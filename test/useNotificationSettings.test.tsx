import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import {
  resetNotificationSettingsCache,
  useNotificationSettings,
} from "../src/hooks/dns/use-notification-settings";
import { TauriClient } from "../src/lib/api/tauri-client";
import { getRuntimeDiagnostics } from "../src/lib/errors/runtime-reporting";
import {
  clampNotificationSettings,
  createDefaultNotificationSettings,
  settingsEqual,
  type NotificationSettings,
} from "../src/lib/notifications/notification-settings";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;

type Backend = {
  stored: unknown;
  updates: NotificationSettings[];
  failUpdate: boolean;
  gate: (() => void) | null;
};

function installBackend(initial: unknown): Backend {
  const backend: Backend = {
    stored: initial,
    updates: [],
    failUpdate: false,
    gate: null,
  };
  mock.method(TauriClient, "notificationsGetSettings", async () =>
    clampNotificationSettings(backend.stored),
  );
  mock.method(
    TauriClient,
    "notificationsUpdateSettings",
    async (settings: NotificationSettings) => {
      backend.updates.push(settings);
      if (backend.gate) {
        await new Promise<void>((resolve) => {
          backend.gate = resolve;
        });
      }
      if (backend.failUpdate) throw new Error("prefs write failed");
      backend.stored = clampNotificationSettings(settings);
      return backend.stored as NotificationSettings;
    },
  );
  return backend;
}

