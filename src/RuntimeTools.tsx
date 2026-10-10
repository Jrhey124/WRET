import { useState } from "react";
import type { DebugCommand } from "./debug-types";
import { decodeText, type Evidence } from "./model";

export function RuntimeTools({ files, features, unsupported, active, frame, skipping, command }: {
  files: Evidence[]; features: string[]; unsupported: Record<string, string>; active: boolean; frame?: any; skipping: boolean; command: (command: DebugCommand) => Promise<any>;
}) {
  const [fileId, setFileId] = useState("");
  const [source, setSource] = useState("");
  const [reviewed, setReviewed] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const loaded = files.filter((file) => file.format === "javascript" && file.runtimeUrl);
  const file = loaded.find((file) => file.id === fileId);
  const signature = `${file?.runtimeUrl || ""}\n${source}`;
  const available = (feature: string) => active && features.includes(feature);
  const reason = (feature: string) => !active ? "Start a runtime session first." : !features.includes(feature) ? unsupported[feature] || "This guest agent does not advertise this feature." : undefined;
  async function edit(dryRun: boolean) {
    if (!file?.runtimeUrl) return;
    setPending(true); setNotice("");
    try {
      const result = await command({ action: "liveEdit", url: file.runtimeUrl, source, dryRun });
      if (!result) return;
      if (result.status !== "Ok") { setReviewed(""); setNotice(`Chromium rejected the edit: ${result.status}. Try editing a function that is not on the active call stack.`); return; }
      setNotice(dryRun ? "Dry run accepted. Review the draft, then apply it explicitly." : "Script edit applied without reloading. Applied source is captured as new evidence.");
      setReviewed(dryRun ? signature : "");
    } finally { setPending(false); }
  }
  return <section className="runtime-tools" aria-labelledby="runtime-tools-title">
    <h2 id="runtime-tools-title">Runtime state and script edits</h2>
    <p>A snapshot records heap usage and bounded shallow scope values without invoking getters. It is evidence, not a restorable VM checkpoint.</p>
    <div className="research-controls">
      <button disabled={!available("snapshot") || pending} title={reason("snapshot") || "Capture heap usage and up to 200 own properties in each selected frame scope."} onClick={async () => { setPending(true); try { const result = await command({ action: "snapshot", scopes: (frame?.scopeChain || []).filter((scope: any) => scope.object?.objectId).slice(0, 12).map((scope: any) => ({ name: String(scope.name || scope.type).slice(0, 100), objectId: scope.object.objectId })) }); if (result) setNotice("State snapshot saved as project evidence. Object references are descriptions; use scope inspection for live contents."); } finally { setPending(false); } }}>Capture state snapshot</button>
      <button disabled={!available("pausePolicy") || pending} title={reason("pausePolicy") || "Suppress all debugger pauses, including your breakpoints and exception pauses. Restore normal pauses when investigating code."} onClick={async () => { setPending(true); try { await command({ action: "pausePolicy", skip: !skipping }); } finally { setPending(false); } }}>{skipping ? "Restore normal pauses" : "Suppress all pauses"}</button>
    </div>
    {skipping && <p className="alert" role="status">Pause suppression is active. Breakpoints and exception pauses are also suppressed. Resume an already paused script to continue.</p>}
    <details>
      <summary>Review a live script edit</summary>
      {!available("liveEdit") && <p role="status">{reason("liveEdit")}</p>}
      <p>Changes run inside the guest and may alter page behavior. Chromium can reject edits to active functions, modules, or unsupported builds. This does not bypass server protections or restore lost runtime state.</p>
      <label>Captured loaded script<select aria-label="Live edit script" value={fileId} disabled={!available("liveEdit") || pending} onChange={(event) => { setFileId(event.target.value); const file = loaded.find((file) => file.id === event.target.value); setSource(file ? decodeText(file.bytes) : ""); setReviewed(""); }}><option value="">Choose a loaded generated script</option>{loaded.map((file) => <option key={file.id} value={file.id}>{file.name} — {file.runtimeUrl}</option>)}</select></label>
      <label>Draft script source<textarea aria-label="Draft live script source" value={source} disabled={!available("liveEdit") || pending} onChange={(event) => { setSource(event.target.value); setReviewed(""); }} spellCheck={false} /></label>
      <div className="research-controls"><button disabled={!available("liveEdit") || !file || pending} title={reason("liveEdit") || "Ask Chromium to validate the draft without applying it."} onClick={() => void edit(true)}>Validate live edit</button><button disabled={!available("liveEdit") || !file || pending || reviewed !== signature} title={reviewed !== signature ? "Validate this exact draft first." : "Apply the reviewed source inside the guest without reloading."} onClick={() => void edit(false)}>Apply reviewed edit</button></div>
    </details>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
