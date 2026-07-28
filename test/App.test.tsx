import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import App from "../src/App";
import { TauriClient } from "../src/lib/api/tauri-client";
import { storageManager } from "../src/lib/storage/storage";

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  cleanup();
  mock.restoreAll();
  (globalThis as { window?: unknown }).window = originalWindow;
});

test("App renders one global titlebar and no embedded chrome during desktop auth", async () => {
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
  mock.method(TauriClient, "getPasskeyStatus", async () => ({
    registrationAvailable: false,
    authenticationAvailable: false,
    legacyCredentialsRequireReregistration: true,
    unavailableReason: "Passkeys are temporarily unavailable.",
  }));
  mock.method(TauriClient, "getApiKeys", async () => {
    desktopKeyLoads += 1;
    return [];
  });
  mock.method(TauriClient, "isTauri", () => false);
  mock.method(TauriClient, "biometricStatus", async () => ({
    available: false,
    biometricType: "none",
  }));

  render(<App />);

  await waitFor(() => {
    assert.equal(desktopKeyLoads, 1);
  });
  assert.equal(webKeyLoads, 0);
  const titlebar = document.querySelector(".titlebar");
  assert.ok(titlebar);
  assert.equal(document.querySelectorAll(".titlebar").length, 1);
  assert.equal(titlebar.querySelectorAll("[data-tauri-drag-region]").length, 1);
  assert.equal(screen.queryByTestId("auth-window-handle"), null);
  assert.equal(titlebar.querySelectorAll(".lucide-minus").length, 1);
  assert.equal(titlebar.querySelectorAll(".lucide-square").length, 1);
  assert.equal(titlebar.querySelectorAll(".lucide-x").length, 1);
});
