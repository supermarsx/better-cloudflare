//! Agent events emitted during execution.
//!
//! These events are forwarded to the frontend via Tauri's event system.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use bc_ai_provider::Usage;

/// Events emitted by the agent during a conversation turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
    UsageUpdate { conversation_id: Uuid, usage: Usage },
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
    Cancelled { conversation_id: Uuid },
}

impl AgentEvent {
    /// Get the conversation ID for any event variant.
    pub fn conversation_id(&self) -> Uuid {
        match self {
            Self::TextDelta {
                conversation_id, ..
            }
            | Self::ToolCallStart {
                conversation_id, ..
            }
            | Self::ToolApprovalRequired {
                conversation_id, ..
            }
            | Self::ToolCallComplete {
                conversation_id, ..
            }
            | Self::UsageUpdate {
                conversation_id, ..
            }
            | Self::TurnComplete {
                conversation_id, ..
            }
            | Self::Error {
                conversation_id, ..
            }
            | Self::Cancelled {
                conversation_id, ..
            } => *conversation_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rust field spellings that must never reach the wire.
    ///
    /// `#[serde(rename_all = "camelCase")]` on a tagged enum renames *variant tags
    /// only* — struct-variant fields keep their Rust names unless
    /// `rename_all_fields` is also set. Dropping that attribute would ship
    /// `conversation_id` again, and the frontend listener filters on
    /// `payload.conversationId`, so every agent event would be silently discarded.
    const FORBIDDEN_SNAKE_CASE_FIELDS: &[&str] = &[
        "conversation_id",
        "message_id",
        "tool_call_id",
        "tool_name",
        "is_error",
    ];

    fn assert_camel_case_wire(event: &AgentEvent) {
        let json = serde_json::to_string(event).expect("event serializes");
        for snake in FORBIDDEN_SNAKE_CASE_FIELDS {
            assert!(
                !json.contains(&format!("\"{snake}\"")),
                "event serialized the snake_case field `{snake}`: {json}"
            );
        }
        assert!(
            json.contains("\"conversationId\""),
            "every variant carries a conversation id: {json}"
        );
    }

    fn sample_events() -> Vec<AgentEvent> {
        let conversation_id = Uuid::nil();
        let message_id = Uuid::nil();
        vec![
            AgentEvent::TextDelta {
                conversation_id,
                message_id,
                text: "hello".into(),
            },
            AgentEvent::ToolCallStart {
                conversation_id,
                tool_call_id: "call-1".into(),
                tool_name: "cf_list_zones".into(),
            },
            AgentEvent::ToolApprovalRequired {
                conversation_id,
                tool_call_id: "call-1".into(),
                tool_name: "cf_delete_dns_record".into(),
                arguments: serde_json::json!({ "zone_id": "abc" }),
                reason: "destructive".into(),
            },
            AgentEvent::ToolCallComplete {
                conversation_id,
                tool_call_id: "call-1".into(),
                tool_name: "cf_list_zones".into(),
                result: "{}".into(),
                is_error: false,
            },
            AgentEvent::UsageUpdate {
                conversation_id,
                usage: Usage::default(),
            },
            AgentEvent::TurnComplete {
                conversation_id,
                message_id,
            },
            AgentEvent::Error {
                conversation_id,
                error: "boom".into(),
            },
            AgentEvent::Cancelled { conversation_id },
        ]
    }

    #[test]
    fn every_variant_serializes_fields_in_camel_case() {
        for event in sample_events() {
            assert_camel_case_wire(&event);
        }
    }

    #[test]
    fn text_delta_matches_the_frontend_contract() {
        let value = serde_json::to_value(AgentEvent::TextDelta {
            conversation_id: Uuid::nil(),
            message_id: Uuid::nil(),
            text: "hi".into(),
        })
        .expect("serializes");

        assert_eq!(value["type"], "textDelta");
        assert!(value.get("conversationId").is_some());
        assert!(value.get("messageId").is_some());
        assert!(
            value.get("conversation_id").is_none(),
            "snake_case field leaked: {value}"
        );
        assert!(
            value.get("message_id").is_none(),
            "snake_case field leaked: {value}"
        );
    }

    #[test]
    fn tool_call_complete_matches_the_frontend_contract() {
        let value = serde_json::to_value(AgentEvent::ToolCallComplete {
            conversation_id: Uuid::nil(),
            tool_call_id: "call-1".into(),
            tool_name: "cf_list_zones".into(),
            result: "{}".into(),
            is_error: true,
        })
        .expect("serializes");

        assert_eq!(value["type"], "toolCallComplete");
        assert_eq!(value["toolCallId"], "call-1");
        assert_eq!(value["toolName"], "cf_list_zones");
        assert_eq!(value["isError"], true);
        for snake in ["conversation_id", "tool_call_id", "tool_name", "is_error"] {
            assert!(
                value.get(snake).is_none(),
                "snake_case field `{snake}` leaked: {value}"
            );
        }
    }

    #[test]
    fn events_round_trip_through_the_camel_case_wire_format() {
        for event in sample_events() {
            let json = serde_json::to_string(&event).expect("serializes");
            let decoded: AgentEvent = serde_json::from_str(&json).expect("deserializes");
            assert_eq!(decoded.conversation_id(), event.conversation_id());
        }
    }
}
