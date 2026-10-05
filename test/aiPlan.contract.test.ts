/**
 * What the plan UI is allowed to offer, pinned against the Rust that would
 * refuse it.
 *
 * The rules in `@/lib/ai/plan` are copies of match arms in
 * `bc-ai-agent/src/plan.rs`, and a copy with no test is a comment. The
 * expensive mistake they guard against is specific: every plan command
 * answers a wrong-state call with `PlanStateConflict`, so a control offered in
 * a state the backend refuses does not merely do nothing — it produces an
 * error the user did nothing to earn, on a screen whose entire job is to tell
 * them what to do next. The arms are therefore read out of the Rust source
 * rather than transcribed here, so adding a state to either match is a
 * frontend test failure and not a silent divergence.
 *
 * The other half of the file is the link resolver, where the thing being
 * pinned is the opposite: that targets which do **not** check out resolve to
 * nothing. The backend validates them too, and that is exactly why these
 * assertions exist — they are what makes the renderer's own check real rather
 * than a comment claiming the backend has it covered.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  AI_PLAN_STATUSES,
  AI_PLAN_STEP_STATUSES,
  AI_REFUSAL_SCREEN,
  aiPlanRefusalLayers,
  aiRefusalScreen,
  aiRunSummaryDidAnything,
  countAiPlanSteps,
  ensureAiPlanCanRun,
  groupAiRunToolRuns,
  isAiPlanApprovable,
  isAiPlanCancellable,
  isAiPlanRunnable,
  isAiPlanStepRunnable,
  isAiPlanTerminal,
  isAiRefusalSource,
  orderedAiPlanSteps,
  planStepToolCallId,
} from "../src/lib/ai/plan";
import {
  AI_LINK_LIMITS,
  AI_WORKSPACE_TARGETS,
  followAiLink,
  normalizeExternalHttpsUrl,
  resolveAiLink,
  type AiLinkNavigation,
} from "../src/lib/ai/links";
import {
  AI_PLAN_STEP_TOOL_CALL_PREFIX,
  type AiLink,
  type AiPlan,
  type AiPlanStatus,
  type AiPlanStep,
  type AiPlanStepStatus,
  type AiRunSummary,
} from "../src/types/ai";

const ROOT = process.cwd();
const PLAN_RS = join(
  ROOT,
  "src-tauri",
  "crates",
  "bc-ai-agent",
  "src",
  "plan.rs",
);
const LINKS_RS = join(
  ROOT,
  "src-tauri",
  "crates",
  "bc-ai-agent",
  "src",
  "links.rs",
);
const TOOL_PERMISSIONS_RS = join(
  ROOT,
  "src-tauri",
  "crates",
  "bc-ai-tools",
  "src",
  "permissions.rs",
);

const PLAN_SOURCE = readFileSync(PLAN_RS, "utf8");
const LINKS_SOURCE = readFileSync(LINKS_RS, "utf8");

/**
 * Assert a pattern appears in a Rust source file.
 *
 * Deliberately not `assert.match`. Under `node:assert/strict` a failed match
 * inspects the actual value, and these sources are tens of thousands of
 * characters — a drift would otherwise print the whole file instead of saying
 * what to fix, which is the same reasoning behind `assertAbsent` in the panel
 * suite.
 */
function assertSourceHas(
  source: string,
  pattern: RegExp,
  message: string,
): void {
  assert.ok(pattern.test(source), message);
}

/** `AwaitingApproval` -> `awaitingApproval`: serde's `rename_all = "camelCase"`. */
function camel(variant: string): string {
  return variant.charAt(0).toLowerCase() + variant.slice(1);
}

/**
 * The variants on the `Ok(())` arm of one `ensure_*_can_run` guard.
 *
 * Only that arm is read: the other is a catch-all `state =>` that names no
 * variants, so the permitted set is the whole contract.
 */
