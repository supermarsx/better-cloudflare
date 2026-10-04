/**
 * Tests for the AI assistant panel.
 *
 * The load-bearing assertions here are the ones about posture, not about
 * layout, and the posture rule has been inverted on purpose: tool state must
 * never gate chat. Dispatch works (`execute_tool_with_grants` is public) and
 * the agent loop advertises only tools that pass both permission layers, so
 * tool use being on cannot produce a doomed call — it is not an error
 * condition, and the composer does not consult it. What the panel says about
 * tools comes from the backend's own availability counts and from nothing else;
 * a count the renderer invented would be a claim about MCP grants it cannot
 * see. Those are the tests to read first if this file ever starts failing.
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
import { TauriClient } from "../src/lib/api/tauri-client";
import type {
  AgentConfig,
  AgentEvent,
  AiPermissionsSnapshot,
  AiProviderProfile,
  AiProviderProfileInput,
  AiToolAvailability,
  ChatMessage,
  Conversation,
  ConversationMeta,
} from "../src/types/ai";

const CREATED = "2026-08-25T10:00:00Z";

function textMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
): ChatMessage {
  return {
    id,
    message: { role, content: { type: "text", text } },
    status: "complete",
    createdAt: CREATED,
    pendingToolCalls: [],
  };
}

function conversationMeta(
  overrides: Partial<ConversationMeta> = {},
): ConversationMeta {
  return {
    id: "conv-1",
    title: "First chat",
    provider: "openai",
    model: "gpt-4o-mini",
    messageCount: 1,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    title: "First chat",
    provider: "openai",
    model: "gpt-4o-mini",
    messages: [textMessage("msg-1", "user", "Hello")],
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

interface BackendCall {
  name: string;
  args: unknown[];
}

interface BackendOptions {
  config?: Partial<AgentConfig>;
  providers?: AiProviderProfile[];
  conversations?: ConversationMeta[];
  conversation?: Conversation | null;
  /** What `ai_get_permissions` reports as usable. Defaults to "all three". */
  availability?: Partial<AiToolAvailability>;
  /** Holds `ai_get_permissions` unresolved, to observe the unloaded state. */
  stallPermissions?: boolean;
}

/** A provider profile as `ai_list_providers` reports one — never with a key. */
function providerProfile(
  overrides: Partial<AiProviderProfile> = {},
): AiProviderProfile {
  return {
    id: "openai-main",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://proxy.test/v1",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 4096,
    hasApiKey: true,
    ...overrides,
  };
}

interface Backend {
  calls: BackendCall[];
  /** Deliver an agent event exactly as the Tauri channel would. */
  emit: (event: AgentEvent) => void;
  /** Mutable, so a refresh after `turnComplete` can return new messages. */
  state: { conversation: Conversation | null };
  /** The provider store, so CRUD is observable across a refresh. */
  providers: AiProviderProfile[];
  failures: Map<string, unknown>;
}

