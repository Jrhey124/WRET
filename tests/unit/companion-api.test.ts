import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import WebSocket from "ws";
let child: ChildProcess, directory: string, token: string;
const port = 44000 + (process.pid % 1000),
  origin = `http://127.0.0.1:${port}`;
beforeAll(async () => {
  await build({
    entryPoints: ["companion/server.ts"],
    outfile: "dist-companion/server.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    target: "node24",
  });
  directory = await mkdtemp(join(tmpdir(), "wret-api-"));
  await writeFile(
    join(directory, "index.html"),
    "<!doctype html><title>Trusted API test fixture</title>",
  );
  child = spawn(process.execPath, ["dist-companion/server.mjs"], {
    env: {
      ...process.env,
      WRET_PORT: String(port),
      WRET_VM_DIR: directory,
      WRET_DIST_DIR: directory,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Companion did not start")),
      10000,
    );
    child.stdout?.on("data", (data) => {
      if (data.toString().includes("Whidra companion:")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && code !== 0)
        reject(new Error("Companion exited " + code));
    });
  });
  const bootstrap = await fetch(origin + "/api/bootstrap", {
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  token = (await bootstrap.json()).token;
});
afterAll(async () => {
  if (child && !child.killed) {
    child.kill();
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(resolve, 2000).unref();
    });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
function headers(extra: Record<string, string> = {}) {
  return { Authorization: "Bearer " + token, ...extra };
}
describe("companion HTTP and WebSocket control access", () => {
  it("protects bootstrap against cross-origin browser access", async () => {
    expect(
      (
        await fetch(origin + "/api/bootstrap", {
          headers: {
            "Sec-Fetch-Site": "cross-site",
            Origin: "https://attacker.invalid",
          },
        })
      ).status,
    ).toBe(400);
  });
  it("requires authentication and the exact origin", async () => {
    expect((await fetch(origin + "/api/events")).status).toBe(400);
    expect(
      (
        await fetch(origin + "/api/events", {
          headers: headers({ Origin: "https://attacker.invalid" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(origin + "/api/events", { headers: headers() })).status,
    ).toBe(200);
    expect(
      (
        await fetch(origin + "/api/command", {
          method: "POST",
          headers: headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ action: "rawCDP", method: "Browser.close" }),
        })
      ).status,
    ).toBe(400);
  });
  it("rejects traversal, missing entrypoints, and unapproved URLs before VM allocation", async () => {
    const base = {
      target: "files",
      entry: "app.js",
      files: [{ id: "a", name: "app.js", bytes: "eCgpOw==" }],
      breakpoints: [],
      approvals: [],
    };
    for (const input of [
      { ...base, files: [{ id: "a", name: "../app.js", bytes: "eCgpOw==" }] },
      { ...base, entry: "missing.html" },
      { ...base, target: "https://example.com", files: [] },
      { ...base, wasmStringDecoders: [{ direction: "wasm-to-js", functionName: "env.decode", memoryName: "env.memory", pointerArgument: 0, lengthArgument: 0 }] },
    ]) {
      const response = await fetch(origin + "/api/sessions", {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain(
        "VM prerequisites",
      );
    }
  });
  it("accepts an authenticated same-origin stream and rejects a foreign origin", async () => {
    const good = new WebSocket(
      origin.replace("http:", "ws:") + "/api/stream",
      token,
      { origin },
    );
    await new Promise<void>((resolve, reject) => {
      good.once("open", resolve);
      good.once("error", reject);
    });
    good.close();
    const rejected = new WebSocket(
      origin.replace("http:", "ws:") + "/api/stream",
      token,
      { origin: "https://attacker.invalid" },
    );
    await new Promise<void>((resolve) =>
      rejected.once("error", () => resolve()),
    );
  });
  it("bounds snapshot and live-edit commands before touching the guest", async () => {
    for (const command of [
      { action: "snapshot", scopes: Array.from({ length: 13 }, () => ({ name: "local", objectId: "x" })) },
      { action: "snapshot", scopes: [{ name: "local", objectId: 123 }] },
      { action: "pausePolicy", skip: "true" },
      { action: "liveEdit", url: "https://example.invalid/app.js", source: "x".repeat(1024 * 1024 + 1), dryRun: true },
      { action: "liveEdit", url: "https://example.invalid/app.js", source: "x();", dryRun: "true" },
    ]) {
      const response = await fetch(origin + "/api/command", { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(command) });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/Invalid/);
    }
  });
  it("serves production assets with CSP and disallows static writes", async () => {
    const response = await fetch(origin + "/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-src 'none'",
    );
    expect((await fetch(origin + "/", { method: "POST" })).status).toBe(405);
  });
});
