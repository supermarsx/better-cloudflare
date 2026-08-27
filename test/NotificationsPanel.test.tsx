import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { NotificationsPanel } from "../src/components/dns/NotificationsPanel";
import { resetNotificationSettingsCache } from "../src/hooks/dns/use-notification-settings";
import {
  TauriClient,
  type AppNotification,
  type NotificationQuery,
  type NotificationServiceStatus,
} from "../src/lib/api/tauri-client";
import { clampNotificationSettings } from "../src/lib/notifications/notification-settings";

/** Accessible name from the naming sources these controls actually use. */
function computeAccessibleName(element: Element): string {
  const label = element.getAttribute("aria-label");
  if (label) return label;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  }
  if (element.id) {
    const forLabel = document.querySelector(`label[for="${element.id}"]`);
    if (forLabel?.textContent) return forLabel.textContent;
  }
  const wrapping = element.closest("label");
  if (wrapping?.textContent) return wrapping.textContent;
  return element.textContent ?? "";
}

const NOW = new Date("2026-08-07T10:40:00Z");

const STATUS: NotificationServiceStatus = {
  running: true,
  enabled: true,
  paused: false,
  quietHoursActive: false,
  zonesTracked: 4,
  unread: 2,
  lastRecordCheckAt: "2026-08-07T10:30:00Z",
  nextRecordCheckAt: "2026-08-07T10:45:00Z",
};

function seedInbox(): AppNotification[] {
  return [
    {
      id: "ntf-expiry",
      kind: "domain_expiry",
      severity: "critical",
      zoneId: "zone-labs",
      zoneName: "labs.test",
      title: "labs.test expires in 3 days",
      body: "Registration ends on 2026-08-10.",
      createdAt: "2026-08-07T08:00:12Z",
      readAt: null,
      archivedAt: null,
      dedupeKey: "expiry:labs.test:2026-08-10:3",
      payload: {
        domain: "labs.test",
        expiresAt: "2026-08-10T00:00:00Z",
        daysLeft: 3,
        milestone: 3,
        source: "rdap",
      },
    },
    {
      id: "ntf-change",
      kind: "record_change",
      severity: "warning",
      zoneId: "zone-main",
      zoneName: "main.test",
      title: "A app.main.test changed outside Better Cloudflare",
      body: "203.0.113.20 → 203.0.113.99",
      createdAt: "2026-08-06T07:41:00Z",
      readAt: "2026-08-06T09:00:00Z",
      archivedAt: null,
      dedupeKey: "change:zone-main:rec-app:2026-08-06T07:39:51Z",
      payload: {
        change: "changed",
        recordId: "rec-app",
        recordType: "A",
        recordName: "app.main.test",
        before: { content: "203.0.113.20", ttl: 1, proxied: true },
        after: { content: "203.0.113.99", ttl: 1, proxied: true },
      },
    },
    {
      id: "ntf-archived",
      kind: "service",
      severity: "info",
      zoneId: null,
      zoneName: null,
      title: "Monitoring started",
      body: "Baseline snapshots were taken for 4 zones.",
      createdAt: "2026-08-05T09:15:30Z",
      readAt: "2026-08-05T09:20:00Z",
      archivedAt: "2026-08-05T18:00:00Z",
      dedupeKey: "service:baseline",
      payload: { event: "baseline" },
    },
  ];
}

type Backend = {
  inbox: AppNotification[];
  calls: { name: string; args: unknown[] }[];
  queries: NotificationQuery[];
};

