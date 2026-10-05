//! Plan and todo state for the assistant: proposed by the model, approved by
//! the user, executed by the harness.
//!
//! The division of labour is the whole point, and it is enforced by the shape
//! of the types rather than by documentation:
//!
//! * The model gets two tools, [`PLAN_PROPOSE_TOOL`] and
//!   [`PLAN_REVISE_TOOL`], whose input ([`AiPlanStepInput`]) has no `status`,
//!   `result`, `refusal`, `id` or `index` field and rejects unknown fields.
//!   There is therefore no wire form in which the model can approve a plan,
//!   run a step, or declare its own work done.
//! * The user approves, runs and cancels through the `ai_*_plan` commands.
//! * The harness executes, and it executes through
//!   [`bc_ai_tools::ToolExecutor`] — the same gate every other tool call goes
//!   through, with no second path.
//!
//! Permissions are resolved through [`ToolExecutor::gate`] *twice*: once when
//! the plan is proposed, so the user can see which steps cannot run and which
//! of the two permission layers stops them before approving anything, and
//! again immediately before each step runs, because grants and per-tool
//! overrides can change between approval and execution. A plan approved an
//! hour ago carries no permission of its own.
//!
//! One plan per conversation. Plans live in memory only, like conversations,
//! and are lost on restart.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use uuid::Uuid;

use bc_ai_provider::limits::{serialized_len_limited, MAX_TOOL_NAME_BYTES, MAX_TOOL_RESULT_BYTES};
use bc_ai_provider::{ToolCall, ToolDefinition, ToolResult};
use bc_ai_tools::permissions::RefusalSource;
use bc_ai_tools::{ToolExecutor, ToolGateDecision};

use crate::error::AgentError;

// ─── Bounds ────────────────────────────────────────────────────────────────
//
// A plan arrives from a model and is therefore untrusted input. Every field
// the model supplies is bounded, and the store itself is bounded so that a
// model which proposes a plan per conversation cannot grow retained state
// without limit.

/// Steps in one plan. A plan the user cannot read in one screenful is not a
/// plan they can meaningfully approve, which is what this cap is really for.
pub const MAX_PLAN_STEPS: usize = 32;

/// Plans retained at once. One plan per conversation and conversations are
/// already capped, so this is the same number — enforced here too, because a
/// conversation evicted by `bc_ai_chat` would otherwise leave its plan behind
/// for ever.
///
/// Spelled as a literal rather than as an alias of
/// `bc_ai_chat::limits::MAX_CONVERSATIONS` so the frontend bounds contract
/// test can read it: that test parses numeric literals out of the Rust source
/// and an alias would fail to parse rather than assert anything. The
/// compile-time assertion below is what keeps the two from drifting, which is
/// strictly stronger than an alias — drift becomes a build failure.
pub const MAX_RETAINED_PLANS: usize = 128;
const _: () = assert!(
    MAX_RETAINED_PLANS == bc_ai_chat::limits::MAX_CONVERSATIONS,
    "MAX_RETAINED_PLANS must stay equal to bc_ai_chat::limits::MAX_CONVERSATIONS"
);

/// Total retained plan bytes, enforced by evicting the least recently updated
/// plans. A quarter of `bc_ai_chat::limits::MAX_GLOBAL_RETAINED_BYTES`: plans
/// summarise work, so they should never approach the size of the transcripts
/// they summarise.
pub const MAX_RETAINED_PLAN_BYTES: usize = bc_ai_chat::limits::MAX_GLOBAL_RETAINED_BYTES / 4;

/// A plan title is a title, bounded exactly like a conversation's.
pub const MAX_PLAN_TITLE_BYTES: usize = bc_ai_chat::limits::MAX_TITLE_BYTES;

/// Same ceiling as the plan title: a step title is one line of UI.
pub const MAX_PLAN_STEP_TITLE_BYTES: usize = bc_ai_chat::limits::MAX_TITLE_BYTES;

/// A step detail is a paragraph explaining the step to the user, not a
/// document.
pub const MAX_PLAN_STEP_DETAIL_BYTES: usize = 4 * 1024;

/// Serialized arguments for one step.
///
/// Deliberately tighter than `bc_ai_provider::limits::MAX_TOOL_ARGUMENT_BYTES`,
/// which bounds a call *in flight*: a plan retains up to [`MAX_PLAN_STEPS`] of
/// these, so the in-flight bound would permit 8 MiB of retained arguments per
/// plan. A step that validates here is always inside the executor's own
/// argument bound as well, so planning cannot build a call that dispatch will
/// refuse for its size.
pub const MAX_PLAN_STEP_ARGUMENT_BYTES: usize = 8 * 1024;

/// Retained result or refusal text per step. The full tool output is bounded
/// by `MAX_TOOL_RESULT_BYTES` at dispatch; what the plan keeps is an excerpt
/// for display, truncated rather than refused — the step really ran, and
/// discarding the outcome because it was long would lose the only record of
/// it.
pub const MAX_PLAN_STEP_RESULT_BYTES: usize = 4 * 1024;

/// User-configurable plan limits, each bounded by the constant of the same
/// name above. [`Default`] is every hard ceiling.
///
/// The ceilings are ceilings, not defaults waiting to be replaced:
/// [`PlanLimits::clamped`] folds a configured value into `1..=CEILING`, and
/// [`PlanStore::set_limits`] is the only way to install one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanLimits {
    /// Steps one plan may have.
    pub max_plan_steps: usize,
    /// Plans retained at once.
    pub max_retained_plans: usize,
}

impl Default for PlanLimits {
    fn default() -> Self {
        Self {
            max_plan_steps: MAX_PLAN_STEPS,
            max_retained_plans: MAX_RETAINED_PLANS,
        }
    }
}

impl PlanLimits {
    /// Fold every field into `1..=CEILING`. Zero would make a plan
    /// unrepresentable rather than unlimited.
    #[must_use]
    pub fn clamped(self) -> Self {
        Self {
            max_plan_steps: self.max_plan_steps.clamp(1, MAX_PLAN_STEPS),
            max_retained_plans: self.max_retained_plans.clamp(1, MAX_RETAINED_PLANS),
        }
    }
}

// ─── Model-facing tool surface ─────────────────────────────────────────────

/// Name of the tool the model uses to propose a plan.
pub const PLAN_PROPOSE_TOOL: &str = "plan_propose";
/// Name of the tool the model uses to replace the steps of a draft plan.
pub const PLAN_REVISE_TOOL: &str = "plan_revise";

/// Prefix of the tool-call id a plan step is approved under.
///
/// A step that resolves to `ask` is approved through the *existing*
/// `ai_approve_tool_call` command, which recognises this prefix and routes the
/// approval to the step instead of to a pending tool call in the transcript.
/// No second approval command, and no second approval event.
pub const PLAN_STEP_TOOL_CALL_PREFIX: &str = "plan-step-";

/// What the model is told after a successful propose or revise. It explains
/// the boundary it cannot cross, because a model that believes it can mark
/// its own work done will narrate having done so.
const PLAN_TOOL_NOTE: &str = "The plan is a draft until the user approves it. \
You cannot approve a plan, run a step, or set a step's status: the user \
approves and the application runs the steps. Do not claim any step is done. \
Steps reported as blocked cannot run under the current tool permissions — \
revise them or tell the user which permission list to change.";

// ─── Types ─────────────────────────────────────────────────────────────────

/// Where one step has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiPlanStepStatus {
    /// Not started. Its tool, if it names one, is currently permitted.
    Pending,
    /// Its tool is refused by one of the two permission layers, so the
    /// harness will not run it. [`AiPlanStep::refusal`] says which layer.
    Blocked,
    /// Its tool needs explicit user approval before it runs.
    AwaitingApproval,
    /// Dispatched; the tool has not returned yet.
    Running,
    /// Ran and succeeded.
    Done,
    /// Nothing for the harness to run: the step names no tool, so it is the
    /// user's to carry out.
    Skipped,
    /// Ran and failed, or was cancelled or timed out before it returned.
    Failed,
}

impl AiPlanStepStatus {
    /// Stable name for error messages, matching the wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Blocked => "blocked",
            Self::AwaitingApproval => "awaitingApproval",
            Self::Running => "running",
            Self::Done => "done",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }

    /// Whether the harness considers this step finished with.
    pub const fn is_complete(self) -> bool {
        matches!(self, Self::Done | Self::Skipped)
    }
}

/// Which permission layer refuses a step, and why.
///
/// The two layers are configured in different places, so a user looking at a
/// blocked step has to be told which one to go and change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPlanStepRefusal {
    /// `assistantPolicy` — the AI assistant's own mode and per-tool
    /// overrides. `mcpGrants` — the application's MCP tool permissions.
    pub source: RefusalSource,
    pub reason: String,
}

/// One step of a plan.
///
/// `id`, `index`, `status`, `result` and `refusal` are all written by the
/// harness. The model supplies only the fields of [`AiPlanStepInput`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPlanStep {
    pub id: Uuid,
    /// Position in the plan, zero-based. Steps run in this order.
    pub index: usize,
    pub title: String,
    pub detail: String,
    /// The tool this step runs, if any. A step naming no tool is the user's
    /// to carry out and is [`AiPlanStepStatus::Skipped`] when run.
    pub tool: Option<String>,
    pub arguments: Option<Value>,
    pub status: AiPlanStepStatus,
    /// Bounded excerpt of the outcome: the tool output, the failure, or the
    /// reason approval is being asked for.
    pub result: Option<String>,
    pub refusal: Option<AiPlanStepRefusal>,
}

impl AiPlanStep {
    fn retained_bytes(&self) -> usize {
        let arguments = self
            .arguments
            .as_ref()
            .map_or(0, |value| value.to_string().len());
        let refusal = self
            .refusal
            .as_ref()
            .map_or(0, |refusal| refusal.reason.len());
        128usize
            .saturating_add(self.title.len())
            .saturating_add(self.detail.len())
            .saturating_add(self.tool.as_ref().map_or(0, String::len))
            .saturating_add(arguments)
            .saturating_add(self.result.as_ref().map_or(0, String::len))
            .saturating_add(refusal)
    }
}

