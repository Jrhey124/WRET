/** All sample-processing jobs share one slot; deadlines start after acquisition. */
const waiting: { resolve: (release: () => void) => void; reject: (error: Error) => void; signal?: AbortSignal; abort: () => void }[] = [];
let occupied = false;
function pump() {
  if (occupied) return;
  const next = waiting.shift();
  if (!next) return;
  next.signal?.removeEventListener("abort", next.abort);
  occupied = true;
  let released = false;
  next.resolve(() => { if (released) return; released = true; occupied = false; pump(); });
}
export function acquireWorker(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Job cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const job = { resolve, reject, signal, abort: () => {
      const index = waiting.indexOf(job);
      if (index >= 0) waiting.splice(index, 1);
      reject(new DOMException("Job cancelled", "AbortError"));
    } };
    signal?.addEventListener("abort", job.abort, { once: true });
    waiting.push(job); pump();
  });
}
