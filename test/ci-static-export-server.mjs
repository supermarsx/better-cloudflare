import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ATTEMPTS,
  basePortFrom,
  isPinnedPort,
} from "../scripts/dev-port.mjs";

const host = "127.0.0.1";
const root = resolve(fileURLToPath(new URL("../out/", import.meta.url)));
const configuredBasePath =
  process.env.PLAYWRIGHT_STATIC_BASE_PATH?.trim() ?? "";
const basePath =
  configuredBasePath.length === 0 || configuredBasePath === "/"
    ? ""
    : `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`;
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

function requestPathname(requestUrl = "/") {
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(requestUrl, "http://localhost").pathname,
    );
  } catch {
    return null;
  }
  return pathname;
}

function exportPathname(pathname) {
  if (!basePath) return pathname;
  if (pathname === basePath || pathname === `${basePath}/`) return "/";
  if (!pathname.startsWith(`${basePath}/`)) return null;
  return pathname.slice(basePath.length);
}

function resolveRequestPath(pathname) {
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

function createStaticExportServer() {
  return createServer((request, response) => {
    const pathname = requestPathname(request.url);
    if (pathname === null) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Bad request");
      return;
    }
    const mountedPathname = exportPathname(pathname);
    if (mountedPathname === null) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const filePath = resolveRequestPath(mountedPathname);
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
}

/**
 * Binds the static export server, climbing to the next port whenever the one it
 * tried is already taken.
 *
 * The bind *is* the availability check, so there is no window between "this port
 * looked free" and "this port is mine" - unlike probing first and listening
 * afterwards, which races whenever two instances start at once.
 *
 * When the port is pinned (`CI` is truthy, or `PORT` was set explicitly) the
 * requested port is used verbatim and a collision fails loudly, because CI
 * expects a known address and silent drift is the bug this whole change exists
 * to remove.
 *
 * @param {object} [options]
 * @param {number} [options.basePort]
 * @param {number} [options.attempts]
 * @param {boolean} [options.pinned]
 * @returns {Promise<{ server: import("node:http").Server, port: number, url: string }>}
 */
export function startStaticExportServer(options = {}) {
  const basePort = options.basePort ?? basePortFrom(process.env);
  const pinned = options.pinned ?? isPinnedPort(process.env);
  const attempts = pinned ? 1 : (options.attempts ?? DEFAULT_ATTEMPTS);
  const server = createStaticExportServer();

  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.requestTimeout = 10_000;
  server.maxHeadersCount = 100;

  return new Promise((resolve, reject) => {
    let offset = 0;

    const onError = (/** @type {NodeJS.ErrnoException} */ error) => {
      if (error.code !== "EADDRINUSE") {
        reject(error);
        return;
      }
      offset += 1;
      if (offset >= attempts) {
        reject(
          new Error(
            pinned
              ? `Port ${basePort} is already in use and this run pinned it. ` +
                "Free the port, or unset PORT/CI to let the server climb."
              : `No free TCP port was found in ${basePort}-${basePort + attempts - 1} on ${host}.`,
          ),
        );
        return;
      }
      server.listen(basePort + offset, host);
    };

    server.on("error", onError);
    server.listen(basePort, host, () => {
      server.removeListener("error", onError);
      server.on("error", () => {});
      const port = /** @type {import("node:net").AddressInfo} */ (
        server.address()
      ).port;
      const url = `http://${host}:${port}${basePath || "/"}`;
      console.log(`Serving static export from ${root} at ${url}`);
      resolve({ server, port, url });
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const { server } = await startStaticExportServer();
    const shutdown = () => {
      server.close(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
