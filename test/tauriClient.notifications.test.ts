import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  NOTIFICATIONS_CHANGED_EVENT,
  NOTIFICATIONS_DESKTOP_ONLY,
  NOTIFICATIONS_STATUS_EVENT,
  TauriClient,
  type NotificationsChangedPayload,
} from "../src/lib/api/tauri-client";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../src/lib/notifications/notification-settings";

type Call = { command: string; payload: Record<string, unknown> | undefined };

const originalWindow = (globalThis as unknown as { window?: unknown }).window;

function desktop(): void {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
}

function recordCalls(
  respond: (command: string, payload?: Record<string, unknown>) => unknown,
): Call[] {
  const calls: Call[] = [];
  mockIPC((command, payload) => {
    const args = payload as Record<string, unknown> | undefined;
    calls.push({ command, payload: args });
    return respond(command, args);
  });
  return calls;
}

afterEach(() => {
  clearMocks();
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

test("every notifications method throws a clear error off desktop", async () => {
  // No `mockIPC` here: installing it would define `window.__TAURI_INTERNALS__`
  // and turn the environment into a desktop one.
  (globalThis as unknown as { window?: unknown }).window = undefined;
  const attempts: Array<() => Promise<unknown>> = [
    () => TauriClient.notificationsStart("k"),
    () => TauriClient.notificationsStop(),
    () => TauriClient.notificationsStatus(),
    () => TauriClient.notificationsCheckNow(),
    () => TauriClient.notificationsList(),
    () => TauriClient.notificationsUnreadCount(),
    () => TauriClient.notificationsMarkRead(["a"]),
    () => TauriClient.notificationsMarkAllRead(),
    () => TauriClient.notificationsArchive(["a"]),
    () => TauriClient.notificationsUnarchive(["a"]),
    () => TauriClient.notificationsArchiveAllRead(),
    () => TauriClient.notificationsDismiss(["a"]),
    () => TauriClient.notificationsClearArchived(),
    () => TauriClient.notificationsReconfigure(),
    () => TauriClient.notificationsPause(),
    () => TauriClient.notificationsResume(),
    () => TauriClient.notificationsGetSettings(),
    () =>
      TauriClient.notificationsUpdateSettings({
        ...DEFAULT_NOTIFICATION_SETTINGS,
      }),
    () => TauriClient.notificationsResetState({ inbox: true }),
    () => TauriClient.notificationsZoneSummary(),
    () => TauriClient.onNotificationsChanged(() => {}),
    () => TauriClient.onNotificationsStatus(() => {}),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt, { message: NOTIFICATIONS_DESKTOP_ONLY });
  }
  assert.equal(TauriClient.hasOsNotifications, true);
});

test("lifecycle and inbox commands use the camelCase Tauri contract", async () => {
  desktop();
  const status = { running: true, enabled: true, paused: false, unread: 2 };
  const calls = recordCalls((command) => {
    if (command.startsWith("notifications_")) {
      if (command === "notifications_list") return [{ id: "n1" }];
      if (command === "notifications_unread_count") return 2;
      if (command === "notifications_stop") return undefined;
      if (command === "notifications_reset_state") return undefined;
      if (command === "notifications_zone_summary") return [];
      if (
        [
          "mark_read",
          "mark_all_read",
          "archive",
          "unarchive",
          "archive_all_read",
          "dismiss",
          "clear_archived",
        ].some((suffix) => command === `notifications_${suffix}`)
      )
        return 1;
      return status;
    }
    throw new Error(`Unexpected Tauri command: ${command}`);
  });

  assert.deepEqual(
    await TauriClient.notificationsStart("tok", "me@x.test"),
    status,
  );
  await TauriClient.notificationsStart("tok");
  await TauriClient.notificationsStop();
  await TauriClient.notificationsStatus();
  await TauriClient.notificationsCheckNow("records");
  await TauriClient.notificationsCheckNow();
  assert.deepEqual(await TauriClient.notificationsList(), [{ id: "n1" }]);
  await TauriClient.notificationsList({
    scope: "archived",
    kind: "record_change",
    zoneId: "z1",
    limit: 50,
    before: "2026-08-26T00:00:00Z",
  });
  assert.equal(await TauriClient.notificationsUnreadCount(), 2);
  assert.equal(await TauriClient.notificationsMarkRead(["a", "b"]), 1);
  await TauriClient.notificationsMarkRead(["a"], false);
  await TauriClient.notificationsMarkAllRead();
  await TauriClient.notificationsArchive(["a"]);
  await TauriClient.notificationsUnarchive(["a"]);
  await TauriClient.notificationsArchiveAllRead();
  await TauriClient.notificationsDismiss(["a"]);
  await TauriClient.notificationsClearArchived();
  await TauriClient.notificationsReconfigure();
  await TauriClient.notificationsPause();
  await TauriClient.notificationsResume();
  await TauriClient.notificationsResetState({
    expiryLedger: true,
    snapshots: false,
  });
  await TauriClient.notificationsZoneSummary();

  assert.deepEqual(calls, [
    {
      command: "notifications_start",
      payload: { apiKey: "tok", email: "me@x.test" },
    },
    { command: "notifications_start", payload: { apiKey: "tok", email: null } },
    { command: "notifications_stop", payload: {} },
    { command: "notifications_status", payload: {} },
    { command: "notifications_check_now", payload: { kind: "records" } },
    { command: "notifications_check_now", payload: { kind: null } },
    { command: "notifications_list", payload: { query: { scope: "all" } } },
    {
      command: "notifications_list",
      payload: {
        query: {
          scope: "archived",
          kind: "record_change",
          zoneId: "z1",
          limit: 50,
          before: "2026-08-26T00:00:00Z",
        },
      },
    },
    { command: "notifications_unread_count", payload: {} },
    {
      command: "notifications_mark_read",
      payload: { ids: ["a", "b"], read: true },
    },
    {
      command: "notifications_mark_read",
      payload: { ids: ["a"], read: false },
    },
    { command: "notifications_mark_all_read", payload: {} },
    { command: "notifications_archive", payload: { ids: ["a"] } },
    { command: "notifications_unarchive", payload: { ids: ["a"] } },
    { command: "notifications_archive_all_read", payload: {} },
    { command: "notifications_dismiss", payload: { ids: ["a"] } },
    { command: "notifications_clear_archived", payload: {} },
    { command: "notifications_reconfigure", payload: {} },
    { command: "notifications_pause", payload: {} },
    { command: "notifications_resume", payload: {} },
    {
      command: "notifications_reset_state",
      payload: { what: { expiryLedger: true, snapshots: false } },
    },
    { command: "notifications_zone_summary", payload: {} },
  ]);
});

test("settings round-trip clamps on both directions and sends the full object", async () => {
  desktop();
  const calls = recordCalls((command, payload) => {
    if (command === "notifications_get_settings") {
      return {
        service: { recordPollMinutes: 1 },
        expiry: { milestones: [400, 45] },
      };
    }
    if (command === "notifications_update_settings") {
      // Rust echoes the persisted (normalized) object; simulate a stricter clamp.
      const sent = payload?.settings as {
        service: { recordPollMinutes: number };
      };
      return { ...sent, service: { ...sent.service, recordPollMinutes: 60 } };
    }
    throw new Error(`Unexpected Tauri command: ${command}`);
  });

  const loaded = await TauriClient.notificationsGetSettings();
  assert.equal(loaded.service.recordPollMinutes, 5);
  assert.deepEqual(loaded.expiry.milestones, [45]);
  assert.equal(loaded.retention.maxItems, 2000);

  const saved = await TauriClient.notificationsUpdateSettings({
    ...loaded,
    service: { ...loaded.service, recordPollMinutes: 99_999 },
  });
  assert.equal(saved.service.recordPollMinutes, 60);
  const sentSettings = calls[1].payload?.settings as {
    version: number;
    service: { recordPollMinutes: number };
    retention: { maxItems: number };
  };
  assert.equal(calls[1].command, "notifications_update_settings");
  assert.equal(sentSettings.version, 1);
  assert.equal(sentSettings.service.recordPollMinutes, 1440);
  assert.equal(sentSettings.retention.maxItems, 2000);
});

test("event subscriptions listen on the documented event names and unlisten", async () => {
  desktop();
  const received: NotificationsChangedPayload[] = [];
  const calls = recordCalls((command, payload) => {
    if (command === "plugin:event|listen") return 7;
    if (command === "plugin:event|unlisten") return undefined;
    throw new Error(`Unexpected Tauri command: ${command}`);
  });
  const unlistenChanged = await TauriClient.onNotificationsChanged((p) =>
    received.push(p),
  );
  const unlistenStatus = await TauriClient.onNotificationsStatus(() => {});
  assert.equal(calls[0].command, "plugin:event|listen");
  assert.equal(calls[0].payload?.event, NOTIFICATIONS_CHANGED_EVENT);
  assert.equal(calls[1].payload?.event, NOTIFICATIONS_STATUS_EVENT);
  assert.equal(NOTIFICATIONS_CHANGED_EVENT, "notifications://changed");
  assert.equal(NOTIFICATIONS_STATUS_EVENT, "notifications://status");
  assert.equal(typeof unlistenChanged, "function");
  unlistenChanged();
  unlistenStatus();
  assert.deepEqual(received, []);
});
