//! AI tool bridge between the AI provider system and the MCP tool catalogue.
//!
//! Converts MCP tool descriptors to AI provider `ToolDefinition`s, executes
//! tool calls, and enforces safety policies for destructive operations.

pub mod converter;
pub mod executor;
pub mod registry;
pub mod safety;

pub use executor::ToolExecutor;
pub use registry::ToolRegistry;
pub use safety::{SafetyPolicy, ToolApproval};