function permittedStates(guard: string, enumName: string): string[] {
  const body = PLAN_SOURCE.match(
    new RegExp(
      `fn ${guard}[\\s\\S]*?match [a-z_.]+ \\{([\\s\\S]*?)=> Ok\\(\\(\\)\\)`,
    ),
  );
  assert.ok(body, `${guard} must stay parseable in plan.rs`);
  const variants = Array.from(
    body[1].matchAll(new RegExp(`${enumName}::([A-Za-z]+)`, "g")),
  ).map((match) => camel(match[1]));
  assert.ok(
    variants.length > 0,
    `${guard} must list the states it permits by name`,
  );
  return variants;
}

/** Every variant of one enum, in declaration order, from its `as_str`. */
function wireNames(enumName: string): string[] {
  const body = PLAN_SOURCE.match(
    new RegExp(
      `impl ${enumName} \\{[\\s\\S]*?pub const fn as_str\\(self\\) -> &'static str \\{([\\s\\S]*?)\\n    \\}`,
    ),
  );
  assert.ok(body, `${enumName}::as_str must stay parseable in plan.rs`);
  return Array.from(body[1].matchAll(/Self::[A-Za-z]+ => "([a-zA-Z]+)"/g)).map(
    (match) => match[1],
  );
}

function step(overrides: Partial<AiPlanStep> = {}): AiPlanStep {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    index: 0,
    title: "Read the zone",
    detail: "List the records so the rest of the plan has something to act on.",
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

// ── The states each command accepts ────────────────────────────────────────

test("the plan states a run is offered in are the states Rust permits", () => {
  const permitted = permittedStates("ensure_plan_can_run", "AiPlanStatus");
  // `failed` being in this set is the one that looks like a bug and is not:
  // re-running re-resolves permissions and retries the step that failed,
  // which is precisely what a user does after granting the tool that stopped
  // it. If Rust ever drops it, this fails rather than the UI offering a
  // button that errors.
  assert.ok(
    permitted.includes("failed"),
    "a failed plan is re-runnable in Rust; the UI depends on it",
  );
  for (const status of AI_PLAN_STATUSES) {
    assert.equal(
      isAiPlanRunnable(status),
      permitted.includes(status),
      `${status}: the TS run predicate must match ensure_plan_can_run`,
    );
  }
  // And the two "not yet" / "never again" reasons are distinguished, because
  // a draft becomes runnable and a cancelled plan does not.
  assert.equal(ensureAiPlanCanRun("draft"), "notApproved");
  assert.equal(ensureAiPlanCanRun("done"), "finished");
  assert.equal(ensureAiPlanCanRun("cancelled"), "finished");
  assert.equal(ensureAiPlanCanRun("paused"), null);
});

test("the step states a run is offered in are the states Rust permits", () => {
  const permitted = permittedStates("ensure_step_can_run", "AiPlanStepStatus");
  // `blocked` is in this set, which is what makes "Try again" after granting
  // a permission a real control rather than a hopeful one: the step is
  // re-gated on every run.
  assert.ok(
    permitted.includes("blocked"),
    "a blocked step is re-runnable in Rust, which is what re-gating means",
  );
  for (const status of AI_PLAN_STEP_STATUSES) {
    assert.equal(
      isAiPlanStepRunnable(status),
      permitted.includes(status),
      `${status}: the TS step predicate must match ensure_step_can_run`,
    );
  }
});

test("a draft is approvable and nothing else is", () => {
  for (const status of AI_PLAN_STATUSES) {
    assert.equal(isAiPlanApprovable(status), status === "draft", status);
  }
  // The complement of the run predicate on a draft: approve and run are never
  // both on offer, which is the "a draft must not look runnable" rule stated
  // as an invariant rather than as a render detail.
  for (const status of AI_PLAN_STATUSES) {
    assert.ok(
      !(isAiPlanApprovable(status) && isAiPlanRunnable(status)),
      `${status} must not be both approvable and runnable`,
    );
  }
});

test("cancel is offered where Rust accepts it and nowhere a user would see nothing", () => {
  // Rust refuses only `done` and is idempotent on `cancelled`. Idempotent is
  // not worth a button: a second cancel changes nothing on screen.
  assert.equal(isAiPlanCancellable("done"), false);
  assert.equal(isAiPlanCancellable("cancelled"), false);
  for (const status of [
    "draft",
    "approved",
    "running",
    "paused",
    "failed",
  ] as const) {
    assert.equal(isAiPlanCancellable(status), true, status);
  }
  // The two arms `cancel` is built on, matched loosely enough to survive
  // rustfmt moving the body onto its own line.
  assertSourceHas(
    PLAN_SOURCE,
    /AiPlanStatus::Cancelled => plan\.clone\(\)/,
    "cancel must still be idempotent on a cancelled plan",
  );
  assertSourceHas(
    PLAN_SOURCE,
    /AiPlanStatus::Done =>[\s\S]{0,160}?PlanStateConflict/,
    "cancel must still refuse a done plan",
  );
});

test("the terminal states are the ones a run summary belongs to", () => {
  const terminal = AI_PLAN_STATUSES.filter(isAiPlanTerminal);
  assert.deepEqual([...terminal], ["done", "failed", "cancelled"]);
});

test("the status spellings are the serde spellings Rust reports", () => {
  assert.deepEqual([...AI_PLAN_STATUSES], wireNames("AiPlanStatus"));
  assert.deepEqual([...AI_PLAN_STEP_STATUSES], wireNames("AiPlanStepStatus"));
});

test("the statuses the harness calls finished are the pair it tallies as done", () => {
  // `countAiPlanSteps` buckets by status, and what "finished" means there has
  // to be the same pair Rust's `is_complete` covers — `ai_run_plan` picks up
  // from the first step that is not one of them, so a UI counting a third
  // status as finished would describe a run as over while it had steps left.
  assertSourceHas(
    PLAN_SOURCE,
    /fn is_complete\(self\) -> bool \{\s*matches!\(self, Self::Done \| Self::Skipped\)/,
    "is_complete must still be Done | Skipped",
  );
  const totals = countAiPlanSteps(
    AI_PLAN_STEP_STATUSES.map((status, index) =>
      step({ id: `${index}`, index, status }),
    ),
  );
  // One each of `done` and `skipped`; every other status lands in a bucket
  // that is not "finished".
  assert.equal(totals.done, 1);
  assert.equal(totals.skipped, 1);
  assert.equal(
    totals.blocked + totals.failed + totals.pending,
    AI_PLAN_STEP_STATUSES.length - 2,
  );
});

// ── Approving a waiting step ───────────────────────────────────────────────

test("a step is approved under the tool-call id Rust builds", () => {
  const prefix = PLAN_SOURCE.match(
    /PLAN_STEP_TOOL_CALL_PREFIX: &str = "([^"]+)"/,
  );
  assert.ok(prefix, "PLAN_STEP_TOOL_CALL_PREFIX must stay parseable");
  assert.equal(AI_PLAN_STEP_TOOL_CALL_PREFIX, prefix[1]);
  // `Uuid::simple()`: 32 hex digits, no hyphens.
  assertSourceHas(
    PLAN_SOURCE,
    /format!\("\{PLAN_STEP_TOOL_CALL_PREFIX\}\{\}", step_id\.simple\(\)\)/,
    "the id must still be the prefix plus the UUID's simple form",
  );
  assert.equal(
    planStepToolCallId("11111111-2222-3333-4444-555555555555"),
    "plan-step-11111111222233334444555555555555",
  );
  // Already hyphen-free, and upper case folds down.
  assert.equal(
    planStepToolCallId("AABBCCDD11112222333344445555AAAA"),
    "plan-step-aabbccdd11112222333344445555aaaa",
  );
});

