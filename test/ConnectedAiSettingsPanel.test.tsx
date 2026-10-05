/**
 * The assistant's settings as the app's Settings workspace hosts them.
 *
 * `AiSettingsPanel.test.tsx` drives the panel against explicit props. This
 * suite drives the **connected** wrapper, which is what the Settings workspace
 * actually renders, so what is pinned here is the wiring that moved out of
 * `AiAssistantPanel` when the settings left the assistant:
 *
 * - the tool-use switch and the provider form reach the backend at all,
 * - a refusal surfaces the backend's own message rather than a generic one,
 * - and the host supplies no state: the wrapper owns its reads, so an install
 *   that never opens this section never issues an `ai_*` command.
 *
 * The first three tests came from `AiAssistantPanel.test.tsx` unchanged in
 * substance — they were testing these sections, not the assistant, and only
 * lived there because the assistant used to be their host.
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

import { AiAssistantPanel } from "../src/components/ai/AiAssistantPanel";
import {
  ConnectedAiSettingsPanel,
  type AiSettingsSection,
} from "../src/components/ai/AiSettingsPanel";
import { TauriClient } from "../src/lib/api/tauri-client";
import type {
  AgentConfig,
  AiPermissionsSnapshot,
  AiProviderProfile,
  AiProviderProfileInput,
} from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";
import {
  chooseThemedSelectValue,
  enableThemedSelectEnvironment,
} from "./radix-select";

interface Call {
  name: string;
  args: unknown[];
}

interface Backend {
  calls: Call[];
  providers: AiProviderProfile[];
  config: AgentConfig;
  /** Mutable, so a write is observable through the next read. */
  permissions: AiPermissionsSnapshot;
  failures: Map<string, unknown>;
}

const CONFIG: AgentConfig = {
  maxToolRounds: 8,
  maxTokensPerTurn: 4096,
  toolsEnabled: false,
  stream: true,
  temperature: 0.7,
  topP: 1,
  personaId: "default",
  defaultProviderId: null,
};

const PERMISSIONS: AiPermissionsSnapshot = {
  mode: "ask",
  tools: {},
  catalog: [],
  availability: {
    dispatchAvailable: true,
    grantedToolCount: 0,
    usableToolCount: 0,
    registeredToolCount: 0,
  },
};

function installBackend(options: { providers?: AiProviderProfile[] } = {}) {
  const backend: Backend = {
    calls: [],
    providers: [...(options.providers ?? [])],
    config: { ...CONFIG },
    permissions: { ...PERMISSIONS },
    failures: new Map(),
  };

  const record =
    <T,>(name: string, result: (args: unknown[]) => T) =>
    async (...args: unknown[]) => {
      backend.calls.push({ name, args });
      if (backend.failures.has(name)) throw backend.failures.get(name);
      return result(args);
    };

  mock.method(
    TauriClient,
    "aiListProviders",
    record("aiListProviders", () =>
      backend.providers.map((entry) => ({ ...entry })),
    ),
  );
  mock.method(
    TauriClient,
    "aiGetConfig",
    record("aiGetConfig", () => backend.config),
  );
  mock.method(
    TauriClient,
    "aiSetConfig",
    record("aiSetConfig", (args) => {
      backend.config = args[0] as AgentConfig;
      return undefined;
    }),
  );
  mock.method(
    TauriClient,
    "aiConfigureProvider",
    record("aiConfigureProvider", (args) => {
      const input = args[0] as AiProviderProfileInput;
      const stored: AiProviderProfile = {
        id: input.id ?? "assigned-id",
        label: input.label,
        protocol: input.protocol,
        baseUrl: input.baseUrl ?? "https://resolved.test/v1",
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        hasApiKey: input.apiKey !== undefined && input.apiKey !== null,
      };
      backend.providers.push(stored);
      return stored;
    }),
  );
  mock.method(
    TauriClient,
    "aiDeleteProvider",
    record("aiDeleteProvider", () => true),
  );
  mock.method(
    TauriClient,
    "aiGetPermissions",
    record("aiGetPermissions", () => ({ ...backend.permissions })),
  );
  mock.method(
    TauriClient,
    "aiSetPermissions",
    record("aiSetPermissions", (args) => {
      // Stored, so the *other* tree's re-read can observe it. A mock that
      // echoed a fixed policy back would make the cross-tree test pass on a
      // broken revision counter and fail on a working one.
      const next = args[0] as AiPermissionsSnapshot;
      backend.permissions = { ...backend.permissions, ...next };
      return { mode: next.mode, tools: next.tools };
    }),
  );
  mock.method(
    TauriClient,
    "aiListPersonas",
    record("aiListPersonas", () => []),
  );
  mock.method(
    TauriClient,
    "aiProtocolCapabilities",
    record("aiProtocolCapabilities", () => ({
      openai: ["topP", "stop", "seed"],
      anthropic: ["topP", "topK", "stop"],
      ollama: ["topP", "topK", "stop", "seed"],
    })),
  );
  return backend;
}

