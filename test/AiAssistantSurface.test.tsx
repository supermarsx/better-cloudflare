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

import {
  AiAssistantSurface,
  type AiAssistantBubblePosition,
} from "../src/components/ai/AiAssistantSurface";
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
  /** A restored bubble position, as the host hands one over after hydration. */
  bubblePosition?: AiAssistantBubblePosition | null;
  /** Observes what the host would be asked to persist, and how often. */
  onBubblePositionChange?: (position: AiAssistantBubblePosition) => void;
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
  bubblePosition,
  onBubblePositionChange,
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
        bubblePosition={bubblePosition}
        onBubblePositionChange={onBubblePositionChange}
        onOpenMcpPermissions={onOpenMcpPermissions}
      />
    </div>
  );
}

function assertAbsent(node: Element | null, label: string): void {
  // Comparing to `null` first: see the same helper in AiPersonaSettings.test.tsx.
  assert.ok(node === null, `expected no ${label}`);
}

// ── Geometry, which jsdom does not have ────────────────────────────────────

/** Undoes whatever {@link stubLayout} patched. Cleared in `afterEach`. */
let restoreLayout: (() => void) | null = null;

/**
 * Give every element a box and the window a size.
 *
 * jsdom lays nothing out: `getBoundingClientRect` answers all zeros and
 * `offsetWidth` is zero. The drag reads exactly those plus
 * `window.innerWidth`/`innerHeight`, so without this the position tests would
 * be asserting arithmetic on zeros and the clamp would have no size to clamp
 * against. Patched on the prototype rather than on one node because the
 * mount-time clamp has to be observable, and at that moment the node to patch
 * does not exist yet.
 *
 * The box *follows its own inline insets*, which is the part that matters for
 * the arrow keys: both gestures measure the rendered box to find out where
 * they are starting from, so a stub that answered the same rect forever would
 * make every nudge start from the default corner and silently turn "ten
 * nudges accumulate" into "the last nudge wins". A browser moves the box; so
 * does this.
 */
function stubLayout(
  box: { right: number; bottom: number; width: number; height: number },
  viewport: { width: number; height: number },
): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const rect = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "getBoundingClientRect",
  );
  const width = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
  const height = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  const innerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");

  Element.prototype.getBoundingClientRect = function (this: Element) {
    // An element carrying inline insets is positioned by them, against the
    // window as it is *now* — `resizeWindow` changes that out from under us.
    const inline = (this as HTMLElement).style;
    const insetRight = inline?.right ? Number.parseFloat(inline.right) : null;
    const insetBottom = inline?.bottom
      ? Number.parseFloat(inline.bottom)
      : null;
    const right =
      insetRight === null ? box.right : window.innerWidth - insetRight;
    const bottom =
      insetBottom === null ? box.bottom : window.innerHeight - insetBottom;
    return {
      x: right - box.width,
      y: bottom - box.height,
      left: right - box.width,
      top: bottom - box.height,
      right,
      bottom,
      width: box.width,
      height: box.height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Object.defineProperty(proto, "offsetWidth", {
    configurable: true,
    get: () => box.width,
  });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get: () => box.height,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: viewport.width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: viewport.height,
  });

  restoreLayout = () => {
    if (rect)
      Object.defineProperty(Element.prototype, "getBoundingClientRect", rect);
    if (width) Object.defineProperty(proto, "offsetWidth", width);
    if (height) Object.defineProperty(proto, "offsetHeight", height);
    if (innerWidth) Object.defineProperty(window, "innerWidth", innerWidth);
    if (innerHeight) Object.defineProperty(window, "innerHeight", innerHeight);
  };
}

