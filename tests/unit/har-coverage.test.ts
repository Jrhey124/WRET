import { newProject, removeEvidence } from "../../src/model";
import { exportProject, importProject, report } from "../../src/storage";
import { describe, it, expect } from "vitest";
import { parseHar, HAR_BODY_LIMIT } from "../../src/har";
import { collectionUrl } from "../../src/CollectionGuide";
const entry = (content: unknown, extra = {}) => ({ request: { url: "https://fixture.invalid/script.js", method: "GET" }, response: { status: 200, content }, ...extra });
describe("guided collection and HAR coverage", () => {
  it("restricts URL opening to credential-free HTTP URLs", () => {
    expect(collectionUrl("https://example.com")).toBe("https://example.com/");
    for (const url of ["javascript:alert(1)", "file:///tmp/x", "https://user:pass@example.com", "invalid"]) expect(() => collectionUrl(url)).toThrow();
  });
  it("distinguishes retained, absent, invalid and truncated bodies with recorded initiators", () => {
    const parsed = parseHar(JSON.stringify({ log: { entries: [
      entry({ text: "const x=1", mimeType: "text/javascript" }, { _initiator: { type: "script", stack: { callFrames: [{ url: "https://fixture.invalid/loader.js", lineNumber: 0, columnNumber: 4 }] } } }),
      entry({ size: 20 }), entry({ text: "!!!", encoding: "base64" }),
      entry({ text: "x".repeat(HAR_BODY_LIMIT + 10) }), {},
    ] } }));
    expect(parsed.requests.map(r => r.bodyAvailability)).toEqual(["retained", "missing", "invalid", "truncated"]);
    expect(parsed.coverage).toMatchObject({ importedRequests: 4, retainedBodies: 2, absentBodies: 1, invalidBodies: 1, truncatedBodies: 1, invalidEntries: 1 });
    expect(parsed.requests[0].initiator).toMatchObject({ url: "https://fixture.invalid/loader.js", line: 1, column: 5 });
    expect(parsed.resources[1].bytes.length).toBe(HAR_BODY_LIMIT);
  });
  it("bounds valid binary bodies without rejecting large base64", () => {
    const text = Buffer.alloc(HAR_BODY_LIMIT + 100, 42).toString("base64");
    const parsed = parseHar(JSON.stringify({ log: { entries: [entry({ text, encoding: "base64" })] } }));
    expect(parsed.requests[0].bodyAvailability).toBe("truncated");
    expect(parsed.resources[0].bytes.length).toBe(HAR_BODY_LIMIT);
  });
});

it("round trips coverage and manual associations, validates additions, and cleans deleted links", async () => {
  const project = newProject();
  project.files = [{ id: "source", name: "source.js", format: "javascript", bytes: new TextEncoder().encode("const x=1;") }];
  const parsed = parseHar(JSON.stringify({ log: { entries: [entry({ size: 10 })] } }));
  parsed.requests[0].analystEvidenceId = "source";
  project.sessions = [{ id: "capture", target: "Fixture", status: "stopped", createdAt: new Date().toISOString(), approvals: [], observations: [], requests: parsed.requests, capturedBytes: 200, truncated: false, coverage: parsed.coverage, captureSource: { kind: "har", filename: "fixture.har" } }];
  const archive = await exportProject(project);
  const reopened = await importProject(archive);
  expect(reopened.sessions?.[0].coverage).toEqual(parsed.coverage);
  expect(reopened.sessions?.[0].requests?.[0].analystEvidenceId).toBe("source");
  expect(report(reopened)).toContain("analyst association: source.js");
  expect(removeEvidence(reopened, "source").sessions?.[0].requests?.[0].analystEvidenceId).toBeUndefined();
  const bad = JSON.parse(archive); bad.sessions[0].requests[0].bodyAvailability = "fiction";
  await expect(importProject(JSON.stringify(bad))).rejects.toThrow("captured request");
  bad.sessions[0].requests[0].bodyAvailability = "missing"; bad.sessions[0].coverage.absentBodies = -1;
  await expect(importProject(JSON.stringify(bad))).rejects.toThrow("capture coverage");
});
