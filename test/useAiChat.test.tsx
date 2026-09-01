import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import {
  AI_STREAM_STALLED_MESSAGE,
  useAiChat,
  useAiConversations,
  useAiPresets,
  useAiProviders,
} from "../src/hooks/ai/use-ai-chat";
import { TauriClient } from "../src/lib/api/tauri-client";
import type {
  AgentEvent,
  AiCommandError,
  Conversation,
  ConversationMeta,
} from "../src/types/ai";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    title: "Zone questions",
    provider: "openai",
    model: "gpt-4o",
    messages: [],
    createdAt: "2026-08-26T10:00:00Z",
    updatedAt: "2026-08-26T10:00:00Z",
    ...overrides,
  };
}

function meta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: "c1",
    title: "Zone questions",
    provider: "openai",
    model: "gpt-4o",
    messageCount: 0,
    createdAt: "2026-08-26T10:00:00Z",
    updatedAt: "2026-08-26T10:00:00Z",
    ...overrides,
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

type Backend = {
  calls: string[];
  conversation: Conversation;
  /** Set to hold `ai_get_conversation` open until the test releases it. */
  gate: Deferred<Conversation> | null;
  emit: ((event: AgentEvent) => void) | null;
  unlistened: number;
  failSend: unknown;
  failApprove: unknown;
};

function installBackend(): Backend {
  const backend: Backend = {
    calls: [],
    conversation: conversation(),
    gate: null,
    emit: null,
    unlistened: 0,
    failSend: null,
    failApprove: null,
  };

  mock.method(TauriClient, "aiGetConversation", async (id: string) => {
    backend.calls.push(`get:${id}`);
    if (backend.gate) return backend.gate.promise;
    return backend.conversation;
  });
  mock.method(
    TauriClient,
    "aiSendMessage",
    async (conversationId: string, text: string, provider: string) => {
      backend.calls.push(`send:${conversationId}:${text}:${provider}`);
      if (backend.failSend) throw backend.failSend;
      return "user-msg-1";
    },
  );
  mock.method(
    TauriClient,
    "aiApproveToolCall",
    async (conversationId: string, toolCallId: string) => {
      backend.calls.push(`approve:${conversationId}:${toolCallId}`);
      if (backend.failApprove) throw backend.failApprove;
    },
  );
  mock.method(TauriClient, "aiCancelGeneration", async (id: string) => {
    backend.calls.push(`cancel:${id}`);
    return true;
  });
  mock.method(TauriClient, "aiExportConversation", async (id: string) => {
    backend.calls.push(`export:${id}`);
    return '{"id":"c1"}';
  });
  mock.method(
    TauriClient,
    "onAiEvent",
    async (handler: (event: AgentEvent) => void) => {
      backend.calls.push("listen");
      backend.emit = handler;
      return () => {
        backend.unlistened += 1;
      };
    },
  );
  return backend;
}

/** Deliver one `ai:event` the way the Tauri channel would. */
async function deliver(backend: Backend, event: AgentEvent): Promise<void> {
  await act(async () => {
    backend.emit?.(event);
  });
}

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

// ─── Availability ──────────────────────────────────────────────────────────

