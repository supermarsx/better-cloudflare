//! A zone's change history, and the undo it offers.
//!
//! The renderer's half of this is `src/lib/history/types.ts`, and that file is
//! the contract: every shape returned here is one of its types, spelled the way
//! it spells them. Read its header before this one — it explains why the list
//! and the undo come from two different stores, which is the single fact this
//! module exists to respect.
//!
//! # Two stores, and only one of them can put a record back
//!
//! The **audit trail** (`bc_storage::audit`, written through
//! [`crate::commands::trail`]) is what the list shows. It is a log: every value
//! in it has been through `trail::shortened`, each entry has a byte budget, and
//! an entry over budget carries `changes_omitted` instead of the rest of the
//! change set. Correct for a log. Fatal for a restore, because a truncated
//! `from` value puts back a record that is subtly not the one that was there.
//! **Nothing here ever builds an undo out of the trail's own values.**
//!
//! The **retention store** (`bc_storage::retention`) is what an undo applies.
//! It holds exact snapshots with bounds generous enough to be faithful, keyed
//! by zone and origin record id, with an expiry and an eviction order.
//!
//! The consequence the UI has to state plainly, and this module has to compute
//! honestly: **history goes back further than undo does.** An operation whose
//! snapshots have expired or been evicted is still listed, with an
//! [`UndoAvailability`] that says which of those happened. A greyed-out button
//! with no reason is how a user concludes the feature is broken.
//!
//! # How `expired`, `evicted` and `no-snapshot` are told apart
//!
//! All three look identical from the store alone — the entry is simply not
//! there. They are told apart by what the **trail entry** carries, which is why
//! [`trail::UNDO_EXPIRES_AT_KEY`] exists:
//!
//! | trail entry | store | verdict |
//! |---|---|---|
//! | no `operation_id` | — | `no-snapshot`: written before this feature |
//! | has `operation_id` | snapshot present, expiry future | `available` |
//! | has `operation_id` | snapshot present, expiry passed | `expired`, with the date |
//! | records an expiry that has passed | snapshot gone | `expired`, with the date |
//! | records an expiry still in the future | snapshot gone | `evicted` |
//!
//! The last two rows are the point. Without the expiry on the trail entry, a
//! missing snapshot could only be guessed at, and "your change expired" versus
//! "the store threw it away early" are different sentences — different enough
//! that one of them is really about the retention window being too short.
//!
//! # Drift
//!
//! An undo is never applied blind. Between the change and the undo the record
//! may have moved again — in this app, in another window, or in the Cloudflare
//! dashboard. So [`preview_undo_operation`] reads the zone as it is now and
//! classifies every row ([`UndoRowDrift`]); a row that drifted is not selected
//! by default, and can be overwritten only deliberately. Silently reverting
//! someone else's later edit is worse than doing nothing.
//!
//! Where the trail shortened a value, equality **cannot** be established, and
//! such a row is reported as `changed` rather than `unchanged`. That is the
//! conservative direction on purpose: a false `unchanged` is pre-selected and
//! overwrites a later edit, where a false `changed` only asks the user to look.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;

use bc_storage::retention::{self, RetainedRecord};
use bc_storage::AuditOutcome;

use crate::cloudflare_api::{CloudflareClient, DNSRecord};
use crate::storage::Storage;

use super::trail;

// ── Bounds ──────────────────────────────────────────────────────────────────

/// Entries one page of history carries, as `ZONE_HISTORY_PAGE_SIZE` in
/// `src/lib/history/types.ts`. Pinned against that file by
/// `the_page_size_matches_the_renderers_contract`.
pub const ZONE_HISTORY_PAGE_SIZE: usize = 50;

/// Records asked for per page while reading the zone for a drift check.
/// Mirrors `commands::retention`'s restore pre-flight.
const DRIFT_SCAN_PER_PAGE: u32 = 1_000;

/// Pages read before the drift check gives up on seeing the whole zone.
///
/// Ten thousand records is past the size of any zone a person administers by
/// hand. Past it, a row whose record was not seen is reported as not undoable
/// rather than guessed at: the two guesses available are "it is gone" and "it
/// is unchanged", and both of them write.
const DRIFT_SCAN_MAX_PAGES: u32 = 10;

// ── Trail vocabulary ────────────────────────────────────────────────────────

/// The operations that write one DNS record, and what each did to it.
///
/// A whitelist, not a pattern match on the name. Everything in a zone's trail
/// that is *not* here is still listed — that is the rule the contract states —
/// with a `not-undoable` reason, so a new operation added elsewhere in the
/// application shows up as something this build does not know how to undo
/// rather than as something it silently believes it can.
const RECORD_WRITES: [(&str, HistoryChangeKind); 5] = [
    ("dns:create", HistoryChangeKind::Created),
    ("dns:update", HistoryChangeKind::Updated),
    ("dns:delete", HistoryChangeKind::Deleted),
    ("dns:disable", HistoryChangeKind::Deleted),
    ("dns:retain", HistoryChangeKind::Deleted),
];

/// The operation that creates many records in one call.
///
/// Handled apart from [`RECORD_WRITES`] because its trail entry is a summary
/// of the whole import rather than a row about one record: the record ids are
/// in an `OperationManifest` in the retention store, so availability and the
/// plan both come from there. See `commands::dns::record_create_manifest`.
const BULK_CREATE: &str = "dns:bulk_create";

/// Why an operation that is in the list cannot be undone.
///
/// One sentence each, in the user's terms rather than the trail's: the string
/// goes straight into `UndoAvailability`'s `reason` and is the only explanation
/// the user gets.
fn not_undoable_reason(operation: &str) -> &'static str {
    match operation {
        "dns:bulk_delete" => {
            "A bulk delete by id keeps no copy of the records, so there is \
             nothing to put back. Deletes made from the record list are \
             undoable."
        }
        "dns:export" => "An export only read the zone; there is nothing to undo.",
        "dns:list" => "A listing only read the zone; there is nothing to undo.",
        "dns:restore" => {
            "Restoring a retained record is itself the undo of a delete. Undo \
             the restore by deleting the record again."
        }
        "cache:purge" => "A cache purge cannot be reversed; the cache refills on its own.",
        "dnssec:update" => {
            "DNSSEC is a zone-level setting with consequences at the registrar, \
             so it is changed deliberately rather than undone."
        }
        "zone_setting:update" => {
            "Zone settings are not record changes. Change the setting back from \
             the zone's settings tab."
        }
        "retention:purge" | "retention:evict" | "retention:clear" | "retention:discard" => {
            "This entry records a copy the application gave up, not a change to \
             the zone."
        }
        _ => "This build does not know how to undo this kind of change.",
    }
}

// ── Wire shapes ─────────────────────────────────────────────────────────────
//
// Every type below is one of `src/lib/history/types.ts`'s, field for field.
// The renames are explicit rather than a container-level `rename_all` so that
// a field added here without a decision about its wire name does not quietly
// ship under a snake_case key the renderer is not reading.

/// What a write did to one record.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryChangeKind {
    Created,
    Updated,
    Deleted,
}

/// Who did it. `mcp_client` in the trail is `mcp` on the wire, which is what
/// the contract calls it.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryActor {
    User,
    Assistant,
    Mcp,
}

/// How a whole operation landed.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryOutcome {
    Ok,
    Partial,
    Failed,
}

/// One record's state, exactly as it was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RetainedRecordSnapshotView {
    #[serde(rename = "recordType")]
    pub record_type: String,
    pub name: String,
    pub content: String,
    pub ttl: Option<u32>,
    pub priority: Option<u16>,
    pub proxied: Option<bool>,
    pub comment: Option<String>,
    pub tags: Vec<String>,
}

impl RetainedRecordSnapshotView {
    /// The view of a stored snapshot.
    ///
    /// `tags` comes from [`RetainedRecord::local_tags`] rather than from the
    /// snapshot, because the snapshot holds what Cloudflare holds and the tags
    /// are this application's own, keyed by a record id that may be dead.
    fn of_retained(entry: &RetainedRecord) -> Self {
        Self {
            record_type: entry.snapshot.record_type.clone(),
            name: entry.snapshot.name.clone(),
            content: entry.snapshot.content.clone(),
            ttl: entry.snapshot.ttl,
            priority: entry.snapshot.priority,
            proxied: entry.snapshot.proxied,
            comment: entry.snapshot.comment.clone(),
            tags: entry.local_tags.clone(),
        }
    }

    /// The view of a record Cloudflare holds now.
    ///
    /// No tags: Cloudflare does not have them, and inventing an empty list for
    /// a record that does have local tags would be a lie in the one direction
    /// that matters, because this view is shown as "what is there now".
    fn of_record(record: &DNSRecord) -> Self {
        Self {
            record_type: record.r#type.clone(),
            name: record.name.clone(),
            content: record.content.clone(),
            ttl: record.ttl,
            priority: record.priority,
            proxied: record.proxied,
            comment: record.comment.clone(),
            tags: Vec::new(),
        }
    }
}

/// Per-field `from`/`to`, as the trail recorded it. Display only — see this
/// module's header.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HistoryFieldChange {
    pub field: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// Why an entry cannot be undone, or that it can.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum UndoAvailability {
    Available,
    /// The snapshot aged out of the retention store.
    Expired {
        #[serde(rename = "expiredAt")]
        expired_at: String,
    },
    /// The snapshot was evicted to stay inside the store's bounds.
    Evicted,
    /// Recorded before this feature existed, so no snapshot was ever taken.
    NoSnapshot,
    /// Undoing this would recreate a record the user has since deleted again.
    SupersededByDelete,
    /// Not a record write — a zone setting, a cache purge, a DNSSEC change.
    NotUndoable {
        reason: String,
    },
}

impl UndoAvailability {
    const fn is_available(&self) -> bool {
        matches!(self, Self::Available)
    }
}

/// One row in the history list: a single record, within an operation.
#[derive(Clone, Debug, Serialize)]
pub struct ZoneHistoryEntry {
    pub id: String,
    #[serde(rename = "operationId")]
    pub operation_id: String,
    pub kind: HistoryChangeKind,
    #[serde(rename = "recordType")]
    pub record_type: String,
    #[serde(rename = "recordName")]
    pub record_name: String,
    #[serde(rename = "recordId")]
    pub record_id: Option<String>,
    pub changes: Vec<HistoryFieldChange>,
    #[serde(rename = "changesOmitted")]
    pub changes_omitted: bool,
    pub undo: UndoAvailability,
}

