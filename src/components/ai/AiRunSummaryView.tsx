/**
 * What the run actually did.
 *
 * **The whole design of this component is one distinction.** Everything
 * `ai_get_run_summary` returns except `narrative` is derived by the harness
 * from what it dispatched through the tool gate: the step totals, the list of
 * tool calls and their outcomes, the refusals and their layers, and the two
 * mutation fields. `narrative` is prose the *model* wrote, and the model did
 * not execute anything and cannot see the gate — so "I removed the old A
 * record" is a sentence it can produce about a call that was denied.
 *
 * If those two are rendered as one block of text, the model's account reads as
 * the record. So they are not: the record comes first, in its own region, each
 * number next to the thing it counts; the narrative comes last, in a region
 * labelled as the assistant's own account, attributed in the heading and not
 * merely in a tooltip. A reader who only looks at the top of this panel sees
 * only facts.
 *
 * **`mutatingToolsRun` and `anyChangeAttempted` lead** whenever anything
 * mutating ran, because "what did you just change in my account" is the
 * question this panel exists to answer, and an answer buried under four
 * counters is not one.
 */
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  MessageSquareQuote,
  MinusCircle,
  Pencil,
  ShieldAlert,
  XCircle,
} from "lucide-react";

import { useI18n } from "@/hooks/use-i18n";
import {
  aiRefusalScreen,
  aiRunSummaryDidAnything,
  groupAiRunToolRuns,
  isAiRefusalSource,
} from "@/lib/ai/plan";
import type {
  AiRunStepTotals,
  AiRunSummary,
  AiRunToolOutcome,
} from "@/types/ai";

export interface AiRunSummaryViewProps {
  summary: AiRunSummary;
}

type TotalKey = keyof AiRunStepTotals;

const TOTAL_ORDER: readonly TotalKey[] = [
  "done",
  "failed",
  "blocked",
  "skipped",
  "pending",
] as const;

