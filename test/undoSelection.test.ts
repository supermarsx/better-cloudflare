/**
 * The rules behind the undo preview, tested without a DOM.
 *
 * Everything here is a decision that would otherwise only exist inside the
 * dialog's JSX: which rows open checked, which can be included at all, how
 * many records the apply button promises to write, which rows a long plan
 * collapses, and how a partial result reads. They are the rules that decide
 * whether this feature reverts somebody else's later edit without asking, so
 * they are tested directly rather than through a rendered checkbox.
 *
 * `test/undoPreview.test.tsx` covers the dialog that calls them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  RetainedRecordSnapshot,
  UndoPlanRow,
  UndoPreview,
  UndoResult,
} from "../src/lib/history/types";
import {
  classifyUndoResult,
  diffSnapshots,
  initialUndoSelection,
  isUndoRowPreselected,
  isUndoRowSelectable,
  selectedUndoEntryIds,
  selectedUndoRows,
  toggleUndoSelection,
  undoApplyCount,
  undoDriftFields,
  undoFailuresByEntryId,
  undoRecordCount,
  undoRowDisplay,
  undoRowIntent,
  undoRowNeedsConfirmation,
  undoTargetFields,
  undoWouldDropTags,
  unlistedUndoFailures,
  UNDO_PREVIEW_CLEAN_ROW_LIMIT,
} from "../src/lib/history/undo";

function snapshot(
  overrides: Partial<RetainedRecordSnapshot> = {},
): RetainedRecordSnapshot {
  return {
    recordType: "A",
    name: "api.example.test",
    content: "203.0.113.10",
    ttl: 3600,
    priority: null,
    proxied: false,
    comment: null,
    tags: [],
    ...overrides,
  };
}

function row(overrides: Partial<UndoPlanRow> = {}): UndoPlanRow {
  const drift = overrides.drift ?? ({ state: "unchanged" } as const);
  return {
    entryId: "entry-1",
    recordType: "A",
    recordName: "api.example.test",
    target: snapshot(),
    drift,
    // What a correct backend sends: pre-checked only when nothing moved.
    selectedByDefault: drift.state === "unchanged",
    ...overrides,
  };
}

function preview(
  rows: readonly UndoPlanRow[],
  unavailable: UndoPreview["unavailable"] = [],
): UndoPreview {
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    zoneId: "zone-1",
    rows,
    unavailable,
  };
}

function result(overrides: Partial<UndoResult> = {}): UndoResult {
  return {
    operationId: "22222222-2222-4222-8222-222222222222",
    applied: 0,
    skipped: 0,
    failed: [],
    ...overrides,
  };
}

test("a freshly opened plan checks the unchanged rows and nothing else", () => {
  const plan = preview([
    row({ entryId: "clean-1" }),
    row({
      entryId: "drifted",
      drift: { state: "changed", current: snapshot({ ttl: 120 }) },
    }),
    row({ entryId: "clean-2" }),
    row({ entryId: "gone", drift: { state: "absent" } }),
  ]);

  assert.deepEqual([...initialUndoSelection(plan)].sort(), [
    "clean-1",
    "clean-2",
  ]);
});

test("a drifted row is not pre-checked even if the plan says it should be", () => {
  // The plan's own answer is honoured in one direction only: it can leave a
  // row unchecked, never check one whose record moved since. An older desktop
  // build or a backend bug must not get a silent overwrite of somebody's
  // later edit out of this dialog.
  const drifted = row({
    entryId: "drifted",
    drift: { state: "changed", current: snapshot({ ttl: 120 }) },
    selectedByDefault: true,
  });

  assert.equal(isUndoRowPreselected(drifted), false);
  assert.deepEqual([...initialUndoSelection(preview([drifted]))], []);
});

test("a clean row the plan left unchecked stays unchecked", () => {
  const clean = row({ entryId: "clean", selectedByDefault: false });

  assert.equal(isUndoRowPreselected(clean), false);
  assert.equal(undoRowNeedsConfirmation(clean), true);
});

test("needing confirmation reads the plan's flag, not the drift state", () => {
  assert.equal(
    undoRowNeedsConfirmation(row({ selectedByDefault: true })),
    false,
  );
  assert.equal(
    undoRowNeedsConfirmation(row({ selectedByDefault: false })),
    true,
  );
});

test("toggling a row returns a new set and leaves the old one alone", () => {
  const first: ReadonlySet<string> = new Set(["a"]);
  const withB = toggleUndoSelection(first, "b");
  assert.deepEqual([...first], ["a"]);
  assert.deepEqual([...withB].sort(), ["a", "b"]);

  const withoutA = toggleUndoSelection(withB, "a");
  assert.deepEqual([...withoutA], ["b"]);
});

test("the ids an apply receives follow the plan's order", () => {
  const plan = preview([
    row({ entryId: "third" }),
    row({ entryId: "first" }),
    row({ entryId: "second" }),
  ]);

  assert.deepEqual(
    selectedUndoEntryIds(plan, new Set(["second", "first", "third"])),
    ["third", "first", "second"],
  );
});

test("a selection left over from another plan cannot reach the apply", () => {
  const plan = preview([row({ entryId: "mine" })]);

  assert.deepEqual(
    selectedUndoEntryIds(plan, new Set(["mine", "from-a-previous-preview"])),
    ["mine"],
  );
  assert.deepEqual(
    selectedUndoRows(plan, new Set(["mine", "from-a-previous-preview"])).map(
      (confirmed) => confirmed.entryId,
    ),
    ["mine"],
  );
  assert.equal(undoApplyCount(plan, new Set(["mine", "stale"])), 1);
});

test("the applier is handed whole rows, snapshot included", () => {
  // The existing `DNSOp` engine builds the reverse operation from the retained
  // snapshot, so an entry id alone would send it back to the plan to look the
  // row up again.
  const target = snapshot({ ttl: 3600 });
  const plan = preview([
    row({ entryId: "a", target }),
    row({ entryId: "b" }),
    row({
      entryId: "c",
      drift: { state: "changed", current: snapshot({ ttl: 120 }) },
    }),
  ]);

  const confirmed = selectedUndoRows(plan, new Set(["a", "c"]));

  assert.deepEqual(
    confirmed.map((confirmedRow) => confirmedRow.entryId),
    ["a", "c"],
  );
  assert.equal(confirmed[0]?.target, target);
  assert.equal(confirmed[1]?.drift.state, "changed");
});

test("the rows and the ids never disagree about what is selected", () => {
  const plan = preview([
    row({ entryId: "a" }),
    row({ entryId: "skip", target: null, drift: { state: "absent" } }),
    row({ entryId: "b" }),
  ]);
  const selected = new Set(["a", "skip", "b"]);

  assert.deepEqual(
    selectedUndoRows(plan, selected).map((confirmed) => confirmed.entryId),
    selectedUndoEntryIds(plan, selected),
  );
  assert.equal(
    undoApplyCount(plan, selected),
    selectedUndoRows(plan, selected).length,
  );
});

test("the apply count is the length of the list the apply is given", () => {
  const plan = preview([
    row({ entryId: "a" }),
    row({ entryId: "b" }),
    row({
      entryId: "c",
      drift: { state: "changed", current: snapshot({ ttl: 120 }) },
    }),
  ]);
  const selected = initialUndoSelection(plan);

  assert.equal(undoApplyCount(plan, selected), 2);
  assert.equal(
    undoApplyCount(plan, toggleUndoSelection(selected, "c")),
    selectedUndoEntryIds(plan, toggleUndoSelection(selected, "c")).length,
  );
  assert.equal(undoApplyCount(plan, toggleUndoSelection(selected, "c")), 3);
  assert.equal(undoApplyCount(plan, new Set()), 0);
});

test("a row's intent says what the write would be", () => {
  assert.equal(undoRowIntent(row()), "restore");
  assert.equal(undoRowIntent(row({ drift: { state: "absent" } })), "recreate");
  assert.equal(undoRowIntent(row({ target: null })), "delete");
  assert.equal(
    undoRowIntent(row({ target: null, drift: { state: "absent" } })),
    "noop",
  );
  assert.equal(
    undoRowIntent(
      row({
        target: null,
        drift: { state: "conflict", conflictingRecordId: "rec-9" },
      }),
    ),
    "delete",
  );
});

test("a row with nothing to write cannot be included in the count", () => {
  const nothingToDo = row({
    entryId: "already-gone",
    target: null,
    drift: { state: "absent" },
  });
  const plan = preview([nothingToDo, row({ entryId: "real" })]);

  assert.equal(isUndoRowSelectable(nothingToDo), false);
  // Even checked, it must not inflate a button that promises writes.
  assert.deepEqual(
    selectedUndoEntryIds(plan, new Set(["already-gone", "real"])),
    ["real"],
  );
  assert.equal(undoApplyCount(plan, new Set(["already-gone"])), 0);
});

test("every other row is selectable", () => {
  assert.equal(isUndoRowSelectable(row()), true);
  assert.equal(isUndoRowSelectable(row({ drift: { state: "absent" } })), true);
  assert.equal(isUndoRowSelectable(row({ target: null })), true);
  assert.equal(
    isUndoRowSelectable(
      row({ drift: { state: "conflict", conflictingRecordId: "rec-9" } }),
    ),
    true,
  );
});

test("a long plan collapses unchanged rows and never a drifted one", () => {
  const rows = [
    ...Array.from({ length: 20 }, (_unused, index) =>
      row({ entryId: `clean-${index}` }),
    ),
    row({
      entryId: "drifted",
      drift: { state: "changed", current: snapshot({ ttl: 120 }) },
    }),
  ];

  const display = undoRowDisplay(rows);

  assert.equal(display.visible.length, UNDO_PREVIEW_CLEAN_ROW_LIMIT + 1);
  assert.equal(display.collapsedCleanCount, 20 - UNDO_PREVIEW_CLEAN_ROW_LIMIT);
  // The row that needs a decision is shown wherever it falls, not promoted.
  assert.equal(display.visible[display.visible.length - 1]?.entryId, "drifted");
});

test("collapsing keeps the plan's order and reports what it hid", () => {
  const rows = [
    row({ entryId: "a" }),
    row({
      entryId: "b",
      drift: { state: "conflict", conflictingRecordId: "rec-9" },
    }),
    row({ entryId: "c" }),
    row({ entryId: "d" }),
  ];

  const display = undoRowDisplay(rows, 2);

  assert.deepEqual(
    display.visible.map((visible) => visible.entryId),
    ["a", "b", "c"],
  );
  assert.equal(display.collapsedCleanCount, 1);
});

test("an unbounded limit shows everything and a zero limit shows only drift", () => {
  const rows = [
    row({ entryId: "a" }),
    row({ entryId: "b", drift: { state: "absent" } }),
    row({ entryId: "c" }),
  ];

  const all = undoRowDisplay(rows, Number.POSITIVE_INFINITY);
  assert.equal(all.visible.length, 3);
  assert.equal(all.collapsedCleanCount, 0);

  const none = undoRowDisplay(rows, 0);
  assert.deepEqual(
    none.visible.map((visible) => visible.entryId),
    ["b"],
  );
  assert.equal(none.collapsedCleanCount, 2);
});

test("a row the apply could not write is never left collapsed", () => {
  // Otherwise a user told "1 of 37 could not be written" is told which record
  // only if it happens to fall inside the first six rows.
  const rows = Array.from({ length: 20 }, (_unused, index) =>
    row({ entryId: `clean-${index}`, recordName: `r${index}.example.test` }),
  );

  const display = undoRowDisplay(rows, 6, new Set(["clean-19"]));

  assert.equal(
    display.visible.some((visible) => visible.entryId === "clean-19"),
    true,
  );
  // Pinning adds a row rather than spending one of the six.
  assert.equal(display.visible.length, 7);
  assert.equal(display.collapsedCleanCount, 13);
  // And it stays where the operation put it.
  assert.equal(
    display.visible[display.visible.length - 1]?.entryId,
    "clean-19",
  );
});

test("pinning a row that was visible anyway changes nothing", () => {
  const rows = [row({ entryId: "a" }), row({ entryId: "b" })];

  const display = undoRowDisplay(rows, 6, new Set(["a"]));

  assert.deepEqual(
    display.visible.map((visible) => visible.entryId),
    ["a", "b"],
  );
  assert.equal(display.collapsedCleanCount, 0);
});

test("a failure with no row in the plan is still reported", () => {
  const plan = preview([row({ entryId: "a" }), row({ entryId: "b" })]);
  const outcome = result({
    applied: 1,
    failed: [
      { entryId: "b", recordName: "b.example.test", message: "forbidden" },
      { entryId: "ghost", recordName: "ghost.example.test", message: "gone" },
    ],
  });

  assert.deepEqual(unlistedUndoFailures(plan, outcome), [
    { entryId: "ghost", recordName: "ghost.example.test", message: "gone" },
  ]);
});

test("a well-behaved result has no unlisted failures", () => {
  const plan = preview([row({ entryId: "a" })]);

  assert.deepEqual(
    unlistedUndoFailures(
      plan,
      result({
        failed: [
          { entryId: "a", recordName: "a.example.test", message: "forbidden" },
        ],
      }),
    ),
    [],
  );
  assert.deepEqual(unlistedUndoFailures(plan, result({ applied: 1 })), []);
});

test("a nonsense limit discloses rather than hides", () => {
  const rows = [row({ entryId: "a" }), row({ entryId: "b" })];

  const display = undoRowDisplay(rows, Number.NaN);

  assert.equal(display.visible.length, 2);
  assert.equal(display.collapsedCleanCount, 0);
});

test("a batch with some failures is partial, not failed", () => {
  assert.equal(
    classifyUndoResult(
      result({
        applied: 36,
        failed: [
          { entryId: "e", recordName: "mx.example.test", message: "429" },
        ],
      }),
    ),
    "partial",
  );
  assert.equal(classifyUndoResult(result({ applied: 37 })), "applied");
  assert.equal(
    classifyUndoResult(
      result({
        applied: 0,
        failed: [
          { entryId: "e", recordName: "mx.example.test", message: "429" },
        ],
      }),
    ),
    "failed",
  );
  assert.equal(
    classifyUndoResult(result({ applied: 0, skipped: 3 })),
    "nothing",
  );
});

test("each failure is addressable by the row it belongs to", () => {
  const failures = undoFailuresByEntryId(
    result({
      applied: 1,
      failed: [
        {
          entryId: "mx",
          recordName: "mx.example.test",
          message: "rate limited",
        },
        {
          entryId: "cdn",
          recordName: "cdn.example.test",
          message: "forbidden",
        },
      ],
    }),
  );

  assert.equal(failures.get("mx"), "rate limited");
  assert.equal(failures.get("cdn"), "forbidden");
  assert.equal(failures.has("api"), false);
  assert.equal(failures.size, 2);
});

test("the header counts the rows undo cannot reach as well as the ones it can", () => {
  const plan = preview(
    [row({ entryId: "a" }), row({ entryId: "b" })],
    [
      {
        entryId: "old",
        recordName: "legacy.example.test",
        undo: { state: "no-snapshot" },
      },
    ],
  );

  assert.equal(undoRecordCount(plan), 3);
});

test("snapshots differ only where they really differ", () => {
  const before = snapshot({ ttl: 3600, tags: ["one", "two"] });

  assert.deepEqual(
    diffSnapshots(before, snapshot({ ttl: 3600, tags: ["one", "two"] })),
    [],
  );
  // Cloudflare may hand the same tags back in another order.
  assert.deepEqual(
    diffSnapshots(before, snapshot({ ttl: 3600, tags: ["two", "one"] })),
    [],
  );
  assert.deepEqual(
    diffSnapshots(before, snapshot({ ttl: 3600, tags: ["one"] })),
    [{ field: "tags", from: ["one", "two"], to: ["one"] }],
  );
  assert.deepEqual(
    diffSnapshots(before, snapshot({ ttl: 120, tags: ["one", "two"] })),
    [{ field: "ttl", from: 3600, to: 120 }],
  );
  assert.deepEqual(
    diffSnapshots(
      before,
      snapshot({ ttl: 3600, tags: ["one", "two"], comment: "set" }),
    ),
    [{ field: "comment", from: null, to: "set" }],
  );
});

test("there is nothing to diff against a record that is not there", () => {
  assert.deepEqual(diffSnapshots(null, snapshot()), []);
  assert.deepEqual(diffSnapshots(snapshot(), null), []);
  assert.deepEqual(diffSnapshots(null, null), []);
});

test("a restore summary leaves out the identity and the fields that are unset", () => {
  const fields = undoTargetFields(
    snapshot({ ttl: 3600, priority: null, comment: "", tags: [] }),
  );

  assert.deepEqual(fields, [
    { field: "content", value: "203.0.113.10" },
    { field: "ttl", value: 3600 },
    { field: "proxied", value: false },
  ]);
});

test("a restore summary never promises the tags an undo cannot write", () => {
  // `DNSRecord` has no tags field and `snapshotToDnsRecord` does not map one:
  // this app keeps record tags locally and the apply writes DNS state only.
  // Listing them as "puts back" would be a promise the apply cannot keep,
  // which is the one inaccuracy a confirm dialog must not contain.
  const fields = undoTargetFields(snapshot({ tags: ["prod", "owner:web"] }));

  assert.equal(
    fields.some((entry) => entry.field === "tags"),
    false,
  );
  assert.deepEqual(
    fields.map((entry) => entry.field),
    ["content", "ttl", "proxied"],
  );
});

test("tags still count as state, just not as something a restore writes", () => {
  // `diffSnapshots` describes what a record holds, so it keeps comparing them.
  assert.deepEqual(
    diffSnapshots(snapshot({ tags: ["a"] }), snapshot({ tags: ["b"] })),
    [{ field: "tags", from: ["a"], to: ["b"] }],
  );
});

test("dropping tags is reported only when the selected rows have any", () => {
  assert.equal(
    undoWouldDropTags([row({ target: snapshot({ tags: ["prod"] }) })]),
    true,
  );
  assert.equal(
    undoWouldDropTags([row({ target: snapshot({ tags: [] }) })]),
    false,
  );
  assert.equal(undoWouldDropTags([]), false);
  // A delete-undo writes no record at all, so it drops nothing.
  assert.equal(undoWouldDropTags([row({ target: null })]), false);
  // One tagged row among many is enough.
  assert.equal(
    undoWouldDropTags([
      row({ entryId: "a" }),
      row({ entryId: "b", target: snapshot({ tags: ["prod"] }) }),
    ]),
    true,
  );
});

test("a set field is kept even when its value is falsy", () => {
  const fields = undoTargetFields(
    snapshot({ proxied: false, priority: 0, ttl: 0 }),
  );

  assert.deepEqual(
    fields.map((entry) => entry.field),
    ["content", "ttl", "priority", "proxied"],
  );
});

test("only a changed row can say what the record holds now", () => {
  const changed = row({
    drift: { state: "changed", current: snapshot({ ttl: 120 }) },
  });

  assert.deepEqual(undoDriftFields(changed), [
    { field: "ttl", restore: 3600, current: 120 },
  ]);
  assert.deepEqual(undoDriftFields(row()), []);
  assert.deepEqual(undoDriftFields(row({ drift: { state: "absent" } })), []);
  // A conflict names a record this undo did not create. Describing its
  // contents as a later version of the same record would be a lie, and the
  // plan does not carry them anyway.
  assert.deepEqual(
    undoDriftFields(
      row({ drift: { state: "conflict", conflictingRecordId: "rec-9" } }),
    ),
    [],
  );
});

test("a delete-undo has no drift fields to show", () => {
  assert.deepEqual(
    undoDriftFields(
      row({
        target: null,
        drift: { state: "changed", current: snapshot({ ttl: 120 }) },
      }),
    ),
    [],
  );
});
