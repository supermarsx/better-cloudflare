import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { useNotifications } from "../src/hooks/dns/use-notifications";
import {
  TauriClient,
  type AppNotification,
  type NotificationServiceStatus,
  type NotificationsChangedPayload,
} from "../src/lib/api/tauri-client";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;

function item(overrides: Partial<AppNotification>): AppNotification {
  return {
    id: "n",
    kind: "service",
    severity: "info",
    zoneId: null,
    zoneName: null,
    title: "t",
    body: "b",
    createdAt: "2026-08-26T10:00:00Z",
    readAt: null,
    archivedAt: null,
    dedupeKey: "k",
    payload: {},
    ...overrides,
  };
}

const STATUS: NotificationServiceStatus = {
  running: true,
  enabled: true,
  paused: false,
  quietHoursActive: false,
  zonesTracked: 2,
  unread: 2,
};

type Backend = {
  inbox: AppNotification[];
  calls: string[];
  changed: ((p: NotificationsChangedPayload) => void) | null;
  status: ((p: NotificationServiceStatus) => void) | null;
  failNext: string | null;
  unlistened: string[];
  paused: boolean;
  lastError: string | null;
};

function installBackend(): Backend {
  const backend: Backend = {
    inbox: [
      item({ id: "a", createdAt: "2026-08-26T10:00:00Z" }),
      item({ id: "b", createdAt: "2026-08-26T09:00:00Z" }),
      item({
        id: "c",
        readAt: "2026-08-26T09:30:00Z",
        createdAt: "2026-08-25T09:00:00Z",
      }),
    ],
    calls: [],
    changed: null,
    status: null,
    failNext: null,
    unlistened: [],
    paused: false,
    lastError: null,
  };
  const unread = () =>
    backend.inbox.filter((i) => !i.readAt && !i.archivedAt).length;
  const track = (name: string) => {
    backend.calls.push(name);
    if (backend.failNext === name) {
      backend.failNext = null;
      throw new Error(`${name} failed`);
    }
  };
  mock.method(
    TauriClient,
    "notificationsList",
    async (query: { scope?: string }) => {
      track("list");
      const scope = query.scope ?? "all";
      return backend.inbox.filter((i) =>
        scope === "archived"
          ? !!i.archivedAt
          : scope === "unread"
            ? !i.readAt && !i.archivedAt
            : !i.archivedAt,
      );
    },
  );
  mock.method(TauriClient, "notificationsUnreadCount", async () => {
    track("unread");
    return unread();
  });
  mock.method(TauriClient, "notificationsStatus", async () => {
    track("status");
    return {
      ...STATUS,
      paused: backend.paused,
      lastError: backend.lastError,
      unread: unread(),
    };
  });
  mock.method(
    TauriClient,
    "notificationsMarkRead",
    async (ids: string[], read: boolean) => {
      track("markRead");
      for (const i of backend.inbox)
        if (ids.includes(i.id)) i.readAt = read ? "2026-08-26T11:00:00Z" : null;
      return ids.length;
    },
  );
  mock.method(TauriClient, "notificationsMarkAllRead", async () => {
    track("markAllRead");
    for (const i of backend.inbox)
      if (!i.archivedAt) i.readAt ??= "2026-08-26T11:00:00Z";
    return 1;
  });
  mock.method(TauriClient, "notificationsArchive", async (ids: string[]) => {
    track("archive");
    for (const i of backend.inbox)
      if (ids.includes(i.id)) i.archivedAt = "2026-08-26T11:00:00Z";
    return ids.length;
  });
  mock.method(TauriClient, "notificationsUnarchive", async (ids: string[]) => {
    track("unarchive");
    for (const i of backend.inbox) if (ids.includes(i.id)) i.archivedAt = null;
    return ids.length;
  });
  mock.method(TauriClient, "notificationsArchiveAllRead", async () => {
    track("archiveAllRead");
    for (const i of backend.inbox)
      if (i.readAt) i.archivedAt = "2026-08-26T11:00:00Z";
    return 1;
  });
  mock.method(TauriClient, "notificationsDismiss", async (ids: string[]) => {
    track("dismiss");
    backend.inbox = backend.inbox.filter((i) => !ids.includes(i.id));
    return ids.length;
  });
  mock.method(TauriClient, "notificationsClearArchived", async () => {
    track("clearArchived");
    backend.inbox = backend.inbox.filter((i) => !i.archivedAt);
    return 1;
  });
  mock.method(TauriClient, "notificationsCheckNow", async () => {
    track("checkNow");
    backend.lastError = "checked";
    return { ...STATUS, unread: unread(), lastError: "checked" };
  });
  mock.method(TauriClient, "notificationsPause", async () => {
    track("pause");
    backend.paused = true;
    return { ...STATUS, paused: true, unread: unread() };
  });
  mock.method(TauriClient, "notificationsResume", async () => {
    track("resume");
    backend.paused = false;
    return { ...STATUS, paused: false, unread: unread() };
  });
  mock.method(
    TauriClient,
    "onNotificationsChanged",
    async (handler: (p: NotificationsChangedPayload) => void) => {
      track("listenChanged");
      backend.changed = handler;
      return () => backend.unlistened.push("changed");
    },
  );
  mock.method(
    TauriClient,
    "onNotificationsStatus",
    async (handler: (p: NotificationServiceStatus) => void) => {
      track("listenStatus");
      backend.status = handler;
      return () => backend.unlistened.push("status");
    },
  );
  return backend;
}

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

