//! Agent configuration.

use serde::{Deserialize, Serialize};

use crate::error::AgentError;

pub const MAX_TOOL_ROUNDS: u32 = 32;
pub const MAX_PRESET_BYTES: usize = 128;
pub const AGENT_EVENT_CHANNEL_CAPACITY: usize = 128;

/// Configuration for the AI agent loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// Maximum number of tool-call rounds before forcing a text response.
    pub max_tool_rounds: u32,
    /// Maximum total tokens per conversation turn.
    pub max_tokens_per_turn: u32,
    /// Whether to enable tool use.
    pub tools_enabled: bool,
    /// Whether to stream responses.
    pub stream: bool,
    /// Persona preset name (e.g. "default", "dns-expert").
    pub preset: String,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_tool_rounds: 10,
            max_tokens_per_turn: 8192,
            tools_enabled: true,
            stream: true,
            preset: "default".into(),
        }
    }
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
        if self.preset.is_empty() || self.preset.len() > MAX_PRESET_BYTES {
            return Err(AgentError::InvalidConfig {
                field: "preset",
                message: format!("must contain between 1 and {MAX_PRESET_BYTES} bytes"),
            });
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
            preset: "p".repeat(MAX_PRESET_BYTES),
        };
        config.validate().expect("exact boundaries");

        let mut invalid = config;
        invalid.max_tool_rounds += 1;
        assert!(matches!(
            invalid.validate(),
            Err(AgentError::InvalidConfig {
                field: "maxToolRounds",
                ..
            })
        ));
    }
}
