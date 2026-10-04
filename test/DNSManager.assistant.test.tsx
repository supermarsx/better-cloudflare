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
import { storageManager } from "../src/lib/storage/storage";
import type { AgentConfig } from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";
import {
  chooseThemedSelectValue,
  enableThemedSelectEnvironment,
  themedSelectValue,
} from "./radix-select";

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

function mockRuntime(
  storedProfile: Record<string, unknown> | null = null,
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

  // The assistant only reaches for these once it is actually opened.
  mock.method(TauriClient, "aiListProviders", async () => []);
  mock.method(TauriClient, "aiGetConfig", async () => AGENT_CONFIG);
  mock.method(TauriClient, "aiListConversations", async () => []);
  mock.method(TauriClient, "onAiEvent", async () => () => {});
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

function renderManager() {
  return render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
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

/**
 * Open the placement control inside the assistant itself: Settings -> Behaviour
 * on the panel's own nav.
 *
 * Scoped to the panel throughout. "Settings" names both the workspace tab in
 * the command bar and the assistant's own view switch, and "Behaviour" would be
 * unambiguous today but is one section rename away from not being.
 */
async function openAssistantOwnPlacement(): Promise<HTMLElement> {
  const panel = await screen.findByTestId("ai-panel");
  fireEvent.click(
    within(
      within(panel).getByRole("toolbar", { name: "Assistant views" }),
    ).getByRole("button", { name: "Settings" }),
  );
  fireEvent.click(
    within(
      await screen.findByRole("toolbar", {
        name: "Assistant settings sections",
      }),
    ).getByRole("button", { name: "Behaviour" }),
  );
  // The themed dropdown's trigger, not a native `<select>`: it is driven
  // through `chooseThemedSelectValue`. See `test/radix-select.ts`.
  return screen.findByLabelText("Placement");
}

/** Every mounted assistant panel. More than one is the bug this guards. */
function mountedPanels(): number {
  return document.querySelectorAll('[data-testid="ai-panel"]').length;
}

/** The command bar's assistant control, distinct from a bubble launcher. */
function commandBarAssistant(): HTMLElement {
  const toolbar = screen.getByRole("toolbar", {
    name: "Global application controls",
  });
  return within(toolbar).getByRole("button", { name: "Assistant" });
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

  // Two controls are named "Assistant" now: the command bar and the launcher.
  const controls = screen.getAllByRole("button", { name: "Assistant" });
  assert.equal(controls.length, 2);
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
  await screen.findByTestId("ai-assistant-bubble");

  fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));

  const notice = await screen.findByTestId("ai-assistant-relocated");
  assert.equal(notice.dataset.presentation, "bubble");
  assert.match(notice.textContent ?? "", /floating over the workspace/);
  // Zero panels: the tab shows the pointer, and the bubble is still closed.
  assert.equal(document.querySelectorAll('[data-testid="ai-panel"]').length, 0);

  fireEvent.click(screen.getByRole("button", { name: "Show the assistant" }));
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("ai-assistant-bubble").dataset.open,
      "true",
    ),
  );
  assert.equal(document.querySelectorAll('[data-testid="ai-panel"]').length, 1);
});

// ── Moving it from inside it ───────────────────────────────────────────────

test("the assistant can be moved from its own settings, and the choice persists", async () => {
  const harness = mockRuntime({ assistantPresentation: "bubble" });
  renderManager();
  await screen.findByTestId("ai-assistant-bubble");
  fireEvent.click(commandBarAssistant());

  // The control has to be reachable here at all: the bubble and the dock are
  // the two placements with no workspace settings tab in front of them.
  const placement = await openAssistantOwnPlacement();
  assert.equal(await themedSelectValue(placement), "bubble");

  await chooseThemedSelectValue(await openAssistantOwnPlacement(), "sidebar");

  // It takes effect immediately, in both stores the preference lives in.
  const dock = await screen.findByTestId("ai-assistant-sidebar");
  await waitFor(() =>
    assert.equal(storageManager.getAiAssistantPresentation(), "sidebar"),
  );
  await waitFor(() => {
    const profile = writtenProfile(harness);
    assert.ok(profile, "a session profile must have been written");
    assert.equal(profile.assistantPresentation, "sidebar");
  });

  // And — unlike the workspace's own placement radios — it does not make the
  // assistant vanish out from under the control the user just used.
  assert.equal(dock.dataset.open, "true");
  assert.equal(dock.hidden, false);
  assertAbsent(screen.queryByTestId("ai-assistant-bubble"), "bubble");
  assert.equal(mountedPanels(), 1);
});

