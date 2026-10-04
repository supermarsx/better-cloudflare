/**
 * The assistant's sectioned settings panel.
 *
 * Two things are pinned here that the app's own settings strips do not do, and
 * that are the reason this panel exists as its own component:
 *
 * 1. The nav is a real ARIA toolbar — one tab stop, arrow keys inside it,
 *    Home/End to the ends. Four sections behind four Tab presses was the state
 *    before.
 * 2. Exactly one section is mounted at a time, so opening settings does not
 *    fire the permission-catalog and persona reads for sections nobody opened.
 *
 * It also pins the shared idiom itself: the same `role="toolbar"` /
 * `.ui-segment-group` / `.ui-segment` markup as the workspace's Session
 * settings and the Notifications settings view. A refactor that quietly swaps
 * it for something else should fail here.
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
  AI_SETTINGS_SECTIONS,
  AiSettingsPanel,
  type AiSettingsSection,
} from "../src/components/ai/AiSettingsPanel";
import { TauriClient } from "../src/lib/api/tauri-client";
import type {
  AgentConfig,
  AiPermissionsSnapshot,
  AiPersona,
  AiProviderProfile,
} from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";

const CONFIG: AgentConfig = {
  maxToolRounds: 8,
  maxTokensPerTurn: 4096,
  toolsEnabled: false,
  stream: true,
  preset: "default",
  temperature: 0.7,
  topP: 1,
  personaId: null,
  defaultProviderId: "openai-main",
};

const PROFILE: AiProviderProfile = {
  id: "openai-main",
  label: "OpenAI",
  protocol: "openai",
  baseUrl: "https://gateway.test/openai/v1",
  model: "gpt-4o-mini",
  temperature: 0.7,
  maxTokens: 4096,
  hasApiKey: true,
};

const PERMISSIONS: AiPermissionsSnapshot = {
  mode: "readOnly",
  tools: {},
  catalog: [
    {
      name: "cf_list_dns_records",
      classification: "read",
      description: "List records",
      permission: "allow",
    },
  ],
};

const PERSONA: AiPersona = {
  id: "dns-expert",
  name: "DNS expert",
  description: "Explains records",
  systemPrompt: "You are a DNS expert.",
  builtin: true,
};

interface Harness {
  sections: AiSettingsSection[];
  /** Which `ai_*` reads the panel caused, so lazy mounting is observable. */
  calls: string[];
}

/**
 * Renders the panel with its own section state, so the nav can be driven the
 * way the assistant drives it rather than against a frozen prop.
 *
 * `section` in the overrides seeds the initial state and is then owned by the
 * host, which is why it is pulled out rather than spread through.
 */
function renderPanel(
  overrides: Partial<React.ComponentProps<typeof AiSettingsPanel>> = {},
): Harness {
  const harness: Harness = { sections: [], calls: [] };
  const { section: initialSection, ...rest } = overrides;

  mock.method(TauriClient, "aiGetPermissions", async () => {
    harness.calls.push("permissions");
    return PERMISSIONS;
  });
  mock.method(TauriClient, "aiListPersonas", async () => {
    harness.calls.push("personas");
    return [PERSONA];
  });

  function Host() {
    const [section, setSection] = React.useState<AiSettingsSection>(
      initialSection ?? "providers",
    );
    return (
      <AiSettingsPanel
        compact={false}
        providers={[PROFILE]}
        providersLoading={false}
        providersError={null}
        onRefreshProviders={() => {}}
        onSaveProvider={async () => null}
        onDeleteProvider={async () => {}}
        config={CONFIG}
        configBusy={false}
        onSaveConfig={async () => {}}
        onSelectPersona={() => {}}
        onSetDefaultProvider={() => {}}
        {...rest}
        section={section}
        onSectionChange={(next) => {
          harness.sections.push(next);
          setSection(next);
        }}
      />
    );
  }

  render(<Host />);
  return harness;
}

