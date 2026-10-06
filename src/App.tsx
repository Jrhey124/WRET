import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { Graph } from "./Graph";
import { decodeValue } from "./decoding";
import {
  exportProject,
  importProject,
  loadProject,
  report,
  saveProject,
  validateProjectBudgets,
} from "./storage";
import { loadTool, runAnalysis } from "./runtime";
import {
  decodeText,
  detectFormat,
  FILE_LIMIT,
  PROJECT_LIMIT,
  newProject,
  sha256,
  uid,
  type Evidence,
  type Item,
  type Job,
  type Location,
  type Note,
  type Project,
} from "./model";
import SearchWorker from "./search.worker?worker";

const LazyEditor = lazy(() =>
  import("./Editor").then((m) => ({ default: m.Editor })),
);
function Editor(props: ComponentProps<typeof LazyEditor>) {
  return (
    <Suspense
      fallback={<p className="view-help">Loading local code viewer…</p>}
    >
      <LazyEditor {...props} />
    </Suspense>
  );
}

type View =
  "Original" | "Hex" | "Formatted" | "AST" | "WAT" | "Graph" | "Decode";
type Panel =
  "Findings" | "Symbols" | "Search" | "Notes" | "Strings" | "Sections";
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function validText(file: Evidence) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    return file.format !== "wasm" && file.format !== "binary";
  } catch {
    return false;
  }
}

