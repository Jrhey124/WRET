import { afterEach, describe, expect, it, vi } from "vitest";
import { runAnalysis, PinnedToolUnavailableError } from "../../src/runtime";
import {
  sha256,
  type ToolPin,
  type Evidence,
  sourceLineStarts,
  sourcePosition,
} from "../../src/model";
const file: Evidence = {
  id: "f",
  name: "f.js",
  format: "javascript",
  bytes: new Uint8Array([49]),
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function environment(mode: "stalled" | "error" | "result" = "stalled") {
  const bytes = new TextEncoder().encode("trusted tool fixture");
  const tool: ToolPin = {
    id: "wret-static",
    version: "1.0.0",
    entry: "/tools/test.js",
    integrity: await sha256(bytes),
    formats: ["javascript"],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("manifest.json")
        ? new Response(JSON.stringify({ tools: [tool] }))
        : new Response(bytes),
    ),
  );
  const terminate = vi.fn();
  class WorkerMock {
    onmessage?: (event: any) => void;
    onerror?: (event: any) => void;
    terminate = terminate;
    postMessage(message: any) {
      if (mode === "error")
        setTimeout(() => this.onerror?.({ message: "parse crash" }), 0);
      if (message.type === "chunk") setTimeout(() => this.onmessage?.({ data: { type: "ack", sequence: message.sequence } }), 0);
      if (mode === "result" && message.type === "finish")
        setTimeout(
          () =>
            this.onmessage?.({
              data: { type: "result", result: { hash: "ok" } },
            }),
          0,
        );
    }
  }
  vi.stubGlobal("Worker", WorkerMock);
  return { tool, terminate };
}
describe("worker lifecycle", () => {
  it("terminates stalled workers and rejects without returning partial results", async () => {
    const { tool, terminate } = await environment();
    await expect(
      runAnalysis(file, tool, () => {}, new AbortController().signal, 10),
    ).rejects.toThrow("worker terminated");
    expect(terminate).toHaveBeenCalledOnce();
  });
  it("terminates on cancellation after startup", async () => {
    const { tool, terminate } = await environment();
    const controller = new AbortController();
    const pending = runAnalysis(file, tool, () => {}, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow("cancelled");
    expect(terminate).toHaveBeenCalledOnce();
  });
  it("surfaces worker crashes and cleans up", async () => {
    const { tool, terminate } = await environment("error");
    await expect(
      runAnalysis(file, tool, () => {}, new AbortController().signal),
    ).rejects.toThrow("parse crash");
    expect(terminate).toHaveBeenCalledOnce();
  });
  it("blocks missing or mismatched project pins before worker execution", async () => {
    const { tool, terminate } = await environment();
    await expect(
      runAnalysis(
        file,
        { ...tool, version: "old" },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(PinnedToolUnavailableError);
    expect(terminate).not.toHaveBeenCalled();
  });
  it("terminates a successful worker", async () => {
    const { tool, terminate } = await environment("result");
    expect(
      await runAnalysis(file, tool, () => {}, new AbortController().signal),
    ).toEqual({ hash: "ok", tool });
    expect(terminate).toHaveBeenCalledOnce();
  });
});
it("maps original UTF-8 bytes to editor positions across BOM, Unicode and mixed newlines", () => {
  const text = '\uFEFFconst a="é";\r\nconst b="🧭";\nconst c=3;\rconst d=4;',
    bytes = new TextEncoder().encode(text);
  const starts = sourceLineStarts(text);
  expect(starts).toHaveLength(4);
  expect(starts[0]).toBe(1);
  for (let i = 0; i < starts.length; i++)
    expect(
      sourcePosition(
        bytes,
        new TextEncoder().encode(text.slice(0, starts[i])).length,
      ),
    ).toEqual({ lineNumber: i + 1, column: 1 });
});