test("a step id that is not a UUID cannot be turned into an approval", () => {
  // The id goes to `ai_approve_tool_call`, which also serves transcript tool
  // calls — so prefixing arbitrary text is the one way an approval could land
  // somewhere other than the step it was meant for.
  for (const candidate of [
    "",
    "not-a-uuid",
    "../../etc/passwd",
    "plan-step-11111111222233334444555555555555",
    "11111111-2222-3333-4444-5555555555",
    "11111111-2222-3333-4444-555555555555-extra",
  ]) {
    assert.equal(
      planStepToolCallId(candidate),
      null,
      `${JSON.stringify(candidate)} must not produce a tool-call id`,
    );
  }
});

// ── Blocked steps name their layer ─────────────────────────────────────────

test("the refusal sources are the Rust variants, and an unknown one stays unknown", () => {
  const source = readFileSync(TOOL_PERMISSIONS_RS, "utf8");
  const body = source.match(/pub enum RefusalSource \{([\s\S]*?)\n\}/);
  assert.ok(body, "RefusalSource must stay parseable");
  const variants = Array.from(
    body[1].matchAll(/^\s{4}([A-Z][A-Za-z]*),/gm),
  ).map((match) => camel(match[1]));
  assert.deepEqual(variants, ["assistantPolicy", "mcpGrants"]);
  for (const variant of variants) {
    assert.ok(isAiRefusalSource(variant), variant);
  }
  // The honesty rule: a third layer added Rust-side arrives as a string this
  // build has never seen, and it must not be mapped onto one of the two it
  // knows — that would send the user to change a setting that is not refusing
  // them. `null` is the answer, and the UI renders it as one.
  for (const junk of ["", "mcp", "assistantpolicy", null, undefined, 7, {}]) {
    assert.equal(isAiRefusalSource(junk), false, JSON.stringify(junk));
    assert.equal(aiRefusalScreen(junk), null, JSON.stringify(junk));
  }
});