beforeEach(() => {
  resetNotificationSettingsCache();
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  resetNotificationSettingsCache();
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

test("web build: defaults, no IPC, writes are local no-ops", async () => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
  const backend = installBackend({});
  const { result } = renderHook(() => useNotificationSettings());
  assert.equal(result.current.available, false);
  assert.deepEqual(
    result.current.settings,
    createDefaultNotificationSettings(),
  );
  act(() => {
    result.current.update({ service: { paused: true } });
  });
  assert.equal(result.current.settings.service.paused, true);
  assert.equal(result.current.saveState, "idle");
  assert.deepEqual(backend.updates, []);
});

test("load → normalized settings from the backend", async () => {
  installBackend({
    service: { recordPollMinutes: 30, expiryPollMinutes: 1 },
    expiry: { milestones: [45, 45, 900] },
  });
  const { result } = renderHook(() => useNotificationSettings());
  await waitFor(() =>
    assert.equal(result.current.settings.service.recordPollMinutes, 30),
  );
  assert.equal(result.current.settings.service.expiryPollMinutes, 60);
  assert.deepEqual(result.current.settings.expiry.milestones, [45]);
  assert.equal(result.current.saveState, "idle");
  assert.equal(result.current.error, null);

  // A second instance renders the confirmed values before its own read.
  const second = renderHook(() => useNotificationSettings());
  assert.equal(second.result.current.settings.service.recordPollMinutes, 30);
});

test("update → one write with the merged, clamped object; returned form applied", async () => {
  const backend = installBackend({ service: { recordPollMinutes: 30 } });
  const { result } = renderHook(() => useNotificationSettings());
  await waitFor(() =>
    assert.equal(result.current.settings.service.recordPollMinutes, 30),
  );

  let returned: NotificationSettings | undefined;
  act(() => {
    returned = result.current.update({
      expiry: { milestones: [90, 60, 45, 30, 14, 7, 3, 1] },
      zones: { exclude: ["zone-shipwright"] },
      retention: { maxItems: 1 },
    });
  });
  assert.equal(result.current.saveState, "saving");
  assert.deepEqual(returned?.expiry.milestones, [90, 60, 45, 30, 14, 7, 3, 1]);
  assert.equal(returned?.retention.maxItems, 100);
  // Optimistic state is visible immediately.
  assert.deepEqual(result.current.settings.zones.exclude, ["zone-shipwright"]);

  await waitFor(() => assert.equal(result.current.saveState, "saved"));
  assert.equal(backend.updates.length, 1);
  const sent = backend.updates[0];
  assert.equal(sent.version, 1);
  assert.equal(sent.service.recordPollMinutes, 30);
  assert.deepEqual(sent.expiry.milestones, [90, 60, 45, 30, 14, 7, 3, 1]);
  assert.deepEqual(sent.zones.exclude, ["zone-shipwright"]);
  assert.equal(sent.retention.maxItems, 100);
  assert.equal(settingsEqual(result.current.settings, sent), true);

  // A no-op update does not write again.
  act(() => {
    result.current.update({ zones: { exclude: ["zone-shipwright"] } });
  });
  assert.equal(backend.updates.length, 1);
});

test("rapid updates coalesce: only the latest object is written", async () => {
  const backend = installBackend({});
  const { result } = renderHook(() => useNotificationSettings());
  await waitFor(() => assert.equal(result.current.saveState, "idle"));
  backend.gate = () => {};
  act(() => {
    result.current.update({ service: { recordPollMinutes: 30 } });
  });
  await waitFor(() => assert.equal(backend.updates.length, 1));
  act(() => {
    result.current.update({ service: { recordPollMinutes: 60 } });
    result.current.update({ service: { paused: true } });
  });
  const release = backend.gate;
  backend.gate = null;
  act(() => release());
  await waitFor(() => assert.equal(result.current.saveState, "saved"));
  assert.equal(backend.updates.length, 2);
  assert.equal(backend.updates[1].service.recordPollMinutes, 60);
  assert.equal(backend.updates[1].service.paused, true);
  assert.equal(result.current.settings.service.recordPollMinutes, 60);
});

test("error → reporter called, previous settings kept", async () => {
  const backend = installBackend({ service: { recordPollMinutes: 30 } });
  const { result } = renderHook(() => useNotificationSettings());
  await waitFor(() =>
    assert.equal(result.current.settings.service.recordPollMinutes, 30),
  );
  const diagnosticsBefore = getRuntimeDiagnostics().length;
  backend.failUpdate = true;
  act(() => {
    result.current.update({ service: { recordPollMinutes: 60 } });
  });
  assert.equal(result.current.settings.service.recordPollMinutes, 60);
  await waitFor(() => assert.equal(result.current.saveState, "error"));
  assert.equal(result.current.settings.service.recordPollMinutes, 30);
  assert.equal(result.current.error, "prefs write failed");
  assert.ok(
    getRuntimeDiagnostics()
      .slice(diagnosticsBefore)
      .some((d) => d.label?.includes("Persist desktop notification settings")),
  );

  // Recovery: the next successful write clears the error.
  backend.failUpdate = false;
  act(() => {
    result.current.update({ service: { recordPollMinutes: 45 } });
  });
  await waitFor(() => assert.equal(result.current.saveState, "saved"));
  assert.equal(result.current.error, null);
  assert.equal(result.current.settings.service.recordPollMinutes, 45);
});

test("reset() → defaults written and applied", async () => {
  const backend = installBackend({
    service: { recordPollMinutes: 30, paused: true },
    quietHours: { enabled: true, start: "21:00", end: "06:00" },
  });
  const { result } = renderHook(() => useNotificationSettings());
  await waitFor(() =>
    assert.equal(result.current.settings.service.paused, true),
  );
  act(() => {
    result.current.reset();
  });
  assert.deepEqual(
    result.current.settings,
    createDefaultNotificationSettings(),
  );
  await waitFor(() => assert.equal(result.current.saveState, "saved"));
  assert.deepEqual(backend.updates.at(-1), createDefaultNotificationSettings());
});

test("reload() re-reads from the backend", async () => {
  const backend = installBackend({});
  const { result } = renderHook(() => useNotificationSettings());
  await waitFor(() => assert.equal(result.current.saveState, "idle"));
  backend.stored = { service: { paused: true } };
  await act(async () => {
    await result.current.reload();
  });
  assert.equal(result.current.settings.service.paused, true);
});
