import { fromBase64 } from "./storage";
import { foldStrings } from "./investigation";
export function decodeValue(
  operation: "base64" | "hex" | "url" | "strings" | "nested" | "gzip" | "deflate",
  input: string,
): string {
  if (input.length > 1024 * 1024) throw new Error("Decode input exceeds 1 MiB");
  if (operation === "strings") return foldStrings(input);
  if (operation === "nested") {
    let output = input;
    for (let depth = 0; depth < 5; depth++) {
      let next: string;
      if (/%[a-f0-9]{2}/i.test(output)) next = decodeValue("url", output);
      else if (
        /^[a-f0-9\s]+$/i.test(output) &&
        output.replace(/\s/g, "").length % 2 === 0
      )
        next = decodeValue("hex", output);
      else if (
        /^[A-Za-z0-9+/\s]+={0,2}$/.test(output) &&
        output.replace(/\s/g, "").length >= 4 &&
        output.replace(/\s/g, "").length % 4 === 0
      )
        next = decodeValue("base64", output);
      else break;
      if (
        next === output ||
        /\\x[0-9a-f]{2}|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i.test(next)
      )
        break;
      output = next;
    }
    return output;
  }
  if (operation === "url") return decodeURIComponent(input);
  let bytes: Uint8Array;
  if (operation === "base64") {
    const compact = input.replace(/\s/g, "");
    bytes = fromBase64(compact.padEnd(Math.ceil(compact.length / 4) * 4, "="));
  } else {
    const compact = input.replace(/\s/g, "");
    if (compact.length % 2 || !/^[a-fA-F0-9]*$/.test(compact))
      throw new Error("Hex input must contain complete byte pairs");
    bytes = Uint8Array.from(compact.match(/../g) || [], (x) => parseInt(x, 16));
  }
  // Lossless display: binary bytes are escaped if the decoded data is not valid UTF-8.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return Array.from(
      bytes,
      (b) => `\\x${b.toString(16).padStart(2, "0")}`,
    ).join("");
  }
}

/** Decode Base64 compressed bytes with streaming output and expansion limits. */
export async function decompressValue(
  operation: "gzip" | "deflate",
  input: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (input.length > 2 * 1024 * 1024) throw new Error("Compressed input exceeds its 1 MiB decoded limit");
  const encoded = input.replace(/\s/g, "");
  const compressed = fromBase64(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
  if (compressed.length > 1024 * 1024) throw new Error("Compressed input exceeds 1 MiB");
  if (typeof DecompressionStream === "undefined") throw new Error("This browser does not support bounded decompression");
  const format = operation === "gzip" ? "gzip" : "deflate";
  const inputBuffer = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer;
  const stream = new Blob([inputBuffer]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const started = performance.now();
  try {
    while (true) {
      signal?.throwIfAborted();
      if (performance.now() - started > 10_000) throw new Error("Decompression exceeded the 10 second job limit");
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 5 * 1024 * 1024) throw new Error("Decompressed output exceeds 5 MiB");
      if (total > Math.max(1, compressed.length) * 100) throw new Error("Decompression exceeds the 100× expansion limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
