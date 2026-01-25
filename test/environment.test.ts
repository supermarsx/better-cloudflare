import assert from "node:assert/strict";
import { test, afterEach } from "node:test";

import { isDesktop, isWeb } from "../src/lib/environment";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;

afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

test("isDesktop/isWeb reflect tauri presence", () => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
  assert.equal(isDesktop(), false);
  assert.equal(isWeb(), true);

  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  assert.equal(isDesktop(), true);
  assert.equal(isWeb(), false);
});
