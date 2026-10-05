/**
 * The plan checklist, and the run record under it.
 *
 * The assertions worth reading first are the blocked-step ones. The harness
 * resolves every step's tool through the permission gate *at proposal time*,
 * so a step that cannot run says so before the user approves anything — and
 * the two layers that can refuse it live on different screens. A UI that said
 * only "blocked" would leave the user with nothing to do, and one that named
 * the wrong layer would send them to change a setting that is not refusing
 * them. Those two failure modes are what the tests below are shaped around.
 *
 * The second group is the summary's separation of harness fact from model
 * prose. `narrative` is the only field a model writes and no counted field
 * reads it, so a narrative claiming a deletion sits beside a record saying
 * nothing was dispatched. The test drives exactly that case.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AiPlanView } from "../src/components/ai/AiPlanView";
import { AI_PLAN_STEP_STATUSES } from "../src/lib/ai/plan";
import type {
  AiPlan,
  AiPlanStep,
  AiPlanStatus,
  AiRunSummary,
} from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";

const STEP_ID = "11111111-2222-3333-4444-555555555555";

function step(overrides: Partial<AiPlanStep> = {}): AiPlanStep {
  return {
    id: STEP_ID,
    index: 0,
    title: "List the MX records",
    detail: "So the rest of the plan has something to act on.",
    tool: "dns_list_records",
    status: "pending",
    ...overrides,
  };
}

function plan(overrides: Partial<AiPlan> = {}): AiPlan {
  return {
    id: "plan-1",
    conversationId: "conv-1",
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
    stepTotals: { done: 0, blocked: 0, failed: 0, skipped: 0, pending: 0 },
    toolRuns: [],
    refusals: [],
    mutatingToolsRun: [],
    anyChangeAttempted: false,
    // Explicit `null`, as serde emits it — never an absent key.
    narrative: null,
    ...overrides,
  };
}

interface Harness {
  approved: number;
  ran: number;
  runSteps: string[];
  approvedSteps: string[];
  cancelled: number;
  deleted: number;
  openedAssistantTools: number;
  openedMcp: number;
}

function renderPlan(
  overrides: Partial<React.ComponentProps<typeof AiPlanView>> = {},
): Harness {
  const harness: Harness = {
    approved: 0,
    ran: 0,
    runSteps: [],
    approvedSteps: [],
    cancelled: 0,
    deleted: 0,
    openedAssistantTools: 0,
    openedMcp: 0,
  };
  render(
    <AiPlanView
      plan={plan()}
      summary={null}
      summaryError={null}
      loading={false}
      loadError={null}
      busy={null}
      error={null}
      onApprove={() => {
        harness.approved += 1;
      }}
      onRun={() => {
        harness.ran += 1;
      }}
      onRunStep={(id) => harness.runSteps.push(id)}
      onApproveStep={(id) => harness.approvedSteps.push(id)}
      onCancel={() => {
        harness.cancelled += 1;
      }}
      onDelete={() => {
        harness.deleted += 1;
      }}
      onRetry={() => {}}
      onDismissError={() => {}}
      onOpenAssistantTools={() => {
        harness.openedAssistantTools += 1;
      }}
      onOpenMcpPermissions={() => {
        harness.openedMcp += 1;
      }}
      {...overrides}
    />,
  );
  return harness;
}

/** Cheap "nothing matched": see `AiAssistantPanel.test.tsx` for why. */
function assertAbsent(node: Element | null, label: string): void {
  assert.ok(node === null, `expected no ${label}`);
}

beforeEach(async () => {
  await useEnglishLocale();
});

afterEach(() => {
  cleanup();
});

// ── Nothing to show costs nothing ──────────────────────────────────────────

test("a conversation with no plan renders nothing at all", () => {
  renderPlan({ plan: null });
  // The dock is 22rem and the bubble 26rem; every row here is transcript
  // height taken from a surface that has none to spare.
  assertAbsent(screen.queryByTestId("ai-plan"), "plan section");
  assertAbsent(screen.queryByRole("alert"), "alert");
});

