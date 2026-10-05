/**
 * The conversation's plan, and what the run did.
 *
 * Kept apart from `use-ai-chat.ts` for a reason that is not organisational:
 * **there are no plan events.** `AgentEvent` belongs to a generation turn and
 * a plan command has no turn to attach to, so there is nothing here to
 * subscribe to and nothing to accumulate. Every command answers with the
 * authoritative plan, and this hook stores what came back and never derives a
 * status, a step outcome or a count from it. The one command that answers with
 * nothing is `ai_approve_tool_call`, which is why approving a waiting step is
 * followed by an `ai_get_plan` re-read rather than by an optimistic edit.
 *
 * A plan can also appear without any command being called at all: the model
 * proposes one through its own `plan_propose` tool during a turn. That emits no
 * event either, so the caller passes a `revision` — some value that changes
 * when the transcript does — and the plan is re-read then.
 *
 * Desktop only, like every other `ai_*` call.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { TauriClient } from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import { isAiPlanTerminal, planStepToolCallId } from "@/lib/ai/plan";
import { isAiCommandError, type AiPlan, type AiRunSummary } from "@/types/ai";

/** Which action is in flight. One at a time; a second is dropped, not queued. */
export type AiPlanAction =
  "approve" | "run" | "runStep" | "approveStep" | "cancel" | "delete";

/** A plan failure worth showing, flattened from either rejection channel. */
export interface AiPlanError {
  message: string;
  remediation?: string;
  retryable: boolean;
  /** Which action produced it, so the message can sit next to that control. */
  action: AiPlanAction;
}

function reportAiFailure(error: unknown, label: string): void {
  reportRuntimeError(error, { source: "runtime", label });
}

function toPlanError(
  error: unknown,
  action: AiPlanAction,
  fallback: string,
): AiPlanError {
  if (isAiCommandError(error)) {
    return {
      message: error.message,
      remediation: error.details.remediation,
      retryable: error.retryable,
      action,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, retryable: false, action };
  }
  if (typeof error === "string" && error.length > 0) {
    return { message: error, retryable: false, action };
  }
  return { message: fallback, retryable: false, action };
}

function useMountedRef() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

export interface UseAiPlanOptions {
  /**
   * Changes whenever the transcript does, so a plan the model proposed during
   * a turn is picked up. Any value works; only inequality is used.
   */
  revision?: string | number | null;
}

export interface UseAiPlanResult {
  /** `null` when the conversation has no plan, or until the read answers. */
  plan: AiPlan | null;
  /**
   * The harness's record of the run. Read only once the plan is terminal,
   * because that is the only point at which it is a record of anything.
   */
  summary: AiRunSummary | null;
  /** Why the summary could not be read. Reported, never smoothed into `null`. */
  summaryError: unknown;
  loading: boolean;
  loadError: unknown;
  /** The action in flight, or `null`. */
  busy: AiPlanAction | null;
  error: AiPlanError | null;
  available: boolean;
  refresh: () => Promise<void>;
  approve: () => Promise<void>;
  run: () => Promise<void>;
  runStep: (stepId: string) => Promise<void>;
  /** Approve a step waiting on `ask`, then re-read: the command answers `()`. */
  approveStep: (stepId: string) => Promise<void>;
  cancel: () => Promise<void>;
  remove: () => Promise<void>;
  dismissError: () => void;
}

