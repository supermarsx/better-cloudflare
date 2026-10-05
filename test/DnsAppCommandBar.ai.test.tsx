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

// ── Reveal versus toggle ───────────────────────────────────────────────────

test("in tab placement the control is a reveal and claims no pressed state", () => {
  // You do not un-activate a workspace tab, so `aria-pressed` here would be a
  // lie — and `aria-pressed="false"` is announced as an unpressed toggle,
  // which is worse than saying nothing.
  const opened = renderBar({
    showAssistant: true,
    assistantControl: { mode: "reveal" },
  });

  const button = screen.getByTestId("command-bar-assistant");
  assert.equal(button.getAttribute("aria-label"), "Assistant");
  assert.equal(button.getAttribute("aria-pressed"), null);
  assert.equal(button.getAttribute("data-pressed"), null);
  fireEvent.click(button);
  assert.deepEqual(opened, ["assistant"]);
});

test("in dock placement the control is a toggle that reports both states", () => {
  const toggled: string[] = [];
  const control = (open: boolean) =>
    ({ mode: "toggle", surface: "sidebar", open }) as const;

  render(
    <DnsAppCommandBar
      accountLabel="a"
      sessionLabel="s"
      showAudit={false}
      onOpenAudit={() => {}}
      onOpenRegistry={() => {}}
      onOpenSettings={() => {}}
      onOpenTags={() => {}}
      onLogout={() => {}}
      showAssistant
      onOpenAssistant={() => toggled.push("reveal")}
      onToggleAssistant={() => toggled.push("toggle")}
      assistantControl={control(false)}
    />,
  );

  const closed = screen.getByTestId("command-bar-assistant");
  assert.equal(closed.getAttribute("aria-pressed"), "false");
  assert.equal(closed.getAttribute("aria-label"), "Show the docked assistant");
  fireEvent.click(closed);
  // The toggle handler, never the reveal one: overloading reveal is what left
  // the dock with no way to be hidden.
  assert.deepEqual(toggled, ["toggle"]);
  cleanup();

  render(
    <DnsAppCommandBar
      accountLabel="a"
      sessionLabel="s"
      showAudit={false}
      onOpenAudit={() => {}}
      onOpenRegistry={() => {}}
      onOpenSettings={() => {}}
      onOpenTags={() => {}}
      onLogout={() => {}}
      showAssistant
      onToggleAssistant={() => toggled.push("toggle")}
      assistantControl={control(true)}
    />,
  );
  const open = screen.getByTestId("command-bar-assistant");
  assert.equal(open.getAttribute("aria-pressed"), "true");
  assert.equal(open.getAttribute("aria-label"), "Hide the docked assistant");
  // Pressed is also visible, not only announced.
  assert.equal(open.dataset.pressed, "true");
  assert.match(open.className, /bg-accent\/60/);
});

test("the bubble's toggle is named for the bubble, not for a dock", () => {
  // Closing a dock and dismissing a floating window are different enough that
  // one shared name would not say what will happen.
  render(
    <DnsAppCommandBar
      accountLabel="a"
      sessionLabel="s"
      showAudit={false}
      onOpenAudit={() => {}}
      onOpenRegistry={() => {}}
      onOpenSettings={() => {}}
      onOpenTags={() => {}}
      onLogout={() => {}}
      showAssistant
      onToggleAssistant={() => {}}
      assistantControl={{ mode: "toggle", surface: "bubble", open: true }}
    />,
  );
  assert.equal(
    screen.getByTestId("command-bar-assistant").getAttribute("aria-label"),
    "Hide the floating assistant",
  );
});

test("a toggle with no toggle handler is no control at all", () => {
  // A host that asked for a toggle and wired only the reveal handler gets
  // nothing, rather than a control that cannot close what it opened.
  renderBar({
    showAssistant: true,
    assistantControl: { mode: "toggle", surface: "sidebar", open: false },
  });
  assert.equal(screen.queryByTestId("command-bar-assistant"), null);
});

test("the pressed treatment stays inside the button's own box", () => {
  // `.app-command-toolbar` is `overflow-x: auto` with a 0.375rem clip
  // allowance sized for the focus ring, the hover lift and the unread badge.
  // A pressed state painted outside the box would be the fourth claimant on
  // that space and the first to need it widened, so it is background and text
  // only: no ring, no outline, no shadow, no translate.
  render(
    <DnsAppCommandBar
      accountLabel="a"
      sessionLabel="s"
      showAudit={false}
      onOpenAudit={() => {}}
      onOpenRegistry={() => {}}
      onOpenSettings={() => {}}
      onOpenTags={() => {}}
      onLogout={() => {}}
      showAssistant
      onToggleAssistant={() => {}}
      assistantControl={{ mode: "toggle", surface: "sidebar", open: true }}
    />,
  );
  const pressed = screen.getByTestId("command-bar-assistant");
  // Only the classes the component adds for the pressed state are checked —
  // the shared button variant's own hover/focus styling is not this test's
  // business.
  const added = pressed.className
    .split(/\s+/)
    .filter(
      (name) => name.startsWith("bg-accent") || name === "text-foreground",
    );
  assert.deepEqual(added.sort(), ["bg-accent/60", "text-foreground"]);
  for (const outside of [/ring-/, /outline-/, /shadow-\[/, /translate-/]) {
    const painted = pressed.className
      .split(/\s+/)
      .filter((name) => outside.test(name) && !name.includes(":"));
    assert.deepEqual(
      painted,
      [],
      `the pressed state must not paint outside the box: ${painted.join(" ")}`,
    );
  }
});
