/**
 * The plan, as a checklist you can act on.
 *
 * The harness shipped with no UI at all, which made one thing invisible that
 * this screen exists to show: **a step whose tool is refused comes back
 * `blocked`, before anything has run, and the two permission layers that can
 * refuse it are configured in different places.** A user told only "blocked"
 * cannot act. So every blocked step names its layer and offers the screen that
 * changes it — the assistant's own Tools & permissions for `assistantPolicy`,
 * the app's MCP tool grants for `mcpGrants` — and a step whose layer does not
 * narrow says so rather than guessing one, because guessing sends half of them
 * to change a setting that is not refusing them.
 *
 * Four more rules it is built around.
 *
 * **A draft must not look runnable.** `ai_run_plan` and `ai_run_plan_step`
 * refuse a draft outright, so a run control on one would produce an error the
 * user did nothing to earn. A draft therefore has no run control anywhere —
 * not a disabled one — only Approve and Discard. Which states permit which
 * command is copied from `plan.rs` into `@/lib/ai/plan`, not discovered by
 * trying.
 *
 * **State is never carried by colour alone.** Every plan and step status
 * renders an icon and a word, and the word is the status, so the difference
 * between `paused` and `failed` survives a greyscale screen and a screen
 * reader.
 *
 * **Every control names its step.** "Run" three times over is three
 * indistinguishable buttons to anyone navigating by accessible name, so each
 * one is "Run step 3: …".
 *
 * **Nothing here derives an outcome.** Every command answers with the
 * authoritative plan and that is what renders; no step is marked done, no
 * count is inferred, and the model — which cannot express a status at all, by
 * the shape of its own tool input — gets no say in what this shows.
 */
