//! The [`AiProvider`] trait — core abstraction for LLM backends.

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::error::AiProviderError;
use crate::types::{CompletionRequest, CompletionResponse, Model, StreamDelta};

/// A backend that can produce LLM completions.
///
/// Implementations exist for OpenAI-compatible APIs, Anthropic, and Ollama.
/// All methods are async and take `&self` so providers can be shared behind
/// an `Arc`.
#[async_trait]
pub trait AiProvider: Send + Sync {
    /// Return the provider kind identifier (e.g. "openai", "anthropic", "ollama").
    fn kind(&self) -> &str;

    /// One-shot completion — sends the request and returns the full response.
    async fn complete(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, AiProviderError>;

    /// Streaming completion — sends deltas through the channel as they arrive.
    ///
    /// The final [`CompletionResponse`] is returned when the stream completes,
    /// containing the fully-assembled message and usage stats.
    async fn stream(
        &self,
        request: CompletionRequest,
        tx: mpsc::Sender<StreamDelta>,
    ) -> Result<CompletionResponse, AiProviderError>;

    /// List models available from this provider.
    async fn list_models(&self) -> Result<Vec<Model>, AiProviderError>;

    /// Verify connectivity and authentication.
    async fn health_check(&self) -> Result<(), AiProviderError>;
}
