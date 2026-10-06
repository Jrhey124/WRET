import { useEffect, useRef } from "react";
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
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6e8595" },
    { token: "string", foreground: "b9d98d" },
    { token: "keyword", foreground: "bfabed" },
  ],
  colors: {
    "editor.background": "#101820",
    "editor.foreground": "#ced9e3",
    "editorLineNumber.foreground": "#496071",
    "editorLineNumber.activeForeground": "#78d4c3",
    "editor.selectionBackground": "#31535a",
    "editor.lineHighlightBackground": "#15212b",
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
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const selectionCallback = useRef(onSelection);
  selectionCallback.current = onSelection;
  useEffect(() => {
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
  return (
    <div
      className="editor-host"
      ref={host}
      aria-label={original ? "Original source editor" : "Derived view editor"}
    />
  );
}
