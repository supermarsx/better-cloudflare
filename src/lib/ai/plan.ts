/**
 * What the plan UI is allowed to say, and what it is allowed to offer.
 *
 * Every rule here is a copy of a rule in `bc-ai-agent/src/plan.rs`, and the
 * reason they are copied rather than discovered by trying is that the backend
 * answers a refused command with `PlanStateConflict` — so a control offered in
 * the wrong state is not merely useless, it produces an error the user did
 * nothing to deserve. `ensureAiPlanCanRun` and `ensureAiPlanStepCanRun` below
 * are `ensure_plan_can_run` and `ensure_step_can_run`; the contract test pins
 * both against the Rust match arms.
 *
 * Three things this module deliberately does **not** do.
 *
 * **It returns no prose.** Like `AiValidationIssue`, every answer is data, so
 * the user-facing sentences stay in the components where `t()` can reach them.
 *
 * **It never guesses a status it does not recognise.** The plan crosses IPC
 * from a Rust enum that can gain a variant, and the whole value of this screen
 * is that a blocked step says *which* permission layer refuses it. A renderer
 * that fell back to one of the two when it met an unfamiliar `refusal.source`
 * would be pointing half its users at the wrong settings screen with total
 * confidence, which is worse than admitting it cannot tell. So the guards here
 * narrow, and an unrecognised value stays unrecognised.
 *
 * **It never claims a step ran.** `status` is written by the harness and is
 * the only authority on what happened; nothing here derives one.
 */
import {
  AI_PLAN_STEP_TOOL_CALL_PREFIX,
  type AiPlan,
  type AiPlanStatus,
  type AiPlanStep,
  type AiPlanStepStatus,
  type AiRefusalSource,
  type AiRunStepTotals,
  type AiRunSummary,
  type AiRunToolOutcome,
} from "@/types/ai";

/** Every plan status, in the order the UI explains them. */
export const AI_PLAN_STATUSES: readonly AiPlanStatus[] = [
  "draft",
  "approved",
  "running",
  "paused",
  "done",
  "failed",
  "cancelled",
] as const;

/** Every step status, in the order the harness can reach them. */
export const AI_PLAN_STEP_STATUSES: readonly AiPlanStepStatus[] = [
  "pending",
  "blocked",
  "awaitingApproval",
  "running",
  "done",
  "skipped",
  "failed",
] as const;

/** Every tool outcome a run summary can report. */
export const AI_RUN_TOOL_OUTCOMES: readonly AiRunToolOutcome[] = [
  "ok",
  "failed",
  "denied",
  "notRun",
] as const;

export function isAiPlanStatus(value: unknown): value is AiPlanStatus {
  return (
    typeof value === "string" &&
    (AI_PLAN_STATUSES as readonly string[]).includes(value)
  );
}

