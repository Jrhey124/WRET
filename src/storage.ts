import {
  FILE_LIMIT,
  PROJECT_LIMIT,
  DERIVED_STORAGE_LIMIT,
  ANNOTATION_STORAGE_LIMIT,
  sha256,
  type Project,
} from "./model";

export const jsonSize = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
export function validateProjectBudgets(project: Project): void {
  if (
    project.files.reduce(
      (sum, f) => sum + (f.result ? jsonSize(f.result) : 0),
      0,
    ) > DERIVED_STORAGE_LIMIT
  )
    throw new Error(
      "Analysis results exceed the 24 MiB project result budget. Existing evidence and notes are preserved; split evidence into separate projects.",
    );
  if (jsonSize([project.notes, project.decodes]) > ANNOTATION_STORAGE_LIMIT)
    throw new Error(
      "Notes and decoding history exceed the 24 MiB project annotation budget. Export this project and begin a new investigation.",
    );
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("wret", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("projects");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(
        new Error(
          "Storage is blocked by another WRET tab. Close it and retry.",
        ),
      );
  });
}
export async function loadProject(): Promise<Project | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const req = db
        .transaction("projects")
        .objectStore("projects")
        .get("current");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
export async function saveProject(project: Project): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").put(project, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error || new Error("Storage transaction aborted"));
    });
  } finally {
    db.close();
  }
}
export function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(chunks.join(""));
}
export function fromBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error("Invalid Base64 evidence");
  return Uint8Array.from(atob(value), (x) => x.charCodeAt(0));
}
export async function exportProject(project: Project): Promise<string> {
  validateProjectBudgets(project);
  const files = await Promise.all(
    project.files.map(async (file) => ({
      ...file,
      bytes: toBase64(file.bytes),
      evidenceHash: await sha256(file.bytes),
    })),
  );
  return JSON.stringify({ ...project, files });
}
export async function importProject(content: string): Promise<Project> {
  if (content.length > 200 * 1024 * 1024)
    throw new Error("Project archive exceeds 200 MiB");
  const data = JSON.parse(content);
  const fail = (message: string): never => {
    throw new Error(`Invalid WRET archive: ${message}`);
  };
  const str = (x: unknown, max = 100000) =>
    typeof x === "string" && x.length <= max;
  const array = (x: unknown, max = 50000) =>
    Array.isArray(x) && x.length <= max;
  if (
    data?.schema !== 1 ||
    !str(data.id, 200) ||
    !str(data.name, 500) ||
    !str(data.createdAt, 100) ||
    !array(data.files, 1000) ||
    !array(data.notes) ||
    !array(data.decodes, 1000) ||
    !array(data.tools, 100)
  )
    fail("schema or required fields");
  const sizes = new Map<string, number>();
  let total = 0;
  for (const file of data.files) {
    if (
      !file ||
      !str(file.id, 200) ||
      sizes.has(file.id) ||
      !str(file.name, 1000) ||
      ![
        "javascript",
        "html",
        "css",
        "json",
        "sourcemap",
        "wasm",
        "binary",
      ].includes(file.format) ||
      !str(file.bytes, Math.ceil(FILE_LIMIT / 3) * 4)
    )
      fail("file metadata or size");
    file.bytes = fromBase64(file.bytes);
    total += file.bytes.length;
    if (file.bytes.length > FILE_LIMIT || total > PROJECT_LIMIT)
      fail("evidence exceeds 25 MiB/file or 100 MiB/project");
    sizes.set(file.id, file.bytes.length);
    const hash = await sha256(file.bytes);
    if (
      file.evidenceHash !== hash ||
      (file.hash !== undefined && file.hash !== hash) ||
      (file.result && file.result.hash !== hash)
    )
      fail(`hash mismatch for ${file.name}`);
    delete file.evidenceHash;
  }
  const location = (x: any) =>
    x &&
    sizes.has(x.fileId) &&
    Number.isSafeInteger(x.start) &&
    Number.isSafeInteger(x.end) &&
    x.start >= 0 &&
    x.end >= x.start &&
    x.end <= sizes.get(x.fileId)!;
  for (const file of data.files)
    if (file.result) {
      const r = file.result;
      for (const key of [
        "strings",
        "outline",
        "references",
        "calls",
        "findings",
        "sections",
      ]) {
        if (!array(r[key], 10000)) fail(`invalid ${key}`);
        for (const item of r[key])
          if (
            !item ||
            !str(item.id, 500) ||
            !str(item.name) ||
            !str(item.kind, 100) ||
            !location(item.location) ||
            item.location.fileId !== file.id ||
            (item.detail !== undefined && !str(item.detail)) ||
            (item.target !== undefined && !str(item.target, 500))
          )
            fail(`invalid ${key} evidence location`);
      }
      if (
        !array(r.diagnostics, 1000) ||
        r.diagnostics.some((s: unknown) => !str(s))
      )
        fail("invalid diagnostics");
      for (const key of ["ast", "formatted", "wat"])
        if (r[key] !== undefined && !str(r[key], 100 * 1024 * 1024))
          fail(`invalid ${key} view`);
      if (
        r.findings.some(
          (f: any) =>
            !["unreviewed", "investigating", "confirmed", "dismissed"].includes(
              f.status,
            ),
        )
      )
        fail("finding status");
    }
  for (const note of data.notes)
    if (
      !note ||
      !str(note.id, 200) ||
      !str(note.text) ||
      !["comment", "bookmark", "label"].includes(note.kind) ||
      !location(note.location)
    )
      fail("note");
  for (const d of data.decodes)
    if (
      !d ||
      !str(d.id, 200) ||
      !str(d.input, 1024 * 1024) ||
      !str(d.output, 4 * 1024 * 1024) ||
      !str(d.createdAt, 100) ||
      !["base64", "hex", "url"].includes(d.operation) ||
      !location(d.location)
    )
      fail("decode history");
  for (const tool of data.tools)
    if (
      !tool ||
      !str(tool.id, 100) ||
      !str(tool.version, 100) ||
      !array(tool.formats, 20) ||
      tool.formats.some((f: unknown) => !str(f, 100)) ||
      !str(tool.entry, 500) ||
      !/^\/tools\/[a-zA-Z0-9._-]+\.js$/.test(tool.entry) ||
      !/^[a-f0-9]{64}$/.test(tool.integrity)
    )
      fail("tool pin");
  validateProjectBudgets(data as Project);
  return data as Project;
}
const escapeMarkdown = (s: string) =>
  s.replace(/[\\`*_{}\[\]<>#|!]/g, "\\$&").replace(/\r?\n/g, " ");
export function report(project: Project): string {
  const fileName = (id: string) =>
    project.files.find((f) => f.id === id)?.name || id;
  const loc = (l: { fileId: string; start: number; end: number }) =>
    `${escapeMarkdown(fileName(l.fileId))} · bytes ${l.start}–${l.end} (end exclusive)`;
  return [
    `# ${escapeMarkdown(project.name)}`,
    "",
    `Project: ${project.id}`,
    `Created: ${project.createdAt}`,
    "",
    "Findings describe observable patterns, not automatic malware verdicts.",
    "",
    "## Evidence",
    ...project.files.flatMap((f) => [
      `- **${escapeMarkdown(f.name)}** · ${f.bytes.length} bytes · ${f.format}`,
      `  - SHA-256: ${f.hash || f.result?.hash || "Not analyzed; integrity hash is included in project archive"}`,
      ...(f.result?.diagnostics || []).map(
        (d) => `  - Diagnostic: ${escapeMarkdown(d)}`,
      ),
    ]),
    "",
    "## Findings",
    ...project.files.flatMap((f) =>
      (f.result?.findings || []).map(
        (x) =>
          `- [${x.status}] ${escapeMarkdown(x.kind)}: ${escapeMarkdown(x.name)} — ${loc(x.location)}`,
      ),
    ),
    "",
    "## Analyst notes",
    ...project.notes.map(
      (n) => `- **${n.kind}**: ${escapeMarkdown(n.text)} — ${loc(n.location)}`,
    ),
    "",
    "## Decoding history",
    ...project.decodes.map(
      (d) =>
        `- ${d.operation} · ${loc(d.location)} · ${d.createdAt}\n  - Input: ${escapeMarkdown(d.input)}\n  - Output: ${escapeMarkdown(d.output)}`,
    ),
    "",
    "## Pinned tools",
    ...project.tools.map(
      (t) => `- ${t.id}@${t.version} · SHA-256 ${t.integrity}`,
    ),
    "",
    "Original evidence remains in the portable WRET archive. Formatted and decoded views do not replace original bytes.",
    "",
  ].join("\n");
}
