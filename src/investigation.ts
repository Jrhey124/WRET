import { parse } from "acorn";
import { simple } from "acorn-walk";
import { parse as parseHTML } from "parse5";
import { analyze as analyzeScopes } from "eslint-scope";
import {
  decodeText,
  sourceLineStarts,
  type Evidence,
  type Location,
} from "./model";
export function evidencePath(value: string): string {
  const path = value.replace(/\\/g, "/");
  if (
    !path ||
    path.startsWith("/") ||
    /^[a-z]+:/i.test(path) ||
    path.split("/").some((x) => x === ".." || !x || x === ".")
  )
    throw new Error("Invalid relative evidence path");
  return path;
}
function relative(base: string, reference: string): string | undefined {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(reference)) return;
  try {
    return decodeURIComponent(
      new URL(reference, "https://evidence.invalid/" + base).pathname.slice(1),
    );
  } catch {
    return;
  }
}
export function dependencies(files: Evidence[]) {
  return files
    .filter((f) => f.format === "html")
    .flatMap((file) => {
      // A code parser cannot instantiate browser nodes or fetch sample resources.
      const doc = parseHTML(
        decodeText(file.bytes.subarray(0, 2 * 1024 * 1024)),
      );
      const stack: any[] = [doc],
        references: string[] = [];
      let inspected = 0;
      while (stack.length && inspected++ < 50000 && references.length < 5000) {
        const node = stack.pop();
        if (node.tagName === "script" || node.tagName === "link" || node.tagName === "img") {
          const attribute = node.attrs?.find(
            (attr: any) =>
              attr.name === (node.tagName === "link" ? "href" : "src"),
          );
          if (attribute) references.push(attribute.value);
        }
        if (node.childNodes)
          for (let i = node.childNodes.length - 1; i >= 0; i--)
            stack.push(node.childNodes[i]);
      }
      return references.map((reference) => {
        const path = relative(file.name, reference);
        return {
          file,
          reference,
          target:
            files.find((f) => f.name === path) ||
            (reference.startsWith("/") && path && file.name.includes("/")
              ? files.find(
                  (f) => f.name === file.name.split("/")[0] + "/" + path,
                )
              : undefined),
          external: path === undefined,
        };
      });
    });
}
export interface Mapping {
  generated: Location;
  original: Location;
  line: number;
  column: number;
  source: string;
}
function mappedSourcePath(mapFile: Evidence, map: any, index: number): string {
  const sourceName = map.sources[index];
  if (typeof sourceName !== "string") throw new Error("Invalid source index");
  return (
    relative(
      mapFile.name,
      (map.sourceRoot ? String(map.sourceRoot).replace(/\/$/, "") + "/" : "") +
        sourceName,
    ) || `embedded/${mapFile.id}/${index}.js`
  );
}
export function embeddedSources(files: Evidence[]): Evidence[] {
  const added: Evidence[] = [];
  for (const file of files.filter((f) => f.format === "sourcemap")) {
    try {
      const map = JSON.parse(decodeText(file.bytes));
      if (
        map.version !== 3 ||
        !Array.isArray(map.sources) ||
        !Array.isArray(map.sourcesContent)
      )
        continue;
      for (let index = 0; index < Math.min(map.sources.length, 1000); index++) {
        const content = map.sourcesContent[index];
        if (typeof content !== "string") continue;
        const name = evidencePath(mappedSourcePath(file, map, index));
        if (
          files.some((f) => f.name === name) ||
          added.some((f) => f.name === name)
        )
          continue;
        const bytes = new TextEncoder().encode(content);
        if (
          bytes.length > 25 * 1024 * 1024 ||
          files.length + added.length >= 1000 ||
          [...files, ...added].reduce((n, f) => n + f.bytes.length, 0) +
            bytes.length >
            100 * 1024 * 1024
        )
          throw new Error("Embedded source evidence exceeds project limits");
        added.push({
          id: crypto.randomUUID(),
          name,
          bytes,
          format: name.endsWith(".css")
            ? "css"
            : name.endsWith(".html")
              ? "html"
              : "javascript",
          sourceMapOf: file.id,
        });
      }
    } catch (error) {
      if (String(error).includes("exceeds project limits")) throw error;
    }
  }
  return added;
}
function vlq(segment: string): number[] {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values: number[] = [];
  let value = 0,
    shift = 0;
  for (const char of segment) {
    const digit = alphabet.indexOf(char);
    if (digit < 0 || shift > 30) throw new Error("Invalid source map VLQ");
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) shift += 5;
    else {
      values.push((value & 1 ? -1 : 1) * Math.floor(value / 2));
      value = shift = 0;
    }
  }
  if (shift) throw new Error("Incomplete source map VLQ");
  return values;
}
function coordinates(file: Evidence) {
  if (file.bytes.length > 2 * 1024 * 1024)
    throw new Error("Source map navigation is limited to sources up to 2 MiB.");
  const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(file.bytes),
    starts = sourceLineStarts(text),
    bytes = new Uint32Array(text.length + 1);
  let byte = 0;
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index)!,
      width = point > 65535 ? 2 : 1;
    bytes[index] = byte;
    if (width === 2) bytes[index + 1] = byte;
    byte += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
    index += width;
    bytes[index] = byte;
  }
  return (line: number, column: number) => {
    if (line < 0 || line >= starts.length || column < 0)
      throw new Error("Source map position outside supplied source");
    let end = starts[line + 1] ?? text.length;
    while (end > starts[line] && /[\r\n]/.test(text[end - 1])) end--;
    const offset = starts[line] + column;
    if (offset > end)
      throw new Error("Source map position outside supplied source");
    return bytes[offset];
  };
}
export function sourceMappings(
  files: Evidence[],
  generated: Evidence,
): { mappings: Mapping[]; diagnostics: string[] } {
  const diagnostics: string[] = [],
    mappings: Mapping[] = [];
  const positions = new Map<string, ReturnType<typeof coordinates>>();
  let coordinateBytes = 0;
  const byteAt = (file: Evidence, line: number, column: number) => {
    let position = positions.get(file.id);
    if (!position) {
      coordinateBytes += file.bytes.length;
      if (coordinateBytes > 16 * 1024 * 1024)
        throw new Error("Source map coordinate indexing exceeds 16 MiB.");
      position = coordinates(file);
      positions.set(file.id, position);
    }
    return position(line, column);
  };
  const reference = /[#@]\s*sourceMappingURL=([^\s]+)/g.exec(
    decodeText(generated.bytes),
  )?.[1];
  const mapFile = files.find(
    (f) =>
      f.name ===
      relative(
        generated.name,
        reference || generated.name.split("/").pop()! + ".map",
      ),
  );
  if (!mapFile)
    return {
      mappings,
      diagnostics: reference ? ["Source map not supplied locally."] : [],
    };
  try {
    const map = JSON.parse(decodeText(mapFile.bytes));
    if (
      map.version !== 3 ||
      !Array.isArray(map.sources) ||
      typeof map.mappings !== "string" ||
      map.mappings.length > 2 * 1024 * 1024
    )
      throw new Error("Unsupported or oversized source map");
    let source = 0,
      originalLine = 0,
      originalColumn = 0;
    const lines = map.mappings.split(";");
    outer: for (let line = 0; line < lines.length; line++) {
      let column = 0;
      for (const segment of lines[line].split(",")) {
        if (!segment) continue;
        const values = vlq(segment);
        column += values[0];
        if (values.length === 1) continue;
        if (values.length !== 4 && values.length !== 5)
          throw new Error("Invalid mapping segment");
        source += values[1];
        originalLine += values[2];
        originalColumn += values[3];
        const sourceName = map.sources[source];
        if (typeof sourceName !== "string")
          throw new Error("Invalid source index");
        const path = mappedSourcePath(mapFile, map, source);
        const original = files.find((f) => f.name === path);
        if (!original) {
          if (
            !diagnostics.includes(
              "Some original sources were not supplied locally.",
            )
          )
            diagnostics.push(
              "Some original sources were not supplied locally.",
            );
          continue;
        }
        const start = byteAt(generated, line, column),
          end = byteAt(original, originalLine, originalColumn);
        mappings.push({
          generated: { fileId: generated.id, start, end: start },
          original: { fileId: original.id, start: end, end },
          line: line + 1,
          column: column + 1,
          source: sourceName,
        });
        if (mappings.length >= 5000) {
          diagnostics.push("Source map navigation limited to 5,000 entries.");
          break outer;
        }
      }
    }
  } catch (error) {
    diagnostics.push(String(error));
  }
  return { mappings, diagnostics };
}
export function foldStrings(input: string): string {
  if (input.length > 1024 * 1024) throw new Error("Recipe input exceeds 1 MiB");
  const ast = parse(input, {
    ecmaVersion: "latest",
    sourceType: "module",
    ranges: true,
  });
  const scopes = analyzeScopes(ast as any, {
    ecmaVersion: 2022,
    sourceType: "module",
    optimistic: false,
  });
  const constants = new Map<object, any>();
  for (const scope of scopes.scopes)
    for (const variable of scope.variables) {
      const definition = variable.defs[0];
      if (
        variable.defs.length !== 1 ||
        definition?.type !== "Variable" ||
        definition.parent?.kind !== "const" ||
        definition.node.type !== "VariableDeclarator" ||
        definition.node.id.type !== "Identifier"
      )
        continue;
      const initializer = definition.node.init;
      if (!initializer) continue;
      for (const reference of variable.references)
        if (
          reference.isRead() &&
          reference.identifier.range![0] >= initializer.range![1] &&
          reference.from.variableScope === variable.scope.variableScope
        )
          constants.set(reference.identifier, initializer);
    }
  const replacements: { start: number; end: number; value: string }[] = [];
  const value = (node: any, depth = 0): string | undefined => {
    if (depth > 32) return;
    if (node.type === "Identifier" && constants.has(node))
      return value(constants.get(node), depth + 1);
    if (node.type === "Literal" && typeof node.value === "string")
      return node.value;
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const a = value(node.left, depth + 1),
        b = value(node.right, depth + 1);
      if (a !== undefined && b !== undefined) return a + b;
    }
  };
  simple(ast, {
    BinaryExpression(node: any) {
      const result = value(node);
      if (result !== undefined)
        replacements.push({
          start: node.start,
          end: node.end,
          value: JSON.stringify(result),
        });
    },
  });
  const outer = replacements.filter(
    (x) =>
      !replacements.some(
        (y) => y !== x && y.start <= x.start && y.end >= x.end,
      ),
  );
  for (const item of outer.sort((a, b) => b.start - a.start))
    input = input.slice(0, item.start) + item.value + input.slice(item.end);
  return input;
}
