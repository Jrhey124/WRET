import { describe, expect, it } from "vitest";
import { newProject, removeEvidence } from "../../src/model";

describe("remove evidence from a project", () => {
  it("removes file-linked annotations, decodes and breakpoints without changing other evidence or sessions", () => {
    const project = newProject();
    project.files = [
      { id: "a", name: "src/a.js", format: "javascript", bytes: new Uint8Array([1]) },
      { id: "b", name: "src/b.js", format: "javascript", bytes: new Uint8Array([2]) },
    ];
    project.notes = [
      { id: "note-a", kind: "comment", text: "remove", location: { fileId: "a", start: 0, end: 0 } },
      { id: "note-b", kind: "comment", text: "keep", location: { fileId: "b", start: 0, end: 0 } },
    ];
    project.decodes = [
      { id: "decode-a", operation: "base64", input: "YQ==", output: "a", location: { fileId: "a", start: 0, end: 0 }, createdAt: "now" },
      { id: "decode-b", operation: "base64", input: "Yg==", output: "b", location: { fileId: "b", start: 0, end: 0 }, createdAt: "now" },
    ];
    project.breakpoints = [
      { id: "bp-a", url: "http://127.0.0.1:8765/src/a.js", line: 1, condition: "" },
      { id: "bp-b", url: "http://127.0.0.1:8765/src/b.js", line: 1, condition: "" },
    ];
    project.sessions = [{ id: "session", createdAt: "now", target: "http://127.0.0.1", status: "stopped", approvals: [], observations: [{ sequence: 1, time: "now", kind: "console", data: { text: "retained" } }], capturedBytes: 1, truncated: false }];

    const result = removeEvidence(project, "a");

    expect(result.files.map((file) => file.id)).toEqual(["b"]);
    expect(result.notes.map((note) => note.id)).toEqual(["note-b"]);
    expect(result.decodes.map((decode) => decode.id)).toEqual(["decode-b"]);
    expect(result.breakpoints?.map((breakpoint) => breakpoint.id)).toEqual(["bp-b"]);
    expect(result.sessions).toEqual(project.sessions);
    expect(project.files).toHaveLength(2);
    expect(removeEvidence(project, "missing")).toBe(project);
  });
});
