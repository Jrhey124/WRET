import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Socket } from "node:net";
import { mkdir, readFile, rm, readdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { brokerRequest } from "./network";
const exec = promisify(execFile);
const root = resolve(process.env.WRET_VM_DIR || ".wret-vm");
const qemu = process.env.WRET_QEMU || "qemu-system-x86_64";
const imageTool = process.env.WRET_QEMU_IMG || "qemu-img";
export async function checks() {
  const list: { name: string; ok: boolean; detail: string }[] = [];
  list.push({
    name: "Windows x64",
    ok: process.platform === "win32" && process.arch === "x64",
    detail: "Windows x64 with virtualization enabled is required.",
  });
  for (const [name, executable] of [
    ["QEMU", qemu],
    ["qemu-img", imageTool],
  ]) {
    try {
      const { stdout } = await exec(executable, ["--version"], {
        timeout: 5000,
      });
      list.push({ name, ok: true, detail: stdout.split("\n")[0] });
    } catch {
      list.push({
        name,
        ok: false,
        detail: "Install QEMU and configure its executable path.",
      });
    }
  }
  const probeStarted = Date.now();
  try {
    await exec(
      qemu,
      [
        "-accel",
        "whpx",
        "-machine",
        "q35",
        "-nodefaults",
        "-display",
        "none",
        "-monitor",
        "none",
        "-serial",
        "none",
        "-nic",
        "none",
        "-m",
        "64",
        "-S",
      ],
      { timeout: 2000, windowsHide: true },
    );
    list.push({
      name: "Windows Hypervisor Platform",
      ok: false,
      detail: "The WHPX probe exited unexpectedly.",
    });
  } catch (error: any) {
    const ready =
      error.killed === true &&
      (error.code === null || error.code === "ETIMEDOUT") &&
      Date.now() - probeStarted >= 1800;
    list.push({
      name: "Windows Hypervisor Platform",
      ok: ready,
      detail: ready
        ? "WHPX initialized successfully."
        : String(error.stderr || error.message).slice(0, 1000),
    });
  }
  try {
    const expected = (await readFile(join(root, "guest.sha256"), "utf8"))
      .trim()
      .split(/\s/)[0];
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(join(root, "guest.qcow2")))
      digest.update(bytes);
    const actual = digest.digest("hex");
    if (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual)
      throw new Error("Guest integrity mismatch");
    list.push({ name: "Guest image integrity", ok: true, detail: actual });
  } catch (error) {
    list.push({
      name: "Guest image integrity",
      ok: false,
      detail: String(error),
    });
  }
  return list;
}
export async function cleanOrphans() {
  await mkdir(root, { recursive: true });
  // Only directories created beneath the configured session root are removed.
  const sessions = join(root, "sessions");
  await mkdir(sessions, { recursive: true });
  for (const name of await readdir(sessions))
    if (/^[a-f0-9-]{36}$/.test(name)) {
      const directory = join(sessions, name),
        overlay = join(directory, "session.qcow2");
      try {
        const pid = Number(await readFile(join(directory, "pid"), "utf8"));
        if (
          process.platform === "win32" &&
          Number.isSafeInteger(pid) &&
          pid > 0
        ) {
          const { stdout } = await exec(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object -ExpandProperty CommandLine`,
            ],
            { timeout: 10000 },
          );
          if (stdout.includes(overlay) && /qemu-system-x86_64/i.test(stdout))
            await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
        }
      } catch {
        /* Deletion below fails visibly if an orphan still holds its disk. */
      }
      await rm(directory, { recursive: true, force: true });
    }
}
export async function startVM(
  input: any,
  event: (kind: string, data: unknown) => void,
  onAllocated?: (vm: {
    id: string;
    command: (action: unknown) => Promise<any>;
    stop: () => Promise<void>;
    approve: (origin: string) => void;
    extend: () => void;
  }) => void,
) {
  const prerequisites = await checks();
  if (prerequisites.some((c) => !c.ok))
    throw new Error("VM prerequisites are incomplete; open setup checks.");
  const id: string = randomUUID(),
    directory = join(root, "sessions", id);
  await mkdir(directory, { recursive: true });
  const overlay = join(directory, "session.qcow2");
  try {
    await exec(imageTool, [
      "create",
      "-f",
      "qcow2",
      "-F",
      "qcow2",
      "-b",
      join(root, "guest.qcow2"),
      overlay,
    ]);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let channel: Socket | undefined,
    buffer = "",
    closed = false;
  const pending = new Map<
    string,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const approvals = new Set<string>(input.approvals);
  let activeRequests = 0,
    requestCount = 0;
  let handshake: () => void;
  let failStartup: (error: Error) => void;
  const startupFailure = new Promise<void>((_resolve, reject) => {
    failStartup = reject;
  });
  void startupFailure.catch(() => {});
  const connected = new Promise<void>((r) => (handshake = r));
  const send = (message: unknown) => {
    if (!channel || channel.destroyed) throw new Error("Guest disconnected");
    channel.write(JSON.stringify(message) + "\n");
  };
  const server = createServer((socket) => {
    if (channel) {
      socket.destroy();
      return;
    }
    channel = socket;
    socket.on("data", (bytes) => {
      buffer += bytes.toString();
      if (buffer.length > 36 * 1024 * 1024) {
        socket.destroy();
        event("error", "Oversized guest message");
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.kind === "ready") handshake();
          else if (message.kind === "broker") {
            if (activeRequests >= 8 || ++requestCount > 10000) {
              send({
                reply: message.id,
                error: "Session network request limit reached",
              });
              continue;
            }
            activeRequests++;
            void brokerRequest(message.data, approvals)
              .then(
                (result) => send({ reply: message.id, result }),
                (error) => send({ reply: message.id, error: String(error) }),
              )
              .catch(() => {})
              .finally(() => {
                activeRequests--;
              });
          } else if (message.reply) {
            const p = pending.get(message.reply);
            if (p) {
              clearTimeout(p.timer);
              pending.delete(message.reply);
              message.error
                ? p.reject(new Error(message.error))
                : p.resolve(message.result);
            }
          } else if (typeof message.kind === "string")
            event(message.kind, message.data);
        } catch (error) {
          event("error", String(error));
        }
      }
    });
    socket.on("error", (error) => event("error", String(error)));
    socket.on("close", () => {
      if (!closed) {
        failStartup(new Error("Guest control channel disconnected"));
        event("failed", "Guest control channel disconnected");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const processVM = spawn(
    qemu,
    [
      "-accel",
      "whpx",
      "-machine",
      "q35",
      "-smp",
      "2",
      "-m",
      "4096",
      "-drive",
      `file=${overlay},format=qcow2,if=virtio`,
      "-nic",
      "none",
      "-display",
      "none",
      "-monitor",
      "none",
      "-serial",
      "none",
      "-device",
      "virtio-serial-pci",
      "-chardev",
      `socket,id=control,host=127.0.0.1,port=${port},reconnect-ms=1000`,
      "-device",
      "virtserialport,chardev=control,name=org.wret.control",
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  processVM.stderr.on("data", (bytes) =>
    event("diagnostic", bytes.toString().slice(0, 4096)),
  );
  processVM.on("error", (error) => {
    failStartup(error);
    event("failed", String(error));
  });
  processVM.on("exit", () => {
    if (!closed) {
      failStartup(new Error("VM exited unexpectedly"));
      event("failed", "VM exited unexpectedly");
    }
  });
  const stop = async () => {
    if (closed) return;
    closed = true;
    failStartup(new Error("Session stopped"));
    clearTimeout(deadline);
    channel?.destroy();
    server.close();
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Session stopped"));
    }
    pending.clear();
    if (processVM.exitCode === null) {
      processVM.kill();
      await new Promise<void>((r) => {
        processVM.once("exit", () => r());
        setTimeout(r, 5000).unref();
      });
    }
    await rm(directory, { recursive: true, force: true });
    event("stopped", {});
  };
  let deadline = setTimeout(
    () => void stop().catch((error) => event("error", String(error))),
    30 * 60 * 1000,
  );
  const command = (action: unknown) =>
    new Promise<any>((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Guest command timed out"));
      }, 30000);
      pending.set(requestId, { resolve, reject, timer });
      try {
        send({ id: requestId, command: action });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  const vm = {
    id,
    command,
    stop,
    approve: (origin: string) => {
      if (approvals.size >= 100)
        throw new Error("Network approval limit reached");
      approvals.add(origin);
    },
    extend: () => {
      clearTimeout(deadline);
      deadline = setTimeout(
        () => void stop().catch((error) => event("error", String(error))),
        30 * 60 * 1000,
      );
    },
  };
  onAllocated?.(vm);
  try {
    if (processVM.pid)
      await writeFile(join(directory, "pid"), String(processVM.pid));
    await Promise.race([
      connected,
      startupFailure,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Guest startup exceeded 90 seconds")),
          90000,
        ).unref(),
      ),
    ]);
    await command({ action: "start", input });
  } catch (error) {
    await stop();
    throw error;
  }
  return vm;
}
