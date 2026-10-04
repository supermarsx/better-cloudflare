//! AI tool bridge between the AI provider system and the MCP tool catalogue.
//!
//! Converts MCP tool descriptors to AI provider `ToolDefinition`s, executes
//! tool calls, and enforces the AI permission policy at the point of dispatch
//! (see [`permissions`] for the algorithm and [`executor`] for the gate).

pub mod converter;
pub mod error;
pub mod executor;
pub mod permissions;
pub mod registry;
pub mod safety;

pub use error::ToolExecutionError;
pub use executor::ToolExecutor;
pub use permissions::{
    AiPermissionMode, AiPermissions, AiToolDescriptor, AiToolPermission, PermissionDecision,
    ToolClassification,
};
pub use registry::ToolRegistry;
pub use safety::{SafetyPolicy, ToolApproval};