export function isAiPlanStepStatus(value: unknown): value is AiPlanStepStatus {
  return (
    typeof value === "string" &&
    (AI_PLAN_STEP_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Narrow a refusal source.
 *
 * Load-bearing rather than defensive: see the module comment. A `blocked` step
 * whose source does not narrow must be presented as "blocked, and the app
 * cannot say which layer" — never as either layer.
 */
export function isAiRefusalSource(value: unknown): value is AiRefusalSource {
  return value === "assistantPolicy" || value === "mcpGrants";
}

// ─── What a state permits ──────────────────────────────────────────────────

/**
 * Why a plan-level action is not on offer, or `null` when it is.
 *
 * Returned rather than a bare boolean so that a disabled control can say
 * which of the two reasons applies: a draft is not runnable *yet* and becomes
 * runnable on approval, whereas a finished or cancelled plan never will be.
 */
export type AiPlanBlockReason = "notApproved" | "finished";

/**
 * `ensure_plan_can_run`: a plan may run while `approved`, `running`, `paused`
 * or `failed`.
 *
 * `failed` is in that list on purpose and it is not a slip — re-running
 * re-resolves permissions and retries the step that failed, which is exactly
 * what a user does after granting the tool that stopped it.
 */
export function ensureAiPlanCanRun(
  status: AiPlanStatus,
): AiPlanBlockReason | null {
  switch (status) {
    case "approved":
    case "running":
    case "paused":
    case "failed":
      return null;
    case "draft":
      return "notApproved";
    case "done":
    case "cancelled":
      return "finished";
  }
}

/** Whether any run control may be offered at all. */
export function isAiPlanRunnable(status: AiPlanStatus): boolean {
  return ensureAiPlanCanRun(status) === null;
}

/** `approve` accepts a draft and nothing else. */
export function isAiPlanApprovable(status: AiPlanStatus): boolean {
  return status === "draft";
}

/**
 * `cancel` refuses only a `done` plan, and is idempotent on a cancelled one.
 *
 * Idempotent is not the same as worth offering: a second cancel changes
 * nothing a user can see, so a cancelled plan gets no cancel control either.
 */
export function isAiPlanCancellable(status: AiPlanStatus): boolean {
  return status !== "done" && status !== "cancelled";
}

/** Reached its last state: a run summary belongs here and nowhere earlier. */
export function isAiPlanTerminal(status: AiPlanStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/**
 * `ensure_step_can_run`: a step may run while `pending`, `blocked`,
 * `awaitingApproval` or `failed`.
 *
 * `blocked` belongs here, which is easy to misread as a bug. Running a blocked
 * step re-resolves its tool through the gate, so it is precisely the control a
 * user wants after granting the permission that blocked it — and if the
 * permission is still refused the step comes back `blocked` again, having
 * dispatched nothing.
 */
export function isAiPlanStepRunnable(status: AiPlanStepStatus): boolean {
  return (
    status === "pending" ||
    status === "blocked" ||
    status === "awaitingApproval" ||
    status === "failed"
  );
}

// ─── Blocked steps: which layer, and which screen fixes it ─────────────────

/**
 * The screen that can change one permission layer.
 *
 * - `assistantTools` — the assistant's own **Tools & permissions** section,
 *   which this panel can open itself.
 * - `sessionSettingsMcp` — the application's MCP tool grants, in **Session
 *   settings → MCP**. Nothing under `ai_*` can change these, so the assistant
 *   can only point at them.
 */
export type AiPermissionScreen = "assistantTools" | "sessionSettingsMcp";

/** Which screen fixes a refusal from each layer. */
export const AI_REFUSAL_SCREEN: Readonly<
  Record<AiRefusalSource, AiPermissionScreen>
> = {
  assistantPolicy: "assistantTools",
  mcpGrants: "sessionSettingsMcp",
} as const;

/**
 * Where to send a user looking at a blocked step, or `null` when the layer did
 * not narrow.
 *
 * `null` is a real answer and must render as one. Picking a screen for an
 * unrecognised source would send the user to change a setting that is not the
 * one refusing them.
 */
export function aiRefusalScreen(source: unknown): AiPermissionScreen | null {
  return isAiRefusalSource(source) ? AI_REFUSAL_SCREEN[source] : null;
}

// ─── Approving a waiting step ──────────────────────────────────────────────

/** A 32-hex-digit UUID with or without its four hyphens. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * The tool-call id a step is approved under, or `null` when the id is not a
 * UUID.
 *
 * Mirrors `step_tool_call_id`: the prefix followed by the UUID's `simple`
 * form, which is 32 hex digits and no hyphens. A step that resolves to `ask`
 * is approved through the **existing** `ai_approve_tool_call`, which
 * recognises the prefix and routes the approval to the step — there is no
 * second approval command and no plan approval event, so re-read the plan
 * afterwards.
 *
 * It refuses a non-UUID rather than prefixing whatever it was handed: the
 * result is sent to a command that also serves transcript tool calls, and a
 * forged id is the one thing that could make an approval land somewhere else.
 */
export function planStepToolCallId(stepId: string): string | null {
  if (!UUID_PATTERN.test(stepId)) return null;
  return `${AI_PLAN_STEP_TOOL_CALL_PREFIX}${stepId.replaceAll("-", "").toLowerCase()}`;
}

// ─── Deriving what the UI counts ───────────────────────────────────────────

/**
 * Step totals computed from a plan's own steps.
 *
 * Used **only** when no run summary has been read — it is the plan's own
 * `status` fields counted up, which is a different and weaker thing than the
 * harness's record of a finished run, and the UI labels it as such. The two
 * are not interchangeable and this must never be substituted for
 * `AiRunSummary.stepTotals`.
 */
export function countAiPlanSteps(
  steps: readonly AiPlanStep[],
): AiRunStepTotals {
  const totals: AiRunStepTotals = {
    done: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
  };
  for (const step of steps) {
    switch (step.status) {
      case "done":
        totals.done += 1;
        break;
      case "blocked":
        totals.blocked += 1;
        break;
      case "failed":
        totals.failed += 1;
        break;
      case "skipped":
        totals.skipped += 1;
        break;
      // `pending`, `running` and `awaitingApproval` are all "not finished",
      // which is what the `pending` total means in the harness's own summary.
      default:
        totals.pending += 1;
        break;
    }
  }
  return totals;
}

/** Steps in plan order. The backend sends them ordered; this does not rely on it. */
export function orderedAiPlanSteps(plan: AiPlan): AiPlanStep[] {
  return [...plan.steps].sort((left, right) => left.index - right.index);
}

/**
 * Every distinct refusal layer a plan's blocked steps name, in explanation
 * order, plus whether any blocked step failed to name one at all.
 *
 * The plan-level summary speaks from this rather than from the first blocked
 * step it finds: a plan can be blocked by both layers at once, and naming one
 * would send half the fix to the wrong screen.
 */
export function aiPlanRefusalLayers(plan: AiPlan): {
  sources: AiRefusalSource[];
  unknown: boolean;
} {
  const sources: AiRefusalSource[] = [];
  let unknown = false;
  for (const step of plan.steps) {
    if (step.status !== "blocked") continue;
    const source = step.refusal?.source;
    if (isAiRefusalSource(source)) {
      if (!sources.includes(source)) sources.push(source);
    } else {
      unknown = true;
    }
  }
  // Explanation order, not encounter order, so the same pair of layers always
  // reads the same way.
  sources.sort(
    (left, right) =>
      (left === "assistantPolicy" ? 0 : 1) -
      (right === "assistantPolicy" ? 0 : 1),
  );
  return { sources, unknown };
}

/**
 * Tool runs grouped by outcome, in a fixed order.
 *
 * Grouped rather than listed flat because "two denied" is the line a user
 * reads first, and a flat list of thirty-two rows buries it.
 */
export function groupAiRunToolRuns(
  summary: AiRunSummary,
): { outcome: AiRunToolOutcome; runs: AiRunSummary["toolRuns"] }[] {
  return AI_RUN_TOOL_OUTCOMES.map((outcome) => ({
    outcome,
    runs: summary.toolRuns.filter((run) => run.outcome === outcome),
  })).filter((group) => group.runs.length > 0);
}

/**
 * Whether the summary's factual half says anything happened.
 *
 * Deliberately ignores `narrative`: a model that narrates a change it never
 * made must not be able to make this true.
 */
export function aiRunSummaryDidAnything(summary: AiRunSummary): boolean {
  return (
    summary.anyChangeAttempted ||
    summary.mutatingToolsRun.length > 0 ||
    summary.toolRuns.length > 0 ||
    summary.stepTotals.done > 0 ||
    summary.stepTotals.failed > 0
  );
}
