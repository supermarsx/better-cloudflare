//! AI Agent orchestrator.
//!
//! Provides the agentic loop: user message → LLM call → tool execution →
//! LLM call → … → final response. Handles streaming, tool approval,
//! cancellation, and event emission.

pub mod agent;
pub mod config;
pub mod events;
pub mod manager;
pub mod presets;

pub use config::AgentConfig;
pub use events::AgentEvent;
pub use manager::AgentManager;
