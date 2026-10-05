//! AI Agent orchestrator.
//!
//! Provides the agentic loop: user message → LLM call → tool execution →
//! LLM call → … → final response. Handles streaming, tool approval,
//! cancellation, and event emission.

pub mod agent;
pub mod config;
pub mod error;
pub mod events;
pub mod links;
pub mod manager;
pub mod personas;
pub mod plan;
pub mod presets;
pub mod run_summary;

pub use config::AgentConfig;
pub use error::AgentError;
pub use events::AgentEvent;
pub use links::{AiLink, AiLinkInput, AiLinkKind, LinkStore};
pub use manager::AgentManager;
pub use personas::{AiPersona, AiPersonaInput, PersonaStore};
pub use plan::{AiPlan, AiPlanStatus, AiPlanStep, AiPlanStepRefusal, AiPlanStepStatus, PlanStore};
pub use run_summary::{
    AiRunRefusal, AiRunStepTotals, AiRunSummary, AiRunToolOutcome, AiRunToolRun, RunLedger,
};
