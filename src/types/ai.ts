/**
 * TypeScript types for the AI assistant subsystem.
 *
 * These mirror the Rust types in `bc-ai-provider`, `bc-ai-chat`,
 * `bc-ai-tools`, and `bc-ai-agent`.
 */

// ─── Provider Types ────────────────────────────────────────────────────────

/** Supported LLM provider kinds. */
export type ProviderKind = "openAi" | "anthropic" | "ollama";

/** Configuration for a provider connection. */
export interface ProviderConfig {
  kind: ProviderKind;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  orgId?: string;
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
  | { type: "toolResult"; toolCallId: string; content: string; isError: boolean };

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