test("is inert on the web build", async () => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
  const backend = installBackend();
  const { result } = renderHook(() => useNotifications());
  assert.equal(result.current.available, false);
  await act(async () => {
    await result.current.refresh();
    await result.current.markAllRead();
  });
  assert.deepEqual(backend.calls, []);
  assert.deepEqual(result.current.items, []);
  assert.equal(result.current.unread, 0);
});

test("loads the inbox, unread count and status, and subscribes to events", async () => {
  const backend = installBackend();
  const { result, unmount } = renderHook(() => useNotifications());
  assert.equal(result.current.available, true);
  await waitFor(() => assert.equal(result.current.items.length, 3));
  assert.equal(result.current.unread, 2);
  assert.equal(result.current.status?.zonesTracked, 2);
  assert.equal(result.current.loading, false);
  assert.equal(result.current.error, null);
  await waitFor(() => assert.ok(backend.changed && backend.status));

  // Backend push: status event updates status + badge without a reload.
  const callsBefore = backend.calls.length;
  act(() => backend.status?.({ ...STATUS, paused: true, unread: 5 }));
  assert.equal(result.current.status?.paused, true);
  assert.equal(result.current.unread, 5);
  assert.equal(backend.calls.length, callsBefore);

  // Changed event refreshes the list.
  backend.inbox.push(item({ id: "d", createdAt: "2026-08-26T12:00:00Z" }));
  act(() => backend.changed?.({ unread: 3 }));
  await waitFor(() => assert.equal(result.current.items.length, 4));
  assert.equal(result.current.unread, 3);

  unmount();
  assert.deepEqual(backend.unlistened.sort(), ["changed", "status"]);
});

test("query changes reload with the new scope", async () => {
  const backend = installBackend();
  backend.inbox[2].archivedAt = "2026-08-25T10:00:00Z";
  const { result, rerender } = renderHook(
    ({ scope }: { scope: "all" | "archived" }) =>
      useNotifications({ query: { scope } }),
    { initialProps: { scope: "all" as "all" | "archived" } },
  );
  await waitFor(() => assert.equal(result.current.items.length, 2));
  rerender({ scope: "archived" });
  await waitFor(() =>
    assert.deepEqual(
      result.current.items.map((i) => i.id),
      ["c"],
    ),
  );
  await act(async () => {
    await result.current.unarchive(["c"]);
  });
  assert.deepEqual(result.current.items, []);
  assert.equal(backend.inbox[2].archivedAt, null);
  assert.ok(backend.calls.includes("unarchive"));
});

test("mark read / archive / dismiss apply optimistically and reconcile", async () => {
  const backend = installBackend();
  const { result } = renderHook(() => useNotifications());
  await waitFor(() => assert.equal(result.current.items.length, 3));

  await act(async () => {
    await result.current.markRead(["a"]);
  });
  assert.ok(result.current.items.find((i) => i.id === "a")?.readAt);
  assert.equal(result.current.unread, 1);

  await act(async () => {
    await result.current.markRead(["a"], false);
  });
  assert.equal(result.current.items.find((i) => i.id === "a")?.readAt, null);
  assert.equal(result.current.unread, 2);

  await act(async () => {
    await result.current.archive(["a"]);
  });
  assert.deepEqual(
    result.current.items.map((i) => i.id),
    ["b", "c"],
  );

  await act(async () => {
    await result.current.dismiss(["b"]);
  });
  assert.deepEqual(
    result.current.items.map((i) => i.id),
    ["c"],
  );
  assert.equal(result.current.unread, 0);

  await act(async () => {
    await result.current.markAllRead();
    await result.current.archiveAllRead();
  });
  assert.deepEqual(result.current.items, []);
  assert.equal(backend.inbox.filter((i) => i.archivedAt).length, 2);

  await act(async () => {
    await result.current.clearArchived();
  });
  assert.equal(backend.inbox.length, 0);
  assert.ok(backend.calls.includes("clearArchived"));
});

test("service actions update status; failures surface as error and re-sync", async () => {
  const backend = installBackend();
  const { result } = renderHook(() => useNotifications());
  await waitFor(() => assert.equal(result.current.items.length, 3));

  await act(async () => {
    await result.current.pause();
  });
  assert.equal(result.current.status?.paused, true);
  await act(async () => {
    await result.current.resume();
  });
  assert.equal(result.current.status?.paused, false);
  await act(async () => {
    await result.current.checkNow("expiry");
  });
  assert.equal(result.current.status?.lastError, "checked");

  backend.failNext = "dismiss";
  await act(async () => {
    await result.current.dismiss(["a"]);
  });
  assert.equal(result.current.error, "dismiss failed");
  // The refresh after the failed action restores the real inbox.
  assert.deepEqual(
    result.current.items.map((i) => i.id),
    ["a", "b", "c"],
  );

  backend.failNext = "list";
  await act(async () => {
    await result.current.refresh();
  });
  assert.equal(result.current.error, "list failed");
  assert.equal(result.current.loading, false);
});