function installBackend(options: BackendOptions = {}): Backend {
  const calls: BackendCall[] = [];
  const failures = new Map<string, unknown>();
  const state = {
    conversation:
      options.conversation === undefined
        ? conversation()
        : options.conversation,
  };
  const providers: AiProviderProfile[] = [...(options.providers ?? [])];
  let handler: ((event: AgentEvent) => void) | null = null;

  const config: AgentConfig = {
    maxToolRounds: 8,
    maxTokensPerTurn: 4096,
    toolsEnabled: false,
    stream: true,
    preset: "default",
    temperature: 0.7,
    topP: 1,
    personaId: null,
    defaultProviderId: null,
    ...options.config,
  };

  function record<T>(name: string, result: (args: unknown[]) => T) {
    return async (...args: unknown[]) => {
      calls.push({ name, args });
      if (failures.has(name)) throw failures.get(name);
      return result(args);
    };
  }

  mock.method(
    TauriClient,
    "aiListProviders",
    record("aiListProviders", () => providers.map((entry) => ({ ...entry }))),
  );
  mock.method(
    TauriClient,
    "aiGetConfig",
    record("aiGetConfig", () => config),
  );
  mock.method(
    TauriClient,
    "aiSetConfig",
    record("aiSetConfig", () => undefined),
  );
  // Read by the Behaviour section to say which generation parameters the
  // provider in use honours. Mocked here so that opening Behaviour does not
  // depend on a Tauri bridge this environment does not have.
  mock.method(
    TauriClient,
    "aiProtocolCapabilities",
    record("aiProtocolCapabilities", () => ({
      openai: ["topP", "stop", "seed"],
      anthropic: ["topP", "topK", "stop"],
      ollama: ["topP", "topK", "stop", "seed"],
    })),
  );
  mock.method(
    TauriClient,
    "aiConfigureProvider",
    record("aiConfigureProvider", (args) => {
      const input = args[0] as AiProviderProfileInput;
      const existing = providers.findIndex((entry) => entry.id === input.id);
      // What the backend stores: the protocol default fills in a missing base
      // URL, and `hasApiKey` is decided by the three-valued `apiKey`.
      const previous = existing >= 0 ? providers[existing] : null;
      const stored: AiProviderProfile = {
        id: input.id ?? "assigned-id",
        label: input.label,
        protocol: input.protocol,
        baseUrl: input.baseUrl ?? "https://resolved.test/v1",
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        hasApiKey:
          input.apiKey === undefined
            ? (previous?.hasApiKey ?? false)
            : input.apiKey !== null,
      };
      if (existing >= 0) providers[existing] = stored;
      else providers.push(stored);
      return stored;
    }),
  );
  mock.method(
    TauriClient,
    "aiDeleteProvider",
    record("aiDeleteProvider", (args) => {
      const index = providers.findIndex((entry) => entry.id === args[0]);
      if (index >= 0) providers.splice(index, 1);
      return index >= 0;
    }),
  );
  mock.method(
    TauriClient,
    "aiListConversations",
    record("aiListConversations", () => options.conversations ?? []),
  );
  mock.method(
    TauriClient,
    "aiGetConversation",
    record("aiGetConversation", () => {
      if (!state.conversation) throw new Error("no conversation");
      return state.conversation;
    }),
  );
  mock.method(
    TauriClient,
    "aiCreateConversation",
    record("aiCreateConversation", (args) =>
      conversationMeta({
        id: "conv-new",
        provider: args[0] as ConversationMeta["provider"],
        model: args[1] as string,
      }),
    ),
  );
  mock.method(
    TauriClient,
    "aiDeleteConversation",
    record("aiDeleteConversation", () => true),
  );
  mock.method(
    TauriClient,
    "aiSendMessage",
    record("aiSendMessage", () => "msg-user"),
  );
  mock.method(
    TauriClient,
    "aiCancelGeneration",
    record("aiCancelGeneration", () => true),
  );
  mock.method(
    TauriClient,
    "aiExportConversation",
    record("aiExportConversation", () => '{"id":"conv-1"}'),
  );
  // The chat view reads this only while tool use is on, which is what lets a
  // test assert that an assistant with tools off never asks for it.
  const permissions: AiPermissionsSnapshot = {
    mode: "ask",
    tools: {},
    catalog: [],
    availability: {
      dispatchAvailable: true,
      grantedToolCount: 3,
      usableToolCount: 3,
      registeredToolCount: 48,
      ...options.availability,
    },
  };
  mock.method(TauriClient, "aiGetPermissions", async () => {
    calls.push({ name: "aiGetPermissions", args: [] });
    if (failures.has("aiGetPermissions"))
      throw failures.get("aiGetPermissions");
    // Never resolving is the honest shape of "the read has not come back yet":
    // the notice must say nothing at all rather than guess a zero.
    if (options.stallPermissions) await new Promise(() => {});
    return permissions;
  });
  mock.method(TauriClient, "onAiEvent", async (next: unknown) => {
    calls.push({ name: "onAiEvent", args: [] });
    handler = next as (event: AgentEvent) => void;
    return () => {
      handler = null;
    };
  });

  return {
    calls,
    state,
    providers,
    failures,
    emit: (event) => {
      act(() => {
        handler?.(event);
      });
    },
  };
}

