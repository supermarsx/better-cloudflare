/**
 * Where the assistant lives, and how that choice survives a restart.
 *
 * The preference deliberately does *not* travel as a top-level Tauri
 * preference field. `AppConfigStore::merge` refuses any key the Rust
 * `Preferences` struct does not declare (`src-tauri/src/app_config.rs`), so a
 * new top-level key would fail the whole preference write and take every other
 * preference down with it. `session_settings_profiles` is a free-form
 * `HashMap<String, Value>` on that struct, which is why the session profile can
 * carry this without a backend change — and why the round trip is asserted
 * through the profile here rather than through a field of its own.
 *
 * The other thing pinned here is that there is never more than one assistant
 * mounted: the workspace tab points at the dock or the bubble instead of
 * rendering a second panel with its own conversation and event subscription.
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
  within,
} from "@testing-library/react";

import { DNSManager } from "../src/components/dns/DNSManager";
import {
  TauriClient,
  type McpServerStatus,
  type TauriZone,
} from "../src/lib/api/tauri-client";
import { useToast } from "../src/hooks/use-toast";
import { storageManager } from "../src/lib/storage/storage";
import type {
  AgentConfig,
  AiLink,
  AiPlan,
  ConversationMeta,
} from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";
import { enableThemedSelectEnvironment } from "./radix-select";

const originalFetch = globalThis.fetch;

const ZONE: TauriZone = {
  id: "zone-1",
  name: "example.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
};

const SESSION = "__default";

const CONVERSATION: ConversationMeta = {
  id: "conv-1",
  title: "Zone questions",
  provider: "openai",
  model: "gpt-4o-mini",
  messageCount: 0,
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
};

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

function createMcpStatus(): McpServerStatus {
  return {
    running: false,
    host: "127.0.0.1",
    port: 8787,
    url: "http://127.0.0.1:8787/mcp",
    enabledTools: [],
    tools: [],
    lastError: null,
  };
}

interface Harness {
  preferenceUpdates: Array<Record<string, unknown>>;
}

/**
 * What the assistant's own reads answer.
 *
 * Empty by default, because most of this file is about placement: with no
 * conversation selected the panel issues no per-conversation read at all.
 */
interface AssistantState {
  conversations?: ConversationMeta[];
  plan?: AiPlan | null;
  links?: AiLink[];
}

function mockRuntime(
  storedProfile: Record<string, unknown> | null = null,
  assistant: AssistantState = {},
): Harness {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  const preferenceUpdates: Array<Record<string, unknown>> = [];

  const preferences: Record<string, unknown> = {
    last_zone: ZONE.id,
    last_active_tab: `${ZONE.id}|records`,
    ...(storedProfile
      ? { session_settings_profiles: { [SESSION]: storedProfile } }
      : {}),
  };

  mock.method(TauriClient, "getPreferences", async () => preferences);
  mock.method(TauriClient, "updatePreferences", async (next: unknown) => {
    preferenceUpdates.push(next as Record<string, unknown>);
  });
  mock.method(TauriClient, "getZones", async () => [ZONE]);
  mock.method(TauriClient, "getDNSRecords", async () => []);
  mock.method(TauriClient, "getAuditEntries", async () => []);
  mock.method(TauriClient, "getMcpServerStatus", async () => createMcpStatus());
  mock.method(TauriClient, "startMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "stopMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "setMcpEnabledTools", async () => createMcpStatus());
  // The Registry workspace starts its own monitor the moment it is opened,
  // and an unmocked `list_registrar_credentials` surfaces as a rejected
  // invoke rather than as an empty list.
  mock.method(TauriClient, "listRegistrarCredentials", async () => []);

  // The assistant only reaches for these once it is actually opened.
  mock.method(TauriClient, "aiListProviders", async () => []);
  mock.method(TauriClient, "aiGetConfig", async () => AGENT_CONFIG);
  mock.method(
    TauriClient,
    "aiListConversations",
    async () => assistant.conversations ?? [],
  );
  mock.method(TauriClient, "aiGetConversation", async () => ({
    id: CONVERSATION.id,
    title: CONVERSATION.title,
    provider: CONVERSATION.provider,
    model: CONVERSATION.model,
    messages: [],
    createdAt: CONVERSATION.createdAt,
    updatedAt: CONVERSATION.updatedAt,
  }));
  mock.method(TauriClient, "onAiEvent", async () => () => {});
  // The plan, the run record and the links. `null`/`[]` are what a
  // conversation with none of them answers, and they are what makes those
  // sections render nothing at all — stubbed rather than left to the real
  // `invoke`, which would fail in jsdom and put a "could not be read" alert
  // in every one of these tests.
  mock.method(TauriClient, "aiGetPlan", async () => assistant.plan ?? null);
  mock.method(TauriClient, "aiGetRunSummary", async () => null);
  mock.method(TauriClient, "aiGetLinks", async () => assistant.links ?? []);
  // The Behaviour section — where the assistant's own placement control
  // lives — reads which generation parameters the provider in use honours.
  mock.method(TauriClient, "aiProtocolCapabilities", async () => ({
    openai: ["topP", "stop", "seed"],
    anthropic: ["topP", "topK", "stop"],
    ollama: ["topP", "topK", "stop", "seed"],
  }));

  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  return { preferenceUpdates };
}

