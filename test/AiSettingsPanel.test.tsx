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

import { AI_SELECT_CONTENT_CLASS } from "../src/components/ai/ai-select";
import {
  AI_SETTINGS_SECTIONS,
  AiSettingsPanel,
  placementFromPickerValue,
  type AiSettingsSection,
} from "../src/components/ai/AiSettingsPanel";
import { TauriClient } from "../src/lib/api/tauri-client";
import {
  AI_ASSISTANT_PRESENTATION_OPTIONS,
  AI_ASSISTANT_PRESENTATIONS,
  type AiAssistantPresentation,
} from "../src/lib/ai/presentation";
import type {
  AgentConfig,
  AiPermissionsSnapshot,
  AiPersona,
  AiProviderProfile,
} from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";
import {
  chooseThemedSelectValue,
  closeThemedSelect,
  enableThemedSelectEnvironment,
  openThemedSelect,
  themedSelectLabels,
  themedSelectValue,
  themedSelectValues,
} from "./radix-select";

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
  availability: {
    dispatchAvailable: true,
    grantedToolCount: 1,
    usableToolCount: 1,
    registeredToolCount: 48,
  },
};

const PERSONA: AiPersona = {
  id: "dns-expert",
  name: "DNS expert",
  description: "Explains records",
  systemPrompt: "You are a DNS expert.",
  builtin: true,
};

const CAPABILITIES = {
  openai: ["topP", "stop", "seed", "frequencyPenalty", "presencePenalty"],
  anthropic: ["topP", "topK", "stop"],
  ollama: ["topP", "topK", "stop", "seed"],
} as const;

interface Harness {
  sections: AiSettingsSection[];
  /** Which `ai_*` reads the panel caused, so lazy mounting is observable. */
  calls: string[];
  /** Every placement the control asked for, in order. */
  placements: AiAssistantPresentation[];
  /** Every agent config the panel asked to store, in order. */
  configs: AgentConfig[];
}

/**
 * Renders the panel with its own section and placement state, so both can be
 * driven the way the assistant drives them rather than against a frozen prop.
 *
 * `section` and `presentation` in the overrides seed the initial state and are
 * then owned by the host, which is why they are pulled out rather than spread
 * through. Passing `onPresentationChange: undefined` explicitly is how a host
 * that does not own the preference is simulated.
 */