test("a plan that could not be read says so instead of looking absent", () => {
  // "No plan" and "we could not read the plan" are the same empty screen
  // otherwise, and only one of them hides an approved plan from its owner.
  renderPlan({ plan: null, loadError: new Error("bridge is down") });
  const alert = screen.getByTestId("ai-plan-load-error");
  assert.match(alert.textContent ?? "", /bridge is down/);
  assert.ok(screen.getByRole("button", { name: "Try again" }));
});

// ── A draft must not look runnable ─────────────────────────────────────────

test("a draft offers no run control, not even a disabled one", () => {
  const harness = renderPlan({ plan: plan({ status: "draft" }) });

  // `ai_run_plan` and `ai_run_plan_step` refuse a draft with
  // `PlanStateConflict`, so a disabled button would still be a promise the
  // backend does not keep. There is no run control in the DOM.
  assertAbsent(screen.queryByTestId("ai-plan-run"), "plan run control");
  assertAbsent(screen.queryByTestId("ai-plan-run-step"), "step run control");
  assertAbsent(
    screen.queryByTestId("ai-plan-approve-step"),
    "step approval control",
  );
  // Nor a cancel: discarding is the action a draft has.
  assertAbsent(screen.queryByTestId("ai-plan-cancel"), "cancel control");

  // What it does offer.
  const approve = screen.getByTestId("ai-plan-approve");
  fireEvent.click(approve);
  assert.equal(harness.approved, 1);
  fireEvent.click(screen.getByTestId("ai-plan-delete"));
  assert.equal(harness.deleted, 1);

  // And it says why, rather than leaving the missing button to be interpreted.
  assert.match(
    screen.getByTestId("ai-plan-explanation").textContent ?? "",
    /Nothing in it can run until you approve it/,
  );
});

test("an approved plan offers a run control and no approval", () => {
  const harness = renderPlan({
    plan: plan({ status: "approved", steps: [step({ status: "pending" })] }),
  });

  assertAbsent(screen.queryByTestId("ai-plan-approve"), "approve control");
  fireEvent.click(screen.getByTestId("ai-plan-run"));
  assert.equal(harness.ran, 1);
  fireEvent.click(screen.getByTestId("ai-plan-run-step"));
  assert.deepEqual(harness.runSteps, [STEP_ID]);
  fireEvent.click(screen.getByTestId("ai-plan-cancel"));
  assert.equal(harness.cancelled, 1);
});

test("a finished plan offers neither approval nor a run", () => {
  for (const status of ["done", "cancelled"] as const) {
    renderPlan({
      plan: plan({ status, steps: [step({ status: "done" })] }),
    });
    assertAbsent(
      screen.queryByTestId("ai-plan-approve"),
      `approve on ${status}`,
    );
    assertAbsent(screen.queryByTestId("ai-plan-run"), `run on ${status}`);
    cleanup();
  }
});

test("a failed plan can be run again, which is how a retry is reached", () => {
  // `ensure_plan_can_run` permits `failed`: re-running re-resolves
  // permissions and retries the step that failed.
  const harness = renderPlan({
    plan: plan({ status: "failed", steps: [step({ status: "failed" })] }),
  });
  fireEvent.click(screen.getByTestId("ai-plan-run"));
  assert.equal(harness.ran, 1);
  assert.ok(
    screen.getByRole("button", {
      name: "Retry step 1: List the MX records",
    }),
  );
});

// ── A blocked step names its layer and points at the right screen ──────────

