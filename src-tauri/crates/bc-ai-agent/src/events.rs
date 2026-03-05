//! Agent events emitted during execution.
//!
//! These events are forwarded to the frontend via Tauri's event system.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use bc_ai_provider::Usage;

/// Events emitted by the agent during a conversation turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    /// Streaming text delta.
    TextDelta {
        conversation_id: Uuid,
        message_id: Uuid,
        text: String,
    },
    /// Tool call started.
    ToolCallStart {
        conversation_id: Uuid,
        tool_call_id: String,
        tool_name: String,
    },
    /// Tool call requires user approval.
    ToolApprovalRequired {
        conversation_id: Uuid,
        tool_call_id: String,
        tool_name: String,
        arguments: serde_json::Value,
        reason: String,
    },
    /// Tool call completed.
    ToolCallComplete {
        conversation_id: Uuid,
        tool_call_id: String,
        tool_name: String,
        result: String,
        is_error: bool,
    },
    /// Token usage update.
    UsageUpdate {
        conversation_id: Uuid,
        usage: Usage,
    },
    /// Agent turn completed.
    TurnComplete {
        conversation_id: Uuid,
        message_id: Uuid,
    },
    /// Agent encountered an error.
    Error {
        conversation_id: Uuid,
        error: String,
    },
    /// Generation was cancelled.
    Cancelled {
        conversation_id: Uuid,
    },
}

impl AgentEvent {
    /// Get the conversation ID for any event variant.
    pub fn conversation_id(&self) -> Uuid {
        match self {
            Self::TextDelta { conversation_id, .. }
            | Self::ToolCallStart { conversation_id, .. }
            | Self::ToolApprovalRequired { conversation_id, .. }
            | Self::ToolCallComplete { conversation_id, .. }
            | Self::UsageUpdate { conversation_id, .. }
            | Self::TurnComplete { conversation_id, .. }
            | Self::Error { conversation_id, .. }
            | Self::Cancelled { conversation_id, .. } => *conversation_id,
        }
    }
}
