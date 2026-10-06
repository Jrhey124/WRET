import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import {
  exportProject,
  importProject,
  loadProject,
  report,
  saveProject,
  fromBase64,
  toBase64,
  validateProjectBudgets,
} from "../../src/storage";
import { decodeValue } from "../../src/decoding";
import { newProject, sha256, type Project } from "../../src/model";
import { analyzeFile } from "../../src/analyze";
async function fixture(): Promise<Project> {
  const p = newProject();
  p.name = "<img src=x onerror=alert(1)>";
  const file = {
    id: "a",
    name: "sample.js",
    format: "javascript" as const,
    bytes: new TextEncoder().encode(
      'function a(){return "https://example.com"} a();',
    ),
  };
  p.files.push({ ...file, result: await analyzeFile(file) });
  p.notes.push({
    id: "n",
    kind: "label",
    text: "send candidate",
    location: { fileId: "a", start: 0, end: 10 },
  });
  p.decodes.push({
    id: "d",
    operation: "base64",
    input: "dGVzdA==",
    output: "test",
    location: { fileId: "a", start: 0, end: 4 },
    createdAt: new Date().toISOString(),
  });
  p.tools.push({
    id: "wret-static",
    version: "1.0.0",
    entry: "/tools/analysis.js",
    formats: ["javascript"],
    integrity: "a".repeat(64),
  });
  p.files[0].result!.findings[0].status = "investigating";
  return p;
}
describe("portable evidence and storage", () => {
  it("round-trips large Base64 evidence without regex stack overflow", () => {
    const bytes = new Uint8Array(4 * 1024 * 1024);
    bytes.fill(255);
    const decoded = fromBase64(toBase64(bytes));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.every((x) => x === 255)).toBe(true);
  });
  it("keeps annotation and result budgets bounded so full evidence archives remain importable", async () => {
    const p = await fixture();
    p.notes[0].text = "x".repeat(24 * 1024 * 1024);
    expect(() => validateProjectBudgets(p)).toThrow("annotation budget");
    p.notes = [];
    p.files[0].result!.formatted = "x".repeat(24 * 1024 * 1024);
    expect(() => validateProjectBudgets(p)).toThrow("result budget");
  });
  it("round-trips bytes, results, statuses, notes, decodes and exact tool pins", async () => {
    const original = await fixture();
    const restored = await importProject(await exportProject(original));
    expect(restored).toEqual(original);
    expect(await sha256(restored.files[0].bytes)).toBe(
      original.files[0].result!.hash,
    );
    await saveProject(restored);
    expect(await loadProject()).toEqual(restored);
  });
  it("rejects tampered evidence, invalid ranges, duplicate IDs and external tool entries", async () => {
    const p = await fixture(),
      text = await exportProject(p);
    const altered = JSON.parse(text);
    altered.files[0].bytes = btoa("changed");
    await expect(importProject(JSON.stringify(altered))).rejects.toThrow(
      "hash mismatch",
    );
    const range = JSON.parse(text);
    range.notes[0].location.end = 99999;
    await expect(importProject(JSON.stringify(range))).rejects.toThrow("note");
    const duplicate = JSON.parse(text);
    duplicate.files.push(duplicate.files[0]);
    await expect(importProject(JSON.stringify(duplicate))).rejects.toThrow(
      "file metadata",
    );
    const tool = JSON.parse(text);
    tool.tools[0].entry = "https://example.com/worker.js";
    await expect(importProject(JSON.stringify(tool))).rejects.toThrow(
      "tool pin",
    );
  });
  it("writes reports with hashes, notes, evidence ranges and escaped HTML", async () => {
    const p = await fixture(),
      md = report(p);
    expect(md).toContain(p.files[0].result!.hash);
    expect(md).toContain("send candidate");
    expect(md).toContain("bytes 0–10");
    expect(md).toContain("\\<img");
    expect(md).toContain("investigating");
    expect(md).toContain("Pinned tools");
  });
});
describe("non-executing, reversible decode history inputs", () => {
  it("decodes each supported form without evaluating content", () => {
    expect(decodeValue("base64", "YWxlcnQoMSk=")).toBe("alert(1)");
    expect(decodeValue("hex", "68 69")).toBe("hi");
    expect(decodeValue("url", "%3Cscript%3E")).toBe("<script>");
    expect(decodeValue("base64", "/w==")).toBe("\\xff");
  });
  it("rejects malformed encodings and oversized inputs", () => {
    expect(() => decodeValue("hex", "abc")).toThrow();
    expect(() => decodeValue("base64", "???")).toThrow();
    expect(() => decodeValue("url", "%zz")).toThrow();
    expect(() => decodeValue("hex", "a".repeat(1024 * 1024 + 1))).toThrow(
      "exceeds",
    );
  });
});
