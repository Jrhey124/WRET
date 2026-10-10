import { parse } from "acorn";
import { fullAncestor } from "acorn-walk";
import { analyze as scopes } from "eslint-scope";
import { decodeText, type Evidence, type Location } from "./model";
import { foldStrings } from "./investigation";

export const RECIPES = ["fold-strings", "literal-constants", "static-branches", "remove-debugger"] as const;
export type Recipe = typeof RECIPES[number];
export interface TransformPreview { source: string; changes: number; diagnostics: string[] }
function syntax(source: string) {
  const options = { ecmaVersion: "latest" as const, ranges: true };
  try { return { ast: parse(source, { ...options, sourceType: "module" }), sourceType: "module" as const }; }
  catch { return { ast: parse(source, { ...options, sourceType: "script" }), sourceType: "script" as const }; }
}
function literal(node: any): { value: string | number | boolean | null } | undefined {
  if (node?.type === "Literal" && !node.regex && (node.value === null || ["string", "number", "boolean"].includes(typeof node.value))) return { value: node.value };
}
/** No eval, getters, or user functions: only finite operations on literal primitives. */
function constant(node: any): ReturnType<typeof literal> {
  const direct = literal(node);
  if (direct) return direct;
  if (node?.type === "UnaryExpression") {
    const operand = literal(node.argument);
    if (!operand) return;
    if (node.operator === "!") return { value: !operand.value };
    if (typeof operand.value === "number" && Number.isFinite(operand.value) && ["+", "-", "~"].includes(node.operator))
      return { value: node.operator === "-" ? -operand.value : node.operator === "~" ? ~operand.value : operand.value };
  }
  if (node?.type !== "BinaryExpression") return;
  const a = literal(node.left), b = literal(node.right);
  if (!a || !b) return;
  if (node.operator === "===") return { value: a.value === b.value };
  if (node.operator === "!==") return { value: a.value !== b.value };
  if (node.operator === "+" && typeof a.value === "string" && typeof b.value === "string") return { value: a.value + b.value };
  if (typeof a.value !== "number" || typeof b.value !== "number") return;
  const x = a.value, y = b.value;
  let result: number | boolean;
  switch (node.operator) {
    case "+": result = x + y; break; case "-": result = x - y; break;
    case "*": result = x * y; break; case "/": result = x / y; break;
    case "%": result = x % y; break; case "<": result = x < y; break;
    case ">": result = x > y; break; case "<=": result = x <= y; break;
    case ">=": result = x >= y; break; default: return;
  }
  if (typeof result === "number" && (!Number.isFinite(result) || Object.is(result, -0))) return;
  return { value: result };
}
export function transformJavaScript(source: string, recipe: Recipe, range?: { start: number; end: number }): TransformPreview {
  if (new TextEncoder().encode(source).length > 1024 * 1024) throw new Error("Transform input exceeds 1 MiB.");
  if (!RECIPES.includes(recipe)) throw new Error("Unknown transformation recipe.");
  const { ast } = syntax(source);
  if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end > source.length || range.end <= range.start)) throw new Error("Invalid source selection.");
  if (recipe === "fold-strings") {
    if (range) throw new Error("String binding folding needs the entire file. Choose literal constants for selection-only folding.");
    const result = foldStrings(source);
    syntax(result);
    return { source: result, changes: result === source ? 0 : 1, diagnostics: ["Constant string folding retains lexical scope boundaries."] };
  }
  const edits: { start: number; end: number; text: string }[] = [];
  const diagnostics: string[] = [];
  fullAncestor(ast, (node: any) => {
    if (edits.length >= 5000) return;
    if (range && (node.start < range.start || node.end > range.end)) return;
    if (recipe === "remove-debugger" && node.type === "DebuggerStatement") edits.push({ start: node.start, end: node.end, text: ";" });
    if (recipe === "literal-constants" && ["BinaryExpression", "UnaryExpression"].includes(node.type)) {
      const result = constant(node);
      if (result && !(typeof result.value === "number" && Object.is(result.value, -0))) edits.push({ start: node.start, end: node.end, text: `(${JSON.stringify(result.value)})` });
    }
    if (recipe === "static-branches" && ["IfStatement", "ConditionalExpression"].includes(node.type)) {
      const test = constant(node.test);
      if (!test) return;
      const kept = test.value ? node.consequent : node.alternate;
      const removed = test.value ? node.alternate : node.consequent;
      let hoisted = false;
      if (removed) fullAncestor(removed, (child: any) => { if (child.type === "FunctionDeclaration" || child.type === "VariableDeclaration" && child.kind === "var") hoisted = true; });
      if (hoisted) { diagnostics.push("Kept a constant branch because removing it could change hoisted declarations."); return; }
      const text = kept ? source.slice(kept.start, kept.end) : ";";
      edits.push({ start: node.start, end: node.end, text: node.type === "ConditionalExpression" ? `(${text})` : text });
    }
  });
  // Outer rewrites win; overlapping AST ranges are never applied twice.
  const selected = edits.sort((a, b) => a.start - b.start || b.end - a.end).filter((edit, index, all) => !all.slice(0, index).some((other) => other.start <= edit.start && other.end >= edit.end));
  let result = source;
  for (const edit of selected.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  syntax(result);
  if (edits.length >= 5000) diagnostics.push("Transformation stopped at 5,000 candidate edits.");
  if (recipe === "remove-debugger") diagnostics.push("Removing debugger statements changes behavior. Timing checks and other protections remain.");
  return { source: result, changes: selected.length, diagnostics: [...new Set(diagnostics)] };
}

