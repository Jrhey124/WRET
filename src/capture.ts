/** Strip live debugger handles and transport credentials from portable observations. */
import type { CapturedRequest, Observation } from "./debug-types";

export function portableObservation(value: any): any {
  if (Array.isArray(value)) return value.map(portableObservation);
  if (value && typeof value === "object") {
    if (
      typeof value.name === "string" &&
      /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|token|access_token|api[_-]?key|secret)$/i.test(
        value.name,
      )
    )
      return { name: value.name, value: "[redacted]" };
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            ![
              "objectId",
              "callFrameId",
              "scriptId",
              "target",
              "sessionId",
              "breakpointId",
              "requestId",
              "networkId",
              "frameId",
              "loaderId",
              "executionContextId",
              "targetId",
              "nodeId",
              "backendNodeId",
              "postData",
              "postDataEntries",
            ].includes(key),
        )
        .map(([key, data]) => [
          key,
          /^(url|documentURL|sourceMapURL|requestURL)$/i.test(key)
            ? safeCapturedUrl(data)
            : /^(authorization|proxy-authorization|cookie|set-cookie|token|password|api[_-]?key|access_token|secret)$/i.test(
            key,
          )
            ? "[redacted]"
            : portableObservation(data),
        ]),
    );
  }
  return value;
}

export function safeCapturedUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) return "";
  try {
    const url = new URL(value);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of [...url.searchParams.keys()])
      if (/^(authorization|auth|token|access_token|api[_-]?key|password|passwd|secret|session|sid)$/i.test(key))
        url.searchParams.set(key, "[redacted]");
    return url.href;
  } catch {
    return value;
  }
}

export function safeCapturedHeaders(value: unknown): { name: string; value: string }[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  return Object.entries(value as Record<string, unknown>).slice(0, 200).map(([name, item]) => ({
    name: name.slice(0, 256),
    value: /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(name)
      ? "[redacted]"
      : String(item).slice(0, 8192),
  }));
}

export function safeCapturedHeaderList(value: unknown): { name: string; value: string }[] | undefined {
  if (!Array.isArray(value)) return;
  return value.slice(0, 200).flatMap((header: any) =>
    header && typeof header.name === "string"
      ? [{
          name: header.name.slice(0, 256),
          value: /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(header.name)
            ? "[redacted]"
            : String(header.value ?? "").slice(0, 8192),
        }]
      : [],
  );
}