test("a step blocked by the assistant's own policy points at Tools & permissions", () => {
  const harness = renderPlan({
    plan: plan({
      status: "paused",
      steps: [
        step({
          status: "blocked",
          refusal: {
            source: "assistantPolicy",
            reason: "dns_create_record is denied in read-only mode",
          },
        }),
      ],
    }),
  });

  const refusal = screen.getByTestId("ai-plan-step-refusal");
  assert.equal(refusal.dataset.source, "assistantPolicy");
  assert.equal(refusal.dataset.screen, "assistantTools");
  // The layer is named in words, not only in a data attribute.
  assert.match(
    refusal.textContent ?? "",
    /Refused by the assistant's own tool permissions/,
  );
  assert.match(
    refusal.textContent ?? "",
    /Settings, under Assistant, in Tools & permissions/,
  );
  // The backend's own reason is shown too, because it names the tool.
  assert.match(
    screen.getByTestId("ai-plan-step-refusal-reason").textContent ?? "",
    /dns_create_record is denied in read-only mode/,
  );

  // And the control goes to that screen. The *other* layer's screen is not
  // offered, because it is not the one refusing this step.
  fireEvent.click(screen.getByTestId("ai-plan-step-open-assistant-tools"));
  assert.equal(harness.openedAssistantTools, 1);
  assertAbsent(
    screen.queryByTestId("ai-plan-step-open-mcp-permissions"),
    "MCP control on an assistantPolicy refusal",
  );
});

test("a step blocked by the app's MCP grants points at Session settings", () => {
  const harness = renderPlan({
    plan: plan({
      status: "paused",
      steps: [
        step({
          status: "blocked",
          refusal: {
            source: "mcpGrants",
            reason: "dns_create_record is not granted to the assistant",
          },
        }),
      ],
    }),
  });

  const refusal = screen.getByTestId("ai-plan-step-refusal");
  assert.equal(refusal.dataset.source, "mcpGrants");
  assert.equal(refusal.dataset.screen, "sessionSettingsMcp");
  assert.match(
    refusal.textContent ?? "",
    /Refused by the app's own MCP tool permissions/,
  );
  // It also says the assistant cannot change these itself, which is the part
  // that stops a user looking for the switch in the assistant's settings.
  assert.match(refusal.textContent ?? "", /which the assistant cannot change/);
  assert.match(refusal.textContent ?? "", /Session settings, under MCP/);

  fireEvent.click(screen.getByTestId("ai-plan-step-open-mcp-permissions"));
  assert.equal(harness.openedMcp, 1);
  assertAbsent(
    screen.queryByTestId("ai-plan-step-open-assistant-tools"),
    "assistant-policy control on an mcpGrants refusal",
  );
});

test("a blocked step whose layer does not narrow admits it instead of guessing", () => {
  // A third layer added backend-side arrives as a string this build has never
  // seen. Mapping it onto one of the two known ones would point half the
  // users at a setting that is not refusing them.
  renderPlan({
    plan: plan({
      status: "paused",
      steps: [
        step({
          status: "blocked",
          refusal: {
            source: "someNewLayer" as never,
            reason: "refused upstream",
          },
        }),
      ],
    }),
  });

  const refusal = screen.getByTestId("ai-plan-step-refusal");
  assert.equal(refusal.dataset.source, "unknown");
  assert.equal(refusal.dataset.screen, "unknown");
  assert.match(
    refusal.textContent ?? "",
    /cannot tell which permission layer refused it/,
  );
  // Both screens are named, because either could be the one.
  assert.match(
    refusal.textContent ?? "",
    /Settings under Assistant, in Tools & permissions/,
  );
  assert.match(refusal.textContent ?? "", /Session settings, under MCP/);
  assert.ok(screen.getByTestId("ai-plan-step-open-assistant-tools"));
  assert.ok(screen.getByTestId("ai-plan-step-open-mcp-permissions"));
});

test("a plan blocked by both layers offers both screens, once each", () => {
  renderPlan({
    plan: plan({
      status: "paused",
      steps: [
        step({
          id: "aaaaaaaa-1111-1111-1111-111111111111",
          index: 0,
          status: "blocked",
          refusal: { source: "mcpGrants", reason: "not granted" },
        }),
        step({
          id: "bbbbbbbb-2222-2222-2222-222222222222",
          index: 1,
          status: "blocked",
          refusal: { source: "assistantPolicy", reason: "denied by mode" },
        }),
      ],
    }),
  });

  const notice = screen.getByTestId("ai-plan-blocked-notice");
  assert.equal(notice.dataset.sources, "assistantPolicy mcpGrants");
  assert.equal(notice.dataset.unknownSource, "false");
  assert.match(notice.textContent ?? "", /2 steps cannot run/);
  // The plan-level notice names both, so neither fix is buried in a step.
  assert.ok(screen.getByTestId("ai-plan-open-assistant-tools"));
  assert.ok(screen.getByTestId("ai-plan-open-mcp-permissions"));
});

