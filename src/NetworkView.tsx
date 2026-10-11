import { materializeEvidence } from "./storage";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CapturedRequest, DebugSession } from "./debug-types";
import { decodeText, type Evidence } from "./model";

type NetworkEntry = { request: CapturedRequest; session: DebugSession };
type DetailTab = "Overview" | "Request headers" | "Response headers" | "Response" | "Initiator";

export function NetworkView({
  sessions,
  files,
  onOpenEvidence,
  onImportHar, onCollect, onLinkEvidence, onBeautify, onReferences, onDeobfuscate,
}: {
  sessions: DebugSession[];
  files: Evidence[];
  onOpenEvidence: (file: Evidence) => void;
  onImportHar: () => void;
  onCollect: () => void;
  onLinkEvidence: (sessionId: string, requestId: string, evidenceId: string) => void;
  onBeautify: (file: Evidence) => void;
  onReferences: (file: Evidence) => void;
  onDeobfuscate: (file: Evidence) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [captureId, setCaptureId] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const pendingFocus = useRef<number | undefined>(undefined);
  const [scrollTop, setScrollTop] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [detailTab, setDetailTab] = useState<DetailTab>("Overview");
  const [copyStatus, setCopyStatus] = useState("");
  const entries = useMemo<NetworkEntry[]>(
    () => sessions.flatMap((session) => (session.requests || []).map((request) => ({ request, session }))),
    [sessions],
  );
  const evidenceFormats = useMemo(() => new Map(files.map(f => [f.id, f.format])), [files]);
  const filtered = entries.filter(({ request, session }) => {
    const matchesQuery = `${request.url} ${request.method} ${request.resourceType || ""} ${request.mimeType || ""} ${request.status || ""} ${session.target}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const isFailed = Boolean(request.blockedReason) || request.status === undefined || request.status >= 400;
    const kind = `${request.resourceType || ""} ${request.mimeType || ""} ${evidenceFormats.get(request.evidenceId || "") || ""}`.toLowerCase();
    const typeMatch = typeFilter === "all" || (typeFilter === "incomplete" ? Boolean(request.bodyAvailability && request.bodyAvailability !== "retained" || request.truncated) : typeFilter === "scripts" ? /javascript|script/.test(kind) : typeFilter === "documents" ? /html|document/.test(kind) : typeFilter === "styles" ? /css|stylesheet/.test(kind) : typeFilter === "wasm" ? /wasm/.test(kind) : /fetch|xhr|json/.test(kind));
    return (captureId === "all" || session.id === captureId) && typeMatch && matchesQuery && (statusFilter === "all" || (statusFilter === "failed" ? isFailed : request.status !== undefined && Math.floor(request.status / 100) === Number(statusFilter)));
  }).sort((a, b) => a.request.startedAt.localeCompare(b.request.startedAt) || a.request.sequence - b.request.sequence);
  const activeEntry = filtered.find(({ request, session }) => `${session.id}:${request.id}` === selectedId) || filtered[0];
  const maxDuration = Math.max(1, ...filtered.map(({ request }) => request.durationMs || 0));
  useEffect(() => { setScrollTop(0); document.getElementById("request-scroll")?.scrollTo(0, 0); }, [query, captureId, typeFilter, statusFilter]);
  const startRow = Math.max(0, Math.floor(scrollTop / 64) - 4);
  const visible = filtered.slice(startRow, startRow + 24);
  useEffect(() => { if (pendingFocus.current === undefined) return; const button = document.querySelector<HTMLButtonElement>(`[data-request-row="${pendingFocus.current}"]`); if (button) { button.focus({ preventScroll: true }); pendingFocus.current = undefined; } }, [scrollTop, selectedId]);
  const capture = sessions.find(s => s.id === captureId);
  const responseEvidence = activeEntry?.request.evidenceId
    ? files.find((file) => file.id === activeEntry.request.evidenceId)
    : undefined;
  const initiatorEvidence = activeEntry?.request.initiator?.url
    ? files.filter((file) => file.runtimeUrl === activeEntry.request.initiator?.url)
    : [];
  const linkedEvidence = files.find(f => f.id === activeEntry?.request.analystEvidenceId);
  const actionEvidence = responseEvidence || linkedEvidence;
  const detailTabs: DetailTab[] = ["Overview", "Request headers", "Response headers", "Response", "Initiator"];
  async function copyRequestUrl(url: string) {
    let copied = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); copied = true; } } catch { /* Try the browser-compatible fallback below. */ }
    if (!copied) {
      const field = document.createElement("textarea");
      field.value = url; field.setAttribute("readonly", ""); field.style.position = "fixed"; field.style.opacity = "0";
      document.body.append(field); field.select();
      try { copied = document.execCommand("copy"); } catch { copied = false; }
      field.remove();
    }
    setCopyStatus(copied ? "URL copied." : "Copy is unavailable here. Select the URL above and copy it manually.");
  }
  return (
    <section className="network-workspace" aria-labelledby="network-title">
      <header className="network-heading">
        <div>
          <div className="section-kicker">CAPTURED WEBSITE ACTIVITY</div>
          <h1 id="network-title">Network</h1>
          <p>Imported requests and response resources. These are recorded observations, not new execution.</p>
        </div>
        <button onClick={onCollect}>Collect website evidence</button>
        <button onClick={onImportHar} title="Import a HAR file offline. Recorded URLs are never contacted during import.">Import HAR</button>
      </header>
      <div className="network-toolbar">
        <label>Capture<select aria-label="Capture" value={captureId} onChange={e => setCaptureId(e.target.value)}><option value="all">All captures</option>{sessions.map(s => <option value={s.id} key={s.id}>{s.target}</option>)}</select></label>
        <label>Resource type<select aria-label="Resource type" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>{["all", "scripts", "documents", "styles", "wasm", "api", "incomplete"].map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Filter requests<input aria-label="Filter network requests" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="URL, method, type, status…" /></label>
        <label>Status<select aria-label="Filter requests by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="2">2xx success</option><option value="3">3xx redirect</option><option value="4">4xx client error</option><option value="5">5xx server error</option><option value="failed">Failed or blocked</option></select></label>
        <span className="network-count" aria-live="polite">{filtered.length} of {entries.length} requests</span>
      </div>
      <div className="capture-summary" aria-label="Capture coverage">{(capture ? [capture] : sessions).map(s => <details key={s.id}><summary>{s.target} - capture coverage</summary>{s.coverage ? <dl>{Object.entries(s.coverage).map(([key, value]) => <div key={key}><dt>{key.replace(/[A-Z]/g, c => " " + c.toLowerCase())}</dt><dd>{value}</dd></div>)}</dl> : <p>Coverage: Not recorded.</p>}<p>Source: {s.captureSource?.filename || "Not recorded"}. Captured activity is historical; missing bodies are not fetched.</p></details>)}</div>
      <div className="network-grid">
        <div id="request-scroll" className="network-table-wrap" onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
          <table className="network-table" aria-rowcount={filtered.length + 1}>
            <caption className="visually-hidden">Captured network requests. Select a row to inspect its details.</caption>
            <thead><tr><th scope="col">Name / URL</th><th scope="col">Method</th><th scope="col">Status</th><th scope="col">Type</th><th scope="col">Size</th><th scope="col">Time</th><th scope="col">Waterfall</th></tr></thead>
            <tbody>
              {startRow > 0 && <tr aria-hidden="true"><td colSpan={7} style={{height:startRow * 64, padding:0}} /></tr>}
              {visible.map(({ request, session }, row) => (
                <tr aria-rowindex={startRow + row + 2} style={{height:64}} key={`${session.id}:${request.id}`} className={activeEntry?.session.id === session.id && activeEntry.request.id === request.id ? "selected" : ""}>
                  <td><button className="network-row-select" aria-pressed={activeEntry?.session.id === session.id && activeEntry.request.id === request.id} onKeyDown={e => { if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) { e.preventDefault(); const index = startRow + row; const next = e.key === "Home" ? 0 : e.key === "End" ? filtered.length - 1 : Math.max(0, Math.min(filtered.length - 1, index + (e.key === "ArrowDown" ? 1 : -1))); const entry = filtered[next]; setSelectedId(`${entry.session.id}:${entry.request.id}`); const scroller = document.getElementById("request-scroll"); pendingFocus.current = next; setScrollTop(next * 64); scroller?.scrollTo(0, next * 64); } }} data-request-row={startRow + row} onClick={() => { setSelectedId(`${session.id}:${request.id}`); setDetailTab("Overview"); }} title="Select request to inspect its captured details.">{request.url || "(URL unavailable)"}<small>{session.target}</small></button></td>
                  <td>{request.method}</td>
                  <td><span className={`network-status ${request.blockedReason ? "failed" : ""}`}>{request.blockedReason ? "Blocked" : request.status ?? "Pending"}</span></td>
                  <td>{request.resourceType || request.mimeType || "Other"}</td>
                  <td>{request.transferBytes === undefined ? "—" : request.transferBytes < 1024 ? `${request.transferBytes} B` : `${(request.transferBytes / 1024).toFixed(1)} KiB`}{request.truncated ? <span title="Response body was truncated"> · partial</span> : null}</td>
                  <td>{request.durationMs === undefined ? "—" : `${request.durationMs} ms`}</td>
                  <td><span className="network-waterfall-track" aria-label={request.durationMs === undefined ? "Timing unavailable" : `${request.durationMs} milliseconds`}><span style={{ width: `${Math.max(3, ((request.durationMs || 0) / maxDuration) * 100)}%` }} /></span></td>
                </tr>
              ))}
              {filtered.length > startRow + visible.length && <tr aria-hidden="true"><td colSpan={7} style={{height:(filtered.length - startRow - visible.length) * 64, padding:0}} /></tr>}
            </tbody>
          </table>
          {!entries.length && <div className="network-empty"><h2>No captured requests</h2><p>Import a HAR capture or a saved project for offline review.</p><button onClick={onImportHar}>Import HAR</button></div>}
          {!!entries.length && !filtered.length && <p className="network-empty-small">No requests match these filters.</p>}
        </div>
        {activeEntry && <aside className="network-details" aria-label="Selected request details">
          <h2 className="network-request-url">{activeEntry.request.url}</h2>
          <button type="button" onClick={() => void copyRequestUrl(activeEntry.request.url)}>Copy URL</button>{copyStatus && <span role="status">{copyStatus}</span>}
          <p>Response body: {activeEntry.request.bodyAvailability || "Not recorded"}</p>
          <div className="workspace-toolbar"><button disabled={!actionEvidence} title={!actionEvidence ? "Import or associate response evidence first." : "Inspect preserved evidence."} onClick={() => actionEvidence && onOpenEvidence(actionEvidence)}>Open response evidence</button><button disabled={!actionEvidence || (actionEvidence.byteLength ?? actionEvidence.bytes.length) > 5 * 1024 * 1024 || !["javascript", "json", "html", "css", "sourcemap"].includes(actionEvidence.format)} title="Requires supported text evidence, up to 5 MiB." onClick={() => actionEvidence && onBeautify(actionEvidence)}>Beautify</button><button disabled={!actionEvidence || actionEvidence.format !== "javascript" || (actionEvidence.byteLength ?? actionEvidence.bytes.length) > 1024 * 1024} title="Preview conservative JavaScript cleanup on supported evidence up to 1 MiB." onClick={() => actionEvidence && onDeobfuscate(actionEvidence)}>Deobfuscate</button><button disabled={!actionEvidence} title="Choose an identifier or literal query in Cross-references." onClick={() => actionEvidence && onReferences(actionEvidence)}>Find related references</button></div>
          <label>Analyst evidence association<select aria-label="Associate request evidence" value={activeEntry.request.analystEvidenceId || ""} onChange={e => onLinkEvidence(activeEntry.session.id, activeEntry.request.id, e.target.value)}><option value="">No analyst association</option>{files.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label><p>This manual association is an analyst interpretation, not an observed source relationship.</p>
          <p>{activeEntry.request.method} · {activeEntry.request.status ?? (activeEntry.request.blockedReason ? "Blocked" : "Pending")} · {activeEntry.request.mimeType || activeEntry.request.resourceType || "Unknown type"}</p>
          {!!activeEntry.request.blockedReason && <p className="alert">{activeEntry.request.blockedReason}</p>}
          <div className="network-detail-tabs" role="tablist" aria-label="Request details">
            {detailTabs.map((tab) => <button key={tab} id={`network-tab-${tab.toLowerCase().replaceAll(" ", "-")}`} role="tab" aria-controls="network-tabpanel" tabIndex={detailTab === tab ? 0 : -1} aria-selected={detailTab === tab} onClick={() => setDetailTab(tab)} onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                const direction = event.key === "ArrowRight" ? 1 : -1;
                const index = detailTabs.indexOf(tab);
                const next = detailTabs[(index + direction + detailTabs.length) % detailTabs.length];
                setDetailTab(next);
                document.getElementById(`network-tab-${next.toLowerCase().replaceAll(" ", "-")}`)?.focus();
              }
            }}>{tab}</button>)}
          </div>
          <div className="network-detail-content" id="network-tabpanel" role="tabpanel" aria-labelledby={`network-tab-${detailTab.toLowerCase().replaceAll(" ", "-")}`} tabIndex={0}>
            {detailTab === "Overview" && <dl>
              <dt>Captured in</dt><dd>{activeEntry.session.target}</dd>
              <dt>Started</dt><dd>{activeEntry.request.startedAt || "Unknown"}</dd>
              <dt>Duration</dt><dd>{activeEntry.request.durationMs === undefined ? "Not recorded" : `${activeEntry.request.durationMs} ms`}</dd>
              <dt>Transfer size</dt><dd>{activeEntry.request.transferBytes === undefined ? "Not recorded" : `${activeEntry.request.transferBytes.toLocaleString()} bytes`}</dd>
              <dt>Redirected from</dt><dd>{activeEntry.request.redirectFrom || "—"}</dd>
              {activeEntry.request.requestPayloadAvailable && <><dt>Request payload</dt><dd>Present in the browser capture. Payload values are not retained in this release.</dd></>}
              {activeEntry.request.truncated && <><dt>Response body</dt><dd>Availability: {activeEntry.request.bodyAvailability || "Partial capture; detailed coverage not recorded"}.</dd></>}
              {responseEvidence && <><dt>Response resource</dt><dd><button onClick={() => onOpenEvidence(responseEvidence)}>Open captured {responseEvidence.name}</button></dd></>}
            </dl>}
            {detailTab === "Request headers" && <HeaderList headers={activeEntry.request.requestHeaders} />}
            {detailTab === "Response headers" && <HeaderList headers={activeEntry.request.responseHeaders} />}
            {detailTab === "Response" && <ResponseBody evidence={responseEvidence} mimeType={activeEntry.request.mimeType} onOpen={() => responseEvidence && onOpenEvidence(responseEvidence)} />}
            {detailTab === "Initiator" && <div>
              {activeEntry.request.initiator ? <dl><dt>Initiator type</dt><dd>{activeEntry.request.initiator.type || "Unknown"}</dd><dt>Source</dt><dd>{activeEntry.request.initiator.url || "Not available"}</dd><dt>Position</dt><dd>{activeEntry.request.initiator.line ? `Line ${activeEntry.request.initiator.line}, column ${activeEntry.request.initiator.column || 1}` : "Not available"}</dd></dl> : <p>No supported initiator location was recorded in this capture.</p>}
              {initiatorEvidence.length > 1 && <p>Multiple imported sources match this recorded URL. Choose a candidate.</p>}{initiatorEvidence.map(f => <button key={f.id} onClick={() => onOpenEvidence(f)}>Open initiator source: {f.name}</button>)}{activeEntry.request.initiator && !initiatorEvidence.length && <p>No imported source matches the recorded URL.</p>}
            </div>}
          </div>
        </aside>}
      </div>
    </section>
  );
}

function HeaderList({ headers }: { headers?: { name: string; value: string }[] }) {
  return headers?.length ? <dl className="network-headers">{headers.map((header, index) => <div key={`${header.name}:${index}`}><dt>{header.name}</dt><dd>{header.value}</dd></div>)}</dl> : <p>No headers were retained.</p>;
}

function ResponseBody({ evidence, mimeType, onOpen }: { evidence?: Evidence; mimeType?: string; onOpen: () => void }) {
  const [view, setView] = useState<"Auto" | "Text" | "JSON" | "Hex">("Auto");
  const [loaded, setLoaded] = useState<Evidence>();
  const [error, setError] = useState("");
  useEffect(() => { let active = true; setLoaded(undefined); setError(""); if (evidence) materializeEvidence(evidence).then(file => { if (active) setLoaded(file); }).catch(cause => { if (active) setError(String(cause)); }); return () => { active = false; }; }, [evidence]);
  if (!evidence) return <p>No response body was retained for this request.</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!loaded) return <p role="status">Loading retained response...</p>;
  evidence = loaded;
  const body = decodeText(evidence.bytes);
  let json: string | undefined;
  try { json = JSON.stringify(JSON.parse(body), null, 2); } catch { /* the JSON view stays unavailable */ }
  const effectiveView = view === "Auto" ? (json ? "JSON" : "Text") : view;
  const hexLimit = Math.min(evidence.bytes.length, 4096);
  const hex = Array.from({ length: Math.ceil(hexLimit / 16) }, (_, row) => {
    const offset = row * 16;
    const bytes = evidence.bytes.subarray(offset, Math.min(offset + 16, hexLimit));
    const values = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = Array.from(bytes, (byte) => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".").join("");
    return `${offset.toString(16).padStart(8, "0")}  ${values}  ${ascii}`;
  }).join("\n");
  return <div>
    <p>{evidence.bytes.length.toLocaleString()} captured bytes · original response evidence is preserved.</p>
    <div className="network-response-views" role="group" aria-label="Response display format">
      {(["Auto", "Text", "JSON", "Hex"] as const).map((format) => <button key={format} type="button" aria-pressed={view === format} disabled={format === "JSON" && !json} title={format === "JSON" && !json ? "This response is not valid JSON." : `Show the response as ${format.toLowerCase()}.`} onClick={() => setView(format)}>{format}</button>)}
    </div>
    <pre className="network-response-body">{effectiveView === "Hex" ? `${hex}${evidence.bytes.length > hexLimit ? "\n… hex preview limited to 4 KiB" : ""}` : effectiveView === "JSON" ? json : `${body.slice(0, 32768)}${body.length > 32768 ? "\n… response preview limited to 32 KiB" : ""}`}</pre>

  </div>;
}
