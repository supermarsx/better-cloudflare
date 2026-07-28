import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ThemeToggle } from "../src/components/layout/ThemeToggle";
import { useAiProviders } from "../src/hooks/ai/use-ai-chat";
import { readSavedLocale } from "../src/i18n";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";

afterEach(() => {
  cleanup();
  clearMocks();
  resetRuntimeReportingForTests();
});

test("theme storage failures preserve the default fallback and report context", () => {
  const { persistTheme, readStoredTheme } = ThemeToggle;
  const deniedStorage = {
    getItem() {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem() {
      throw new DOMException("full", "QuotaExceededError");
    },
  };

  assert.deepEqual(readStoredTheme(deniedStorage), {
    theme: null,
    storageAvailable: false,
  });
  assert.equal(persistTheme("sunset", deniedStorage), false);
  assert.equal(getRuntimeDiagnostics().length, 2);
  assert.match(
    getRuntimeDiagnostics()[0]?.label ?? "",
    /Save theme preference/,
  );
  assert.match(getRuntimeDiagnostics()[1]?.label ?? "", /Read saved theme/);
});

test("saved locale access failure falls back without throwing", () => {
  const resources = {
    "en-US": { translation: {} },
  } as Parameters<typeof readSavedLocale>[0];
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("locale blocked", "SecurityError");
    },
  });

  try {
    assert.equal(readSavedLocale(resources), undefined);
    assert.match(
      getRuntimeDiagnostics()[0]?.label ?? "",
      /Read saved language preference/,
    );
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalDescriptor);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }
});

test("automatic AI provider refresh rejection is contained and clears loading", async () => {
  mockIPC((command) => {
    if (command === "ai_list_providers") {
      throw new Error("provider refresh failed api_key=provider-secret");
    }
    return null;
  });

  function ProviderProbe() {
    const { loading, providers } = useAiProviders();
    return (
      <div>
        <span>{loading ? "loading" : "idle"}</span>
        <span>{providers.length}</span>
      </div>
    );
  }

  render(<ProviderProbe />);

  await waitFor(() => {
    assert.ok(screen.getByText("idle"));
    assert.match(
      getRuntimeDiagnostics()[0]?.label ?? "",
      /Refresh AI providers/,
    );
  });
  assert.doesNotMatch(
    getRuntimeDiagnostics()[0]?.message ?? "",
    /provider-secret/,
  );
});
