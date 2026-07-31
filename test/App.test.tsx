import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import App, { DnsWorkspaceSection } from "../src/App";
import { TauriClient } from "../src/lib/api/tauri-client";
import { storageManager } from "../src/lib/storage/storage";
import { resetRuntimeReportingForTests } from "../src/lib/errors/runtime-reporting";

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  cleanup();
  mock.restoreAll();
  resetRuntimeReportingForTests();
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

  const authScrollRegion = document.querySelector(
    '[data-auth-scroll-region="body"]',
  );
  assert.ok(authScrollRegion, "Missing auth scroll region");
  assert.match(authScrollRegion.className, /\bscrollbar-themed\b/);
  assert.match(authScrollRegion.className, /\bscroll-smooth\b/);
  assert.match(authScrollRegion.className, /\boverflow-y-auto\b/);
  assert.match(authScrollRegion.className, /\boverflow-x-hidden\b/);
  assert.ok(
    document
      .querySelector('[data-testid="app-viewport"]')
      ?.contains(authScrollRegion),
    "auth scroll region is not inside app viewport",
  );
});

test("DNS workspace render failure preserves shell recovery and can retry", async () => {
  mock.method(console, "error", () => {});
  let shouldThrow = true;
  let returnedToLogin = 0;

  function FragileDnsWorkspace() {
    if (shouldThrow) {
      throw new Error("DNS render failed api_key=workspace-secret");
    }
    return <div>DNS workspace recovered</div>;
  }

  render(
    <div>
      <div data-testid="persistent-titlebar">Titlebar remains</div>
      <DnsWorkspaceSection
        onReturnToLogin={() => {
          returnedToLogin += 1;
        }}
      >
        <FragileDnsWorkspace />
      </DnsWorkspaceSection>
    </div>,
  );

  assert.ok(screen.getByTestId("persistent-titlebar"));
  assert.ok(screen.getByTestId("dns-workspace-recovery"));
  assert.doesNotMatch(document.body.textContent ?? "", /workspace-secret/);

  fireEvent.click(screen.getByRole("button", { name: "Return to login" }));
  assert.equal(returnedToLogin, 1);

  shouldThrow = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry DNS workspace" }));
  await waitFor(() => assert.ok(screen.getByText("DNS workspace recovered")));
  assert.ok(screen.getByTestId("persistent-titlebar"));
});
