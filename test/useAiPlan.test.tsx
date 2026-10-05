/**
 * The plan and link hooks.
 *
 * What is actually being pinned:
 *
 * - **There are no plan events.** Every command answers with the authoritative
 *   plan, and the hook stores what came back rather than deriving a status, a
 *   step outcome or a count. The one command that answers with nothing is
 *   `ai_approve_tool_call`, which is why approving a waiting step is followed
 *   by an `ai_get_plan` re-read instead of an optimistic edit.
 * - **A plan can appear with no command called at all**, because the model
 *   proposes one through its own tool during a turn. That is what `revision`
 *   exists for, and the re-read it triggers is the only way a newly proposed
 *   plan reaches the screen.
 * - **The run record is read only once the plan is terminal.** Asking earlier
 *   would be asking for a record of a run that has not finished, and the
 *   command is keyed on the status rather than the whole plan so an
 *   `updatedAt` bump cannot re-issue it.
 * - A step id that is not a UUID produces **no** `ai_approve_tool_call` at
 *   all: the id goes to a command that also serves transcript approvals.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { useAiLinks } from "../src/hooks/ai/use-ai-links";
import { useAiPlan } from "../src/hooks/ai/use-ai-plan";
import { TauriClient } from "../src/lib/api/tauri-client";
import type {
  AiCommandError,
  AiLink,
  AiPlan,
  AiPlanStep,
  AiRunSummary,
} from "../src/types/ai";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;

const STEP_ID = "11111111-2222-3333-4444-555555555555";

function step(overrides: Partial<AiPlanStep> = {}): AiPlanStep {
  return {
    id: STEP_ID,
    index: 0,
    title: "List the MX records",
    detail: "",
    tool: "dns_list_records",
    status: "pending",
    ...overrides,
  };
}

function plan(overrides: Partial<AiPlan> = {}): AiPlan {
  return {
    id: "plan-1",
    conversationId: "c1",
    title: "Fix the mail records",
    status: "draft",
    steps: [step()],
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    ...overrides,
  };
}

function summary(overrides: Partial<AiRunSummary> = {}): AiRunSummary {
  return {
    planId: "plan-1",
    title: "Fix the mail records",
    startedAt: "2026-10-01T10:01:00Z",
    finishedAt: "2026-10-01T10:02:00Z",
    stepTotals: { done: 1, blocked: 0, failed: 0, skipped: 0, pending: 0 },
    toolRuns: [],
    refusals: [],
    mutatingToolsRun: [],
    anyChangeAttempted: false,
    // Explicit `null`, as serde emits it — never an absent key.
    narrative: null,
    ...overrides,
  };
}

interface Backend {
  calls: string[];
  /** What `ai_get_plan` answers; mutated by the fake commands. */
  stored: AiPlan | null;
  links: AiLink[];
  summary: AiRunSummary | null;
  failures: Map<string, unknown>;
}

function installBackend(initial: AiPlan | null = plan()): Backend {
  const backend: Backend = {
    calls: [],
    stored: initial,
    links: [],
    summary: null,
    failures: new Map(),
  };

  const record =
    <T,>(name: string, result: () => T) =>
    async (...args: unknown[]) => {
      backend.calls.push(args.length > 1 ? `${name}:${String(args[1])}` : name);
      if (backend.failures.has(name)) throw backend.failures.get(name);
      return result();
    };

  mock.method(
    TauriClient,
    "aiGetPlan",
    record("get", () => backend.stored),
  );
  mock.method(
    TauriClient,
    "aiApprovePlan",
    record("approve", () => {
      backend.stored = { ...plan(), status: "approved" };
      return backend.stored;
    }),
  );
  mock.method(
    TauriClient,
    "aiRunPlan",
    record("run", () => {
      backend.stored = {
        ...plan(),
        status: "done",
        steps: [step({ status: "done", result: "3 records" })],
      };
      return backend.stored;
    }),
  );
  mock.method(
    TauriClient,
    "aiRunPlanStep",
    record("runStep", () => {
      backend.stored = {
        ...plan(),
        status: "paused",
        steps: [
          step({
            status: "blocked",
            refusal: { source: "mcpGrants", reason: "not granted" },
          }),
        ],
      };
      return backend.stored;
    }),
  );
  mock.method(
    TauriClient,
    "aiApproveToolCall",
    record("approveToolCall", () => {
      // The command answers `()`. The *only* way to learn what it did is the
      // re-read that follows.
      backend.stored = {
        ...plan(),
        status: "done",
        steps: [step({ status: "done", result: "ran after approval" })],
      };
      return undefined;
    }),
  );
  mock.method(
    TauriClient,
    "aiCancelPlan",
    record("cancel", () => {
      backend.stored = { ...plan(), status: "cancelled" };
      return backend.stored;
    }),
  );
  mock.method(
    TauriClient,
    "aiDeletePlan",
    record("delete", () => {
      backend.stored = null;
      return true;
    }),
  );
  mock.method(
    TauriClient,
    "aiGetRunSummary",
    record("summary", () => backend.summary),
  );
  mock.method(
    TauriClient,
    "aiGetLinks",
    record("links", () => backend.links),
  );
  return backend;
}