/** The workspace's own host: it owns which section is open, nothing else. */
function Host({ initial = "providers" }: { initial?: AiSettingsSection }) {
  const [section, setSection] = React.useState<AiSettingsSection>(initial);
  return (
    <ConnectedAiSettingsPanel section={section} onSectionChange={setSection} />
  );
}

function named(backend: Backend, name: string): Call[] {
  return backend.calls.filter((call) => call.name === name);
}

function sectionNav(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Assistant settings sections" });
}

beforeEach(async () => {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  await useEnglishLocale();
  enableThemedSelectEnvironment();
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

// ── Moved from the assistant panel's suite ─────────────────────────────────

test("the tool-use toggle writes agent config", async () => {
  const backend = installBackend();
  render(<Host initial="tools" />);

  // The toggle lives in Tools & permissions, next to the policy it governs,
  // rather than being duplicated into the Providers section.
  await screen.findByTestId("ai-settings");
  const toggle = await screen.findByRole("switch", { name: "Tool use" });
  // Disabled until `ai_get_config` answers, so the enabled state is what says
  // the panel is ready rather than merely mounted.
  await waitFor(() =>
    assert.equal((toggle as HTMLButtonElement).disabled, false),
  );
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  // It used to be permanently `disabled`, because nothing in the renderer
  // wrote `toolsEnabled` once the chat view's opt-out button went with the
  // gate it belonged to — which left tool use on by default and unreachable.
  // This is the control, so the write is pinned end to end.

  await act(async () => {
    fireEvent.click(toggle);
  });

  const writes = named(backend, "aiSetConfig");
  assert.equal(writes.length, 1);
  assert.equal(
    (writes[0].args[0] as AgentConfig).toolsEnabled,
    true,
    "the switch must store the new value, not merely re-send the old config",
  );
  // The whole config goes with it: `ai_set_config` replaces the stored
  // document, so a partial write would reset the other sections' settings.
  assert.equal((writes[0].args[0] as AgentConfig).maxToolRounds, 8);
  await waitFor(() =>
    assert.equal(
      screen
        .getByRole("switch", { name: "Tool use" })
        .getAttribute("aria-checked"),
      "true",
    ),
  );
});

test("the provider form states the session-only rule and never reveals the key", async () => {
  installBackend();
  render(<Host />);
  await screen.findByTestId("ai-settings");

  fireEvent.click(
    await screen.findByRole("button", { name: "Add a provider" }),
  );

  // The only mitigation for a key that silently vanishes on restart.
  assert.ok(
    screen.getByText(
      "Stored in memory for this session only. You will need to re-enter it after restarting the app.",
    ),
  );
  const key = screen.getByLabelText("API key") as HTMLInputElement;
  assert.equal(key.type, "password");
  assert.equal(key.value, "");
});

test("a rejected provider config surfaces the backend message and remediation", async () => {
  const backend = installBackend();
  backend.failures.set("aiConfigureProvider", {
    code: "AI_PROVIDER_UNAUTHORIZED",
    message: "The provider rejected the credentials.",
    source: "provider",
    operation: "ai:configure_provider",
    retryable: false,
    details: { status: 401, remediation: "Check the API key and try again." },
  });
  render(<Host />);
  await screen.findByTestId("ai-settings");

  fireEvent.click(
    await screen.findByRole("button", { name: "Add a provider" }),
  );
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "sk-wrong" },
  });
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "OpenAI" },
  });
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "gpt-4o-mini" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));
  });

  // The backend's own words, not a generic failure: it configures *and*
  // verifies in one call, so a refusal means "this provider does not work".
  await waitFor(() =>
    assert.match(
      document.body.textContent ?? "",
      /The provider rejected the credentials\./,
    ),
  );
  assert.match(
    document.body.textContent ?? "",
    /Check the API key and try again\./,
  );
});

// ── What the re-host itself has to get right ───────────────────────────────

test("the host supplies no state, and every section is reachable", async () => {
  const backend = installBackend();
  render(<Host />);
  await screen.findByTestId("ai-settings");

  // The wrapper owns the reads: the workspace passes only which section is
  // open, so `DNSManager` holds no provider or config state of its own.
  await waitFor(() => assert.equal(named(backend, "aiGetConfig").length, 1));
  assert.equal(named(backend, "aiListProviders").length, 1);

  // `Providers` is matched as a prefix: with nothing configured its
  // accessible name carries "(needs setup)", which is the point of that
  // marker and not something to assert around.
  for (const label of [
    /^Behaviour/,
    /^Tools & permissions/,
    /^Personas/,
    /^Providers/,
  ]) {
    fireEvent.click(within(sectionNav()).getByRole("button", { name: label }));
    await waitFor(() =>
      assert.equal(
        within(sectionNav())
          .getByRole("button", { name: label })
          .getAttribute("aria-pressed"),
        "true",
      ),
    );
  }
  // One section is mounted at a time, so the permission catalog and the
  // persona list are read because the user opened them and not otherwise.
  assert.equal(named(backend, "aiGetPermissions").length >= 1, true);
  await act(async () => {});
});

