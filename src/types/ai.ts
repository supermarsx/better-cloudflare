/**
 * TypeScript types for the AI assistant subsystem.
 *
 * These mirror the Rust types in `bc-ai-provider`, `bc-ai-chat`,
 * `bc-ai-tools`, and `bc-ai-agent`.
 */

// ─── Provider Types ────────────────────────────────────────────────────────

/**
 * Supported LLM provider kinds.
 *
 * Rust is `#[serde(rename_all = "lowercase")]` on `ProviderKind`
 * (`bc-ai-provider/src/config.rs:11-17`), so `OpenAi` is `"openai"` on the
 * wire — not `"openAi"`. Five of the seventeen commands take a `kind` (or a
 * `provider`) and reject any other spelling at deserialization time.
 */
export type ProviderKind = "openai" | "anthropic" | "ollama";

/** Every provider kind, in the order the backend enumerates them. */
export const PROVIDER_KINDS: readonly ProviderKind[] = [
  "openai",
  "anthropic",
  "ollama",
] as const;

/**
 * Configuration for a provider connection.
 *
 * Mirrors Rust `ProviderConfig` (`bc-ai-provider/src/config.rs:62-79`).
 * `model`, `temperature` and `maxTokens` are **required** — they are plain
 * fields with no `Option` and no `#[serde(default)]`, so omitting any of them
 * fails `ai_configure_provider` before it reaches validation. There is no
 * `orgId` field on the Rust side.
 */
export interface ProviderConfig {
  kind: ProviderKind;
  /** Omitted entirely for providers that need no key (Ollama). Never echoed back by any command. */
  apiKey?: string;
  /** Overrides `ProviderKind::default_base_url`; must be http(s). */
  baseUrl?: string;
  model: string;
  /** 0.0–2.0. */
  temperature: number;
  /** Bounded by `MAX_COMPLETION_TOKENS`. */
  maxTokens: number;
}

/** Provider availability status. */
export interface ProviderStatus {
  kind: ProviderKind;
  configured: boolean;
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

/** Lightweight conversation metadata for listing. */
export interface ConversationMeta {
  id: string;
  title: string;
  provider: ProviderKind;
  model: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Full conversation with all messages. */
export interface Conversation {
  id: string;
  title: string;
  provider: ProviderKind;
  model: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

// ─── Agent Types ───────────────────────────────────────────────────────────

/** Configuration for the AI agent loop. */
export interface AgentConfig {
  maxToolRounds: number;
  maxTokensPerTurn: number;
  toolsEnabled: boolean;
  stream: boolean;
  preset: string;
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
