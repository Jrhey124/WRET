import { parse, serialize } from "parse5";
import postcss from "postcss";
import { decodeText, type Evidence } from "./model";

const MAX_SOURCE = 5 * 1024 * 1024;
const MAX_RESOURCES = 100;
const MAX_RESOURCE_BYTES = 20 * 1024 * 1024;
const mimeByExtension: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};
export interface StaticPreviewResult {
  document: string;
  diagnostics: string[];
  omittedResources: number;
  resourceIds: string[];
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(binary);
}
function assetPath(base: string, reference: string): string | undefined {
  if (!reference || reference.startsWith("#") || /^(?:[a-z]+:|\/\/)/i.test(reference)) return;
  try {
    const url = new URL(reference, `https://evidence.invalid/${base}`);
    const path = decodeURIComponent(url.pathname.slice(1));
    if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) return;
    const root = base.includes("/") ? base.split("/")[0] : "";
    if (root && path !== root && !path.startsWith(`${root}/`)) return;
    if (reference.startsWith("/")) return path;
    return path;
  } catch { return; }
}
function removeNode(parent: any, node: any) {
  const index = parent.childNodes?.indexOf(node) ?? -1;
  if (index >= 0) parent.childNodes.splice(index, 1);
}
function referencedFile(files: Map<string, Evidence>, from: string, reference: string) {
  const path = assetPath(from, reference);
  if (!path) return { path: undefined, file: undefined };
  let file = files.get(path);
  if (!file && reference.startsWith("/") && from.includes("/")) file = files.get(`${from.split("/")[0]}/${path}`);
  return { path: file?.name || path, file };
}