/**
 * Resize the window without re-stubbing the element boxes.
 *
 * `new window.Event`, not `new Event`. Node has had a global `Event` since v18,
 * and `test/node-test-env.ts` copies jsdom's globals across only where the name
 * is still free — so a bare `Event` here is Node's, from the wrong realm, and
 * jsdom's `dispatchEvent` rejects it. The same harness wraps
 * `window.dispatchEvent` in a `try`/`catch` that returns `true`, so the throw
 * is swallowed and the dispatch looks like it worked while no listener ever
 * runs. `MouseEvent` is unaffected because Node has no global of that name.
 */
function resizeWindow(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  });
  act(() => {
    window.dispatchEvent(new window.Event("resize"));
  });
}

/**
 * Dispatch one step of a pointer gesture.
 *
 * Built from `MouseEvent`, not `PointerEvent`: jsdom does not implement the
 * latter, and the drag only reads `button`, `clientX` and `clientY`, all of
 * which a `MouseEvent` carries. `WindowControls.test.tsx` does the same for the
 * same reason. The move and release go to `document.body` so they bubble to the
 * `window` listeners the drag installs for the rest of the gesture — which is
 * how a real drag survives the pointer leaving a 44px button.
 */
function pointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  target: EventTarget,
  point: { clientX: number; clientY: number },
): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...point,
      }),
    );
  });
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
  restoreLayout?.();
  restoreLayout = null;
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

// ── Moving the bubble ──────────────────────────────────────────────────────

/** The launcher, which is also the grab handle. */
function bubbleLauncher(): HTMLElement {
  return screen.getByTestId("ai-assistant-bubble-launcher");
}

test("an undragged bubble paints no position of its own", () => {
  installBackend();
  render(<Harness presentation="bubble" />);

  // No inline style at all, so the responsive `right-4 bottom-16` corner is
  // still what decides. A default re-expressed in pixels would quietly stop
  // tracking the root font size.
  const bubble = screen.getByTestId("ai-assistant-bubble");
  assert.equal(bubble.style.right, "");
  assert.equal(bubble.style.bottom, "");
  assert.match(bubble.className, /(?:^|\s)right-4(?:$|\s)/);
  assert.match(bubble.className, /(?:^|\s)bottom-16(?:$|\s)/);
});

test("dragging the bubble moves it and never toggles the assistant", () => {
  installBackend();
  // A 44px launcher sitting in the default corner of a 1000x800 window:
  // 1000-984 = 16px from the right, 800-736 = 64px from the bottom.
  stubLayout(
    { right: 984, bottom: 736, width: 44, height: 44 },
    { width: 1000, height: 800 },
  );
  const stored: AiAssistantBubblePosition[] = [];
  render(
    <Harness
      presentation="bubble"
      onBubblePositionChange={(p) => stored.push(p)}
    />,
  );
  const bubble = screen.getByTestId("ai-assistant-bubble");
  const launcher = bubbleLauncher();

  pointer("pointerdown", launcher, { clientX: 900, clientY: 700 });
  pointer("pointermove", document.body, { clientX: 700, clientY: 300 });
  // Following the pointer, not waiting for release: 200px left of where it
  // started is 200px further from the right edge.
  assert.equal(bubble.style.right, "216px");
  assert.equal(bubble.style.bottom, "464px");
  assert.equal(bubble.dataset.dragging, "true");

  pointer("pointerup", launcher, { clientX: 700, clientY: 300 });
  assert.equal(bubble.dataset.dragging, "false");
  // One write for the whole gesture, not one per pointer move.
  assert.deepEqual(stored, [{ right: 216, bottom: 464 }]);

  // The browser fires a click after a release over a button whatever the
  // pointer did in between. Moving the assistant must not open it — otherwise
  // there is no way to move it at all.
  act(() => {
    fireEvent.click(launcher);
  });
  assert.equal(bubble.dataset.open, "false");
  assertAbsent(screen.queryByTestId("ai-panel"), "panel opened by a drag");
});