test("every AI hook is inert on the web build", async () => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
  const backend = installBackend();
  mock.method(TauriClient, "aiListProviders", async () => {
    backend.calls.push("providers");
    return [];
  });
  mock.method(TauriClient, "aiListConversations", async () => {
    backend.calls.push("conversations");
    return [];
  });
  mock.method(TauriClient, "aiCreateConversation", async () => {
    backend.calls.push("create");
    return meta();
  });
  mock.method(TauriClient, "aiListPresets", async () => {
    backend.calls.push("presets");
    return [];
  });

  const chat = renderHook(() => useAiChat("c1"));
  const providers = renderHook(() => useAiProviders());
  const conversations = renderHook(() => useAiConversations());
  const presets = renderHook(() => useAiPresets());

  assert.equal(chat.result.current.available, false);
  assert.equal(providers.result.current.available, false);
  assert.equal(conversations.result.current.available, false);
  assert.equal(presets.result.current.available, false);

  // Mutators resolve without reaching the backend rather than throwing.
  await act(async () => {
    await chat.result.current.sendMessage("hi", "openai");
    await chat.result.current.cancel();
    await chat.result.current.approveToolCall("tc1");
    assert.equal(await chat.result.current.exportConversation(), null);
    assert.equal(
      await conversations.result.current.create("openai", "gpt-4o"),
      null,
    );
    assert.deepEqual(await providers.result.current.testProvider("openai"), []);
    assert.equal(await presets.result.current.getPreset("p1"), null);
  });

  assert.deepEqual(backend.calls, []);
  assert.equal(chat.result.current.streaming, false);
});

// ─── Event routing ─────────────────────────────────────────────────────────

test("routes events by conversation id and ignores other conversations", async () => {
  const backend = installBackend();
  const { result } = renderHook(() => useAiChat("c1"));
  await waitFor(() => assert.ok(backend.emit));

  await deliver(backend, {
    type: "textDelta",
    conversationId: "c2",
    messageId: "m9",
    text: "not mine",
  });
  assert.equal(result.current.streamText, "");

  // The camelCase field is the contract: a snake_case `conversation_id` would
  // leave `conversationId` undefined and drop every event (the original bug).
  await deliver(backend, {
    type: "textDelta",
    conversationId: "c1",
    messageId: "m1",
    text: "Hello",
  });
  await deliver(backend, {
    type: "textDelta",
    conversationId: "c1",
    messageId: "m1",
    text: ", world",
  });
  assert.equal(result.current.streamText, "Hello, world");
});

test("clears the stream buffer only after the refresh settles", async () => {
  const backend = installBackend();
  const { result } = renderHook(() => useAiChat("c1"));
  await waitFor(() => assert.ok(backend.emit));

  await act(async () => {
    await result.current.sendMessage("hi", "openai");
  });
  assert.equal(result.current.streaming, true);

  await deliver(backend, {
    type: "textDelta",
    conversationId: "c1",
    messageId: "m1",
    text: "streamed answer",
  });
  assert.equal(result.current.streamText, "streamed answer");

  // Hold the post-turn refresh open. Clearing the buffer first would blank the
  // transcript for the whole round trip — the flicker §7 calls out.
  const gate = deferred<Conversation>();
  backend.gate = gate;

  await deliver(backend, {
    type: "turnComplete",
    conversationId: "c1",
    messageId: "m1",
  });

  assert.equal(result.current.streaming, false);
  assert.equal(
    result.current.streamText,
    "streamed answer",
    "buffer must survive until the authoritative transcript has arrived",
  );

  const persisted = conversation({
    messages: [
      {
        id: "m1",
        message: {
          role: "assistant",
          content: { type: "text", text: "streamed answer" },
        },
        status: "complete",
        createdAt: "2026-08-26T10:00:01Z",
        pendingToolCalls: [],
      },
    ],
  });
  await act(async () => {
    backend.gate = null;
    gate.resolve(persisted);
    await gate.promise;
  });

  await waitFor(() => assert.equal(result.current.streamText, ""));
  assert.equal(result.current.conversation?.messages.length, 1);
});

test("keeps the partial answer when a run errors or is cancelled", async () => {
  const backend = installBackend();
  const { result } = renderHook(() => useAiChat("c1"));
  await waitFor(() => assert.ok(backend.emit));

  await act(async () => {
    await result.current.sendMessage("hi", "openai");
  });
  await deliver(backend, {
    type: "textDelta",
    conversationId: "c1",
    messageId: "m1",
    text: "half an ans",
  });

  await deliver(backend, {
    type: "error",
    conversationId: "c1",
    error: "The provider returned 503.",
  });

  assert.equal(result.current.streaming, false);
  assert.equal(result.current.error?.message, "The provider returned 503.");
  // The backend only stamps a status onto an empty pending message, so the
  // buffer is the only copy of what the user already read.
  assert.equal(result.current.streamText, "half an ans");

  await act(async () => {
    result.current.dismissError();
  });
  assert.equal(result.current.error, null);

  await deliver(backend, { type: "cancelled", conversationId: "c1" });
  assert.equal(result.current.streaming, false);
  assert.equal(result.current.streamText, "half an ans");
});