test("each layer points at exactly one screen, and they are different screens", () => {
  assert.equal(aiRefusalScreen("assistantPolicy"), "assistantTools");
  assert.equal(aiRefusalScreen("mcpGrants"), "sessionSettingsMcp");
  // The whole reason the source is carried to the UI: the two fixes are in
  // different places, so a mapping that collapsed them would be worse than
  // useless.
  assert.notEqual(
    AI_REFUSAL_SCREEN.assistantPolicy,
    AI_REFUSAL_SCREEN.mcpGrants,
  );
});

test("a plan blocked by both layers reports both, in explanation order", () => {
  const blocked = plan({
    status: "paused",
    steps: [
      step({
        id: "s1",
        index: 0,
        status: "blocked",
        refusal: { source: "mcpGrants", reason: "not granted" },
      }),
      step({
        id: "s2",
        index: 1,
        status: "blocked",
        refusal: { source: "assistantPolicy", reason: "denied by mode" },
      }),
      step({
        id: "s3",
        index: 2,
        status: "blocked",
        refusal: { source: "mcpGrants", reason: "not granted" },
      }),
    ],
  });
  const layers = aiPlanRefusalLayers(blocked);
  // Deduplicated, and ordered by explanation rather than by encounter, so the
  // same pair always reads the same way.
  assert.deepEqual(layers.sources, ["assistantPolicy", "mcpGrants"]);
  assert.equal(layers.unknown, false);
});

test("a blocked step with no usable source is counted as unknown, not as a layer", () => {
  const layers = aiPlanRefusalLayers(
    plan({
      status: "paused",
      steps: [
        step({ id: "s1", index: 0, status: "blocked", refusal: null }),
        step({
          id: "s2",
          index: 1,
          status: "blocked",
          refusal: {
            source: "somethingNew" as never,
            reason: "a layer this build does not know",
          },
        }),
      ],
    }),
  );
  assert.deepEqual(layers.sources, []);
  assert.equal(layers.unknown, true);
});

// ── Counting, ordering ─────────────────────────────────────────────────────

test("the plan's own counts bucket in-flight steps as not finished", () => {
  const totals = countAiPlanSteps([
    step({ id: "a", index: 0, status: "done" }),
    step({ id: "b", index: 1, status: "running" }),
    step({ id: "c", index: 2, status: "awaitingApproval" }),
    step({ id: "d", index: 3, status: "pending" }),
    step({ id: "e", index: 4, status: "blocked" }),
    step({ id: "f", index: 5, status: "failed" }),
    step({ id: "g", index: 6, status: "skipped" }),
  ]);
  // `running` and `awaitingApproval` are neither done nor wrong: they are
  // unfinished, which is what the harness's own `pending` total means.
  assert.deepEqual(totals, {
    done: 1,
    blocked: 1,
    failed: 1,
    skipped: 1,
    pending: 3,
  });
});

