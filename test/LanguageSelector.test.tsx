import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { LanguageSelector } from "../src/components/layout/LanguageSelector";
import { RuntimeErrorListener } from "../src/components/layout/RuntimeErrorListener";
import { Toaster } from "../src/components/ui/toaster";
import i18n from "../src/i18n";
import { TauriClient } from "../src/lib/api/tauri-client";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";

const originalWindow = (globalThis as { window?: unknown }).window;

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
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  resetRuntimeReportingForTests();
  globalThis.localStorage.removeItem("locale");
  (globalThis as { window?: unknown }).window = originalWindow;
});

test("LanguageSelector renders trigger and can open language menu", () => {
  render(<LanguageSelector />);

  const trigger = screen.getByRole("button");
  assert.ok(trigger);

  fireEvent.click(trigger);
  assert.ok(trigger.getAttribute("aria-haspopup"));
});

test("language persistence rolls back visibly on failure and remains retryable without exposing secrets", async () => {
  await i18n.changeLanguage("en-US");
  globalThis.localStorage.setItem("locale", "en-US");
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {},
  };

  const nativeLocales: string[] = [];
  mock.method(
    TauriClient,
    "updatePreferenceFields",
    async (fields: Record<string, unknown>) => {
      nativeLocales.push(String(fields.locale));
    },
  );

  const originalChangeLanguage = i18n.changeLanguage.bind(i18n);
  let rejectPortuguese = true;
  mock.method(i18n, "changeLanguage", async (...args) => {
    if (args[0] === "pt-PT" && rejectPortuguese) {
      rejectPortuguese = false;
      throw new Error("translation load failed token=language-secret");
    }
    return originalChangeLanguage(...args);
  });

  render(
    <>
      <RuntimeErrorListener />
      <LanguageSelector />
      <Toaster />
    </>,
  );

  await act(async () => {
    await LanguageSelector.changeLanguageTransaction("pt-PT");
  });

  await waitFor(() => {
    assert.equal(globalThis.localStorage.getItem("locale"), "en-US");
    assert.deepEqual(nativeLocales, ["pt-PT", "en-US"]);
    assert.match(
      getRuntimeDiagnostics()[0]?.message ?? "",
      /previous language was restored/i,
    );
  });

  assert.equal(i18n.language, "en-US");
  assert.match(document.body.textContent ?? "", /Retry the change/i);
  assert.doesNotMatch(document.body.textContent ?? "", /language-secret/);
  assert.doesNotMatch(
    getRuntimeDiagnostics()[0]?.message ?? "",
    /language-secret/,
  );
  assert.match(getRuntimeDiagnostics()[0]?.message ?? "", /\[redacted\]/);

  await act(async () => {
    await LanguageSelector.changeLanguageTransaction("pt-PT");
  });

  await waitFor(() => {
    assert.equal(globalThis.localStorage.getItem("locale"), "pt-PT");
    assert.equal(i18n.language, "pt-PT");
    assert.deepEqual(nativeLocales, ["pt-PT", "en-US", "pt-PT"]);
  });
});
