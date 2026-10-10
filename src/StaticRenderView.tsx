import { useMemo, useState } from "react";
import type { Evidence } from "./model";
import { buildStaticPreview } from "./static-render";

export function StaticRenderView({ files, file, onInteractive }: { files: Evidence[]; file: Evidence; onInteractive: () => void }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewport, setViewport] = useState("100%");
  const result = useMemo(() => {
    try { return { ...buildStaticPreview(files, file), error: "" }; }
    catch (error) { return { document: "", diagnostics: [], omittedResources: 0, error: String(error) }; }
  }, [files, file, refreshKey]);
  return <section className="static-render" aria-label="HTML render preview">
    <div className="render-toolbar">
      <strong>Static — scripts disabled</strong>
      <label>Viewport <select aria-label="Preview viewport" value={viewport} onChange={(event) => setViewport(event.target.value)}><option value="100%">Fit</option><option value="375px">Mobile · 375px</option><option value="768px">Tablet · 768px</option><option value="1280px">Desktop · 1280px</option></select></label>
      <button onClick={() => setRefreshKey((key) => key + 1)} title="Rebuild the safe preview from current project evidence.">Refresh preview</button>
      <button onClick={onInteractive} title="Open Debug with this HTML page selected. Starting the VM remains a separate action.">Interactive preview in VM</button>
    </div>
    <p className="view-help">Scripts, forms, navigation, external requests, and active embeds are removed. Script-generated pages may be incomplete or blank.</p>
    {result.error ? <p className="alert" role="alert">Static preview unavailable: {result.error}</p> : <>
      <ul className="render-diagnostics" aria-label="Preview resource and safety summary">{result.diagnostics.map((message, index) => <li key={index}>{message}</li>)}</ul>
      <iframe key={refreshKey} title="Static HTML preview; scripts disabled" sandbox="" referrerPolicy="no-referrer" srcDoc={result.document} style={{ width: viewport, maxWidth: "100%" }} />
    </>}
  </section>;
}
