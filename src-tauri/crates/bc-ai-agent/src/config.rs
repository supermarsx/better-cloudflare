//! Agent configuration.

use serde::{Deserialize, Serialize};

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
