/**
 * The permission resolution order, and the bounds the forms check.
 *
 * Two different kinds of assertion live here, both deliberate:
 *
 * - The resolution order is pinned case by case. The one worth reading is
 *   `readOnly` + a write tool: the answer is `deny`, not `ask`. Every other
 *   mode's refusal is a prompt the user sees; this one is silent, and a UI that
 *   got it wrong would promise a prompt that never comes.
 * - The numeric and length limits are compared against the Rust validators by
 *   parsing them out of the crates. `AI_AGENT_LIMITS` and `AI_PERSONA_LIMITS`
 *   claim to be copied rather than chosen, and this is what makes that claim
 *   checkable: change `MAX_TOOL_ROUNDS` on the Rust side and this fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";

import {
  AI_AGENT_LIMITS,
  AI_CONFIGURABLE_LIMITS,
  AI_DEFAULT_MAX_CONTEXT_TOKENS,
  AI_PERMISSION_MODES,
  AI_PERSONA_LIMITS,
  AI_STOP_LIMITS,
  AI_TOOL_PERMISSIONS,
  buildAiToolPermissionRows,
  isAiPermissionMode,
  isAiToolPermission,
  modePermission,
  resolveAiToolPermission,
  summarizeAiToolPermissionRows,
  validateAgentConfig,
  validatePersonaInput,
} from "../src/lib/ai/permissions";
import type {
  AiPermissionMode,
  AiPermissions,
  AiPermissionsSnapshot,
  AiToolDescriptor,
  AiToolPermission,
} from "../src/types/ai";

const ROOT = process.cwd();
const AGENT_CONFIG_RS = join(
  ROOT,
  "src-tauri",
  "crates",
  "bc-ai-agent",
  "src",
  "config.rs",
);
const PROVIDER_LIMITS_RS = join(
  ROOT,
  "src-tauri",
  "crates",
  "bc-ai-provider",
  "src",
  "limits.rs",
);
const PROVIDER_CONFIG_RS = join(
  ROOT,
  "src-tauri",
  "crates",
  "bc-ai-provider",
  "src",
  "config.rs",
);
/** Six of the eight configurable limits are retention limits and live here. */
const CHAT_LIMITS_RS = join(
  ROOT,
  "src-tauri",
  "crates",
  "bc-ai-chat",
  "src",
  "limits.rs",
);
/** The other two are plan limits. */
const AGENT_PLAN_RS = join(
  ROOT,
  "src-tauri",
  "crates",
  "bc-ai-agent",
  "src",
  "plan.rs",
);

/**
 * Read a numeric `const NAME: ty = …;` out of a Rust file.
 *
 * Handles the three spellings these bounds actually use: a plain integer
 * (`32`), a product (`256 * 1024`), and a signed decimal (`-2.0`). The value
 * group used to be integers-only, which matched no float bound at all —
 * `MAX_TOP_P`, `MAX_TEMPERATURE` and both sampling penalties — and a reader
 * that cannot match the value it was asked for is worse than no reader,
 * because the assertion looks present and checks nothing. It is widened
 * rather than paired with a float-only sibling so there is one reader and no
 * way to call the wrong one.
 *
 * `pub` is optional because not every bound worth pinning is exported: a
 * crate-private default is still the number the backend will use.
 */
function rustConst(path: string, name: string): number {
  const source = readFileSync(path, "utf8");
  const match = source.match(
    new RegExp(
      `(?:pub )?const ${name}\\s*:\\s*[A-Za-z0-9_]+\\s*=\\s*(-?[0-9_]+(?:\\.[0-9]+)?(?:\\s*\\*\\s*-?[0-9_]+(?:\\.[0-9]+)?)*)\\s*;`,
    ),
  );
  assert.ok(match, `${name} must stay parseable in ${path}`);
  const value = match[1]
    .split("*")
    .map((part) => Number(part.trim().replaceAll("_", "")))
    .reduce((product, factor) => product * factor, 1);
  // A `Number()` that returned NaN would otherwise compare unequal to every
  // expectation and be reported as a drift rather than as an unreadable
  // constant.
  assert.ok(
    Number.isFinite(value),
    `${name} in ${path} did not parse to a number`,
  );
  return value;
}

