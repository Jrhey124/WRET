# MVP validation record

## Guided workbench and companion update — 2026-10-10

- Production frontend build and companion TypeScript checks passed.
- **41 unit/API tests passed**, including archive migration, local/embedded source maps, recipes, authentication/origin enforcement, DNS pinning, redirect approval boundaries, and response limits.
- **12 browser tests passed in both Edge and Chrome**, covering the guided workspace, inert dependency parsing, static investigation, runtime observation ordering/replay, annotations, credential/handle sanitization, export, and reload recovery. Overview and Inspect screenshots were visually inspected.
- A real Chromium guest protocol test passed in a network-disabled Linux container using only benign fixtures: breakpoints before execution, stepping, variable scopes, evaluation, workers, frames, captured scripts, browser preview, HTTP blocking, and WebSocket attempts.
- **Windows QEMU acceptance is not complete.** The real VM test was run and failed at prerequisite checks because QEMU/qemu-img and the prepared guest image/checksum are absent. WHPX initialization, real guest boot, isolation, orphan cleanup, and disposable-disk lifecycle must be verified on a configured Windows host before a debugger release is declared complete.
- The container protocol test uses a test-only stdio transport and disables Chromium's sandbox inside that test container. Production VM launches use virtio serial, no network adapter, an unprivileged guest service, and the Chromium sandbox. The container result does not establish VM containment.

Follow [Companion setup](COMPANION.md) and run `npm.cmd run test:vm` after provisioning. The earlier static-MVP record below is retained as historical evidence.

Verified on 2026-10-05 against the implemented README MVP. Future-roadmap items remain explicitly deferred.

| Requirement | Implementation and verification |
| --- | --- |
| Four-pane project workspace; local multi-file import | React workbench; browser workflow tests and rendered screenshots inspected |
| JavaScript, HTML, CSS, JSON, source maps, WASM and opaque files | Format detection, source/hex viewers, SHA-256 and ASCII strings; unit and browser fixtures |
| JS formatting, syntax-tree inspection, outlines, references and calls | Acorn, eslint-scope, Prettier; normal/minified/obfuscated/malformed code, lexical shadowing, reassignment and unresolved calls tested |
| WASM sections, imports, exports, functions and navigable WAT | WABT worker; stripped-name and truncated fixtures; browser WAT-to-original-hex navigation |
| Search, indicators and relationship graph | Project-wide byte search, URL/host/domain/API patterns, clickable graph nodes; browser workflow and binary search tests |
| Comments, bookmarks, labels and finding status | Evidence-linked annotation records; label/status navigation, persistence and archive round trips |
| Reversible decoding without execution | Base64/hex/URL unit tests; input/output history, restore-input control and browser decoding workflow |
| Portable archive and Markdown report | Hash-validated Base64 evidence archive; results, statuses, notes, transformations and exact pins round-trip; report hashes/ranges verified |
| Original evidence coordinates | UTF-8 byte ranges, end exclusive; Unicode/BOM/mixed-newline and binary offset tests, including keyboard selection in Monaco |
| Versioned, first-party analysis tools | Content-addressed self-contained worker and manifest; version/integrity matching; tampering and unavailable-pin tests |
| Worker progress, cancellation and resource limits | Sequential queue, hard termination and download deadlines; stalled/crashed/cancelled worker unit tests and browser cancellation |
| IndexedDB persistence and quota handling | Atomic saves, persistence request, exportable in-memory state on quota failure; failed restore cannot overwrite prior data |
| No sample execution, uploads or automatic URL fetching | Inert HTML test, WABT disassembly under production CSP, network log permits only first-party GET requests with no payloads |
| 25 MiB/file and 100 MiB/project | Browser tests reject oversized files and batches before adding evidence; output/annotation budgets preserve archive portability |
| Current desktop Chrome and Edge | All 10 browser tests passed in each installed browser |
| Docker-ready static deployment | Actual multi-stage image built with `npm ci`; Compose service healthy; `nginx -t` passed; non-root UID 101, read-only filesystem, GET health check and HTTP 405 for POST verified |
| Production runtime behavior | All 10 browser tests passed against actual nginx at `http://127.0.0.1:8080`, including CSP and privacy checks |
| HTTPS deployment configuration | Optional Caddy Compose overlay validates with a domain setting; public certificate issuance requires the operator's real hostname and DNS |

`npm test`: **21 passed**. TypeScript checks and production builds passed on Windows and inside the Linux container. `npm audit`: **0 vulnerabilities** after overriding Monaco's transitive DOMPurify dependency to patched version 3.4.16. This is a dependency advisory check, not a claim that the application has no possible security defects.

The analysis tool digest was identical in Windows and Linux builds: `c7d44f1072f6eafbd1f7…`. Browser tests used isolated contexts and did not change normal-browser projects. The local Docker service is left running at `http://localhost:8080`.

See [Development](DEVELOPMENT.md) for documented analysis bounds and [Deployment](DEPLOYMENT.md) for operation and HTTPS instructions. The checked-in CI workflow repeats unit/build/browser checks and Docker smoke tests; no claim is made that a remote CI run has occurred.
