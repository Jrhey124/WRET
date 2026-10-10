import { useMemo, useState } from "react";
import type { CapturedRequest, DebugSession } from "./debug-types";
import { decodeText, type Evidence } from "./model";

type NetworkEntry = { request: CapturedRequest; session: DebugSession };
type DetailTab = "Overview" | "Request headers" | "Response headers" | "Response" | "Initiator";

export function NetworkView({
  sessions,
  files,
  onOpenEvidence,
  onImportHar,
}: {
  sessions: DebugSession[];
  files: Evidence[];
  onOpenEvidence: (file: Evidence) => void;
  onImportHar: () => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [detailTab, setDetailTab] = useState<DetailTab>("Overview");
  const entries = useMemo<NetworkEntry[]>(
    () => sessions.flatMap((session) => (session.requests || []).map((request) => ({ request, session }))),
    [sessions],
  );
  const filtered = entries.filter(({ request, session }) => {
    const matchesQuery = `${request.url} ${request.method} ${request.resourceType || ""} ${request.mimeType || ""} ${request.status || ""} ${session.target}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const isFailed = Boolean(request.blockedReason) || request.status === undefined || request.status >= 400;
    return matchesQuery && (statusFilter === "all" || (statusFilter === "failed" ? isFailed : request.status !== undefined && Math.floor(request.status / 100) === Number(statusFilter)));
  }).sort((a, b) => a.request.startedAt.localeCompare(b.request.startedAt) || a.request.sequence - b.request.sequence);
  const activeEntry = filtered.find(({ request, session }) => `${session.id}:${request.id}` === selectedId) || filtered[0];
  const maxDuration = Math.max(1, ...filtered.map(({ request }) => request.durationMs || 0));
  const responseEvidence = activeEntry?.request.evidenceId
    ? files.find((file) => file.id === activeEntry.request.evidenceId)
    : undefined;
  const initiatorEvidence = activeEntry?.request.initiator?.url
    ? files.find((file) => file.runtimeUrl === activeEntry.request.initiator?.url || file.name === activeEntry.request.initiator?.url)
    : undefined;
  const detailTabs: DetailTab[] = ["Overview", "Request headers", "Response headers", "Response", "Initiator"];
  return (
    <section className="network-workspace" aria-labelledby="network-title">
      <header className="network-heading">
        <div>
          <div className="section-kicker">CAPTURED WEBSITE ACTIVITY</div>
          <h1 id="network-title">Network</h1>
          <p>Requests and response resources captured in local VM sessions or imported from HAR files.</p>
        </div>
        <button onClick={onImportHar} title="Import a HAR file offline. Recorded URLs are never contacted during import.">Import HAR</button>
      </header>
      <div className="network-toolbar">
        <label>Filter requests<input aria-label="Filter network requests" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="URL, method, type, status…" /></label>
        <label>Status<select aria-label="Filter requests by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="2">2xx success</option><option value="3">3xx redirect</option><option value="4">4xx client error</option><option value="5">5xx server error</option><option value="failed">Failed or blocked</option></select></label>
        <span className="network-count" aria-live="polite">{filtered.length} of {entries.length} requests</span>
      </div>
      <div className="network-grid">
        <div className="network-table-wrap">
          <table className="network-table">
            <caption className="visually-hidden">Captured network requests. Select a row to inspect its details.</caption>
            <thead><tr><th scope="col">Name / URL</th><th scope="col">Method</th><th scope="col">Status</th><th scope="col">Type</th><th scope="col">Size</th><th scope="col">Time</th><th scope="col">Waterfall</th></tr></thead>
            <tbody>
              {filtered.map(({ request, session }) => (
                <tr key={`${session.id}:${request.id}`} className={activeEntry?.session.id === session.id && activeEntry.request.id === request.id ? "selected" : ""}>
                  <td><button className="network-row-select" aria-pressed={activeEntry?.session.id === session.id && activeEntry.request.id === request.id} onClick={() => { setSelectedId(`${session.id}:${request.id}`); setDetailTab("Overview"); }} title={`${request.method} ${request.url}`}>{request.url || "(URL unavailable)"}<small>{session.target}</small></button></td>
                  <td>{request.method}</td>
                  <td><span className={`network-status ${request.blockedReason ? "failed" : ""}`}>{request.blockedReason ? "Blocked" : request.status ?? "Pending"}</span></td>
                  <td>{request.resourceType || request.mimeType || "Other"}</td>
                  <td>{request.transferBytes === undefined ? "—" : request.transferBytes < 1024 ? `${request.transferBytes} B` : `${(request.transferBytes / 1024).toFixed(1)} KiB`}{request.truncated ? <span title="Response body was truncated"> · partial</span> : null}</td>
                  <td>{request.durationMs === undefined ? "—" : `${request.durationMs} ms`}</td>
                  <td><span className="network-waterfall-track" aria-label={request.durationMs === undefined ? "Timing unavailable" : `${request.durationMs} milliseconds`}><span style={{ width: `${Math.max(3, ((request.durationMs || 0) / maxDuration) * 100)}%` }} /></span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!entries.length && <div className="network-empty"><h2>No captured requests</h2><p>Start a URL investigation in Debug, or import a HAR capture for offline review.</p><button onClick={onImportHar}>Import HAR</button></div>}
          {!!entries.length && !filtered.length && <p className="network-empty-small">No requests match these filters.</p>}
        </div>
        {activeEntry && <aside className="network-details" aria-label="Selected request details">
          <h2 title={activeEntry.request.url}>{activeEntry.request.url}</h2>
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
              {activeEntry.request.truncated && <><dt>Response body</dt><dd>Capture is partial or exceeded the per-response body limit.</dd></>}
              {responseEvidence && <><dt>Response resource</dt><dd><button onClick={() => onOpenEvidence(responseEvidence)}>Open captured {responseEvidence.name}</button></dd></>}
            </dl>}
            {detailTab === "Request headers" && <HeaderList headers={activeEntry.request.requestHeaders} />}
            {detailTab === "Response headers" && <HeaderList headers={activeEntry.request.responseHeaders} />}
            {detailTab === "Response" && <ResponseBody evidence={responseEvidence} mimeType={activeEntry.request.mimeType} onOpen={() => responseEvidence && onOpenEvidence(responseEvidence)} />}
            {detailTab === "Initiator" && <div>
              {activeEntry.request.initiator ? <dl><dt>Initiator type</dt><dd>{activeEntry.request.initiator.type || "Unknown"}</dd><dt>Source</dt><dd>{activeEntry.request.initiator.url || "Not available"}</dd><dt>Position</dt><dd>{activeEntry.request.initiator.line ? `Line ${activeEntry.request.initiator.line}, column ${activeEntry.request.initiator.column || 1}` : "Not available"}</dd></dl> : <p>Chromium did not provide an initiator location for this request.</p>}
              {initiatorEvidence && <button onClick={() => onOpenEvidence(initiatorEvidence)}>Open initiator source</button>}
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
  if (!evidence) return <p>No response body was retained for this request.</p>;
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
    <button onClick={onOpen}>Open response evidence</button>
  </div>;
}
