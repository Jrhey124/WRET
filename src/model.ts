export const FILE_LIMIT = 25 * 1024 * 1024;
export const PROJECT_LIMIT = 100 * 1024 * 1024;
export const RESULT_LIMIT = 5000;
export const DERIVED_STORAGE_LIMIT = 24 * 1024 * 1024;
export const ANNOTATION_STORAGE_LIMIT = 24 * 1024 * 1024;
export type Format =
  "javascript" | "html" | "css" | "json" | "sourcemap" | "wasm" | "binary";
export interface Location {
  fileId: string;
  start: number;
  end: number;
}
export interface Item {
  id: string;
  name: string;
  kind: string;
  location: Location;
  detail?: string;
  target?: string;
}
export interface Finding extends Item {
  status: "unreviewed" | "investigating" | "confirmed" | "dismissed";
}
export interface Analysis {
  hash: string;
  /** Analyzer that produced this result. Missing on older archives means legacy provenance. */
  tool?: ToolPin;
  strings: Item[];
  outline: Item[];
  references: Item[];
  calls: Item[];
  findings: Finding[];
  sections: Item[];
  ast?: string;
  formatted?: string;
  wat?: string;
  wasmFunctions?: WasmFunction[];
  wasmInstructions?: WasmInstruction[];
  wasmCoverage?: { decoded: number; total: number; reason?: string };
  diagnostics: string[];
}
export interface WasmFunction {
  index: number;
  imported: boolean;
  name: string;
  typeIndex?: number;
  location?: Location;
}
export interface WasmInstruction {
  functionIndex: number;
  offset: number;
  end: number;
  opcode: string;
  operands: string;
  callTarget?: number;
}
export interface WasmAlias { moduleHash: string; functionIndex: number; name: string; }
export interface AnalysisOptions {
  maxEntries?: number;
}
export interface Evidence {
  id: string;
  name: string;
  format: Format;
  bytes: Uint8Array;
  hash?: string;
  runtimeUrl?: string;
  sourceMapOf?: string;
  derivation?: { sourceId?: string; sourceHash: string; recipe: string; createdAt: string; changes: number };
  captureKind?: "snapshot" | "script" | "response" | "live-edit";
  result?: Analysis;
}
export interface Note {
  id: string;
  kind: "comment" | "bookmark" | "label";
  text: string;
  location: Location;
}
export interface Decode {
  id: string;
  operation: "base64" | "hex" | "url" | "strings" | "nested" | "gzip" | "deflate";
  input: string;
  output: string;
  location: Location;
  createdAt: string;
}
export interface Transformation {
  id: string;
  parentEvidenceId?: string;
  parentHash: string;
  inputRange: { start: number; end: number };
  operation: string;
  version: 1;
  parameters: Record<string, string | number | boolean>;
  createdAt: string;
  outputEvidenceId: string;
  outputHash: string;
  mapping: "exact" | "range" | "unknown";
  parentUnavailable?: boolean;
}
export interface ToolPin {
  id: string;
  version: string;
  formats: string[];
  entry: string;
  integrity: string;
}
export interface Project {
  schema: 1 | 2 | 3 | 4 | 5;
  id: string;
  name: string;
  createdAt: string;
  files: Evidence[];
  notes: Note[];
  decodes: Decode[];
  tools: ToolPin[];
  sessions?: import("./debug-types").DebugSession[];
  breakpoints?: import("./debug-types").Breakpoint[];
  transformations?: Transformation[];
  wasmAliases?: WasmAlias[];
}
export interface Job {
  id: string;
  fileId: string;
  name: string;
  status: "queued" | "running" | "done" | "cancelled" | "failed";
  progress: string;
}
let fallbackIdCounter = 0;

/** UUIDs are identifiers, not secrets. randomUUID is unavailable on plain-HTTP
 * LAN origins in some browsers, so use getRandomValues when possible and a
 * collision-resistant local fallback only when Web Crypto itself is absent. */
