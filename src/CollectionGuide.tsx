import { useState } from "react";

export function collectionUrl(value: string): string {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Enter an HTTP or HTTPS URL without embedded credentials.");
  return url.href;
}

export function CollectionGuide({ onImportHar, onImportFiles, onImportFolder, onInvestigate, captures, busy }: {
  onImportHar: () => void; onImportFiles: () => void; onImportFolder: () => void; onInvestigate: () => void; captures: number; busy: boolean;
}) {
  const [step, setStep] = useState(0);
  const [url, setUrl] = useState("");
  const [browser, setBrowser] = useState("Chrome");
  const [message, setMessage] = useState("");
  const labels = ["Open website", "Record activity", "Import evidence", "Investigate"];
  async function useUrl(copy: boolean) {
    try {
      const target = collectionUrl(url);
      if (copy) { await navigator.clipboard.writeText(target); setMessage("URL copied."); }
      else { window.open(target, "_blank", "noopener,noreferrer"); setMessage("Website opened. Whidra cannot monitor the new tab; use its DevTools to record activity."); }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }
  return <section className="collection-guide" aria-labelledby="collection-title">
    <h1 id="collection-title">Collect website evidence</h1>
    <p>Record activity in your browser, then import it for investigation. Your Pi serves Whidra; your browser collects and analyzes evidence.</p>
    <nav aria-label="Collection progress" className="collection-steps">{labels.map((label, index) => <button key={label} aria-current={step === index ? "step" : undefined} onClick={() => setStep(index)}>{index + 1}. {label}</button>)}</nav>
    <p role="status">Step {step + 1} of 4: {labels[step]}</p>
    {step === 0 && <div><h2>Open the website in a separate tab</h2><label>Website URL (optional)<input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com" type="url" /></label><div className="workspace-toolbar"><button disabled={!url.trim()} onClick={() => void useUrl(false)}>Open website</button><button disabled={!url.trim()} onClick={() => void useUrl(true)}>Copy URL</button></div><p>Only HTTP/HTTPS URLs without embedded credentials are accepted. Opening a URL does not start automatic capture. Use a site you are authorized to investigate.</p></div>}
    {step === 1 && <div><h2>Record the interaction</h2><label>Collection browser<select value={browser} onChange={e => setBrowser(e.target.value)}><option>Chrome</option><option>Edge</option></select></label><ol><li>In the target tab, open DevTools with F12 or Ctrl+Shift+I and select Network.</li><li>Enable Preserve log and clear old requests to start a focused capture.</li><li>Reload the page, then perform the interaction you want to investigate.</li><li>Use Export HAR (sanitized) in the Network toolbar and save the file.</li></ol><a href={browser === "Chrome" ? "https://developer.chrome.com/docs/devtools/network/reference/" : "https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/network/reference"} target="_blank" rel="noopener noreferrer">Official {browser} Network instructions</a><p>HAR records network activity. It does not record JavaScript state, DOM history, or JS/Wasm bridge calls. Sanitized exports may still contain sensitive response content; review captures before sharing.</p></div>}
    {step === 2 && <div><h2>Import your capture and supporting files</h2><div className="workspace-toolbar"><button disabled={busy} onClick={onImportHar}>Import HAR capture</button><button disabled={busy} onClick={onImportFiles}>Import evidence files</button><button disabled={busy} onClick={onImportFolder}>Import site folder</button></div><p>Import saved HTML, scripts, styles, or Wasm files when response bodies are missing. Ctrl+S can save a complete page and its resource folder; import the folder to preserve relative paths. Script-generated content may be absent.</p><p>HAR limit: 25 MiB; retained body limit: 1 MiB per response. Recorded URLs are never fetched by Whidra.</p></div>}
    {step === 3 && <div><h2>Connect and annotate the evidence</h2><p>{captures} saved capture{captures === 1 ? "" : "s"} in this project.</p><ol><li>Review capture coverage and missing responses in Network.</li><li>Open a script or response, then beautify it or find related references.</li><li>Search for an endpoint, annotate supporting source, and export your investigation.</li></ol><button onClick={onInvestigate}>Review captures in Network</button></div>}
    {message && <p role="status">{message}</p>}
    <div className="workspace-toolbar"><button disabled={step === 0} onClick={() => setStep(s => s - 1)}>Previous step</button><button disabled={step === 3} onClick={() => setStep(s => s + 1)}>Next step</button></div>
    <p>Closing this guide keeps all imported evidence. Collection progress is temporary and is not included in project exports.</p>
  </section>;
}