function named(backend: Backend, name: string) {
  return backend.calls.filter((call) => call.name === name);
}

/**
 * Assert that a query found nothing.
 *
 * Deliberately not `assert.equal(node, null)`. Under `node:assert/strict` a
 * failed comparison inspects the actual value, and inspecting a jsdom element
 * walks its whole document graph. Inside a `waitFor` retry loop — where the
 * node is still present on the early attempts, which is the normal case for
 * anything that disappears asynchronously — that costs minutes of blocked
 * event loop per attempt and can exhaust the heap, turning a one-line
 * assertion into a hung suite. Comparing to `null` first keeps the failure
 * message cheap no matter how large the tree is.
 */
function assertAbsent(node: Element | null, label: string): void {
  assert.ok(node === null, `expected no ${label}`);
}

beforeEach(() => {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

// ── Availability ───────────────────────────────────────────────────────────

test("the web build shows the desktop-only notice and never calls the backend", () => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  const backend = installBackend();
  render(<AiAssistantPanel />);

  assert.ok(
    screen.getByText("The assistant is only available in the desktop app."),
  );
  assert.equal(backend.calls.length, 0);
});

// ── The tool posture: reported, never a gate ───────────────────────────────

test("tool use being on does not disable the composer", async () => {
  const backend = installBackend({
    config: { toolsEnabled: true },
    conversations: [conversationMeta()],
  });
  render(<AiAssistantPanel />);

  const notice = await screen.findByTestId("ai-tool-notice");
  await waitFor(() => assert.equal(notice.getAttribute("data-state"), "on"));

  // The whole point: a conversation and a provider are the only requirements.
  // Tools being on is not an error condition, so nothing stays locked and
  // nothing demands the user turn a setting off first. The wait is for the
  // conversation list to land, which is the only thing that was ever holding
  // the composer here.
  const composer = screen.getByLabelText("Message") as HTMLTextAreaElement;
  await waitFor(() => assert.equal(composer.disabled, false));
  assertAbsent(
    within(notice).queryByRole("alert"),
    "alert in the tool notice while tool use is on",
  );
  for (const button of screen.getAllByRole("button")) {
    const name = `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`;
    assert.doesNotMatch(name, /disable tool use/i);
  }

  // And the panel still does not rewrite global agent config behind the user.
  assert.equal(named(backend, "aiSetConfig").length, 0);

  // A message can actually be sent, which is the user-visible defect.
  fireEvent.change(composer, { target: { value: "Hello with tools on" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    assert.deepEqual(named(backend, "aiSendMessage")[0]?.args, [
      "conv-1",
      "Hello with tools on",
      "openai",
    ]),
  );
});

test("with tool use on the notice reports the backend's own counts", async () => {
  installBackend({
    config: { toolsEnabled: true },
    conversations: [conversationMeta()],
    availability: {
      dispatchAvailable: true,
      grantedToolCount: 7,
      usableToolCount: 3,
      registeredToolCount: 48,
    },
  });
  render(<AiAssistantPanel />);

  const usable = await screen.findByTestId("ai-tool-usable");
  // "3 of 48", from `ai_get_permissions` — not from counting catalog rows,
  // which cannot see the MCP grants that half of this describes.
  assert.match(usable.textContent ?? "", /can use 3 of the 48 tools/);
  assertAbsent(
    screen.queryByTestId("ai-tool-none-usable"),
    "the none-usable notice while three tools are usable",
  );
});

test("tool use on with nothing granted says so calmly, and names the right screen", async () => {
  installBackend({
    config: { toolsEnabled: true },
    conversations: [conversationMeta()],
    availability: {
      dispatchAvailable: false,
      grantedToolCount: 0,
      usableToolCount: 0,
      registeredToolCount: 48,
    },
  });
  render(<AiAssistantPanel />);

  const none = await screen.findByTestId("ai-tool-none-usable");
  assert.match(none.textContent ?? "", /none of its 48 tools/);
  assert.match(none.textContent ?? "", /MCP server settings/);
  // Informational, not destructive, and not an alert: chatting works, so this
  // is a setup state rather than a failure.
  assert.equal(none.getAttribute("role"), "note");
  assert.doesNotMatch(none.className, /destructive/);
  assertAbsent(
    within(screen.getByTestId("ai-tool-notice")).queryByRole("button"),
    "a coercive button in the tool notice",
  );
  await waitFor(() =>
    assert.equal(
      (screen.getByLabelText("Message") as HTMLTextAreaElement).disabled,
      false,
      "nothing usable is still no reason to lock the composer",
    ),
  );
});

test("tool use on with every granted tool refused points at the assistant's own rules", async () => {
  installBackend({
    config: { toolsEnabled: true },
    conversations: [conversationMeta()],
    availability: {
      dispatchAvailable: false,
      grantedToolCount: 9,
      usableToolCount: 0,
      registeredToolCount: 48,
    },
  });
  render(<AiAssistantPanel />);

  // The two layers compose as an intersection, so which one is empty decides
  // which settings screen is worth naming.
  const none = await screen.findByTestId("ai-tool-none-usable");
  assert.match(none.textContent ?? "", /refuse all 9 of the 48 tools/);
  assert.match(none.textContent ?? "", /Tools & permissions/);
  assert.doesNotMatch(none.textContent ?? "", /MCP server settings/);
});

test("no count is shown until the backend has reported one", async () => {
  installBackend({
    config: { toolsEnabled: true },
    conversations: [conversationMeta()],
    stallPermissions: true,
  });
  render(<AiAssistantPanel />);

  const notice = await screen.findByTestId("ai-tool-notice");
  await waitFor(() => assert.equal(notice.getAttribute("data-state"), "on"));
  // A plausible zero would be a fabricated claim about the MCP grants.
  assertAbsent(
    screen.queryByTestId("ai-tool-usable"),
    "a usable count before the read resolved",
  );
  assertAbsent(
    screen.queryByTestId("ai-tool-none-usable"),
    "a none-usable claim before the read resolved",
  );
});

test("tool use off says what that means and reads no permission catalog", async () => {
  const backend = installBackend({ conversations: [conversationMeta()] });
  render(<AiAssistantPanel />);

  const notice = await screen.findByTestId("ai-tool-notice");
  await waitFor(() => assert.equal(notice.getAttribute("data-state"), "off"));
  assert.match(
    notice.textContent ?? "",
    /Tool use is off, so the assistant can read and discuss but will not change anything in your account\./,
  );
  // Nothing to report, so nothing is read: the chat view does not pay for a
  // catalog it would not speak from.
  assert.equal(named(backend, "aiGetPermissions").length, 0);
  await waitFor(() =>
    assert.equal(
      (screen.getByLabelText("Message") as HTMLTextAreaElement).disabled,
      false,
    ),
  );
});

test("an approval request is read-only and offers no way to approve it", async () => {
  const backend = installBackend({ conversations: [conversationMeta()] });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-transcript");
  await waitFor(() => assert.ok(named(backend, "onAiEvent").length > 0));

  backend.emit({
    type: "toolApprovalRequired",
    conversationId: "conv-1",
    toolCallId: "call-1",
    toolName: "cf_delete_dns_record",
    arguments: { zoneId: "zone-1", recordId: "rec-1" },
    reason: "This tool can delete a DNS record.",
  });

  const card = await screen.findByTestId("ai-approval");
  assert.match(card.textContent ?? "", /cf_delete_dns_record/);
  assert.match(card.textContent ?? "", /This tool can delete a DNS record\./);
  // The full arguments, never a summary — a summary of a mutation is exactly
  // what a reader cannot verify.
  const pre = card.querySelector("pre");
  assert.match(pre?.textContent ?? "", /"zoneId": "zone-1"/);
  assert.match(pre?.textContent ?? "", /"recordId": "rec-1"/);

  // The whole point: no approve affordance anywhere in the panel.
  for (const button of screen.getAllByRole("button")) {
    const name = `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`;
    assert.doesNotMatch(name, /approve/i);
  }

  fireEvent.click(within(card).getByRole("button", { name: "Stop this run" }));
  await waitFor(() =>
    assert.deepEqual(named(backend, "aiCancelGeneration")[0]?.args, ["conv-1"]),
  );
  // Stopping resolves the card rather than leaving it stranded: there is no
  // reject command, and cancelling does not clear `pending_tool_calls`.
  await waitFor(() =>
    assertAbsent(screen.queryByTestId("ai-approval"), "approval card"),
  );
});

test("the tool-use toggle writes agent config through the panel", async () => {
  const harness = installBackend();
  render(<AiAssistantPanel initialView="settings" />);

  // The toggle lives in Tools & permissions, next to the policy it governs,
  // rather than being duplicated into the Providers section.
  fireEvent.click(
    within(
      await screen.findByRole("toolbar", {
        name: "Assistant settings sections",
      }),
    ).getByRole("button", { name: "Tools & permissions" }),
  );

  const toggle = await screen.findByRole("switch", { name: "Tool use" });
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  // It used to be `disabled`, because nothing in the renderer wrote
  // `toolsEnabled` once the chat view's opt-out button went with the gate it
  // belonged to — which left tool use on by default and unreachable. This is
  // the control now, so the write is pinned end to end rather than the
  // read-only-ness.
  assert.equal((toggle as HTMLButtonElement).disabled, false);

  await act(async () => {
    fireEvent.click(toggle);
  });

  const writes = harness.calls.filter((call) => call.name === "aiSetConfig");
  assert.equal(writes.length, 1);
  assert.equal(
    (writes[0].args[0] as AgentConfig).toolsEnabled,
    true,
    "the switch must store the new value, not merely re-send the old config",
  );
  // The whole config goes with it: `ai_set_config` replaces the stored
  // document, so a partial write would reset the other sections' settings.
  assert.equal((writes[0].args[0] as AgentConfig).maxToolRounds, 8);
  assert.equal(
    await screen
      .findByRole("switch", { name: "Tool use" })
      .then((node) => node.getAttribute("aria-checked")),
    "true",
  );
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /unavailable in this build/,
  );
});

// ── Streaming ──────────────────────────────────────────────────────────────

test("streamed deltas render provisionally and are replaced on turnComplete", async () => {
  const backend = installBackend({ conversations: [conversationMeta()] });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-transcript");
  await waitFor(() => assert.ok(named(backend, "onAiEvent").length > 0));

  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "What is my TTL?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() =>
    assert.deepEqual(named(backend, "aiSendMessage")[0]?.args, [
      "conv-1",
      "What is my TTL?",
      "openai",
    ]),
  );

  // While a turn runs, send becomes stop — there is always a way out.
  const stop = await screen.findByRole("button", { name: "Stop generating" });
  assert.ok(stop);
  assertAbsent(
    screen.queryByRole("button", { name: "Send message" }),
    "send button while a turn is running",
  );

  backend.emit({
    type: "textDelta",
    conversationId: "conv-1",
    messageId: "msg-2",
    text: "Your ",
  });
  backend.emit({
    type: "textDelta",
    conversationId: "conv-1",
    messageId: "msg-2",
    text: "TTL is 300.",
  });

  const stream = await screen.findByTestId("ai-stream");
  assert.match(stream.textContent ?? "", /Your TTL is 300\./);

  // An event for someone else's conversation must not leak into this one.
  backend.emit({
    type: "textDelta",
    conversationId: "conv-other",
    messageId: "msg-9",
    text: "LEAKED",
  });
  assert.doesNotMatch(
    screen.getByTestId("ai-stream").textContent ?? "",
    /LEAKED/,
  );

  // The authoritative transcript replaces the buffer only once it has arrived.
  backend.state.conversation = conversation({
    messages: [
      textMessage("msg-1", "user", "Hello"),
      textMessage("msg-2", "assistant", "Your TTL is 300."),
    ],
  });
  backend.emit({
    type: "turnComplete",
    conversationId: "conv-1",
    messageId: "msg-2",
  });

  await waitFor(() =>
    assertAbsent(
      screen.queryByTestId("ai-stream"),
      "provisional stream bubble",
    ),
  );
  const transcript = screen.getByTestId("ai-transcript");
  assert.equal(
    within(transcript).getAllByText("Your TTL is 300.").length,
    1,
    "the reply is shown once, from the persisted transcript",
  );
});

test("a stalled run unlocks the composer and says so instead of looking busy", async () => {
  const backend = installBackend({ conversations: [conversationMeta()] });
  render(<AiAssistantPanel watchdogMs={20} />);
  await screen.findByTestId("ai-transcript");
  await waitFor(() => assert.ok(named(backend, "onAiEvent").length > 0));

  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Anyone there?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("button", { name: "Stop generating" });

  backend.emit({
    type: "textDelta",
    conversationId: "conv-1",
    messageId: "msg-2",
    text: "Partial answer",
  });

  // No terminal event ever arrives. The watchdog is the only thing that can
  // end this run; without it the composer would stay locked forever.
  const banner = await screen.findByTestId("ai-error", undefined, {
    timeout: 5_000,
  });
  assert.match(banner.textContent ?? "", /The assistant stopped responding\./);

  await screen.findByRole("button", { name: "Send message" });
  // What the user already read stays on screen, marked as incomplete.
  const stream = screen.getByTestId("ai-stream");
  assert.match(stream.textContent ?? "", /Partial answer/);
  assert.match(stream.textContent ?? "", /This response is incomplete/);
  // Re-sending after a stall would duplicate a message the backend kept.
  assertAbsent(
    within(banner).queryByRole("button", { name: "Try again" }),
    "Try again offer after a stall",
  );
  assert.ok(
    within(banner).getByRole("button", { name: "Reload conversation" }),
  );
});

test("a terminal error keeps the partial answer and unlocks the composer", async () => {
  const backend = installBackend({ conversations: [conversationMeta()] });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-transcript");
  await waitFor(() => assert.ok(named(backend, "onAiEvent").length > 0));

  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Explain SPF" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("button", { name: "Stop generating" });

  backend.emit({
    type: "textDelta",
    conversationId: "conv-1",
    messageId: "msg-2",
    text: "SPF is",
  });
  backend.emit({
    type: "error",
    conversationId: "conv-1",
    error: "The provider ended the stream.",
  });

  const banner = await screen.findByTestId("ai-error");
  assert.match(banner.textContent ?? "", /The provider ended the stream\./);
  await screen.findByRole("button", { name: "Send message" });
  assert.match(screen.getByTestId("ai-stream").textContent ?? "", /SPF is/);

  fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    assertAbsent(screen.queryByTestId("ai-error"), "error banner"),
  );
});

