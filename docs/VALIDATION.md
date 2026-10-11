# Whidra browser-only validation

Local verification on Windows passed:

- Frontend typecheck and production build.
- 59 unit tests across 9 files, including a 100 MiB metadata-only restore, preservation of unloaded content, atomic deletion, legacy archives, bounded decompression, worker cancellation, and queue serialization.
- 20 Chromium and 20 Microsoft Edge browser workflows against production assets and CSP.
- Keyboard navigation, focus restoration, short/narrow layouts, and the Welcome home button at 200% CSS zoom.
- Large-source paging, search-to-original-byte navigation, direct hex range reads, legacy observation import/deletion/reload/export, offline HAR inspection, and hostile HTML preview fixtures.
- Compose configuration validation and git diff --check.

The 3 MiB paged-source reopen/search/hex fixture recorded approximately 23 MiB of used JavaScript heap in Edge. This is one fixture, not total browser memory: native buffers, workers, graphics, other tabs, and large exports are additional costs. The test writes browser-memory.json into its output directory.

Docker build/container smoke checks were unavailable: local Docker configuration and engine access were denied. No Pi was accessible, so server memory usage and Pi deployment have not been measured. The checked-in runtime image contains nginx and static assets; Node is confined to the build stage. CI retains static build/browser/container checks and has no companion or VM jobs.

Imported JavaScript and Wasm are never executed. Worker deadlines and cancellation keep parsing bounded; workers are not an execution sandbox. Static previews retain an empty iframe sandbox, restrictive CSP, local resource limits, and reconstruction output limits. Large imports, parsing, and portable archive export can still use substantial client memory.

Archive schemas, browser storage identifiers, original hashes, notes, aliases, transformations, and historical runtime records remain compatible. No remote CI or hardware acceptance is claimed by these local results.