test("switching placement from inside the assistant never mounts two of them", async () => {
  mockRuntime();
  renderManager();
  await screen.findByRole("button", { name: "Settings" });

  // Start in the tab, which is the one placement DNSManager renders itself.
  fireEvent.click(commandBarAssistant());
  await waitFor(() => assert.equal(mountedPanels(), 1));

  // Tab -> bubble. The tab stays open and must point at the bubble rather than
  // render a second panel with its own conversation and event subscription.
  await chooseThemedSelectValue(await openAssistantOwnPlacement(), "bubble");
  await screen.findByTestId("ai-assistant-bubble");
  await waitFor(() => assert.equal(mountedPanels(), 1));
  assert.ok(screen.getByTestId("ai-assistant-relocated"));

  // Bubble -> dock, through the bubble's own copy of the control.
  await chooseThemedSelectValue(await openAssistantOwnPlacement(), "sidebar");
  await screen.findByTestId("ai-assistant-sidebar");
  await waitFor(() => assert.equal(mountedPanels(), 1));
  assertAbsent(screen.queryByTestId("ai-assistant-bubble"), "bubble");

  // Dock -> tab. Switching back must leave neither floating surface behind,
  // and must open the tab, or the assistant would disappear entirely.
  await chooseThemedSelectValue(await openAssistantOwnPlacement(), "panel");
  await waitFor(() =>
    assertAbsent(screen.queryByTestId("ai-assistant-sidebar"), "dock"),
  );
  assertAbsent(screen.queryByTestId("ai-assistant-bubble"), "bubble");
  assertAbsent(
    screen.queryByTestId("ai-assistant-relocated"),
    "relocation notice while the assistant is the tab again",
  );
  assert.equal(mountedPanels(), 1);
  assert.equal(
    screen.getByTestId("ai-panel").dataset.presentation,
    "panel",
    "the surviving panel is the tab's",
  );
});

test("moving the assistant from its own settings does not cancel a run", async () => {
  mockRuntime({ assistantPresentation: "sidebar" });
  const cancelled: unknown[] = [];
  mock.method(TauriClient, "aiCancelGeneration", async (id: unknown) => {
    cancelled.push(id);
    return true;
  });
  renderManager();
  await screen.findByTestId("ai-assistant-sidebar");
  fireEvent.click(commandBarAssistant());

  await chooseThemedSelectValue(await openAssistantOwnPlacement(), "bubble");
  await screen.findByTestId("ai-assistant-bubble");

  // The chromes are different parents, so the panel is remounted rather than
  // moved — but a remount only drops the `ai:event` subscription. Cancelling
  // the turn would be the thing that actually loses work, and nothing does.
  await waitFor(() => assert.equal(mountedPanels(), 1));
  assert.deepEqual(cancelled, []);
});

test("moving the assistant does not pop it open", async () => {
  mockRuntime({ assistantPresentation: "bubble" });
  renderManager();
  await screen.findByTestId("ai-assistant-bubble");
  fireEvent.click(commandBarAssistant());
  await screen.findByTestId("ai-panel");

  await openAssistantPlacement();
  fireEvent.click(screen.getByRole("radio", { name: /Docked sidebar/ }));

  const dock = await screen.findByTestId("ai-assistant-sidebar");
  assert.equal(dock.dataset.open, "false");
  assertAbsent(screen.queryByTestId("ai-assistant-bubble"), "bubble");
});
