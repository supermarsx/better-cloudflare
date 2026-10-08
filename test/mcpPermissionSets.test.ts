/**
 * Saved tool-permission sets, and the one thing they must not become: a way
 * around the permission gate.
 *
 * A set is a named selection the user can switch to. The hazard is obvious
 * once stated -- if applying a set wrote `mcpEnabledTools` directly, anyone
 * could save a set holding `cf_delete_dns_record`, apply it, and have a
 * destructive tool enabled without the confirmation a click in the
 * permissions screen would have triggered. The apply path therefore goes
 * through `partitionMcpPermissionPolicySelection` and `stageMcpEnabledTools`,
 * the same two steps that click takes, and the test below is written as that
 * attack rather than as a round-trip.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_MCP_PERMISSION_SETS,
  MAX_MCP_PERMISSION_SET_NAME_BYTES,
  normalizeMcpPermissionSetName,
  reconcileMcpPermissionSets,
} from "../src/lib/mcp/tool-permissions.ts";
import { storageManager } from "../src/lib/storage/storage.ts";

/** A tool the permissions screen would stop and ask about. */
const DESTRUCTIVE = "cf_delete_dns_record";
/** Two tools it would not. */
const READ_ONLY = ["cf_list_zones", "cf_list_dns_records"];

function clearSets(): void {
  for (const name of Object.keys(storageManager.getMcpPermissionSets())) {
    storageManager.deleteMcpPermissionSet(name);
  }
}

test("a saved set round-trips under the name it was given", () => {
  clearSets();
  assert.equal(
    storageManager.saveMcpPermissionSet("Read only", READ_ONLY),
    "Read only",
  );
  assert.deepEqual(
    { ...storageManager.getMcpPermissionSets() },
    { "Read only": READ_ONLY },
  );
  assert.equal(storageManager.deleteMcpPermissionSet("Read only"), true);
  assert.deepEqual({ ...storageManager.getMcpPermissionSets() }, {});
});

test("a name is trimmed, and surrounding space does not make a second set", () => {
  clearSets();
  storageManager.saveMcpPermissionSet("  Audit  ", READ_ONLY);
  storageManager.saveMcpPermissionSet("Audit", [READ_ONLY[0]]);
  assert.deepEqual(Object.keys(storageManager.getMcpPermissionSets()), [
    "Audit",
  ]);
  clearSets();
});

test("an unusable name is refused rather than stored under something else", () => {
  clearSets();
  const tooLong = "x".repeat(MAX_MCP_PERMISSION_SET_NAME_BYTES + 1);
  for (const bad of ["", "   ", "has a \u0000 null", "tab\tinside", tooLong]) {
    assert.equal(
      storageManager.saveMcpPermissionSet(bad, READ_ONLY),
      null,
      `${JSON.stringify(bad.slice(0, 20))} must be refused`,
    );
  }
  assert.deepEqual({ ...storageManager.getMcpPermissionSets() }, {});
});

test("a name is bounded in bytes, not characters", () => {
  // An emoji is four bytes and one grapheme. A limit measured in characters
  // would accept a name the storage layer then refuses to write, turning a
  // polite "that name is too long" into a thrown save.
  const name = "\u{1F600}".repeat(
    Math.ceil(MAX_MCP_PERMISSION_SET_NAME_BYTES / 4),
  );
  assert.equal(normalizeMcpPermissionSetName(name), name);
  assert.equal(normalizeMcpPermissionSetName(`${name}\u{1F600}`), null);
});

test("the library is full at its limit, but a rename-in-place still works", () => {
  clearSets();
  for (let index = 0; index < MAX_MCP_PERMISSION_SETS; index += 1) {
    assert.equal(
      storageManager.saveMcpPermissionSet(`set-${index}`, READ_ONLY),
      `set-${index}`,
    );
  }
  assert.equal(
    storageManager.saveMcpPermissionSet("one too many", READ_ONLY),
    null,
  );
  // Overwriting an existing set adds no entry, so it must not be refused for
  // fullness -- otherwise a full library could never be edited.
  assert.equal(
    storageManager.saveMcpPermissionSet("set-0", [READ_ONLY[0]]),
    "set-0",
  );
  assert.deepEqual(storageManager.getMcpPermissionSets()["set-0"], [
    READ_ONLY[0],
  ]);
  clearSets();
});

test("a set can only name tools the catalogue has", () => {
  clearSets();
  storageManager.saveMcpPermissionSet("mixed", [
    READ_ONLY[0],
    "cf_tool_from_a_newer_build",
    "../../etc/passwd",
  ]);
  assert.deepEqual(storageManager.getMcpPermissionSets().mixed, [READ_ONLY[0]]);
  clearSets();
});

