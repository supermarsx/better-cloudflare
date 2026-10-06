/**
 * The app has one name, and four places had to be told it.
 *
 * `tauri.conf.json` is the authority: it names the bundle, the executable and
 * the installer, and being JSON it cannot import a constant. Everything else
 * duplicates it, so this reads that file and fails when a copy disagrees.
 *
 * This is not hypothetical tidying. The window manager's title bar and the
 * app's own title bar sit inches apart, and they were showing "Better
 * Cloudflare DNS Manager" and "Better Cloudflare Console" while the product
 * was called "Better Cloudflare".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { APP_TITLE } from "../src/lib/app-identity";

function readJson(relative: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const tauriConfig = readJson("../src-tauri/tauri.conf.json");

test("the shared constant is the product name Tauri bundles under", () => {
  assert.equal(
    tauriConfig.productName,
    APP_TITLE,
    "APP_TITLE must match tauri.conf.json's productName, which names the bundle",
  );
});

test("the window title is the product name, not a longer description", () => {
  const app = tauriConfig.app as { windows?: Array<{ title?: unknown }> };
  const windows = app?.windows ?? [];
  assert.ok(windows.length > 0, "tauri.conf.json should configure a window");
  for (const [index, window] of windows.entries()) {
    assert.equal(
      window.title,
      APP_TITLE,
      `window ${index}: the OS title bar must read the product name`,
    );
  }
});

test("the in-app title bar renders the constant rather than its own wording", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../src/components/layout/WindowTitleBar.tsx", import.meta.url),
    ),
    "utf8",
  );
  assert.match(
    source,
    /\{APP_TITLE\}/,
    "the title bar should render APP_TITLE",
  );
  // The name is a proper noun. Sending it through `t()` is what produced
  // twelve catalogue entries that each invented a descriptive phrase — a
  // console, "the improved Cloudflare console" — instead of a name.
  assert.doesNotMatch(
    source,
    /t\(\s*"Better Cloudflare/,
    "the product name must not be translated",
  );
});

test("the web metadata agrees with the bundle", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../app/layout.tsx", import.meta.url)),
    "utf8",
  );
  assert.ok(
    source.includes(`default: "${APP_TITLE}"`),
    "the metadata title default must be the product name",
  );
  assert.ok(
    source.includes(`applicationName: "${APP_TITLE}"`),
    "applicationName must be the product name",
  );
});
