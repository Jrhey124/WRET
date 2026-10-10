import { decodeText, type Item } from "./model";

type Start = { type: "start"; jobId: string; query: string; fileId: string; name: string };
type Chunk = { type: "chunk"; jobId: string; sequence: number; offset: number; bytes: Uint8Array };
type Finish = { type: "finish"; jobId: string; chunks: number; byteLength: number };
let job: { id: string; query: Uint8Array; fileId: string; name: string; results: Item[]; tail: Uint8Array; next: number; length: number } | undefined;

self.onmessage = (event: MessageEvent<Start | Chunk | Finish>) => {
  try {
    const message = event.data;
    if (message.type === "start") {
      if (message.query.length > 4096) throw new Error("Search query exceeds 4 KiB");
      job = { id: message.jobId, query: new TextEncoder().encode(message.query), fileId: message.fileId, name: message.name, results: [], tail: new Uint8Array(), next: 0, length: 0 };
      return;
    }
    if (!job || message.jobId !== job.id) throw new Error("Unknown or expired search job");
    if (message.type === "chunk") {
      if (message.sequence !== job.next || message.offset !== job.length || message.bytes.length > 256 * 1024) throw new Error("Invalid search chunk sequence or size");
      const combined = new Uint8Array(job.tail.length + message.bytes.length);
      combined.set(job.tail); combined.set(message.bytes, job.tail.length);
      let offset = 0;
      while (job.results.length < 500) {
        const found = combined.indexOf(job.query[0], offset);
        if (found < 0) break;
        if (found + job.query.length <= combined.length && job.query.every((byte, index) => combined[found + index] === byte)) {
          const start = message.offset - job.tail.length + found;
          if (start >= 0 && start < message.offset + message.bytes.length && start + job.query.length > message.offset) {
            job.results.push({ id: `${job.fileId}:search:${start}`, name: decodeText(combined.subarray(Math.max(0, found - 25), found + job.query.length + 60)).replace(/\s/g, " "), kind: "search result", detail: job.name, location: { fileId: job.fileId, start, end: start + job.query.length } });
          }
          offset = found + Math.max(1, job.query.length);
        } else offset = found + 1;
      }
      const keep = Math.min(combined.length, Math.max(0, job.query.length - 1));
      job.tail = combined.slice(combined.length - keep);
      job.length += message.bytes.length; job.next++;
      self.postMessage({ type: "ack", jobId: job.id, sequence: message.sequence });
      return;
    }
    if (message.chunks !== job.next || message.byteLength !== job.length) throw new Error("Search input length did not match its chunks");
    self.postMessage({ type: "result", jobId: job.id, results: job.results });
    job = undefined;
  } catch (error) {
    self.postMessage({ type: "error", jobId: job?.id, error: String(error) });
    job = undefined;
  }
};
