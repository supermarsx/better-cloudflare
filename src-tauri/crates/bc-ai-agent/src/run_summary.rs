//! What the harness actually did in a conversation, as the harness recorded
//! it.
//!
//! The question this answers is "what did you just change in my account", and
//! the answer has to be trustworthy. A recap written by the model is not: a
//! model can claim a record was created that was never created, or omit one
//! that was, and nothing in the transcript contradicts it. So every factual
//! field of [`AiRunSummary`] is derived from the harness's own record of what
//! it dispatched and what came back.
//!
//! **The record is scoped to the conversation, not to a plan run.** It covers
//! both ways a tool can run:
//!
//! * **Plan steps** — written by [`crate::plan::PlanStore::finish_step`], the
//!   single place every step outcome is applied.
//! * **Free-turn calls** — tool calls the model makes in an ordinary turn,
//!   written by the agent loop around its one dispatch, and by the manager
//!   around an approved call.
//!
//! Scoping it to plan runs was the original design and it was wrong. A plan is
//! the exception rather than the rule, so a plan-scoped summary is silent
//! about most tool calls — and a summary that says nothing about a
//! `cf_delete_dns_record` executed in an ordinary turn is worse than no
//! summary at all, because silence reads as "nothing happened".
//!
//! What is derived from what:
//!
//! * `stepTotals` counts [`AiPlanStepStatus`] values, which only the harness
//!   writes — [`crate::plan::AiPlanStepInput`] has no `status` field and
//!   rejects unknown ones, so there is no wire form in which a model can set
//!   one. All zero when the conversation has no plan.
//! * `toolRuns` and `refusals` come from [`RecordedStep`] and
//!   [`RecordedTurnCall`] entries, written only by [`RunLedger`].
//! * `mutatingToolsRun` and `anyChangeAttempted` come from
//!   [`RunRecord::confirmed_mutating`] and the open dispatch attempts —
//!   deliberately **not** from `toolRuns`, which is a bounded window. See
//!   [`MAX_RECORDED_TURN_CALLS`].
//! * `narrative` is the model's prose and is the *only* model-written field.
//!   Nothing above reads it. [`RunRecord::summary`] is the one function that
//!   builds a summary, and it derives no factual field from the narrative;
//!   `a_model_supplied_narrative_cannot_alter_the_totals` in
//!   [`crate::plan`]'s tests pins that.
//!
//! `title` is the plan's own label, which the model proposed, and is `None`
//! when there is no plan rather than being synthesised — a made-up title is a
//! sentence a UI would render as though the model had named the run.
//!
//! One record per conversation, in memory only, like plans and conversations.

use std::collections::{BTreeMap, HashMap, VecDeque};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::RwLock;
use uuid::Uuid;

use bc_ai_provider::limits::MAX_TOOL_NAME_BYTES;
use bc_ai_provider::ToolDefinition;
use bc_ai_tools::executor::ExecutionResult;
use bc_ai_tools::permissions::RefusalSource;
use bc_ai_tools::safety::mutates;

use crate::error::AgentError;
use crate::plan::{
    bounded_excerpt, AiPlan, AiPlanStatus, AiPlanStepStatus, MAX_PLAN_STEPS, MAX_PLAN_TITLE_BYTES,
    MAX_RETAINED_PLANS, MAX_RETAINED_PLAN_BYTES,
};

// ─── Bounds ────────────────────────────────────────────────────────────────

/// Bytes of model-written prose one run summary may carry.
///
/// A narrative is a paragraph beside a table of facts, not a document. It is
/// also the one field a model can fill at will, so it is the one field worth
/// keeping small.
pub const MAX_RUN_NARRATIVE_BYTES: usize = 2 * 1024;

/// Retained bytes of one refusal reason.
///
/// Deliberately far tighter than the plan's own
/// `MAX_PLAN_STEP_RESULT_BYTES`: a refusal reason is one sentence naming a
/// tool and a permission layer, the plan already keeps the full text, and up
/// to [`MAX_PLAN_STEPS`] of these are retained per record.
pub const MAX_RUN_REFUSAL_REASON_BYTES: usize = 512;

/// Free-turn tool calls kept in `toolRuns`, most recent first to be dropped.
///
/// A conversation has no step cap to bound it the way a plan does — the model
/// may call tools on every round of every turn — so this window is bounded
/// and the oldest entries fall out of it.
///
/// **`mutatingToolsRun` is not derived from this window**, and that is the
/// whole reason the window may be lossy: the detailed call list is a
/// convenience, while "did anything change" is the answer the user acts on,
/// so the two are stored separately and only the first is allowed to forget.
pub const MAX_RECORDED_TURN_CALLS: usize = 64;

/// Distinct mutating tool names one record names, never evicted.
///
/// Deduplicated against a registry of around fifty tools, so this is not
/// reachable in practice; it exists so the list cannot grow without bound if
/// the catalogue ever does. On overflow the name is dropped but
/// `anyChangeAttempted` stays true, so the answer that matters survives.
pub const MAX_RECORDED_MUTATING_TOOLS: usize = 128;

/// Dispatch attempts open at once in one conversation.
///
/// The agent loop dispatches strictly sequentially and the approval path
/// handles one call, so one or two is the realistic number; the cap only
/// stops a leak if an attempt is ever opened without being closed.
const MAX_OPEN_ATTEMPTS: usize = 32;

/// Run records retained at once: one per conversation, like plans.
pub const MAX_RETAINED_RUN_SUMMARIES: usize = MAX_RETAINED_PLANS;

/// Total retained run-record bytes, enforced by evicting the least recently
/// touched records. An eighth of the plan ceiling: a record summarises what
/// happened, so it must never approach the size of the plans it summarises.
pub const MAX_RETAINED_RUN_SUMMARY_BYTES: usize = MAX_RETAINED_PLAN_BYTES / 8;

/// One record stays inside this, so the store's ceiling is reachable by count
/// rather than by one pathological record. Asserted rather than assumed.
const MAX_RUN_RECORD_BYTES: usize = MAX_PLAN_STEPS
    * (192 + MAX_TOOL_NAME_BYTES + MAX_RUN_REFUSAL_REASON_BYTES)
    + MAX_RECORDED_TURN_CALLS * (192 + MAX_TOOL_NAME_BYTES + MAX_RUN_REFUSAL_REASON_BYTES)
    + MAX_RECORDED_MUTATING_TOOLS * MAX_TOOL_NAME_BYTES
    + MAX_PLAN_TITLE_BYTES
    + MAX_RUN_NARRATIVE_BYTES
    + 192;
