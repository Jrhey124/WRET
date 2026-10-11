import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { checks, cleanOrphans, startVM } from "./vm";
import { approvedOrigin } from "./network";
import {
  CAPTURE_LIMIT,
  type DebugCommand,
  type SessionInput,
} from "../src/debug-types";
const port = Number(process.env.WRET_PORT || 8080),
  origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString("hex");
const dist = resolve(process.env.WRET_DIST_DIR || "dist");
const sockets = new Set<any>();
let session: Awaited<ReturnType<typeof startVM>> | undefined,
  starting = false;
let sequence = 0,
  captured = 0,
  truncated = false,
  sessionId = "";
const events: any[] = [];
let liveState: any,
  sessionTarget = "files";
function event(kind: string, data: any) {
  let payload = JSON.stringify(data ?? null);
  const payloadLimit = kind === "wasmModule" ? 36 * 1024 * 1024 : 2 * 1024 * 1024;
  if (Buffer.byteLength(payload) > payloadLimit) {
    kind = "diagnostic";
    payload = JSON.stringify("Oversized observation omitted");
    data = JSON.parse(payload);
  }
  if (["paused", "running", "stopped", "failed"].includes(kind)) {
    liveState = {
      kind: "state",
      status: kind,
      data,
      sessionId,
      target: sessionTarget,
    };
    for (const socket of sockets)
      if (socket.bufferedAmount < 2 * 1024 * 1024)
        socket.send(JSON.stringify(liveState));
    if (kind === "failed") void session?.stop().catch(console.error);
    if (kind === "stopped") session = undefined;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9]{0,99}$/.test(kind)) return;
  if (kind === "preview") {
    if (
      !data ||
      typeof data.image !== "string" ||
      data.image.length > 2 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data.image)
    )
      return;
    for (const socket of sockets)
      if (socket.bufferedAmount < 2 * 1024 * 1024)
        socket.send(JSON.stringify({ kind, data }));
    return;
  }
  if (
    captured + Buffer.byteLength(payload) > CAPTURE_LIMIT ||
    events.length >= 49999
  ) {
    if (truncated) return;
    truncated = true;
    kind = "truncated";
    payload = JSON.stringify("50 MiB or 50,000 event capture limit reached.");
  }
  const observation = {
    sequence: ++sequence,
    time: new Date().toISOString(),
    kind,
    data: JSON.parse(payload),
  };
  captured += Buffer.byteLength(JSON.stringify(observation));
  events.push(observation);
  for (const socket of sockets)
    if (socket.bufferedAmount < 2 * 1024 * 1024)
      socket.send(JSON.stringify({ sessionId, observation }));
}
function authorize(request: http.IncomingMessage) {
  if (
    request.headers.host !== `127.0.0.1:${port}` ||
    (request.headers.origin && request.headers.origin !== origin)
  )
    throw new Error("Invalid API origin");
  const supplied = String(request.headers.authorization || "").replace(
    /^Bearer /,
    "",
  );
  if (
    supplied.length !== token.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
  )
    throw new Error("Authentication required");
}
async function body(request: http.IncomingMessage, maximum = 64 * 1024) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function validateInput(input: SessionInput) {
  if (input?.monitorWasmBridge !== undefined && typeof input.monitorWasmBridge !== "boolean")
    throw new Error("Invalid WebAssembly monitor option");
  if (input?.captureWasmModules !== undefined && typeof input.captureWasmModules !== "boolean")
    throw new Error("Invalid WebAssembly module capture option");
  if (input?.wasmStringDecoders !== undefined && (!Array.isArray(input.wasmStringDecoders) || input.wasmStringDecoders.length > 20))
    throw new Error("Invalid WebAssembly string decoder rules");
  for (const rule of input?.wasmStringDecoders || []) {
    if (!rule || !["js-to-wasm", "wasm-to-js"].includes(rule.direction) || typeof rule.functionName !== "string" || !rule.functionName.trim() || rule.functionName.length > 200 || typeof rule.memoryName !== "string" || !rule.memoryName.trim() || rule.memoryName.length > 200 || !Number.isSafeInteger(rule.pointerArgument) || rule.pointerArgument < 0 || rule.pointerArgument > 15 || (rule.lengthArgument !== undefined && (!Number.isSafeInteger(rule.lengthArgument) || rule.lengthArgument < 0 || rule.lengthArgument > 15 || rule.lengthArgument === rule.pointerArgument)))
      throw new Error("Invalid WebAssembly string decoder rule");
  }
  if (
    input?.exceptionState !== undefined &&
    !["none", "uncaught", "all"].includes(input.exceptionState)
  )
    throw new Error("Invalid initial exception mode");
  if (
    !input ||
    typeof input.target !== "string" ||
    input.target.length > 2000 ||
    !Array.isArray(input.files) ||
    input.files.length > 1000 ||
    !Array.isArray(input.breakpoints) ||
    input.breakpoints.length > 1000 ||
    !Array.isArray(input.approvals) ||
    input.approvals.length > 100
  )
    throw new Error("Invalid session input");
  let total = 0;
  const names = new Set();
  for (const file of input.files) {
    if (
      typeof file.id !== "string" ||
      typeof file.name !== "string" ||
      file.name.length > 1000 ||
      !file.name ||
      file.name.startsWith("/") ||
      file.name.includes("\\") ||
      file.name.includes(":") ||
      file.name.split("/").some((x) => !x || x === ".." || x === ".") ||
      names.has(file.name) ||
      typeof file.bytes !== "string" ||
      file.bytes.length > 34952536 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.bytes)
    )
      throw new Error("Invalid evidence path or bytes");
    names.add(file.name);
    const size = Buffer.from(file.bytes, "base64").length;
    total += size;
    if (size > 25 * 1024 * 1024 || total > 100 * 1024 * 1024)
      throw new Error("Evidence limit exceeded");
  }
  input.approvals = input.approvals.map(approvedOrigin);
  if (input.target === "files") {
    if (
      !input.entry ||
      !names.has(input.entry) ||
      !/\.(html?|[mc]?js)$/i.test(input.entry)
    )
      throw new Error("Select an imported HTML or JavaScript entrypoint");
  } else {
    const requested = approvedOrigin(input.target);
    if (!input.approvals.includes(requested))
      throw new Error("Approve the website origin before starting");
    if (input.files.length)
      throw new Error("URL sessions must not transfer unrelated evidence");
  }
  for (const bp of input.breakpoints)
    validateCommand({ action: "breakpoint", breakpoint: bp });
}
function validateCommand(command: DebugCommand) {
  if (
    (command as any)?.target !== undefined &&
    (typeof (command as any).target !== "string" ||
      (command as any).target.length > 200)
  )
    throw new Error("Invalid debugger target");
  if (
    !command ||
    ![
      "pause",
      "resume",
      "stepInto",
      "stepOver",
      "stepOut",
      "stop",
      "extend",
      "breakpoint",
      "removeBreakpoint",
      "exceptions",
      "evaluate",
      "properties",
      "approve",
      "input",
      "snapshot",
      "pausePolicy",
      "liveEdit",
    ].includes(command.action)
  )
    throw new Error("Unknown debugger command");
  if (command.action === "pausePolicy" && typeof command.skip !== "boolean") throw new Error("Invalid pause policy");
  if (command.action === "snapshot" && (!Array.isArray(command.scopes) || command.scopes.length > 12 || command.scopes.some((scope) => !scope || typeof scope.name !== "string" || scope.name.length > 100 || typeof scope.objectId !== "string" || scope.objectId.length > 1000))) throw new Error("Invalid snapshot scope handles");
  if (command.action === "liveEdit" && (typeof command.url !== "string" || !command.url || command.url.length > 2000 || typeof command.source !== "string" || Buffer.byteLength(command.source) > 1024 * 1024 || typeof command.dryRun !== "boolean")) throw new Error("Invalid live edit");
  if (
    command.action === "breakpoint" &&
    (!command.breakpoint ||
      typeof command.breakpoint.id !== "string" ||
      command.breakpoint.id.length > 200 ||
      typeof command.breakpoint.url !== "string" ||
      command.breakpoint.url.length > 2000 ||
      !Number.isSafeInteger(command.breakpoint.line) ||
      command.breakpoint.line < 1 ||
      typeof command.breakpoint.condition !== "string" ||
      command.breakpoint.condition.length > 4096)
  )
    throw new Error("Invalid breakpoint");
  if (
    command.action === "evaluate" &&
    (typeof command.expression !== "string" ||
      command.expression.length > 4096 ||
      (command.callFrameId !== undefined &&
        typeof command.callFrameId !== "string"))
  )
    throw new Error("Invalid evaluation");
  if (
    command.action === "properties" &&
    (typeof command.objectId !== "string" || command.objectId.length > 1000)
  )
    throw new Error("Invalid object handle");
  if (
    command.action === "removeBreakpoint" &&
    (typeof command.id !== "string" || command.id.length > 200)
  )
    throw new Error("Invalid breakpoint ID");
  if (
    command.action === "exceptions" &&
    !["none", "uncaught", "all"].includes(command.state)
  )
    throw new Error("Invalid exception mode");
  if (
    command.action === "input" &&
    (![
      "mousePressed",
      "mouseReleased",
      "mouseMoved",
      "keyDown",
      "keyUp",
    ].includes(command.type) ||
      (command.x !== undefined &&
        (!Number.isFinite(command.x) || command.x < 0 || command.x > 1280)) ||
      (command.y !== undefined &&
        (!Number.isFinite(command.y) || command.y < 0 || command.y > 720)) ||
      (command.key !== undefined &&
        (typeof command.key !== "string" || command.key.length > 100)) ||
      (command.text !== undefined &&
        (typeof command.text !== "string" || command.text.length > 100)))
  )
    throw new Error("Invalid preview input");
}
const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  const reply = (status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  try {
    if (request.headers.host !== `127.0.0.1:${port}`)
      throw new Error("Invalid host");
    const path = new URL(request.url!, origin).pathname;
    if (path === "/api/bootstrap" && request.method === "GET") {
      if (request.headers["sec-fetch-site"] !== "same-origin")
        throw new Error("Bootstrap requires a same-origin browser request");
      reply(200, { token });
      return;
    }
    if (path.startsWith("/api/")) {
      authorize(request);
      if (path === "/api/capabilities" && request.method === "GET") {
        const list = await checks();
        reply(200, {
          available: true,
          ready: list.every((c) => c.ok),
          checks: list,
        });
        return;
      }
      if (path === "/api/sessions" && request.method === "POST") {
        if (session || starting) {
          reply(409, { error: "Stop the active session first" });
          return;
        }
        starting = true;
        try {
          const input = await body(request, 140 * 1024 * 1024);
          validateInput(input);
          sessionTarget = input.target;
          liveState = undefined;
          sequence = captured = 0;
          truncated = false;
          events.length = 0;
          sessionId = randomUUID();
          session = await startVM(input, event, (allocated) => {
            session = allocated;
          });
          reply(200, { id: sessionId });
        } finally {
          starting = false;
        }
        return;
      }
      if (path === "/api/command" && request.method === "POST") {
        const command = await body(request, 2 * 1024 * 1024);
        validateCommand(command);
        if (!session) throw new Error("No active session");
        if (starting && command.action !== "stop")
          throw new Error("Guest is still starting");
        if (command.action === "stop") {
          await session.stop();
          session = undefined;
          reply(200, {});
        } else if (command.action === "extend") {
          session.extend();
          reply(200, {});
        } else if (command.action === "approve") {
          const value = approvedOrigin(command.origin);
          session.approve(value);
          event("approval", value);
          reply(200, {});
        } else reply(200, await session.command(command));
        return;
      }
      if (path === "/api/events" && request.method === "GET") {
        const after = Number(
          new URL(request.url!, origin).searchParams.get("after") || 0,
        );
        reply(200, {
          sessionId,
          events: events.filter((e) => e.sequence > after).slice(0, 100),
          captured,
          truncated,
        });
        return;
      }
      reply(404, { error: "Unknown API endpoint" });
      return;
    }
    if (!["GET", "HEAD"].includes(request.method!)) {
      reply(405, { error: "Method not allowed" });
      return;
    }
    const file = resolve(
      dist,
      "." + decodeURIComponent(path === "/" ? "/index.html" : path),
    );
    if (!file.startsWith(dist + sep) || !(await stat(file)).isFile()) {
      reply(404, { error: "Not found" });
      return;
    }
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".wasm": "application/wasm",
      ".woff2": "font/woff2",
    };
    response.setHeader(
      "Content-Type",
      types[extname(file)] || "application/octet-stream",
    );
    response.end(request.method === "HEAD" ? undefined : await readFile(file));
  } catch (error) {
    reply(400, { error: String(error) });
  }
});
const ws = new WebSocketServer({ noServer: true, maxPayload: 1024 });
server.on("upgrade", (request, socket, head) => {
  try {
    if (
      request.url !== "/api/stream" ||
      request.headers.origin !== origin ||
      request.headers.host !== `127.0.0.1:${port}`
    )
      throw new Error("Invalid WebSocket origin");
    const protocols = String(request.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((x) => x.trim());
    if (!protocols.includes(token)) throw new Error("Authentication required");
    ws.handleUpgrade(request, socket, head, (client) => {
      sockets.add(client);
      if (liveState) client.send(JSON.stringify(liveState));
      client.on("error", () => {});
      client.on("close", () => sockets.delete(client));
    });
  } catch {
    socket.destroy();
  }
});
if (process.argv.includes("--check")) {
  const result = await checks();
  console.log(
    JSON.stringify(
      { ready: result.every((c) => c.ok), checks: result },
      null,
      2,
    ),
  );
  process.exit(result.every((c) => c.ok) ? 0 : 1);
}
await cleanOrphans();
server.listen(port, "127.0.0.1", () =>
  console.log(`Whidra companion: ${origin}`),
);
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  await session?.stop();
  ws.close();
  server.close();
  process.exit();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
