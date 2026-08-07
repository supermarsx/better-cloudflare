/**
 * Shared TCP port resolution for the whole dev stack.
 *
 *   node scripts/dev-port.mjs [--base 3000] [--host 127.0.0.1] [--attempts 100]
 *                             [--reuse|--no-reuse]
 *
 * Everything that needs "the dev port" - `npm run dev`, `npm run tauri:dev`,
 * the static export server, Playwright and the screenshot harness - resolves it
 * through this module so a single run cannot end up with two different answers.
 *
 * Two rules keep the result honest:
 *
 *  1. Availability is proven by actually binding a listener, never by a bare
 *     probe. `reservePort` hands back a live `net.Server`; whoever holds it owns
 *     the port until it is released, so two concurrent resolvers cannot agree on
 *     the same number.
 *  2. Where a number has to be handed to a child process (Next.js, Playwright's
 *     `webServer`), the reservation is released microseconds before the spawn
 *     and the *consumer* is expected to retry on `EADDRINUSE` rather than trust
 *     the pre-check. See `scripts/dev-server.mjs`.
 *
 * Determinism: when `PORT` is set explicitly, or when `CI` is truthy, the base
 * port is used exactly as given and nothing climbs. CI machines have no
 * collisions and their fixed ports are baked into workflow expectations.
 */

import { createServer, connect } from "node:net";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the search starts when nothing overrides it. */
export const DEFAULT_BASE_PORT = 3000;
/** Upper bound on the climb, so a wedged machine fails instead of spinning. */
export const DEFAULT_ATTEMPTS = 100;
const MIN_PORT = 1;
const MAX_PORT = 65535;

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const STATE_DIRECTORY = path.join(
  REPO_ROOT,
  "node_modules",
  ".cache",
  "better-cloudflare",
);

/**
 * Records the port `npm run dev` actually bound, so later consumers in the same
 * working tree (Playwright, the screenshot harness) can join an existing server
 * instead of starting a second one on a different port. It lives under
 * `node_modules/.cache`, which is already ignored by git.
 */
export const DEV_SERVER_STATE_FILE = path.join(
  STATE_DIRECTORY,
  "dev-server.json",
);

/**
 * @typedef {object} PortReservation
 * @property {number} port The bound port.
 * @property {import("node:net").Server} server The listener holding it.
 * @property {() => Promise<void>} release Stops holding the port.
 */

/**
 * @typedef {object} DevServerState
 * @property {number} port
 * @property {string} url
 * @property {number} [pid]
 * @property {string} [startedAt]
 */

export class NoFreePortError extends Error {
  /**
   * @param {number} basePort
   * @param {number} attempts
   * @param {string | undefined} host
   */
  constructor(basePort, attempts, host) {
    super(
      `No free TCP port was found in ${basePort}-${basePort + attempts - 1} on ` +
        `${host ?? "all interfaces"} after ${attempts} attempt(s). ` +
        "Free a port in that range, or set PORT to choose a different base.",
    );
    this.name = "NoFreePortError";
    this.basePort = basePort;
    this.attempts = attempts;
    this.host = host;
  }
}

/**
 * @param {unknown} value
 * @returns {number | null} The port, or `null` when `value` is not one.
 */
export function parsePort(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) return null;
  const port = Number(text);
  return port >= MIN_PORT && port <= MAX_PORT ? port : null;
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isTruthyFlag(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "0" && normalized !== "false";
}

/**
 * A pinned port is used verbatim: no probing, no climbing. This is what keeps CI
 * byte-for-byte deterministic and what lets a parent process hand an exact port
 * to a child.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isPinnedPort(env = process.env) {
  return parsePort(env.PORT) !== null || isTruthyFlag(env.CI);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} `PORT` when it is a valid port, otherwise {@link DEFAULT_BASE_PORT}.
 */
export function basePortFrom(env = process.env) {
  return parsePort(env.PORT) ?? DEFAULT_BASE_PORT;
}

/**
 * Attempts to take exclusive ownership of `port`.
 *
 * @param {number} port
 * @param {string} [host] Omit to listen on every interface, like `next dev`.
 * @returns {Promise<import("node:net").Server | null>} The live listener, or
 *   `null` when the port is taken or forbidden.
 */
export function bindPort(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (/** @type {NodeJS.ErrnoException} */ error) => {
      server.close();
      if (
        error.code === "EADDRINUSE" ||
        error.code === "EACCES" ||
        error.code === "EADDRNOTAVAIL"
      ) {
        resolve(null);
        return;
      }
      reject(error);
    };

    server.once("error", onError);
    server.listen(
      host === undefined
        ? { port, exclusive: true }
        : { host, port, exclusive: true },
      () => {
        server.removeListener("error", onError);
        // A reservation is short-lived; a late socket error must not crash the
        // process that is only holding the port.
        server.on("error", () => {});
        resolve(server);
      },
    );
  });
}

/**
 * Finds the first free port at or above `basePort` and *keeps holding it*.
 *
 * This is the race-free form: the caller owns the port until `release()`.
 *
 * @param {object} [options]
 * @param {number} [options.basePort]
 * @param {number} [options.attempts]
 * @param {string} [options.host]
 * @returns {Promise<PortReservation>}
 */
