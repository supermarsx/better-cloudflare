/**
 * The dock and the bubble.
 *
 * What is actually being pinned here:
 *
 * - There is one assistant. Whatever the presentation, `ai-panel` appears at
 *   most once, so there is never a second conversation or a second `ai:event`
 *   subscription.
 * - Opening costs a round trip; existing costs nothing. Until the user opens
 *   the assistant, no `ai_*` command is issued at all.
 * - Closing is not abandoning. The panel stays mounted and hidden, so a
 *   streaming turn survives a dismissal.
 * - Focus moves once per opening and comes back on close. A floating surface
 *   that re-grabs focus on every render is unusable, so that is tested
 *   directly by forcing a re-render.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { AiAssistantSurface } from "../src/components/ai/AiAssistantSurface";
import { TauriClient } from "../src/lib/api/tauri-client";
import type { AiAssistantPresentation } from "../src/lib/ai/presentation";
import type { AgentConfig } from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";

const AGENT_CONFIG: AgentConfig = {
  maxToolRounds: 8,
  maxTokensPerTurn: 4096,
  toolsEnabled: false,
  stream: true,
  preset: "default",
  temperature: 0.7,
  topP: 1,
  personaId: null,
};

/** Counts the `ai_*` traffic the surface causes, which is the point of some tests. */
function installBackend(): { calls: string[] } {
  const calls: string[] = [];
  const record =
    <T,>(name: string, result: () => T) =>
    async () => {
      calls.push(name);
      return result();
    };

  mock.method(
    TauriClient,
    "aiListProviders",
    record("providers", () => []),
  );
  mock.method(
    TauriClient,
    "aiGetConfig",
    record("config", () => AGENT_CONFIG),
  );
  mock.method(
    TauriClient,
    "aiSetConfig",
    record("setConfig", () => undefined),
  );
  mock.method(
    TauriClient,
    "aiListConversations",
    record("conversations", () => []),
  );
  mock.method(TauriClient, "onAiEvent", async () => {
    calls.push("subscribe");
    return () => {};
  });
  return { calls };
}

interface HarnessProps {
  presentation: AiAssistantPresentation;
  initiallyOpen?: boolean;
}

/**
 * A trigger outside the surface plus a re-render button, so focus restoration
 * and focus stability can both be observed from the outside.
 */
function Harness({ presentation, initiallyOpen = false }: HarnessProps) {
  const [open, setOpen] = React.useState(initiallyOpen);
  const [, setTick] = React.useState(0);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open from outside
      </button>
      <button type="button" onClick={() => setTick((value) => value + 1)}>
        Force re-render
      </button>
      <AiAssistantSurface
        presentation={presentation}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}

function assertAbsent(node: Element | null, label: string): void {
  // Comparing to `null` first: see the same helper in AiPersonaSettings.test.tsx.
  assert.ok(node === null, `expected no ${label}`);
}

