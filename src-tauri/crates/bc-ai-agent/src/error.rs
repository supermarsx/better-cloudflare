//! Structured agent orchestration errors.

use bc_ai_chat::ChatError;
use bc_ai_provider::AiProviderError;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error(transparent)]
    Provider(#[from] AiProviderError),

    #[error(transparent)]
    Chat(#[from] ChatError),

    #[error("invalid agent configuration field {field}: {message}")]
    InvalidConfig {
        field: &'static str,
        message: String,
    },

    #[error("conversation disposed while generation was active: {0}")]
    ConversationDisposed(Uuid),

    #[error("generation cancelled")]
    Cancelled,

    #[error("agent event consumer dropped")]
    ConsumerDropped,

    #[error("maximum tool rounds exceeded: {0}")]
    ToolRoundLimit(u32),

    #[error("tool output exceeded limit of {limit} bytes (actual: {actual})")]
    ToolOutputLimit { limit: usize, actual: usize },
}

impl serde::Serialize for AgentError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