/**
 * Mirrors the toast store into the DOM.
 *
 * `DNSManager` does not mount a `Toaster` — the app shell does — so a
 * confirmation raised through `notifySaved` is otherwise unobservable here.
 * `useToast` reads a module-level store, so a probe rendered beside the
 * manager sees exactly what the real toaster would.
 */
function ToastProbe() {
  const { toasts } = useToast();
  return (
    <ul data-testid="toast-probe">
      {toasts.map((entry) => (
        <li key={entry.id}>{entry.description}</li>
      ))}
    </ul>
  );
}

function renderManager() {
  return render(
    <>
      <DNSManager apiKey="test-key" onLogout={() => {}} />
      <ToastProbe />
    </>,
  );
}

/**
 * Open Settings -> General from the command bar.
 *
 * Scoped to the global toolbar on purpose: the assistant panel has a "Settings"
 * segment of its own, so an unscoped query matches two buttons as soon as the
 * assistant is on screen.
 */
async function openAssistantPlacement(): Promise<HTMLElement> {
  const toolbar = await screen.findByRole("toolbar", {
    name: "Global application controls",
  });
  // Clicked under `waitFor` on purpose. Preference hydration sets the active
  // tab from `last_active_tab` once it settles, which undoes a Settings click
  // that landed first; `openActionTab` is idempotent, so retrying until the
  // General subtab is on screen is both correct and race-free.
  await waitFor(() => {
    fireEvent.click(within(toolbar).getByRole("button", { name: "Settings" }));
    assert.ok(screen.getByRole("button", { name: "General" }));
  });
  fireEvent.click(screen.getByRole("button", { name: "General" }));
  return screen.findByTestId("assistant-placement");
}

/** Every mounted assistant panel. More than one is the bug this guards. */
function mountedPanels(): number {
  return document.querySelectorAll('[data-testid="ai-panel"]').length;
}

/**
 * The command bar's assistant control, distinct from a bubble launcher.
 *
 * Found by test id rather than by name: the control is a reveal named
 * "Assistant" in tab placement and a toggle named for its surface and state in
 * the other two, so there is no one name that finds it everywhere. The names
 * themselves are asserted directly in the toggle tests below.
 */
function commandBarAssistant(): HTMLElement {
  const toolbar = screen.getByRole("toolbar", {
    name: "Global application controls",
  });
  return within(toolbar).getByTestId("command-bar-assistant");
}

/** The latest written copy of this session's profile, as the backend sees it. */
function writtenProfile(harness: Harness): Record<string, unknown> | undefined {
  for (const update of [...harness.preferenceUpdates].reverse()) {
    const profiles = update.session_settings_profiles as
      Record<string, Record<string, unknown>> | undefined;
    if (profiles?.[SESSION]) return profiles[SESSION];
  }
  return undefined;
}

function assertAbsent(node: Element | null, label: string): void {
  // Comparing to `null` first keeps a failure message cheap; see the same
  // helper in AiAssistantPanel.test.tsx.
  assert.ok(node === null, `expected no ${label}`);
}