beforeEach(async () => {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  await useEnglishLocale();
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

// ── The tab presentation is not this component's job ───────────────────────

test("the tab presentation renders nothing here", () => {
  const backend = installBackend();
  render(<Harness presentation="panel" />);

  assertAbsent(screen.queryByTestId("ai-assistant-sidebar"), "dock");
  assertAbsent(screen.queryByTestId("ai-assistant-bubble"), "bubble");
  assertAbsent(screen.queryByTestId("ai-panel"), "panel");
  // DNSManager renders the panel in the tab body; a second one here would be
  // a second conversation.
  assert.deepEqual(backend.calls, []);
});

// ── Nothing is read until the assistant is opened ──────────────────────────

test("an unopened dock issues no ai_* command and occupies no space", async () => {
  const backend = installBackend();
  render(<Harness presentation="sidebar" />);

  const dock = screen.getByTestId("ai-assistant-sidebar");
  assert.equal(dock.hidden, true);
  assert.equal(dock.dataset.open, "false");
  // `display` must not be applied while hidden: a Tailwind `flex` utility beats
  // the user-agent `[hidden] { display: none }` rule.
  assert.doesNotMatch(dock.className, /(?:^|\s)flex(?:$|\s)/);
  assertAbsent(screen.queryByTestId("ai-panel"), "panel");
  assert.deepEqual(backend.calls, []);

  fireEvent.click(screen.getByRole("button", { name: "Open from outside" }));
  await screen.findByTestId("ai-panel");
  await waitFor(() => assert.ok(backend.calls.includes("config")));
});

test("an unopened bubble shows only its launcher", () => {
  const backend = installBackend();
  render(<Harness presentation="bubble" />);

  const launcher = screen.getByRole("button", { name: "Assistant" });
  assert.equal(launcher.getAttribute("aria-expanded"), "false");
  assertAbsent(screen.queryByTestId("ai-panel"), "panel");
  assert.deepEqual(backend.calls, []);
});

// ── One assistant, whichever chrome ────────────────────────────────────────

test("an open dock holds exactly one panel, wearing the dock's chrome", async () => {
  installBackend();
  render(<Harness presentation="sidebar" initiallyOpen />);

  const panel = await screen.findByTestId("ai-panel");
  assert.equal(document.querySelectorAll('[data-testid="ai-panel"]').length, 1);
  assert.equal(panel.dataset.presentation, "sidebar");

  const dock = screen.getByTestId("ai-assistant-sidebar");
  assert.equal(dock.hidden, false);
  assert.equal(dock.getAttribute("role"), "complementary");
  assert.equal(dock.getAttribute("aria-label"), "Assistant");
  assert.ok(dock.contains(panel));

  // In the flow at wide widths, out of the flow when the window is narrow —
  // never squeezing the workspace into an unreadable column.
  assert.match(dock.className, /\bfixed\b/);
  assert.match(dock.className, /\blg:static\b/);
  assert.match(dock.className, /lg:w-\[22rem\]/);
  assert.match(dock.className, /\blg:shrink-0\b/);
});

test("an open bubble holds exactly one panel, wearing the bubble's chrome", async () => {
  installBackend();
  render(<Harness presentation="bubble" initiallyOpen />);

  const panel = await screen.findByTestId("ai-panel");
  assert.equal(document.querySelectorAll('[data-testid="ai-panel"]').length, 1);
  assert.equal(panel.dataset.presentation, "bubble");
  // Two controls carry this name once open - the launcher and the panel
  // header - so the launcher is identified by the state it reports.
  const launcher = screen
    .getAllByRole("button", { name: "Close assistant" })
    .find((button) => button.hasAttribute("aria-expanded"));
  assert.ok(launcher, "the launcher must report its expanded state");
  assert.equal(launcher.getAttribute("aria-expanded"), "true");
  assert.equal(screen.getByTestId("ai-assistant-bubble").dataset.open, "true");
});

// ── Dismissal, and what survives it ────────────────────────────────────────

test("Escape dismisses the bubble", async () => {
  installBackend();
  render(<Harness presentation="bubble" initiallyOpen />);
  const panel = await screen.findByTestId("ai-panel");

  fireEvent.keyDown(panel, { key: "Escape" });

  await waitFor(() =>
    assert.equal(
      screen.getByTestId("ai-assistant-bubble").dataset.open,
      "false",
    ),
  );
});

test("Escape dismisses the dock", async () => {
  installBackend();
  render(<Harness presentation="sidebar" initiallyOpen />);
  const panel = await screen.findByTestId("ai-panel");

  fireEvent.keyDown(panel, { key: "Escape" });

  await waitFor(() =>
    assert.equal(screen.getByTestId("ai-assistant-sidebar").hidden, true),
  );
});

test("a key other than Escape is left alone", async () => {
  installBackend();
  render(<Harness presentation="bubble" initiallyOpen />);
  const panel = await screen.findByTestId("ai-panel");

  fireEvent.keyDown(panel, { key: "Enter" });
  fireEvent.keyDown(panel, { key: "Tab" });
  fireEvent.keyDown(panel, { key: "e" });

  // Only Escape dismisses. Nothing a user types into the composer may close
  // the surface they are typing into.
  assert.equal(screen.getByTestId("ai-assistant-bubble").dataset.open, "true");
});

test("the header dismiss control closes the surface", async () => {
  installBackend();
  render(<Harness presentation="bubble" initiallyOpen />);
  await screen.findByTestId("ai-panel");

  // Two controls are named "Close assistant" once open: the launcher and the
  // header button. Both must close it.
  const controls = screen.getAllByRole("button", { name: "Close assistant" });
  assert.equal(controls.length, 2);
  fireEvent.click(controls[1]);

  await waitFor(() =>
    assert.equal(
      screen.getByTestId("ai-assistant-bubble").dataset.open,
      "false",
    ),
  );
});

test("dismissing hides the panel without unmounting it, so a run is not abandoned", async () => {
  const backend = installBackend();
  render(<Harness presentation="bubble" initiallyOpen />);
  const panel = await screen.findByTestId("ai-panel");
  await waitFor(() => assert.ok(backend.calls.includes("config")));
  const callsWhileOpen = backend.calls.length;

  fireEvent.keyDown(panel, { key: "Escape" });
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("ai-assistant-bubble").dataset.open,
      "false",
    ),
  );

  // Still in the document, just hidden: unmounting would drop the conversation
  // and the agent-event subscription mid-turn.
  assert.ok(screen.getByTestId("ai-panel").isConnected);
  assert.equal(
    (screen.getByTestId("ai-panel").closest("[hidden]") as HTMLElement | null)
      ?.hidden,
    true,
  );

  // Reopening re-reads nothing, because nothing was torn down.
  fireEvent.click(screen.getAllByRole("button", { name: "Assistant" })[0]);
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("ai-assistant-bubble").dataset.open,
      "true",
    ),
  );
  assert.equal(backend.calls.length, callsWhileOpen);
});

