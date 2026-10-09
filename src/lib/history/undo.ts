/**
 * Every decision the undo preview makes, as functions over the contract types.
 *
 * `src/lib/history/types.ts` explains why undo is previewed rather than
 * applied blind: between the change and the undo a record may have moved
 * again, here or in the Cloudflare dashboard, and silently reverting someone
 * else's later edit is worse than doing nothing. The rules that follow from
 * that — which rows open checked, which need a deliberate opt-in, how many
 * records the apply button is about to write, and how a partial result reads —
 * live here rather than in the dialog's JSX, because a rule that only exists
 * inside a component can only be tested through the DOM.
 *
 * Nothing in this module knows about React or about words: a caller turns the
 * returned classifications into user-visible strings through `t()`. That is
 * also why the field helpers return raw snapshot values rather than formatted
 * text — a `null` TTL or a `false` proxied flag reads differently in twelve
 * locales, and that is the component's problem, not this module's.
 */
import type {
  RetainedRecordSnapshot,
  UndoPlanRow,
  UndoPreview,
  UndoResult,
} from "@/lib/history/types";

/**
 * How many records the operation touched, undoable or not.
 *
 * Both halves on purpose. History reaches further back than undo does, so an
 * operation of 37 records may plan 30 rows and list 7 as unavailable; a header
 * that counted only the plan would quietly disagree with the history list the
 * user opened this from.
 */
export function undoRecordCount(preview: UndoPreview): number {
  return preview.rows.length + preview.unavailable.length;
}

/** What applying one row would actually do upstream. */
export type UndoRowIntent =
  /** Write the retained snapshot over the record that is there. */
  | "restore"
  /** The record is gone from Cloudflare, so the undo re-creates it. */
  | "recreate"
  /** Reverting a create: the record this operation added is deleted. */
  | "delete"
  /** A create whose record is already gone. Applying it would write nothing. */
  | "noop";

/**
 * Classify one row by what the write would be.
 *
 * `target === null` is the contract's marker for "the undo deletes this
 * record", and `drift.state === "absent"` means Cloudflare no longer holds it.
 * Together they are a create that someone has already deleted, which is the
 * one row in a plan with nothing to do.
 */
export function undoRowIntent(row: UndoPlanRow): UndoRowIntent {
  if (row.target === null) {
    return row.drift.state === "absent" ? "noop" : "delete";
  }
  return row.drift.state === "absent" ? "recreate" : "restore";
}

/**
 * Whether the user can include this row at all.
 *
 * Only a `noop` row is excluded, and not as a safety rail: including it would
 * make the apply button promise a write that cannot happen, and an apply that
 * reported "1 applied" for a record it never touched would be a lie about the
 * zone.
 */
export function isUndoRowSelectable(row: UndoPlanRow): boolean {
  return undoRowIntent(row) !== "noop";
}

/**
 * Whether including this row needs a deliberate per-row decision.
 *
 * Read from `selectedByDefault`, which is the plan's own answer, rather than
 * re-derived from the drift state — the backend classified the drift against
 * live records and this module has not seen them.
 */
export function undoRowNeedsConfirmation(row: UndoPlanRow): boolean {
  return !row.selectedByDefault;
}

/**
 * Whether the dialog opens with this row checked.
 *
 * `selectedByDefault` decides, but it is ANDed with the drift state rather
 * than trusted alone. The asymmetry is deliberate and runs one way: the plan
 * can only ever leave a row unchecked, never check one whose record moved
 * since. A `selectedByDefault: true` on a drifted row — a backend bug, an
 * older desktop build, a hand-rolled fixture — would otherwise pre-select an
 * overwrite of somebody else's later edit, which is the single outcome this
 * whole dialog exists to prevent. Costing a user one extra click in that case
 * is the cheap side of the trade.
 */
export function isUndoRowPreselected(row: UndoPlanRow): boolean {
  return (
    row.selectedByDefault &&
    row.drift.state === "unchanged" &&
    isUndoRowSelectable(row)
  );
}