export interface CrossReference { name: string; access: "read" | "write" | "read/write" | "dynamic"; location: Location; definition?: Location; certainty: "lexical" | "module" | "unresolved" }
function byteOffsets(text: string) {
  const offsets = new Uint32Array(text.length + 1);
  for (let index = 0, byte = 0; index < text.length;) {
    const point = text.codePointAt(index)!, width = point > 65535 ? 2 : 1;
    offsets[index] = byte;
    if (width === 2) offsets[index + 1] = byte;
    byte += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
    index += width; offsets[index] = byte;
  }
  return offsets;
}
export function workspaceReferences(files: Evidence[]): { references: CrossReference[]; diagnostics: string[] } {
  const references: CrossReference[] = [], diagnostics: string[] = [];
  const exports = new Map<string, Map<string, Location>>();
  const parsed: { file: Evidence; text: string; offsets: Uint32Array; ast: any; manager: any }[] = [];
  let budget = 0;
  for (const file of files.filter((file) => file.format === "javascript")) {
    budget += file.bytes.length;
    if (file.bytes.length > 1024 * 1024 || budget > 16 * 1024 * 1024) { diagnostics.push(`Skipped ${file.name}: reference indexing budget reached.`); continue; }
    try {
      const text = decodeText(file.bytes), { ast, sourceType } = syntax(text);
      const manager = scopes(ast as any, { ecmaVersion: 2022, sourceType, optimistic: false });
      const offsets = byteOffsets(text);
      parsed.push({ file, text, offsets, ast, manager });
      const names = new Map<string, Location>();
      const local = new Map<string, any>();
      for (const scope of manager.scopes) if (scope.type === "module" || scope.type === "global") for (const variable of scope.variables) local.set(variable.name, variable.identifiers[0]);
      const location = (node: any): Location => ({ fileId: file.id, start: offsets[node.start], end: offsets[node.end] });
      for (const statement of (ast as any).body) {
        if (statement.type === "ExportNamedDeclaration") {
          const declaration = statement.declaration;
          if (declaration?.id) names.set(declaration.id.name, location(declaration.id));
          for (const declarator of declaration?.declarations || []) if (declarator.id.type === "Identifier") names.set(declarator.id.name, location(declarator.id));
          if (!statement.source) for (const specifier of statement.specifiers || []) { const node = local.get(specifier.local.name); if (node) names.set(specifier.exported.name || specifier.exported.value, location(node)); }
        }
        if (statement.type === "ExportDefaultDeclaration" && statement.declaration) names.set("default", location(statement.declaration));
      }
      exports.set(file.id, names);
    } catch (error) { diagnostics.push(`${file.name}: ${String(error)}`); }
  }
  for (const { file, text, offsets, ast, manager } of parsed) {
    const location = (node: any): Location => ({ fileId: file.id, start: offsets[node.start], end: offsets[node.end] });
    for (const scope of manager.scopes) for (const variable of scope.variables) {
      const node = variable.identifiers[0];
      let definition = node ? location(node) : undefined;
      let certainty: CrossReference["certainty"] = definition ? "lexical" : "unresolved";
      const importDef = variable.defs.find((definition: any) => definition.type === "ImportBinding");
      if (importDef) {
        const source = importDef.parent?.source?.value;
        let target: Evidence | undefined;
        if (typeof source === "string" && source.startsWith(".")) {
          const path = new URL(source, `https://evidence.invalid/${file.name}`).pathname.slice(1);
          target = files.find((candidate) => [path, `${path}.js`, `${path}/index.js`].includes(candidate.name));
        }
        const imported = importDef.node.type === "ImportDefaultSpecifier" ? "default" : importDef.node.imported?.name || importDef.node.imported?.value;
        const resolved = target && exports.get(target.id)?.get(imported);
        if (resolved) { definition = resolved; certainty = "module"; } else { definition = undefined; certainty = "unresolved"; }
      }
      for (const reference of variable.references) {
        if (references.length >= 5000) break;
        references.push({ name: variable.name, access: reference.isReadWrite() ? "read/write" : reference.isWrite() ? "write" : "read", location: location(reference.identifier), definition, certainty });
      }
    }
    fullAncestor(ast, (node: any) => {
      if (references.length < 5000 && node.type === "MemberExpression" && node.computed && node.property.type !== "Literal") references.push({ name: `${text.slice(node.object.start, node.object.end).slice(0, 80)}[…]`, access: "dynamic", location: location(node), certainty: "unresolved" });
    });
  }
  if (references.length >= 5000) diagnostics.push("Reference list capped at 5,000. Dynamic properties and re-exports may remain unresolved.");
  return { references, diagnostics };
}

