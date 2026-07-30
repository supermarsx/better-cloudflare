//! Provider configuration and enumeration.

use serde::{Deserialize, Serialize};

use crate::error::AiProviderError;
use crate::limits::{
    validate_string, MAX_API_KEY_BYTES, MAX_BASE_URL_BYTES, MAX_COMPLETION_TOKENS, MAX_MODEL_BYTES,
};

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
        self.base_url
            .as_deref()
            .unwrap_or(self.kind.default_base_url())
    }

    /// Validate all user-controlled configuration before constructing a client.
    pub fn validate(&self) -> Result<(), AiProviderError> {
        if self.model.is_empty() {
            return Err(AiProviderError::InvalidRequest {
                field: "model",
                message: "must not be empty".into(),
            });
        }
        validate_string("provider model", &self.model, MAX_MODEL_BYTES)?;
        if let Some(api_key) = &self.api_key {
            validate_string("provider API key", api_key, MAX_API_KEY_BYTES)?;
        }
        if let Some(base_url) = &self.base_url {
            validate_string("provider base URL", base_url, MAX_BASE_URL_BYTES)?;
            let parsed =
                reqwest::Url::parse(base_url).map_err(|error| AiProviderError::InvalidRequest {
                    field: "baseUrl",
                    message: error.to_string(),
                })?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(AiProviderError::InvalidRequest {
                    field: "baseUrl",
                    message: "scheme must be http or https".into(),
                });
            }
        }
        if !self.temperature.is_finite() || !(0.0..=2.0).contains(&self.temperature) {
            return Err(AiProviderError::InvalidRequest {
                field: "temperature",
                message: "must be finite and between 0 and 2".into(),
            });
        }
        if self.max_tokens == 0 || self.max_tokens > MAX_COMPLETION_TOKENS {
            return Err(AiProviderError::InvalidRequest {
                field: "maxTokens",
                message: format!("must be between 1 and {MAX_COMPLETION_TOKENS}"),
            });
        }
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_exact_string_boundary_and_numeric_limits() {
        let mut config = ProviderConfig {
            kind: ProviderKind::Ollama,
            api_key: None,
            base_url: Some("http://localhost:11434".into()),
            model: "m".repeat(MAX_MODEL_BYTES),
            temperature: 2.0,
            max_tokens: MAX_COMPLETION_TOKENS,
        };
        config.validate().expect("exact limits are valid");

        config.model.push('x');
        assert!(matches!(
            config.validate(),
            Err(AiProviderError::LimitExceeded {
                resource: "provider model",
                ..
            })
        ));

        config.model = "model".into();
        config.temperature = f32::NAN;
        assert!(matches!(
            config.validate(),
            Err(AiProviderError::InvalidRequest {
                field: "temperature",
                ..
            })
        ));
    }
}
