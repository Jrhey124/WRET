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
  strings: Item[];
  outline: Item[];
  references: Item[];
  calls: Item[];
  findings: Finding[];
  sections: Item[];
  ast?: string;
  formatted?: string;
  wat?: string;
  diagnostics: string[];
}
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
  schema: 1 | 2 | 3 | 4;
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
}
export interface Job {
  id: string;
  fileId: string;
  name: string;
  status: "queued" | "running" | "done" | "cancelled" | "failed";
  progress: string;
}
export const uid = () => crypto.randomUUID();
export function newProject(): Project {
  return {
    schema: 4,
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
  };
}
/** Remove one imported evidence item and project records anchored to it. */
export function removeEvidence(project: Project, evidenceId: string): Project {
  const evidence = project.files.find((file) => file.id === evidenceId);
  if (!evidence) return project;
  return {
    ...project,
    files: project.files.filter((file) => file.id !== evidenceId).map((file) => ({
      ...file,
      sourceMapOf: file.sourceMapOf === evidenceId ? undefined : file.sourceMapOf,
      derivation: file.derivation?.sourceId === evidenceId ? { ...file.derivation, sourceId: undefined } : file.derivation,
    })),
    transformations: (project.transformations || []).filter((entry) => entry.outputEvidenceId !== evidenceId).map((entry) => entry.parentEvidenceId === evidenceId ? { ...entry, parentUnavailable: true } : entry),
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
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
