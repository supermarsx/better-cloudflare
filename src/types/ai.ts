/**
 * TypeScript types for the AI assistant subsystem.
 *
 * These mirror the Rust types in `bc-ai-provider`, `bc-ai-chat`,
 * `bc-ai-tools`, and `bc-ai-agent`.
 */

// ─── Provider Types ────────────────────────────────────────────────────────

/**
 * The wire format a provider speaks — not the vendor.
 *
 * Rust is `#[serde(rename_all = "lowercase")]` on the protocol enum
 * (`bc-ai-provider/src/config.rs`), so `OpenAi` is `"openai"` on the wire, not
 * `"openAi"`. The protocol also supplies the default base URL and default
 * model for a profile that does not name its own, which is why one protocol can
 * back any number of providers: OpenAI, Groq, Together, vLLM and LM Studio all
 * speak `"openai"`, and each is a separate {@link AiProviderProfile}.
 */
export type ProviderProtocol = "openai" | "anthropic" | "ollama";

/** Every protocol, in the order the backend enumerates them. */
export const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = [
  "openai",
  "anthropic",
  "ollama",
] as const;

/**
 * A configured provider, as `ai_list_providers` and `ai_configure_provider`
 * report it.
 *
 * **There is deliberately no `apiKey` field.** The renderer never receives key
 * material — only {@link hasApiKey}, which says whether one is stored. Adding a
 * key field here, even optional, would re-open the leak this shape exists to
 * close; see `AiProviderSettings` for the display rule that follows from it.
 *
 * `baseUrl` and `model` are always resolved: a profile saved without a base URL
 * comes back carrying the protocol's default, so the form can show the endpoint
 * that will actually be dialled rather than an empty field.
 */
export interface AiProviderProfile {
  /** User-chosen, `[A-Za-z0-9-_]`, unique. Stable across edits. */
  id: string;
  /** Display name. Free text; this is what the chat UI shows. */
  label: string;
  protocol: ProviderProtocol;
  /** Absolute `http:`/`https:` URL. Resolved, never blank. */
  baseUrl: string;
  model: string;
  /** 0.0–2.0. */
  temperature: number;
  /** Bounded by `MAX_COMPLETION_TOKENS`. */
  maxTokens: number;
  /** Whether a key is stored. The key itself is never sent to the renderer. */
  hasApiKey: boolean;
}

/**
 * The writable half of a profile — what `ai_configure_provider` accepts.
 *
 * `id` absent creates a profile and lets the backend assign the id; `id`
 * present updates that profile in place, so the same command is both create and
 * update. `baseUrl` absent means "use the protocol's default".
 *
 * {@link apiKey} is three-valued on purpose, and the distinction is the whole
 * reason this type is separate from {@link AiProviderProfile}:
 *
 * - **absent** — leave the stored key exactly as it is. This is what an edit
 *   that did not touch the key must send; the renderer has no key to resend.
 * - **`null`** — clear the stored key.
 * - **a string** — replace the stored key with this one.
 */
export interface AiProviderProfileInput {
  id?: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiKey?: string | null;
}

/** Description of an available model. */
export interface Model {
  id: string;
  name: string;
  contextWindow?: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
}

// ─── Message Types ─────────────────────────────────────────────────────────

/** Message role in a conversation. */
export type Role = "system" | "user" | "assistant" | "tool";

/** Message content — text, tool calls, or tool result. */
export type MessageContent =
  | { type: "text"; text: string }
  | { type: "toolUse"; toolCalls: ToolCall[] }
  | {
      type: "toolResult";
      toolCallId: string;
      content: string;
      isError: boolean;
    };

/** A single message in a conversation. */
export interface Message {
  role: Role;
  content: MessageContent;
  toolCallId?: string;
}

/** Status of a chat message. */
export type MessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | { error: { message: string } }
  | "cancelled";

/** A chat message with metadata. */
export interface ChatMessage {
  id: string;
  message: Message;
  status: MessageStatus;
  createdAt: string;
  usage?: Usage;
  pendingToolCalls: ToolCall[];
}

// ─── Tool Types ────────────────────────────────────────────────────────────

/** A tool the model can invoke. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Result of executing a tool call. */
export interface ToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

/** Token usage statistics. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─── Conversation Types ────────────────────────────────────────────────────

/**
 * Lightweight conversation metadata for listing.
 *
 * `provider` is a plain string, not a protocol: since provider identity became
 * user-defined it is an {@link AiProviderProfile.id}. Older conversations were
 * stored against a bare protocol name, and both spellings have to render, so
 * nothing here may assume the value resolves to a profile that still exists.
 */
