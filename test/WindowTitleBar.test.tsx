import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { cleanup, render, waitFor } from "@testing-library/react";
import { WindowTitleBar } from "../src/components/layout/WindowTitleBar";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";
import { storageManager } from "../src/lib/storage/storage";

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  cleanup();
  clearMocks();
  resetRuntimeReportingForTests();
  storageManager.setConfirmWindowClose(true);
  (globalThis as { window?: unknown }).window = originalWindow;
});

test("close preference failure restores the safest value, reports it, and remains retryable", async () => {
  const localWrites: boolean[] = [];
  const nativeWrites: boolean[] = [];
  let rejectDisable = true;
  const persistence = {
    persistLocal(enabled: boolean) {
      localWrites.push(enabled);
    },
    async persistNative(enabled: boolean) {
      nativeWrites.push(enabled);
      if (!enabled && rejectDisable) {
        rejectDisable = false;
        throw new Error("preference write failed token=titlebar-secret");
      }
    },
  };

  const firstResult = await WindowTitleBar.persistClosePreference(
    false,
    persistence,
  );

  assert.equal(firstResult, false);
  assert.deepEqual(nativeWrites, [false, true]);
  assert.deepEqual(localWrites, [true]);
  assert.match(
    getRuntimeDiagnostics()[0]?.label ?? "",
    /Save titlebar close confirmation preference/,
  );
  assert.match(
    getRuntimeDiagnostics()[0]?.message ?? "",
    /remains enabled for safety/i,
  );
  assert.match(getRuntimeDiagnostics()[0]?.message ?? "", /retry/i);
  assert.doesNotMatch(
    getRuntimeDiagnostics()[0]?.message ?? "",
    /titlebar-secret/,
  );
  assert.match(getRuntimeDiagnostics()[0]?.message ?? "", /\[redacted\]/);

  const retryResult = await WindowTitleBar.persistClosePreference(
    false,
    persistence,
  );

  assert.equal(retryResult, true);
  assert.deepEqual(nativeWrites, [false, true, false]);
  assert.deepEqual(localWrites, [true, false]);
});

test("unreadable close preference defaults to confirmation and sanitizes its diagnostic", () => {
  const result = WindowTitleBar.readConfirmWindowCloseSafely(() => {
    throw new Error("storage denied password=close-secret");
  });

  assert.equal(result, true);
  assert.match(
    getRuntimeDiagnostics()[0]?.label ?? "",
    /Read titlebar close confirmation preference/,
  );
  assert.doesNotMatch(
    getRuntimeDiagnostics()[0]?.message ?? "",
    /close-secret/,
  );
});

test("close-listener registration failure reports and persists the safe fallback", async () => {
  storageManager.setConfirmWindowClose(false);
  mockWindows("main");
  mockIPC((command) => {
    if (command === "plugin:window|is_always_on_top") return false;
    if (command === "plugin:event|listen") {
      throw new Error("listener unavailable api_key=listener-secret");
    }
    return null;
  });

  render(<WindowTitleBar />);

  await waitFor(() => {
    assert.equal(storageManager.getConfirmWindowClose(), true);
    assert.ok(
      getRuntimeDiagnostics().some((diagnostic) =>
        diagnostic.label?.includes("Register titlebar close-request listener"),
      ),
    );
  });

  const diagnostic = getRuntimeDiagnostics().find((candidate) =>
    candidate.label?.includes("Register titlebar close-request listener"),
  );
  assert.match(diagnostic?.message ?? "", /confirmation remains enabled/i);
  assert.doesNotMatch(diagnostic?.message ?? "", /listener-secret/);
  assert.match(diagnostic?.message ?? "", /\[redacted\]/);
});