beforeEach(async () => {
  await useEnglishLocale();
  // The assistant's own placement control is a Radix dropdown; opening one
  // needs the two jsdom gaps this installs. See `test/radix-select.ts`.
  enableThemedSelectEnvironment();
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  // The storage manager is a module singleton: a presentation written by one
  // test would otherwise hydrate the next one.
  storageManager.clearSettings();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

// ── The default is the tab that already existed ────────────────────────────

test("with nothing stored the assistant is a workspace tab and nothing floats", async () => {
  mockRuntime();
  renderManager();
  await screen.findByRole("button", { name: "Settings" });

  assert.equal(storageManager.getAiAssistantPresentation(), "panel");
  assertAbsent(screen.queryByTestId("ai-assistant-sidebar"), "dock");
  assertAbsent(screen.queryByTestId("ai-assistant-bubble"), "bubble");

  fireEvent.click(commandBarAssistant());
  await screen.findByTestId("ai-panel");
  assertAbsent(
    screen.queryByTestId("ai-assistant-relocated"),
    "relocation notice",
  );
});

// ── Choosing a placement, and where the choice goes ────────────────────────

test("choosing the bubble persists through storage and the session profile", async () => {
  const harness = mockRuntime();
  renderManager();

  const placement = await openAssistantPlacement();
  assert.equal(placement.dataset.presentation, "panel");

  fireEvent.click(screen.getByRole("radio", { name: /Floating bubble/ }));

  // The browser copy, read back through the same accessor the next launch uses.
  await waitFor(() =>
    assert.equal(storageManager.getAiAssistantPresentation(), "bubble"),
  );
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("assistant-placement").dataset.presentation,
      "bubble",
    ),
  );

  // And the desktop copy, inside the session profile that `update_preferences`
  // actually accepts.
  await waitFor(() => {
    const profile = writtenProfile(harness);
    assert.ok(profile, "a session profile must have been written");
    assert.equal(profile.assistantPresentation, "bubble");
  });

  // No top-level key: `AppConfigStore::merge` would reject the whole write.
  for (const update of harness.preferenceUpdates) {
    assert.ok(
      !("assistant_presentation" in update),
      "the presentation must not be sent as a top-level preference field",
    );
  }
});

test("choosing the dock persists the same way", async () => {
  const harness = mockRuntime();
  renderManager();
  await openAssistantPlacement();

  fireEvent.click(screen.getByRole("radio", { name: /Docked sidebar/ }));

  await waitFor(() =>
    assert.equal(storageManager.getAiAssistantPresentation(), "sidebar"),
  );
  await waitFor(() => {
    const profile = writtenProfile(harness);
    assert.ok(profile);
    assert.equal(profile.assistantPresentation, "sidebar");
  });
});

test("the placement control states what the dock does in a narrow window", async () => {
  mockRuntime();
  renderManager();
  const placement = await openAssistantPlacement();

  // The layout consequence has to be readable before the choice is made.
  assert.match(placement.textContent ?? "", /slides over the workspace/);
  assert.match(placement.textContent ?? "", /Escape closes it/);
});

// ── Hydration ──────────────────────────────────────────────────────────────

test("a stored dock placement is restored from the session profile", async () => {
  mockRuntime({ assistantPresentation: "sidebar" });
  renderManager();

  const dock = await screen.findByTestId("ai-assistant-sidebar");
  // Restored, not opened: hydrating a preference must not pop a panel open.
  assert.equal(dock.dataset.open, "false");
  assertAbsent(screen.queryByTestId("ai-panel"), "panel");

  const placement = await openAssistantPlacement();
  await waitFor(() => assert.equal(placement.dataset.presentation, "sidebar"));
  assert.equal(
    (screen.getByRole("radio", { name: /Docked sidebar/ }) as HTMLInputElement)
      .checked,
    true,
  );
});

test("a junk stored placement falls back to the tab rather than a blank workspace", async () => {
  mockRuntime({ assistantPresentation: "floating-window" });
  renderManager();
  await screen.findByRole("button", { name: "Settings" });

  assert.equal(storageManager.getAiAssistantPresentation(), "panel");
  assertAbsent(screen.queryByTestId("ai-assistant-sidebar"), "dock");
  assertAbsent(screen.queryByTestId("ai-assistant-bubble"), "bubble");
});

// ── One assistant, wherever it is ──────────────────────────────────────────