test("a failed tool result renders as an error chip, not a crash", async () => {
  installBackend({
    conversations: [conversationMeta()],
    conversation: conversation({
      messages: [
        textMessage("msg-1", "user", "Delete it"),
        {
          id: "msg-2",
          message: {
            role: "tool",
            content: {
              type: "toolResult",
              toolCallId: "call-1",
              content:
                "Tool dispatch denied: explicit canonical permission grants are required.",
              isError: true,
            },
          },
          status: "complete",
          createdAt: CREATED,
          pendingToolCalls: [],
        },
      ],
    }),
  });
  render(<AiAssistantPanel />);

  const chip = await screen.findByTestId("ai-tool-result-error");
  assert.match(chip.textContent ?? "", /Tool dispatch denied/);
});

// ── Provider configuration and the session-only key ────────────────────────

test("the provider form states the session-only rule and never reveals the key", async () => {
  const backend = installBackend();
  render(<AiAssistantPanel initialView="settings" />);
  await screen.findByTestId("ai-settings");

  fireEvent.click(
    await screen.findByRole("button", { name: "Add a provider" }),
  );

  // Required copy from the plan; the only mitigation for a key that silently
  // vanishes on restart.
  assert.ok(
    screen.getByText(
      "Stored in memory for this session only. You will need to re-enter it after restarting the app.",
    ),
  );

  const key = screen.getByLabelText("API key") as HTMLInputElement;
  assert.equal(key.type, "password");
  // No reveal toggle: unlike the login field, this key is never shown back.
  for (const button of screen.getAllByRole("button")) {
    const name = `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`;
    assert.doesNotMatch(name, /show|reveal/i);
  }

  fireEvent.change(key, { target: { value: "sk-secret-value" } });
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "OpenAI" },
  });
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "gpt-4o-mini" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  await waitFor(() =>
    assert.equal(named(backend, "aiConfigureProvider").length, 1),
  );
  const [sent] = named(backend, "aiConfigureProvider")[0].args as [
    AiProviderProfileInput,
  ];
  // The shape Rust actually deserializes: a lowercase protocol, a label, and
  // required model / temperature / maxTokens. No `kind`, and no invented
  // `orgId`.
  assert.equal(sent.protocol, "openai");
  assert.equal(sent.label, "OpenAI");
  assert.equal(sent.model, "gpt-4o-mini");
  assert.equal(typeof sent.temperature, "number");
  assert.equal(typeof sent.maxTokens, "number");
  assert.equal(sent.apiKey, "sk-secret-value");
  assert.ok(!("orgId" in sent));
  assert.ok(!("kind" in sent));

  // Saving is also the verification, so there is no separate Test button.
  assertAbsent(
    screen.queryByRole("button", { name: /^test/i }),
    "separate Test button",
  );

  // The key is gone from the page once it has been handed over: the editor
  // closes, and the only thing shown about the credential is that one exists.
  await waitFor(() =>
    assertAbsent(screen.queryByTestId("ai-provider-editor"), "provider editor"),
  );
  assert.doesNotMatch(document.body.textContent ?? "", /sk-secret-value/);
  const row = await screen.findByTestId("ai-provider-row");
  assert.equal(row.getAttribute("data-has-key"), "true");
  assert.match(row.textContent ?? "", /Key set/);
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
  render(<AiAssistantPanel initialView="settings" />);
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
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  const alert = await screen.findByText(
    "The provider rejected the credentials.",
  );
  assert.ok(alert);
  assert.ok(screen.getByText("Check the API key and try again."));
  // A failed attempt must not leak the submitted secret into the page.
  assert.doesNotMatch(document.body.textContent ?? "", /sk-wrong/);
});