function renderPanel(
  overrides: Partial<React.ComponentProps<typeof AiSettingsPanel>> = {},
): Harness {
  const harness: Harness = {
    sections: [],
    calls: [],
    placements: [],
    configs: [],
  };
  const {
    section: initialSection,
    presentation: initialPresentation,
    onSaveConfig: saveConfig,
    ...rest
  } = overrides;
  const ownsPlacement = !("onPresentationChange" in overrides);
  // `config: null` is a meaningful initial value (the read has not answered),
  // so presence decides rather than nullishness.
  const initialConfig =
    "config" in overrides ? (overrides.config ?? null) : CONFIG;

  mock.method(TauriClient, "aiGetPermissions", async () => {
    harness.calls.push("permissions");
    return PERMISSIONS;
  });
  mock.method(TauriClient, "aiListPersonas", async () => {
    harness.calls.push("personas");
    return [PERSONA];
  });
  mock.method(TauriClient, "aiProtocolCapabilities", async () => {
    harness.calls.push("capabilities");
    return CAPABILITIES;
  });

  function Host() {
    const [section, setSection] = React.useState<AiSettingsSection>(
      initialSection ?? "providers",
    );
    const [presentation, setPresentation] =
      React.useState<AiAssistantPresentation>(initialPresentation ?? "panel");
    // The host owns the config, the way `AiAssistantPanel` does: a successful
    // `ai_set_config` replaces it, and a refused one leaves it alone. A frozen
    // prop would make a write that was refused look exactly like one that was
    // stored.
    const [config, setConfig] = React.useState<AgentConfig | null>(
      initialConfig,
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
        configBusy={false}
        onSelectPersona={() => {}}
        onSetDefaultProvider={() => {}}
        {...rest}
        config={config}
        onSaveConfig={async (next) => {
          harness.configs.push(next);
          // A test supplies this to reject; the throw must happen before the
          // state is replaced, or a refusal would still be applied.
          if (saveConfig) await saveConfig(next);
          setConfig(next);
        }}
        section={section}
        onSectionChange={(next) => {
          harness.sections.push(next);
          setSection(next);
        }}
        presentation={presentation}
        onPresentationChange={
          ownsPlacement
            ? (next) => {
                harness.placements.push(next);
                setPresentation(next);
              }
            : undefined
        }
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
  // The placement picker is a Radix dropdown; opening one needs the two jsdom
  // gaps this installs. See `test/radix-select.ts`.
  enableThemedSelectEnvironment();
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
  // Let the reads the sections started settle inside the test: the row, not
  // just the section, so the list state lands before the test ends. The order
  // is nav order — Behaviour comes before Tools, and it reads the capability
  // map.
  await waitFor(() =>
    assert.deepEqual(harness.calls, [
      "capabilities",
      "permissions",
      "personas",
    ]),
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
  // Behaviour reads one thing of its own: which generation parameters the
  // provider in use honours. Agent config it already has. The assertion is
  // kept exact rather than loosened, because "only the open section reads"
  // is the property this test exists for.
  await waitFor(() =>
    assert.deepEqual(harness.calls, [
      "permissions",
      "personas",
      "capabilities",
    ]),
  );
});

// ── The master tool-use switch ─────────────────────────────────────────────

test("the tool-use switch writes the config", async () => {
  const harness = renderPanel();

  fireEvent.click(segment("Tools & permissions"));
  // The permission read settles inside this await, so its state update is not
  // left to land outside `act`.
  await screen.findByTestId("ai-permissions");
  const toggle = () => screen.getByRole("switch", { name: "Tool use" });
  assert.equal(toggle().getAttribute("aria-checked"), "false");
  // One switch for one piece of state, and it is now the only control for
  // `toolsEnabled` anywhere in the app.
  assert.equal(screen.getAllByRole("switch", { name: "Tool use" }).length, 1);

  await act(async () => {
    fireEvent.click(toggle());
  });

  // The whole config is carried: a partial write would reset what the other
  // sections stored.
  assert.deepEqual(harness.configs, [{ ...CONFIG, toolsEnabled: true }]);
  assert.equal(toggle().getAttribute("aria-checked"), "true");
  assert.equal((toggle() as HTMLButtonElement).disabled, false);

  // And back off again, from the same switch.
  await act(async () => {
    fireEvent.click(toggle());
  });
  assert.deepEqual(harness.configs[1], { ...CONFIG, toolsEnabled: false });
  assert.equal(toggle().getAttribute("aria-checked"), "false");
});

test("the tool-use copy no longer claims the switch only reports", async () => {
  renderPanel({ config: { ...CONFIG, toolsEnabled: true } });

  fireEvent.click(segment("Tools & permissions"));
  await screen.findByTestId("ai-permissions");

  // It said "This switch reports that setting rather than changing it", which
  // stopped being true the moment it became writable.
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /reports that setting rather than changing it|cannot be changed from this switch/,
  );
  // What it must still say: turning tool use on is not by itself permission.
  assert.ok(
    screen.getByText(
      /Tool use is on for the assistant\..*does not by itself allow anything\./,
    ),
  );
  // The dead claim this copy used to make. Dispatch works in this build, so
  // saying otherwise would be the same lie the chat view just stopped telling.
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /unavailable in this build/,
  );
});

test("a refused tool-use change springs the switch back and says why", async () => {
  const harness = renderPanel({
    onSaveConfig: async () => {
      throw {
        code: "AI_INVALID_CONFIG",
        message: "Tool use is pinned on by policy.",
        source: "agent",
        operation: "ai:set_config",
        retryable: false,
        details: { remediation: "Ask an administrator." },
      };
    },
  });

  fireEvent.click(segment("Tools & permissions"));
  await screen.findByTestId("ai-permissions");
  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Tool use" }));
  });

  assert.deepEqual(harness.configs, [{ ...CONFIG, toolsEnabled: true }]);
  assert.ok(screen.getByText("Tool use is pinned on by policy."));
  assert.ok(screen.getByText("Ask an administrator."));
  // The state the backend is actually in, not the one that was attempted.
  assert.equal(
    screen
      .getByRole("switch", { name: "Tool use" })
      .getAttribute("aria-checked"),
    "false",
  );
});

test("the tool-use switch cannot be flipped before the config has arrived", async () => {
  const harness = renderPanel({ config: null });

  fireEvent.click(segment("Tools & permissions"));
  await screen.findByTestId("ai-permissions");
  const toggle = screen.getByRole("switch", { name: "Tool use" });
  // There is nothing to write into yet: a flip would have to invent the five
  // other fields `ai_set_config` takes.
  assert.equal((toggle as HTMLButtonElement).disabled, true);
  await act(async () => {
    fireEvent.click(toggle);
  });
  assert.deepEqual(harness.configs, []);
});

// ── Where the assistant appears ────────────────────────────────────────────

