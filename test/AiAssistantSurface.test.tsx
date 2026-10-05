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
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { AiAssistantSurface } from "../src/components/ai/AiAssistantSurface";
import { TauriClient } from "../src/lib/api/tauri-client";
import type { AiAssistantPresentation } from "../src/lib/ai/presentation";
import type { AgentConfig, AiPlan, ConversationMeta } from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";
import {
  chooseThemedSelectValue,
  enableThemedSelectEnvironment,
  openThemedSelect,
} from "./radix-select";

const AGENT_CONFIG: AgentConfig = {
  maxToolRounds: 8,
  maxTokensPerTurn: 4096,
  toolsEnabled: false,
  stream: true,
  preset: "default",
  temperature: 0.7,
  topP: 1,
  personaId: null,
  defaultProviderId: null,
};

interface BackendOptions {
  /**
   * Turns tool use on, which is what makes the mode dropdown and the
   * permission read exist at all. Off by default, so most of these tests pay
   * for neither.
   */
  toolsEnabled?: boolean;
  /** What `ai_get_plan` answers. `null`, the default, is "no plan". */
  plan?: AiPlan | null;
  /**
   * Give the panel a conversation to select. Empty by default, because most
   * of these tests are about the chrome rather than about a transcript — and
   * with no conversation selected the panel issues no per-conversation read
   * at all, which is what keeps the call counts small.
   */
  conversations?: ConversationMeta[];
}

/** Counts the `ai_*` traffic the surface causes, which is the point of some tests. */
function installBackend(options: BackendOptions = {}): { calls: string[] } {
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
    record("config", () => ({
      ...AGENT_CONFIG,
      toolsEnabled: options.toolsEnabled ?? false,
    })),
  );
  // Read only while tool use is on, which is what the mode dropdown speaks
  // from. Recorded like the rest.
  mock.method(
    TauriClient,
    "aiGetPermissions",
    record("permissions", () => ({
      mode: "ask" as const,
      tools: {},
      catalog: [],
      availability: {
        dispatchAvailable: true,
        grantedToolCount: 2,
        usableToolCount: 2,
        registeredToolCount: 10,
      },
    })),
  );
  mock.method(
    TauriClient,
    "aiSetPermissions",
    record("setPermissions", () => ({ mode: "ask" as const, tools: {} })),
  );
  mock.method(
    TauriClient,
    "aiSetConfig",
    record("setConfig", () => undefined),
  );
  // Only the Behaviour section reads this, so it adds nothing to the call
  // counts the "opening costs a round trip" tests assert on.
  mock.method(
    TauriClient,
    "aiProtocolCapabilities",
    record("capabilities", () => ({
      openai: ["topP", "stop", "seed"],
      anthropic: ["topP", "topK", "stop"],
      ollama: ["topP", "topK", "stop", "seed"],
    })),
  );
  mock.method(
    TauriClient,
    "aiListConversations",
    record("conversations", () => options.conversations ?? []),
  );
  mock.method(
    TauriClient,
    "aiGetConversation",
    record("conversation", () => ({
      id: "conv-1",
      title: "First chat",
      provider: "openai",
      model: "gpt-4o-mini",
      messages: [],
      createdAt: "2026-08-25T10:00:00Z",
      updatedAt: "2026-08-25T10:00:00Z",
    })),
  );
  // The plan read. Recorded like the rest rather than silently stubbed,
  // because "opening costs a round trip and existing costs nothing" is a
  // claim about *every* command the panel issues, and a plan read that did
  // not show up in these counts would quietly exempt itself from it.
  mock.method(
    TauriClient,
    "aiGetPlan",
    record("plan", () => options.plan ?? null),
  );
  mock.method(
    TauriClient,
    "aiGetRunSummary",
    record("runSummary", () => null),
  );
  mock.method(
    TauriClient,
    "aiGetLinks",
    record("links", () => []),
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
  /** Wired through so the plan's MCP pointer can be observed from outside. */
  onOpenMcpPermissions?: () => void;
}

/**
 * A trigger outside the surface plus a re-render button, so focus restoration
 * and focus stability can both be observed from the outside.
 *
 * The placement is a plain prop now: the assistant no longer contains a
 * control for it, so there is nothing inside the surface that could change it.
 * `DNSManager` owns the preference and Session settings is where it is set.
 */
