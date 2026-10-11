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
import { Tooltip } from "./Tooltip";
import { GlobalTooltips } from "./GlobalTooltips";
import { runResearchJob } from "./research-runtime";
import {
  exportProject,
  importProject,
  loadProject,
  report,
  saveProject,
  validateProjectBudgets,
} from "./storage";
import { loadTool, runAnalysis, verifyToolBundle, WORKER_TIMEOUT, PinnedToolUnavailableError } from "./runtime";
import {
  decodeText,
  detectFormat,
  FILE_LIMIT,
  PROJECT_LIMIT,
  newProject,
  removeEvidence as removeProjectEvidence,
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
import { DebugPanel } from "./DebugPanel";
import { NetworkView } from "./NetworkView";
import { ResearchView } from "./ResearchView";
import { StaticRenderView } from "./StaticRenderView";
import { buildStaticPreview } from "./static-render";
import whidraLogoUrl from "./assets/whidra-hydra-gear.png";
import packageJson from "../package.json";
import { WasmView } from "./WasmView";
import BeautifyWorker from "./analysis.worker?worker";
import { parseHar } from "./har";
import {
  dependencies,
  sourceMappings,
  evidencePath,
  embeddedSources,
} from "./investigation";

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
  "Original" | "Hex" | "Beautified" | "AST" | "WAT" | "Wasm" | "Graph" | "Decode" | "Render";
type Panel =
  "Findings" | "Symbols" | "Search" | "Notes" | "Strings" | "Sections";
const WELCOME_TAB_ID = "__wret_welcome__";
type PaletteCommand = {
  id: string;
  label: string;
  description: string;
  keywords: string;
  shortcut?: string;
  disabledReason?: string;
  run: () => void;
};
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
    const decoder = new TextDecoder("utf-8", { fatal: true });
    if (file.bytes.length > 2 * 1024 * 1024) {
      for (let offset = 0; offset < file.bytes.length; offset += 256 * 1024)
        decoder.decode(file.bytes.subarray(offset, Math.min(file.bytes.length, offset + 256 * 1024)), { stream: true });
      decoder.decode();
    } else decoder.decode(file.bytes);
    return file.format !== "wasm" && file.format !== "binary";
  } catch {
    return false;
  }
}

