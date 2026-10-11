import { acquireWorker } from "./worker-queue";
import type { Evidence, Location } from "./model";
import type { Recipe, TransformPreview } from "./gap-analysis";
import { WORKER_TIMEOUT } from "./runtime";
import { uid } from "./model";

type Message =
  | { action: "har"; bytes: Uint8Array }
  | { action: "snapshots"; files: Evidence[] }
  | { action: "contracts"; files: Evidence[]; sessions: import("./debug-types").DebugSession[] }
  | { action: "preview"; files: Evidence[]; fileId: string }
  | { action: "index"; files: Evidence[] }
  | { action: "transform"; bytes: Uint8Array; recipe: Recipe; location?: Location }
  | { action: "potential"; files: Evidence[]; query: string }
  | { action: "decode"; operation: "base64" | "hex" | "url" | "strings" | "nested" | "gzip" | "deflate"; input: string };

export async function runResearchJob<T>(message: Message, signal?: AbortSignal): Promise<T> {
  const release = await acquireWorker(signal);
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(new URL("./research.worker.ts", import.meta.url), { type: "module" });
    const id = uid();
    const timer = setTimeout(() => finish(new Error("Research exceeded the 10 second job limit; the worker was terminated.")), WORKER_TIMEOUT);
    const cleanup = () => { rejectAck?.(new Error("Research job stopped")); rejectAck = undefined; clearTimeout(timer); signal?.removeEventListener("abort", abort); worker.terminate(); };
    const finish = (error?: Error, value?: T) => { cleanup(); error ? reject(error) : resolve(value as T); };
    const abort = () => finish(new DOMException("Research cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish(new Error("Research worker failed; original evidence remains unchanged."));
    worker.onmessageerror = () => finish(new Error("Research worker returned an unreadable result."));
    worker.onmessage = (event) => {
      if (event.data.id !== id) return finish(new Error("Research worker returned an invalid job ID."));
      if (event.data.type === "error") finish(new Error(event.data.error));
      else if (event.data.type === "result") finish(undefined, event.data.result as T);
      else finish(new Error("Research worker returned an invalid response."));
    };
    let ack: (() => void) | undefined;
    let rejectAck: ((error: Error) => void) | undefined;
    let sequence = 0;
    const resultHandler = worker.onmessage;
    worker.onmessage = event => {
      if (event.data.id === id && event.data.type === "ack") {
        if (event.data.sequence !== sequence) return finish(new Error("Invalid research chunk acknowledgment"));
        ack?.(); ack = undefined; rejectAck = undefined;
      } else resultHandler?.call(worker, event);
    };
    const send = async () => {
      const sourceFiles = "files" in message ? message.files : (message.action === "transform" || message.action === "har") ? [{ id: "input", bytes: message.bytes }] : message.action === "decode" ? [{ id: "input", bytes: new TextEncoder().encode(message.input) }] : [];
      const { files: _files, bytes: _bytes, input: _input, ...options } = message as any;
      worker.postMessage({ id, type: "start", options });
      for (const file of sourceFiles) {
        const { bytes, result: _result, ...metadata } = file as Evidence;
        worker.postMessage({ id, type: "file", metadata, length: bytes.length });
        for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
          const chunk = bytes.slice(offset, Math.min(bytes.length, offset + 256 * 1024));
          await new Promise<void>((resolve, reject) => {
            ack = resolve; rejectAck = reject;
            worker.postMessage({ id, type: "chunk", sequence, offset, bytes: chunk }, [chunk.buffer]);
          });
          sequence++;
        }
        worker.postMessage({ id, type: "endFile" });
      }
      worker.postMessage({ id, type: "finish" });
    };
    void send().catch(error => finish(error));
  }).finally(release);
}