function installBackend(): Backend {
  const backend: Backend = { inbox: seedInbox(), calls: [], queries: [] };
  const record =
    (name: string, impl: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      backend.calls.push({ name, args });
      return impl(...args);
    };
  const unread = () =>
    backend.inbox.filter((item) => !item.readAt && !item.archivedAt).length;

  mock.method(
    TauriClient,
    "notificationsList",
    record("list", (query) => {
      const q = (query ?? {}) as NotificationQuery;
      backend.queries.push(q);
      return backend.inbox.filter((item) =>
        q.scope === "archived"
          ? !!item.archivedAt
          : q.scope === "unread"
            ? !item.readAt && !item.archivedAt
            : !item.archivedAt,
      );
    }),
  );
  mock.method(TauriClient, "notificationsUnreadCount", record("count", unread));
  mock.method(
    TauriClient,
    "notificationsStatus",
    record("status", () => ({ ...STATUS, unread: unread() })),
  );
  mock.method(
    TauriClient,
    "notificationsMarkRead",
    record("markRead", (ids, read) => {
      for (const item of backend.inbox) {
        if ((ids as string[]).includes(item.id))
          item.readAt = read ? "2026-08-07T10:41:00Z" : null;
      }
      return 1;
    }),
  );
  mock.method(
    TauriClient,
    "notificationsMarkAllRead",
    record("markAllRead", () => 1),
  );
  mock.method(
    TauriClient,
    "notificationsArchive",
    record("archive", (ids) => {
      for (const item of backend.inbox) {
        if ((ids as string[]).includes(item.id))
          item.archivedAt = "2026-08-07T10:41:00Z";
      }
      return 1;
    }),
  );
  mock.method(
    TauriClient,
    "notificationsUnarchive",
    record("unarchive", (ids) => {
      for (const item of backend.inbox) {
        if ((ids as string[]).includes(item.id)) item.archivedAt = null;
      }
      return 1;
    }),
  );
  mock.method(
    TauriClient,
    "notificationsArchiveAllRead",
    record("archiveAllRead", () => 1),
  );
  mock.method(
    TauriClient,
    "notificationsDismiss",
    record("dismiss", (ids) => {
      backend.inbox = backend.inbox.filter(
        (item) => !(ids as string[]).includes(item.id),
      );
      return 1;
    }),
  );
  mock.method(
    TauriClient,
    "notificationsClearArchived",
    record("clearArchived", () => 1),
  );
  mock.method(
    TauriClient,
    "notificationsCheckNow",
    record("checkNow", () => STATUS),
  );
  mock.method(
    TauriClient,
    "notificationsPause",
    record("pause", () => STATUS),
  );
  mock.method(
    TauriClient,
    "notificationsResume",
    record("resume", () => STATUS),
  );
  mock.method(TauriClient, "onNotificationsChanged", async () => () => {});
  mock.method(TauriClient, "onNotificationsStatus", async () => () => {});
  mock.method(TauriClient, "notificationsGetSettings", async () =>
    clampNotificationSettings({}),
  );
  mock.method(TauriClient, "notificationsUpdateSettings", async (s: unknown) =>
    clampNotificationSettings(s),
  );
  mock.method(TauriClient, "notificationsZoneSummary", async () => []);
  return backend;
}

function names(backend: Backend, name: string) {
  return backend.calls.filter((call) => call.name === name);
}

beforeEach(() => {
  resetNotificationSettingsCache();
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof NotificationsPanel>> = {},
) {
  const opened: string[] = [];
  const revealed: [string, string][] = [];
  render(
    <NotificationsPanel
      now={NOW}
      onOpenZone={(zoneId) => opened.push(zoneId)}
      onRevealRecord={(zoneId, recordId) => revealed.push([zoneId, recordId])}
      {...overrides}
    />,
  );
  return { opened, revealed };
}

test("the web build shows the desktop-only notice and never calls the backend", () => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  const backend = installBackend();
  renderPanel();
  assert.ok(
    screen.getByText("Notifications are only available in the desktop app."),
  );
  assert.equal(backend.calls.length, 0);
});

test("the inbox lists items grouped by day with a status line and unread count", async () => {
  installBackend();
  renderPanel();

  const items = await screen.findAllByTestId("notification-item");
  assert.equal(items.length, 2, "archived items stay out of the All scope");

  const headings = within(screen.getByTestId("notifications-inbox"))
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent);
  assert.deepEqual(headings, ["Today", "Yesterday"]);

  const status = screen.getByTestId("notifications-status-line").textContent;
  assert.match(
    status ?? "",
    /Last checked 10 min ago · 4 zones · Next in 5 min/,
  );

  // Unread items are marked for styling and the Inbox segment shows the count.
  const [expiry] = items;
  assert.equal(expiry.getAttribute("data-unread"), "true");
  assert.equal(expiry.getAttribute("data-severity"), "critical");
  // The count sits in a sibling <span> separated only by a CSS margin, not by
  // a whitespace text node, so the accessible name concatenates to
  // "Inbox(1)". jsdom <= 28 inserted a space here and 29 no longer does,
  // matching what browsers actually compute. The assertion is that the count
  // reaches the accessible name at all, so the separator stays flexible.
  assert.ok(
    screen.getByRole("button", { name: /Inbox\s*\(1\)/ }),
    "the Inbox segment carries the unread count",
  );

  // A record change renders the field-level before → after diff.
  const change = items[1];
  assert.ok(within(change).getByText("203.0.113.20"));
  assert.ok(within(change).getByText("203.0.113.99"));
});

