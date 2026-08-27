import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BASE_PORT } from "../scripts/dev-port.mjs";
import {
  devUrlPortFromConfig,
  planBeforeDev,
} from "../scripts/tauri-before-dev.mjs";
import { routeTauriArguments } from "../scripts/tauri-cli.mjs";
import {
  buildTauriConfigOverride,
  judgeSpawnedDevServer,
  planTauriDev,
} from "../scripts/tauri-dev.mjs";

const devUrl = "http://localhost:3001";

test("the tauri:dev override repoints devUrl and disables beforeDevCommand", () => {
  assert.deepEqual(JSON.parse(buildTauriConfigOverride(undefined, devUrl)), {
    build: { beforeDevCommand: "", devUrl },
  });
  // Whitespace-only input counts as "no patch supplied".
  assert.deepEqual(JSON.parse(buildTauriConfigOverride("  \n", devUrl)), {
    build: { beforeDevCommand: "", devUrl },
  });
});

test("the tauri:dev override merges an existing TAURI_DEV_CONFIG patch", () => {
  const existing = JSON.stringify({
    identifier: "com.example.override",
    build: {
      beforeDevCommand: "npm run dev",
      devUrl: "http://localhost:3000",
      frontendDist: "../custom",
    },
  });
  assert.deepEqual(JSON.parse(buildTauriConfigOverride(existing, devUrl)), {
    identifier: "com.example.override",
    build: {
      frontendDist: "../custom",
      // The launcher's values win: Next.js is already running on `devUrl`.
      beforeDevCommand: "",
      devUrl,
    },
  });
});

test("the tauri:dev override rejects a patch that is not a JSON object", () => {
  for (const invalid of ["[]", "null", '"text"', "42"]) {
    assert.throws(
      () => buildTauriConfigOverride(invalid, devUrl),
      /TAURI_DEV_CONFIG must be a JSON object/,
      `expected ${invalid} to be rejected`,
    );
  }
  assert.throws(() => buildTauriConfigOverride("{not json", devUrl));
});

test("the tauri:dev launcher joins this app's running dev server", () => {
  // Next.js 16 refuses a second dev server per project directory, so a
  // server of ours already on the base port is joined, not duplicated.
  assert.equal(planTauriDev({ verdict: "ours" }), "reuse");
  assert.equal(planTauriDev({ ourServer: true }), "reuse");
  // A free base port is the plain start path.
  assert.equal(planTauriDev({ verdict: "absent" }), "start");
  assert.equal(planTauriDev({ ourServer: false }), "start");
  // Anything else on the base port is climbed past, never refused: the user
  // expects the window to open on the next free port.
  assert.equal(planTauriDev({ verdict: "foreign" }), "climb");
  assert.equal(planTauriDev({ verdict: "unresponsive" }), "climb");
});

test("the server the launcher spawned is trusted unless it is conclusively foreign", () => {
  assert.equal(judgeSpawnedDevServer("ours"), "proceed");
  // Still compiling, or slow: a warning, not a refusal - the child bound the
  // port itself, so it is this app by construction.
  assert.equal(judgeSpawnedDevServer("unresponsive"), "warn");
  assert.equal(judgeSpawnedDevServer("absent"), "warn");
  // A stranger's page on the port the child reported is the one thing the
  // window must never load.
  assert.equal(judgeSpawnedDevServer("foreign"), "refuse");
});

test("`npm run tauri dev` routes to the free-port launcher", () => {
  assert.deepEqual(routeTauriArguments(["dev"]), {
    launcher: "dev",
    args: [],
  });
  assert.deepEqual(routeTauriArguments(["dev", "--foo"]), {
    launcher: "dev",
    args: ["--foo"],
  });
});

test("every other tauri subcommand passes straight through to the CLI", () => {
  for (const argv of [["build"], [], ["--help"], ["info"], ["build", "dev"]]) {
    assert.deepEqual(
      routeTauriArguments(argv),
      { launcher: "cli", args: argv },
      `expected ${JSON.stringify(argv)} to pass through`,
    );
  }
});

test("the beforeDevCommand guard reuses, starts, or refuses", () => {
  assert.equal(planBeforeDev({ portFree: false, ourServer: true }), "reuse");
  assert.equal(planBeforeDev({ portFree: true, ourServer: true }), "reuse");
  assert.equal(planBeforeDev({ portFree: true, ourServer: false }), "start");
  // A foreign listener on the configured port must never receive the window.
  assert.equal(planBeforeDev({ portFree: false, ourServer: false }), "refuse");
});

test("the beforeDevCommand guard reads the port Tauri will actually load", () => {
  assert.equal(
    devUrlPortFromConfig(
      JSON.stringify({ build: { devUrl: "http://localhost:4321" } }),
    ),
    4321,
  );
  assert.equal(
    devUrlPortFromConfig(
      JSON.stringify({ build: { devUrl: "http://127.0.0.1:5000/" } }),
    ),
    5000,
  );
  // A devUrl without an explicit port is still a real port to Tauri.
  assert.equal(
    devUrlPortFromConfig(
      JSON.stringify({ build: { devUrl: "http://localhost" } }),
    ),
    80,
  );
  assert.equal(
    devUrlPortFromConfig(
      JSON.stringify({ build: { devUrl: "https://localhost" } }),
    ),
    443,
  );
  for (const configText of [
    JSON.stringify({}),
    JSON.stringify({ build: {} }),
    JSON.stringify({ build: { devUrl: "not a url" } }),
    JSON.stringify({ build: { devUrl: "http://localhost:99999" } }),
    "{not json",
  ]) {
    assert.equal(
      devUrlPortFromConfig(configText),
      DEFAULT_BASE_PORT,
      `expected the default port for ${configText}`,
    );
  }
});
