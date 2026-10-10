import {
  FILE_LIMIT,
  PROJECT_LIMIT,
  DERIVED_STORAGE_LIMIT,
  ANNOTATION_STORAGE_LIMIT,
  sha256,
  type Project,
} from "./model";
import { CAPTURE_LIMIT } from "./debug-types";
import { evidencePath } from "./investigation";
import { portableObservation, updateCapturedRequests } from "./capture";

export const jsonSize = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
export function validateProjectBudgets(project: Project): void {
  if (
    (project.sessions || []).length > 100 ||
    jsonSize(project.sessions || []) > CAPTURE_LIMIT
  )
    throw new Error(
      "Runtime capture exceeds the 50 MiB project budget. Export and begin another project.",
    );
  if (
    project.files.reduce(
      (sum, f) => sum + (f.result ? jsonSize(f.result) : 0),
      0,
    ) > DERIVED_STORAGE_LIMIT
  )
    throw new Error(
      "Analysis results exceed the 24 MiB project result budget. Existing evidence and notes are preserved; split evidence into separate projects.",
    );
  if (jsonSize([project.notes, project.decodes, project.transformations || []]) > ANNOTATION_STORAGE_LIMIT)
    throw new Error(
      "Notes and decoding history exceed the 24 MiB project annotation budget. Export this project and begin a new investigation.",
    );
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("wret", 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects");
      if (!db.objectStoreNames.contains("evidence")) {
        const store = db.createObjectStore("evidence", { keyPath: ["projectId", "id"] });
        store.createIndex("byProject", "projectId");
        store.createIndex("byPath", ["projectId", "name"]);
        store.createIndex("byHash", ["projectId", "hash"]);
      }
      if (!db.objectStoreNames.contains("contentChunks")) db.createObjectStore("contentChunks", { keyPath: ["projectId", "fileId", "index"] });
      if (!db.objectStoreNames.contains("analysisResults")) db.createObjectStore("analysisResults", { keyPath: ["projectId", "fileId"] });
      if (!db.objectStoreNames.contains("projectRecords")) db.createObjectStore("projectRecords", { keyPath: "projectId" });
      if (!db.objectStoreNames.contains("transformations")) db.createObjectStore("transformations", { keyPath: ["projectId", "id"] });
      if (!db.objectStoreNames.contains("annotations")) db.createObjectStore("annotations", { keyPath: "projectId" });
      if (!db.objectStoreNames.contains("runtimeRecords")) db.createObjectStore("runtimeRecords", { keyPath: "projectId" });
    };
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
      req.onsuccess = () => {
        const record = req.result;
        if (record?.storageVersion === 2) {
          const tx = db.transaction(["evidence", "contentChunks", "analysisResults", "projectRecords", "transformations", "annotations", "runtimeRecords"], "readonly");
          const projectId = record.projectId;
          const evidenceReq = tx.objectStore("evidence").index("byProject").getAll(projectId);
          const chunksReq = tx.objectStore("contentChunks").getAll();
          const analysisReq = tx.objectStore("analysisResults").getAll();
          const recordsReq = tx.objectStore("projectRecords").get(projectId);
          const transformationsReq = tx.objectStore("transformations").getAll();
          const annotationsReq = tx.objectStore("annotations").get(projectId);
          const runtimeReq = tx.objectStore("runtimeRecords").get(projectId);
          tx.oncomplete = () => {
            const chunks = chunksReq.result.filter((x: any) => x.projectId === projectId);
            const analyses = new Map(analysisReq.result.filter((x: any) => x.projectId === projectId).map((x: any) => [x.fileId, x.result]));
            const files = evidenceReq.result.map((recordValue: any) => {
              const { projectId: _projectId, byteLength, contentHash: _contentHash, ...meta } = recordValue;
              const pieces = chunks.filter((x: any) => x.fileId === meta.id).sort((a: any, b: any) => a.index - b.index);
              const bytes = new Uint8Array(byteLength);
              let offset = 0;
              for (const piece of pieces) { bytes.set(piece.bytes, offset); offset += piece.bytes.length; }
              return { ...meta, bytes, result: analyses.get(meta.id) };
            });
            const { projectId: _storedProjectId, ...projectRecord } = recordsReq.result;
            const value = { ...projectRecord.project, files, ...(annotationsReq.result ? { notes: annotationsReq.result.notes, decodes: annotationsReq.result.decodes } : { notes: [], decodes: [] }), ...(runtimeReq.result ? { sessions: runtimeReq.result.sessions, breakpoints: runtimeReq.result.breakpoints } : { sessions: [], breakpoints: [] }), transformations: transformationsReq.result.filter((x: any) => x.projectId === projectId).map((x: any) => x.value) };
            resolve(normalizeLoadedProject(value));
          };
          tx.onerror = () => reject(tx.error);
          return;
        }
        resolve(record ? normalizeLoadedProject(record) : undefined);
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
function normalizeLoadedProject(project: any): Project {
  return {
    ...project,
    schema: 4,
    sessions: (project.sessions || []).map((s: any) => ({
      ...s,
      status: ["starting", "running", "paused"].includes(s.status) ? "disconnected" : s.status,
      requests: s.requests || (s.observations || []).reduce((requests: any[], observation: any) => updateCapturedRequests(requests, observation), []),
    })),
    breakpoints: project.breakpoints || [],
    transformations: project.transformations || [],
  };
}

const CONTENT_CHUNK_SIZE = 256 * 1024;
const CONTENT_CACHE_LIMIT = 32 * 1024 * 1024;
const contentCache = new Map<string, Uint8Array>();
let contentCacheBytes = 0;
function cacheChunk(key: string, value: Uint8Array) {
  const previous = contentCache.get(key);
  if (previous) { contentCacheBytes -= previous.byteLength; contentCache.delete(key); }
  if (value.byteLength <= CONTENT_CACHE_LIMIT) {
    contentCache.set(key, value); contentCacheBytes += value.byteLength;
    while (contentCacheBytes > CONTENT_CACHE_LIMIT) {
      const first = contentCache.keys().next().value as string | undefined;
      if (!first) break;
      contentCacheBytes -= contentCache.get(first)!.byteLength; contentCache.delete(first);
    }
  }
}
function invalidateCachedEvidence(projectId: string, fileId: string) {
  for (const [key, bytes] of contentCache) if (key.startsWith(`${projectId}:${fileId}:`)) {
    contentCache.delete(key); contentCacheBytes -= bytes.byteLength;
  }
}
async function activeProjectId(db: IDBDatabase): Promise<string | undefined> {
  return await new Promise((resolve, reject) => {
    const req = db.transaction("projects").objectStore("projects").get("current");
    req.onsuccess = () => resolve(req.result?.storageVersion === 2 ? req.result.projectId : undefined);
    req.onerror = () => reject(req.error);
  });
}
export async function evidenceMetadata(fileId: string): Promise<{ id: string; name: string; format: string; byteLength: number; hash?: string } | undefined> {
  const db = await database();
  try {
    const projectId = await activeProjectId(db);
    if (!projectId) return undefined;
    return await new Promise((resolve, reject) => {
      const req = db.transaction("evidence").objectStore("evidence").get([projectId, fileId]);
      req.onsuccess = () => {
        if (!req.result) return resolve(undefined);
        const { id, name, format, byteLength, hash } = req.result;
        resolve({ id, name, format, byteLength, hash });
      };
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
export async function readEvidenceRange(fileId: string, start: number, end: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error("Invalid evidence byte range");
  const db = await database();
  try {
    const projectId = await activeProjectId(db);
    if (!projectId) {
      const legacy = await new Promise<any>((resolve, reject) => {
        const req = db.transaction("projects").objectStore("projects").get("current"); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      const bytes = legacy?.files?.find((file: any) => file.id === fileId)?.bytes as Uint8Array | undefined;
      if (!bytes) throw new Error("Evidence is not available in browser storage");
      return bytes.slice(start, Math.min(end, bytes.length));
    }
    const metadata = await new Promise<any>((resolve, reject) => {
      const req = db.transaction("evidence").objectStore("evidence").get([projectId, fileId]); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    if (!metadata || end > metadata.byteLength) throw new Error("Evidence byte range is outside the file");
    if (start === end) return new Uint8Array();
    const first = Math.floor(start / CONTENT_CHUNK_SIZE), last = Math.floor((end - 1) / CONTENT_CHUNK_SIZE);
    const chunks = await Promise.all(Array.from({ length: last - first + 1 }, async (_, offset) => {
      const index = first + offset, key = `${projectId}:${fileId}:${index}`;
      const cached = contentCache.get(key);
      if (cached) { contentCache.delete(key); contentCache.set(key, cached); return cached; }
      const record = await new Promise<any>((resolve, reject) => {
        const req = db.transaction("contentChunks").objectStore("contentChunks").get([projectId, fileId, index]); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      if (!record?.bytes) throw new Error("Evidence content chunk is missing");
      cacheChunk(key, record.bytes); return record.bytes as Uint8Array;
    }));
    const result = new Uint8Array(end - start);
    for (let index = first; index <= last; index++) {
      const bytes = chunks[index - first], chunkStart = index * CONTENT_CHUNK_SIZE;
      const from = Math.max(start, chunkStart), to = Math.min(end, chunkStart + bytes.length);
      result.set(bytes.subarray(from - chunkStart, to - chunkStart), from - start);
    }
    return result;
  } finally { db.close(); }
}
export function evidenceStream(fileId: string, byteLength: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (offset >= byteLength) { controller.close(); return; }
      const end = Math.min(byteLength, offset + CONTENT_CHUNK_SIZE);
      try { controller.enqueue(await readEvidenceRange(fileId, offset, end)); offset = end; }
      catch (error) { controller.error(error); }
    },
  });
}
export async function saveProject(project: Project): Promise<void> {
  const hashes = new Map<string, string>();
  for (const file of project.files) hashes.set(file.id, file.hash || file.result?.hash || await sha256(file.bytes));
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["projects", "evidence", "contentChunks", "analysisResults", "projectRecords", "transformations", "annotations", "runtimeRecords"], "readwrite");
      const projectId = project.id;
      const evidenceStore = tx.objectStore("evidence");
      const chunksStore = tx.objectStore("contentChunks");
      const analysisStore = tx.objectStore("analysisResults");
      const transformStore = tx.objectStore("transformations");
      const oldEvidence = evidenceStore.index("byProject").getAll(projectId);
      oldEvidence.onsuccess = () => {
        const previous = new Map<string, any>(oldEvidence.result.map((record: any) => [record.id, record]));
        const currentIds = new Set(project.files.map((file) => file.id));
        const changed = new Set<string>();
        for (const file of project.files) {
          const { bytes, result, ...metadata } = file;
          const contentHash = hashes.get(file.id)!;
          const before = previous.get(file.id);
          const sameContent = before?.contentHash === contentHash && before?.byteLength === bytes.length;
          evidenceStore.put({ ...metadata, projectId, byteLength: bytes.length, contentHash });
          if (!sameContent) {
            changed.add(file.id);
            invalidateCachedEvidence(projectId, file.id);
            for (let offset = 0, index = 0; offset < bytes.length; offset += CONTENT_CHUNK_SIZE, index++)
              chunksStore.put({ projectId, fileId: file.id, index, bytes: bytes.slice(offset, Math.min(bytes.length, offset + CONTENT_CHUNK_SIZE)) });
          }
          if (result) analysisStore.put({ projectId, fileId: file.id, result });
          else analysisStore.delete([projectId, file.id]);
        }
        for (const [id] of previous) if (!currentIds.has(id)) { evidenceStore.delete([projectId, id]); analysisStore.delete([projectId, id]); invalidateCachedEvidence(projectId, id); }
        const chunkCursor = chunksStore.openKeyCursor();
        chunkCursor.onsuccess = () => {
          const cursor = chunkCursor.result;
          if (!cursor) return;
          const [chunkProject, fileId, index] = cursor.key as IDBValidKey[];
          if (chunkProject === projectId) {
            const file = project.files.find((candidate) => candidate.id === fileId);
            const expectedChunks = file ? Math.ceil(file.bytes.length / CONTENT_CHUNK_SIZE) : 0;
            if (!file || changed.has(String(fileId)) && Number(index) >= expectedChunks) cursor.delete();
          }
          cursor.continue();
        };
      };
      const lineage = (project as any).transformations || [];
      for (const [index, value] of lineage.entries()) transformStore.put({ projectId, id: value.id || String(index), value });
      const lineageIds = new Set(lineage.map((value: any, index: number) => value.id || String(index)));
      const transformCursor = transformStore.openCursor();
      transformCursor.onsuccess = () => {
        const cursor = transformCursor.result;
        if (!cursor) return;
        const key = cursor.key as IDBValidKey[];
        if (key[0] === projectId && !lineageIds.has(key[1])) cursor.delete();
        cursor.continue();
      };
      tx.objectStore("annotations").put({ projectId, notes: project.notes, decodes: project.decodes });
      tx.objectStore("runtimeRecords").put({ projectId, sessions: project.sessions || [], breakpoints: project.breakpoints || [] });
      const { files: _files, transformations: _transformations, notes: _notes, decodes: _decodes, sessions: _sessions, breakpoints: _breakpoints, ...projectRecords } = project as any;
      tx.objectStore("projectRecords").put({ projectId, project: projectRecords });
      tx.objectStore("projects").put({ storageVersion: 2, projectId }, "current");
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
  return JSON.stringify({
    ...project,
    schema: 4,
    files,
    transformations: project.transformations || [],
    sessions: (project.sessions || []).map((s) => ({
      ...s,
      status: ["running", "starting", "paused"].includes(s.status)
        ? "disconnected"
        : s.status,
      observations: s.observations.map((o) => ({
        ...o,
        data: portableObservation(o.data),
      })),
      requests: (() => {
        const requests = s.requests || [];
        const stableIds = new Map(
          requests.map((request, index) => [
            request.id,
            `request:${request.sequence}:${index + 1}`,
          ]),
        );
        return requests.map((request) => {
          const id = stableIds.get(request.id)!;
          const portable = portableObservation({
            ...request,
            id,
            redirectFrom: request.redirectFrom
              ? stableIds.get(request.redirectFrom)
              : undefined,
          });
          return { ...portable, requestId: `archive:${id}` };
        });
      })(),
    })),
    breakpoints: project.breakpoints || [],
  });
}
export async function importProject(content: string): Promise<Project> {
  if (content.length > 300 * 1024 * 1024)
    throw new Error("Project archive exceeds 300 MiB");
  const data = JSON.parse(content);
  const fail = (message: string): never => {
    throw new Error(`Invalid WRET archive: ${message}`);
  };
  const str = (x: unknown, max = 100000) =>
    typeof x === "string" && x.length <= max;
  const array = (x: unknown, max = 50000) =>
    Array.isArray(x) && x.length <= max;
  if (
    ![1, 2, 3, 4].includes(data?.schema) ||
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
  const hashes = new Map<string, string>();
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
    if (file.runtimeUrl !== undefined && !str(file.runtimeUrl, 2000))
      fail("runtime source URL");
    if (file.captureKind !== undefined && !["snapshot", "script", "response", "live-edit"].includes(file.captureKind)) fail("capture kind");
    file.bytes = fromBase64(file.bytes);
    evidencePath(file.name);
    total += file.bytes.length;
    if (file.bytes.length > FILE_LIMIT || total > PROJECT_LIMIT)
      fail("evidence exceeds 25 MiB/file or 100 MiB/project");
    sizes.set(file.id, file.bytes.length);
    const hash = await sha256(file.bytes);
    hashes.set(file.id, hash);
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
    if (
      file.sourceMapOf !== undefined &&
      (!str(file.sourceMapOf, 200) || !sizes.has(file.sourceMapOf))
    )
      fail("embedded source provenance");
  for (const file of data.files)
    if (file.derivation !== undefined) {
      const d = file.derivation;
      if (!d || (d.sourceId !== undefined && (!str(d.sourceId, 200) || !sizes.has(d.sourceId) || hashes.get(d.sourceId) !== d.sourceHash)) || !/^[a-f0-9]{64}$/.test(d.sourceHash) || !str(d.recipe, 100) || !str(d.createdAt, 100) || !Number.isSafeInteger(d.changes) || d.changes < 0 || d.changes > 5000)
        fail("transformation provenance");
    }
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
      !str(d.input, 2 * 1024 * 1024) ||
      !str(d.output, 5 * 1024 * 1024) ||
      !str(d.createdAt, 100) ||
      !["base64", "hex", "url", "strings", "nested", "gzip", "deflate"].includes(d.operation) ||
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
  if (data.schema === 2 || data.schema === 3 || data.schema === 4) {
    if (!array(data.sessions, 100) || !array(data.breakpoints, 1000))
      fail("runtime schema");
    const ids = new Set<string>();
    for (const session of data.sessions) {
      if (
        !session ||
        !str(session.id, 200) ||
        ids.has(session.id) ||
        !str(session.target, 2000) ||
        !str(session.createdAt, 100) ||
        ![
          "starting",
          "running",
          "paused",
          "stopped",
          "failed",
          "disconnected",
        ].includes(session.status) ||
        !array(session.approvals, 100) ||
        session.approvals.some((x: unknown) => !str(x, 2000)) ||
        !array(session.observations, 50000) ||
        !Number.isSafeInteger(session.capturedBytes) ||
        session.capturedBytes < 0 ||
        session.capturedBytes > CAPTURE_LIMIT ||
        typeof session.truncated !== "boolean"
      )
        fail("runtime session");
      ids.add(session.id);
      let previous = 0;
      for (const event of session.observations) {
        if (
          !event ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence <= previous ||
          !str(event.time, 100) ||
          !str(event.kind, 100) ||
          jsonSize(event.data) > 2 * 1024 * 1024
        )
          fail("runtime observation");
        previous = event.sequence;
      }
      if ((data.schema === 3 || data.schema === 4) && session.requests !== undefined) {
        if (!array(session.requests, 50000)) fail("captured requests");
        for (const request of session.requests) {
          if (
            !request ||
            !str(request.id, 300) ||
            !str(request.requestId, 300) ||
            !Number.isSafeInteger(request.sequence) ||
            !str(request.url, 8192) ||
            !str(request.method, 32) ||
            !str(request.startedAt, 100) ||
            (request.status !== undefined && (!Number.isSafeInteger(request.status) || request.status < 0 || request.status > 999)) ||
            (request.durationMs !== undefined && (!Number.isSafeInteger(request.durationMs) || request.durationMs < 0)) ||
            (request.evidenceId !== undefined && (!str(request.evidenceId, 200) || !sizes.has(request.evidenceId))) ||
            (request.blockedReason !== undefined && !str(request.blockedReason, 1000)) ||
            (request.truncated !== undefined && typeof request.truncated !== "boolean")
          ) fail("captured request record");
          for (const key of ["requestHeaders", "responseHeaders"])
            if (request[key] !== undefined && (!array(request[key], 200) || request[key].some((header: any) => !header || !str(header.name, 256) || !str(header.value, 8192)))) fail("captured request headers");
        }
      } else {
        session.requests = session.observations.reduce(
          (requests: any[], observation: any) => updateCapturedRequests(requests, observation),
          [],
        );
      }
      if (["starting", "running", "paused"].includes(session.status))
        session.status = "disconnected";
    }
    for (const bp of data.breakpoints)
      if (
        !bp ||
        !str(bp.id, 200) ||
        !str(bp.url, 2000) ||
        !Number.isSafeInteger(bp.line) ||
        bp.line < 1 ||
        !str(bp.condition, 4096)
      )
        fail("breakpoint");
  } else {
    data.sessions = [];
    data.breakpoints = [];
  }
  if (data.schema === 4) {
    if (!array(data.transformations, 5000)) fail("transformation lineage");
    const seen = new Set<string>();
    const lineageByOutput = new Map<string, any>();
    for (const node of data.transformations) {
      if (!node || !str(node.id, 200) || seen.has(node.id) || !str(node.parentHash, 64) || !/^[a-f0-9]{64}$/.test(node.parentHash) || !node.inputRange || !Number.isSafeInteger(node.inputRange.start) || !Number.isSafeInteger(node.inputRange.end) || node.inputRange.start < 0 || node.inputRange.end < node.inputRange.start || !str(node.operation, 100) || node.version !== 1 || !str(node.createdAt, 100) || !str(node.outputEvidenceId, 200) || !sizes.has(node.outputEvidenceId) || !/^[a-f0-9]{64}$/.test(node.outputHash) || hashes.get(node.outputEvidenceId) !== node.outputHash || !["exact", "range", "unknown"].includes(node.mapping) || typeof node.parameters !== "object" || !node.parameters || Object.keys(node.parameters).length > 50) fail("transformation lineage record");
      if (node.parentEvidenceId !== undefined && (!str(node.parentEvidenceId, 200) || (!sizes.has(node.parentEvidenceId) && node.parentUnavailable !== true) || (sizes.has(node.parentEvidenceId) && (hashes.get(node.parentEvidenceId) !== node.parentHash || node.inputRange.end > sizes.get(node.parentEvidenceId)!)))) fail("transformation parent reference");
      if (Object.values(node.parameters).some((value: any) => !["string", "number", "boolean"].includes(typeof value) || (typeof value === "string" && value.length > 4096) || (typeof value === "number" && !Number.isFinite(value)))) fail("transformation parameters");
      if (node.parentUnavailable !== undefined && typeof node.parentUnavailable !== "boolean") fail("transformation parent marker");
      seen.add(node.id); lineageByOutput.set(node.outputEvidenceId, node);
    }
    for (const node of data.transformations) {
      let current = node, depth = 0; const chain = new Set<string>();
      while (current.parentEvidenceId && lineageByOutput.has(current.parentEvidenceId)) {
        if (chain.has(current.id) || ++depth > 32) fail("transformation cycle or depth");
        chain.add(current.id); current = lineageByOutput.get(current.parentEvidenceId);
      }
    }
  } else data.transformations = [];
  data.schema = 4;
  data.sessions ||= [];
  data.breakpoints ||= [];
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
      ...(f.derivation ? [`  - Transformation: ${escapeMarkdown(f.derivation.recipe)}; ${f.derivation.changes} changes; original SHA-256 ${f.derivation.sourceHash}; ${escapeMarkdown(f.derivation.createdAt)}`] : []),
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
    "## Transformation lineage",
    ...(project.transformations || []).map((step) => {
      const outputName = fileName(step.outputEvidenceId);
      const parentName = step.parentEvidenceId ? fileName(step.parentEvidenceId) : "Parent evidence unavailable";
      return `- ${escapeMarkdown(step.operation)}: ${escapeMarkdown(parentName)} bytes ${step.inputRange.start}â€“${step.inputRange.end} â†’ ${escapeMarkdown(outputName)}; mapping ${step.mapping}; output SHA-256 ${step.outputHash}${step.parentUnavailable ? "; parent evidence deleted" : ""}`;
    }),
    "",
    "## Pinned tools",
    ...project.tools.map(
      (t) => `- ${t.id}@${t.version} · SHA-256 ${t.integrity}`,
    ),
    "",
    "## Runtime investigations",
    ...(project.sessions || []).flatMap((s) => [
      `- ${escapeMarkdown(s.target)} · ${s.status} · ${s.createdAt}${s.truncated ? " · capture truncated" : ""}`,
      ...s.observations.map(
        (o) =>
          `  - ${o.sequence} · ${o.time} · ${escapeMarkdown(o.kind)}: ${escapeMarkdown(JSON.stringify(portableObservation(o.data)))}`,
      ),
    ]),
    "",
    "Original evidence remains in the portable WRET archive. Formatted and decoded views do not replace original bytes.",
    "",
  ].join("\n");
}
