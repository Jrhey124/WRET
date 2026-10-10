import { sha256, type Evidence, type Analysis, type ToolPin } from "./model";
// Sample controlled work always has a short wall clock budget. Network fetches
// for the first party analyzer have separate deadlines below.
export const WORKER_TIMEOUT = 10_000;
export async function loadTool(signal?: AbortSignal): Promise<ToolPin> {
  const response = await fetch("/tools/manifest.json", {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    cache: "no-cache",
    credentials: "omit",
  });
  if (!response.ok) throw new Error("Analysis tool manifest unavailable");
  const manifest = await response.json();
  const tool = manifest.tools?.find((t: ToolPin) => t.id === "wret-static");
  if (
    !tool ||
    !/^\/tools\/[a-zA-Z0-9._-]+\.js$/.test(tool.entry) ||
    !/^[a-f0-9]{64}$/.test(tool.integrity)
  )
    throw new Error("Invalid first-party tool manifest");
  return tool;
}
export async function runAnalysis(
  file: Evidence,
  tool: ToolPin,
  onProgress: (s: string) => void,
  signal: AbortSignal,
  timeout = WORKER_TIMEOUT,
): Promise<Analysis> {
  // Imported project pins must exactly match this server's manifest before any download.
  const trusted = await loadTool(signal);
  if (
    trusted.id !== tool.id ||
    trusted.version !== tool.version ||
    trusted.integrity !== tool.integrity ||
    trusted.entry !== tool.entry
  )
    throw new Error(
      "Pinned tool is unavailable on this server. Existing results are preserved. Start a new project to use the installed tool version.",
    );
  if (!trusted.formats.includes(file.format))
    throw new Error("Tool does not support this file format");
  const response = await fetch(trusted.entry, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    credentials: "omit",
    cache: "force-cache",
  });
  if (!response.ok) throw new Error("Tool download failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if ((await sha256(bytes)) !== trusted.integrity)
    throw new Error("Tool integrity check failed; refusing to start worker");
  signal.throwIfAborted();
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "text/javascript" }),
  );
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      reject(error);
      return;
    }
    let rejectAck: ((error: Error) => void) | undefined;
    let expectedAck: number | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      rejectAck?.(error instanceof Error ? error : new Error(String(error)));
      rejectAck = undefined;
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(new DOMException("Analysis cancelled", "AbortError"));
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            "Analysis exceeded the 10 second job limit; worker terminated. Original evidence and notes are preserved.",
          ),
        ),
      Math.min(timeout, WORKER_TIMEOUT),
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (e) => fail(new Error(`Worker failed: ${e.message}`));
    worker.onmessageerror = () =>
      fail(new Error("Worker returned an unreadable message"));
    worker.onmessage = (e) => {
      if (e.data.type === "ack") {
        if (e.data.sequence !== expectedAck) return fail(new Error("Analysis worker returned an invalid chunk acknowledgment"));
        rejectAck = undefined; acknowledge?.(); acknowledge = undefined;
      }
      else if (e.data.type === "progress") onProgress(e.data.progress);
      else if (e.data.type === "result") {
        cleanup();
        resolve(e.data.result);
      } else if (e.data.type === "error") fail(new Error(e.data.error));
    };
    let acknowledge: (() => void) | undefined;
    const send = async () => {
      try {
        const { bytes: _bytes, result: _result, ...metadata } = file;
        worker.postMessage({ type: "start", action: "analyze", file: metadata, byteLength: file.bytes.length });
        let chunks = 0;
        for (let offset = 0; offset < file.bytes.length; offset += 256 * 1024) {
          await new Promise<void>((resolve, reject) => {
            acknowledge = resolve; rejectAck = reject; expectedAck = chunks;
            const bytes = file.bytes.slice(offset, Math.min(file.bytes.length, offset + 256 * 1024));
            worker.postMessage({ type: "chunk", sequence: chunks, offset, bytes }, [bytes.buffer]);
          });
          chunks++;
        }
        worker.postMessage({ type: "finish", chunks, byteLength: file.bytes.length });
      } catch (error) { fail(error); }
    };
    void send();
  });
}
