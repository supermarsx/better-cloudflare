//! Provider configuration and enumeration.

use serde::{Deserialize, Serialize};

/// Supported LLM provider backends.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    OpenAi,
    Anthropic,
    Ollama,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Ollama => "ollama",
        }
    }

    /// Default base URL for this provider.
    pub fn default_base_url(&self) -> &'static str {
        match self {
            Self::OpenAi => "https://api.openai.com/v1",
            Self::Anthropic => "https://api.anthropic.com/v1",
            Self::Ollama => "http://localhost:11434",
        }
    }

    /// Default model for this provider.
    pub fn default_model(&self) -> &'static str {
        match self {
            Self::OpenAi => "gpt-4o",
            Self::Anthropic => "claude-sonnet-4-20250514",
            Self::Ollama => "llama3",
        }
    }

    /// Whether this provider requires an API key.
    pub fn requires_api_key(&self) -> bool {
        match self {
            Self::OpenAi | Self::Anthropic => true,
            Self::Ollama => false,
        }
    }
}

impl std::fmt::Display for ProviderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Configuration for connecting to an AI provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// Which provider backend to use.
    pub kind: ProviderKind,
    /// API key (stored securely via biometric keychain in production).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Base URL override (for proxies or OpenAI-compatible endpoints).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Default model to use.
    pub model: String,
    /// Default temperature (0.0–2.0).
    pub temperature: f32,
    /// Default max tokens per response.
    pub max_tokens: u32,
}

impl ProviderConfig {
    /// Effective base URL (custom or provider default).
    pub fn effective_base_url(&self) -> &str {
        self.base_url.as_deref().unwrap_or(self.kind.default_base_url())
    }
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            kind: ProviderKind::Anthropic,
            api_key: None,
            base_url: None,
            model: ProviderKind::Anthropic.default_model().to_string(),
            temperature: 0.7,
            max_tokens: 4096,
        }
    }
}
