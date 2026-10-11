import { describe, it, expect, vi } from "vitest";
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
  evidenceMetadata,
  readEvidenceRange,
  materializeEvidence,
} from "../../src/storage";
import { decodeValue, decompressValue } from "../../src/decoding";
import { newProject, removeEvidence, sha256, type Project } from "../../src/model";
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
  it("reopens a 100 MiB project as metadata and preserves unloaded bytes through save and export", async () => {
    const project = newProject();
    for (let index = 0; index < 4; index++) {
      const bytes = new Uint8Array(25 * 1024 * 1024); bytes[0] = index + 1;
      project.files.push({ id: `lazy-${index}`, name: `${index}.bin`, format: "binary", bytes, hash: await sha256(bytes) });
    }
    await saveProject(project);
    const loaded = (await loadProject(true))!;
    expect(loaded.files.reduce((sum, file) => sum + file.bytes.length, 0)).toBe(0);
    expect(loaded.files.map(file => file.byteLength)).toEqual([25, 25, 25, 25].map(size => size * 1024 * 1024));
    await saveProject(loaded);
    const file = await materializeEvidence(loaded.files[2]);
    expect(file.bytes[0]).toBe(3);
    expect(await sha256(file.bytes)).toBe(project.files[2].hash);
    loaded.files = [loaded.files[2]];
    const portable = await importProject(await exportProject(loaded));
    expect(portable.files[0].hash).toBe(project.files[2].hash);
    expect(portable.files[0].byteLength).toBeUndefined();
  });
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
  it("stores byte chunks separately and reads ranges across chunk boundaries", async () => {
    const project = newProject();
    const bytes = Uint8Array.from({ length: 300_000 }, (_, index) => index % 251);
    project.files.push({ id: "chunked", name: "large.js", format: "javascript", bytes, hash: await sha256(bytes) });
    await saveProject(project);
    expect(await evidenceMetadata("chunked")).toEqual({ id: "chunked", name: "large.js", format: "javascript", byteLength: bytes.length, hash: await sha256(bytes) });
    expect(await readEvidenceRange("chunked", 262_140, 262_160)).toEqual(bytes.slice(262_140, 262_160));
  });
  it("atomically removes evidence, chunks, analysis and linked records while preserving the rest through reload", async () => {
    const project = newProject();
    const dropBytes = new TextEncoder().encode("const removed = true;"), keepBytes = new TextEncoder().encode("const retained = true;"),
      moduleBytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]), derivedBytes = new TextEncoder().encode("const derived = true;");
    const moduleHash = await sha256(moduleBytes), parentHash = await sha256(keepBytes), derivedHash = await sha256(derivedBytes);
    const drop = { id: "drop", name: "drop.js", format: "javascript" as const, bytes: dropBytes };
    const keep = { id: "keep", name: "keep.js", format: "javascript" as const, bytes: keepBytes };
    const module = { id: "module", name: "module.wasm", format: "wasm" as const, bytes: moduleBytes, hash: moduleHash };
    project.files = [
      { ...drop, result: await analyzeFile(drop) },
      { ...keep, result: await analyzeFile(keep) },
      { ...module, result: await analyzeFile(module) },
      { id: "derived", name: "derived.js", format: "javascript", bytes: derivedBytes, hash: derivedHash, derivation: { sourceId: "keep", sourceHash: parentHash, recipe: "fixture", createdAt: "now", changes: 1 } },
    ];
    project.notes = [
      { id: "drop-note", kind: "comment", text: "remove with file", location: { fileId: "drop", start: 0, end: 5 } },
      { id: "keep-note", kind: "comment", text: "keep with file", location: { fileId: "keep", start: 0, end: 5 } },
    ];
    project.wasmAliases = [{ moduleHash, functionIndex: 0, name: "module_entry" }];
    project.sessions = [{ id: "retained-session", createdAt: "now", target: "fixture", status: "stopped", approvals: [], observations: [{ sequence: 1, time: "now", kind: "console", data: { text: "retained" } }], capturedBytes: 0, truncated: false }];
    project.transformations = [{ id: "derived-step", parentEvidenceId: "keep", parentHash, inputRange: { start: 0, end: keepBytes.length }, operation: "fixture", version: 1, parameters: {}, createdAt: "now", outputEvidenceId: "derived", outputHash: derivedHash, mapping: "unknown" }];
    await saveProject(project);

    await saveProject(removeEvidence(project, "drop"));
    const afterFileDelete = await loadProject();
    expect(afterFileDelete?.files.map((file) => file.id).sort()).toEqual(["keep", "module", "derived"].sort());
    expect(afterFileDelete?.files.find((file) => file.id === "keep")?.bytes).toEqual(keepBytes);
    expect(afterFileDelete?.notes.map((note) => note.id)).toEqual(["keep-note"]);
    expect(afterFileDelete?.wasmAliases).toEqual(project.wasmAliases);
    expect(afterFileDelete?.sessions?.[0]).toMatchObject(project.sessions![0]);
    expect(await sha256(afterFileDelete!.files.find((file) => file.id === "keep")!.bytes)).toBe(parentHash);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("wret");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stores = await new Promise<{ chunks: any[]; analyses: any[] }>((resolve, reject) => {
      const tx = db.transaction(["projects", "contentChunks", "analysisResults"], "readonly");
      const pointer = tx.objectStore("projects").get("current");
      const chunks = tx.objectStore("contentChunks").getAll();
      const analyses = tx.objectStore("analysisResults").getAll();
      tx.oncomplete = () => resolve({ chunks: chunks.result, analyses: analyses.result.filter((record: any) => record.projectId === pointer.result.projectId) });
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const activeProjectId = (await loadProject())!.id;
    expect(stores.chunks.filter((record) => record.projectId === activeProjectId && record.fileId === "drop")).toEqual([]);
    expect(stores.analyses.some((record) => record.fileId === "drop")).toBe(false);

    const withoutDerived = removeEvidence(afterFileDelete!, "derived");
    await saveProject(withoutDerived);
    expect((await loadProject())?.transformations).toEqual([]);
    const withoutOthers = removeEvidence(withoutDerived, "keep");
    const withoutModule = removeEvidence(withoutOthers, "module");
    await saveProject(withoutModule);
    const finalProject = await loadProject();
    expect(finalProject?.files).toEqual([]);
    expect(finalProject?.wasmAliases).toEqual([]);
    expect(finalProject?.sessions?.[0]).toMatchObject(project.sessions![0]);
  });
  it("keeps the prior committed project intact when evidence chunk cleanup fails", async () => {
    const project = newProject();
    project.files = [{ id: "preserved", name: "preserved.js", format: "javascript", bytes: new TextEncoder().encode("still here") }];
    await saveProject(project);
    const originalDelete = IDBObjectStore.prototype.delete;
    const deleteSpy = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
      if (this.name === "contentChunks") throw new DOMException("simulated chunk cleanup failure", "DataError");
      return originalDelete.call(this, query);
    });
    try {
      await expect(saveProject({ ...project, files: [] })).rejects.toThrow("simulated chunk cleanup failure");
    } finally {
      deleteSpy.mockRestore();
    }
    expect((await loadProject())?.files.map((file) => file.id)).toEqual(["preserved"]);
    expect(await readEvidenceRange("preserved", 0, 10)).toEqual(new TextEncoder().encode("still here"));
  });
  it("round-trips schema 4 transformation ancestry and rejects a bad parent hash", async () => {
    const original = await fixture();
    const parent = original.files[0];
    const parentHash = await sha256(parent.bytes);
    parent.hash = parentHash;
    const outputBytes = new TextEncoder().encode("derived copy");
    const outputHash = await sha256(outputBytes);
    const outputId = "derived-1";
    original.files.push({ id: outputId, name: "derived/sample.js", format: "javascript", bytes: outputBytes, hash: outputHash });
    original.transformations = [{ id: "transform-1", parentEvidenceId: parent.id, parentHash, inputRange: { start: 0, end: parent.bytes.length }, operation: "fixture", version: 1, parameters: {}, createdAt: new Date().toISOString(), outputEvidenceId: outputId, outputHash, mapping: "unknown" }];
    const restored = await importProject(await exportProject(original));
    expect(restored.transformations).toEqual(original.transformations);
    const altered = JSON.parse(await exportProject(original));
    altered.transformations[0].parentHash = "f".repeat(64);
    await expect(importProject(JSON.stringify(altered))).rejects.toThrow("parent reference");
  });
  it("round-trips module-hash-scoped Wasm function aliases without changing bytes", async () => {
    const project = newProject();
    const bytes = Uint8Array.from([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,4,1,2,0,11]);
    const evidence = { id: "module", name: "stripped.wasm", format: "wasm" as const, bytes };
    const result = await analyzeFile(evidence);
    const hash = await sha256(bytes);
    project.files.push({ ...evidence, hash, result });
    project.wasmAliases = [{ moduleHash: hash, functionIndex: 0, name: "entry_point" }];
    const reopened = await importProject(await exportProject(project));
    expect(reopened.schema).toBe(5);
    expect(reopened.wasmAliases).toEqual(project.wasmAliases);
    expect(reopened.files[0].bytes).toEqual(bytes);
    expect(await sha256(reopened.files[0].bytes)).toBe(hash);
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
  it("decompresses gzip with strict streaming output bounds", async () => {
    const original = new TextEncoder().encode(Array.from({ length: 500 }, (_, index) => `WRET evidence record-${index} includes varying content\n`).join(""));
    const stream = new Blob([original]).stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    const output = await decompressValue("gzip", toBase64(compressed));
    expect(output).toEqual(original);
    const bombSource = new TextEncoder().encode("A".repeat(1024 * 1024));
    const bombStream = new Blob([bombSource]).stream().pipeThrough(new CompressionStream("gzip"));
    const bomb = new Uint8Array(await new Response(bombStream).arrayBuffer());
    await expect(decompressValue("gzip", toBase64(bomb))).rejects.toThrow("100×");
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