test("a press that barely travels is still a click, not a drag", () => {
  installBackend();
  stubLayout(
    { right: 984, bottom: 736, width: 44, height: 44 },
    { width: 1000, height: 800 },
  );
  const stored: AiAssistantBubblePosition[] = [];
  render(
    <Harness
      presentation="bubble"
      onBubblePositionChange={(p) => stored.push(p)}
    />,
  );
  const bubble = screen.getByTestId("ai-assistant-bubble");
  const launcher = bubbleLauncher();

  // Two pixels of jitter is what a real click off a trackpad looks like.
  pointer("pointerdown", launcher, { clientX: 900, clientY: 700 });
  pointer("pointermove", document.body, { clientX: 901, clientY: 701 });
  pointer("pointerup", launcher, { clientX: 901, clientY: 701 });
  act(() => {
    fireEvent.click(launcher);
  });

  assert.equal(bubble.dataset.open, "true");
  assert.deepEqual(stored, [], "a click is not a position to remember");
  assert.equal(bubble.style.right, "", "and it moved nothing");
});

test("a drag that ends off the launcher does not swallow the next activation", async () => {
  installBackend();
  stubLayout(
    { right: 984, bottom: 736, width: 44, height: 44 },
    { width: 1000, height: 800 },
  );
  render(<Harness presentation="bubble" />);
  const bubble = screen.getByTestId("ai-assistant-bubble");
  const launcher = bubbleLauncher();

  // Released away from the handle, so no click follows and the suppression
  // that a finished drag arms is never consumed.
  pointer("pointerdown", launcher, { clientX: 900, clientY: 700 });
  pointer("pointermove", document.body, { clientX: 500, clientY: 200 });
  pointer("pointerup", document.body, { clientX: 500, clientY: 200 });
  // 400px left and 500px up from the default 16/64 corner.
  assert.equal(bubble.style.right, "416px");
  assert.equal(bubble.style.bottom, "564px");

  // A later activation is a different gesture — and a keyboard one produces a
  // click with no pointer events in front of it, so a suppression left armed
  // would make the bubble unopenable from the keyboard.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => {
    fireEvent.click(launcher);
  });
  assert.equal(bubble.dataset.open, "true");
});

test("a bubble stored past the edge of the window is pulled back on screen", () => {
  installBackend();
  stubLayout(
    { right: 984, bottom: 736, width: 44, height: 44 },
    { width: 1000, height: 800 },
  );
  const stored: AiAssistantBubblePosition[] = [];
  render(
    <Harness
      presentation="bubble"
      // What a wide monitor leaves behind once the window is small again.
      bubblePosition={{ right: 4000, bottom: 3000 }}
      onBubblePositionChange={(p) => stored.push(p)}
    />,
  );

  // Clamped to the far edge less the bubble's own size, so the launcher is
  // still on screen and still grabbable. Stranded off-screen with the point
  // persisted, it would be unrecoverable without clearing settings.
  const bubble = screen.getByTestId("ai-assistant-bubble");
  assert.equal(bubble.style.right, "956px");
  assert.equal(bubble.style.bottom, "756px");
  // And the stored point is left alone: a window the user made small for a
  // minute must not rewrite where they decided the bubble lives.
  assert.deepEqual(stored, []);
});

test("shrinking the window pulls the bubble back without rewriting what was stored", () => {
  installBackend();
  stubLayout(
    { right: 984, bottom: 736, width: 44, height: 44 },
    { width: 1000, height: 800 },
  );
  const stored: AiAssistantBubblePosition[] = [];
  render(
    <Harness
      presentation="bubble"
      bubblePosition={{ right: 900, bottom: 700 }}
      onBubblePositionChange={(p) => stored.push(p)}
    />,
  );
  const bubble = screen.getByTestId("ai-assistant-bubble");
  assert.equal(bubble.style.right, "900px");

  resizeWindow(500, 400);

  assert.equal(bubble.style.right, "456px");
  assert.equal(bubble.style.bottom, "356px");
  assert.deepEqual(stored, []);
});