test("steps render in plan order whatever order they arrive in", () => {
  const scrambled = plan({
    steps: [
      step({ id: "c", index: 2 }),
      step({ id: "a", index: 0 }),
      step({ id: "b", index: 1, status: "done" }),
    ],
  });
  assert.deepEqual(
    orderedAiPlanSteps(scrambled).map((entry) => entry.id),
    ["a", "b", "c"],
  );
});

// ── The summary's factual half ─────────────────────────────────────────────

test("tool runs group by outcome in a fixed order and drop empty groups", () => {
  const grouped = groupAiRunToolRuns(
    summary({
      toolRuns: [
        { tool: "dns_delete_record", stepIndex: 1, outcome: "denied" },
        { tool: "dns_list_records", stepIndex: 0, outcome: "ok" },
        { tool: "dns_create_record", stepIndex: 2, outcome: "denied" },
      ],
    }),
  );
  assert.deepEqual(
    grouped.map((group) => [group.outcome, group.runs.length]),
    [
      ["ok", 1],
      ["denied", 2],
    ],
  );
});

test("whether anything happened is read off the record, never off the narrative", () => {
  // A model that narrates a change it never made must not be able to make
  // this true: the narrative is not consulted at all.
  assert.equal(
    aiRunSummaryDidAnything(
      summary({ narrative: "I deleted the stale A record for you." }),
    ),
    false,
  );
  assert.equal(
    aiRunSummaryDidAnything(summary({ anyChangeAttempted: true })),
    true,
  );
  assert.equal(
    aiRunSummaryDidAnything(
      summary({ mutatingToolsRun: ["dns_create_record"] }),
    ),
    true,
  );
});

// ── Links: the closed sets ─────────────────────────────────────────────────

const KNOWN_ZONE = "zone-aaaa1111";

function navigation(): AiLinkNavigation & {
  zones: string[];
  records: string[];
  domains: string[];
  zoneTabs: string[];
  workspaces: string[];
} {
  const zones: string[] = [];
  const records: string[] = [];
  const domains: string[] = [];
  const zoneTabs: string[] = [];
  const workspaces: string[] = [];
  return {
    knownZoneIds: [KNOWN_ZONE],
    openZone: (zoneId) => zones.push(zoneId),
    revealRecord: (zoneId, recordId) => records.push(`${zoneId}/${recordId}`),
    openZoneTab: (zoneId, tab) => zoneTabs.push(`${zoneId}/${tab}`),
    openDomainRegistry: (domain) => domains.push(domain),
    openWorkspace: (workspace) => workspaces.push(workspace),
    zones,
    records,
    domains,
    zoneTabs,
    workspaces,
  };
}

function link(overrides: Partial<AiLink>): AiLink {
  return { kind: "external", label: "Somewhere", target: "", ...overrides };
}