const _: () = assert!(
    MAX_RUN_RECORD_BYTES < MAX_RETAINED_RUN_SUMMARY_BYTES,
    "a single run record must never fill the whole store"
);

/// The model-facing tool that attaches prose to a run summary.
pub const RUN_NARRATE_TOOL: &str = "run_narrate";

/// What the model is told every time it narrates, so it cannot come to
/// believe the narrative is the record.
const NARRATE_TOOL_NOTE: &str =
    "This text is shown beside the application's own record of what it ran, which is what the \
     user is told actually happened. It cannot change any counted or recorded field, and it is \
     dropped if anything else runs afterwards. Do not use it to assert that something ran, \
     succeeded or failed: the record already says so.";

// ─── Wire types ────────────────────────────────────────────────────────────

/// How one tool call ended, as the harness observed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiRunToolOutcome {
    /// Dispatched and returned successfully.
    Ok,
    /// Dispatched and returned an error, or was cancelled or timed out
    /// mid-flight, or is still in flight. The call may have left the harness,
    /// so a write may have landed.
    Failed,
    /// Refused by one of the two permission layers. Nothing was dispatched.
    Denied,
    /// Never dispatched: still pending, waiting for approval, or a plan step
    /// that named no tool and is the user's to carry out.
    NotRun,
}

/// One tool call and how it ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunToolRun {
    pub tool: String,
    /// Position of the plan step this call came from, zero-based, or `None`
    /// for a call the model made in an ordinary turn.
    ///
    /// Optional rather than defaulted: a free-turn call has no step, and an
    /// invented index is exactly the kind of plausible-looking field a UI
    /// renders as fact.
    pub step_index: Option<usize>,
    pub outcome: AiRunToolOutcome,
}

/// One tool a permission layer refused, and which layer refused it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunRefusal {
    pub tool: String,
    /// `assistantPolicy` — the AI assistant's own mode and per-tool
    /// overrides. `mcpGrants` — the application's MCP tool permissions.
    pub source: RefusalSource,
    pub reason: String,
}

/// Plan step counts by status.
///
/// The seven [`AiPlanStepStatus`] values fold into five buckets: `pending`
/// absorbs `pending`, `awaitingApproval` and `running`, which is to say
/// "steps the run has not finished with". The three stay distinguishable in
/// the plan itself; this is a tally, and a run that stopped on an unfinished
/// step is unfinished whichever of the three it stopped on.
///
/// All zero when the conversation has no plan — and a plan always has at
/// least one step, so all-zero means exactly that, matching `planId: null`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunStepTotals {
    pub done: usize,
    pub blocked: usize,
    pub failed: usize,
    pub skipped: usize,
    pub pending: usize,
}

impl AiRunStepTotals {
    /// Tally a plan's steps. Reads only harness-written statuses.
    fn of(plan: &AiPlan) -> Self {
        let mut totals = Self::default();
        for step in &plan.steps {
            let bucket = match step.status {
                AiPlanStepStatus::Done => &mut totals.done,
                AiPlanStepStatus::Blocked => &mut totals.blocked,
                AiPlanStepStatus::Failed => &mut totals.failed,
                AiPlanStepStatus::Skipped => &mut totals.skipped,
                AiPlanStepStatus::Pending
                | AiPlanStepStatus::AwaitingApproval
                | AiPlanStepStatus::Running => &mut totals.pending,
            };
            *bucket = bucket.saturating_add(1);
        }
        totals
    }
}

/// The harness's account of what it ran in one conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunSummary {
    /// The plan this conversation's steps belong to, or `None` when the
    /// conversation has run tools without a plan.
    pub plan_id: Option<Uuid>,
    /// The plan's label, as the model proposed it. `None` when there is no
    /// plan. A caption, not a claim — see the module docs.
    pub title: Option<String>,
    /// When the harness first did something in this conversation that could
    /// change anything: the plan's approval, or the first tool call.
    pub started_at: DateTime<Utc>,
    /// When the harness last stopped acting, or `None` while work is
    /// outstanding — a plan that is not yet `done`/`failed`/`cancelled`, a
    /// step in flight, or a call in flight.
    pub finished_at: Option<DateTime<Utc>>,
    pub step_totals: AiRunStepTotals,
    /// Plan steps that named a tool, in plan order, followed by free-turn
    /// calls in dispatch order. A bounded window — see
    /// [`MAX_RECORDED_TURN_CALLS`] — so a long conversation's oldest calls
    /// fall out of it. `mutatingToolsRun` does not.
    pub tool_runs: Vec<AiRunToolRun>,
    pub refusals: Vec<AiRunRefusal>,
    /// Write tools the harness **dispatched**, deduplicated, in first-dispatch
    /// order, across plan steps and free turns alike.
    ///
    /// Dispatched, not succeeded: a write that returned an error can still
    /// have landed, so leaving it out would be the dangerous direction to be
    /// wrong in. A tool a permission layer refused never left the harness and
    /// is not listed. "Write" is the MCP registry's own effect tier, read
    /// through [`bc_ai_tools::safety::mutates`], never guessed from the name.
    ///
    /// Not derived from `toolRuns`: that window forgets, and this must not.
    /// So a tool may be named here with no matching `toolRuns` entry, in a
    /// conversation long enough to have dropped it.
    ///
    /// Erring that way does over-report in one case: a call the MCP dispatch
    /// boundary rejected on its arguments is listed too, because what comes
    /// back is a message, and the harness cannot tell it apart from an error
    /// the provider returned after acting. "A write was attempted and may
    /// have failed" is the safe reading of an ambiguous one.
    pub mutating_tools_run: Vec<String>,
    /// Whether anything could have changed: a write tool was dispatched, or
    /// one is in flight right now.
    ///
    /// The in-flight half is why this is not simply
    /// `!mutating_tools_run.is_empty()`. Cancelling a plan does not abort a
    /// call already in flight, and a free-turn call is dispatched inside a
    /// turn this command can be called during, so there is a window in which
    /// a write is outstanding and no outcome has been recorded. Answering
    /// "no" in that window would be a false all-clear.
    pub any_change_attempted: bool,
    /// Model-written prose, or `None`. Clearly labelled, and derived from:
    /// nothing. No field above reads it, and the model can write no field
    /// above.
    pub narrative: Option<String>,
}

