// Production-artifact test server. Mirrors nginx CSP and rejects non-read requests.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
const root = resolve("dist");
const nginx = await readFile("nginx.conf", "utf8");
const csp = nginx.match(/Content-Security-Policy "([^"]+)"/)[1];
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const testServer = http
  .createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/healthz") {
        res.end("ok");
        return;
      }
      const target = resolve(
        root,
        `.${decodeURIComponent(path === "/" ? "/index.html" : path)}`,
      );
      if (!target.startsWith(root + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const data = await readFile(target);
      res.setHeader(
        "Content-Type",
        types[extname(target)] || "application/octet-stream",
      );
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
testServer.listen(4173, "127.0.0.1", () =>
  console.log("Whidra production test server: http://127.0.0.1:4173"),
);
const shutdown = () => {
  const forceExit = setTimeout(() => {
    testServer.closeAllConnections?.();
    process.exit(0);
  }, 1500);
  forceExit.unref();
  testServer.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