function tool(
  name: string,
  classification: AiToolDescriptor["classification"],
  permission: AiToolPermission,
): AiToolDescriptor {
  return {
    name,
    classification,
    description: `${classification} tool`,
    permission,
  };
}

function policy(
  mode: AiPermissionMode,
  tools: Record<string, AiToolPermission> = {},
): AiPermissions {
  return { mode, tools };
}

/**
 * The availability the backend reports alongside the catalog.
 *
 * None of the row-building assertions below read it — a row's permission comes
 * from the catalog and the policy, never from these counts — but it is part of
 * `ai_get_permissions`, so a snapshot without it is not a snapshot.
 */
function availability(
  usable: number,
  registered: number,
): AiPermissionsSnapshot["availability"] {
  return {
    dispatchAvailable: usable > 0,
    grantedToolCount: usable,
    usableToolCount: usable,
    registeredToolCount: registered,
  };
}

// ── The resolution order ───────────────────────────────────────────────────

test("the mode alone decides a tool with no override", () => {
  const expected: Record<
    AiPermissionMode,
    { read: AiToolPermission; write: AiToolPermission }
  > = {
    readOnly: { read: "allow", write: "deny" },
    ask: { read: "allow", write: "ask" },
    autonomous: { read: "allow", write: "allow" },
  };

  for (const mode of AI_PERMISSION_MODES) {
    assert.equal(modePermission(mode, "read"), expected[mode].read, mode);
    assert.equal(modePermission(mode, "write"), expected[mode].write, mode);
  }

  // The asymmetry worth naming: read-only refuses a write outright. If this
  // ever becomes "ask", the mode's description in the settings UI is a lie.
  assert.notEqual(modePermission("readOnly", "write"), "ask");
});

test("tools off globally beats the mode and every per-tool override", () => {
  const write = tool("cf_delete_dns_record", "write", "allow");
  const read = tool("cf_list_dns_records", "read", "allow");

  for (const mode of AI_PERMISSION_MODES) {
    for (const override of [...AI_TOOL_PERMISSIONS, undefined]) {
      const tools = override ? { [write.name]: override } : {};
      assert.deepEqual(
        resolveAiToolPermission(write, policy(mode, tools), false),
        { permission: "deny", reason: "toolsOff" },
        `${mode}/${override ?? "no override"}`,
      );
      assert.deepEqual(
        resolveAiToolPermission(read, policy(mode, tools), false),
        { permission: "deny", reason: "toolsOff" },
      );
    }
  }
});

test("an explicit override beats the mode in both directions", () => {
  const write = tool("cf_delete_dns_record", "write", "deny");
  const read = tool("cf_list_dns_records", "read", "allow");

  // Loosening: autonomy for one write tool under the most restrictive mode.
  assert.deepEqual(
    resolveAiToolPermission(
      write,
      policy("readOnly", { [write.name]: "allow" }),
      true,
    ),
    { permission: "allow", reason: "override" },
  );
  // Tightening: a refused read under the most permissive mode.
  assert.deepEqual(
    resolveAiToolPermission(
      read,
      policy("autonomous", { [read.name]: "deny" }),
      true,
    ),
    { permission: "deny", reason: "override" },
  );
  // An override for a different tool must not leak across.
  assert.deepEqual(
    resolveAiToolPermission(read, policy("ask", { other: "deny" }), true),
    { permission: "allow", reason: "mode" },
  );
});

test("a junk override value falls through to the mode rather than being trusted", () => {
  const write = tool("cf_delete_dns_record", "write", "ask");
  const tools = { [write.name]: "maybe" } as unknown as Record<
    string,
    AiToolPermission
  >;
  assert.deepEqual(resolveAiToolPermission(write, policy("ask", tools), true), {
    permission: "ask",
    reason: "mode",
  });
});