test("the placement control offers every presentation and names the current one", async () => {
  renderPanel({ section: "behaviour", presentation: "sidebar" });

  const placement = screen.getByTestId("ai-placement");
  assert.equal(placement.dataset.presentation, "sidebar");
  // The app's themed dropdown rather than a native `<select>`: its trigger is
  // a `role="combobox"` button, so the value and the options are read from the
  // popover it opens rather than from `HTMLSelectElement`.
  const trigger = screen.getByLabelText("Placement");
  assert.equal(trigger.getAttribute("role"), "combobox");
  assert.equal(await themedSelectValue(trigger), "sidebar");

  // Every presentation is offered, in the shared option order, labelled with
  // the same words the workspace's own placement control uses.
  assert.deepEqual(
    await themedSelectValues(screen.getByLabelText("Placement")),
    [...AI_ASSISTANT_PRESENTATIONS],
  );
  assert.deepEqual(
    await themedSelectLabels(screen.getByLabelText("Placement")),
    AI_ASSISTANT_PRESENTATION_OPTIONS.map((option) => option.label),
  );

  // The difference a label cannot carry: what the dock does to a narrow window.
  assert.match(
    screen.getByTestId("ai-placement-hint").textContent ?? "",
    /slides over the workspace instead of shrinking it/,
  );
});

test("choosing a placement asks the owner to change it, and the hint follows", async () => {
  const harness = renderPanel({ section: "behaviour" });

  await chooseThemedSelectValue(screen.getByLabelText("Placement"), "bubble");

  assert.deepEqual(harness.placements, ["bubble"]);
  // Applied immediately — this is a UI preference, not a form with a Save
  // button, and the host owns the state it just reported back.
  assert.equal(
    await themedSelectValue(screen.getByLabelText("Placement")),
    "bubble",
  );
  assert.equal(
    screen.getByTestId("ai-placement").dataset.presentation,
    "bubble",
  );
  assert.match(
    screen.getByTestId("ai-placement-hint").textContent ?? "",
    /Escape closes it/,
  );
});

test("a value that is not a presentation never reaches the owner", () => {
  // The guard the native `<select>` carried, now a function of its own. A
  // themed dropdown's `onValueChange` is typed `(value: string) => void`, and
  // the stored preference it is seeded from can hold anything at all.
  for (const presentation of AI_ASSISTANT_PRESENTATIONS) {
    assert.equal(placementFromPickerValue(presentation), presentation);
  }
  for (const junk of ["", "Panel", "dock", "bubble ", "null", "0"]) {
    assert.equal(
      placementFromPickerValue(junk),
      null,
      `${junk} must not become a placement`,
    );
  }
});

test("every dropdown in these settings is raised above the floating bubble", async () => {
  renderPanel({ section: "behaviour", presentation: "bubble" });

  /**
   * The bubble is painted at `z-[60]`, and both it and a dropdown's popover
   * are portaled to `document.body` — siblings in one stacking context, where
   * `z-index` alone decides which is on top. The shared `SelectContent`
   * default is `z-50`, which loses: the popover would open *behind* the
   * surface it was opened from, which looks exactly like being clipped. Being
   * portaled is what keeps it out of the bubble's `overflow-hidden` and the
   * dock's scroll region; this is the other half of the same requirement.
   */
  const assertRaised = async (trigger: HTMLElement, what: string) => {
    const popover = await openThemedSelect(trigger);
    assert.ok(
      popover.classList.contains(AI_SELECT_CONTENT_CLASS),
      `${what} must carry ${AI_SELECT_CONTENT_CLASS}, got ${popover.className}`,
    );
    assert.ok(
      !popover.classList.contains("z-50"),
      `${what} must drop the losing z-index rather than keep both`,
    );
    await closeThemedSelect();
  };

  await assertRaised(
    screen.getByLabelText("Placement"),
    "the placement popover",
  );

  fireEvent.click(segment("Providers"));
  fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
  await assertRaised(
    await screen.findByLabelText("Protocol"),
    "the protocol popover",
  );

  fireEvent.click(segment("Tools & permissions"));
  await screen.findByTestId("ai-permissions");
  await assertRaised(
    within(screen.getByTestId("ai-tool-row")).getByRole("combobox"),
    "the per-tool permission popover",
  );
});

test("a host that does not own the preference gets no placement control", () => {
  renderPanel({ section: "behaviour", onPresentationChange: undefined });

  // An inert select would claim a choice that nothing is listening for.
  assertAbsent(
    screen.queryByTestId("ai-placement"),
    "the placement control without an owner",
  );
  // The rest of Behaviour is unaffected.
  assert.ok(screen.getByTestId("ai-agent-settings"));
});

test("the placement control sits in Behaviour and nowhere else", async () => {
  renderPanel({ section: "behaviour" });
  assert.ok(screen.getByTestId("ai-placement"));

  for (const other of ["providers", "tools", "personas"] as const) {
    fireEvent.click(
      segment(
        new RegExp(
          `^${AI_SETTINGS_SECTIONS.find((entry) => entry.id === other)?.label}`,
        ),
      ),
    );
    assertAbsent(
      screen.queryByTestId("ai-placement"),
      `a second placement control in ${other}`,
    );
  }
  await settlePendingReads();
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