test("a set that enables nothing is a selection, not an absence", () => {
  clearSets();
  assert.equal(
    storageManager.saveMcpPermissionSet("locked down", []),
    "locked down",
  );
  assert.deepEqual(storageManager.getMcpPermissionSets()["locked down"], []);
  clearSets();
});

test("the returned map is a copy, so a renderer cannot edit saved state", () => {
  clearSets();
  storageManager.saveMcpPermissionSet("Read only", READ_ONLY);
  const sets = storageManager.getMcpPermissionSets();
  sets["Read only"].push(DESTRUCTIVE);
  sets.invented = [DESTRUCTIVE];
  assert.deepEqual(
    { ...storageManager.getMcpPermissionSets() },
    { "Read only": READ_ONLY },
  );
  clearSets();
});

test("applying a set that holds a destructive tool does not enable it", () => {
  // The attack this file exists for. If this assertion ever reads
  // `enabledTools` containing DESTRUCTIVE, saving a set has become a way to
  // grant yourself a permission the UI would have stopped to ask about.
  clearSets();
  storageManager.setMcpEnabledTools([...READ_ONLY]);
  storageManager.saveMcpPermissionSet("danger", [...READ_ONLY, DESTRUCTIVE]);

  const applied = storageManager.applyMcpPermissionSet("danger");
  assert.ok(applied, "applying a saved set should report what it did");
  assert.ok(
    !applied.enabledTools.includes(DESTRUCTIVE),
    "a destructive tool must not be enabled by applying a set",
  );
  assert.ok(
    applied.pendingHighRiskToolIds.includes(DESTRUCTIVE),
    "it must instead arrive pending confirmation",
  );
  assert.ok(
    !storageManager.getMcpEnabledTools().includes(DESTRUCTIVE),
    "and the stored enabled set must agree",
  );
  for (const id of READ_ONLY) {
    assert.ok(
      applied.enabledTools.includes(id),
      `${id} is read-only and should have been enabled outright`,
    );
  }
  clearSets();
});

test("applying a set nobody saved changes nothing", () => {
  clearSets();
  storageManager.setMcpEnabledTools([...READ_ONLY]);
  assert.equal(storageManager.applyMcpPermissionSet("no such set"), null);
  assert.equal(storageManager.applyMcpPermissionSet("  "), null);
  assert.deepEqual(storageManager.getMcpEnabledTools(), READ_ONLY);
  clearSets();
});

test("reconciling an untrusted map drops what it cannot honour", () => {
  // Reached directly as well as through storage, because this is the function
  // an imported file's payload goes through.
  const reconciled = reconcileMcpPermissionSets({
    good: [READ_ONLY[0], "nonsense"],
    "": [READ_ONLY[0]],
    "bad\u0007name": [READ_ONLY[0]],
    notAnArray: "cf_list_zones",
  });
  assert.deepEqual({ ...reconciled }, { good: [READ_ONLY[0]], notAnArray: [] });
  assert.deepEqual({ ...reconcileMcpPermissionSets(null) }, {});
  assert.deepEqual({ ...reconcileMcpPermissionSets([READ_ONLY]) }, {});
});

test("reconciling keeps only as many sets as the app can hold", () => {
  const overflowing = Object.fromEntries(
    Array.from({ length: MAX_MCP_PERMISSION_SETS + 5 }, (_, index) => [
      `set-${index}`,
      READ_ONLY,
    ]),
  );
  assert.equal(
    Object.keys(reconcileMcpPermissionSets(overflowing)).length,
    MAX_MCP_PERMISSION_SETS,
  );
});

test("a set named __proto__ is a set, not a prototype change", () => {
  // Set names are arbitrary user text and arrive from imported files, so the
  // map they key is given a null prototype. With an ordinary object literal a
  // set called `__proto__` would be swallowed by the inherited setter rather
  // than stored, and one called `constructor` would shadow a real property.
  const reconciled = reconcileMcpPermissionSets(
    JSON.parse(
      '{"__proto__":["cf_list_zones"],"constructor":["cf_list_dns_records"]}',
    ),
  );
  assert.equal(Object.getPrototypeOf(reconciled), null);
  assert.deepEqual(Object.keys(reconciled).sort(), [
    "__proto__",
    "constructor",
  ]);
  assert.deepEqual(reconciled["__proto__"], [READ_ONLY[0]]);
  assert.deepEqual(reconciled["constructor"], [READ_ONLY[1]]);
});