test("the guards reject values outside the two unions", () => {
  for (const mode of AI_PERMISSION_MODES) assert.ok(isAiPermissionMode(mode));
  for (const value of AI_TOOL_PERMISSIONS) assert.ok(isAiToolPermission(value));
  for (const value of ["", "read-only", "ALLOW", null, 1, undefined, {}]) {
    assert.equal(isAiPermissionMode(value), false, String(value));
    assert.equal(isAiToolPermission(value), false, String(value));
  }
});

// ── Rendered rows ──────────────────────────────────────────────────────────

const SNAPSHOT: AiPermissionsSnapshot = {
  mode: "ask",
  tools: { cf_delete_dns_record: "allow" },
  catalog: [
    tool("cf_list_dns_records", "read", "allow"),
    tool("cf_delete_dns_record", "write", "allow"),
    tool("cf_purge_cache", "write", "ask"),
  ],
  availability: availability(3, 3),
};

test("a row renders the permission the backend reported, with its reason", () => {
  const rows = buildAiToolPermissionRows(SNAPSHOT, true);

  assert.deepEqual(
    rows.map((row) => [row.tool.name, row.effective, row.reason, row.override]),
    [
      ["cf_list_dns_records", "allow", "mode", null],
      ["cf_delete_dns_record", "allow", "override", "allow"],
      ["cf_purge_cache", "ask", "mode", null],
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.drifted),
    [false, false, false],
  );
  assert.deepEqual(summarizeAiToolPermissionRows(rows), {
    allow: 2,
    ask: 1,
    deny: 0,
  });
});

test("tools off renders every row as refused and says that is why", () => {
  const rows = buildAiToolPermissionRows(SNAPSHOT, false);

  // The catalog still reports `allow` for two of these. Rendering that while
  // nothing can run is the exact misreport this guards against.
  assert.deepEqual(
    rows.map((row) => row.effective),
    ["deny", "deny", "deny"],
  );
  assert.deepEqual(
    rows.map((row) => row.reason),
    ["toolsOff", "toolsOff", "toolsOff"],
  );
  assert.deepEqual(summarizeAiToolPermissionRows(rows), {
    allow: 0,
    ask: 0,
    deny: 3,
  });
  // Drift is not reported while the global switch is what decides: the rules
  // and the catalog are not being compared at all in that state.
  assert.deepEqual(
    rows.map((row) => row.drifted),
    [false, false, false],
  );
});

test("a backend decision the rules do not predict is flagged, not overruled", () => {
  const drifting: AiPermissionsSnapshot = {
    mode: "readOnly",
    tools: {},
    // `readOnly` would deny a write, but the backend says it runs. The backend
    // is what actually executes, so its answer is rendered — and marked.
    catalog: [tool("cf_delete_dns_record", "write", "allow")],
    availability: availability(1, 1),
  };

  const [row] = buildAiToolPermissionRows(drifting, true);
  assert.equal(row.effective, "allow");
  assert.equal(row.reported, "allow");
  assert.equal(row.drifted, true);
  assert.equal(row.reason, "mode");
});

test("an empty catalog produces no rows and a zeroed summary", () => {
  const rows = buildAiToolPermissionRows(
    { mode: "ask", tools: {}, catalog: [], availability: availability(0, 0) },
    true,
  );
  assert.deepEqual(rows, []);
  assert.deepEqual(summarizeAiToolPermissionRows(rows), {
    allow: 0,
    ask: 0,
    deny: 0,
  });
});

// ── Bounds, against the Rust validators ────────────────────────────────────

/**
 * Every bound in the TS table, paired with the Rust constant that is its
 * source of truth.
 *
 * `AI_AGENT_LIMITS` is a hand-maintained duplicate of those constants, so it
 * can drift freely and silently — which is the whole reason this table exists.
 * Drift is a build-time problem and belongs in CI, not in a round-trip on
 * every settings open, so the bounds are not fetched at runtime.
 *
 * Nearly everything lives in the provider crate: the provider crate cannot
 * depend on the agent crate, so a bound the request validator enforces has to
 * live provider-side, and `bc_ai_agent::config` re-exports two of them as
 * aliases. The aliases are deliberately never read here — an alias is not a
 * literal, so reading one would fail to parse rather than assert anything.
 * Only four bounds are genuinely agent-only concepts.
 *
 * `seed` is absent on purpose: its range is the `u32` type rather than a
 * validated bound, so there is no constant to pin, and asserting that no
 * validator exists would fire the day someone adds a legitimate one.
 */