// ── Conversations, export, and accessible names ────────────────────────────

test("a conversation can be created from a configured provider and deleted", async () => {
  const backend = installBackend({
    providers: [providerProfile()],
    conversations: [conversationMeta()],
  });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-conversations");

  fireEvent.change(await screen.findByLabelText("Model"), {
    target: { value: "gpt-4o-mini" },
  });
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

  await waitFor(() =>
    assert.deepEqual(named(backend, "aiCreateConversation")[0]?.args, [
      "openai-main",
      "gpt-4o-mini",
      undefined,
      undefined,
    ]),
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Delete conversation: First chat" }),
  );
  await waitFor(() =>
    assert.deepEqual(named(backend, "aiDeleteConversation")[0]?.args, [
      "conv-1",
    ]),
  );
});

test("export offers the conversation as a file and reports the size ceiling", async () => {
  const backend = installBackend({ conversations: [conversationMeta()] });
  const created: string[] = [];
  const urlApi = URL as unknown as Record<string, unknown>;
  const originalCreate = urlApi.createObjectURL;
  const originalRevoke = urlApi.revokeObjectURL;
  urlApi.createObjectURL = () => {
    created.push("blob:ai");
    return "blob:ai";
  };
  urlApi.revokeObjectURL = () => {};

  try {
    render(<AiAssistantPanel />);
    const exportButton = await screen.findByRole("button", {
      name: "Export conversation",
    });
    await waitFor(() =>
      assert.equal((exportButton as HTMLButtonElement).disabled, false),
    );

    fireEvent.click(exportButton);
    await waitFor(() =>
      assert.deepEqual(named(backend, "aiExportConversation")[0]?.args, [
        "conv-1",
      ]),
    );
    await waitFor(() => assert.equal(created.length, 1));

    // The 8 MiB ceiling is a hard error, not a truncation, and must be said.
    backend.failures.set("aiExportConversation", {
      code: "AI_LIMIT_EXCEEDED",
      message: "The AI conversation export exceeded 8388608 bytes.",
      source: "chat",
      operation: "ai:export_conversation",
      retryable: false,
      details: { limit: 8_388_608, actual: 9_000_000 },
    });
    fireEvent.click(exportButton);
    assert.ok(
      await screen.findByText(
        "The AI conversation export exceeded 8388608 bytes.",
      ),
    );
  } finally {
    urlApi.createObjectURL = originalCreate;
    urlApi.revokeObjectURL = originalRevoke;
  }
});