test("Mark read, Archive and Dismiss call the backend with the item id", async () => {
  const backend = installBackend();
  renderPanel();
  const items = await screen.findAllByTestId("notification-item");
  const expiry = items[0];

  fireEvent.click(within(expiry).getByRole("button", { name: "Mark read" }));
  await waitFor(() => assert.equal(names(backend, "markRead").length, 1));
  assert.deepEqual(names(backend, "markRead")[0].args, [["ntf-expiry"], true]);
  await waitFor(() =>
    assert.ok(
      within(screen.getAllByTestId("notification-item")[0]).getByRole(
        "button",
        { name: "Mark unread" },
      ),
    ),
  );

  fireEvent.click(
    within(screen.getAllByTestId("notification-item")[1]).getByRole("button", {
      name: "Archive",
    }),
  );
  await waitFor(() => assert.equal(names(backend, "archive").length, 1));
  assert.deepEqual(names(backend, "archive")[0].args, [["ntf-change"]]);
  await waitFor(() =>
    assert.equal(screen.getAllByTestId("notification-item").length, 1),
  );

  fireEvent.click(
    within(screen.getAllByTestId("notification-item")[0]).getByRole("button", {
      name: "Dismiss",
    }),
  );
  await waitFor(() => assert.equal(names(backend, "dismiss").length, 1));
  assert.deepEqual(names(backend, "dismiss")[0].args, [["ntf-expiry"]]);
  await waitFor(() => assert.ok(screen.getByTestId("notifications-empty")));
});

test("the Archived scope lists archived items and offers Unarchive", async () => {
  const backend = installBackend();
  renderPanel();
  await screen.findAllByTestId("notification-item");

  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await waitFor(() =>
    assert.ok(backend.queries.some((query) => query.scope === "archived")),
  );
  const archived = await screen.findByText("Monitoring started");
  const item = archived.closest("article") as HTMLElement;
  assert.equal(item.getAttribute("data-unread"), null);
  assert.equal(within(item).queryByRole("button", { name: "Mark read" }), null);

  fireEvent.click(within(item).getByRole("button", { name: "Unarchive" }));
  await waitFor(() => assert.equal(names(backend, "unarchive").length, 1));
  assert.deepEqual(names(backend, "unarchive")[0].args, [["ntf-archived"]]);
});

test("Go to record and Go to zone hand the ids to the host", async () => {
  installBackend();
  const { opened, revealed } = renderPanel();
  const items = await screen.findAllByTestId("notification-item");

  fireEvent.click(
    within(items[1]).getByRole("button", { name: "Go to record" }),
  );
  assert.deepEqual(revealed, [["zone-main", "rec-app"]]);

  // Expiry notices have no record; they open the zone instead.
  fireEvent.click(within(items[0]).getByRole("button", { name: "Go to zone" }));
  assert.deepEqual(opened, ["zone-labs"]);
});

test("the header actions run Check now, Mark all read and Archive all read", async () => {
  const backend = installBackend();
  renderPanel();
  await screen.findAllByTestId("notification-item");

  fireEvent.click(screen.getByRole("button", { name: "Check now" }));
  await waitFor(() => assert.equal(names(backend, "checkNow").length, 1));
  assert.deepEqual(names(backend, "checkNow")[0].args, ["all"]);

  fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
  await waitFor(() => assert.equal(names(backend, "markAllRead").length, 1));

  fireEvent.click(screen.getByRole("button", { name: "Archive all read" }));
  await waitFor(() => assert.equal(names(backend, "archiveAllRead").length, 1));
});

test("search narrows the list and reports an empty filter state", async () => {
  installBackend();
  renderPanel();
  await screen.findAllByTestId("notification-item");

  const search = screen.getByRole("searchbox", {
    name: "Search notifications",
  });
  fireEvent.change(search, { target: { value: "app.main" } });
  assert.equal(screen.getAllByTestId("notification-item").length, 1);

  fireEvent.change(search, { target: { value: "nothing-matches" } });
  assert.equal(
    screen.getByTestId("notifications-empty").textContent,
    "No notifications match the current filters.",
  );
});

test("the Settings segment swaps the inbox for the settings sections", async () => {
  installBackend();
  renderPanel();
  await screen.findAllByTestId("notification-item");

  fireEvent.click(
    within(
      screen.getByRole("toolbar", { name: "Notification views" }),
    ).getByRole("button", { name: "Settings" }),
  );
  assert.ok(
    screen.getByRole("toolbar", { name: "Notification settings sections" }),
  );
  assert.equal(screen.queryByTestId("notifications-inbox"), null);
  await screen.findByTestId("notifications-settings-service");
});

test("every control in the inbox has an accessible name", async () => {
  installBackend();
  renderPanel();
  await screen.findAllByTestId("notification-item");
  for (const role of ["button", "combobox", "searchbox"]) {
    for (const control of screen.getAllByRole(role)) {
      assert.ok(
        computeAccessibleName(control).trim(),
        `${role} without a name: ${control.outerHTML.slice(0, 160)}`,
      );
    }
  }
});