function named(backend: Backend, name: string): string[] {
  return backend.calls.filter((call) => call.split(":")[0] === name);
}

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

// ── Reading ────────────────────────────────────────────────────────────────

test("the hook is inert with no conversation and on the web build", async () => {
  const backend = installBackend();
  const none = renderHook(() => useAiPlan(null));
  await waitFor(() => assert.equal(none.result.current.loading, false));
  assert.equal(none.result.current.plan, null);
  assert.deepEqual(backend.calls, []);

  (globalThis as unknown as { window?: unknown }).window = undefined;
  const web = renderHook(() => useAiPlan("c1"));
  await waitFor(() => assert.equal(web.result.current.available, false));
  assert.deepEqual(backend.calls, []);
});

test("the plan comes from the backend and is never reconstructed", async () => {
  const backend = installBackend(plan({ status: "approved" }));
  const hook = renderHook(() => useAiPlan("c1"));
  await waitFor(() =>
    assert.equal(hook.result.current.plan?.status, "approved"),
  );
  assert.deepEqual(named(backend, "get"), ["get"]);
  assert.equal(hook.result.current.loadError, null);
});

test("a plan that could not be read is a failure, not an absent plan", async () => {
  const backend = installBackend();
  const failure: AiCommandError = {
    code: "AI_DESKTOP_ONLY",
    message: "the bridge is unavailable",
    source: "agent",
    operation: "ai:get_plan",
    retryable: true,
    details: {},
  };
  backend.failures.set("get", failure);
  const hook = renderHook(() => useAiPlan("c1"));
  // Deliberately not falling back to "no plan": that would hide an approved
  // plan from the person who approved it.
  await waitFor(() => assert.ok(hook.result.current.loadError));
  assert.equal(hook.result.current.plan, null);
});

test("a changed transcript re-reads the plan, because a proposal emits no event", async () => {
  const backend = installBackend(null);
  const hook = renderHook(
    ({ revision }: { revision: string }) => useAiPlan("c1", { revision }),
    { initialProps: { revision: "r1" } },
  );
  await waitFor(() => assert.equal(named(backend, "get").length, 1));
  assert.equal(hook.result.current.plan, null);

  // The model has proposed a plan during a turn. There is no plan event, so
  // the transcript's own timestamp is the trigger.
  backend.stored = plan();
  await act(async () => {
    hook.rerender({ revision: "r2" });
  });
  await waitFor(() => assert.equal(hook.result.current.plan?.id, "plan-1"));
  assert.equal(named(backend, "get").length, 2);
});

// ── Mutating ───────────────────────────────────────────────────────────────

test("every command stores the plan it answers with", async () => {
  const backend = installBackend();
  const hook = renderHook(() => useAiPlan("c1"));
  await waitFor(() => assert.equal(hook.result.current.plan?.status, "draft"));

  await act(async () => {
    await hook.result.current.approve();
  });
  assert.equal(hook.result.current.plan?.status, "approved");
  // No re-read: the command already answered with the authoritative plan.
  assert.equal(named(backend, "get").length, 1);

  await act(async () => {
    await hook.result.current.run();
  });
  assert.equal(hook.result.current.plan?.status, "done");
  assert.equal(hook.result.current.plan?.steps[0].status, "done");
  assert.equal(named(backend, "get").length, 1);
});

test("running one step stores the plan including a step that came back blocked", async () => {
  const backend = installBackend(plan({ status: "approved" }));
  const hook = renderHook(() => useAiPlan("c1"));
  await waitFor(() =>
    assert.equal(hook.result.current.plan?.status, "approved"),
  );

  await act(async () => {
    await hook.result.current.runStep(STEP_ID);
  });
  // Re-gated at run time: the permission was withdrawn since approval, and
  // the UI shows what the backend says rather than assuming the run worked.
  assert.equal(hook.result.current.plan?.steps[0].status, "blocked");
  assert.equal(hook.result.current.plan?.steps[0].refusal?.source, "mcpGrants");
  assert.deepEqual(named(backend, "runStep"), [`runStep:${STEP_ID}`]);
});

test("approving a waiting step calls the existing command, then re-reads", async () => {
  const backend = installBackend(
    plan({ status: "paused", steps: [step({ status: "awaitingApproval" })] }),
  );
  const hook = renderHook(() => useAiPlan("c1"));
  await waitFor(() => assert.equal(hook.result.current.plan?.status, "paused"));
  const readsBefore = named(backend, "get").length;

  await act(async () => {
    await hook.result.current.approveStep(STEP_ID);
  });

  // The existing approval command, under the `plan-step-` tool-call id — no
  // second approval command exists.
  assert.deepEqual(named(backend, "approveToolCall"), [
    "approveToolCall:plan-step-11111111222233334444555555555555",
  ]);
  // And then the re-read, because the command resolves with nothing.
  assert.equal(named(backend, "get").length, readsBefore + 1);
  assert.equal(hook.result.current.plan?.steps[0].status, "done");
});

