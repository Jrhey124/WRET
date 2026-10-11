# Collect website evidence

1. Open the collection guide from Welcome, Overview, Network, or the command palette.
2. Optionally enter an HTTP/HTTPS URL and open it in a separate tab. Whidra cannot monitor that tab.
3. Open Chrome or Edge DevTools (F12 or Ctrl+Shift+I), choose Network, enable Preserve log, and clear old requests. Reload and perform the relevant interaction.
4. Export HAR (sanitized) from the Network toolbar. Import it through the guide or Network.
5. Save missing HTML or source resources separately. Import files or the complete saved-page folder. Script-generated content may be absent.
6. Review coverage, open response evidence, beautify supported text, search related references, annotate original evidence, and export the project.

Official references: [Chrome](https://developer.chrome.com/docs/devtools/network/reference/) and [Edge](https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/network/reference).

HAR does not contain JavaScript runtime state, DOM history, or JS/Wasm bridge calls. Some response bodies are unavailable. The importer retains up to 1 MiB per body and records absent, invalid, truncated, and budget-omitted responses. Coverage reflects the original import; deleting evidence changes the request body availability to deleted. Legacy captures show coverage as Not recorded.

Imports run offline in the shared worker queue with a ten-second worker deadline. Cancellation discards the staged import. Resource hashes deduplicate bytes while requests retain individual URLs. Explicit analyst associations are distinct from recorded source links.

Limits: 25 MiB HAR input, 20,000 requests, 50 MiB per capture, 100 MiB project evidence, and existing metadata budgets. Sanitized export and common-header/URL redaction cannot guarantee removal of secrets inside response bodies.

Automatic capture and a VM companion are deferred. Normal Pi hosting requires only static assets; analysis uses the client browser.
