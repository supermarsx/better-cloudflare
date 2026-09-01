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
import type { AgentConfig, AgentEvent, ProviderConfig } from "../src/types/ai";

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
        kind: "openai",
        model: "gpt-4o",
        temperature: 0.2,
        maxTokens: 1024,
      }),
    () => TauriClient.aiTestProvider("openai"),
    () => TauriClient.aiListModels("openai"),
    () => TauriClient.aiGetConfig(),
    () => TauriClient.aiSetConfig(AGENT_CONFIG),
    () => TauriClient.aiCreateConversation("anthropic", "claude"),
    () => TauriClient.aiListConversations(),
    () => TauriClient.aiGetConversation("c1"),
    () => TauriClient.aiDeleteConversation("c1"),
    () => TauriClient.aiSetConversationTitle("c1", "t"),
    () => TauriClient.aiSendMessage("c1", "hi", "openai"),
    () => TauriClient.aiApproveToolCall("c1", "tc1"),
    () => TauriClient.aiCancelGeneration("c1"),
    () => TauriClient.aiListPresets(),
    () => TauriClient.aiGetPreset("p1"),
    () => TauriClient.aiExportConversation("c1"),
    () => TauriClient.onAiEvent(() => {}),
  ];
  // Seventeen commands plus the event subscription.
  assert.equal(attempts.length, 18);
  for (const attempt of attempts) {
    await assert.rejects(attempt, { message: AI_DESKTOP_ONLY });
  }
});

test("all seventeen commands use the camelCase Tauri contract", async () => {
  desktop();
  const calls = recordCalls((command) => {
    switch (command) {
      case "ai_list_providers":
        return [{ kind: "openai", configured: true }];
      case "ai_test_provider":
      case "ai_list_models":
        return [{ id: "m", name: "M", supportsTools: true }];
      case "ai_get_config":
        return AGENT_CONFIG;
      case "ai_create_conversation":
        return { id: "c1", title: "New" };
      case "ai_list_conversations":
        return [{ id: "c1" }];
      case "ai_get_conversation":
        return { id: "c1", messages: [] };
      case "ai_delete_conversation":
      case "ai_set_conversation_title":
      case "ai_cancel_generation":
        return true;
      case "ai_send_message":
        return "user-msg-1";
      case "ai_list_presets":
        return [{ id: "p1" }];
      case "ai_get_preset":
        return { id: "p1" };
      case "ai_export_conversation":
        return '{"id":"c1"}';
      case "ai_configure_provider":
      case "ai_set_config":
      case "ai_approve_tool_call":
        return undefined;
      default:
        throw new Error(`Unexpected Tauri command: ${command}`);
    }
  });

  await TauriClient.aiListProviders();
  await TauriClient.aiConfigureProvider({
    kind: "anthropic",
    apiKey: "secret",
    baseUrl: "https://proxy.test/v1",
    model: "claude-sonnet-4-20250514",
    temperature: 0.7,
    maxTokens: 2048,
  });
  await TauriClient.aiTestProvider("ollama");
  await TauriClient.aiListModels("ollama");
  await TauriClient.aiGetConfig();
  await TauriClient.aiSetConfig(AGENT_CONFIG);
  await TauriClient.aiCreateConversation("openai", "gpt-4o", "Title", "Sys");
  await TauriClient.aiCreateConversation("openai", "gpt-4o");
  await TauriClient.aiListConversations();
  await TauriClient.aiGetConversation("c1");
  await TauriClient.aiDeleteConversation("c1");
  await TauriClient.aiSetConversationTitle("c1", "Renamed");
  await TauriClient.aiSendMessage("c1", "hello", "openai");
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
      "ai_test_provider",
      "ai_list_models",
      "ai_get_config",
      "ai_set_config",
      "ai_create_conversation",
      "ai_create_conversation",
      "ai_list_conversations",
      "ai_get_conversation",
      "ai_delete_conversation",
      "ai_set_conversation_title",
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
  // expects the camelCase spelling from JS.
  assert.deepEqual(byCommand("ai_send_message")[0].payload, {
    conversationId: "c1",
    text: "hello",
    provider: "openai",
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
  assert.deepEqual(byCommand("ai_get_preset")[0].payload, { id: "p1" });
  assert.deepEqual(byCommand("ai_export_conversation")[0].payload, {
    id: "c1",
  });
  assert.deepEqual(byCommand("ai_set_config")[0].payload, {
    config: AGENT_CONFIG,
  });

  // Optional conversation fields are sent as explicit nulls, matching the
  // `Option<String>` parameters rather than relying on absent keys.
  assert.deepEqual(byCommand("ai_create_conversation")[0].payload, {
    provider: "openai",
    model: "gpt-4o",
    title: "Title",
    systemPrompt: "Sys",
  });
  assert.deepEqual(byCommand("ai_create_conversation")[1].payload, {
    provider: "openai",
    model: "gpt-4o",
    title: null,
    systemPrompt: null,
  });
});

test("provider kinds cross the wire in Rust's lowercase spelling", async () => {
  desktop();
  const calls = recordCalls(() => []);
  await TauriClient.aiTestProvider("openai");
  await TauriClient.aiTestProvider("anthropic");
  await TauriClient.aiTestProvider("ollama");

  // `#[serde(rename_all = "lowercase")]` on `ProviderKind` means `OpenAi` is
  // `"openai"`. The old TS spelling `"openAi"` failed deserialization.
  assert.deepEqual(
    calls.map((call) => call.payload?.kind),
    ["openai", "anthropic", "ollama"],
  );
  assert.ok(!calls.some((call) => call.payload?.kind === "openAi"));
});

test("provider config forwards exactly the fields Rust requires", async () => {
  desktop();
  const calls = recordCalls(() => undefined);
  const config: ProviderConfig = {
    kind: "openai",
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    temperature: 0.5,
    maxTokens: 4096,
  };
  await TauriClient.aiConfigureProvider(config);

  const sent = calls[0].payload?.config as Record<string, unknown>;
  assert.deepEqual(sent, {
    kind: "openai",
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    temperature: 0.5,
    maxTokens: 4096,
  });
  // `model`, `temperature` and `maxTokens` are non-`Option` on the Rust side.
  for (const required of ["model", "temperature", "maxTokens"]) {
    assert.ok(required in sent, `${required} must be sent`);
  }
  // There is no `orgId` field in `bc-ai-provider::ProviderConfig`.
  assert.ok(!("orgId" in sent));
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
  // Starting a turn returns immediately; it keeps the default.
  assert.equal(getTauriInvokeTimeoutMs("ai_send_message"), 15_000);
});
