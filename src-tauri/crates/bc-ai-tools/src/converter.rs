//! Convert between MCP tool descriptors and AI provider tool definitions.

use bc_ai_provider::ToolDefinition;
use bc_mcp::tools::McpToolDescriptor;

/// Convert an MCP tool descriptor to an AI provider tool definition.
pub fn mcp_to_provider(descriptor: &McpToolDescriptor) -> ToolDefinition {
    ToolDefinition {
        name: descriptor.name.clone(),
        description: descriptor.description.clone(),
        input_schema: descriptor.input_schema.clone(),
    }
}

/// Convert all enabled MCP tools to AI provider tool definitions.
pub fn all_enabled_tools(descriptors: &[McpToolDescriptor]) -> Vec<ToolDefinition> {
    descriptors
        .iter()
        .filter(|d| d.enabled)
        .map(mcp_to_provider)
        .collect()
}

/// Filter tools by category.
pub fn tools_by_category(
    descriptors: &[McpToolDescriptor],
    category: &str,
) -> Vec<ToolDefinition> {
    descriptors
        .iter()
        .filter(|d| d.enabled && d.category == category)
        .map(mcp_to_provider)
        .collect()
}