test("a step id that is not a UUID is never sent as an approval", async () => {
  const backend = installBackend(
    plan({ status: "paused", steps: [step({ status: "awaitingApproval" })] }),
  );
  const hook = renderHook(() => useAiPlan("c1"));
  await waitFor(() => assert.ok(hook.result.current.plan));

  await act(async () => {
    await hook.result.current.approveStep("../../etc/passwd");
  });
  // `ai_approve_tool_call` also serves transcript tool calls, so a forged id
  // is the one way an approval could land somewhere else.
  assert.deepEqual(named(backend, "approveToolCall"), []);
  assert.equal(hook.result.current.error?.action, "approveStep");
});

test("discarding leaves no plan rather than a stale one", async () => {
  installBackend();
  const hook = renderHook(() => useAiPlan("c1"));
  await waitFor(() => assert.ok(hook.result.current.plan));

  await act(async () => {
    await hook.result.current.remove();
  });
  assert.equal(hook.result.current.plan, null);
});

test("a refused command is kept as state next to the control, not thrown", async () => {
  const backend = installBackend();
  backend.failures.set("approve", {
    code: "AI_PLAN_STATE_CONFLICT",
    message: "a draft plan cannot be approved twice",
    source: "agent",
    operation: "ai:approve_plan",
    retryable: false,
    details: {
      remediation: "Re-read the plan with ai_get_plan and try again.",
    },
  } satisfies AiCommandError);
  const hook = renderHook(() => useAiPlan("c1"));
  await waitFor(() => assert.ok(hook.result.current.plan));

  await act(async () => {
    await hook.result.current.approve();
  });
  assert.equal(
    hook.result.current.error?.message,
    "a draft plan cannot be approved twice",
  );
  assert.equal(
    hook.result.current.error?.remediation,
    "Re-read the plan with ai_get_plan and try again.",
  );
  assert.equal(hook.result.current.error?.action, "approve");
  // The plan is untouched: a refused command changed nothing.
  assert.equal(hook.result.current.plan?.status, "draft");

  act(() => hook.result.current.dismissError());
  assert.equal(hook.result.current.error, null);
});

// ── The run record ─────────────────────────────────────────────────────────

test("the run record is asked for only once the plan is terminal", async () => {
  const backend = installBackend(plan({ status: "approved" }));
  backend.summary = summary();
  const hook = renderHook(() => useAiPlan("c1"));
  await waitFor(() =>
    assert.equal(hook.result.current.plan?.status, "approved"),
  );
  // Nothing has finished, so there is no record of a run to ask for.
  assert.deepEqual(named(backend, "summary"), []);

  await act(async () => {
    await hook.result.current.run();
  });
  await waitFor(() => assert.ok(hook.result.current.summary));
  assert.deepEqual(named(backend, "summary"), ["summary"]);
  assert.equal(hook.result.current.summary?.planId, "plan-1");
});

test("an unreadable run record is reported rather than smoothed into none", async () => {
  const backend = installBackend(plan({ status: "done" }));
  backend.failures.set("summary", new Error("no such command"));
  const hook = renderHook(() => useAiPlan("c1"));
  await waitFor(() => assert.ok(hook.result.current.summaryError));
  assert.equal(hook.result.current.summary, null);
});

// ── Links ──────────────────────────────────────────────────────────────────

test("links are read per conversation and re-read when the transcript changes", async () => {
  const backend = installBackend();
  backend.links = [
    { kind: "workspace", label: "Registry", target: "registry" },
  ];
  const hook = renderHook(
    ({ revision }: { revision: string }) => useAiLinks("c1", { revision }),
    { initialProps: { revision: "r1" } },
  );
  await waitFor(() => assert.equal(hook.result.current.links.length, 1));
  assert.equal(hook.result.current.links[0].target, "registry");

  // An offer replaces the last one, which is what makes this a re-read rather
  // than an append.
  backend.links = [
    { kind: "external", label: "Docs", target: "https://example.com/" },
  ];
  await act(async () => {
    hook.rerender({ revision: "r2" });
  });
  await waitFor(() =>
    assert.equal(hook.result.current.links[0]?.target, "https://example.com/"),
  );
  assert.equal(named(backend, "links").length, 2);
});

test("an unreadable link offer is an empty list and a reported reason", async () => {
  const backend = installBackend();
  backend.failures.set("links", new Error("bridge is down"));
  const hook = renderHook(() => useAiLinks("c1"));
  await waitFor(() => assert.ok(hook.result.current.loadError));
  // "pointing at nothing" and "we could not ask" look identical on screen;
  // only one of them is a reason to retry.
  assert.deepEqual(hook.result.current.links, []);
});

test("a link payload that is not a list reads as no links", async () => {
  const backend = installBackend();
  mock.method(TauriClient, "aiGetLinks", async () => {
    backend.calls.push("links");
    return null as unknown as AiLink[];
  });
  const hook = renderHook(() => useAiLinks("c1"));
  await waitFor(() => assert.equal(named(backend, "links").length, 1));
  assert.deepEqual(hook.result.current.links, []);
});
