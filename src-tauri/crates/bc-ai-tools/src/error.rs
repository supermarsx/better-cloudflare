//! Structured failures raised before or after AI tool dispatch.

use thiserror::Error;

#[derive(Debug, Clone, Error)]
pub enum ToolExecutionError {
    #[error("{resource} exceeded limit of {limit} bytes/items (actual: {actual})")]
    LimitExceeded {
        resource: &'static str,
        limit: usize,
        actual: usize,
    },

    #[error("invalid tool-call field {field}: {message}")]
    InvalidInput {
        field: &'static str,
        message: &'static str,
    },

    #[error("tool result could not be serialized safely")]
    Serialization,
}

impl serde::Serialize for ToolExecutionError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