test("every icon-only control in the panel is announced by name", async () => {
  installBackend({
    providers: [providerProfile()],
    conversations: [conversationMeta()],
  });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-conversations");

  for (const name of [
    "Export conversation",
    "New conversation",
    "Delete conversation: First chat",
    "Send message",
  ]) {
    assert.ok(
      screen.getByRole("button", { name }),
      `no control is announced as ${name}`,
    );
  }

  // The stop button only exists mid-run, so it is checked where it appears.
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Hi" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  assert.ok(await screen.findByRole("button", { name: "Stop generating" }));
});

test("the segmented toolbar swaps the chat view for the settings view", async () => {
  installBackend({ conversations: [conversationMeta()] });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-transcript");

  const toolbar = screen.getByRole("toolbar", { name: "Assistant views" });
  const settings = within(toolbar).getByRole("button", { name: "Settings" });
  assert.equal(settings.getAttribute("aria-pressed"), "false");

  fireEvent.click(settings);
  await screen.findByTestId("ai-settings");
  assertAbsent(
    screen.queryByTestId("ai-transcript"),
    "transcript in settings view",
  );
  assert.equal(
    within(toolbar)
      .getByRole("button", { name: "Settings" })
      .getAttribute("aria-pressed"),
    "true",
  );

  fireEvent.click(within(toolbar).getByRole("button", { name: "Chat" }));
  await screen.findByTestId("ai-transcript");
});

test("an empty conversation list explains what to do next", async () => {
  installBackend({ conversations: [], conversation: null });
  render(<AiAssistantPanel />);

  const empty = await screen.findByTestId("ai-empty");
  assert.match(empty.textContent ?? "", /Select a conversation/);
  assert.ok(
    screen.getByText(
      "Configure a provider in Settings to start a conversation.",
    ),
  );
});