test("without a host that owns the MCP screen the layer is still named", () => {
  // An inert button would be worse than none, but the sentence that says
  // which list to change is not the host's to provide.
  renderPlan({
    plan: plan({
      status: "paused",
      steps: [
        step({
          status: "blocked",
          refusal: { source: "mcpGrants", reason: "not granted" },
        }),
      ],
    }),
    onOpenMcpPermissions: undefined,
  });

  assert.match(
    screen.getByTestId("ai-plan-step-refusal").textContent ?? "",
    /Refused by the app's own MCP tool permissions/,
  );
  assertAbsent(
    screen.queryByTestId("ai-plan-step-open-mcp-permissions"),
    "MCP control with no host wiring",
  );
});

test("a blocked step can still be run, and the control says what changes first", () => {
  // `ensure_step_can_run` permits `blocked`, because every run re-gates the
  // tool: this is the control a user presses after granting the permission.
  const harness = renderPlan({
    plan: plan({
      status: "paused",
      steps: [
        step({
          status: "blocked",
          refusal: { source: "mcpGrants", reason: "not granted" },
        }),
      ],
    }),
  });
  const retry = screen.getByRole("button", {
    name: "Try step 1: List the MX records again",
  });
  fireEvent.click(retry);
  assert.deepEqual(harness.runSteps, [STEP_ID]);
  assert.match(
    screen.getByTestId("ai-plan-step-retry-note").textContent ?? "",
    /after granting the permission/,
  );
});

// ── Waiting on approval ────────────────────────────────────────────────────

test("a step waiting on approval offers approval, not a bare run", () => {
  const harness = renderPlan({
    plan: plan({
      status: "paused",
      steps: [step({ status: "awaitingApproval" })],
    }),
  });

  assertAbsent(
    screen.queryByTestId("ai-plan-run-step"),
    "plain run on a step awaiting approval",
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Approve and run step 1: List the MX records",
    }),
  );
  assert.deepEqual(harness.approvedSteps, [STEP_ID]);
  assert.match(
    screen.getByTestId("ai-plan-step-approval-note").textContent ?? "",
    /set to ask first/,
  );
});

// ── State is legible without colour, and every control names its step ──────

test("every status renders an icon and the word, not a colour", () => {
  const steps = AI_PLAN_STEP_STATUSES.map((status, index) =>
    step({
      id: `${index}`.repeat(8) + "-1111-1111-1111-111111111111",
      index,
      title: `Step about ${status}`,
      status,
    }),
  );
  renderPlan({ plan: plan({ status: "paused", steps }) });

  const rendered = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="ai-plan-step-status"]',
    ),
  );
  assert.equal(rendered.length, AI_PLAN_STEP_STATUSES.length);
  for (const node of rendered) {
    // A word, so greyscale and a screen reader both carry the state.
    assert.ok(
      (node.textContent ?? "").trim().length > 0,
      `${node.dataset.status} has no text`,
    );
    // And a shape, so the states are told apart at a glance too.
    assert.ok(node.querySelector("svg"), `${node.dataset.status} has no icon`);
  }
  // The seven statuses produce seven distinct words: two states that read the
  // same are two states the user cannot distinguish.
  const words = new Set(rendered.map((node) => node.textContent?.trim()));
  assert.equal(words.size, AI_PLAN_STEP_STATUSES.length);
});