export function AiRunSummaryView({ summary }: AiRunSummaryViewProps) {
  const { t } = useI18n();

  const totalLabels: Record<TotalKey, string> = {
    done: t("Completed", "Completed"),
    failed: t("Failed", "Failed"),
    blocked: t("Blocked", "Blocked"),
    skipped: t("Yours to do", "Yours to do"),
    pending: t("Never started", "Never started"),
  };

  const outcomeLabels: Record<AiRunToolOutcome, string> = {
    ok: t("Succeeded", "Succeeded"),
    failed: t("Failed", "Failed"),
    denied: t("Refused by permissions", "Refused by permissions"),
    notRun: t("Not run", "Not run"),
  };

  const outcomeIcons: Record<AiRunToolOutcome, typeof CheckCircle2> = {
    ok: CheckCircle2,
    failed: XCircle,
    denied: Ban,
    notRun: CircleDashed,
  };

  const mutating = summary.mutatingToolsRun;
  const changed = summary.anyChangeAttempted || mutating.length > 0;
  /**
   * Whether anything happened at all — read off the record and never off
   * `narrative`, which is exactly the case this panel exists to keep straight:
   * a plan cancelled before its first step can still carry a paragraph
   * describing work.
   */
  const didAnything = aiRunSummaryDidAnything(summary);
  const narrative =
    typeof summary.narrative === "string" && summary.narrative.trim().length > 0
      ? summary.narrative
      : null;

  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border border-border/60 bg-card/40 p-3"
      data-testid="ai-run-summary"
      data-plan-id={summary.planId}
      data-changed={changed}
      data-did-anything={didAnything}
      data-has-narrative={narrative !== null}
      aria-label={t("What this run did", "What this run did")}
    >
      <div className="min-w-0 space-y-1">
        <h4 className="text-sm font-semibold break-words [overflow-wrap:anywhere]">
          {t("What this run did", "What this run did")}
        </h4>
        <p className="text-xs break-words text-muted-foreground [overflow-wrap:anywhere]">
          {summary.title}
        </p>
      </div>

      {/* ── The record ──────────────────────────────────────────────────────
          Harness-derived, and labelled as such in words rather than by
          position alone, because position is not something a screen reader
          conveys. */}
      <div
        role="group"
        aria-label={t(
          "Recorded by the app, not written by the assistant",
          "Recorded by the app, not written by the assistant",
        )}
        className="min-w-0 space-y-2"
        data-testid="ai-run-facts"
      >
        <p
          className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
          data-testid="ai-run-facts-attribution"
        >
          {t(
            "Recorded by the app, not written by the assistant",
            "Recorded by the app, not written by the assistant",
          )}
        </p>

        {/* The mutation answer, first and in its own box whenever anything
            mutating ran. */}
        <div
          className="min-w-0 space-y-1 rounded-md border border-border/60 bg-background/40 px-3 py-2"
          data-testid="ai-run-mutations"
          data-changed={changed}
        >
          <p className="flex items-start gap-1.5 text-xs font-medium">
            {changed ? (
              <Pencil
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
            ) : (
              <MinusCircle
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
            )}
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {changed
                ? t(
                    "This run used tools that can change your account.",
                    "This run used tools that can change your account.",
                  )
                : t(
                    "Nothing in your account was changed: no tool that can change anything ran.",
                    "Nothing in your account was changed: no tool that can change anything ran.",
                  )}
            </span>
          </p>
          {mutating.length > 0 ? (
            <ul
              role="list"
              data-testid="ai-run-mutating-tools"
              className="flex flex-wrap gap-1"
            >
              {mutating.map((tool) => (
                <li
                  key={tool}
                  data-tool={tool}
                  className="rounded border border-border/60 bg-background/60 px-1.5 py-0.5 font-mono text-[11px] break-all"
                >
                  {tool}
                </li>
              ))}
            </ul>
          ) : null}
          {changed && mutating.length === 0 ? (
            // `anyChangeAttempted` without a named tool: a mutating call was
            // attempted and did not complete, which is still an answer to
            // "did anything touch my account" and must not be rounded down.
            <p
              className="text-xs break-words text-muted-foreground [overflow-wrap:anywhere]"
              data-testid="ai-run-attempted-only"
            >
              {t(
                "A change was attempted but no tool completed one, so there is no list of tools to show.",
                "A change was attempted but no tool completed one, so there is no list of tools to show.",
              )}
            </p>
          ) : null}
        </div>

        {didAnything ? null : (
          // Stated rather than left to five zeros, because a plan closed
          // before its first step can still carry a narrative describing
          // work, and this is the line that contradicts it.
          <p
            data-testid="ai-run-nothing-happened"
            className="text-xs break-words [overflow-wrap:anywhere]"
          >
            {t(
              "No step was ever dispatched: this plan was closed before anything ran.",
              "No step was ever dispatched: this plan was closed before anything ran.",
            )}
          </p>
        )}

        <dl
          className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs"
          data-testid="ai-run-step-totals"
        >
          {TOTAL_ORDER.map((key) => (
            <div key={key} className="flex min-w-0 items-baseline gap-1.5">
              <dt className="min-w-0 truncate text-muted-foreground">
                {totalLabels[key]}
              </dt>
              <dd
                className="font-mono font-medium"
                data-testid="ai-run-total"
                data-total={key}
              >
                {summary.stepTotals[key]}
              </dd>
            </div>
          ))}
        </dl>

        {summary.toolRuns.length > 0 ? (
          <div className="min-w-0 space-y-1" data-testid="ai-run-tool-runs">
            {groupAiRunToolRuns(summary).map(({ outcome, runs }) => {
              const Icon = outcomeIcons[outcome];
              return (
                <div
                  key={outcome}
                  className="min-w-0 space-y-0.5"
                  data-testid="ai-run-tool-group"
                  data-outcome={outcome}
                >
                  <p className="flex items-center gap-1.5 text-xs font-medium">
                    <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    {outcomeLabels[outcome]}
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {runs.length}
                    </span>
                  </p>
                  <ul role="list" className="space-y-0.5 pl-5">
                    {runs.map((run) => (
                      <li
                        key={`${run.tool}-${run.stepIndex}`}
                        data-testid="ai-run-tool"
                        data-tool={run.tool}
                        data-step={run.stepIndex + 1}
                        className="font-mono text-[11px] break-all text-muted-foreground"
                      >
                        {t("Step {{step}}: {{tool}}", {
                          step: run.stepIndex + 1,
                          tool: run.tool,
                          defaultValue: `Step ${run.stepIndex + 1}: ${run.tool}`,
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : null}

        {summary.refusals.length > 0 ? (
          <ul role="list" data-testid="ai-run-refusals" className="space-y-1">
            {summary.refusals.map((refusal, index) => {
              const screen = aiRefusalScreen(refusal.source);
              return (
                <li
                  key={`${refusal.tool}-${index}`}
                  data-testid="ai-run-refusal"
                  data-tool={refusal.tool}
                  data-source={
                    isAiRefusalSource(refusal.source)
                      ? refusal.source
                      : "unknown"
                  }
                  className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs"
                >
                  <ShieldAlert
                    aria-hidden="true"
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  />
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    <span className="font-mono break-all">{refusal.tool}</span>{" "}
                    {screen === "assistantTools"
                      ? t(
                          "was refused by the assistant's own tool permissions (Tools & permissions).",
                          "was refused by the assistant's own tool permissions (Tools & permissions).",
                        )
                      : screen === "sessionSettingsMcp"
                        ? t(
                            "was refused by the app's MCP tool permissions (Session settings, MCP).",
                            "was refused by the app's MCP tool permissions (Session settings, MCP).",
                          )
                        : t(
                            "was refused, and the app cannot say which permission layer refused it.",
                            "was refused, and the app cannot say which permission layer refused it.",
                          )}{" "}
                    <span className="text-muted-foreground">
                      {refusal.reason}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {/* ── The assistant's account ─────────────────────────────────────────
          Last, in its own labelled region, attributed in the heading. It is
          not interleaved with the record above and never replaces a number
          from it. */}
      {narrative !== null ? (
        <div
          role="group"
          aria-label={t(
            "The assistant's own account of the run",
            "The assistant's own account of the run",
          )}
          className="min-w-0 space-y-1 rounded-md border border-dashed border-border/60 bg-background/30 px-3 py-2"
          data-testid="ai-run-narrative"
        >
          <p
            className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            data-testid="ai-run-narrative-attribution"
          >
            <MessageSquareQuote
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0"
            />
            {t("Written by the assistant", "Written by the assistant")}
          </p>
          <p className="text-xs break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
            {narrative}
          </p>
          <p
            className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
            data-testid="ai-run-narrative-caveat"
          >
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-3 w-3 shrink-0"
            />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {t(
                "The assistant did not run these tools itself and cannot see what the permission gate allowed, so check this against the record above rather than the other way round.",
                "The assistant did not run these tools itself and cannot see what the permission gate allowed, so check this against the record above rather than the other way round.",
              )}
            </span>
          </p>
        </div>
      ) : null}
    </section>
  );
}
