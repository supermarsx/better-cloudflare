//! Tool registry: keeps the active set of tools available to the AI.

use std::collections::HashSet;
use tokio::sync::RwLock;

use bc_ai_provider::ToolDefinition;
use bc_mcp::tools::McpToolDescriptor;

use crate::converter;

/// Registry of tools available to the AI agent.
#[derive(Default)]
pub struct ToolRegistry {
    /// Set of enabled tool names.
    enabled: RwLock<HashSet<String>>,
    /// Cached tool definitions.
    cached_definitions: RwLock<Vec<ToolDefinition>>,
}

impl ToolRegistry {
    /// Refresh from the MCP tool catalogue.
    pub async fn refresh_from_mcp(&self) {
        let descriptors = bc_mcp::available_tool_definitions();
        let enabled = self.enabled.read().await;

        let defs: Vec<ToolDefinition> = descriptors
            .iter()
            .filter(|d| {
                if enabled.is_empty() {
                    d.enabled
                } else {
                    enabled.contains(&d.name)
                }
            })
            .map(converter::mcp_to_provider)
            .collect();

        drop(enabled);
        *self.cached_definitions.write().await = defs;
    }

    /// Initialize with all MCP tools enabled.
    pub async fn init_all(&self) {
        let descriptors = bc_mcp::available_tool_definitions();
        let names: HashSet<String> = descriptors.iter().map(|d| d.name.clone()).collect();
        let defs: Vec<ToolDefinition> = descriptors
            .iter()
            .filter(|d| d.enabled)
            .map(converter::mcp_to_provider)
            .collect();

        *self.enabled.write().await = names;
        *self.cached_definitions.write().await = defs;
    }

    /// Get current tool definitions.
    pub async fn definitions(&self) -> Vec<ToolDefinition> {
        self.cached_definitions.read().await.clone()
    }

    /// Set specific enabled tools.
    pub async fn set_enabled(&self, names: HashSet<String>) {
        *self.enabled.write().await = names;
        self.refresh_from_mcp().await;
    }

    /// Check if a specific tool is enabled.
    pub async fn is_enabled(&self, name: &str) -> bool {
        let enabled = self.enabled.read().await;
        if enabled.is_empty() {
            true
        } else {
            enabled.contains(name)
        }
    }

    /// Get all available MCP tool descriptors.
    pub fn available_descriptors(&self) -> Vec<McpToolDescriptor> {
        bc_mcp::available_tool_definitions()
    }
}
