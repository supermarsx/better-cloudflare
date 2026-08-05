import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { ThemeToggle } from "../src/components/layout/ThemeToggle";
import i18n from "../src/i18n";
import { TauriClient } from "../src/lib/api/tauri-client";
import { resetRuntimeReportingForTests } from "../src/lib/errors/runtime-reporting";

const originalDocumentTheme = document.documentElement.dataset.theme;
const originalTauriInternalsDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "__TAURI_INTERNALS__",
);

function setTauriInternals(value: unknown): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value,
    writable: true,
  });
}

function clearTauriInternals(): void {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

function restoreTauriInternals(): void {
  if (originalTauriInternalsDescriptor) {
    Object.defineProperty(
      window,
      "__TAURI_INTERNALS__",
      originalTauriInternalsDescriptor,
    );
  } else {
    clearTauriInternals();
  }
}

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

beforeEach(async () => {
  await waitForI18nInitialization();
  await i18n.changeLanguage("en-US");
  window.localStorage.removeItem("theme");
  clearTauriInternals();
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  resetRuntimeReportingForTests();
  window.localStorage.removeItem("theme");
  restoreTauriInternals();
  if (originalDocumentTheme === undefined) {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = originalDocumentTheme;
  }
});

test("void is accepted as a stored theme and applied during hydration", async () => {
  assert.deepEqual(ThemeToggle.readStoredTheme({ getItem: () => "void" }), {
    theme: "void",
    storageAvailable: true,
  });
  window.localStorage.setItem("theme", "void");

  render(<ThemeToggle />);

  await waitFor(() => {
    assert.equal(document.documentElement.dataset.theme, "void");
    assert.equal(window.localStorage.getItem("theme"), "void");
  });

  fireEvent.keyDown(screen.getByRole("button", { name: "Select theme" }), {
    key: "Enter",
  });
  const voidOption = await screen.findByRole("menuitemradio", {
    hidden: true,
    name: "Void",
  });
  assert.equal(voidOption.getAttribute("aria-checked"), "true");
});

test("Void persists locally and hydrates with the expected desktop update", async () => {
  setTauriInternals({});
  window.localStorage.setItem("theme", "sunset");
  const desktopUpdates: Array<Record<string, unknown>> = [];
  mock.method(TauriClient, "updatePreferenceFields", async (fields) => {
    desktopUpdates.push(fields as Record<string, unknown>);
  });

  const initialRender = render(<ThemeToggle />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Select theme" }), {
    key: "Enter",
  });
  const options = await screen.findAllByRole("menuitemradio", {
    hidden: true,
  });
  assert.equal(options.length, 4);
  const [sunsetOption, nightOption, middayOption, voidOption] = options;
  assert.match(sunsetOption.textContent ?? "", /Sunset/);
  assert.match(nightOption.textContent ?? "", /Night/);
  assert.match(middayOption.textContent ?? "", /Midday/);
  assert.match(voidOption.textContent ?? "", /Void/);
  assert.equal(sunsetOption.getAttribute("aria-checked"), "true");
  assert.equal(voidOption.getAttribute("aria-checked"), "false");

  initialRender.unmount();
  assert.equal(ThemeToggle.persistTheme("void", window.localStorage), true);
  await TauriClient.updatePreferenceFields({ theme: "void" });
  render(<ThemeToggle />);

  await waitFor(() => {
    assert.equal(document.documentElement.dataset.theme, "void");
    assert.equal(window.localStorage.getItem("theme"), "void");
    assert.deepEqual(desktopUpdates, [{ theme: "void" }]);
  });

  fireEvent.keyDown(screen.getByRole("button", { name: "Select theme" }), {
    key: "Enter",
  });
  const selectedOptions = await screen.findAllByRole("menuitemradio", {
    hidden: true,
  });
  assert.equal(selectedOptions.length, 4);
  const selectedSunsetOption = selectedOptions[0];
  const selectedVoidOption = selectedOptions[3];
  assert.equal(selectedVoidOption.getAttribute("aria-checked"), "true");
  assert.equal(selectedSunsetOption.getAttribute("aria-checked"), "false");
});

test("stored prototype keys are rejected as themes", () => {
  for (const value of ["__proto__", "constructor", "toString"]) {
    assert.deepEqual(ThemeToggle.readStoredTheme({ getItem: () => value }), {
      theme: null,
      storageAvailable: true,
    });
  }
});

test("desktop prototype keys are rejected as themes", async () => {
  setTauriInternals({});
  mock.method(
    TauriClient,
    "getPreferences",
    async () => ({ theme: "constructor" }) as never,
  );

  render(<ThemeToggle />);

  await waitFor(() => {
    assert.equal(document.documentElement.dataset.theme, "sunset");
    assert.equal(window.localStorage.getItem("theme"), "sunset");
  });
});