export function buildStaticPreview(files: Evidence[], html: Evidence): StaticPreviewResult {
  const diagnostics: string[] = [];
  let omittedResources = 0, resources = 0, resourceBytes = 0;
  const byPath = new Map(files.map((file) => [file.name, file]));
  const included = new Set<string>();
  const include = (file: Evidence): boolean => {
    if (included.has(file.id)) return true;
    if (resources >= MAX_RESOURCES || resourceBytes + file.bytes.length > MAX_RESOURCE_BYTES) return false;
    included.add(file.id); resources++; resourceBytes += file.bytes.length;
    return true;
  };
  const getText = (file: Evidence) => {
    if (file.bytes.length > MAX_SOURCE) throw new Error(`${file.name} exceeds the 5 MiB preview source limit.`);
    return decodeText(file.bytes);
  };
  const assetUrl = (from: string, reference: string): string | undefined => {
    const { path, file } = referencedFile(byPath, from, reference);
    const extension = path?.split(".").pop()?.toLowerCase() || "";
    const mime = mimeByExtension[extension];
    if (!path || !file || !mime || file.bytes.length > MAX_RESOURCE_BYTES) {
      omittedResources++;
      return;
    }
    if (!include(file)) { omittedResources++; return; }
    return `data:${mime};base64,${base64(file.bytes)}`;
  };
  const cssCache = new Map<string, string>();
  const css = (source: string, from: string, chain = new Set<string>()): string => {
    const root = postcss.parse(source, { from });
    let cssNodes = 0;
    root.walk(() => { if (++cssNodes > 100_000) throw new Error("CSS preview exceeds its 100,000-node safety limit."); });
    root.walkAtRules("import", (rule) => {
      const match = rule.params.match(/^(?:url\()?\s*["']?([^\s"')]+)["']?\s*\)?(.*)$/i);
      const resolved = match && referencedFile(byPath, from, match[1]);
      const path = resolved?.path, imported = resolved?.file;
      const media = match?.[2]?.trim();
      if (!path || !imported || imported.format !== "css" || chain.has(path) || imported.bytes.length > MAX_SOURCE || !include(imported)) {
        omittedResources++; rule.remove(); return;
      }
      try {
        const nested = new Set(chain); nested.add(path);
        const parsed = postcss.parse(cssCache.get(path) || css(getText(imported), path, nested), { from: path });
        cssCache.set(path, parsed.toString());
        if (media) rule.replaceWith(postcss.atRule({ name: "media", params: media, nodes: parsed.nodes }));
        else rule.replaceWith(...parsed.nodes);
      } catch { omittedResources++; rule.remove(); }
    });
    root.walkDecls((declaration) => {
      declaration.value = declaration.value.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_all, _quote, reference: string) => {
        if (reference.startsWith("#")) return `url("${reference}")`;
        const url = assetUrl(from, reference);
        return url ? `url("${url}")` : 'url("")';
      });
    });
    return root.toString();
  };

  if (html.format !== "html") throw new Error("Static preview is available for HTML evidence.");
  const document = parse(getText(html)) as any;
  const stack: Array<{ parent: any; node: any }> = [{ parent: null, node: document }];
  let inspected = 0;
  const forbidden = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "form", "base", "svg", "math", "video", "audio", "source", "track"]);
  while (stack.length && inspected++ < 100_000) {
    const { parent, node } = stack.pop()!;
    if (!node || typeof node !== "object") continue;
    const tag = node.tagName;
    if (tag && (forbidden.has(tag) || tag === "meta" && node.attrs?.some((attr: any) => attr.name === "http-equiv" && attr.value.toLowerCase() === "refresh"))) {
      if (tag === "script" || tag === "iframe" || tag === "frame" || tag === "frameset" || tag === "object" || tag === "embed") diagnostics.push(`Removed active or embedded content: <${tag}>.`);
      if (parent) removeNode(parent, node);
      continue;
    }
    if (tag === "style") {
      node.attrs = (node.attrs || []).filter((attr: any) => !attr.name.toLowerCase().startsWith("on") && !["srcdoc", "href", "src"].includes(attr.name.toLowerCase()));
      try {
        const value = css((node.childNodes || []).map((child: any) => child.value || "").join(""), html.name);
        node.childNodes = [{ nodeName: "#text", value, parentNode: node }];
      } catch { omittedResources++; if (parent) removeNode(parent, node); }
      continue;
    }
    if (tag === "link") {
      const rel = node.attrs?.find((attr: any) => attr.name === "rel")?.value.toLowerCase().split(/\s+/) || [];
      const href = node.attrs?.find((attr: any) => attr.name === "href")?.value;
      if (rel.includes("stylesheet") && href) {
        const { path, file: stylesheet } = referencedFile(byPath, html.name, href);
        try {
          if (!stylesheet || stylesheet.format !== "css" || stylesheet.bytes.length > MAX_SOURCE || !include(stylesheet)) throw new Error("missing");
          const style: any = { nodeName: "style", tagName: "style", attrs: [], namespaceURI: node.namespaceURI, childNodes: [{ nodeName: "#text", value: css(getText(stylesheet), path), parentNode: undefined }], parentNode: parent };
          style.childNodes[0].parentNode = style;
          const index = parent.childNodes.indexOf(node); parent.childNodes.splice(index, 1, style);
        } catch { omittedResources++; removeNode(parent, node); }
        continue;
      }
      if (parent) removeNode(parent, node);
      continue;
    }
    if (node.attrs) {
      const kept = [];
      for (const attr of node.attrs) {
        const name = attr.name.toLowerCase(), value = String(attr.value);
        if (name.startsWith("on") || ["srcdoc", "action", "formaction", "target", "ping", "srcset", "poster", "background", "manifest"].includes(name)) continue;
        if (name === "style") {
          try { attr.value = css(value, html.name); kept.push(attr); } catch { omittedResources++; }
        } else if (name === "src" && tag === "img") {
          const url = assetUrl(html.name, value); if (url) { attr.value = url; kept.push(attr); }
        } else if (name === "href" && tag !== "a" && tag !== "area") {
          continue;
        } else if (name === "href" && (tag === "a" || tag === "area")) {
          continue;
        } else if (["src", "xlink:href"].includes(name)) continue;
        else kept.push(attr);
      }
      node.attrs = kept;
    }
    if (node.childNodes) for (const child of [...node.childNodes].reverse()) stack.push({ parent: node, node: child });
  }
  if (stack.length) throw new Error("HTML preview exceeds its 100,000-node safety limit.");
  diagnostics.push("Static preview — scripts disabled. Script-generated content may be incomplete or blank.");
  diagnostics.push("External resources and navigation are blocked. Only imported raster images, fonts, and stylesheets are included.");
  if (omittedResources) diagnostics.push(`${omittedResources} local resource(s) were missing, unsupported, cyclic, or omitted by preview limits.`);
  const head = document.childNodes?.find((node: any) => node.tagName === "html")?.childNodes?.find((node: any) => node.tagName === "head");
  if (head) head.childNodes.unshift({ nodeName: "meta", tagName: "meta", attrs: [{ name: "http-equiv", value: "Content-Security-Policy" }, { name: "content", value: "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; connect-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline' data:;" }], namespaceURI: head.namespaceURI, childNodes: [], parentNode: head });
  return { document: serialize(document), diagnostics, omittedResources, resourceIds: [...included] };
}
