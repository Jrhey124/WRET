# Whidra static investigation capabilities

Whidra analyzes browser-visible code and imported observations without executing samples. Static resolution, observed behavior, and unresolved relationships are distinct.

## 2. AST workflows

Implemented: Research previews constant strings, finite literal expressions, constant branches, and explicit debugger-statement removal for selected files or a bounded workspace. Literal/branch/debugger recipes also support byte selections carried from Inspect. Original and proposed source appear side by side. Saving creates separate evidence with source hash, source ID, recipe, timestamp, and change count. Original bytes are preserved. Syntax is checked before and after transformation; samples are not executed. Branch pruning preserves potentially hoisted var/function declarations. Unknown calls and dynamic expressions remain intact.

Bounds: 1 MiB per source; 50 files/8 MiB per workspace preview; 5,000 candidate edits. String-binding folding requires a whole file. One transformation failure cancels the preview batch and surfaces the reason.

Follow-up: adapters for recognized bundler modules and specific flattening patterns, reviewed rename maps, original-to-derivative coordinates, and worker-based incremental indexing. Arbitrary transformation scripts and automatic claims of full deobfuscation are excluded.

## 3. Backend behavior

Implemented: Research groups captured requests by method and endpoint and describes field paths/types from retained JSON responses. Samples link to their response evidence. Missing bodies and bounds produce incomplete-coverage markers. Query values and response values are omitted from shape summaries. Sample frequency is not treated as proof that a field is required.

Bounds: 5,000 requests, 1,000 endpoint groups, 8 MiB of inspected bodies, 200 field paths per response/group, depth 6, 2,000 visited values per body, 20 array elements, 100 keys per object.

Follow-up: capture comparison, endpoint state-transition hypotheses, schema export with confidence labels, and explicit comparison of imported captures. Backend source recovery is outside this workflow.

## 5. Cross-references

Implemented: a searchable workspace index separates reads, writes, and read/write references using lexical scope analysis. Supported relative ES module imports resolve to locally supplied named/default exports. Definition/reference buttons navigate to original byte locations. Computed property calls remain explicitly unresolved. Indexing is static; it does not claim to observe every runtime access or framework state update.

Bounds: 1 MiB/file, 16 MiB total source indexing, 5,000 references. Re-exports, namespace property resolution, dynamic imports, package resolution, and framework state models remain follow-up work.

## WebAssembly

WABT disassembly, sections/imports/exports, original-byte instruction navigation, direct-call references, virtualized function/instruction views, and module-hash/function-index aliases remain available. Unknown proposal instructions retain partial-coverage diagnostics. Imported Wasm is never instantiated. Historical bridge and memory observations can be reviewed, but live monitoring, memory capture, and VM controls have been removed.

## Saved observations

Imported heap/scope snapshots remain JSON evidence and can be compared in Research. Saved observations provides a searchable read-only record list; Network reviews imported requests. Snapshots do not restore execution state.

## Validation

Run frontend typecheck, build, unit checks, and Chromium/Edge workflows. Verify static-preview isolation, legacy archive preservation, cancellation, bounded transfers, lazy storage, aliases, and transformation provenance.
