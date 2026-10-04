//! Wire protocol selection and the per-connection client configuration.

use serde::{Deserialize, Serialize};

use crate::error::AiProviderError;
use crate::limits::{
    validate_string, MAX_API_KEY_BYTES, MAX_BASE_URL_BYTES, MAX_COMPLETION_TOKENS, MAX_MODEL_BYTES,
    MAX_TEMPERATURE, MIN_TEMPERATURE,
};

/// The wire protocol a provider speaks.
///
/// This is a closed set because it selects a client implementation, not a
/// vendor: any OpenAI-compatible endpoint (Groq, Together AI, vLLM, LM Studio,
/// a local proxy) is reached with [`Self::OpenAi`] and its own base URL.
/// Provider *identity* is the user-defined id on
/// [`crate::profile::ProviderProfile`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderProtocol {
    OpenAi,
    Anthropic,
    Ollama,
}

impl ProviderProtocol {
    /// Every protocol, in the order the renderer lists them.
    ///
    /// Anything that must answer "for each protocol" — the advanced-control
    /// capability list above all — iterates this rather than restating the
    /// three names, so adding a protocol cannot leave one of those answers out.
    pub const ALL: &'static [Self] = &[Self::OpenAi, Self::Anthropic, Self::Ollama];

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Ollama => "ollama",
        }
    }

    /// Human-readable name, used to seed a profile label when a caller (or a
    /// pre-profile stored payload) supplies none.
    pub fn label(&self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Ollama => "Ollama",
        }
    }

    /// Default base URL for this protocol's reference vendor.
    pub fn default_base_url(&self) -> &'static str {
        match self {
            Self::OpenAi => "https://api.openai.com/v1",
            Self::Anthropic => "https://api.anthropic.com/v1",
            Self::Ollama => "http://localhost:11434",
        }
    }

    /// Default model for this protocol's reference vendor.
    pub fn default_model(&self) -> &'static str {
        match self {
            Self::OpenAi => "gpt-4o",
            Self::Anthropic => "claude-sonnet-4-20250514",
            Self::Ollama => "llama3",
        }
    }

    /// Whether a connection speaking this protocol needs an API key.
    pub fn requires_api_key(&self) -> bool {
        match self {
            Self::OpenAi | Self::Anthropic => true,
            Self::Ollama => false,
        }
    }
}

impl std::fmt::Display for ProviderProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Configuration for one provider connection.
///
/// This is the client-facing half of a [`crate::profile::ProviderProfile`]: it
/// carries no identity, only what a request needs. It is never accepted from
/// or returned to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// Which wire protocol — and therefore which client — to use.
    pub protocol: ProviderProtocol,
    /// API key for the endpoint, when it needs one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Base URL override (for proxies or protocol-compatible endpoints).
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
    /// Effective base URL (custom or protocol default).
    pub fn effective_base_url(&self) -> &str {
        self.base_url
            .as_deref()
            .unwrap_or(self.protocol.default_base_url())
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
        if !self.temperature.is_finite()
            || !(MIN_TEMPERATURE..=MAX_TEMPERATURE).contains(&self.temperature)
        {
            return Err(AiProviderError::InvalidRequest {
                field: "temperature",
                message: format!(
                    "must be finite and between {MIN_TEMPERATURE} and {MAX_TEMPERATURE}"
                ),
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
            protocol: ProviderProtocol::Anthropic,
            api_key: None,
            base_url: None,
            model: ProviderProtocol::Anthropic.default_model().to_string(),
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
            protocol: ProviderProtocol::Ollama,
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

        // Both ends of the range, now that both are named constants rather
        // than literals inside the `contains` call.
        for refused in [MIN_TEMPERATURE - 0.1, MAX_TEMPERATURE + 0.1] {
            config.temperature = refused;
            assert!(
                matches!(
                    config.validate(),
                    Err(AiProviderError::InvalidRequest {
                        field: "temperature",
                        ..
                    })
                ),
                "temperature {refused} must be refused"
            );
        }
        config.temperature = MIN_TEMPERATURE;
        config.validate().expect("the temperature floor is valid");
    }

    /// The second of the two scheme checks a stored profile passes through
    /// (see `profile::validate_base_url` for the first). It is the last gate
    /// before a client is built, so it is pinned here independently.
    #[test]
    fn a_non_http_base_url_is_refused_by_the_client_configuration_too() {
        for refused in [
            "ftp://example.com",
            "ws://example.com",
            "file:///etc/passwd",
            "data:text/plain,hi",
        ] {
            let config = ProviderConfig {
                protocol: ProviderProtocol::OpenAi,
                base_url: Some(refused.into()),
                ..ProviderConfig::default()
            };
            assert!(
                matches!(
                    config.validate(),
                    Err(AiProviderError::InvalidRequest {
                        field: "baseUrl",
                        ..
                    })
                ),
                "{refused:?} must not reach a client"
            );
        }
    }

    /// The protocol is the renderer's selector for a client and a prefill, so
    /// its wire spelling and its seeds are part of the contract.
    #[test]
    fn protocol_wire_spellings_and_seeds_are_stable() {
        for (protocol, wire) in [
            (ProviderProtocol::OpenAi, "openai"),
            (ProviderProtocol::Anthropic, "anthropic"),
            (ProviderProtocol::Ollama, "ollama"),
        ] {
            assert_eq!(protocol.as_str(), wire);
            assert_eq!(
                serde_json::to_value(protocol).expect("serializes"),
                serde_json::json!(wire)
            );
            assert_eq!(
                serde_json::from_value::<ProviderProtocol>(serde_json::json!(wire))
                    .expect("deserializes"),
                protocol
            );
            assert!(!protocol.label().is_empty());
            assert!(!protocol.default_model().is_empty());
            assert!(protocol.default_base_url().starts_with("http"));
        }
        assert!(ProviderProtocol::OpenAi.requires_api_key());
        assert!(ProviderProtocol::Anthropic.requires_api_key());
        assert!(!ProviderProtocol::Ollama.requires_api_key());
    }
}
