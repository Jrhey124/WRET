import { describe, expect, it } from "vitest";
import { beautifyEvidence } from "../../src/analyze";
import { buildStaticPreview } from "../../src/static-render";
import type { Evidence } from "../../src/model";

function evidence(name: string, source: string, format: Evidence["format"]): Evidence {
  return { id: name, name, format, bytes: new TextEncoder().encode(source) };
}
function binary(name: string, bytes: number[]): Evidence {
  return { id: name, name, format: "binary", bytes: new Uint8Array(bytes) };
}

describe("Beautify and static preview", () => {
  it.each([
    ["page.html", "<html><head><script>const x={a:1}</script><style>h1{color:red}</style></head><body><script>evil()</script><h1>Hello</h1></body></html>", "<h1>"],
    ["app.js", "const x={a:1};", "a: 1"],
    ["style.css", "h1{color:red}", "color: red"],
    ["data.json", "{\"x\":1}", '"x": 1'],
    ["map.js.map", "{\"version\":3,\"sources\":[]}", '"sources": []'],
  ])("beautifies supported source %s", async (name, source, expected) => {
    const format: Evidence["format"] = name.endsWith("html") ? "html" : name.endsWith("js") ? "javascript" : name.endsWith("css") ? "css" : name.endsWith("json") ? "json" : "sourcemap";
    expect(await beautifyEvidence(evidence(name, source, format))).toContain(expected);
  });
  it("keeps invalid and oversized source available without changing it", async () => {
    await expect(beautifyEvidence(evidence("bad.js", "const =", "javascript"))).rejects.toThrow();
    await expect(beautifyEvidence(evidence("large.js", "x".repeat(5 * 1024 * 1024 + 1), "javascript"))).rejects.toThrow(/5 MiB/);
  });

  it("reconstructs inert HTML and resolves local styles and raster images without contacting external URLs", () => {
    const page = evidence("site/index.html", '<!doctype html><html><head><link rel="stylesheet" href="css/main.css"></head><body onload="evil()"><script>evil()</script><iframe src="https://evil.invalid"></iframe><form action="https://evil.invalid"><input></form><img src="img/pixel.png" onerror="evil()"><img src="https://evil.invalid/x.png"><a href="javascript:evil()">link</a></body></html>', "html");
    const result = buildStaticPreview([
      page,
      evidence("site/css/main.css", 'h1{color:red}@import "nested.css";', "css"),
      evidence("site/css/nested.css", "body{margin:0}", "css"),
      binary("site/img/pixel.png", [137,80,78,71]),
    ], page);
    expect(result.document).toContain("Content-Security-Policy");
    expect(result.document).toContain("data:image/png;base64,");
    expect(result.document).toContain("color:red");
    expect(result.document).toContain("margin:0");
    for (const forbidden of ["<script", "<iframe", "<form", "onload=", "onerror=", "javascript:", "evil.invalid"]) expect(result.document).not.toContain(forbidden);
    expect(result.omittedResources).toBeGreaterThan(0);
  });

  it("caps sources and reports missing assets and CSS import cycles", () => {
    const page = evidence("index.html", '<link rel="stylesheet" href="a.css"><img src="missing.png">', "html");
    const css = evidence("a.css", '@import "b.css";body{background:url(missing.png)}', "css");
    const nested = evidence("b.css", '@import "a.css";p{color:red}', "css");
    const result = buildStaticPreview([page, css, nested], page);
    expect(result.omittedResources).toBeGreaterThan(0);
    expect(result.diagnostics.join(" ")).toContain("omitted");
    const large = evidence("large.html", "x".repeat(5 * 1024 * 1024 + 1), "html");
    expect(() => buildStaticPreview([large], large)).toThrow(/5 MiB/);
  });
  it("bounds repeated embedding of the same asset instead of multiplying preview memory", () => {
    const page = evidence("index.html", '<img src="pixel.png">'.repeat(30), "html");
    const image = { id: "pixel", name: "pixel.png", format: "binary" as const, bytes: new Uint8Array(1024 * 1024) };
    const result = buildStaticPreview([page, image], page);
    expect(result.document.length).toBeLessThan(21 * 1024 * 1024);
    expect(result.omittedResources).toBeGreaterThan(0);
  });
});