test("a position that arrives after mount is adopted", async () => {
  installBackend();
  stubLayout(
    { right: 984, bottom: 736, width: 44, height: 44 },
    { width: 1000, height: 800 },
  );
  const { rerender } = render(<Harness presentation="bubble" />);
  const bubble = screen.getByTestId("ai-assistant-bubble");
  assert.equal(bubble.style.right, "");

  // Preference hydration is asynchronous in the host, so the stored point
  // lands a tick or two after the first render. Ignoring it then would make
  // the bubble forget its position on every launch.
  await act(async () => {
    rerender(
      <Harness
        presentation="bubble"
        bubblePosition={{ right: 300, bottom: 200 }}
      />,
    );
  });
  assert.equal(bubble.style.right, "300px");
  assert.equal(bubble.style.bottom, "200px");
});

/** The launcher in the default corner of a 1000x800 window: 16 right, 64 bottom. */
function renderMovableBubble(
  stored: AiAssistantBubblePosition[],
  bubblePosition?: AiAssistantBubblePosition,
): { bubble: HTMLElement; launcher: HTMLElement } {
  installBackend();
  stubLayout(
    { right: 984, bottom: 736, width: 44, height: 44 },
    { width: 1000, height: 800 },
  );
  render(
    <Harness
      presentation="bubble"
      bubblePosition={bubblePosition}
      onBubblePositionChange={(p) => stored.push(p)}
    />,
  );
  return {
    bubble: screen.getByTestId("ai-assistant-bubble"),
    launcher: bubbleLauncher(),
  };
}

test("arrow keys nudge the bubble, and each nudge is stored", () => {
  const stored: AiAssistantBubblePosition[] = [];
  const { bubble, launcher } = renderMovableBubble(stored);

  // Insets are measured from the bottom-right, so moving left grows `right`.
  act(() => {
    fireEvent.keyDown(launcher, { key: "ArrowLeft" });
  });
  assert.equal(bubble.style.right, "32px");
  assert.equal(bubble.style.bottom, "64px");

  // Accumulating, not restarting: the second nudge reads back where the first
  // one left the box rather than the corner it began in.
  act(() => {
    fireEvent.keyDown(launcher, { key: "ArrowLeft" });
  });
  assert.equal(bubble.style.right, "48px");

  // Shift is the coarse step — 64px, the default corner's own block inset.
  act(() => {
    fireEvent.keyDown(launcher, { key: "ArrowUp", shiftKey: true });
  });
  assert.equal(bubble.style.bottom, "128px");

  act(() => {
    fireEvent.keyDown(launcher, { key: "ArrowRight" });
  });
  assert.equal(bubble.style.right, "32px");

  // A keypress is a finished gesture — there is no release to wait for — so a
  // user who nudges four times and walks away has the fourth one stored.
  assert.deepEqual(stored, [
    { right: 32, bottom: 64 },
    { right: 48, bottom: 64 },
    { right: 48, bottom: 128 },
    { right: 32, bottom: 128 },
  ]);
});

test("an arrow is swallowed only where it moves the bubble", () => {
  const stored: AiAssistantBubblePosition[] = [];
  const { bubble, launcher } = renderMovableBubble(stored);

  // On the launcher the page must not also scroll underneath the thing being
  // moved, so the key is consumed.
  const onLauncher = fireEvent.keyDown(launcher, {
    key: "ArrowLeft",
    cancelable: true,
  });
  assert.equal(onLauncher, false, "an arrow that moves the bubble is consumed");

  // Anywhere else it is the page's key. The handler lives on the button, so
  // this is scoped by focus in a browser; here it is scoped by target.
  const elsewhere = fireEvent.keyDown(document.body, {
    key: "ArrowLeft",
    cancelable: true,
  });
  assert.equal(elsewhere, true, "an arrow elsewhere still scrolls the page");
  assert.equal(bubble.style.right, "32px", "and moved nothing");

  // Modified arrows belong to the browser and the window manager — Alt+Left is
  // Back — so they are left alone even on the launcher.
  const withCtrl = fireEvent.keyDown(launcher, {
    key: "ArrowLeft",
    ctrlKey: true,
    cancelable: true,
  });
  assert.equal(withCtrl, true, "Ctrl+Arrow is not ours to take");
  assert.equal(bubble.style.right, "32px");
  assert.deepEqual(stored, [{ right: 32, bottom: 64 }]);
});