test("a paused approval stops the run and offers no approve path of its own", async () => {
  const backend = installBackend();
  const { result } = renderHook(() => useAiChat("c1"));
  await waitFor(() => assert.ok(backend.emit));

  await act(async () => {
    await result.current.sendMessage("delete a record", "openai");
  });

  const approval: AgentEvent = {
    type: "toolApprovalRequired",
    conversationId: "c1",
    toolCallId: "tc1",
    toolName: "cf_delete_dns_record",
    arguments: { zoneId: "z1", recordId: "r1" },
    reason: "This tool changes DNS records.",
  };
  await deliver(backend, approval);

  assert.deepEqual(result.current.pendingApproval, approval);
  // The turn ends and waits, so the composer must unlock.
  assert.equal(result.current.streaming, false);
});

test("restores the pending approval when approving fails", async () => {
  const backend = installBackend();
  backend.failApprove = { message: "denied" };
  const { result } = renderHook(() => useAiChat("c1"));
  await waitFor(() => assert.ok(backend.emit));

  const approval: AgentEvent = {
    type: "toolApprovalRequired",
    conversationId: "c1",
    toolCallId: "tc1",
    toolName: "cf_delete_dns_record",
    arguments: {},
    reason: "mutating",
  };
  await deliver(backend, approval);

  await act(async () => {
    await assert.rejects(() => result.current.approveToolCall("tc1"));
  });

  assert.deepEqual(result.current.pendingApproval, approval);
  assert.equal(result.current.streaming, false);
});

// ─── Watchdog ──────────────────────────────────────────────────────────────

test("unlocks the composer when no terminal event ever arrives", async () => {
  const backend = installBackend();
  const { result } = renderHook(() => useAiChat("c1", { watchdogMs: 10 }));
  await waitFor(() => assert.ok(backend.emit));

  await act(async () => {
    await result.current.sendMessage("hi", "openai");
  });
  assert.equal(result.current.streaming, true);

  await waitFor(() => assert.equal(result.current.streaming, false));
  assert.equal(result.current.error?.message, AI_STREAM_STALLED_MESSAGE);
  assert.equal(result.current.error?.retryable, true);
});

test("a terminal event disarms the watchdog", async () => {
  const backend = installBackend();
  const { result } = renderHook(() => useAiChat("c1", { watchdogMs: 30 }));
  await waitFor(() => assert.ok(backend.emit));

  await act(async () => {
    await result.current.sendMessage("hi", "openai");
  });
  await deliver(backend, {
    type: "turnComplete",
    conversationId: "c1",
    messageId: "m1",
  });
  assert.equal(result.current.streaming, false);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  // The stall notice must not appear for a turn that finished normally.
  assert.equal(result.current.error, null);
});

// ─── Command failures ──────────────────────────────────────────────────────

