/**
 * `npm run dev` - starts `next dev --turbo` on a port that is genuinely free,
 * and proves the server it started is what a `localhost` client reaches.
 *
 *   node scripts/dev-server.mjs [extra next dev arguments]
 *
 * Why this exists: `next dev` silently auto-increments when its port is busy,
 * so the Tauri window, Playwright and the screenshot harness all kept talking to
 * a server that was no longer there - or to a different application entirely.
 * This launcher makes both the port and the server's identity first-class
 * results rather than assumptions:
 *
 *  - It picks a port that is free on every loopback address (`reservePort`),
 *    releases it immediately before the spawn, and climbs and respawns if
 *    Next.js still reports `EADDRINUSE`. The pre-check is an optimisation; the
 *    retry is the correctness guarantee.
 *  - It binds Next.js to exactly `127.0.0.1`, unless the caller passes their own
 *    `-H` / `--hostname`. An exact bind cannot be shared, so a server started
 *    later on the same port fails instead of taking this one's traffic.
 *  - It hands `next dev` a fresh identity token (see `scripts/dev-port.mjs`),
 *    which the root layout renders in development only.
 *  - Once Next.js reports the port it actually bound, it verifies the child: no
 *    other loopback address may answer on that port. A port shared with a
 *    stranger is abandoned for the next one, or - when pinned - is a hard
 *    failure.
 *  - Only a verified server is published to `node_modules/.cache/
 *    better-cloudflare/dev-server.json`, with its token, so later consumers can
 *    re-prove it before they join it.
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
  DEFAULT_ATTEMPTS,
  DEV_IDENTITY_ENV,
  DEV_SERVER_HOST,
  NoFreePortError,
  REPO_ROOT,
  basePortFrom,
  checkLoopbackOwnership,
  clearDevServerState,
  createDevIdentityToken,
  devServerUrl,
  isPinnedPort,
  isPortListening,
  probeDevServer,
  readRunningDevServer,
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
 * @typedef {object} DevServerVerification
 * @property {import("./dev-port.mjs").DevServerVerdict} verdict
 * @property {"structural" | "identity"} method How the verdict was reached.
 */

/**
 * @typedef {object} DevServerHandle
 * @property {number} port The port Next.js actually bound.
 * @property {string} url
 * @property {import("node:child_process").ChildProcess} child
 * @property {() => void} stop Terminates the dev server and its children.
 * @property {string} token The identity token this launch serves.
 * @property {DevServerVerification} verification
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
 * The hostname a caller passed through to `next dev`, or `null` when they did
 * not pass one.
 *
 * @param {readonly string[]} args
 * @returns {string | null}
 */
export function hostnameFromArguments(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-H" || argument === "--hostname") {
      return args[index + 1] ?? null;
    }
    for (const prefix of ["-H=", "--hostname="]) {
      if (argument.startsWith(prefix)) return argument.slice(prefix.length);
    }
  }
  return null;
}

/**
 * Proves the child this process just started is what a `localhost` client will
 * reach.
 *
 * On the default bind the proof is structural and immediate (see
 * `checkLoopbackOwnership`): the child holds `127.0.0.1` exactly, so if no other
 * loopback address answers, every client lands on it - even before the first
 * page compiles, and even while the app fails to render.
 *
 * When the caller chose the hostname, that address is not known to be
 * exclusive, so the child has to serve its identity token instead.
 *
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.token
 * @param {string | null} options.hostname The caller's `-H`, or `null`.
 * @param {number} [options.deadlineMs]
 * @returns {Promise<DevServerVerification>}
 */
export async function verifySpawnedDevServer({
  port,
  token,
  hostname,
  deadlineMs,
}) {
  if (hostname === null) {
    const structural = await checkLoopbackOwnership(port, {
      bindHost: DEV_SERVER_HOST,
    });
    // `absent` here means Next reported a port that does not answer yet. That
    // proves nothing either way, so the identity probe decides.
    if (structural !== "absent") {
      return { verdict: structural, method: "structural" };
    }
  }
  return {
    verdict: await probeDevServer(port, { expectedToken: token, deadlineMs }),
    method: "identity",
  };
}