test("nudging never toggles the assistant, and Enter still does", () => {
  const stored: AiAssistantBubblePosition[] = [];
  const { bubble, launcher } = renderMovableBubble(stored);

  act(() => {
    fireEvent.keyDown(launcher, { key: "ArrowUp" });
    fireEvent.keyDown(launcher, { key: "ArrowLeft" });
  });
  assert.equal(
    bubble.dataset.open,
    "false",
    "a bare arrow is not an activation",
  );
  assertAbsent(screen.queryByTestId("ai-panel"), "panel opened by a nudge");

  // Enter and Space are the button's. The handler must not consume them, or
  // the browser would never synthesise the click that activates it.
  const onEnter = fireEvent.keyDown(launcher, {
    key: "Enter",
    cancelable: true,
  });
  assert.equal(onEnter, true, "Enter belongs to the button");
  const onSpace = fireEvent.keyDown(launcher, { key: " ", cancelable: true });
  assert.equal(onSpace, true, "Space belongs to the button");

  // And that activation still opens, after all the nudging.
  act(() => {
    fireEvent.click(launcher);
  });
  assert.equal(bubble.dataset.open, "true");
});

test("a nudge cannot walk the bubble off the screen", () => {
  const stored: AiAssistantBubblePosition[] = [];
  // 34px short of the far edge, with a coarse 64px step aimed at it.
  const { bubble } = renderMovableBubble(stored, { right: 922, bottom: 700 });
  const launcher = bubbleLauncher();

  act(() => {
    fireEvent.keyDown(launcher, { key: "ArrowLeft", shiftKey: true });
  });

  // 922 + 64 = 986, past the 1000 - 44 ceiling, so it stops at the edge with
  // the launcher still on screen. What is stored is the clamped point, not the
  // overshoot — the same rule the drag follows on release.
  assert.equal(bubble.style.right, "956px");
  assert.deepEqual(stored, [{ right: 956, bottom: 700 }]);

  // Still pinned after another push in the same direction.
  act(() => {
    fireEvent.keyDown(launcher, { key: "ArrowLeft", shiftKey: true });
  });
  assert.equal(bubble.style.right, "956px");
});

test("the launcher says it can be moved, without that becoming its name", () => {
  installBackend();
  render(<Harness presentation="bubble" />);
  const launcher = bubbleLauncher();

  // Without this nothing on screen tells anyone the bubble moves at all.
  assert.equal(
    launcher.getAttribute("title"),
    "Drag or use arrow keys to move",
  );

  // And it is a description, not the name. This query resolves by *computed*
  // accessible name, so it fails the moment `title` starts winning — which
  // matters beyond this file: `DNSManager.assistant.test.tsx` pins that
  // exactly one control is named just "Assistant", and the command bar's
  // control is told apart from this one by name alone.
  assert.ok(
    screen.getByRole("button", { name: "Assistant" }) === launcher,
    "the accessible name must still come from aria-label",
  );
});

test("the dock is not movable", async () => {
  installBackend();
  render(<Harness presentation="sidebar" initiallyOpen />);
  await screen.findByTestId("ai-panel");

  // A dock takes part in the layout it docks into; a free-floating one would
  // just be the bubble. There is no handle and no inline position.
  assertAbsent(
    screen.queryByTestId("ai-assistant-bubble-launcher"),
    "a drag handle on the dock",
  );
  const dock = screen.getByTestId("ai-assistant-sidebar");
  assert.equal(dock.style.right, "");
  assert.equal(dock.style.bottom, "");
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
