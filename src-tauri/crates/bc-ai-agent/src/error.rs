//! Structured agent orchestration errors.

use bc_ai_chat::ChatError;
use bc_ai_provider::AiProviderError;
use bc_ai_tools::ToolExecutionError;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error(transparent)]
    Provider(#[from] AiProviderError),

    #[error(transparent)]
    Chat(#[from] ChatError),

    #[error(transparent)]
    Tool(#[from] ToolExecutionError),

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

    #[error("pending tool call was not found")]
    ToolCallNotFound,

    #[error("approved tool call unexpectedly requested approval again")]
    UnexpectedApproval,

    #[error("AI subsystem state is unavailable")]
    StateUnavailable,

    #[error("{operation} timed out")]
    OperationTimedOut { operation: &'static str },
}

impl AgentError {
    /// Secret-safe summary suitable for UI events. Structured command errors
    /// retain richer bounded fields at the Tauri boundary.
    pub fn public_message(&self) -> String {
        match self {
            Self::Provider(bc_ai_provider::AiProviderError::Api { status, .. }) => {
                format!("The AI provider rejected the request (HTTP {status}).")
            }
            Self::Provider(bc_ai_provider::AiProviderError::AuthFailed(_)) => {
                "AI provider authentication failed.".into()
            }
            Self::Provider(bc_ai_provider::AiProviderError::RateLimited { .. }) => {
                "The AI provider rate-limited the request.".into()
            }
            Self::Provider(bc_ai_provider::AiProviderError::Http(error)) if error.is_timeout() => {
                "The AI provider request timed out.".into()
            }
            Self::Provider(bc_ai_provider::AiProviderError::Http(_)) => {
                "The AI provider could not be reached.".into()
            }
            Self::Provider(bc_ai_provider::AiProviderError::Parse(_)) => {
                "The AI provider returned an invalid response.".into()
            }
            Self::Provider(bc_ai_provider::AiProviderError::LimitExceeded {
                resource,
                limit,
                actual,
            }) => format!("{resource} exceeded limit {limit} (actual: {actual})."),
            Self::Provider(bc_ai_provider::AiProviderError::InvalidRequest { field, .. }) => {
                format!("Invalid AI request field: {field}.")
            }
            Self::Provider(bc_ai_provider::AiProviderError::Cancelled) | Self::Cancelled => {
                "AI generation was cancelled.".into()
            }
            Self::Provider(_) => "The AI provider request failed.".into(),
            Self::Chat(bc_ai_chat::ChatError::LimitExceeded {
                resource,
                limit,
                actual,
            }) => format!("{resource} exceeded limit {limit} (actual: {actual})."),
            Self::Chat(bc_ai_chat::ChatError::ConversationNotFound(_)) => {
                "The AI conversation no longer exists.".into()
            }
            Self::Chat(bc_ai_chat::ChatError::InvalidField { field, .. }) => {
                format!("Invalid AI conversation field: {field}.")
            }
            Self::Tool(bc_ai_tools::ToolExecutionError::LimitExceeded {
                resource,
                limit,
                actual,
            }) => format!("{resource} exceeded limit {limit} (actual: {actual})."),
            Self::Tool(_) => "The AI tool call was rejected by local safety checks.".into(),
            Self::InvalidConfig { field, .. } => {
                format!("Invalid AI agent configuration field: {field}.")
            }
            Self::ConversationDisposed(_) => "The AI conversation was closed.".into(),
            Self::ConsumerDropped => "The AI event consumer disconnected.".into(),
            Self::ToolRoundLimit(limit) => {
                format!("The AI turn reached its tool-round limit ({limit}).")
            }
            Self::ToolOutputLimit { limit, actual } => {
                format!("Tool output exceeded limit {limit} (actual: {actual}).")
            }
            Self::ToolCallNotFound => "The pending AI tool call no longer exists.".into(),
            Self::UnexpectedApproval => "The approved AI tool call could not be executed.".into(),
            Self::StateUnavailable => "The AI subsystem is temporarily unavailable.".into(),
            Self::OperationTimedOut { operation } => format!("{operation} timed out."),
        }
    }
}

impl serde::Serialize for AgentError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_server_details_do_not_cross_event_or_retained_status_boundaries() {
        let error = AgentError::Provider(bc_ai_provider::AiProviderError::Api {
            status: 401,
            message: "Authorization: Bearer super-secret token=also-secret".into(),
            provider_code: Some("secret-code".into()),
        });
        let public = error.public_message();
        assert_eq!(public, "The AI provider rejected the request (HTTP 401).");
        assert!(!public.contains("super-secret"));
        assert!(!public.contains("also-secret"));
        assert!(!public.contains("secret-code"));
    }
}