import {
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  ClipboardList,
  Loader2,
  MinusCircle,
  Pause,
  Play,
  ShieldAlert,
  ShieldQuestion,
  Trash2,
  XCircle,
  XOctagon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { AiPlanAction, AiPlanError } from "@/hooks/ai/use-ai-plan";
import {
  aiPlanRefusalLayers,
  aiRefusalScreen,
  countAiPlanSteps,
  ensureAiPlanCanRun,
  isAiPlanApprovable,
  isAiPlanCancellable,
  isAiPlanStatus,
  isAiPlanStepRunnable,
  isAiPlanStepStatus,
  isAiPlanTerminal,
  isAiRefusalSource,
  orderedAiPlanSteps,
} from "@/lib/ai/plan";
import { cn } from "@/lib/utils";
import type {
  AiPlan,
  AiPlanStatus,
  AiPlanStep,
  AiPlanStepStatus,
  AiRunSummary,
} from "@/types/ai";

import { AiRunSummaryView } from "./AiRunSummaryView";
import { describeAiError } from "./ai-error";

export interface AiPlanViewProps {
  /** `null` when the conversation has no plan. Renders nothing then. */
  plan: AiPlan | null;
  summary: AiRunSummary | null;
  summaryError: unknown;
  loading: boolean;
  loadError: unknown;
  /** Which command is in flight, or `null`. */
  busy: AiPlanAction | null;
  error: AiPlanError | null;
  onApprove: () => void;
  onRun: () => void;
  onRunStep: (stepId: string) => void;
  onApproveStep: (stepId: string) => void;
  onCancel: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  /**
   * Opens the assistant's Tools & permissions settings.
   *
   * No longer owned by the assistant: those settings are the "Assistant"
   * section of the app's Settings workspace, so this is the host's. Absent
   * when the host has no such screen, in which case the refusal still names
   * the layer and offers no button — an inert one would be worse than none,
   * and the sentence is the part that actually tells the user what to change.
   */
  onOpenAssistantTools?: () => void;
  /**
   * Opens the app's MCP tool permissions. Absent when the host does not own
   * that screen, in which case the refusal still names the layer and simply
   * offers no button — an inert one would be worse than none.
   */
  onOpenMcpPermissions?: () => void;
  /** Trims padding for the 22rem dock and the 26rem bubble. */
  compact?: boolean;
}

type IconComponent = typeof CheckCircle2;

/** Icon per plan status, so the state is never colour alone. */
const PLAN_STATUS_ICON: Record<AiPlanStatus, IconComponent> = {
  draft: ClipboardList,
  approved: CheckCircle2,
  running: Loader2,
  paused: Pause,
  done: CheckCircle2,
  failed: XCircle,
  cancelled: XOctagon,
};

/** Icon per step status, for the same reason. */
const STEP_STATUS_ICON: Record<AiPlanStepStatus, IconComponent> = {
  pending: Circle,
  blocked: Ban,
  awaitingApproval: ShieldQuestion,
  running: Loader2,
  done: CheckCircle2,
  skipped: MinusCircle,
  failed: XCircle,
};

/**
 * Border and text treatment per step status.
 *
 * Colour is carried here *in addition to* the icon and the word, never
 * instead of them: `paused` and `failed` are already distinguishable with the
 * stylesheet thrown away.
 */
const STEP_STATUS_CLASS: Record<AiPlanStepStatus, string> = {
  pending: "border-border/60",
  blocked: "border-amber-500/50 bg-amber-500/5",
  awaitingApproval: "border-sky-500/50 bg-sky-500/5",
  running: "border-primary/50 bg-primary/5",
  done: "border-emerald-500/40 bg-emerald-500/5",
  skipped: "border-border/60 bg-muted/20",
  failed: "border-destructive/50 bg-destructive/5",
};

export function AiPlanView({
  plan,
  summary,
  summaryError,
  loading,
  loadError,
  busy,
  error,
  onApprove,
  onRun,
  onRunStep,
  onApproveStep,
  onCancel,
  onDelete,
  onRetry,
  onDismissError,
  onOpenAssistantTools,
  onOpenMcpPermissions,
  compact = false,
}: AiPlanViewProps) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();

  const planStatusLabel: Record<AiPlanStatus, string> = {
    draft: t("Draft", "Draft"),
    approved: t("Approved", "Approved"),
    running: t("Running", "Running"),
    paused: t("Paused", "Paused"),
    done: t("Done", "Done"),
    failed: t("Failed", "Failed"),
    cancelled: t("Cancelled", "Cancelled"),
  };

  const stepStatusLabel: Record<AiPlanStepStatus, string> = {
    pending: t("Not started", "Not started"),
    blocked: t("Blocked", "Blocked"),
    awaitingApproval: t("Needs your approval", "Needs your approval"),
    running: t("Running", "Running"),
    done: t("Done", "Done"),
    skipped: t("Yours to do", "Yours to do"),
    failed: t("Failed", "Failed"),
  };

  /** What the plan's state means for the user, in one sentence. */
  const planStatusExplanation: Record<AiPlanStatus, string> = {
    draft: t(
      "The assistant proposed this plan. Nothing in it can run until you approve it, and approving re-checks every step against the tool permissions in force then.",
      "The assistant proposed this plan. Nothing in it can run until you approve it, and approving re-checks every step against the tool permissions in force then.",
    ),
    approved: t(
      "Approved and ready. No step has started yet.",
      "Approved and ready. No step has started yet.",
    ),
    running: t(
      "Running the steps in order. It stops at the first one that does not finish.",
      "Running the steps in order. It stops at the first one that does not finish.",
    ),
    paused: t(
      "The run stopped on a step that cannot continue on its own. Fix what is holding it up, or approve it, then run the plan again.",
      "The run stopped on a step that cannot continue on its own. Fix what is holding it up, or approve it, then run the plan again.",
    ),
    done: t(
      "Every step is finished or was yours to carry out.",
      "Every step is finished or was yours to carry out.",
    ),
    failed: t(
      "A step failed, so the run stopped there. Earlier steps may have completed; each step says what happened to it. Running the plan again retries from the step that failed.",
      "A step failed, so the run stopped there. Earlier steps may have completed; each step says what happened to it. Running the plan again retries from the step that failed.",
    ),
    cancelled: t(
      "You cancelled this plan, so it will not go any further. Steps that had already run are unaffected.",
      "You cancelled this plan, so it will not go any further. Steps that had already run are unaffected.",
    ),
  };

  if (plan === null) {
    // No plan is the common case and it must cost nothing: the dock and the
    // bubble pay for every row in transcript height. A failed *read* is a
    // different thing and does get a line, because an approved plan hidden
    // from its owner is the outcome worth shouting about.
    if (loadError === null || loadError === undefined) return null;
    return (
      <div
        role="alert"
        data-testid="ai-plan-load-error"
        className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        <p>
          {
            describeAiError(
              loadError,
              t(
                "The assistant's plan could not be read.",
                "The assistant's plan could not be read.",
              ),
            ).message
          }
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("Try again", "Try again")}
        </Button>
      </div>
    );
  }

  const steps = orderedAiPlanSteps(plan);
  const totals = countAiPlanSteps(steps);
  const layers = aiPlanRefusalLayers(plan);
  /**
   * The plan's state, or `null` when this build does not recognise it.
   *
   * The status crosses IPC from a Rust enum that can gain a variant, and every
   * control on this screen is keyed off it. `null` therefore offers no
   * approve, run or cancel control at all: a predicate asked about an unknown
   * state would answer "no" by luck rather than by rule, and a button that
   * guessed would produce a `PlanStateConflict` the user cannot act on. Only
   * Discard stays, because discarding is legal in every state the backend has.
   */
  const status = isAiPlanStatus(plan.status) ? plan.status : null;
  const canRun = status !== null && ensureAiPlanCanRun(status) === null;
  const canApprove = status !== null && isAiPlanApprovable(status);
  const canCancel =
    status !== null && isAiPlanCancellable(status) && status !== "draft";
  const terminal = status !== null && isAiPlanTerminal(status);
  const PlanIcon = status === null ? CircleDashed : PLAN_STATUS_ICON[status];
  const anyBusy = busy !== null;

  /** The run control is offered only where the backend accepts it. */
  const nextRunnable = steps.find(
    (step) =>
      isAiPlanStepStatus(step.status) && isAiPlanStepRunnable(step.status),
  );

  const stepName = (step: AiPlanStep): string =>
    t("step {{number}}: {{title}}", {
      number: step.index + 1,
      title: step.title,
      defaultValue: `step ${step.index + 1}: ${step.title}`,
    });

  return (
    <section
      className={cn(
        "min-w-0 space-y-3 rounded-xl border border-border/60 bg-card/50",
        compact ? "p-2" : "p-3",
      )}
      data-testid="ai-plan"
      data-status={status ?? "unrecognised"}
      data-plan-id={plan.id}
      data-steps={steps.length}
      aria-label={t("Plan", "Plan")}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 text-sm font-semibold break-words [overflow-wrap:anywhere]">
            {plan.title}
          </h3>
          {/* Icon plus word. The word is the status, so nothing here depends
              on the colour of the border around it. */}
          <span
            data-testid="ai-plan-status"
            data-status={status ?? "unrecognised"}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[11px] font-medium"
          >
            <PlanIcon
              aria-hidden="true"
              className={cn(
                "h-3 w-3",
                status === "running" && !reducedMotion && "animate-spin",
              )}
            />
            {status === null
              ? t("Unrecognised", "Unrecognised")
              : planStatusLabel[status]}
          </span>
        </div>
        <p
          data-testid="ai-plan-explanation"
          className="text-xs break-words text-muted-foreground [overflow-wrap:anywhere]"
        >
          {status === null
            ? t(
                "This copy of the app does not recognise the state the assistant reports for this plan, so it offers nothing but discarding it. Updating the app is what fixes this.",
                "This copy of the app does not recognise the state the assistant reports for this plan, so it offers nothing but discarding it. Updating the app is what fixes this.",
              )
            : planStatusExplanation[status]}
        </p>
        <p
          data-testid="ai-plan-counts"
          className="text-xs text-muted-foreground"
        >
          {t(
            "{{total}} steps: {{done}} done, {{blocked}} blocked, {{failed}} failed, {{remaining}} to go.",
            {
              total: steps.length,
              done: totals.done,
              blocked: totals.blocked,
              failed: totals.failed,
              remaining: totals.pending,
              defaultValue: `${steps.length} steps: ${totals.done} done, ${totals.blocked} blocked, ${totals.failed} failed, ${totals.pending} to go.`,
            },
          )}
        </p>
      </div>

      {/* The plan-level blocked notice. It lists every layer involved rather
          than the first one found: a plan can be blocked by both at once, and
          naming one would send half the fix to the wrong screen. */}
      {totals.blocked > 0 ? (
        <div
          data-testid="ai-plan-blocked-notice"
          data-sources={layers.sources.join(" ")}
          data-unknown-source={layers.unknown}
          className="min-w-0 space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs"
        >
          <p className="flex items-start gap-1.5">
            <ShieldAlert
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
            />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {totals.blocked === 1
                ? t(
                    "One step cannot run: a tool permission refuses the tool it needs. Nothing has been dispatched for it.",
                    "One step cannot run: a tool permission refuses the tool it needs. Nothing has been dispatched for it.",
                  )
                : t(
                    "{{count}} steps cannot run: a tool permission refuses the tool they need. Nothing has been dispatched for them.",
                    {
                      count: totals.blocked,
                      defaultValue: `${totals.blocked} steps cannot run: a tool permission refuses the tool they need. Nothing has been dispatched for them.`,
                    },
                  )}
            </span>
          </p>
          <div className="flex flex-wrap gap-1">
            {layers.sources.includes("assistantPolicy") &&
            onOpenAssistantTools ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                data-testid="ai-plan-open-assistant-tools"
                onClick={onOpenAssistantTools}
              >
                {t("Open Tools & permissions", "Open Tools & permissions")}
              </Button>
            ) : null}
            {layers.sources.includes("mcpGrants") && onOpenMcpPermissions ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                data-testid="ai-plan-open-mcp-permissions"
                onClick={onOpenMcpPermissions}
              >
                {t(
                  "Open the app's MCP tool permissions",
                  "Open the app's MCP tool permissions",
                )}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <ol role="list" className="min-w-0 space-y-2" data-testid="ai-plan-steps">
        {steps.map((step) => {
          // Same rule as the plan's own status: a step state this build does
          // not know is reported as unrecognised and offers no control, rather
          // than being rendered as whichever known state it sorts next to.
          const stepStatus = isAiPlanStepStatus(step.status)
            ? step.status
            : null;
          const StepIcon =
            stepStatus === null ? CircleDashed : STEP_STATUS_ICON[stepStatus];
          const screen = aiRefusalScreen(step.refusal?.source);
          const stepRunnable =
            canRun && stepStatus !== null && isAiPlanStepRunnable(stepStatus);
          return (
            <li
              key={step.id}
              data-testid="ai-plan-step"
              data-step-id={step.id}
              data-index={step.index}
              data-step-status={stepStatus ?? "unrecognised"}
              data-tool={step.tool ?? ""}
              className={cn(
                "min-w-0 space-y-1 rounded-lg border px-2.5 py-2",
                stepStatus === null
                  ? "border-border/60"
                  : STEP_STATUS_CLASS[stepStatus],
              )}
            >
              <div className="flex min-w-0 items-start gap-2">
                <span
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 font-mono text-[11px] text-muted-foreground"
                >
                  {step.index + 1}.
                </span>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block text-xs font-medium break-words [overflow-wrap:anywhere]">
                    {step.title}
                  </span>
                  {step.detail.trim().length > 0 ? (
                    <span className="block text-xs break-words text-muted-foreground [overflow-wrap:anywhere]">
                      {step.detail}
                    </span>
                  ) : null}
                </span>
                <span
                  data-testid="ai-plan-step-status"
                  data-status={stepStatus ?? "unrecognised"}
                  className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium"
                >
                  <StepIcon
                    aria-hidden="true"
                    className={cn(
                      "h-3 w-3",
                      stepStatus === "running" &&
                        !reducedMotion &&
                        "animate-spin",
                    )}
                  />
                  {stepStatus === null
                    ? t("Unrecognised", "Unrecognised")
                    : stepStatusLabel[stepStatus]}
                </span>
              </div>

              {/* Which tool it will call, or that it calls none. "None" is
                  not an omission: a step without a tool is the user's own to
                  carry out, and the harness marks it skipped when run. */}
              <p
                data-testid="ai-plan-step-tool"
                className="pl-5 text-[11px] break-all text-muted-foreground"
              >
                {step.tool
                  ? t("Runs {{tool}}", {
                      tool: step.tool,
                      defaultValue: `Runs ${step.tool}`,
                    })
                  : t(
                      "Calls no tool: this one is yours to carry out.",
                      "Calls no tool: this one is yours to carry out.",
                    )}
              </p>

              {/* The blocked explanation, per step, naming the layer and the
                  screen that changes it. */}
              {stepStatus === "blocked" ? (
                <div
                  data-testid="ai-plan-step-refusal"
                  data-source={
                    isAiRefusalSource(step.refusal?.source)
                      ? step.refusal?.source
                      : "unknown"
                  }
                  data-screen={screen ?? "unknown"}
                  className="ml-5 min-w-0 space-y-1 rounded-md border border-amber-500/40 bg-background/40 px-2 py-1.5 text-[11px]"
                >
                  <p className="break-words [overflow-wrap:anywhere]">
                    {screen === "assistantTools"
                      ? t(
                          "Refused by the assistant's own tool permissions. Change this in Settings, under Assistant, in Tools & permissions: its mode, or the override on this one tool.",
                          "Refused by the assistant's own tool permissions. Change this in Settings, under Assistant, in Tools & permissions: its mode, or the override on this one tool.",
                        )
                      : screen === "sessionSettingsMcp"
                        ? t(
                            "Refused by the app's own MCP tool permissions, which the assistant cannot change. Grant the tool in Session settings, under MCP.",
                            "Refused by the app's own MCP tool permissions, which the assistant cannot change. Grant the tool in Session settings, under MCP.",
                          )
                        : t(
                            "Refused, but the app cannot tell which permission layer refused it, so it cannot say which screen to change. Check both Settings under Assistant, in Tools & permissions, and Session settings, under MCP.",
                            "Refused, but the app cannot tell which permission layer refused it, so it cannot say which screen to change. Check both Settings under Assistant, in Tools & permissions, and Session settings, under MCP.",
                          )}
                  </p>
                  {step.refusal?.reason ? (
                    <p
                      data-testid="ai-plan-step-refusal-reason"
                      className="break-words text-muted-foreground [overflow-wrap:anywhere]"
                    >
                      {step.refusal.reason}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-1">
                    {(screen === "assistantTools" || screen === null) &&
                    onOpenAssistantTools ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        data-testid="ai-plan-step-open-assistant-tools"
                        aria-label={t("Open Tools & permissions for {{step}}", {
                          step: stepName(step),
                          defaultValue: `Open Tools & permissions for ${stepName(step)}`,
                        })}
                        onClick={onOpenAssistantTools}
                      >
                        {t("Tools & permissions", "Tools & permissions")}
                      </Button>
                    ) : null}
                    {(screen === "sessionSettingsMcp" || screen === null) &&
                    onOpenMcpPermissions ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        data-testid="ai-plan-step-open-mcp-permissions"
                        aria-label={t(
                          "Open the app's MCP tool permissions for {{step}}",
                          {
                            step: stepName(step),
                            defaultValue: `Open the app's MCP tool permissions for ${stepName(step)}`,
                          },
                        )}
                        onClick={onOpenMcpPermissions}
                      >
                        {t("MCP tool permissions", "MCP tool permissions")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {stepStatus === "awaitingApproval" ? (
                <p
                  data-testid="ai-plan-step-approval-note"
                  className="ml-5 text-[11px] break-words [overflow-wrap:anywhere]"
                >
                  {t(
                    "This tool is set to ask first, so it will not run until you approve it. Approving runs the step straight away.",
                    "This tool is set to ask first, so it will not run until you approve it. Approving runs the step straight away.",
                  )}
                </p>
              ) : null}

              {step.result ? (
                <p
                  data-testid="ai-plan-step-result"
                  className="ml-5 max-h-24 overflow-y-auto rounded border border-border/50 bg-background/40 px-2 py-1 font-mono text-[11px] break-all whitespace-pre-wrap"
                >
                  {step.result}
                </p>
              ) : null}

              {/* Per-step controls. A draft reaches none of these, because
                  `canRun` is false for it — that is the "a draft must not
                  look runnable" rule, and it is one condition rather than a
                  check repeated per button. */}
              {stepRunnable ? (
                <div className="ml-5 flex flex-wrap gap-1">
                  {stepStatus === "awaitingApproval" ? (
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      data-testid="ai-plan-approve-step"
                      disabled={anyBusy}
                      aria-label={t("Approve and run {{step}}", {
                        step: stepName(step),
                        defaultValue: `Approve and run ${stepName(step)}`,
                      })}
                      onClick={() => onApproveStep(step.id)}
                    >
                      <ShieldQuestion
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                      />
                      {t("Approve and run", "Approve and run")}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      data-testid="ai-plan-run-step"
                      disabled={anyBusy}
                      // The accessible name contains the visible word, in
                      // order: a control whose label and name disagree reads
                      // as two different buttons to someone using both.
                      aria-label={
                        stepStatus === "blocked"
                          ? t("Try {{step}} again", {
                              step: stepName(step),
                              defaultValue: `Try ${stepName(step)} again`,
                            })
                          : stepStatus === "failed"
                            ? t("Retry {{step}}", {
                                step: stepName(step),
                                defaultValue: `Retry ${stepName(step)}`,
                              })
                            : t("Run {{step}}", {
                                step: stepName(step),
                                defaultValue: `Run ${stepName(step)}`,
                              })
                      }
                      onClick={() => onRunStep(step.id)}
                    >
                      <Play aria-hidden="true" className="h-3.5 w-3.5" />
                      {stepStatus === "blocked"
                        ? t("Try again", "Try again")
                        : stepStatus === "failed"
                          ? t("Retry", "Retry")
                          : t("Run", "Run")}
                    </Button>
                  )}
                  {stepStatus === "blocked" ? (
                    <span
                      className="self-center text-[11px] text-muted-foreground"
                      data-testid="ai-plan-step-retry-note"
                    >
                      {t(
                        "after granting the permission",
                        "after granting the permission",
                      )}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* Plan-level controls. Approve and Run are mutually exclusive by
          construction: approval is only legal on a draft, and a run is only
          legal once it is not one. */}
      <div className="flex flex-wrap gap-1" data-testid="ai-plan-controls">
        {canApprove ? (
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            data-testid="ai-plan-approve"
            disabled={anyBusy}
            aria-label={t("Approve the plan {{title}}", {
              title: plan.title,
              defaultValue: `Approve the plan ${plan.title}`,
            })}
            onClick={onApprove}
          >
            <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
            {busy === "approve"
              ? t("Approving…", "Approving…")
              : t("Approve plan", "Approve plan")}
          </Button>
        ) : null}
        {canRun ? (
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            data-testid="ai-plan-run"
            disabled={anyBusy || nextRunnable === undefined}
            aria-label={t("Run the plan {{title}}", {
              title: plan.title,
              defaultValue: `Run the plan ${plan.title}`,
            })}
            onClick={onRun}
          >
            <Play aria-hidden="true" className="h-3.5 w-3.5" />
            {busy === "run"
              ? t("Running…", "Running…")
              : status === "approved"
                ? t("Run plan", "Run plan")
                : t("Continue plan", "Continue plan")}
          </Button>
        ) : null}
        {canCancel ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            data-testid="ai-plan-cancel"
            disabled={anyBusy}
            aria-label={t("Cancel the plan {{title}}", {
              title: plan.title,
              defaultValue: `Cancel the plan ${plan.title}`,
            })}
            onClick={onCancel}
          >
            <XOctagon aria-hidden="true" className="h-3.5 w-3.5" />
            {busy === "cancel"
              ? t("Cancelling…", "Cancelling…")
              : t("Cancel plan", "Cancel plan")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          data-testid="ai-plan-delete"
          disabled={anyBusy}
          aria-label={t("Discard the plan {{title}}", {
            title: plan.title,
            defaultValue: `Discard the plan ${plan.title}`,
          })}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          {busy === "delete"
            ? t("Discarding…", "Discarding…")
            : t("Discard plan", "Discard plan")}
        </Button>
        {loading ? (
          <span
            role="status"
            aria-live="polite"
            data-testid="ai-plan-loading"
            className="self-center text-[11px] text-muted-foreground"
          >
            {t("Re-reading the plan…", "Re-reading the plan…")}
          </span>
        ) : null}
      </div>

      {/* A refused command, next to the controls that produced it. */}
      {error ? (
        <div
          role="alert"
          data-testid="ai-plan-error"
          data-action={error.action}
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p className="break-words [overflow-wrap:anywhere]">
            {error.message}
          </p>
          {error.remediation ? (
            <p className="break-words [overflow-wrap:anywhere]">
              {error.remediation}
            </p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={onDismissError}
          >
            {t("Dismiss", "Dismiss")}
          </Button>
        </div>
      ) : null}

      {/* The run record, once there is a run to have a record of. */}
      {terminal && summary ? <AiRunSummaryView summary={summary} /> : null}
      {terminal && summary === null && summaryError ? (
        <p
          role="note"
          data-testid="ai-run-summary-error"
          className="flex items-start gap-1.5 text-xs break-words text-muted-foreground [overflow-wrap:anywhere]"
        >
          <CircleDashed
            aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
          />
          <span>
            {t(
              "The record of what this run did could not be read, so the step states above are all there is to go on.",
              "The record of what this run did could not be read, so the step states above are all there is to go on.",
            )}
          </span>
        </p>
      ) : null}
    </section>
  );
}