export async function reservePort(options = {}) {
  const basePort = options.basePort ?? DEFAULT_BASE_PORT;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const host = options.host;

  if (parsePort(basePort) === null) {
    throw new TypeError(`Not a usable base port: ${String(basePort)}`);
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError(`Port search attempts must be positive: ${attempts}`);
  }

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = basePort + offset;
    if (port > MAX_PORT) break;

    const server = await bindPort(port, host);
    if (server === null) continue;

    return {
      port,
      server,
      release: () =>
        new Promise((resolve) => {
          server.close(() => resolve());
        }),
    };
  }

  throw new NoFreePortError(basePort, attempts, host);
}

/**
 * Convenience wrapper that releases the reservation before returning.
 *
 * The number is stale the instant it is returned, so only use this when the
 * consumer retries on `EADDRINUSE` (see `scripts/dev-server.mjs`) or when the
 * port is handed straight to a process that binds it immediately.
 *
 * @param {Parameters<typeof reservePort>[0]} [options]
 * @returns {Promise<number>}
 */
export async function findFreePort(options = {}) {
  const reservation = await reservePort(options);
  await reservation.release();
  return reservation.port;
}

/**
 * @param {number} port
 * @param {string} [host]
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} Whether something is accepting connections there.
 */
export function isPortListening(port, host = "127.0.0.1", timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const settle = (/** @type {boolean} */ listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/**
 * @param {DevServerState} state
 * @returns {void}
 */
export function writeDevServerState(state) {
  try {
    mkdirSync(STATE_DIRECTORY, { recursive: true });
    writeFileSync(
      DEV_SERVER_STATE_FILE,
      `${JSON.stringify({ startedAt: new Date().toISOString(), ...state }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // The state file is an optimisation, never a requirement.
  }
}

/** @returns {DevServerState | null} */
export function readDevServerState() {
  try {
    const parsed = JSON.parse(readFileSync(DEV_SERVER_STATE_FILE, "utf8"));
    const port = parsePort(parsed?.port);
    if (port === null) return null;
    return {
      port,
      url: typeof parsed.url === "string" ? parsed.url : devServerUrl(port),
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      startedAt:
        typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
    };
  } catch {
    return null;
  }
}

/** @returns {void} */
export function clearDevServerState() {
  try {
    rmSync(DEV_SERVER_STATE_FILE, { force: true });
  } catch {
    // Nothing depends on the file being gone.
  }
}

/**
 * @param {number} port
 * @param {string} [host]
 * @returns {string}
 */
export function devServerUrl(port, host = "localhost") {
  return `http://${host}:${port}`;
}

/**
 * Returns a live recorded dev server, if one is genuinely still listening.
 *
 * @returns {Promise<DevServerState | null>}
 */
export async function readRunningDevServer() {
  const state = readDevServerState();
  if (state === null) return null;
  return (await isPortListening(state.port)) ? state : null;
}

/**
 * The single answer to "which port should this run use?".
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.basePort]
 * @param {number} [options.attempts]
 * @param {string} [options.host]
 * @param {boolean} [options.reuse] Join an already running `npm run dev`.
 * @returns {Promise<number>}
 */
export async function resolveDevPort(options = {}) {
  const env = options.env ?? process.env;
  if (options.reuse ?? true) {
    const running = await readRunningDevServer();
    if (running !== null) return running.port;
  }
  const basePort = options.basePort ?? basePortFrom(env);
  if (isPinnedPort(env)) return basePort;
  return await findFreePort({
    basePort,
    attempts: options.attempts,
    host: options.host,
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @param {readonly string[]} argv
 * @returns {{ basePort?: number, attempts?: number, host?: string, reuse: boolean }}
 */
export function parseCliArguments(argv) {
  /** @type {{ basePort?: number, attempts?: number, host?: string, reuse: boolean }} */
  const parsed = { reuse: true };

  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = splitArgument(argv[index]);
    const value = inlineValue ?? argv[index + 1];
    const consume = () => {
      if (inlineValue === undefined) index += 1;
      if (value === undefined) throw new Error(`${name} requires a value.`);
      return value;
    };

    switch (name) {
      case "--base":
      case "--port": {
        const port = parsePort(consume());
        if (port === null) throw new Error(`${name} must be a TCP port.`);
        parsed.basePort = port;
        break;
      }
      case "--attempts": {
        const attempts = Number(consume());
        if (!Number.isSafeInteger(attempts) || attempts < 1) {
          throw new Error("--attempts must be a positive integer.");
        }
        parsed.attempts = attempts;
        break;
      }
      case "--host":
        parsed.host = consume();
        break;
      case "--reuse":
        parsed.reuse = true;
        break;
      case "--no-reuse":
        parsed.reuse = false;
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }

  return parsed;
}

/**
 * @param {string} argument
 * @returns {[string, string | undefined]}
 */
function splitArgument(argument) {
  const equalsIndex = argument.indexOf("=");
  return equalsIndex === -1
    ? [argument, undefined]
    : [argument.slice(0, equalsIndex), argument.slice(equalsIndex + 1)];
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseCliArguments(process.argv.slice(2));
  resolveDevPort(options)
    .then((port) => {
      process.stdout.write(`${port}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : error}\n`,
      );
      process.exitCode = 1;
    });
}