test("the link rules and bounds are the ones Rust enforces", () => {
  // The workspace set is a closed list on both sides, and the renderer's copy
  // is what decides whether a control is drawn at all — so it is read out of
  // `links.rs` rather than trusted to stay in step.
  const workspaces = LINKS_SOURCE.match(
    /pub const WORKSPACE_IDS: &\[&str\] = &\[([\s\S]*?)\n\];/,
  );
  assert.ok(workspaces, "WORKSPACE_IDS must stay parseable in links.rs");
  assert.deepEqual(
    [...AI_WORKSPACE_TARGETS],
    Array.from(workspaces[1].matchAll(/"([a-z]+)"/g)).map((match) => match[1]),
    "AI_WORKSPACE_TARGETS must be exactly Rust's WORKSPACE_IDS",
  );
  // `zone` is deliberately absent from both: a zone workspace needs a zone to
  // open, which is what the `zone` kind is for.
  assert.ok(!(AI_WORKSPACE_TARGETS as readonly string[]).includes("zone"));

  for (const [field, constant] of [
    ["maxLinks", "MAX_LINKS_PER_OFFER"],
    ["labelBytes", "MAX_LINK_LABEL_BYTES"],
    ["idBytes", "MAX_LINK_ID_BYTES"],
    ["hostnameBytes", "MAX_LINK_HOSTNAME_BYTES"],
    ["urlBytes", "MAX_LINK_URL_BYTES"],
  ] as const) {
    const declared = LINKS_SOURCE.match(
      new RegExp(
        `pub const ${constant}: usize = ([0-9_]+(?:\\s*\\*\\s*[0-9_]+)*);`,
      ),
    );
    assert.ok(declared, `${constant} must stay parseable in links.rs`);
    const expected = declared[1]
      .split("*")
      .map((part) => Number(part.trim().replaceAll("_", "")))
      .reduce((product, factor) => product * factor, 1);
    assert.equal(
      AI_LINK_LIMITS[field],
      expected,
      `${field} is ${AI_LINK_LIMITS[field]} in AI_LINK_LIMITS but ${constant} is ${expected} - update the TS table to match`,
    );
  }

  // The id charset, which is the whole defence for the two id kinds: with no
  // `.`, `/`, `:`, `%` or non-ASCII admitted, a traversal is unrepresentable.
  assertSourceHas(
    LINKS_SOURCE,
    /byte\.is_ascii_alphanumeric\(\) \|\| byte == b'-' \|\| byte == b'_'/,
    "the opaque-id charset must still be alphanumerics, '-' and '_'",
  );
  // And the external rule: https only, tested against the raw string.
  assertSourceHas(
    LINKS_SOURCE,
    /!target\.starts_with\("https:\/\/"\)/,
    "an external link must still be https-only, checked on the raw target",
  );
});

test("a zone link resolves only against the zones this account has", () => {
  const nav = navigation();
  assert.deepEqual(
    resolveAiLink(link({ kind: "zone", target: KNOWN_ZONE }), nav),
    { kind: "zone", zoneId: KNOWN_ZONE },
  );
  // Well-formed, and somebody else's: the shape of an id says nothing about
  // whether this account can open it.
  assert.equal(
    resolveAiLink(link({ kind: "zone", target: "zone-bbbb2222" }), nav),
    null,
  );
  // Before the zone list has loaded there is no closed set to check against,
  // so nothing resolves rather than everything.
  assert.equal(
    resolveAiLink(link({ kind: "zone", target: KNOWN_ZONE }), {
      knownZoneIds: [],
    }),
    null,
  );
});

test("a record link is two opaque ids and exactly one separator", () => {
  const nav = navigation();
  assert.deepEqual(
    resolveAiLink(
      link({ kind: "record", target: `${KNOWN_ZONE}/rec_123-abc` }),
      nav,
    ),
    { kind: "record", zoneId: KNOWN_ZONE, recordId: "rec_123-abc" },
  );
  // `/` is the one structural byte the charset admits, and only between two
  // non-empty halves — so nothing path-shaped survives, and no target has a
  // tail silently dropped.
  for (const target of [
    KNOWN_ZONE,
    "rec_123-abc",
    `${KNOWN_ZONE}/`,
    "/rec_1",
    `${KNOWN_ZONE}//rec_1`,
    `${KNOWN_ZONE}/rec_1/extra`,
    `${KNOWN_ZONE}/..`,
    `${KNOWN_ZONE}/../../admin`,
    "../secrets/rec_1",
    `${KNOWN_ZONE}/rec.1`,
    `${KNOWN_ZONE}/rec:1`,
    `${KNOWN_ZONE}/rec%2f1`,
    `${KNOWN_ZONE}/rec with spaces`,
    `${KNOWN_ZONE}/réc`,
    "https://example.com/rec_1",
    `${KNOWN_ZONE}/${"r".repeat(AI_LINK_LIMITS.idBytes + 1)}`,
  ]) {
    assert.equal(
      resolveAiLink(link({ kind: "record", target }), nav),
      null,
      JSON.stringify(target),
    );
  }
  // The zone half gets the account's own closed-set check too, which the
  // backend cannot make: it validates the id's shape, not whose zone it is.
  assert.equal(
    resolveAiLink(link({ kind: "record", target: "zone-bbbb2222/rec_1" }), nav),
    null,
  );
});