export const uid = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    const seed = `${Date.now()}-${++fallbackIdCounter}-${Math.random()}`;
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = (Math.random() * 256) ^ seed.charCodeAt(i % seed.length);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
};
export function newProject(): Project {
  return {
    schema: 5,
    id: uid(),
    name: "Untitled investigation",
    createdAt: new Date().toISOString(),
    files: [],
    notes: [],
    decodes: [],
    tools: [],
    sessions: [],
    breakpoints: [],
    transformations: [],
    wasmAliases: [],
  };
}
/** Remove one imported evidence item and project records anchored to it. */
export function removeEvidence(project: Project, evidenceId: string): Project {
  const evidence = project.files.find((file) => file.id === evidenceId);
  if (!evidence) return project;
  const removedModuleHash = evidence.format === "wasm" ? evidence.hash || evidence.result?.hash : undefined;
  const remainingModuleHashes = new Set(project.files.filter((file) => file.id !== evidenceId && file.format === "wasm").map((file) => file.hash || file.result?.hash).filter((hash): hash is string => Boolean(hash)));
  return {
    ...project,
    files: project.files.filter((file) => file.id !== evidenceId).map((file) => ({
      ...file,
      sourceMapOf: file.sourceMapOf === evidenceId ? undefined : file.sourceMapOf,
      derivation: file.derivation?.sourceId === evidenceId ? { ...file.derivation, sourceId: undefined } : file.derivation,
    })),
    transformations: (project.transformations || []).filter((entry) => entry.outputEvidenceId !== evidenceId).map((entry) => entry.parentEvidenceId === evidenceId ? { ...entry, parentUnavailable: true } : entry),
    wasmAliases: removedModuleHash && !remainingModuleHashes.has(removedModuleHash) ? (project.wasmAliases || []).filter((alias) => alias.moduleHash !== removedModuleHash) : project.wasmAliases || [],
    sessions: project.sessions?.map((session) => ({ ...session, requests: session.requests?.map((request) => request.evidenceId === evidenceId ? { ...request, evidenceId: undefined, truncated: true } : request) })),
    notes: project.notes.filter((note) => note.location.fileId !== evidenceId),
    decodes: project.decodes.filter((decode) => decode.location.fileId !== evidenceId),
    breakpoints: (project.breakpoints || []).filter((breakpoint) => {
      if (evidence.runtimeUrl && breakpoint.url === evidence.runtimeUrl) return false;
      try {
        const path = decodeURIComponent(new URL(breakpoint.url).pathname.replace(/^\/+/, ""));
        return path !== evidence.name;
      } catch {
        return true;
      }
    }),
  };
}
export function detectFormat(name: string, bytes: Uint8Array): Format {
  if (bytes[0] === 0 && bytes[1] === 97 && bytes[2] === 115 && bytes[3] === 109)
    return "wasm";
  const ext = name.split(".").pop()?.toLowerCase();
  return (
    (
      {
        js: "javascript",
        mjs: "javascript",
        cjs: "javascript",
        jsx: "javascript",
        html: "html",
        htm: "html",
        css: "css",
        json: "json",
        map: "sourcemap",
        wasm: "wasm",
      } as Record<string, Format>
    )[ext || ""] || "binary"
  );
}
export const decodeText = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
export function offsetToByte(text: string, offset: number): number {
  return new TextEncoder().encode(text.slice(0, offset)).length;
}
export function byteToOffset(bytes: Uint8Array, offset: number): number {
  return decodeText(bytes.subarray(0, offset)).length;
}
export function sourceLineStarts(text: string): number[] {
  const starts = [text.charCodeAt(0) === 0xfeff ? 1 : 0];
  for (const m of text.matchAll(/\r\n|\r|\n/g))
    starts.push(m.index! + m[0].length);
  return starts;
}
export function sourcePosition(
  bytes: Uint8Array,
  byte: number,
): { lineNumber: number; column: number } {
  const prefix = decodeText(bytes.subarray(0, byte)),
    starts = sourceLineStarts(prefix);
  return {
    lineNumber: starts.length,
    column: Math.max(1, prefix.length - starts[starts.length - 1] + 1),
  };
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle?.digest) {
    return Array.from(
      new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer)),
    ).map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  return sha256Fallback(bytes);
}

// Small synchronous SHA-256 fallback for browsers that disable SubtleCrypto on
// insecure LAN origins. This keeps import, persistence, and integrity checks
// working over HTTP; HTTPS is still recommended for a secure browser context.
function sha256Fallback(input: Uint8Array): string {
  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(input); data[input.length] = 0x80;
  const view = new DataView(data.buffer);
  const high = Math.floor(bitLength / 0x100000000);
  view.setUint32(paddedLength - 8, high); view.setUint32(paddedLength - 4, bitLength >>> 0);
  const w = new Uint32Array(64), rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3), s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+hh)>>>0;
  }
  return h.map((value) => value.toString(16).padStart(8, "0")).join("");
}