// ─── The harness's record ──────────────────────────────────────────────────

/// What the harness saw happen to one plan step.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RecordedStep {
    /// The tool the step named. `None` for a step the user carries out.
    tool: Option<String>,
    outcome: AiRunToolOutcome,
    /// Whether the call actually left the harness.
    dispatched: bool,
    /// Whether the tool mutates, by its MCP registry effect tier.
    mutating: bool,
    refusal: Option<AiRunRefusal>,
}

impl RecordedStep {
    /// Derive a record from a step's *current* harness-written state.
    ///
    /// `running` is absent in practice: this is only called from
    /// [`crate::plan::PlanStore::finish_step`], which has just applied a
    /// settled outcome. It is still mapped, and mapped to a dispatch, because
    /// a step in flight is a call that left the harness.
    fn of(status: AiPlanStepStatus, tool: Option<&str>, refusal: Option<AiRunRefusal>) -> Self {
        let (outcome, dispatched) = match status {
            AiPlanStepStatus::Done => (AiRunToolOutcome::Ok, true),
            // Including cancelled and timed out: the manager records those as
            // `failed`, and they are dispatches whose fate is unknown. A step
            // the executor rejected locally also lands here and is
            // over-reported as dispatched — the step status cannot tell the
            // two apart, and over-reporting is the safe direction. The
            // free-turn path below has the executor's own variant and is
            // exact.
            AiPlanStepStatus::Failed | AiPlanStepStatus::Running => {
                (AiRunToolOutcome::Failed, true)
            }
            AiPlanStepStatus::Blocked => (AiRunToolOutcome::Denied, false),
            AiPlanStepStatus::Pending
            | AiPlanStepStatus::AwaitingApproval
            | AiPlanStepStatus::Skipped => (AiRunToolOutcome::NotRun, false),
        };
        Self {
            tool: tool.map(str::to_string),
            outcome,
            dispatched,
            mutating: tool.is_some_and(mutates),
            refusal,
        }
    }

    fn retained_bytes(&self) -> usize {
        192usize
            .saturating_add(self.tool.as_ref().map_or(0, String::len))
            .saturating_add(refusal_bytes(self.refusal.as_ref()))
    }
}

/// What the harness saw happen to one tool call the model made in an ordinary
/// turn, outside any plan.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RecordedTurnCall {
    /// Identifies the dispatch attempt, so closing it updates the entry it
    /// opened rather than guessing by tool name.
    attempt: u64,
    tool: String,
    outcome: AiRunToolOutcome,
    dispatched: bool,
    mutating: bool,
    refusal: Option<AiRunRefusal>,
}

impl RecordedTurnCall {
    fn retained_bytes(&self) -> usize {
        192usize
            .saturating_add(self.tool.len())
            .saturating_add(refusal_bytes(self.refusal.as_ref()))
    }
}

fn refusal_bytes(refusal: Option<&AiRunRefusal>) -> usize {
    refusal.map_or(0, |refusal| {
        refusal.tool.len().saturating_add(refusal.reason.len())
    })
}

/// Read the executor's own verdict on one dispatch attempt.
///
/// The variant is the evidence, not the prose: `Denied` and `Rejected` never
/// reached a tool, `Success` and `Error` did. Nothing here parses a message.
fn observe(tool: &str, result: &ExecutionResult) -> (AiRunToolOutcome, bool, Option<AiRunRefusal>) {
    match result {
        ExecutionResult::Success(_) => (AiRunToolOutcome::Ok, true, None),
        ExecutionResult::Error(_) => (AiRunToolOutcome::Failed, true, None),
        ExecutionResult::Denied { source, result } => (
            AiRunToolOutcome::Denied,
            false,
            Some(AiRunRefusal {
                tool: tool.to_string(),
                source: *source,
                reason: bounded_excerpt(&result.content, MAX_RUN_REFUSAL_REASON_BYTES),
            }),
        ),
        ExecutionResult::NeedsApproval { .. } => (AiRunToolOutcome::NotRun, false, None),
        // A local safety check refused the call before the permission gate,
        // so nothing was dispatched. Unlike the plan path, the variant says
        // so outright.
        ExecutionResult::Rejected(_) => (AiRunToolOutcome::Failed, false, None),
    }
}

/// The harness's record of one conversation's tool use.
#[derive(Debug, Clone)]
pub struct RunRecord {
    plan_id: Option<Uuid>,
    title: Option<String>,
    started_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
    /// Last write of any kind, for eviction order and for `finished_at`.
    touched_at: DateTime<Utc>,
    totals: AiRunStepTotals,
    /// Plan step outcomes, keyed by step index so re-running a step that
    /// failed replaces its outcome instead of describing the plan twice.
    /// Bounded by [`MAX_PLAN_STEPS`].
    steps: BTreeMap<usize, RecordedStep>,
    /// Free-turn calls, oldest first. Bounded by [`MAX_RECORDED_TURN_CALLS`].
    turn_calls: VecDeque<RecordedTurnCall>,
    /// Mutating tools the harness has *confirmed* it dispatched, in
    /// first-dispatch order. Never retracted, never evicted — this is what
    /// `mutatingToolsRun` is built from.
    confirmed_mutating: Vec<String>,
    /// Dispatch attempts opened and not yet closed, by attempt id. A mutating
    /// tool in here counts as a change attempt, and is dropped without trace
    /// if the gate turns out to have refused the call.
    open_attempts: BTreeMap<u64, String>,
    next_attempt: u64,
    /// A plan step the harness dispatched that has not returned yet.
    plan_step_in_flight: bool,
    /// …and whether that step's tool mutates.
    mutating_step_in_flight: bool,
    /// Whether the plan, if any, has reached a terminal status.
    plan_settled: bool,
    narrative: Option<String>,
}

impl RunRecord {
    /// Open a record for a conversation that is about to do something.
    fn opened() -> Self {
        let now = Utc::now();
        Self {
            plan_id: None,
            title: None,
            started_at: now,
            finished_at: None,
            touched_at: now,
            totals: AiRunStepTotals::default(),
            steps: BTreeMap::new(),
            turn_calls: VecDeque::new(),
            confirmed_mutating: Vec::new(),
            open_attempts: BTreeMap::new(),
            next_attempt: 0,
            plan_step_in_flight: false,
            mutating_step_in_flight: false,
            plan_settled: true,
            narrative: None,
        }
    }

