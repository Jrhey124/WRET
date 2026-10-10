import { useEffect, useRef, useState } from "react";
import {
  CAPTURE_LIMIT,
  type Capabilities,
  type DebugCommand,
  type DebugSession,
  type Observation,
} from "./debug-types";
import {
  type Project,
  type Evidence,
  detectFormat,
  uid,
  sha256,
  sourceLineStarts,
  offsetToByte,
  decodeText,
} from "./model";
import { toBase64 } from "./storage";
import { portableObservation, safeCapturedUrl, updateCapturedRequests } from "./capture";
import { RuntimeTools } from "./RuntimeTools";
export function DebugPanel({
  project,
  update,
  onNavigate,
  active,
  initialEntry,
  initialSelection,
}: {
  project: Project;
  update: (fn: (p: Project) => Project) => void;
  onNavigate: (file: Evidence, start?: number) => void;
  active: boolean;
  initialEntry?: string;
  initialSelection?: string[];
}) {
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [guestFeatures, setGuestFeatures] = useState<string[]>([]);
  const [unsupportedFeatures, setUnsupportedFeatures] = useState<Record<string, string>>({});
  const [skippingPauses, setSkippingPauses] = useState(false);
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [connected, setConnected] = useState(false);
  const [entry, setEntry] = useState(""),
    [url, setUrl] = useState(""),
    [origin, setOrigin] = useState(""),
    [approved, setApproved] = useState<string[]>([]);
  const [preview, setPreview] = useState(""),
    [paused, setPaused] = useState<any>(),
    [frameIndex, setFrameIndex] = useState(0);
  const [expression, setExpression] = useState(""),
    [evaluation, setEvaluation] = useState<any>(),
    [properties, setProperties] = useState<any>();
  const [bpUrl, setBpUrl] = useState(""),
    [bpLine, setBpLine] = useState(1),
    [condition, setCondition] = useState("");
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!initialEntry) return;
    setEntry(initialEntry);
    setBpUrl("http://127.0.0.1:8765/" + initialEntry);
    setSelection(Object.fromEntries(project.files.map((file) => [file.id, (initialSelection || []).includes(file.id)])));
  }, [initialEntry, initialSelection]);
  const [exceptionState, setExceptionState] = useState<
    "none" | "uncaught" | "all"
  >("none");
  const [watches, setWatches] = useState<string[]>([]),
    [watchValues, setWatchValues] = useState<Record<string, unknown>>({});
  const selectedEvidence = project.files.filter(
    (f) => selection[f.id] ?? !f.name.startsWith("runtime/"),
  );
  const token = useRef(""),
    socket = useRef<WebSocket | undefined>(undefined),
    current = useRef(project),
    updateRef = useRef(update),
    target = useRef("files"),
    activeId = useRef(""),
    eventQueue = useRef<Promise<void>>(Promise.resolve());
  const liveScriptUrls = useRef(new Map<string, Set<string>>());
  current.current = project;
  updateRef.current = update;
  function applyUpdate(fn: (p: Project) => Project) {
    updateRef.current((p) => {
      const next = fn(p);
      current.current = next;
      return next;
    });
  }
  const [status, setStatus] = useState("No active session");
  const activeProjectSession = (project.sessions || []).find((session) => ["starting", "running", "paused"].includes(session.status));
  async function api(path: string, body?: unknown) {
    const response = await fetch("/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token.current,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Companion request failed");
    return result;
  }
  async function command(command: DebugCommand) {
    try {
      setError("");
      if (command.action === "liveEdit") {
        const urls = [...(liveScriptUrls.current.get(command.url) || [])];
        if (urls.length !== 1) throw new Error("This captured URL does not identify a unique script in the live session. Capture or reconnect to the loaded script first.");
        command = { ...command, url: urls[0] };
      }
      const result = await api("command", {
        ...command,
        ...(paused?.target ? { target: paused.target } : {}),
      });
      return result;
    } catch (error) {
      setError(String(error));
    }
  }
  useEffect(() => {
    const listener = (event: Event) => {
      if (connected && ["Running", "Paused"].includes(status))
        void command((event as CustomEvent<DebugCommand>).detail);
    };
    window.addEventListener("wret-debug-command", listener);
    const shortcuts = (event: KeyboardEvent) => {
      if (!active || !connected) return;
      const action =
        event.key === "F5"
          ? event.shiftKey
            ? "stop"
            : "resume"
          : event.key === "F8"
            ? "pause"
            : event.key === "F10"
              ? "stepOver"
              : event.key === "F11"
                ? event.shiftKey
                  ? "stepOut"
                  : "stepInto"
                : undefined;
      if (action) {
        event.preventDefault();
        void command({ action });
      }
    };
    window.addEventListener("keydown", shortcuts);
    return () => {
      window.removeEventListener("wret-debug-command", listener);
      window.removeEventListener("keydown", shortcuts);
    };
  }, [connected, status, active, paused]);
  useEffect(() => {
    if (!paused || !watches.length) return;
    let cancelled = false;
    const frame = paused.callFrames?.[frameIndex];
    for (const watch of watches)
      void command({
        action: "evaluate",
        expression: watch,
        callFrameId: frame?.callFrameId,
      }).then((result) => {
        if (!cancelled)
          setWatchValues((values) => ({ ...values, [watch]: result }));
      });
    return () => {
      cancelled = true;
    };
  }, [paused, frameIndex, watches]);
  async function accept(id: string, observation: Observation) {
    if (
      current.current.sessions?.find((s) => s.id === id)?.truncated &&
      !["paused", "running", "stopped", "failed"].includes(observation.kind)
    )
      return;
    const latest =
      current.current.sessions?.find((s) => s.id === id)?.observations.at(-1)
        ?.sequence || 0;
    const newest = observation.sequence > latest;
    if (
      (current.current.sessions || [])
        .find((s) => s.id === id)
        ?.observations.some((o) => o.sequence === observation.sequence)
    )
      return;
    activeId.current = id;
    const rawData = observation.data as any;
    if (observation.kind === "script" && typeof rawData?.url === "string" && rawData.url) {
      const key = safeCapturedUrl(rawData.url);
      const urls = liveScriptUrls.current.get(key) || new Set<string>();
      urls.add(rawData.url); liveScriptUrls.current.set(key, urls);
    }
    if (observation.kind === "capabilities" && Array.isArray(rawData?.features)) {
      setGuestFeatures(rawData.features.filter((feature: unknown) => typeof feature === "string").slice(0, 20));
      setUnsupportedFeatures(Object.fromEntries(Object.entries(rawData.unsupported || {}).slice(0, 20).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => [key, value.slice(0, 1000)])));
    }
    if (observation.kind === "pausePolicy" && typeof rawData?.skip === "boolean") setSkippingPauses(rawData.skip);
    const candidateData = rawData && typeof rawData === "object" ? { ...rawData } : rawData;
    let resourceBytes: Uint8Array | undefined;
    if (candidateData && (observation.kind === "resource" || observation.kind === "response") && typeof candidateData.body === "string") {
      try {
        const encoded = candidateData.body as string;
        if (encoded.length <= 1_400_000 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
          resourceBytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      } catch { resourceBytes = undefined; }
    } else if ((observation.kind === "script" || observation.kind === "liveEdit" && candidateData?.status === "Ok" && !candidateData?.dryRun) && typeof candidateData?.source === "string") {
      resourceBytes = new TextEncoder().encode(candidateData.source);
    } else if (observation.kind === "snapshot") {
      resourceBytes = new TextEncoder().encode(JSON.stringify(portableObservation(candidateData), null, 2));
    }
    let resourceEvidence: Evidence | undefined;
    if (resourceBytes && resourceBytes.length <= 1024 * 1024) {
      const hash = await sha256(resourceBytes);
      const existing = current.current.files.find((file) => file.hash === hash);
      const rawUrl = typeof candidateData.url === "string" ? candidateData.url : "";
      const extension = (() => {
        if (observation.kind === "snapshot") return "json";
        if (observation.kind === "script" || observation.kind === "liveEdit") return "js";
        try { return new URL(rawUrl).pathname.split("/").pop()?.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase() || "bin"; }
        catch { return "bin"; }
      })();
      const runtimeName = `runtime/${id}/resources/${observation.sequence}.${extension}`;
      resourceEvidence = existing || {
        id: uid(), name: runtimeName, format: detectFormat(runtimeName, resourceBytes),
        bytes: resourceBytes, hash, runtimeUrl: safeCapturedUrl(rawUrl) || undefined,
        captureKind: observation.kind === "snapshot" ? "snapshot" : observation.kind === "liveEdit" ? "live-edit" : observation.kind === "script" ? "script" : "response",
      };
      if (!existing && observation.kind === "liveEdit") {
        const original = current.current.files.find((file) => file.runtimeUrl === safeCapturedUrl(rawUrl) && file.hash);
        if (original) resourceEvidence.derivation = { sourceId: original.id, sourceHash: original.hash!, recipe: "live-edit", createdAt: observation.time, changes: 1 };
      }
      candidateData.evidenceId = resourceEvidence.id;
      if (observation.kind === "resource" || observation.kind === "response") delete candidateData.body;
      if (observation.kind === "script" || observation.kind === "liveEdit") delete candidateData.source;
    } else if (resourceBytes) {
      candidateData.truncated = true;
      delete candidateData.body;
      delete candidateData.source;
    } else if (candidateData && (observation.kind === "resource" || observation.kind === "response")) {
      candidateData.truncated = true;
      delete candidateData.body;
    }
    const clean = { ...observation, data: portableObservation(candidateData) };
    applyUpdate((p) => {
      const sessions = [...(p.sessions || [])];
      if (sessions.length >= 100 && !sessions.some((s) => s.id === id))
        return p;
      let index = sessions.findIndex((s) => s.id === id);
      if (index < 0) {
        index = sessions.length;
        sessions.push({
          id,
          createdAt: observation.time,
          target: target.current,
          status: "starting",
          approvals: [...approved],
          observations: [],
          requests: [],
          capturedBytes: 0,
          truncated: false,
        });
      }
      const existing = sessions[index];
      if (existing.observations.some((o) => o.sequence === clean.sequence))
        return p;
      const hasResource = Boolean(resourceEvidence && p.files.some((file) => file.hash === resourceEvidence!.hash));
      let bytes = new TextEncoder().encode(JSON.stringify(clean)).length;
      if (resourceEvidence && !hasResource) bytes += resourceEvidence.bytes.length;
      const total =
        sessions.reduce(
          (sum, s) => sum + s.capturedBytes + s.observations.length,
          0,
        ) +
        new TextEncoder().encode(
          JSON.stringify(
            sessions.map(({ observations, ...metadata }) => metadata),
          ),
        ).length;
      const status =
        newest &&
        ["running", "paused", "stopped", "failed"].includes(observation.kind)
          ? (observation.kind as DebugSession["status"])
          : existing.status;
      const approvals =
        observation.kind === "approval" && typeof observation.data === "string"
          ? [...new Set([...existing.approvals, observation.data])]
          : existing.approvals;
      const captureAllowed = total + bytes <= CAPTURE_LIMIT - 4096 && existing.observations.length < 50000;
      const evidenceAllowed = !resourceEvidence || Boolean(captureAllowed && (hasResource || (p.files.length < 1000 && p.files.reduce((sum, file) => sum + file.bytes.length, 0) + resourceEvidence.bytes.length <= 100 * 1024 * 1024)));
      const cleanData = clean.data as any;
      const storedObservation = !evidenceAllowed ? {
        ...clean,
        data: { ...cleanData, evidenceId: undefined, truncated: true },
      } : clean;
      if (!evidenceAllowed && resourceEvidence && !hasResource)
        bytes -= resourceEvidence.bytes.length;
      const storedBytes = new TextEncoder().encode(JSON.stringify(storedObservation)).length + (evidenceAllowed && resourceEvidence && !hasResource ? resourceEvidence.bytes.length : 0);
      const fitsCapture = total + storedBytes <= CAPTURE_LIMIT - 4096 && existing.observations.length < 50000;
      sessions[index] = {
        ...existing,
        status,
        approvals,
        capturedBytes: existing.capturedBytes + (fitsCapture ? storedBytes : 0),
        truncated:
          existing.truncated ||
          observation.kind === "truncated" ||
          !fitsCapture,
        observations:
          fitsCapture
            ? [...existing.observations, storedObservation].sort(
                (a, b) => a.sequence - b.sequence,
              )
            : existing.observations,
        // Keep transient CDP IDs in the in-memory request index so subsequent
        // events can be correlated. Portable observations strip those handles
        // before persistence and export; the normalized request id is stable.
        requests: updateCapturedRequests(existing.requests || [], { ...storedObservation, data: candidateData }),
      };
      const files = evidenceAllowed && resourceEvidence && !hasResource ? [...p.files, resourceEvidence] : evidenceAllowed && resourceEvidence && candidateData?.url ? p.files.map((file) => file.id === resourceEvidence!.id && !file.runtimeUrl ? { ...file, runtimeUrl: safeCapturedUrl(candidateData.url) || undefined } : file) : p.files;
      return { ...p, schema: 4, sessions, files };
    });
    const data = observation.data as any;
    if (newest && observation.kind === "paused") {
      setPaused(data);
      setFrameIndex(0);
      setStatus("Paused");
    }
    if (newest && observation.kind === "running") {
      setPaused(undefined);
      setStatus("Running");
    }
    if (newest && ["failed", "stopped"].includes(observation.kind)) {
      setPaused(undefined);
      setStatus(observation.kind);
    }
  }
  async function connect() {
    try {
      setPending(true);
      setError("");
      const response = await fetch("/api/bootstrap");
      if (!response.ok)
        throw new Error(
          "Start the local companion with npm run companion. The static server supports inspection only.",
        );
      token.current = (await response.json()).token;
      setCapabilities(await api("capabilities"));
      socket.current?.close();
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/stream`,
        token.current,
      );
      socket.current = ws;
      ws.onopen = () => {
        setConnected(true);
        setStatus("Companion connected");
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.kind === "state" && message.status === "failed")
          setError(String(message.data));
        if (message.kind === "preview") setPreview(message.data.image);
        else if (message.kind === "state") {
          activeId.current = message.sessionId;
          target.current = message.target || target.current;
          if (message.status === "paused") {
            setPaused(message.data);
            setFrameIndex(0);
            setStatus("Paused");
          } else {
            setPaused(undefined);
            setStatus(
              message.status === "running" ? "Running" : message.status,
            );
          }
          applyUpdate((p) => ({
            ...p,
            sessions: (p.sessions || []).map((s) =>
              s.id === message.sessionId ? { ...s, status: message.status } : s,
            ),
          }));
        } else if (message.observation)
          eventQueue.current = eventQueue.current
            .then(() => accept(message.sessionId, message.observation))
            .catch((error) => setError(String(error)));
      };
      ws.onclose = () => {
        setConnected(false);
        setStatus("Companion disconnected");
        applyUpdate((p) => ({
          ...p,
          sessions: (p.sessions || []).map((s) =>
            ["running", "starting", "paused"].includes(s.status)
              ? { ...s, status: "disconnected" }
              : s,
          ),
        }));
      };
      ws.onerror = () => setError("Companion stream connection failed.");
      const replay = await api("events");
      for (const observation of replay.events)
        await accept(replay.sessionId, observation);
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(false);
    }
  }
  useEffect(
    () => () => {
      socket.current?.close();
    },
    [],
  );
  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(() => {
      const session = current.current.sessions?.find(
        (s) => s.id === activeId.current,
      );
      if (session?.truncated) return;
      const after =
        session?.observations.reduce(
          (last, o) => (o.sequence === last + 1 ? o.sequence : last),
          0,
        ) || 0;
      void api("events?after=" + after)
        .then((replay) => {
          for (const observation of replay.events)
            eventQueue.current = eventQueue.current.then(() =>
              accept(replay.sessionId, observation),
            );
        })
        .catch((error) => setError(String(error)));
    }, 3000);
    return () => clearInterval(interval);
  }, [connected]);
  async function start() {
    setGuestFeatures([]); setUnsupportedFeatures({}); setSkippingPauses(false); liveScriptUrls.current.clear();
    setPending(true);
    setError("");
    setStatus("Starting disposable VM…");
    target.current = url.trim() || "files";
    try {
      if (
        (current.current.sessions || []).length >= 100 ||
        new TextEncoder().encode(JSON.stringify(current.current.sessions || []))
          .length >
          CAPTURE_LIMIT - 1024 * 1024
      )
        throw new Error(
          "Runtime project budget reached. Export this investigation and start another project.",
        );
      if (!url && !entry)
        throw new Error("Choose an HTML entrypoint or JavaScript harness.");
      const result = await api("sessions", {
        target: target.current,
        entry,
        files: url
          ? []
          : selectedEvidence.map((f) => ({
              id: f.id,
              name: f.name,
              bytes: toBase64(f.bytes),
            })),
        breakpoints: current.current.breakpoints || [],
        approvals: approved,
        exceptionState,
      });
      activeId.current = result.id;
    } catch (error) {
      setError(String(error));
      setStatus("Session could not start");
    } finally {
      setPending(false);
    }
  }
  async function approve() {
    try {
      const parsed = new URL(origin);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw new Error("Enter an HTTP(S) origin");
      if (
        !window.confirm(
          `Allow the VM to contact ${parsed.origin}? Requests may transmit sample data to this destination.`,
        )
      )
        return;
      if (["Running", "Paused"].includes(status))
        await api("command", { action: "approve", origin: parsed.origin });
      setApproved((values) => [...new Set([...values, parsed.origin])]);
      setOrigin("");
    } catch (error) {
      setError(String(error));
    }
  }
  const frames = paused?.callFrames || [],
    selectedFrame = frames[frameIndex];
  const observations = (project.sessions || [])
    .flatMap((s) => s.observations)
    .slice(-100)
    .reverse();
  return (
    <section className="debug-workspace" hidden={!active}>
      <div className="section-kicker">ISOLATED DYNAMIC INVESTIGATION</div>
      <h1>Debug and capture behavior</h1>
      <p>
        Samples execute inside a disposable VM on your computer. External
        requests start blocked. Console and watch expressions execute code
        inside the guest.
      </p>
      <div className="debug-toolbar">
        <strong>{status}</strong>
        <button disabled={pending} onClick={() => void connect()} title="Check the companion connection and refresh its VM capability checks.">
          Check companion / reconnect
        </button>
        <button
          disabled={!connected || !capabilities?.ready || pending || !!activeProjectSession}
          onClick={() => void start()}
          title={activeProjectSession ? "Stop the active session before starting a different entrypoint." : "Start an isolated session after companion setup succeeds and an entrypoint or URL is ready."}
        >
          Start session
        </button>
        <button
          disabled={!connected}
          onClick={() => void command({ action: "stop" })}
          title="Stop the session and destroy its temporary VM state."
        >
          Stop and destroy VM
        </button>
        <button
          disabled={!connected}
          onClick={() => void command({ action: "extend" })}
          title="Add 30 minutes to the active session limit."
        >
          Extend 30 minutes
        </button>
      </div>
      {activeProjectSession && <p role="status" className="view-help">Session {activeProjectSession.id} is {activeProjectSession.status}. Stop and destroy that VM before starting a different entrypoint.</p>}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {project.sessions?.some((s) => s.truncated) && (
        <p className="alert">
          Runtime capture was truncated by a storage or event limit. Existing
          observations are preserved; export this investigation and begin
          another project for more capture.
        </p>
      )}
      {capabilities && (
        <details open={!capabilities.ready}>
          <summary>Setup checks</summary>
          {capabilities.checks.map((c) => (
            <p key={c.name}>
              {c.ok ? "✓" : "!"} <strong>{c.name}</strong> — {c.detail}
            </p>
          ))}
        </details>
      )}
      <RuntimeTools files={project.files} features={guestFeatures} unsupported={unsupportedFeatures} active={connected && ["Running", "Paused"].includes(status)} frame={paused?.callFrames?.[frameIndex]} skipping={skippingPauses} command={command} />
      <div className="debug-grid">
        <section>
          <h2>Session input</h2>
          <details>
            <summary>
              Evidence sent to the VM · {selectedEvidence.length} files
            </summary>
            <p>Only checked files are copied into the guest.</p>
            {project.files.map((f) => (
              <label key={f.id}>
                <input
                  type="checkbox"
                  checked={selection[f.id] ?? !f.name.startsWith("runtime/")}
                  onChange={(event) =>
                    setSelection((values) => ({
                      ...values,
                      [f.id]: event.target.checked,
                    }))
                  }
                />
                {f.name}
              </label>
            ))}
          </details>
          <label>
            Imported entrypoint
            <select
              aria-label="Debug entrypoint"
              title="Choose an imported HTML page or JavaScript harness to run in the guest browser."
              value={entry}
              onChange={(e) => {
                setEntry(e.target.value);
                setBpUrl("http://127.0.0.1:8765/" + e.target.value);
              }}
            >
              <option value="">Choose HTML or JavaScript</option>
              {project.files
                .filter((f) => ["html", "javascript"].includes(f.format))
                .map((f) => (
                  <option key={f.id} value={f.name}>
                    {f.name}
                    {f.format === "javascript" ? " (module harness)" : ""}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Or website URL
            <input
              aria-label="Website URL"
              title="Enter a website URL. Its destination must be approved before requests are allowed."
              placeholder="https://example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <p>
            For URL sessions, approve the website origin first. Imported
            JavaScript uses a browser module harness; Node.js APIs are
            unavailable.
          </p>
          <label>
            Network destination
            <input
              aria-label="Network destination"
              title="Enter an external origin to approve for this session. Private and host destinations are rejected."
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder="https://example.com"
            />
          </label>
          <button onClick={() => void approve()} title="Allow this external destination through the session network broker.">Approve destination</button>
          <ul>
            {approved.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
        <section>
          <h2>Breakpoints</h2>
          <p>
            Click the source editor gutter to toggle a breakpoint. F5 resumes,
            F8 pauses, F10 steps over, and F11 steps into.
          </p>
          <label>
            Script URL
            <input
              aria-label="Breakpoint URL"
              value={bpUrl}
              onChange={(e) => setBpUrl(e.target.value)}
            />
          </label>
          <label>
            Line
            <input
              aria-label="Breakpoint line"
              type="number"
              min="1"
              value={bpLine}
              onChange={(e) => setBpLine(Number(e.target.value))}
            />
          </label>
          <label>
            Condition
            <input
              aria-label="Breakpoint condition"
              title="Optional JavaScript expression evaluated in the paused guest context."
              value={condition}
              maxLength={4096}
              onChange={(e) => setCondition(e.target.value)}
            />
          </label>
          <button
            onClick={() => {
              if (!bpUrl || !Number.isSafeInteger(bpLine) || bpLine < 1) return;
              const breakpoint = {
                id: uid(),
                url: bpUrl,
                line: bpLine,
                condition,
              };
              update((p) => ({
                ...p,
                breakpoints: [...(p.breakpoints || []), breakpoint],
              }));
              if (["Running", "Paused"].includes(status))
                void command({ action: "breakpoint", breakpoint });
            }}
          >
            Add breakpoint
          </button>
          {(project.breakpoints || []).map((bp) => (
            <p key={bp.id}>
              {bp.url}:{bp.line} {bp.condition}
              <button
                onClick={() => {
                  update((p) => ({
                    ...p,
                    breakpoints: (p.breakpoints || []).filter(
                      (x) => x.id !== bp.id,
                    ),
                  }));
                  if (["Running", "Paused"].includes(status))
                    void command({ action: "removeBreakpoint", id: bp.id });
                }}
              >
                Remove
              </button>
            </p>
          ))}
        </section>
      </div>
      <div className="debug-toolbar">
        {(["pause", "resume", "stepInto", "stepOver", "stepOut"] as const).map(
          (action) => (
            <button
              key={action}
              disabled={!connected}
              onClick={() => void command({ action })}
            >
              {action.replace(/([A-Z])/g, " $1")}
            </button>
          ),
        )}
        <label>
          Pause on exceptions
          <select
            aria-label="Pause on exceptions"
            title="Choose whether the debugger pauses when guest code throws an exception."
            value={exceptionState}
            onChange={(e) => {
              const state = e.target.value as "none" | "uncaught" | "all";
              setExceptionState(state);
              if (["Running", "Paused"].includes(status))
                void command({ action: "exceptions", state });
            }}
          >
            <option value="none">None</option>
            <option value="uncaught">Uncaught</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>
      <div className="debug-grid">
        <section>
          <h2>Guest browser preview</h2>
          {preview ? (
            <img
              className="guest-preview"
              src={"data:image/jpeg;base64," + preview}
              alt="Guest browser preview"
              tabIndex={0}
              onMouseDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                void command({
                  action: "input",
                  type: "mousePressed",
                  x: ((e.clientX - rect.left) * 1280) / rect.width,
                  y: ((e.clientY - rect.top) * 720) / rect.height,
                });
              }}
              onMouseUp={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                void command({
                  action: "input",
                  type: "mouseReleased",
                  x: ((e.clientX - rect.left) * 1280) / rect.width,
                  y: ((e.clientY - rect.top) * 720) / rect.height,
                });
              }}
              onKeyDown={(e) => {
                e.preventDefault();
                void command({
                  action: "input",
                  type: "keyDown",
                  key: e.key,
                  text: e.key.length === 1 ? e.key : undefined,
                });
              }}
              onKeyUp={(e) => {
                e.preventDefault();
                void command({ action: "input", type: "keyUp", key: e.key });
              }}
            />
          ) : (
            <p>Preview appears after the VM starts.</p>
          )}
        </section>
        <section>
          <h2>Call stack and variables</h2>
          {frames.map((frame: any, index: number) => (
            <button
              key={frame.callFrameId}
              className={index === frameIndex ? "active" : ""}
              onClick={() => {
                setFrameIndex(index);
                const file = project.files.find(
                  (f) =>
                    f.runtimeUrl === frame.url ||
                    "http://127.0.0.1:8765/" + f.name === frame.url,
                );
                if (file) {
                  const text = decodeText(file.bytes);
                  const starts = sourceLineStarts(text);
                  onNavigate(
                    file,
                    offsetToByte(
                      text,
                      (starts[frame.location.lineNumber] || 0) +
                        frame.location.columnNumber,
                    ),
                  );
                }
              }}
            >
              {frame.functionName || "(anonymous)"} · {frame.url}:
              {frame.location.lineNumber + 1}
            </button>
          ))}
          {selectedFrame?.scopeChain.map((scope: any, index: number) => (
            <button
              key={index}
              onClick={() =>
                void command({
                  action: "properties",
                  objectId: scope.object.objectId,
                }).then(setProperties)
              }
            >
              {scope.type} scope
            </button>
          ))}
          {properties && <pre>{JSON.stringify(properties, null, 2)}</pre>}
          {properties?.result
            ?.filter((property: any) => property.value?.objectId)
            .map((property: any) => (
              <button
                key={property.name}
                onClick={() =>
                  void command({
                    action: "properties",
                    objectId: property.value.objectId,
                  }).then(setProperties)
                }
              >
                Inspect {property.name}
              </button>
            ))}
          <label>
            Console / watch expression
            <input
              aria-label="Watch expression"
              title="Watch expressions execute inside the guest while paused. Add only expressions you intend to run."
              value={expression}
              maxLength={4096}
              onChange={(e) => setExpression(e.target.value)}
            />
          </label>
          <button
            onClick={() =>
              void command({
                action: "evaluate",
                expression,
                callFrameId: selectedFrame?.callFrameId,
              }).then(setEvaluation)
            }
          >
            Evaluate in guest
          </button>
          {evaluation && <pre>{JSON.stringify(evaluation, null, 2)}</pre>}
          <button
            onClick={() => {
              if (
                expression.trim() &&
                !watches.includes(expression) &&
                watches.length < 20
              )
                setWatches((values) => [...values, expression]);
            }}
          >
            Pin watch (evaluates on each pause)
          </button>
          {watches.map((watch) => (
            <div key={watch}>
              <strong>{watch}</strong>
              <button
                onClick={() =>
                  setWatches((values) =>
                    values.filter((value) => value !== watch),
                  )
                }
              >
                Remove watch
              </button>
              <pre>{JSON.stringify(watchValues[watch], null, 2)}</pre>
            </div>
          ))}
        </section>
      </div>
      <h2>Saved observations</h2>
      <p>
        Latest 100 observations shown. Full captured evidence is included in
        project export and the report.
      </p>
      {observations.map((o) => (
        <details key={o.time + o.sequence}>
          <summary>
            {o.time} · {o.kind}
          </summary>
          <pre>{JSON.stringify(o.data, null, 2)}</pre>
          <button
            onClick={() =>
              void (async () => {
                const bytes = new TextEncoder().encode(
                  JSON.stringify(o, null, 2),
                );
                if (
                  project.files.length >= 1000 ||
                  project.notes.length >= 50000 ||
                  project.files.reduce((n, f) => n + f.bytes.length, 0) +
                    bytes.length >
                    100 * 1024 * 1024
                ) {
                  setError(
                    "Project evidence or note limit reached. Export and begin another project.",
                  );
                  return;
                }
                const evidence: Evidence = {
                  id: uid(),
                  name: `runtime/observations/${uid()}.json`,
                  format: "json",
                  bytes,
                  hash: await sha256(bytes),
                };
                update((p) => ({
                  ...p,
                  files: [...p.files, evidence],
                  notes: [
                    ...p.notes,
                    {
                      id: uid(),
                      kind: "bookmark",
                      text: `Runtime ${o.kind} observation at ${o.time}`,
                      location: {
                        fileId: evidence.id,
                        start: 0,
                        end: bytes.length,
                      },
                    },
                  ],
                }));
                onNavigate(evidence);
              })()
            }
          >
            Bookmark and annotate observation
          </button>
        </details>
      ))}
    </section>
  );
}