const RUST_BOUNDS: readonly {
  field: string;
  bound: "min" | "max";
  actual: number;
  file: string;
  constant: string;
}[] = [
  // Agent-only concepts, with no provider-side validator.
  {
    field: "maxToolRounds",
    bound: "max",
    actual: AI_AGENT_LIMITS.maxToolRounds.max,
    file: AGENT_CONFIG_RS,
    constant: "MAX_TOOL_ROUNDS",
  },
  {
    field: "maxContextTokens",
    bound: "min",
    actual: AI_AGENT_LIMITS.maxContextTokens.min,
    file: AGENT_CONFIG_RS,
    constant: "MIN_CONTEXT_TOKENS",
  },
  {
    field: "maxContextTokens",
    bound: "max",
    actual: AI_AGENT_LIMITS.maxContextTokens.max,
    file: AGENT_CONFIG_RS,
    constant: "MAX_CONTEXT_TOKENS",
  },
  // Everything the provider crate owns, because the request validator is the
  // last gate before the wire and has to enforce them anyway.
  {
    field: "maxTokensPerTurn",
    bound: "max",
    actual: AI_AGENT_LIMITS.maxTokensPerTurn.max,
    file: PROVIDER_LIMITS_RS,
    constant: "MAX_COMPLETION_TOKENS",
  },
  {
    field: "temperature",
    bound: "min",
    actual: AI_AGENT_LIMITS.temperature.min,
    file: PROVIDER_LIMITS_RS,
    constant: "MIN_TEMPERATURE",
  },
  {
    field: "temperature",
    bound: "max",
    actual: AI_AGENT_LIMITS.temperature.max,
    file: PROVIDER_LIMITS_RS,
    constant: "MAX_TEMPERATURE",
  },
  {
    field: "topP",
    bound: "min",
    actual: AI_AGENT_LIMITS.topP.min,
    file: PROVIDER_LIMITS_RS,
    constant: "MIN_TOP_P",
  },
  {
    field: "topP",
    bound: "max",
    actual: AI_AGENT_LIMITS.topP.max,
    file: PROVIDER_LIMITS_RS,
    constant: "MAX_TOP_P",
  },
  {
    field: "topK",
    bound: "min",
    actual: AI_AGENT_LIMITS.topK.min,
    file: PROVIDER_LIMITS_RS,
    constant: "MIN_TOP_K",
  },
  {
    field: "topK",
    bound: "max",
    actual: AI_AGENT_LIMITS.topK.max,
    file: PROVIDER_LIMITS_RS,
    constant: "MAX_TOP_K",
  },
  {
    field: "frequencyPenalty",
    bound: "min",
    actual: AI_AGENT_LIMITS.frequencyPenalty.min,
    file: PROVIDER_LIMITS_RS,
    constant: "MIN_SAMPLING_PENALTY",
  },
  {
    field: "frequencyPenalty",
    bound: "max",
    actual: AI_AGENT_LIMITS.frequencyPenalty.max,
    file: PROVIDER_LIMITS_RS,
    constant: "MAX_SAMPLING_PENALTY",
  },
  // Both penalties share one Rust pair, so both are listed: a table that
  // checked only one would let the other drift.
  {
    field: "presencePenalty",
    bound: "min",
    actual: AI_AGENT_LIMITS.presencePenalty.min,
    file: PROVIDER_LIMITS_RS,
    constant: "MIN_SAMPLING_PENALTY",
  },
  {
    field: "presencePenalty",
    bound: "max",
    actual: AI_AGENT_LIMITS.presencePenalty.max,
    file: PROVIDER_LIMITS_RS,
    constant: "MAX_SAMPLING_PENALTY",
  },
  {
    field: "requestTimeoutMs",
    bound: "min",
    actual: AI_AGENT_LIMITS.requestTimeoutMs.min,
    file: PROVIDER_LIMITS_RS,
    constant: "MIN_REQUEST_TIMEOUT_MS",
  },
  {
    field: "requestTimeoutMs",
    bound: "max",
    actual: AI_AGENT_LIMITS.requestTimeoutMs.max,
    file: PROVIDER_LIMITS_RS,
    constant: "MAX_REQUEST_TIMEOUT_MS",
  },
  {
    field: "stop (sequence count)",
    bound: "max",
    actual: AI_STOP_LIMITS.maxSequences,
    file: PROVIDER_LIMITS_RS,
    constant: "MAX_STOP_SEQUENCES",
  },
  {
    field: "stop (bytes per sequence)",
    bound: "min",
    actual: AI_STOP_LIMITS.minSequenceBytes,
    file: PROVIDER_LIMITS_RS,
    constant: "MIN_STOP_SEQUENCE_BYTES",
  },
  {
    field: "stop (bytes per sequence)",
    bound: "max",
    actual: AI_STOP_LIMITS.maxSequenceBytes,
    file: PROVIDER_LIMITS_RS,
    constant: "MAX_STOP_SEQUENCE_BYTES",
  },
  {
    field: "systemPromptOverride (bytes)",
    bound: "max",
    actual: AI_PERSONA_LIMITS.systemPromptBytes,
    file: PROVIDER_LIMITS_RS,
    constant: "MAX_SYSTEM_PROMPT_BYTES",
  },
  // The eight configurable retention and plan limits. Only their ceilings are
  // pinned here: each floor is 1 by construction, from Rust's
  // `value == 0 || value > ceiling` check, which the test below pins
  // separately rather than inventing a `MIN_` constant that does not exist.
  //
  // Each of these ceilings is also the field's serde default, which is why the
  // form seeds an absent field from `max` rather than from a number of its
  // own: the ceiling is what the backend will have used.
  {
    field: "maxConversations",
    bound: "max",
    actual: AI_AGENT_LIMITS.maxConversations.max,
    file: CHAT_LIMITS_RS,
    constant: "MAX_CONVERSATIONS",
  },
  {
    field: "maxMessagesPerConversation",
    bound: "max",
    actual: AI_AGENT_LIMITS.maxMessagesPerConversation.max,
    file: CHAT_LIMITS_RS,
    constant: "MAX_MESSAGES_PER_CONVERSATION",
  },
  {
    field: "maxChatMessageBytes",
    bound: "max",
    actual: AI_AGENT_LIMITS.maxChatMessageBytes.max,
    file: CHAT_LIMITS_RS,
    constant: "MAX_CHAT_MESSAGE_BYTES",
  },
  {
    field: "maxConversationBytes",
    bound: "max",
    actual: AI_AGENT_LIMITS.maxConversationBytes.max,
    file: CHAT_LIMITS_RS,
    constant: "MAX_CONVERSATION_BYTES",
  },
  {
    field: "maxGlobalRetainedBytes",
    bound: "max",
    actual: AI_AGENT_LIMITS.maxGlobalRetainedBytes.max,
    file: CHAT_LIMITS_RS,
    constant: "MAX_GLOBAL_RETAINED_BYTES",
  },
  {
    field: "maxTitleBytes",
    bound: "max",
    actual: AI_AGENT_LIMITS.maxTitleBytes.max,
    file: CHAT_LIMITS_RS,
    constant: "MAX_TITLE_BYTES",
  },
  {
    field: "maxPlanSteps",
    bound: "max",
    actual: AI_AGENT_LIMITS.maxPlanSteps.max,
    file: AGENT_PLAN_RS,
    constant: "MAX_PLAN_STEPS",
  },
  {
    field: "maxRetainedPlans",
    bound: "max",
    actual: AI_AGENT_LIMITS.maxRetainedPlans.max,
    file: AGENT_PLAN_RS,
    constant: "MAX_RETAINED_PLANS",
  },
];