    /// When this record was last written, for eviction order.
    fn touched_at(&self) -> DateTime<Utc> {
        self.touched_at
    }

    /// Attach a plan the user has just approved.
    ///
    /// Keeps the conversation's free-turn history and its confirmed mutating
    /// tools — the record is conversation-scoped, and a new plan does not
    /// un-change what the assistant already changed. Clears the *step*
    /// outcomes, because those described a plan that is no longer the one
    /// `planId` names.
    fn attach_plan(&mut self, plan: &AiPlan) {
        if self.plan_id != Some(plan.id) {
            self.steps.clear();
            self.plan_step_in_flight = false;
            self.mutating_step_in_flight = false;
        }
        self.plan_id = Some(plan.id);
        self.title = Some(bounded_excerpt(&plan.title, MAX_PLAN_TITLE_BYTES));
        self.narrative = None;
        self.observe_plan(plan);
    }

    /// Forget the plan half, keeping the free-turn half.
    fn detach_plan(&mut self) {
        self.plan_id = None;
        self.title = None;
        self.steps.clear();
        self.totals = AiRunStepTotals::default();
        self.plan_step_in_flight = false;
        self.mutating_step_in_flight = false;
        self.plan_settled = true;
        self.touch();
    }

    /// Whether this record now accounts for nothing at all.
    ///
    /// A narrative alone does not count: prose describing work that is no
    /// longer recorded is exactly what must not be kept.
    fn is_empty(&self) -> bool {
        self.plan_id.is_none()
            && self.steps.is_empty()
            && self.turn_calls.is_empty()
            && self.confirmed_mutating.is_empty()
            && self.open_attempts.is_empty()
    }

    /// Re-read everything derived from the plan as a whole: the step tally,
    /// whether a step is in flight, and whether the plan has settled.
    ///
    /// Idempotent and self-correcting, so it is safe on every write: each
    /// field is recomputed from the plan rather than accumulated.
    fn observe_plan(&mut self, plan: &AiPlan) {
        self.totals = AiRunStepTotals::of(plan);
        let in_flight: Vec<&str> = plan
            .steps
            .iter()
            .filter(|step| step.status == AiPlanStepStatus::Running)
            .filter_map(|step| step.tool.as_deref())
            .collect();
        self.plan_step_in_flight = !in_flight.is_empty();
        self.mutating_step_in_flight = in_flight.iter().copied().any(mutates);
        self.plan_settled = matches!(
            plan.status,
            AiPlanStatus::Done | AiPlanStatus::Failed | AiPlanStatus::Cancelled
        );
        self.touch();
    }

    /// Record how one plan step settled.
    ///
    /// Drops any narrative: prose written before this outcome describes work
    /// that has since moved on, and showing it beside numbers it no longer
    /// matches is the failure mode this whole module exists to avoid.
    fn record_step(&mut self, plan: &AiPlan, step_index: usize) {
        if let Some(step) = plan.steps.iter().find(|step| step.index == step_index) {
            let refusal = step.refusal.as_ref().map(|refusal| AiRunRefusal {
                tool: step.tool.clone().unwrap_or_default(),
                source: refusal.source,
                reason: bounded_excerpt(&refusal.reason, MAX_RUN_REFUSAL_REASON_BYTES),
            });
            let recorded = RecordedStep::of(step.status, step.tool.as_deref(), refusal);
            if recorded.dispatched && recorded.mutating {
                if let Some(tool) = &recorded.tool {
                    self.confirm_mutating(tool);
                }
            }
            self.steps.insert(step_index, recorded);
            self.narrative = None;
        }
        self.observe_plan(plan);
    }

    /// Note that a free-turn call is about to be dispatched.
    ///
    /// Opened *before* the call leaves, so there is no instant in which a
    /// write is in flight and the summary does not know it. The entry is
    /// provisional — `failed` and dispatched, the safe reading of "we do not
    /// know yet" — and [`Self::close_attempt`] replaces it with the
    /// executor's own verdict, including withdrawing it if the gate refused.
    fn open_attempt(&mut self, tool: &str) -> u64 {
        let attempt = self.next_attempt;
        self.next_attempt = self.next_attempt.saturating_add(1);
        self.open_attempts.insert(attempt, tool.to_string());
        while self.open_attempts.len() > MAX_OPEN_ATTEMPTS {
            let Some(oldest) = self.open_attempts.keys().next().copied() else {
                break;
            };
            self.open_attempts.remove(&oldest);
        }
        self.push_turn_call(RecordedTurnCall {
            attempt,
            tool: tool.to_string(),
            outcome: AiRunToolOutcome::Failed,
            dispatched: true,
            mutating: mutates(tool),
            refusal: None,
        });
        self.narrative = None;
        self.touch();
        attempt
    }

    /// Close a provisional entry for a call whose fate will never be known —
    /// cancelled, timed out, or the conversation closed under it.
    ///
    /// Recorded as dispatched and failed, because it is: the call left the
    /// harness and stopped being observable, which is not the same as not
    /// having happened. Closing it rather than leaving it open is what keeps
    /// `finishedAt` from being pinned to `null` for ever, while the confirmed
    /// mutating list keeps `anyChangeAttempted` true.
    fn abandon_attempt(&mut self, attempt: u64, tool: &str) {
        self.open_attempts.remove(&attempt);
        if mutates(tool) {
            self.confirm_mutating(tool);
        }
        if let Some(entry) = self
            .turn_calls
            .iter_mut()
            .find(|entry| entry.attempt == attempt)
        {
            entry.outcome = AiRunToolOutcome::Failed;
            entry.dispatched = true;
        }
        self.touch();
    }

    /// Replace a provisional entry with what the executor actually returned.
    fn close_attempt(&mut self, attempt: u64, tool: &str, result: &ExecutionResult) {
        self.open_attempts.remove(&attempt);
        let (outcome, dispatched, refusal) = observe(tool, result);
        let mutating = mutates(tool);
        if dispatched && mutating {
            self.confirm_mutating(tool);
        }
        // The window may already have dropped the entry this closes. The
        // confirmation above is what matters and is kept regardless.
        if let Some(entry) = self
            .turn_calls
            .iter_mut()
            .find(|entry| entry.attempt == attempt)
        {
            entry.outcome = outcome;
            entry.dispatched = dispatched;
            entry.refusal = refusal;
        }
        self.touch();
    }