export function useAiPlan(
  conversationId: string | null,
  options: UseAiPlanOptions = {},
): UseAiPlanResult {
  const available = isDesktop();
  const revision = options.revision ?? null;
  const [plan, setPlan] = useState<AiPlan | null>(null);
  const [summary, setSummary] = useState<AiRunSummary | null>(null);
  const [summaryError, setSummaryError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState<AiPlanAction | null>(null);
  const [error, setError] = useState<AiPlanError | null>(null);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++refreshVersionRef.current;
    if (!conversationId || !available) {
      if (mountedRef.current) {
        setPlan(null);
        setLoadError(null);
        setLoading(false);
      }
      return;
    }
    if (mountedRef.current) setLoading(true);
    try {
      const result = await TauriClient.aiGetPlan(conversationId);
      if (mountedRef.current && refreshVersionRef.current === version) {
        setPlan(result);
        setLoadError(null);
      }
    } catch (readError) {
      if (mountedRef.current && refreshVersionRef.current === version) {
        // Not falling back to "no plan": a plan that exists and could not be
        // read is a different thing from a conversation that has none, and
        // showing the second would hide an approved plan from its owner.
        setLoadError(readError);
      }
      reportAiFailure(readError, "Read AI plan");
    } finally {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [available, conversationId, mountedRef]);

  useEffect(() => {
    void refresh();
    // `revision` is a deliberate extra trigger, not a value this reads: a plan
    // proposed during a turn arrives with no event of its own.
  }, [refresh, revision]);

  // Switching conversations must not leave another plan's summary or failure
  // on screen.
  useEffect(() => {
    setSummary(null);
    setSummaryError(null);
    setError(null);
  }, [conversationId]);

  /**
   * The run record, read exactly when the plan is terminal.
   *
   * Keyed on the status and the plan id rather than on the whole plan, so a
   * `updatedAt` bump cannot re-issue the command, and a plan that is still
   * running does not get asked for a record of a run that has not finished.
   */
  const terminal = plan !== null && isAiPlanTerminal(plan.status);
  const planId = plan?.id ?? null;
  const planStatus = plan?.status ?? null;

  useEffect(() => {
    if (!available || conversationId === null || !terminal) {
      setSummary(null);
      setSummaryError(null);
      return;
    }
    let cancelled = false;
    void TauriClient.aiGetRunSummary(conversationId)
      .then((result) => {
        if (cancelled || !mountedRef.current) return;
        setSummary(result);
        setSummaryError(null);
      })
      .catch((readError) => {
        if (!cancelled && mountedRef.current) {
          setSummary(null);
          setSummaryError(readError);
        }
        reportAiFailure(readError, "Read AI run summary");
      });
    return () => {
      cancelled = true;
    };
  }, [available, conversationId, mountedRef, planId, planStatus, terminal]);

  /**
   * Run one plan command and store the plan it answers with.
   *
   * A second action while one is in flight is dropped rather than queued: the
   * commands are not ordered against each other, so the loser would silently
   * win. Rejections are kept as state rather than rethrown — each control
   * renders the message next to itself.
   */
  const perform = useCallback(
    async (
      action: AiPlanAction,
      fallback: string,
      operation: (conversationId: string) => Promise<AiPlan | null>,
    ) => {
      if (!available || conversationId === null) return;
      if (busy !== null) return;
      setBusy(action);
      setError(null);
      try {
        const result = await operation(conversationId);
        if (!mountedRef.current) return;
        // Deleting answers a boolean, not a plan, and `null` here means the
        // plan is gone rather than unchanged.
        setPlan(result);
        setLoadError(null);
      } catch (actionError) {
        if (mountedRef.current) {
          setError(toPlanError(actionError, action, fallback));
        }
        reportAiFailure(actionError, `AI plan: ${action}`);
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [available, busy, conversationId, mountedRef],
  );

  const approve = useCallback(
    () =>
      perform("approve", "The plan could not be approved.", (id) =>
        TauriClient.aiApprovePlan(id),
      ),
    [perform],
  );

  const run = useCallback(
    () =>
      perform("run", "The plan could not be run.", (id) =>
        TauriClient.aiRunPlan(id),
      ),
    [perform],
  );

  const runStep = useCallback(
    (stepId: string) =>
      perform("runStep", "The step could not be run.", (id) =>
        TauriClient.aiRunPlanStep(id, stepId),
      ),
    [perform],
  );

  /**
   * Approve a step waiting on `ask`.
   *
   * Two round trips, and the second is not optional: `ai_approve_tool_call`
   * resolves with `()`, so the only way to learn what the approval did — it
   * runs the step, which can still fail or be refused by a grant withdrawn in
   * the meantime — is to read the plan back.
   */
  const approveStep = useCallback(
    (stepId: string) =>
      perform("approveStep", "The step could not be approved.", async (id) => {
        const toolCallId = planStepToolCallId(stepId);
        if (toolCallId === null) {
          // A step id that is not a UUID cannot be addressed, and prefixing it
          // anyway would send a forged tool-call id to a command that also
          // serves transcript approvals.
          throw new Error("That step cannot be approved.");
        }
        await TauriClient.aiApproveToolCall(id, toolCallId);
        return TauriClient.aiGetPlan(id);
      }),
    [perform],
  );

  const cancel = useCallback(
    () =>
      perform("cancel", "The plan could not be cancelled.", (id) =>
        TauriClient.aiCancelPlan(id),
      ),
    [perform],
  );

  const remove = useCallback(
    () =>
      perform("delete", "The plan could not be discarded.", async (id) => {
        await TauriClient.aiDeletePlan(id);
        return null;
      }),
    [perform],
  );

  const dismissError = useCallback(() => setError(null), []);

  return {
    plan,
    summary,
    summaryError,
    loading,
    loadError,
    busy,
    error,
    available,
    refresh,
    approve,
    run,
    runStep,
    approveStep,
    cancel,
    remove,
    dismissError,
  };
}