test("every bound in the TS table is the Rust constant it mirrors", () => {
  for (const { field, bound, actual, file, constant } of RUST_BOUNDS) {
    const expected = rustConst(file, constant);
    // The message names the field and the constant, so a drift says what to
    // change rather than only that two numbers differ.
    assert.equal(
      actual,
      expected,
      `${field} ${bound} is ${actual} in AI_AGENT_LIMITS but ${constant} is ${expected} in ${basename(file)} - update the TS table to match`,
    );
  }
});

test("the agent-config floors the Rust validators imply are the TS floors", () => {
  // These two have no `MIN_` constant: the Rust check is `== 0 || > MAX`,
  // which makes 1 the floor by construction. Pinning the *shape* is the right
  // call while the floors are implicit, but it does make the shape a contract
  // rather than an accident — so the failure message says what to do, because
  // the fix is not "restore the inline check", it is to move these two into
  // `RUST_BOUNDS` with the new constant names.
  const promoted =
    "move maxToolRounds/maxTokensPerTurn into RUST_BOUNDS with the new constant names";
  assert.equal(
    AI_AGENT_LIMITS.maxToolRounds.min,
    1,
    `maxToolRounds min must be the floor the == 0 check implies - if Rust gained a MIN_TOOL_ROUNDS, ${promoted}`,
  );
  assert.equal(
    AI_AGENT_LIMITS.maxTokensPerTurn.min,
    1,
    `maxTokensPerTurn min must be the floor the == 0 check implies - if Rust gained a MIN_COMPLETION_TOKENS, ${promoted}`,
  );
  const agentSource = readFileSync(AGENT_CONFIG_RS, "utf8");
  for (const field of ["max_tool_rounds", "max_tokens_per_turn"] as const) {
    assert.match(
      agentSource,
      new RegExp(`self\\.${field} == 0`),
      `${field} no longer has an inline zero check - if its floor became a named constant, ${promoted}`,
    );
  }
});

