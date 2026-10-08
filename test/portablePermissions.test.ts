/**
 * The claim that an import cannot grant a tool permission manual use would
 * have asked about.
 *
 * The central assertion is exhaustive rather than illustrative: a file that
 * asks for *every* id in the catalogue must leave the enabled set exactly
 * equal to `DEFAULT_MCP_ENABLED_TOOL_IDS`, the read-risk tools. That pins the
 * property for every tool at once, including ones added after this was
 * written, which a list of named examples could not do -- a new destructive
 * tool would simply not be in the list.
 *
 * The named cases around it cover the two ways a file can be hostile rather
 * than merely stale: an id above `read` risk, which must arrive pending, and
 * an id the catalogue has never heard of, which must be dropped rather than
 * granted at the `admin` risk `resolveMcpTool` gives an unknown tool.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MCP_ENABLED_TOOL_IDS,
  MAX_MCP_PERMISSION_SETS,
  MCP_PERMISSION_POLICY_VERSION,
  MCP_TOOL_FALLBACKS,
  STABLE_MCP_TOOL_IDS,
} from "../src/lib/mcp/tool-permissions";
import { buildEnvelope } from "../src/lib/portable/envelope";
import {
  applyPortableToolPermissions,
  exportToolPermissions,
  parseToolPermissionsFile,
} from "../src/lib/portable/permissions";
import type { PortableToolPermissions } from "../src/lib/portable/types";

const OPTIONS = { appVersion: "1.2.3", now: new Date("2026-03-04T05:06:07Z") };

/** A destructive tool, an admin tool, and two ids that do not exist. */
const DESTRUCTIVE = "cf_delete_dns_record";
const ADMIN = "cf_update_zone_setting";
const READ = "cf_list_zones";
const INVENTED = ["dns_delete_record", "totally_made_up"];

function file(payload: unknown): string {
  return JSON.stringify(buildEnvelope("tool-permissions", payload, OPTIONS));
}

function payload(
  overrides: Partial<PortableToolPermissions> = {},
): PortableToolPermissions {
  return {
    policyVersion: MCP_PERMISSION_POLICY_VERSION,
    enabledToolIds: [],
    sets: [],
    ...overrides,
  };
}

function subjects(
  warnings: readonly { reason: string; subjects: string[] }[],
  reason: string,
): string[] {
  return warnings
    .filter((warning) => warning.reason === reason)
    .flatMap((warning) => warning.subjects);
}

test("an export states the current policy version and reconciles its ids", () => {
  const envelope = exportToolPermissions(
    {
      enabledToolIds: [READ, "left_the_catalogue"],
      sets: { Everything: [DESTRUCTIVE, "also_gone"], "  ": [READ] },
    },
    OPTIONS,
  );
  assert.equal(envelope.payload.policyVersion, MCP_PERMISSION_POLICY_VERSION);
  assert.deepEqual(envelope.payload.enabledToolIds, [READ]);
  // A set whose name cannot be stored is not written; the one that can keeps
  // only ids the catalogue still has.
  assert.deepEqual(envelope.payload.sets, [
    { name: "Everything", toolIds: [DESTRUCTIVE] },
  ]);
});

test("a file asking for the whole catalogue grants only the read-risk tools", () => {
  const result = applyPortableToolPermissions(
    { enabledToolIds: [] },
    payload({ enabledToolIds: [...STABLE_MCP_TOOL_IDS] }),
  );
  assert.deepEqual(result.enabledToolIds, [...DEFAULT_MCP_ENABLED_TOOL_IDS]);
  // Everything else is a question, not a grant.
  const confirmable = MCP_TOOL_FALLBACKS.filter(
    ({ risk }) => risk !== "read",
  ).map(({ id }) => id);
  assert.deepEqual(result.pendingHighRiskToolIds.sort(), confirmable.sort());
  for (const id of confirmable) {
    assert.equal(result.enabledToolIds.includes(id), false);
  }
});

