import { analyzeFile, beautifyEvidence } from "./analyze";
import type { Evidence, AnalysisOptions } from "./model";
let incoming: { action?: "analyze" | "beautify"; file: Omit<Evidence, "bytes">; bytes: Uint8Array; next: number; length: number; options?: AnalysisOptions } | undefined;
async function run(action: "analyze" | "beautify", file: Evidence, options?: AnalysisOptions) {
  try {
    if (action === "beautify") {
      const formatted = await beautifyEvidence(file);
      self.postMessage({ type: "beautified", formatted });
      return;
    }
    const result = await analyzeFile(
      file,
      (progress) => self.postMessage({ type: "progress", progress }),
      options,
    );
    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({ type: "error", error: String(error) });
  }
}
self.onmessage = async (event: MessageEvent<any>) => {
  const message = event.data;
  try {
    if (message.type === "start") {
      if (incoming) throw new Error("A worker job is already active");
      if (!message.file || !Number.isSafeInteger(message.byteLength) || message.byteLength < 0 || message.byteLength > 25 * 1024 * 1024 || !["analyze", "beautify"].includes(message.action)) throw new Error("Invalid chunked worker job");
      incoming = { action: message.action, file: message.file, bytes: new Uint8Array(message.byteLength), next: 0, length: 0, options: message.options };
      return;
    }
    if (message.type === "chunk") {
      if (!incoming || message.sequence !== incoming.next || message.offset !== incoming.length || !(message.bytes instanceof Uint8Array) || message.bytes.length > 256 * 1024 || incoming.length + message.bytes.length > incoming.bytes.length) throw new Error("Invalid worker byte chunk");
      incoming.bytes.set(message.bytes, incoming.length); incoming.length += message.bytes.length; incoming.next++;
      self.postMessage({ type: "ack", sequence: message.sequence });
      return;
    }
    if (message.type === "finish") {
      if (!incoming || message.chunks !== incoming.next || message.byteLength !== incoming.length || incoming.length !== incoming.bytes.length) throw new Error("Worker byte stream ended at an invalid length");
      const job = incoming; incoming = undefined;
      await run(job.action || "analyze", { ...job.file, bytes: job.bytes } as Evidence, job.options);
      return;
    }
    if (message.file) await run(message.action || "analyze", message.file, message.options);
    else throw new Error("Invalid worker message");
  } catch (error) {
    incoming = undefined;
    self.postMessage({ type: "error", error: String(error) });
  }
};
