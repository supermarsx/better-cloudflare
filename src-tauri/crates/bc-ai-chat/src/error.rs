//! Structured chat retention and lifecycle errors.

use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum ChatError {
    #[error("conversation not found: {0}")]
    ConversationNotFound(Uuid),

    #[error("{resource} exceeded limit of {limit} bytes/items (actual: {actual})")]
    LimitExceeded {
        resource: &'static str,
        limit: usize,
        actual: usize,
    },

    #[error("invalid conversation field {field}: {message}")]
    InvalidField {
        field: &'static str,
        message: String,
    },
}

impl serde::Serialize for ChatError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