test("the eight configurable limits are the eight Rust validates, with 1 as the floor", () => {
  // Two different drifts are caught here, and they fail differently on
  // purpose.
  //
  // The first is a *missing* control: Rust's `CONFIGURABLE_LIMITS` is the one
  // table `AgentConfig::validate` walks, so a limit added there without a
  // matching entry in `AI_CONFIGURABLE_LIMITS` is a setting the backend
  // enforces and the form never offers — which is exactly how all eight of
  // these shipped with no UI in the first place.
  //
  // The second is the floor. None of them has a `MIN_` constant, because the
  // Rust check is `value == 0 || value > ceiling`: zero is refused rather than
  // read as "unlimited", which makes 1 the floor by construction. So the
  // *shape* of that check is what gets pinned, and the failure message says
  // the fix is to move the floor into `RUST_BOUNDS` rather than to put the
  // inline check back.
  const agentSource = readFileSync(AGENT_CONFIG_RS, "utf8");
  const table = agentSource.match(
    /const CONFIGURABLE_LIMITS:\s*\[ConfigurableLimit;\s*(\d+)\]\s*=\s*\[([\s\S]*?)\n\];/,
  );
  assert.ok(
    table,
    "CONFIGURABLE_LIMITS must stay parseable in config.rs - it is the table validate() walks",
  );
  const rustFields = Array.from(table[2].matchAll(/"([A-Za-z0-9_]+)"/g)).map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...AI_CONFIGURABLE_LIMITS],
    rustFields,
    "AI_CONFIGURABLE_LIMITS must list exactly the fields Rust's CONFIGURABLE_LIMITS does, in the same order - a limit Rust enforces and the form does not offer is a setting with no control",
  );
  assert.equal(
    Number(table[1]),
    AI_CONFIGURABLE_LIMITS.length,
    "the declared length of CONFIGURABLE_LIMITS must match the fields it holds",
  );

  for (const field of AI_CONFIGURABLE_LIMITS) {
    assert.equal(
      AI_AGENT_LIMITS[field].min,
      1,
      `${field} min must be the floor the == 0 check implies - if Rust gained a named floor, move it into RUST_BOUNDS with that constant`,
    );
  }
  // The check itself, so a Rust change from "refuse zero" to "clamp zero"
  // cannot leave these floors claiming something that stopped being true.
  assert.match(
    agentSource,
    /value == 0 \|\| value > ceiling/,
    "the configurable limits must still refuse zero and anything above the ceiling - if they are clamped instead, the floors above are no longer a contract",
  );
});

