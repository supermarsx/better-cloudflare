/**
 * `beforeDevCommand` guard - makes the raw Tauri CLI path safe.
 *
 *   node scripts/tauri-before-dev.mjs
 *
 * `npm run tauri:dev` (`scripts/tauri-dev.mjs`) is the primary way to open the
 * desktop window in development: it starts Next.js first and tells Tauri the
 * port that was *actually* bound. But `src-tauri/tauri.conf.json` is static
 * JSON with `devUrl` pinned to `http://localhost:3000`, and the Tauri CLI can
 * be invoked around that launcher - `npx tauri dev`, `cargo tauri dev`, an IDE
 * plugin. On that path Tauri runs `beforeDevCommand` and then loads `devUrl`
 * regardless of what the command did. If the command were `npm run dev` and
 * 3000 were busy, Next.js would climb to 3001 while the window still opened
 * 3000: a blank page at best, and at worst whatever foreign process holds the
 * port, loaded with this application's native command surface attached.
 *
 * So this command never lets the static `devUrl` and the real server disagree:
 *
 *  - reuse:  something on the `devUrl` port already answers as *this* app's
 *            dev server - join it and exit 0, so Tauri proceeds.
 *  - start:  the port is free - start Next.js pinned to exactly that port and
 *            stay alive with it, because Tauri stops the `beforeDevCommand`
 *            process tree when it exits.
 *  - refuse: the port is taken by something else - exit 1 with a pointer at
 *            `npm run tauri:dev`. Tauri aborts when `beforeDevCommand` fails,
 *            so a stranger's server can never end up inside the window.
 *
 * Nothing here is imported from `tauri-dev.mjs`: that launcher clears
 * `beforeDevCommand` through `--config`, so the two never run together, and
 * keeping them apart avoids a circular import.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BASE_PORT,
  REPO_ROOT,
  bindPort,
  clearDevServerState,
  devServerUrl,
  isOurDevServer,
  parsePort,
  writeDevServerState,
} from "./dev-port.mjs";
import { startNextDev } from "./dev-server.mjs";

const TAURI_CONFIG_PATH = path.join(REPO_ROOT, "src-tauri", "tauri.conf.json");
const LOG_PREFIX = "[tauri-before-dev]";

/**
 * Decides what to do about the `devUrl` port.
 *
 * `ourServer` wins over `portFree`: a port cannot be both, but if a caller
 * passes contradictory flags the safe reading is the one that does not start a
 * second server.
 *
 * @param {object} state
 * @param {boolean} state.portFree Whether a listener could be bound there.
 * @param {boolean} state.ourServer Whether this app's dev server answers there.
 * @returns {"start" | "reuse" | "refuse"}
 */
export function planBeforeDev({ portFree, ourServer }) {
  if (ourServer) return "reuse";
  if (portFree) return "start";
  return "refuse";
}

/**
 * Reads the port Tauri will load from `build.devUrl`.
 *
 * Falls back to {@link DEFAULT_BASE_PORT} when the text is not JSON, has no
 * `devUrl`, or the URL carries no explicit port that Node can parse: the
 * fallback matches the tracked configuration, so a broken file still guards
 * the port Tauri would most plausibly open.
 *
 * @param {string} configText Contents of `src-tauri/tauri.conf.json`.
 * @returns {number}
 */
export function devUrlPortFromConfig(configText) {
  try {
    const parsed = JSON.parse(configText);
    const devUrl = parsed?.build?.devUrl;
    if (typeof devUrl !== "string") return DEFAULT_BASE_PORT;
    const url = new URL(devUrl);
    if (url.port.length > 0) return parsePort(url.port) ?? DEFAULT_BASE_PORT;
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return DEFAULT_BASE_PORT;
  }
}

/**
 * @param {number} port
 * @returns {string}
 */
export function refusalMessage(port) {
  return (
    `Port ${port} is in use by something that is not this app's dev server. ` +
    `Run "npm run tauri:dev" (it picks a free port automatically) or free ` +
    `port ${port}.`
  );
}

/**
 * @param {number} port
 * @returns {Promise<boolean>} Whether `port` could be bound just now.
 */
async function isPortFree(port) {
  const probe = await bindPort(port);
  if (probe === null) return false;
  await new Promise((resolve) => probe.close(() => resolve(undefined)));
  return true;
}

async function main() {
  const port = devUrlPortFromConfig(readFileSync(TAURI_CONFIG_PATH, "utf8"));

  // `PORT` pins `next dev`, but Tauri still loads `devUrl`. Honouring a PORT
  // that differs would start a server the window never opens.
  const pinnedPort = parsePort(process.env.PORT);
  if (pinnedPort !== null && pinnedPort !== port) {
    throw new Error(
      `PORT=${pinnedPort} does not match the devUrl port ${port} in ` +
        `src-tauri/tauri.conf.json; Tauri would still load port ${port}. ` +
        `Unset PORT, or run "npm run tauri:dev", which repoints devUrl to the ` +
        `port Next.js actually binds.`,
    );
  }

  const ourServer = await isOurDevServer(port);
  const portFree = ourServer ? false : await isPortFree(port);
  const plan = planBeforeDev({ portFree, ourServer });

  if (plan === "reuse") {
    process.stdout.write(
      `${LOG_PREFIX} joining the dev server already on ${devServerUrl(port)}\n`,
    );
    return;
  }

  if (plan === "refuse") {
    process.stderr.write(`${refusalMessage(port)}\n`);
    process.exitCode = 1;
    return;
  }

  const handle = await startNextDev({ basePort: port, pinned: true });
  writeDevServerState({
    port: handle.port,
    url: handle.url,
    pid: handle.child.pid,
  });
  process.stdout.write(
    `\n${LOG_PREFIX} Next.js is serving ${handle.url} (port ${handle.port})\n`,
  );

  /** @type {NodeJS.Signals[]} */
  const signals = ["SIGINT", "SIGTERM"];
  const forward = () => {
    handle.stop();
  };
  for (const signal of signals) process.once(signal, forward);

  await new Promise((resolve) => {
    handle.child.once("exit", (code, signal) => {
      clearDevServerState();
      process.exitCode =
        code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
      resolve(undefined);
    });
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    clearDevServerState();
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
