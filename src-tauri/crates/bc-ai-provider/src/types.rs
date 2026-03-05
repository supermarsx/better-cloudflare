//! Core types shared across all AI providers.

use serde::{Deserialize, Serialize};

// ─── Roles & Messages ──────────────────────────────────────────────────────

/// Message role in a conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// A single message in a conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: Role,
    pub content: MessageContent,
    /// Tool call ID this message is responding to (for Role::Tool messages).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Message content — text, tool calls, or a combination.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MessageContent {
    /// Plain text content.
    Text { text: String },
    /// One or more tool invocations requested by the assistant.
    ToolUse { tool_calls: Vec<ToolCall> },
    /// Result of a tool invocation.
    ToolResult {
        tool_call_id: String,
        content: String,
        is_error: bool,
    },
}

impl MessageContent {
    /// Create a text content variant.
    pub fn text(t: impl Into<String>) -> Self {
        Self::Text { text: t.into() }
    }

    /// Extract text content, returning empty string for non-text variants.
    pub fn as_text(&self) -> &str {
        match self {
            Self::Text { text } => text,
            _ => "",
        }
    }
}

impl Message {
    /// Convenience: create a user text message.
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: MessageContent::text(text),
            tool_call_id: None,
        }
    }

    /// Convenience: create an assistant text message.
    pub fn assistant(text: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: MessageContent::text(text),
            tool_call_id: None,
        }
    }

    /// Convenience: create a system message.
    pub fn system(text: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: MessageContent::text(text),
            tool_call_id: None,
        }
    }

    /// Convenience: create a tool result message.
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>, is_error: bool) -> Self {
        Self {
            role: Role::Tool,
            content: MessageContent::ToolResult {
                tool_call_id: tool_call_id.into(),
                content: content.into(),
                is_error,
            },
            tool_call_id: None,
        }
    }
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

/// A tool the model can invoke, with a JSON Schema for its input.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    /// Unique tool name (e.g. `cf_list_zones`).
    pub name: String,
    /// Human-readable description for the model.
    pub description: String,
    /// JSON Schema object describing the tool's input parameters.
    pub input_schema: serde_json::Value,
}

/// A tool invocation requested by the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    /// Provider-assigned call ID.
    pub id: String,
    /// Tool name to invoke.
    pub name: String,
    /// JSON arguments to pass to the tool.
    pub arguments: serde_json::Value,
}

/// Result of executing a tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub tool_call_id: String,
    pub content: String,
    pub is_error: bool,
}

// ─── Completion Request / Response ─────────────────────────────────────────

/// Request to an AI provider for a completion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    /// Model identifier (e.g. "gpt-4o", "claude-sonnet-4-20250514").
    pub model: String,
    /// Conversation messages.
    pub messages: Vec<Message>,
    /// Tools available for the model to call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
    /// Sampling temperature (0.0–2.0).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Maximum tokens to generate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// System prompt (some providers handle this separately).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
}

/// Response from a completion request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResponse {
    /// The assistant's response message.
    pub message: Message,
    /// Token usage statistics.
    pub usage: Option<Usage>,
    /// Model that produced the response.
    pub model: String,
    /// Provider-specific finish reason.
    pub finish_reason: Option<String>,
}

// ─── Streaming ─────────────────────────────────────────────────────────────

/// Incremental delta emitted during streaming.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamDelta {
    /// Incremental text content.
    Text { text: String },
    /// A tool call has started.
    ToolCallStart { id: String, name: String },
    /// Incremental JSON arguments for an in-progress tool call.
    ToolCallDelta { id: String, arguments: String },
    /// A tool call is complete and ready to execute.
    ToolCallEnd { id: String },
    /// Token usage (usually sent at stream end).
    Usage(Usage),
    /// Stream completed successfully.
    Done,
    /// Stream-level error.
    Error { message: String },
}

// ─── Usage & Models ────────────────────────────────────────────────────────

/// Token usage statistics for a completion.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// Description of an available model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// Model identifier to use in requests.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Maximum context window in tokens.
    pub context_window: Option<u32>,
    /// Whether this model supports tool/function calling.
    pub supports_tools: bool,
    /// Whether this model supports streaming.
    pub supports_streaming: bool,
}
