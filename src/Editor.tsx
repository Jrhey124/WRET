import { readEvidenceRange } from "./storage";
import { evidenceSize } from "./model";
import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import type { Location, Evidence } from "./model";
import { sourceLineStarts, sourcePosition, offsetToByte } from "./model";
(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme("wret", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "69757d" },
    { token: "string", foreground: "52733d" },
    { token: "keyword", foreground: "694e91" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#252d33",
    "editorLineNumber.foreground": "#859098",
    "editorLineNumber.activeForeground": "#315f7b",
    "editor.selectionBackground": "#c8dce8",
    "editor.lineHighlightBackground": "#f4f7f8",
  },
});
export function Editor({
  file,
  value,
  original,
  location,
  line,
  onSelection,
}: {
  file: Evidence;
  value: string;
  original: boolean;
  location?: Location;
  line?: number;
  onSelection: (l: Location) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const selectionCallback = useRef(onSelection);
  selectionCallback.current = onSelection;
  const paged = original && evidenceSize(file) > 2 * 1024 * 1024;
  const pageBytes = 256 * 1024;
  const pageStart = page * pageBytes;
  const [pageData, setPageData] = useState<Uint8Array>();
  const [pageError, setPageError] = useState("");
  useEffect(() => {
    if (!paged) return;
    let active = true; setPageData(undefined); setPageError("");
    const end = Math.min(evidenceSize(file), pageStart + pageBytes + 4);
    const load = file.bytes.length === evidenceSize(file) ? Promise.resolve(file.bytes.slice(pageStart, end)) : readEvidenceRange(file.id, pageStart, end);
    load.then(bytes => { if (active) setPageData(bytes); }).catch(error => { if (active) setPageError(String(error)); });
    return () => { active = false; };
  }, [file.id, pageStart, paged]);
  const data = pageData || new Uint8Array();
  let from = 0, to = Math.min(data.length, pageBytes);
  while (from < to && (data[from] & 0xc0) === 0x80) from++;
  while (to < data.length && (data[to] & 0xc0) === 0x80) to++;
  const textStart = pageStart + from, pageEnd = pageStart + to;
  let pageText = "", encodingError = "";
  try { pageText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.subarray(from, to)); }
  catch { encodingError = "This page is not valid UTF-8. Use Hex to inspect its original bytes."; }
  useEffect(() => setPage(0), [file.id]);
  useEffect(() => { if (paged && location?.fileId === file.id) setPage(Math.floor(location.start / pageBytes)); }, [paged, file.id, location?.fileId, location?.start]);
  useEffect(() => {
    if (paged) return;
    const model = monaco.editor.createModel(
      value,
      original
        ? file.format === "sourcemap"
          ? "json"
          : file.format === "binary" || file.format === "wasm"
            ? "plaintext"
            : file.format
        : "plaintext",
    );
    const starts = sourceLineStarts(value);
    const instance = monaco.editor.create(host.current!, {
      model,
      theme: "wret",
      readOnly: true,
      glyphMargin: false,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      lineNumbersMinChars: 4,
      padding: { top: 18 },
      scrollBeyondLastLine: false,
      wordWrap: "off",
      renderValidationDecorations: "off",
      links: false,
      folding: true,
      contextmenu: false,
      unicodeHighlight: { ambiguousCharacters: false },
      quickSuggestions: false,
    });
    editor.current = instance;
    const listener = instance.onDidChangeCursorSelection((e) => {
      if (!original || e.source === "wret") return;
      const a = e.selection.getStartPosition(),
        b = e.selection.getEndPosition();
      const start = (starts[a.lineNumber - 1] || 0) + a.column - 1,
        end = (starts[b.lineNumber - 1] || 0) + b.column - 1;
      selectionCallback.current({
        fileId: file.id,
        start: offsetToByte(value, start),
        end: offsetToByte(value, end),
      });
    });
    return () => {
      listener.dispose();
      instance.dispose();
      model.dispose();
      editor.current = null;
    };
  }, [file.id, file.format, value, original]);
  useEffect(() => {
    const instance = editor.current,
      model = instance?.getModel();
    if (!instance || !model) return;
    if (original && location?.fileId === file.id) {
      const start = sourcePosition(file.bytes, location.start),
        end = sourcePosition(file.bytes, location.end);
      instance.setSelection(
        new monaco.Range(
          start.lineNumber,
          start.column,
          end.lineNumber,
          end.column,
        ),
        "wret",
      );
      instance.revealLineInCenter(start.lineNumber);
    } else if (line) {
      instance.revealLineInCenter(line);
      instance.setPosition({ lineNumber: line, column: 1 }, "wret");
    }
  }, [file, location, original, line]);
  if (paged) return <div className="large-source-page" aria-label="Paged large source viewer">
    <div className="large-source-toolbar"><strong>{file.format.toUpperCase()} · large file paging</strong><button disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous page</button><span>Page {page + 1} of {Math.ceil(evidenceSize(file) / pageBytes)}</span><button disabled={pageStart + pageBytes >= evidenceSize(file)} onClick={() => setPage((value) => value + 1)}>Next page</button><span>Bytes {textStart.toLocaleString()}–{pageEnd.toLocaleString()}</span></div>
    <p className="panel-help">Large evidence is shown in 256 KiB pages to keep the editor responsive. Syntax coloring is available in Monaco for files up to 2 MiB.</p>
    {(pageError || encodingError) && <p role="alert">{pageError || encodingError}</p>}
    {!pageData && !pageError && <p role="status">Loading source page?</p>}
    <pre onMouseUp={() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.anchorNode || selection.anchorNode !== selection.focusNode || selection.anchorNode.nodeType !== Node.TEXT_NODE) return;
      const start = Math.min(selection.anchorOffset, selection.focusOffset), end = Math.max(selection.anchorOffset, selection.focusOffset);
      const encoder = new TextEncoder();
      onSelection({ fileId: file.id, start: textStart + encoder.encode(pageText.slice(0, start)).length, end: textStart + encoder.encode(pageText.slice(0, end)).length });
    }}><code>{pageText}</code></pre>
  </div>;
  return (
    <div
      className="editor-host"
      ref={host}
      aria-label={original ? "Original source editor" : "Derived view editor"}
    />
  );
}
