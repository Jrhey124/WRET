import { byteToOffset, type Evidence, type Item, type Location } from "./model";
import { transformJavaScript, workspaceReferences, type Recipe } from "./gap-analysis";
import { decodeValue, decompressValue } from "./decoding";

self.onmessage = async (event: MessageEvent<any>) => {
  const { id, action } = event.data;
  try {
    if (action === "index") {
      const result = workspaceReferences(event.data.files as Evidence[]);
      self.postMessage({ id, type: "result", result });
    } else if (action === "transform") {
      const bytes = event.data.bytes as Uint8Array;
      const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const selection = event.data.location as Location | undefined;
      const range = selection ? { start: byteToOffset(bytes, selection.start), end: byteToOffset(bytes, selection.end) } : undefined;
      self.postMessage({ id, type: "result", result: transformJavaScript(source, event.data.recipe as Recipe, range) });
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
