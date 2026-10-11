import { parseHar } from "./har";
import { buildStaticPreview } from "./static-render";
import { byteToOffset, type Evidence, type Item, type Location } from "./model";
import { deobfuscateJavaScript, observedContracts, snapshotDifferences, transformJavaScript, workspaceReferences, type DeobfuscationRecipe, type Recipe } from "./gap-analysis";
import { decodeValue, decompressValue } from "./decoding";

let stream: { id: string; options: any; files: Evidence[]; active?: { metadata: any; bytes: Uint8Array; offset: number }; sequence: number; total: number } | undefined;
self.onmessage = async (event: MessageEvent<any>) => {
  const { id, type } = event.data;
  try {
    const message = event.data;
    if (type === "start") {
      if (stream) throw new Error("Research job already active");
      stream = { id, options: message.options, files: [], sequence: 0, total: 0 }; return;
    }
    if (!stream || stream.id !== id) throw new Error("Unknown research job");
    if (type === "file") {
      if (stream.active || !Number.isSafeInteger(message.length) || message.length < 0 || message.length > 25 * 1024 * 1024 || stream.total + message.length > 25 * 1024 * 1024) throw new Error("Research input exceeds limits");
      stream.total += message.length;
      stream.active = { metadata: message.metadata, bytes: new Uint8Array(message.length), offset: 0 }; return;
    }
    if (type === "chunk") {
      const active = stream.active;
      if (!active || !(message.bytes instanceof Uint8Array) || message.bytes.length > 256 * 1024 || message.sequence !== stream.sequence || message.offset !== active.offset || active.offset + message.bytes.length > active.bytes.length) throw new Error("Malformed research chunk");
      active.bytes.set(message.bytes, active.offset); active.offset += message.bytes.length; stream.sequence++;
      self.postMessage({ id, type: "ack", sequence: message.sequence }); return;
    }
    if (type === "endFile") {
      const active = stream.active;
      if (!active || active.offset !== active.bytes.length) throw new Error("Incomplete research evidence");
      stream.files.push({ ...active.metadata, bytes: active.bytes }); stream.active = undefined; return;
    }
    if (type !== "finish" || stream.active) throw new Error("Incomplete research stream");
    event = { data: { ...stream.options, files: stream.files, bytes: stream.files[0]?.bytes, input: stream.options.action === "decode" ? new TextDecoder().decode(stream.files[0]?.bytes) : undefined } } as MessageEvent<any>;
    const action = stream.options.action; stream = undefined;
    if (action === "har") {
      const result = parseHar(new TextDecoder().decode(event.data.bytes));
      self.postMessage({ id, type: "result", result }, { transfer: result.resources.map(resource => resource.bytes.buffer as ArrayBuffer) });
    } else if (action === "snapshots") {
      const files = event.data.files as Evidence[];
      if (files.length !== 2) throw new Error("Select two snapshots");
      self.postMessage({ id, type: "result", result: snapshotDifferences(files[0], files[1]) });
    } else if (action === "contracts") {
      self.postMessage({ id, type: "result", result: observedContracts({ files: event.data.files, sessions: event.data.sessions }) });
    } else if (action === "preview") {
      const files = event.data.files as Evidence[];
      const file = files.find(file => file.id === event.data.fileId);
      if (!file) throw new Error("Preview evidence is unavailable");
      self.postMessage({ id, type: "result", result: buildStaticPreview(files, file) });
    } else if (action === "index") {
      const result = workspaceReferences(event.data.files as Evidence[]);
      self.postMessage({ id, type: "result", result });
    } else if (action === "transform") {
      const bytes = event.data.bytes as Uint8Array;
      const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const selection = event.data.location as Location | undefined;
      const range = selection ? { start: byteToOffset(bytes, selection.start), end: byteToOffset(bytes, selection.end) } : undefined;
      self.postMessage({ id, type: "result", result: transformJavaScript(source, event.data.recipe as Recipe, range) });
    } else if (action === "deobfuscate") {
      const bytes = event.data.bytes as Uint8Array;
      const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      self.postMessage({ id, type: "result", result: deobfuscateJavaScript(source, event.data.recipe as DeobfuscationRecipe, Boolean(event.data.removeDebugger)) });
    } else if (action === "potential") {
      const needle = new TextEncoder().encode(event.data.query as string);
      const results: Item[] = [];
      for (const file of event.data.files as Evidence[]) {
        let offset = 0;
        while (results.length < 500) {
          const found = file.bytes.indexOf(needle[0], offset);
          if (found < 0) break;
          if (found + needle.length <= file.bytes.length && needle.every((byte, index) => file.bytes[found + index] === byte)) {
            results.push({ id: `${file.id}:related:${found}`, name: event.data.query, kind: "potential text match", detail: file.name, location: { fileId: file.id, start: found, end: found + needle.length } });
            offset = found + Math.max(1, needle.length);
          } else offset = found + 1;
        }
        if (results.length >= 500) break;
      }
      self.postMessage({ id, type: "result", result: results });
    } else if (action === "decode") {
      const operation = event.data.operation as string;
      if (operation === "gzip" || operation === "deflate") {
        const bytes = await decompressValue(operation, event.data.input as string);
        const output = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        self.postMessage({ id, type: "result", result: { output, bytes } }, { transfer: [bytes.buffer as ArrayBuffer] });
      } else {
        self.postMessage({ id, type: "result", result: { output: decodeValue(operation as any, event.data.input as string) } });
      }
    } else throw new Error("Unknown research worker action");
  } catch (error) {
    self.postMessage({ id, type: "error", error: String(error) });
  }
};
