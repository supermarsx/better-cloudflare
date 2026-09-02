/**
 * The assistant entry point in the command bar.
 *
 * Every `ai_*` command is Tauri-only and `server-client.ts` has no HTTP
 * fallback, so the control must not exist at all on the web build. These tests
 * pin that gate, and pin that the button is reachable by name — it is
 * icon-only, so its accessible name is the only thing a screen reader has.
 */
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
      onOpenAssistant={() => opened.push("assistant")}
      onLogout={() => opened.push("logout")}
      {...overrides}
    />,
  );
  return opened;
}

test("the assistant button is hidden unless showAssistant is set (web build)", () => {
  renderBar({ showAssistant: false });
  assert.equal(screen.queryByRole("button", { name: /assistant/i }), null);
});

test("the assistant button is hidden by default", () => {
  // `showAssistant` is optional; the safe default for a Tauri-only surface is
  // absent, not present.
  renderBar();
  assert.equal(screen.queryByRole("button", { name: /assistant/i }), null);
});

test("the assistant button is hidden when no handler is supplied", () => {
  renderBar({ showAssistant: true, onOpenAssistant: undefined });
  assert.equal(screen.queryByRole("button", { name: /assistant/i }), null);
});

test("the assistant button is announced by name and opens the tab", () => {
  const opened = renderBar({ showAssistant: true });

  // Icon-only: `getByRole` with a name is the query a screen reader makes.
  const button = screen.getByRole("button", { name: "Assistant" });
  fireEvent.click(button);
  assert.deepEqual(opened, ["assistant"]);
});

test("the assistant button is independent of the notifications bell", () => {
  // The two desktop-only controls are gated separately; neither may drag the
  // other into or out of the toolbar.
  renderBar({ showAssistant: true, showNotifications: false });
  assert.ok(screen.getByRole("button", { name: "Assistant" }));
  assert.equal(screen.queryByRole("button", { name: /notifications/i }), null);

  cleanup();

  renderBar({ showAssistant: false, showNotifications: true, unreadCount: 1 });
  assert.ok(screen.getByRole("button", { name: "Notifications, 1 unread" }));
  assert.equal(screen.queryByRole("button", { name: /assistant/i }), null);
});