test("the validators compare against the constants they name", () => {
  // A bound can be named and then compared against something else. The
  // temperature range in particular used to be two literals here, which this
  // test scraped with a regex; reading the constants is sturdier, but only if
  // the validator is still using them.
  //
  // Each pattern matches only the `(MIN..=MAX).contains(&field)` fragment, so
  // it is indifferent to how rustfmt wraps the condition around it — two of
  // these six are already split across lines before the `||`. The `\s*` before
  // `.contains` is there for the one wrap that *would* break the match, a
  // method call pushed onto its own line, so a pure formatting change cannot
  // turn this into a false alarm. It still tolerates nothing but whitespace:
  // a different constant or a different field fails.
  const named = (range: string, field: string) =>
    new RegExp(`\\(${range}\\)\\s*\\.contains\\(&${field}\\)`);
  const sites: readonly [string, string, string][] = [
    [
      PROVIDER_CONFIG_RS,
      "MIN_TEMPERATURE..=MAX_TEMPERATURE",
      "self\\.temperature",
    ],
    [
      AGENT_CONFIG_RS,
      "MIN_TEMPERATURE..=MAX_TEMPERATURE",
      "self\\.temperature",
    ],
    [AGENT_CONFIG_RS, "MIN_TOP_P..=MAX_TOP_P", "self\\.top_p"],
    [AGENT_CONFIG_RS, "MIN_TOP_K..=MAX_TOP_K", "top_k"],
    [AGENT_CONFIG_RS, "MIN_SAMPLING_PENALTY..=MAX_SAMPLING_PENALTY", "penalty"],
    [
      AGENT_CONFIG_RS,
      "MIN_CONTEXT_TOKENS..=MAX_CONTEXT_TOKENS",
      "self\\.max_context_tokens",
    ],
    [
      AGENT_CONFIG_RS,
      "MIN_REQUEST_TIMEOUT_MS..=MAX_REQUEST_TIMEOUT_MS",
      "timeout_ms",
    ],
  ];
  for (const [file, range, field] of sites) {
    const escapedRange = range.replaceAll(".", "\\.");
    assert.match(
      readFileSync(file, "utf8"),
      named(escapedRange, field),
      `${basename(file)} must still enforce ${range} - a bound that is named but compared against something else is the drift this test exists for`,
    );
  }
});

test("the context-budget default is the one AgentConfig::default uses", () => {
  // The form has to seed this field with *something* when a config read from
  // an older build carries no value, and the only honest something is the
  // value the backend would have defaulted it to.
  assert.equal(
    AI_DEFAULT_MAX_CONTEXT_TOKENS,
    rustConst(AGENT_CONFIG_RS, "DEFAULT_MAX_CONTEXT_TOKENS"),
  );
});

test("the persona bounds are the Rust byte limits", () => {
  assert.equal(
    AI_PERSONA_LIMITS.nameBytes,
    rustConst(AGENT_CONFIG_RS, "MAX_PRESET_BYTES"),
  );
  assert.equal(
    AI_PERSONA_LIMITS.systemPromptBytes,
    rustConst(PROVIDER_LIMITS_RS, "MAX_SYSTEM_PROMPT_BYTES"),
  );
});

