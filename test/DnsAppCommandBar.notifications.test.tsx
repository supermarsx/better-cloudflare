import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DnsAppCommandBar } from "../src/components/dns/DnsAppCommandBar";

afterEach(() => cleanup());

function renderBar(
  overrides: Partial<React.ComponentProps<typeof DnsAppCommandBar>> = {},
) {
  const opened: string[] = [];
  render(
    <DnsAppCommandBar
      accountLabel="admin@example.test"
      sessionLabel="Active session"
      showAudit
      onOpenAudit={() => opened.push("audit")}
      onOpenRegistry={() => opened.push("registry")}
      onOpenSettings={() => opened.push("settings")}
      onOpenTags={() => opened.push("tags")}
      onOpenNotifications={() => opened.push("notifications")}
      onLogout={() => opened.push("logout")}
      {...overrides}
    />,
  );
  return opened;
}

test("the bell is hidden unless showNotifications is set (web build)", () => {
  renderBar({ showNotifications: false });
  assert.equal(screen.queryByRole("button", { name: /notifications/i }), null);
  assert.equal(screen.queryByTestId("notifications-unread-badge"), null);
});

test("the bell announces the unread count and shows a badge", () => {
  const opened = renderBar({ showNotifications: true, unreadCount: 2 });
  const bell = screen.getByRole("button", { name: "Notifications, 2 unread" });
  assert.equal(
    screen.getByTestId("notifications-unread-badge").textContent,
    "2",
  );
  fireEvent.click(bell);
  assert.deepEqual(opened, ["notifications"]);
});

test("with nothing unread the bell has a plain name and no badge", () => {
  renderBar({ showNotifications: true, unreadCount: 0 });
  assert.ok(screen.getByRole("button", { name: "Notifications" }));
  assert.equal(screen.queryByTestId("notifications-unread-badge"), null);
});

test("large counts are capped at 99+ in the badge but exact in the name", () => {
  renderBar({ showNotifications: true, unreadCount: 250 });
  assert.ok(screen.getByRole("button", { name: "Notifications, 250 unread" }));
  assert.equal(
    screen.getByTestId("notifications-unread-badge").textContent,
    "99+",
  );
});