test("the command-bar control opens the bubble instead of a tab", async () => {
  mockRuntime({ assistantPresentation: "bubble" });
  renderManager();
  await screen.findByTestId("ai-assistant-bubble");

  // The command bar's control and the bubble's own launcher used to share the
  // name "Assistant", which is what this previously asserted. They no longer
  // do: the command bar names the surface and the action it will perform, so
  // the two controls are told apart by name instead of only by position.
  assert.equal(
    commandBarAssistant().getAttribute("aria-label"),
    "Show the floating assistant",
  );
  assert.deepEqual(
    screen.getAllByRole("button", { name: "Assistant" }).length,
    1,
    "only the bubble launcher should still be named just Assistant",
  );
  fireEvent.click(commandBarAssistant());

  const panel = await screen.findByTestId("ai-panel");
  assert.equal(panel.dataset.presentation, "bubble");
  assert.equal(document.querySelectorAll('[data-testid="ai-panel"]').length, 1);
});

test("an assistant tab left open while the bubble takes over points at it, not a copy", async () => {
  mockRuntime();
  renderManager();

  // Open the assistant as a tab, then move it to the bubble. The tab stays
  // open, which is exactly the state the pointer exists for.
  fireEvent.click(commandBarAssistant());
  await screen.findByTestId("ai-panel");

  await openAssistantPlacement();
  fireEvent.click(screen.getByRole("radio", { name: /Floating bubble/ }));
  const bubble = await screen.findByTestId("ai-assistant-bubble");
  // Choosing a surface from Session settings now shows it, so the bubble is
  // open here. This test used to assert zero panels at this point, which was
  // only true because the radio closed the surface it had just been asked
  // for — the defect, not a requirement.
  await waitFor(() => assert.equal(bubble.dataset.open, "true"));

  fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));

  const notice = await screen.findByTestId("ai-assistant-relocated");
  assert.equal(notice.dataset.presentation, "bubble");
  assert.match(notice.textContent ?? "", /floating over the workspace/);
  // One panel, and it is the bubble's: the tab shows a pointer rather than a
  // second panel with its own conversation and event subscription. That is
  // what this test exists for and it is unchanged.
  assert.equal(document.querySelectorAll('[data-testid="ai-panel"]').length, 1);

  // Hide it from the chrome, then bring it back through the tab's pointer —
  // the reveal path, which must still be open-only.
  fireEvent.click(commandBarAssistant());
  await waitFor(() => assert.equal(bubble.dataset.open, "false"));
  fireEvent.click(screen.getByRole("button", { name: "Show the assistant" }));
  await waitFor(() => assert.equal(bubble.dataset.open, "true"));
  assert.equal(document.querySelectorAll('[data-testid="ai-panel"]').length, 1);
});

test("moving an open assistant between surfaces keeps it open", async () => {
  // This replaces a test that asserted the opposite ("moving the assistant
  // does not pop it open"), which pinned the defect rather than a
  // requirement: it left `data-open="false"` on a dock the user had just
  // asked for. Closing a surface the user is looking at is not moving the
  // assistant, it is dismissing it.
  mockRuntime({ assistantPresentation: "bubble" });
  renderManager();
  await screen.findByTestId("ai-assistant-bubble");
  fireEvent.click(commandBarAssistant());
  await screen.findByTestId("ai-panel");

  await openAssistantPlacement();
  fireEvent.click(screen.getByRole("radio", { name: /Docked sidebar/ }));

  const dock = await screen.findByTestId("ai-assistant-sidebar");
  await waitFor(() => assert.equal(dock.dataset.open, "true"));
  assert.equal(dock.hidden, false);
  assertAbsent(screen.queryByTestId("ai-assistant-bubble"), "bubble");
});

/**
 * Open the assistant tab and wait for one of the panel's own reads to land.
 *
 * Clicked under `waitFor` for exactly the reason `openAssistantPlacement` is:
 * preference hydration sets the active tab from `last_active_tab` once it
 * settles, which can undo a click that landed first and unmount the panel
 * again. `openActionTab` is idempotent, so retrying until the thing being
 * waited for is on screen is both correct and race-free.
 */
async function openAssistantShowing(testId: string): Promise<HTMLElement> {
  const toolbar = await screen.findByRole("toolbar", {
    name: "Global application controls",
  });
  await waitFor(() => {
    fireEvent.click(within(toolbar).getByTestId("command-bar-assistant"));
    assert.ok(screen.getByTestId(testId));
  });
  return screen.getByTestId(testId);
}

// ── Where an assistant-offered link actually goes ──────────────────────────