test("agent-config validation accepts the exact boundaries and rejects past them", () => {
  const valid = {
    maxToolRounds: AI_AGENT_LIMITS.maxToolRounds.max,
    maxTokensPerTurn: AI_AGENT_LIMITS.maxTokensPerTurn.max,
    temperature: AI_AGENT_LIMITS.temperature.max,
    topP: AI_AGENT_LIMITS.topP.max,
  };
  assert.deepEqual(validateAgentConfig(valid), []);
  assert.deepEqual(
    validateAgentConfig({
      maxToolRounds: AI_AGENT_LIMITS.maxToolRounds.min,
      maxTokensPerTurn: AI_AGENT_LIMITS.maxTokensPerTurn.min,
      temperature: AI_AGENT_LIMITS.temperature.min,
      topP: AI_AGENT_LIMITS.topP.min,
    }),
    [],
  );

  assert.deepEqual(
    validateAgentConfig({ ...valid, maxToolRounds: valid.maxToolRounds + 1 }),
    [
      {
        field: "maxToolRounds",
        code: "integerRange",
        min: 1,
        max: AI_AGENT_LIMITS.maxToolRounds.max,
      },
    ],
  );
  assert.deepEqual(
    validateAgentConfig({ ...valid, temperature: 2.01 }).map(
      (issue) => issue.field,
    ),
    ["temperature"],
  );
  // `topP` is a probability: 1 is the ceiling, so 1.5 is not a soft overshoot.
  assert.deepEqual(
    validateAgentConfig({ ...valid, topP: 1.5 }).map((issue) => issue.field),
    ["topP"],
  );
  // A fractional round count is not a round count.
  assert.deepEqual(
    validateAgentConfig({ ...valid, maxToolRounds: 2.5 }).map(
      (issue) => issue.code,
    ),
    ["integerRange"],
  );
  // NaN and Infinity must be rejected, not coerced.
  for (const broken of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      validateAgentConfig({ ...valid, temperature: broken }).map(
        (issue) => issue.field,
      ),
      ["temperature"],
      String(broken),
    );
  }
  // Every field reports independently rather than stopping at the first.
  assert.deepEqual(
    validateAgentConfig({
      maxToolRounds: 0,
      maxTokensPerTurn: 0,
      temperature: -1,
      topP: 2,
    }).map((issue) => issue.field),
    ["maxToolRounds", "maxTokensPerTurn", "temperature", "topP"],
  );
});

test("persona validation measures bytes, not characters", () => {
  const ok = {
    name: "Zone reviewer",
    description: "Reads a zone",
    systemPrompt: "You review DNS zones.",
  };
  assert.deepEqual(validatePersonaInput(ok), []);

  // Whitespace-only is empty: the backend trims before it checks, so a name of
  // spaces would be refused there after passing a naive length check here.
  assert.deepEqual(validatePersonaInput({ ...ok, name: "   " }), [
    { field: "name", code: "required" },
  ]);
  assert.deepEqual(validatePersonaInput({ ...ok, systemPrompt: "\n\t " }), [
    { field: "systemPrompt", code: "required" },
  ]);

  // Exactly at the limit passes; one byte over does not.
  const atLimit = "a".repeat(AI_PERSONA_LIMITS.nameBytes);
  assert.deepEqual(validatePersonaInput({ ...ok, name: atLimit }), []);
  assert.deepEqual(validatePersonaInput({ ...ok, name: `${atLimit}a` }), [
    { field: "name", code: "tooLong", limit: AI_PERSONA_LIMITS.nameBytes },
  ]);

  // The point of counting bytes: a 4-byte emoji is one JS code point pair and
  // four bytes to Rust, so a character count would wave this through.
  const emoji = "🌍".repeat(AI_PERSONA_LIMITS.nameBytes / 4 + 1);
  assert.ok(emoji.length < AI_PERSONA_LIMITS.nameBytes);
  assert.deepEqual(validatePersonaInput({ ...ok, name: emoji }), [
    { field: "name", code: "tooLong", limit: AI_PERSONA_LIMITS.nameBytes },
  ]);

  // An over-long description is reported, but it is not required.
  assert.deepEqual(validatePersonaInput({ ...ok, description: "" }), []);
  assert.deepEqual(
    validatePersonaInput({
      ...ok,
      description: "d".repeat(AI_PERSONA_LIMITS.descriptionBytes + 1),
    }),
    [
      {
        field: "description",
        code: "tooLong",
        limit: AI_PERSONA_LIMITS.descriptionBytes,
      },
    ],
  );
});
