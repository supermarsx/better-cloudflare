//! Unified LLM provider abstraction.
//!
//! Provides a common [`AiProvider`] trait implemented for three wire
//! protocols — see [`ProviderProtocol`]:
//! - **OpenAI** (GPT-4o, o1, etc.) — and every OpenAI-compatible endpoint
//!   (Groq, Together AI, vLLM, …), reached by setting a base URL
//! - **Anthropic** (Claude 4 Opus, Sonnet, etc.)
//! - **Ollama** (local models via `localhost:11434`)
//!
//! A protocol selects a client; a [`ProviderProfile`] is the user-defined
//! *identity* that chooses one, so an install can hold several connections per
//! protocol without one evicting another.
//!
//! All providers support both one-shot and streaming completions, tool/function
//! calling, and model listing.

pub mod config;
pub mod error;
pub mod limits;
pub mod profile;
pub mod sampling;
pub mod traits;
pub mod types;

pub mod anthropic;
pub mod ollama;
pub mod openai;

pub use config::{ProviderConfig, ProviderProtocol};
pub use error::AiProviderError;
pub use profile::{
    validate_base_url, validate_provider_id, AiProviderProfile, AiProviderProfileInput,
    ProviderProfile, MAX_PROVIDER_ID_BYTES, MAX_PROVIDER_LABEL_BYTES, MAX_PROVIDER_PROFILES,
};
pub use sampling::{honoured_fields, honours, protocol_capabilities, AdvancedField};
pub use traits::AiProvider;
pub use types::*;
