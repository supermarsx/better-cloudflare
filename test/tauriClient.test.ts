import assert from "node:assert/strict";
import { test, afterEach } from "node:test";

import { TauriClient } from "../src/lib/tauri-client";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;

afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

test("isTauri returns true when window.__TAURI__ is present", () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  assert.equal(TauriClient.isTauri(), true);
});

test("isTauri returns false when window is missing", () => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
  assert.equal(TauriClient.isTauri(), false);
});
