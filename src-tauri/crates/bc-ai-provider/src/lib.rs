//! Unified LLM provider abstraction.
//!
//! Provides a common [`AiProvider`] trait implemented for multiple backends:
//! - **OpenAI** (GPT-4o, o1, etc.) — also compatible with OpenAI-compatible APIs
//! - **Anthropic** (Claude 4 Opus, Sonnet, etc.)
//! - **Ollama** (local models via `localhost:11434`)
//!
//! All providers support both one-shot and streaming completions, tool/function
//! calling, and model listing.

pub mod config;
pub mod error;
pub mod traits;
pub mod types;

pub mod anthropic;
pub mod ollama;
pub mod openai;

pub use config::{ProviderConfig, ProviderKind};
pub use error::AiProviderError;
pub use traits::AiProvider;
pub use types::*;
