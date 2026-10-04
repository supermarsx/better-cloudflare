//! Agent configuration.

use serde::{Deserialize, Serialize};

use bc_ai_provider::limits::{
    MAX_REQUEST_TIMEOUT_MS, MAX_SAMPLING_PENALTY, MAX_SYSTEM_PROMPT_BYTES, MAX_TOP_K,
    MIN_REQUEST_TIMEOUT_MS, MIN_SAMPLING_PENALTY, MIN_TEMPERATURE, MIN_TOP_K, MIN_TOP_P,
};

use crate::error::AgentError;

pub const MAX_TOOL_ROUNDS: u32 = 32;
pub const MAX_PRESET_BYTES: usize = 128;
pub const AGENT_EVENT_CHANNEL_CAPACITY: usize = 128;
/// Aliases, not copies: the number the settings form enforces is literally the
/// number the request validator enforces, so the two cannot drift. The
/// literals live in `bc_ai_provider::limits` because the provider crate cannot
/// depend on this one, and the floors are imported above rather than re-named
/// here so that each bound has exactly one greppable definition.
pub const MAX_TEMPERATURE: f32 = bc_ai_provider::limits::MAX_TEMPERATURE;
pub const MAX_TOP_P: f32 = bc_ai_provider::limits::MAX_TOP_P;

/// Context-window budget bounds.
///
/// The floor is a window that can still hold a system prompt and one exchange;
/// below it the history fitter would drop everything the user just typed. The
/// ceiling is above the largest context any current model offers, so it cannot
/// clip a real model's window.
pub const MIN_CONTEXT_TOKENS: u32 = 512;
pub const MAX_CONTEXT_TOKENS: u32 = 2_000_000;

/// Persona selected when a stored configuration names none.
pub const DEFAULT_PERSONA_ID: &str = "default";

const DEFAULT_TEMPERATURE: f32 = 0.7;
const DEFAULT_TOP_P: f32 = 1.0;
/// Fits the common 128k-context models. History longer than this was
/// previously sent whole and rejected by the provider, so a default that
/// truncates is the more forgiving behaviour, not the stricter one.
const DEFAULT_MAX_CONTEXT_TOKENS: u32 = 128_000;

fn default_temperature() -> f32 {
    DEFAULT_TEMPERATURE
}

fn default_top_p() -> f32 {
    DEFAULT_TOP_P
}

fn default_max_context_tokens() -> u32 {
    DEFAULT_MAX_CONTEXT_TOKENS
}