export function App() {
  const [mode, setMode] = useState<"Overview" | "Inspect" | "Network" | "Research" | "Debug" | "Report">(
    "Overview",
  );
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [activeCommand, setActiveCommand] = useState(0);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null),
    archiveInput = useRef<HTMLInputElement>(null),
    commandInput = useRef<HTMLInputElement>(null),
    harInput = useRef<HTMLInputElement>(null);
  const paletteReturnFocus = useRef<HTMLElement | null>(null);
  const [project, setProject] = useState<Project>(newProject);
  const current = useRef(project);
  current.current = project;
  const [ready, setReady] = useState(false),
    [selected, setSelected] = useState(WELCOME_TAB_ID);
  const [openTabs, setOpenTabs] = useState<string[]>([WELCOME_TAB_ID]);
  const [fileMenu, setFileMenu] = useState<{ id: string; x: number; y: number }>();
  const [view, setView] = useState<View>("Original"),
    [panel, setPanel] = useState<Panel>("Findings");
  const inspectorTabRefs = useRef<Partial<Record<Panel, HTMLButtonElement | null>>>({});
  const [location, setLocation] = useState<Location>(),
    [watLine, setWatLine] = useState<number>();
  const [jobs, setJobs] = useState<Job[]>([]),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toolStatus, setToolStatus] = useState<"checking" | "ready" | "update" | "unavailable">("checking");
  const [toolRecovery, setToolRecovery] = useState<{ installed: import("./model").ToolPin; fileIds: string[] }>();
  const [toolStatusMessage, setToolStatusMessage] = useState("");
  const [beautified, setBeautified] = useState<Record<string, string>>({});
  const [beautifying, setBeautifying] = useState(false);
  const beautifyWorker = useRef<Worker | undefined>(undefined);
  const beautifyTimeout = useRef<number | undefined>(undefined);
  useEffect(() => () => { beautifyWorker.current?.terminate(); if (beautifyTimeout.current) clearTimeout(beautifyTimeout.current); }, []);
  const [debugHandoff, setDebugHandoff] = useState<{ entry: string; files: string[] }>();
  const [storageError, setStorageError] = useState(""),
    [persistent, setPersistent] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    setToolStatus("checking");
    loadTool().then(async (installed) => {
      await verifyToolBundle(installed);
      if (!active) return;
      const pins = project.tools.filter((pin) => pin.id === installed.id);
      const currentPin = pins[pins.length - 1];
      setToolStatus(currentPin && (currentPin.version !== installed.version || currentPin.integrity !== installed.integrity || currentPin.entry !== installed.entry) ? "update" : "ready");
      setToolStatusMessage("");
    }).catch((cause) => {
      if (!active) return;
      setToolStatus("unavailable");
      setToolStatusMessage(String(cause));
    });
    return () => { active = false; };
  }, [ready, project.id, project.tools.map((pin) => `${pin.id}:${pin.version}:${pin.integrity}`).join("|")]);
  const [query, setQuery] = useState(""),
    [matches, setMatches] = useState<Item[]>([]),
    [searching, setSearching] = useState(false);
  const [noteText, setNoteText] = useState(""),
    [noteKind, setNoteKind] = useState<Note["kind"]>("comment");
  const [decodeInput, setDecodeInput] = useState(""),
    [operation, setOperation] = useState<
      "base64" | "hex" | "url" | "strings" | "nested" | "gzip" | "deflate"
    >("base64");
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
    savedRevision = useRef(0),
    checkpointPending = useRef(false),
    pendingWrites = useRef(0);
  const file = project.files.find((f) => f.id === selected);
  const result = file?.result;
  let displayedWat = result?.wat;
  if (displayedWat && result?.wasmFunctions) {
    for (const fn of result.wasmFunctions) {
      const alias = (project.wasmAliases || []).find((x) => x.moduleHash === result.hash && x.functionIndex === fn.index)?.name;
      if (alias && /^[A-Za-z_$][\w$.-]{0,127}$/.test(alias) && fn.name.startsWith("$")) {
        const escaped = fn.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        displayedWat = displayedWat.replace(new RegExp(`${escaped}(?=[\\s)]|$)`, "g"), `$${alias}`);
      }
    }
  }
  const resources = useMemo(() => dependencies(project.files), [project.files]);
  const mapping = useMemo(
    () =>
      file
        ? sourceMappings(project.files, file)
        : { mappings: [], diagnostics: [] },
    [project.files, file],
  );
  const totalBytes = project.files.reduce((sum, f) => sum + f.bytes.length, 0);
  const findings = project.files.reduce(
    (sum, f) => sum + (f.result?.findings.length || 0),
    0,
  );
  const originalText = useMemo(
    () => (file && validText(file) ? file.bytes.length > 2 * 1024 * 1024 ? "" : decodeText(file.bytes) : undefined),
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

  function openPalette() {
    if (palette) return;
    paletteReturnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setPaletteQuery("");
    setActiveCommand(0);
    setPalette(true);
  }
  function closePalette() {
    setPalette(false);
    setPaletteQuery("");
  }
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        const target = event.target;
        if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true'], .monaco-editor")) return;
        event.preventDefault();
        if (palette) closePalette();
        else openPalette();
      }
      if (event.key === "Escape") {
        if (palette) closePalette();
        setFileMenu(undefined);
      }
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [palette]);
  useEffect(() => {
    if (palette) commandInput.current?.focus();
    else paletteReturnFocus.current?.focus();
  }, [palette]);
  useEffect(() => {
    let alive = true;
    loadProject()
      .then((p) => {
        if (!alive) return;
        if (p) {
          current.current = p;
          setProject(p);
          if (p.files.length) setMode("Inspect");
          if (p.files[0]) {
            setSelected(p.files[0].id);
            setOpenTabs((tabs) => [
              ...(tabs.includes(WELCOME_TAB_ID) ? [WELCOME_TAB_ID] : []),
              p.files[0].id,
            ]);
          }
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
    const timer = setTimeout(() => {
      const snapshot = project;
      pendingWrites.current++;
      writeQueue.current = writeQueue.current
        .then(() => saveProject(snapshot))
        .then(() => {
          savedRevision.current = rev;
          if (revision.current === rev) {
            setStorageError("");
          }
        })
        .catch((e) => {
          if (revision.current === rev) setStorageError(
            `Browser storage failed: ${String(e)}. Your current work is still in memory. Export your project now, then free browser storage and retry.`,
          );
        })
        .finally(() => { pendingWrites.current = Math.max(0, pendingWrites.current - 1); });
    }, 350);
    return () => clearTimeout(timer);
  }, [project, ready, restoreFailed]);
  useEffect(() => {
    const checkpoint = setInterval(() => {
      if (!ready || restoreFailed || checkpointPending.current || pendingWrites.current > 0 || revision.current === savedRevision.current)
        return;
      const revisionAtSave = revision.current;
      const snapshot = current.current;
      checkpointPending.current = true;
      pendingWrites.current++;
      writeQueue.current = writeQueue.current
        .then(() => saveProject(snapshot))
        .then(() => {
          savedRevision.current = revisionAtSave;
          if (revision.current === revisionAtSave) setStorageError("");
        })
        .catch((e) => {
          if (revision.current === revisionAtSave) setStorageError(
            `Checkpoint failed: ${String(e)}. Export your project to preserve captured evidence.`,
          );
        })
        .finally(() => {
          checkpointPending.current = false;
          pendingWrites.current = Math.max(0, pendingWrites.current - 1);
        });
    }, 3000);
    return () => clearInterval(checkpoint);
  }, [ready, restoreFailed]);
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
    const timer = setTimeout(() => {
      worker = new SearchWorker();
      let resolveAck: (() => void) | undefined;
      let rejectAck: ((error: Error) => void) | undefined;
      let resolveDone: ((items: Item[]) => void) | undefined;
      let rejectDone: ((error: Error) => void) | undefined;
      let expectedAck: number | undefined;
      let activeDeadline: ReturnType<typeof setTimeout> | undefined;
      worker.onmessage = (e) => {
        if (e.data.type === "ack") {
          if (e.data.sequence !== expectedAck) { rejectAck?.(new Error("Search worker returned an invalid chunk acknowledgment")); return; }
          resolveAck?.(); resolveAck = undefined;
        }
        else if (e.data.type === "result") { resolveDone?.(e.data.results); resolveDone = undefined; }
        else if (e.data.type === "error") { const error = new Error(e.data.error); rejectAck?.(error); rejectDone?.(error); rejectAck = undefined; rejectDone = undefined; }
      };
      worker.onerror = () => { const error = new Error("Search worker failed"); rejectAck?.(error); rejectDone?.(error); };
      const run = async () => {
        const all: Item[] = [];
        try {
          for (const file of project.files) {
            if (all.length >= 500) break;
            const jobId = uid();
            const done = new Promise<Item[]>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
            void done.catch(() => {});
            activeDeadline = setTimeout(() => { const error = new Error("Search exceeded the 10 second job limit"); rejectAck?.(error); rejectDone?.(error); }, WORKER_TIMEOUT);
            worker!.postMessage({ type: "start", jobId, query, fileId: file.id, name: file.name });
            let chunks = 0;
            for (let offset = 0; offset < file.bytes.length; offset += 256 * 1024) {
              await new Promise<void>((resolve, reject) => {
                resolveAck = resolve; expectedAck = chunks;
                // The per-file deadline also bounds a lost acknowledgment.
                rejectAck = reject;
                const bytes = file.bytes.slice(offset, Math.min(file.bytes.length, offset + 256 * 1024));
                worker!.postMessage({ type: "chunk", jobId, sequence: chunks, offset, bytes }, [bytes.buffer]);
              });
              rejectAck = undefined;
              chunks++;
            }
            worker!.postMessage({ type: "finish", jobId, chunks, byteLength: file.bytes.length });
            all.push(...await done);
            clearTimeout(activeDeadline); activeDeadline = undefined;
          }
          if (all.length >= 500) setError("Search reached the 500 result display limit.");
          setMatches(all.slice(0, 500)); setSearching(false);
          worker?.terminate();
        } catch (error) {
          clearTimeout(activeDeadline);
          setError(`${String(error)}. Refine the query; completed file results are preserved.`);
          setMatches(all); setSearching(false); worker?.terminate();
        }
      };
      void run();
    }, 250);
    return () => {
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [query, project.files]);

  function navigate(loc: Location, item?: Item) {
    setMode("Inspect");
    const target = current.current.files.find((f) => f.id === loc.fileId);
    if (!target) return;
    setSelected(target.id);
    setOpenTabs((tabs) => tabs.includes(target.id) ? tabs : [...tabs, target.id]);
    setLocation({ ...loc });
    setHexPage(Math.floor(loc.start / 512));
    setJump(String(loc.start));
    if (item?.target?.startsWith("wat:")) {
      setView("WAT");
      setWatLine(Number(item.target.slice(4)));
    } else setView(validText(target) ? "Original" : "Hex");
  }
  function selectFile(f: Evidence) {
    setMode("Inspect");
    setSelected(f.id);
    setOpenTabs((tabs) => tabs.includes(f.id) ? tabs : [...tabs, f.id]);
    setLocation({ fileId: f.id, start: 0, end: 0 });
    setView(validText(f) ? "Original" : "Hex");
    setHexPage(0);
    setWatLine(undefined);
  }
  function startBeautify() {
    if (!file || file.bytes.length > 5 * 1024 * 1024 || beautifyWorker.current) return;
    setError(""); setBeautifying(true);
    const worker = new BeautifyWorker();
    beautifyWorker.current = worker;
    let resolveChunk: (() => void) | undefined;
    let rejectChunk: ((error: Error) => void) | undefined;
    let expectedChunk = -1;
    beautifyTimeout.current = window.setTimeout(() => {
      rejectChunk?.(new Error("Beautify exceeded the 10 second job limit."));
      worker.terminate(); beautifyWorker.current = undefined; setBeautifying(false);
      beautifyTimeout.current = undefined;
      setError("Beautifying exceeded the 10 second job limit and was stopped.");
    }, WORKER_TIMEOUT);
    worker.onmessage = (event: MessageEvent) => {
      if (event.data.type === "ack") {
        if (event.data.sequence !== expectedChunk) { rejectChunk?.(new Error("Beautify worker returned an invalid chunk acknowledgment")); return; }
        resolveChunk?.(); resolveChunk = undefined; rejectChunk = undefined; return;
      }
      if (beautifyTimeout.current) clearTimeout(beautifyTimeout.current); beautifyTimeout.current = undefined; worker.terminate(); beautifyWorker.current = undefined; setBeautifying(false);
      if (event.data.type === "beautified") { setBeautified((values) => ({ ...values, [file.id]: event.data.formatted })); if (selected === file.id) setView("Beautified"); }
      else setError(String(event.data.error || "Beautify failed."));
    };
    worker.onerror = () => { rejectChunk?.(new Error("Beautify worker failed")); if (beautifyTimeout.current) clearTimeout(beautifyTimeout.current); beautifyTimeout.current = undefined; worker.terminate(); beautifyWorker.current = undefined; setBeautifying(false); setError("Beautify worker failed. The imported original is unchanged."); };
    const send = async () => {
      try {
        const { bytes: _bytes, result: _result, ...metadata } = file;
        worker.postMessage({ type: "start", action: "beautify", file: metadata, byteLength: file.bytes.length });
        let chunks = 0;
        for (let offset = 0; offset < file.bytes.length; offset += 256 * 1024) {
          await new Promise<void>((resolve, reject) => {
            resolveChunk = resolve; rejectChunk = reject; expectedChunk = chunks;
            const bytes = file.bytes.slice(offset, Math.min(file.bytes.length, offset + 256 * 1024));
            worker.postMessage({ type: "chunk", sequence: chunks, offset, bytes }, [bytes.buffer]);
          });
          chunks++;
        }
        worker.postMessage({ type: "finish", chunks, byteLength: file.bytes.length });
      } catch (error) {
        if (beautifyTimeout.current) clearTimeout(beautifyTimeout.current); beautifyTimeout.current = undefined;
        worker.terminate(); beautifyWorker.current = undefined; setBeautifying(false); setError(String(error));
      }
    };
    void send();
  }
  function cancelBeautify() {
    if (beautifyTimeout.current) clearTimeout(beautifyTimeout.current); beautifyTimeout.current = undefined; beautifyWorker.current?.terminate(); beautifyWorker.current = undefined; setBeautifying(false);
  }
  function startInteractivePreview(targetFile: Evidence) {
    const related = dependencies(project.files).filter((resource) => resource.file.id === targetFile.id && resource.target).map((resource) => resource.target!.id);
    try { related.push(...buildStaticPreview(project.files, targetFile).resourceIds); } catch { /* oversized pages can still use explicit VM execution */ }
    setDebugHandoff({ entry: targetFile.name, files: [...new Set([targetFile.id, ...related])] });
    setMode("Debug");
  }
  function selectWelcome() {
    setMode("Inspect");
    setSelected(WELCOME_TAB_ID);
    setOpenTabs((tabs) => tabs.includes(WELCOME_TAB_ID) ? tabs : [...tabs, WELCOME_TAB_ID]);
    setLocation(undefined);
    setHexPage(0);
    setWatLine(undefined);
  }
  function closeFileTab(id: string) {
    const index = openTabs.indexOf(id);
    if (index < 0) return;
    const nextTabs = openTabs.filter((tabId) => tabId !== id);
    setOpenTabs(nextTabs);
    if (selected === id) {
      const nextId = nextTabs[Math.min(index, nextTabs.length - 1)] || "";
      setSelected(nextId);
      setLocation(undefined);
      setHexPage(0);
      setWatLine(undefined);
      const nextFile = current.current.files.find((candidate) => candidate.id === nextId);
      if (nextFile) setView(validText(nextFile) ? "Original" : "Hex");
    }
  }
  const runtimeActive = (project.sessions || []).some((session) =>
    ["starting", "running", "paused"].includes(session.status),
  );
  const canDeleteEvidence = !busy && !runtimeActive;
  function deleteEvidence(evidence: Evidence) {
    if (!canDeleteEvidence) return;
    const linkedNotes = project.notes.filter((note) => note.location.fileId === evidence.id).length;
    const linkedDecodes = project.decodes.filter((decode) => decode.location.fileId === evidence.id).length;
    if (!window.confirm(`Remove “${evidence.name}” from this Whidra project? This also removes ${linkedNotes} linked note(s), ${linkedDecodes} decoding record(s), its analysis results, and its breakpoints. The original file on your device is not deleted.`)) return;
    const index = openTabs.indexOf(evidence.id);
    const nextTabs = openTabs.filter((id) => id !== evidence.id);
    const removingActive = selected === evidence.id;
    const nextId = nextTabs[Math.min(Math.max(index, 0), nextTabs.length - 1)] || "";
    update((project) => removeProjectEvidence(project, evidence.id));
    setJobs((items) => items.filter((job) => job.fileId !== evidence.id));
    setOpenTabs(nextTabs);
    if (removingActive) {
      setSelected(nextId);
      setLocation(undefined);
      setHexPage(0);
      setWatLine(undefined);
      const nextFile = current.current.files.find((candidate) => candidate.id === nextId);
      if (nextFile) setView(validText(nextFile) ? "Original" : "Hex");
    }
    setFileMenu(undefined);
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
    let installed: import("./model").ToolPin;
    try { installed = await loadTool(); }
    catch (cause) {
      setToolStatus("unavailable");
      setToolStatusMessage(String(cause));
      for (const job of batch) patchJob(job.id, { status: "failed", progress: String(cause) });
      setError(String(cause));
      return;
    }
    setToolStatus("ready");
    const pins = current.current.tools.filter((pin) => pin.id === installed.id);
    const pin = pins[pins.length - 1];
    if (pin && (pin.version !== installed.version || pin.integrity !== installed.integrity || pin.entry !== installed.entry)) {
      setToolStatus("update");
      setToolRecovery({ installed, fileIds: files.map((item) => item.id) });
      setError("");
      for (const job of batch) patchJob(job.id, { status: "failed", progress: "Analyzer update required; existing results are retained" });
      return;
    }
    setToolRecovery(undefined);
    const activePin = pin ?? installed;
    if (!pin) update((p) => ({ ...p, tools: [...p.tools, installed] }));
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
        const output = await runAnalysis(
          files[i],
          activePin,
          (progress) => patchJob(job.id, { progress }),
          controller.signal,
          WORKER_TIMEOUT,
          installed,
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
        if (e instanceof PinnedToolUnavailableError) {
          setToolStatus("update");
          setToolRecovery({ installed: e.installed, fileIds: files.slice(i).map((item) => item.id) });
          patchJob(job.id, { status: "failed", progress: e.message });
          return;
        }
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
  async function useInstalledAnalyzer() {
    const pending = toolRecovery;
    if (!pending || busy) return;
    setBusy(true);
    try {
      const installed = await loadTool();
      await verifyToolBundle(installed);
      const validIds = new Set(pending.fileIds);
      const retryFiles = current.current.files.filter((item) => validIds.has(item.id));
      if (!retryFiles.length) { setToolRecovery(undefined); return; }
      update((p) => ({ ...p, tools: [...p.tools, installed] }));
      setToolRecovery(undefined);
      setToolStatus("ready");
      setError("");
      await analyze(retryFiles);
    } catch (cause) {
      setToolStatus("unavailable");
      setToolStatusMessage(String(cause));
      setError(String(cause));
    } finally {
      setBusy(false);
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
      const existingPaths = new Set(current.current.files.map((f) => f.name));
      for (const f of incoming) {
        const name = evidencePath(f.webkitRelativePath || f.name);
        if (existingPaths.has(name))
          throw new Error(
            `Duplicate evidence path: ${name}. Rename the file or start another project.`,
          );
        existingPaths.add(name);
        const bytes = new Uint8Array(await f.arrayBuffer());
        added.push({
          id: uid(),
          name,
          bytes,
          hash: await sha256(bytes),
          format: detectFormat(f.name, bytes),
        });
      }
      const embedded = embeddedSources([...current.current.files, ...added]);
      for (const source of embedded) {
        source.hash = await sha256(source.bytes);
        added.push(source);
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
    if (
      (current.current.sessions || []).some((s) =>
        ["running", "starting", "paused"].includes(s.status),
      )
    ) {
      setError(
        "Stop the active debugging session before replacing this project.",
      );
      return;
    }
    if (!upload || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (upload.size > 300 * 1024 * 1024)
        throw new Error("Project archive exceeds 300 MiB.");
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
      const keepWelcome = openTabs.includes(WELCOME_TAB_ID);
      setOpenTabs(keepWelcome ? [WELCOME_TAB_ID] : []);
      if (restored.files[0]) selectFile(restored.files[0]);
      else {
        setSelected(keepWelcome ? WELCOME_TAB_ID : "");
      }
    } catch (e) {
      setError(`Could not open project: ${String(e)}`);
    } finally {
      lock.current = false;
      setBusy(false);
      if (archiveInput.current) archiveInput.current.value = "";
    }
  }
  async function importHarFile(upload?: File) {
    if (!upload || busy || lock.current) return;
    setBusy(true);
    setError("");
    try {
      const parsed = parseHar(await upload.text());
      if ((current.current.sessions || []).length >= 100)
        throw new Error("This project already has 100 runtime or imported capture sessions.");
      const evidenceByPlaceholder = new Map<string, string>();
      const capturedFiles: Evidence[] = [];
      let available = PROJECT_LIMIT - current.current.files.reduce((sum, file) => sum + file.bytes.length, 0);
      for (const resource of parsed.resources) {
        const hash = await sha256(resource.bytes);
        const existing = current.current.files.find((file) => file.hash === hash) || capturedFiles.find((file) => file.hash === hash);
        if (existing) {
          evidenceByPlaceholder.set(`har-resource:${resource.index}`, existing.id);
          continue;
        }
        if (resource.bytes.length > FILE_LIMIT || resource.bytes.length > available || current.current.files.length + capturedFiles.length >= 1000)
          continue;
        let suffix = "bin";
        try { suffix = new URL(resource.url).pathname.split("/").pop()?.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase() || "bin"; } catch { /* use a safe generic extension */ }
        const name = `captures/har/${uid()}/${resource.index}.${suffix}`;
        const file: Evidence = { id: uid(), name, format: detectFormat(name, resource.bytes), bytes: resource.bytes, hash, runtimeUrl: resource.url };
        capturedFiles.push(file);
        available -= file.bytes.length;
        evidenceByPlaceholder.set(`har-resource:${resource.index}`, file.id);
      }
      const requests = parsed.requests.map((request) => {
        const fileId = request.evidenceId ? evidenceByPlaceholder.get(request.evidenceId) : undefined;
        return { ...request, evidenceId: fileId, truncated: request.truncated || Boolean(request.evidenceId && !fileId) };
      });
      const id = uid();
      const sessionBytes = new TextEncoder().encode(JSON.stringify(requests)).length + capturedFiles.reduce((sum, file) => sum + file.bytes.length, 0);
      if (sessionBytes > 50 * 1024 * 1024) throw new Error("HAR records exceed the 50 MiB session capture limit.");
      const next: Project = {
        ...current.current,
        schema: 5,
        files: [...current.current.files, ...capturedFiles],
        sessions: [...(current.current.sessions || []), {
          id,
          createdAt: new Date().toISOString(),
          target: `HAR capture: ${upload.name.slice(0, 500)}`,
          status: "stopped",
          approvals: [],
          observations: [],
          requests,
          capturedBytes: sessionBytes,
          truncated: parsed.truncated || requests.some((request) => request.truncated),
        }],
      };
      validateProjectBudgets(next);
      update(() => next);
      setMode("Network");
    } catch (e) {
      setError(`Could not import HAR: ${String(e)}`);
    } finally {
      setBusy(false);
      if (harInput.current) harInput.current.value = "";
    }
  }
  async function exportArchive() {
    try {
      download(
        `${project.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.whidra.json`,
        await exportProject(current.current),
        "application/json",
      );
    } catch (e) {
      setError(`Export failed: ${String(e)}`);
    }
  }
  function startNew() {
    if (
      (current.current.sessions || []).some((s) =>
        ["running", "starting", "paused"].includes(s.status),
      )
    ) {
      setError(
        "Stop the active debugging session before starting another project.",
      );
      return;
    }
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
    setSelected(WELCOME_TAB_ID);
    setOpenTabs([WELCOME_TAB_ID]);
    setFileMenu(undefined);
    setLocation(undefined);
    setJobs([]);
    setQuery("");
    setError("");
    setMode("Overview");
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
  async function decode() {
    if (!file) return;
    if (project.decodes.length >= 1000) {
      setError(
        "Decode history limit reached (1,000). Export this project and begin a new investigation.",
      );
      return;
    }
    try {
      const decoded = await runResearchJob<{ output: string; bytes?: Uint8Array }>({ action: "decode", operation, input: decodeInput });
      const binaryOutput = decoded.bytes;
      const output = decoded.output;
      const loc =
        decodeOrigin ||
        (location?.fileId === file.id
          ? location
          : { fileId: file.id, start: 0, end: 0 });
      const parent = decodeOrigin ? project.files.find((candidate) => candidate.id === decodeOrigin.fileId) : undefined;
      const parentHash = parent ? parent.hash || await sha256(parent.bytes) : undefined;
      const derived = binaryOutput && parent ? { id: uid(), bytes: binaryOutput, hash: await sha256(binaryOutput), name: `derived/${uid()}/${parent.name.split("/").pop()}.decompressed`, format: detectFormat(parent.name, binaryOutput), parent, parentHash: parentHash!, loc } : undefined;
      if (derived && (project.files.length >= 1000 || project.files.reduce((sum, evidence) => sum + evidence.bytes.length, 0) + derived.bytes.length > PROJECT_LIMIT || (project.transformations || []).length >= 5000)) throw new Error("Derived evidence exceeds the project file, byte, or lineage limit.");
      const saved = annotate((p) => ({
        ...p,
        files: derived ? [...p.files, { id: derived.id, name: derived.name, bytes: derived.bytes, hash: derived.hash, format: derived.format, derivation: { sourceId: derived.parent.id, sourceHash: derived.parentHash, recipe: operation, createdAt: new Date().toISOString(), changes: 1 } }] : p.files,
        transformations: derived ? [...(p.transformations || []), { id: uid(), parentEvidenceId: derived.parent.id, parentHash: derived.parentHash, inputRange: { start: loc.start, end: loc.end }, operation, version: 1 as const, parameters: {}, createdAt: new Date().toISOString(), outputEvidenceId: derived.id, outputHash: derived.hash, mapping: "unknown" as const }] : p.transformations,
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
        {filtered.slice(0, resultCount).map((item) => {
          const wasmFunction = item.kind === "wasm func" ? result?.wasmFunctions?.find((fn) => fn.location?.start === item.location.start) : undefined;
          const wasmAlias = wasmFunction && result?.hash ? project.wasmAliases?.find((alias) => alias.moduleHash === result.hash && alias.functionIndex === wasmFunction.index)?.name : undefined;
          return <div className="evidence-row" key={item.id}>
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
                )?.text || (wasmAlias ? `${wasmAlias} (original ${wasmFunction?.name})` : item.name)}
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
          </div>;
        })}
        {filtered.length > resultCount && (
          <button
            className="more"
            onClick={() => setResultCount((n) => n + 100)}
          >
            Show 100 more
          </button>
        )}
        {!filtered.length && (
          <p className="inspector-empty" role="status">
            {filter ? "No results match this filter." : !file ? "Select evidence in Project Explorer to see its analysis here." : result ? "No entries are available in this view." : "Analysis has not completed for this evidence yet."}
          </p>
        )}
      </>
    );
  };

  const inspectorPanels: Panel[] = ["Findings", "Symbols", "Search", "Notes", "Strings", "Sections"];
  const inspectorCount = (name: Panel) => {
    if (name === "Findings") return result?.findings.length;
    if (name === "Symbols") return result ? result.outline.length + result.calls.length + result.references.length : undefined;
    if (name === "Search") return matches.length;
    if (name === "Notes") return project.notes.length;
    if (name === "Strings") return result?.strings.length;
    return result?.sections.length;
  };
  const filteredFindings = (result?.findings || []).filter((finding) =>
    `${finding.name} ${finding.kind}`.toLowerCase().includes(filter.toLowerCase()),
  );

  const commands: PaletteCommand[] = [
    ...(["Overview", "Inspect", "Network", "Research", "Debug", "Report"] as const).map((section) => ({
      id: `go-${section.toLowerCase()}`,
      label: `Go to ${section}`,
      description: {
        Overview: "Review this investigation and suggested next steps.",
        Inspect: "Browse evidence, static analysis, notes, and decoding tools.",
        Network: "Search captured website requests, timing, headers, and response evidence.",
        Research: "Preview AST transforms, follow workspace references, and inspect observed API shapes.",
        Debug: "Run evidence in the companion VM and inspect its behavior.",
        Report: "Review and export retained findings and observations.",
      }[section],
      keywords: `navigate ${section.toLowerCase()} view workspace`,
      run: () => setMode(section),
    })),
    ...(file?.format === "html" ? [{ id: "render-selected", label: "Render selected HTML", description: "Open the sandboxed offline preview or choose an interactive VM preview.", keywords: "preview render html page browser", run: () => { setMode("Inspect"); setView("Render"); } }] : []),
    ...(file?.format === "wasm" ? [{ id: "inspect-wasm", label: "Open WebAssembly workbench", description: "Search indexed instructions, rename functions with aliases, inspect direct calls, and navigate to original module bytes.", keywords: "wasm webassembly disassemble instruction function rename alias references", run: () => { setMode("Inspect"); setView("Wasm"); } }] : []),
    ...(file && ["html", "javascript", "css", "json", "sourcemap"].includes(file.format) ? [{ id: "beautify-selected", label: "Beautify selected evidence", description: "Create a formatted view in a worker while preserving the imported bytes.", keywords: "format prettify beautified source", disabledReason: beautifying ? "Beautify is already in progress." : file.bytes.length > 5 * 1024 * 1024 ? "Beautify supports sources up to 5 MiB." : undefined, run: () => { setMode("Inspect"); startBeautify(); } }] : []),
    {
      id: "open-welcome",
      label: "Open or show Welcome tab",
      description: "Open the Whidra Welcome page or switch to it if it is already open.",
      keywords: "home start getting started welcome page",
      run: selectWelcome,
    },
    {
      id: "import-files", label: "Import files", description: "Add one or more files to the current investigation.",
      keywords: "evidence upload add file",
      disabledReason: busy || !ready ? "Wait for the current operation to finish." : undefined,
      run: () => filesInput.current?.click(),
    },
    {
      id: "import-folder", label: "Import site folder", description: "Import a website folder and preserve its relative paths.",
      keywords: "directory website folder dependencies",
      disabledReason: busy || !ready ? "Wait for the current operation to finish." : undefined,
      run: () => folderInput.current?.click(),
    },
    {
      id: "import-har", label: "Import HAR capture", description: "Import browser request history and bounded response bodies for offline review. Recorded URLs are not contacted.",
      keywords: "network capture archive har waterfall offline",
      disabledReason: busy || !ready ? "Wait for the current operation to finish." : undefined,
      run: () => harInput.current?.click(),
    },
    {
      id: "open-project", label: "Open project", description: "Open a previously exported Whidra project archive.",
      keywords: "archive restore load project",
      disabledReason: busy || !ready ? "Wait for the current operation to finish." : undefined,
      run: () => archiveInput.current?.click(),
    },
    {
      id: "export-project", label: "Export project", description: "Download the project with its evidence, notes, and findings.",
      keywords: "save backup archive portable project",
      disabledReason: !ready ? "The project is still loading." : undefined,
      run: () => void exportArchive(),
    },
    {
      id: "export-report", label: "Export report", description: "Download a Markdown report of this investigation.",
      keywords: "markdown findings report download",
      disabledReason: !ready ? "The project is still loading." : undefined,
      run: () => download("whidra-report.md", report(project), "text/markdown"),
    },
    {
      id: "new-project", label: "New project", description: "Start a new investigation after confirming the current project can be replaced.",
      keywords: "clear reset investigation",
      disabledReason: busy || !ready ? "Wait for the current operation to finish." : runtimeActive ? "Stop the active debugging session first." : undefined,
      run: startNew,
    },
    {
      id: "close-file", label: "Close active evidence tab", description: "Close the current editor tab and keep its evidence in the project.",
      keywords: "close tab editor file",
      disabledReason: !selected ? "No evidence tab is open." : undefined,
      run: () => closeFileTab(selected),
    },
  ];
  const closeTabCommand = commands.find((command) => command.id === "close-file");
  if (closeTabCommand && selected === WELCOME_TAB_ID) {
    closeTabCommand.label = "Close Welcome tab";
    closeTabCommand.description = "Close the Welcome tab; it can be reopened from this palette.";
    closeTabCommand.keywords += " welcome";
  }
  const filteredCommands = commands.filter((command) =>
    `${command.label} ${command.description} ${command.keywords}`
      .toLocaleLowerCase()
      .includes(paletteQuery.trim().toLocaleLowerCase()),
  );
  const firstEnabledCommand = filteredCommands.findIndex((command) => !command.disabledReason);
  const selectedIndex = filteredCommands[activeCommand]?.disabledReason
    ? firstEnabledCommand
    : filteredCommands[activeCommand] ? activeCommand : firstEnabledCommand;
  const selectedCommand = selectedIndex >= 0 ? filteredCommands[selectedIndex] : undefined;
  useEffect(() => {
    if (!palette || !selectedCommand) return;
    document.getElementById(`command-option-${selectedCommand.id}`)?.scrollIntoView({ block: "nearest" });
  }, [palette, selectedCommand?.id]);
  function moveCommandSelection(direction: -1 | 1) {
    const enabled = filteredCommands.flatMap((command, index) => command.disabledReason ? [] : [index]);
    if (!enabled.length) return;
    const currentIndex = enabled.indexOf(activeCommand);
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : enabled.length - 1)
      : (currentIndex + direction + enabled.length) % enabled.length;
    setActiveCommand(enabled[nextIndex]);
  }
  function runPaletteCommand(command?: PaletteCommand) {
    if (!command || command.disabledReason) return;
    command.run();
    closePalette();
  }

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
      <GlobalTooltips />
      <header className="topbar">
        <div className="brand">
          <button
            className="brand-home"
            type="button"
            aria-label="Whidra home — open Welcome"
            title="Go to Welcome"
            onClick={selectWelcome}
          >
            <img className="brand-logo" src={whidraLogoUrl} alt="" aria-hidden="true" />
            <span className="brand-name">Whidra</span>
          </button>
          <span className="brand-caption">Web-based Reverse Engineering Tool</span>
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
      <nav className="workflow-nav" aria-label="Investigation workflow">
        {(["Overview", "Inspect", "Network", "Research", "Debug", "Report"] as const).map((value) => (
          <Tooltip key={value} content={{Overview:"Project summary and suggested next steps.",Inspect:"Browse evidence, analysis results, notes, and decoding tools.",Network:"Search captured requests and open their response evidence.",Research:"Preview transformations, inspect cross-references, and review observed API shapes.",Debug:"Run selected evidence in the companion VM and inspect behavior.",Report:"Review and export investigation findings."}[value]}><button
            key={value}
            className={mode === value ? "active" : ""}
            aria-current={mode === value ? "page" : undefined}
            onClick={() => setMode(value)}
          >
            {value}
          </button></Tooltip>
        ))}
        <Tooltip content="Search and run workbench commands. Shortcut: Ctrl+K."><button onClick={openPalette}>Commands · Ctrl+K</button></Tooltip>
        <button
          disabled={busy || !ready}
          onClick={() => folderInput.current?.click()}
          title="Import a website folder with relative paths. Choose an entrypoint before running it."
        >
          Import site folder
        </button>
      </nav>
      {palette && (
        <div className="command-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closePalette(); }}>
          <section className="command-overlay" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled])"));
            if (!focusable.length) return;
            const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
            const nextIndex = event.shiftKey
              ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
              : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
            event.preventDefault();
            focusable[nextIndex].focus();
          }}>
            <div className="command-heading">
              <div><h2>Command palette</h2><p>Search and run a Whidra command</p></div>
              <button className="command-close" aria-label="Close command palette" title="Close · Escape" onClick={closePalette}>×</button>
            </div>
            <input
              ref={commandInput}
              className="command-search"
              type="text"
              role="combobox"
              aria-label="Search commands"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls="wret-command-list"
              aria-activedescendant={selectedCommand ? `command-option-${selectedCommand.id}` : undefined}
              placeholder="Type a command name…"
              value={paletteQuery}
              onChange={(event) => { setPaletteQuery(event.target.value); setActiveCommand(0); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); moveCommandSelection(1); }
                else if (event.key === "ArrowUp") { event.preventDefault(); moveCommandSelection(-1); }
                else if (event.key === "Enter") { event.preventDefault(); runPaletteCommand(selectedCommand); }
              }}
            />
            <div className="command-list" id="wret-command-list" role="listbox" aria-label="Matching commands">
              {filteredCommands.length ? filteredCommands.map((command, index) => (
                <div
                  key={command.id}
                  id={`command-option-${command.id}`}
                  role="option"
                  aria-selected={selectedIndex === index}
                  aria-disabled={Boolean(command.disabledReason)}
                  className={`command-option ${selectedIndex === index ? "active" : ""} ${command.disabledReason ? "disabled" : ""}`}
                  onMouseMove={() => { if (!command.disabledReason) setActiveCommand(index); }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runPaletteCommand(command)}
                  title={command.disabledReason || command.description}
                >
                  <span className="command-option-copy"><strong>{command.label}</strong><small>{command.disabledReason || command.description}</small></span>
                  {command.shortcut && <kbd>{command.shortcut}</kbd>}
                </div>
              )) : <p className="command-empty">No commands match “{paletteQuery}”. Try a section name or action such as “import”.</p>}
            </div>
            <div className="command-hint"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Run</span><span><kbd>Esc</kbd> Close</span></div>
          </section>
        </div>
      )}
      <input
        ref={folderInput}
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        className="hidden"
        aria-label="Import site folder"
        onChange={(e) => {
          if (e.target.files) void importFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={filesInput}
        type="file"
        multiple
        className="hidden"
        aria-label="Import evidence files"
        onChange={(e) => e.target.files && void importFiles(e.target.files)}
      />
      <input
        ref={harInput}
        type="file"
        accept=".har,application/json,application/har+json"
        className="hidden"
        aria-label="Import HAR capture"
        onChange={(event) => { if (event.target.files?.[0]) void importHarFile(event.target.files[0]); }}
      />
      <input
        ref={archiveInput}
        type="file"
        accept=".json,.wret,.wret.json,.whidra,.whidra.json"
        className="hidden"
        aria-label="Open Whidra project archive"
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
      {toolRecovery && (
        <div role="status" className="tool-update-alert">
          <div>
            <strong>Update the analyzer for this project?</strong>
            <span> Existing findings, evidence, notes, aliases, and transformations stay saved. Reanalysis replaces a result only after it succeeds.</span>
          </div>
          <button onClick={useInstalledAnalyzer} disabled={busy}>Use installed analyzer</button>
          <button aria-label="Dismiss analyzer update notice" onClick={() => setToolRecovery(undefined)}>×</button>
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
      {mode === "Overview" && (
        <section className="guided-overview">
          <div className="section-kicker">YOUR INVESTIGATION WORKSPACE</div>
          <h1>Whidra — Web-based Reverse Engineering Tool</h1>
          <p>
            Inspect web code, trace behavior, debug, and connect evidence in one browser-based workspace.
          </p>
          <div className="debug-toolbar">
            <button
              className="primary"
              disabled={busy || !ready}
              onClick={() => filesInput.current?.click()}
            >
              Import evidence files
            </button>
            <button
              disabled={busy || !ready}
              onClick={() => folderInput.current?.click()}
            >
              Import site folder
            </button>
            <button onClick={() => archiveInput.current?.click()}>
              Open saved project
            </button>
            <button onClick={() => setMode("Debug")}>
              Investigate a website URL
            </button>
          </div>
          <div className="overview-cards">
            <article>
              <h2>{project.files.length} evidence files</h2>
              <p>{size(totalBytes)} · original bytes retained</p>
            </article>
            <article>
              <h2>{findings} findings</h2>
              <p>Observable patterns with navigable evidence</p>
            </article>
            <article>
              <h2>{project.sessions?.length || 0} runtime sessions</h2>
              <p>Captured observations saved locally</p>
            </article>
          </div>
          <h2>Suggested next steps</h2>
          {project.files.slice(0, 30).map((f) => (
            <p key={f.id}>
              <button onClick={() => selectFile(f)}>Inspect {f.name}</button> ·{" "}
              {f.result
                ? `${f.result.outline.length} functions, ${f.result.findings.length} findings`
                : "Analysis pending"}
              {f.result?.diagnostics.map((d, i) => (
                <span className="diagnostic-line" key={i}>
                  {d}
                </span>
              ))}
            </p>
          ))}
          <h2>Imported website dependencies</h2>
          {resources.map((resource, index) => (
            <p key={index}>
              {resource.file.name} → {resource.reference} ·{" "}
              {resource.target ? (
                <button onClick={() => selectFile(resource.target!)}>
                  Inspect resource
                </button>
              ) : resource.external ? (
                "External resource; not fetched"
              ) : (
                "Missing imported dependency"
              )}
            </p>
          ))}
          <details>
            <summary>Workflow help</summary>
            <p>
              Inspect shows original source, hex, symbols, findings, maps, and
              reversible decoding. Debug requires the Windows local companion
              and a prepared VM. Report exports your findings and captured
              observations. Ctrl+K opens commands.
            </p>
          </details>
        </section>
      )}
      <DebugPanel
        active={mode === "Debug"}
        initialEntry={debugHandoff?.entry}
        initialSelection={debugHandoff?.files}
        project={project}
        update={update}
        onNavigate={(f, start = 0) =>
          navigate({ fileId: f.id, start, end: start })
        }
      />
      {mode === "Network" && <NetworkView
        sessions={project.sessions || []}
        files={project.files}
        onOpenEvidence={selectFile}
        onImportHar={() => harInput.current?.click()}
      />}
      {mode === "Research" && <ResearchView project={project} selection={location} update={update} navigate={navigate} />}
      {mode === "Report" && (
        <section className="guided-overview">
          <h1>Investigation report</h1>
          <div className="debug-toolbar">
            <button
              onClick={() =>
                download("whidra-report.md", report(project), "text/markdown")
              }
            >
              Export Markdown report
            </button>
            <button onClick={() => void exportArchive()}>
              Export portable project
            </button>
          </div>
          <p>
            Preview shows up to 100 notes and 20 observations per session.
            Export includes all retained records.
          </p>
          <pre>
            {report({
              ...project,
              notes: project.notes.slice(0, 100),
              sessions: project.sessions?.map((s) => ({
                ...s,
                observations: s.observations.slice(-20),
              })),
            }).slice(0, 100000)}
          </pre>
        </section>
      )}
      <main
        className="workbench"
        style={mode === "Inspect" ? undefined : { display: "none" }}
      >
        <aside className="explorer">
          <div className="pane-heading">
            <span>PROJECT EXPLORER</span>
            <span className="counter">{project.files.length}</span>
          </div>
          <div className="explorer-files">
            {project.files.length ? (
              project.files.map((f) => (
                <div
                  key={f.id}
                  className={`file-row ${selected === f.id ? "selected" : ""}`}
                  onContextMenu={(event) => { event.preventDefault(); setFileMenu({ id:f.id, x:Math.min(event.clientX, window.innerWidth - 210), y:Math.min(event.clientY, window.innerHeight - 120) }); }}
                >
                  <button className="file-open-action" onClick={() => selectFile(f)} onKeyDown={(event) => {
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setFileMenu({ id:f.id, x:Math.min(rect.left, window.innerWidth - 210), y:Math.min(rect.bottom, window.innerHeight - 120) }); }
                  }} aria-label={`Inspect ${f.name}`} title={`Open ${f.name} in the evidence editor.`}>
                    <span className={`file-icon ${f.format}`}>
                      {f.format === "javascript" ? "JS" : f.format === "wasm" ? "WA" : "{ }"}
                    </span>
                    <span className="file-label">
                      {f.name}
                      <small>{size(f.bytes.length)}</small>
                    </span>
                    <span className={`file-state ${f.result ? "analyzed" : ""}`} title={f.result ? "Analyzed" : "Awaiting analysis"} />
                  </button>
                  <span className="file-row-actions">
                    <Tooltip content={canDeleteEvidence ? `Delete ${f.name} and its linked project records. The original file on your device is untouched.` : "Wait for analysis to finish and stop active runtime sessions before deleting evidence."}><button type="button" className="file-row-delete" title={canDeleteEvidence ? `Delete ${f.name} from this project` : "Stop analysis and active runtime sessions before deleting evidence"} aria-label={`Delete ${f.name}`} disabled={!canDeleteEvidence} onClick={(event) => { event.stopPropagation(); deleteEvidence(f); }}>×</button></Tooltip>
                  </span>
                </div>
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
        {fileMenu && (() => {
          const menuFile = project.files.find((candidate) => candidate.id === fileMenu.id);
          if (!menuFile) return null;
          return <div className="file-menu-dismiss" onMouseDown={() => setFileMenu(undefined)}>
            <div className="file-context-menu" role="menu" style={{ left:fileMenu.x, top:fileMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
              <button role="menuitem" onClick={() => { selectFile(menuFile); setFileMenu(undefined); }}>Inspect <span>{menuFile.name}</span></button>
              <Tooltip content={!canDeleteEvidence ? "Wait for analysis to finish and stop active runtime sessions before deleting evidence." : "Remove this evidence and its linked records from this project. The original file on your device is untouched."}><button role="menuitem" disabled={!canDeleteEvidence} title={!canDeleteEvidence ? "Stop analysis and active runtime sessions before deleting evidence" : "Remove this evidence and its linked records from the project"} onClick={() => deleteEvidence(menuFile)}>Delete <span>{menuFile.name}</span></button></Tooltip>
            </div>
          </div>;
        })()}
        <section className="center-pane">
          <div className="file-tabbar">
            <div className="evidence-tabs" role="tablist" aria-label="Open editor tabs">
              {openTabs.map((id) => {
                if (id === WELCOME_TAB_ID) {
                  return <div className={`evidence-tab welcome-tab ${selected === id ? "active" : ""}`} key={id}>
                    <button role="tab" aria-selected={selected === id} aria-label="Welcome" title="Switch to Welcome" onClick={selectWelcome}>
                      <span className="teal">⌂</span><span className="evidence-tab-name">Welcome</span>
                    </button>
                    <button className="evidence-tab-close" aria-label="Close Welcome tab" title="Close Welcome tab; reopen it from Commands · Ctrl+K" onClick={() => closeFileTab(WELCOME_TAB_ID)}>×</button>
                  </div>;
                }
                const tabFile = project.files.find((candidate) => candidate.id === id);
                if (!tabFile) return null;
                return <div className={`evidence-tab ${selected === id ? "active" : ""}`} key={id}>
                  <button role="tab" aria-selected={selected === id} aria-label={`Inspect ${tabFile.name}`} title={`Switch to ${tabFile.name}`} onClick={() => selectFile(tabFile)}>
                    <span className="teal">◇</span><span className="evidence-tab-name">{tabFile.name}</span>
                  </button>
                  <button className="evidence-tab-close" aria-label={`Close ${tabFile.name}`} title={`Close ${tabFile.name} tab; keep it in the project`} onClick={() => closeFileTab(id)}>×</button>
                </div>;
              })}
            </div>
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
                    "Beautified",
                    "AST",
                    "WAT",
                    ...(file.format === "wasm" ? ["Wasm" as View] : []),
                    "Graph",
                    "Decode",
                    ...(file.format === "html" ? ["Render" as View] : []),
                  ] as View[]
                ).map((v) => (
                  <Tooltip key={v} content={{Original:"View the imported source. Click the editor gutter to set or clear a breakpoint.",Hex:"Inspect the original bytes and select byte ranges.",Beautified:"Read a formatted copy; its positions do not map exactly to original evidence.",AST:"Browse the parsed syntax tree and jump to source locations.",WAT:"Read the WebAssembly text representation and navigate its sections.",Wasm:"Browse indexed instructions, imports, exports, and direct call references. Rename functions with project-wide analyst aliases; the original module is unchanged.",Graph:"Explore links between files, functions, calls, and findings.",Decode:"Apply reversible decoding steps while retaining the original evidence.",Render:"Build an offline sandboxed HTML preview with scripts disabled."}[v]}><button
                    role="tab"
                    aria-selected={view === v}
                    className={view === v ? "active" : ""}
                    title={v === "Beautified" && !beautified[file.id] && !result?.formatted ? "Select Beautify to create this view." : undefined}
                    disabled={
                      (v === "Original" && originalText === undefined) ||
                      (v === "Beautified" && !beautified[file.id] && !result?.formatted) ||
                      (v === "AST" && !result?.ast) ||
                      (v === "WAT" && !result?.wat) ||
                      (v === "Wasm" && !result?.wasmFunctions)
                    }
                    onClick={() => setView(v)}
                  >
                    {v}
                  </button></Tooltip>
                ))}
              </div>
              <div className="view-actions"><Tooltip content="Format HTML, JavaScript, CSS, JSON, or a source map in a worker. Original evidence stays unchanged."><button onClick={startBeautify} disabled={beautifying || file.bytes.length > 5 * 1024 * 1024 || !["html", "javascript", "css", "json", "sourcemap"].includes(file.format)} title={beautifying ? "Beautifying is already in progress." : file.bytes.length > 5 * 1024 * 1024 ? "Beautify supports sources up to 5 MiB." : !["html", "javascript", "css", "json", "sourcemap"].includes(file.format) ? "This evidence format is not supported by Beautify." : "Create a formatted view; original evidence stays unchanged."}>{beautifying ? "Beautifying…" : "Beautify"}</button></Tooltip>
                {beautifying && <button onClick={cancelBeautify} aria-label="Cancel beautifying">Cancel</button>}</div>
              <div className="view-content">
                {view === "Original" && originalText !== undefined && (
                  <Editor
                    file={file}
                    value={originalText}
                    original
                    location={location}
                    onSelection={setLocation}
                    breakpointLines={(project.breakpoints || [])
                      .filter(
                        (bp) =>
                          bp.url ===
                          (file.runtimeUrl ||
                            "http://127.0.0.1:8765/" + file.name),
                      )
                      .map((bp) => bp.line)}
                    onBreakpoint={(line) => {
                      const url =
                        file.runtimeUrl || "http://127.0.0.1:8765/" + file.name;
                      const existing = current.current.breakpoints?.find(
                        (bp) => bp.url === url && bp.line === line,
                      );
                      const breakpoint = {
                        id: uid(),
                        url,
                        line,
                        condition: "",
                      };
                      update((p) => ({
                        ...p,
                        breakpoints: existing
                          ? (p.breakpoints || []).filter(
                              (bp) => bp.id !== existing.id,
                            )
                          : [...(p.breakpoints || []), breakpoint],
                      }));
                      window.dispatchEvent(
                        new CustomEvent("wret-debug-command", {
                          detail: existing
                            ? { action: "removeBreakpoint", id: existing.id }
                            : { action: "breakpoint", breakpoint },
                        }),
                      );
                    }}
                  />
                )}
                {view === "Beautified" && (
                  <>
                    <div className="view-help">
                      Derived formatting · original bytes are preserved. No
                      exact source map is available; annotate the Original view.
                    </div>
                    <div className="render-toolbar">
                      <button aria-label="Copy beautified source" onClick={() => { try { void navigator.clipboard.writeText(beautified[file.id] || result?.formatted || "").then(() => setError("Beautified source copied."), () => setError("Clipboard access was denied.")); } catch { setError("Clipboard access is unavailable."); } }}>Copy beautified source</button>
                      <button onClick={() => download(file.name.replace(/(\.[^./]+)$/, ".beautified$1"), beautified[file.id] || result?.formatted || "", "text/plain")}>Download beautified file</button>
                    </div>
                    <Editor
                      file={file}
                      value={beautified[file.id] || result?.formatted || ""}
                      original={false}
                      onSelection={() => {}}
                    />
                  </>
                )}
                {view === "Render" && file.format === "html" && <StaticRenderView files={project.files} file={file} onInteractive={() => startInteractivePreview(file)} />}
                {view === "WAT" && (
                  <>
                    <div className="view-help">
                      WABT disassembly · sample is never instantiated. Select an
                      outline entry, then Hex to inspect its original function
                      body or containing section.
                    </div>
                    <Editor
                      file={file}
                      value={displayedWat || ""}
                      original={false}
                      line={watLine}
                      onSelection={() => {}}
                    />
                  </>
                )}
                {view === "Wasm" && result?.wasmFunctions && (
                  <WasmView
                    analysis={result}
                    aliases={project.wasmAliases || []}
                    onAlias={(functionIndex, name) => update((p) => {
                      const aliases = (p.wasmAliases || []).filter((a) => !(a.moduleHash === result.hash && a.functionIndex === functionIndex));
                      if (name.trim()) aliases.push({ moduleHash: result.hash, functionIndex, name: name.trim().slice(0, 128) });
                      return { ...p, wasmAliases: aliases };
                    })}
                    onBytes={(start, end) => {
                      setLocation({ fileId: file.id, start, end });
                      setHexPage(Math.floor(start / 512));
                      setView("Hex");
                    }}
                  />
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
                        <option value="strings">
                          Fold constant string concatenation
                        </option>
                        <option value="nested">
                          Decode nested encodings (up to 5 layers)
                        </option>
                        <option value="gzip">gzip decompress (Base64 input)</option>
                        <option value="deflate">deflate decompress (Base64 input)</option>
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
                      maxLength={operation === "gzip" || operation === "deflate" ? 2 * 1024 * 1024 : 1024 * 1024}
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
          ) : selected === WELCOME_TAB_ID ? (
            <div className="welcome">
              <img className="welcome-emblem" src={whidraLogoUrl} alt="Whidra hydra and gear logo" />
              <div className="section-kicker">WEB-BASED REVERSE ENGINEERING TOOL</div>
              <h1>Whidra</h1>
              <p>
                Inspect web code, trace behavior, debug, and connect evidence in one browser-based workspace.
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
          ) : (
            <div className="inspect-empty">
              <h2>No editor tab open</h2>
              <p>Your evidence remains in Project Explorer. Open a file or restore the Welcome page.</p>
              <div>
                {project.files[0] && <button onClick={() => selectFile(project.files[0])}>Open first evidence file</button>}
                <button onClick={selectWelcome}>Open Welcome</button>
              </div>
            </div>
          )}
        </section>
        <aside className="inspector">
          <div className="pane-heading">
            <span>INVESTIGATION</span>
            <span className="teal">◎</span>
          </div>
          <div className="inspector-evidence-context" title={file?.name || "No evidence selected"}>
            <span>{file?.name || "No evidence selected"}</span>
            {file?.result && !file.result.tool && <small className="legacy-result-label">Legacy analysis result · analyzer version not recorded</small>}
            <small>{file ? `${size(file.bytes.length)} · ${file.format}` : "Choose a file in Project Explorer"}</small>
          </div>
          <div className="inspector-tabs" role="tablist" aria-label="Investigation tools" aria-orientation="horizontal">
            {inspectorPanels.map((p) => (
              <Tooltip key={p} wrapperRole="presentation" content={{Findings:"Review analysis indicators and their source locations.",Symbols:"Browse functions, classes, and other parsed symbols.",Search:"Search across all imported project evidence.",Notes:"Create and review annotations attached to evidence.",Strings:"Review strings extracted during static analysis.",Sections:"Inspect sections detected in WebAssembly evidence."}[p]}><button
                ref={(element) => { inspectorTabRefs.current[p] = element; }}
                id={`investigation-tab-${p.toLowerCase()}`}
                type="button"
                role="tab"
                aria-label={p}
                aria-controls="investigation-panel"
                aria-selected={panel === p}
                tabIndex={panel === p ? 0 : -1}
                className={panel === p ? "active" : ""}
                onClick={() => setPanel(p)}
                onKeyDown={(event) => {
                  const index = inspectorPanels.indexOf(p);
                  const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % inspectorPanels.length
                    : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + inspectorPanels.length - 1) % inspectorPanels.length
                      : event.key === "Home" ? 0 : event.key === "End" ? inspectorPanels.length - 1 : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  const nextPanel = inspectorPanels[next];
                  setPanel(nextPanel);
                  inspectorTabRefs.current[nextPanel]?.focus();
                }}
              >
                <span>{p}</span>
                <small>{inspectorCount(p) === undefined ? "—" : inspectorCount(p)!.toLocaleString()}</small>
              </button></Tooltip>
            ))}
          </div>
          <div className="inspector-content" id="investigation-panel" role="tabpanel" aria-labelledby={`investigation-tab-${panel.toLowerCase()}`} tabIndex={0}>
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
                {filteredFindings
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
                {filteredFindings.length > resultCount && (
                  <button
                    className="more"
                    onClick={() => setResultCount((n) => n + 100)}
                  >
                    Show more
                  </button>
                )}
                {!filteredFindings.length && <div className="inspector-empty" role="status">{!file ? "Select evidence in Project Explorer to inspect its indicators." : !result ? "Analysis has not completed for this evidence yet." : filter ? "No findings match this filter." : "No indicator patterns were found."}</div>}
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
                {!project.notes.length && <p className="inspector-empty">No notes yet. Add an observation above to keep it with this project.</p>}
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
                    download("whidra-report.md", report(project), "text/markdown")
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
      {mode === "Inspect" && file && (
        <section className="source-map-panel">
          <details>
            <summary>
              Local source map navigation · {mapping.mappings.length} mappings
            </summary>
            {mapping.diagnostics.map((d, i) => (
              <p key={i}>{d}</p>
            ))}
            {mapping.mappings.slice(0, 100).map((m, i) => (
              <button key={i} onClick={() => navigate(m.original)}>
                Generated {m.line}:{m.column} → {m.source} byte{" "}
                {m.original.start}
              </button>
            ))}
            {mapping.mappings.length > 100 && (
              <p>
                First 100 mappings shown. Select a generated position and use
                the nearest mapping below.
              </p>
            )}
            <button
              disabled={!mapping.mappings.length}
              onClick={() => {
                const byte = location?.fileId === file.id ? location.start : 0;
                const nearest = [...mapping.mappings]
                  .reverse()
                  .find((m) => m.generated.start <= byte);
                if (nearest) navigate(nearest.original);
              }}
            >
              Navigate selected position to original source
            </button>
          </details>
        </section>
      )}
      <section
        className="jobs-pane"
        style={mode === "Inspect" ? undefined : { display: "none" }}
      >
        <div className="jobs-heading">
          <span>
            ANALYSIS JOBS <span className="counter">{jobs.length}</span>
          </span>
          <span className="jobs-hint">
            Static analysis jobs terminate after 10 seconds
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
              Ready to inspect. Static analysis runs in workers. Dynamic
              execution requires an explicitly started VM session.
            </p>
          )}
        </div>
      </section>
      <footer className="statusbar">
        <span className="product-version">Whidra v{packageJson.version}</span>
        <span className={`tool-readiness ${toolStatus}`} title={toolStatusMessage || undefined}>
          Analyzer: {toolStatus === "checking" ? "checking" : toolStatus === "ready" ? "ready" : toolStatus === "update" ? "update required" : "unavailable"}
        </span>
        <button
          onClick={() =>
            download("whidra-report.md", report(project), "text/markdown")
          }
        >
          Export report ↗
        </button>
      </footer>
    </div>
  );
}