test("a hostile file enables nothing it was not already allowed to", () => {
  const result = applyPortableToolPermissions(
    { enabledToolIds: [] },
    payload({ enabledToolIds: [READ, DESTRUCTIVE, ADMIN, ...INVENTED] }),
  );

  assert.deepEqual(result.enabledToolIds, [READ]);
  assert.deepEqual(result.pendingHighRiskToolIds, [DESTRUCTIVE, ADMIN]);
  // An invented id is dropped, not granted. `resolveMcpTool` would class an
  // unknown tool as `admin`, which is exactly what must not be reachable from
  // a file.
  for (const id of INVENTED) {
    assert.equal(result.enabledToolIds.includes(id), false);
    assert.equal(result.pendingHighRiskToolIds.includes(id), false);
    assert.equal(result.removedToolIds.includes(id), true);
  }
  assert.deepEqual(
    subjects(result.warnings, "unknown-tool-id").sort(),
    [...INVENTED].sort(),
  );
  assert.deepEqual(subjects(result.warnings, "high-risk-pending"), [
    DESTRUCTIVE,
    ADMIN,
  ]);
});

test("an already-confirmed grant is asked for again, as a set switch asks", () => {
  const result = applyPortableToolPermissions(
    { enabledToolIds: [DESTRUCTIVE] },
    payload({ enabledToolIds: [READ, DESTRUCTIVE, ADMIN] }),
  );
  // This is the behaviour of `Storage.applyMcpPermissionSet`, which hands
  // `partition.enabledToolIds` to a staging path that replaces rather than
  // merges: adopting a selection re-asks about every tool above `read` risk in
  // it, even one that was enabled a moment ago. An import that kept the grant
  // would be a softer gate than a set switch for the same act.
  assert.deepEqual(result.enabledToolIds, [READ]);
  assert.deepEqual(result.pendingHighRiskToolIds, [DESTRUCTIVE, ADMIN]);
});

test("what is already enabled is not an input to what an import enables", () => {
  const result = applyPortableToolPermissions(
    { enabledToolIds: [READ, DESTRUCTIVE, "left_the_catalogue"] },
    payload({ enabledToolIds: [] }),
  );
  // A file enabling nothing enables nothing, whatever this machine holds.
  assert.deepEqual(result.enabledToolIds, []);
  assert.deepEqual(result.pendingHighRiskToolIds, []);
  // And an id stored here that the catalogue has dropped is not reported as
  // the file's fault.
  assert.deepEqual(result.removedToolIds, []);
});

test("the three id lists are the partition's, so none of them overlap", () => {
  const result = applyPortableToolPermissions(
    { enabledToolIds: [] },
    payload({ enabledToolIds: [...STABLE_MCP_TOOL_IDS, ...INVENTED] }),
  );
  const enabled = new Set(result.enabledToolIds);
  const pending = new Set(result.pendingHighRiskToolIds);
  const removed = new Set(result.removedToolIds);
  for (const id of enabled) {
    assert.equal(pending.has(id), false, `${id} is enabled and pending`);
    assert.equal(removed.has(id), false, `${id} is enabled and unknown`);
  }
  for (const id of pending) {
    assert.equal(removed.has(id), false, `${id} is pending and unknown`);
  }
  assert.equal(
    enabled.size + pending.size,
    STABLE_MCP_TOOL_IDS.length,
    "every catalogue id is either enabled or pending, and nothing else is",
  );
});

test("a differing policy version is reported, a matching one is not", () => {
  const differs = applyPortableToolPermissions(
    { enabledToolIds: [] },
    payload({ policyVersion: MCP_PERMISSION_POLICY_VERSION + 1 }),
  );
  assert.deepEqual(subjects(differs.warnings, "policy-version-differs"), [
    String(MCP_PERMISSION_POLICY_VERSION + 1),
  ]);

  const matches = applyPortableToolPermissions(
    { enabledToolIds: [] },
    payload(),
  );
  assert.deepEqual(subjects(matches.warnings, "policy-version-differs"), []);
});