test("surfaces a structured AiCommandError from a failed send", async () => {
  const backend = installBackend();
  const failure: AiCommandError = {
    code: "AI_NOT_CONFIGURED",
    message: "The AI provider is not configured.",
    source: "provider",
    operation: "ai:send_message",
    retryable: false,
    details: { remediation: "Add an API key in AI settings." },
  };
  backend.failSend = failure;
  const { result } = renderHook(() => useAiChat("c1"));
  await waitFor(() => assert.ok(backend.emit));

  await act(async () => {
    await assert.rejects(() => result.current.sendMessage("hi", "openai"));
  });

  assert.equal(result.current.streaming, false);
  assert.deepEqual(result.current.error, {
    message: "The AI provider is not configured.",
    remediation: "Add an API key in AI settings.",
    retryable: false,
  });
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────

test("resets stream state and resubscribes when the conversation changes", async () => {
  const backend = installBackend();
  const { result, rerender } = renderHook(
    ({ id }: { id: string }) => useAiChat(id),
    { initialProps: { id: "c1" } },
  );
  await waitFor(() => assert.ok(backend.emit));

  await act(async () => {
    await result.current.sendMessage("hi", "openai");
  });
  await deliver(backend, {
    type: "textDelta",
    conversationId: "c1",
    messageId: "m1",
    text: "partial",
  });
  assert.equal(result.current.streamText, "partial");

  backend.conversation = conversation({ id: "c2", title: "Other" });
  await act(async () => {
    rerender({ id: "c2" });
  });

  assert.equal(result.current.streamText, "");
  assert.equal(result.current.streaming, false);
  assert.equal(result.current.pendingApproval, null);
  assert.equal(backend.unlistened, 1);
  await waitFor(() => assert.equal(result.current.conversation?.id, "c2"));
  assert.ok(backend.calls.includes("get:c2"));
});

test("unsubscribes from the event channel on unmount", async () => {
  const backend = installBackend();
  const { unmount } = renderHook(() => useAiChat("c1"));
  await waitFor(() => assert.ok(backend.emit));

  unmount();
  assert.equal(backend.unlistened, 1);
});

test("does not subscribe when there is no conversation selected", async () => {
  const backend = installBackend();
  const { result } = renderHook(() => useAiChat(null));

  await waitFor(() => assert.equal(result.current.conversation, null));
  assert.deepEqual(backend.calls, []);
  await act(async () => {
    await assert.rejects(() => result.current.sendMessage("hi", "openai"), {
      message: "No conversation selected",
    });
  });
});

// ─── Sibling hooks ─────────────────────────────────────────────────────────

test("configuring a provider refreshes the provider list", async () => {
  const calls: string[] = [];
  let configured = false;
  mock.method(TauriClient, "aiListProviders", async () => {
    calls.push("list");
    return [
      { kind: "openai" as const, configured },
      { kind: "anthropic" as const, configured: false },
      { kind: "ollama" as const, configured: false },
    ];
  });
  mock.method(TauriClient, "aiConfigureProvider", async () => {
    calls.push("configure");
    configured = true;
  });

  const { result } = renderHook(() => useAiProviders());
  await waitFor(() => assert.equal(result.current.providers.length, 3));
  assert.equal(result.current.providers[0].configured, false);

  await act(async () => {
    await result.current.configure({
      kind: "openai",
      apiKey: "sk-test",
      model: "gpt-4o",
      temperature: 0.2,
      maxTokens: 1024,
    });
  });

  assert.deepEqual(calls, ["list", "configure", "list"]);
  assert.equal(result.current.providers[0].configured, true);
});

test("creating a conversation refreshes the list and returns the new meta", async () => {
  const store: ConversationMeta[] = [];
  mock.method(TauriClient, "aiListConversations", async () => [...store]);
  mock.method(TauriClient, "aiCreateConversation", async () => {
    const created = meta({ id: "c9", title: "New chat" });
    store.push(created);
    return created;
  });

  const { result } = renderHook(() => useAiConversations());
  await waitFor(() => assert.equal(result.current.loading, false));

  // Held in an object: a plain `let` would be narrowed to `null` here, because
  // control-flow analysis does not follow the assignment inside `act`.
  const created: { value: ConversationMeta | null } = { value: null };
  await act(async () => {
    created.value = await result.current.create("anthropic", "claude-sonnet-4");
  });

  assert.equal(created.value?.id, "c9");
  await waitFor(() => assert.equal(result.current.conversations.length, 1));
});
