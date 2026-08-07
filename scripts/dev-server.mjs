/**
 * `npm run dev` - starts `next dev --turbo` on a port that is genuinely free.
 *
 *   node scripts/dev-server.mjs [extra next dev arguments]
 *
 * Why this exists: `next dev` silently auto-increments when its port is busy,
 * so the Tauri window, Playwright and the screenshot harness all kept talking to
 * a server that was no longer there. This launcher makes the port a first-class
 * result rather than an assumption:
 *
 *  - It picks a port by *holding a real listener* (`reservePort`), releases it
 *    immediately before the spawn, and - crucially - climbs and respawns if
 *    Next.js still reports `EADDRINUSE`. The pre-check is an optimisation; the
 *    retry is the correctness guarantee.
 *  - It reads the port Next.js *actually* bound out of Next's own startup
 *    banner, so even if Next auto-increments behind our back the recorded port
 *    is the truthful one.
 *  - It publishes that port to `node_modules/.cache/better-cloudflare/
 *    dev-server.json` so later consumers join this server instead of guessing.
 *
 * When the port is pinned (`CI` is truthy, or `PORT` is set explicitly - which
 * is how Playwright hands an exact port down) nothing climbs: the launcher
 * retries the *same* port a few times to absorb a lingering socket, then fails
 * loudly. A pinned run that quietly moved would be the original bug again.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  basePortFrom,
  clearDevServerState,
  devServerUrl,
  DEFAULT_ATTEMPTS,
  isPinnedPort,
  isPortListening,
  NoFreePortError,
  REPO_ROOT,
  reservePort,
  writeDevServerState,
} from "./dev-port.mjs";

const NEXT_BIN = path.join(
  REPO_ROOT,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);

/** Next prints `- Local: http://localhost:3001` once it is actually bound. */
const LOCAL_URL_PATTERN =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/iu;
const PORT_TAKEN_PATTERN =
  /EADDRINUSE|address already in use|port \d+ is in use/iu;

/** How long to wait for Next to report a bound URL before giving up. */
const READY_TIMEOUT_MS = 180_000;
/** Grace period after the port answers TCP, in case the banner is late. */
const BANNER_GRACE_MS = 5_000;
/** A pinned port is retried this many times before the run fails. */
const PINNED_ATTEMPTS = 12;
const PINNED_RETRY_DELAY_MS = 400;

/**
 * @typedef {object} DevServerHandle
 * @property {number} port The port Next.js actually bound.
 * @property {string} url
 * @property {import("node:child_process").ChildProcess} child
 * @property {() => void} stop Terminates the dev server and its children.
 */

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @returns {void}
 */
export function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) return;

  if (process.platform === "win32") {
    spawnSync(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "taskkill.exe",
      ),
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    return;
  }
  child.kill("SIGTERM");
}

/**
 * Starts one `next dev` attempt and waits until its real port is known.
 *
 * @param {number} requestedPort
 * @param {object} options
 * @param {readonly string[]} options.extraArguments
 * @param {NodeJS.ProcessEnv} options.env
 * @param {boolean} options.pinned
 * @returns {Promise<{ ok: true, handle: DevServerHandle } | { ok: false, retryable: boolean, error: Error }>}
 */
