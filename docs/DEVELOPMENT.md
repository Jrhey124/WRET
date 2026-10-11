# Whidra development and verification

Whidra's inspection frontend is React/TypeScript. Static Docker hosting has no backend API. Evidence, notes, results, transformations, pinned tools, and imported historical observations remain in browser IndexedDB. Imported code is never executed.

The `wret` IndexedDB name and `WRET_*` identifiers are retained for compatibility with existing Whidra installations.

## Local development

Research workflows and their bounds are documented in [the investigation capabilities](GAP-IMPLEMENTATION.md).

Use Node.js 24 and npm. On Windows PowerShell with restricted execution policy, invoke `npm.cmd` and `npx.cmd`.

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite. The `dev` command first builds the analysis tool manifest and bundle. Rerun `npm run tools:build` after changing analysis code while the development server is running.

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser suite serves `dist/` with the production Content Security Policy. Build before running it. To test installed browsers instead of downloaded Chromium:

```powershell
$env:WRET_BROWSER = 'chrome' # or 'msedge'
npm.cmd run test:e2e
```

Set `WRET_BASE_URL=http://127.0.0.1:8080` to run the same tests against an already-running Docker service instead of the test server. The test runner uses isolated browser contexts and does not alter your normal browser's projects.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/App.tsx` | Workbench, import queue, cancellation, evidence navigation, notes and decoding |
| `src/analyze.ts` | Static JS analysis, WABT disassembly, metadata, indicators and source ranges |
| `src/analysis.worker.ts` | Common tool protocol: evidence + options in; progress/result/error out |
| `src/runtime.ts` | First-party manifest checks, SHA-256 integrity, worker lifecycle and deadlines |
| `src/storage.ts` | Atomic IndexedDB writes, schema 1-5 archive migration and validation, Markdown reporting |
| `src/har.ts`, `src/capture.ts` | Offline bounded HAR import, credential redaction, normalized network request records |
| `src/NetworkView.tsx` | Searchable captured request table, timing bars, headers, initiator and response evidence |
| `src/Editor.tsx` | Read-only Monaco views with original byte-to-source position mapping |
| `src/search.worker.ts` | Bounded literal byte search across project evidence |
| `scripts/build-tools.mjs` | Reproducible analysis bundle and content-addressed manifest generation |
| `nginx.conf`, `Dockerfile`, `compose*.yaml` | Static container deployment and optional HTTPS |

## Evidence and tool contracts

- Locations are `{ fileId, start, end }`: original byte offsets, end exclusive. Text is UTF-8. Invalid UTF-8 falls back to original hex and ASCII strings rather than presenting inaccurate source ranges.
- Worker input: `{ file: { id, name, bytes, format }, options?: { maxEntries } }`. Entry limits can be lowered, but not raised beyond the release maximum. Worker messages are `{ type: 'progress', progress }`, `{ type: 'result', result }`, or `{ type: 'error', error }`.
- JS references use lexical scope analysis. Only unmodified lexical function bindings are statically resolved. Property calls, dynamic targets, and unknown bindings remain explicitly unresolved. These are syntactic/lexical relationships, not claims about all runtime behavior.
- AST inspection is a bounded indented syntax-tree index with clickable original ranges. Formatted source has no exact source map: annotation uses the original view.
- WASM function-body ranges map to original code bytes; imports/exports map to their containing section. A bounded WebAssembly 1.0 instruction reader records original byte ranges, direct calls, and partial-coverage diagnostics; proposal opcodes it cannot safely size remain unindexed. Analyst aliases are separate from original names and bytes and are keyed by module hash/function index. WABT itself uses trusted tool code; imported modules are read as data, never instantiated during static analysis.
- Source maps are inspected as JSON and their declared sources are listed. No referenced source is downloaded and mappings are not automatically applied. HTML and CSS are source/hex plus indicators and strings.
- Tool bundles are self-contained and served from `/tools/`. A pinned tool must match the current server's first-party manifest before any executable bundle is downloaded. The digest is verified before worker creation. A mismatched historical pin preserves existing results and offers an explicit update to the verified installed analyzer.
- The manifest is a same-origin trust root, not a publisher signature. Host the app and tools on infrastructure you trust.

