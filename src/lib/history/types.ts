/**
 * The zone history subtab and the undo it offers.
 *
 * # Two stores, on purpose
 *
 * This feature reads from two places and it is important not to confuse them,
 * because only one of them can be trusted to put a record back.
 *
 * **The audit trail** (`bc_storage::audit`, written by
 * `src-tauri/src/commands/trail.rs`) is what the history *list* shows. It is a
 * log: every value in it goes through `shortened()`, each entry has a byte
 * budget, and when the budget runs out the entry carries `changes_omitted`
 * instead of the rest of the change set. That is correct for a log and fatal
 * for a restore — a truncated `from` value would put back a record that is
 * subtly not the one that was there.
 *
 * **The retention store** (`bc_storage::retention`) is what undo actually
 * applies. It holds exact {@link RetainedRecordSnapshot}s with bounds generous
 * enough to be faithful, keyed by zone and origin record id, with an expiry
 * and an eviction order. It already existed for deletions — a record removed
 * from Cloudflare and kept so it can be put back. Undo for an *edit* is the
 * same idea with a different reason, so this feature extends that store rather
 * than adding a second one beside it.
 *
 * The consequence, which the UI has to state plainly: **history goes back
 * further than undo does.** An operation whose snapshots have expired or been
 * evicted still appears in the list, with {@link UndoAvailability} explaining
 * why it can no longer be undone. Offering a greyed-out button with no reason
 * is how a user concludes the feature is broken.
 *
 * # Grouping
 *
 * A bulk edit is one user action and must undo as one. Every write command
 * stamps the entries it produces with a shared {@link OperationId}, which is
 * what lets the list nest rows under an operation and offer "undo all". A
 * single-record edit is an operation of one, so there is no second code path.
 *
 * # Drift
 *
 * Undo is not applied blind. Between the change and the undo, the record may
 * have moved again — in this app, in another window, or in the Cloudflare
 * dashboard. So a preview compares each row's recorded *after* state against
 * what Cloudflare holds now and classifies it ({@link UndoRowDrift}). A row
 * that drifted is skipped by default and can be overwritten deliberately,
 * because silently reverting someone else's later edit is worse than doing
 * nothing.
 */

/** Groups every entry produced by one user action. A UUID v4. */
export type OperationId = string;

/** Why a record snapshot is in the retention store. */
export type RetentionReason =
  /** The user parked the record: deleted upstream, kept here to re-create. */
  | "disabled"
  /** The user deleted the record outright. */
  | "deleted"
  /** The record was edited; this is the state it held before. */
  | "superseded";

/** What a write did to one record. */
export type HistoryChangeKind = "created" | "updated" | "deleted";

/**
 * One record's state, exactly as it was. The field set is `RecordFacts` plus
 * the identity fields a re-create needs.
 */
export type RetainedRecordSnapshot = {
  readonly recordType: string;
  readonly name: string;
  readonly content: string;
  readonly ttl: number | null;
  readonly priority: number | null;
  readonly proxied: boolean | null;
  readonly comment: string | null;
  readonly tags: readonly string[];
};

/** Per-field `from`/`to`, as the trail recorded it. Display only. */
export type HistoryFieldChange = {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
};

/** Why an entry cannot be undone, or that it can. */
export type UndoAvailability =
  | { readonly state: "available" }
  /** The snapshot aged out of the retention store. */
  | { readonly state: "expired"; readonly expiredAt: string }
  /** The snapshot was evicted to stay inside the store's bounds. */
  | { readonly state: "evicted" }
  /** Recorded before this feature existed, so no snapshot was ever taken. */
  | { readonly state: "no-snapshot" }
  /** Undoing this would recreate a record the user has since deleted again. */
  | { readonly state: "superseded-by-delete" }
  /** Not a record write — a zone setting, a cache purge, a DNSSEC change. */
  | { readonly state: "not-undoable"; readonly reason: string };

/** One row in the history list: a single record, within an operation. */
export type ZoneHistoryEntry = {
  readonly id: string;
  readonly operationId: OperationId;
  readonly kind: HistoryChangeKind;
  readonly recordType: string;
  readonly recordName: string;
  /** Absent once a record is deleted: Cloudflare destroys the id. */
  readonly recordId: string | null;
  readonly changes: readonly HistoryFieldChange[];
  /** True when the trail dropped part of the change set to stay in budget. */
  readonly changesOmitted: boolean;
  readonly undo: UndoAvailability;
};

/** One user action, with the records it touched. */
export type ZoneHistoryOperation = {
  readonly operationId: OperationId;
  readonly zoneId: string;
  /** The command, as the trail names it: `update_dns_record` and friends. */
  readonly operation: string;
  readonly actor: "user" | "assistant" | "mcp";
  readonly outcome: "ok" | "partial" | "failed";
  readonly at: string;
  readonly entries: readonly ZoneHistoryEntry[];
  /** Entries this operation produced that the trail has since dropped. */
  readonly truncated: boolean;
};

/** How one row of an undo would land. */
export type UndoRowDrift =
  /** Cloudflare still holds what the change wrote; the revert is clean. */
  | { readonly state: "unchanged" }
  /** It moved again since. Skipped unless the user overwrites. */
  | { readonly state: "changed"; readonly current: RetainedRecordSnapshot }
  /** Gone from Cloudflare. An update-undo becomes a re-create. */
  | { readonly state: "absent" }
  /** The name and type now belong to a record this undo did not create. */
  | { readonly state: "conflict"; readonly conflictingRecordId: string };

/** One record the undo would write, and what writing it would mean. */
export type UndoPlanRow = {
  readonly entryId: string;
  readonly recordType: string;
  readonly recordName: string;
  /** `null` when the undo deletes the record (reverting a create). */
  readonly target: RetainedRecordSnapshot | null;
  readonly drift: UndoRowDrift;
  /** Pre-checked for the user: false when `drift` is not `unchanged`. */
  readonly selectedByDefault: boolean;
};

/** What `undo_preview` returns. Nothing is written to produce this. */
export type UndoPreview = {
  readonly operationId: OperationId;
  readonly zoneId: string;
  readonly rows: readonly UndoPlanRow[];
  /** Rows in the operation that cannot be undone at all, with the reason. */
  readonly unavailable: readonly {
    readonly entryId: string;
    readonly recordName: string;
    readonly undo: UndoAvailability;
  }[];
};

/** What `undo_apply` returns. An undo is itself a logged operation. */
export type UndoResult = {
  /** The new operation id, so the undo appears in history and is re-undoable. */
  readonly operationId: OperationId;
  readonly applied: number;
  readonly skipped: number;
  readonly failed: readonly {
    readonly entryId: string;
    readonly recordName: string;
    readonly message: string;
  }[];
};

/**
 * The three Tauri commands this feature adds. Named here so the renderer and
 * the backend cannot drift on the strings — an unregistered command fails only
 * when a user reaches it.
 */
export const HISTORY_COMMANDS = {
  /** Page the trail for one zone, grouped into operations, newest first. */
  list: "list_zone_history",
  /** Plan an undo and classify drift. Reads Cloudflare; writes nothing. */
  preview: "preview_undo_operation",
  /** Apply a planned undo. Takes the entry ids the user confirmed. */
  apply: "apply_undo_operation",
} as const satisfies Record<string, string>;

/**
 * Page size for the history list. The trail can hold a lot; a zone subtab that
 * fetches all of it blocks the first paint for no benefit.
 */
export const ZONE_HISTORY_PAGE_SIZE = 50;
