//! AI tool bridge between the AI provider system and the MCP tool catalogue.
//!
//! Converts MCP tool descriptors to AI provider `ToolDefinition`s, executes
//! tool calls, and enforces the AI permission policy at the point of dispatch
//! (see [`permissions`] for the algorithm and [`executor`] for the gate).
//!
//! Dispatch is governed by two layers composed as an intersection: the
//! application's canonical MCP grants decide what may happen at all, and the
//! assistant's own permissions can only narrow that further. See
//! [`executor::ToolExecutor`].

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
    RefusalSource, ToolAvailability, ToolClassification,
};
pub use registry::ToolRegistry;
pub use safety::{SafetyPolicy, ToolApproval};
