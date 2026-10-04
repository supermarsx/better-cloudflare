//! Agent configuration.

use serde::{Deserialize, Serialize};

use crate::error::AgentError;

pub const MAX_TOOL_ROUNDS: u32 = 32;
pub const MAX_PRESET_BYTES: usize = 128;
pub const AGENT_EVENT_CHANNEL_CAPACITY: usize = 128;
pub const MAX_TEMPERATURE: f32 = 2.0;
pub const MAX_TOP_P: f32 = 1.0;

/// Persona selected when a stored configuration names none.
pub const DEFAULT_PERSONA_ID: &str = "default";

const DEFAULT_TEMPERATURE: f32 = 0.7;
const DEFAULT_TOP_P: f32 = 1.0;

fn default_temperature() -> f32 {
    DEFAULT_TEMPERATURE
}

fn default_top_p() -> f32 {
    DEFAULT_TOP_P
}

/// Configuration for the AI agent loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "StoredAgentConfig")]
pub struct AgentConfig {
    /// Maximum number of tool-call rounds before forcing a text response.
    pub max_tool_rounds: u32,
    /// Maximum total tokens per conversation turn.
    pub max_tokens_per_turn: u32,
    /// Whether to enable tool use.
    pub tools_enabled: bool,
    /// Whether to stream responses.
    pub stream: bool,
    /// Selected persona id (builtin, e.g. "dns-expert", or `custom-…`).
    ///
    /// This is the field formerly spelled `preset`; see [`StoredAgentConfig`].
    pub persona_id: String,
    /// Sampling temperature (0.0–2.0).
    pub temperature: f32,
    /// Nucleus sampling probability mass (0.0–1.0).
    pub top_p: f32,
    /// Provider profile a send uses when it names none.
    ///
    /// Only the *shape* of the id is validated here, because a configuration
    /// may legitimately name a profile that has not been configured yet. An id
    /// that resolves to nothing fails the send with
    /// `AI_NOT_CONFIGURED` rather than quietly picking another provider, and
    /// deleting the named profile clears this field.
    pub default_provider_id: Option<String>,
}

/// Wire/stored shape of [`AgentConfig`], used for backward-compatible reads.
///
/// Configurations stored before personas existed carry `preset` and no
/// sampling fields. Deserialising through this shape converts rather than
/// rejects them, so upgrading never drops a user's selection. When both
/// spellings are present `personaId` wins — a duplicate-field error would turn
/// a merged config into a hard failure.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAgentConfig {
    max_tool_rounds: u32,
    max_tokens_per_turn: u32,
    tools_enabled: bool,
    stream: bool,
    #[serde(default)]
    persona_id: Option<String>,
    /// Pre-persona spelling of `persona_id`.
    #[serde(default)]
    preset: Option<String>,
    #[serde(default = "default_temperature")]
    temperature: f32,
    #[serde(default = "default_top_p")]
    top_p: f32,
    /// Absent in every configuration stored before provider profiles existed.
    #[serde(default)]
    default_provider_id: Option<String>,
}

impl From<StoredAgentConfig> for AgentConfig {
    fn from(stored: StoredAgentConfig) -> Self {
        Self {
            max_tool_rounds: stored.max_tool_rounds,
            max_tokens_per_turn: stored.max_tokens_per_turn,
            tools_enabled: stored.tools_enabled,
            stream: stored.stream,
            persona_id: stored
                .persona_id
                .or(stored.preset)
                .unwrap_or_else(|| DEFAULT_PERSONA_ID.to_string()),
            temperature: stored.temperature,
            top_p: stored.top_p,
            default_provider_id: stored
                .default_provider_id
                .filter(|id| !id.trim().is_empty()),
        }
    }
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_tool_rounds: 10,
            max_tokens_per_turn: 8192,
            tools_enabled: true,
            stream: true,
            persona_id: DEFAULT_PERSONA_ID.into(),
            temperature: DEFAULT_TEMPERATURE,
            top_p: DEFAULT_TOP_P,
            default_provider_id: None,
        }
    }
}

/// Whether a persona id is shaped like one this backend issues or recognises.
fn is_valid_persona_id(id: &str) -> bool {
    id.chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
}

