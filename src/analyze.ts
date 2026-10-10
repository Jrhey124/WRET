import { parse } from "acorn";
import { fullAncestor } from "acorn-walk";
import { analyze as analyzeScopes } from "eslint-scope";
import * as prettier from "prettier/standalone";
import * as babel from "prettier/plugins/babel";
import * as estree from "prettier/plugins/estree";
import * as htmlPlugin from "prettier/plugins/html";
import * as postcssPlugin from "prettier/plugins/postcss";
import wabtFactory from "wabt";
import {
  decodeText,
  offsetToByte,
  sha256,
  RESULT_LIMIT,
  FILE_LIMIT,
  type AnalysisOptions,
  type Analysis,
  type Evidence,
  type Item,
} from "./model";

export async function beautifyEvidence(file: Evidence): Promise<string> {
  if (file.bytes.length > 5 * 1024 * 1024) throw new Error("Beautify supports files up to 5 MiB.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  let output: string;
  if (file.format === "html") {
    output = await prettier.format(text, { parser: "html", plugins: [htmlPlugin, babel, estree, postcssPlugin] });
  } else if (file.format === "javascript") {
    output = await prettier.format(text, { parser: "babel", plugins: [babel, estree] });
  } else if (file.format === "css") {
    output = await prettier.format(text, { parser: "css", plugins: [postcssPlugin] });
  } else if (file.format === "json" || file.format === "sourcemap") {
    output = await prettier.format(text, { parser: "json-stringify", plugins: [babel, estree] });
  } else throw new Error("Beautify supports HTML, JavaScript, CSS, JSON, and source maps.");
  if (new TextEncoder().encode(output).length > 20 * 1024 * 1024) throw new Error("Beautified output exceeds the 20 MiB limit.");
  return output;
}

export async function analyzeFile(
  file: Evidence,
  progress: (s: string) => void = () => {},
  options: AnalysisOptions = {},
): Promise<Analysis> {
  const { bytes, id: fileId } = file;
  if (bytes.length > FILE_LIMIT)
    throw new Error("File exceeds the 25 MiB analysis limit");
  const maxEntries = Math.min(
    RESULT_LIMIT,
    Math.max(1, Math.floor(options.maxEntries || RESULT_LIMIT)),
  );
  const result: Analysis = {
    hash: await sha256(bytes),
    strings: [],
    outline: [],
    references: [],
    calls: [],
    findings: [],
    sections: [],
    diagnostics: [],
  };
  let serial = 0;
  const item = (
    name: string,
    kind: string,
    start: number,
    end: number,
    detail?: string,
  ): Item => ({
    id: `${fileId}:${serial++}`,
    name: name.length > 2048 ? name.slice(0, 2048) + "…" : name,
    kind,
    location: { fileId, start, end },
    detail,
  });
  progress("Extracting strings and indicators");
  for (let i = 0; i < bytes.length && result.strings.length < maxEntries;) {
    const start = i;
    while (i < bytes.length && bytes[i] >= 32 && bytes[i] <= 126) i++;
    if (i - start >= 4)
      result.strings.push(
        item(
          decodeText(bytes.subarray(start, Math.min(i, start + 2048))),
          "string",
          start,
          i,
        ),
      );
    i++;
  }
  if (result.strings.length === maxEntries)
    result.diagnostics.push(
      "String results capped at 5,000. Search original evidence for additional matches.",
    );
  if (file.format !== "binary" && file.format !== "wasm") {
    try {
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      result.diagnostics.push(
        "File is not valid UTF-8. Text analysis is skipped to preserve accurate evidence offsets; inspect original bytes and extracted strings.",
      );
      return result;
    }
  }
  const text = decodeText(bytes);
  // Build once: all source ranges are converted from UTF-16 positions to original UTF-8 byte offsets.
  const byteOffsets = new Uint32Array(text.length + 1);
  let byte = 0;
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i)!;
    const n = code > 65535 ? 2 : 1;
    byteOffsets[i] = byte;
    if (n === 2) byteOffsets[i + 1] = byte;
    byte += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    i += n;
    byteOffsets[i] = byte;
  }
  const at = (n: number) =>
    Math.min(bytes.length, byteOffsets[n] ?? offsetToByte(text, n));
  const sourceItem = (
    name: string,
    kind: string,
    start: number,
    end: number,
    detail?: string,
  ) => item(name, kind, at(start), at(end), detail);
  if (file.format !== "binary" && file.format !== "wasm") {
    const patterns: [RegExp, string][] = [
      [/https?:\/\/[^\s"'<>`\\)]+/g, "URL"],
      [
        /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:com|net|org|io|dev|ru|cn|xyz|info|top|biz|app|co|uk)\b/g,
        "domain candidate",
      ],
      [
        /\b(?:eval|Function|atob|fetch|XMLHttpRequest|WebSocket|sendBeacon|document\.cookie|localStorage|WebAssembly\.instantiate)\b/g,
        "API pattern",
      ],
    ];
    for (const [regex, kind] of patterns)
      for (const match of text.matchAll(regex)) {
        if (result.findings.length >= maxEntries) break;
        result.findings.push({
          ...sourceItem(
            match[0],
            kind,
            match.index!,
            match.index! + match[0].length,
            "Observable text pattern; may occur in comments or strings. Review its context.",
          ),
          status: "unreviewed",
        });
        if (kind === "URL" && result.findings.length < maxEntries) {
          const host = match[0].match(
            /^https?:\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^:/?#]+)/i,
          );
          if (host) {
            const start = match.index! + host[0].length - host[1].length;
            result.findings.push({
              ...sourceItem(
                host[1],
                "URL host",
                start,
                start + host[1].length,
                "Host extracted from a URL literal; never resolved or fetched.",
              ),
              status: "unreviewed",
            });
          }
        }
      }
    if (/sourceMappingURL\s*=/.test(text))
      result.diagnostics.push(
        "Source-map link found. It was not fetched; import the map locally to inspect it.",
      );
  } else {
    for (const s of result.strings)
      for (const m of s.name.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
        if (result.findings.length >= maxEntries) break;
        result.findings.push({
          ...item(
            m[0],
            "URL",
            s.location.start + m.index!,
            s.location.start + m.index! + m[0].length,
          ),
          status: "unreviewed",
        });
      }
  }
  if (result.findings.length === maxEntries)
    result.diagnostics.push("Indicator results capped at 5,000.");
  if (file.format === "javascript") {
    progress("Parsing JavaScript and resolving lexical bindings");
    try {
      let ast;
      let sourceType: "module" | "script" = "module";
      try {
        ast = parse(text, {
          ecmaVersion: "latest",
          sourceType,
          ranges: true,
          locations: true,
        });
      } catch {
        sourceType = "script";
        ast = parse(text, {
          ecmaVersion: "latest",
          sourceType,
          ranges: true,
          locations: true,
          allowReturnOutsideFunction: true,
        });
      }
      const functionNodes = new Map<object, Item>();
      const bindings = new Map<object, Item>();
      const calls: { node: any; ancestors: any[] }[] = [];
      fullAncestor(ast, (node: any, _state: unknown, ancestors: any[]) => {
        if (
          /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(
            node.type,
          ) &&
          result.outline.length < maxEntries
        ) {
          const parent = ancestors[ancestors.length - 2];
          const name =
            node.id?.name ||
            (parent?.type === "VariableDeclarator"
              ? parent.id?.name
              : undefined) ||
            (parent?.type === "Property" ? parent.key?.name : undefined) ||
            `(anonymous @ ${node.loc.start.line})`;
          const fn = sourceItem(
            name,
            "function",
            node.start,
            node.end,
            `${node.params.length} parameters · line ${node.loc.start.line}`,
          );
          result.outline.push(fn);
          functionNodes.set(node, fn);
          if (node.id) bindings.set(node.id, fn);
          if (
            parent?.type === "VariableDeclarator" &&
            parent.id.type === "Identifier"
          )
            bindings.set(parent.id, fn);
        }
        if (
          (node.type === "CallExpression" || node.type === "NewExpression") &&
          calls.length < maxEntries
        )
          calls.push({ node, ancestors: [...ancestors] });
      });
      const scope = analyzeScopes(ast as any, {
        ecmaVersion: 2022,
        sourceType,
        optimistic: false,
        ignoreEval: false,
      });
      const refTargets = new Map<object, Item>();
      for (const s of scope.scopes) {
        for (const variable of s.variables) {
          // Only unmodified lexical function bindings are considered statically resolved.
          const target = variable.identifiers
            .map((x) => bindings.get(x))
            .find(Boolean);
          const reassigned = variable.references.some(
            (r) => r.isWrite() && !r.init,
          );
          for (const ref of variable.references) {
            if (result.references.length >= maxEntries) break;
            const n = ref.identifier as any;
            const entry = sourceItem(
              variable.name,
              ref.isWrite() ? "write reference" : "read reference",
              n.start,
              n.end,
              "Lexically resolved symbol reference",
            );
            const declaration = variable.identifiers[0] as any;
            if (target) entry.target = target.id;
            else if (declaration)
              entry.detail += ` · declaration byte ${at(declaration.start)}`;
            result.references.push(entry);
            if (target && !reassigned) refTargets.set(n, target);
          }
        }
      }
      for (const { node, ancestors } of calls) {
        const target =
          node.callee.type === "Identifier"
            ? refTargets.get(node.callee)
            : undefined;
        const owner = [...ancestors]
          .reverse()
          .map((x) => functionNodes.get(x))
          .find(Boolean);
        const call = sourceItem(
          text.slice(node.callee.start, node.callee.end).slice(0, 150),
          target ? "static call" : "unresolved dynamic call",
          node.start,
          node.end,
          owner ? `From ${owner.name}` : "From file scope",
        );
        call.target = target?.id;
        result.calls.push(call);
      }
      // Bounded, navigable AST index rather than an unbounded recursive JSON dump.
      const nodes: {
        start: number;
        end: number;
        depth: number;
        text: string;
      }[] = [];
      fullAncestor(ast, (node: any, _state: unknown, ancestors: any[]) => {
        if (nodes.length < maxEntries)
          nodes.push({
            start: node.start,
            end: node.end,
            depth: ancestors.length,
            text: `${"  ".repeat(Math.min(ancestors.length - 1, 40))}${node.type}  bytes ${at(node.start)}..${at(node.end)}  line ${node.loc.start.line}`,
          });
      });
      result.ast = nodes
        .sort((a, b) => a.start - b.start || b.end - a.end || a.depth - b.depth)
        .map((n) => n.text)
        .join("\n");
      if (nodes.length === maxEntries)
        result.diagnostics.push("AST index capped at 5,000 nodes.");
      if (
        [result.outline, result.calls, result.references].some(
          (x) => x.length === maxEntries,
        )
      )
        result.diagnostics.push("Symbol/call results capped at 5,000.");
    } catch (error) {
      result.diagnostics.push(`JavaScript parsing: ${String(error)}`);
    }
    progress("Formatting a derived view");
    if (bytes.length <= 2 * 1024 * 1024) {
      try {
        result.formatted = await prettier.format(text, {
          parser: "babel",
          plugins: [babel, estree],
        });
      } catch (error) {
        result.diagnostics.push(`Formatting unavailable: ${String(error)}`);
      }
    } else
      result.diagnostics.push(
        "Formatting skipped above 2 MiB; original source remains available.",
      );
  }
  if (file.format === "json" || file.format === "sourcemap") {
    try {
      const json = JSON.parse(text);
      if (bytes.length <= 2 * 1024 * 1024)
        result.formatted = JSON.stringify(json, null, 2);
      if (file.format === "sourcemap") {
        result.diagnostics.push(
          "Source map inspected as data. External sources are never fetched; mappings are not applied to derived views.",
        );
        if (json.version !== 3 || !Array.isArray(json.sources))
          result.diagnostics.push(
            "Not a valid version 3 source-map structure.",
          );
        else
          for (const source of json.sources.slice(0, maxEntries))
            result.outline.push(
              item(
                String(source),
                "source-map source",
                0,
                bytes.length,
                "Source declaration; inspect original JSON for context.",
              ),
            );
      }
    } catch (error) {
      result.diagnostics.push(`JSON parsing: ${String(error)}`);
    }
  }
  if (file.format === "wasm") {
    progress("Inspecting WASM sections");
    try {
      result.sections = wasmSections(bytes, fileId);
    } catch (error) {
      result.diagnostics.push(`WASM sections: ${String(error)}`);
    }
    progress("Disassembling with WABT (no sample execution)");
    let module:
      | ReturnType<Awaited<ReturnType<typeof wabtFactory>>["readWasm"]>
      | undefined;
    try {
      const wabt = await wabtFactory();
      module = wabt.readWasm(bytes, { readDebugNames: true, check: false });
      module.generateNames();
      module.applyNames();
      result.wat = module.toText({ foldExprs: false, inlineExport: false });
      if (result.wat.length > 16 * 1024 * 1024) {
        result.wat = undefined;
        result.diagnostics.push(
          "WAT exceeds the 16 MiB derived-view limit. Original section and function byte ranges remain available.",
        );
        return result;
      }
      const lines = result.wat.split("\n");
      let functionIndex = 0;
      for (
        let line = 0;
        line < lines.length && result.outline.length < maxEntries;
        line++
      ) {
        const match = lines[line].match(/^  \((import|export|func)\s+(.*)/);
        if (!match) continue;
        const kind = match[1];
        const section = result.sections.find(
          (s) =>
            s.kind ===
            (kind === "import"
              ? "import section"
              : kind === "export"
                ? "export section"
                : "code section"),
        );
        const body =
          kind === "func"
            ? result.sections.filter((s) => s.kind === "function body")[
                functionIndex++
              ]
            : undefined;
        result.outline.push({
          ...item(
            match[2].slice(0, 180),
            `wasm ${kind}`,
            body?.location.start ?? section?.location.start ?? 0,
            body?.location.end ?? section?.location.end ?? 8,
            `WAT line ${line + 1}; ${body ? "original function body" : "containing section"} byte range`,
          ),
          target: `wat:${line + 1}`,
        });
      }
    } catch (error) {
      result.diagnostics.push(`WABT: ${String(error)}`);
    } finally {
      module?.destroy();
    }
  }
  return result;
}

export function wasmSections(bytes: Uint8Array, fileId: string): Item[] {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0 ||
    bytes[1] !== 97 ||
    bytes[2] !== 115 ||
    bytes[3] !== 109 ||
    bytes[4] !== 1 ||
    bytes[5] ||
    bytes[6] ||
    bytes[7]
  )
    throw new Error("Invalid or truncated WASM v1 header");
  let p = 8;
  const read = (end = bytes.length) => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (p >= end) throw new Error("Truncated LEB128");
      const b = bytes[p++];
      if (i === 4 && b & 0xf0) throw new Error("Invalid LEB128");
      value += (b & 127) * 2 ** (i * 7);
      if (!(b & 128)) return value;
    }
    throw new Error("Invalid LEB128");
  };
  const names = [
    "custom",
    "type",
    "import",
    "function",
    "table",
    "memory",
    "global",
    "export",
    "start",
    "element",
    "code",
    "data",
    "data count",
    "tag",
  ];
  const sections: Item[] = [];
  while (p < bytes.length) {
    if (sections.length >= RESULT_LIMIT)
      throw new Error("WASM section/function result limit exceeded");
    const start = p,
      id = bytes[p++],
      size = read(),
      payload = p,
      end = p + size;
    if (end > bytes.length)
      throw new Error(`Truncated section at byte ${start}`);
    sections.push({
      id: `${fileId}:section:${start}`,
      name: `${names[id] || `unknown ${id}`} · ${size} bytes`,
      kind: `${names[id]} section`,
      location: { fileId, start, end },
      detail: `Payload starts at byte ${payload}`,
    });
    if (id === 10) {
      const count = read(end);
      if (count > RESULT_LIMIT) throw new Error("WASM function limit exceeded");
      for (let i = 0; i < count; i++) {
        const length = read(end),
          bodyStart = p;
        if (p + length > end) throw new Error("Truncated function body");
        sections.push({
          id: `${fileId}:body:${i}`,
          name: `Function body ${i}`,
          kind: "function body",
          location: { fileId, start: bodyStart, end: p + length },
        });
        p += length;
      }
      if (p !== end) throw new Error("Unexpected trailing code bytes");
    }
    p = end;
  }
  return sections;
}
