import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  AI_DESKTOP_ONLY,
  AI_EVENT,
  getTauriInvokeTimeoutMs,
  TauriClient,
} from "../src/lib/api/tauri-client";
import type {
  AgentConfig,
  AgentEvent,
  AiPermissionsSnapshot,
  AiPersona,
  AiPersonaInput,
  AiProviderProfileInput,
} from "../src/types/ai";

type Call = { command: string; payload: Record<string, unknown> | undefined };

const originalWindow = (globalThis as unknown as { window?: unknown }).window;

/** The jsdom window plus the Tauri bridge marker `isDesktop()` looks for. */
function desktop(): void {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
  (originalWindow as { __TAURI__?: unknown }).__TAURI__ = {};
}

function recordCalls(
  respond: (command: string, payload?: Record<string, unknown>) => unknown,
): Call[] {
  const calls: Call[] = [];
  mockIPC((command, payload) => {
    const args = payload as Record<string, unknown> | undefined;
    calls.push({ command, payload: args });
    return respond(command, args);
  });
  return calls;
}

const AGENT_CONFIG: AgentConfig = {
  maxToolRounds: 8,
  maxTokensPerTurn: 4096,
  toolsEnabled: false,
  stream: true,
  preset: "dns-assistant",
  temperature: 0.7,
  topP: 1,
  personaId: null,
  defaultProviderId: null,
};

