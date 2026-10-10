import { useEffect, useState } from "react";
import { decodeText, PROJECT_LIMIT, sha256, uid, type Evidence, type Item, type Location, type Project, type Transformation } from "./model";
import { observedContracts, RECIPES, snapshotDifferences, workspaceReferences, type Recipe, type TransformPreview } from "./gap-analysis";
import { runResearchJob } from "./research-runtime";

const labels: Record<Recipe, string> = { "fold-strings": "Fold constant strings", "literal-constants": "Simplify literal expressions", "static-branches": "Simplify constant branches", "remove-debugger": "Remove debugger statements" };
type Draft = { file: Evidence; hash: string; preview: TransformPreview; inputRange: { start: number; end: number } };
export function ResearchView({ project, selection, update, navigate }: {
  project: Project; selection?: Location; update: (fn: (project: Project) => Project) => void; navigate: (location: Location) => void;
}) {
  const [tab, setTab] = useState("Transforms");
  const [fileId, setFileId] = useState("");
  const [recipe, setRecipe] = useState<Recipe>("literal-constants");
  const [scope, setScope] = useState("file");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftContext, setDraftContext] = useState<{ projectId: string; recipe: Recipe }>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<ReturnType<typeof workspaceReferences>>();
  const [potential, setPotential] = useState<Item[]>([]);
  const [headerHits, setHeaderHits] = useState<{ id: string; url: string; name: string; value: string; evidenceId?: string }[]>([]);
  const [beforeId, setBeforeId] = useState("");
  const [afterId, setAfterId] = useState("");
  const [differences, setDifferences] = useState<ReturnType<typeof snapshotDifferences>>();
  const files = project.files.filter((file) => file.format === "javascript");
  const file = files.find((file) => file.id === fileId) || files.find((file) => file.id === selection?.fileId) || files[0];
  const selectionAvailable = Boolean(file && selection?.fileId === file.id && selection.end > selection.start);
  useEffect(() => {
    if (!selection || selection.end <= selection.start || selection.end - selection.start > 256) return;
    const selectedFile = project.files.find((candidate) => candidate.id === selection.fileId);
    if (!selectedFile) return;
    const text = decodeText(selectedFile.bytes.subarray(selection.start, selection.end)).trim();
    if (text && text.length <= 256 && !/[\r\n]/.test(text)) setQuery(text);
  }, [selection?.fileId, selection?.start, selection?.end, project.files]);
  function clearDraft() { setDrafts([]); setDraftContext(undefined); setMessage(""); }
  async function preview() {
    setBusy(true); setError(""); clearDraft();
    try {
      const chosen = scope === "workspace" ? files : file ? [file] : [];
      if (!chosen.length) throw new Error("Import JavaScript evidence first.");
      if (chosen.length > 50 || chosen.reduce((sum, file) => sum + file.bytes.length, 0) > 8 * 1024 * 1024) throw new Error("Preview is limited to 50 files and 8 MiB. Choose a smaller file set.");
      const results: Draft[] = [];
      for (const original of chosen) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const selected = scope === "selection" && selectionAvailable && selection ? selection : undefined;
        if (scope === "selection" && !selected) throw new Error("Select a code range in Inspect first.");
        const preview = await runResearchJob<TransformPreview>({ action: "transform", bytes: original.bytes, recipe, location: selected });
        results.push({ file: original, hash: await sha256(original.bytes), preview, inputRange: selected ? { start: selected.start, end: selected.end } : { start: 0, end: original.bytes.length } });
      }
      setDrafts(results); setDraftContext({ projectId: project.id, recipe });
      setMessage(`${results.filter((draft) => draft.preview.changes).length} files have proposed changes. Review each preview before saving derivatives.`);
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  async function buildIndex() {
    setBusy(true); setError("");
    try { setIndex(await runResearchJob<ReturnType<typeof workspaceReferences>>({ action: "index", files: project.files })); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  async function findRelated() {
    if (!query.trim() || query.length > 4096) return;
    setBusy(true); setError(""); setPotential([]); setHeaderHits([]);
    try {
      const eligible: Evidence[] = []; let budget = 0;
      for (const candidate of project.files) {
        if (candidate.bytes.length > 1024 * 1024 || budget + candidate.bytes.length > 16 * 1024 * 1024) continue;
        eligible.push(candidate); budget += candidate.bytes.length;
      }
      setPotential(await runResearchJob<Item[]>({ action: "potential", files: eligible, query }));
      const q = query.toLowerCase();
      const capturedHeaders = (project.sessions || []).flatMap((session) =>
        (session.requests || []).flatMap((request) =>
          [...(request.requestHeaders || []), ...(request.responseHeaders || [])]
            .filter((header) => `${header.name}: ${header.value}`.toLowerCase().includes(q))
            .slice(0, 20)
            .map((header) => ({ id: `${request.id}:${header.name}`, url: request.url, name: header.name, value: header.value, evidenceId: request.evidenceId })),
        ),
      );
      setHeaderHits(capturedHeaders);
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!draftContext || !drafts.length) return;
    setBusy(true); setError("");
    try {
      const derivatives: Evidence[] = [];
      const lineage: Transformation[] = [];
      for (const draft of drafts.filter((draft) => draft.preview.changes)) {
        const bytes = new TextEncoder().encode(draft.preview.source);
        const id = uid(), outputHash = await sha256(bytes), createdAt = new Date().toISOString();
        derivatives.push({ id, name: `derived/${uid()}/${draft.file.name.split("/").pop()}`, format: "javascript", bytes, hash: outputHash, derivation: { sourceId: draft.file.id, sourceHash: draft.hash, recipe: draftContext.recipe, createdAt, changes: draft.preview.changes } });
        lineage.push({ id: uid(), parentEvidenceId: draft.file.id, parentHash: draft.hash, inputRange: draft.inputRange, operation: draftContext.recipe, version: 1, parameters: { changes: draft.preview.changes }, createdAt, outputEvidenceId: id, outputHash, mapping: "unknown" });
      }
      update((current) => {
        if (current.id !== draftContext.projectId || drafts.some((draft) => !current.files.some((file) => file.id === draft.file.id && file.bytes === draft.file.bytes))) throw new Error("Source evidence changed. Generate a fresh preview.");
        if (current.files.length + derivatives.length > 1000 || current.files.reduce((sum, file) => sum + file.bytes.length, 0) + derivatives.reduce((sum, file) => sum + file.bytes.length, 0) > PROJECT_LIMIT) throw new Error("Derived files exceed the project evidence budget.");
        return { ...current, files: [...current.files, ...derivatives], transformations: [...(current.transformations || []), ...lineage] };
      });
      clearDraft(); setMessage(`Saved ${derivatives.length} derived files with original hashes and transformation history.`);
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  const contracts = tab === "API shapes" ? observedContracts(project) : [];
  return <section className="research-workspace" aria-labelledby="research-title">
    <h1 id="research-title">Investigation tools</h1>
    <p>Transform a copy of code, follow references, and describe observed API behavior.</p>
    <div className="research-tabs" role="group" aria-label="Investigation tools">
      {["Transforms", "Cross-references", "API shapes", "State snapshots"].map((name) => <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}
    </div>
    {error && <p role="alert" className="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {tab === "Transforms" && <>
      <div className="research-controls">
        <label>JavaScript evidence<select aria-label="Transform evidence" value={file?.id || ""} onChange={(event) => { setFileId(event.target.value); clearDraft(); }}>{files.map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}</select></label>
        <label>Recipe<select aria-label="Transformation recipe" value={recipe} onChange={(event) => { setRecipe(event.target.value as Recipe); clearDraft(); }}>{RECIPES.map((recipe) => <option key={recipe} value={recipe}>{labels[recipe]}</option>)}</select></label>
        <label>Scope<select aria-label="Transformation scope" value={scope} onChange={(event) => { setScope(event.target.value); clearDraft(); }}><option value="file">Selected file</option><option value="selection" disabled={!selectionAvailable}>Inspect selection</option><option value="workspace">All JavaScript files</option></select></label>
        <button disabled={busy || !files.length} onClick={() => void preview()} title={!files.length ? "Import JavaScript evidence first." : "Parse and preview changes without executing sample code."}>Preview transformations</button>
        <button disabled={busy || !drafts.some((draft) => draft.preview.changes)} onClick={() => void save()} title="Save new derivative evidence with provenance. Originals are preserved.">Save derived files</button>
      </div>
      <p className="panel-help">These conservative AST recipes do not execute samples or promise to undo arbitrary obfuscation. Removing debugger statements changes behavior; review the proposed copy before using it in a VM.</p>
      {drafts.map((draft) => <details className="research-preview" key={draft.file.id} open><summary>{draft.file.name} — {draft.preview.changes} changes</summary>{draft.preview.diagnostics.map((diagnostic) => <p key={diagnostic}>{diagnostic}</p>)}<div className="research-diff"><div><h2>Original</h2><pre>{decodeText(draft.file.bytes)}</pre></div><div><h2>Proposed derivative</h2><pre>{draft.preview.source}</pre></div></div></details>)}
      <h2>Transformation history</h2>
      {project.files.filter((file) => file.derivation).map((file) => <article className="research-record" key={file.id}><strong>{file.name}</strong><p>{file.derivation!.recipe} · {file.derivation!.changes} changes · {file.derivation!.createdAt}</p><p>Original SHA-256: <code>{file.derivation!.sourceHash}</code></p><button onClick={() => navigate({ fileId: file.id, start: 0, end: 0 })}>Inspect derivative</button>{file.derivation!.sourceId && <button onClick={() => navigate({ fileId: file.derivation!.sourceId!, start: 0, end: 0 })}>Inspect original</button>}</article>)}
      <h2>Origin and transformations</h2>
      {!project.transformations?.length && <p>No transformation lineage has been recorded yet. New AST derivatives and decompressed evidence appear here.</p>}
      {(project.transformations || []).map((step) => <article className="research-record" key={step.id}><strong>{step.operation}</strong><p>{project.files.find((candidate) => candidate.id === step.parentEvidenceId)?.name || (step.parentUnavailable ? "Parent evidence was deleted; its hash is retained." : "Source unavailable")} · bytes {step.inputRange.start}–{step.inputRange.end} · mapping: {step.mapping}</p><p>Output SHA-256: <code>{step.outputHash}</code></p><button onClick={() => navigate({ fileId: step.outputEvidenceId, start: 0, end: 0 })}>Inspect derived evidence</button>{step.parentEvidenceId && project.files.some((candidate) => candidate.id === step.parentEvidenceId) && <button onClick={() => navigate({ fileId: step.parentEvidenceId!, start: step.inputRange.start, end: step.inputRange.end })}>Inspect source range</button>}</article>)}
    </>}
    {tab === "Cross-references" && <>
      <div className="research-controls"><button disabled={busy} onClick={() => void buildIndex()}>Build reference index</button><label>Find symbol or string<input aria-label="Filter cross-references" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Selection, identifier, or literal text" /></label><button disabled={busy || !query.trim()} onClick={() => void findRelated()}>Find related</button></div>
      <p>Lexical references resolve within their scope. Supported relative ES module imports link to supplied exports. Dynamic property access stays explicitly unresolved. Rebuild after importing or transforming files.</p>
      {index?.diagnostics.map((diagnostic) => <p key={diagnostic} className="panel-help">{diagnostic}</p>)}
      <h2>AST and module references</h2>
      {index?.references.filter((reference) => reference.name.toLowerCase().includes(query.toLowerCase()) && project.files.some((file) => file.id === reference.location.fileId)).map((reference, index) => <article className="research-record" key={`${reference.location.fileId}:${reference.location.start}:${index}`}><strong>{reference.name}</strong> · {reference.access} · {reference.certainty}<p>{project.files.find((file) => file.id === reference.location.fileId)?.name} · byte {reference.location.start}</p><button onClick={() => navigate(reference.location)}>Inspect reference</button>{reference.definition && project.files.some((file) => file.id === reference.definition!.fileId) && <button onClick={() => navigate(reference.definition!)}>Go to definition</button>}</article>)}
      <h2>Potential text matches</h2><p>Literal matches may be unrelated. They do not prove the same variable or runtime value.</p>
      {potential.map((match, i) => <article className="research-record" key={`${match.location.fileId}:${match.location.start}:${i}`}><strong>{project.files.find((candidate) => candidate.id === match.location.fileId)?.name}</strong><p>Potential literal match · byte {match.location.start}</p><button onClick={() => navigate(match.location)}>Inspect match</button></article>)}
      {headerHits.map((hit) => <article className="research-record" key={hit.id}><strong>Captured network header: {hit.name}</strong><p>{hit.url}</p><code>{hit.value.slice(0, 512)}</code>{hit.evidenceId && <button onClick={() => navigate({ fileId: hit.evidenceId!, start: 0, end: 0 })}>Inspect response evidence</button>}</article>)}
      {index && !index.references.length && <p>No supported references found.</p>}
    </>}
    {tab === "API shapes" && <>
      <p>Response shapes are inferred from retained JSON bodies. Counts show observed samples; they do not establish required fields or reveal server source code. Query values and response values are omitted from this summary.</p>
      {!contracts.length && <p>Import a HAR capture or capture website requests in Debug to begin.</p>}
      {contracts.map((contract) => <details className="research-preview" key={contract.endpoint}><summary>{contract.endpoint} — {contract.samples} samples</summary><p>Status codes: {contract.statuses.join(", ") || "unavailable"}. {contract.incomplete ? "Coverage is incomplete or bounded." : "Retained response coverage available."}</p><ul>{contract.fields.map((field) => <li key={field.path}><code>{field.path}</code>: {field.types.join(" / ")} · observed in {field.samples} samples</li>)}</ul>{contract.evidenceIds.map((id) => <button key={id} onClick={() => navigate({ fileId: id, start: 0, end: 0 })}>Inspect supporting response {id.slice(0, 8)}</button>)}</details>)}
    </>}
    {tab === "State snapshots" && <>
      <p>Capture state in Debug, then compare recorded heap usage and shallow scope values. Matching uses scope names and positions; descriptions do not establish object identity. Snapshots cannot restore execution or active connections.</p>
      <div className="research-controls">{(["Before", "After"] as const).map((label) => <label key={label}>{label}<select aria-label={`${label} state snapshot`} value={label === "Before" ? beforeId : afterId} onChange={(event) => { (label === "Before" ? setBeforeId : setAfterId)(event.target.value); setDifferences(undefined); }}><option value="">Choose a snapshot</option>{project.files.filter((file) => file.captureKind === "snapshot").map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}</select></label>)}<button disabled={!beforeId || !afterId || beforeId === afterId} title="Choose two different retained state snapshots." onClick={() => { try { const before = project.files.find((file) => file.id === beforeId), after = project.files.find((file) => file.id === afterId); if (!before || !after) throw new Error("Selected snapshot evidence is no longer available."); setDifferences(snapshotDifferences(before, after)); setError(""); } catch (error) { setError(String(error)); } }}>Compare state snapshots</button></div>
      {differences && <p role="status">{differences.length} differences shown, capped at 1,000.</p>}
      {differences?.map((difference) => <article className="research-record" key={difference.path}><strong>{difference.path}</strong><p>Before: <code>{difference.before ?? "not captured"}</code></p><p>After: <code>{difference.after ?? "not captured"}</code></p></article>)}
      {[beforeId, afterId].filter((id, index, list) => id && list.indexOf(id) === index && project.files.some((file) => file.id === id)).map((id) => <button key={id} onClick={() => navigate({ fileId: id, start: 0, end: 0 })}>Inspect snapshot evidence</button>)}
    </>}
  </section>;
}