impl AgentConfig {
    pub fn validate(&self) -> Result<(), AgentError> {
        if self.max_tool_rounds == 0 || self.max_tool_rounds > MAX_TOOL_ROUNDS {
            return Err(AgentError::InvalidConfig {
                field: "maxToolRounds",
                message: format!("must be between 1 and {MAX_TOOL_ROUNDS}"),
            });
        }
        if self.max_tokens_per_turn == 0
            || self.max_tokens_per_turn > bc_ai_provider::limits::MAX_COMPLETION_TOKENS
        {
            return Err(AgentError::InvalidConfig {
                field: "maxTokensPerTurn",
                message: format!(
                    "must be between 1 and {}",
                    bc_ai_provider::limits::MAX_COMPLETION_TOKENS
                ),
            });
        }
        if self.persona_id.is_empty() || self.persona_id.len() > MAX_PRESET_BYTES {
            return Err(AgentError::InvalidConfig {
                field: "personaId",
                message: format!("must contain between 1 and {MAX_PRESET_BYTES} bytes"),
            });
        }
        if !is_valid_persona_id(&self.persona_id) {
            return Err(AgentError::InvalidConfig {
                field: "personaId",
                message: "must contain only letters, digits, '-' or '_'".into(),
            });
        }
        if !self.temperature.is_finite() || !(0.0..=MAX_TEMPERATURE).contains(&self.temperature) {
            return Err(AgentError::InvalidConfig {
                field: "temperature",
                message: format!("must be between 0.0 and {MAX_TEMPERATURE}"),
            });
        }
        if !self.top_p.is_finite() || !(0.0..=MAX_TOP_P).contains(&self.top_p) {
            return Err(AgentError::InvalidConfig {
                field: "topP",
                message: format!("must be between 0.0 and {MAX_TOP_P}"),
            });
        }
        if let Some(id) = &self.default_provider_id {
            // Shape only: the store, not the configuration, knows which ids
            // exist. A well-formed id that names nothing is caught at send.
            bc_ai_provider::validate_provider_id(id).map_err(|error| {
                AgentError::InvalidConfig {
                    field: "defaultProviderId",
                    message: match error {
                        bc_ai_provider::AiProviderError::InvalidRequest { message, .. } => message,
                        other => other.to_string(),
                    },
                }
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_config_boundaries_are_valid() {
        let config = AgentConfig {
            max_tool_rounds: MAX_TOOL_ROUNDS,
            max_tokens_per_turn: bc_ai_provider::limits::MAX_COMPLETION_TOKENS,
            tools_enabled: true,
            stream: true,
            persona_id: "p".repeat(MAX_PRESET_BYTES),
            temperature: MAX_TEMPERATURE,
            top_p: MAX_TOP_P,
            default_provider_id: Some("groq-prod".into()),
        };
        config.validate().expect("exact boundaries");

        let mut invalid = config.clone();
        invalid.max_tool_rounds += 1;
        assert!(matches!(
            invalid.validate(),
            Err(AgentError::InvalidConfig {
                field: "maxToolRounds",
                ..
            })
        ));

        let mut invalid = config.clone();
        invalid.persona_id.push('p');
        assert!(matches!(
            invalid.validate(),
            Err(AgentError::InvalidConfig {
                field: "personaId",
                ..
            })
        ));

        let mut invalid = config.clone();
        invalid.temperature = MAX_TEMPERATURE + 0.1;
        assert!(matches!(
            invalid.validate(),
            Err(AgentError::InvalidConfig {
                field: "temperature",
                ..
            })
        ));

        let mut invalid = config.clone();
        invalid.top_p = MAX_TOP_P + 0.1;
        assert!(matches!(
            invalid.validate(),
            Err(AgentError::InvalidConfig { field: "topP", .. })
        ));

        let mut invalid = config;
        invalid.default_provider_id = Some("../../etc/passwd".into());
        assert!(matches!(
            invalid.validate(),
            Err(AgentError::InvalidConfig {
                field: "defaultProviderId",
                ..
            })
        ));
    }

    /// The default selection is user-supplied text that later becomes a map
    /// key, so an id that could not have come from the store is refused here.
    #[test]
    fn a_malformed_default_provider_id_is_rejected_but_an_unknown_one_is_not() {
        for refused in ["", "   ", "my provider", "openai/v1", &"i".repeat(65)] {
            let config = AgentConfig {
                default_provider_id: Some(refused.into()),
                ..AgentConfig::default()
            };
            assert!(
                matches!(
                    config.validate(),
                    Err(AgentError::InvalidConfig {
                        field: "defaultProviderId",
                        ..
                    })
                ),
                "default provider id {refused:?} must be rejected"
            );
        }

        // Well-formed but not configured: the send resolves it, not the
        // configuration, so storing the selection first must stay legal.
        let config = AgentConfig {
            default_provider_id: Some("not-configured-yet".into()),
            ..AgentConfig::default()
        };
        config.validate().expect("an unknown id is a valid shape");
    }

    #[test]
    fn zero_is_a_valid_floor_for_both_sampling_fields() {
        let config = AgentConfig {
            temperature: 0.0,
            top_p: 0.0,
            ..AgentConfig::default()
        };
        config.validate().expect("zero sampling values");
    }

    #[test]
    fn non_finite_sampling_values_are_rejected() {
        for temperature in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let config = AgentConfig {
                temperature,
                ..AgentConfig::default()
            };
            assert!(matches!(
                config.validate(),
                Err(AgentError::InvalidConfig {
                    field: "temperature",
                    ..
                })
            ));
        }
        let config = AgentConfig {
            top_p: f32::NAN,
            ..AgentConfig::default()
        };
        assert!(matches!(
            config.validate(),
            Err(AgentError::InvalidConfig { field: "topP", .. })
        ));
    }

    #[test]
    fn an_empty_or_exotic_persona_id_is_rejected() {
        for persona_id in ["", "../default", "dns expert", "dns\u{0}expert"] {
            let config = AgentConfig {
                persona_id: persona_id.into(),
                ..AgentConfig::default()
            };
            assert!(
                matches!(
                    config.validate(),
                    Err(AgentError::InvalidConfig {
                        field: "personaId",
                        ..
                    })
                ),
                "persona id {persona_id:?} must be rejected"
            );
        }
    }

    /// A configuration stored before this change has `preset` and none of the
    /// new fields. It must still load, keeping every setting the user chose.
    #[test]
    fn a_pre_persona_stored_config_migrates_without_losing_settings() {
        let stored = r#"{
            "maxToolRounds": 5,
            "maxTokensPerTurn": 4096,
            "toolsEnabled": false,
            "stream": false,
            "preset": "dns-expert"
        }"#;
        let config: AgentConfig = serde_json::from_str(stored).expect("old config deserializes");

        assert_eq!(config.persona_id, "dns-expert");
        assert_eq!(config.max_tool_rounds, 5);
        assert_eq!(config.max_tokens_per_turn, 4096);
        assert!(!config.tools_enabled);
        assert!(!config.stream);
        assert_eq!(config.temperature, DEFAULT_TEMPERATURE);
        assert_eq!(config.top_p, DEFAULT_TOP_P);
        assert_eq!(
            config.default_provider_id, None,
            "a configuration stored before profiles existed names no default"
        );
        config.validate().expect("migrated config is valid");
    }

    #[test]
    fn a_stored_config_without_any_persona_falls_back_to_the_default() {
        let stored = r#"{
            "maxToolRounds": 5,
            "maxTokensPerTurn": 4096,
            "toolsEnabled": true,
            "stream": true
        }"#;
        let config: AgentConfig = serde_json::from_str(stored).expect("deserializes");
        assert_eq!(config.persona_id, DEFAULT_PERSONA_ID);
        config.validate().expect("valid");
    }

    #[test]
    fn the_new_spelling_wins_when_a_stored_config_carries_both() {
        let stored = r#"{
            "maxToolRounds": 5,
            "maxTokensPerTurn": 4096,
            "toolsEnabled": true,
            "stream": true,
            "preset": "dns-expert",
            "personaId": "security-auditor",
            "temperature": 1.25,
            "topP": 0.5
        }"#;
        let config: AgentConfig =
            serde_json::from_str(stored).expect("both spellings must not be an error");
        assert_eq!(config.persona_id, "security-auditor");
        assert_eq!(config.temperature, 1.25);
        assert_eq!(config.top_p, 0.5);
    }

