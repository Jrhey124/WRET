# Web investigation gaps: plan and implementation

WRET investigates browser-visible code and behavior. A browser heap is inspectable through CDP, but a heap snapshot is not a restorable execution checkpoint. Binary clients can also depend on private servers; possessing a client does not imply possessing all server logic. The implementation distinguishes observations, static resolution, and unresolved relationships.

## 1. Execution state

Implemented: capability-gated Debug controls capture heap usage and shallow own properties from the selected paused frame's scopes. Accessors are recorded without invoking getters. Snapshots become JSON evidence and can be compared in Research. Live editing is probed with a benign compiled script before sample navigation. Current Chromium has removed CDP live editing, so WRET disables it with an explanation. Older compatible builds can expose the reviewed draft/dry-run/apply adapter; applied source is retained with original provenance. Transformed derivatives can be executed in a fresh session, which does not preserve volatile runtime state.

Bounds: 12 scopes, 200 properties per scope, 300 characters per primitive string or description, 1 MiB per evidence capture, existing session/project budgets. Comparison shows at most 1,000 differences and uses scope name/position, not heap object identity. All captures remain observations: closures, object graphs, timers, sockets, DOM, and execution state are not restored.

Follow-up: bounded heap-profiler sampling, explicit object-graph exploration, application-specific state serialization with opt-in restore, and deterministic replay fixtures. Full arbitrary heap restoration is not a promised feature.

## 2. AST workflows

Implemented: Research previews constant strings, finite literal expressions, constant branches, and explicit debugger-statement removal for selected files or a bounded workspace. Literal/branch/debugger recipes also support byte selections carried from Inspect. Original and proposed source appear side by side. Saving creates separate evidence with source hash, source ID, recipe, timestamp, and change count. Original bytes are preserved. Syntax is checked before and after transformation; samples are not executed. Branch pruning preserves potentially hoisted var/function declarations. Unknown calls and dynamic expressions remain intact.

Bounds: 1 MiB per source; 50 files/8 MiB per workspace preview; 5,000 candidate edits. String-binding folding requires a whole file. One transformation failure cancels the preview batch and surfaces the reason.

Follow-up: adapters for recognized bundler modules and specific flattening patterns, reviewed rename maps, original-to-derivative coordinates, and worker-based incremental indexing. Arbitrary transformation scripts and automatic claims of full deobfuscation are excluded.

## 3. Backend behavior

Implemented: Research groups captured requests by method and endpoint and describes field paths/types from retained JSON responses. Samples link to their response evidence. Missing bodies and bounds produce incomplete-coverage markers. Query values and response values are omitted from shape summaries. Sample frequency is not treated as proof that a field is required.

Bounds: 5,000 requests, 1,000 endpoint groups, 8 MiB of inspected bodies, 200 field paths per response/group, depth 6, 2,000 visited values per body, 20 array elements, 100 keys per object.

Follow-up: capture comparison, endpoint state-transition hypotheses, schema export with confidence labels, and explicitly reviewed replay through the existing broker. Backend source recovery is outside this workflow.

## 4. Repeated debugger pauses

Implemented: Debug can suppress all pauses through CDP and restore normal pauses. The UI states that line breakpoints and exception pauses are suppressed too. The policy applies to attached targets and new targets, and changes appear in observations. A separate AST recipe removes debugger statements from a reviewed derivative.

Follow-up: per-source ignore lists and response overrides for locally authorized fixtures. No automatic challenge solving, timing spoofing, or guarantee of bypassing commercial protection is provided. Pause suppression is a debugging control, not a browser stealth mode.

## 5. Cross-references

Implemented: a searchable workspace index separates reads, writes, and read/write references using lexical scope analysis. Supported relative ES module imports resolve to locally supplied named/default exports. Definition/reference buttons navigate to original byte locations. Computed property calls remain explicitly unresolved. Indexing is static; it does not claim to observe every runtime access or framework state update.

Bounds: 1 MiB/file, 16 MiB total source indexing, 5,000 references. Re-exports, namespace property resolution, dynamic imports, package resolution, and framework state models remain follow-up work.

## Accessibility and release checks

Research and runtime controls use labeled fields, visible keyboard focus, explanatory disabled-action help, selectable source previews, and searchable reference lists. Status changes use polite announcements. Reduced-motion preferences disable transitions. The existing Ctrl+K palette exposes Research and preserves editing shortcuts.

Required validation: typecheck, companion typecheck, unit tests for semantic hazards/bounds/provenance, Chromium and Edge flows for previews/navigation/export/reopen, and real guest tests for snapshots, capability negotiation, and pause-policy reset. The guest suite explicitly verifies live-edit rejection on unsupported builds, or dry-run/apply on compatible builds. Old guest images do not advertise new capabilities and leave runtime controls disabled. Rebuild the prepared guest image using the current agent; its integrity manifest must match.

Windows/QEMU lifecycle, Narrator/NVDA, and actual guest acceptance remain release gates. A static/browser test pass is not evidence that live edit works with every Chromium build.

Official implementation references: [CDP Debugger](https://chromedevtools.github.io/devtools-protocol/tot/Debugger/), [CDP Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/), [CDP HeapProfiler](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/).
