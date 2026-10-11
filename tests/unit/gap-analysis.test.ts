import { describe, expect, it } from "vitest";
import { deobfuscateJavaScript, observedContracts, snapshotDifferences, transformJavaScript, workspaceReferences } from "../../src/gap-analysis";
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
    expect(result.diagnostics).toContain("Kept a constant branch because removing it could change hoisting or directive semantics.");
    expect(transformJavaScript('if(true) "use strict";', "static-branches").source).toBe('if(true) "use strict";');
  });
  it("limits transformations to AST nodes inside the original selection", () => {
    const source = "let a=1+2; let b=3+4; debugger;";
    const result = transformJavaScript(source, "literal-constants", { start: 6, end: 9 });
    expect(result.source).toBe("let a=(3); let b=3+4; debugger;");
    expect(transformJavaScript('const s="debugger;"; debugger;', "remove-debugger").source).toBe('const s="debugger;"; ;');
  });
  it("runs conservative cleanup without executing code and records changed recipe stages", () => {
    const source = 'const _0x=["admin","password"]; const key="api_"+"key"; send(_0x[0], _0x[1], object["name"], key); if(false){ dead(); } else { keep(); } debugger;';
    const result = deobfuscateJavaScript(source);
    expect(result.source).toContain('send("admin", "password", object.name, key)');
    expect(result.source).toContain("{ keep(); }");
    expect(result.source).toContain("debugger;");
    const changedSteps = result.steps?.filter(step => step.changes);
    expect(changedSteps?.map(step => step.recipe)).toEqual(["fold-strings", "const-string-arrays", "normalize-properties", "static-branches"]);
    expect(changedSteps?.every(step => step.changes > 0)).toBe(true);
  });
  it("leaves string arrays unchanged when references mutate, escape, are dynamic, or execute later", () => {
    for (const source of [
      'const values=["x"]; values[0]="y"; use(values[0]);',
      'const values=["x"]; const alias=values; use(values[0]);',
      'const values=["x"]; use(values[index]);',
      'const values=["x"]; function later(){ return values[0]; }',
      'const values=["x"]; use(values[0]());',
      'const values=["x"]; values[0]\`tag\`;',
      'const values=["x"]; eval("values"); use(values[0]);',
      'use(values[0]); const values=["x"];',
      'export const values=["x"]; use(values[0]);',
      'with (scope) { const values=["x"]; use(values[0]); }',
    ]) {
      const result = deobfuscateJavaScript(source, "const-string-arrays");
      expect(result.source).toBe(source);
    }
  });
  it("normalizes only supported computed property reads and keeps optional chains and writes", () => {
    const source = 'obj["name"]; obj["not-valid-key"]; obj?.["name"]; obj["name"]=1;';
    const result = deobfuscateJavaScript(source, "normalize-properties");
    expect(result.source).toBe('obj.name; obj["not-valid-key"]; obj?.["name"]; obj["name"]=1;');
    expect(deobfuscateJavaScript('(getObject()["name"]);', "normalize-properties").source).toBe('(getObject().name);');
  });
  it("makes debugger removal explicitly opt-in and rejects malformed code", () => {
    expect(deobfuscateJavaScript("debugger;").source).toBe("debugger;");
    expect(deobfuscateJavaScript("debugger;", "conservative-cleanup", true).source).toBe(";");
    expect(() => deobfuscateJavaScript("function {")).toThrow();
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
