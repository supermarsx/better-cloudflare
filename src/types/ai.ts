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