/// Where the plan as a whole has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiPlanStatus {
    /// Proposed, not yet approved. Nothing can run.
    Draft,
    /// The user approved it. No step has started.
    Approved,
    /// At least one step has started, and none is blocked, awaiting approval
    /// or failed.
    Running,
    /// A run stopped on a step that is blocked or awaiting approval. The user
    /// can change permissions, or approve, and run again.
    Paused,
    /// Every step is done or skipped.
    Done,
    /// A step failed. Earlier steps may have completed; their statuses say so.
    Failed,
    /// Cancelled by the user. Final.
    Cancelled,
}

impl AiPlanStatus {
    /// Stable name for error messages, matching the wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Approved => "approved",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// A plan: one per conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPlan {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub title: String,
    pub status: AiPlanStatus,
    pub steps: Vec<AiPlanStep>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl AiPlan {
    fn step(&self, step_id: Uuid) -> Option<&AiPlanStep> {
        self.steps.iter().find(|step| step.id == step_id)
    }

    fn step_mut(&mut self, step_id: Uuid) -> Option<&mut AiPlanStep> {
        self.steps.iter_mut().find(|step| step.id == step_id)
    }

    fn retained_bytes(&self) -> usize {
        self.steps.iter().map(AiPlanStep::retained_bytes).fold(
            256usize.saturating_add(self.title.len()),
            usize::saturating_add,
        )
    }

    /// Recompute the plan status from its steps, after a step outcome.
    ///
    /// Only called once execution has started, so `Running` is the right
    /// fallback: a plan with pending steps left and nothing wrong is running.
    /// A cancelled plan is final and is never recomputed out of that state.
    fn recompute_status(&mut self) {
        if matches!(self.status, AiPlanStatus::Cancelled) {
            return;
        }
        self.status = if self.steps.iter().all(|step| step.status.is_complete()) {
            AiPlanStatus::Done
        } else if self
            .steps
            .iter()
            .any(|step| step.status == AiPlanStepStatus::Failed)
        {
            AiPlanStatus::Failed
        } else if self.steps.iter().any(|step| {
            matches!(
                step.status,
                AiPlanStepStatus::Blocked | AiPlanStepStatus::AwaitingApproval
            )
        }) {
            AiPlanStatus::Paused
        } else {
            AiPlanStatus::Running
        };
    }
}

// ─── Model-supplied input ──────────────────────────────────────────────────

/// The model-supplied half of a step.
///
/// `deny_unknown_fields` is load-bearing, not tidiness: it is what makes
/// `{"title": "…", "status": "done"}` a refused call rather than a silently
/// ignored field. Without it a model could plausibly believe it had marked
/// its own work complete, and would narrate having done so.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiPlanStepInput {
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub arguments: Option<Value>,
}

/// Arguments of [`PLAN_PROPOSE_TOOL`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiPlanProposal {
    pub title: String,
    pub steps: Vec<AiPlanStepInput>,
}

/// Arguments of [`PLAN_REVISE_TOOL`]. The plan is identified by the
/// conversation, not by the model: there is one plan per conversation, so the
/// model cannot address another conversation's plan.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiPlanRevision {
    pub steps: Vec<AiPlanStepInput>,
}

// ─── Validation ────────────────────────────────────────────────────────────

fn invalid(field: &'static str, message: impl Into<String>) -> AgentError {
    AgentError::InvalidPlan {
        field,
        message: message.into(),
    }
}

fn limit(resource: &'static str, limit: usize, actual: usize) -> AgentError {
    AgentError::PlanLimit {
        resource,
        limit,
        actual,
    }
}

/// Reject control characters in plan text. A title carrying them corrupts the
/// UI; a detail carrying them can forge structure in anything the text is
/// pasted into. Line breaks and tabs stay legal in multiline prose.
fn validate_text(
    field: &'static str,
    value: &str,
    ceiling: usize,
    multiline: bool,
) -> Result<(), AgentError> {
    if value.len() > ceiling {
        return Err(limit(field_resource(field), ceiling, value.len()));
    }
    if value
        .chars()
        .any(|value| value.is_control() && !(multiline && matches!(value, '\n' | '\r' | '\t')))
    {
        return Err(invalid(
            field,
            if multiline {
                "must not contain control characters other than tab, carriage return or newline"
            } else {
                "must not contain control characters"
            },
        ));
    }
    Ok(())
}

/// Resource name for a limit error, so an over-long field is reported as a
/// limit rather than as a validation failure.
fn field_resource(field: &'static str) -> &'static str {
    match field {
        "title" => "plan title",
        "detail" => "plan step detail",
        "tool" => "plan step tool name",
        _ => "plan field",
    }
}

fn validate_step_input(index: usize, input: &AiPlanStepInput) -> Result<(), AgentError> {
    validate_text("title", &input.title, MAX_PLAN_STEP_TITLE_BYTES, false)?;
    if input.title.trim().is_empty() {
        return Err(invalid("title", format!("step {index} must have a title")));
    }
    validate_text("detail", &input.detail, MAX_PLAN_STEP_DETAIL_BYTES, true)?;

    match &input.tool {
        Some(tool) => {
            validate_text("tool", tool, MAX_TOOL_NAME_BYTES, false)?;
            if tool.is_empty()
                || !tool
                    .chars()
                    .all(|value| value.is_ascii_alphanumeric() || value == '_' || value == '-')
            {
                return Err(invalid(
                    "tool",
                    format!("step {index} names a tool with characters no tool name can contain"),
                ));
            }
        }
        // Arguments for no tool would be shown to the user as if something
        // were going to be called with them.
        None if input.arguments.is_some() => {
            return Err(invalid(
                "arguments",
                format!("step {index} supplies arguments but names no tool"),
            ));
        }
        None => {}
    }

    if let Some(arguments) = &input.arguments {
        if !arguments.is_object() {
            return Err(invalid(
                "arguments",
                format!("step {index} must pass arguments as a JSON object"),
            ));
        }
        serialized_len_limited(
            "plan step arguments",
            arguments,
            MAX_PLAN_STEP_ARGUMENT_BYTES,
        )
        .map_err(|error| match error {
            bc_ai_provider::AiProviderError::LimitExceeded {
                resource,
                limit: ceiling,
                actual,
            } => limit(resource, ceiling, actual),
            _ => invalid("arguments", format!("step {index} has invalid arguments")),
        })?;
    }
    Ok(())
}

fn validate_steps(steps: &[AiPlanStepInput], limits: &PlanLimits) -> Result<(), AgentError> {
    if steps.is_empty() {
        return Err(invalid("steps", "a plan must have at least one step"));
    }
    // The configured value is the one reported, so the error names the number
    // the user set rather than the ceiling they never see.
    let max_steps = limits.clamped().max_plan_steps;
    if steps.len() > max_steps {
        return Err(limit("plan steps", max_steps, steps.len()));
    }
    for (index, step) in steps.iter().enumerate() {
        validate_step_input(index, step)?;
    }
    Ok(())
}

/// Keep the leading bytes of `text`, cut on a character boundary, marking the
/// cut so a reader never mistakes an excerpt for the whole output.
fn bounded_excerpt(text: &str, ceiling: usize) -> String {
    if text.len() <= ceiling {
        return text.to_string();
    }
    const MARKER: &str = "… [truncated]";
    let budget = ceiling.saturating_sub(MARKER.len());
    let mut end = budget.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{MARKER}", &text[..end])
}

// ─── Permission resolution ─────────────────────────────────────────────────

/// Resolve one step's tool through the executor's own gate and set the step's
/// status accordingly.
///
/// `blocked` is the plan-time projection of a `deny`; `pending` covers both
/// `allow` and `ask`, because `ask` only becomes
/// [`AiPlanStepStatus::AwaitingApproval`] at run time, when there is a user
/// present to ask.
async fn resolve_step(executor: &ToolExecutor, step: &mut AiPlanStep) {
    let Some(tool) = step.tool.clone() else {
        step.status = AiPlanStepStatus::Pending;
        step.refusal = None;
        return;
    };
    match executor.gate(&tool).await {
        ToolGateDecision::Deny { source, reason } => {
            step.status = AiPlanStepStatus::Blocked;
            step.refusal = Some(AiPlanStepRefusal {
                source,
                reason: bounded_excerpt(&reason, MAX_PLAN_STEP_RESULT_BYTES),
            });
        }
        ToolGateDecision::Ask { .. } | ToolGateDecision::Allow => {
            step.status = AiPlanStepStatus::Pending;
            step.refusal = None;
        }
    }
}

/// Build the harness-owned steps from model-supplied input, resolving each
/// named tool as it goes.
async fn build_steps(executor: &ToolExecutor, inputs: Vec<AiPlanStepInput>) -> Vec<AiPlanStep> {
    let mut steps = Vec::with_capacity(inputs.len());
    for (index, input) in inputs.into_iter().enumerate() {
        let mut step = AiPlanStep {
            id: Uuid::new_v4(),
            index,
            title: input.title,
            detail: input.detail,
            tool: input.tool,
            arguments: input.arguments,
            status: AiPlanStepStatus::Pending,
            result: None,
            refusal: None,
        };
        resolve_step(executor, &mut step).await;
        steps.push(step);
    }
    steps
}

// ─── Step dispatch handshake ───────────────────────────────────────────────

/// Whether the user has already approved this particular step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepApproval {
    /// A plain run: a tool resolving to `ask` stops and asks.
    Required,
    /// The user approved this step through `ai_approve_tool_call`, so `ask`
    /// resolves to a run. An approval still cannot satisfy a `deny` — the
    /// executor re-checks, exactly as it does for a chat tool call.
    Granted,
}

/// What [`PlanStore::begin_step`] decided.
#[derive(Debug, Clone)]
pub enum StepDispatch {
    /// Nothing to dispatch; the plan already records the outcome.
    Settled(AiPlan),
    /// Run this call through [`ToolExecutor`], then hand the outcome to
    /// [`PlanStore::finish_step`]. The store has marked the step `running`.
    Dispatch {
        plan_id: Uuid,
        step_id: Uuid,
        tool_call: ToolCall,
        /// Passed to the executor as `force`: true only for a step the user
        /// explicitly approved.
        approved: bool,
    },
}

