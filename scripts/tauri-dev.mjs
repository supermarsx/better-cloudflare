/**
 * `npm run tauri:dev` - opens the desktop window against this checkout's dev
 * server, whatever port it landed on.
 *
 *   node scripts/tauri-dev.mjs [extra tauri dev arguments]
 *
 * `src-tauri/tauri.conf.json` pins `devUrl` to `http://localhost:3000` and runs
 * `npm run dev` as `beforeDevCommand`. That is static JSON, so when Next.js ends
 * up on 3001 the window loads nothing. Rather than mutate tracked configuration,
 * this launcher:
 *
 *  1. joins a dev server only when it is provably this checkout's - recorded in
 *     the dev-server state file *and* still serving the identity token recorded
 *     with it, on every loopback address (see `scripts/dev-port.mjs`). Nothing
 *     else is ever joined: not another Next.js project, not another checkout of
 *     this one, and not whatever inherited a stale record's port. Otherwise it
 *     starts Next.js itself and waits until the child is proven to be what a
 *     `localhost` client reaches (see `scripts/dev-server.mjs`). Then it
 *  2. hands Tauri a config patch that repoints `devUrl` and clears
 *     `beforeDevCommand`, so Tauri does not start a second dev server on a
 *     different port.
 *
 * The patch goes through the CLI's `--config` flag, not the `TAURI_CONFIG`
 * environment variable that `.github/workflows/ci.yml` uses. They are not
 * interchangeable: `TAURI_CONFIG` is read by the `tauri-build` crate, which is
 * why CI can set it for a bare `cargo test`, but the Node CLI ignores it on the
 * way in and re-exports its own merged copy on the way out to cargo. Verified by
 * running both forms against `tauri dev`: `--config '{"identifier":123}'` is
 * rejected immediately, the environment variable is silently ignored. Setting
 * `TAURI_CONFIG` here would also risk `tauri-build` reading this partial patch
 * as a whole configuration.
 *
 * The window is loaded with this application's native command surface attached,
 * so it is only ever pointed at a server that passed one of those two proofs.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  basePortFrom,
  clearDevServerState,
  isPinnedPort,
  probeDevServer,
  readRunningDevServer,
  writeDevServerState,
} from "./dev-port.mjs";
import { startNextDev, terminateChild } from "./dev-server.mjs";

const TAURI_BIN = path.join(
  REPO_ROOT,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);

/**
 * Budget for the one probe this launcher makes without a token. With nothing
 * verified on record, nothing on the base port can be proven to be ours, so
 * that probe only decides what to tell the user - not worth waiting out a
 * compile for.
 */
const UNVERIFIED_PROBE_DEADLINE_MS = 3_000;

/**
 * Builds the `--config` patch, merging on top of any patch the caller already
 * supplied through `TAURI_DEV_CONFIG` so this launcher composes with a custom
 * override instead of fighting it.
 *
 * @param {string | undefined} existing A JSON object, or nothing.
 * @param {string} devUrl
 * @returns {string}
 */
export function buildTauriConfigOverride(existing, devUrl) {
  /** @type {Record<string, unknown>} */
  let patch = {};
  if (existing !== undefined && existing.trim().length > 0) {
    const parsed = JSON.parse(existing);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("TAURI_DEV_CONFIG must be a JSON object.");
    }
    patch = parsed;
  }

  const build =
    typeof patch.build === "object" && patch.build !== null
      ? /** @type {Record<string, unknown>} */ (patch.build)
      : {};

  return JSON.stringify({
    ...patch,
    build: {
      ...build,
      // Next.js is already running; Tauri must not start a second one.
      beforeDevCommand: "",
      devUrl,
    },
  });
}

/**
 * Decides what to do about the base port once no verified server was found.
 *
 * Only a server proven to be this checkout's is ever joined, and that proof
 * needs the token recorded at launch. A caller holding one can still pass an
 * `ours` verdict here; without one, `ours` is unreachable. A free base port is
 * the plain start path. Anything else on it - another application, another
 * checkout, a socket that accepts and says nothing - is climbed past: Next.js
 * takes the next port that is free on every loopback address (unless `PORT`
 * pins it, in which case `startNextDev` retries that exact port and fails
 * loudly). Kept pure so the decision is unit-testable without sockets.
 *
 * @param {object} state
 * @param {boolean} [state.ourServer] Legacy boolean form of `verdict`.
 * @param {import("./dev-port.mjs").DevServerVerdict} [state.verdict] What
 *   {@link probeDevServer} found on the base port.
 * @returns {"reuse" | "start" | "climb"} `climb` is `start` with a busy base
 *   port worth a note to the user.
 */