/** The rows a freshly opened dialog has checked, by entry id. */
export function initialUndoSelection(
  preview: UndoPreview,
): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const row of preview.rows) {
    if (isUndoRowPreselected(row)) selected.add(row.entryId);
  }
  return selected;
}

/** The same selection with one row flipped. */
export function toggleUndoSelection(
  selected: ReadonlySet<string>,
  entryId: string,
): ReadonlySet<string> {
  const next = new Set(selected);
  if (!next.delete(entryId)) next.add(entryId);
  return next;
}

/**
 * Exactly the rows an apply should be handed, in the plan's own order.
 *
 * This is the one filter the apply path goes through, and it is deliberately
 * the whole row rather than an id: the undo is applied by the existing
 * `DNSOp` engine, which needs the retained snapshot to build the reverse
 * operation, and an id would send the caller back to the plan to look it up.
 *
 * Filtered against the preview rather than read off the selection set, so a
 * selection left over from a previous preview — a reopen, a re-fetch after
 * somebody else's edit — cannot smuggle in a row this plan does not contain.
 */
export function selectedUndoRows(
  preview: UndoPreview,
  selected: ReadonlySet<string>,
): readonly UndoPlanRow[] {
  return preview.rows.filter(
    (row) => isUndoRowSelectable(row) && selected.has(row.entryId),
  );
}

/**
 * The same rows as their entry ids.
 *
 * Derived from {@link selectedUndoRows} rather than filtering again, so the
 * ids and the rows cannot come to disagree about what is selected.
 */
export function selectedUndoEntryIds(
  preview: UndoPreview,
  selected: ReadonlySet<string>,
): readonly string[] {
  return selectedUndoRows(preview, selected).map((row) => row.entryId);
}

/**
 * How many records the apply button is about to write.
 *
 * The same list the apply is given, counted — not the size of the selection
 * set — so the number on the button cannot drift from the number of writes.
 */
export function undoApplyCount(
  preview: UndoPreview,
  selected: ReadonlySet<string>,
): number {
  return selectedUndoRows(preview, selected).length;
}

/**
 * How many unchanged rows a collapsed list shows before counting the rest.
 *
 * Six rather than the two in the approved sketch: a bulk edit of a handful of
 * records is the common case, and collapsing three of five clean rows behind a
 * "2 more" line hides a list the user could simply have read. Six keeps every
 * small operation whole and still stops a 500-record undo from filling the
 * dialog with rows that say nothing happened to them.
 */
export const UNDO_PREVIEW_CLEAN_ROW_LIMIT = 6;

export type UndoRowDisplay = {
  /** The rows to render, in the plan's order. */
  readonly visible: readonly UndoPlanRow[];
  /** Unchanged rows left out, to be reported as a count. */
  readonly collapsedCleanCount: number;
};

const NO_PINNED_ROWS: ReadonlySet<string> = new Set<string>();

/**
 * Which rows to render, and how many unchanged ones were left out.
 *
 * Only `unchanged` rows are ever collapsed. A row that drifted is the reason
 * the dialog exists, so it is shown wherever it falls in the operation — never
 * behind a "more" line, and never reordered to the top, because the list reads
 * as the operation the user recognises.
 *
 * `cleanLimit` is a parameter so the component's "show all" control is the
 * same function with a different bound. A non-finite bound shows everything,
 * which fails toward disclosure rather than concealment.
 *
 * `pinned` is the second thing that outranks the limit, and it exists for one
 * case: a row the apply could not write. Those are reported per row, and a
 * clean row that failed would otherwise be collapsed along with the clean rows
 * that succeeded — so a user told "1 of 37 failed" would be told which record
 * only if it happened to fall inside the first six. That is the defect this
 * whole dialog is meant to avoid one level down: a number with no way to act
 * on it.
 */