/// The outcome of a dispatched step, as the store records it.
#[derive(Debug, Clone)]
pub enum StepOutcome {
    Done {
        result: String,
    },
    Failed {
        reason: String,
    },
    Blocked {
        source: RefusalSource,
        reason: String,
    },
    AwaitingApproval {
        reason: String,
    },
    Skipped,
}

impl StepOutcome {
    fn apply(self, step: &mut AiPlanStep) {
        match self {
            Self::Done { result } => {
                step.status = AiPlanStepStatus::Done;
                step.result = Some(bounded_excerpt(&result, MAX_PLAN_STEP_RESULT_BYTES));
                step.refusal = None;
            }
            Self::Failed { reason } => {
                step.status = AiPlanStepStatus::Failed;
                step.result = Some(bounded_excerpt(&reason, MAX_PLAN_STEP_RESULT_BYTES));
                step.refusal = None;
            }
            Self::Blocked { source, reason } => {
                step.status = AiPlanStepStatus::Blocked;
                // A blocked step ran nothing, so it has no result. The refusal
                // is the whole outcome, and it names the layer to change.
                step.result = None;
                step.refusal = Some(AiPlanStepRefusal {
                    source,
                    reason: bounded_excerpt(&reason, MAX_PLAN_STEP_RESULT_BYTES),
                });
            }
            Self::AwaitingApproval { reason } => {
                step.status = AiPlanStepStatus::AwaitingApproval;
                step.result = Some(bounded_excerpt(&reason, MAX_PLAN_STEP_RESULT_BYTES));
                step.refusal = None;
            }
            Self::Skipped => {
                step.status = AiPlanStepStatus::Skipped;
                step.result = Some("This step names no tool; it is for you to carry out.".into());
                step.refusal = None;
            }
        }
    }
}

// ─── Store ─────────────────────────────────────────────────────────────────

/// Bounded store of plans, keyed by conversation.
///
/// Keying by conversation *is* the cardinality rule: one plan per
/// conversation, with no way to express a second one.
#[derive(Default)]
pub struct PlanStore {
    plans: RwLock<HashMap<Uuid, AiPlan>>,
    /// The user's configured plan limits, already clamped.
    limits: RwLock<PlanLimits>,
}

impl PlanStore {
    /// The plan limits in force, already clamped to the hard ceilings.
    pub async fn limits(&self) -> PlanLimits {
        *self.limits.read().await
    }

    /// Install the user's configured plan limits.
    ///
    /// The value is clamped here, and this is the only way to install one, so
    /// a caller cannot raise a ceiling even by mistake. Lowering a limit
    /// deletes no plan — see [`enforce_limits`].
    pub async fn set_limits(&self, limits: PlanLimits) -> PlanLimits {
        let clamped = limits.clamped();
        *self.limits.write().await = clamped;
        clamped
    }

    /// The conversation's plan, if it has one.
    pub async fn get(&self, conversation_id: Uuid) -> Option<AiPlan> {
        self.plans.read().await.get(&conversation_id).cloned()
    }

    /// Drop the conversation's plan. Returns whether there was one.
    pub async fn delete(&self, conversation_id: Uuid) -> bool {
        self.plans.write().await.remove(&conversation_id).is_some()
    }

    #[cfg(test)]
    async fn count(&self) -> usize {
        self.plans.read().await.len()
    }

    #[cfg(test)]
    async fn retained_bytes(&self) -> usize {
        retained_bytes(&*self.plans.read().await)
    }

    /// Record a model-proposed plan as a draft, resolving every named tool.
    ///
    /// Replaces a plan the user has not committed to — a draft, or one that
    /// has finished or been cancelled. It refuses to replace an `approved`,
    /// `running` or `paused` plan: the user committed to that one, and a model
    /// must not be able to swap it out from under them. They can cancel or
    /// delete it first.
    pub async fn propose(
        &self,
        executor: &ToolExecutor,
        conversation_id: Uuid,
        proposal: AiPlanProposal,
    ) -> Result<AiPlan, AgentError> {
        validate_text("title", &proposal.title, MAX_PLAN_TITLE_BYTES, false)?;
        if proposal.title.trim().is_empty() {
            return Err(invalid("title", "a plan must have a title"));
        }
        let limits = self.limits().await;
        validate_steps(&proposal.steps, &limits)?;

        if let Some(existing) = self.get(conversation_id).await {
            if matches!(
                existing.status,
                AiPlanStatus::Approved | AiPlanStatus::Running | AiPlanStatus::Paused
            ) {
                return Err(AgentError::PlanStateConflict {
                    state: existing.status.as_str(),
                    action: "be replaced by a new proposal",
                });
            }
        }

        let steps = build_steps(executor, proposal.steps).await;
        let now = Utc::now();
        let plan = AiPlan {
            id: Uuid::new_v4(),
            conversation_id,
            title: proposal.title,
            status: AiPlanStatus::Draft,
            steps,
            created_at: now,
            updated_at: now,
        };
        let mut plans = self.plans.write().await;
        plans.insert(conversation_id, plan.clone());
        enforce_limits(&mut plans, conversation_id, &limits);
        Ok(plan)
    }

    /// Replace the steps of a plan still in `draft`.
    pub async fn revise(
        &self,
        executor: &ToolExecutor,
        conversation_id: Uuid,
        revision: AiPlanRevision,
    ) -> Result<AiPlan, AgentError> {
        let limits = self.limits().await;
        validate_steps(&revision.steps, &limits)?;
        let status = self
            .get(conversation_id)
            .await
            .ok_or(AgentError::PlanNotFound)?
            .status;
        if status != AiPlanStatus::Draft {
            return Err(AgentError::PlanStateConflict {
                state: status.as_str(),
                action: "have its steps revised",
            });
        }

        let steps = build_steps(executor, revision.steps).await;
        let mut plans = self.plans.write().await;
        let plan = plans
            .get_mut(&conversation_id)
            .ok_or(AgentError::PlanNotFound)?;
        // Re-check under the write lock: the plan could have been approved
        // between the read above and here.
        if plan.status != AiPlanStatus::Draft {
            return Err(AgentError::PlanStateConflict {
                state: plan.status.as_str(),
                action: "have its steps revised",
            });
        }
        plan.steps = steps;
        plan.updated_at = Utc::now();
        let plan = plan.clone();
        enforce_limits(&mut plans, conversation_id, &limits);
        Ok(plan)
    }

    /// Approve a draft, re-resolving its steps so the user commits against
    /// the permissions in force *now* rather than those at proposal time.
    pub async fn approve(
        &self,
        executor: &ToolExecutor,
        conversation_id: Uuid,
    ) -> Result<AiPlan, AgentError> {
        let mut plan = self
            .get(conversation_id)
            .await
            .ok_or(AgentError::PlanNotFound)?;
        if plan.status != AiPlanStatus::Draft {
            return Err(AgentError::PlanStateConflict {
                state: plan.status.as_str(),
                action: "be approved",
            });
        }
        // Nothing has run in a draft, so re-resolving cannot clobber a result.
        for step in &mut plan.steps {
            resolve_step(executor, step).await;
        }

        let mut plans = self.plans.write().await;
        let stored = plans
            .get_mut(&conversation_id)
            .ok_or(AgentError::PlanNotFound)?;
        if stored.id != plan.id || stored.status != AiPlanStatus::Draft {
            return Err(AgentError::PlanStateConflict {
                state: stored.status.as_str(),
                action: "be approved",
            });
        }
        stored.steps = plan.steps;
        stored.status = AiPlanStatus::Approved;
        stored.updated_at = Utc::now();
        Ok(stored.clone())
    }

    /// Cancel a plan. Final: a cancelled plan advances no further.
    ///
    /// A tool call already in flight is not aborted by this —
    /// `ai_cancel_generation` is the control for in-flight work, and a plan
    /// step runs under it.
    pub async fn cancel(&self, conversation_id: Uuid) -> Result<AiPlan, AgentError> {
        let mut plans = self.plans.write().await;
        let plan = plans
            .get_mut(&conversation_id)
            .ok_or(AgentError::PlanNotFound)?;
        match plan.status {
            // Idempotent: cancelling a cancelled plan is what the caller wanted.
            AiPlanStatus::Cancelled => Ok(plan.clone()),
            AiPlanStatus::Done => Err(AgentError::PlanStateConflict {
                state: plan.status.as_str(),
                action: "be cancelled",
            }),
            _ => {
                plan.status = AiPlanStatus::Cancelled;
                plan.updated_at = Utc::now();
                Ok(plan.clone())
            }
        }
    }