export function planTauriDev({ ourServer, verdict }) {
  const resolved = verdict ?? (ourServer ? "ours" : "absent");
  if (resolved === "ours") return "reuse";
  return resolved === "absent" ? "start" : "climb";
}

/**
 * Judges the server the launcher itself just spawned.
 *
 * `startNextDev` has already refused a child that shares its port with a
 * stranger on another loopback address, so on the default bind `foreign` never
 * reaches this function; it stays in the table so the table is total. What is
 * left is the inconclusive case, reachable only when the child's address could
 * not be proven exclusive and its page never answered. That is a warning, not a
 * refusal: no stranger answered on any address, so the worst outcome is a
 * window with nothing to show yet.
 *
 * @param {import("./dev-port.mjs").DevServerVerdict} verdict
 * @returns {"proceed" | "warn" | "refuse"}
 */
export function judgeSpawnedDevServer(verdict) {
  if (verdict === "ours") return "proceed";
  return verdict === "foreign" ? "refuse" : "warn";
}

/**
 * @typedef {object} DevTarget
 * @property {number} port
 * @property {string} url
 * @property {boolean} owned Whether this process started the server and must
 *   stop it on exit. A joined server belongs to whoever started it.
 * @property {import("node:child_process").ChildProcess | null} child
 * @property {() => void} stop
 */

/** Whether this process wrote the state file, and so owns removing it. */
let publishedState = false;

/**
 * @returns {Promise<DevTarget>}
 */
async function resolveDevTarget() {
  const running = await readRunningDevServer();
  if (running !== null) {
    process.stdout.write(
      `[tauri-dev] joining this checkout's dev server on ${running.url} ` +
        "(identity verified)\n",
    );
    return {
      port: running.port,
      url: running.url,
      owned: false,
      child: null,
      stop: () => {},
    };
  }

  const basePort = basePortFrom();
  const plan = planTauriDev({
    verdict: await probeDevServer(basePort, {
      deadlineMs: UNVERIFIED_PROBE_DEADLINE_MS,
    }),
  });
  if (plan !== "start") {
    process.stdout.write(
      isPinnedPort()
        ? `[tauri-dev] port ${basePort} is busy with something that could not ` +
            `be verified as this checkout's dev server, and PORT pins it; ` +
            `waiting for it to free up.\n`
        : `[tauri-dev] port ${basePort} is busy with something that could not ` +
            `be verified as this checkout's dev server; Next.js will take the ` +
            `next free port.\n`,
    );
  }

  const dev = await startNextDev();

  const judgement = judgeSpawnedDevServer(dev.verification.verdict);
  if (judgement === "refuse") {
    terminateChild(dev.child);
    throw new Error(
      `Refusing to start: ${dev.url} answered as something other than this ` +
        `application's dev server, even though Next.js (pid ${dev.child.pid}) ` +
        `reported binding port ${dev.port}. Something else is intercepting that ` +
        `port. Stop it, or set PORT to a different port, then try again.`,
    );
  }
  if (judgement === "warn") {
    process.stderr.write(
      `[tauri-dev] warning: ${dev.url} has not served the app yet (Next.js is ` +
        `probably still compiling); opening the window against it anyway.\n`,
    );
  }

  if (dev.verification.verdict === "ours") {
    writeDevServerState({
      port: dev.port,
      url: dev.url,
      pid: dev.child.pid,
      token: dev.token,
    });
    publishedState = true;
  }
  process.stdout.write(
    `\n[tauri-dev] Next.js is serving ${dev.url}; pointing the desktop window at it.\n`,
  );
  return {
    port: dev.port,
    url: dev.url,
    owned: true,
    child: dev.child,
    stop: dev.stop,
  };
}

async function main() {
  const dev = await resolveDevTarget();

  const tauri = spawn(
    process.execPath,
    [
      TAURI_BIN,
      "dev",
      "--config",
      buildTauriConfigOverride(process.env.TAURI_DEV_CONFIG, dev.url),
      ...process.argv.slice(2),
    ],
    {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    },
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    terminateChild(tauri);
    dev.stop();
    // A joined server's state record belongs to the process that started it.
    if (publishedState) clearDevServerState();
  };

  for (const signal of /** @type {NodeJS.Signals[]} */ ([
    "SIGINT",
    "SIGTERM",
  ])) {
    process.once(signal, shutdown);
  }
  dev.child?.once("exit", () => {
    process.stderr.write(
      "[tauri-dev] the Next.js dev server exited; stopping the desktop shell.\n",
    );
    shutdown();
  });

  await new Promise((resolve) => {
    tauri.once("exit", (code, signal) => {
      shutdown();
      process.exitCode =
        code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
      resolve(undefined);
    });
    tauri.once("error", (error) => {
      shutdown();
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
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