function nav(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Assistant settings sections" });
}

function segment(label: string | RegExp): HTMLElement {
  return within(nav()).getByRole("button", { name: label });
}

function assertAbsent(node: Element | null, label: string): void {
  assert.ok(node === null, `expected no ${label}`);
}

/**
 * Settle the reads that a section started and that the test then navigated
 * away from.
 *
 * Mounting Tools & permissions or Personas fires a command; passing through
 * them leaves its resolution in flight, and a state update that lands after
 * the test body has finished is the "not wrapped in act" warning. There is
 * nothing left on screen to wait for by then, so the microtask queue is
 * flushed inside `act` instead.
 */
async function settlePendingReads(): Promise<void> {
  await act(async () => {});
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

// ── The shared idiom ───────────────────────────────────────────────────────

test("the nav is the app's own segmented strip, not a one-off", () => {
  renderPanel();

  const strip = nav();
  // The same classes the workspace's Session settings strip and the
  // Notifications settings strip carry. Consistency here was the request.
  for (const required of [
    "ui-segment-group",
    "glass-surface",
    "glass-sheen",
    "scrollbar-themed",
  ]) {
    assert.ok(
      strip.classList.contains(required),
      `the nav must keep the shared .${required}`,
    );
  }
  for (const entry of AI_SETTINGS_SECTIONS) {
    const button = within(strip).getByRole("button", {
      name: new RegExp(`^${entry.label.replace("&", "&")}`),
    });
    assert.ok(
      button.classList.contains("ui-segment"),
      `${entry.label} must be a .ui-segment`,
    );
  }
});

test("every section is reachable and the current one is obvious", async () => {
  const harness = renderPanel();

  // Providers is the landing section: it is the only one that can be required
  // before the assistant works at all.
  assert.equal(screen.getByTestId("ai-settings").dataset.section, "providers");
  assert.equal(segment(/^Providers/).dataset.active, "true");
  assert.equal(segment(/^Providers/).getAttribute("aria-pressed"), "true");

  for (const entry of AI_SETTINGS_SECTIONS) {
    fireEvent.click(segment(new RegExp(`^${entry.label}`)));
    assert.equal(
      screen.getByTestId("ai-settings").dataset.section,
      entry.id,
      `clicking ${entry.label} must open it`,
    );
    const button = segment(new RegExp(`^${entry.label}`));
    assert.equal(button.dataset.active, "true");
    assert.equal(button.getAttribute("aria-pressed"), "true");
    // Exactly one segment claims to be current.
    const active = within(nav())
      .getAllByRole("button")
      .filter((node) => node.dataset.active === "true");
    assert.equal(active.length, 1);
  }
  assert.deepEqual(
    harness.sections,
    AI_SETTINGS_SECTIONS.map((entry) => entry.id),
  );
  // Let the reads the last two sections started settle inside the test: the
  // row, not just the section, so the list state lands before the test ends.
  await waitFor(() =>
    assert.deepEqual(harness.calls, ["permissions", "personas"]),
  );
  await screen.findByTestId("ai-persona-row");
});

test("the body is a labelled group tied to the active segment", async () => {
  renderPanel();

  const active = segment(/^Providers/);
  const panel = screen.getByRole("group", { name: /^Providers/ });
  assert.equal(active.getAttribute("aria-controls"), panel.id);
  assert.equal(panel.getAttribute("aria-labelledby"), active.id);

  fireEvent.click(segment("Personas"));
  const next = screen.getByRole("group", { name: "Personas" });
  assert.equal(next.getAttribute("aria-labelledby"), segment("Personas").id);
  await screen.findByTestId("ai-persona-row");
});

// ── Keyboard navigation ────────────────────────────────────────────────────

test("the strip is one tab stop, and the arrows move inside it", async () => {
  renderPanel();

  const stops = () =>
    within(nav())
      .getAllByRole("button")
      .filter((node) => node.tabIndex === 0)
      .map((node) => node.dataset.section);

  // A toolbar is a single tab stop; the selected segment is the one that has
  // it, so Tab crosses the strip in one press instead of four.
  assert.deepEqual(stops(), ["providers"]);

  fireEvent.keyDown(nav(), { key: "ArrowRight" });
  assert.equal(screen.getByTestId("ai-settings").dataset.section, "behaviour");
  assert.deepEqual(stops(), ["behaviour"]);
  // Focus follows the selection, so the next arrow press continues from here.
  assert.equal(document.activeElement, segment("Behaviour"));

  fireEvent.keyDown(nav(), { key: "ArrowRight" });
  assert.equal(screen.getByTestId("ai-settings").dataset.section, "tools");

  fireEvent.keyDown(nav(), { key: "ArrowLeft" });
  assert.equal(screen.getByTestId("ai-settings").dataset.section, "behaviour");

  // Down and Up are accepted too: the strip scrolls sideways on a narrow
  // surface, and which axis a user reaches for there is not predictable.
  fireEvent.keyDown(nav(), { key: "ArrowDown" });
  assert.equal(screen.getByTestId("ai-settings").dataset.section, "tools");
  fireEvent.keyDown(nav(), { key: "ArrowUp" });
  assert.equal(screen.getByTestId("ai-settings").dataset.section, "behaviour");
  await settlePendingReads();
});

test("the arrows wrap, and Home and End jump to the ends", async () => {
  renderPanel();
  const last = AI_SETTINGS_SECTIONS.at(-1);
  assert.ok(last);

  fireEvent.keyDown(nav(), { key: "ArrowLeft" });
  assert.equal(screen.getByTestId("ai-settings").dataset.section, last.id);
  fireEvent.keyDown(nav(), { key: "ArrowRight" });
  assert.equal(screen.getByTestId("ai-settings").dataset.section, "providers");

  fireEvent.keyDown(nav(), { key: "End" });
  assert.equal(screen.getByTestId("ai-settings").dataset.section, last.id);
  fireEvent.keyDown(nav(), { key: "Home" });
  assert.equal(screen.getByTestId("ai-settings").dataset.section, "providers");
  await settlePendingReads();
});

test("an unrelated key leaves the section alone", () => {
  const harness = renderPanel();

  for (const key of ["a", "Tab", "Enter", "PageDown"]) {
    fireEvent.keyDown(nav(), { key });
  }
  assert.equal(screen.getByTestId("ai-settings").dataset.section, "providers");
  assert.deepEqual(harness.sections, []);
});

// ── First run ──────────────────────────────────────────────────────────────

test("an unconfigured install marks Providers in the nav and says so", () => {
  renderPanel({
    providers: [],
    config: { ...CONFIG, defaultProviderId: null },
  });

  // The dot is decorative; the words are folded into the button's accessible
  // name so the signal is not sight-only.
  assert.ok(screen.getByTestId("ai-settings-attention"));
  assert.ok(segment("Providers (needs setup)"));
  assert.ok(screen.getByTestId("ai-providers-empty"));
});

test("the attention marker is not shown while the list is still loading", () => {
  renderPanel({ providers: [], providersLoading: true });

  // A nav that cries for attention during a round trip is noise, not a signal.
  assertAbsent(
    screen.queryByTestId("ai-settings-attention"),
    "attention marker while loading",
  );
  assert.ok(segment("Providers"));
});

test("a configured install leaves the nav unmarked", () => {
  renderPanel();

  assertAbsent(
    screen.queryByTestId("ai-settings-attention"),
    "attention marker once a provider exists",
  );
});

// ── One section mounted at a time ──────────────────────────────────────────

test("only the open section reads its backend state", async () => {
  const harness = renderPanel();

  // Opening settings on Providers must not fetch the tool catalog or the
  // persona list for sections nobody looked at.
  assert.deepEqual(harness.calls, []);
  assert.ok(screen.getByTestId("ai-providers"));
  assertAbsent(
    screen.queryByTestId("ai-permissions"),
    "the permission section while Providers is open",
  );

  fireEvent.click(segment("Tools & permissions"));
  await waitFor(() => assert.deepEqual(harness.calls, ["permissions"]));
  assert.ok(screen.getByTestId("ai-permissions"));
  assert.ok(screen.getByRole("switch", { name: "Tool use" }));
  assertAbsent(
    screen.queryByTestId("ai-providers"),
    "the provider section while Tools & permissions is open",
  );

  fireEvent.click(segment("Personas"));
  await waitFor(() =>
    assert.deepEqual(harness.calls, ["permissions", "personas"]),
  );
  // Waiting for the row, not just the section, settles the list state inside
  // the test rather than after it.
  assert.ok(await screen.findByTestId("ai-persona-row"));
  assert.ok(screen.getByTestId("ai-personas"));

  fireEvent.click(segment("Behaviour"));
  assert.ok(screen.getByTestId("ai-agent-settings"));
  // Behaviour reads nothing of its own: agent config is already in hand.
  assert.deepEqual(harness.calls, ["permissions", "personas"]);
});

test("the tool-use switch reports agent config and cannot be flipped here", async () => {
  renderPanel({ config: { ...CONFIG, toolsEnabled: true } });

  fireEvent.click(segment("Tools & permissions"));
  // The permission read settles inside this await, so its state update is not
  // left to land outside `act`.
  await screen.findByTestId("ai-permissions");
  const toggle = screen.getByRole("switch", { name: "Tool use" });
  assert.equal((toggle as HTMLButtonElement).disabled, true);
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  // One switch for one piece of state: the chat view owns the opt-out, and a
  // second control here could disagree with it.
  assert.equal(screen.getAllByRole("switch", { name: "Tool use" }).length, 1);
});

// ── Narrow surfaces ────────────────────────────────────────────────────────

test("a narrow surface keeps the same scrolling strip, with every section on it", async () => {
  renderPanel({ compact: true });

  assert.equal(screen.getByTestId("ai-settings").dataset.compact, "true");
  // The strip does not collapse into a menu or wrap onto a second row: it is
  // the same `.ui-segment-group` scroller, so every section stays one press or
  // one click away in the dock and the bubble too.
  const strip = nav();
  assert.ok(strip.classList.contains("ui-segment-group"));
  assert.equal(
    within(strip).getAllByRole("button").length,
    AI_SETTINGS_SECTIONS.length,
  );
  assertAbsent(
    screen.queryByRole("combobox", { name: "Assistant settings sections" }),
    "a dropdown replacing the nav on a narrow surface",
  );

  // And the keyboard path still works, which is what makes an off-screen
  // segment reachable when the strip is scrolled.
  fireEvent.keyDown(strip, { key: "End" });
  assert.equal(
    screen.getByTestId("ai-settings").dataset.section,
    AI_SETTINGS_SECTIONS.at(-1)?.id,
  );
  await settlePendingReads();
});

// ── Unread config ──────────────────────────────────────────────────────────

test("every section renders before agent config has arrived", async () => {
  renderPanel({ config: null });

  // `ai_get_config` is a round trip; a section that threw or showed a wrong
  // value in the meantime would be worse than one that waits.
  assert.ok(screen.getByTestId("ai-providers"));
  fireEvent.click(segment("Behaviour"));
  assert.ok(screen.getByTestId("ai-agent-settings"));
  fireEvent.click(segment("Tools & permissions"));
  await screen.findByTestId("ai-permissions");
  assert.equal(
    screen
      .getByRole("switch", { name: "Tool use" })
      .getAttribute("aria-checked"),
    "false",
  );
  fireEvent.click(segment("Personas"));
  assert.ok(await screen.findByTestId("ai-persona-row"));
});