    /// Decide what running one step means right now.
    ///
    /// Re-resolves the step's tool through [`ToolExecutor::gate`] every time,
    /// which is the point: the stored status is a snapshot from proposal or
    /// approval time, and grants and overrides change. A step blocked an hour
    /// ago runs once the grant is added, and a step that was permitted is
    /// blocked once it is withdrawn — without the caller having to know.
    pub async fn begin_step(
        &self,
        executor: &ToolExecutor,
        conversation_id: Uuid,
        step_id: Uuid,
        approval: StepApproval,
    ) -> Result<StepDispatch, AgentError> {
        let (plan_id, tool, arguments) = {
            let plans = self.plans.read().await;
            let plan = plans
                .get(&conversation_id)
                .ok_or(AgentError::PlanNotFound)?;
            ensure_plan_can_run(plan)?;
            let step = plan.step(step_id).ok_or(AgentError::PlanStepNotFound)?;
            ensure_step_can_run(step)?;
            (plan.id, step.tool.clone(), step.arguments.clone())
        };

        // A step naming no tool is the user's to carry out; the harness has
        // nothing to dispatch and says so rather than claiming it ran.
        let Some(tool) = tool else {
            return Ok(StepDispatch::Settled(
                self.settle(plan_id, step_id, StepOutcome::Skipped).await?,
            ));
        };

        let outcome = match executor.gate(&tool).await {
            ToolGateDecision::Deny { source, reason } => {
                Some(StepOutcome::Blocked { source, reason })
            }
            ToolGateDecision::Ask { reason } if approval == StepApproval::Required => {
                Some(StepOutcome::AwaitingApproval { reason })
            }
            ToolGateDecision::Ask { .. } | ToolGateDecision::Allow => None,
        };
        if let Some(outcome) = outcome {
            return Ok(StepDispatch::Settled(
                self.settle(plan_id, step_id, outcome).await?,
            ));
        }

        let tool_call = ToolCall {
            id: step_tool_call_id(step_id),
            name: tool,
            arguments: arguments.unwrap_or_else(|| json!({})),
        };
        {
            let mut plans = self.plans.write().await;
            let plan = plans
                .get_mut(&conversation_id)
                .ok_or(AgentError::PlanNotFound)?;
            if plan.id != plan_id {
                return Err(AgentError::PlanNotFound);
            }
            ensure_plan_can_run(plan)?;
            let step = plan.step_mut(step_id).ok_or(AgentError::PlanStepNotFound)?;
            // Re-check under the write lock: a concurrent run of the same step
            // would otherwise dispatch it twice.
            ensure_step_can_run(step)?;
            step.status = AiPlanStepStatus::Running;
            step.result = None;
            step.refusal = None;
            plan.status = AiPlanStatus::Running;
            plan.updated_at = Utc::now();
        }
        Ok(StepDispatch::Dispatch {
            plan_id,
            step_id,
            tool_call,
            approved: approval == StepApproval::Granted,
        })
    }

    /// Record the outcome of a dispatched step.
    ///
    /// The plan id is checked, so an outcome arriving after the plan was
    /// replaced or deleted is dropped rather than written to a plan it did
    /// not come from.
    pub async fn finish_step(
        &self,
        plan_id: Uuid,
        step_id: Uuid,
        outcome: StepOutcome,
    ) -> Option<AiPlan> {
        let mut plans = self.plans.write().await;
        let plan = plans
            .values_mut()
            .find(|plan| plan.id == plan_id && plan.step(step_id).is_some())?;
        let step = plan.step_mut(step_id)?;
        outcome.apply(step);
        plan.recompute_status();
        plan.updated_at = Utc::now();
        Some(plan.clone())
    }

    /// Write an outcome for a step that was never dispatched.
    async fn settle(
        &self,
        plan_id: Uuid,
        step_id: Uuid,
        outcome: StepOutcome,
    ) -> Result<AiPlan, AgentError> {
        self.finish_step(plan_id, step_id, outcome)
            .await
            .ok_or(AgentError::PlanNotFound)
    }

    /// The step a `plan-step-` tool-call id names, if the conversation's plan
    /// really is waiting for that step to be approved.
    ///
    /// Returning `None` makes `ai_approve_tool_call` fall through to its
    /// existing behaviour, so this cannot shadow a pending tool call from the
    /// transcript.
    pub async fn awaiting_approval_step(
        &self,
        conversation_id: Uuid,
        tool_call_id: &str,
    ) -> Option<Uuid> {
        let step_id = step_id_from_tool_call_id(tool_call_id)?;
        let plans = self.plans.read().await;
        let step = plans.get(&conversation_id)?.step(step_id)?;
        (step.status == AiPlanStepStatus::AwaitingApproval).then_some(step_id)
    }
}

/// Evict the least recently updated plans until the store is inside both
/// caps, never evicting the plan the caller just wrote.
///
/// Mirrors `bc_ai_chat`'s global enforcement, deliberately: plans outlive the
/// conversations they belong to otherwise, because a conversation evicted
/// there is not deleted through any command this store can observe.
fn enforce_limits(plans: &mut HashMap<Uuid, AiPlan>, keep: Uuid, limits: &PlanLimits) {
    // The ceilings without bound — `MAX_RETAINED_PLAN_BYTES` bounds memory,
    // so nothing may be retained above it — then the configured plan count,
    // one plan per write. A lowered setting therefore stops the store growing
    // at once and never reaches back to delete plans the user already had.
    evict_oldest_plans_until(plans, keep, MAX_RETAINED_PLANS, usize::MAX);
    evict_oldest_plans_until(
        plans,
        keep,
        limits.clamped().max_retained_plans,
        bc_ai_chat::limits::MAX_CONFIGURED_EVICTIONS_PER_WRITE,
    );
}

fn evict_oldest_plans_until(
    plans: &mut HashMap<Uuid, AiPlan>,
    keep: Uuid,
    max_plans: usize,
    budget: usize,
) {
    let mut evicted = 0usize;
    while plans.len() > max_plans || retained_bytes(plans) > MAX_RETAINED_PLAN_BYTES {
        if evicted >= budget {
            break;
        }
        let Some(oldest) = plans
            .values()
            .filter(|plan| plan.conversation_id != keep)
            .min_by_key(|plan| (plan.updated_at, plan.created_at, plan.id))
            .map(|plan| plan.conversation_id)
        else {
            break;
        };
        plans.remove(&oldest);
        evicted = evicted.saturating_add(1);
    }
}

fn retained_bytes(plans: &HashMap<Uuid, AiPlan>) -> usize {
    plans
        .values()
        .map(AiPlan::retained_bytes)
        .fold(0usize, usize::saturating_add)
}

fn ensure_plan_can_run(plan: &AiPlan) -> Result<(), AgentError> {
    match plan.status {
        // A failed plan may be run again: re-running re-resolves permissions
        // and retries the step that failed.
        AiPlanStatus::Approved
        | AiPlanStatus::Running
        | AiPlanStatus::Paused
        | AiPlanStatus::Failed => Ok(()),
        state => Err(AgentError::PlanStateConflict {
            state: state.as_str(),
            action: "run a step",
        }),
    }
}

fn ensure_step_can_run(step: &AiPlanStep) -> Result<(), AgentError> {
    match step.status {
        AiPlanStepStatus::Pending
        | AiPlanStepStatus::Blocked
        | AiPlanStepStatus::AwaitingApproval
        | AiPlanStepStatus::Failed => Ok(()),
        state => Err(AgentError::PlanStateConflict {
            state: state.as_str(),
            action: "be run",
        }),
    }
}

/// The tool-call id a step is approved under.
pub fn step_tool_call_id(step_id: Uuid) -> String {
    format!("{PLAN_STEP_TOOL_CALL_PREFIX}{}", step_id.simple())
}

/// Inverse of [`step_tool_call_id`].
pub fn step_id_from_tool_call_id(tool_call_id: &str) -> Option<Uuid> {
    Uuid::parse_str(tool_call_id.strip_prefix(PLAN_STEP_TOOL_CALL_PREFIX)?).ok()
}

// ─── The two model-facing tools ────────────────────────────────────────────

fn step_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "maxLength": MAX_PLAN_STEP_TITLE_BYTES,
                "description": "One line naming what this step does."
            },
            "detail": {
                "type": "string",
                "maxLength": MAX_PLAN_STEP_DETAIL_BYTES,
                "description": "Why this step is needed and what it will change. Shown to the user before they approve."
            },
            "tool": {
                "type": "string",
                "maxLength": MAX_TOOL_NAME_BYTES,
                "description": "The tool this step runs. Omit for a step the user has to carry out themselves; the application will mark such a step skipped rather than run anything."
            },
            "arguments": {
                "type": "object",
                "description": "Arguments for `tool`. Omit when `tool` is omitted."
            }
        },
        "required": ["title"],
        "additionalProperties": false
    })
}

/// The assistant's own planning tools.
///
/// These are *not* MCP tools: they are not in the MCP catalogue, they hold no
/// MCP permission, and they dispatch nothing. They mutate draft plan state and
/// nothing else, which is why the agent loop can serve them locally instead of
/// through the tool executor.
pub fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: PLAN_PROPOSE_TOOL.to_string(),
            description: format!(
                "Propose a plan for the user to approve. Proposing executes nothing. \
                 Each step may name one tool and its arguments; the application resolves \
                 tool permissions for every step now and again before it runs the step, \
                 and reports back any step that cannot run. {PLAN_TOOL_NOTE} \
                 At most {MAX_PLAN_STEPS} steps. Replaces an existing plan only while \
                 that plan is still a draft, finished or cancelled."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "maxLength": MAX_PLAN_TITLE_BYTES,
                        "description": "Short name for the whole plan."
                    },
                    "steps": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_PLAN_STEPS,
                        "items": step_schema(),
                        "description": "The steps, in the order they should run."
                    }
                },
                "required": ["title", "steps"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: PLAN_REVISE_TOOL.to_string(),
            description: format!(
                "Replace every step of the current plan. Only works while the plan is \
                 still a draft: once the user has approved it, the steps are fixed. \
                 {PLAN_TOOL_NOTE}"
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_PLAN_STEPS,
                        "items": step_schema(),
                        "description": "The replacement steps, in the order they should run."
                    }
                },
                "required": ["steps"],
                "additionalProperties": false
            }),
        },
    ]
}

/// Whether a tool name is one of the assistant's own planning tools.
pub fn is_plan_tool(name: &str) -> bool {
    name == PLAN_PROPOSE_TOOL || name == PLAN_REVISE_TOOL
}

/// What the model is told about a plan it just proposed or revised.
fn plan_tool_report(plan: &AiPlan) -> String {
    let blocked: Vec<Value> = plan
        .steps
        .iter()
        .filter(|step| step.status == AiPlanStepStatus::Blocked)
        .map(|step| {
            json!({
                "index": step.index,
                "title": step.title,
                "refusal": step.refusal,
            })
        })
        .collect();
    let report = json!({
        "planId": plan.id,
        "status": plan.status,
        "stepCount": plan.steps.len(),
        "blockedSteps": blocked,
        "note": PLAN_TOOL_NOTE,
    });
    match serialized_len_limited("plan tool result", &report, MAX_TOOL_RESULT_BYTES) {
        Ok(_) => report.to_string(),
        // Unreachable while the field bounds hold; a short answer still tells
        // the model the truth rather than failing the turn.
        Err(_) => format!(
            "Recorded a draft plan with {} steps. {PLAN_TOOL_NOTE}",
            plan.steps.len()
        ),
    }
}