    fn push_turn_call(&mut self, call: RecordedTurnCall) {
        self.turn_calls.push_back(call);
        while self.turn_calls.len() > MAX_RECORDED_TURN_CALLS {
            self.turn_calls.pop_front();
        }
    }

    fn confirm_mutating(&mut self, tool: &str) {
        if self.confirmed_mutating.iter().any(|seen| seen == tool) {
            return;
        }
        if self.confirmed_mutating.len() >= MAX_RECORDED_MUTATING_TOOLS {
            return;
        }
        self.confirmed_mutating.push(tool.to_string());
    }

    /// Mark the record written, and recompute whether work is outstanding.
    fn touch(&mut self) {
        self.touched_at = Utc::now();
        let outstanding =
            !self.plan_settled || self.plan_step_in_flight || !self.open_attempts.is_empty();
        self.finished_at = (!outstanding).then_some(self.touched_at);
    }

    /// Attach the model's prose, already validated by
    /// [`validate_narrative`].
    fn set_narrative(&mut self, narrative: String) {
        self.narrative = Some(narrative);
        self.touched_at = Utc::now();
    }

    /// Project the record into the wire summary.
    ///
    /// Every factual field is computed here from the recorded entries, the
    /// confirmed mutating list and the open attempts. `self.narrative` is
    /// copied across and read by nothing.
    fn summary(&self) -> AiRunSummary {
        let mut tool_runs = Vec::with_capacity(self.steps.len() + self.turn_calls.len());
        let mut refusals = Vec::new();
        for (index, recorded) in &self.steps {
            if let Some(refusal) = &recorded.refusal {
                refusals.push(refusal.clone());
            }
            if let Some(tool) = &recorded.tool {
                tool_runs.push(AiRunToolRun {
                    tool: tool.clone(),
                    step_index: Some(*index),
                    outcome: recorded.outcome,
                });
            }
        }
        for call in &self.turn_calls {
            if let Some(refusal) = &call.refusal {
                refusals.push(refusal.clone());
            }
            tool_runs.push(AiRunToolRun {
                tool: call.tool.clone(),
                step_index: None,
                outcome: call.outcome,
            });
        }

        // A write still in flight counts, and is listed under the same field
        // as a confirmed one: from the user's side "a delete is running" and
        // "a delete ran" are the same answer to "did you change anything".
        let mut mutating_tools_run = self.confirmed_mutating.clone();
        for tool in self.open_attempts.values() {
            if mutates(tool) && !mutating_tools_run.iter().any(|seen| seen == tool) {
                mutating_tools_run.push(tool.clone());
            }
        }

        AiRunSummary {
            plan_id: self.plan_id,
            title: self.title.clone(),
            started_at: self.started_at,
            finished_at: self.finished_at,
            step_totals: self.totals,
            tool_runs,
            refusals,
            any_change_attempted: !mutating_tools_run.is_empty() || self.mutating_step_in_flight,
            mutating_tools_run,
            narrative: self.narrative.clone(),
        }
    }

    /// Bytes this record retains, for the store's byte ceiling.
    fn retained_bytes(&self) -> usize {
        let base = 192usize
            .saturating_add(self.title.as_ref().map_or(0, String::len))
            .saturating_add(self.narrative.as_ref().map_or(0, String::len))
            .saturating_add(
                self.confirmed_mutating
                    .iter()
                    .map(String::len)
                    .fold(0usize, usize::saturating_add),
            );
        let steps = self
            .steps
            .values()
            .map(RecordedStep::retained_bytes)
            .fold(base, usize::saturating_add);
        self.turn_calls
            .iter()
            .map(RecordedTurnCall::retained_bytes)
            .fold(steps, usize::saturating_add)
    }
}

// ─── The ledger ────────────────────────────────────────────────────────────

/// Bounded store of what the harness ran, keyed by conversation.
///
/// Shared between [`crate::plan::PlanStore`] and the agent loop, because
/// there are exactly two places a tool call can be settled and the record has
/// to be complete across both. Everything that writes here is harness code;
/// no model-supplied value reaches any field except `narrative`.
#[derive(Default)]
pub struct RunLedger {
    records: RwLock<HashMap<Uuid, RunRecord>>,
}

impl RunLedger {
    /// The harness's account of this conversation's tool use, if it has run
    /// anything.
    pub async fn summary(&self, conversation_id: Uuid) -> Option<AiRunSummary> {
        self.records
            .read()
            .await
            .get(&conversation_id)
            .map(RunRecord::summary)
    }

    /// Drop a conversation's record.
    pub async fn delete(&self, conversation_id: Uuid) -> bool {
        self.records
            .write()
            .await
            .remove(&conversation_id)
            .is_some()
    }

    /// Attach a plan the user has just approved, opening a record if the
    /// conversation has none.
    pub(crate) async fn attach_plan(&self, plan: &AiPlan) {
        let mut records = self.records.write().await;
        records
            .entry(plan.conversation_id)
            .or_insert_with(RunRecord::opened)
            .attach_plan(plan);
        evict_oldest(&mut records, plan.conversation_id);
    }

    /// Record how one plan step settled.
    ///
    /// Opens a record if there is none: losing the record of a dispatch would
    /// be worse than starting the account late, and `started_at` says which
    /// happened.
    pub(crate) async fn record_step(&self, plan: &AiPlan, step_index: usize) {
        let mut records = self.records.write().await;
        let record = records
            .entry(plan.conversation_id)
            .or_insert_with(RunRecord::opened);
        if record.plan_id != Some(plan.id) {
            record.attach_plan(plan);
        }
        record.record_step(plan, step_index);
        evict_oldest(&mut records, plan.conversation_id);
    }

    /// Forget the plan half of a conversation's record, keeping what it ran
    /// outside the plan.
    ///
    /// Discarding a plan is the user saying "forget this plan", which is not
    /// the same as "forget that you deleted my MX record in the chat": the
    /// record is conversation-scoped, so only the plan half goes. The record
    /// itself is dropped when that leaves nothing in it, so a conversation
    /// that only ever had a discarded plan is back to having no account.
    pub(crate) async fn detach_plan(&self, conversation_id: Uuid) {
        let mut records = self.records.write().await;
        let Some(record) = records.get_mut(&conversation_id) else {
            return;
        };
        record.detach_plan();
        if record.is_empty() {
            records.remove(&conversation_id);
        }
    }

