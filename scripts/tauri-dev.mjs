/**
 * `npm run tauri:dev` - opens the desktop window against the dev server that is
 * actually running, whatever port it landed on.
 *
 *   node scripts/tauri-dev.mjs [extra tauri dev arguments]
 *
 * `src-tauri/tauri.conf.json` pins `devUrl` to `http://localhost:3000` and runs
 * `npm run dev` as `beforeDevCommand`. That is static JSON, so when Next.js ends
 * up on 3001 the window loads nothing. Rather than mutate tracked configuration,
 * this launcher:
 *
 *  1. starts Next.js itself and waits until the port it *actually bound* is
 *     known (see `scripts/dev-server.mjs`) - unless this application's dev
 *     server already answers on the base port, in which case it is joined
 *     instead (Next.js 16 refuses to run two dev servers from one project
 *     directory, so a second one would abort anyway). Anything *else* on the
 *     base port is simply climbed past: Next.js takes the next free port and
 *     the window follows it. Then it
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
 * Because the URL is derived after the fact from a server that is already
 * listening, there is no window in which the port could be taken by someone
 * else: Tauri is told where the server *is*, never where it is expected to be.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  basePortFrom,
  clearDevServerState,
  devServerUrl,
  isPinnedPort,
  probeDevServer,
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
 * Decides whether to join a dev server that is already up or start a new one.
 *
 * Only *this* application's server is ever joined. Anything else on the base
 * port - a stranger's server, or a socket that accepts and says nothing - is
 * left alone and Next.js climbs past it to the next free port (unless `PORT`
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
 * Judges the server the launcher itself just spawned, once it has reported a
 * bound port. That process is ours by construction - Next.js bound the port
 * exclusively from this project directory - so the marker probe is a sanity
 * check, not a gatekeeper: an inconclusive answer (still compiling, slow disk)
 * is worth a warning, never a refusal. Only a *conclusive* stranger's page on
 * that port stops the launch, because that is the one outcome the desktop
 * window must never load.
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

/**
 * @returns {Promise<DevTarget>}
 */
async function resolveDevTarget() {
  const basePort = basePortFrom();
  const plan = planTauriDev({ verdict: await probeDevServer(basePort) });
  if (plan === "reuse") {
    const url = devServerUrl(basePort);
    process.stdout.write(
      `[tauri-dev] joining the dev server already on ${url}\n`,
    );
    return { port: basePort, url, owned: false, child: null, stop: () => {} };
  }
  if (plan === "climb") {
    process.stdout.write(
      isPinnedPort()
        ? `[tauri-dev] port ${basePort} is busy with something that is not ` +
            `this app's dev server, and PORT pins it; waiting for it to free up.\n`
        : `[tauri-dev] port ${basePort} is busy with something that is not ` +
            `this app's dev server; Next.js will take the next free port.\n`,
    );
  }

  const dev = await startNextDev();

  // The desktop shell is about to load this URL with the application's native
  // command surface attached to it. The server there is the child this process
  // spawned, on the port it reported binding, so it is ours by construction;
  // the marker probe is a sanity check. Only a conclusive stranger's page can
  // stop the launch - see `judgeSpawnedDevServer`.
  const judgement = judgeSpawnedDevServer(await probeDevServer(dev.port));
  if (judgement === "refuse") {
    terminateChild(dev.child);
    throw new Error(
      `Refusing to start: ${dev.url} answered with a page that is not this ` +
        `application's, even though Next.js (pid ${dev.child.pid}) reported ` +
        `binding port ${dev.port}. Something else is intercepting that port. ` +
        `Stop it, or set PORT to a different port, then try again.`,
    );
  }
  if (judgement === "warn") {
    process.stderr.write(
      `[tauri-dev] warning: ${dev.url} has not served the app yet (Next.js is ` +
        `probably still compiling); opening the window against it anyway.\n`,
    );
  }

  writeDevServerState({ port: dev.port, url: dev.url, pid: dev.child.pid });
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
    if (dev.owned) clearDevServerState();
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
    clearDevServerState();
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