/// One user action, with the records it touched.
#[derive(Clone, Debug, Serialize)]
pub struct ZoneHistoryOperation {
    #[serde(rename = "operationId")]
    pub operation_id: String,
    #[serde(rename = "zoneId")]
    pub zone_id: String,
    pub operation: String,
    pub actor: HistoryActor,
    pub outcome: HistoryOutcome,
    pub at: String,
    pub entries: Vec<ZoneHistoryEntry>,
    pub truncated: bool,
}

/// How one row of an undo would land.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum UndoRowDrift {
    /// Cloudflare still holds what the change wrote; the revert is clean.
    Unchanged,
    /// It moved again since. Skipped unless the user overwrites.
    Changed { current: RetainedRecordSnapshotView },
    /// Gone from Cloudflare. An update-undo becomes a re-create.
    Absent,
    /// The name and type now belong to a record this undo did not create.
    Conflict {
        #[serde(rename = "conflictingRecordId")]
        conflicting_record_id: String,
    },
}

/// One record the undo would write, and what writing it would mean.
///
/// `recordId` is **an addition to `src/lib/history/types.ts`'s `UndoPlanRow`**,
/// which does not declare it. It has to be here: the renderer builds the
/// reverse operation itself, and it cannot issue an update without the id to
/// update. Without the field the renderer would have to join each row back to
/// `list_zone_history`'s entry on `entryId` and read the id from there — which
/// works for an edit but not for a row expanded out of an import, whose
/// `entryId` is not a list entry's id at all. An extra key is ignored by a
/// structural type, so this is additive rather than breaking; `types.ts` should
/// adopt it.
#[derive(Clone, Debug, Serialize)]
pub struct UndoPlanRow {
    #[serde(rename = "entryId")]
    pub entry_id: String,
    #[serde(rename = "recordType")]
    pub record_type: String,
    #[serde(rename = "recordName")]
    pub record_name: String,
    /// `null` when the undo deletes the record (reverting a create).
    pub target: Option<RetainedRecordSnapshotView>,
    /// The live record to write over, or `null` when the reverse operation is a
    /// create: the record is gone, or was never there because this row reverts
    /// a creation.
    #[serde(rename = "recordId")]
    pub record_id: Option<String>,
    pub drift: UndoRowDrift,
    #[serde(rename = "selectedByDefault")]
    pub selected_by_default: bool,
}

/// A row of the operation that cannot be undone at all, and why.
#[derive(Clone, Debug, Serialize)]
pub struct UndoUnavailableRow {
    #[serde(rename = "entryId")]
    pub entry_id: String,
    #[serde(rename = "recordName")]
    pub record_name: String,
    pub undo: UndoAvailability,
}

/// What `preview_undo_operation` returns. Nothing is written to produce it.
#[derive(Clone, Debug, Serialize)]
pub struct UndoPreview {
    #[serde(rename = "operationId")]
    pub operation_id: String,
    #[serde(rename = "zoneId")]
    pub zone_id: String,
    pub rows: Vec<UndoPlanRow>,
    pub unavailable: Vec<UndoUnavailableRow>,
}

// `UndoResult` and its per-row failure are deliberately **not** here. The
// renderer applies an undo through the stack it already has, so it is the thing
// that knows what landed and what did not, and a second applier on this side
// would be a second set of rules for re-pointing a dead record id and for
// routing a binned delete through retention's restore. The writes it makes come
// back through the ordinary DNS commands, so they are logged, grouped under
// whatever operation id it passes, and snapshotted, without anything here.

// ── Reading the trail ───────────────────────────────────────────────────────

/// One trail entry, parsed as far as this module needs it.
#[derive(Clone, Debug)]
struct TrailEntry {
    id: String,
    operation_id: Option<String>,
    group: String,
    operation: String,
    actor: HistoryActor,
    outcome: AuditOutcome,
    at: String,
    sort_key: Option<DateTime<Utc>>,
    record_type: String,
    record_name: String,
    /// The `resource` field: a record id for a record write, a zone id for a
    /// zone-level action. Dead after a delete, and still the key the snapshot
    /// is found by.
    resource: Option<String>,
    changes: Vec<HistoryFieldChange>,
    changes_omitted: bool,
    /// The recorded state *after* the write, field by field, from `changes`'
    /// `to` side or from a whole-record `record` detail.
    after: Map<String, Value>,
    /// Whether any part of the after-state was dropped or shortened, so
    /// equality against the live record cannot be established.
    after_unverifiable: bool,
    undo_expires_at: Option<DateTime<Utc>>,
}

impl TrailEntry {
    fn kind(&self) -> Option<HistoryChangeKind> {
        if self.is_bulk_create() {
            return Some(HistoryChangeKind::Created);
        }
        RECORD_WRITES
            .iter()
            .find(|(operation, _)| *operation == self.operation)
            .map(|(_, kind)| *kind)
    }

    /// Whether this entry summarises an import, so its record ids are in a
    /// manifest rather than in the entry.
    fn is_bulk_create(&self) -> bool {
        self.operation == BULK_CREATE
    }

    /// Whether this entry describes a whole batch rather than one record,
    /// which is also to say that its `resource` is the zone and not a record.
    fn is_bulk(&self) -> bool {
        self.is_bulk_create() || self.operation == "dns:bulk_delete"
    }

    /// The kind a list row reports, for an operation that is not a record
    /// write.
    ///
    /// The contract's `kind` is closed — created, updated or deleted — and a
    /// cache purge is none of the three. A bulk operation genuinely created or
    /// deleted records, so it says so; anything else reports `updated`, with
    /// the truth in the `not-undoable` reason, because that is the only field
    /// that can hold it.
    fn listed_kind(&self) -> HistoryChangeKind {
        self.kind().unwrap_or(match self.operation.as_str() {
            "dns:bulk_delete" => HistoryChangeKind::Deleted,
            _ => HistoryChangeKind::Updated,
        })
    }
}

/// Read one zone's trail, newest first, as entries this module can group.
fn trail_entries(log: &[Value], zone_id: &str) -> Vec<TrailEntry> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut entries: Vec<TrailEntry> = log
        .iter()
        .filter(|entry| detail_str(entry, "zone_id").as_deref() == Some(zone_id))
        .map(|entry| parse_entry(entry, &mut seen))
        .collect();
    // Newest first. Stable, so entries sharing a timestamp keep the order the
    // log holds them in, and an entry with no readable timestamp sorts last
    // rather than to the top: an unknown date is not a recent one.
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.sort_key));
    entries
}

fn parse_entry(entry: &Value, seen: &mut HashMap<String, usize>) -> TrailEntry {
    let operation = detail_str(entry, "operation").unwrap_or_default();
    let at = detail_str(entry, "timestamp").unwrap_or_default();
    let resource = detail_str(entry, "resource");
    let record_type = detail_str(entry, "record_type").unwrap_or_default();
    let record_name = detail_str(entry, "record_name").unwrap_or_default();
    let operation_id = detail_str(entry, trail::OPERATION_ID_KEY);

    let id = entry_id(&at, &operation, &resource, &record_name, seen);
    let group = operation_id
        .clone()
        // An entry with no operation id is an operation of one, under a key
        // that cannot be mistaken for a minted id — it is not a UUID, so
        // `preview_undo_operation` finds no snapshots for it and says so,
        // rather than matching some other action's group by accident.
        .unwrap_or_else(|| format!("entry:{id}"));

    let (changes, changes_omitted, after, after_unverifiable) = read_change_set(entry);

    TrailEntry {
        id,
        operation_id,
        group,
        operation,
        actor: actor_of(entry),
        outcome: outcome_of(entry),
        sort_key: DateTime::parse_from_rfc3339(&at).ok().map(Into::into),
        at,
        record_type,
        record_name,
        resource,
        changes,
        changes_omitted,
        after,
        after_unverifiable,
        undo_expires_at: detail_str(entry, trail::UNDO_EXPIRES_AT_KEY)
            .and_then(|at| DateTime::parse_from_rfc3339(&at).ok())
            .map(Into::into),
    }
}