    /// Re-read what the record derives from the plan as a whole. Never opens
    /// a record: a plan cancelled or stepped without ever being approved has
    /// no account to keep.
    pub(crate) async fn observe_plan(&self, plan: &AiPlan) {
        let mut records = self.records.write().await;
        if let Some(record) = records.get_mut(&plan.conversation_id) {
            if record.plan_id == Some(plan.id) {
                record.observe_plan(plan);
            }
        }
    }

    /// Note that a free-turn tool call is about to be dispatched, returning
    /// the attempt id [`Self::close_turn_call`] takes.
    ///
    /// Call this immediately before the one dispatch and close it immediately
    /// after, so a write is never in flight unaccounted for.
    pub async fn open_turn_call(&self, conversation_id: Uuid, tool: &str) -> u64 {
        let mut records = self.records.write().await;
        let attempt = records
            .entry(conversation_id)
            .or_insert_with(RunRecord::opened)
            .open_attempt(tool);
        evict_oldest(&mut records, conversation_id);
        attempt
    }

    /// Replace a provisional free-turn entry with the executor's verdict.
    pub async fn close_turn_call(
        &self,
        conversation_id: Uuid,
        attempt: u64,
        tool: &str,
        result: &ExecutionResult,
    ) {
        let mut records = self.records.write().await;
        if let Some(record) = records.get_mut(&conversation_id) {
            record.close_attempt(attempt, tool, result);
        }
    }

    /// Close a free-turn entry for a call that was cancelled, timed out, or
    /// whose conversation closed under it. See
    /// [`RunRecord::abandon_attempt`].
    pub async fn abandon_turn_call(&self, conversation_id: Uuid, attempt: u64, tool: &str) {
        let mut records = self.records.write().await;
        if let Some(record) = records.get_mut(&conversation_id) {
            record.abandon_attempt(attempt, tool);
        }
    }

    /// Attach the model's prose, and return the summary it now reads as.
    ///
    /// The only write a model can make to a run summary. It touches one
    /// field, and [`RunRecord::summary`] derives nothing from that field.
    pub async fn narrate(
        &self,
        conversation_id: Uuid,
        narrative: &str,
    ) -> Result<AiRunSummary, AgentError> {
        let narrative = validate_narrative(narrative)?;
        let mut records = self.records.write().await;
        let record = records
            .get_mut(&conversation_id)
            .ok_or_else(|| AgentError::InvalidPlan {
                field: "narrative",
                message: "there is nothing recorded in this conversation to narrate".into(),
            })?;
        record.set_narrative(narrative);
        Ok(record.summary())
    }

    #[cfg(test)]
    pub(crate) async fn count(&self) -> usize {
        self.records.read().await.len()
    }
}

/// Evict the least recently touched records until the ledger is inside both
/// its caps, never evicting the record just written.
fn evict_oldest(records: &mut HashMap<Uuid, RunRecord>, keep: Uuid) {
    while records.len() > MAX_RETAINED_RUN_SUMMARIES
        || retained_bytes(records) > MAX_RETAINED_RUN_SUMMARY_BYTES
    {
        let Some(oldest) = records
            .iter()
            .filter(|(conversation_id, _)| **conversation_id != keep)
            .min_by_key(|(conversation_id, record)| (record.touched_at(), **conversation_id))
            .map(|(conversation_id, _)| *conversation_id)
        else {
            break;
        };
        records.remove(&oldest);
    }
}

fn retained_bytes(records: &HashMap<Uuid, RunRecord>) -> usize {
    records
        .values()
        .map(RunRecord::retained_bytes)
        .fold(0usize, usize::saturating_add)
}

// ─── The model-facing narrate tool ─────────────────────────────────────────

/// Reject prose that would corrupt the UI it is rendered into, or that is
/// larger than a paragraph.
pub fn validate_narrative(narrative: &str) -> Result<String, AgentError> {
    if narrative.len() > MAX_RUN_NARRATIVE_BYTES {
        return Err(AgentError::PlanLimit {
            resource: "run narrative",
            limit: MAX_RUN_NARRATIVE_BYTES,
            actual: narrative.len(),
        });
    }
    if narrative.trim().is_empty() {
        return Err(AgentError::InvalidPlan {
            field: "narrative",
            message: "must not be blank".into(),
        });
    }
    if narrative
        .chars()
        .any(|value| value.is_control() && !matches!(value, '\n' | '\r' | '\t'))
    {
        return Err(AgentError::InvalidPlan {
            field: "narrative",
            message: "must not contain control characters other than tab, carriage return or \
                      newline"
                .into(),
        });
    }
    Ok(narrative.to_string())
}

/// Arguments of [`RUN_NARRATE_TOOL`].
///
/// One field, and `deny_unknown_fields`: there is no wire form in which this
/// call carries a total, an outcome or a tool name. That is the point —
/// narrating is the only thing a model can do to a run summary, and a call
/// that tries to do more is refused rather than silently trimmed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiRunNarration {
    pub narrative: String,
}

/// The narrate tool, as offered to the model.
pub fn tool_definition() -> ToolDefinition {
    ToolDefinition {
        name: RUN_NARRATE_TOOL.to_string(),
        description: format!(
            "Attach a short explanation to the application's record of what you just ran — why \
             you did what you did, or what the user should look at next. {NARRATE_TOOL_NOTE} At \
             most {MAX_RUN_NARRATIVE_BYTES} bytes. Only works once something has actually run in \
             this conversation."
        ),
        input_schema: json!({
            "type": "object",
            "properties": {
                "narrative": {
                    "type": "string",
                    "maxLength": MAX_RUN_NARRATIVE_BYTES,
                    "description": "Prose for the user, shown beside the run record. Not a \
                                    substitute for it: do not claim here that a tool ran or \
                                    succeeded."
                }
            },
            "required": ["narrative"],
            "additionalProperties": false
        }),
    }
}