/** A plan whose only step is blocked by the assistant's own policy. */
function assistantPolicyBlockedPlan(): AiPlan {
  const base = mcpBlockedPlan();
  return {
    ...base,
    steps: [
      {
        ...base.steps[0],
        refusal: { source: "assistantPolicy", reason: "denied by mode" },
      },
    ],
  };
}

/** A plan whose only step is blocked by the app's MCP grants. */
function mcpBlockedPlan(): AiPlan {
  return {
    id: "plan-1",
    conversationId: CONVERSATION.id,
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
    createdAt: CONVERSATION.createdAt,
    updatedAt: CONVERSATION.updatedAt,
  };
}

test("a workspace link opens that workspace through the app's own tab opener", async () => {
  mockRuntime(null, {
    conversations: [CONVERSATION],
    links: [{ kind: "workspace", label: "Audit log", target: "audit" }],
  });
  renderManager();

  const link = await openAssistantShowing("ai-link");
  assert.equal(link.dataset.kind, "workspace");
  assert.equal(link.dataset.destination, "audit");
  fireEvent.click(link);

  // `openActionTab("audit")` is the same call the command bar's own Audit
  // button makes. There is no second route into a workspace.
  await waitFor(() =>
    assert.ok(
      within(screen.getByRole("tablist", { name: "DNS workspaces" })).getByRole(
        "tab",
        { name: /Audit/ },
      ),
    ),
  );
});

test("a registry link opens the Registry workspace, like an expiry notice does", async () => {
  mockRuntime(null, {
    conversations: [CONVERSATION],
    links: [
      {
        kind: "domainRegistry",
        label: "example.test registration",
        target: "example.test",
      },
    ],
  });
  renderManager();

  const link = await openAssistantShowing("ai-link");
  assert.equal(link.dataset.destination, "example.test");
  // The same accessible name the expiry notice's own control carries, because
  // it is the same destination reached the same way.
  assert.equal(
    link.getAttribute("aria-label"),
    "Check example.test in the registry",
  );
  fireEvent.click(link);

  await waitFor(() =>
    assert.ok(
      within(screen.getByRole("tablist", { name: "DNS workspaces" })).getByRole(
        "tab",
        { name: /Registry/ },
      ),
    ),
  );
});

test("a zone link is offered for a zone this account has, and not for another", async () => {
  mockRuntime(null, {
    conversations: [CONVERSATION],
    links: [
      { kind: "zone", label: "example.test", target: ZONE.id },
      { kind: "zone", label: "somebody else's", target: "zone-9999" },
    ],
  });
  renderManager();

  const list = await openAssistantShowing("ai-link-list");
  // The closed set is the account's own zone list, which is a check the
  // backend cannot make: it validates the id's shape, not whose zone it is.
  await waitFor(() => assert.equal(list.dataset.usable, "1"));
  assert.equal(list.dataset.dropped, "1");
  assert.equal(screen.getByTestId("ai-link").dataset.destination, ZONE.id);
});

test("a blocked step's MCP pointer lands on Session settings, MCP", async () => {
  mockRuntime(null, {
    conversations: [CONVERSATION],
    plan: mcpBlockedPlan(),
  });
  renderManager();

  const control = await openAssistantShowing(
    "ai-plan-step-open-mcp-permissions",
  );
  fireEvent.click(control);

  // The app's MCP grants are the layer nothing under `ai_*` can change, so
  // the assistant points at the screen that owns them — reached through the
  // same `openActionTab`/subtab pair the settings nav uses.
  await waitFor(() => {
    const mcp = screen.getByRole("button", { name: "MCP" });
    assert.equal(mcp.dataset.active, "true");
  });
});

// ── Showing and hiding the dock from the chrome ────────────────────────────

test("choosing the dock in Session settings makes it visible straight away", async () => {
  // The reported defect. `assistantOpen` starts false and the dock renders as
  // a hidden `<aside>` with no panel inside until it has been opened once, so
  // a radio that wrote the preference and closed the surface showed nothing —
  // permanently, for anyone who never found the command-bar button.
  mockRuntime();
  renderManager();

  await openAssistantPlacement();
  fireEvent.click(screen.getByRole("radio", { name: /Docked sidebar/ }));

  const dock = await screen.findByTestId("ai-assistant-sidebar");
  await waitFor(() => assert.equal(dock.dataset.open, "true"));
  assert.equal(dock.hidden, false);
  // `display` is applied only while visible, because a Tailwind `flex`
  // utility outranks the user-agent `[hidden] { display: none }` rule.
  assert.match(dock.className, /(?:^|\s)flex(?:$|\s)/);
  // And the panel is really inside it, not merely a frame.
  assert.ok(within(dock).getByTestId("ai-panel"));
});