/// Prose may carry line breaks and tabs; every other control character is
/// refused. The same rule `personas::validate_text` applies, and for the same
/// reason: a control character pasted into a system prompt can forge message
/// structure in the prompt it joins.
fn has_forbidden_control(value: &str) -> bool {
    value
        .chars()
        .any(|value| value.is_control() && !matches!(value, '\n' | '\r' | '\t'))
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
    /// Sample only from the `k` most likely tokens. `None` sends nothing.
    ///
    /// Not every protocol honours this, or the five controls below it; see
    /// `bc_ai_provider::protocol_capabilities`, which the renderer reads
    /// through `ai_protocol_capabilities` to mark a setting the selected
    /// provider cannot apply. A control the provider in use cannot take is
    /// omitted from its request rather than renamed onto a field that means
    /// something else.
    pub top_k: Option<u32>,
    /// Sequences that end generation. Empty sends nothing.
    pub stop: Vec<String>,
    /// Seed for reproducible sampling. `None` sends nothing.
    ///
    /// `u32` rather than `u64` so a JSON number from the renderer can never
    /// lose precision: every value the renderer can send round-trips exactly,
    /// which makes an out-of-range seed unrepresentable instead of rejected.
    /// That is why `validate` has no seed arm and why there is no `MAX_SEED` —
    /// a bound nothing checks would look enforced without being enforced.
    pub seed: Option<u32>,
    /// Penalty in proportion to how often a token has appeared (−2.0–2.0).
    pub frequency_penalty: Option<f32>,
    /// Flat penalty for tokens that have appeared at all (−2.0–2.0).
    pub presence_penalty: Option<f32>,
    /// Token budget for the history sent with a turn.
    ///
    /// Drives `bc_ai_chat::context::fit_context_window`, which trims the
    /// oldest messages until the turn fits.
    pub max_context_tokens: u32,
    /// Extra instruction appended to the persona (or conversation) prompt.
    ///
    /// Composed, never substituted — replacing the selected persona silently
    /// would discard a choice the user made in the same settings panel, and a
    /// true replacement already exists per conversation.
    pub system_prompt_override: Option<String>,
    /// HTTP timeout for the provider call. `None` leaves it unbounded.
    pub request_timeout_ms: Option<u32>,
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
    /// Absent in every configuration stored before the advanced generation
    /// controls existed, which is why each one defaults rather than being
    /// required: a stored payload that predates them must load unchanged, with
    /// every setting the user did choose left alone.
    #[serde(default)]
    top_k: Option<u32>,
    #[serde(default)]
    stop: Vec<String>,
    #[serde(default)]
    seed: Option<u32>,
    #[serde(default)]
    frequency_penalty: Option<f32>,
    #[serde(default)]
    presence_penalty: Option<f32>,
    #[serde(default = "default_max_context_tokens")]
    max_context_tokens: u32,
    #[serde(default)]
    system_prompt_override: Option<String>,
    #[serde(default)]
    request_timeout_ms: Option<u32>,
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
            top_k: stored.top_k,
            stop: stored.stop,
            seed: stored.seed,
            frequency_penalty: stored.frequency_penalty,
            presence_penalty: stored.presence_penalty,
            max_context_tokens: stored.max_context_tokens,
            // An emptied text box arrives as `""`, which is the user clearing
            // the override rather than appending a blank line to the persona.
            system_prompt_override: stored
                .system_prompt_override
                .filter(|prompt| !prompt.trim().is_empty()),
            request_timeout_ms: stored.request_timeout_ms,
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
            top_k: None,
            stop: Vec::new(),
            seed: None,
            frequency_penalty: None,
            presence_penalty: None,
            max_context_tokens: DEFAULT_MAX_CONTEXT_TOKENS,
            system_prompt_override: None,
            request_timeout_ms: None,
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
        if !self.temperature.is_finite()
            || !(MIN_TEMPERATURE..=MAX_TEMPERATURE).contains(&self.temperature)
        {
            return Err(AgentError::InvalidConfig {
                field: "temperature",
                message: format!("must be between {MIN_TEMPERATURE} and {MAX_TEMPERATURE}"),
            });
        }
        if !self.top_p.is_finite() || !(MIN_TOP_P..=MAX_TOP_P).contains(&self.top_p) {
            return Err(AgentError::InvalidConfig {
                field: "topP",
                message: format!("must be between {MIN_TOP_P} and {MAX_TOP_P}"),
            });
        }
        if let Some(top_k) = self.top_k {
            if !(MIN_TOP_K..=MAX_TOP_K).contains(&top_k) {
                return Err(AgentError::InvalidConfig {
                    field: "topK",
                    message: format!("must be between {MIN_TOP_K} and {MAX_TOP_K}"),
                });
            }
        }
        for (field, penalty) in [
            ("frequencyPenalty", self.frequency_penalty),
            ("presencePenalty", self.presence_penalty),
        ] {
            if let Some(penalty) = penalty {
                if !penalty.is_finite()
                    || !(MIN_SAMPLING_PENALTY..=MAX_SAMPLING_PENALTY).contains(&penalty)
                {
                    return Err(AgentError::InvalidConfig {
                        field,
                        message: format!(
                            "must be between {MIN_SAMPLING_PENALTY} and {MAX_SAMPLING_PENALTY}"
                        ),
                    });
                }
            }
        }
        // The provider crate owns the stop-sequence rules, because the request
        // validator has to enforce them anyway as the last gate before the
        // wire. Enforcing them here too is what turns a provider rejection
        // into a named settings error.
        bc_ai_provider::limits::validate_stop_sequences(&self.stop).map_err(|error| {
            AgentError::InvalidConfig {
                field: "stop",
                message: match error {
                    bc_ai_provider::AiProviderError::InvalidRequest { message, .. } => message,
                    other => other.to_string(),
                },
            }
        })?;
        if !(MIN_CONTEXT_TOKENS..=MAX_CONTEXT_TOKENS).contains(&self.max_context_tokens) {
            return Err(AgentError::InvalidConfig {
                field: "maxContextTokens",
                message: format!("must be between {MIN_CONTEXT_TOKENS} and {MAX_CONTEXT_TOKENS}"),
            });
        }
        if let Some(prompt) = &self.system_prompt_override {
            if prompt.trim().is_empty() {
                return Err(AgentError::InvalidConfig {
                    field: "systemPromptOverride",
                    message: "must not be blank; send null to clear it".into(),
                });
            }
            if prompt.len() > MAX_SYSTEM_PROMPT_BYTES {
                return Err(AgentError::InvalidConfig {
                    field: "systemPromptOverride",
                    message: format!("must not exceed {MAX_SYSTEM_PROMPT_BYTES} bytes"),
                });
            }
            if has_forbidden_control(prompt) {
                return Err(AgentError::InvalidConfig {
                    field: "systemPromptOverride",
                    message:
                        "must not contain control characters other than tab, carriage return or newline"
                            .into(),
                });
            }
        }
        if let Some(timeout_ms) = self.request_timeout_ms {
            if !(MIN_REQUEST_TIMEOUT_MS..=MAX_REQUEST_TIMEOUT_MS).contains(&timeout_ms) {
                return Err(AgentError::InvalidConfig {
                    field: "requestTimeoutMs",
                    message: format!(
                        "must be between {MIN_REQUEST_TIMEOUT_MS} and {MAX_REQUEST_TIMEOUT_MS}"
                    ),
                });
            }
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
            top_k: Some(MAX_TOP_K),
            stop: vec![
                "x".repeat(bc_ai_provider::limits::MAX_STOP_SEQUENCE_BYTES);
                bc_ai_provider::limits::MAX_STOP_SEQUENCES
            ],
            seed: Some(u32::MAX),
            frequency_penalty: Some(MAX_SAMPLING_PENALTY),
            presence_penalty: Some(MIN_SAMPLING_PENALTY),
            max_context_tokens: MAX_CONTEXT_TOKENS,
            system_prompt_override: Some("o".repeat(MAX_SYSTEM_PROMPT_BYTES)),
            request_timeout_ms: Some(MAX_REQUEST_TIMEOUT_MS),
            default_provider_id: Some("groq-prod".into()),
        };
        config.validate().expect("exact boundaries");

        let floors = AgentConfig {
            max_context_tokens: MIN_CONTEXT_TOKENS,
            request_timeout_ms: Some(MIN_REQUEST_TIMEOUT_MS),
            top_k: Some(MIN_TOP_K),
            ..config.clone()
        };
        floors.validate().expect("exact floors");

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

        let mut invalid = config.clone();
        invalid.default_provider_id = Some("../../etc/passwd".into());
        assert!(matches!(
            invalid.validate(),
            Err(AgentError::InvalidConfig {
                field: "defaultProviderId",
                ..
            })
        ));

        // One step past each new boundary, named by the camelCase field the
        // renderer labels its input with.
        let past_boundary: [(&str, AgentConfig); 11] = [
            (
                "topK",
                AgentConfig {
                    top_k: Some(MIN_TOP_K - 1),
                    ..config.clone()
                },
            ),
            (
                "topK",
                AgentConfig {
                    top_k: Some(MAX_TOP_K + 1),
                    ..config.clone()
                },
            ),
            (
                "frequencyPenalty",
                AgentConfig {
                    frequency_penalty: Some(MAX_SAMPLING_PENALTY + 0.1),
                    ..config.clone()
                },
            ),
            (
                "frequencyPenalty",
                AgentConfig {
                    frequency_penalty: Some(f32::NAN),
                    ..config.clone()
                },
            ),
            (
                "presencePenalty",
                AgentConfig {
                    presence_penalty: Some(MIN_SAMPLING_PENALTY - 0.1),
                    ..config.clone()
                },
            ),
            (
                "stop",
                AgentConfig {
                    stop: vec!["x".into(); bc_ai_provider::limits::MAX_STOP_SEQUENCES + 1],
                    ..config.clone()
                },
            ),
            (
                "maxContextTokens",
                AgentConfig {
                    max_context_tokens: MIN_CONTEXT_TOKENS - 1,
                    ..config.clone()
                },
            ),
            (
                "maxContextTokens",
                AgentConfig {
                    max_context_tokens: MAX_CONTEXT_TOKENS + 1,
                    ..config.clone()
                },
            ),
            (
                "systemPromptOverride",
                AgentConfig {
                    system_prompt_override: Some("o".repeat(MAX_SYSTEM_PROMPT_BYTES + 1)),
                    ..config.clone()
                },
            ),
            (
                "requestTimeoutMs",
                AgentConfig {
                    request_timeout_ms: Some(MIN_REQUEST_TIMEOUT_MS - 1),
                    ..config.clone()
                },
            ),
            (
                "requestTimeoutMs",
                AgentConfig {
                    request_timeout_ms: Some(MAX_REQUEST_TIMEOUT_MS + 1),
                    ..config.clone()
                },
            ),
        ];
        for (expected, invalid) in past_boundary {
            match invalid.validate() {
                Err(AgentError::InvalidConfig { field, .. }) => assert_eq!(field, expected),
                other => panic!("{expected} past its boundary must be refused, got {other:?}"),
            }
        }
    }

    /// Stop sequences are user text headed for a provider body, and the rules
    /// are the intersection of the three protocols — `"\nUser:"` has to work
    /// (it is the canonical use), while a whitespace-only sequence is refused
    /// because Anthropic rejects one, and an empty one because OpenAI does.
    #[test]
    fn stop_sequences_accept_newlines_and_refuse_blank_or_control_text() {
        let config = AgentConfig {
            stop: vec!["\nUser:".into(), "END\t".into()],
            ..AgentConfig::default()
        };
        config.validate().expect("newline-bearing stop sequences");

        for refused in ["", "\n\n", "   ", "stop\u{0}", "stop\u{1b}[0m"] {
            let config = AgentConfig {
                stop: vec![refused.into()],
                ..AgentConfig::default()
            };
            assert!(
                matches!(
                    config.validate(),
                    Err(AgentError::InvalidConfig { field: "stop", .. })
                ),
                "stop sequence {refused:?} must be refused"
            );
        }
    }

    /// An emptied text box arrives as `""`; that clears the override instead
    /// of appending a blank line to the persona prompt. A non-null blank could
    /// only come from code, and that is a mistake worth naming.
    #[test]
    fn a_blank_system_prompt_override_clears_rather_than_composing_nothing() {
        let stored = r#"{
            "maxToolRounds": 5,
            "maxTokensPerTurn": 4096,
            "toolsEnabled": true,
            "stream": true,
            "systemPromptOverride": "   \n "
        }"#;
        let config: AgentConfig = serde_json::from_str(stored).expect("deserializes");
        assert_eq!(config.system_prompt_override, None);
        config.validate().expect("a cleared override is valid");

        let constructed = AgentConfig {
            system_prompt_override: Some("  ".into()),
            ..AgentConfig::default()
        };
        assert!(matches!(
            constructed.validate(),
            Err(AgentError::InvalidConfig {
                field: "systemPromptOverride",
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
            temperature: MIN_TEMPERATURE,
            top_p: MIN_TOP_P,
            ..AgentConfig::default()
        };
        config.validate().expect("zero sampling values");
        assert_eq!((MIN_TEMPERATURE, MIN_TOP_P), (0.0, 0.0));

        // The floors are named constants now, so they need pinning in both
        // directions: a value below either must be refused by its own field.
        let below_temperature = AgentConfig {
            temperature: MIN_TEMPERATURE - 0.1,
            ..AgentConfig::default()
        };
        assert!(matches!(
            below_temperature.validate(),
            Err(AgentError::InvalidConfig {
                field: "temperature",
                ..
            })
        ));
        let below_top_p = AgentConfig {
            top_p: MIN_TOP_P - 0.1,
            ..AgentConfig::default()
        };
        assert!(matches!(
            below_top_p.validate(),
            Err(AgentError::InvalidConfig { field: "topP", .. })
        ));
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

        // The advanced generation controls did not exist when this payload was
        // written. Each defaults to "not configured" — so nothing new is sent
        // to a provider on behalf of a user who never asked for it — except
        // the context budget, which has to be a number to fit history against.
        assert_eq!(config.top_k, None);
        assert!(config.stop.is_empty());
        assert_eq!(config.seed, None);
        assert_eq!(config.frequency_penalty, None);
        assert_eq!(config.presence_penalty, None);
        assert_eq!(config.max_context_tokens, DEFAULT_MAX_CONTEXT_TOKENS);
        assert_eq!(config.system_prompt_override, None);
        assert_eq!(config.request_timeout_ms, None);

        config.validate().expect("migrated config is valid");
    }

    /// The round trip the previous test proves is lossless, in the other
    /// direction: a configuration carrying every new control must come back
    /// the same, so saving settings cannot quietly drop one.
    #[test]
    fn a_config_carrying_every_new_control_round_trips() {
        let stored = r#"{
            "maxToolRounds": 5,
            "maxTokensPerTurn": 4096,
            "toolsEnabled": true,
            "stream": true,
            "personaId": "dns-expert",
            "temperature": 0.4,
            "topP": 0.8,
            "topK": 40,
            "stop": ["\nUser:", "END"],
            "seed": 1234,
            "frequencyPenalty": 0.5,
            "presencePenalty": -0.5,
            "maxContextTokens": 64000,
            "systemPromptOverride": "Prefer UK English.",
            "requestTimeoutMs": 45000
        }"#;
        let config: AgentConfig = serde_json::from_str(stored).expect("deserializes");
        config.validate().expect("valid");

        assert_eq!(config.top_k, Some(40));
        assert_eq!(config.stop, vec!["\nUser:".to_string(), "END".to_string()]);
        assert_eq!(config.seed, Some(1234));
        assert_eq!(config.frequency_penalty, Some(0.5));
        assert_eq!(config.presence_penalty, Some(-0.5));
        assert_eq!(config.max_context_tokens, 64_000);
        assert_eq!(
            config.system_prompt_override.as_deref(),
            Some("Prefer UK English.")
        );
        assert_eq!(config.request_timeout_ms, Some(45_000));

        let reencoded = serde_json::to_string(&config).expect("serializes");
        let decoded: AgentConfig = serde_json::from_str(&reencoded).expect("round trips");
        assert_eq!(decoded.top_k, config.top_k);
        assert_eq!(decoded.stop, config.stop);
        assert_eq!(decoded.seed, config.seed);
        assert_eq!(decoded.frequency_penalty, config.frequency_penalty);
        assert_eq!(decoded.presence_penalty, config.presence_penalty);
        assert_eq!(decoded.max_context_tokens, config.max_context_tokens);
        assert_eq!(
            decoded.system_prompt_override,
            config.system_prompt_override
        );
        assert_eq!(decoded.request_timeout_ms, config.request_timeout_ms);
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
            "topK",
            "stop",
            "seed",
            "frequencyPenalty",
            "presencePenalty",
            "maxContextTokens",
            "systemPromptOverride",
            "requestTimeoutMs",
            "defaultProviderId",
        ] {
            assert!(json.contains(expected), "missing {expected} in {json}");
        }
        for forbidden in [
            "persona_id",
            "top_p",
            "top_k",
            "frequency_penalty",
            "presence_penalty",
            "max_context_tokens",
            "system_prompt_override",
            "request_timeout_ms",
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
