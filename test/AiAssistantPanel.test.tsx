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
  AiPlan,
  AiProviderProfile,
  AiProviderProfileInput,
  AiRunSummary,
  AiToolAvailability,
  ChatMessage,
  Conversation,
  ConversationMeta,
} from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";
import {
  chooseThemedSelectValue,
  enableThemedSelectEnvironment,
} from "./radix-select";

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
  /** What `ai_get_plan` answers. `null`, the default, is "no plan". */
  plan?: AiPlan | null;
  /** What `ai_get_run_summary` answers once the plan is terminal. */
  runSummary?: AiRunSummary | null;
  /** The permission mode the snapshot reports. */
  mode?: AiPermissionsSnapshot["mode"];
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
  // The plan, and the run record the plan asks for once it is terminal.
  // `null` for both is "this conversation has no plan", which is what makes
  // the plan section render nothing.
  mock.method(
    TauriClient,
    "aiGetPlan",
    record("aiGetPlan", () => options.plan ?? null),
  );
  mock.method(
    TauriClient,
    "aiGetRunSummary",
    record("aiGetRunSummary", () => options.runSummary ?? null),
  );
  // The chat view reads this only while tool use is on, which is what lets a
  // test assert that an assistant with tools off never asks for it.
  const permissions: AiPermissionsSnapshot = {
    mode: options.mode ?? "ask",
    // A stored per-tool override, so a mode change can be shown to carry it
    // through rather than quietly clearing it.
    tools: { dns_delete_record: "deny" },
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
  mock.method(TauriClient, "aiSetPermissions", async (...args: unknown[]) => {
    calls.push({ name: "aiSetPermissions", args });
    if (failures.has("aiSetPermissions"))
      throw failures.get("aiSetPermissions");
    const next = args[0] as AiPermissionsSnapshot;
    permissions.mode = next.mode;
    permissions.tools = next.tools;
    return { mode: next.mode, tools: next.tools };
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

beforeEach(async () => {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  await useEnglishLocale();
  // The mode dropdown is a Radix select; opening one needs the two jsdom gaps
  // this installs. See `test/radix-select.ts`.
  enableThemedSelectEnvironment();
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

// ── The plan, where it mounts and what it reaches ──────────────────────────

/** A plan as `ai_get_plan` answers one, blocked by the assistant's own policy. */
function blockedPlan(): AiPlan {
  return {
    id: "plan-1",
    conversationId: "conv-1",
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
        refusal: {
          source: "assistantPolicy",
          reason: "dns_create_record is denied in read-only mode",
        },
      },
    ],
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

test("a conversation with no plan adds no plan section to the panel", async () => {
  installBackend({ conversations: [conversationMeta()] });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-transcript");

  // The dock and the bubble have no height to spare, so "no plan" has to cost
  // nothing rather than render an empty frame.
  assertAbsent(screen.queryByTestId("ai-plan"), "plan section with no plan");
  assertAbsent(screen.queryByTestId("ai-link-list"), "link list with no links");
});

test("the plan renders in the workspace tab, above the transcript", async () => {
  installBackend({
    conversations: [conversationMeta()],
    plan: blockedPlan(),
  });
  render(<AiAssistantPanel presentation="panel" />);

  const plan = await screen.findByTestId("ai-plan");
  assert.equal(plan.dataset.status, "draft");
  const transcript = screen.getByTestId("ai-transcript");
  // Above, because the whole point is that a blocked step is visible before
  // anything is approved, and the transcript grows without bound underneath.
  assert.ok(
    plan.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test("the assistant has no settings view of its own any more", async () => {
  // They are the "Assistant" section of the app's Settings workspace now, and
  // this used to be a Chat/Settings view switch inside the panel. A panel
  // that still rendered them would be a second host for one screen.
  installBackend({ conversations: [conversationMeta()] });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-transcript");

  assertAbsent(
    screen.queryByRole("toolbar", { name: "Assistant views" }),
    "the Chat/Settings view switch",
  );
  assertAbsent(
    screen.queryByTestId("ai-settings"),
    "settings inside the panel",
  );
  assertAbsent(
    screen.queryByRole("toolbar", { name: "Assistant settings sections" }),
    "the settings section nav inside the panel",
  );
});

test("a blocked step asks the host for Tools & permissions, by section", async () => {
  const sections: string[] = [];
  installBackend({
    conversations: [conversationMeta()],
    plan: blockedPlan(),
  });
  render(
    <AiAssistantPanel
      onOpenAssistantSettings={(section) => sections.push(section)}
    />,
  );
  await screen.findByTestId("ai-plan");

  // The assistant no longer owns that screen, so it names the section it
  // wants and the host navigates — which is what lands the user on the
  // control refusing the step rather than on a sentence describing it.
  fireEvent.click(screen.getByTestId("ai-plan-step-open-assistant-tools"));
  assert.deepEqual(sections, ["tools"]);
});

test("with no host for the settings there is no pointer, only the sentence", async () => {
  installBackend({
    conversations: [conversationMeta()],
    plan: blockedPlan(),
  });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-plan");

  assert.match(
    screen.getByTestId("ai-plan-step-refusal").textContent ?? "",
    /Settings, under Assistant, in Tools & permissions/,
  );
  assertAbsent(
    screen.queryByTestId("ai-plan-step-open-assistant-tools"),
    "a pointer with no host to navigate",
  );
});

test("the MCP screen is offered only when the host owns one", async () => {
  const mcpBlocked: AiPlan = {
    ...blockedPlan(),
    steps: [
      {
        ...blockedPlan().steps[0],
        refusal: { source: "mcpGrants", reason: "not granted" },
      },
    ],
  };
  installBackend({ conversations: [conversationMeta()], plan: mcpBlocked });

  // No host: the layer is still named, because that sentence is not the
  // host's to supply.
  render(<AiAssistantPanel />);
  const refusal = await screen.findByTestId("ai-plan-step-refusal");
  assert.match(refusal.textContent ?? "", /app's own MCP tool permissions/);
  assertAbsent(
    screen.queryByTestId("ai-plan-step-open-mcp-permissions"),
    "MCP control with no host wiring",
  );
  cleanup();

  const opens: number[] = [];
  render(<AiAssistantPanel onOpenMcpPermissions={() => opens.push(1)} />);
  await screen.findByTestId("ai-plan");
  fireEvent.click(screen.getByTestId("ai-plan-step-open-mcp-permissions"));
  assert.deepEqual(opens, [1]);
});

test("the run record appears under the plan once it is terminal", async () => {
  installBackend({
    conversations: [conversationMeta()],
    plan: { ...blockedPlan(), status: "done" },
    runSummary: {
      planId: "plan-1",
      title: "Fix the mail records",
      startedAt: CREATED,
      finishedAt: CREATED,
      stepTotals: { done: 1, blocked: 0, failed: 0, skipped: 0, pending: 0 },
      toolRuns: [{ tool: "dns_create_record", stepIndex: 0, outcome: "ok" }],
      refusals: [],
      mutatingToolsRun: ["dns_create_record"],
      anyChangeAttempted: true,
      narrative: "I created the SPF record.",
    },
  });
  render(<AiAssistantPanel />);

  const record = await screen.findByTestId("ai-run-summary");
  assert.equal(record.dataset.changed, "true");
  // The harness's record and the model's prose are separate regions, and the
  // record is the one that comes first.
  const facts = screen.getByTestId("ai-run-facts");
  const narrative = screen.getByTestId("ai-run-narrative");
  assert.ok(!facts.contains(narrative));
});

test("the links the assistant offers render as controls in the chat view", async () => {
  const backend = installBackend({ conversations: [conversationMeta()] });
  mock.method(TauriClient, "aiGetLinks", async () => {
    backend.calls.push({ name: "aiGetLinks", args: [] });
    return [
      { kind: "workspace", label: "Registry", target: "registry" },
      { kind: "external", label: "Run it", target: "javascript:alert(1)" },
    ];
  });
  render(<AiAssistantPanel />);

  const list = await screen.findByTestId("ai-link-list");
  assert.equal(list.dataset.context, "conversation");
  // The workspace link has no host wiring here, so nothing is followable; the
  // `javascript:` one never resolves at all. Both are counted as dropped.
  assert.equal(list.dataset.usable, "0");
  assert.equal(list.dataset.dropped, "2");
});

// ── The mode, changed from inside the conversation ─────────────────────────

test("the mode dropdown appears only while tool use is on", async () => {
  installBackend({ conversations: [conversationMeta()] });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-transcript");

  // With tool use off every tool is denied whatever the mode says, so a mode
  // control there would imply it decided something. It is also the gate on
  // the permission read, so nothing is asked for either.
  assertAbsent(
    screen.queryByTestId("ai-mode-select"),
    "a mode control with tool use off",
  );
  cleanup();

  installBackend({
    config: { toolsEnabled: true },
    conversations: [conversationMeta()],
  });
  render(<AiAssistantPanel />);
  const control = await screen.findByTestId("ai-mode-select");
  assert.equal(control.dataset.mode, "ask");
});

test("changing the mode writes it and carries the per-tool overrides through", async () => {
  const backend = installBackend({
    config: { toolsEnabled: true },
    conversations: [conversationMeta()],
  });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-mode-select");

  await act(async () => {
    await chooseThemedSelectValue(
      screen.getByLabelText("What the assistant may do"),
      "readOnly",
    );
  });

  const writes = named(backend, "aiSetPermissions");
  assert.equal(writes.length, 1, "exactly one writer of the mode");
  assert.deepEqual(writes[0].args[0], {
    mode: "readOnly",
    // The override survives: changing the mode must not silently clear a
    // per-tool rule set in the settings screen.
    tools: { dns_delete_record: "deny" },
  });
  // And the catalog is re-read, because `ai_set_permissions` answers with the
  // policy and not with its new effective per-tool values.
  await waitFor(() =>
    assert.ok(named(backend, "aiGetPermissions").length >= 2),
  );
  await waitFor(() =>
    assert.equal(screen.getByTestId("ai-mode-select").dataset.mode, "readOnly"),
  );
});

test("a mode the backend refuses leaves the control on the stored value", async () => {
  const backend = installBackend({
    config: { toolsEnabled: true },
    conversations: [conversationMeta()],
  });
  backend.failures.set("aiSetPermissions", {
    code: "AI_INVALID_PERMISSIONS",
    message: "that mode is not available in this build",
    source: "agent",
    operation: "ai:set_permissions",
    retryable: false,
    details: {},
  });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-mode-select");

  await act(async () => {
    await chooseThemedSelectValue(
      screen.getByLabelText("What the assistant may do"),
      "autonomous",
    );
  });

  await waitFor(() =>
    assert.match(
      document.body.textContent ?? "",
      /that mode is not available in this build/,
    ),
  );
  // Not "autonomous": the refusal did not change what gates the next call.
  assert.equal(screen.getByTestId("ai-mode-select").dataset.mode, "ask");
});

test("a mode read as read-only reports what that costs, unprompted", async () => {
  installBackend({
    config: { toolsEnabled: true },
    conversations: [conversationMeta()],
    mode: "readOnly",
  });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-mode-select");

  assert.match(
    screen.getByTestId("ai-mode-consequence").textContent ?? "",
    /refused outright — you are not prompted/,
  );
});

// ── Conversation history: select, rename, delete ───────────────────────────

test("a conversation can be renamed, which nothing in the UI could do before", async () => {
  // `ai_set_conversation_title` has been registered since the chat shipped
  // and `useAiConversations.setTitle` wrapped it, and **nothing called
  // either**. So every conversation was stuck with the title it was created
  // with, which is what makes a list of several of them unnavigable — and the
  // most likely reason the history looks absent.
  const backend = installBackend({
    conversations: [
      conversationMeta({ id: "conv-1", title: "First chat" }),
      conversationMeta({ id: "conv-2", title: "Second chat" }),
    ],
  });
  mock.method(
    TauriClient,
    "aiSetConversationTitle",
    async (...args: unknown[]) => {
      backend.calls.push({ name: "aiSetConversationTitle", args });
      return true;
    },
  );
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-transcript");

  fireEvent.click(
    await screen.findByRole("button", {
      name: "Rename conversation: Second chat",
    }),
  );
  const field = screen.getByRole("textbox", {
    name: "Rename conversation: Second chat",
  });
  fireEvent.change(field, {
    target: { value: "  MX records for example.test  " },
  });
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Save the title for Second chat" }),
    );
  });

  // Trimmed, and against the right conversation.
  assert.deepEqual(
    named(backend, "aiSetConversationTitle").map((call) => call.args),
    [["conv-2", "MX records for example.test"]],
  );
  // The list is re-read rather than patched locally, because the backend
  // bounds and normalises a title.
  await waitFor(() =>
    assert.ok(named(backend, "aiListConversations").length >= 2),
  );
});

test("Enter saves a rename and Escape abandons it without dismissing the bubble", async () => {
  const backend = installBackend({
    conversations: [conversationMeta({ title: "First chat" })],
  });
  mock.method(
    TauriClient,
    "aiSetConversationTitle",
    async (...args: unknown[]) => {
      backend.calls.push({ name: "aiSetConversationTitle", args });
      return true;
    },
  );
  render(<AiAssistantPanel presentation="bubble" />);
  await screen.findByTestId("ai-transcript");

  // Escape first: it must cancel the edit and go no further. The bubble
  // closes on Escape, and this input is rendered inside it.
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Rename conversation: First chat",
    }),
  );
  const field = screen.getByRole("textbox", {
    name: "Rename conversation: First chat",
  });
  fireEvent.change(field, { target: { value: "abandoned" } });
  const notPrevented = fireEvent.keyDown(field, {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  assert.equal(notPrevented, false, "Escape must be consumed by the edit");
  assertAbsent(
    screen.queryByRole("textbox", {
      name: "Rename conversation: First chat",
    }),
    "the rename field after Escape",
  );
  assert.equal(named(backend, "aiSetConversationTitle").length, 0);

  // Then Enter, which saves.
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Rename conversation: First chat",
    }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Rename conversation: First chat" }),
    { target: { value: "Renamed by Enter" } },
  );
  await act(async () => {
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Rename conversation: First chat" }),
      { key: "Enter" },
    );
  });
  assert.deepEqual(
    named(backend, "aiSetConversationTitle").map((call) => call.args),
    [["conv-1", "Renamed by Enter"]],
  );
});

test("a refused rename shows the backend's message and keeps the field open", async () => {
  const backend = installBackend({
    conversations: [conversationMeta({ title: "First chat" })],
  });
  mock.method(TauriClient, "aiSetConversationTitle", async () => {
    backend.calls.push({ name: "aiSetConversationTitle", args: [] });
    throw {
      code: "AI_LIMIT",
      message: "title must not exceed 512 bytes",
      source: "chat",
      operation: "ai:set_conversation_title",
      retryable: false,
      details: { limit: 512, actual: 900 },
    };
  });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-transcript");

  fireEvent.click(
    await screen.findByRole("button", {
      name: "Rename conversation: First chat",
    }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Rename conversation: First chat" }),
    { target: { value: "a very long title" } },
  );
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Save the title for First chat" }),
    );
  });

  // A title is bounded in UTF-8 bytes and that ceiling is user-configurable,
  // so a title that looks short can still be refused — the backend's own
  // message says which number was exceeded.
  await waitFor(() =>
    assert.match(
      screen.getByTestId("ai-conversation-rename-error").textContent ?? "",
      /title must not exceed 512 bytes/,
    ),
  );
  // Still editing, so the typed title is not lost.
  assert.ok(
    screen.getByRole("textbox", { name: "Rename conversation: First chat" }),
  );
});

