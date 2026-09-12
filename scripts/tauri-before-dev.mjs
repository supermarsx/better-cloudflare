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
 *  - reuse:  the recorded dev server of *this checkout* is on the `devUrl`
 *            port and still serves the identity token recorded with it, on
 *            every loopback address - join it and exit 0, so Tauri proceeds.
 *  - start:  the port is free on every loopback address - start Next.js pinned
 *            to exactly that port and stay alive with it, because Tauri stops
 *            the `beforeDevCommand` process tree when it exits.
 *  - refuse: anything else holds the port - exit 1 with a pointer at
 *            `npm run tauri:dev`. Tauri aborts when `beforeDevCommand` fails,
 *            so a stranger's server can never end up inside the window.
 *
 * "Anything else" is meant literally. Another Next.js project on port 3000
 * serves `/_next/` just as this one does, and another checkout of this
 * repository serves the same application name; neither can produce the token.
 * Before identity tokens, this guard joined both.
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
  NoFreePortError,
  REPO_ROOT,
  clearDevServerState,
  parsePort,
  readRunningDevServer,
  reservePort,
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
 * @param {boolean} state.portFree Whether the port is free on every loopback address.
 * @param {boolean} state.ourServer Whether this checkout's verified dev server is there.
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
    `Port ${port} is in use by something that could not be verified as this ` +
    `checkout's dev server. Run "npm run tauri:dev" (it picks a free port ` +
    `automatically) or free port ${port}.`
  );
}

/**
 * @param {string} runningUrl
 * @param {number} port
 * @returns {string}
 */
export function runningElsewhereMessage(runningUrl, port) {
  return (
    `This checkout's dev server is already running on ${runningUrl}, but ` +
    `src-tauri/tauri.conf.json loads port ${port}, and this guard will not start ` +
    `a second dev server for the same checkout. Run "npm run tauri:dev", which ` +
    `points the window at the running server, or stop that server first.`
  );
}

/**
 * Whether `port` is genuinely free for a `localhost` client: bindable on the
 * address Next.js will use, with no stranger on any other loopback address.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function isPortFree(port) {
  try {
    const reservation = await reservePort({ basePort: port, attempts: 1 });
    await reservation.release();
    return true;
  } catch (error) {
    if (error instanceof NoFreePortError) return false;
    throw error;
  }
}

/** Whether this process wrote the state file, and so owns removing it. */
let publishedState = false;

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

  const running = await readRunningDevServer();
  if (running !== null && running.port !== port) {
    process.stderr.write(`${runningElsewhereMessage(running.url, port)}\n`);
    process.exitCode = 1;
    return;
  }

  const ourServer = running !== null;
  const portFree = ourServer ? false : await isPortFree(port);
  const plan = planBeforeDev({ portFree, ourServer });

  if (plan === "reuse") {
    process.stdout.write(
      `${LOG_PREFIX} joining this checkout's dev server on ${running?.url} ` +
        "(identity verified)\n",
    );
    return;
  }

  if (plan === "refuse") {
    process.stderr.write(`${refusalMessage(port)}\n`);
    process.exitCode = 1;
    return;
  }

  const handle = await startNextDev({ basePort: port, pinned: true });
  if (handle.verification.verdict === "ours") {
    writeDevServerState({
      port: handle.port,
      url: handle.url,
      pid: handle.child.pid,
      token: handle.token,
    });
    publishedState = true;
  }
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
      if (publishedState) clearDevServerState();
      process.exitCode =
        code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
      resolve(undefined);
    });
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (publishedState) clearDevServerState();
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