/// A stable id for one trail entry.
///
/// Derived from the entry's own content rather than from its position in the
/// log, because the log evicts from the middle: a positional id would renumber
/// every row behind an eviction, and the id is what `apply_undo_operation` is
/// handed after the user has chosen. The occurrence counter separates two
/// entries that are identical in every field this reads, which needs a
/// timestamp collision to happen at all.
///
/// Deterministic by construction, with FNV-1a rather than
/// `std::hash::DefaultHasher`: the standard hasher's output is explicitly not
/// guaranteed to be stable across builds, and an id that changes when the
/// toolchain does is an id that stops matching a dialog the user left open.
fn entry_id(
    at: &str,
    operation: &str,
    resource: &Option<String>,
    record_name: &str,
    seen: &mut HashMap<String, usize>,
) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in [
        at,
        operation,
        resource.as_deref().unwrap_or(""),
        record_name,
    ] {
        for byte in part.as_bytes().iter().chain(b"\x1f") {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    let base = format!("h{hash:016x}");
    let occurrence = seen.entry(base.clone()).or_insert(0);
    *occurrence += 1;
    match *occurrence {
        1 => base,
        n => format!("{base}-{n}"),
    }
}

/// The change set a reader sees, and the after-state a drift check needs.
///
/// Returns `(changes, changes_omitted, after, after_unverifiable)`. The two
/// halves come from the same place but answer different questions: `changes` is
/// for display and keeps both sides of every field, while `after` is only the
/// post-write value of each field, which is what the live record is compared
/// against.
fn read_change_set(entry: &Value) -> (Vec<HistoryFieldChange>, bool, Map<String, Value>, bool) {
    let mut changes = Vec::new();
    let mut after = Map::new();
    let mut unverifiable = false;

    if let Some(fields) = entry.get("changes").and_then(Value::as_object) {
        for (field, pair) in fields {
            let from = pair.get("from").cloned().unwrap_or(Value::Null);
            let to = pair.get("to").cloned().unwrap_or(Value::Null);
            unverifiable |= is_shortened(&from) || is_shortened(&to);
            changes.push(HistoryFieldChange {
                field: field.clone(),
                from: rendered(&from),
                to: rendered(&to),
            });
            after.insert(field.clone(), to);
        }
    } else if let Some(fields) = entry.get("record").and_then(Value::as_object) {
        // No before-state was known, so the trail recorded the whole record.
        // Every field is an after-value with nothing to compare it to, which is
        // a complete after-state and an empty change set.
        for (field, value) in fields {
            unverifiable |= is_shortened(value);
            after.insert(field.clone(), value.clone());
        }
    }

    let omitted = entry
        .get("changes_omitted")
        .or_else(|| entry.get("record_omitted"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    // A dropped field is a field the live record cannot be checked against, so
    // the whole row stops being verifiable rather than being checked on the
    // fields that survived.
    (changes, omitted > 0, after, unverifiable || omitted > 0)
}

/// Whether a recorded value was shortened on the way into the log.
fn is_shortened(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| text.ends_with(trail::TRUNCATION_MARKER))
}

/// One recorded value as the contract's `string | null`.
fn rendered(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

fn detail_str(entry: &Value, key: &str) -> Option<String> {
    entry
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn actor_of(entry: &Value) -> HistoryActor {
    match entry.get("actor").and_then(Value::as_str) {
        Some("assistant") => HistoryActor::Assistant,
        Some("mcp_client") => HistoryActor::Mcp,
        // The trail's own default: every writer that predates the `actor` field
        // was the application acting for the person at the keyboard.
        _ => HistoryActor::User,
    }
}

fn outcome_of(entry: &Value) -> AuditOutcome {
    match entry.get("outcome").and_then(Value::as_str) {
        Some("failed") => AuditOutcome::Failed,
        Some("denied") => AuditOutcome::Denied,
        _ => AuditOutcome::Succeeded,
    }
}

// ── Grouping ────────────────────────────────────────────────────────────────

/// One operation's trail entries, before availability is decided.
struct Group {
    key: String,
    entries: Vec<TrailEntry>,
}

/// Collect a zone's entries into operations, newest first.
///
/// Entries *within* an operation keep the order the log holds them in — oldest
/// first — because that is the order an "undo all" replays them in.
fn group(entries: Vec<TrailEntry>) -> Vec<Group> {
    let mut order: Vec<String> = Vec::new();
    let mut grouped: HashMap<String, Vec<TrailEntry>> = HashMap::new();
    for entry in entries {
        if !grouped.contains_key(&entry.group) {
            order.push(entry.group.clone());
        }
        grouped.entry(entry.group.clone()).or_default().push(entry);
    }
    order
        .into_iter()
        .filter_map(|key| {
            let mut entries = grouped.remove(&key)?;
            entries.reverse();
            Some(Group { key, entries })
        })
        .collect()
}

/// How a whole operation landed, from the outcomes of its entries.
fn operation_outcome(entries: &[TrailEntry]) -> HistoryOutcome {
    let settled = entries
        .iter()
        .filter(|entry| entry.outcome == AuditOutcome::Succeeded)
        .count();
    match settled {
        0 => HistoryOutcome::Failed,
        n if n == entries.len() => HistoryOutcome::Ok,
        _ => HistoryOutcome::Partial,
    }
}

// ── Availability ────────────────────────────────────────────────────────────

/// The snapshots held for one zone, indexed the two ways this module looks
/// them up.
struct Snapshots<'a> {
    by_operation: HashMap<String, Vec<RetainedRecord>>,
    by_record: HashMap<String, Vec<RetainedRecord>>,
    /// The whole store, kept for the manifest reads, which are keyed by
    /// operation id and are rare enough not to earn an index of their own.
    store: &'a [Value],
}

impl<'a> Snapshots<'a> {
    fn of_zone(store: &'a [Value], zone_id: &str) -> Self {
        let held =
            retention::snapshots_for_zone(store, zone_id, retention::MAX_RETAINED_READ_ENTRIES);
        let mut by_operation: HashMap<String, Vec<RetainedRecord>> = HashMap::new();
        let mut by_record: HashMap<String, Vec<RetainedRecord>> = HashMap::new();
        for entry in held {
            if let Some(operation_id) = entry.operation_id.clone() {
                by_operation
                    .entry(operation_id)
                    .or_default()
                    .push(entry.clone());
            }
            if let Some(record_id) = entry.origin_record_id.clone() {
                by_record.entry(record_id).or_default().push(entry);
            }
        }
        Self {
            by_operation,
            by_record,
            store,
        }
    }

    /// What one import created, if the store still holds the manifests and the
    /// import belongs to the zone being read.
    ///
    /// The zone check is not ceremony: a manifest is addressed by operation id
    /// alone, so without it an operation id from another zone's history would
    /// return that zone's record ids and an undo would delete them.
    ///
    /// An import wide enough to need several manifests comes back assembled, so
    /// a part the store has since dropped shows up as the set no longer
    /// accounting for the total — not as a shorter list that looks whole.
    fn created(&self, entry: &TrailEntry, zone_id: &str) -> Option<retention::CreatedRecords> {
        let operation_id = entry.operation_id.as_deref()?;
        retention::created_records_for_operation(self.store, operation_id)
            .filter(|created| created.zone_id == zone_id)
    }

    /// The snapshot that backs one entry's undo, if the store still holds it.
    ///
    /// Matched on the operation id **and** the record id where the entry has
    /// one, so a record edited twice under two operations finds the state that
    /// belongs to the edit the user is looking at rather than the other one.
    ///
    /// The fallback — record id alone — exists for the entries written by
    /// `commands::retention::retain_dns_record`, which keeps a snapshot but
    /// does not yet stamp an operation id on it. It is only taken when the
    /// record id has exactly one snapshot, because with several there is no way
    /// to tell which change a trail entry refers to and a wrong snapshot is a
    /// wrong record. A deleted record's id is dead and Cloudflare does not
    /// reuse it, which is what makes the single-candidate case sound.
    fn backing(&self, entry: &TrailEntry) -> Option<&RetainedRecord> {
        let record_id = entry.resource.as_deref();
        if let Some(operation_id) = entry.operation_id.as_deref() {
            // Both keys or nothing. A snapshot from the right operation but a
            // different record is a different record, and writing it back
            // would revert something the user did not ask about.
            return self
                .by_operation
                .get(operation_id)?
                .iter()
                .find(|held| held.origin_record_id.as_deref() == record_id);
        }
        let held = self.by_record.get(record_id?)?;
        match held.as_slice() {
            [only] if only.operation_id.is_none() => Some(only),
            _ => None,
        }
    }
}

/// Whether an entry's undo can still be applied, and if not, why not.
///
/// `later_deletes` holds the record ids this zone's trail shows deleted *after*
/// the entry being classified, which is what makes `superseded-by-delete`
/// decidable without a network call: putting an edit back on a record the user
/// has since deleted would re-create the record, not revert the edit.
fn availability(
    entry: &TrailEntry,
    kind: Option<HistoryChangeKind>,
    snapshots: &Snapshots<'_>,
    zone_id: &str,
    later_deletes: &HashSet<String>,
    now: DateTime<Utc>,
) -> UndoAvailability {
    let Some(kind) = kind else {
        return UndoAvailability::NotUndoable {
            reason: not_undoable_reason(&entry.operation).to_string(),
        };
    };
    if entry.outcome == AuditOutcome::Denied {
        return UndoAvailability::NotUndoable {
            reason: "This change was refused before it was sent, so nothing happened to undo."
                .to_string(),
        };
    }
    // An import's record ids are in a manifest, not in its summary entry, and
    // a manifest that lists only part of the import is refused by name: an
    // undo that deletes 200 of 412 records and reports success is worse than
    // one that will not run.
    if entry.is_bulk_create() {
        return match snapshots.created(entry, zone_id) {
            Some(created) if created.is_expired(now) => UndoAvailability::Expired {
                expired_at: created
                    .expires_at
                    .map(|at| at.to_rfc3339())
                    .unwrap_or_default(),
            },
            Some(created) if !created.is_complete() => UndoAvailability::NotUndoable {
                reason: format!(
                    "This import created {total} records, and the ids of {missing} of them are \
                     no longer held, so it cannot be undone as one action. The {known} that are \
                     still recorded can be deleted individually.",
                    total = created.created_record_count.unwrap_or_default(),
                    missing = created.omitted(),
                    known = created.record_ids.len(),
                ),
            },
            Some(_) => UndoAvailability::Available,
            None => vanished(entry, now),
        };
    }
    // A create's undo is a delete, which needs the record id and nothing else.
    // A record already deleted since is still `available`: the undo has
    // nothing left to do, which the preview reports as `absent` drift and the
    // apply counts as skipped. Claiming it cannot be undone would be stranger
    // than offering a revert that turns out to be a no-op.
    if kind == HistoryChangeKind::Created {
        return match entry.resource.as_deref() {
            Some(_) => UndoAvailability::Available,
            None => UndoAvailability::NotUndoable {
                reason: "The trail did not record the id of the record that was created."
                    .to_string(),
            },
        };
    }
    if kind == HistoryChangeKind::Updated
        && entry
            .resource
            .as_deref()
            .is_some_and(|record_id| later_deletes.contains(record_id))
    {
        return UndoAvailability::SupersededByDelete;
    }
    match snapshots.backing(entry) {
        Some(held) if held.is_expired(now) => UndoAvailability::Expired {
            expired_at: held
                .expires_at
                .map(|at| at.to_rfc3339())
                .unwrap_or_default(),
        },
        Some(held) if !held.is_restorable() => UndoAvailability::NotUndoable {
            reason: "The stored copy of this record is missing a field it would need to be \
                     written back."
                .to_string(),
        },
        Some(_) => UndoAvailability::Available,
        None => vanished(entry, now),
    }
}

/// Why there is nothing in the store for an entry that should have had
/// something.
///
/// The three cases are indistinguishable from the store — the entry is simply
/// absent — so the verdict comes from what the *trail entry* recorded. See the
/// module header's table; this is the row that makes `expired` and `evicted`
/// different answers rather than a coin toss.
fn vanished(entry: &TrailEntry, now: DateTime<Utc>) -> UndoAvailability {
    match entry.undo_expires_at {
        Some(expires_at) if expires_at <= now => UndoAvailability::Expired {
            expired_at: expires_at.to_rfc3339(),
        },
        Some(_) => UndoAvailability::Evicted,
        // An operation id means a build that takes snapshots wrote this, so
        // one was taken and is gone; without the expiry there is no date to
        // offer, which leaves eviction as the only answer that does not invent
        // one. No operation id at all means no snapshot was ever taken.
        None if entry.operation_id.is_some() => UndoAvailability::Evicted,
        None => UndoAvailability::NoSnapshot,
    }
}

/// The record ids this zone's trail shows deleted after each entry.
///
/// Built once over the whole zone rather than per entry: the list is newest
/// first, so walking it forwards accumulates the deletes that happened *later*
/// than whatever comes next.
fn later_delete_index(entries: &[TrailEntry]) -> Vec<HashSet<String>> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut index = Vec::with_capacity(entries.len());
    for entry in entries {
        index.push(seen.clone());
        if entry.kind() == Some(HistoryChangeKind::Deleted)
            && entry.outcome == AuditOutcome::Succeeded
        {
            if let Some(record_id) = entry.resource.clone() {
                seen.insert(record_id);
            }
        }
    }
    index
}

// ── Drift ───────────────────────────────────────────────────────────────────

/// The zone as Cloudflare holds it, for a drift check.
struct ZoneNow {
    by_id: HashMap<String, DNSRecord>,
    by_slot: HashMap<(String, String), DNSRecord>,
    /// `true` when the zone was larger than the scan window, so "not found"
    /// does not mean "not there".
    partial: bool,
}

impl ZoneNow {
    async fn read(client: &CloudflareClient, zone_id: &str) -> Result<Self, String> {
        let mut by_id = HashMap::new();
        let mut by_slot = HashMap::new();
        let mut partial = false;
        for page in 1..=DRIFT_SCAN_MAX_PAGES {
            let records = client
                .get_dns_records(zone_id, Some(page), Some(DRIFT_SCAN_PER_PAGE))
                .await
                .map_err(|error| error.to_string())?;
            let full = records.len() as u32 == DRIFT_SCAN_PER_PAGE;
            for record in records {
                by_slot.insert(
                    (record.r#type.to_uppercase(), slot_name(&record.name)),
                    record.clone(),
                );
                if let Some(id) = record.id.clone() {
                    by_id.insert(id, record);
                }
            }
            if !full {
                return Ok(Self {
                    by_id,
                    by_slot,
                    partial,
                });
            }
            partial = page == DRIFT_SCAN_MAX_PAGES;
        }
        Ok(Self {
            by_id,
            by_slot,
            partial,
        })
    }

    fn record(&self, record_id: &str) -> Option<&DNSRecord> {
        self.by_id.get(record_id)
    }

    /// Whichever record now holds a name and type, if any.
    fn occupant(&self, record_type: &str, name: &str) -> Option<&DNSRecord> {
        self.by_slot
            .get(&(record_type.to_uppercase(), slot_name(name)))
    }
}

/// A record name as a comparison key: case-insensitive, with the trailing dot
/// a zone file may carry removed. `WWW.Example.com.` and `www.example.com` are
/// one name, and treating them as two would report drift that is not there.
fn slot_name(name: &str) -> String {
    name.trim().trim_end_matches('.').to_lowercase()
}

/// Whether the live record still matches what the change wrote.
///
/// `false` whenever equality cannot be *established*, not only when the values
/// differ: a row the trail shortened is reported as changed, because the
/// alternative pre-selects it and overwrites whatever is actually there. See
/// the module header.
fn matches_recorded(after: &Map<String, Value>, unverifiable: bool, live: &DNSRecord) -> bool {
    if unverifiable || after.is_empty() {
        return false;
    }
    after.iter().all(|(field, recorded)| {
        let current = live_field(live, field);
        match current {
            // A field the trail recorded that this build cannot read off a
            // record is a field that cannot be compared.
            None => false,
            Some(current) => &current == recorded,
        }
    })
}

/// One field of a live record as the trail would have recorded it.
fn live_field(record: &DNSRecord, field: &str) -> Option<Value> {
    Some(match field {
        "content" => Value::String(record.content.clone()),
        "name" => Value::String(record.name.clone()),
        "type" | "record_type" => Value::String(record.r#type.clone()),
        "ttl" => record.ttl.map_or(Value::Null, Value::from),
        "proxied" => record.proxied.map_or(Value::Null, Value::from),
        "priority" => record.priority.map_or(Value::Null, Value::from),
        "comment" => record.comment.clone().map_or(Value::Null, Value::String),
        _ => return None,
    })
}

/// Classify how one row of an undo would land.
///
/// Three different comparisons, because the three kinds are undone three
/// different ways:
///
/// * **A create** is undone by deleting the record, so the question is whether
///   that record is still the one that was created.
/// * **An update** is undone by writing the old state back over the same id, so
///   the question is whether the id still holds what the edit wrote.
/// * **A delete** is undone by creating the record again, so the id is dead and
///   the question is whether anything has taken the name and type since.
fn classify(
    entry: &TrailEntry,
    kind: HistoryChangeKind,
    target: Option<&RetainedRecordSnapshotView>,
    zone: &ZoneNow,
) -> UndoRowDrift {
    let live = entry.resource.as_deref().and_then(|id| zone.record(id));
    match kind {
        HistoryChangeKind::Created => match live {
            Some(live) if matches_recorded(&entry.after, entry.after_unverifiable, live) => {
                UndoRowDrift::Unchanged
            }
            Some(live) => UndoRowDrift::Changed {
                current: RetainedRecordSnapshotView::of_record(live),
            },
            // Already gone. Deleting it again is a no-op, which is a clean
            // revert with nothing to write.
            None => UndoRowDrift::Absent,
        },
        HistoryChangeKind::Updated => match live {
            Some(live) if matches_recorded(&entry.after, entry.after_unverifiable, live) => {
                UndoRowDrift::Unchanged
            }
            Some(live) => UndoRowDrift::Changed {
                current: RetainedRecordSnapshotView::of_record(live),
            },
            None => conflict_or(zone, target, UndoRowDrift::Absent),
        },
        HistoryChangeKind::Deleted => match live {
            // The id still resolves, so the delete this is undoing did not
            // land. Re-creating would duplicate the record.
            Some(live) => UndoRowDrift::Changed {
                current: RetainedRecordSnapshotView::of_record(live),
            },
            None => conflict_or(zone, target, UndoRowDrift::Unchanged),
        },
    }
}

/// Whether a row arrives pre-checked for the user.
///
/// Only a clean revert does. Every other verdict means writing the row would
/// change something the recorded change did not write, so the user has to tick
/// it themselves — which is the whole safety property of the preview, and the
/// reason this is one function rather than a comparison repeated at each call
/// site.
const fn selected_by_default(drift: &UndoRowDrift) -> bool {
    matches!(drift, UndoRowDrift::Unchanged)
}

/// `conflict` when something already holds the name and type the undo would
/// write, otherwise the caller's verdict.
fn conflict_or(
    zone: &ZoneNow,
    target: Option<&RetainedRecordSnapshotView>,
    clean: UndoRowDrift,
) -> UndoRowDrift {
    let Some(target) = target else {
        return clean;
    };
    match zone.occupant(&target.record_type, &target.name) {
        Some(occupant) => UndoRowDrift::Conflict {
            conflicting_record_id: occupant.id.clone().unwrap_or_default(),
        },
        None => clean,
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Page one zone's history, grouped into operations, newest first.
///
/// Reads the trail and the retention store, and **nothing else** — no network
/// call, so opening the tab cannot be slow or fail because Cloudflare is
/// unreachable. That is also why availability here answers "is there still a
/// snapshot", never "would the undo be clean": drift needs the zone as it is
/// now, which is [`preview_undo_operation`]'s job.
///
/// Paged by entries rather than by operations, because an entry is what costs
/// the renderer something to draw — but an operation is never split across a
/// page, so "undo all" is always offered the whole group. A page therefore
/// holds at least [`ZONE_HISTORY_PAGE_SIZE`] entries once an operation
/// straddles the boundary. An empty result means there is no further page.
#[tauri::command]
pub async fn list_zone_history(
    storage: State<'_, Storage>,
    zone_id: String,
    page: Option<u32>,
) -> Result<Vec<ZoneHistoryOperation>, String> {
    let log = storage
        .get_audit_entries()
        .await
        .map_err(|error| error.to_string())?;
    let store = storage
        .get_retained_records()
        .await
        .map_err(|error| error.to_string())?;
    Ok(zone_history(
        &log,
        &store,
        &zone_id,
        page.unwrap_or(0) as usize,
        Utc::now(),
    ))
}

/// The whole of `list_zone_history` that does not touch a store, so it can be
/// tested against a log and a snapshot set rather than a keyring.
fn zone_history(
    log: &[Value],
    store: &[Value],
    zone_id: &str,
    page: usize,
    now: DateTime<Utc>,
) -> Vec<ZoneHistoryOperation> {
    let entries = trail_entries(log, zone_id);
    let later_deletes = later_delete_index(&entries);
    let snapshots = Snapshots::of_zone(store, zone_id);
    // Availability is decided over the flat, newest-first list, where "deleted
    // later than this" is a position rather than a search.
    let classified: HashMap<String, UndoAvailability> = entries
        .iter()
        .zip(later_deletes.iter())
        .map(|(entry, later)| {
            (
                entry.id.clone(),
                availability(entry, entry.kind(), &snapshots, zone_id, later, now),
            )
        })
        .collect();

    let operations: Vec<ZoneHistoryOperation> = group(entries)
        .into_iter()
        .map(|group| {
            let newest = group
                .entries
                .iter()
                .max_by(|left, right| left.sort_key.cmp(&right.sort_key))
                .or_else(|| group.entries.first());
            let operation = group
                .entries
                .first()
                .map(|entry| entry.operation.clone())
                .unwrap_or_default();
            let actor = group
                .entries
                .first()
                .map(|entry| entry.actor)
                .unwrap_or(HistoryActor::User);
            let truncated = trail_dropped_entries(store, &group);
            ZoneHistoryOperation {
                operation_id: group.key.clone(),
                zone_id: zone_id.to_string(),
                operation,
                actor,
                outcome: operation_outcome(&group.entries),
                at: newest.map(|entry| entry.at.clone()).unwrap_or_default(),
                entries: group
                    .entries
                    .iter()
                    .map(|entry| ZoneHistoryEntry {
                        id: entry.id.clone(),
                        operation_id: group.key.clone(),
                        kind: entry.listed_kind(),
                        record_type: entry.record_type.clone(),
                        record_name: entry.record_name.clone(),
                        // No record id for a deletion, because Cloudflare
                        // destroys it when the record goes — and none for a
                        // bulk entry either, whose `resource` is the *zone*.
                        // Handing a zone id back under `recordId` is the kind
                        // of thing a renderer would use once and only notice
                        // when the wrong record moved.
                        record_id: match entry.listed_kind() {
                            HistoryChangeKind::Deleted => None,
                            _ if entry.is_bulk() => None,
                            _ => entry.resource.clone(),
                        },
                        changes: entry.changes.clone(),
                        changes_omitted: entry.changes_omitted,
                        undo: classified
                            .get(&entry.id)
                            .cloned()
                            .unwrap_or(UndoAvailability::NoSnapshot),
                    })
                    .collect(),
                truncated,
            }
        })
        .collect();

    paginate(operations, page)
}

/// Whether the trail has dropped entries this operation produced.
///
/// Answered from the retention store, which is the only place that remembers:
/// a snapshot carrying this operation's id whose record is named by none of the
/// operation's surviving trail entries is an entry the log evicted. The audit
/// log and the snapshot store have different caps and different eviction rules,
/// so one outliving the other is normal rather than a fault.
fn trail_dropped_entries(store: &[Value], group: &Group) -> bool {
    let Some(operation_id) = group
        .entries
        .first()
        .and_then(|entry| entry.operation_id.clone())
    else {
        return false;
    };
    let listed: HashSet<&str> = group
        .entries
        .iter()
        .filter_map(|entry| entry.resource.as_deref())
        .collect();
    retention::snapshots_for_operation(store, &operation_id)
        .iter()
        .any(|held| {
            held.origin_record_id
                .as_deref()
                .is_some_and(|record_id| !listed.contains(record_id))
        })
}

/// Take one page of operations, greedily filling it to
/// [`ZONE_HISTORY_PAGE_SIZE`] entries without splitting an operation.
///
/// Deterministic: the same log always divides into the same pages, so a page
/// number means the same thing on the second call as on the first.
fn paginate(operations: Vec<ZoneHistoryOperation>, page: usize) -> Vec<ZoneHistoryOperation> {
    let mut pages: Vec<Vec<ZoneHistoryOperation>> = Vec::new();
    let mut current: Vec<ZoneHistoryOperation> = Vec::new();
    let mut held = 0_usize;
    for operation in operations {
        let size = operation.entries.len();
        // Break before the operation that would take the page over budget, not
        // after — and never on an empty page, so an operation larger than a
        // whole page still gets one of its own rather than being dropped.
        if !current.is_empty() && held + size > ZONE_HISTORY_PAGE_SIZE {
            pages.push(std::mem::take(&mut current));
            held = 0;
        }
        held += size;
        current.push(operation);
    }
    if !current.is_empty() {
        pages.push(current);
    }
    pages.into_iter().nth(page).unwrap_or_default()
}

/// Plan an undo: say what each row would write and how it would land.
///
/// **Writes nothing, and does not apply anything.** The renderer applies, with
/// the undo stack it already has (`src/hooks/dns/use-undo-redo.ts` and
/// `applyDnsOp` in `DNSManager.tsx`): that is the one place that knows how to
/// re-point an operation whose record id died and to route a binned delete
/// through retention's restore rather than a raw delete, and an undo applied
/// through it lands in the in-memory stack and becomes redoable for free. What
/// this command adds is the two things the renderer cannot get from a stack
/// that dies with the session: the **exact** state to write, out of the
/// retention store, and whether writing it would overwrite somebody's later
/// edit.
///
/// So every row carries what a reverse operation needs to be built from: the
/// target snapshot, the live record id where one still exists, and the drift.
/// A row that cannot be undone at all is reported in `unavailable` with its
/// reason rather than left out, so the dialog can account for every record in
/// the operation.
#[tauri::command]
pub async fn preview_undo_operation(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    operation_id: String,
) -> Result<UndoPreview, String> {
    let plan = plan_undo(
        &storage,
        &api_key,
        email.as_deref(),
        &zone_id,
        &operation_id,
    )
    .await?;
    Ok(UndoPreview {
        operation_id,
        zone_id,
        rows: plan.rows,
        unavailable: plan.unavailable,
    })
}

struct Plan {
    rows: Vec<UndoPlanRow>,
    unavailable: Vec<UndoUnavailableRow>,
}

async fn plan_undo(
    storage: &Storage,
    api_key: &str,
    email: Option<&str>,
    zone_id: &str,
    operation_id: &str,
) -> Result<Plan, String> {
    let log = storage
        .get_audit_entries()
        .await
        .map_err(|error| error.to_string())?;
    let store = storage
        .get_retained_records()
        .await
        .map_err(|error| error.to_string())?;
    let now = Utc::now();
    let entries = trail_entries(&log, zone_id);
    let later_deletes = later_delete_index(&entries);
    let snapshots = Snapshots::of_zone(&store, zone_id);

    let selected: Vec<(TrailEntry, UndoAvailability)> = entries
        .iter()
        .zip(later_deletes.iter())
        .filter(|(entry, _)| entry.group == operation_id)
        .map(|(entry, later)| {
            (
                entry.clone(),
                availability(entry, entry.kind(), &snapshots, zone_id, later, now),
            )
        })
        .collect();
    if selected.is_empty() {
        return Err(format!(
            "No operation {operation_id} in this zone's history."
        ));
    }

    let mut rows = Vec::new();
    let mut unavailable = Vec::new();
    let mut zone: Option<ZoneNow> = None;
    for (entry, undo) in selected.into_iter().rev() {
        if !undo.is_available() {
            unavailable.push(UndoUnavailableRow {
                entry_id: entry.id.clone(),
                record_name: entry.record_name.clone(),
                undo,
            });
            continue;
        }
        // The zone is read once, and only if something in the operation can
        // actually be undone: a preview of an operation that is entirely
        // expired must not spend a Cloudflare call to say so.
        if zone.is_none() {
            let client = CloudflareClient::new(api_key, email);
            zone = Some(ZoneNow::read(&client, zone_id).await?);
        }
        let zone_now = zone.as_ref().expect("read above");
        // An import is one trail entry covering many records, so it expands
        // into one row per record the manifest lists. Each gets an id of its
        // own, suffixed with the record it is about, so the user can deselect
        // individual records out of a 200-record revert.
        if entry.is_bulk_create() {
            let Some(created) = snapshots.created(&entry, zone_id) else {
                continue;
            };
            for record_id in created.record_ids {
                let live = zone_now.record(&record_id);
                // What this cannot do, and the cost of it: the summary entry
                // records no per-record state, so there is nothing to compare
                // a surviving record against. A record somebody edited after
                // the import therefore reports as a clean revert, and reverting
                // it deletes their edit along with the import. The renderer's
                // applier routes a delete through retention, so the record is
                // recoverable from the bin — but the user is not warned, and
                // that is a real gap and not a rounding error.
                let drift = match live {
                    Some(_) => UndoRowDrift::Unchanged,
                    None => UndoRowDrift::Absent,
                };
                rows.push(UndoPlanRow {
                    entry_id: format!("{}#{record_id}", entry.id),
                    record_type: live.map(|record| record.r#type.clone()).unwrap_or_default(),
                    record_name: live
                        .map(|record| record.name.clone())
                        .unwrap_or_else(|| record_id.clone()),
                    // Reverting a create is a delete, and a delete needs only
                    // the id — which is why an import needs no snapshots.
                    target: None,
                    record_id: live.and(Some(record_id)),
                    selected_by_default: selected_by_default(&drift),
                    drift,
                });
            }
            continue;
        }
        let kind = entry.kind().expect("an available row is a record write");
        let held = snapshots.backing(&entry);
        let target = match kind {
            HistoryChangeKind::Created => None,
            _ => held.map(RetainedRecordSnapshotView::of_retained),
        };
        let live = entry.resource.as_deref().and_then(|id| zone_now.record(id));
        if live.is_none() && zone_now.partial {
            unavailable.push(UndoUnavailableRow {
                entry_id: entry.id.clone(),
                record_name: entry.record_name.clone(),
                undo: UndoAvailability::NotUndoable {
                    reason: "This zone holds more records than can be read in one pass, so \
                             whether this record still exists cannot be confirmed. Undo is \
                             refused rather than applied blind."
                        .to_string(),
                },
            });
            continue;
        }
        rows.push(plan_row(&entry, kind, target, zone_now));
    }
    Ok(Plan { rows, unavailable })
}

/// Everything the renderer needs to build the reverse of one recorded change.
///
/// Separate from [`plan_undo`] because that function needs a store and a
/// provider and this one needs neither: it is the whole of the decision, and
/// the part a test can hold still.
fn plan_row(
    entry: &TrailEntry,
    kind: HistoryChangeKind,
    target: Option<RetainedRecordSnapshotView>,
    zone: &ZoneNow,
) -> UndoPlanRow {
    let drift = classify(entry, kind, target.as_ref(), zone);
    UndoPlanRow {
        entry_id: entry.id.clone(),
        record_type: entry.record_type.clone(),
        record_name: entry.record_name.clone(),
        target,
        // The id to write over, read from **the zone** rather than from the
        // trail. That distinction is the whole value of the field: the trail's
        // id is dead after a delete, and an edit whose record has gone since
        // has nothing to write over at all. `None` therefore means the reverse
        // operation is a create, not that the id was unavailable.
        record_id: entry
            .resource
            .as_deref()
            .and_then(|id| zone.record(id))
            .and_then(|record| record.id.clone()),
        selected_by_default: selected_by_default(&drift),
        drift,
    }
}

/// The commands this feature adds, as `HISTORY_COMMANDS` in
/// `src/lib/history/types.ts` names them.
///
/// **Two, not three.** `HISTORY_COMMANDS.apply` names `apply_undo_operation`,
/// and there is deliberately no such command: the renderer applies through its
/// own undo stack. That entry has to come out of `types.ts`, because a name in
/// that table is a name something will eventually invoke, and invoking a
/// command Tauri does not have fails at the moment a user clicks — which is
/// exactly the failure the table was written to prevent, pointing the other
/// way.
///
/// Read by `main`'s registration test and by
/// `every_command_name_is_the_one_the_renderer_invokes` below.
///
/// `cfg(test)` like the other modules' lists: it exists to be asserted on, and
/// a production build that carried it would carry two unread strings.
#[cfg(test)]
pub const COMMAND_NAMES: [&str; 2] = ["list_zone_history", "preview_undo_operation"];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use bc_storage::RecordSnapshot;

    use super::*;

    /// The renderer's contract, read as text so the constants and command
    /// names on this side cannot drift from it without a test failing.
    const CONTRACT: &str = include_str!("../../../src/lib/history/types.ts");

    fn entry(fields: Value) -> Value {
        let Value::Object(mut map) = fields else {
            unreachable!("fixtures are objects")
        };
        map.entry("zone_id".to_string())
            .or_insert_with(|| json!("zone-1"));
        map.entry("actor".to_string())
            .or_insert_with(|| json!("user"));
        map.entry("outcome".to_string())
            .or_insert_with(|| json!("succeeded"));
        Value::Object(map)
    }

    fn at(seconds: u32) -> String {
        format!("2026-01-01T00:00:{seconds:02}+00:00")
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-02-01T00:00:00+00:00")
            .expect("a fixed clock")
            .into()
    }

    fn snapshot(operation_id: Option<&str>, record_id: &str, content: &str) -> Value {
        let mut held = RetainedRecord::new(retention::RetentionReason::SUPERSEDED, "zone-1", "")
            .origin_record_id(record_id)
            .snapshot(RecordSnapshot {
                record_type: "A".to_string(),
                name: "www.example.com".to_string(),
                content: content.to_string(),
                ttl: Some(300),
                priority: None,
                proxied: Some(false),
                comment: None,
            })
            .removed_at(now() - chrono::Duration::days(1))
            .expiring_after(Some(30), now() - chrono::Duration::days(1));
        if let Some(operation_id) = operation_id {
            held = held.operation_id(operation_id);
        }
        held.into_value()
    }

    const OP: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const OTHER_OP: &str = "11111111-2222-4333-8444-555555555555";

    fn an_update(operation_id: Option<&str>, record_id: &str, seconds: u32) -> Value {
        let mut fields = json!({
            "timestamp": at(seconds),
            "operation": "dns:update",
            "resource": record_id,
            "record_type": "A",
            "record_name": "www.example.com",
            "changes": { "content": { "from": "203.0.113.1", "to": "203.0.113.9" } },
        });
        if let Some(operation_id) = operation_id {
            fields[trail::OPERATION_ID_KEY] = json!(operation_id);
            fields[trail::UNDO_EXPIRES_AT_KEY] = json!("2026-03-01T00:00:00+00:00");
        }
        entry(fields)
    }

    // ── The contract ────────────────────────────────────────────────────────

    #[test]
    fn the_page_size_matches_the_renderers_contract() {
        assert!(
            CONTRACT.contains(&format!(
                "ZONE_HISTORY_PAGE_SIZE = {ZONE_HISTORY_PAGE_SIZE}"
            )),
            "the renderer pages by its own constant; two values is two page sizes"
        );
    }

    #[test]
    fn every_command_name_is_the_one_the_renderer_invokes() {
        for name in COMMAND_NAMES {
            assert!(
                CONTRACT.contains(&format!("\"{name}\"")),
                "{name} is not in HISTORY_COMMANDS, so the renderer cannot reach it"
            );
        }
    }

    #[test]
    fn every_state_the_contract_names_can_be_serialised_under_that_name() {
        let availabilities = [
            UndoAvailability::Available,
            UndoAvailability::Expired { expired_at: at(0) },
            UndoAvailability::Evicted,
            UndoAvailability::NoSnapshot,
            UndoAvailability::SupersededByDelete,
            UndoAvailability::NotUndoable {
                reason: "because".to_string(),
            },
        ];
        for availability in availabilities {
            let value = serde_json::to_value(&availability).expect("serialise");
            let state = value["state"].as_str().expect("a tagged state").to_string();
            assert!(
                CONTRACT.contains(&format!("\"{state}\"")),
                "{state:?} is not a state the renderer knows"
            );
        }
        for drift in [
            UndoRowDrift::Unchanged,
            UndoRowDrift::Absent,
            UndoRowDrift::Changed {
                current: target_of("203.0.113.5"),
            },
            UndoRowDrift::Conflict {
                conflicting_record_id: "record-9".to_string(),
            },
        ] {
            let value = serde_json::to_value(&drift).expect("serialise");
            let state = value["state"].as_str().expect("a tagged state").to_string();
            assert!(
                CONTRACT.contains(&format!("\"{state}\"")),
                "{state:?} is not a drift state the renderer knows"
            );
        }
    }

    #[test]
    fn the_wire_keys_are_the_camel_case_ones_the_renderer_reads() {
        let value = serde_json::to_value(ZoneHistoryEntry {
            id: "h0".to_string(),
            operation_id: OP.to_string(),
            kind: HistoryChangeKind::Updated,
            record_type: "A".to_string(),
            record_name: "www.example.com".to_string(),
            record_id: Some("record-1".to_string()),
            changes: Vec::new(),
            changes_omitted: false,
            undo: UndoAvailability::Available,
        })
        .expect("serialise");
        for key in [
            "operationId",
            "recordType",
            "recordName",
            "recordId",
            "changesOmitted",
        ] {
            assert!(value.get(key).is_some(), "{key} is missing: {value}");
        }
        assert!(
            value.get("record_type").is_none(),
            "a snake_case key the renderer is not reading is a field that vanished"
        );
    }

    // ── Grouping ────────────────────────────────────────────────────────────

    #[test]
    fn entries_sharing_an_operation_id_are_one_operation_newest_first() {
        let log = vec![
            an_update(Some(OP), "record-1", 1),
            an_update(Some(OP), "record-2", 2),
            an_update(Some(OTHER_OP), "record-3", 9),
        ];
        let history = zone_history(&log, &[], "zone-1", 0, now());

        assert_eq!(history.len(), 2, "two actions, not three: {history:?}");
        assert_eq!(history[0].operation_id, OTHER_OP, "newest operation first");
        assert_eq!(history[1].operation_id, OP);
        assert_eq!(
            history[1].entries.len(),
            2,
            "a bulk edit's rows nest under one operation"
        );
        assert_eq!(
            history[1]
                .entries
                .iter()
                .filter_map(|entry| entry.record_id.as_deref())
                .collect::<Vec<_>>(),
            vec!["record-1", "record-2"],
            "and in the order they were written, which is the order an undo replays them"
        );
    }

    #[test]
    fn an_entry_with_no_operation_id_is_an_operation_of_one() {
        let log = vec![
            an_update(None, "record-1", 1),
            an_update(None, "record-2", 2),
        ];
        let history = zone_history(&log, &[], "zone-1", 0, now());

        assert_eq!(
            history.len(),
            2,
            "two ungrouped entries are two actions, not one: {history:?}"
        );
        for operation in &history {
            assert!(
                operation.operation_id.starts_with("entry:"),
                "a synthesised group key must not look like a minted id: {}",
                operation.operation_id
            );
        }
    }

    #[test]
    fn another_zones_entries_are_not_in_this_zones_history() {
        let mut elsewhere = an_update(Some(OP), "record-1", 1);
        elsewhere["zone_id"] = json!("zone-2");
        let history = zone_history(&[elsewhere], &[], "zone-1", 0, now());
        assert!(history.is_empty(), "{history:?}");
    }

    #[test]
    fn an_operation_whose_rows_did_not_all_land_is_partial() {
        let mut failed = an_update(Some(OP), "record-2", 2);
        failed["outcome"] = json!("failed");
        let history = zone_history(
            &[an_update(Some(OP), "record-1", 1), failed.clone()],
            &[],
            "zone-1",
            0,
            now(),
        );
        assert_eq!(history[0].outcome, HistoryOutcome::Partial);

        let history = zone_history(&[failed], &[], "zone-1", 0, now());
        assert_eq!(
            history[0].outcome,
            HistoryOutcome::Failed,
            "an action where nothing landed is not partly done"
        );
    }

    #[test]
    fn a_page_is_filled_to_the_entry_budget_without_splitting_an_operation() {
        // Two operations of forty entries each. The first page cannot hold
        // exactly fifty without cutting one in half, so it holds forty.
        let log: Vec<Value> = (0..40)
            .map(|index| an_update(Some(OP), &format!("record-{index}"), 1))
            .chain((0..40).map(|index| an_update(Some(OTHER_OP), &format!("other-{index}"), 2)))
            .collect();

        let first = zone_history(&log, &[], "zone-1", 0, now());
        assert_eq!(first.len(), 1, "an operation is never split across a page");
        assert_eq!(first[0].entries.len(), 40);
        let second = zone_history(&log, &[], "zone-1", 1, now());
        assert_eq!(second.len(), 1);
        assert_ne!(second[0].operation_id, first[0].operation_id);
        assert!(
            zone_history(&log, &[], "zone-1", 2, now()).is_empty(),
            "an empty page is how the renderer learns there are no more"
        );
    }

    // ── Availability ────────────────────────────────────────────────────────

    #[test]
    fn an_edit_with_a_live_snapshot_can_be_undone() {
        let history = zone_history(
            &[an_update(Some(OP), "record-1", 1)],
            &[snapshot(Some(OP), "record-1", "203.0.113.1")],
            "zone-1",
            0,
            now(),
        );
        assert_eq!(history[0].entries[0].undo, UndoAvailability::Available);
    }

    #[test]
    fn an_entry_from_before_the_feature_says_no_snapshot_rather_than_expired() {
        let history = zone_history(&[an_update(None, "record-1", 1)], &[], "zone-1", 0, now());
        assert_eq!(
            history[0].entries[0].undo,
            UndoAvailability::NoSnapshot,
            "an entry that never had a snapshot did not lose one"
        );
    }

    #[test]
    fn a_snapshot_still_held_past_its_expiry_reports_the_date_it_expired() {
        let expired = RetainedRecord::of(&snapshot(Some(OP), "record-1", "203.0.113.1"))
            .expect("a fixture parses")
            .expiring_after(Some(1), now() - chrono::Duration::days(10))
            .into_value();
        let history = zone_history(
            &[an_update(Some(OP), "record-1", 1)],
            &[expired],
            "zone-1",
            0,
            now(),
        );
        match &history[0].entries[0].undo {
            UndoAvailability::Expired { expired_at } => assert!(
                !expired_at.is_empty(),
                "the user is told when, not merely that"
            ),
            other => panic!("expected expired, got {other:?}"),
        }
    }

    #[test]
    fn a_vanished_snapshot_is_expired_or_evicted_by_what_the_trail_recorded() {
        // The trail entry carries an expiry that has already passed, and the
        // store no longer holds the snapshot: it aged out and was swept.
        let mut aged = an_update(Some(OP), "record-1", 1);
        aged[trail::UNDO_EXPIRES_AT_KEY] = json!("2026-01-15T00:00:00+00:00");
        let history = zone_history(&[aged], &[], "zone-1", 0, now());
        assert_eq!(
            history[0].entries[0].undo,
            UndoAvailability::Expired {
                expired_at: "2026-01-15T00:00:00+00:00".to_string()
            },
            "a passed expiry is the one thing that distinguishes aged-out from thrown-away"
        );

        // Same entry, an expiry still in the future, and no snapshot. It was
        // given up early, which is eviction and a different sentence.
        let history = zone_history(
            &[an_update(Some(OP), "record-1", 1)],
            &[],
            "zone-1",
            0,
            now(),
        );
        assert_eq!(history[0].entries[0].undo, UndoAvailability::Evicted);
    }

    #[test]
    fn an_edit_to_a_record_deleted_since_is_superseded_by_that_delete() {
        let delete = entry(json!({
            "timestamp": at(5),
            "operation": "dns:delete",
            "resource": "record-1",
            "record_type": "A",
            "record_name": "www.example.com",
            trail::OPERATION_ID_KEY: OTHER_OP,
        }));
        let history = zone_history(
            &[an_update(Some(OP), "record-1", 1), delete],
            &[snapshot(Some(OP), "record-1", "203.0.113.1")],
            "zone-1",
            0,
            now(),
        );
        let edit = history
            .iter()
            .find(|operation| operation.operation_id == OP)
            .expect("the edit is still listed");
        assert_eq!(
            edit.entries[0].undo,
            UndoAvailability::SupersededByDelete,
            "putting an edit back on a deleted record would re-create it, not revert it"
        );
    }

    #[test]
    fn a_zone_setting_is_listed_with_a_reason_rather_than_hidden() {
        let setting = entry(json!({
            "timestamp": at(1),
            "operation": "zone_setting:update",
            "resource": "always_use_https",
            "value": "on",
        }));
        let history = zone_history(&[setting], &[], "zone-1", 0, now());

        assert_eq!(history.len(), 1, "it must appear at all: {history:?}");
        match &history[0].entries[0].undo {
            UndoAvailability::NotUndoable { reason } => {
                assert!(
                    reason.contains("settings"),
                    "a greyed-out button with no reason reads as a broken feature: {reason}"
                );
            }
            other => panic!("expected not-undoable, got {other:?}"),
        }
    }

    #[test]
    fn a_cache_purge_is_listed_and_says_why_it_cannot_be_undone() {
        let purge = entry(json!({
            "timestamp": at(1),
            "operation": "cache:purge",
            "resource": "zone-1",
        }));
        let history = zone_history(&[purge], &[], "zone-1", 0, now());
        assert_eq!(history.len(), 1, "it must appear at all: {history:?}");
        match &history[0].entries[0].undo {
            UndoAvailability::NotUndoable { reason } => assert!(
                reason.contains("cache"),
                "every refusal carries its own reason: {reason}"
            ),
            other => panic!("expected not-undoable, got {other:?}"),
        }
    }

    // ── Imports ─────────────────────────────────────────────────────────────

    fn an_import(created: usize) -> Value {
        entry(json!({
            "timestamp": at(1),
            "operation": "dns:bulk_create",
            "resource": "zone-1",
            "records": created,
            "created": created,
            trail::OPERATION_ID_KEY: OP,
        }))
    }

    /// The store entries one import's manifest occupies.
    ///
    /// `claimed` is what the operation created; `ids` is what the store still
    /// holds. The two differ when a part was evicted or purged, which is the
    /// case the completeness rule exists for.
    fn a_manifest(ids: &[&str], claimed: usize) -> Vec<Value> {
        retention::manifests_for_created_records(
            "zone-1",
            OP,
            ids,
            Some(30),
            now() - chrono::Duration::days(1),
        )
        .into_iter()
        .map(|mut part| {
            part.created_record_count = Some(claimed);
            part.into_value()
        })
        .collect()
    }

    #[test]
    fn an_import_whose_ids_were_all_kept_can_be_undone() {
        let history = zone_history(
            &[an_import(2)],
            &a_manifest(&["record-1", "record-2"], 2),
            "zone-1",
            0,
            now(),
        );
        assert_eq!(
            history[0].entries[0].undo,
            UndoAvailability::Available,
            "the record ids are in the manifest, which is the point of it"
        );
        assert_eq!(history[0].entries[0].kind, HistoryChangeKind::Created);
        assert_eq!(
            history[0].entries[0].record_id, None,
            "a batch entry's resource is the zone, and handing that back as a record id \
             is how the wrong record gets edited"
        );
    }

    #[test]
    fn an_import_too_large_to_record_fully_is_refused_by_name_not_half_applied() {
        let history = zone_history(
            &[an_import(412)],
            &a_manifest(&["record-1", "record-2"], 412),
            "zone-1",
            0,
            now(),
        );
        match &history[0].entries[0].undo {
            UndoAvailability::NotUndoable { reason } => {
                assert!(reason.contains("412"), "the user is told the scale: {reason}");
                assert!(
                    reason.contains('2'),
                    "and how much of it was kept: {reason}"
                );
            }
            other => panic!(
                "deleting part of an import and reporting success is the worst available                  outcome: {other:?}"
            ),
        }
    }

    #[test]
    fn an_import_with_no_manifest_left_says_the_undo_went_not_that_it_never_existed() {
        let history = zone_history(&[an_import(2)], &[], "zone-1", 0, now());
        assert_eq!(history[0].entries[0].undo, UndoAvailability::Evicted);
    }

    #[test]
    fn a_manifest_from_another_zone_is_not_borrowed() {
        let elsewhere: Vec<Value> = a_manifest(&["record-1"], 1)
            .into_iter()
            .map(|mut part| {
                part["zone_id"] = json!("zone-2");
                part
            })
            .collect();
        let history = zone_history(&[an_import(1)], &elsewhere, "zone-1", 0, now());
        assert_ne!(
            history[0].entries[0].undo,
            UndoAvailability::Available,
            "a manifest is addressed by operation id alone, so the zone has to be checked              or an undo deletes another zone's records"
        );
    }

    #[test]
    fn a_refused_write_is_listed_but_is_not_offered_an_undo() {
        let mut denied = an_update(Some(OP), "record-1", 1);
        denied["outcome"] = json!("denied");
        let history = zone_history(
            &[denied],
            &[snapshot(Some(OP), "record-1", "203.0.113.1")],
            "zone-1",
            0,
            now(),
        );
        match &history[0].entries[0].undo {
            UndoAvailability::NotUndoable { reason } => assert!(reason.contains("refused")),
            other => panic!("a refusal changed nothing, so there is nothing to undo: {other:?}"),
        }
    }

    #[test]
    fn a_create_needs_no_snapshot_because_its_undo_is_a_delete() {
        let created = entry(json!({
            "timestamp": at(1),
            "operation": "dns:create",
            "resource": "record-1",
            "record_type": "A",
            "record_name": "www.example.com",
            "record": { "content": "203.0.113.1", "ttl": 300 },
            trail::OPERATION_ID_KEY: OP,
        }));
        let history = zone_history(&[created], &[], "zone-1", 0, now());
        assert_eq!(
            history[0].entries[0].undo,
            UndoAvailability::Available,
            "an empty snapshot store must not stop a create being undone"
        );
    }

    #[test]
    fn a_delete_that_kept_a_copy_is_undoable_through_the_record_id_alone() {
        // The retaining path does not stamp an operation id yet, so the
        // snapshot is found by the record id. One candidate, so it is sound.
        let deleted = entry(json!({
            "timestamp": at(1),
            "operation": "dns:delete",
            "resource": "record-1",
            "record_type": "A",
            "record_name": "www.example.com",
        }));
        let history = zone_history(
            &[deleted],
            &[snapshot(None, "record-1", "203.0.113.1")],
            "zone-1",
            0,
            now(),
        );
        assert_eq!(history[0].entries[0].undo, UndoAvailability::Available);
        assert_eq!(
            history[0].entries[0].record_id, None,
            "Cloudflare destroyed the id, so the list does not hand one back"
        );
    }

    #[test]
    fn a_record_with_two_snapshots_and_no_operation_id_is_not_guessed_at() {
        let deleted = entry(json!({
            "timestamp": at(1),
            "operation": "dns:delete",
            "resource": "record-1",
            "record_type": "A",
            "record_name": "www.example.com",
        }));
        let history = zone_history(
            &[deleted],
            &[
                snapshot(None, "record-1", "203.0.113.1"),
                snapshot(None, "record-1", "203.0.113.2"),
            ],
            "zone-1",
            0,
            now(),
        );
        assert_ne!(
            history[0].entries[0].undo,
            UndoAvailability::Available,
            "two candidates and no way to choose must not resolve to a guess"
        );
    }

    // ── Entry ids ───────────────────────────────────────────────────────────

    #[test]
    fn an_entry_id_does_not_move_when_an_older_entry_is_evicted() {
        let log = vec![
            an_update(Some(OP), "record-1", 1),
            an_update(Some(OP), "record-2", 2),
        ];
        let before = zone_history(&log, &[], "zone-1", 0, now());
        let after = zone_history(&log[1..], &[], "zone-1", 0, now());

        let kept = before[0]
            .entries
            .iter()
            .find(|entry| entry.record_id.as_deref() == Some("record-2"))
            .expect("the surviving entry");
        assert_eq!(
            after[0].entries[0].id, kept.id,
            "an id derived from a position would renumber behind an eviction"
        );
    }

    #[test]
    fn two_entries_identical_in_every_recorded_field_still_get_distinct_ids() {
        let duplicate = an_update(Some(OP), "record-1", 1);
        let history = zone_history(&[duplicate.clone(), duplicate], &[], "zone-1", 0, now());
        let ids: HashSet<&str> = history[0]
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(ids.len(), 2, "two rows the user can select separately");
    }

    // ── Change sets ─────────────────────────────────────────────────────────

    #[test]
    fn a_change_set_is_rendered_with_both_sides_and_a_cleared_field_is_null() {
        let edit = entry(json!({
            "timestamp": at(1),
            "operation": "dns:update",
            "resource": "record-1",
            "record_type": "A",
            "record_name": "www.example.com",
            "changes": {
                "ttl": { "from": 300, "to": 1 },
                "comment": { "from": "note", "to": null },
            },
            trail::OPERATION_ID_KEY: OP,
        }));
        let history = zone_history(&[edit], &[], "zone-1", 0, now());
        let changes = &history[0].entries[0].changes;

        let ttl = changes
            .iter()
            .find(|change| change.field == "ttl")
            .expect("ttl changed");
        assert_eq!(ttl.from.as_deref(), Some("300"));
        assert_eq!(ttl.to.as_deref(), Some("1"));
        let comment = changes
            .iter()
            .find(|change| change.field == "comment")
            .expect("comment changed");
        assert_eq!(
            comment.to, None,
            "a field that became unset is null, not the string \"null\""
        );
    }

    #[test]
    fn an_entry_the_trail_truncated_says_so() {
        let edit = entry(json!({
            "timestamp": at(1),
            "operation": "dns:update",
            "resource": "record-1",
            "record_type": "TXT",
            "record_name": "mail.example.com",
            "changes": { "content": { "from": "a", "to": "b" } },
            "changes_omitted": 2,
            trail::OPERATION_ID_KEY: OP,
        }));
        let history = zone_history(&[edit], &[], "zone-1", 0, now());
        assert!(history[0].entries[0].changes_omitted);
    }

    // ── Drift ───────────────────────────────────────────────────────────────

    fn live(id: &str, content: &str) -> DNSRecord {
        DNSRecord {
            id: Some(id.to_string()),
            r#type: "A".to_string(),
            name: "www.example.com".to_string(),
            content: content.to_string(),
            comment: None,
            ttl: Some(300),
            priority: None,
            proxied: Some(false),
            zone_id: "zone-1".to_string(),
            zone_name: "example.com".to_string(),
            created_on: at(0),
            modified_on: at(0),
        }
    }

    fn zone_of(records: Vec<DNSRecord>, partial: bool) -> ZoneNow {
        let mut by_id = HashMap::new();
        let mut by_slot = HashMap::new();
        for record in records {
            by_slot.insert(
                (record.r#type.to_uppercase(), slot_name(&record.name)),
                record.clone(),
            );
            if let Some(id) = record.id.clone() {
                by_id.insert(id, record);
            }
        }
        ZoneNow {
            by_id,
            by_slot,
            partial,
        }
    }

    fn parsed(value: &Value) -> TrailEntry {
        let mut seen = HashMap::new();
        parse_entry(value, &mut seen)
    }

    fn target_of(content: &str) -> RetainedRecordSnapshotView {
        RetainedRecordSnapshotView {
            record_type: "A".to_string(),
            name: "www.example.com".to_string(),
            content: content.to_string(),
            ttl: Some(300),
            priority: None,
            proxied: Some(false),
            comment: None,
            tags: Vec::new(),
        }
    }

    #[test]
    fn an_edit_cloudflare_still_holds_is_unchanged_and_pre_selected() {
        let edit = parsed(&an_update(Some(OP), "record-1", 1));
        let zone = zone_of(vec![live("record-1", "203.0.113.9")], false);
        let drift = classify(
            &edit,
            HistoryChangeKind::Updated,
            Some(&target_of("203.0.113.1")),
            &zone,
        );
        assert_eq!(drift, UndoRowDrift::Unchanged);
    }

    #[test]
    fn an_edit_that_moved_again_is_changed_and_carries_what_is_there_now() {
        let edit = parsed(&an_update(Some(OP), "record-1", 1));
        let zone = zone_of(vec![live("record-1", "198.51.100.7")], false);
        match classify(
            &edit,
            HistoryChangeKind::Updated,
            Some(&target_of("203.0.113.1")),
            &zone,
        ) {
            UndoRowDrift::Changed { current } => {
                assert_eq!(current.content, "198.51.100.7");
            }
            other => panic!("expected changed, got {other:?}"),
        }
    }

    #[test]
    fn a_value_the_trail_shortened_is_changed_rather_than_assumed_unchanged() {
        // The recorded `to` ends in the truncation marker, so equality cannot
        // be established. Reporting `unchanged` here would pre-select the row
        // and overwrite whatever is actually in the record.
        let long = format!("v=DKIM1; p={}", "A".repeat(400));
        let mut edit_value = an_update(Some(OP), "record-1", 1);
        edit_value["changes"]["content"]["to"] =
            json!(format!("{}{}", &long[..100], trail::TRUNCATION_MARKER));
        let edit = parsed(&edit_value);
        let mut record = live("record-1", &long);
        record.r#type = "TXT".to_string();
        let zone = zone_of(vec![record], false);

        let drift = classify(
            &edit,
            HistoryChangeKind::Updated,
            Some(&target_of("old")),
            &zone,
        );
        assert!(
            matches!(drift, UndoRowDrift::Changed { .. }),
            "a prefix match is not a match: {drift:?}"
        );
    }

    #[test]
    fn a_row_whose_change_set_was_cut_short_is_changed_even_when_what_survived_matches() {
        // The case the truncation rule actually turns on. The trail ran out of
        // budget and dropped a field, so the entry records that `ttl` went to
        // 1 and says nothing about what else moved. The live record agrees
        // about the ttl — and reporting `unchanged` on that basis would
        // pre-select the row and write the old state over a field nobody
        // checked.
        let edit = parsed(&entry(json!({
            "timestamp": at(1),
            "operation": "dns:update",
            "resource": "record-1",
            "record_type": "A",
            "record_name": "www.example.com",
            "changes": { "ttl": { "from": 300, "to": 300 } },
            "changes_omitted": 1,
            trail::OPERATION_ID_KEY: OP,
        })));
        let zone = zone_of(vec![live("record-1", "203.0.113.9")], false);
        let drift = classify(
            &edit,
            HistoryChangeKind::Updated,
            Some(&target_of("203.0.113.1")),
            &zone,
        );
        assert!(
            matches!(drift, UndoRowDrift::Changed { .. }),
            "a change set missing a field cannot establish that nothing moved: {drift:?}"
        );
    }

    #[test]
    fn an_edit_whose_record_is_gone_is_absent_unless_the_name_is_taken() {
        let edit = parsed(&an_update(Some(OP), "record-1", 1));
        let empty = zone_of(Vec::new(), false);
        assert_eq!(
            classify(
                &edit,
                HistoryChangeKind::Updated,
                Some(&target_of("203.0.113.1")),
                &empty
            ),
            UndoRowDrift::Absent,
            "an update-undo for a missing record becomes a re-create"
        );

        let occupied = zone_of(vec![live("record-9", "203.0.113.5")], false);
        match classify(
            &edit,
            HistoryChangeKind::Updated,
            Some(&target_of("203.0.113.1")),
            &occupied,
        ) {
            UndoRowDrift::Conflict {
                conflicting_record_id,
            } => assert_eq!(conflicting_record_id, "record-9"),
            other => panic!("expected conflict, got {other:?}"),
        }
    }

    #[test]
    fn a_delete_undo_is_clean_when_nothing_has_taken_the_name() {
        let deleted = parsed(&entry(json!({
            "timestamp": at(1),
            "operation": "dns:delete",
            "resource": "record-1",
            "record_type": "A",
            "record_name": "www.example.com",
        })));
        assert_eq!(
            classify(
                &deleted,
                HistoryChangeKind::Deleted,
                Some(&target_of("203.0.113.1")),
                &zone_of(Vec::new(), false)
            ),
            UndoRowDrift::Unchanged
        );
    }

    #[test]
    fn a_delete_undo_whose_record_still_resolves_is_changed_not_duplicated() {
        let deleted = parsed(&entry(json!({
            "timestamp": at(1),
            "operation": "dns:delete",
            "resource": "record-1",
            "record_type": "A",
            "record_name": "www.example.com",
        })));
        match classify(
            &deleted,
            HistoryChangeKind::Deleted,
            Some(&target_of("203.0.113.1")),
            &zone_of(vec![live("record-1", "203.0.113.1")], false),
        ) {
            UndoRowDrift::Changed { .. } => {}
            other => {
                panic!("re-creating a record that is still there would duplicate it: {other:?}")
            }
        }
    }

    #[test]
    fn a_name_compares_case_insensitively_and_ignores_a_trailing_dot() {
        let deleted = parsed(&entry(json!({
            "timestamp": at(1),
            "operation": "dns:delete",
            "resource": "record-1",
            "record_type": "a",
            "record_name": "WWW.Example.com.",
        })));
        let mut occupant = live("record-9", "203.0.113.5");
        occupant.name = "WWW.Example.com.".to_string();
        match classify(
            &deleted,
            HistoryChangeKind::Deleted,
            Some(&target_of("203.0.113.1")),
            &zone_of(vec![occupant], false),
        ) {
            UndoRowDrift::Conflict { .. } => {}
            other => panic!("one name spelled two ways is still one name: {other:?}"),
        }
    }

    #[test]
    fn a_create_undo_is_absent_once_the_record_has_already_gone() {
        let created = parsed(&entry(json!({
            "timestamp": at(1),
            "operation": "dns:create",
            "resource": "record-1",
            "record_type": "A",
            "record_name": "www.example.com",
            "record": { "content": "203.0.113.1", "ttl": 300 },
            trail::OPERATION_ID_KEY: OP,
        })));
        assert_eq!(
            classify(
                &created,
                HistoryChangeKind::Created,
                None,
                &zone_of(Vec::new(), false)
            ),
            UndoRowDrift::Absent
        );
        assert_eq!(
            classify(
                &created,
                HistoryChangeKind::Created,
                None,
                &zone_of(vec![live("record-1", "203.0.113.1")], false)
            ),
            UndoRowDrift::Unchanged,
            "the record that was created is still the record that is there"
        );
    }

    // ── Plan rows ───────────────────────────────────────────────────────────

    #[test]
    fn a_plan_row_names_the_record_to_write_over() {
        // The renderer builds the reverse operation itself, and an update it
        // cannot address is an update it cannot make. `null` has to mean "the
        // reverse is a create", never "we did not look".
        let edit = parsed(&an_update(Some(OP), "record-1", 1));
        let row = plan_row(
            &edit,
            HistoryChangeKind::Updated,
            Some(target_of("203.0.113.1")),
            &zone_of(vec![live("record-1", "203.0.113.9")], false),
        );
        assert_eq!(row.record_id.as_deref(), Some("record-1"));
        assert_eq!(row.drift, UndoRowDrift::Unchanged);
        assert!(row.selected_by_default);
        assert_eq!(
            row.target.expect("the state to put back").content,
            "203.0.113.1",
            "the exact pre-edit state, out of the store and not out of the trail"
        );
    }

    #[test]
    fn a_plan_row_for_a_record_that_has_gone_offers_no_id_to_write_over() {
        let edit = parsed(&an_update(Some(OP), "record-1", 1));
        let row = plan_row(
            &edit,
            HistoryChangeKind::Updated,
            Some(target_of("203.0.113.1")),
            &zone_of(Vec::new(), false),
        );
        assert_eq!(
            row.record_id, None,
            "there is nothing to update, so the reverse operation is a create"
        );
        assert_eq!(row.drift, UndoRowDrift::Absent);
        assert!(!row.selected_by_default);
    }

    #[test]
    fn a_plan_row_for_a_deletion_carries_the_snapshot_and_no_id() {
        let deleted = parsed(&entry(json!({
            "timestamp": at(1),
            "operation": "dns:delete",
            "resource": "record-1",
            "record_type": "A",
            "record_name": "www.example.com",
        })));
        let row = plan_row(
            &deleted,
            HistoryChangeKind::Deleted,
            Some(target_of("203.0.113.1")),
            &zone_of(Vec::new(), false),
        );
        assert_eq!(
            row.record_id, None,
            "Cloudflare destroyed the id, so the reverse operation is a create"
        );
        assert_eq!(row.drift, UndoRowDrift::Unchanged);
        assert_eq!(
            row.target.expect("the record to re-create").name,
            "www.example.com"
        );
    }

    #[test]
    fn only_an_unchanged_row_is_pre_selected() {
        assert!(
            selected_by_default(&UndoRowDrift::Unchanged),
            "a clean revert is the one thing the user should not have to tick"
        );
        for drift in [
            UndoRowDrift::Absent,
            UndoRowDrift::Changed {
                current: target_of("203.0.113.5"),
            },
            UndoRowDrift::Conflict {
                conflicting_record_id: "record-9".to_string(),
            },
        ] {
            assert!(
                !selected_by_default(&drift),
                "{drift:?} writes something the change did not, so it is the user's call"
            );
        }
    }
}