    #[test]
    fn an_empty_stored_persona_is_rejected_rather_than_quietly_replaced() {
        let stored = r#"{
            "maxToolRounds": 5,
            "maxTokensPerTurn": 4096,
            "toolsEnabled": true,
            "stream": true,
            "personaId": ""
        }"#;
        let config: AgentConfig = serde_json::from_str(stored).expect("deserializes");
        assert_eq!(config.persona_id, "");
        assert!(matches!(
            config.validate(),
            Err(AgentError::InvalidConfig {
                field: "personaId",
                ..
            })
        ));
    }

    #[test]
    fn the_wire_format_is_camel_case_and_round_trips() {
        let config = AgentConfig::default();
        let json = serde_json::to_string(&config).expect("serializes");
        for expected in [
            "maxToolRounds",
            "maxTokensPerTurn",
            "toolsEnabled",
            "stream",
            "personaId",
            "temperature",
            "topP",
            "defaultProviderId",
        ] {
            assert!(json.contains(expected), "missing {expected} in {json}");
        }
        for forbidden in [
            "persona_id",
            "top_p",
            "max_tool_rounds",
            "default_provider_id",
            "\"preset\"",
        ] {
            assert!(!json.contains(forbidden), "leaked {forbidden} in {json}");
        }

        let decoded: AgentConfig = serde_json::from_str(&json).expect("round trips");
        assert_eq!(decoded.persona_id, config.persona_id);
        assert_eq!(decoded.temperature, config.temperature);
        assert_eq!(decoded.top_p, config.top_p);
        assert_eq!(decoded.default_provider_id, config.default_provider_id);

        // The renderer reads this field to show a selection, so an absent
        // default is an explicit null rather than a missing key.
        let selected = AgentConfig {
            default_provider_id: Some("groq-prod".into()),
            ..AgentConfig::default()
        };
        let value = serde_json::to_value(&selected).expect("serializes");
        assert_eq!(value["defaultProviderId"], "groq-prod");
        assert_eq!(
            serde_json::to_value(AgentConfig::default()).expect("serializes")["defaultProviderId"],
            serde_json::Value::Null
        );
    }
}
