import { describe, it, expect } from "vitest";
import wabtFactory from "wabt";
import { analyzeFile, wasmSections } from "../../src/analyze";
import { decodeText, type Evidence } from "../../src/model";
const js = (text: string): Evidence => ({
  id: "file-1",
  name: "sample.js",
  format: "javascript",
  bytes: new TextEncoder().encode(text),
});
describe("static investigation", () => {
  it("preserves BOM offsets, reports invalid UTF-8, and honors bounded tool options", async () => {
    const file = js('\uFEFFconst url="https://EXAMPLE.invalid/a";');
    const r = await analyzeFile(file);
    for (const finding of r.findings)
      expect(
        decodeText(
          file.bytes.subarray(finding.location.start, finding.location.end),
        ),
      ).toBe(finding.name);
    expect(
      r.findings.some(
        (f) => f.kind === "URL host" && f.name === "EXAMPLE.invalid",
      ),
    ).toBe(true);
    const invalid = await analyzeFile({
      ...js(""),
      bytes: new Uint8Array([255, 65, 66, 67, 68]),
    });
    expect(invalid.diagnostics.join()).toContain("not valid UTF-8");
    expect(invalid.strings[0].location.start).toBe(1);
    const bounded = await analyzeFile(
      js("function a(){} function b(){} a(); b();"),
      () => {},
      { maxEntries: 1 },
    );
    expect(bounded.outline).toHaveLength(1);
    expect(bounded.calls).toHaveLength(1);
  });
  it("resolves lexical functions, references and shadowing with original UTF-8 byte ranges", async () => {
    const source =
      'const label = "🧭é"; function send(x) { return fetch(x); } function local(send) { send("shadow"); } send("https://example.com/a");';
    const file = js(source),
      r = await analyzeFile(file);
    expect(r.diagnostics).toEqual([]);
    expect(r.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.outline.map((x) => x.name)).toEqual(["send", "local"]);
    expect(r.calls.filter((x) => x.kind === "static call")).toHaveLength(1);
    expect(
      r.calls.filter((x) => x.kind === "unresolved dynamic call"),
    ).toHaveLength(2);
    expect(r.references.some((x) => x.name === "send")).toBe(true);
    for (const finding of r.findings)
      expect(
        decodeText(
          file.bytes.subarray(finding.location.start, finding.location.end),
        ),
      ).toBe(finding.name);
    for (const fn of r.outline)
      expect(
        decodeText(file.bytes.subarray(fn.location.start, fn.location.end)),
      ).toContain(`function ${fn.name}`);
    expect(r.formatted).toContain("\n");
    expect(r.ast).toContain("FunctionDeclaration");
    expect(decodeText(file.bytes)).toBe(source);
  });
  it("does not resolve reassigned or property calls", async () => {
    const r = await analyzeFile(
      js("let f = () => 1; f = other; f(); object[f]();"),
    );
    expect(r.calls).toHaveLength(2);
    expect(r.calls.every((x) => x.kind === "unresolved dynamic call")).toBe(
      true,
    );
  });
  it("handles malformed and obfuscated files without losing metadata", async () => {
    const bad = await analyzeFile(
      js('function broken( { fetch("https://example.com");'),
    );
    expect(bad.hash).toHaveLength(64);
    expect(bad.diagnostics.join()).toContain("parsing");
    expect(bad.findings.length).toBeGreaterThan(0);
    const obfuscated = await analyzeFile(
      js(
        'const _0x=["ZmV0Y2g="];globalThis[atob(_0x[0])]("https://example.com");',
      ),
    );
    expect(
      obfuscated.calls.every((c) => c.kind === "unresolved dynamic call"),
    ).toBe(true);
    expect(obfuscated.findings.some((f) => f.name === "atob")).toBe(true);
  });
  it("records missing source maps without fetching them or executing sample code", async () => {
    const source =
      'throw new Error("never execute");\n//# sourceMappingURL=https://example.com/missing.map';
    const r = await analyzeFile(js(source));
    expect(r.diagnostics.join()).toContain("not fetched");
    expect(r.hash).toHaveLength(64);
  });
  it("inspects JSON, HTML and opaque bytes as data", async () => {
    const json = await analyzeFile({ ...js('{"a":1}'), format: "json" });
    expect(json.formatted).toContain('  "a"');
    const html = await analyzeFile({
      ...js(
        '<script>throw Error("no")</script><img src="https://example.com/x">',
      ),
      format: "html",
    });
    expect(html.findings.some((f) => f.kind === "URL")).toBe(true);
    const binary = await analyzeFile({
      ...js(""),
      format: "binary",
      bytes: new Uint8Array([0, 65, 66, 67, 68, 0, 255]),
    });
    expect(binary.strings[0].name).toBe("ABCD");
    expect(binary.strings[0].location).toEqual({
      fileId: "file-1",
      start: 1,
      end: 5,
    });
  });
  it("disassembles stripped WASM with imports, exports, sections and linked function bodies", async () => {
    const wabt = await wabtFactory(),
      module = wabt.parseWat(
        "fixture.wat",
        '(module (import "env" "log" (func (param i32))) (func (export "answer") (result i32) i32.const 42))',
      );
    const bytes = new Uint8Array(
      module.toBinary({ write_debug_names: false }).buffer,
    );
    module.destroy();
    const r = await analyzeFile({
      id: "wasm",
      name: "stripped.wasm",
      format: "wasm",
      bytes,
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.wat).toContain("i32.const 42");
    expect(r.outline.map((x) => x.kind)).toContain("wasm import");
    expect(r.outline.map((x) => x.kind)).toContain("wasm export");
    const fn = r.outline.find((x) => x.kind === "wasm func")!;
    expect(fn.target).toMatch(/^wat:\d+$/);
    expect(bytes[fn.location.end - 1]).toBe(11);
    expect(r.sections.some((s) => s.kind === "function body")).toBe(true);
  });
  it("handles malformed and truncated WASM", async () => {
    expect(() => wasmSections(new Uint8Array([0, 97, 115]), "w")).toThrow(
      "truncated",
    );
    const r = await analyzeFile({
      id: "w",
      name: "bad.wasm",
      format: "wasm",
      bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 10, 10, 1]),
    });
    expect(r.hash).toHaveLength(64);
    expect(r.diagnostics.join()).toContain("Truncated");
  });
});
