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
import { join } from "node:path";
import { test } from "node:test";

import {
  AI_AGENT_LIMITS,
  AI_PERMISSION_MODES,
  AI_PERSONA_LIMITS,
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

/** Read `pub const NAME: ty = 32;` or `= 256 * 1024;` out of a Rust file. */
function rustConst(path: string, name: string): number {
  const source = readFileSync(path, "utf8");
  const match = source.match(
    new RegExp(
      `pub const ${name}\\s*:\\s*[A-Za-z0-9_]+\\s*=\\s*([0-9_]+(?:\\s*\\*\\s*[0-9_]+)*)\\s*;`,
    ),
  );
  assert.ok(match, `${name} must stay parseable in ${path}`);
  return match[1]
    .split("*")
    .map((part) => Number(part.trim().replaceAll("_", "")))
    .reduce((product, factor) => product * factor, 1);
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
  };

  const [row] = buildAiToolPermissionRows(drifting, true);
  assert.equal(row.effective, "allow");
  assert.equal(row.reported, "allow");
  assert.equal(row.drifted, true);
  assert.equal(row.reason, "mode");
});

test("an empty catalog produces no rows and a zeroed summary", () => {
  const rows = buildAiToolPermissionRows(
    { mode: "ask", tools: {}, catalog: [] },
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

test("the agent-config bounds are the Rust validators' bounds", () => {
  assert.equal(
    AI_AGENT_LIMITS.maxToolRounds.max,
    rustConst(AGENT_CONFIG_RS, "MAX_TOOL_ROUNDS"),
  );
  assert.equal(
    AI_AGENT_LIMITS.maxTokensPerTurn.max,
    rustConst(PROVIDER_LIMITS_RS, "MAX_COMPLETION_TOKENS"),
  );
  // Both Rust checks are `== 0 || > MAX`, so 1 is the floor.
  assert.equal(AI_AGENT_LIMITS.maxToolRounds.min, 1);
  assert.equal(AI_AGENT_LIMITS.maxTokensPerTurn.min, 1);

  const temperatureRange = readFileSync(PROVIDER_CONFIG_RS, "utf8").match(
    /\(([0-9.]+)\.\.=([0-9.]+)\)\.contains\(&self\.temperature\)/,
  );
  assert.ok(
    temperatureRange,
    "ProviderConfig::validate must keep its temperature range parseable",
  );
  assert.equal(AI_AGENT_LIMITS.temperature.min, Number(temperatureRange[1]));
  assert.equal(AI_AGENT_LIMITS.temperature.max, Number(temperatureRange[2]));
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