export interface ConversationMeta {
  id: string;
  title: string;
  provider: string;
  model: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Full conversation with all messages. */
export interface Conversation {
  id: string;
  title: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

// ─── Agent Types ───────────────────────────────────────────────────────────

/**
 * Configuration for the AI agent loop.
 *
 * `maxToolRounds`, `maxTokensPerTurn`, `toolsEnabled`, `stream` and `preset`
 * mirror Rust `AgentConfig` (`bc-ai-agent/src/config.rs:13-25`) and are bounded
 * by `AgentConfig::validate` — see `AI_AGENT_LIMITS` for the numbers.
 *
 * `temperature`, `topP` and `personaId` are the three fields the sampling and
 * persona work added to `ai_get_config` / `ai_set_config`. The advanced
 * generation parameters that follow them are optional and provider-dependent;
 * read their own doc comment before rendering a control for one.
 *
 * `defaultProviderId` arrives with user-defined providers. It lives in agent
 * config rather than on the profiles themselves so that exactly one provider
 * can be the default — a flag per profile could be set on two of them at once.
 * It may name a profile that has since been deleted; a reader must treat an
 * unmatched id as "no default" rather than as a usable provider.
 */
export interface AgentConfig {
  maxToolRounds: number;
  maxTokensPerTurn: number;
  toolsEnabled: boolean;
  stream: boolean;
  /**
   * The advanced generation parameters, mirroring Rust `AgentConfig`
   * (`bc-ai-agent/src/config.rs`).
   *
   * Most are `Option<…>` in Rust, so `null` is how "not set" is *sent* and
   * absent is how an older build's read arrives — both mean the same thing,
   * and the backend then sends nothing for that parameter at all. Zero is
   * never that: a `topK` of 0 asks to sample from no tokens.
   *
   * Which of them a provider honours is not a property of this type:
   * Anthropic has no `seed` and no penalties, OpenAI has no `topK`. Ask
   * `ai_protocol_capabilities` (see {@link AiProtocolCapabilities}) rather
   * than assuming a stored value reaches anything — {@link topP} spent a
   * release stored, validated and sent nowhere, which is the mistake that
   * command exists to stop.
   */
  topK?: number | null;
  /**
   * Sequences that end the reply, at most four. Empty or absent sends none —
   * Rust types this a bare `Vec<String>`, and an empty array is the absence
   * of the setting rather than "stop on nothing".
   */
  stop?: string[];
  seed?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  /**
   * The token budget for the history sent with a turn.
   *
   * The one advanced parameter that is **not** optional: Rust types it a bare
   * `u32` with a serde default, so it is always a number and `null` is not a
   * value it can take. It is marked optional here only so that a config read
   * from a build predating the field still satisfies the type; see
   * `AI_DEFAULT_MAX_CONTEXT_TOKENS` for what to seed a form with then.
   */
  maxContextTokens?: number;
  /**
   * Extra instructions **added to** the system prompt in effect.
   *
   * Composed, not substituted: `compose_system_prompt`
   * (`bc-ai-agent/src/agent.rs`) appends this after the conversation's own
   * prompt or, failing that, the selected persona's, so the persona keeps
   * applying. A present-but-blank value is refused by the backend — `null` is
   * how the setting is cleared.
   */
  systemPromptOverride?: string | null;
  requestTimeoutMs?: number | null;
  /**
   * The pre-persona spelling of {@link personaId}.
   *
   * **Optional, and never present on a read.** Rust's `AgentConfig` no longer
   * has this field: it deserializes through a compatibility shape that accepts
   * `preset` as an alias and drops it, and serializes only `personaId`. So a
   * value read from `ai_get_config` has no `preset` at all, and one sent is
   * ignored whenever `personaId` is also present. It stays in the type only so
   * that a config round-tripped through older stored session state still
   * satisfies it.
   */
  preset?: string;
  /** 0.0–2.0. */
  temperature: number;
  /** 0.0–1.0. */
  topP: number;
  /**
   * The selected {@link AiPersona}.
   *
   * A read always carries a string — Rust's field is a plain `String` and
   * falls back to the `default` persona — so `null` is only ever something the
   * renderer *sends*, and the backend resolves it to `default` rather than to
   * "no persona at all". Treat a write of `null` as "use the default persona".
   */
  personaId: string | null;
  defaultProviderId: string | null;
  /**
   * The eight retention and plan limits, mirroring Rust `AgentConfig`
   * (`bc-ai-agent/src/config.rs`, `CONFIGURABLE_LIMITS`).
   *
   * Every one is bounded by `1..=CEILING`, where the ceiling is the constant
   * of the same name in `bc_ai_chat::limits` or `bc_ai_agent::plan` — see
   * {@link AI_AGENT_LIMITS}. **The ceilings are ceilings**: a value may be
   * lowered and may never be raised past what the code is built to survive,
   * and the backend refuses an out-of-range value by name rather than
   * clamping it silently.
   *
   * Each is marked optional for exactly the reason {@link maxContextTokens}
   * is: Rust types them bare `usize` with serde defaults, so a read always
   * carries a number and `null` is not a value any of them can take. The
   * `?` is here only so a config round-tripped through stored session state
   * from a build predating these fields still satisfies the type. Seed a form
   * from `AI_AGENT_LIMITS.<field>.max` when one is absent, which is the
   * default that build's successor would have given it.
   *
   * Every `*Bytes` field counts UTF-8 bytes, not characters.
   */
  maxConversations?: number;
  maxMessagesPerConversation?: number;
  maxChatMessageBytes?: number;
  maxConversationBytes?: number;
  maxGlobalRetainedBytes?: number;
  maxTitleBytes?: number;
  maxPlanSteps?: number;
  maxRetainedPlans?: number;
}

/**
 * `ai_protocol_capabilities`: which advanced {@link AgentConfig} parameters
 * each wire protocol honours.
 *
 * The keys are {@link ProviderProtocol} values and the entries are camelCase
 * `AgentConfig` field names — the same spellings the renderer writes, so a
 * lookup needs no translation table. The map is the **only** authority on this
 * question: a frontend list of "OpenAI has no topK" would drift the first time
 * a protocol adapter gained a parameter, and the whole point of the command is
 * that the answer comes from the code that builds the request.
 *
 * Both halves are deliberately loose. A protocol the renderer does not know is
 * ignored rather than rejected, and a field name it does not render is ignored
 * too, so a backend that adds either does not have to ship with a matching
 * renderer. What a reader may **not** do is treat a missing entry as "honoured"
 * — see `aiParameterApplicability`.
 */
export type AiProtocolCapabilities = Partial<
  Record<ProviderProtocol, readonly string[]>
>;

// ─── Permissions ───────────────────────────────────────────────────────────

/**
 * How the agent treats a tool that has no explicit per-tool override.
 *
 * `readOnly` runs read-only tools and **denies** everything else outright — it
 * does not prompt. `ask` runs reads and prompts for writes. `autonomous` runs
 * everything. Enforcement is server-side; see `resolveAiToolPermission` for the
 * order these rules apply in.
 */
export type AiPermissionMode = "readOnly" | "ask" | "autonomous";

/** The decision for one tool: run it, prompt first, or refuse. */
export type AiToolPermission = "allow" | "ask" | "deny";

/** Whether a tool only reads, or can change something. */
export type AiToolClassification = "read" | "write";

/**
 * One tool as the backend describes it.
 *
 * `permission` is the **effective** resolved value, not the override — a tool
 * with no override still reports whatever the mode produced for it.
 */
export interface AiToolDescriptor {
  name: string;
  classification: AiToolClassification;
  description: string;
  permission: AiToolPermission;
}

/** The stored policy: a mode plus the explicit per-tool overrides only. */
export interface AiPermissions {
  mode: AiPermissionMode;
  tools: Record<string, AiToolPermission>;
}

/**
 * What the assistant can actually dispatch right now.
 *
 * Rust's `ToolAvailability` (`bc-ai-tools/src/permissions.rs`), carried on the
 * permissions view verbatim. The renderer cannot work these numbers out for
 * itself: the catalog describes the assistant's *own* policy, while a dispatch
 * is gated on that policy **and** on the application's canonical MCP grants,
 * which no `ai_*` command exposes. Anything the UI says about whether tool use
 * is possible has to come from here rather than from counting catalog rows.
 */
export interface AiToolAvailability {
  /**
   * Whether any tool at all passes both layers. `false` means the agent loop
   * advertises no tools, so the model is offered none and simply chats.
   */
  dispatchAvailable: boolean;
  /** Registered tools the application's MCP grants currently cover. */
  grantedToolCount: number;
  /**
   * Registered tools that pass both layers — MCP-granted and not denied by the
   * assistant's policy. Never larger than `grantedToolCount`.
   */
  usableToolCount: number;
  /** Every tool in the MCP catalogue, so a UI can say "3 of 48". */
  registeredToolCount: number;
}

/**
 * `ai_get_permissions`: the stored policy, the catalog it resolves over, and
 * what that resolution plus the MCP grants actually leaves usable.
 */
export interface AiPermissionsSnapshot extends AiPermissions {
  catalog: AiToolDescriptor[];
  availability: AiToolAvailability;
}

// ─── Personas ──────────────────────────────────────────────────────────────

/** A named system prompt. Builtins are immutable. */
export interface AiPersona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  builtin: boolean;
}

/** The writable half of a persona — what create and update accept. */
export interface AiPersonaInput {
  name: string;
  description: string;
  systemPrompt: string;
}

/** Events emitted by the agent during execution. */
export type AgentEvent =
  | {
      type: "textDelta";
      conversationId: string;
      messageId: string;
      text: string;
    }
  | {
      type: "toolCallStart";
      conversationId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "toolApprovalRequired";
      conversationId: string;
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      reason: string;
    }
  | {
      type: "toolCallComplete";
      conversationId: string;
      toolCallId: string;
      toolName: string;
      result: string;
      isError: boolean;
    }
  | {
      type: "usageUpdate";
      conversationId: string;
      usage: Usage;
    }
  | {
      type: "turnComplete";
      conversationId: string;
      messageId: string;
    }
  | {
      type: "error";
      conversationId: string;
      error: string;
    }
  | {
      type: "cancelled";
      conversationId: string;
    };

// ─── Plans ─────────────────────────────────────────────────────────────────
//
// Mirrors `bc-ai-agent/src/plan.rs`. The division of labour there is enforced
// by the Rust types and is the reason this section exists at all: the model
// proposes steps and can express no status, the user approves and runs through
// the `ai_*_plan` commands, and the harness executes through the same tool
// gate every other call goes through.
//
// **There are no plan events.** `AgentEvent` belongs to a generation turn and
// a plan command has no turn to attach to, so every command answers with the
// authoritative plan and the renderer shows what came back. The one exception
// is `ai_approve_tool_call`, which resolves with nothing; re-read with
// `ai_get_plan` after it.

/**
 * Which of the two permission layers refused something, and therefore which
 * screen the user has to go and change.
 *
 * Rust `RefusalSource` (`bc-ai-tools/src/permissions.rs`). The layers compose
 * as an intersection, so a refusal can come from either, and they are
 * configured in different places:
 *
 * - `assistantPolicy` — the assistant's own mode and per-tool overrides, in
 *   the assistant's **Tools & permissions** settings section.
 * - `mcpGrants` — the application's canonical MCP tool grants, in **Session
 *   settings → MCP**. No `ai_*` command can change these.
 *
 * Collapsing the two into "blocked" would leave a user with nothing to act
 * on, which is why this is carried all the way to the UI.
 */
export type AiRefusalSource = "assistantPolicy" | "mcpGrants";

/**
 * Where one step has got to.
 *
 * `blocked` and `awaitingApproval` are the two that stop a run, and they are
 * different things: `blocked` means a permission layer refuses the tool and
 * nothing was dispatched, `awaitingApproval` means it resolved to `ask` and
 * the user has to approve it. `skipped` is not a failure — it is a step that
 * names no tool, so there was never anything for the harness to run.
 */
export type AiPlanStepStatus =
  | "pending"
  | "blocked"
  | "awaitingApproval"
  | "running"
  | "done"
  | "skipped"
  | "failed";

/** Which permission layer refuses a step, and the reason it gave. */
export interface AiPlanStepRefusal {
  source: AiRefusalSource;
  reason: string;
}

/**
 * One step of a plan.
 *
 * `id`, `index`, `status`, `result` and `refusal` are written by the harness;
 * the model supplies only `title`, `detail`, `tool` and `arguments`. A step
 * with no `tool` is the user's own to carry out.
 */
export interface AiPlanStep {
  id: string;
  /** Position in the plan, **zero-based**. Steps run in this order. */
  index: number;
  title: string;
  detail: string;
  tool?: string | null;
  arguments?: Record<string, unknown> | null;
  status: AiPlanStepStatus;
  /** Bounded excerpt of the outcome: output, failure, or why approval is asked. */
  result?: string | null;
  refusal?: AiPlanStepRefusal | null;
}

/**
 * Where the plan as a whole has got to.
 *
 * `draft` is the one that must not look runnable: nothing can run until the
 * user approves it, and `ai_run_plan`/`ai_run_plan_step` refuse a draft
 * outright.
 */
export type AiPlanStatus =
  "draft" | "approved" | "running" | "paused" | "done" | "failed" | "cancelled";

/** A plan: one per conversation, held in memory and lost on restart. */
export interface AiPlan {
  id: string;
  conversationId: string;
  title: string;
  status: AiPlanStatus;
  steps: AiPlanStep[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Prefix of the tool-call id a plan step is approved under.
 *
 * `bc_ai_agent::plan::PLAN_STEP_TOOL_CALL_PREFIX`. A step that resolves to
 * `ask` is approved through the **existing** `ai_approve_tool_call` command,
 * which recognises this prefix and routes the approval to the step rather than
 * to a pending tool call in the transcript — there is no second approval
 * command. See `planStepToolCallId`, which is the only thing that should build
 * one of these.
 */
export const AI_PLAN_STEP_TOOL_CALL_PREFIX = "plan-step-";

// ─── Run summaries ─────────────────────────────────────────────────────────

/** How one tool call in a run came out. */
export type AiRunToolOutcome = "ok" | "failed" | "denied" | "notRun";

/** One tool the run dispatched, or tried to. */
export interface AiRunToolRun {
  tool: string;
  /** The step it belongs to, in the plan's own zero-based numbering. */
  stepIndex: number;
  outcome: AiRunToolOutcome;
}

/** One refusal the run hit, with the layer that produced it. */
export interface AiRunRefusal {
  tool: string;
  source: AiRefusalSource;
  reason: string;
}

/** How many steps ended in each state. */
export interface AiRunStepTotals {
  done: number;
  blocked: number;
  failed: number;
  skipped: number;
  pending: number;
}

/**
 * What a finished run did, as `ai_get_run_summary` reports it.
 *
 * **The fields are not all the same kind of claim, and a UI must not render
 * them as though they were.** Everything but {@link narrative} is derived by
 * the harness from what it actually dispatched: the totals, the tool list, the
 * refusals and the two mutation fields are the record. {@link narrative} is
 * prose written by the model, which did not execute anything and cannot
 * observe the gate — so a recap of a change that never happened is a thing it
 * can produce, and presenting the two together as one block is what would make
 * that read as fact.
 *
 * {@link mutatingToolsRun} and {@link anyChangeAttempted} are the answer to
 * "what did you just change in my account", which is why they lead.
 */
export interface AiRunSummary {
  /**
   * The plan this run belongs to.
   *
   * Nothing in the UI may be keyed off this being present: the harness is
   * being extended to account for tool calls the model makes outside a plan,
   * and this becomes `null` for those. Treat it as an identifier to carry, not
   * as evidence that a plan exists.
   */
  planId: string | null;
  /**
   * The plan's label, as the model proposed it.
   *
   * A caption, not a claim: nothing about what happened is read from it. It
   * is the one string here the model chose, and it is bounded and
   * control-character-free like every other plan string.
   */
  title: string;
  /**
   * When the user approved the plan — or when the first step settled, if the
   * record had to be opened without an approval to observe. Never `null`: a
   * record only exists once there is a run to record.
   */
  startedAt: string;
  /**
   * When the run reached `done`, `failed` or `cancelled`. `null` while the
   * plan is still approved, running or paused.
   */
  finishedAt: string | null;
  stepTotals: AiRunStepTotals;
  /** One entry per recorded step that named a tool, in plan order. */
  toolRuns: AiRunToolRun[];
  refusals: AiRunRefusal[];
  /**
   * Write tools the harness **dispatched**, deduplicated, in plan order.
   *
   * Dispatched, not succeeded: a write that returned an error can still have
   * landed, so omitting it would be the dangerous direction to be wrong in. A
   * tool a permission layer refused never left the harness and is absent.
   * "Write" is the MCP registry's own effect tier, never guessed from a name.
   */
  mutatingToolsRun: string[];
  /**
   * Whether anything could have changed: a write tool was dispatched, or one
   * is still in flight.
   *
   * The in-flight half is why this is not `mutatingToolsRun.length > 0`.
   * Cancelling a plan does not abort a call already in flight, so there is a
   * window with a write outstanding and no outcome recorded, and answering
   * "no" in it would be a false all-clear.
   */
  anyChangeAttempted: boolean;
  /**
   * Model-written prose. **Derived from nothing** — no field above reads it,
   * and the model can write no field above.
   *
   * An explicit `null`, never an absent key: serde puts no
   * `skip_serializing_if` on it, nor on {@link finishedAt}. It is also
   * **dropped whenever another step settles**, because prose written before
   * the latest outcome describes a run that has moved on — so it must not be
   * cached across a re-read.
   */
  narrative: string | null;
}

// ─── Links ─────────────────────────────────────────────────────────────────

/**
 * What kind of place a link points at, and therefore how `target` reads.
 *
 * Mirrors Rust `AiLinkKind` (`bc-ai-agent/src/links.rs`). There is
 * deliberately no "some other string" kind:
 *
 * - `zone` is an **opaque id** — letters, digits, `-` and `_` only, 1-64
 *   bytes, so it cannot express a path, a scheme or an escape.
 * - `record` is `"<zoneId>/<recordId>"`: two such ids joined by exactly one
 *   `/`, which is the only structural byte admitted and only in that one
 *   position. Each half is bounded separately, so the whole target can be 129
 *   bytes.
 * - `zoneTab` is `"<zoneId>/<tab>"`, parsed the same way, except that the tab
 *   half is checked against a **closed set** of view names rather than a
 *   charset. `domain-registry` is one of these and `registry` is a
 *   `workspace`; they are different screens, and the two sets are disjoint.
 * - `domainRegistry` is a bare hostname, normalised and validated by the same
 *   function `dns_check_registration` validates its argument with.
 * - `workspace` is one of the app's own workspace ids, from a closed set.
 * - `external` is an absolute `https:` URL with no credentials.
 *
 * That backend validation is necessary and **not sufficient** on the
 * renderer's side: see `resolveAiLink`, which re-checks every target against
 * the same closed sets before it reaches a navigation call, so a backend
 * change cannot turn into a renderer navigation bug.
 */
export type AiLinkKind =
  "zone" | "record" | "zoneTab" | "domainRegistry" | "workspace" | "external";

/**
 * A place the assistant is pointing at, read with `ai_get_links`.
 *
 * Links belong to the **conversation**, not to a plan, a step or a run: the
 * model offers a set through its own `link_offer` tool and each offer replaces
 * the last, so an offer is "where to look now" rather than a growing list.
 *
 * `label` is model-written display text. `target` is validated per
 * {@link AiLinkKind} and must still go through `resolveAiLink` before it is
 * used for anything.
 */
export interface AiLink {
  kind: AiLinkKind;
  label: string;
  target: string;
}

// ─── Presets ───────────────────────────────────────────────────────────────

/** A named agent persona preset. */
export interface Preset {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

// ─── Command errors ────────────────────────────────────────────────────────

/**
 * Optional detail bag on {@link AiCommandError}.
 *
 * Mirrors Rust `AiCommandErrorDetails` (`src-tauri/src/ai_commands.rs:37-53`).
 * Every field is `skip_serializing_if = "Option::is_none"`, so an absent field
 * means "not applicable", never "unknown".
 */
export interface AiCommandErrorDetails {
  kind?: string;
  /** Upstream HTTP status, when the failure came from a provider call. */
  status?: number;
  /** The offending input field, for validation failures. */
  field?: string;
  resource?: string;
  /** The ceiling that was exceeded, paired with {@link actual}. */
  limit?: number;
  actual?: number;
  /** Operator-facing next step. Render this alongside `message`. */
  remediation?: string;
}

/**
 * Structured failure returned by every fallible AI Tauri command.
 *
 * Mirrors Rust `AiCommandError` (`src-tauri/src/ai_commands.rs:26-35`). The
 * message is passed through `sanitize_error_text`, so it is safe to display;
 * it never carries an API key. Render `message` plus `details.remediation`,
 * and offer a retry only when `retryable` is true.
 */
export interface AiCommandError {
  /** Stable screaming-snake identifier, e.g. `AI_NOT_CONFIGURED`. */
  code: string;
  message: string;
  /** Which layer failed, e.g. `provider`, `chat`, `agent`. */
  source: string;
  /** The command that failed, e.g. `ai:configure_provider`. */
  operation: string;
  retryable: boolean;
  details: AiCommandErrorDetails;
}

/**
 * Narrow an unknown rejection to an {@link AiCommandError}.
 *
 * Tauri rejects with the serialized error value itself, so a failed AI command
 * surfaces as a plain object rather than an `Error` instance.
 */
export function isAiCommandError(value: unknown): value is AiCommandError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AiCommandError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.operation === "string" &&
    typeof candidate.retryable === "boolean" &&
    typeof candidate.details === "object" &&
    candidate.details !== null
  );
}