/**
 * Starts one `next dev` attempt and waits until its real port is known.
 *
 * @param {number} requestedPort
 * @param {object} options
 * @param {readonly string[]} options.extraArguments
 * @param {NodeJS.ProcessEnv} options.env
 * @param {boolean} options.pinned
 * @param {string} options.token
 * @param {string | null} options.hostname
 * @returns {Promise<{ ok: true, handle: Omit<DevServerHandle, "token" | "verification"> } | { ok: false, retryable: boolean, error: Error }>}
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
      ...(options.hostname === null ? ["-H", DEV_SERVER_HOST] : []),
      ...options.extraArguments,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...options.env,
        PORT: String(requestedPort),
        [DEV_IDENTITY_ENV]: options.token,
      },
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
     * @param {{ ok: true, handle: Omit<DevServerHandle, "token" | "verification"> } | { ok: false, retryable: boolean, error: Error }} value
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
 * Starts the Next.js dev server on a free port, verifies that the child is what
 * a `localhost` client reaches, and resolves with it.
 *
 * A child that shares its port with a stranger on another loopback address is
 * never returned: unpinned, the launch moves to the next port; pinned, it fails.
 * Any other verdict is returned for the caller to judge - it can only be
 * inconclusive, never a stranger.
 *
 * @param {object} [options]
 * @param {readonly string[]} [options.extraArguments]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.basePort]
 * @param {number} [options.attempts]
 * @param {boolean} [options.pinned]
 * @param {number} [options.verifyDeadlineMs]
 * @returns {Promise<DevServerHandle>}
 */
export async function startNextDev(options = {}) {
  const env = options.env ?? process.env;
  const pinned = options.pinned ?? isPinnedPort(env);
  const basePort = options.basePort ?? basePortFrom(env);
  const attempts =
    options.attempts ?? (pinned ? PINNED_ATTEMPTS : DEFAULT_ATTEMPTS);
  const extraArguments = options.extraArguments ?? [];
  const hostname = hostnameFromArguments(extraArguments);
  // One token for the whole launch, so every attempt serves the same identity
  // and the one that succeeds is the one that gets recorded.
  const token = createDevIdentityToken();

  let candidate = basePort;
  /** @type {Error | null} */
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!pinned) {
      // Hold a port that is free on every loopback address, then let go right
      // before handing the number to Next.
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
      token,
      hostname,
    });

    if (!result.ok) {
      lastError = result.error;
      if (!result.retryable) throw result.error;
      if (pinned) {
        // Same port on purpose: a pinned run must not drift.
        await delay(PINNED_RETRY_DELAY_MS);
        continue;
      }
      candidate += 1;
      continue;
    }

    const verification = await verifySpawnedDevServer({
      port: result.handle.port,
      token,
      hostname,
      deadlineMs: options.verifyDeadlineMs,
    });

    if (verification.verdict === "foreign") {
      result.handle.stop();
      lastError = new Error(
        `Port ${result.handle.port} is shared with another server on a different ` +
          "loopback address, so a localhost client could reach that server " +
          "instead of this app's dev server. " +
          (pinned
            ? "The port is pinned, so the launch stops here. Free the port, or set PORT to another one."
            : "Moving to the next port."),
      );
      if (pinned) throw lastError;
      candidate = result.handle.port + 1;
      continue;
    }

    return { ...result.handle, token, verification };
  }

  throw lastError ?? new NoFreePortError(basePort, attempts, undefined);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Whether this process wrote the state file, and so owns removing it. */
let publishedState = false;

async function main() {
  // One recorded dev server per checkout. A second launch would otherwise
  // overwrite the first one's record - leaving that server running but unknown
  // to every tool that looks for it - and put two servers to work on the same
  // `.next/` build output. Next.js does not reliably stop that on its own:
  // measured here, a second `next dev` in the same checkout started and
  // accepted connections.
  const running = await readRunningDevServer();
  if (running !== null) {
    process.stderr.write(
      `[dev-server] this checkout's dev server is already running on ${running.url} ` +
        "(identity verified). Use that one, or stop it before starting another.\n",
    );
    process.exitCode = 1;
    return;
  }

  const handle = await startNextDev({
    extraArguments: process.argv.slice(2),
  });

  if (handle.verification.verdict === "ours") {
    // Re-checked just before publishing: a concurrent launch may have published
    // while this one was starting, and its record must not be overwritten.
    const raced = await readRunningDevServer();
    if (raced !== null) {
      handle.stop();
      process.stderr.write(
        `[dev-server] another launch of this checkout's dev server published ${raced.url} ` +
          "first; stopping this one.\n",
      );
      process.exitCode = 1;
      return;
    }
    writeDevServerState({
      port: handle.port,
      url: handle.url,
      pid: handle.child.pid,
      token: handle.token,
    });
    publishedState = true;
    process.stdout.write(
      `\n[dev-server] Next.js is serving ${handle.url} (port ${handle.port}), ` +
        "verified as this checkout's dev server.\n",
    );
  } else {
    process.stderr.write(
      `\n[dev-server] warning: Next.js is serving ${handle.url}, but it could ` +
        `not be verified as this checkout's dev server (${handle.verification.verdict}). ` +
        "It is not published for reuse, so tools that need a dev server will " +
        "start their own.\n",
    );
  }

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
    // Only a record this process wrote is this process's to remove. A launch
    // that fails before publishing - most often because this checkout's dev
    // server is already running, which Next.js refuses to duplicate - must
    // leave that server's record alone.
    if (publishedState) clearDevServerState();
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