test("choosing the bubble in Session settings makes it visible straight away", async () => {
  mockRuntime();
  renderManager();

  await openAssistantPlacement();
  fireEvent.click(screen.getByRole("radio", { name: /Floating bubble/ }));

  const bubble = await screen.findByTestId("ai-assistant-bubble");
  await waitFor(() => assert.equal(bubble.dataset.open, "true"));
  assert.ok(within(bubble).getByTestId("ai-panel"));
});

test("choosing the tab leaves no surface on screen and does not navigate away", async () => {
  mockRuntime({ assistantPresentation: "sidebar" });
  renderManager();
  await screen.findByTestId("ai-assistant-sidebar");

  const fieldset = await openAssistantPlacement();
  fireEvent.click(screen.getByRole("radio", { name: /Workspace tab/ }));

  // No dock and no bubble: the tab placement has neither.
  await waitFor(() =>
    assertAbsent(screen.queryByTestId("ai-assistant-sidebar"), "dock"),
  );
  assertAbsent(screen.queryByTestId("ai-assistant-bubble"), "bubble");
  // Still on the settings page the user was reading. Navigating someone out
  // of Session settings because they touched a radio is hostile, which is the
  // half of the original reasoning that was sound.
  assert.ok(fieldset.isConnected);
  assert.ok(screen.getByRole("button", { name: "General" }));
  // And the absence is explained rather than mysterious: the confirmation
  // says where it went and how to open it.
  await waitFor(() =>
    assert.match(
      screen.getByTestId("toast-probe").textContent ?? "",
      /Assistant opens as a workspace tab\. Use the Assistant button in the toolbar to open it\./,
    ),
  );
});

test("the command-bar control hides an open dock and brings it back", async () => {
  mockRuntime({ assistantPresentation: "sidebar" });
  renderManager();
  const dock = await screen.findByTestId("ai-assistant-sidebar");

  // Open it first, then prove the same control closes it. Before this there
  // was no way at all to dismiss the dock from the chrome.
  await waitFor(() => {
    fireEvent.click(commandBarAssistant());
    assert.equal(dock.dataset.open, "true");
  });
  assert.equal(
    commandBarAssistant().getAttribute("aria-pressed"),
    "true",
    "the chrome must say the dock is open",
  );
  assert.equal(
    commandBarAssistant().getAttribute("aria-label"),
    "Hide the docked assistant",
  );

  fireEvent.click(commandBarAssistant());
  await waitFor(() => assert.equal(dock.dataset.open, "false"));
  assert.equal(dock.hidden, true);
  assert.equal(commandBarAssistant().getAttribute("aria-pressed"), "false");
  assert.equal(
    commandBarAssistant().getAttribute("aria-label"),
    "Show the docked assistant",
  );

  fireEvent.click(commandBarAssistant());
  await waitFor(() => assert.equal(dock.dataset.open, "true"));
});

test("in tab placement the command-bar control stays a reveal", async () => {
  // Activating a workspace tab is not something you un-activate, so a second
  // press must not close the tab — and `aria-pressed` would be a lie.
  mockRuntime();
  renderManager();
  await screen.findByRole("button", { name: "Settings" });

  assert.equal(commandBarAssistant().getAttribute("aria-pressed"), null);
  await waitFor(() => {
    fireEvent.click(commandBarAssistant());
    assert.ok(screen.getByTestId("ai-panel"));
  });
  fireEvent.click(commandBarAssistant());
  // Still there: the tab is activated again rather than dismissed.
  assert.ok(screen.getByTestId("ai-panel"));
  assert.equal(commandBarAssistant().getAttribute("aria-label"), "Assistant");
});

// ── The claims the removed in-assistant placement tests carried ────────────

