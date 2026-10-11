import { readEvidenceRange } from "./storage";
import { materializeEvidence } from "./storage";
import { evidenceSize } from "./model";
import { useEffect, useRef, useState } from "react";
import { decodeText, PROJECT_LIMIT, sha256, uid, type Evidence, type Item, type Location, type Project, type Transformation } from "./model";
import { observedContracts, RECIPES, snapshotDifferences, workspaceReferences, type DeobfuscationRecipe, type Recipe, type TransformPreview } from "./gap-analysis";
import { runResearchJob } from "./research-runtime";

const labels: Record<Recipe, string> = { "fold-strings": "Fold constant strings", "literal-constants": "Simplify literal expressions", "static-branches": "Simplify constant branches", "remove-debugger": "Remove debugger statements", "const-string-arrays": "Resolve immutable string-array lookups", "normalize-properties": "Normalize constant property names" };
type Draft = { file: Evidence; hash: string; preview: TransformPreview; inputRange: { start: number; end: number } };
export function ResearchView({ project, selection, update, navigate, initialTab, initialFileId }: {
  initialTab?: string; initialFileId?: string; project: Project; selection?: Location; update: (fn: (project: Project) => Project) => void; navigate: (location: Location) => void;
}) {
  const [tab, setTab] = useState(initialTab || "Transforms");
  const [fileId, setFileId] = useState(initialFileId || "");
  const [recipe, setRecipe] = useState<Recipe>("literal-constants");
  const [scope, setScope] = useState("file");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftContext, setDraftContext] = useState<{ projectId: string; recipe: Recipe | DeobfuscationRecipe }>();
  const [deobRecipe, setDeobRecipe] = useState<DeobfuscationRecipe>("conservative-cleanup");
  const [removeDebugger, setRemoveDebugger] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const job = useRef(new AbortController());
  const beginJob = () => { job.current.abort(); job.current = new AbortController(); };
  useEffect(() => () => job.current.abort(), []);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<ReturnType<typeof workspaceReferences>>();
  const [potential, setPotential] = useState<Item[]>([]);
  const [headerHits, setHeaderHits] = useState<{ id: string; url: string; name: string; value: string; evidenceId?: string }[]>([]);
  const [beforeId, setBeforeId] = useState("");
  const [afterId, setAfterId] = useState("");
  const [differences, setDifferences] = useState<ReturnType<typeof snapshotDifferences>>();
  const files = project.files.filter((file) => file.format === "javascript");
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  useEffect(() => { if (initialFileId) setFileId(initialFileId); }, [initialFileId]);
  const file = files.find((file) => file.id === fileId) || files.find((file) => file.id === selection?.fileId) || files[0];
  const selectionAvailable = Boolean(file && selection?.fileId === file.id && selection.end > selection.start);
  useEffect(() => {
    if (!selection || selection.end <= selection.start || selection.end - selection.start > 256) return;
    const selectedFile = project.files.find((candidate) => candidate.id === selection.fileId);
    if (!selectedFile) return;
    let active = true;
    const read = selectedFile.bytes.length === evidenceSize(selectedFile) ? Promise.resolve(selectedFile.bytes.slice(selection.start, selection.end)) : readEvidenceRange(selectedFile.id, selection.start, selection.end);
    void read.then(bytes => { const text = decodeText(bytes).trim(); if (active && text && text.length <= 256 && !/[\r\n]/.test(text)) setQuery(text); }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [selection?.fileId, selection?.start, selection?.end, project.files]);
  function clearDraft() { setDrafts([]); setDraftContext(undefined); setMessage(""); }
  async function preview() {
    beginJob(); setBusy(true); setError(""); clearDraft();
    try {
      const chosen = scope === "workspace" ? files : file ? [file] : [];
      if (!chosen.length) throw new Error("Import JavaScript evidence first.");
      if (chosen.length > 50 || chosen.reduce((sum, file) => sum + evidenceSize(file), 0) > 8 * 1024 * 1024) throw new Error("Preview is limited to 50 files and 8 MiB. Choose a smaller file set.");
      const results: Draft[] = [];
      for (const metadata of chosen) {
        const original = await materializeEvidence(metadata);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const selected = scope === "selection" && selectionAvailable && selection ? selection : undefined;
        if (scope === "selection" && !selected) throw new Error("Select a code range in Inspect first.");
        const preview = await runResearchJob<TransformPreview>({ action: "transform", bytes: original.bytes, recipe, location: selected }, job.current.signal);
        results.push({ file: original, hash: await sha256(original.bytes), preview, inputRange: selected ? { start: selected.start, end: selected.end } : { start: 0, end: original.bytes.length } });
      }
      setDrafts(results); setDraftContext({ projectId: project.id, recipe });
      setMessage(`${results.filter((draft) => draft.preview.changes).length} files have proposed changes. Review each preview before saving derivatives.`);
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  async function previewDeobfuscation() {
    beginJob(); setBusy(true); setError(""); clearDraft();
    try {
      const chosen = scope === "workspace" ? files : file ? [file] : [];
      if (!chosen.length) throw new Error("Import JavaScript evidence first.");
      if (chosen.length > 50 || chosen.reduce((sum, candidate) => sum + evidenceSize(candidate), 0) > 8 * 1024 * 1024) throw new Error("Deobfuscation is limited to 50 files and 8 MiB of source. Choose a smaller set.");
      if (chosen.some(candidate => evidenceSize(candidate) > 1024 * 1024)) throw new Error("Each deobfuscation input is limited to 1 MiB. Choose a smaller file set.");
      const results: Draft[] = [];
      let stagedOutputBytes = 0;
      for (const metadata of chosen) {
        const original = await materializeEvidence(metadata);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const result = await runResearchJob<TransformPreview>({ action: "deobfuscate", bytes: original.bytes, recipe: deobRecipe, removeDebugger }, job.current.signal);
        const changedSteps = result.steps?.filter(step => step.changes) || [];
        if (changedSteps.length) stagedOutputBytes += changedSteps.reduce((sum, step) => sum + new TextEncoder().encode(step.source).length, 0);
        else if (result.changes) stagedOutputBytes += new TextEncoder().encode(result.source).length;
        if (stagedOutputBytes > 8 * 1024 * 1024) throw new Error("The cumulative preview and lineage steps exceed the 8 MiB workspace output limit.");
        results.push({ file: original, hash: await sha256(original.bytes), preview: result, inputRange: { start: 0, end: original.bytes.length } });
      }
      setDrafts(results); setDraftContext({ projectId: project.id, recipe: deobRecipe });
      setMessage(`${results.filter((result) => result.preview.changes).length} files contain proposed JavaScript cleanup. Review outputs before saving.`);
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  async function buildIndex() {
    beginJob(); setBusy(true); setError("");
    try {
      const files: Evidence[] = []; let bytes = 0; const skipped: string[] = [];
      for (const file of project.files) {
        if (evidenceSize(file) > 1024 * 1024 || bytes + evidenceSize(file) > 16 * 1024 * 1024) { skipped.push(file.name); continue; }
        files.push(await materializeEvidence(file)); bytes += evidenceSize(file);
      }
      const result = await runResearchJob<ReturnType<typeof workspaceReferences>>({ action: "index", files }, job.current.signal);
      setIndex({ ...result, diagnostics: [...result.diagnostics, ...skipped.map(name => "Skipped " + name + ": reference budget reached")] });
    }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  async function findRelated() {
    if (!query.trim() || query.length > 4096) return;
    beginJob(); setBusy(true); setError(""); setPotential([]); setHeaderHits([]);
    try {
      const eligible: Evidence[] = []; let budget = 0;
      for (const candidate of project.files) {
        if (evidenceSize(candidate) > 1024 * 1024 || budget + evidenceSize(candidate) > 16 * 1024 * 1024) continue;
        eligible.push(await materializeEvidence(candidate)); budget += evidenceSize(candidate);
      }
      setPotential(await runResearchJob<Item[]>({ action: "potential", files: eligible, query }, job.current.signal));
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
        const steps = draft.preview.steps?.filter(step => step.changes) || [{ recipe: draftContext.recipe, source: draft.preview.source, changes: draft.preview.changes, diagnostics: draft.preview.diagnostics }];
        let parentId = draft.file.id, parentHash = draft.hash, parentSize = draft.file.bytes.length;
        for (let index = 0; index < steps.length; index++) {
          const step = steps[index];
          const bytes = new TextEncoder().encode(step.source);
          if (bytes.length > 2 * 1024 * 1024) throw new Error("A derived step exceeds the 2 MiB output limit.");
          const id = uid(), outputHash = await sha256(bytes), createdAt = new Date().toISOString();
          const name = `derived/${uid()}/${draft.file.name.split("/").pop()}${steps.length > 1 ? `.step-${index + 1}` : ""}`;
          derivatives.push({ id, name, format: "javascript", bytes, hash: outputHash, derivation: { sourceId: parentId, sourceHash: parentHash, recipe: step.recipe, createdAt, changes: step.changes } });
          lineage.push({ id: uid(), parentEvidenceId: parentId, parentHash, inputRange: { start: 0, end: parentSize }, operation: step.recipe, version: 1, parameters: { changes: step.changes, pass: "pass" in step && step.pass ? step.pass : 1, preset: "preset" in step && step.preset ? step.preset : String(draftContext.recipe) }, createdAt, outputEvidenceId: id, outputHash, mapping: "unknown" });
          parentId = id; parentHash = outputHash; parentSize = bytes.length;
        }
      }
      update((current) => {
        if (current.id !== draftContext.projectId || drafts.some((draft) => !current.files.some((source) => source.id === draft.file.id && evidenceSize(source) === draft.file.bytes.length && (source.hash || source.result?.hash) === draft.hash))) throw new Error("Source evidence changed. Generate a fresh preview.");
        if (current.files.length + derivatives.length > 1000 || current.files.reduce((sum, file) => sum + evidenceSize(file), 0) + derivatives.reduce((sum, file) => sum + evidenceSize(file), 0) > PROJECT_LIMIT) throw new Error("Derived files exceed the project evidence budget.");
        return { ...current, files: [...current.files, ...derivatives], transformations: [...(current.transformations || []), ...lineage] };
      });
      clearDraft(); setMessage(`Saved ${derivatives.length} derived files with original hashes and transformation history.`);
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  const [contracts, setContracts] = useState<ReturnType<typeof observedContracts>>([]);
  useEffect(() => {
    if (tab !== "API shapes") return;
    let active = true; const controller = new AbortController();
    const load = async () => {
      const files: Evidence[] = []; let budget = 0;
      for (const file of project.files) {
        if (evidenceSize(file) > 1024 * 1024 || budget + evidenceSize(file) > 16 * 1024 * 1024) continue;
        files.push(await materializeEvidence(file)); budget += evidenceSize(file);
      }
      let remaining = 5000;
      const sessions = (project.sessions || []).map(session => { const requests = (session.requests || []).slice(0, remaining); remaining -= requests.length; return { ...session, observations: [], requests }; });
      const result = await runResearchJob<ReturnType<typeof observedContracts>>({ action: "contracts", files, sessions }, controller.signal);
      if (active) setContracts(result);
    };
    void load().catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; controller.abort(); };
  }, [tab, project.files]);
  return <section className="research-workspace" aria-labelledby="research-title">
    <h1 id="research-title">Investigation tools</h1>
    <p>Transform a copy of code, follow references, and describe observed API behavior.</p>
    <div className="research-tabs" role="group" aria-label="Investigation tools">
      {["Transforms", "Deobfuscate", "Cross-references", "API shapes", "State snapshots"].map((name) => <button key={name} aria-pressed={tab === name} onClick={() => { setTab(name); clearDraft(); }}>{name}</button>)}
    </div>
    {busy && <button onClick={() => job.current.abort()}>Cancel operation</button>}
    {error && <p role="alert" className="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {tab === "Transforms" && <>
      <div className="research-controls">
        <label>JavaScript evidence<select aria-label="Transform evidence" value={file?.id || ""} onChange={(event) => { setFileId(event.target.value); clearDraft(); }}>{files.map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}</select></label>
        <label>Recipe<select aria-label="Transformation recipe" value={recipe} onChange={(event) => { setRecipe(event.target.value as Recipe); clearDraft(); }}>{RECIPES.map((recipe) => <option key={recipe} value={recipe}>{labels[recipe]}</option>)}</select></label>
        <label>Scope<select aria-label="Transformation scope" value={scope} onChange={(event) => { setScope(event.target.value); clearDraft(); }}><option value="file">Selected file</option><option value="selection" disabled={!selectionAvailable}>Inspect selection</option><option value="workspace">All JavaScript files</option></select></label>
        <button disabled={busy || !files.length} onClick={() => void preview()} title={!files.length ? "Import JavaScript evidence first." : "Parse and preview changes without executing sample code."}>Preview transformations</button>
        <button disabled={busy || !drafts.some((draft) => draft.preview.changes)} onClick={() => void save()} title="Save new derivative evidence with provenance. Originals are preserved.">Save derived evidence</button>
      </div>
      <p className="panel-help">These conservative AST recipes do not execute samples or promise to undo arbitrary obfuscation. Removing debugger statements changes behavior; review the proposed copy before saving derived evidence.</p>
      {drafts.map((draft) => <details className="research-preview" key={draft.file.id} open><summary>{draft.file.name} — {draft.preview.changes} changes</summary>{draft.preview.diagnostics.map((diagnostic) => <p key={diagnostic}>{diagnostic}</p>)}<div className="research-diff"><div><h2>Original</h2><pre>{decodeText(draft.file.bytes)}</pre></div><div><h2>Proposed derivative</h2><pre>{draft.preview.source}</pre></div></div></details>)}
      <h2>Transformation history</h2>
      {project.files.filter((file) => file.derivation).map((file) => <article className="research-record" key={file.id}><strong>{file.name}</strong><p>{file.derivation!.recipe} · {file.derivation!.changes} changes · {file.derivation!.createdAt}</p><p>Original SHA-256: <code>{file.derivation!.sourceHash}</code></p><button onClick={() => navigate({ fileId: file.id, start: 0, end: 0 })}>Inspect derivative</button>{file.derivation!.sourceId && <button onClick={() => navigate({ fileId: file.derivation!.sourceId!, start: 0, end: 0 })}>Inspect original</button>}</article>)}
      <h2>Origin and transformations</h2>
      {!project.transformations?.length && <p>No transformation lineage has been recorded yet. New AST derivatives and decompressed evidence appear here.</p>}
      {(project.transformations || []).map((step) => <article className="research-record" key={step.id}><strong>{step.operation}</strong><p>{project.files.find((candidate) => candidate.id === step.parentEvidenceId)?.name || (step.parentUnavailable ? "Parent evidence was deleted; its hash is retained." : "Source unavailable")} · bytes {step.inputRange.start}–{step.inputRange.end} · mapping: {step.mapping}</p><p>Output SHA-256: <code>{step.outputHash}</code></p><button onClick={() => navigate({ fileId: step.outputEvidenceId, start: 0, end: 0 })}>Inspect derived evidence</button>{step.parentEvidenceId && project.files.some((candidate) => candidate.id === step.parentEvidenceId) && <button onClick={() => navigate({ fileId: step.parentEvidenceId!, start: step.inputRange.start, end: step.inputRange.end })}>Inspect source range</button>}</article>)}
    </>}
    {tab === "Deobfuscate" && <>
      <p className="panel-help">Whidra applies bounded syntax based cleanup and never runs the imported code. This can simplify supported patterns; it does not recover arbitrary decoders or flattened control flow.</p>
      <div className="research-controls">
        <label>JavaScript evidence<select aria-label="Deobfuscation evidence" value={file?.id || ""} onChange={(event) => { setFileId(event.target.value); clearDraft(); }}>{files.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
        <label>Cleanup recipe<select aria-label="Deobfuscation recipe" value={deobRecipe} onChange={(event) => { setDeobRecipe(event.target.value as DeobfuscationRecipe); clearDraft(); }}><option value="conservative-cleanup">Conservative cleanup</option>{RECIPES.map((item) => <option key={item} value={item}>{labels[item]}</option>)}</select></label>
        <label>Scope<select aria-label="Deobfuscation scope" value={scope === "workspace" ? "workspace" : "file"} onChange={(event) => { setScope(event.target.value); clearDraft(); }}><option value="file">Selected file</option><option value="workspace">All JavaScript files</option></select></label>
        {deobRecipe === "conservative-cleanup" && <label className="research-checkbox"><input type="checkbox" checked={removeDebugger} onChange={(event) => { setRemoveDebugger(event.target.checked); clearDraft(); }} />Also remove debugger statements <span>(changes debugging behavior)</span></label>}
        <button disabled={busy || !files.length || (scope !== "workspace" && !file)} onClick={() => void previewDeobfuscation()} title="Run bounded syntax transforms in the analysis worker; imported code is not executed.">Preview deobfuscation</button>
        <button disabled={busy || !drafts.some((draft) => draft.preview.changes)} onClick={() => void save()} title="Add the reviewed output as derived evidence with one lineage record per changed step.">Save derived evidence</button>
      </div>
      <p className="panel-help">Limits: 1 MiB per input, at most 50 files and 8 MiB per workspace, 5,000 edits per recipe, 2 MiB per recipe output, three cleanup passes, and the shared 10-second worker deadline. Debugger removal is off by default.</p>
      {drafts.map((draft) => <details className="research-preview" key={draft.file.id} open>
        <summary>{draft.file.name} — {draft.preview.changes} proposed changes</summary>
        {draft.preview.steps?.map((step, index) => <p key={`${step.recipe}:${index}`}><strong>{labels[step.recipe]}</strong>: {step.changes} changes{step.diagnostics.length ? ` · ${step.diagnostics.join(" ")}` : ""}</p>)}
        {!draft.preview.changes && <p>No supported changes found. Unsupported or uncertain patterns are left in place.</p>}
        <div className="workspace-toolbar"><button disabled={!draft.preview.changes} onClick={async () => { try { await navigator.clipboard.writeText(draft.preview.source); setMessage("Preview copied to clipboard."); } catch { setError("Could not copy the preview. Select its text and copy it manually."); } }}>Copy preview</button><button disabled={!draft.preview.changes} onClick={() => { const href = URL.createObjectURL(new Blob([draft.preview.source], { type: "text/javascript;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = href; anchor.download = `${draft.file.name.split("/").pop() || "evidence"}.deobfuscated.js`; anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 0); }}>Download preview</button></div>
        <div className="research-diff"><div><h2>Original</h2><pre>{decodeText(draft.file.bytes)}</pre></div><div><h2>Proposed derivative</h2><pre>{draft.preview.source}</pre></div></div>
      </details>)}
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
      {!contracts.length && <p>Import a HAR capture or saved observations to begin.</p>}
      {contracts.map((contract) => <details className="research-preview" key={contract.endpoint}><summary>{contract.endpoint} — {contract.samples} samples</summary><p>Status codes: {contract.statuses.join(", ") || "unavailable"}. {contract.incomplete ? "Coverage is incomplete or bounded." : "Retained response coverage available."}</p><ul>{contract.fields.map((field) => <li key={field.path}><code>{field.path}</code>: {field.types.join(" / ")} · observed in {field.samples} samples</li>)}</ul>{contract.evidenceIds.map((id) => <button key={id} onClick={() => navigate({ fileId: id, start: 0, end: 0 })}>Inspect supporting response {id.slice(0, 8)}</button>)}</details>)}
    </>}
    {tab === "State snapshots" && <>
      <p>Compare imported snapshots of recorded heap usage and shallow scope values. Matching uses scope names and positions; descriptions do not establish object identity. Snapshots cannot restore execution or active connections.</p>
      <div className="research-controls">{(["Before", "After"] as const).map((label) => <label key={label}>{label}<select aria-label={`${label} state snapshot`} value={label === "Before" ? beforeId : afterId} onChange={(event) => { (label === "Before" ? setBeforeId : setAfterId)(event.target.value); setDifferences(undefined); }}><option value="">Choose a snapshot</option>{project.files.filter((file) => file.captureKind === "snapshot").map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}</select></label>)}<button disabled={!beforeId || !afterId || beforeId === afterId} title="Choose two different retained state snapshots." onClick={async () => { try { const before = project.files.find((file) => file.id === beforeId), after = project.files.find((file) => file.id === afterId); if (!before || !after) throw new Error("Selected snapshot evidence is no longer available."); setDifferences(await runResearchJob<ReturnType<typeof snapshotDifferences>>({ action: "snapshots", files: [await materializeEvidence(before), await materializeEvidence(after)] })); setError(""); } catch (error) { setError(String(error)); } }}>Compare state snapshots</button></div>
      {differences && <p role="status">{differences.length} differences shown, capped at 1,000.</p>}
      {differences?.map((difference) => <article className="research-record" key={difference.path}><strong>{difference.path}</strong><p>Before: <code>{difference.before ?? "not captured"}</code></p><p>After: <code>{difference.after ?? "not captured"}</code></p></article>)}
      {[beforeId, afterId].filter((id, index, list) => id && list.indexOf(id) === index && project.files.some((file) => file.id === id)).map((id) => <button key={id} onClick={() => navigate({ fileId: id, start: 0, end: 0 })}>Inspect snapshot evidence</button>)}
    </>}
  </section>;
}