// ── Focus ──────────────────────────────────────────────────────────────────

test("opening moves focus into the surface and closing hands it back", async () => {
  installBackend();
  render(<Harness presentation="bubble" />);

  const trigger = screen.getByRole("button", { name: "Open from outside" });
  trigger.focus();
  assert.equal(document.activeElement, trigger);

  fireEvent.click(trigger);
  const panel = await screen.findByTestId("ai-panel");
  await waitFor(() => {
    const active = document.activeElement as HTMLElement | null;
    assert.ok(active && panel.contains(active), "focus must land in the panel");
  });

  fireEvent.keyDown(panel, { key: "Escape" });
  // Back where it came from, not left on a hidden element.
  await waitFor(() => assert.equal(document.activeElement, trigger));
});

test("a re-render while open does not steal focus back", async () => {
  installBackend();
  render(<Harness presentation="bubble" initiallyOpen />);
  const panel = await screen.findByTestId("ai-panel");
  await waitFor(() => {
    const active = document.activeElement as HTMLElement | null;
    assert.ok(active && panel.contains(active));
  });

  // The user moves focus out of the floating surface on purpose.
  const outside = screen.getByRole("button", { name: "Force re-render" });
  outside.focus();
  assert.equal(document.activeElement, outside);

  // Any number of re-renders must leave it there. An effect keyed on anything
  // other than the open transition would yank it back on each one.
  fireEvent.click(outside);
  fireEvent.click(outside);
  assert.equal(document.activeElement, outside);
});

test("the surface is reachable by keyboard even when it has no focusable child", () => {
  installBackend();
  render(<Harness presentation="sidebar" initiallyOpen />);
  // `tabIndex=-1` is what lets focus land on the container itself when the
  // panel inside has nothing focusable yet (the desktop-only notice, say).
  assert.equal(screen.getByTestId("ai-assistant-sidebar").tabIndex, -1);
});

// ── Reduced motion ─────────────────────────────────────────────────────────

test("the entry animation is skipped when reduced motion is asked for", async () => {
  installBackend();
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        addListener: () => {},
        removeListener: () => {},
      }) as MediaQueryList,
  });

  try {
    render(<Harness presentation="bubble" initiallyOpen />);
    const panel = await screen.findByTestId("ai-panel");
    const surface = panel.closest('[role="complementary"]');
    assert.ok(surface);
    await waitFor(() => assert.doesNotMatch(surface.className, /fade-in-up/));
  } finally {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  }
});

test("the entry animation is applied when motion is allowed", async () => {
  installBackend();
  render(<Harness presentation="bubble" initiallyOpen />);
  const panel = await screen.findByTestId("ai-panel");
  const surface = panel.closest('[role="complementary"]');
  assert.ok(surface);
  assert.match(surface.className, /fade-in-up/);
});