/** Fold ordered CDP and broker observations into safe, archiveable request records. */
export function updateCapturedRequests(
  requests: CapturedRequest[] = [],
  observation: Observation,
): CapturedRequest[] {
  const data = observation.data as any;
  if (!data || typeof data !== "object") return requests;
  const next = requests.slice();
  const findLatest = (requestId: string, targetType?: string) => {
    for (let i = next.length - 1; i >= 0; i--)
      if (next[i].requestId === requestId && (!targetType || next[i].targetType === targetType)) return i;
    return -1;
  };
  const create = (requestId: string, url: string, method: string, extra: Partial<CapturedRequest> = {}) => {
    const targetType = typeof data.targetType === "string" ? data.targetType : undefined;
    const prior = findLatest(requestId, targetType);
    const previous = prior >= 0 ? next[prior] : undefined;
    const id = `request:${observation.sequence}`;
    next.push({
      id: id.slice(0, 300),
      requestId: requestId.slice(0, 300),
      sequence: observation.sequence,
      url: safeCapturedUrl(url),
      method: method.slice(0, 32).toUpperCase(),
      startedAt: observation.time,
      targetType,
      ...extra,
      ...(previous ? { redirectFrom: previous.id } : {}),
    });
    return next.length - 1;
  };

  if (observation.kind === "network") {
    const method = String(data.event || "");
    const requestId = typeof data.requestId === "string" ? data.requestId : "";
    if (!requestId || next.length >= 50000) return requests;
    if (method === "Network.requestWillBeSent") {
      const request = data.request || {};
      const existing = findLatest(requestId, data.targetType);
      if (data.redirectResponse && existing >= 0) {
        const previous = next[existing];
        next[existing] = {
          ...previous,
          status: Number(data.redirectResponse.status) || undefined,
          mimeType: String(data.redirectResponse.mimeType || "").slice(0, 256),
          responseHeaders: safeCapturedHeaders(data.redirectResponse.headers),
          transferBytes: Number(data.redirectResponse.encodedDataLength) || undefined,
        };
      }
      create(requestId, request.url || data.documentURL || "", request.method || "GET", {
        resourceType: String(data.type || "Other").slice(0, 64),
        startTimestamp: Number.isFinite(data.timestamp) ? data.timestamp : undefined,
        requestHeaders: safeCapturedHeaders(request.headers),
        requestPayloadAvailable: Boolean(request.hasPostData || request.postData),
        initiator: data.initiator ? {
          type: String(data.initiator.type || "").slice(0, 64),
          url: safeCapturedUrl(data.initiator.url),
          line: Number.isFinite(data.initiator.lineNumber) ? data.initiator.lineNumber + 1 : undefined,
          column: Number.isFinite(data.initiator.columnNumber) ? data.initiator.columnNumber + 1 : undefined,
        } : undefined,
        frameId: typeof data.frameId === "string" ? data.frameId.slice(0, 300) : undefined,
      });
    } else {
      const index = findLatest(requestId, data.targetType);
      if (index < 0) return requests;
      const record = next[index];
      if (method === "Network.responseReceived") {
        const response = data.response || {};
        next[index] = {
          ...record,
          status: Number(response.status) || undefined,
          mimeType: String(response.mimeType || "").slice(0, 256),
          responseHeaders: safeCapturedHeaders(response.headers),
          transferBytes: Number(response.encodedDataLength) || undefined,
          url: safeCapturedUrl(response.url || record.url),
        };
      } else if (method === "Network.loadingFinished") {
        next[index] = {
          ...record,
          durationMs: Number.isFinite(data.timestamp) && Number.isFinite(record.startTimestamp)
            ? Math.max(0, Math.round((data.timestamp - record.startTimestamp!) * 1000))
            : undefined,
          transferBytes: Number(data.encodedDataLength) || record.transferBytes,
        };
      } else if (method === "Network.loadingFailed") {
        next[index] = { ...record, blockedReason: String(data.errorText || "Request failed").slice(0, 1000) };
      }
    }
    return next;
  }

  if (observation.kind === "request") {
    const requestId = typeof data.requestId === "string" ? data.requestId : "";
    const targetType = typeof data.targetType === "string" ? data.targetType : undefined;
    let index = requestId ? findLatest(requestId, targetType) : -1;
    if (index < 0) {
      if (next.length >= 50000) return requests;
      const id = requestId || `broker:${observation.sequence}`;
      next.push({
        id: `${targetType || "page"}:${id}`.slice(0, 300),
        requestId: id.slice(0, 300),
        sequence: observation.sequence,
        url: safeCapturedUrl(data.url),
        method: String(data.method || "GET").slice(0, 32).toUpperCase(),
        startedAt: observation.time,
        targetType,
      });
      index = next.length - 1;
    } else {
      next[index] = {
        ...next[index],
        url: safeCapturedUrl(data.url) || next[index].url,
        method: String(data.method || next[index].method).slice(0, 32).toUpperCase(),
      };
    }
  } else if (observation.kind === "response" || observation.kind === "blocked") {
    let index = -1;
    if (typeof data.requestId === "string") index = findLatest(data.requestId, data.targetType);
    if (index < 0)
      for (let i = next.length - 1; i >= 0; i--)
        if (next[i].url === safeCapturedUrl(data.url) && next[i].status === undefined && !next[i].blockedReason) { index = i; break; }
    if (index < 0) {
      if (next.length >= 50000) return requests;
      index = create(`broker:${observation.sequence}`, data.url || "", data.method || "GET");
    }
    next[index] = observation.kind === "response"
      ? { ...next[index], status: Number(data.status) || undefined, responseHeaders: safeCapturedHeaderList(data.headers), transferBytes: Number(data.bodyBytes) || undefined, truncated: Boolean(data.truncated), evidenceId: typeof data.evidenceId === "string" ? data.evidenceId : undefined }
      : { ...next[index], blockedReason: String(data.reason || "Blocked by network policy").slice(0, 1000) };
  } else if (observation.kind === "resource" && typeof data.requestId === "string") {
    const index = findLatest(data.requestId, data.targetType);
    if (index >= 0)
      next[index] = { ...next[index], evidenceId: typeof data.evidenceId === "string" ? data.evidenceId : next[index].evidenceId, truncated: Boolean(data.truncated), transferBytes: Number(data.bodyBytes) || next[index].transferBytes };
  }
  return next;
}