/// What the model is told after narrating: the facts, so that it answers the
/// user from the record rather than from its own prose.
pub(crate) fn narrate_tool_report(summary: &AiRunSummary) -> String {
    json!({
        "planId": summary.plan_id,
        "narrativeRecorded": summary.narrative.is_some(),
        "stepTotals": summary.step_totals,
        "mutatingToolsRun": summary.mutating_tools_run,
        "anyChangeAttempted": summary.any_change_attempted,
        "note": NARRATE_TOOL_NOTE,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use bc_ai_provider::ToolResult;

    use super::*;

    fn success() -> ExecutionResult {
        ExecutionResult::Success(ToolResult {
            tool_call_id: "call-1".into(),
            content: "{}".into(),
            is_error: false,
        })
    }

    fn denied() -> ExecutionResult {
        ExecutionResult::Denied {
            source: RefusalSource::AssistantPolicy,
            result: ToolResult {
                tool_call_id: "call-1".into(),
                content: "Tool call refused: read-only mode.".into(),
                is_error: true,
            },
        }
    }

    #[test]
    fn the_wire_format_is_camel_case() {
        let summary = AiRunSummary {
            plan_id: Some(Uuid::nil()),
            title: Some("Tidy up MX".into()),
            started_at: Utc::now(),
            finished_at: None,
            step_totals: AiRunStepTotals {
                done: 1,
                blocked: 2,
                failed: 0,
                skipped: 0,
                pending: 3,
            },
            tool_runs: vec![
                AiRunToolRun {
                    tool: "cf_delete_dns_record".into(),
                    step_index: Some(0),
                    outcome: AiRunToolOutcome::NotRun,
                },
                AiRunToolRun {
                    tool: "cf_create_dns_record".into(),
                    step_index: None,
                    outcome: AiRunToolOutcome::Ok,
                },
            ],
            refusals: vec![AiRunRefusal {
                tool: "cf_delete_dns_record".into(),
                source: RefusalSource::McpGrants,
                reason: "not granted".into(),
            }],
            mutating_tools_run: vec!["cf_create_dns_record".into()],
            any_change_attempted: true,
            narrative: Some("prose".into()),
        };
        let value = serde_json::to_value(&summary).expect("serializes");
        assert_eq!(value["planId"], Uuid::nil().to_string());
        assert_eq!(value["title"], "Tidy up MX");
        assert_eq!(value["stepTotals"]["blocked"], 2);
        assert_eq!(value["toolRuns"][0]["stepIndex"], 0);
        assert_eq!(value["toolRuns"][0]["outcome"], "notRun");
        assert!(
            value["toolRuns"][1]["stepIndex"].is_null(),
            "a free-turn call has no step index, and must not invent one"
        );
        assert_eq!(value["refusals"][0]["source"], "mcpGrants");
        assert_eq!(value["mutatingToolsRun"][0], "cf_create_dns_record");
        assert_eq!(value["anyChangeAttempted"], true);
        assert_eq!(value["narrative"], "prose");
        assert!(value["finishedAt"].is_null());

        // Every nullable field is an explicit null, never an absent key.
        let empty = serde_json::to_value(AiRunSummary {
            plan_id: None,
            title: None,
            started_at: Utc::now(),
            finished_at: None,
            step_totals: AiRunStepTotals::default(),
            tool_runs: Vec::new(),
            refusals: Vec::new(),
            mutating_tools_run: Vec::new(),
            any_change_attempted: false,
            narrative: None,
        })
        .expect("serializes");
        for key in ["planId", "title", "finishedAt", "narrative"] {
            assert!(
                empty.get(key).is_some_and(serde_json::Value::is_null),
                "{key} must be present and null"
            );
        }
        assert_eq!(empty["stepTotals"]["done"], 0);
    }

    #[test]
    fn the_narration_tool_accepts_prose_and_nothing_else() {
        let accepted: AiRunNarration =
            serde_json::from_value(json!({"narrative": "Checked the MX records."}))
                .expect("prose deserializes");
        assert_eq!(accepted.narrative, "Checked the MX records.");

        for rejected in [
            json!({"narrative": "ok", "stepTotals": {"done": 9}}),
            json!({"narrative": "ok", "mutatingToolsRun": []}),
            json!({"narrative": "ok", "anyChangeAttempted": false}),
            json!({"narrative": "ok", "toolRuns": []}),
            json!({"narrative": "ok", "planId": null}),
        ] {
            assert!(
                serde_json::from_value::<AiRunNarration>(rejected.clone()).is_err(),
                "{rejected} must be refused, not silently ignored"
            );
        }
    }

    #[test]
    fn a_narrative_is_bounded_and_rejects_control_characters() {
        assert!(validate_narrative("fine\nacross lines\tand tabs").is_ok());
        assert!(matches!(
            validate_narrative("   "),
            Err(AgentError::InvalidPlan {
                field: "narrative",
                ..
            })
        ));
        assert!(matches!(
            validate_narrative("forged\u{0}structure"),
            Err(AgentError::InvalidPlan {
                field: "narrative",
                ..
            })
        ));
        assert!(matches!(
            validate_narrative(&"n".repeat(MAX_RUN_NARRATIVE_BYTES + 1)),
            Err(AgentError::PlanLimit {
                resource: "run narrative",
                ..
            })
        ));
    }

    #[test]
    fn a_dispatched_write_is_recorded_as_mutating_and_a_refused_one_is_not() {
        let dispatched =
            RecordedStep::of(AiPlanStepStatus::Failed, Some("cf_delete_dns_record"), None);
        assert!(
            dispatched.dispatched,
            "a failed call still left the harness"
        );
        assert!(dispatched.mutating);
        assert_eq!(dispatched.outcome, AiRunToolOutcome::Failed);

        let refused = RecordedStep::of(
            AiPlanStepStatus::Blocked,
            Some("cf_delete_dns_record"),
            Some(AiRunRefusal {
                tool: "cf_delete_dns_record".into(),
                source: RefusalSource::AssistantPolicy,
                reason: "read-only mode".into(),
            }),
        );
        assert!(!refused.dispatched, "a blocked call dispatched nothing");
        assert_eq!(refused.outcome, AiRunToolOutcome::Denied);

        let read = RecordedStep::of(AiPlanStepStatus::Done, Some("dns_check_registration"), None);
        assert!(read.dispatched);
        assert!(!read.mutating, "an RDAP lookup changes nothing");

        let unknown = RecordedStep::of(AiPlanStepStatus::Done, Some("dns_check_invented"), None);
        assert!(
            unknown.mutating,
            "a tool the registry does not know must count as a write"
        );
    }

    /// The executor's variant decides, not its prose.
    #[test]
    fn the_executors_verdict_decides_whether_a_call_was_dispatched() {
        let (outcome, dispatched, refusal) = observe("cf_delete_dns_record", &success());
        assert_eq!(outcome, AiRunToolOutcome::Ok);
        assert!(dispatched);
        assert!(refusal.is_none());

        let (outcome, dispatched, refusal) = observe("cf_delete_dns_record", &denied());
        assert_eq!(outcome, AiRunToolOutcome::Denied);
        assert!(!dispatched, "a refused call never reached a tool");
        let refusal = refusal.expect("a denial carries its refusal");
        assert_eq!(refusal.source, RefusalSource::AssistantPolicy);
        assert_eq!(refusal.tool, "cf_delete_dns_record");

        let rejected = ExecutionResult::Rejected(bc_ai_tools::ToolExecutionError::InvalidInput {
            field: "arguments",
            message: "must be a JSON object",
        });
        let (outcome, dispatched, _) = observe("cf_delete_dns_record", &rejected);
        assert_eq!(outcome, AiRunToolOutcome::Failed);
        assert!(
            !dispatched,
            "a local safety check refuses before the gate, so nothing was dispatched"
        );
    }

    /// The window may forget a call; the change list may not.
    #[tokio::test]
    async fn the_tool_run_window_is_bounded_but_the_mutating_list_is_not() {
        let ledger = RunLedger::default();
        let conversation = Uuid::new_v4();

        let attempt = ledger
            .open_turn_call(conversation, "cf_delete_dns_record")
            .await;
        ledger
            .close_turn_call(conversation, attempt, "cf_delete_dns_record", &success())
            .await;

        // Push the delete out of the bounded window with reads.
        for _ in 0..MAX_RECORDED_TURN_CALLS + 4 {
            let attempt = ledger.open_turn_call(conversation, "dns_parse_spf").await;
            ledger
                .close_turn_call(conversation, attempt, "dns_parse_spf", &success())
                .await;
        }

        let summary = ledger.summary(conversation).await.expect("a summary");
        assert!(summary.tool_runs.len() <= MAX_RECORDED_TURN_CALLS);
        assert!(
            !summary
                .tool_runs
                .iter()
                .any(|run| run.tool == "cf_delete_dns_record"),
            "the window has forgotten the delete, which is what makes this test mean something"
        );
        assert_eq!(
            summary.mutating_tools_run,
            vec!["cf_delete_dns_record".to_string()],
            "the change list must not forget a write just because the window did"
        );
        assert!(summary.any_change_attempted);
    }

    #[tokio::test]
    async fn an_in_flight_write_is_accounted_for_before_it_returns() {
        let ledger = RunLedger::default();
        let conversation = Uuid::new_v4();

        let attempt = ledger
            .open_turn_call(conversation, "cf_delete_dns_record")
            .await;
        let in_flight = ledger.summary(conversation).await.expect("a summary");
        assert!(
            in_flight.any_change_attempted,
            "a write in flight may already have landed"
        );
        assert_eq!(
            in_flight.mutating_tools_run,
            vec!["cf_delete_dns_record".to_string()]
        );
        assert!(
            in_flight.finished_at.is_none(),
            "work is outstanding while a call is open"
        );

        // The gate turns out to have refused it, so the attempt is withdrawn.
        ledger
            .close_turn_call(conversation, attempt, "cf_delete_dns_record", &denied())
            .await;
        let settled = ledger.summary(conversation).await.expect("a summary");
        assert!(
            settled.mutating_tools_run.is_empty(),
            "a refused call dispatched nothing, so the attempt is withdrawn"
        );
        assert!(!settled.any_change_attempted);
        assert_eq!(settled.refusals.len(), 1);
        assert_eq!(settled.tool_runs[0].outcome, AiRunToolOutcome::Denied);
        assert!(settled.tool_runs[0].step_index.is_none());
        assert!(settled.finished_at.is_some());
    }

    #[tokio::test]
    async fn a_conversation_with_no_plan_has_a_summary_with_no_plan_id() {
        let ledger = RunLedger::default();
        let conversation = Uuid::new_v4();
        let attempt = ledger
            .open_turn_call(conversation, "cf_create_dns_record")
            .await;
        ledger
            .close_turn_call(conversation, attempt, "cf_create_dns_record", &success())
            .await;

        let summary = ledger.summary(conversation).await.expect("a summary");
        assert!(summary.plan_id.is_none());
        assert!(
            summary.title.is_none(),
            "a free-turn record must not borrow a plan's title"
        );
        assert_eq!(summary.step_totals, AiRunStepTotals::default());
        assert_eq!(summary.tool_runs.len(), 1);
        assert!(summary.tool_runs[0].step_index.is_none());
        assert_eq!(
            summary.mutating_tools_run,
            vec!["cf_create_dns_record".to_string()]
        );
        assert!(summary.any_change_attempted);

        assert!(ledger.delete(conversation).await);
        assert!(ledger.summary(conversation).await.is_none());
    }

    #[tokio::test]
    async fn narrating_needs_something_recorded_first() {
        let ledger = RunLedger::default();
        let conversation = Uuid::new_v4();
        assert!(matches!(
            ledger.narrate(conversation, "I did a thing").await,
            Err(AgentError::InvalidPlan {
                field: "narrative",
                ..
            })
        ));

        let attempt = ledger.open_turn_call(conversation, "dns_parse_spf").await;
        ledger
            .close_turn_call(conversation, attempt, "dns_parse_spf", &success())
            .await;
        let narrated = ledger
            .narrate(conversation, "Parsed the SPF record.")
            .await
            .expect("a free-turn record can be narrated");
        assert_eq!(
            narrated.narrative.as_deref(),
            Some("Parsed the SPF record.")
        );
        assert!(!narrated.any_change_attempted);
    }

    #[tokio::test]
    async fn the_retained_record_count_is_capped() {
        let ledger = RunLedger::default();
        for _ in 0..MAX_RETAINED_RUN_SUMMARIES + 8 {
            let conversation = Uuid::new_v4();
            let attempt = ledger.open_turn_call(conversation, "dns_parse_spf").await;
            ledger
                .close_turn_call(conversation, attempt, "dns_parse_spf", &success())
                .await;
        }
        assert!(ledger.count().await <= MAX_RETAINED_RUN_SUMMARIES);
    }
}
