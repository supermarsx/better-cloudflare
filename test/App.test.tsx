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
import i18n from "../src/i18n";
import { TauriClient } from "../src/lib/api/tauri-client";
import { storageManager } from "../src/lib/storage/storage";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";

const originalWindow = (globalThis as { window?: unknown }).window;
const originalDocumentTheme = document.documentElement.dataset.theme;

async function waitForI18nInitialization(): Promise<void> {
  if (i18n.isInitialized) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      i18n.off("initialized", onInitialized);
      reject(new Error("Timed out waiting for i18n initialization"));
    }, 5_000);
    const onInitialized = () => {
      clearTimeout(timeout);
      i18n.off("initialized", onInitialized);
      resolve();
    };
    i18n.on("initialized", onInitialized);
  });
}

function mockDesktopAppDependencies(
  getPreferences: () => Promise<unknown>,
): void {
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {},
  };
  mock.method(storageManager, "getCurrentSession", () => null);
  mock.method(storageManager, "getApiKeys", () => []);
  mock.method(TauriClient, "getEncryptionSettings", async () => ({
    iterations: 100000,
    keyLength: 256,
    algorithm: "AES-GCM",
  }));
  mock.method(TauriClient, "getPreferences", getPreferences);
  mock.method(TauriClient, "getPasskeyStatus", async () => ({
    registrationAvailable: false,
    authenticationAvailable: false,
    legacyCredentialsRequireReregistration: true,
    unavailableReason: "Passkeys are temporarily unavailable.",
  }));
  mock.method(TauriClient, "getApiKeys", async () => []);
  mock.method(TauriClient, "isTauri", () => true);
  mock.method(TauriClient, "biometricStatus", async () => ({
    available: false,
    biometricType: "none",
  }));
}

afterEach(() => {
  cleanup();
  mock.restoreAll();
  resetRuntimeReportingForTests();
  window.localStorage.removeItem("theme");
  window.localStorage.removeItem("locale");
  if (originalDocumentTheme === undefined) {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = originalDocumentTheme;
  }
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

test("desktop startup invokes get_preferences and hydrates valid theme and locale preferences", async () => {
  await waitForI18nInitialization();
  await i18n.changeLanguage("en-US");
  window.localStorage.setItem("theme", "sunset");
  window.localStorage.removeItem("locale");
  let preferenceLoads = 0;
  mockDesktopAppDependencies(async () => {
    preferenceLoads += 1;
    return { theme: "void", locale: "pt-PT" };
  });

  render(<App />);

  await waitFor(() => {
    assert.ok(preferenceLoads >= 1);
    assert.equal(document.documentElement.dataset.theme, "void");
    assert.equal(window.localStorage.getItem("theme"), "void");
    assert.equal(i18n.language, "pt-PT");
    assert.equal(window.localStorage.getItem("locale"), "pt-PT");
  });
  assert.ok(screen.getByTestId("app-viewport"));
});

test("desktop preference load failures are reported without breaking the app shell", async () => {
  await waitForI18nInitialization();
  await i18n.changeLanguage("en-US");
  window.localStorage.setItem("theme", "sunset");
  const nativeFailure =
    "state not managed for field `config` on command `get_preferences`";
  let preferenceLoads = 0;
  mockDesktopAppDependencies(async () => {
    preferenceLoads += 1;
    throw new Error(nativeFailure);
  });

  render(<App />);

  await waitFor(() => {
    assert.ok(preferenceLoads >= 1);
    const diagnostic = getRuntimeDiagnostics().find(
      ({ label }) => label === "Load desktop application preferences",
    );
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /state not managed for field `config`/);
  });
  assert.ok(screen.getByTestId("app-viewport"));
  assert.equal(document.documentElement.dataset.theme, "sunset");
  assert.equal(i18n.language, "en-US");
});
