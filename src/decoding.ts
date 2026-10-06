import { fromBase64 } from "./storage";
export function decodeValue(
  operation: "base64" | "hex" | "url",
  input: string,
): string {
  if (input.length > 1024 * 1024) throw new Error("Decode input exceeds 1 MiB");
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
