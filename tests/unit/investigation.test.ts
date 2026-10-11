import { describe, expect, it } from "vitest";
import {
  evidencePath,
  sourceMappings,
  foldStrings,
  dependencies,
  embeddedSources,
} from "../../src/investigation";
import { decodeValue } from "../../src/decoding";
import { newProject, type Evidence } from "../../src/model";
import {
  exportProject,
  importProject,
  validateProjectBudgets,
} from "../../src/storage";
import { portableObservation, updateCapturedRequests } from "../../src/capture";
import { parseHar, HAR_BODY_LIMIT } from "../../src/har";
const evidence = (id: string, name: string, text: string): Evidence => ({
  id,
  name,
  format: name.endsWith(".map") ? "sourcemap" : "javascript",
  bytes: new TextEncoder().encode(text),
});
describe("guided investigation evidence", () => {
  it("inspects inert HTML resources without constructing browser nodes", () => {
    const html = {
      ...evidence(
        "h",
        "site/index.html",
        '<img src="https://example.invalid/pixel"><iframe src="https://example.invalid/frame"></iframe><script src="/app.js"></script><link href="missing.css">',
      ),
      format: "html" as const,
    };
    const js = evidence("j", "site/app.js", "");
    const resources = dependencies([html, js]);
    expect(resources).toHaveLength(3);
    expect(resources.find((resource) => resource.reference === "/app.js")?.target?.id).toBe("j");
    expect(resources.find((resource) => resource.reference === "missing.css")?.target).toBeUndefined();
    expect(resources.find((resource) => resource.reference === "https://example.invalid/pixel")?.external).toBe(true);
  });
  it("extracts supplied embedded originals and preserves map provenance", () => {
    const map = evidence(
      "m",
      "app.js.map",
      JSON.stringify({
        version: 3,
        sources: ["webpack:///src/app.js"],
        sourcesContent: ["const original = 1;"],
        mappings: "AAAA",
      }),
    );
    const originals = embeddedSources([map]);
    expect(originals[0].sourceMapOf).toBe("m");
    const generated = evidence(
      "g",
      "app.js",
      "x();\n//# sourceMappingURL=app.js.map",
    );
    expect(
      sourceMappings([generated, map, ...originals], generated).mappings[0]
        .original.fileId,
    ).toBe(originals[0].id);
  });
  it("preserves relative paths and rejects traversal and absolute paths", () => {
    expect(evidencePath("site\\src\\app.js")).toBe("site/src/app.js");
    for (const path of [
      "../app.js",
      "/app.js",
      "C:/app.js",
      "site/../app.js",
      "site//app.js",
    ])
      expect(() => evidencePath(path)).toThrow();
  });
  it("maps generated Unicode byte positions to supplied original source without fetching", () => {
    const generated = evidence(
      "g",
      "site/app.js",
      '"é";x();\n//# sourceMappingURL=app.js.map',
    );
    const original = evidence("o", "site/src/app.js", 'const x = "é";\nx();');
    const map = evidence(
      "m",
      "site/app.js.map",
      JSON.stringify({
        version: 3,
        sourceRoot: "src",
        sources: ["app.js"],
        mappings: "AAAA,IAAA;AACA",
      }),
    );
    const result = sourceMappings([generated, original, map], generated);
    expect(result.diagnostics).toEqual([]);
    expect(result.mappings[1].generated.start).toBe(5);
    expect(result.mappings[2].original.start).toBe(16);
  });
  it("reports missing and malformed source maps", () => {
    const generated = evidence(
      "g",
      "app.js",
      "x();\n//# sourceMappingURL=app.js.map",
    );
    expect(sourceMappings([generated], generated).diagnostics[0]).toContain(
      "not supplied",
    );
    expect(
      sourceMappings([generated, evidence("m", "app.js.map", "{}")], generated)
        .diagnostics[0],
    ).toContain("Unsupported");
  });
  it("folds only literal strings without executing code", () => {
    expect(foldStrings('const x = "a" + ("b" + "c"); run(x);')).toBe(
      'const x = "abc"; run(x);',
    );
    expect(foldStrings('const x = dangerous() + "a";')).toContain(
      "dangerous()",
    );
    expect(decodeValue("nested", "%59%57%4A%6A")).toBe("abc");
    expect(foldStrings('const a="a"; const b=a+"b"; const c=b+"c";')).toBe(
      'const a="a"; const b="ab"; const c="abc";',
    );
    expect(foldStrings('let a="a"; const b=a+"b";')).toContain('a+"b"');
    expect(
      foldStrings('const a="a"; function nested(){return a+"b"}'),
    ).toContain('a+"b"');
    expect(
      foldStrings('const a="outer"; {const a="inner"; const b=a+"!";}'),
    ).toContain('const b="inner!"');
  });
  it("migrates legacy archives and round-trips ordered runtime evidence", async () => {
    const p = newProject();
    p.files = [evidence("a", "app.js", "x();")];
    p.notes = [{ id: "note-1", kind: "comment", text: "Keep this note", location: { fileId: "a", start: 0, end: 1 } }];
    p.breakpoints = [{ id: "bp-1", url: "app.js", line: 1, condition: "" }];
    const legacy = JSON.parse(await exportProject(p));
    legacy.schema = 1;
    delete legacy.sessions;
    delete legacy.breakpoints;
    legacy.sessions = [{ bad: "must not bypass schema-2 validation" }];
    expect((await importProject(JSON.stringify(legacy))).schema).toBe(5);
    expect((await importProject(JSON.stringify(legacy))).sessions).toEqual([]);
    const schema2 = JSON.parse(await exportProject(p));
    schema2.schema = 2;
    schema2.sessions = [{
      id: "old-session",
      target: "old capture",
      createdAt: "2026-10-10",
      status: "stopped",
      approvals: [],
      capturedBytes: 10,
      truncated: false,
      observations: [{
      sequence: 1,
      time: "2026-10-10T00:00:01Z",
      kind: "network",
      data: {
        event: "Network.requestWillBeSent",
        requestId: "old-cdp-id",
        targetType: "page",
        timestamp: 1,
        request: { url: "https://example.invalid/old.js", method: "GET" },
      },
    }],
    }];
    const migratedSchema2 = await importProject(JSON.stringify(schema2));
    expect(migratedSchema2.schema).toBe(5);
    expect(migratedSchema2.notes[0].text).toBe("Keep this note");
    expect(migratedSchema2.breakpoints).toHaveLength(1);
    expect(migratedSchema2.sessions?.[0].requests?.[0].url).toContain("old.js");
    p.sessions = [
      {
        id: "s",
        target: "files",
        createdAt: "2026-10-10",
        status: "paused",
        approvals: [],
        capturedBytes: 30,
        truncated: false,
        observations: [
          {
            sequence: 1,
            time: "2026-10-10",
            kind: "paused",
            data: {
              callFrameId: "live",
              headers: { Authorization: "secret" },
              value: 42,
            },
          },
        ],
        requests: [{
          id: "request:2",
          requestId: "cdp-live-request-handle",
          sequence: 2,
          url: "https://example.invalid/app.js",
          method: "GET",
          startedAt: "2026-10-10",
        }],
      },
    ];
    const archived = await exportProject(p);
    expect(archived).not.toContain("secret");
    expect(archived).not.toContain("callFrameId");
    expect(archived).not.toContain("cdp-live-request-handle");
    expect(archived).toContain('"requestId":"archive:request:2:1"');
    const restored = await importProject(archived);
    expect(restored.sessions?.[0].status).toBe("disconnected");
    expect((restored.sessions?.[0].observations[0].data as any).value).toBe(42);
    const invalid = JSON.parse(archived);
    invalid.sessions[0].observations.push(invalid.sessions[0].observations[0]);
    await expect(importProject(JSON.stringify(invalid))).rejects.toThrow(
      "runtime observation",
    );
  });
  it("bounds runtime storage and strips transport handles and credential headers", () => {
    expect(
      portableObservation({
        args: [{ objectId: "x", description: "Object" }],
        headers: [{ name: "Set-Cookie", value: "private" }],
      }),
    ).toEqual({
      args: [{ description: "Object" }],
      headers: [{ name: "Set-Cookie", value: "[redacted]" }],
    });
    const p = newProject();
    p.sessions = Array.from({ length: 101 }, () => ({}) as any);
    expect(() => validateProjectBudgets(p)).toThrow("Runtime capture");
  });
  it("normalizes CDP network events and joins broker response evidence to its request", () => {
    let requests = updateCapturedRequests([], {
      sequence: 1,
      time: "2026-10-10T00:00:00Z",
      kind: "network",
      data: {
        event: "Network.requestWillBeSent",
        requestId: "r1",
        targetType: "page",
        timestamp: 1,
        request: { url: "https://example.invalid/app.js?token=private", method: "GET", headers: { Accept: "*/*" } },
      },
    });
    requests = updateCapturedRequests(requests, {
      sequence: 2,
      time: "2026-10-10T00:00:00.020Z",
      kind: "request",
      data: { requestId: "r1", targetType: "page", url: "https://example.invalid/app.js?token=private", method: "GET" },
    });
    requests = updateCapturedRequests(requests, {
      sequence: 3,
      time: "2026-10-10T00:00:00.050Z",
      kind: "response",
      data: { requestId: "r1", targetType: "page", status: 200, headers: [{ name: "Set-Cookie", value: "secret" }], evidenceId: "e1" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("token=%5Bredacted%5D");
    expect(requests[0].status).toBe(200);
    expect(requests[0].evidenceId).toBe("e1");
    expect(requests[0].responseHeaders?.[0].value).toBe("[redacted]");
  });
  it("imports bounded HAR entries offline and marks missing or clipped bodies", () => {
    const parsed = parseHar(JSON.stringify({ log: { entries: [
      {
        startedDateTime: "2026-10-10T00:00:00.000Z", time: 12,
        request: { method: "POST", url: "https://example.invalid/send?api_key=secret", headers: [{ name: "Cookie", value: "private" }], postData: { text: "payload" } },
        response: { status: 201, headers: [{ name: "Set-Cookie", value: "private" }], content: { size: 3, mimeType: "text/plain", text: "ok!" } },
      },
      {
        request: { method: "GET", url: "https://example.invalid/large", headers: [] },
        response: { status: 200, headers: [], content: { size: HAR_BODY_LIMIT + 4, mimeType: "application/octet-stream", text: "x".repeat(HAR_BODY_LIMIT + 4) } },
      },
      {
        request: { method: "GET", url: "https://example.invalid/empty", headers: [] },
        response: { status: 204, headers: [], content: { size: 0, mimeType: "text/plain" } },
      },
    ] } }));
    expect(parsed.requests).toHaveLength(3);
    expect(parsed.requests[0].url).toContain("api_key=%5Bredacted%5D");
    expect(parsed.requests[0].requestHeaders?.[0].value).toBe("[redacted]");
    expect(parsed.requests[0].responseHeaders?.[0].value).toBe("[redacted]");
    expect(parsed.requests[0].requestPayloadAvailable).toBe(true);
    expect(parsed.resources[0].bytes).toEqual(new TextEncoder().encode("ok!"));
    expect(parsed.resources[1].bytes).toHaveLength(HAR_BODY_LIMIT);
    expect(parsed.requests[1].truncated).toBe(true);
    expect(parsed.requests[2].truncated).toBe(false);
  });
  it("rejects malformed and oversized HAR input", () => {
    expect(() => parseHar("not json")).toThrow("not valid HAR JSON");
    expect(() => parseHar(JSON.stringify({ log: { entries: [] } }))).not.toThrow();
    expect(() => parseHar("x".repeat(25 * 1024 * 1024 + 1))).toThrow("25 MiB");
  });
});
