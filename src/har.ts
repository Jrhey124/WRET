import type { CapturedRequest, CaptureCoverage, BodyAvailability } from "./debug-types";
import { safeCapturedHeaderList, safeCapturedUrl } from "./capture";

export const HAR_LIMIT = 25 * 1024 * 1024;
export const HAR_ENTRY_LIMIT = 20000;
export const HAR_BODY_LIMIT = 1024 * 1024;

export interface HarResource {
  index: number;
  url: string;
  mimeType: string;
  bytes: Uint8Array;
  truncated: boolean;
}

export interface HarImport {
  requests: CapturedRequest[];
  resources: HarResource[];
  truncated: boolean;
  coverage: CaptureCoverage;
}

function decodeHarContent(content: any): { bytes?: Uint8Array; status: BodyAvailability } {
  if (!content || typeof content.text !== "string") return { status: "missing" };
  const text = content.text;
  if (content.encoding && content.encoding !== "base64") return { status: "invalid" };
  try {
    if (content.encoding === "base64") {
      const compact = text.replace(/\s/g, "");
      if ((compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact))) return { status: "invalid" };
      const partial = compact.length > Math.ceil(HAR_BODY_LIMIT / 3) * 4;
      const bounded = compact.slice(0, Math.ceil(HAR_BODY_LIMIT / 3) * 4);
      const bytes = Uint8Array.from(atob(bounded), c => c.charCodeAt(0));
      return { bytes: bytes.subarray(0, HAR_BODY_LIMIT), status: partial || bytes.length > HAR_BODY_LIMIT ? "truncated" : "retained" };
    }
    const bytes = new Uint8Array(Math.min(HAR_BODY_LIMIT, text.length * 3));
    const { read, written } = new TextEncoder().encodeInto(text, bytes);
    return { bytes: bytes.subarray(0, written), status: read < text.length ? "truncated" : "retained" };
  } catch { return { status: "invalid" }; }
}

export function captureCoverage(requests: CapturedRequest[], invalidEntries = 0, skippedEntries = 0): CaptureCoverage {
  return {
    importedRequests: requests.length,
    retainedBodies: requests.filter(r => r.bodyAvailability === "retained" || r.bodyAvailability === "truncated").length,
    absentBodies: requests.filter(r => r.bodyAvailability === "missing" || r.bodyAvailability === "deleted").length,
    truncatedBodies: requests.filter(r => r.bodyAvailability === "truncated").length,
    invalidBodies: requests.filter(r => r.bodyAvailability === "invalid").length,
    invalidEntries,
    omittedResources: requests.filter(r => r.bodyAvailability === "budget-omitted").length,
    skippedEntries,
  };
}

function initiator(entry: any): CapturedRequest["initiator"] {
  const value = entry._initiator;
  if (!value || typeof value !== "object") return;
  const frame = Array.isArray(value.stack?.callFrames) ? value.stack.callFrames[0] : value;
  const url = safeCapturedUrl(frame?.url);
  const line = Number.isSafeInteger(frame?.lineNumber) && frame.lineNumber >= 0 && frame.lineNumber < 10000000 ? frame.lineNumber + 1 : undefined;
  const column = Number.isSafeInteger(frame?.columnNumber) && frame.columnNumber >= 0 && frame.columnNumber < 10000000 ? frame.columnNumber + 1 : undefined;
  return { type: typeof value.type === "string" ? value.type.slice(0, 64) : undefined, url: /^https?:\/\//i.test(url) ? url : undefined, line, column };
}

/** Parse a HAR entirely offline, bounding retained bodies and redacting common secrets. */
export function parseHar(source: string): HarImport {
  if (new TextEncoder().encode(source).length > HAR_LIMIT)
    throw new Error("HAR file exceeds the 25 MiB import limit.");
  let archive: any;
  try {
    archive = JSON.parse(source);
  } catch {
    throw new Error("The selected file is not valid HAR JSON.");
  }
  const entries = archive?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("HAR log.entries is missing or invalid.");
  const requests: CapturedRequest[] = [];
  const resources: HarResource[] = [];
  let invalidEntries = 0;
  let truncated = entries.length > HAR_ENTRY_LIMIT;
  for (const [index, entry] of entries.slice(0, HAR_ENTRY_LIMIT).entries()) {
    const request = entry?.request;
    const response = entry?.response;
    const url = safeCapturedUrl(request?.url);
    let validUrl = false;
    try { validUrl = ["http:", "https:"].includes(new URL(url).protocol); } catch { /* malformed destinations are skipped, never contacted */ }
    if (!validUrl || !request || !response || typeof response !== "object" || Array.isArray(response)) { invalidEntries++; continue; }
    const requestId = `har:${index + 1}`;
    const resourceId = index + 1;
    const decoded = decodeHarContent(response.content);
    const body = decoded.bytes;
    const contentSize = Number(response.content?.size);
    const bodyTruncated = Boolean(
      decoded.status === "truncated",
    );
    const responseBytes = body ? body.subarray(0, HAR_BODY_LIMIT) : undefined;
    const record: CapturedRequest = {
      bodyAvailability: decoded.status,
      initiator: initiator(entry),
      id: requestId,
      requestId,
      sequence: index + 1,
      url,
      method: String(request.method || "GET").slice(0, 32).toUpperCase(),
      resourceType: String(entry._resourceType || "Other").slice(0, 64),
      startedAt: String(entry.startedDateTime || "").slice(0, 100),
      durationMs: Number.isFinite(entry.time) && entry.time >= 0 ? Math.round(entry.time) : undefined,
      status: Number.isSafeInteger(response.status) ? response.status : undefined,
      mimeType: String(response.content?.mimeType || "").slice(0, 256),
      transferBytes: Number.isFinite(contentSize) && contentSize >= 0 ? contentSize : undefined,
      requestHeaders: safeCapturedHeaderList(request.headers),
      responseHeaders: safeCapturedHeaderList(response.headers),
      requestPayloadAvailable: Boolean(request.postData?.text),
      truncated: bodyTruncated || (body === undefined && (contentSize > 0 || typeof response.content?.text === "string")),
      ...(body === undefined ? {} : { evidenceId: `har-resource:${resourceId}` }),
    };
    if (bodyTruncated) truncated = true;
    requests.push(record);
    if (responseBytes)
      resources.push({
        index: resourceId,
        url,
        mimeType: record.mimeType || "application/octet-stream",
        bytes: responseBytes,
        truncated: bodyTruncated,
      });
  }
  return { requests, resources, truncated, coverage: captureCoverage(requests, invalidEntries, Math.max(0, entries.length - HAR_ENTRY_LIMIT)) };
}