export function undoRowDisplay(
  rows: readonly UndoPlanRow[],
  cleanLimit: number = UNDO_PREVIEW_CLEAN_ROW_LIMIT,
  pinned: ReadonlySet<string> = NO_PINNED_ROWS,
): UndoRowDisplay {
  const limit = Number.isFinite(cleanLimit)
    ? Math.max(0, Math.floor(cleanLimit))
    : Number.POSITIVE_INFINITY;
  const visible: UndoPlanRow[] = [];
  let shownClean = 0;
  let collapsedCleanCount = 0;
  for (const row of rows) {
    if (row.drift.state !== "unchanged" || pinned.has(row.entryId)) {
      visible.push(row);
      continue;
    }
    if (shownClean < limit) {
      shownClean += 1;
      visible.push(row);
      continue;
    }
    collapsedCleanCount += 1;
  }
  return { visible, collapsedCleanCount };
}

/** How an apply turned out, as one word. */
export type UndoOutcome =
  /** Every row the user confirmed was written. */
  | "applied"
  /** Some were written and some were not. The normal mixed case. */
  | "partial"
  /** Nothing was written and at least one row reported an error. */
  | "failed"
  /** Nothing was written and nothing failed. */
  | "nothing";

/**
 * Classify a result.
 *
 * `failed` being non-empty is not an error state: 36 of 37 records restored is
 * a success with a footnote, and reporting it as a failure would send a user
 * looking for 37 records to put back by hand. Hence `partial` as its own word,
 * distinct from `failed`.
 */
export function classifyUndoResult(result: UndoResult): UndoOutcome {
  if (result.failed.length === 0) {
    return result.applied > 0 ? "applied" : "nothing";
  }
  return result.applied > 0 ? "partial" : "failed";
}

/**
 * Each failure's message, keyed by entry id, so a row can report its own.
 *
 * A batch failure belongs on the rows that failed, not in one banner over a
 * list of rows that mostly succeeded.
 */
export function undoFailuresByEntryId(
  result: UndoResult,
): ReadonlyMap<string, string> {
  const failures = new Map<string, string>();
  for (const failure of result.failed) {
    failures.set(failure.entryId, failure.message);
  }
  return failures;
}

/** One entry of {@link UndoResult.failed}. */
export type UndoFailure = UndoResult["failed"][number];

/**
 * Failures the plan has no row to hang on.
 *
 * Normally empty: an applier reports failures for the rows it was handed. But
 * a failure reported against an entry id this plan does not contain has
 * nowhere to be rendered per row, and dropping it would leave a record in its
 * post-change state with nothing on screen saying so — the exact defect that
 * reporting failures per row exists to fix. `UndoResult.failed` carries its
 * own `recordName`, so these can still be named without the plan's help.
 */
export function unlistedUndoFailures(
  preview: UndoPreview,
  result: UndoResult,
): readonly UndoFailure[] {
  const planned = new Set(preview.rows.map((row) => row.entryId));
  return result.failed.filter((failure) => !planned.has(failure.entryId));
}

export type SnapshotFieldId = keyof RetainedRecordSnapshot;
export type SnapshotFieldValue = RetainedRecordSnapshot[SnapshotFieldId];

/** Snapshot fields in the order a reader scans them. */
export const SNAPSHOT_FIELD_ORDER: readonly SnapshotFieldId[] = [
  "recordType",
  "name",
  "content",
  "ttl",
  "priority",
  "proxied",
  "comment",
  "tags",
];

/**
 * Fields the row header already shows, so the per-row detail does not repeat
 * them.
 */
const SNAPSHOT_IDENTITY_FIELDS: readonly SnapshotFieldId[] = [
  "recordType",
  "name",
];

/**
 * Fields an undo cannot put back, and must therefore not claim it will.
 *
 * `tags` is the whole list. A retained snapshot holds them, but `DNSRecord`
 * has no tags field and `snapshotToDnsRecord` does not map one: this app keeps
 * record tags locally, keyed by Cloudflare record id, and the `DNSOp` engine
 * writes DNS state only. Listing them among what a restore puts back would be
 * a promise the apply cannot keep — the one kind of inaccuracy a confirm
 * dialog must never contain, because the user's decision is made on it.
 *
 * They stay in {@link SNAPSHOT_FIELD_ORDER} and in {@link diffSnapshots},
 * which describe what a record *holds* rather than what an undo *will write*.
 */
const SNAPSHOT_UNRESTORABLE_FIELDS: readonly SnapshotFieldId[] = ["tags"];

