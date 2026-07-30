//! Chat conversation management for the AI assistant.
//!
//! Handles conversation lifecycle, message history, context
//! window management, and system prompt construction.

pub mod context;
pub mod conversation;
pub mod error;
pub mod history;
pub mod limits;
pub mod system;
pub mod types;

pub use conversation::ChatManager;
pub use error::ChatError;
pub use types::*;
