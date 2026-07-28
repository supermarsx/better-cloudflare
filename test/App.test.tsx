import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import { cleanup, render, waitFor } from "@testing-library/react";

import App from "../src/App";
import { TauriClient } from "../src/lib/api/tauri-client";
import { storageManager } from "../src/lib/storage/storage";

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  cleanup();
  mock.restoreAll();
  (globalThis as { window?: unknown }).window = originalWindow;
});

test("App starts the login form in desktop mode when the Tauri bridge exists", async () => {
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {},
  };

  let webKeyLoads = 0;
  let desktopKeyLoads = 0;
  mock.method(storageManager, "getApiKeys", () => {
    webKeyLoads += 1;
    return [];
  });
  mock.method(TauriClient, "getEncryptionSettings", async () => ({
    iterations: 100000,
    keyLength: 256,
    algorithm: "AES-GCM",
  }));
  mock.method(TauriClient, "getPreferences", async () => ({}));
  mock.method(TauriClient, "getApiKeys", async () => {
    desktopKeyLoads += 1;
    return [];
  });
  mock.method(TauriClient, "biometricStatus", async () => ({
    available: false,
    biometricType: "none",
  }));

  render(<App />);

  await waitFor(() => {
    assert.equal(desktopKeyLoads, 1);
  });
  assert.equal(webKeyLoads, 0);
});