export type SnapshotFieldChange = {
  readonly field: SnapshotFieldId;
  readonly from: SnapshotFieldValue;
  readonly to: SnapshotFieldValue;
};

export type SnapshotFieldEntry = {
  readonly field: SnapshotFieldId;
  readonly value: SnapshotFieldValue;
};

function isStringList(value: SnapshotFieldValue): value is readonly string[] {
  return Array.isArray(value);
}

/**
 * Whether two snapshot values are the same for display purposes.
 *
 * Tags compare as unordered, because Cloudflare is free to hand back the same
 * tags in a different order and a row reading "tags changed" when they did not
 * would send the user chasing an edit nobody made. The backend has already
 * decided whether this row drifted; this comparison only decides what to show.
 */
function sameSnapshotValue(
  left: SnapshotFieldValue,
  right: SnapshotFieldValue,
): boolean {
  if (isStringList(left) && isStringList(right)) {
    if (left.length !== right.length) return false;
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
  }
  return left === right;
}

/** The fields in which two snapshots disagree, in {@link SNAPSHOT_FIELD_ORDER}. */
export function diffSnapshots(
  from: RetainedRecordSnapshot | null,
  to: RetainedRecordSnapshot | null,
): readonly SnapshotFieldChange[] {
  if (from === null || to === null) return [];
  return SNAPSHOT_FIELD_ORDER.map((field) => ({
    field,
    from: from[field],
    to: to[field],
  })).filter((change) => !sameSnapshotValue(change.from, change.to));
}

/**
 * What a restore would put back, as the fields worth reading.
 *
 * Identity fields are dropped because the row names the record already, unset
 * fields are dropped because "priority: none" on an A record is noise, and
 * {@link SNAPSHOT_UNRESTORABLE_FIELDS} are dropped because the apply cannot
 * write them. A row can therefore show a short line that is entirely true:
 * this is what the undo writes. It deliberately does not claim to show *what
 * changed* — for an unchanged row the plan carries only the state to restore,
 * not the state the original write left behind, and inventing the other side
 * of that arrow from the audit trail would mean displaying a value the trail
 * may have truncated.
 */
export function undoTargetFields(
  target: RetainedRecordSnapshot,
): readonly SnapshotFieldEntry[] {
  return SNAPSHOT_FIELD_ORDER.filter(
    (field) =>
      !SNAPSHOT_IDENTITY_FIELDS.includes(field) &&
      !SNAPSHOT_UNRESTORABLE_FIELDS.includes(field),
  )
    .map((field) => ({ field, value: target[field] }))
    .filter((entry) => {
      if (entry.value === null) return false;
      if (isStringList(entry.value)) return entry.value.length > 0;
      if (typeof entry.value === "string") return entry.value.length > 0;
      return true;
    });
}

/**
 * Whether applying these rows would leave tags behind.
 *
 * Said rather than silently omitted. A user who tagged a record and watches an
 * undo "put it back" will not go looking for the tags afterwards, so the
 * moment to say so is before they press Apply — and only when it is true of
 * what they have actually selected, which is why this takes rows rather than
 * the whole plan.
 */
export function undoWouldDropTags(rows: readonly UndoPlanRow[]): boolean {
  return rows.some((row) => (row.target?.tags.length ?? 0) > 0);
}

export type UndoDriftField = {
  readonly field: SnapshotFieldId;
  /** What the undo would write. */
  readonly restore: SnapshotFieldValue;
  /** What Cloudflare holds now. */
  readonly current: SnapshotFieldValue;
};

/**
 * Where the live record disagrees with what the undo would write.
 *
 * Empty for every drift state but `changed`, because that is the only one the
 * plan gives a current snapshot for: `absent` has no record to compare, and
 * `conflict` names a record by id that this undo did not create, whose
 * contents the plan does not carry and which must not be described as if it
 * were a later version of the same record.
 */
export function undoDriftFields(row: UndoPlanRow): readonly UndoDriftField[] {
  if (row.drift.state !== "changed" || row.target === null) return [];
  return diffSnapshots(row.target, row.drift.current).map((change) => ({
    field: change.field,
    restore: change.from,
    current: change.to,
  }));
}