test("imported sets win a name collision and the rest survive", () => {
  const result = applyPortableToolPermissions(
    {
      enabledToolIds: [],
      sets: { Shared: [ADMIN], Mine: [READ] },
    },
    payload({
      sets: [{ name: "Shared", toolIds: [READ, "invented_in_a_set"] }],
    }),
  );
  assert.deepEqual(Object.keys(result.sets).sort(), ["Mine", "Shared"]);
  assert.deepEqual(result.sets.Shared, [READ]);
  assert.deepEqual(result.sets.Mine, [READ]);
  // A set is a saved selection, not a grant: its unknown ids are still
  // reported, and nothing in it is enabled by the import.
  assert.equal(result.removedToolIds.includes("invented_in_a_set"), true);
  assert.deepEqual(result.enabledToolIds, []);
});

test("the number of sets an import keeps is bounded", () => {
  const incoming = Array.from(
    { length: MAX_MCP_PERMISSION_SETS + 4 },
    (_, index) => ({ name: `Set ${index}`, toolIds: [READ] }),
  );
  const parse = parseToolPermissionsFile(file(payload({ sets: incoming })));
  assert.equal(parse.ok, true);
  if (!parse.ok) return;
  assert.equal(parse.value.payload.sets.length, MAX_MCP_PERMISSION_SETS);
  assert.deepEqual(subjects(parse.warnings, "too-many-sets"), ["4"]);

  const result = applyPortableToolPermissions(
    { enabledToolIds: [], sets: { Mine: [READ] } },
    parse.value.payload,
  );
  assert.equal(
    Object.keys(result.sets).length,
    MAX_MCP_PERMISSION_SETS,
    "the machine's own sets cannot push the total past the ceiling",
  );
});

test("the parse keeps an unknown id so that the apply can report it", () => {
  const parse = parseToolPermissionsFile(
    file(payload({ enabledToolIds: [READ, ...INVENTED] })),
  );
  assert.equal(parse.ok, true);
  if (!parse.ok) return;
  assert.deepEqual(parse.value.payload.enabledToolIds, [READ, ...INVENTED]);
});

test("the parsed payload carries only the three fields it is specified with", () => {
  const parse = parseToolPermissionsFile(
    file({ ...payload(), enabledToolIds: [READ, 7, null], evil: "smuggled" }),
  );
  assert.equal(parse.ok, true);
  if (!parse.ok) return;
  assert.deepEqual(Object.keys(parse.value.payload).sort(), [
    "enabledToolIds",
    "policyVersion",
    "sets",
  ]);
  // Non-strings are not coerced: `String(null)` is an id-shaped lie.
  assert.deepEqual(parse.value.payload.enabledToolIds, [READ]);
});

test("a payload missing any of its three fields is malformed", () => {
  for (const broken of [
    { enabledToolIds: [], sets: [] },
    { policyVersion: 1.5, enabledToolIds: [], sets: [] },
    { policyVersion: -1, enabledToolIds: [], sets: [] },
    { policyVersion: 1, sets: [] },
    { policyVersion: 1, enabledToolIds: [] },
    { policyVersion: 1, enabledToolIds: {}, sets: [] },
    [READ],
  ]) {
    const parse = parseToolPermissionsFile(file(broken));
    assert.equal(
      parse.ok === false && parse.rejection,
      "malformed-payload",
      JSON.stringify(broken),
    );
  }
});

test("a file this build writes applies without a single warning", () => {
  const raw = JSON.stringify(
    exportToolPermissions(
      { enabledToolIds: [...DEFAULT_MCP_ENABLED_TOOL_IDS], sets: {} },
      OPTIONS,
    ),
  );
  const parse = parseToolPermissionsFile(raw);
  assert.equal(parse.ok, true);
  if (!parse.ok) return;
  const result = applyPortableToolPermissions(
    { enabledToolIds: [] },
    parse.value.payload,
  );
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.enabledToolIds, [...DEFAULT_MCP_ENABLED_TOOL_IDS]);
});