test("the plan's own status is a word and an icon too, for every state", () => {
  const statuses: AiPlanStatus[] = [
    "draft",
    "approved",
    "running",
    "paused",
    "done",
    "failed",
    "cancelled",
  ];
  const seen = new Set<string>();
  for (const status of statuses) {
    renderPlan({ plan: plan({ status }) });
    const badge = screen.getByTestId("ai-plan-status");
    assert.equal(badge.dataset.status, status);
    assert.ok(badge.querySelector("svg"), `${status} has no icon`);
    const word = (badge.textContent ?? "").trim();
    assert.ok(word.length > 0, `${status} has no word`);
    seen.add(word);
    // And one sentence saying what the state means for the user.
    assert.ok(
      (screen.getByTestId("ai-plan-explanation").textContent ?? "").length > 30,
      `${status} has no explanation`,
    );
    cleanup();
  }
  assert.equal(seen.size, statuses.length, "two states read the same");
});

test("every step control is named for the step it acts on", () => {
  renderPlan({
    plan: plan({
      status: "paused",
      steps: [
        step({
          id: "aaaaaaaa-1111-1111-1111-111111111111",
          index: 0,
          title: "List the MX records",
          status: "pending",
        }),
        step({
          id: "bbbbbbbb-2222-2222-2222-222222222222",
          index: 1,
          title: "Add the SPF record",
          status: "awaitingApproval",
        }),
      ],
    }),
  });

  // "Run" three times over is three indistinguishable buttons by accessible
  // name. Each one carries its number and its title.
  assert.ok(
    screen.getByRole("button", { name: "Run step 1: List the MX records" }),
  );
  assert.ok(
    screen.getByRole("button", {
      name: "Approve and run step 2: Add the SPF record",
    }),
  );
  // And every plan-level control names the plan.
  assert.ok(
    screen.getByRole("button", { name: "Run the plan Fix the mail records" }),
  );
  assert.ok(
    screen.getByRole("button", {
      name: "Discard the plan Fix the mail records",
    }),
  );
  // No control is named by its verb alone.
  for (const button of screen.getAllByRole("button")) {
    const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
    assert.notEqual(name.trim(), "Run");
    assert.notEqual(name.trim(), "Approve");
  }
});

test("the step index on screen is one-based, not the wire's zero", () => {
  renderPlan({
    plan: plan({
      status: "approved",
      steps: [step({ index: 0, title: "First" })],
    }),
  });
  const row = screen.getByTestId("ai-plan-step");
  // The wire value is kept in the attribute, so nothing has to re-derive it.
  assert.equal(row.dataset.index, "0");
  assert.match(row.textContent ?? "", /^1\./);
});

test("a step naming no tool says so rather than leaving the line blank", () => {
  renderPlan({
    plan: plan({ steps: [step({ tool: null })] }),
  });
  assert.match(
    screen.getByTestId("ai-plan-step-tool").textContent ?? "",
    /Calls no tool: this one is yours to carry out\./,
  );
});

test("a status this build does not know offers no control and admits it", () => {
  renderPlan({
    plan: plan({
      status: "awaitingSomething" as never,
      steps: [step({ status: "quantum" as never })],
    }),
  });

  assert.equal(screen.getByTestId("ai-plan").dataset.status, "unrecognised");
  assert.equal(
    screen.getByTestId("ai-plan-step").dataset.stepStatus,
    "unrecognised",
  );
  assert.match(
    screen.getByTestId("ai-plan-explanation").textContent ?? "",
    /does not recognise the state/,
  );
  // No guess about what is legal in a state the backend has not described.
  assertAbsent(screen.queryByTestId("ai-plan-run"), "run on an unknown state");
  assertAbsent(
    screen.queryByTestId("ai-plan-approve"),
    "approve on an unknown state",
  );
  assertAbsent(
    screen.queryByTestId("ai-plan-cancel"),
    "cancel on an unknown state",
  );
  // Discarding is legal in every state the backend has, so it stays.
  assert.ok(screen.getByTestId("ai-plan-delete"));
});

// ── Busy and failure ───────────────────────────────────────────────────────