test("there is no placement control here, because Session settings owns it", async () => {
  installBackend();
  render(<Host initial="behaviour" />);
  await screen.findByTestId("ai-settings");

  // The picker existed inside the assistant because the dock and the bubble
  // had no settings tab in front of them. This screen is that tab, and
  // Session settings → General already has a radio group for the preference —
  // two controls for it in one workspace could disagree.
  assert.equal(screen.queryByTestId("ai-placement"), null);
  assert.equal(screen.queryByLabelText("Placement"), null);
  // The rest of Behaviour is here.
  assert.ok(screen.getByTestId("ai-agent-settings"));
  await act(async () => {});
});

test("a refused config write reports the backend's message", async () => {
  const backend = installBackend();
  backend.failures.set("aiSetConfig", {
    code: "AI_INVALID_CONFIG",
    message: "personaId must contain only letters, digits, '-' or '_'",
    source: "agent",
    operation: "ai:set_config",
    retryable: false,
    details: { field: "personaId" },
  });
  render(<Host initial="tools" />);

  // The tool-use switch is the config-writing path this suite can reach
  // without a persona list; what is pinned is that a refusal is shown rather
  // than swallowed.
  const toggle = await screen.findByRole("switch", { name: "Tool use" });
  // Waited for, not merely found: the switch is disabled until
  // `ai_get_config` answers, and a click that lands first does nothing. That
  // race is what made this flaky.
  await waitFor(() =>
    assert.equal((toggle as HTMLButtonElement).disabled, false),
  );
  await act(async () => {
    fireEvent.click(toggle);
  });
  await waitFor(() =>
    assert.match(
      screen.getByTestId("ai-tools-error").textContent ?? "",
      /personaId must contain only letters/,
    ),
  );
});

// ── One writer, two trees ──────────────────────────────────────────────────

/**
 * The settings screen and the assistant, mounted together.
 *
 * This is the arrangement the re-host created and the one that can go wrong:
 * the two live in different component trees — a workspace settings tab and a
 * dock or bubble — so each has its own `useAiConfig` and `useAiPermissions`.
 * Without the revision counters in those hooks a user could turn tool use off
 * here and have the open assistant keep reporting it on, which is a claim
 * about what the next tool call will do.
 */
function BothTrees() {
  const [section, setSection] = React.useState<AiSettingsSection>("tools");
  return (
    <>
      <ConnectedAiSettingsPanel
        section={section}
        onSectionChange={setSection}
      />
      <AiAssistantPanel />
    </>
  );
}

test("turning tool use off in Settings reaches an open assistant", async () => {
  const backend = installBackend();
  backend.config = { ...CONFIG, toolsEnabled: true };
  render(<BothTrees />);

  // The assistant reports the posture it read, and the tool notice is where
  // that posture is user-visible.
  const notice = await screen.findByTestId("ai-tool-notice");
  await waitFor(() => assert.equal(notice.dataset.state, "on"));

  const toggle = await screen.findByRole("switch", { name: "Tool use" });
  await waitFor(() =>
    assert.equal((toggle as HTMLButtonElement).disabled, false),
  );
  await act(async () => {
    fireEvent.click(toggle);
  });

  // The other tree follows, without a remount. Exactly one writer: the
  // settings screen wrote, and the assistant re-read.
  await waitFor(() =>
    assert.equal(screen.getByTestId("ai-tool-notice").dataset.state, "off"),
  );
  assert.equal(named(backend, "aiSetConfig").length, 1);
  assert.ok(
    named(backend, "aiGetConfig").length >= 3,
    `both instances must re-read; got ${named(backend, "aiGetConfig").length}`,
  );
});

test("changing the mode in the assistant reaches the Settings screen", async () => {
  const backend = installBackend();
  backend.config = { ...CONFIG, toolsEnabled: true };
  render(<BothTrees />);

  // The settings screen's own mode control is a radio group; `data-mode` on
  // the section is the mode it read.
  const permissions = await screen.findByTestId("ai-permissions");
  await waitFor(() => assert.equal(permissions.dataset.mode, "ask"));

  // Change it from inside the conversation instead.
  const inline = await screen.findByLabelText("What the assistant may do");
  await act(async () => {
    await chooseThemedSelectValue(inline, "readOnly");
  });

  assert.equal(named(backend, "aiSetPermissions").length, 1);
  // And the settings screen, in the other tree, shows the new mode rather
  // than the one it read on mount.
  await waitFor(() =>
    assert.equal(screen.getByTestId("ai-permissions").dataset.mode, "readOnly"),
  );
});
