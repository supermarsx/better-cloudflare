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
  /**
   * App-local tags, which the retention store keeps and **an undo does not
   * put back**.
   *
   * They are here because the store carries them — `local_tags` in
   * `bc_storage::retention`, so the recycle bin's restore can return a record
   * with its tags intact. The undo path cannot: `DNSRecord` in
   * `src/types/dns.ts` has no `tags` field, and `snapshotToDnsRecord` maps
   * content, ttl, comment, priority and proxied only.
   *
   * So a row must never *claim* to restore a tag.
   * `SNAPSHOT_UNRESTORABLE_FIELDS` in `src/lib/history/undo.ts` excludes it
   * from what the dialog promises, and a plan touching a tagged record says
   * so explicitly instead. Listing it as restorable was a real defect — a row
   * read "Puts back Content … · Tags prod" and the apply silently dropped the
   * third, which is the one kind of inaccuracy a confirmation dialog cannot
   * contain, because the decision is made on it.
   */
  readonly tags: readonly string[];
};

/** Per-field `from`/`to`, as the trail recorded it. Display only. */
export type HistoryFieldChange = {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
};

/**
 * Why something cannot be undone, as a code rather than a sentence.
 *
 * Codes, because of where these are produced. `planUndoRows` is a pure
 * function outside the component and has no `t()`; the backend has no locale
 * at all. A sentence authored in either place is a sentence that ships in
 * English in twelve locales — and it cannot even be *caught*, because
 * `t(reason, reason)` passes a variable and `scripts/i18n-coverage.mjs` only
 * sees literals. That is the same blind spot that left six zone-subtab labels
 * untranslated behind a green coverage report.
 *
 * So the rule for this feature: **a reason this application decides is a
 * code, and the renderer turns it into a literal `t()` call.** The one
 * exception is {@link UndoResult.failed}, which carries an upstream error
 * message verbatim — a Cloudflare API error is not ours to author and
 * paraphrasing it into a code would lose the only detail that explains the
 * failure.
 */
export type UndoRefusalCode =
  /**
   * Cloudflare says the record exists; this zone's loaded list disagrees. The
   * list is stale, not the record gone, and refusing names a fix the user can
   * act on where guessing does not.
   */
  | "stale-record-list"
  /** A zone setting, not a record write. */
  | "zone-setting"
  /** A cache purge: nothing to put back. */
  | "cache-purge"
  /** A DNSSEC change. */
  | "dnssec"
  /**
   * A bulk create whose manifest could not hold every id it created, so some
   * of the records are unidentifiable and a partial delete would be worse
   * than none.
   */
  | "manifest-truncated"
  /**
   * A bulk operation the trail recorded as one summary entry carrying no
   * record ids at all, which is deliberate — see `trail.rs`.
   */
  | "summary-entry-only";

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
  /** Not something this feature can reverse. See {@link UndoRefusalCode}. */
  | { readonly state: "not-undoable"; readonly reason: UndoRefusalCode };

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
  /**
   * Rows the planner will not write, by code. Distinct from `unavailable`:
   * those have no undo material at all, while these have it and the current
   * state of the zone is what blocks the write.
   */
  readonly refused?: readonly {
    readonly entryId: string;
    readonly recordName: string;
    readonly reason: UndoRefusalCode;
  }[];
};

/**
 * What an undo reports back.
 *
 * Not the return of one backend command any more. This was specified when a
 * single `apply_undo_operation` performed the whole undo and could stamp one
 * trail id on it; the writes now go through the ordinary record commands,
 * which each stamp their own. An undo is still a logged operation — several of
 * them — and still re-undoable, because the renderer pushes the whole set onto
 * the existing `DNSOp` stack as one composite entry.
 */
export type UndoResult = {
  /**
   * Locally minted, and deliberately **not** a trail operation id: there is no
   * single one to report. Nothing reads this field; it is kept because a
   * result with no identity at all is awkward to log, and an id pretending to
   * be a trail id would be worse than one that says it is not.
   */
  readonly operationId: OperationId;
  readonly applied: number;
  readonly skipped: number;
  /**
   * Upstream failures, with the provider's own message. The one place prose
   * rather than a code is right: a Cloudflare error is not ours to author, and
   * the renderer shows it verbatim beside a translated frame.
   */
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
  /**
   * Reserved, and intentionally unimplemented. An undo applies through the
   * renderer's existing `DNSOp` engine rather than a command of its own,
   * because that engine is the only thing that knows how to re-point a record
   * id the write just destroyed and to route a binned deletion through
   * retention's restore. A second applier beside it would be a second set of
   * those bugs. Kept named so nobody adds it back without reading this.
   */
  apply: "apply_undo_operation",
} as const satisfies Record<string, string>;

/**
 * Page size for the history list. The trail can hold a lot; a zone subtab that
 * fetches all of it blocks the first paint for no benefit.
 */
export const ZONE_HISTORY_PAGE_SIZE = 50;
