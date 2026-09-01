/**
 * Tests for the AI assistant panel.
 *
 * The load-bearing assertions here are the ones about posture, not about
 * layout. Tool dispatch is denied at a crate boundary in this build
 * (`bc_mcp::tools::execute_tool` always returns an error; the real dispatcher
 * is `pub(crate)`), so the panel must never offer an approve action and must
 * not let a user chat while the agent is still configured to offer tools. Two
 * tests pin exactly that, and they are the ones to read first if this file ever
 * starts failing.
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
  ChatMessage,
  Conversation,
  ConversationMeta,
  ProviderConfig,
  ProviderStatus,
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
  providers?: ProviderStatus[];
  conversations?: ConversationMeta[];
  conversation?: Conversation | null;
}

interface Backend {
  calls: BackendCall[];
  /** Deliver an agent event exactly as the Tauri channel would. */
  emit: (event: AgentEvent) => void;
  /** Mutable, so a refresh after `turnComplete` can return new messages. */
  state: { conversation: Conversation | null };
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
  let handler: ((event: AgentEvent) => void) | null = null;

  const config: AgentConfig = {
    maxToolRounds: 8,
    maxTokensPerTurn: 4096,
    toolsEnabled: false,
    stream: true,
    preset: "default",
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
    record("aiListProviders", () => options.providers ?? []),
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
  mock.method(
    TauriClient,
    "aiConfigureProvider",
    record("aiConfigureProvider", () => undefined),
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

// ── The tool posture: the reason this panel is chat-only ───────────────────

test("tools enabled blocks the composer behind an explicit opt-out", async () => {
  const backend = installBackend({
    config: { toolsEnabled: true },
    conversations: [conversationMeta()],
  });
  render(<AiAssistantPanel />);

  const notice = await screen.findByTestId("ai-tool-warning");
  await waitFor(() =>
    assert.equal(notice.getAttribute("data-state"), "blocked"),
  );
  assert.ok(within(notice).getByRole("alert"));

  // Opening the panel must not have quietly rewritten global agent config.
  assert.equal(named(backend, "aiSetConfig").length, 0);

  const composer = screen.getByLabelText("Message");
  assert.equal((composer as HTMLTextAreaElement).disabled, true);

  fireEvent.click(screen.getByRole("button", { name: "Disable tool use" }));

  await waitFor(() => assert.equal(named(backend, "aiSetConfig").length, 1));
  const [written] = named(backend, "aiSetConfig")[0].args as [AgentConfig];
  assert.equal(written.toolsEnabled, false);
  // The rest of the agent config is carried through untouched.
  assert.equal(written.maxToolRounds, 8);
  assert.equal(written.preset, "default");

  await waitFor(() =>
    assert.equal(
      (screen.getByLabelText("Message") as HTMLTextAreaElement).disabled,
      false,
    ),
  );
  assert.equal(
    screen.getByTestId("ai-tool-warning").getAttribute("data-state"),
    "ready",
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

test("the tool-use toggle is present, disabled, and reports the real state", async () => {
  installBackend();
  render(<AiAssistantPanel initialView="settings" />);

  const toggle = await screen.findByRole("switch", { name: "Tool use" });
  assert.equal((toggle as HTMLButtonElement).disabled, true);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.ok(
    screen.getAllByText(
      /Tool use is unavailable in this build\. The assistant can read and discuss, but cannot change anything in your account\./,
    ).length > 0,
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
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "gpt-4o-mini" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  await waitFor(() =>
    assert.equal(named(backend, "aiConfigureProvider").length, 1),
  );
  const [sent] = named(backend, "aiConfigureProvider")[0].args as [
    ProviderConfig,
  ];
  // The shape Rust actually deserializes: lowercase kind, required model /
  // temperature / maxTokens, and no invented `orgId`.
  assert.equal(sent.kind, "openai");
  assert.equal(sent.model, "gpt-4o-mini");
  assert.equal(typeof sent.temperature, "number");
  assert.equal(typeof sent.maxTokens, "number");
  assert.equal(sent.apiKey, "sk-secret-value");
  assert.ok(!("orgId" in sent));

  // Saving is also the verification, so there is no separate Test button.
  assertAbsent(
    screen.queryByRole("button", { name: /^test/i }),
    "separate Test button",
  );

  // The key is dropped from component state once it has been handed over.
  await waitFor(() =>
    assert.equal(
      (screen.getByLabelText("API key") as HTMLInputElement).value,
      "",
    ),
  );
  assert.doesNotMatch(document.body.textContent ?? "", /sk-secret-value/);
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

  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "sk-wrong" },
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
    providers: [{ kind: "openai", configured: true }],
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
      "openai",
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
    providers: [{ kind: "openai", configured: true }],
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
