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
 *     known (see `scripts/dev-server.mjs`), then
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
  clearDevServerState,
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

async function main() {
  const dev = await startNextDev();
  writeDevServerState({ port: dev.port, url: dev.url, pid: dev.child.pid });
  process.stdout.write(
    `\n[tauri-dev] Next.js is serving ${dev.url}; pointing the desktop window at it.\n`,
  );

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
    clearDevServerState();
  };

  for (const signal of /** @type {NodeJS.Signals[]} */ ([
    "SIGINT",
    "SIGTERM",
  ])) {
    process.once(signal, shutdown);
  }
  dev.child.once("exit", () => {
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
