//! Error types for AI provider operations.

use thiserror::Error;

/// Errors that can occur during AI provider operations.
#[derive(Debug, Error)]
pub enum AiProviderError {
    /// Network or HTTP error communicating with the provider.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// The provider returned an API-level error (non-2xx with body).
    #[error("API error ({status}): {message}")]
    Api {
        status: u16,
        message: String,
        provider_code: Option<String>,
    },

    /// Failed to parse the provider response.
    #[error("Response parse error: {0}")]
    Parse(String),

    /// The requested model is not available.
    #[error("Model not found: {0}")]
    ModelNotFound(String),

    /// Authentication failed (invalid or missing API key).
    #[error("Authentication failed: {0}")]
    AuthFailed(String),

    /// Rate limited by the provider.
    #[error("Rate limited: retry after {retry_after_ms:?}ms")]
    RateLimited { retry_after_ms: Option<u64> },

    /// The provider is not configured (missing API key / base URL).
    #[error("Provider not configured: {0}")]
    NotConfigured(String),

    /// Streaming channel closed unexpectedly.
    #[error("Stream closed: {0}")]
    StreamClosed(String),

    /// Request was cancelled.
    #[error("Request cancelled")]
    Cancelled,

    /// Token limit exceeded.
    #[error("Token limit exceeded: {0}")]
    TokenLimitExceeded(String),

    /// Catch-all for other errors.
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for AiProviderError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<AiProviderError> for String {
    fn from(e: AiProviderError) -> Self {
        e.to_string()
    }
}