test("moving the assistant through every placement never mounts two of them", async () => {
  // This is the surviving half of a test that drove the assistant's own
  // placement dropdown, which went with its settings view. The claim is about
  // the assistant, not about which control changed it: one panel, always.
  mockRuntime();
  renderManager();
  await screen.findByRole("button", { name: "Settings" });

  await waitFor(() => {
    fireEvent.click(commandBarAssistant());
    assert.equal(mountedPanels(), 1);
  });

  const fieldset = await openAssistantPlacement();

  // Tab -> bubble. The tab stays open and must point at the bubble rather
  // than render a second panel with its own conversation and subscription.
  fireEvent.click(screen.getByRole("radio", { name: /Floating bubble/ }));
  await screen.findByTestId("ai-assistant-bubble");
  await waitFor(() => assert.equal(mountedPanels(), 1));

  // Bubble -> dock.
  fireEvent.click(screen.getByRole("radio", { name: /Docked sidebar/ }));
  await screen.findByTestId("ai-assistant-sidebar");
  await waitFor(() => assert.equal(mountedPanels(), 1));
  assertAbsent(screen.queryByTestId("ai-assistant-bubble"), "bubble");

  // Dock -> tab. Neither floating surface may be left behind.
  fireEvent.click(screen.getByRole("radio", { name: /Workspace tab/ }));
  await waitFor(() =>
    assertAbsent(screen.queryByTestId("ai-assistant-sidebar"), "dock"),
  );
  assertAbsent(screen.queryByTestId("ai-assistant-bubble"), "bubble");
  assert.ok(fieldset.isConnected, "still on the settings page");
});

test("moving the assistant does not cancel a run", async () => {
  // Also from the removed tests. The chromes are different parents, so the
  // panel is remounted rather than moved — but a remount only drops the
  // `ai:event` subscription. Cancelling the turn would be the thing that
  // actually loses work, and nothing does.
  mockRuntime({ assistantPresentation: "sidebar" });
  const cancelled: unknown[] = [];
  mock.method(TauriClient, "aiCancelGeneration", async (id: unknown) => {
    cancelled.push(id);
    return true;
  });
  renderManager();
  await screen.findByTestId("ai-assistant-sidebar");

  await openAssistantPlacement();
  fireEvent.click(screen.getByRole("radio", { name: /Floating bubble/ }));
  await screen.findByTestId("ai-assistant-bubble");

  await waitFor(() => assert.equal(mountedPanels(), 1));
  assert.deepEqual(cancelled, []);
});

// ── The assistant's settings, in the Settings workspace ────────────────────

test("the assistant's settings are a section of the app's Settings workspace", async () => {
  mockRuntime();
  renderManager();

  const toolbar = await screen.findByRole("toolbar", {
    name: "Global application controls",
  });
  // Scoped to the settings nav: the command bar's own control is also named
  // "Assistant" in tab placement, which is the one placement this test is in.
  await waitFor(() => {
    fireEvent.click(within(toolbar).getByRole("button", { name: "Settings" }));
    assert.ok(
      within(
        screen.getByRole("toolbar", { name: "Session settings sections" }),
      ).getByRole("button", { name: "Assistant" }),
    );
  });
  fireEvent.click(
    within(
      screen.getByRole("toolbar", { name: "Session settings sections" }),
    ).getByRole("button", { name: "Assistant" }),
  );

  // The same `AiSettingsPanel`, re-hosted: its section nav is here, and the
  // assistant surface no longer has a settings view of its own.
  const host = await screen.findByTestId("assistant-settings-host");
  assert.ok(
    within(host).getByRole("toolbar", { name: "Assistant settings sections" }),
  );
  assertAbsent(screen.queryByTestId("ai-panel"), "an assistant panel");
});

test("a blocked plan step lands on Tools & permissions in the Settings workspace", async () => {
  mockRuntime(null, {
    conversations: [CONVERSATION],
    plan: assistantPolicyBlockedPlan(),
  });
  renderManager();

  const control = await openAssistantShowing(
    "ai-plan-step-open-assistant-tools",
  );
  fireEvent.click(control);

  // The assistant does not own that screen any more, so it asks the host —
  // which opens the Settings workspace on the Assistant section and selects
  // Tools & permissions, through the same `openActionTab`/subtab pair the
  // settings nav uses.
  const host = await screen.findByTestId("assistant-settings-host");
  await waitFor(() =>
    assert.equal(
      within(host)
        .getByRole("button", { name: "Tools & permissions" })
        .getAttribute("aria-pressed"),
      "true",
    ),
  );
});