export function App() {
  const [project, setProject] = useState<Project>(newProject);
  const current = useRef(project);
  current.current = project;
  const [ready, setReady] = useState(false),
    [selected, setSelected] = useState("");
  const [view, setView] = useState<View>("Original"),
    [panel, setPanel] = useState<Panel>("Findings");
  const [location, setLocation] = useState<Location>(),
    [watLine, setWatLine] = useState<number>();
  const [jobs, setJobs] = useState<Job[]>([]),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [storage, setStorage] = useState("Opening local project…");
  const [storageError, setStorageError] = useState(""),
    [persistent, setPersistent] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [query, setQuery] = useState(""),
    [matches, setMatches] = useState<Item[]>([]),
    [searching, setSearching] = useState(false);
  const [noteText, setNoteText] = useState(""),
    [noteKind, setNoteKind] = useState<Note["kind"]>("comment");
  const [decodeInput, setDecodeInput] = useState(""),
    [operation, setOperation] = useState<"base64" | "hex" | "url">("base64");
  const [decodeOrigin, setDecodeOrigin] = useState<Location>();
  const [hexPage, setHexPage] = useState(0),
    [jump, setJump] = useState("0");
  const [filter, setFilter] = useState(""),
    [resultCount, setResultCount] = useState(100);
  const abort = useRef<AbortController | null>(null),
    cancelled = useRef(false);
  const lock = useRef(false),
    writeQueue = useRef(Promise.resolve()),
    revision = useRef(0),
    savedRevision = useRef(0);
  const filesInput = useRef<HTMLInputElement>(null),
    archiveInput = useRef<HTMLInputElement>(null);
  const file = project.files.find((f) => f.id === selected);
  const result = file?.result;
  const totalBytes = project.files.reduce((sum, f) => sum + f.bytes.length, 0);
  const findings = project.files.reduce(
    (sum, f) => sum + (f.result?.findings.length || 0),
    0,
  );
  const originalText = useMemo(
    () => (file && validText(file) ? decodeText(file.bytes) : undefined),
    [file],
  );
  const update = (fn: (p: Project) => Project) => {
    const next = fn(current.current);
    current.current = next;
    setProject(next);
  };
  function annotate(fn: (p: Project) => Project) {
    try {
      const next = fn(current.current);
      validateProjectBudgets(next);
      update(() => next);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  useEffect(() => {
    let alive = true;
    loadProject()
      .then((p) => {
        if (!alive) return;
        if (p) {
          current.current = p;
          setProject(p);
          setSelected(p.files[0]?.id || "");
          if (p.files[0] && !validText(p.files[0])) setView("Hex");
        }
      })
      .catch((e) => {
        if (alive) {
          setRestoreFailed(true);
          setStorageError(
            `Could not restore browser storage: ${String(e)}. Autosave is paused to protect the previous project. Export any new work, then reload to retry.`,
          );
        }
      })
      .finally(() => {
        if (alive) setReady(true);
      });
    navigator.storage
      ?.persisted?.()
      .then(setPersistent)
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!ready || restoreFailed) return;
    const rev = ++revision.current;
    setStorage("Unsaved changes");
    const timer = setTimeout(() => {
      setStorage("Saving locally…");
      writeQueue.current = writeQueue.current
        .then(() => saveProject(project))
        .then(() => {
          savedRevision.current = rev;
          if (revision.current === rev) {
            setStorage("Saved in this browser");
            setStorageError("");
          }
        })
        .catch((e) => {
          setStorage("Not saved");
          setStorageError(
            `Browser storage failed: ${String(e)}. Your current work is still in memory. Export your project now, then free browser storage and retry.`,
          );
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [project, ready, restoreFailed]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (revision.current !== savedRevision.current || lock.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    setResultCount(100);
    setFilter("");
  }, [panel, selected]);
  useEffect(() => {
    if (!query) {
      setMatches([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let worker: Worker | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      worker = new SearchWorker();
      deadline = setTimeout(() => {
        worker?.terminate();
        setSearching(false);
        setError(
          "Search exceeded 60 seconds and was stopped. Refine the query.",
        );
      }, 60000);
      worker.onmessage = (e) => {
        clearTimeout(deadline);
        setMatches(e.data);
        setSearching(false);
        worker?.terminate();
      };
      worker.onerror = () => {
        clearTimeout(deadline);
        setError(
          "Search worker failed. Shorten the query or reduce the project size.",
        );
        setSearching(false);
        worker?.terminate();
      };
      worker.postMessage({
        query,
        files: project.files.map(({ id, name, bytes }) => ({
          id,
          name,
          bytes,
        })),
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      clearTimeout(deadline);
      worker?.terminate();
    };
  }, [query, project.files]);

  function navigate(loc: Location, item?: Item) {
    const target = current.current.files.find((f) => f.id === loc.fileId);
    if (!target) return;
    setSelected(target.id);
    setLocation({ ...loc });
    setHexPage(Math.floor(loc.start / 512));
    setJump(String(loc.start));
    if (item?.target?.startsWith("wat:")) {
      setView("WAT");
      setWatLine(Number(item.target.slice(4)));
    } else setView(validText(target) ? "Original" : "Hex");
  }
  function selectFile(f: Evidence) {
    setSelected(f.id);
    setLocation({ fileId: f.id, start: 0, end: 0 });
    setView(validText(f) ? "Original" : "Hex");
    setHexPage(0);
    setWatLine(undefined);
  }
  function patchJob(id: string, patch: Partial<Job>) {
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }
  async function analyze(files: Evidence[]) {
    const batch = files.map((f) => ({
      id: uid(),
      fileId: f.id,
      name: f.name,
      status: "queued" as const,
      progress: "Waiting",
    }));
    setJobs((previous) => [...batch, ...previous].slice(0, 1000));
    for (let i = 0; i < files.length; i++) {
      const job = batch[i];
      if (cancelled.current) {
        patchJob(job.id, {
          status: "cancelled",
          progress: "Cancelled before start",
        });
        continue;
      }
      const controller = new AbortController();
      abort.current = controller;
      patchJob(job.id, {
        status: "running",
        progress: "Checking first-party tool integrity",
      });
      try {
        let tool = current.current.tools.find((t) => t.id === "wret-static");
        if (!tool) {
          tool = await loadTool(controller.signal);
          const pinned = tool;
          update((p) => ({ ...p, tools: [...p.tools, pinned] }));
        }
        const output = await runAnalysis(
          files[i],
          tool,
          (progress) => patchJob(job.id, { progress }),
          controller.signal,
        );
        const analyzed = {
          ...current.current,
          files: current.current.files.map((f) =>
            f.id === files[i].id ? { ...f, result: output } : f,
          ),
        };
        validateProjectBudgets(analyzed);
        update(() => analyzed);
        patchJob(job.id, {
          status: "done",
          progress: output.diagnostics.length
            ? `Complete · ${output.diagnostics.length} diagnostics`
            : "Complete",
        });
      } catch (e) {
        const wasCancelled = controller.signal.aborted;
        patchJob(job.id, {
          status: wasCancelled ? "cancelled" : "failed",
          progress: String(e),
        });
        if (!wasCancelled) setError(String(e));
      } finally {
        abort.current = null;
      }
    }
  }
  async function importFiles(list: FileList | File[]) {
    if (lock.current || !ready) return;
    lock.current = true;
    cancelled.current = false;
    setBusy(true);
    setError("");
    try {
      const incoming = Array.from(list);
      if (!incoming.length) return;
      if (incoming.some((f) => f.size > FILE_LIMIT))
        throw new Error(
          "Import rejected: each file must be 25 MiB or smaller.",
        );
      if (current.current.files.length + incoming.length > 1000)
        throw new Error("Import rejected: at most 1,000 files per project.");
      if (
        current.current.files.reduce((n, f) => n + f.bytes.length, 0) +
          incoming.reduce((n, f) => n + f.size, 0) >
        PROJECT_LIMIT
      )
        throw new Error(
          "Import rejected: project evidence must be 100 MiB or smaller.",
        );
      const added: Evidence[] = [];
      for (const f of incoming) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        added.push({
          id: uid(),
          name: f.name,
          bytes,
          hash: await sha256(bytes),
          format: detectFormat(f.name, bytes),
        });
      }
      update((p) => ({ ...p, files: [...p.files, ...added] }));
      selectFile(added[0]);
      if (navigator.storage?.persist)
        navigator.storage
          .persist()
          .then(setPersistent)
          .catch(() => {});
      await analyze(added);
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
      if (filesInput.current) filesInput.current.value = "";
    }
  }
  async function reanalyze() {
    if (!file || lock.current) return;
    if (
      file.result &&
      !window.confirm(
        "Reanalysis replaces this file’s generated results and finding statuses. Original evidence and analyst notes remain. Continue?",
      )
    )
      return;
    lock.current = true;
    cancelled.current = false;
    setBusy(true);
    try {
      await analyze([file]);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function openArchive(upload?: File) {
    if (!upload || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (upload.size > 200 * 1024 * 1024)
        throw new Error("Project archive exceeds 200 MiB.");
      const restored = await importProject(await upload.text());
      if (
        current.current.files.length &&
        !window.confirm(
          "Replace the open project? Export it first if you need to keep it.",
        )
      )
        return;
      current.current = restored;
      setProject(restored);
      setRestoreFailed(false);
      setDecodeInput("");
      setDecodeOrigin(undefined);
      setJobs([]);
      setQuery("");
      if (restored.files[0]) selectFile(restored.files[0]);
      else setSelected("");
    } catch (e) {
      setError(`Could not open project: ${String(e)}`);
    } finally {
      lock.current = false;
      setBusy(false);
      if (archiveInput.current) archiveInput.current.value = "";
    }
  }
  async function exportArchive() {
    try {
      download(
        `${project.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.wret.json`,
        await exportProject(current.current),
        "application/json",
      );
    } catch (e) {
      setError(`Export failed: ${String(e)}`);
    }
  }
  function startNew() {
    if (
      lock.current ||
      !window.confirm(
        "Start a new investigation? Export the current project first if you need to keep it.",
      )
    )
      return;
    const fresh = newProject();
    setRestoreFailed(false);
    setDecodeInput("");
    setDecodeOrigin(undefined);
    current.current = fresh;
    setProject(fresh);
    setSelected("");
    setLocation(undefined);
    setJobs([]);
    setQuery("");
    setError("");
  }
  function addNote() {
    if (!file || !noteText.trim()) return;
    if (project.notes.length >= 50000) {
      setError(
        "Project note limit reached (50,000). Export this project and begin a new investigation.",
      );
      return;
    }
    const loc =
      location?.fileId === file.id
        ? location
        : { fileId: file.id, start: 0, end: 0 };
    const saved = annotate((p) => ({
      ...p,
      notes: [
        ...p.notes,
        { id: uid(), kind: noteKind, text: noteText.trim(), location: loc },
      ],
    }));
    if (saved) setNoteText("");
    setPanel("Notes");
  }
  function decode() {
    if (!file) return;
    if (project.decodes.length >= 1000) {
      setError(
        "Decode history limit reached (1,000). Export this project and begin a new investigation.",
      );
      return;
    }
    try {
      const output = decodeValue(operation, decodeInput);
      const loc =
        decodeOrigin ||
        (location?.fileId === file.id
          ? location
          : { fileId: file.id, start: 0, end: 0 });
      const saved = annotate((p) => ({
        ...p,
        decodes: [
          ...p.decodes,
          {
            id: uid(),
            operation,
            input: decodeInput,
            output,
            location: loc,
            createdAt: new Date().toISOString(),
          },
        ],
      }));
      if (saved) setError("");
    } catch (e) {
      setError(`Decode failed: ${String(e)}`);
    }
  }
  const listItems = (items: Item[], allowTarget = false) => {
    const filtered = items.filter((x) =>
      `${x.name} ${x.kind}`.toLowerCase().includes(filter.toLowerCase()),
    );
    return (
      <>
        <div className="result-count">
          {filtered.length.toLocaleString()} entries
        </div>
        {filtered.slice(0, resultCount).map((item) => (
          <div className="evidence-row" key={item.id}>
            <button
              className="evidence-link"
              onClick={() => navigate(item.location, item)}
              title={item.detail}
            >
              <span className="item-kind">{item.kind}</span>
              <span className="item-name">
                {project.notes.find(
                  (n) =>
                    n.kind === "label" &&
                    n.location.fileId === item.location.fileId &&
                    n.location.start === item.location.start,
                )?.text || item.name}
              </span>
              <small>
                {item.detail ||
                  `bytes ${item.location.start}–${item.location.end}`}
              </small>
            </button>
            {allowTarget && item.target && !item.target.startsWith("wat:") && (
              <button
                className="small-button"
                onClick={() => {
                  const target = result?.outline.find(
                    (o) => o.id === item.target,
                  );
                  if (target) navigate(target.location);
                }}
              >
                Go to function ↗
              </button>
            )}
          </div>
        ))}
        {filtered.length > resultCount && (
          <button
            className="more"
            onClick={() => setResultCount((n) => n + 100)}
          >
            Show 100 more
          </button>
        )}
        {!filtered.length && (
          <p className="empty-small">No entries in this view.</p>
        )}
      </>
    );
  };

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
      }}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">W</span>
          <strong>WRET</strong>
          <span className="brand-caption">ANALYSIS WORKBENCH</span>
        </div>
        <div className="privacy-badge">
          <span className="status-dot" /> LOCAL ONLY
        </div>
        <div className="header-actions">
          <button
            onClick={() => archiveInput.current?.click()}
            disabled={busy || !ready}
          >
            Open project
          </button>
          <button onClick={exportArchive} disabled={!ready}>
            Export project ↗
          </button>
          <button
            className="primary"
            onClick={() => filesInput.current?.click()}
            disabled={busy || !ready}
          >
            ＋ Import files
          </button>
        </div>
      </header>
      <input
        ref={filesInput}
        type="file"
        multiple
        className="hidden"
        aria-label="Import evidence files"
        onChange={(e) => e.target.files && void importFiles(e.target.files)}
      />
      <input
        ref={archiveInput}
        type="file"
        accept=".json,.wret"
        className="hidden"
        aria-label="Open WRET archive"
        onChange={(e) => void openArchive(e.target.files?.[0])}
      />
      <div className="projectbar">
        <div className="project-title">
          <span className="muted">WORKSPACE /</span>
          <input
            aria-label="Project name"
            value={project.name}
            maxLength={200}
            onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
          />
        </div>
        <span className="project-stat">
          {project.files.length} files <span>·</span> {size(totalBytes)}{" "}
          <span>·</span> {findings} indicators
        </span>
        <button
          className="text-button"
          onClick={startNew}
          disabled={busy || !ready}
        >
          New project
        </button>
      </div>
      {error && (
        <div role="alert" className="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {storageError && (
        <div role="alert" className="alert storage-alert">
          <span>{storageError}</span>
          <button onClick={exportArchive}>Export now</button>
          <button
            onClick={() =>
              restoreFailed
                ? window.location.reload()
                : setProject((p) => ({ ...p }))
            }
          >
            {restoreFailed ? "Reload to retry" : "Retry save"}
          </button>
        </div>
      )}
      <main className="workbench">
        <aside className="explorer">
          <div className="pane-heading">
            <span>PROJECT EXPLORER</span>
            <span className="counter">{project.files.length}</span>
          </div>
          <div className="explorer-files">
            {project.files.length ? (
              project.files.map((f) => (
                <button
                  key={f.id}
                  className={`file-row ${selected === f.id ? "selected" : ""}`}
                  onClick={() => selectFile(f)}
                >
                  <span className={`file-icon ${f.format}`}>
                    {f.format === "javascript"
                      ? "JS"
                      : f.format === "wasm"
                        ? "WA"
                        : "{ }"}
                  </span>
                  <span className="file-label">
                    {f.name}
                    <small>{size(f.bytes.length)}</small>
                  </span>
                  <span
                    className={`file-state ${f.result ? "analyzed" : ""}`}
                    title={f.result ? "Analyzed" : "Awaiting analysis"}
                  />
                </button>
              ))
            ) : (
              <div className="explorer-empty">
                <span>◇</span>
                <p>No evidence yet</p>
                <small>Import files to begin an investigation.</small>
              </div>
            )}
          </div>
          <div className="explorer-footer">
            <div className="eyebrow">EVIDENCE STORAGE</div>
            <div className="storage-meter">
              <span
                style={{ width: `${(totalBytes / PROJECT_LIMIT) * 100}%` }}
              />
            </div>
            <span>{size(totalBytes)} / 100 MiB</span>
            <p>
              Original files stay in this browser. Export your project to keep a
              portable copy.
            </p>
            <span className="persistent-status">
              {persistent
                ? "● Persistent storage granted"
                : "○ Browser storage may be evicted"}
            </span>
          </div>
        </aside>
        <section className="center-pane">
          <div className="file-tabbar">
            <span className="active-file">
              {file ? (
                <>
                  <span className="teal">◇</span> {file.name}
                </>
              ) : (
                "Investigation overview"
              )}
            </span>
            {file && (
              <span className="file-format">
                {file.format.toUpperCase()} · {size(file.bytes.length)}
              </span>
            )}
          </div>
          {file ? (
            <>
              <div
                className="view-tabs"
                role="tablist"
                aria-label="Evidence views"
              >
                {(
                  [
                    "Original",
                    "Hex",
                    "Formatted",
                    "AST",
                    "WAT",
                    "Graph",
                    "Decode",
                  ] as View[]
                ).map((v) => (
                  <button
                    key={v}
                    role="tab"
                    aria-selected={view === v}
                    className={view === v ? "active" : ""}
                    disabled={
                      (v === "Original" && originalText === undefined) ||
                      (v === "Formatted" && !result?.formatted) ||
                      (v === "AST" && !result?.ast) ||
                      (v === "WAT" && !result?.wat)
                    }
                    onClick={() => setView(v)}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <div className="view-content">
                {view === "Original" && originalText !== undefined && (
                  <Editor
                    file={file}
                    value={originalText}
                    original
                    location={location}
                    onSelection={setLocation}
                  />
                )}
                {view === "Formatted" && (
                  <>
                    <div className="view-help">
                      Derived formatting · original bytes are preserved. No
                      exact source map is available; annotate the Original view.
                    </div>
                    <Editor
                      file={file}
                      value={result?.formatted || ""}
                      original={false}
                      onSelection={() => {}}
                    />
                  </>
                )}
                {view === "WAT" && (
                  <>
                    <div className="view-help">
                      WABT disassembly · sample is never instantiated. Select an
                      outline entry, then Hex to inspect its original function
                      body or containing section.
                    </div>
                    <Editor
                      file={file}
                      value={result?.wat || ""}
                      original={false}
                      line={watLine}
                      onSelection={() => {}}
                    />
                  </>
                )}
                {view === "Hex" && (
                  <div className="hex-view">
                    <div className="hex-toolbar">
                      <label>
                        Byte offset{" "}
                        <input
                          aria-label="Hex byte offset"
                          value={jump}
                          onChange={(e) => setJump(e.target.value)}
                        />
                      </label>
                      <button
                        onClick={() => {
                          const n = Number(jump);
                          if (
                            Number.isSafeInteger(n) &&
                            n >= 0 &&
                            n < file.bytes.length
                          ) {
                            setHexPage(Math.floor(n / 512));
                            setLocation({
                              fileId: file.id,
                              start: n,
                              end: n + 1,
                            });
                          } else
                            setError(
                              "Enter a byte offset within this file (decimal or 0x-prefixed hex).",
                            );
                        }}
                      >
                        Go
                      </button>
                      <span className="grow" />
                      <button
                        disabled={!hexPage}
                        onClick={() => setHexPage((n) => n - 1)}
                      >
                        ←
                      </button>
                      <span>
                        {hexPage + 1} /{" "}
                        {Math.max(1, Math.ceil(file.bytes.length / 512))}
                      </span>
                      <button
                        disabled={(hexPage + 1) * 512 >= file.bytes.length}
                        onClick={() => setHexPage((n) => n + 1)}
                      >
                        →
                      </button>
                    </div>
                    <div className="hex-heading">
                      OFFSET{" "}
                      <span>
                        00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F
                      </span>{" "}
                      ASCII
                    </div>
                    {Array.from(
                      {
                        length: Math.min(
                          32,
                          Math.ceil((file.bytes.length - hexPage * 512) / 16),
                        ),
                      },
                      (_, row) => {
                        const offset = hexPage * 512 + row * 16,
                          bytes = Array.from(
                            file.bytes.subarray(offset, offset + 16),
                          );
                        return (
                          <div className="hex-row" key={offset}>
                            <span className="hex-offset">
                              {offset.toString(16).padStart(8, "0")}
                            </span>
                            <span className="hex-bytes">
                              {bytes.map((b, i) => (
                                <button
                                  key={i}
                                  title={`Byte ${offset + i}`}
                                  className={
                                    location?.fileId === file.id &&
                                    offset + i >= location.start &&
                                    offset + i < location.end
                                      ? "highlight"
                                      : ""
                                  }
                                  onClick={(e) =>
                                    setLocation({
                                      fileId: file.id,
                                      start:
                                        e.shiftKey &&
                                        location?.fileId === file.id
                                          ? Math.min(location.start, offset + i)
                                          : offset + i,
                                      end: offset + i + 1,
                                    })
                                  }
                                >
                                  {b.toString(16).padStart(2, "0")}
                                </button>
                              ))}
                            </span>
                            <span className="ascii">
                              {bytes
                                .map((b) =>
                                  b >= 32 && b <= 126
                                    ? String.fromCharCode(b)
                                    : ".",
                                )
                                .join("")}
                            </span>
                          </div>
                        );
                      },
                    )}
                  </div>
                )}
                {view === "AST" && (
                  <div className="ast-view">
                    <p className="view-help">
                      Syntax tree index · select a node to inspect its original
                      byte range.
                    </p>
                    {result?.ast?.split("\n").map((row, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          const match = row.match(/bytes (\d+)\.\.(\d+)/);
                          if (match)
                            navigate({
                              fileId: file.id,
                              start: +match[1],
                              end: +match[2],
                            });
                        }}
                      >
                        {row}
                      </button>
                    ))}
                  </div>
                )}
                {view === "Graph" && (
                  <Graph project={project} navigate={navigate} />
                )}
                {view === "Decode" && (
                  <div className="decode-view">
                    <div className="section-kicker">
                      REVERSIBLE TRANSFORMATIONS
                    </div>
                    <h2>Follow the encoded evidence.</h2>
                    <p>
                      Decode text without executing it. Each step retains its
                      input, output, and source selection.
                    </p>
                    <div className="decode-controls">
                      <select
                        aria-label="Decoding operation"
                        value={operation}
                        onChange={(e) =>
                          setOperation(e.target.value as typeof operation)
                        }
                      >
                        <option value="base64">Base64 → text</option>
                        <option value="hex">Hex → text</option>
                        <option value="url">URL → text</option>
                      </select>
                      <button
                        onClick={() => {
                          if (location?.fileId === file.id) {
                            setDecodeOrigin(location);
                            setDecodeInput(
                              decodeText(
                                file.bytes.subarray(
                                  location.start,
                                  location.end,
                                ),
                              ),
                            );
                          }
                        }}
                      >
                        Use evidence selection
                      </button>
                    </div>
                    <textarea
                      aria-label="Encoded input"
                      value={decodeInput}
                      maxLength={1024 * 1024}
                      onChange={(e) => {
                        setDecodeInput(e.target.value);
                        setDecodeOrigin(undefined);
                      }}
                      placeholder="Paste encoded text, or use a selection from the original evidence."
                    />
                    <button
                      className="primary"
                      onClick={decode}
                      disabled={!decodeInput}
                    >
                      Decode & record step
                    </button>
                    <h3>
                      Transformation history{" "}
                      <span className="counter">{project.decodes.length}</span>
                    </h3>
                    {[...project.decodes].reverse().map((d) => (
                      <article className="decode-card" key={d.id}>
                        <div>
                          <strong>{d.operation.toUpperCase()}</strong>
                          <button
                            className="text-button"
                            onClick={() => navigate(d.location)}
                          >
                            Evidence: bytes {d.location.start}–{d.location.end}{" "}
                            ↗
                          </button>
                        </div>
                        <label>
                          Input<pre>{d.input}</pre>
                        </label>
                        <label>
                          Output<pre>{d.output}</pre>
                        </label>
                        <button
                          onClick={() => {
                            setDecodeInput(d.output);
                            setDecodeOrigin(d.location);
                          }}
                        >
                          Use output as next input
                        </button>
                        <button
                          onClick={() => {
                            setDecodeInput(d.input);
                            setDecodeOrigin(d.location);
                            setOperation(d.operation);
                          }}
                        >
                          Restore input
                        </button>
                      </article>
                    ))}
                  </div>
                )}
              </div>
              <div className="evidence-status">
                <span>
                  {location?.fileId === file.id
                    ? `Selection: bytes ${location.start}–${location.end}`
                    : "Select evidence to annotate"}{" "}
                  <span className="muted">· end exclusive</span>
                </span>
                <button
                  className="text-button"
                  onClick={() => setPanel("Notes")}
                >
                  ＋ Annotate
                </button>
                <button
                  className="text-button"
                  onClick={reanalyze}
                  disabled={busy}
                >
                  Analyze again
                </button>
              </div>
            </>
          ) : (
            <div className="welcome">
              <div className="welcome-emblem">⌘</div>
              <div className="section-kicker">
                A LOCAL-FIRST INVESTIGATION SPACE
              </div>
              <h1>
                Unfamiliar code.
                <br />
                <span>Understandable evidence.</span>
              </h1>
              <p>
                Inspect suspicious web files, trace relationships, and document
                what you find. Your evidence never leaves this browser.
              </p>
              <button
                className="primary large"
                disabled={busy || !ready}
                onClick={() => filesInput.current?.click()}
              >
                ＋ Import evidence files
              </button>
              <span className="drop-hint">
                or drop files anywhere · up to 25 MiB each
              </span>
              <div className="welcome-features">
                <div>
                  <span>01</span>
                  <strong>Inspect</strong>
                  <p>Source, bytes & WAT</p>
                </div>
                <div>
                  <span>02</span>
                  <strong>Connect</strong>
                  <p>Functions & indicators</p>
                </div>
                <div>
                  <span>03</span>
                  <strong>Document</strong>
                  <p>Notes & portable projects</p>
                </div>
              </div>
              <div className="format-pills">
                <span>JavaScript</span>
                <span>WebAssembly</span>
                <span>HTML / CSS</span>
                <span>JSON / source maps</span>
              </div>
            </div>
          )}
        </section>
        <aside className="inspector">
          <div className="pane-heading">
            <span>INVESTIGATION</span>
            <span className="teal">◎</span>
          </div>
          <div className="inspector-tabs">
            {(
              [
                "Findings",
                "Symbols",
                "Search",
                "Notes",
                "Strings",
                "Sections",
              ] as Panel[]
            ).map((p) => (
              <button
                key={p}
                className={panel === p ? "active" : ""}
                onClick={() => setPanel(p)}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="inspector-content">
            {panel !== "Search" && panel !== "Notes" && (
              <input
                className="filter-input"
                aria-label={`Filter ${panel.toLowerCase()}`}
                placeholder={`Filter ${panel.toLowerCase()}…`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
            {panel === "Findings" && (
              <>
                <p className="panel-help">
                  Observable patterns, not malware verdicts. Select an indicator
                  to review its context.
                </p>
                {result?.findings
                  .filter((f) =>
                    `${f.name} ${f.kind}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                  )
                  .slice(0, resultCount)
                  .map((f) => (
                    <div className="finding-card" key={f.id}>
                      <button
                        className="evidence-link"
                        onClick={() => navigate(f.location)}
                      >
                        <span className="item-kind">{f.kind}</span>
                        <span className="item-name">{f.name}</span>
                        <small>
                          bytes {f.location.start}–{f.location.end} ↗
                        </small>
                      </button>
                      <select
                        aria-label={`Status for ${f.name}`}
                        value={f.status}
                        onChange={(e) =>
                          update((p) => ({
                            ...p,
                            files: p.files.map((ef) =>
                              ef.id === file?.id && ef.result
                                ? {
                                    ...ef,
                                    result: {
                                      ...ef.result,
                                      findings: ef.result.findings.map((x) =>
                                        x.id === f.id
                                          ? {
                                              ...x,
                                              status: e.target
                                                .value as typeof f.status,
                                            }
                                          : x,
                                      ),
                                    },
                                  }
                                : ef,
                            ),
                          }))
                        }
                      >
                        {[
                          "unreviewed",
                          "investigating",
                          "confirmed",
                          "dismissed",
                        ].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                {(result?.findings.length || 0) > resultCount && (
                  <button
                    className="more"
                    onClick={() => setResultCount((n) => n + 100)}
                  >
                    Show more
                  </button>
                )}
                {!result?.findings.length && (
                  <div className="empty-small">
                    {file
                      ? result
                        ? "No indicator patterns found."
                        : "Analysis results will appear here."
                      : "Import a file to inspect its indicators."}
                  </div>
                )}
                {!!result?.diagnostics.length && (
                  <div className="diagnostics">
                    <h3>Analysis diagnostics</h3>
                    {result.diagnostics.map((d, i) => (
                      <p key={i}>{d}</p>
                    ))}
                  </div>
                )}
              </>
            )}
            {panel === "Symbols" && (
              <>
                <h3>Function outline</h3>
                {listItems(result?.outline || [])}
                <h3>Call relationships</h3>
                {listItems(result?.calls || [], true)}
                <h3>Symbol references</h3>
                {listItems(result?.references || [], true)}
              </>
            )}
            {panel === "Strings" && (
              <>
                <p className="panel-help">
                  Printable ASCII runs of 4+ bytes. Long strings display their
                  first 2,048 characters.
                </p>
                {listItems(result?.strings || [])}
              </>
            )}
            {panel === "Sections" && (
              <>
                <p className="panel-help">
                  Original WASM section and function-body byte ranges.
                </p>
                {listItems(result?.sections || [])}
              </>
            )}
            {panel === "Search" && (
              <>
                <label className="search-label">
                  PROJECT-WIDE SEARCH
                  <input
                    aria-label="Project search"
                    maxLength={4096}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search original evidence…"
                  />
                </label>
                <p className="panel-help">
                  Literal, case-sensitive search · first 500 matches.
                </p>
                {searching ? (
                  <p className="empty-small">Searching…</p>
                ) : (
                  listItems(matches)
                )}
              </>
            )}
            {panel === "Notes" && (
              <>
                <div className="note-composer">
                  <h3>Record an observation</h3>
                  <p className="panel-help">
                    {file
                      ? `${file.name} · bytes ${location?.fileId === file.id ? location.start : 0}–${location?.fileId === file.id ? location.end : 0}`
                      : "Select evidence first."}
                  </p>
                  <select
                    aria-label="Note type"
                    value={noteKind}
                    onChange={(e) =>
                      setNoteKind(e.target.value as Note["kind"])
                    }
                  >
                    <option value="comment">Comment</option>
                    <option value="bookmark">Bookmark</option>
                    <option value="label">Function label</option>
                  </select>
                  <textarea
                    aria-label="Analyst note"
                    placeholder="What did you observe?"
                    maxLength={100000}
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                  />
                  <button
                    className="primary"
                    onClick={addNote}
                    disabled={!file || !noteText.trim()}
                  >
                    Save note
                  </button>
                </div>
                <h3>Project notes · {project.notes.length}</h3>
                {project.notes.map((n) => (
                  <article className="note-card" key={n.id}>
                    <button
                      className="evidence-link"
                      onClick={() => navigate(n.location)}
                    >
                      <span className="item-kind">{n.kind}</span>
                      <span className="note-text">{n.text}</span>
                      <small>
                        {
                          project.files.find((f) => f.id === n.location.fileId)
                            ?.name
                        }{" "}
                        · byte {n.location.start} ↗
                      </small>
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        if (window.confirm("Delete this note?"))
                          update((p) => ({
                            ...p,
                            notes: p.notes.filter((x) => x.id !== n.id),
                          }));
                      }}
                    >
                      Delete
                    </button>
                  </article>
                ))}
                <button
                  className="report-button"
                  onClick={() =>
                    download("wret-report.md", report(project), "text/markdown")
                  }
                >
                  ↓ Export Markdown report
                </button>
              </>
            )}
          </div>
          {file && (
            <div className="hash-panel">
              <span className="eyebrow">SHA-256 / ORIGINAL EVIDENCE</span>
              <code>{file.hash || result?.hash || "Pending analysis"}</code>
            </div>
          )}
        </aside>
      </main>
      <section className="jobs-pane">
        <div className="jobs-heading">
          <span>
            ANALYSIS JOBS <span className="counter">{jobs.length}</span>
          </span>
          <span className="jobs-hint">
            Static analysis · workers terminate after 60 seconds
          </span>
          {busy && (
            <button
              className="cancel-button"
              onClick={() => {
                cancelled.current = true;
                abort.current?.abort();
              }}
            >
              Cancel analysis
            </button>
          )}
        </div>
        <div className="jobs-list">
          {jobs.length ? (
            jobs.map((job) => (
              <div className="job-row" key={job.id}>
                <span className={`job-status ${job.status}`}>
                  {job.status === "done"
                    ? "✓"
                    : job.status === "running"
                      ? "◌"
                      : job.status === "failed"
                        ? "!"
                        : "—"}{" "}
                  {job.status}
                </span>
                <button
                  onClick={() => {
                    const f = project.files.find((f) => f.id === job.fileId);
                    if (f) selectFile(f);
                  }}
                >
                  {job.name}
                </button>
                <span>{job.progress}</span>
              </div>
            ))
          ) : (
            <p>
              Ready to inspect. Imported files are analyzed in isolated worker
              jobs; sample code is never executed.
            </p>
          )}
        </div>
      </section>
      <footer className="statusbar">
        <span>
          <span className="status-dot" /> {storage}
        </span>
        <span>
          {project.tools[0]
            ? `${project.tools[0].id} v${project.tools[0].version}`
            : "Tools load on demand"}{" "}
          <span className="status-divider">/</span> No uploads · No external
          services
        </span>
        <button
          onClick={() =>
            download("wret-report.md", report(project), "text/markdown")
          }
        >
          Export report ↗
        </button>
      </footer>
    </div>
  );
}