/// Serve one of the assistant's own planning tools, or decline to.
///
/// Returns `None` for any other name, so the caller falls through to the tool
/// executor. The two names this matches are not MCP tools, so falling through
/// would refuse them — see the test below that pins that they can never
/// shadow a real tool.
pub async fn try_execute_plan_tool(
    plans: &PlanStore,
    executor: &ToolExecutor,
    conversation_id: Uuid,
    tool_call: &ToolCall,
) -> Option<ToolResult> {
    if !is_plan_tool(&tool_call.name) {
        return None;
    }
    let outcome = if tool_call.name == PLAN_PROPOSE_TOOL {
        match serde_json::from_value::<AiPlanProposal>(tool_call.arguments.clone()) {
            Ok(proposal) => plans.propose(executor, conversation_id, proposal).await,
            Err(error) => Err(invalid("steps", bounded_excerpt(&error.to_string(), 512))),
        }
    } else {
        match serde_json::from_value::<AiPlanRevision>(tool_call.arguments.clone()) {
            Ok(revision) => plans.revise(executor, conversation_id, revision).await,
            Err(error) => Err(invalid("steps", bounded_excerpt(&error.to_string(), 512))),
        }
    };
    Some(match outcome {
        Ok(plan) => ToolResult {
            tool_call_id: tool_call.id.clone(),
            content: plan_tool_report(&plan),
            is_error: false,
        },
        // A rejected plan is reported to the model as a tool error, the same
        // way a refused call is: it can correct the plan in the same turn
        // instead of stalling.
        Err(error) => ToolResult {
            tool_call_id: tool_call.id.clone(),
            content: bounded_excerpt(
                &format!("{}. {PLAN_TOOL_NOTE}", error.public_message()),
                MAX_PLAN_STEP_RESULT_BYTES,
            ),
            is_error: true,
        },
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use bc_ai_tools::permissions::{AiPermissionMode, AiPermissions, AiToolPermission};
    use bc_ai_tools::ToolRegistry;
    use bc_mcp::{McpGrantHandle, McpGrantSet};

    use super::*;

    const READ_TOOL: &str = "dns_parse_spf";
    const WRITE_TOOL: &str = "cf_delete_dns_record";

    async fn executor(mode: AiPermissionMode, grants: McpGrantHandle) -> ToolExecutor {
        let registry = Arc::new(ToolRegistry::default());
        registry.init_all().await;
        let executor = ToolExecutor::with_registry_and_grants(registry, grants);
        executor
            .try_set_permissions(AiPermissions {
                mode,
                tools: BTreeMap::new(),
            })
            .await
            .expect("valid permissions");
        executor
    }

    async fn open_executor() -> ToolExecutor {
        executor(
            AiPermissionMode::Autonomous,
            McpGrantHandle::new(McpGrantSet::all()),
        )
        .await
    }

    fn step(title: &str, tool: Option<&str>) -> AiPlanStepInput {
        AiPlanStepInput {
            title: title.into(),
            detail: "because the user asked".into(),
            tool: tool.map(str::to_string),
            arguments: tool.map(|_| json!({ "content": "v=spf1 -all" })),
        }
    }

    fn proposal(steps: Vec<AiPlanStepInput>) -> AiPlanProposal {
        AiPlanProposal {
            title: "Tidy the zone".into(),
            steps,
        }
    }

    #[tokio::test]
    async fn a_proposal_is_a_draft_with_harness_owned_step_identity() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();

        let plan = plans
            .propose(
                &executor,
                conversation_id,
                proposal(vec![
                    step("parse", Some(READ_TOOL)),
                    step("tell them", None),
                ]),
            )
            .await
            .expect("valid proposal");

        assert_eq!(plan.status, AiPlanStatus::Draft);
        assert_eq!(plan.conversation_id, conversation_id);
        assert_eq!(plan.steps.len(), 2);
        for (index, step) in plan.steps.iter().enumerate() {
            assert_eq!(step.index, index, "indexes are assigned here, not supplied");
            assert_eq!(step.status, AiPlanStepStatus::Pending);
            assert!(step.result.is_none());
            assert!(step.refusal.is_none());
        }
        assert_ne!(plan.steps[0].id, plan.steps[1].id);
    }

    /// One plan per conversation, and the key is what enforces it.
    #[tokio::test]
    async fn a_conversation_has_at_most_one_plan() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();

        let first = plans
            .propose(&executor, conversation_id, proposal(vec![step("a", None)]))
            .await
            .expect("first draft");
        let second = plans
            .propose(&executor, conversation_id, proposal(vec![step("b", None)]))
            .await
            .expect("a draft may be replaced");
        assert_ne!(first.id, second.id);
        assert_eq!(plans.count().await, 1);
        assert_eq!(
            plans.get(conversation_id).await.expect("stored").id,
            second.id
        );
    }

    /// A plan the user has committed to is not the model's to replace.
    #[tokio::test]
    async fn an_approved_plan_cannot_be_replaced_or_revised_by_the_model() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        plans
            .propose(&executor, conversation_id, proposal(vec![step("a", None)]))
            .await
            .expect("draft");
        plans
            .approve(&executor, conversation_id)
            .await
            .expect("approve");

        let error = plans
            .propose(&executor, conversation_id, proposal(vec![step("z", None)]))
            .await
            .expect_err("an approved plan must not be replaced");
        assert!(matches!(
            error,
            AgentError::PlanStateConflict {
                state: "approved",
                ..
            }
        ));

        let error = plans
            .revise(
                &executor,
                conversation_id,
                AiPlanRevision {
                    steps: vec![step("z", None)],
                },
            )
            .await
            .expect_err("an approved plan's steps are fixed");
        assert!(matches!(
            error,
            AgentError::PlanStateConflict {
                state: "approved",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn only_a_draft_can_be_approved() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        plans
            .propose(&executor, conversation_id, proposal(vec![step("a", None)]))
            .await
            .expect("draft");
        plans
            .approve(&executor, conversation_id)
            .await
            .expect("first approval");
        let error = plans
            .approve(&executor, conversation_id)
            .await
            .expect_err("a second approval must be refused");
        assert!(matches!(
            error,
            AgentError::PlanStateConflict {
                state: "approved",
                action: "be approved"
            }
        ));
    }

    /// The property the whole feature exists for: the user sees which steps
    /// cannot run, and which of the two permission layers stops them, *before*
    /// approving anything.
    #[tokio::test]
    async fn plan_time_resolution_marks_blocked_steps_with_their_refusal_source() {
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();

        // The assistant's own policy refuses the write.
        let read_only = executor(
            AiPermissionMode::ReadOnly,
            McpGrantHandle::new(McpGrantSet::all()),
        )
        .await;
        let plan = plans
            .propose(
                &read_only,
                conversation_id,
                proposal(vec![
                    step("parse", Some(READ_TOOL)),
                    step("delete", Some(WRITE_TOOL)),
                ]),
            )
            .await
            .expect("draft");
        assert_eq!(
            plan.status,
            AiPlanStatus::Draft,
            "a draft with a blocked step is still a draft"
        );
        assert_eq!(plan.steps[0].status, AiPlanStepStatus::Pending);
        assert_eq!(plan.steps[1].status, AiPlanStepStatus::Blocked);
        let refusal = plan.steps[1].refusal.as_ref().expect("a reason");
        assert_eq!(refusal.source, RefusalSource::AssistantPolicy);
        assert!(refusal.reason.contains("read-only"), "{}", refusal.reason);

        // The application's MCP grants refuse it instead.
        let ungranted = executor(AiPermissionMode::Autonomous, McpGrantHandle::default()).await;
        let plan = plans
            .propose(
                &ungranted,
                Uuid::new_v4(),
                proposal(vec![step("parse", Some(READ_TOOL))]),
            )
            .await
            .expect("draft");
        let refusal = plan.steps[0].refusal.as_ref().expect("a reason");
        assert_eq!(refusal.source, RefusalSource::McpGrants);
        assert_ne!(
            refusal.source,
            RefusalSource::AssistantPolicy,
            "the two sources must be distinguishable, or the user cannot tell which list to change"
        );
    }

    /// Mirrors `bc_ai_agent::agent::tests::\
    /// an_ungranted_tool_is_refused_by_the_mcp_layer_and_consumes_rounds`:
    /// the most permissive assistant configuration there is must not let a
    /// plan step run a tool MCP has not granted.
    #[tokio::test]
    async fn an_allow_override_in_autonomous_mode_cannot_run_an_ungranted_plan_step() {
        let executor = executor(AiPermissionMode::Autonomous, McpGrantHandle::default()).await;
        executor
            .try_set_permissions(AiPermissions {
                mode: AiPermissionMode::Autonomous,
                tools: BTreeMap::from([(READ_TOOL.to_string(), AiToolPermission::Allow)]),
            })
            .await
            .expect("valid permissions");
        assert_eq!(
            executor.decision(READ_TOOL).await.effective(),
            AiToolPermission::Allow,
            "the assistant layer must really be saying allow, or this proves nothing"
        );

        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        plans
            .propose(
                &executor,
                conversation_id,
                proposal(vec![step("parse", Some(READ_TOOL))]),
            )
            .await
            .expect("draft");
        let plan = plans
            .approve(&executor, conversation_id)
            .await
            .expect("approve");
        let step_id = plan.steps[0].id;

        let dispatch = plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Required)
            .await
            .expect("the step resolves");
        let plan = match dispatch {
            StepDispatch::Settled(plan) => plan,
            StepDispatch::Dispatch { .. } => {
                panic!("an ungranted tool must never be dispatched from a plan step")
            }
        };
        let step = &plan.steps[0];
        assert_eq!(step.status, AiPlanStepStatus::Blocked);
        assert!(step.result.is_none(), "a blocked step ran nothing");
        assert_eq!(
            step.refusal.as_ref().expect("a reason").source,
            RefusalSource::McpGrants
        );

        // Nor can an explicit approval buy it: approval satisfies an `ask`,
        // never a `deny`.
        let dispatch = plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Granted)
            .await
            .expect("the step resolves");
        assert!(matches!(dispatch, StepDispatch::Settled(_)));
    }

    /// MUTATION PROOF (c): re-resolving before execution is what keeps an
    /// approved plan from carrying stale permission. Make `begin_step` honour
    /// the stored `blocked` status instead of re-resolving, and this fails.
    #[tokio::test]
    async fn a_step_blocked_at_plan_time_runs_once_the_grant_is_added() {
        let registry = Arc::new(ToolRegistry::default());
        registry.init_all().await;
        let mcp = bc_mcp::McpServerManager::default();
        let executor = ToolExecutor::with_registry_and_grants(registry, mcp.grant_handle());
        executor
            .try_set_permissions(AiPermissions {
                mode: AiPermissionMode::Autonomous,
                tools: BTreeMap::new(),
            })
            .await
            .expect("valid permissions");

        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        let plan = plans
            .propose(
                &executor,
                conversation_id,
                proposal(vec![step("parse", Some(READ_TOOL))]),
            )
            .await
            .expect("draft");
        assert_eq!(
            plan.steps[0].status,
            AiPlanStepStatus::Blocked,
            "nothing is granted yet, so the step must be blocked at plan time"
        );
        let step_id = plan.steps[0].id;
        plans
            .approve(&executor, conversation_id)
            .await
            .expect("the user may approve a plan with blocked steps");

        // The user grants the tool after approving — exactly the window the
        // re-resolution exists for.
        mcp.set_enabled_tools(vec![READ_TOOL.to_string()])
            .await
            .expect("grants stored");

        let dispatch = plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Required)
            .await
            .expect("the step resolves");
        match dispatch {
            StepDispatch::Dispatch { tool_call, .. } => {
                assert_eq!(tool_call.name, READ_TOOL);
                assert_eq!(tool_call.id, step_tool_call_id(step_id));
            }
            StepDispatch::Settled(plan) => panic!(
                "a step blocked at plan time must run once the grant is added, \
                 but it settled as {:?}",
                plan.steps[0].status
            ),
        }
    }

    /// And the other direction: a permission withdrawn after approval blocks
    /// the step, rather than running on the strength of a stale `pending`.
    #[tokio::test]
    async fn a_permission_withdrawn_after_approval_blocks_the_step() {
        let registry = Arc::new(ToolRegistry::default());
        registry.init_all().await;
        let executor = ToolExecutor::with_registry_and_grants(
            registry,
            McpGrantHandle::new(McpGrantSet::all()),
        );
        executor
            .try_set_permissions(AiPermissions {
                mode: AiPermissionMode::Autonomous,
                tools: BTreeMap::new(),
            })
            .await
            .expect("valid permissions");

        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        let plan = plans
            .propose(
                &executor,
                conversation_id,
                proposal(vec![step("parse", Some(READ_TOOL))]),
            )
            .await
            .expect("draft");
        assert_eq!(plan.steps[0].status, AiPlanStepStatus::Pending);
        let step_id = plan.steps[0].id;
        plans
            .approve(&executor, conversation_id)
            .await
            .expect("approve");

        executor
            .try_set_permissions(AiPermissions {
                mode: AiPermissionMode::Autonomous,
                tools: BTreeMap::from([(READ_TOOL.to_string(), AiToolPermission::Deny)]),
            })
            .await
            .expect("valid permissions");

        let dispatch = plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Required)
            .await
            .expect("the step resolves");
        match dispatch {
            StepDispatch::Settled(plan) => {
                assert_eq!(plan.steps[0].status, AiPlanStepStatus::Blocked);
                assert_eq!(
                    plan.steps[0].refusal.as_ref().expect("a reason").source,
                    RefusalSource::AssistantPolicy
                );
                assert_eq!(plan.status, AiPlanStatus::Paused);
            }
            StepDispatch::Dispatch { .. } => {
                panic!("a withdrawn permission must stop the step, not be remembered as allowed")
            }
        }
    }

    #[tokio::test]
    async fn a_step_needing_approval_waits_and_then_dispatches_once_approved() {
        let executor = executor(
            AiPermissionMode::Ask,
            McpGrantHandle::new(McpGrantSet::all()),
        )
        .await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        let plan = plans
            .propose(
                &executor,
                conversation_id,
                proposal(vec![step("delete", Some(WRITE_TOOL))]),
            )
            .await
            .expect("draft");
        assert_eq!(
            plan.steps[0].status,
            AiPlanStepStatus::Pending,
            "an `ask` is pending at plan time; there is no user to ask yet"
        );
        let step_id = plan.steps[0].id;
        plans
            .approve(&executor, conversation_id)
            .await
            .expect("approve");

        let dispatch = plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Required)
            .await
            .expect("resolves");
        let plan = match dispatch {
            StepDispatch::Settled(plan) => plan,
            StepDispatch::Dispatch { .. } => panic!("an `ask` must stop and ask"),
        };
        assert_eq!(plan.steps[0].status, AiPlanStepStatus::AwaitingApproval);
        assert_eq!(plan.status, AiPlanStatus::Paused);
        assert!(plan.steps[0]
            .result
            .as_ref()
            .expect("the reason is shown")
            .contains("write/delete"));

        // The id the existing approval command recognises.
        let tool_call_id = step_tool_call_id(step_id);
        assert_eq!(
            plans
                .awaiting_approval_step(conversation_id, &tool_call_id)
                .await,
            Some(step_id)
        );

        let dispatch = plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Granted)
            .await
            .expect("resolves");
        match dispatch {
            StepDispatch::Dispatch {
                tool_call,
                approved,
                ..
            } => {
                assert!(approved, "the executor must be told this was approved");
                assert_eq!(tool_call.name, WRITE_TOOL);
            }
            StepDispatch::Settled(_) => panic!("an approved `ask` must dispatch"),
        }
    }

    /// An approval only ever counts for the step it names.
    #[tokio::test]
    async fn an_unrelated_tool_call_id_does_not_resolve_to_a_plan_step() {
        let executor = executor(
            AiPermissionMode::Ask,
            McpGrantHandle::new(McpGrantSet::all()),
        )
        .await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        let step_id = plans
            .propose(
                &executor,
                conversation_id,
                proposal(vec![step("delete", Some(WRITE_TOOL))]),
            )
            .await
            .expect("draft")
            .steps[0]
            .id;

        // Not a plan-step id at all.
        assert_eq!(
            plans
                .awaiting_approval_step(conversation_id, "call-1")
                .await,
            None
        );
        // Right shape, no such step.
        assert_eq!(
            plans
                .awaiting_approval_step(conversation_id, &step_tool_call_id(Uuid::new_v4()))
                .await,
            None
        );
        // Right step, but it is not awaiting approval.
        assert_eq!(
            plans
                .awaiting_approval_step(conversation_id, &step_tool_call_id(step_id))
                .await,
            None
        );
    }

    #[tokio::test]
    async fn a_step_naming_no_tool_is_skipped_rather_than_claimed_as_done() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        let plan = plans
            .propose(
                &executor,
                conversation_id,
                proposal(vec![step("rotate the key by hand", None)]),
            )
            .await
            .expect("draft");
        let step_id = plan.steps[0].id;
        plans
            .approve(&executor, conversation_id)
            .await
            .expect("approve");

        let dispatch = plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Required)
            .await
            .expect("resolves");
        let plan = match dispatch {
            StepDispatch::Settled(plan) => plan,
            StepDispatch::Dispatch { .. } => panic!("there is no tool to dispatch"),
        };
        assert_eq!(plan.steps[0].status, AiPlanStepStatus::Skipped);
        assert_eq!(plan.status, AiPlanStatus::Done);
    }

    #[tokio::test]
    async fn a_completed_step_is_not_run_a_second_time() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        let plan = plans
            .propose(
                &executor,
                conversation_id,
                proposal(vec![step("a", None), step("b", None)]),
            )
            .await
            .expect("draft");
        let step_id = plan.steps[0].id;
        plans
            .approve(&executor, conversation_id)
            .await
            .expect("approve");
        let plan = match plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Required)
            .await
            .expect("first run")
        {
            StepDispatch::Settled(plan) => plan,
            StepDispatch::Dispatch { .. } => panic!("there is no tool to dispatch"),
        };
        assert_eq!(plan.steps[0].status, AiPlanStepStatus::Skipped);
        assert_eq!(
            plan.status,
            AiPlanStatus::Running,
            "one step done and one to go is a running plan"
        );

        let error = plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Required)
            .await
            .expect_err("a skipped step must not run again");
        assert!(
            matches!(
                error,
                AgentError::PlanStateConflict {
                    state: "skipped",
                    action: "be run"
                }
            ),
            "{error}"
        );

        // Once the whole plan is finished the plan-level guard answers first.
        plans
            .begin_step(
                &executor,
                conversation_id,
                plan.steps[1].id,
                StepApproval::Required,
            )
            .await
            .expect("second run");
        let error = plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Required)
            .await
            .expect_err("a finished plan runs nothing");
        assert!(
            matches!(
                error,
                AgentError::PlanStateConflict {
                    state: "done",
                    action: "run a step"
                }
            ),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_draft_or_cancelled_plan_runs_nothing() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        let plan = plans
            .propose(&executor, conversation_id, proposal(vec![step("a", None)]))
            .await
            .expect("draft");
        let step_id = plan.steps[0].id;

        let error = plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Required)
            .await
            .expect_err("a draft must be approved first");
        assert!(matches!(
            error,
            AgentError::PlanStateConflict {
                state: "draft",
                action: "run a step"
            }
        ));

        plans
            .approve(&executor, conversation_id)
            .await
            .expect("approve");
        plans.cancel(conversation_id).await.expect("cancel");
        let error = plans
            .begin_step(&executor, conversation_id, step_id, StepApproval::Required)
            .await
            .expect_err("a cancelled plan advances no further");
        assert!(matches!(
            error,
            AgentError::PlanStateConflict {
                state: "cancelled",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn cancelling_is_idempotent_but_a_finished_plan_cannot_be_cancelled() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        plans
            .propose(&executor, conversation_id, proposal(vec![step("a", None)]))
            .await
            .expect("draft");
        plans.cancel(conversation_id).await.expect("cancel");
        assert_eq!(
            plans
                .cancel(conversation_id)
                .await
                .expect("idempotent")
                .status,
            AiPlanStatus::Cancelled
        );

        // A finished plan is a different matter.
        let conversation_id = Uuid::new_v4();
        plans
            .propose(&executor, conversation_id, proposal(vec![step("a", None)]))
            .await
            .expect("draft");
        let plan = plans
            .approve(&executor, conversation_id)
            .await
            .expect("approve");
        plans
            .begin_step(
                &executor,
                conversation_id,
                plan.steps[0].id,
                StepApproval::Required,
            )
            .await
            .expect("run");
        assert_eq!(
            plans.get(conversation_id).await.expect("stored").status,
            AiPlanStatus::Done
        );
        assert!(matches!(
            plans.cancel(conversation_id).await,
            Err(AgentError::PlanStateConflict { state: "done", .. })
        ));
    }

    /// MUTATION PROOF (b): the model's tool surface cannot set a step status.
    /// Remove `deny_unknown_fields` from `AiPlanStepInput` and this fails.
    #[tokio::test]
    async fn the_models_tool_surface_cannot_set_a_step_status() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();

        // Every field the harness owns is refused outright, not ignored: a
        // model whose extra field were silently dropped would believe it had
        // marked its own work done.
        for forged in [
            json!({ "title": "x", "status": "done" }),
            json!({ "title": "x", "result": "already handled" }),
            json!({ "title": "x", "refusal": null }),
            json!({ "title": "x", "id": "00000000-0000-0000-0000-000000000000" }),
            json!({ "title": "x", "index": 0 }),
        ] {
            let error = serde_json::from_value::<AiPlanStepInput>(forged.clone())
                .expect_err("a harness-owned field must not deserialize");
            assert!(
                error.to_string().contains("unknown field"),
                "{forged} was accepted with {error}"
            );
        }

        // And the same through the real tool surface, so this is not just a
        // property of a type nobody uses.
        let call = ToolCall {
            id: "call-1".into(),
            name: PLAN_PROPOSE_TOOL.into(),
            arguments: json!({
                "title": "Tidy the zone",
                "steps": [{ "title": "delete it", "tool": WRITE_TOOL, "status": "done" }],
            }),
        };
        let result = try_execute_plan_tool(&plans, &executor, conversation_id, &call)
            .await
            .expect("a plan tool call is served here");
        assert!(
            result.is_error,
            "a forged status must be refused, not quietly dropped: {}",
            result.content
        );
        assert!(
            plans.get(conversation_id).await.is_none(),
            "a refused proposal must not be retained"
        );

        // The honest form of the same call records every step as pending.
        let call = ToolCall {
            id: "call-2".into(),
            name: PLAN_PROPOSE_TOOL.into(),
            arguments: json!({
                "title": "Tidy the zone",
                "steps": [{ "title": "parse it", "tool": READ_TOOL }],
            }),
        };
        let result = try_execute_plan_tool(&plans, &executor, conversation_id, &call)
            .await
            .expect("served");
        assert!(!result.is_error, "{}", result.content);
        let plan = plans.get(conversation_id).await.expect("stored");
        assert_eq!(plan.status, AiPlanStatus::Draft);
        assert_eq!(plan.steps[0].status, AiPlanStepStatus::Pending);
    }

    /// The model has no tool that approves a plan or runs a step. Its whole
    /// surface is these two names, and both only ever produce a draft.
    #[test]
    fn the_models_tool_surface_is_two_tools_and_neither_approves_nor_runs() {
        let definitions = tool_definitions();
        let names: Vec<&str> = definitions
            .iter()
            .map(|definition| definition.name.as_str())
            .collect();
        assert_eq!(names, vec![PLAN_PROPOSE_TOOL, PLAN_REVISE_TOOL]);
        for definition in &definitions {
            let schema = &definition.input_schema;
            assert_eq!(schema["additionalProperties"], json!(false));
            let step = &schema["properties"]["steps"]["items"];
            assert_eq!(step["additionalProperties"], json!(false));
            for owned in ["status", "result", "refusal", "id", "index"] {
                assert!(
                    step["properties"].get(owned).is_none(),
                    "{} advertises the harness-owned field {owned}",
                    definition.name
                );
            }
            assert_eq!(
                schema["properties"]["steps"]["maxItems"],
                json!(MAX_PLAN_STEPS)
            );
        }
    }

    /// The local interception in the agent loop matches two exact names. If
    /// either were ever an MCP tool, the interception would shadow a real tool
    /// and route a dispatch away from the permission gate.
    #[test]
    fn the_plan_tool_names_are_not_mcp_tools() {
        for name in [PLAN_PROPOSE_TOOL, PLAN_REVISE_TOOL] {
            assert!(
                bc_mcp::permissions::permission_for_invocation(name).is_none(),
                "{name} is an MCP tool; the local interception would shadow it"
            );
            assert!(
                !bc_mcp::available_tool_definitions()
                    .iter()
                    .any(|descriptor| descriptor.name == name),
                "{name} is in the MCP catalogue"
            );
        }
        assert!(!is_plan_tool(READ_TOOL));
        assert!(!is_plan_tool(WRITE_TOOL));
    }

    #[tokio::test]
    async fn a_name_that_is_not_a_plan_tool_falls_through_to_the_executor() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let call = ToolCall {
            id: "call-1".into(),
            name: READ_TOOL.into(),
            arguments: json!({}),
        };
        assert!(
            try_execute_plan_tool(&plans, &executor, Uuid::new_v4(), &call)
                .await
                .is_none(),
            "only the two plan tools are served locally"
        );
    }

    #[tokio::test]
    async fn untrusted_plan_input_is_bounded_in_every_field() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();

        let cases: Vec<(&'static str, AiPlanProposal)> = vec![
            (
                "plan title",
                AiPlanProposal {
                    title: "t".repeat(MAX_PLAN_TITLE_BYTES + 1),
                    steps: vec![step("a", None)],
                },
            ),
            (
                "plan steps",
                proposal(
                    (0..=MAX_PLAN_STEPS)
                        .map(|index| step(&format!("step {index}"), None))
                        .collect(),
                ),
            ),
            (
                "plan title",
                proposal(vec![AiPlanStepInput {
                    title: "s".repeat(MAX_PLAN_STEP_TITLE_BYTES + 1),
                    ..step("a", None)
                }]),
            ),
            (
                "plan step detail",
                proposal(vec![AiPlanStepInput {
                    detail: "d".repeat(MAX_PLAN_STEP_DETAIL_BYTES + 1),
                    ..step("a", None)
                }]),
            ),
            (
                "plan step arguments",
                proposal(vec![AiPlanStepInput {
                    tool: Some(READ_TOOL.into()),
                    arguments: Some(json!({
                        "content": "x".repeat(MAX_PLAN_STEP_ARGUMENT_BYTES)
                    })),
                    ..step("a", None)
                }]),
            ),
        ];
        for (resource, case) in cases {
            let error = plans
                .propose(&executor, conversation_id, case)
                .await
                .expect_err("an unbounded field must be refused");
            match error {
                AgentError::PlanLimit { resource: got, .. } => assert_eq!(got, resource),
                other => panic!("expected a {resource} limit, got {other}"),
            }
        }

        // Structural refusals, reported as validation rather than as limits.
        let invalid: Vec<(&'static str, AiPlanProposal)> = vec![
            ("steps", proposal(Vec::new())),
            (
                "title",
                proposal(vec![AiPlanStepInput {
                    title: "   ".into(),
                    ..step("a", None)
                }]),
            ),
            (
                "title",
                proposal(vec![AiPlanStepInput {
                    title: "forged\u{0}structure".into(),
                    ..step("a", None)
                }]),
            ),
            (
                "tool",
                proposal(vec![AiPlanStepInput {
                    tool: Some("cf list zones; rm -rf".into()),
                    arguments: None,
                    ..step("a", None)
                }]),
            ),
            (
                "arguments",
                proposal(vec![AiPlanStepInput {
                    tool: None,
                    arguments: Some(json!({ "zone_id": "abc" })),
                    ..step("a", None)
                }]),
            ),
            (
                "arguments",
                proposal(vec![AiPlanStepInput {
                    tool: Some(READ_TOOL.into()),
                    arguments: Some(json!("not an object")),
                    ..step("a", None)
                }]),
            ),
            (
                "title",
                AiPlanProposal {
                    title: " ".into(),
                    steps: vec![step("a", None)],
                },
            ),
        ];
        for (field, case) in invalid {
            let error = plans
                .propose(&executor, conversation_id, case)
                .await
                .expect_err("malformed input must be refused");
            match error {
                AgentError::InvalidPlan { field: got, .. } => assert_eq!(got, field),
                other => panic!("expected an invalid {field}, got {other}"),
            }
        }

        assert!(
            plans.get(conversation_id).await.is_none(),
            "nothing refused is retained"
        );
    }

    #[tokio::test]
    async fn the_retained_plan_count_is_capped_and_evicts_the_least_recent() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let first = Uuid::new_v4();
        plans
            .propose(&executor, first, proposal(vec![step("a", None)]))
            .await
            .expect("draft");
        for _ in 0..MAX_RETAINED_PLANS {
            plans
                .propose(&executor, Uuid::new_v4(), proposal(vec![step("a", None)]))
                .await
                .expect("draft");
        }
        assert_eq!(plans.count().await, MAX_RETAINED_PLANS);
        assert!(
            plans.get(first).await.is_none(),
            "the least recently updated plan is the one evicted"
        );
    }

    /// The byte ceiling is the binding one in the worst case: 128 plans of 32
    /// maximal steps would retain far more than the count cap alone permits,
    /// so both are enforced in the same loop.
    #[tokio::test]
    async fn the_retained_plan_bytes_are_capped_below_the_plan_count() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let fat = || AiPlanProposal {
            title: "Tidy the zone".into(),
            steps: (0..MAX_PLAN_STEPS)
                .map(|index| AiPlanStepInput {
                    title: format!("step {index}"),
                    detail: "d".repeat(MAX_PLAN_STEP_DETAIL_BYTES),
                    tool: None,
                    arguments: None,
                })
                .collect(),
        };
        // Enough maximal plans to exceed the byte ceiling well before the
        // count ceiling, so this really measures the bytes.
        let needed = MAX_RETAINED_PLAN_BYTES
            .div_ceil(MAX_PLAN_STEPS * MAX_PLAN_STEP_DETAIL_BYTES)
            .saturating_add(4);
        assert!(
            needed < MAX_RETAINED_PLANS,
            "the byte ceiling must bite before the count ceiling, or it is dead"
        );
        for _ in 0..needed {
            plans
                .propose(&executor, Uuid::new_v4(), fat())
                .await
                .expect("each plan is individually valid");
        }
        assert!(
            plans.retained_bytes().await <= MAX_RETAINED_PLAN_BYTES,
            "retained {} bytes, over the {MAX_RETAINED_PLAN_BYTES} ceiling",
            plans.retained_bytes().await
        );
        assert!(
            plans.count().await < needed,
            "the byte ceiling must have evicted something"
        );
    }

    /// A configured step cap is enforced and reported as the configured
    /// number, so the model is told the limit the user actually set.
    #[tokio::test]
    async fn a_configured_step_cap_is_enforced_and_reported() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let stored = plans
            .set_limits(PlanLimits {
                max_plan_steps: 2,
                ..PlanLimits::default()
            })
            .await;
        assert_eq!(stored.max_plan_steps, 2);

        plans
            .propose(
                &executor,
                Uuid::new_v4(),
                proposal(vec![step("a", None), step("b", None)]),
            )
            .await
            .expect("two steps is inside a cap of two");

        let error = plans
            .propose(
                &executor,
                Uuid::new_v4(),
                proposal(vec![step("a", None), step("b", None), step("c", None)]),
            )
            .await
            .expect_err("three steps is over a cap of two");
        assert!(
            matches!(
                error,
                AgentError::PlanLimit {
                    resource: "plan steps",
                    limit: 2,
                    actual: 3
                }
            ),
            "the error must name the configured cap, not the ceiling: {error}"
        );
    }

    /// Lowering the retained-plan limit below current usage deletes nothing,
    /// then caps growth — the same policy `ChatManager` applies, for the same
    /// reason.
    #[tokio::test]
    async fn lowering_the_retained_plan_limit_deletes_nothing() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let mut conversations = Vec::new();
        for _ in 0..12 {
            let conversation_id = Uuid::new_v4();
            plans
                .propose(&executor, conversation_id, proposal(vec![step("a", None)]))
                .await
                .expect("draft");
            conversations.push(conversation_id);
        }
        assert_eq!(plans.count().await, 12);

        plans
            .set_limits(PlanLimits {
                max_retained_plans: 2,
                ..PlanLimits::default()
            })
            .await;
        assert_eq!(
            plans.count().await,
            12,
            "lowering the limit must not drop a single plan"
        );
        for conversation_id in &conversations {
            assert!(plans.get(*conversation_id).await.is_some());
        }

        // Growth stops at the current level, one plan per write.
        for _ in 0..3 {
            plans
                .propose(&executor, Uuid::new_v4(), proposal(vec![step("a", None)]))
                .await
                .expect("draft");
            assert_eq!(plans.count().await, 12);
        }
    }

    /// Nothing a caller passes may raise a ceiling, and zero clamps up to the
    /// floor rather than making a plan unrepresentable.
    #[tokio::test]
    async fn set_limits_cannot_raise_a_plan_ceiling() {
        let plans = PlanStore::default();
        assert_eq!(
            plans
                .set_limits(PlanLimits {
                    max_plan_steps: usize::MAX,
                    max_retained_plans: usize::MAX,
                })
                .await,
            PlanLimits::default()
        );
        assert_eq!(plans.limits().await, PlanLimits::default());

        let stored = plans
            .set_limits(PlanLimits {
                max_plan_steps: 0,
                max_retained_plans: 0,
            })
            .await;
        assert_eq!(stored.max_plan_steps, 1);
        assert_eq!(stored.max_retained_plans, 1);

        // A floor of one step still accepts a one-step plan.
        let executor = open_executor().await;
        plans
            .propose(
                &executor,
                Uuid::new_v4(),
                proposal(vec![step("the only step", None)]),
            )
            .await
            .expect("a floor of one must leave a plan representable");
    }

    /// The retained-plan ceiling is spelled as a literal so the frontend
    /// bounds test can parse it; this is the assertion that keeps it equal to
    /// the conversation ceiling it mirrors. The `const` assertion above makes
    /// drift a build failure, and this one says why out loud.
    #[test]
    fn the_retained_plan_ceiling_mirrors_the_conversation_ceiling() {
        assert_eq!(
            MAX_RETAINED_PLANS,
            bc_ai_chat::limits::MAX_CONVERSATIONS,
            "one plan per conversation, so the two ceilings are the same number"
        );
    }

    #[tokio::test]
    async fn a_long_step_result_is_excerpted_rather_than_discarded() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        plans
            .propose(
                &executor,
                conversation_id,
                proposal(vec![step("parse", Some(READ_TOOL))]),
            )
            .await
            .expect("draft");
        let plan = plans
            .approve(&executor, conversation_id)
            .await
            .expect("approve");
        let step_id = plan.steps[0].id;

        let plan = plans
            .finish_step(
                plan.id,
                step_id,
                StepOutcome::Done {
                    result: "y".repeat(MAX_PLAN_STEP_RESULT_BYTES * 4),
                },
            )
            .await
            .expect("recorded");
        let result = plan.steps[0].result.as_ref().expect("a result");
        assert!(result.len() <= MAX_PLAN_STEP_RESULT_BYTES);
        assert!(
            result.ends_with("[truncated]"),
            "an excerpt must say that it is one"
        );
        assert_eq!(plan.steps[0].status, AiPlanStepStatus::Done);
        assert_eq!(plan.status, AiPlanStatus::Done);
    }

    #[tokio::test]
    async fn an_outcome_for_a_replaced_plan_is_dropped() {
        let executor = open_executor().await;
        let plans = PlanStore::default();
        let conversation_id = Uuid::new_v4();
        let stale = plans
            .propose(&executor, conversation_id, proposal(vec![step("a", None)]))
            .await
            .expect("draft");
        let stale_step = stale.steps[0].id;
        plans
            .propose(&executor, conversation_id, proposal(vec![step("b", None)]))
            .await
            .expect("replacement draft");

        assert!(
            plans
                .finish_step(
                    stale.id,
                    stale_step,
                    StepOutcome::Done { result: "x".into() }
                )
                .await
                .is_none(),
            "an outcome must never be written to a plan it did not come from"
        );
    }

    #[test]
    fn the_wire_format_is_camel_case() {
        let plan = AiPlan {
            id: Uuid::nil(),
            conversation_id: Uuid::nil(),
            title: "Tidy the zone".into(),
            status: AiPlanStatus::Paused,
            steps: vec![AiPlanStep {
                id: Uuid::nil(),
                index: 0,
                title: "delete".into(),
                detail: "because".into(),
                tool: Some(WRITE_TOOL.into()),
                arguments: Some(json!({ "zone_id": "abc" })),
                status: AiPlanStepStatus::AwaitingApproval,
                result: None,
                refusal: Some(AiPlanStepRefusal {
                    source: RefusalSource::McpGrants,
                    reason: "not granted".into(),
                }),
            }],
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let value = serde_json::to_value(&plan).expect("serializes");
        assert_eq!(value["conversationId"], json!(Uuid::nil()));
        assert_eq!(value["status"], "paused");
        assert!(value.get("conversation_id").is_none());
        assert!(value.get("created_at").is_none());
        assert!(value["createdAt"].is_string());
        let step = &value["steps"][0];
        assert_eq!(step["status"], "awaitingApproval");
        assert_eq!(step["refusal"]["source"], "mcpGrants");
        assert!(step.get("refusal").is_some());

        // Every status spelling, so a renderer switch cannot be written
        // against a name that is not on the wire.
        for (status, wire) in [
            (AiPlanStatus::Draft, "draft"),
            (AiPlanStatus::Approved, "approved"),
            (AiPlanStatus::Running, "running"),
            (AiPlanStatus::Paused, "paused"),
            (AiPlanStatus::Done, "done"),
            (AiPlanStatus::Failed, "failed"),
            (AiPlanStatus::Cancelled, "cancelled"),
        ] {
            assert_eq!(serde_json::to_value(status).expect("serializes"), wire);
            assert_eq!(status.as_str(), wire);
        }
        for (status, wire) in [
            (AiPlanStepStatus::Pending, "pending"),
            (AiPlanStepStatus::Blocked, "blocked"),
            (AiPlanStepStatus::AwaitingApproval, "awaitingApproval"),
            (AiPlanStepStatus::Running, "running"),
            (AiPlanStepStatus::Done, "done"),
            (AiPlanStepStatus::Skipped, "skipped"),
            (AiPlanStepStatus::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_value(status).expect("serializes"), wire);
            assert_eq!(status.as_str(), wire);
        }
    }

    #[test]
    fn a_step_tool_call_id_round_trips_and_is_bounded() {
        let step_id = Uuid::new_v4();
        let id = step_tool_call_id(step_id);
        assert_eq!(step_id_from_tool_call_id(&id), Some(step_id));
        assert!(id.len() <= bc_ai_provider::limits::MAX_TOOL_CALL_ID_BYTES);
        assert_eq!(step_id_from_tool_call_id("call-1"), None);
        assert_eq!(step_id_from_tool_call_id("plan-step-not-a-uuid"), None);
    }

    #[test]
    fn an_excerpt_cuts_on_a_character_boundary() {
        let text = "é".repeat(64);
        let excerpt = bounded_excerpt(&text, 32);
        assert!(excerpt.len() <= 32);
        assert!(excerpt.ends_with("[truncated]"));
        assert_eq!(bounded_excerpt("short", 32), "short");
    }
}