test("a command in flight locks every control and says which one is running", () => {
  renderPlan({
    plan: plan({ status: "approved", steps: [step()] }),
    busy: "run",
  });
  for (const id of [
    "ai-plan-run",
    "ai-plan-cancel",
    "ai-plan-delete",
    "ai-plan-run-step",
  ]) {
    assert.equal(
      (screen.getByTestId(id) as HTMLButtonElement).disabled,
      true,
      id,
    );
  }
  assert.match(screen.getByTestId("ai-plan-run").textContent ?? "", /Running…/);
});

test("a refused command shows the backend's own message and its remediation", () => {
  renderPlan({
    plan: plan({ status: "draft" }),
    error: {
      message: "a draft plan cannot be run",
      remediation: "Approve the plan first.",
      retryable: false,
      action: "run",
    },
  });
  const alert = screen.getByTestId("ai-plan-error");
  assert.equal(alert.dataset.action, "run");
  assert.match(alert.textContent ?? "", /a draft plan cannot be run/);
  assert.match(alert.textContent ?? "", /Approve the plan first\./);
});

// ── The run record, and the line between fact and prose ────────────────────

test("the summary appears only once the plan is terminal", () => {
  for (const status of ["draft", "approved", "running", "paused"] as const) {
    renderPlan({ plan: plan({ status }), summary: summary() });
    assertAbsent(
      screen.queryByTestId("ai-run-summary"),
      `summary on a ${status} plan`,
    );
    cleanup();
  }
  renderPlan({ plan: plan({ status: "done" }), summary: summary() });
  assert.ok(screen.getByTestId("ai-run-summary"));
});

