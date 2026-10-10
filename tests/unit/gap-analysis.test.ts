import { describe, expect, it } from "vitest";
import { observedContracts, snapshotDifferences, transformJavaScript, workspaceReferences } from "../../src/gap-analysis";
import { exportProject, importProject } from "../../src/storage";
import { newProject, removeEvidence, sha256, type Evidence } from "../../src/model";
const file = (id: string, name: string, source: string): Evidence => ({ id, name, bytes: new TextEncoder().encode(source), format: name.endsWith(".js") ? "javascript" : "json" });

describe("gap investigation tools", () => {
  it("folds finite literals without invoking functions or losing negative zero", () => {
    expect(transformJavaScript("const a=2*3; const b=call()+2; const c=-0; const d=+1e400;", "literal-constants").source).toBe("const a=(6); const b=call()+2; const c=-0; const d=+1e400;");
    expect(transformJavaScript("const a=1/0;", "literal-constants").changes).toBe(0);
    expect(() => transformJavaScript("x".repeat(1024 * 1024 + 1), "literal-constants")).toThrow("1 MiB");
  });
  it("prunes constant branches conservatively and preserves hoisted declarations", () => {
    const result = transformJavaScript("if(false){var hoisted=1;} if(true){run();}else{other();}", "static-branches");
    expect(result.source).toContain("if(false){var hoisted=1;}");
    expect(result.source).toContain("{run();}");
    expect(result.source).not.toContain("other()");
    expect(result.diagnostics).toContain("Kept a constant branch because removing it could change hoisted declarations.");
  });
  it("limits transformations to AST nodes inside the original selection", () => {
    const source = "let a=1+2; let b=3+4; debugger;";
    const result = transformJavaScript(source, "literal-constants", { start: 6, end: 9 });
    expect(result.source).toBe("let a=(3); let b=3+4; debugger;");
    expect(transformJavaScript('const s="debugger;"; debugger;', "remove-debugger").source).toBe('const s="debugger;"; ;');
  });
  it("resolves module imports and shadowed reads/writes while keeping dynamic properties unresolved", () => {
    const a = file("a", "site/a.js", "export const answer=42;");
    const b = file("b", "site/b.js", 'import {answer} from "./a.js"; function f(){let answer=1; answer++;} console.log(answer); obj[key]();');
    const result = workspaceReferences([a, b]);
    expect(result.diagnostics).toEqual([]);
    expect(result.references.some((reference) => reference.name === "answer" && reference.certainty === "module" && reference.definition?.fileId === "a")).toBe(true);
    expect(result.references.some((reference) => reference.name === "answer" && reference.access === "read/write" && reference.definition?.fileId === "b")).toBe(true);
    expect(result.references.some((reference) => reference.access === "dynamic" && !reference.definition)).toBe(true);
  });
  it("infers bounded observed response types without retaining sample values", () => {
    const p = newProject();
    p.files = [file("r1", "one.json", '{"user":{"name":"private-value"},"ok":true}'), file("r2", "two.json", '{"ok":null}')];
    p.sessions = [{ id: "s", target: "fixture", createdAt: "now", status: "stopped", observations: [], approvals: [], capturedBytes: 1, truncated: false, requests: p.files.map((file, index) => ({ id: `r${index}`, requestId: `r${index}`, sequence: index + 1, startedAt: "now", url: "https://example.invalid/api?token=redacted", method: "GET", status: 200, evidenceId: file.id })) }];
    const result = observedContracts(p);
    expect(result).toHaveLength(1);
    expect(result[0].endpoint).toBe("GET https://example.invalid/api");
    expect(result[0].fields.find((field) => field.path === "$.ok")?.types).toEqual(["boolean", "null"]);
    expect(result[0].fields.find((field) => field.path === "$.user.name")?.samples).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private-value");
  });
  it("compares retained snapshot values and round-trips transformation provenance", async () => {
    const a = file("a", "before.json", JSON.stringify({ heapUsage: { usedSize: 10 }, scopes: [{ name: "local", properties: [{ name: "x", value: 1, type: "number" }] }] }));
    const b = file("b", "after.json", JSON.stringify({ heapUsage: { usedSize: 20 }, scopes: [{ name: "local", properties: [{ name: "x", value: 2, type: "number" }] }] }));
    expect(snapshotDifferences(a, b)).toHaveLength(2);
    const p = newProject(), original = file("original", "original.js", "const x=1+2;"), derived = file("derived", "derived.js", "const x=(3);");
    derived.derivation = { sourceId: original.id, sourceHash: await sha256(original.bytes), recipe: "literal-constants", createdAt: "now", changes: 1 };
    p.files = [original, derived];
    const restored = await importProject(await exportProject(p));
    expect(restored.files[1].derivation).toEqual(derived.derivation);
    const removed = removeEvidence(restored, "original");
    expect(removed.files[0].derivation?.sourceId).toBeUndefined();
    await expect(importProject(await exportProject(removed))).resolves.toBeDefined();
  });
});
