import type { CapturedRequest } from "./debug-types";
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
}

function decodeHarContent(content: any): Uint8Array | undefined {
  if (!content || typeof content.text !== "string") return;
  try {
    if (content.encoding === "base64") {
      if (content.text.length > Math.ceil(HAR_BODY_LIMIT * 4 / 3) + 8) return;
      return Uint8Array.from(atob(content.text), (character) => character.charCodeAt(0));
    }
    return new TextEncoder().encode(content.text);
  } catch {
    return;
  }
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
  let truncated = entries.length > HAR_ENTRY_LIMIT;
  for (const [index, entry] of entries.slice(0, HAR_ENTRY_LIMIT).entries()) {
    const request = entry?.request;
    const response = entry?.response;
    const url = safeCapturedUrl(request?.url);
    if (!url || !/^https?:\/\//i.test(url) || !request || !response) continue;
    const requestId = `har:${index + 1}`;
    const resourceId = index + 1;
    const body = decodeHarContent(response.content);
    const contentSize = Number(response.content?.size);
    const bodyTruncated = Boolean(
      (body && body.length > HAR_BODY_LIMIT) || contentSize > HAR_BODY_LIMIT,
    );
    const responseBytes = body ? body.subarray(0, HAR_BODY_LIMIT) : undefined;
    const record: CapturedRequest = {
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
  return { requests, resources, truncated };
}