test("the record and the assistant's account are separate, attributed regions", () => {
  renderPlan({
    plan: plan({ status: "done" }),
    summary: summary({
      stepTotals: { done: 2, blocked: 1, failed: 0, skipped: 0, pending: 0 },
      toolRuns: [
        { tool: "dns_list_records", stepIndex: 0, outcome: "ok" },
        { tool: "dns_create_record", stepIndex: 2, outcome: "denied" },
      ],
      narrative: "I added the SPF record you asked for.",
    }),
  });

  const facts = screen.getByTestId("ai-run-facts");
  const narrative = screen.getByTestId("ai-run-narrative");
  // Two regions, not one block of text — and each says whose claim it is in
  // words, because position is not something a screen reader conveys.
  assert.match(
    screen.getByTestId("ai-run-facts-attribution").textContent ?? "",
    /Recorded by the app, not written by the assistant/,
  );
  assert.match(
    screen.getByTestId("ai-run-narrative-attribution").textContent ?? "",
    /Written by the assistant/,
  );
  // The prose is not inside the record.
  assert.ok(!facts.contains(narrative));
  // The record comes first in document order, so a reader who stops at the
  // top of the panel has read only facts.
  assert.ok(
    facts.compareDocumentPosition(narrative) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  // And the narrative carries the caveat that it is not the record.
  assert.match(
    screen.getByTestId("ai-run-narrative-caveat").textContent ?? "",
    /check this against the record above/,
  );
});

test("a narrative claiming work cannot make the record say work happened", () => {
  // The case this whole separation exists for: the model narrates a deletion
  // on a plan the harness never dispatched a step for.
  renderPlan({
    plan: plan({ status: "cancelled" }),
    summary: summary({
      stepTotals: { done: 0, blocked: 0, failed: 0, skipped: 0, pending: 3 },
      narrative: "I deleted the stale A record and updated the MX priority.",
    }),
  });

  const panel = screen.getByTestId("ai-run-summary");
  assert.equal(panel.dataset.changed, "false");
  assert.equal(panel.dataset.didAnything, "false");
  assert.match(
    screen.getByTestId("ai-run-nothing-happened").textContent ?? "",
    /No step was ever dispatched/,
  );
  assert.match(
    screen.getByTestId("ai-run-mutations").textContent ?? "",
    /Nothing in your account was changed/,
  );
  // The prose is still shown — hiding it would be its own kind of dishonesty
  // — but it is labelled and it changed nothing above.
  assert.match(
    screen.getByTestId("ai-run-narrative").textContent ?? "",
    /I deleted the stale A record/,
  );
});

test("a mutating run leads with what it could have changed", () => {
  renderPlan({
    plan: plan({ status: "done" }),
    summary: summary({
      stepTotals: { done: 2, blocked: 0, failed: 0, skipped: 0, pending: 0 },
      toolRuns: [
        { tool: "dns_create_record", stepIndex: 0, outcome: "ok" },
        { tool: "dns_delete_record", stepIndex: 1, outcome: "failed" },
      ],
      mutatingToolsRun: ["dns_create_record", "dns_delete_record"],
      anyChangeAttempted: true,
    }),
  });

  const mutations = screen.getByTestId("ai-run-mutations");
  assert.equal(mutations.dataset.changed, "true");
  assert.match(
    mutations.textContent ?? "",
    /used tools that can change your account/,
  );
  const tools = Array.from(
    screen
      .getByTestId("ai-run-mutating-tools")
      .querySelectorAll<HTMLElement>("li"),
  ).map((node) => node.dataset.tool);
  assert.deepEqual(tools, ["dns_create_record", "dns_delete_record"]);
  // It is the first thing in the record, before the counters.
  const totals = screen.getByTestId("ai-run-step-totals");
  assert.ok(
    mutations.compareDocumentPosition(totals) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test("a change attempted with no completed tool is not rounded down to none", () => {
  // Cancelling does not abort a call in flight, so there is a window with a
  // write outstanding and no outcome recorded. "No" there is a false
  // all-clear.
  renderPlan({
    plan: plan({ status: "cancelled" }),
    summary: summary({
      anyChangeAttempted: true,
      mutatingToolsRun: [],
    }),
  });
  assert.equal(screen.getByTestId("ai-run-mutations").dataset.changed, "true");
  assert.match(
    screen.getByTestId("ai-run-attempted-only").textContent ?? "",
    /A change was attempted but no tool completed one/,
  );
});

test("a refusal in the record names its layer, like a blocked step does", () => {
  renderPlan({
    plan: plan({ status: "failed" }),
    summary: summary({
      refusals: [
        {
          tool: "dns_delete_record",
          source: "mcpGrants",
          reason: "not granted to the assistant",
        },
        {
          tool: "dns_create_record",
          source: "assistantPolicy",
          reason: "denied in read-only mode",
        },
      ],
    }),
  });
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="ai-run-refusal"]'),
  );
  assert.deepEqual(
    rows.map((row) => row.dataset.source),
    ["mcpGrants", "assistantPolicy"],
  );
  assert.match(rows[0].textContent ?? "", /Session settings, MCP/);
  assert.match(rows[1].textContent ?? "", /Tools & permissions/);
});

test("an unreadable run record says so rather than implying nothing happened", () => {
  renderPlan({
    plan: plan({ status: "done" }),
    summary: null,
    summaryError: new Error("no such command"),
  });
  assert.match(
    screen.getByTestId("ai-run-summary-error").textContent ?? "",
    /could not be read/,
  );
});

test("without a host that owns the assistant settings the layer is still named", () => {
  // The assistant no longer contains its own settings — they are a section of
  // the app's Settings workspace — so this pointer is the host's and can be
  // absent. The sentence that says which list to change is not.
  renderPlan({
    plan: plan({
      status: "paused",
      steps: [
        step({
          status: "blocked",
          refusal: { source: "assistantPolicy", reason: "denied by mode" },
        }),
      ],
    }),
    onOpenAssistantTools: undefined,
  });

  assert.match(
    screen.getByTestId("ai-plan-step-refusal").textContent ?? "",
    /Settings, under Assistant, in Tools & permissions/,
  );
  assertAbsent(
    screen.queryByTestId("ai-plan-step-open-assistant-tools"),
    "assistant-settings control with no host wiring",
  );
});
