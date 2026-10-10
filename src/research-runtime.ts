import type { Evidence, Location } from "./model";
import type { Recipe, TransformPreview } from "./gap-analysis";
import { WORKER_TIMEOUT } from "./runtime";

type Message =
  | { action: "index"; files: Evidence[] }
  | { action: "transform"; bytes: Uint8Array; recipe: Recipe; location?: Location }
  | { action: "potential"; files: Evidence[]; query: string }
  | { action: "decode"; operation: "base64" | "hex" | "url" | "strings" | "nested" | "gzip" | "deflate"; input: string };

export function runResearchJob<T>(message: Message, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./research.worker.ts", import.meta.url), { type: "module" });
    const id = crypto.randomUUID();
    const timer = setTimeout(() => finish(new Error("Research exceeded the 10 second job limit; the worker was terminated.")), WORKER_TIMEOUT);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); worker.terminate(); };
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
    if (message.action === "index" || message.action === "potential") {
      const files = message.files.map((file) => { const { result: _result, ...metadata } = file; return { ...metadata, bytes: file.bytes.slice() }; });
      const transfers = files.map((file) => file.bytes.buffer);
      worker.postMessage({ ...message, files, id }, transfers);
    } else if (message.action === "transform") {
      const bytes = message.bytes.slice();
      worker.postMessage({ ...message, bytes, id }, [bytes.buffer]);
    } else worker.postMessage({ ...message, id });
  });
}