export interface EndpointContract { endpoint: string; samples: number; statuses: number[]; fields: { path: string; types: string[]; samples: number }[]; evidenceIds: string[]; incomplete: boolean }
export function snapshotDifferences(a: Evidence, b: Evidence): { path: string; before?: string; after?: string }[] {
  const flatten = (file: Evidence) => {
    if (file.bytes.length > 1024 * 1024) throw new Error("Snapshot comparison is limited to 1 MiB per file.");
    const data = JSON.parse(decodeText(file.bytes));
    const values = new Map<string, string>();
    for (const [name, value] of Object.entries(data.heapUsage || {}).slice(0, 10)) values.set(`heap.${name}`, JSON.stringify(value));
    for (const [index, scope] of (Array.isArray(data.scopes) ? data.scopes : []).slice(0, 12).entries()) {
      for (const property of (Array.isArray(scope.properties) ? scope.properties : []).slice(0, 200)) values.set(`scope[${String(scope.name).slice(0, 100)}:${index}].${String(property.name).slice(0, 200)}`, JSON.stringify({ type: property.type, value: property.value, description: property.description, accessor: property.accessor }));
    }
    return values;
  };
  const before = flatten(a), after = flatten(b);
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).slice(0, 1000).map((path) => ({ path, before: before.get(path), after: after.get(path) }));
}
export function observedContracts(project: { files: Evidence[]; sessions?: import("./debug-types").DebugSession[] }): EndpointContract[] {
  const groups = new Map<string, EndpointContract>();
  let reviewed = 0, bodyBudget = 0;
  for (const session of project.sessions || []) for (const request of session.requests || []) {
    if (++reviewed > 5000) { for (const group of groups.values()) group.incomplete = true; return [...groups.values()]; }
    let endpoint: string;
    try { const url = new URL(request.url); endpoint = `${request.method} ${url.origin}${url.pathname}`; } catch { continue; }
    if (!groups.has(endpoint) && groups.size >= 1000) continue;
    const group = groups.get(endpoint) || { endpoint, samples: 0, statuses: [], fields: [], evidenceIds: [], incomplete: false };
    groups.set(endpoint, group); group.samples++;
    if (request.status !== undefined && !group.statuses.includes(request.status)) group.statuses.push(request.status);
    const file = project.files.find((file) => file.id === request.evidenceId);
    group.incomplete ||= Boolean(request.truncated || !file);
    if (!file || file.bytes.length > 1024 * 1024) continue;
    bodyBudget += file.bytes.length;
    if (bodyBudget > 8 * 1024 * 1024) { group.incomplete = true; continue; }
    if (!group.evidenceIds.includes(file.id)) group.evidenceIds.push(file.id);
    let value: unknown; try { value = JSON.parse(decodeText(file.bytes)); } catch { continue; }
    const seen = new Map<string, Set<string>>();
    let visited = 0;
    const walk = (item: any, path: string, depth: number) => {
      if (++visited > 2000 || depth > 6 || seen.size >= 200) { group.incomplete = true; return; }
      const type = item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
      const types = seen.get(path) || new Set(); types.add(type); seen.set(path, types);
      if (Array.isArray(item)) { if (item.length > 20) group.incomplete = true; item.slice(0, 20).forEach((element) => walk(element, `${path}[]`, depth + 1)); }
      else if (item && typeof item === "object") { const entries = Object.entries(item); if (entries.length > 100) group.incomplete = true; entries.slice(0, 100).forEach(([key, element]) => walk(element, `${path}.${key.slice(0, 100)}`, depth + 1)); }
    };
    walk(value, "$", 0);
    for (const [path, types] of seen) {
      let field = group.fields.find((field) => field.path === path);
      if (!field) { if (group.fields.length >= 200) { group.incomplete = true; continue; } field = { path, types: [], samples: 0 }; group.fields.push(field); }
      field.samples++; for (const type of types) if (!field.types.includes(type)) field.types.push(type);
    }
  }
  return [...groups.values()];
}
