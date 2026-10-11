import SearchWorker from "./search.worker?worker";
import { evidenceSize, uid, type Evidence, type Item } from "./model";
import { readEvidenceRange } from "./storage";
import { acquireWorker } from "./worker-queue";
import { WORKER_TIMEOUT } from "./runtime";

export async function searchEvidence(file: Evidence, query: string, signal: AbortSignal): Promise<Item[]> {
  const release = await acquireWorker(signal);
  return new Promise<Item[]>((resolve, reject) => {
    const worker = new SearchWorker(), jobId = uid();
    let settled = false, sequence = 0;
    let ack: (() => void) | undefined, rejectAck: ((error: Error) => void) | undefined;
    const finish = (error?: Error, results: Item[] = []) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort); worker.terminate();
      rejectAck?.(error || new Error("Search finished"));
      error ? reject(error) : resolve(results);
    };
    const abort = () => finish(new DOMException("Search cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Search exceeded the 10 second job limit")), WORKER_TIMEOUT);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish(new Error("Search worker failed"));
    worker.onmessageerror = () => finish(new Error("Unreadable search result"));
    worker.onmessage = event => {
      const message = event.data;
      if (message.jobId !== jobId) return finish(new Error("Invalid search job identity"));
      if (message.type === "ack" && message.sequence === sequence) { ack?.(); ack = undefined; rejectAck = undefined; }
      else if (message.type === "result" && Array.isArray(message.results) && message.results.length <= 500) finish(undefined, message.results);
      else finish(new Error(message.error || "Malformed search response"));
    };
    const send = async () => {
      signal.throwIfAborted();
      worker.postMessage({ type: "start", jobId, query, fileId: file.id, name: file.name });
      const length = evidenceSize(file);
      for (let offset = 0; offset < length; offset += 256 * 1024) {
        const end = Math.min(length, offset + 256 * 1024);
        const bytes = file.bytes.length === length ? file.bytes.slice(offset, end) : await readEvidenceRange(file.id, offset, end);
        signal.throwIfAborted(); if (settled) return;
        await new Promise<void>((resolve, reject) => { ack = resolve; rejectAck = reject; worker.postMessage({ type: "chunk", jobId, sequence, offset, bytes }, [bytes.buffer]); });
        sequence++;
      }
      worker.postMessage({ type: "finish", jobId, chunks: sequence, byteLength: length });
    };
    void send().catch(error => finish(error));
  }).finally(release);
}