test("a blank title is refused before it reaches the backend", async () => {
  const backend = installBackend({
    conversations: [conversationMeta({ title: "First chat" })],
  });
  mock.method(TauriClient, "aiSetConversationTitle", async () => {
    backend.calls.push({ name: "aiSetConversationTitle", args: [] });
    return true;
  });
  render(<AiAssistantPanel />);
  await screen.findByTestId("ai-transcript");

  fireEvent.click(
    await screen.findByRole("button", {
      name: "Rename conversation: First chat",
    }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Rename conversation: First chat" }),
    { target: { value: "   " } },
  );
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Save the title for First chat" }),
    );
  });

  assert.match(
    screen.getByTestId("ai-conversation-rename-error").textContent ?? "",
    /A conversation needs a title\./,
  );
  assert.equal(named(backend, "aiSetConversationTitle").length, 0);
});

test("the history is selectable and says which conversation is active", async () => {
  const backend = installBackend({
    conversations: [
      conversationMeta({ id: "conv-1", title: "First chat" }),
      conversationMeta({ id: "conv-2", title: "Second chat" }),
    ],
  });
  render(<AiAssistantPanel presentation="sidebar" />);
  await screen.findByTestId("ai-transcript");

  const rows = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="ai-conversation-row"]',
      ),
    );
  // Landed on the most recent, and says so rather than leaving the user to
  // guess which transcript they are reading.
  await waitFor(() => assert.equal(rows()[0].dataset.active, "true"));
  assert.equal(rows()[1].dataset.active, "false");
  // Filtered on `pressed`: the rename and delete controls in the same row
  // also carry the title in their names, and only the select button is a
  // toggle.
  assert.ok(
    within(rows()[0]).getByRole("button", {
      name: /First chat/,
      pressed: true,
    }),
  );

  // Switching reloads that conversation's transcript from the backend rather
  // than reusing the one on screen.
  const readsBefore = named(backend, "aiGetConversation").length;
  fireEvent.click(
    within(rows()[1]).getByRole("button", {
      name: /Second chat/,
      pressed: false,
    }),
  );
  await waitFor(() => assert.equal(rows()[1].dataset.active, "true"));
  await waitFor(() =>
    assert.ok(named(backend, "aiGetConversation").length > readsBefore),
  );
});

test("the create row stacks on a framed surface and pairs on the tab", async () => {
  // The row is a 9rem select, a 12rem input and a button: about 23rem, which
  // `flex-wrap` saved from overflowing a 22rem dock but left ragged. It is
  // keyed off the surface, not a viewport breakpoint — a docked panel can be
  // 22rem wide on a 2560px display.
  installBackend({
    providers: [providerProfile()],
    conversations: [conversationMeta()],
  });
  render(<AiAssistantPanel presentation="sidebar" />);
  const docked = await screen.findByLabelText("Model");
  assert.match(docked.className, /(?:^|\s)w-full(?:$|\s)/);
  cleanup();

  installBackend({
    providers: [providerProfile()],
    conversations: [conversationMeta()],
  });
  render(<AiAssistantPanel presentation="panel" />);
  const tabbed = await screen.findByLabelText("Model");
  assert.match(tabbed.className, /(?:^|\s)w-48(?:$|\s)/);
});
