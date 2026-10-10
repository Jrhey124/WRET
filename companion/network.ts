import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Only global unicast IPv6; reject transition mechanisms and documentation space.
  return (
    isIP(address) === 6 &&
    /^[23]/i.test(address) &&
    !/^200[12]:/i.test(address) &&
    !/^2001:(?:0:|db8:|10:|20:|2:)/i.test(address)
  );
}
export function approvedOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port !== ""
  )
    throw new Error("Approve an HTTP(S) origin using its standard port");
  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local")
  )
    throw new Error("Local destinations are prohibited");
  return url.origin;
}
export async function brokerRequest(input: any, approvals: Set<string>) {
  const url = new URL(input.url);
  if (!approvals.has(approvedOrigin(input.url)))
    throw new Error("Network destination has not been approved");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const hostAddresses = new Set(
    Object.values(networkInterfaces()).flatMap((entries) =>
      (entries || []).map((entry) => entry.address),
    ),
  );
  if (
    !addresses.length ||
    addresses.some(
      (a) => !publicAddress(a.address) || hostAddresses.has(a.address),
    )
  )
    throw new Error("Private, reserved, or host network destination rejected");
  const address = addresses[0];
  const method = String(input.method || "GET").toUpperCase();
  if (
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
      method,
    )
  )
    throw new Error("Unsupported request method");
  const body = input.postData ? Buffer.from(input.postData) : undefined;
  if (body && body.length > 1024 * 1024)
    throw new Error("Request body exceeds 1 MiB");
  const headers: Record<string, string> = {};
  headers["accept-encoding"] = "identity";
  for (const [key, value] of Object.entries(input.headers || {}))
    if (
      !/^(host|connection|upgrade|proxy-|transfer-encoding|content-length|accept-encoding)/i.test(
        key,
      ) &&
      typeof value === "string" &&
      !/[\r\n]/.test(value)
    )
      headers[key] = value;
  if (body) headers["content-length"] = String(body.length);
  return await new Promise<{
    status: number;
    headers: { name: string; value: string }[];
    body: string;
    capturedBody: string;
    bodyBytes: number;
    truncated: boolean;
  }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method,
        headers,
        timeout: 15000,
        lookup: (_host, _options, callback) =>
          callback(null, address.address, address.family),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 25 * 1024 * 1024) {
            response.destroy();
            reject(new Error("Response transfer exceeds 25 MiB"));
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: response.statusCode || 502,
            headers: Object.entries(response.headers)
              .filter(
                ([key]) =>
                  !/^(connection|transfer-encoding|content-length)$/i.test(key),
              )
              .flatMap(([name, value]) =>
                value === undefined
                  ? []
                  : Array.isArray(value)
                    ? value.map((item) => ({ name, value: item }))
                    : [{ name, value }],
              ),
            body: bytes.toString("base64"),
            capturedBody: bytes.subarray(0, 1024 * 1024).toString("base64"),
            bodyBytes: bytes.length,
            truncated: bytes.length > 1024 * 1024,
          });
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("Network request timed out")),
    );
    request.on("error", reject);
    request.end(body);
  });
}