afterEach(() => {
  clearMocks();
  delete (originalWindow as { __TAURI__?: unknown }).__TAURI__;
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

test("every AI method throws a clear error off desktop", async () => {
  // No `mockIPC` here: installing it would define `window.__TAURI_INTERNALS__`
  // and turn the environment into a desktop one.
  (globalThis as unknown as { window?: unknown }).window = undefined;
  const attempts: Array<() => Promise<unknown>> = [
    () => TauriClient.aiListProviders(),
    () =>
      TauriClient.aiConfigureProvider({
        label: "OpenAI",
        protocol: "openai",
        model: "gpt-4o",
        temperature: 0.2,
        maxTokens: 1024,
      }),
    () => TauriClient.aiDeleteProvider("openai-main"),
    () => TauriClient.aiTestProvider("openai-main"),
    () => TauriClient.aiListModels("openai-main"),
    () => TauriClient.aiGetConfig(),
    () => TauriClient.aiSetConfig(AGENT_CONFIG),
    () => TauriClient.aiProtocolCapabilities(),
    () => TauriClient.aiCreateConversation("anthropic", "claude"),
    () => TauriClient.aiListConversations(),
    () => TauriClient.aiGetConversation("c1"),
    () => TauriClient.aiDeleteConversation("c1"),
    () => TauriClient.aiSetConversationTitle("c1", "t"),
    () => TauriClient.aiSetConversationPersona("c1", "dns-expert"),
    () => TauriClient.aiSetConversationProvider("c1", "openai-main", "gpt-4o"),
    () => TauriClient.aiSendMessage("c1", "hi", "openai-main"),
    () => TauriClient.aiApproveToolCall("c1", "tc1"),
    () => TauriClient.aiCancelGeneration("c1"),
    () => TauriClient.aiListPresets(),
    () => TauriClient.aiGetPreset("p1"),
    () => TauriClient.aiExportConversation("c1"),
    () => TauriClient.aiGetPermissions(),
    () => TauriClient.aiSetPermissions({ mode: "ask", tools: {} }),
    () => TauriClient.aiListPersonas(),
    () =>
      TauriClient.aiCreatePersona({
        name: "n",
        description: "d",
        systemPrompt: "s",
      }),
    () =>
      TauriClient.aiUpdatePersona("p1", {
        name: "n",
        description: "d",
        systemPrompt: "s",
      }),
    () => TauriClient.aiDeletePersona("p1"),
    () => TauriClient.onAiEvent(() => {}),
  ];
  // Twenty-seven commands plus the event subscription.
  assert.equal(attempts.length, 28);
  for (const attempt of attempts) {
    await assert.rejects(attempt, { message: AI_DESKTOP_ONLY });
  }
});

test("every chat and provider command uses the camelCase Tauri contract", async () => {
  desktop();
  const calls = recordCalls((command) => {
    switch (command) {
      case "ai_list_providers":
        return [
          {
            id: "openai-main",
            label: "OpenAI",
            protocol: "openai",
            baseUrl: "https://proxy.test/v1",
            model: "gpt-4o",
            temperature: 0.7,
            maxTokens: 2048,
            hasApiKey: true,
          },
        ];
      case "ai_test_provider":
      case "ai_list_models":
        return [{ id: "m", name: "M", supportsTools: true }];
      case "ai_get_config":
        return AGENT_CONFIG;
      case "ai_protocol_capabilities":
        return {
          openai: ["topP", "stop", "seed"],
          anthropic: ["topP", "topK", "stop"],
          ollama: ["topP", "topK", "stop", "seed"],
        };
      case "ai_create_conversation":
        return { id: "c1", title: "New" };
      case "ai_list_conversations":
        return [{ id: "c1" }];
      case "ai_get_conversation":
        return { id: "c1", messages: [] };
      case "ai_delete_conversation":
      case "ai_delete_provider":
      case "ai_set_conversation_title":
      case "ai_cancel_generation":
        return true;
      // Both switches answer with the *stored* metadata, so a caller reads
      // what was kept rather than assuming its own input was taken verbatim.
      case "ai_set_conversation_persona":
      case "ai_set_conversation_provider":
        return { id: "c1", title: "New", provider: "openai-main" };
      case "ai_send_message":
        return "user-msg-1";
      case "ai_list_presets":
        return [{ id: "p1" }];
      case "ai_get_preset":
        return { id: "p1" };
      case "ai_export_conversation":
        return '{"id":"c1"}';
      case "ai_configure_provider":
        return {
          id: "anthropic-proxy",
          label: "Anthropic via proxy",
          protocol: "anthropic",
          baseUrl: "https://proxy.test/v1",
          model: "claude-sonnet-4-20250514",
          temperature: 0.7,
          maxTokens: 2048,
          hasApiKey: true,
        };
      case "ai_set_config":
      case "ai_approve_tool_call":
        return undefined;
      default:
        throw new Error(`Unexpected Tauri command: ${command}`);
    }
  });

  await TauriClient.aiListProviders();
  await TauriClient.aiConfigureProvider({
    id: "anthropic-proxy",
    label: "Anthropic via proxy",
    protocol: "anthropic",
    apiKey: "secret",
    baseUrl: "https://proxy.test/v1",
    model: "claude-sonnet-4-20250514",
    temperature: 0.7,
    maxTokens: 2048,
  });
  await TauriClient.aiDeleteProvider("anthropic-proxy");
  await TauriClient.aiTestProvider("ollama-local");
  await TauriClient.aiListModels("ollama-local");
  await TauriClient.aiGetConfig();
  await TauriClient.aiSetConfig(AGENT_CONFIG);
  await TauriClient.aiProtocolCapabilities();
  await TauriClient.aiCreateConversation(
    "openai-main",
    "gpt-4o",
    "Title",
    "Sys",
  );
  await TauriClient.aiCreateConversation("openai-main", "gpt-4o");
  await TauriClient.aiListConversations();
  await TauriClient.aiGetConversation("c1");
  await TauriClient.aiDeleteConversation("c1");
  await TauriClient.aiSetConversationTitle("c1", "Renamed");
  await TauriClient.aiSetConversationPersona("c1", "security-auditor");
  await TauriClient.aiSetConversationPersona("c1", null);
  await TauriClient.aiSetConversationProvider("c1", "openai-main", "gpt-4o");
  await TauriClient.aiSendMessage("c1", "hello", "openai-main");
  await TauriClient.aiSendMessage("c1", "hello again");
  await TauriClient.aiApproveToolCall("c1", "tc1");
  await TauriClient.aiCancelGeneration("c1");
  await TauriClient.aiListPresets();
  await TauriClient.aiGetPreset("p1");
  await TauriClient.aiExportConversation("c1");

  assert.deepEqual(
    calls.map((call) => call.command),
    [
      "ai_list_providers",
      "ai_configure_provider",
      "ai_delete_provider",
      "ai_test_provider",
      "ai_list_models",
      "ai_get_config",
      "ai_set_config",
      "ai_protocol_capabilities",
      "ai_create_conversation",
      "ai_create_conversation",
      "ai_list_conversations",
      "ai_get_conversation",
      "ai_delete_conversation",
      "ai_set_conversation_title",
      "ai_set_conversation_persona",
      "ai_set_conversation_persona",
      "ai_set_conversation_provider",
      "ai_send_message",
      "ai_send_message",
      "ai_approve_tool_call",
      "ai_cancel_generation",
      "ai_list_presets",
      "ai_get_preset",
      "ai_export_conversation",
    ],
  );

  const byCommand = (command: string) =>
    calls.filter((call) => call.command === command);

  // Rust takes `conversation_id` / `tool_call_id` / `system_prompt`; Tauri
  // expects the camelCase spelling from JS. The provider argument is an
  // optional profile id named `providerId`, and is sent as an explicit null
  // when omitted rather than as an absent key.
  assert.deepEqual(byCommand("ai_send_message")[0].payload, {
    conversationId: "c1",
    text: "hello",
    providerId: "openai-main",
  });
  assert.deepEqual(byCommand("ai_send_message")[1].payload, {
    conversationId: "c1",
    text: "hello again",
    providerId: null,
  });
  // The provider commands are keyed by profile id, not by protocol.
  assert.deepEqual(byCommand("ai_delete_provider")[0].payload, {
    id: "anthropic-proxy",
  });
  assert.deepEqual(byCommand("ai_test_provider")[0].payload, {
    id: "ollama-local",
  });
  assert.deepEqual(byCommand("ai_list_models")[0].payload, {
    id: "ollama-local",
  });
  assert.deepEqual(byCommand("ai_approve_tool_call")[0].payload, {
    conversationId: "c1",
    toolCallId: "tc1",
  });
  assert.deepEqual(byCommand("ai_cancel_generation")[0].payload, {
    conversationId: "c1",
  });
  assert.deepEqual(byCommand("ai_get_conversation")[0].payload, { id: "c1" });
  assert.deepEqual(byCommand("ai_set_conversation_title")[0].payload, {
    id: "c1",
    title: "Renamed",
  });
  // `personaId` is sent as an explicit null for "use the configured
  // persona", matching the `Option<String>` parameter rather than relying on
  // an absent key — an absent key would be indistinguishable from a caller
  // that forgot the argument.
  assert.deepEqual(byCommand("ai_set_conversation_persona")[0].payload, {
    id: "c1",
    personaId: "security-auditor",
  });
  assert.deepEqual(byCommand("ai_set_conversation_persona")[1].payload, {
    id: "c1",
    personaId: null,
  });
  // The provider and the model travel together, in one command, because a
  // model name only means anything to the endpoint that serves it.
  assert.deepEqual(byCommand("ai_set_conversation_provider")[0].payload, {
    id: "c1",
    provider: "openai-main",
    model: "gpt-4o",
  });
  assert.deepEqual(byCommand("ai_get_preset")[0].payload, { id: "p1" });
  assert.deepEqual(byCommand("ai_export_conversation")[0].payload, {
    id: "c1",
  });
  assert.deepEqual(byCommand("ai_set_config")[0].payload, {
    config: AGENT_CONFIG,
  });
  // The capability map is a question about the build, not about a profile, so
  // it takes no argument at all.
  assert.deepEqual(byCommand("ai_protocol_capabilities")[0].payload, {});

  // Optional conversation fields are sent as explicit nulls, matching the
  // `Option<String>` parameters rather than relying on absent keys.
  assert.deepEqual(byCommand("ai_create_conversation")[0].payload, {
    provider: "openai-main",
    model: "gpt-4o",
    title: "Title",
    systemPrompt: "Sys",
  });
  assert.deepEqual(byCommand("ai_create_conversation")[1].payload, {
    provider: "openai-main",
    model: "gpt-4o",
    title: null,
    systemPrompt: null,
  });
});

test("permission and persona commands use the camelCase Tauri contract", async () => {
  desktop();
  const snapshot: AiPermissionsSnapshot = {
    mode: "ask",
    tools: { cf_delete_dns_record: "deny" },
    catalog: [
      {
        name: "cf_list_dns_records",
        classification: "read",
        description: "List records",
        permission: "allow",
      },
    ],
    // `availability` is part of the view and is carried through untouched like
    // everything else: the client must not derive it from the catalog, which
    // cannot see the MCP grants that half of it describes.
    availability: {
      dispatchAvailable: true,
      grantedToolCount: 1,
      usableToolCount: 1,
      registeredToolCount: 48,
    },
  };
  const persona: AiPersona = {
    id: "custom-1",
    name: "Zone reviewer",
    description: "Reads a zone and reports on it",
    systemPrompt: "You review DNS zones.",
    builtin: false,
  };
  const calls = recordCalls((command) => {
    switch (command) {
      case "ai_get_permissions":
        return snapshot;
      case "ai_set_permissions":
        return { mode: snapshot.mode, tools: snapshot.tools };
      case "ai_list_personas":
        return [persona];
      case "ai_create_persona":
      case "ai_update_persona":
        return persona;
      case "ai_delete_persona":
        return true;
      default:
        throw new Error(`Unexpected Tauri command: ${command}`);
    }
  });

  const input: AiPersonaInput = {
    name: persona.name,
    description: persona.description,
    systemPrompt: persona.systemPrompt,
  };
  const read = await TauriClient.aiGetPermissions();
  const stored = await TauriClient.aiSetPermissions({
    mode: "readOnly",
    tools: { cf_delete_dns_record: "deny" },
  });
  const listed = await TauriClient.aiListPersonas();
  await TauriClient.aiCreatePersona(input);
  await TauriClient.aiUpdatePersona("custom-1", input);
  const deleted = await TauriClient.aiDeletePersona("custom-1");

  assert.deepEqual(
    calls.map((call) => call.command),
    [
      "ai_get_permissions",
      "ai_set_permissions",
      "ai_list_personas",
      "ai_create_persona",
      "ai_update_persona",
      "ai_delete_persona",
    ],
  );

  // The catalog's `permission` is the effective value, so it is carried
  // through untouched: the client must not resolve or normalize it.
  assert.deepEqual(read, snapshot);
  assert.deepEqual(stored, { mode: "ask", tools: snapshot.tools });
  assert.deepEqual(listed, [persona]);
  assert.equal(deleted, true);

  const byCommand = (command: string) =>
    calls.filter((call) => call.command === command);
  // A read takes no arguments at all.
  assert.deepEqual(byCommand("ai_get_permissions")[0].payload, {});
  assert.deepEqual(byCommand("ai_set_permissions")[0].payload, {
    permissions: {
      mode: "readOnly",
      tools: { cf_delete_dns_record: "deny" },
    },
  });
  assert.deepEqual(byCommand("ai_create_persona")[0].payload, {
    persona: {
      name: "Zone reviewer",
      description: "Reads a zone and reports on it",
      systemPrompt: "You review DNS zones.",
    },
  });
  assert.deepEqual(byCommand("ai_update_persona")[0].payload, {
    id: "custom-1",
    persona: {
      name: "Zone reviewer",
      description: "Reads a zone and reports on it",
      systemPrompt: "You review DNS zones.",
    },
  });
  assert.deepEqual(byCommand("ai_delete_persona")[0].payload, {
    id: "custom-1",
  });
});

test("provider protocols cross the wire in Rust's lowercase spelling", async () => {
  desktop();
  const calls = recordCalls(() => ({
    id: "p",
    label: "P",
    protocol: "openai",
    baseUrl: "https://proxy.test/v1",
    model: "m",
    temperature: 0.5,
    maxTokens: 1024,
    hasApiKey: false,
  }));
  for (const protocol of ["openai", "anthropic", "ollama"] as const) {
    await TauriClient.aiConfigureProvider({
      label: protocol,
      protocol,
      model: "m",
      temperature: 0.5,
      maxTokens: 1024,
    });
  }

  // `#[serde(rename_all = "lowercase")]` on the protocol enum means `OpenAi` is
  // `"openai"`. The old TS spelling `"openAi"` failed deserialization.
  assert.deepEqual(
    calls.map(
      (call) => (call.payload?.profile as Record<string, unknown>).protocol,
    ),
    ["openai", "anthropic", "ollama"],
  );
  assert.ok(
    !calls.some(
      (call) =>
        (call.payload?.profile as Record<string, unknown>).protocol ===
        "openAi",
    ),
  );
});

test("a provider profile forwards exactly the fields Rust requires", async () => {
  desktop();
  const calls = recordCalls(() => undefined);
  const profile: AiProviderProfileInput = {
    id: "groq-fast",
    label: "Groq (fast)",
    protocol: "openai",
    apiKey: "sk-test",
    baseUrl: "https://gateway.test/openai/v1",
    model: "llama-3.3-70b",
    temperature: 0.5,
    maxTokens: 4096,
  };
  await TauriClient.aiConfigureProvider(profile);

  const sent = calls[0].payload?.profile as Record<string, unknown>;
  assert.deepEqual(sent, {
    id: "groq-fast",
    label: "Groq (fast)",
    protocol: "openai",
    apiKey: "sk-test",
    baseUrl: "https://gateway.test/openai/v1",
    model: "llama-3.3-70b",
    temperature: 0.5,
    maxTokens: 4096,
  });
  // `label`, `protocol`, `model`, `temperature` and `maxTokens` are non-`Option`
  // on the Rust side.
  for (const required of [
    "label",
    "protocol",
    "model",
    "temperature",
    "maxTokens",
  ]) {
    assert.ok(required in sent, `${required} must be sent`);
  }
  // The argument is named `profile`, not `config`, and there is no `kind`.
  assert.ok(!("config" in (calls[0].payload ?? {})));
  assert.ok(!("kind" in sent));
});

test("an omitted apiKey stays omitted, and null is sent as null", async () => {
  desktop();
  const calls = recordCalls(() => undefined);
  const base: AiProviderProfileInput = {
    id: "groq-fast",
    label: "Groq (fast)",
    protocol: "openai",
    model: "llama-3.3-70b",
    temperature: 0.5,
    maxTokens: 4096,
  };
  // An edit that does not touch the key must not carry an `apiKey` key at all:
  // `null` means "clear it", so serializing an absent field as null would wipe
  // the credential of anyone who renamed a provider.
  await TauriClient.aiConfigureProvider(base);
  await TauriClient.aiConfigureProvider({ ...base, apiKey: null });
  await TauriClient.aiConfigureProvider({ ...base, apiKey: "sk-new" });

  const sent = calls.map(
    (call) => call.payload?.profile as Record<string, unknown>,
  );
  assert.ok(!("apiKey" in sent[0]), "an untouched key must not be sent");
  assert.equal(sent[1].apiKey, null);
  assert.equal(sent[2].apiKey, "sk-new");
});

test("onAiEvent subscribes to the one global channel and unwraps payloads", async () => {
  desktop();
  mockIPC(() => undefined, { shouldMockEvents: true });

  const received: AgentEvent[] = [];
  const unlisten = await TauriClient.onAiEvent((payload) =>
    received.push(payload),
  );
  assert.equal(typeof unlisten, "function");
  assert.equal(AI_EVENT, "ai:event");

  const delta: AgentEvent = {
    type: "textDelta",
    conversationId: "c1",
    messageId: "m1",
    text: "hello",
  };
  // Events for other conversations share the channel — the handler sees them
  // all and is responsible for filtering.
  const other: AgentEvent = { type: "cancelled", conversationId: "c2" };
  await emit(AI_EVENT, delta);
  await emit(AI_EVENT, other);

  // The handler receives `event.payload`, not the `{ event, payload }` wrapper.
  assert.deepEqual(received, [delta, other]);

  await unlisten();
  // The mock's unlisten drops the callback registration but leaves its id in
  // the channel's listener list, so this emit logs a harmless
  // "[TAURI] Couldn't find callback id …" line. The assertion is the point:
  // nothing reaches the handler once unsubscribed.
  await emit(AI_EVENT, delta);
  assert.equal(received.length, 2);
});

test("slow AI commands get a deadline above their native bound", () => {
  // `ai_configure_provider` health-checks under a 30 s Rust timeout; the
  // default 15 s UI deadline would always fire first and report a phantom
  // timeout for a provider that was about to answer.
  assert.equal(getTauriInvokeTimeoutMs("ai_configure_provider"), 60_000);
  assert.equal(getTauriInvokeTimeoutMs("ai_test_provider"), 60_000);
  assert.equal(getTauriInvokeTimeoutMs("ai_list_models"), 60_000);
  assert.equal(getTauriInvokeTimeoutMs("ai_export_conversation"), 60_000);
  // Starting a turn returns immediately; it keeps the default. So does
  // forgetting a profile, which touches no network at all.
  assert.equal(getTauriInvokeTimeoutMs("ai_send_message"), 15_000);
  assert.equal(getTauriInvokeTimeoutMs("ai_delete_provider"), 15_000);
});