function Harness({
  presentation,
  initiallyOpen = false,
  onOpenMcpPermissions,
}: HarnessProps) {
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
        onOpenMcpPermissions={onOpenMcpPermissions}
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
  // The mode dropdown inside the conversation is a Radix dropdown; opening
  // one needs the two jsdom gaps this installs. See `test/radix-select.ts`.
  enableThemedSelectEnvironment();
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

test("Escape in an open dropdown closes the dropdown, not the bubble", async () => {
  // The dropdown used to be the assistant's own placement picker, which went
  // with its settings view. The mode dropdown is the one that lives inside
  // the conversation now, so it is what this is checked against — the
  // requirement is about Radix and Escape, not about which dropdown.
  installBackend({ toolsEnabled: true });
  render(<Harness presentation="bubble" initiallyOpen />);
  await screen.findByTestId("ai-panel");

  const trigger = await screen.findByLabelText("What the assistant may do");
  const popover = await openThemedSelect(trigger);
  assert.equal(trigger.getAttribute("data-state"), "open");

  // The bubble closes on Escape, and the dropdown lives inside it. Radix
  // handles Escape on a document capture listener and calls
  // `preventDefault()`, and the bubble's handler ignores an already-prevented
  // key — which is the whole reason that guard exists. One Escape must
  // therefore close the dropdown and leave the bubble up.
  await act(async () => {
    fireEvent.keyDown(popover, { key: "Escape" });
  });
  assert.equal(trigger.getAttribute("data-state"), "closed");
  assert.equal(screen.getByTestId("ai-assistant-bubble").dataset.open, "true");
  assert.ok(screen.getByTestId("ai-panel").isConnected);

  // With nothing open, Escape still dismisses the bubble.
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId("ai-panel"), { key: "Escape" });
  });
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("ai-assistant-bubble").dataset.open,
      "false",
    ),
  );
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

// ── The plan rides in every chrome ─────────────────────────────────────────

const CONVERSATION: ConversationMeta = {
  id: "conv-1",
  title: "First chat",
  provider: "openai",
  model: "gpt-4o-mini",
  messageCount: 0,
  createdAt: "2026-08-25T10:00:00Z",
  updatedAt: "2026-08-25T10:00:00Z",
};

/** A draft blocked by the app's MCP grants, which only the host can fix. */
function blockedPlan(): AiPlan {
  return {
    id: "plan-1",
    conversationId: "conv-1",
    title: "Fix the mail records",
    status: "draft",
    steps: [
      {
        id: "11111111-2222-3333-4444-555555555555",
        index: 0,
        title: "Create the SPF record",
        detail: "A TXT record at the apex.",
        tool: "dns_create_record",
        status: "blocked",
        refusal: { source: "mcpGrants", reason: "not granted" },
      },
    ],
    createdAt: "2026-08-25T10:00:00Z",
    updatedAt: "2026-08-25T10:00:00Z",
  };
}

test("the dock shows the plan, and its blocked step, in 22rem", async () => {
  installBackend({ plan: blockedPlan(), conversations: [CONVERSATION] });
  render(<Harness presentation="sidebar" initiallyOpen />);

  const dock = await screen.findByTestId("ai-assistant-sidebar");
  const plan = await screen.findByTestId("ai-plan");
  // One plan, inside the dock, and sized for it: `compact` is keyed off the
  // chrome rather than a viewport breakpoint, because a 22rem dock can sit on
  // a 2560px display.
  assert.equal(document.querySelectorAll('[data-testid="ai-plan"]').length, 1);
  assert.ok(dock.contains(plan));
  assert.match(plan.className, /(?:^|\s)p-2(?:$|\s)/);
  // The blocked step still names its layer here: there is one plan component,
  // so the dock cannot drift from the tab.
  assert.match(
    within(plan).getByTestId("ai-plan-step-refusal").textContent ?? "",
    /app's own MCP tool permissions/,
  );
  // And a draft is not runnable in the dock either.
  assertAbsent(screen.queryByTestId("ai-plan-run"), "run control on a draft");
});

test("the bubble shows the same plan, and reaches the host's MCP screen", async () => {
  const opens: number[] = [];
  installBackend({ plan: blockedPlan(), conversations: [CONVERSATION] });
  render(
    <Harness
      presentation="bubble"
      initiallyOpen
      onOpenMcpPermissions={() => opens.push(1)}
    />,
  );

  const bubble = await screen.findByTestId("ai-assistant-bubble");
  const plan = await screen.findByTestId("ai-plan");
  assert.equal(document.querySelectorAll('[data-testid="ai-plan"]').length, 1);
  assert.ok(bubble.contains(plan));
  assert.match(plan.className, /(?:^|\s)p-2(?:$|\s)/);

  // The host's own screen, wired through the surface: nothing under `ai_*`
  // can change the app's MCP grants, so the assistant can only point there.
  fireEvent.click(screen.getByTestId("ai-plan-step-open-mcp-permissions"));
  assert.deepEqual(opens, [1]);
});
