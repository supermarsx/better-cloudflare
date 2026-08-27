/**
 * `npm run tauri` - the Tauri CLI, with `dev` routed through the safe launcher.
 *
 *   node scripts/tauri-cli.mjs <tauri arguments>
 *
 * `src-tauri/tauri.conf.json` pins `devUrl` to `http://localhost:3000`. The
 * launcher in `scripts/tauri-dev.mjs` (`npm run tauri:dev`) works around that by
 * starting Next.js first and repointing Tauri at the port it actually bound,
 * but the natural invocation the Tauri docs teach - `npm run tauri dev` - used
 * to bypass it: the `tauri` npm script was the bare CLI, so the window kept
 * waiting on port 3000 while Next.js had climbed to 3001.
 *
 * This wrapper closes that gap. `dev` (the first non-flag argument) is handed to
 * `tauri-dev.mjs` with the remaining arguments; every other subcommand (`build`,
 * `info`, `icon`, `--help`, ...) is passed to the CLI untouched, so
 * `npm run tauri -- build` in `.github/workflows/autopublish.yml` keeps working.
 * Exit codes and termination signals are forwarded in both cases.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "./dev-port.mjs";
import { terminateChild } from "./dev-server.mjs";

const TAURI_BIN = path.join(
  REPO_ROOT,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);
const TAURI_DEV_LAUNCHER = path.join(REPO_ROOT, "scripts", "tauri-dev.mjs");

/**
 * Decides which program should handle a `tauri` invocation.
 *
 * The first argument that does not start with `-` is the subcommand. `dev`
 * goes to the launcher (without the `dev` token, which the launcher adds
 * itself); anything else, including no subcommand at all, goes to the CLI with
 * the argument list unchanged.
 *
 * @param {readonly string[]} argv Arguments after the script path.
 * @returns {{ launcher: "dev" | "cli", args: string[] }}
 */
export function routeTauriArguments(argv) {
  const subcommandIndex = argv.findIndex(
    (argument) => !argument.startsWith("-"),
  );
  if (subcommandIndex !== -1 && argv[subcommandIndex] === "dev") {
    return {
      launcher: "dev",
      args: [
        ...argv.slice(0, subcommandIndex),
        ...argv.slice(subcommandIndex + 1),
      ],
    };
  }
  return { launcher: "cli", args: [...argv] };
}

/**
 * @param {readonly string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const route = routeTauriArguments(argv);
  const script = route.launcher === "dev" ? TAURI_DEV_LAUNCHER : TAURI_BIN;

  const child = spawn(process.execPath, [script, ...route.args], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });

  const forward = () => terminateChild(child);
  for (const signal of /** @type {NodeJS.Signals[]} */ ([
    "SIGINT",
    "SIGTERM",
  ])) {
    process.once(signal, forward);
  }

  await new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      process.exitCode =
        code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
      resolve(undefined);
    });
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      resolve(undefined);
    });
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
