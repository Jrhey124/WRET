# Whidra development and verification

Whidra's inspection frontend is React/TypeScript. Static Docker hosting has no backend API. The optional local Node companion adds authenticated debugger control and a disposable QEMU guest; see [Companion setup](COMPANION.md). Project evidence, notes, results, transformations, pinned tools, and sanitized runtime records remain in browser IndexedDB. Selected evidence is copied into the local guest only when a user starts a dynamic session.

The `wret` IndexedDB name and `WRET_*` identifiers are retained for compatibility with existing Whidra installations.

## Local development

Research workflows and their bounds are documented in [the gap implementation plan](GAP-IMPLEMENTATION.md). `npm run test:guest` runs benign Chromium fixtures in a disposable Docker container with networking disabled, including snapshots, pause policy, and actual live-edit capability negotiation. This supplements the Windows/QEMU integration suite; it does not replace it.

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
| `src/storage.ts` | Atomic IndexedDB writes, schema 1/2/3 archive migration and validation, Markdown reporting |
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
- Tool bundles are self-contained and served from `/tools/`. A pinned tool must match the current server's first-party manifest before any executable bundle is downloaded. The digest is verified before worker creation. A mismatched historical pin preserves existing results and refuses reanalysis; use the matching release image or begin a new project.
- The manifest is a same-origin trust root, not a publisher signature. Host the app and tools on infrastructure you trust.

## Resource bounds

Evidence defaults: 25 MiB/file, 100 MiB/project, 1,000 files. These are constants in `src/model.ts` and checked before evidence is added. Browser memory use can exceed evidence size during parsing/export; use smaller projects on constrained desktops.

Analysis: one worker at a time, 60-second hard termination, 15-second manifest deadline, 30-second bundle-download deadline, up to 5,000 entries per result category, ASCII strings of at least 4 bytes with a 2,048-character preview, formatting only up to 2 MiB, and a 16 MiB WAT view limit. Diagnostics describe truncation. Search returns the first 500 matches and is terminated after 60 seconds. The graph shows up to 20 files, 10 functions/findings and 100 calls per file; full entries remain in other panels.

Decode input is at most 1 MiB, with 1,000 stored transformations and 50,000 notes per project. Serialized analysis results have a 24 MiB project budget; notes plus decoding history have a separate 24 MiB budget. Updates exceeding a budget are visibly rejected without replacing existing work. These budgets leave room for all 100 MiB of evidence as Base64 inside the 200 MiB archive import limit. Export regularly; IndexedDB may be evicted even after a persistence request is denied. A quota failure leaves the current in-memory project exportable and the previous successful IndexedDB transaction intact. A failed initial restore pauses autosave so it cannot overwrite the prior project.

## Validation coverage

Unit tests cover normal/minified/obfuscated/malformed JavaScript, lexical shadowing and reassignment, Unicode/BOM/newline coordinates, static indicators, missing maps, inert HTML, binary metadata, stripped/truncated WASM and instruction offsets, schema 1–5 archive migration, aliases, network event normalization, HAR body limits and credential redaction, tampering and invalid archive ranges, atomic storage, Markdown escaping, decoding errors, worker crashes, pin mismatch, cancellation and termination.

Browser tests exercise the production bundle and CSP: import → evidence navigation → status → notes/labels → formatting → graph → decoding → search → reports → archive export/import → reload. They also cover inert HTML, WASM instruction/alias navigation, oversized inputs, tool integrity failure, cancellation, quota exhaustion, offline HAR import and linked response evidence, and a network log asserting only first-party GET requests with no sample/notes payloads.

CI additionally builds and runs the Docker image, checks health, validates nginx configuration, checks CSP headers and rejects POST. Local Docker validation requires an installed Docker engine.

## Privacy boundary

The guarantees in this section apply to static inspection. Starting a companion session explicitly transfers selected files to the local guest; approved external HTTP requests can transmit sample data to those destinations. Dynamic behavior, setup, and current transport limitations are documented in [Companion setup](COMPANION.md).

No sample execution, uploads, sample-driven fetches, third-party analytics, CDN scripts, accounts or cloud analysis. Monaco link activation is disabled. Workers provide responsiveness and cancellation, not a sandbox for running malware. The production CSP allows first-party application scripts and trusted tool WebAssembly compilation, blob workers, and inline styles required by Monaco; it prohibits frames and object embeds. Downloads of projects/reports are user actions within the browser.

The guided workflow now adds local source-map navigation, embedded map originals, inert HTML resource relationships, bounded string folding and nested decoding, offline HAR import, structured network request capture, response evidence links, and a VM debugger implementation. WebAssembly additions include explicit module capture through Chromium’s Wasm script-source capability and an opt-in JavaScript/Wasm boundary wrapper. The monitor can affect timing and function identity; direct instance access, Wasm-internal calls, pointer decoding, and complete target coverage are not promised. Runtime linear-memory snapshots, CFG simplification, and collaboration relay remain future releases. Windows VM lifecycle and bridge instrumentation acceptance require the real Windows/QEMU suite; network-disabled Chromium tests alone do not establish VM isolation.

## Companion interfaces and persistence

`src/debug-types.ts` defines capabilities, selected session input, typed debugger commands, breakpoints, and ordered observations. The loopback companion serves production assets and `/api/bootstrap`, `/api/capabilities`, `/api/sessions`, `/api/command`, `/api/events`, and `/api/stream`. Bootstrap requires a same-origin browser fetch; other endpoints require a transient bearer token, and the stream requires that token as its WebSocket subprotocol. Raw CDP access is not exposed.

Schema 3 stores normalized captured requests alongside runtime sessions and breakpoints; schema 1 and 2 archives are migrated on import. Session imports/restores mark previous live sessions disconnected. Captured scripts and response resources become immutable project evidence; runtime bookmarks create JSON evidence snapshots that can receive ordinary notes. Exports remove live debugger handles and redact common credential headers and common secret URL parameters. Active records are checkpointed every three seconds, with a 50 MiB project runtime budget and visible truncation. HAR files are parsed offline, capped at 25 MiB and 20,000 entries, and retain response bodies up to 1 MiB per request.

Source-map navigation supports standard version-3 mappings and supplied `sourcesContent`, with sources limited to 2 MiB each and a 16 MiB coordinate-indexing budget. Indexed/sectioned maps are reported unsupported. HTML dependency indexing covers the first 2 MiB, 50,000 syntax nodes, and 5,000 script/link references per file. Recipes operate on input of at most 1 MiB. String folding resolves immutable local string bindings conservatively, respecting shadowing and avoiding cross-function initialization assumptions. Nested decoding stops after five layers or when output becomes non-textual; every recorded recipe retains its original input and output.