test("a registry link resolves a hostname and refuses anything path-shaped", () => {
  const nav = navigation();
  assert.deepEqual(
    resolveAiLink(
      link({ kind: "domainRegistry", target: "EXAMPLE.COM." }),
      nav,
    ),
    { kind: "domainRegistry", domain: "example.com" },
  );
  for (const target of [
    "..",
    "../example.com",
    "example",
    "exa mple.com",
    "-example.com",
    "https://example.com",
    "example.com/path",
    "example.com:443",
  ]) {
    assert.equal(
      resolveAiLink(link({ kind: "domainRegistry", target }), nav),
      null,
      target,
    );
  }
});

test("a workspace link resolves only the tabs the app can open", () => {
  const nav = navigation();
  for (const workspace of AI_WORKSPACE_TARGETS) {
    assert.deepEqual(
      resolveAiLink(link({ kind: "workspace", target: workspace }), nav),
      { kind: "workspace", workspace },
    );
  }
  // `zone` is deliberately not in the set: a zone needs an id, and the `zone`
  // kind is how one is addressed.
  for (const target of ["zone", "Settings", "mcp", "../settings", ""]) {
    assert.equal(
      resolveAiLink(link({ kind: "workspace", target }), nav),
      null,
      target,
    );
  }
});

test("an external link must be an absolute credential-free https URL", () => {
  const nav = navigation();
  assert.deepEqual(
    resolveAiLink(
      link({ kind: "external", target: "https://example.com/docs?q=1" }),
      nav,
    ),
    { kind: "external", url: "https://example.com/docs?q=1" },
  );
  for (const target of [
    "http://example.com/",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "file:///etc/passwd",
    "https://user:pass@example.com/",
    "https://example.com/\nnext",
    "/relative/path",
    "example.com",
  ]) {
    assert.equal(
      resolveAiLink(link({ kind: "external", target }), nav),
      null,
      target,
    );
    assert.equal(normalizeExternalHttpsUrl(target), null, target);
  }
});

test("a kind this build does not know resolves to nothing", () => {
  assert.equal(
    resolveAiLink(
      { kind: "sqlConsole" as never, label: "Run it", target: "whatever" },
      navigation(),
    ),
    null,
  );
});

test("following a link calls the host's own navigation, and never for external", () => {
  const nav = navigation();
  assert.equal(followAiLink({ kind: "zone", zoneId: KNOWN_ZONE }, nav), true);
  assert.equal(
    followAiLink(
      { kind: "record", zoneId: KNOWN_ZONE, recordId: "rec_1" },
      nav,
    ),
    true,
  );
  assert.equal(
    followAiLink({ kind: "domainRegistry", domain: "example.com" }, nav),
    true,
  );
  assert.equal(
    followAiLink({ kind: "workspace", workspace: "registry" }, nav),
    true,
  );
  assert.deepEqual(nav.zones, [KNOWN_ZONE]);
  assert.deepEqual(nav.records, [`${KNOWN_ZONE}/rec_1`]);
  assert.deepEqual(nav.domains, ["example.com"]);
  assert.deepEqual(nav.workspaces, ["registry"]);
  // External is not this function's business: the desktop build has to route
  // it through the Tauri shell, which only `openExternalUrl` knows how to do.
  assert.equal(
    followAiLink({ kind: "external", url: "https://example.com/" }, nav),
    false,
  );
  assert.deepEqual(nav.zones, [KNOWN_ZONE]);
});

// ── A guard against the UI growing a state the backend has not got ─────────

test("every plan and step status the UI knows is one Rust can send", () => {
  const planStatuses: readonly AiPlanStatus[] = AI_PLAN_STATUSES;
  const stepStatuses: readonly AiPlanStepStatus[] = AI_PLAN_STEP_STATUSES;
  for (const status of planStatuses) {
    assertSourceHas(
      PLAN_SOURCE,
      new RegExp(`=> "${status}"`),
      `${status} must be a status Rust spells`,
    );
  }
  for (const status of stepStatuses) {
    assertSourceHas(
      PLAN_SOURCE,
      new RegExp(`=> "${status}"`),
      `${status} must be a step status Rust spells`,
    );
  }
});
