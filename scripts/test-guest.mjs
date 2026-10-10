// Real Chromium protocol integration with benign fixtures in a network-disabled container.
// This supplements, and never replaces, the Windows QEMU acceptance suite.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const name = "wret-guest-test-" + randomUUID();
const child = spawn(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "--name",
    name,
    "-i",
    "wret-guest-integration",
  ],
  { stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
);
let buffer = "";
const events = [],
  requests = new Map();
const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.kind === "broker") {
      if (message.data.url === "https://approved.example/body") {
        const body = Buffer.from("approved fixture").toString("base64");
        send({
          reply: message.id,
          result: {
            status: 200,
            headers: [
              { name: "content-type", value: "text/plain" },
              { name: "access-control-allow-origin", value: "*" },
            ],
            body,
            capturedBody: body,
            bodyBytes: 16,
            truncated: false,
          },
        });
      } else
        send({
          reply: message.id,
          error: "Fixture broker: external network blocked",
        });
    } else if (message.reply) {
      const request = requests.get(message.reply);
      if (request) {
        requests.delete(message.reply);
        clearTimeout(request.timer);
        message.error
          ? request.reject(new Error(message.error))
          : request.resolve(message.result);
      }
    } else events.push(message);
  }
});
const command = (action) =>
  new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error("Guest command timeout: " + JSON.stringify(action)));
    }, 30000);
    requests.set(id, { resolve, reject, timer });
    send({ id, command: action });
  });
async function wait(predicate, label) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const found = events.find(predicate);
    if (found) return found;
    if (child.exitCode !== null)
      throw new Error("Guest exited: " + child.exitCode);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    "Missing " +
      label +
      "; diagnostics: " +
      JSON.stringify(
        events.filter((e) => ["diagnostic", "failed"].includes(e.kind)),
      ),
  );
}
try {
  await wait((e) => e.kind === "ready", "guest handshake");
  const fixtures = {
    "index.html":
      '<script src="/patch.js"></script><script src="/app.js"></script><iframe src="/frame.html"></iframe>',
    "patch.js": 'function editable(){return 1;} window.editable=editable;',
    "app.js":
      'const marker = "fresh";\nconsole.log(marker);\nnew Worker("worker.js");\nfetch("https://example.com/");\nnew WebSocket("wss://example.com/");\nfetch("https://approved.example/body").then(r=>r.text()).then(text=>console.log(text));',
    "worker.js": 'console.log("worker captured");',
    "frame.html": '<script>console.log("frame captured")</script>',
  };
  await command({
    action: "start",
    input: {
      target: "files",
      entry: "site/index.html",
      approvals: [],
      breakpoints: [
        {
          id: "b",
          url: "http://127.0.0.1:8765/app.js",
          line: 2,
          condition: "",
        },
      ],
      files: [
        ...Object.entries(fixtures).map(([name, source]) => ({
          id: name,
          name: "site/" + name,
          bytes: Buffer.from(source).toString("base64"),
        })),
        {
          id: "embedded",
          name: "embedded/map/original.js",
          bytes: Buffer.from("// supplied original").toString("base64"),
        },
      ],
    },
  });
  const paused = await wait((e) => e.kind === "paused", "initial breakpoint");
  const frame = paused.data.callFrames[0];
  const evaluation = await command({
    action: "evaluate",
    expression: "marker",
    callFrameId: frame.callFrameId,
    target: paused.data.target,
  });
  assert.equal(evaluation.result.value, "fresh");
  const scope = frame.scopeChain.find((s) => s.type === "script");
  assert.ok(scope);
  const properties = await command({
    action: "properties",
    objectId: scope.object.objectId,
    target: paused.data.target,
  });
  assert.ok(properties.result.some((p) => p.name === "marker"));
  const snapshot = await command({ action: "snapshot", scopes: [{ name: "script", objectId: scope.object.objectId }], target: paused.data.target });
  assert.ok(snapshot.heapUsage.usedSize > 0);
  assert.ok(snapshot.scopes[0].properties.some((property) => property.name === "marker" && property.value === "fresh"));
  assert.ok(!JSON.stringify(snapshot).includes("objectId"));
  const edit = { action: "liveEdit", url: "http://127.0.0.1:8765/patch.js", source: 'function editable(){return 2;} window.editable=editable;', target: paused.data.target };
  const capabilities = await wait((event) => event.kind === "capabilities", "guest capabilities");
  if (capabilities.data.features.includes("liveEdit")) {
  assert.equal((await command({ ...edit, dryRun: true })).status, "Ok");
  assert.equal((await command({ action: "evaluate", expression: "editable()", callFrameId: frame.callFrameId, target: paused.data.target })).result.value, 1);
  assert.equal((await command({ ...edit, dryRun: false })).status, "Ok");
  assert.equal((await command({ action: "evaluate", expression: "editable()", callFrameId: frame.callFrameId, target: paused.data.target })).result.value, 2);
  } else {
    assert.match(capabilities.data.unsupported.liveEdit, /unavailable/);
    await assert.rejects(command({ ...edit, dryRun: true }), /unavailable/);
    assert.equal((await command({ action: "evaluate", expression: "editable()", callFrameId: frame.callFrameId, target: paused.data.target })).result.value, 1);
  }
  await command({ action: "stepOver", target: paused.data.target });
  await wait(
    (e) => e.kind === "paused" && e.data.callFrames[0].location.lineNumber >= 2,
    "stepped pause",
  );
  await command({ action: "resume", target: paused.data.target });
  await wait(
    (e) => e.kind === "blocked" && e.data.url === "https://example.com/",
    "blocked HTTP request",
  );
  await wait(
    (e) =>
      e.kind === "console" &&
      JSON.stringify(e.data).includes("worker captured"),
    "worker console",
  );
  await wait(
    (e) =>
      e.kind === "console" && JSON.stringify(e.data).includes("frame captured"),
    "frame console",
  );
  await wait((e) => e.kind === "preview", "browser preview");
  await wait(
    (e) =>
      e.kind === "response" && e.data.url === "https://approved.example/body",
    "fulfilled approved response",
  );
  await wait(
    (e) =>
      e.kind === "console" &&
      JSON.stringify(e.data).includes("approved fixture"),
    "approved response usable by sample",
  );
  await wait((e) => e.kind === "websocket", "WebSocket attempt");
  assert.ok(
    events.some((e) => e.kind === "script" && e.data.source.includes("marker")),
  );
  await command({ action: "pausePolicy", skip: true });
  assert.equal((await command({ action: "evaluate", expression: 'debugger; "no pause"' })).result.value, "no pause");
  await command({ action: "pausePolicy", skip: false });
  console.log(
    "Guest Chromium integration passed: breakpoint, step, scopes, evaluation, workers, frames, capture, preview, and blocked network.",
  );
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    const stop = spawn("docker", ["rm", "-f", name], {
      stdio: "ignore",
      windowsHide: true,
    });
    stop.on("exit", resolve);
  });
  for (const request of requests.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("Test cleanup"));
  }
  child.kill();
}