## Resource bounds

Evidence defaults: 25 MiB/file, 100 MiB/project, 1,000 files. These are constants in `src/model.ts` and checked before evidence is added. Browser memory use can exceed evidence size during parsing/export; use smaller projects on constrained desktops.

Analysis: one worker at a time, 10-second hard termination, 15-second manifest deadline, 30-second bundle-download deadline, up to 5,000 entries per result category, ASCII strings of at least 4 bytes with a 2,048-character preview, formatting only up to 2 MiB, and a 16 MiB WAT view limit. Diagnostics describe truncation. Search returns the first 500 matches and is terminated after 10 seconds. The graph shows up to 20 files, 10 functions/findings and 100 calls per file; full entries remain in other panels.

Decode input is at most 1 MiB, with 1,000 stored transformations and 50,000 notes per project. Serialized analysis results have a 24 MiB project budget; notes plus decoding history have a separate 24 MiB budget. Updates exceeding a budget are visibly rejected without replacing existing work. These budgets leave room for all 100 MiB of evidence as Base64 inside the 200 MiB archive import limit. Export regularly; IndexedDB may be evicted even after a persistence request is denied. A quota failure leaves the current in-memory project exportable and the previous successful IndexedDB transaction intact. A failed initial restore pauses autosave so it cannot overwrite the prior project.

## Validation coverage

Unit tests cover normal/minified/obfuscated/malformed JavaScript, lexical shadowing and reassignment, Unicode/BOM/newline coordinates, static indicators, missing maps, inert HTML, binary metadata, stripped/truncated WASM and instruction offsets, schema 1–5 archive migration, aliases, network event normalization, HAR body limits and credential redaction, tampering and invalid archive ranges, atomic storage, Markdown escaping, decoding errors, worker crashes, pin mismatch, cancellation and termination.

Browser tests exercise the production bundle and CSP: import → evidence navigation → status → notes/labels → formatting → graph → decoding → search → reports → archive export/import → reload. They also cover inert HTML, WASM instruction/alias navigation, oversized inputs, tool integrity failure, cancellation, quota exhaustion, offline HAR import and linked response evidence, and a network log asserting only first-party GET requests with no sample/notes payloads.

CI additionally builds and runs the Docker image, checks health, validates nginx configuration, checks CSP headers and rejects POST. Local Docker validation requires an installed Docker engine.

## Privacy boundary

All investigations are static. HAR import and archive restoration do not contact recorded destinations.

No sample execution, uploads, sample-driven fetches, third-party analytics, CDN scripts, accounts or cloud analysis. Monaco link activation is disabled. Workers provide responsiveness and cancellation, not a sandbox for running malware. The production CSP allows first-party application scripts and trusted tool WebAssembly compilation, blob workers, and inline styles required by Monaco; it restricts previews to sandboxed local frames and prohibits object embeds. Downloads of projects/reports are user actions within the browser.

The guided workflow includes local source-map navigation, embedded map originals, inert HTML previews, bounded string folding and nested decoding, offline HAR import, saved observations, and source-linked notes.

## Lazy evidence and worker budget

Project restore loads evidence metadata and saved results first. Content chunks are read on demand using a 32 MiB LRU chunk cache; the selected editor owns its active buffer separately. Models are disposed when their views close. Sources over 2 MiB use 256 KiB pages. Export remains an explicit operation and can allocate a large archive string.

Sample-processing workers share one slot. Formatting, search, analysis, research, and preview jobs keep 10-second deadlines and disposable 256 KiB transfers. Static preview sanitization fails closed. Historical runtime observations and breakpoint records are data only.

Explicit Beautify accepts up to 5 MiB of HTML/embedded scripts/styles, JavaScript, CSS, JSON, or source-map input and up to 20 MiB output. HAR parsing, snapshot comparison, API shape inspection, and static preview reconstruction also run in the shared worker queue. Repeated asset embedding and stylesheet expansion count toward preview budgets.