async function spawnNextDev(requestedPort, options) {
  const child = spawn(
    process.execPath,
    [
      NEXT_BIN,
      "dev",
      "--turbo",
      "-p",
      String(requestedPort),
      ...options.extraArguments,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...options.env, PORT: String(requestedPort) },
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let output = "";

  return await new Promise((resolve) => {
    let done = false;
    /** @type {NodeJS.Timeout | undefined} */
    let graceTimer;
    /** @type {NodeJS.Timeout | undefined} */
    let readyTimer;
    /** @type {NodeJS.Timeout | undefined} */
    let listenPoll;

    /**
     * @param {{ ok: true, handle: DevServerHandle } | { ok: false, retryable: boolean, error: Error }} value
     */
    const settle = (value) => {
      if (done) return;
      done = true;
      clearTimeout(readyTimer);
      clearTimeout(graceTimer);
      clearInterval(listenPoll);
      resolve(value);
    };

    const succeed = (/** @type {number} */ port) => {
      if (options.pinned && port !== requestedPort) {
        terminateChild(child);
        settle({
          ok: false,
          retryable: false,
          error: new Error(
            `next dev was pinned to port ${requestedPort} but bound ${port}. ` +
              "Refusing to run with a dev server the rest of the stack cannot find.",
          ),
        });
        return;
      }
      settle({
        ok: true,
        handle: {
          port,
          url: devServerUrl(port),
          child,
          stop: () => terminateChild(child),
        },
      });
    };

    const observe = (/** @type {string} */ text) => {
      output = `${output}${text}`.slice(-64_000);
      const match = LOCAL_URL_PATTERN.exec(output);
      if (match) succeed(Number(match[1]));
    };

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      process.stdout.write(text);
      observe(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      process.stderr.write(text);
      observe(text);
    });

    child.once("error", (error) => {
      settle({ ok: false, retryable: false, error });
    });
    child.once("exit", (code, signal) => {
      settle({
        ok: false,
        retryable: PORT_TAKEN_PATTERN.test(output),
        error: new Error(
          `next dev exited (code ${code ?? "null"}, signal ${signal ?? "null"}) ` +
            `before reporting a bound port on ${requestedPort}.` +
            (PORT_TAKEN_PATTERN.test(output) ? " The port was taken." : ""),
        ),
      });
    });

    readyTimer = setTimeout(() => {
      terminateChild(child);
      settle({
        ok: false,
        retryable: false,
        error: new Error(
          `next dev never reported a bound URL within ${READY_TIMEOUT_MS} ms.`,
        ),
      });
    }, READY_TIMEOUT_MS);

    // Fallback: if a future Next release stops printing the banner we still
    // learn the port, as long as the requested one starts answering.
    listenPoll = setInterval(() => {
      void isPortListening(requestedPort).then((listening) => {
        if (!listening || done || graceTimer !== undefined) return;
        graceTimer = setTimeout(() => succeed(requestedPort), BANNER_GRACE_MS);
      });
    }, 500);
  });
}

/**
 * Starts the Next.js dev server on a free port and resolves once the port it
 * actually bound is known.
 *
 * @param {object} [options]
 * @param {readonly string[]} [options.extraArguments]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.basePort]
 * @param {number} [options.attempts]
 * @param {boolean} [options.pinned]
 * @returns {Promise<DevServerHandle>}
 */
export async function startNextDev(options = {}) {
  const env = options.env ?? process.env;
  const pinned = options.pinned ?? isPinnedPort(env);
  const basePort = options.basePort ?? basePortFrom(env);
  const attempts =
    options.attempts ?? (pinned ? PINNED_ATTEMPTS : DEFAULT_ATTEMPTS);
  const extraArguments = options.extraArguments ?? [];

  let candidate = basePort;
  /** @type {Error | null} */
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!pinned) {
      // Hold a real listener so a concurrent resolver cannot choose the same
      // port, then let go right before handing the number to Next.
      const reservation = await reservePort({
        basePort: candidate,
        attempts: attempts - attempt,
      });
      candidate = reservation.port;
      await reservation.release();
    }

    const result = await spawnNextDev(candidate, {
      extraArguments,
      env,
      pinned,
    });
    if (result.ok) return result.handle;

    lastError = result.error;
    if (!result.retryable) throw result.error;

    if (pinned) {
      // Same port on purpose: a pinned run must not drift.
      await delay(PINNED_RETRY_DELAY_MS);
      continue;
    }
    candidate += 1;
  }

  throw lastError ?? new NoFreePortError(basePort, attempts, undefined);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const handle = await startNextDev({
    extraArguments: process.argv.slice(2),
  });

  writeDevServerState({
    port: handle.port,
    url: handle.url,
    pid: handle.child.pid,
  });
  process.stdout.write(
    `\n[dev-server] Next.js is serving ${handle.url} (port ${handle.port})\n`,
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
