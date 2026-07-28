import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = 3000;
const root = resolve(fileURLToPath(new URL("../out/", import.meta.url)));
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function resolveRequestPath(requestUrl = "/") {
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(requestUrl, "http://localhost").pathname,
    );
  } catch {
    return null;
  }
  const candidate = resolve(root, `.${pathname}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;

  try {
    const stats = statSync(candidate);
    return stats.isDirectory() ? resolve(candidate, "index.html") : candidate;
  } catch {
    return pathname.endsWith("/")
      ? resolve(candidate, "index.html")
      : candidate;
  }
}

const server = createServer((request, response) => {
  const filePath = resolveRequestPath(request.url);
  if (!filePath) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }

  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  if (!stats.isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": stats.size,
    "content-type":
      contentTypes.get(extname(filePath).toLowerCase()) ??
      "application/octet-stream",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
});

server.headersTimeout = 5_000;
server.keepAliveTimeout = 1_000;
server.requestTimeout = 10_000;
server.maxHeadersCount = 100;

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(port, host, () => {
  console.log(`Serving static export from ${root} at http://${host}:${port}`);
});
