import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("desktop external URL opening has matching frontend, Rust, and capability wiring", () => {
  const packageJson = JSON.parse(
    readFileSync(`${root}/package.json`, "utf8"),
  ) as { dependencies?: Record<string, string> };
  const capability = JSON.parse(
    readFileSync(`${root}/src-tauri/capabilities/main.json`, "utf8"),
  ) as { permissions?: string[] };
  const mainSource = readFileSync(`${root}/src-tauri/src/main.rs`, "utf8");

  assert.match(
    packageJson.dependencies?.["@tauri-apps/plugin-shell"] ?? "",
    /^\^2(?:\.|$)/,
  );
  assert.ok(capability.permissions?.includes("shell:allow-open"));
  assert.match(mainSource, /\.plugin\(tauri_plugin_shell::init\(\)\)/);
});
