import { materializeEvidence } from "./storage";
import { evidenceSize } from "./model";
import { useEffect, useState } from "react";
import type { Evidence } from "./model";
import type { StaticPreviewResult } from "./static-render";
import { runResearchJob } from "./research-runtime";

export function StaticRenderView({ files, file }: { files: Evidence[]; file: Evidence }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewport, setViewport] = useState("100%");
  const [result, setResult] = useState<(StaticPreviewResult & { error: string })>();
  const [pending, setPending] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined); setPending(true);
    const load = async () => {
      if (evidenceSize(file) > 5 * 1024 * 1024) throw new Error("HTML exceeds the 5 MiB preview source limit.");
      const selected: Evidence[] = [await materializeEvidence(file)]; let budget = evidenceSize(file);
      for (const resource of files) {
        if (resource.id === file.id) continue;
        if (!/\.(css|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)$/i.test(resource.name)) continue;
        if (selected.length >= 100 || budget + evidenceSize(resource) > 20 * 1024 * 1024) continue;
        selected.push(await materializeEvidence(resource)); budget += evidenceSize(resource);
      }
      controller.signal.throwIfAborted();
      return runResearchJob<StaticPreviewResult>({ action: "preview", files: selected, fileId: file.id }, controller.signal);
    };
    load()
      .then(result => { if (!controller.signal.aborted) setResult({ ...result, error: "" }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ document: "", diagnostics: [], omittedResources: 0, resourceIds: [], error: String(error) }); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [files, file, refreshKey]);
  return <section className="static-render" aria-label="HTML render preview">
    <div className="render-toolbar">
      <strong>Static — scripts disabled</strong>
      <label>Viewport <select aria-label="Preview viewport" value={viewport} onChange={(event) => setViewport(event.target.value)}><option value="100%">Fit</option><option value="375px">Mobile · 375px</option><option value="768px">Tablet · 768px</option><option value="1280px">Desktop · 1280px</option></select></label>
      <button onClick={() => setRefreshKey((key) => key + 1)} title="Rebuild the safe preview from current project evidence.">Refresh preview</button>
    </div>
    <p className="view-help">Scripts, forms, navigation, external requests, and active embeds are removed. Script-generated pages may be incomplete or blank.</p>
    {pending && <p role="status">Building static preview…</p>}
    {result?.error ? <p className="alert" role="alert">Static preview unavailable: {result.error}</p> : result && !pending ? <>
      <ul className="render-diagnostics" aria-label="Preview resource and safety summary">{result.diagnostics.map((message, index) => <li key={index}>{message}</li>)}</ul>
      <iframe key={refreshKey} title="Static HTML preview; scripts disabled" sandbox="" referrerPolicy="no-referrer" srcDoc={result.document} style={{ width: viewport, maxWidth: "100%" }} />
    </> : null}
  </section>;
}
