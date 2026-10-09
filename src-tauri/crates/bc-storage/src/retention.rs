//! Records that are **gone from Cloudflare** and kept here so they can be put
//! back.
//!
//! # Cloudflare has no disabled state
//!
//! A Cloudflare DNS record either exists or it does not. There is no flag that
//! parks one, no `enabled: false`, nothing the API will accept that makes a
//! record stop answering while staying in the zone. So "disable this record"
//! can only be implemented one way: delete it from Cloudflare, keep a complete
//! copy here, and create it again on re-enable.
//!
//! Everything in this module is named for that truth. There is no
//! `DisabledRecord`, because nothing is disabled anywhere — there is a
//! [`RetainedRecord`], which is a record this application removed from a
//! provider and retained locally, and whose
//! [`removed_from_provider_at`](RetainedRecord::removed_from_provider_at) says
//! when it stopped resolving. A reader who only ever sees these names cannot
//! come away believing a dormant record is sitting in the zone.
//!
//! The consequences are the user's to understand, and the UI has to say them:
//! a disabled record does not resolve, it is invisible to `dig` and to the
//! Cloudflare dashboard, its id is gone forever, and if this application's
//! store is lost the record is lost with it. It is a backup, not a toggle.
//!
//! # One store, three intents
//!
//! A deletion and a disable are the same mechanism — removed there, retained
//! here — so they share one store and differ only in
//! [`reason`](RetainedRecord::reason) and lifetime:
//!
//! * `disabled` is indefinite and meant to be reversed. It has no expiry.
//! * `deleted` is a recycle-bin entry. It carries an
//!   [`expires_at`](RetainedRecord::expires_at) stamped when it was binned.
//! * `superseded` is the state an edited record held before the edit, kept so
//!   the edit can be undone. It expires like a bin entry.
//!
//! Two stores would drift: the restore path, the conflict rules, the byte
//! budget and the audit entries are identical for both, and only one of them
//! would get the next bug fix.
//!
//! `superseded` is the one reason where the module's opening sentence needs
//! reading carefully. The *record* is not gone from Cloudflare — it is still
//! there, under its new values. What is gone is the **state** it used to hold,
//! and that state exists nowhere but here, which is why it belongs in this
//! store and not in the audit trail: the trail shortens values to stay inside
//! a log's budget, and a shortened `from` value restores a record that is
//! subtly not the one that was there. Everything else in the module applies
//! unchanged, because putting a state back is the same operation as putting a
//! record back.
//!
//! A `superseded` entry is therefore the *least* precious thing in the store:
//! losing it costs the ability to revert an edit, where losing a `deleted`
//! entry loses the only copy of a record that exists nowhere at all. Eviction
//! takes them in that order — see [`evict_to_cap`].
//!
//! # The one entry that is not a record
//!
//! Undoing a bulk *create* is the other direction: nothing was removed, so
//! there is no state to keep — what is needed is the list of record ids the
//! operation created, so they can be deleted again. Those ids cannot live in
//! the audit trail, which writes one entry per bulk operation inside a 768-byte
//! detail budget, and they must not be one retention entry per record, which
//! would spend four hundred of the store's thousand slots on a single import
//! and starve the recycle bin they share.
//!
//! So an [`OperationManifest`] is one entry per operation, holding the zone,
//! the operation id and the ids. It is a different shape from a
//! [`RetainedRecord`] and deliberately a different type: it has no snapshot,
//! nothing about it can be restored, and giving it its own struct is what stops
//! [`RetainedRecord::of`] producing a record with an empty name from it and
//! [`is_restorable`](RetainedRecord::is_restorable) ever being asked. It shares
//! the entry id, the reason, the zone id, the operation id and the expiry keys,
//! so the store's addressing, purging and eviction all work on it unchanged.
//!
//! A large import is written as several manifests, because the import size one
//! entry refuses is exactly the size a user cannot undo by hand — see
//! [`manifests_for_created_records`] — and read back as one
//! [`CreatedRecords`]. What cannot be held says so rather than being quietly
//! left out: [`CreatedRecords::is_complete`] is `false` and
//! [`omitted`](CreatedRecords::omitted) says how many records are missing. Half
//! an undo — deleting two hundred of four hundred imported records and
//! reporting success — is worse than no undo, so a reader refuses it by name.
//!
//! # Expiry is a property of the entry, not of the settings
//!
//! `expires_at` is computed once, from the retention setting in force at the
//! moment the record was binned, and then never recomputed. [`purge_expired`]
//! needs only a clock. That means the date the UI showed the user is the date
//! the purge honours, and lowering the retention setting cannot retroactively
//! destroy something the application had promised to keep for longer. Raising
//! it does not extend existing entries either; a caller that wants that has to
//! rewrite them deliberately.
//!
//! Every function that cares what time it is takes `now` as an argument, the
//! way `bc_notify` does, so a thirty-day expiry is testable in a millisecond.
//!
//! # Forward compatibility
//!
//! Entries are parsed field by field out of a `serde_json::Value`, never
//! through a derived `Deserialize`, and [`RetainedRecord::of`] fails only on a
//! value that is not a JSON object. Every field is optional and has a defined
//! meaning when absent, so an entry written by a newer build — extra fields, a
//! `reason` this build has never heard of — round-trips intact and behaves
//! sanely rather than taking the whole bin down with it. Unrecognised keys are
//! held in [`RetainedRecord::extra`] and written back verbatim.

use chrono::{DateTime, Duration, Utc};
use serde_json::{Map, Number, Value};
use std::cmp::Reverse;
use std::collections::HashMap;

use super::MAX_SECRET_BYTES;

// ── Bounds ──────────────────────────────────────────────────────────────────

/// Entries the store may hold.
///
/// A ceiling on *count* as well as on bytes, because the two protect against
/// different things: the byte cap stops a handful of enormous TXT records from
/// filling the secret, and this stops a script that deletes ten thousand small
/// records from turning every later write into a thousand-element re-serialise.
pub const MAX_RETAINED_ENTRIES: usize = 1_000;

/// The floor a user may configure [`MAX_RETAINED_ENTRIES`] down to.
///
/// Ten rather than one: a bin that holds a single entry is a bin that loses the
/// record you deleted immediately before the one you meant to undo.
pub const MIN_RETAINED_ENTRY_LIMIT: usize = 10;

/// Entries one read — [`snapshots_for_zone`], [`snapshots_for_operation`] —
/// may return, whatever the caller asks for.
///
/// Equal to [`MAX_RETAINED_ENTRIES`] on purpose, so it cannot shorten the
/// answer a well-formed store gives: the store holds no more than that in the
/// first place. The bound is here for the store that somehow holds more — hand
/// edited into the keyring, or written by a build with wider limits — so a read
/// cannot be made to parse and return without limit. It is deliberately *not* a smaller
/// paging number: an undo handed half of an operation's snapshots is worse than
/// an undo that is refused, so the only thing allowed to shorten a read is a
/// `limit` a caller passed knowing what it meant.
pub const MAX_RETAINED_READ_ENTRIES: usize = MAX_RETAINED_ENTRIES;

/// Bytes the whole serialised store may occupy, punctuation included.
///
/// Well under [`MAX_SECRET_BYTES`] on purpose. The gap is not slack, it is the
/// reason a full bin cannot make a write fail: the store is checked against
/// this before it is handed to a layer that enforces the harder limit.
pub const MAX_RETAINED_BYTES: usize = 1_500_000;

/// Bytes one serialised entry may occupy.
pub const MAX_RETAINED_ENTRY_BYTES: usize = 12_288;

/// Serialised bytes one short text field may occupy, quotes included.
///
/// A fully qualified DNS name is at most 253 bytes, and a zone id, a record id
/// and a record type all fit comfortably inside that.
pub const MAX_RETAINED_TEXT_BYTES: usize = 258;

/// Serialised bytes a record's content may occupy.
///
/// Sized for the longest thing anybody actually stores in DNS: a DKIM public
/// key or a long SPF chain in a TXT record.
pub const MAX_RETAINED_CONTENT_BYTES: usize = 4_098;

/// Serialised bytes a record's comment may occupy.
pub const MAX_RETAINED_COMMENT_BYTES: usize = 514;

/// Local tags one entry may carry. Matches the per-record tag cap the browser
/// preference store applies (`src/lib/storage/storage.ts`).
pub const MAX_RETAINED_TAGS: usize = 32;

/// Serialised bytes one local tag may occupy. Matches `MAX_TAG_BYTES` in
/// `src/lib/storage/storage.ts`, plus its quotes.
pub const MAX_RETAINED_TAG_BYTES: usize = 130;

/// Serialised bytes the unrecognised-field passthrough may occupy.
///
/// A budget rather than "whatever a newer build sends", because an entry this
/// build cannot interpret still has to fit the ceiling this build enforces.
/// Over-budget keys are dropped, which loses a newer build's extra data; the
/// alternative is a store a newer build can render unwritable, which loses
/// everybody's.
pub const MAX_RETAINED_EXTRA_BYTES: usize = 1_024;

/// Record ids one [`OperationManifest`] may list.
///
/// Two hundred is what the per-entry ceiling affords once the manifest's own
/// fields and the passthrough budget are paid for — the const assertion below
/// pins it. An import larger than this is still *recorded*: the manifest keeps
/// how many records the operation created, so a reader sees that it lists 200
/// of 412 and refuses the undo by name, instead of deleting part of an import
/// and reporting success.
pub const MAX_MANIFEST_RECORD_IDS: usize = 200;

/// Serialised bytes one record id in a manifest may occupy, quotes included.
///
/// A Cloudflare DNS record id is 32 hexadecimal characters; the headroom is for
/// a provider that is less tidy. An id that does not fit is left **out** of the
/// list and counted as omitted rather than truncated to fit: half an id is not
/// an id, and an undo must never issue a delete against a guess.
pub const MAX_MANIFEST_RECORD_ID_BYTES: usize = 42;

/// Manifests one operation may be written as.
///
/// A 412-record import is three of them, which is three slots out of a
/// thousand — cheap for making the undo that matters most actually work. Eight
/// is 1,600 ids and about 72KB of the 1.5MB store, and beyond it an operation
/// is recorded but visibly incomplete: the count still says what the import
/// created, so a reader refuses the undo and names the gap. Raising it is one
/// line and costs slots the recycle bin would otherwise have.
pub const MAX_MANIFEST_PARTS: usize = 8;

/// Days a recycle-bin entry is kept, unless configured otherwise.
pub const DEFAULT_RETENTION_DAYS: u32 = 30;

/// The shortest configurable retention. A day, not an hour: anything smaller
/// is a bin that is empty by the time the user thinks to look in it.
pub const MIN_RETENTION_DAYS: u32 = 1;

/// The longest configurable retention. A year of deleted DNS records is
/// already far past the point where restoring one is a good idea.
pub const MAX_RETENTION_DAYS: u32 = 365;

/// Worst case for the fixed part of an entry: every known key, the JSON
/// punctuation around it, the entry id, both timestamps, and the three numeric
/// fields.
const RETAINED_OVERHEAD_BYTES: usize = 334;

/// Serialised bytes a full tag list occupies: the tags, their commas, and the
/// brackets.
const RETAINED_TAGS_BYTES: usize = MAX_RETAINED_TAGS * MAX_RETAINED_TAG_BYTES + MAX_RETAINED_TAGS;

/// The seven short text fields: `reason`, `zone_id`, `zone_name`,
/// `origin_record_id`, `operation_id`, `type` and `name`.
const RETAINED_TEXT_FIELDS: usize = 7;

const _: () = assert!(
    RETAINED_OVERHEAD_BYTES
        + RETAINED_TEXT_FIELDS * MAX_RETAINED_TEXT_BYTES
        + MAX_RETAINED_CONTENT_BYTES
        + MAX_RETAINED_COMMENT_BYTES
        + RETAINED_TAGS_BYTES
        + MAX_RETAINED_EXTRA_BYTES
        <= MAX_RETAINED_ENTRY_BYTES,
    "the widest entry the builder can make must fit the per-entry ceiling"
);
/// Worst case for the fixed part of a manifest: every key it writes, the JSON
/// punctuation around it, the entry id, both timestamps and the count.
const MANIFEST_OVERHEAD_BYTES: usize = 250;

/// The three short text fields a manifest carries: `reason`, `zone_id` and
/// `operation_id`.
const MANIFEST_TEXT_FIELDS: usize = 3;

/// Serialised bytes a full id list occupies: the ids, their commas, and the
/// brackets.
const MANIFEST_IDS_BYTES: usize =
    MAX_MANIFEST_RECORD_IDS * MAX_MANIFEST_RECORD_ID_BYTES + MAX_MANIFEST_RECORD_IDS;

const _: () = assert!(
    MANIFEST_OVERHEAD_BYTES
        + MANIFEST_TEXT_FIELDS * MAX_RETAINED_TEXT_BYTES
        + MANIFEST_IDS_BYTES
        + MAX_RETAINED_EXTRA_BYTES
        <= MAX_RETAINED_ENTRY_BYTES,
    "the widest manifest the builder can make must fit the per-entry ceiling"
);
const _: () = assert!(
    MAX_RETAINED_ENTRY_BYTES <= MAX_RETAINED_BYTES,
    "one maximal entry must always fit the store, or retaining is impossible"
);
const _: () = assert!(
    // The array punctuation: one comma per entry after the first, plus the
    // brackets. Charged separately because the per-entry ceiling does not
    // include it.
    MAX_RETAINED_BYTES + MAX_RETAINED_ENTRIES + 2 <= MAX_SECRET_BYTES,
    "a full store, punctuation included, must fit one stored secret"
);
const _: () = assert!(
    MIN_RETAINED_ENTRY_LIMIT <= MAX_RETAINED_ENTRIES,
    "the configurable floor must sit under the hard ceiling"
);
const _: () = assert!(
    MIN_RETENTION_DAYS <= DEFAULT_RETENTION_DAYS && DEFAULT_RETENTION_DAYS <= MAX_RETENTION_DAYS,
    "the default retention must be configurable"
);

// ── Wire keys ───────────────────────────────────────────────────────────────

/// `type`, `name`, `content`, `ttl`, `priority`, `proxied` and `comment` are
/// spelled exactly as Cloudflare spells them, at the top level of the entry, so
/// the create path can be handed the entry itself rather than a translation of
/// it. A translation is a place for a field to go missing.
const KEY_ENTRY_ID: &str = "entry_id";
const KEY_REASON: &str = "reason";
const KEY_ZONE_ID: &str = "zone_id";
const KEY_ZONE_NAME: &str = "zone_name";
const KEY_ORIGIN_RECORD_ID: &str = "origin_record_id";
const KEY_OPERATION_ID: &str = "operation_id";
const KEY_REMOVED_AT: &str = "removed_from_provider_at";
const KEY_EXPIRES_AT: &str = "expires_at";
const KEY_TYPE: &str = "type";
const KEY_NAME: &str = "name";
const KEY_CONTENT: &str = "content";
const KEY_TTL: &str = "ttl";
const KEY_PRIORITY: &str = "priority";
const KEY_PROXIED: &str = "proxied";
const KEY_COMMENT: &str = "comment";
const KEY_LOCAL_TAGS: &str = "local_tags";

/// Every key this build understands. Anything else in a stored entry is a
/// newer build's business and is preserved untouched.
const KNOWN_KEYS: [&str; 16] = [
    KEY_ENTRY_ID,
    KEY_REASON,
    KEY_ZONE_ID,
    KEY_ZONE_NAME,
    KEY_ORIGIN_RECORD_ID,
    KEY_OPERATION_ID,
    KEY_REMOVED_AT,
    KEY_EXPIRES_AT,
    KEY_TYPE,
    KEY_NAME,
    KEY_CONTENT,
    KEY_TTL,
    KEY_PRIORITY,
    KEY_PROXIED,
    KEY_COMMENT,
    KEY_LOCAL_TAGS,
];

/// An [`OperationManifest`]'s own keys.
///
/// It shares `entry_id`, `reason`, `zone_id`, `operation_id` and `expires_at`
/// with a retained record, which is what lets the store address, purge and
/// evict it without knowing the difference. It does not share
/// `removed_from_provider_at`: nothing was removed from the provider, records
/// were added to it, and a manifest stamped with a key that says otherwise
/// would be a lie in the one module that is careful about this.
const KEY_CREATED_RECORD_IDS: &str = "created_record_ids";
const KEY_CREATED_RECORD_COUNT: &str = "created_record_count";
const KEY_RECORDED_AT: &str = "recorded_at";

const MANIFEST_KNOWN_KEYS: [&str; 8] = [
    KEY_ENTRY_ID,
    KEY_REASON,
    KEY_ZONE_ID,
    KEY_OPERATION_ID,
    KEY_RECORDED_AT,
    KEY_EXPIRES_AT,
    KEY_CREATED_RECORD_IDS,
    KEY_CREATED_RECORD_COUNT,
];

// ── Reasons ─────────────────────────────────────────────────────────────────

/// Why a record is gone from the provider.
///
/// The stored value is the raw string, so an entry keeps whatever a newer build
/// wrote. This is the view this build takes of it, and
/// [`RetentionReason::Unknown`] is a first-class answer rather than an error:
/// nothing in this module branches on the reason except the words it shows and
/// the order eviction considers entries in, and both have a safe default.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum RetentionReason {
    /// Removed so it would stop resolving, indefinitely, meaning to put it
    /// back. No expiry.
    Disabled,
    /// Removed because the user deleted it. Expires.
    Deleted,
    /// The state the record held before an edit, kept so the edit can be
    /// undone. Expires.
    ///
    /// The record itself is still at the provider, under its new values, so
    /// [`removed_from_provider_at`](RetainedRecord::removed_from_provider_at)
    /// reads as *when this state stopped being what the provider held* rather
    /// than when the record stopped resolving. Nothing about the record is
    /// unrecoverable if this entry is lost — only the revert is — which is why
    /// it is the first thing eviction gives up.
    Superseded,
    /// Not a record at all: an [`OperationManifest`], listing the record ids a
    /// bulk create produced so the create can be undone. Expires.
    ///
    /// Expendable, and given up after a superseded snapshot but before a
    /// binned record. Losing it costs the undo of a create, which is a
    /// reconstructible thing in principle and never the record data itself;
    /// but one manifest covers a whole import, so evicting one destroys more
    /// undo per slot freed than evicting one edit's snapshot does.
    Manifest,
    /// A reason this build does not know. Treated like [`Self::Disabled`]:
    /// never preferred as an eviction victim, and purged only if the entry
    /// carries an expiry it can be held to.
    Unknown,
}

impl RetentionReason {
    /// The stored spelling of `disabled`.
    pub const DISABLED: &'static str = "disabled";
    /// The stored spelling of `deleted`.
    pub const DELETED: &'static str = "deleted";
    /// The stored spelling of `superseded`.
    pub const SUPERSEDED: &'static str = "superseded";
    /// The stored spelling of an operation manifest's reason.
    pub const MANIFEST: &'static str = "operation_manifest";

    /// The reason a stored string names.
    ///
    /// An absent, empty or unrecognised reason reads as [`Self::Unknown`], and
    /// unknown is protected rather than expendable — over-retaining a record
    /// this build cannot classify is the safe direction to be wrong in, because
    /// the record exists nowhere else.
    pub fn of(raw: &str) -> Self {
        match raw {
            Self::DISABLED => Self::Disabled,
            Self::DELETED => Self::Deleted,
            Self::SUPERSEDED => Self::Superseded,
            Self::MANIFEST => Self::Manifest,
            _ => Self::Unknown,
        }
    }

    /// Whether an entry with this reason is given up before one that is
    /// indefinite. See [`evict_to_cap`].
    ///
    /// All three dated reasons are expendable, and they are not equally so:
    /// see [`evict_to_cap`] for the order between them. This answers only "may
    /// it ever be given up", which is the question [`is_protected`] and
    /// [`fits_after_eviction`] ask.
    pub const fn is_expendable(self) -> bool {
        matches!(self, Self::Deleted | Self::Superseded | Self::Manifest)
    }
}

// ── Entries ─────────────────────────────────────────────────────────────────

/// What the create path needs to make the record again.
///
/// Exactly the fields `bc_cloudflare_api::DNSRecordInput` carries, because a
/// field retained here that the create path cannot send is a field that only
/// looks preserved.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RecordSnapshot {
    pub record_type: String,
    pub name: String,
    pub content: String,
    pub ttl: Option<u32>,
    pub priority: Option<u16>,
    pub proxied: Option<bool>,
    pub comment: Option<String>,
}

/// One record that was removed from a provider and kept here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetainedRecord {
    /// This entry's identity, generated here.
    ///
    /// The provider's record id cannot serve: it dies with the record and a
    /// restore mints a new one, so anything keyed on it breaks exactly when the
    /// feature is used. Callers address entries by this.
    pub entry_id: String,
    /// The raw stored reason. [`Self::reason_kind`] is this build's reading of
    /// it; the string is what round-trips.
    pub reason: String,
    pub zone_id: String,
    pub zone_name: String,
    /// The id the record had at the provider before it was removed.
    ///
    /// Dead the moment the record is gone, and *not* the id it will have after
    /// a restore. Kept only so the audit trail and the UI can say which record
    /// this used to be.
    pub origin_record_id: Option<String>,
    /// The one user action this entry came out of. A UUID v4 string, shared by
    /// every entry that action produced.
    ///
    /// This is what lets a bulk edit of thirty-seven records be undone as one
    /// unit instead of thirty-seven: [`snapshots_for_operation`] takes the id
    /// and hands back the whole group. A single-record edit is an operation of
    /// one, so there is no second code path.
    ///
    /// `None` for every entry written before this field existed, and for any
    /// caller that does not group its writes. Those entries list and restore
    /// exactly as they always did; they just cannot be addressed as a group,
    /// which the UI reports rather than hides (`UndoAvailability` in
    /// `src/lib/history/types.ts`).
    pub operation_id: Option<String>,
    /// When the record stopped existing at the provider. `None` for an entry
    /// that did not record it, or recorded something unparseable.
    ///
    /// For [`RetentionReason::Superseded`], when the state in
    /// [`snapshot`](Self::snapshot) stopped being what the provider held: the
    /// record is still there, under its new values.
    pub removed_from_provider_at: Option<DateTime<Utc>>,
    /// When this entry may be purged. `None` means never, which is what an
    /// indefinite disable stores and also what an unreadable expiry degrades
    /// to — a date this build cannot read is not a licence to delete.
    pub expires_at: Option<DateTime<Utc>>,
    pub snapshot: RecordSnapshot,
    /// This application's own tags for the record, which live outside
    /// Cloudflare and are keyed by the record id that is about to die. Retained
    /// here so a restore can re-attach them to the new id.
    pub local_tags: Vec<String>,
    /// Keys a newer build wrote that this one does not understand, preserved so
    /// that build still finds them.
    pub extra: Map<String, Value>,
}

impl RetainedRecord {
    /// Open an entry. `reason` is [`RetentionReason::DISABLED`],
    /// [`RetentionReason::DELETED`], [`RetentionReason::SUPERSEDED`], or
    /// whatever a future build uses.
    pub fn new(reason: &str, zone_id: &str, zone_name: &str) -> Self {
        Self {
            entry_id: format!("ret_{}", uuid::Uuid::new_v4()),
            reason: bounded_text(reason, MAX_RETAINED_TEXT_BYTES),
            zone_id: bounded_text(zone_id, MAX_RETAINED_TEXT_BYTES),
            zone_name: bounded_text(zone_name, MAX_RETAINED_TEXT_BYTES),
            origin_record_id: None,
            operation_id: None,
            removed_from_provider_at: None,
            expires_at: None,
            snapshot: RecordSnapshot::default(),
            local_tags: Vec::new(),
            extra: Map::new(),
        }
    }

    /// This build's reading of [`Self::reason`].
    pub fn reason_kind(&self) -> RetentionReason {
        RetentionReason::of(&self.reason)
    }

    #[must_use]
    pub fn origin_record_id(mut self, record_id: &str) -> Self {
        self.origin_record_id = Some(bounded_text(record_id, MAX_RETAINED_TEXT_BYTES));
        self
    }

    /// Stamp the user action this entry belongs to.
    ///
    /// The caller mints one id per action and passes the same one to every
    /// entry that action produces — that is the whole mechanism behind "undo
    /// all". A blank id is stored as no id at all rather than as an empty
    /// group key, so [`snapshots_for_operation`] cannot be made to return a
    /// pile of unrelated entries by asking it for `""`.
    #[must_use]
    pub fn operation_id(mut self, operation_id: &str) -> Self {
        let operation_id = bounded_text(operation_id, MAX_RETAINED_TEXT_BYTES);
        self.operation_id = if operation_id.trim().is_empty() {
            None
        } else {
            Some(operation_id)
        };
        self
    }

    #[must_use]
    pub fn snapshot(mut self, snapshot: RecordSnapshot) -> Self {
        self.snapshot = RecordSnapshot {
            record_type: bounded_text(&snapshot.record_type, MAX_RETAINED_TEXT_BYTES),
            name: bounded_text(&snapshot.name, MAX_RETAINED_TEXT_BYTES),
            content: bounded_text(&snapshot.content, MAX_RETAINED_CONTENT_BYTES),
            ttl: snapshot.ttl,
            priority: snapshot.priority,
            proxied: snapshot.proxied,
            comment: snapshot
                .comment
                .map(|comment| bounded_text(&comment, MAX_RETAINED_COMMENT_BYTES)),
        };
        self
    }

    #[must_use]
    pub fn local_tags<S: AsRef<str>>(mut self, tags: &[S]) -> Self {
        self.local_tags = tags
            .iter()
            .map(|tag| bounded_text(tag.as_ref(), MAX_RETAINED_TAG_BYTES))
            .filter(|tag| !tag.trim().is_empty())
            .take(MAX_RETAINED_TAGS)
            .collect();
        self
    }

    /// Stamp the moment the record stopped existing at the provider.
    #[must_use]
    pub fn removed_at(mut self, now: DateTime<Utc>) -> Self {
        self.removed_from_provider_at = Some(now);
        self
    }

    /// Set the expiry from a retention window, measured from
    /// [`Self::removed_at`] (or from `now` if that was never stamped).
    ///
    /// `None` days means no expiry, which is what a disable wants. `days` is
    /// clamped to [`MIN_RETENTION_DAYS`]..=[`MAX_RETENTION_DAYS`] here, so a
    /// caller cannot hand the store a zero-day or a thousand-year window
    /// however its own settings got mangled.
    #[must_use]
    pub fn expiring_after(mut self, days: Option<u32>, now: DateTime<Utc>) -> Self {
        self.expires_at = days.map(|days| {
            let from = self.removed_from_provider_at.unwrap_or(now);
            from + Duration::days(i64::from(clamp_retention_days(days)))
        });
        self
    }

    /// Whether this entry's expiry has passed.
    ///
    /// An entry with no expiry is never expired, however old it is.
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at.is_some_and(|expires_at| expires_at <= now)
    }

    /// Serialise into the flat object the store holds.
    ///
    /// Absent optional fields are left out rather than written as `null`: a
    /// reader should not have to tell "there was no comment" from "nobody
    /// looked". The result is bounded by [`MAX_RETAINED_ENTRY_BYTES`] by
    /// construction — every text field was bounded on the way in and the
    /// const assertions above pin the sum — and `extra` is spent last so an
    /// over-budget newer field is what gets dropped, never an identifying one.
    pub fn into_value(self) -> Value {
        let mut map = Map::new();
        insert_text(&mut map, KEY_ENTRY_ID, &self.entry_id);
        insert_text(&mut map, KEY_REASON, &self.reason);
        insert_text(&mut map, KEY_ZONE_ID, &self.zone_id);
        insert_text(&mut map, KEY_ZONE_NAME, &self.zone_name);
        if let Some(record_id) = &self.origin_record_id {
            insert_text(&mut map, KEY_ORIGIN_RECORD_ID, record_id);
        }
        if let Some(operation_id) = &self.operation_id {
            insert_text(&mut map, KEY_OPERATION_ID, operation_id);
        }
        if let Some(removed_at) = self.removed_from_provider_at {
            insert_text(&mut map, KEY_REMOVED_AT, &removed_at.to_rfc3339());
        }
        if let Some(expires_at) = self.expires_at {
            insert_text(&mut map, KEY_EXPIRES_AT, &expires_at.to_rfc3339());
        }
        insert_text(&mut map, KEY_TYPE, &self.snapshot.record_type);
        insert_text(&mut map, KEY_NAME, &self.snapshot.name);
        insert_text(&mut map, KEY_CONTENT, &self.snapshot.content);
        if let Some(ttl) = self.snapshot.ttl {
            map.insert(KEY_TTL.to_string(), Value::Number(Number::from(ttl)));
        }
        if let Some(priority) = self.snapshot.priority {
            map.insert(
                KEY_PRIORITY.to_string(),
                Value::Number(Number::from(priority)),
            );
        }
        if let Some(proxied) = self.snapshot.proxied {
            map.insert(KEY_PROXIED.to_string(), Value::Bool(proxied));
        }
        if let Some(comment) = &self.snapshot.comment {
            insert_text(&mut map, KEY_COMMENT, comment);
        }
        if !self.local_tags.is_empty() {
            map.insert(
                KEY_LOCAL_TAGS.to_string(),
                Value::Array(
                    self.local_tags
                        .iter()
                        .map(|tag| Value::String(tag.clone()))
                        .collect(),
                ),
            );
        }
        let mut spent = 0_usize;
        for (key, value) in self.extra {
            if KNOWN_KEYS.contains(&key.as_str()) {
                continue;
            }
            let cost = serialized_text_len(&key) + 1 + serialized_value_len(&value) + 1;
            if spent.saturating_add(cost) > MAX_RETAINED_EXTRA_BYTES {
                continue;
            }
            spent = spent.saturating_add(cost);
            map.insert(key, value);
        }
        Value::Object(map)
    }

    /// Read a stored entry.
    ///
    /// `None` only for a value that is not a JSON object — the one shape that
    /// cannot be an entry at all. Every field is optional: a missing `zone_id`
    /// gives an entry that lists but cannot restore, a missing or unreadable
    /// `expires_at` gives one that never auto-purges, a `reason` this build
    /// never heard of gives [`RetentionReason::Unknown`]. Nothing here can
    /// fail in a way that takes the rest of the store with it.
    pub fn of(value: &Value) -> Option<Self> {
        let map = value.as_object()?;
        let mut extra = Map::new();
        for (key, child) in map {
            if KNOWN_KEYS.contains(&key.as_str()) {
                continue;
            }
            extra.insert(key.clone(), child.clone());
        }
        // Every field is bounded on the way in as well as on the way out. An
        // entry hand-edited into the keyring, or written by a build with wider
        // limits, must not be able to exceed the per-entry ceiling the moment
        // this build reads it and writes it back.
        Some(Self {
            entry_id: short_text_at(map, KEY_ENTRY_ID).unwrap_or_default(),
            reason: short_text_at(map, KEY_REASON).unwrap_or_default(),
            zone_id: short_text_at(map, KEY_ZONE_ID).unwrap_or_default(),
            zone_name: short_text_at(map, KEY_ZONE_NAME).unwrap_or_default(),
            origin_record_id: short_text_at(map, KEY_ORIGIN_RECORD_ID),
            // Blank the same way the builder blanks it: an entry carrying
            // `operation_id: ""` must not read back as a group of its own.
            operation_id: short_text_at(map, KEY_OPERATION_ID)
                .filter(|operation_id| !operation_id.trim().is_empty()),
            removed_from_provider_at: timestamp_at(map, KEY_REMOVED_AT),
            expires_at: timestamp_at(map, KEY_EXPIRES_AT),
            snapshot: RecordSnapshot {
                record_type: short_text_at(map, KEY_TYPE).unwrap_or_default(),
                name: short_text_at(map, KEY_NAME).unwrap_or_default(),
                content: text_at(map, KEY_CONTENT, MAX_RETAINED_CONTENT_BYTES).unwrap_or_default(),
                ttl: map
                    .get(KEY_TTL)
                    .and_then(Value::as_u64)
                    .and_then(|ttl| u32::try_from(ttl).ok()),
                priority: map
                    .get(KEY_PRIORITY)
                    .and_then(Value::as_u64)
                    .and_then(|priority| u16::try_from(priority).ok()),
                proxied: map.get(KEY_PROXIED).and_then(Value::as_bool),
                comment: text_at(map, KEY_COMMENT, MAX_RETAINED_COMMENT_BYTES),
            },
            local_tags: map
                .get(KEY_LOCAL_TAGS)
                .and_then(Value::as_array)
                .map(|tags| {
                    tags.iter()
                        .filter_map(|tag| tag.as_str())
                        .filter(|tag| !tag.trim().is_empty())
                        .take(MAX_RETAINED_TAGS)
                        .map(|tag| bounded_text(tag, MAX_RETAINED_TAG_BYTES))
                        .collect()
                })
                .unwrap_or_default(),
            extra,
        })
    }

    /// Whether this entry carries everything a restore needs.
    ///
    /// A zone, a type, a name and an entry id. Content is allowed to be empty
    /// because a few record types legitimately have none; the provider is the
    /// authority on that, and a pre-flight validation runs before the call.
    pub fn is_restorable(&self) -> bool {
        !self.entry_id.is_empty()
            && !self.zone_id.is_empty()
            && !self.snapshot.record_type.is_empty()
            && !self.snapshot.name.is_empty()
    }
}

/// The entry id a stored value carries, without parsing the rest of it.
pub fn entry_id_of(entry: &Value) -> Option<&str> {
    entry.get(KEY_ENTRY_ID).and_then(Value::as_str)
}

/// The zone id a stored value carries, without parsing the rest of it.
///
/// `None` for an entry that has none, and for one whose `zone_id` is blank —
/// the two are the same thing to every caller, and neither is a zone anything
/// can be read for or restored into.
pub fn zone_id_of(entry: &Value) -> Option<&str> {
    non_blank(entry.get(KEY_ZONE_ID).and_then(Value::as_str))
}

/// The operation id a stored value carries, without parsing the rest of it.
///
/// `None` for every entry written before the field existed, which is the
/// normal case for a store that predates undo.
pub fn operation_id_of(entry: &Value) -> Option<&str> {
    non_blank(entry.get(KEY_OPERATION_ID).and_then(Value::as_str))
}

// ── Operation manifests ─────────────────────────────────────────────────────

/// The record ids one bulk create produced, kept so the create can be undone.
///
/// One entry per operation, not per record — see the module header for why
/// neither the audit trail nor a snapshot each would do. It carries no record
/// state: undoing a create means *deleting* what it made, so the ids are all
/// that is needed and a snapshot would be dead weight inside the same ceiling
/// the ids have to fit.
///
/// A large import is written as several of these — see
/// [`manifests_for_created_records`] — and read back as one
/// [`CreatedRecords`], so a single part on its own is a *partial* record of an
/// operation and says so. It is written to the same store as a
/// [`RetainedRecord`] and shares the keys the store itself reads, so
/// [`purge_expired`], [`evict_to_cap`] and `forget_retained_record` all handle
/// it without a special case. The record reads — [`snapshots_for_zone`] and
/// [`snapshots_for_operation`] — leave manifests out, because a manifest
/// parsed as a record would be a record with no name.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationManifest {
    /// This entry's identity in the store, generated here.
    pub entry_id: String,
    pub zone_id: String,
    /// The user action this manifest describes. Not optional, unlike a
    /// record's: a manifest with no operation id cannot be looked up, which
    /// makes it unreachable rather than merely ungrouped.
    pub operation_id: String,
    /// The ids the manifest lists, in the order the caller gave them.
    ///
    /// Possibly fewer than the operation created — see [`Self::is_complete`].
    /// Never a partial id: one that would not fit is dropped whole.
    pub created_record_ids: Vec<String>,
    /// How many records the operation created, as the caller reported it.
    ///
    /// Held separately from the list so truncation is a number the UI can say
    /// out loud ("200 of 412 recorded") rather than a flag. `None` for a
    /// manifest that did not record it, which reads as incomplete.
    pub created_record_count: Option<usize>,
    /// When the operation ran. `None` for an entry that did not record it, or
    /// recorded something unparseable.
    pub recorded_at: Option<DateTime<Utc>>,
    /// When this entry may be purged. `None` means never, which is also what
    /// an unreadable expiry degrades to.
    pub expires_at: Option<DateTime<Utc>>,
    /// Keys a newer build wrote that this one does not understand.
    pub extra: Map<String, Value>,
}

impl OperationManifest {
    pub fn new(zone_id: &str, operation_id: &str) -> Self {
        Self {
            entry_id: format!("man_{}", uuid::Uuid::new_v4()),
            zone_id: bounded_text(zone_id, MAX_RETAINED_TEXT_BYTES),
            operation_id: bounded_text(operation_id, MAX_RETAINED_TEXT_BYTES),
            created_record_ids: Vec::new(),
            created_record_count: None,
            recorded_at: None,
            expires_at: None,
            extra: Map::new(),
        }
    }

    /// Record the ids the operation created, and how many there were.
    ///
    /// Keeps at most [`MAX_MANIFEST_RECORD_IDS`] of them, drops any id that is
    /// blank or wider than [`MAX_MANIFEST_RECORD_ID_BYTES`], and stores the
    /// length of what it was *given* as the count. So anything left out — too
    /// many, blank, or over-long — shows up as
    /// [`omitted`](Self::omitted) rather than as a list that looks complete.
    /// A blank id means the provider did not tell us what it created, and an
    /// undo that cannot name a record cannot delete it, so counting that as a
    /// gap is the accurate answer and not a pedantic one.
    #[must_use]
    pub fn created_record_ids<S: AsRef<str>>(mut self, ids: &[S]) -> Self {
        self.created_record_ids = ids
            .iter()
            .map(|id| id.as_ref().trim())
            .filter(|id| !id.is_empty())
            .filter(|id| serialized_text_len(id) <= MAX_MANIFEST_RECORD_ID_BYTES)
            .take(MAX_MANIFEST_RECORD_IDS)
            .map(ToString::to_string)
            .collect();
        self.created_record_count = Some(ids.len());
        self
    }

    /// Stamp the moment the operation ran.
    #[must_use]
    pub fn recorded_at(mut self, now: DateTime<Utc>) -> Self {
        self.recorded_at = Some(now);
        self
    }

    /// Set the expiry from a retention window, measured from
    /// [`Self::recorded_at`] (or from `now` if that was never stamped).
    ///
    /// Clamped exactly as [`RetainedRecord::expiring_after`] clamps it.
    #[must_use]
    pub fn expiring_after(mut self, days: Option<u32>, now: DateTime<Utc>) -> Self {
        self.expires_at = days.map(|days| {
            let from = self.recorded_at.unwrap_or(now);
            from + Duration::days(i64::from(clamp_retention_days(days)))
        });
        self
    }

    /// Whether this manifest lists **every** record the operation created.
    ///
    /// `false` when the count is absent, which is the fail-closed direction:
    /// an undo that deletes part of an import and reports success is worse
    /// than one that refuses and says what is missing. A caller asks this
    /// before offering the undo, not after running it.
    pub fn is_complete(&self) -> bool {
        self.created_record_count == Some(self.created_record_ids.len())
    }

    /// How many of the operation's records this manifest does not list.
    ///
    /// Zero when it is complete — and also zero when it cannot tell, so this
    /// is for saying *how much* is missing, never for deciding whether
    /// anything is. That question is [`Self::is_complete`].
    pub fn omitted(&self) -> usize {
        self.created_record_count
            .unwrap_or_default()
            .saturating_sub(self.created_record_ids.len())
    }

    /// Whether this entry's expiry has passed.
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at.is_some_and(|expires_at| expires_at <= now)
    }

    /// Serialise into the flat object the store holds.
    ///
    /// Bounded by [`MAX_RETAINED_ENTRY_BYTES`] by construction, the same way a
    /// record is: every field was bounded on the way in, the const assertions
    /// pin the sum, and `extra` is spent last so an over-budget newer field is
    /// what gets dropped rather than an id.
    pub fn into_value(self) -> Value {
        let mut map = Map::new();
        insert_text(&mut map, KEY_ENTRY_ID, &self.entry_id);
        insert_text(&mut map, KEY_REASON, RetentionReason::MANIFEST);
        insert_text(&mut map, KEY_ZONE_ID, &self.zone_id);
        insert_text(&mut map, KEY_OPERATION_ID, &self.operation_id);
        if let Some(recorded_at) = self.recorded_at {
            insert_text(&mut map, KEY_RECORDED_AT, &recorded_at.to_rfc3339());
        }
        if let Some(expires_at) = self.expires_at {
            insert_text(&mut map, KEY_EXPIRES_AT, &expires_at.to_rfc3339());
        }
        if !self.created_record_ids.is_empty() {
            map.insert(
                KEY_CREATED_RECORD_IDS.to_string(),
                Value::Array(
                    self.created_record_ids
                        .iter()
                        .map(|id| Value::String(id.clone()))
                        .collect(),
                ),
            );
        }
        if let Some(count) = self.created_record_count {
            map.insert(
                KEY_CREATED_RECORD_COUNT.to_string(),
                Value::Number(Number::from(count as u64)),
            );
        }
        let mut spent = 0_usize;
        for (key, value) in self.extra {
            if MANIFEST_KNOWN_KEYS.contains(&key.as_str()) {
                continue;
            }
            let cost = serialized_text_len(&key) + 1 + serialized_value_len(&value) + 1;
            if spent.saturating_add(cost) > MAX_RETAINED_EXTRA_BYTES {
                continue;
            }
            spent = spent.saturating_add(cost);
            map.insert(key, value);
        }
        Value::Object(map)
    }

    /// Read a stored manifest.
    ///
    /// `None` for anything that is not a manifest — a record entry, or a value
    /// that is not an object. That is a type check rather than a parse
    /// failure, and it is the point of the separate type: a record read as a
    /// manifest would be an operation that created nothing, which an undo
    /// would carry out happily.
    ///
    /// Every field is otherwise optional and bounded on the way in, the way a
    /// record's are. An id list longer or wider than this build allows is
    /// shortened to what fits — and then the count no longer matches, so
    /// [`Self::is_complete`] is `false` and the undo is refused rather than
    /// run against a partial list.
    pub fn of(value: &Value) -> Option<Self> {
        if reason_of(value) != RetentionReason::Manifest {
            return None;
        }
        let map = value.as_object()?;
        let mut extra = Map::new();
        for (key, child) in map {
            if MANIFEST_KNOWN_KEYS.contains(&key.as_str()) {
                continue;
            }
            extra.insert(key.clone(), child.clone());
        }
        Some(Self {
            entry_id: short_text_at(map, KEY_ENTRY_ID).unwrap_or_default(),
            zone_id: short_text_at(map, KEY_ZONE_ID).unwrap_or_default(),
            operation_id: short_text_at(map, KEY_OPERATION_ID).unwrap_or_default(),
            created_record_ids: map
                .get(KEY_CREATED_RECORD_IDS)
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .filter(|id| serialized_text_len(id) <= MAX_MANIFEST_RECORD_ID_BYTES)
                        .take(MAX_MANIFEST_RECORD_IDS)
                        .map(ToString::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            created_record_count: map
                .get(KEY_CREATED_RECORD_COUNT)
                .and_then(Value::as_u64)
                .and_then(|count| usize::try_from(count).ok()),
            recorded_at: timestamp_at(map, KEY_RECORDED_AT),
            expires_at: timestamp_at(map, KEY_EXPIRES_AT),
            extra,
        })
    }
}

/// Whether a stored entry is an operation manifest rather than a record.
pub fn is_manifest(entry: &Value) -> bool {
    reason_of(entry) == RetentionReason::Manifest
}

/// Split what one operation created into as many manifests as it takes.
///
/// One manifest holds [`MAX_MANIFEST_RECORD_IDS`] ids, which refuses the case
/// undo matters most in: somebody who imports twelve records by mistake can
/// undo them by hand, and somebody who imports four hundred cannot. So an
/// import is written as several manifests — three slots out of a thousand for a
/// 412-record import — up to [`MAX_MANIFEST_PARTS`] of them.
///
/// **Every part carries the operation's total count, not its own slice's.**
/// That is what makes a lost part detectable: if one of three parts is evicted
/// or purged, the ids that remain no longer account for the total every
/// surviving part reports, so [`CreatedRecords::is_complete`] is `false` and
/// the undo is refused. It also means a reader that looks at a single part in
/// isolation sees a manifest that does not account for the whole operation and
/// refuses — the naive read fails closed, which is the only direction worth
/// failing in when the alternative is deleting 200 records of 412 and
/// reporting success.
///
/// The caller writes each one with [`OperationManifest::into_value`] and
/// `Storage::retain_record`, and reads them back with
/// [`created_records_for_operation`]. An empty `created` writes nothing: an
/// operation that created no records has nothing to undo.
pub fn manifests_for_created_records<S: AsRef<str>>(
    zone_id: &str,
    operation_id: &str,
    created: &[S],
    retention_days: Option<u32>,
    now: DateTime<Utc>,
) -> Vec<OperationManifest> {
    created
        .chunks(MAX_MANIFEST_RECORD_IDS)
        .take(MAX_MANIFEST_PARTS)
        .map(|chunk| {
            let mut part = OperationManifest::new(zone_id, operation_id)
                .created_record_ids(chunk)
                .recorded_at(now)
                .expiring_after(retention_days, now);
            part.created_record_count = Some(created.len());
            part
        })
        .collect()
}

/// Every manifest one operation wrote, in the order the store holds them.
///
/// At most [`MAX_MANIFEST_PARTS`] of them: a store holding more than that for
/// one operation is one this build did not write, and reading the extra parts
/// would be reading past a bound rather than honouring it. The missing ids then
/// make the set visibly incomplete, which is the safe way to be wrong.
///
/// Prefer [`created_records_for_operation`], which applies the completeness
/// rule for you. This is for a caller that needs the entries themselves —
/// their entry ids, to forget them after an undo.
///
/// A blank `operation_id` finds nothing, for the reason
/// [`snapshots_for_operation`] gives. No clock: an expired-but-unpurged
/// manifest is returned, so a caller can say when an import's undo aged out
/// instead of only that it is gone.
pub fn manifests_for_operation(entries: &[Value], operation_id: &str) -> Vec<OperationManifest> {
    let Some(operation_id) = non_blank(Some(operation_id)) else {
        return Vec::new();
    };
    let operation_id = bounded_text(operation_id, MAX_RETAINED_TEXT_BYTES);
    entries
        .iter()
        .filter(|entry| operation_id_of(entry) == Some(operation_id.as_str()))
        .filter_map(OperationManifest::of)
        .take(MAX_MANIFEST_PARTS)
        .collect()
}

/// Everything one operation created, across however many manifests it took.
///
/// `None` when the store holds no manifest for the operation — which is not the
/// same as an empty one, and a caller tells the user a different thing about
/// each: no manifest means the undo material is gone or was never written, an
/// empty one means the operation created nothing.
pub fn created_records_for_operation(
    entries: &[Value],
    operation_id: &str,
) -> Option<CreatedRecords> {
    let parts = manifests_for_operation(entries, operation_id);
    if parts.is_empty() {
        return None;
    }

    let mut record_ids: Vec<String> = Vec::new();
    for part in &parts {
        for id in &part.created_record_ids {
            // A retried write can leave the same part in the store twice. A
            // record id names one record, so a repeat is a duplicate write and
            // not a second record — counting it twice would make a whole import
            // read as incomplete.
            if !record_ids.iter().any(|held| held == id) {
                record_ids.push(id.clone());
            }
        }
    }

    Some(CreatedRecords {
        zone_id: parts[0].zone_id.clone(),
        operation_id: parts[0].operation_id.clone(),
        record_ids,
        // The largest count any part claims. Parts of one write agree; when
        // they do not, the store has been tampered with or written by a build
        // that counted differently, and the larger total is the one that
        // refuses an undo rather than running a partial one.
        created_record_count: parts
            .iter()
            .filter_map(|part| part.created_record_count)
            .max(),
        parts: parts.len(),
        recorded_at: parts.iter().filter_map(|part| part.recorded_at).min(),
        // The *earliest* expiry: the moment this set stops being whole is the
        // moment its first part becomes due, not its last.
        expires_at: parts.iter().filter_map(|part| part.expires_at).min(),
    })
}

/// Everything one operation created, assembled from its manifests.
///
/// Built by [`created_records_for_operation`], which is also where the rules
/// for assembling it are argued.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatedRecords {
    pub zone_id: String,
    pub operation_id: String,
    /// Every id the operation's manifests list, in write order, without
    /// repeats.
    pub record_ids: Vec<String>,
    /// How many records the operation created, as its manifests report it.
    pub created_record_count: Option<usize>,
    /// How many manifests the store holds for this operation.
    pub parts: usize,
    /// When the operation ran: the earliest moment its parts recorded.
    pub recorded_at: Option<DateTime<Utc>>,
    /// When this set stops being whole: the earliest expiry among its parts.
    pub expires_at: Option<DateTime<Utc>>,
}

impl CreatedRecords {
    /// Whether these ids account for **every** record the operation created.
    ///
    /// `false` when the count is absent, when a part has been evicted or
    /// purged, when a part could not store every id it was handed, and when
    /// the operation created more than [`MAX_MANIFEST_PARTS`] parts' worth.
    /// Each of those is a gap, and an undo that runs with a gap deletes part of
    /// an import and reports success.
    pub fn is_complete(&self) -> bool {
        self.created_record_count == Some(self.record_ids.len())
    }

    /// How many of the operation's records these ids do not name.
    ///
    /// Zero when the set is complete — and also zero when it cannot tell, so
    /// this says *how much* is missing and never *whether* anything is. That
    /// question is [`Self::is_complete`].
    pub fn omitted(&self) -> usize {
        self.created_record_count
            .unwrap_or_default()
            .saturating_sub(self.record_ids.len())
    }

    /// Whether the earliest part's expiry has passed, which is when this set
    /// stopped being a complete record of the operation.
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at.is_some_and(|expires_at| expires_at <= now)
    }
}

// ── Retention window ────────────────────────────────────────────────────────

/// Bring a configured retention window inside
/// [`MIN_RETENTION_DAYS`]..=[`MAX_RETENTION_DAYS`].
pub fn clamp_retention_days(days: u32) -> u32 {
    days.clamp(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS)
}

/// Bring a configured entry limit inside
/// [`MIN_RETAINED_ENTRY_LIMIT`]..=[`MAX_RETAINED_ENTRIES`].
pub fn clamp_entry_limit(limit: usize) -> usize {
    limit.clamp(MIN_RETAINED_ENTRY_LIMIT, MAX_RETAINED_ENTRIES)
}

// ── Reads ───────────────────────────────────────────────────────────────────

/// Every entry held for one zone, newest first, at most `limit` of them.
///
/// Newest first by
/// [`removed_from_provider_at`](RetainedRecord::removed_from_provider_at) — the
/// moment the record, or the state, stopped being what the provider held —
/// because that is the order a history list reads in. An entry that never
/// recorded that moment sorts *last*: an unknown date is not a recent one.
/// Entries sharing a date keep the order the store holds them in, which is the
/// order they were written.
///
/// **Every record reason comes back**, not only
/// [`RetentionReason::Superseded`]. Undoing a delete means re-creating the
/// record from its `deleted` entry, so a caller assembling undo availability
/// needs both and branches on [`RetainedRecord::reason_kind`]. An
/// [`OperationManifest`] is not a record and is left out — it would parse as a
/// record with no name — and is read with [`created_records_for_operation`].
///
/// **Expired entries come back too**, and that is load-bearing. This function
/// has no clock on purpose. An entry whose expiry has passed but which no purge
/// has swept yet is still readable here, so a caller can say "that snapshot
/// expired on the 3rd" rather than "there is no snapshot" — two states the UI
/// shows differently and a user reads differently. Filtering here would make an
/// expired snapshot indistinguishable from one that was never taken. The caller
/// applies [`is_expired`], the same clock it would purge with, and decides.
///
/// `limit` is clamped to [`MAX_RETAINED_READ_ENTRIES`]. A `limit` of zero
/// returns nothing — it is a count, not a sentinel — and a caller that wants
/// everything the store can hold passes that constant. A blank `zone_id`
/// returns nothing.
pub fn snapshots_for_zone(entries: &[Value], zone_id: &str, limit: usize) -> Vec<RetainedRecord> {
    let Some(zone_id) = non_blank(Some(zone_id)) else {
        return Vec::new();
    };
    // Bounded the way the builder bounded it on the way in, so a caller holding
    // an over-long id asks for what the store actually wrote.
    let zone_id = bounded_text(zone_id, MAX_RETAINED_TEXT_BYTES);
    let limit = limit.min(MAX_RETAINED_READ_ENTRIES);
    if limit == 0 {
        return Vec::new();
    }

    // Only the one timestamp is read before the sort; whole entries are parsed
    // after the truncate, so the parse cost is the size of the answer rather
    // than the size of the store.
    let mut matching: Vec<(Option<DateTime<Utc>>, &Value)> = entries
        .iter()
        .filter(|entry| zone_id_of(entry) == Some(zone_id.as_str()))
        .filter(|entry| !is_manifest(entry))
        .map(|entry| (removed_at_of(entry), entry))
        .collect();
    // Descending, and stable: `None` orders below every `Some`, so an entry
    // with no recorded moment lands at the end instead of at the top.
    matching.sort_by_key(|(removed_at, _)| Reverse(*removed_at));
    matching.truncate(limit);
    matching
        .into_iter()
        .filter_map(|(_, entry)| RetainedRecord::of(entry))
        .collect()
}

/// Every entry one user action produced, in the order they were written.
///
/// Store order rather than newest first: this is the input to an "undo all",
/// and a group replays in the order it was recorded. Bounded by
/// [`MAX_RETAINED_READ_ENTRIES`], which cannot shorten a group a well-formed
/// store holds.
///
/// A blank `operation_id` returns nothing, and it has to: every entry written
/// before [`RetainedRecord::operation_id`] existed carries none, so a read that
/// treated "no id" as a group would hand an undo the whole store.
///
/// Entries are *not* filtered by record reason or by clock, for the reasons
/// [`snapshots_for_zone`] gives, and the operation's [`OperationManifest`] is
/// left out the same way — ask [`created_records_for_operation`] for that. Each
/// entry
/// carries its own [`zone_id`](RetainedRecord::zone_id), which a caller about
/// to write checks against the zone the user is looking at.
pub fn snapshots_for_operation(entries: &[Value], operation_id: &str) -> Vec<RetainedRecord> {
    let Some(operation_id) = non_blank(Some(operation_id)) else {
        return Vec::new();
    };
    let operation_id = bounded_text(operation_id, MAX_RETAINED_TEXT_BYTES);
    entries
        .iter()
        .filter(|entry| operation_id_of(entry) == Some(operation_id.as_str()))
        .filter(|entry| !is_manifest(entry))
        .take(MAX_RETAINED_READ_ENTRIES)
        .filter_map(RetainedRecord::of)
        .collect()
}

// ── Purge ───────────────────────────────────────────────────────────────────

/// Whether a stored entry's expiry has passed by `now`.
pub fn is_expired(entry: &Value, now: DateTime<Utc>) -> bool {
    entry
        .as_object()
        .and_then(|map| timestamp_at(map, KEY_EXPIRES_AT))
        .is_some_and(|expires_at| expires_at <= now)
}

/// Drop every entry whose expiry has passed, and return them in the order they
/// were held.
///
/// The whole purge decision is this function and the clock it is handed. An
/// entry with no expiry — a disable, or one whose `expires_at` this build
/// cannot read — is never dropped here.
pub fn purge_expired(entries: &mut Vec<Value>, now: DateTime<Utc>) -> Vec<Value> {
    let mut purged = Vec::new();
    let mut index = 0;
    while index < entries.len() {
        if is_expired(&entries[index], now) {
            purged.push(entries.remove(index));
        } else {
            index += 1;
        }
    }
    purged
}

// ── Eviction ────────────────────────────────────────────────────────────────

/// Why an entry was given up.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvictionCause {
    /// The store held more entries than it is allowed to.
    EntryLimit,
    /// The store was larger than it is allowed to be.
    ByteLimit,
}

impl EvictionCause {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::EntryLimit => "entry_limit",
            Self::ByteLimit => "byte_limit",
        }
    }
}

/// An entry the store gave up to stay inside its bounds.
#[derive(Clone, Debug)]
pub struct Evicted {
    pub entry: Value,
    pub cause: EvictionCause,
}

/// Whether an entry may never be given up to make room.
///
/// A disable — or any reason this build cannot classify — is the **only** copy
/// of a record that no longer exists at the provider, and the user parked it on
/// this application's assurance that it could be put back. Evicting one would
/// be data loss caused by the feature itself, so nothing in this module will do
/// it, however full the store is.
///
/// A recycle-bin entry is not protected: it has a stated, finite life the user
/// already accepted, so losing it early loses a little rather than everything.
/// Nor is a superseded snapshot, which is the least costly of all to lose — the
/// record it describes is still at the provider — nor an [`OperationManifest`],
/// which holds no record data at all. An expired entry of any reason is not
/// protected either; it is already past the date it was given.
pub fn is_protected(entry: &Value, now: DateTime<Utc>) -> bool {
    !is_expired(entry, now) && !reason_of(entry).is_expendable()
}

/// Whether one more entry of `incoming_bytes` could be stored without giving up
/// a protected record.
///
/// Call this before pushing. It asks the worst-case question — if every
/// expired and every recycle-bin entry were given up, would the newcomer fit
/// alongside what must be kept? — so a `true` guarantees [`evict_to_cap`] can
/// reach the bounds, and a `false` means the only way in would be through a
/// record that exists nowhere else.
pub fn fits_after_eviction(
    entries: &[Value],
    incoming_bytes: usize,
    max_entries: usize,
    now: DateTime<Utc>,
) -> bool {
    let max_entries = clamp_entry_limit(max_entries);
    let protected: Vec<&Value> = entries
        .iter()
        .filter(|entry| is_protected(entry, now))
        .collect();
    let bytes = protected
        .iter()
        .map(|entry| serialized_value_len(entry))
        .sum::<usize>()
        .saturating_add(incoming_bytes)
        // One comma per entry after the first, plus the brackets.
        .saturating_add(protected.len())
        .saturating_add(2);
    // `<` rather than `+ 1 <=`: the newcomer needs a slot of its own, so what
    // must be kept has to come to strictly fewer than the cap.
    protected.len() < max_entries && bytes <= MAX_RETAINED_BYTES
}

/// Bring the store back inside its entry and byte bounds, and return what that
/// cost.
///
/// Victims are chosen in a fixed order, and the order is the whole argument:
///
/// 1. **An expired entry.** Already past the date the user was shown. Dropping
///    it early costs nothing that was promised.
/// 2. **A `superseded` snapshot**, from whichever zone holds the most of them;
///    the oldest of that zone's. Losing one costs the ability to revert an
///    edit. The record itself is untouched at the provider, which makes this
///    the cheapest thing in the store to give up — and the reason it goes
///    before a bin entry, not after: a `deleted` entry is the only copy of a
///    record that exists nowhere at all.
/// 3. **An [`OperationManifest`]**, chosen the same way. Losing one costs the
///    undo of a bulk create and no record data at all, so it ranks below the
///    bin too — but above an edit's snapshot, because one manifest covers a
///    whole import: evicting it destroys more undo per slot freed.
/// 4. **The oldest `deleted` entry.** A recycle-bin entry has a stated, finite
///    life the user already accepted; shortening it loses a little.
/// 5. **Nothing.** A protected entry — see [`is_protected`] — is never a
///    victim, so a store with no expired, no superseded, no manifest and no bin
///    entries left simply stays over its bound and this returns having evicted
///    nothing.
///
/// Steps 2 and 3 take from the largest holder rather than simply taking the
/// oldest, and that is what stops one zone's history crowding out another's.
/// Oldest first alone would mean a bulk edit of several hundred records in one
/// zone fills the store and then evicts *other* zones' undo material, because
/// theirs is older — a zone the user has not touched in a month silently loses
/// its undo to a zone they are working in. Taking from the biggest holder means
/// a zone can only lose undo material to its own history until it is no longer
/// the biggest, at which point the two shrink together.
///
/// That last case is why callers must ask [`fits_after_eviction`] *before*
/// pushing: a bin that cannot make room has to refuse the new entry, and a
/// refused retain costs nothing — the record stays live at the provider, which
/// is recoverable in a way a forgotten disable is not.
///
/// Always the oldest of its class, never the entry just added: a store that
/// drops the newest write is a store that discards the deletion the user is
/// at that moment trying to be able to undo. Over either bound there are
/// always at least two entries — one maximal entry fits both bounds by
/// construction — so "the oldest" is never also "the newest".
///
/// Every eviction is handed back for the caller to put in the audit trail. A
/// record this application forgets must not be a record it forgot silently.
pub fn evict_to_cap(
    entries: &mut Vec<Value>,
    max_entries: usize,
    now: DateTime<Utc>,
) -> Vec<Evicted> {
    let max_entries = clamp_entry_limit(max_entries);
    let mut evicted = Vec::new();
    let mut bytes = serialized_store_len(entries);

    loop {
        let cause = if entries.len() > max_entries {
            EvictionCause::EntryLimit
        } else if bytes > MAX_RETAINED_BYTES {
            EvictionCause::ByteLimit
        } else {
            return evicted;
        };
        let Some(index) = victim_index(entries, now) else {
            return evicted;
        };
        let entry = entries.remove(index);
        bytes = bytes
            .saturating_sub(serialized_value_len(&entry))
            .saturating_sub(if entries.is_empty() { 0 } else { 1 });
        evicted.push(Evicted { entry, cause });
    }
}

/// The index of the entry to give up, or `None` when every remaining entry is
/// protected.
fn victim_index(entries: &[Value], now: DateTime<Utc>) -> Option<usize> {
    if let Some(index) = entries.iter().position(|entry| is_expired(entry, now)) {
        return Some(index);
    }
    // Undo material, cheapest first: an edit's snapshot, then an import's
    // manifest. Both before the recycle bin, whose entries are the only copy
    // of a record that exists nowhere else.
    for reason in [RetentionReason::Superseded, RetentionReason::Manifest] {
        if let Some(index) = fair_share_victim_index(entries, reason) {
            return Some(index);
        }
    }
    // The recycle bin, and the one tier that does **not** use the busiest-zone
    // rule: this takes the oldest expendable entry anywhere in the store,
    // whatever zone it belongs to. So emptying four hundred records out of one
    // zone can evict another zone's bin entries, because theirs are older —
    // the same crowding the two tiers above deliberately avoid.
    //
    // That is a known gap and not an oversight. This tier predates the
    // superseded and manifest tiers, and oldest-first here is behaviour users
    // already have: the entries it reorders are the only copies of records that
    // exist nowhere else, so changing which of them is given up first changes
    // what the recycle bin does for everybody who already relies on it. The
    // fix, if it is ever wanted, is one line —
    // `fair_share_victim_index(entries, RetentionReason::Deleted)` ahead of
    // this, since that function takes the reason as an argument for exactly
    // this reason — plus a test that a bulk delete in one zone stops at its own
    // bin entries. It wants a deliberate decision about existing data, not a
    // tidy-up.
    entries
        .iter()
        .position(|entry| reason_of(entry).is_expendable())
}

/// The entry of `reason` to give up: the oldest one belonging to a zone that
/// holds the most of them. `None` when the store holds none of that reason.
///
/// See [`evict_to_cap`] for why the busiest zone pays rather than the oldest
/// entry. Two zones tied for the most are separated by store order, so the
/// choice is the same on every run and on every machine — a `HashMap`'s
/// iteration order is not.
fn fair_share_victim_index(entries: &[Value], reason: RetentionReason) -> Option<usize> {
    let mut held: HashMap<&str, usize> = HashMap::new();
    for entry in entries {
        if reason_of(entry) == reason {
            // An entry with no readable zone id is its own bucket, under a key
            // no zone can have. It still has to be evictable, or a store full
            // of unreadable entries could never make room.
            *held
                .entry(zone_id_of(entry).unwrap_or_default())
                .or_default() += 1;
        }
    }
    let most = held.values().copied().max()?;
    entries.iter().position(|entry| {
        reason_of(entry) == reason && held.get(zone_id_of(entry).unwrap_or_default()) == Some(&most)
    })
}

/// This build's reading of a stored entry's reason.
pub fn reason_of(entry: &Value) -> RetentionReason {
    RetentionReason::of(
        entry
            .get(KEY_REASON)
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
}

// ── Restore: what the zone looks like now ───────────────────────────────────

/// A record that exists in the zone at the moment a restore is attempted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExistingRecord {
    pub record_id: Option<String>,
    pub record_type: String,
    pub name: String,
    pub content: String,
}

/// A reason a restore must not proceed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestoreObstacle {
    /// This record is already there. Restoring would add a second copy of
    /// something that is already resolving, so the entry is left alone and the
    /// caller is told which record matched — the user's next move is usually to
    /// discard the entry, not to restore it.
    AlreadyPresent { existing: ExistingRecord },
    /// A CNAME cannot share a name with anything else, so either the entry is a
    /// CNAME and the name is now occupied, or something else now holds a CNAME
    /// at the entry's name. Cloudflare would refuse this; refusing it here
    /// names the record in the way instead of returning a provider error code.
    CnameCollision { existing: ExistingRecord },
}

impl RestoreObstacle {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::AlreadyPresent { .. } => "already_present",
            Self::CnameCollision { .. } => "cname_collision",
        }
    }

    pub const fn existing(&self) -> &ExistingRecord {
        match self {
            Self::AlreadyPresent { existing } | Self::CnameCollision { existing } => existing,
        }
    }
}

/// What a restore would run into, given the zone as it is now.
#[derive(Clone, Debug, Default)]
pub struct DestinationReport {
    /// Set when the restore must not proceed.
    pub obstacle: Option<RestoreObstacle>,
    /// Records that already hold the entry's name. Empty when the name is
    /// free. Reported even on success, because "restored, and it now shares
    /// the name with two other A records" is something the user wants told.
    pub occupants: Vec<ExistingRecord>,
}

/// Decide whether a retained record can go back into the zone it came from.
///
/// Pure, and given the zone's current records rather than a client, so the
/// decision is testable without a network and identical whichever caller asks.
///
/// Names are compared case-insensitively and with a trailing dot ignored,
/// because that is what DNS means by the same name. Content is compared the
/// same way: a record that differs from this one only in the case of its
/// content is, for every type Cloudflare serves, the same record — and
/// answering "that is already there" is a refusal the user can act on, whereas
/// creating a near-duplicate is a mess they have to find first.
pub fn inspect_destination(
    snapshot: &RecordSnapshot,
    existing: &[ExistingRecord],
) -> DestinationReport {
    let name = canonical_name(&snapshot.name);
    let record_type = snapshot.record_type.trim().to_ascii_uppercase();
    let content = canonical_content(&snapshot.content);

    let occupants: Vec<ExistingRecord> = existing
        .iter()
        .filter(|candidate| canonical_name(&candidate.name) == name)
        .cloned()
        .collect();

    let duplicate = occupants.iter().find(|candidate| {
        candidate.record_type.trim().to_ascii_uppercase() == record_type
            && canonical_content(&candidate.content) == content
    });
    if let Some(existing) = duplicate {
        return DestinationReport {
            obstacle: Some(RestoreObstacle::AlreadyPresent {
                existing: existing.clone(),
            }),
            occupants,
        };
    }

    let cname_in_the_way = occupants.iter().find(|candidate| {
        let candidate_type = candidate.record_type.trim().to_ascii_uppercase();
        record_type == "CNAME" || candidate_type == "CNAME"
    });
    if let Some(existing) = cname_in_the_way {
        return DestinationReport {
            obstacle: Some(RestoreObstacle::CnameCollision {
                existing: existing.clone(),
            }),
            occupants,
        };
    }

    DestinationReport {
        obstacle: None,
        occupants,
    }
}

// ── Local helpers ───────────────────────────────────────────────────────────

fn canonical_name(name: &str) -> String {
    name.trim().trim_end_matches('.').to_ascii_lowercase()
}

fn canonical_content(content: &str) -> String {
    content.trim().to_ascii_lowercase()
}

fn insert_text(map: &mut Map<String, Value>, key: &str, value: &str) {
    map.insert(key.to_string(), Value::String(value.to_string()));
}

fn text_at(map: &Map<String, Value>, key: &str, max_serialized_bytes: usize) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(|text| bounded_text(text, max_serialized_bytes))
}

fn short_text_at(map: &Map<String, Value>, key: &str) -> Option<String> {
    text_at(map, key, MAX_RETAINED_TEXT_BYTES)
}

/// A text value, unless it is blank. Blank and absent mean the same thing to
/// every caller in this module, so they are the same answer.
fn non_blank(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.trim().is_empty())
}

/// The moment a stored entry records, without parsing the rest of it.
fn removed_at_of(entry: &Value) -> Option<DateTime<Utc>> {
    entry
        .as_object()
        .and_then(|map| timestamp_at(map, KEY_REMOVED_AT))
}

fn timestamp_at(map: &Map<String, Value>, key: &str) -> Option<DateTime<Utc>> {
    let raw = map.get(key).and_then(Value::as_str)?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

/// The exact length `serde_json` gives a string, quotes and escapes included.
///
/// Measured rather than approximated by `str::len`, because the budgets in this
/// module are budgets on what reaches the keyring. A record comment of nothing
/// but quotation marks serialises to twice its length, and a bound that does
/// not know that is not a bound.
fn serialized_text_len(value: &str) -> usize {
    let mut len = 2;
    for byte in value.bytes() {
        len += match byte {
            b'"' | b'\\' | 0x08 | 0x09 | 0x0a | 0x0c | 0x0d => 2,
            0x00..=0x1f => 6,
            _ => 1,
        };
    }
    len
}

fn serialized_value_len(value: &Value) -> usize {
    match value {
        Value::String(text) => serialized_text_len(text),
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(number) => number.to_string().len(),
        other => other.to_string().len(),
    }
}

/// The serialised length of the whole store, array punctuation included.
fn serialized_store_len(entries: &[Value]) -> usize {
    let commas = entries.len().saturating_sub(1);
    entries
        .iter()
        .map(serialized_value_len)
        .sum::<usize>()
        .saturating_add(commas)
        .saturating_add(2)
}

/// Truncate so the value's *serialised* form fits `max_serialized_bytes`,
/// cutting on a character boundary so a multi-byte name is shortened rather
/// than turned into invalid UTF-8.
fn bounded_text(value: &str, max_serialized_bytes: usize) -> String {
    let budget = max_serialized_bytes.saturating_sub(2);
    let mut spent = 0_usize;
    let mut end = value.len();
    for (index, character) in value.char_indices() {
        let cost: usize = character
            .to_string()
            .bytes()
            .map(|byte| match byte {
                b'"' | b'\\' | 0x08 | 0x09 | 0x0a | 0x0c | 0x0d => 2,
                0x00..=0x1f => 6,
                _ => 1,
            })
            .sum();
        if spent + cost > budget {
            end = index;
            break;
        }
        spent += cost;
    }
    if end == value.len() {
        value.to_string()
    } else {
        value[..end].to_string()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .expect("test timestamp")
            .with_timezone(&Utc)
    }

    fn snapshot(record_type: &str, name: &str, content: &str) -> RecordSnapshot {
        RecordSnapshot {
            record_type: record_type.to_string(),
            name: name.to_string(),
            content: content.to_string(),
            ttl: Some(1),
            priority: None,
            proxied: Some(false),
            comment: None,
        }
    }

    fn existing(record_type: &str, name: &str, content: &str) -> ExistingRecord {
        ExistingRecord {
            record_id: Some(format!("cf-{record_type}-{name}")),
            record_type: record_type.to_string(),
            name: name.to_string(),
            content: content.to_string(),
        }
    }

    fn deleted_entry(seq: usize, expires_at: Option<DateTime<Utc>>) -> Value {
        let mut entry = RetainedRecord::new(RetentionReason::DELETED, "zone-1", "example.com")
            .snapshot(snapshot("A", &format!("r{seq}.example.com"), "203.0.113.1"))
            .removed_at(at("2026-01-01T00:00:00Z"));
        entry.expires_at = expires_at;
        let mut value = entry.into_value();
        value["seq"] = json!(seq);
        value
    }

    fn disabled_entry(seq: usize) -> Value {
        let mut value = RetainedRecord::new(RetentionReason::DISABLED, "zone-1", "example.com")
            .snapshot(snapshot("A", &format!("d{seq}.example.com"), "203.0.113.2"))
            .removed_at(at("2026-01-01T00:00:00Z"))
            .into_value();
        value["seq"] = json!(seq);
        value
    }

    /// A pre-edit snapshot. An `operation_id` of `""` gives an entry with no
    /// group at all, which is the shape every entry written before undo existed
    /// has.
    fn superseded_entry(
        seq: usize,
        zone_id: &str,
        operation_id: &str,
        expires_at: Option<DateTime<Utc>>,
    ) -> Value {
        let mut entry = RetainedRecord::new(RetentionReason::SUPERSEDED, zone_id, "example.com")
            .origin_record_id(&format!("cf-{seq}"))
            .operation_id(operation_id)
            .snapshot(snapshot("A", &format!("s{seq}.example.com"), "203.0.113.3"))
            .removed_at(at("2026-01-01T00:00:00Z"));
        entry.expires_at = expires_at;
        let mut value = entry.into_value();
        value["seq"] = json!(seq);
        value
    }

    // ── Shape and round-tripping ────────────────────────────────────────

    #[test]
    fn an_entry_spells_the_record_fields_the_way_the_create_path_does() {
        let value = RetainedRecord::new(RetentionReason::DISABLED, "zone-1", "example.com")
            .origin_record_id("cf-record-1")
            .snapshot(RecordSnapshot {
                record_type: "MX".to_string(),
                name: "example.com".to_string(),
                content: "mail.example.com".to_string(),
                ttl: Some(3600),
                priority: Some(10),
                proxied: Some(false),
                comment: Some("primary".to_string()),
            })
            .local_tags(&["mail", "critical"])
            .removed_at(at("2026-03-01T12:00:00Z"))
            .into_value();

        assert_eq!(value["reason"], json!("disabled"));
        assert_eq!(value["zone_id"], json!("zone-1"));
        assert_eq!(value["origin_record_id"], json!("cf-record-1"));
        assert_eq!(value["type"], json!("MX"));
        assert_eq!(value["name"], json!("example.com"));
        assert_eq!(value["content"], json!("mail.example.com"));
        assert_eq!(value["ttl"], json!(3600));
        assert_eq!(value["priority"], json!(10));
        assert_eq!(value["proxied"], json!(false));
        assert_eq!(value["comment"], json!("primary"));
        assert_eq!(value["local_tags"], json!(["mail", "critical"]));
        assert!(
            value["entry_id"].as_str().is_some_and(|id| id.len() > 4),
            "an entry gets its own id, because the provider's dies with the record"
        );
        assert!(
            value.get("expires_at").is_none(),
            "a disable is indefinite, so it stores no expiry at all"
        );
    }

    #[test]
    fn an_absent_optional_field_is_left_out_rather_than_written_as_null() {
        let value = RetainedRecord::new(RetentionReason::DELETED, "zone-1", "example.com")
            .snapshot(snapshot("TXT", "example.com", "v=spf1 -all"))
            .into_value();
        for key in [
            "origin_record_id",
            "operation_id",
            "comment",
            "priority",
            "local_tags",
        ] {
            assert!(
                value.get(key).is_none(),
                "{key} was absent, so it must not become a null a reader has to interpret"
            );
        }
    }

    #[test]
    fn a_newer_builds_fields_survive_a_round_trip_through_this_one() {
        let stored = json!({
            "entry_id": "ret_1",
            "reason": "quarantined_by_policy",
            "zone_id": "zone-1",
            "zone_name": "example.com",
            "type": "A",
            "name": "www.example.com",
            "content": "203.0.113.5",
            "policy_id": "pol-7",
            "settings": { "flatten_cname": true },
        });

        let parsed = RetainedRecord::of(&stored).expect("an object always parses");
        assert_eq!(
            parsed.reason_kind(),
            RetentionReason::Unknown,
            "a reason this build never heard of is a reading, not a failure"
        );
        assert!(!parsed.reason.is_empty(), "and the raw spelling is kept");

        let rewritten = parsed.into_value();
        assert_eq!(rewritten["reason"], json!("quarantined_by_policy"));
        assert_eq!(rewritten["policy_id"], json!("pol-7"));
        assert_eq!(rewritten["settings"], json!({ "flatten_cname": true }));
    }

    #[test]
    fn an_entry_missing_every_field_parses_and_simply_cannot_restore() {
        let parsed = RetainedRecord::of(&json!({})).expect("an empty object is still an object");
        assert_eq!(parsed.reason_kind(), RetentionReason::Unknown);
        assert_eq!(parsed.expires_at, None);
        assert_eq!(parsed.removed_from_provider_at, None);
        assert!(
            !parsed.is_restorable(),
            "nothing to restore, but nothing crashed either"
        );
        assert!(RetainedRecord::of(&json!("not an object")).is_none());
        assert!(RetainedRecord::of(&json!([])).is_none());
    }

    #[test]
    fn an_unreadable_expiry_means_never_expire_rather_than_expire_now() {
        let stored = json!({
            "entry_id": "ret_1",
            "reason": "deleted",
            "zone_id": "zone-1",
            "expires_at": "whenever",
        });
        assert_eq!(
            RetainedRecord::of(&stored).expect("parses").expires_at,
            None
        );
        assert!(
            !is_expired(&stored, at("2099-01-01T00:00:00Z")),
            "a date this build cannot read is not a licence to delete the record"
        );
    }

    // ── Superseded snapshots and operation ids ──────────────────────────

    #[test]
    fn superseded_is_a_reason_this_build_knows_and_the_cheapest_one_to_lose() {
        assert_eq!(RetentionReason::SUPERSEDED, "superseded");
        assert_eq!(
            RetentionReason::of(RetentionReason::SUPERSEDED),
            RetentionReason::Superseded,
            "a stored 'superseded' must not read as Unknown, or eviction would \
             protect undo material ahead of a deleted record's only copy"
        );
        assert!(
            RetentionReason::Superseded.is_expendable(),
            "the record is still at the provider under its new values, so this \
             entry is a revert and not the only copy of anything"
        );
        assert!(
            !is_protected(
                &superseded_entry(0, "zone-1", "op-1", Some(at("2026-06-01T00:00:00Z"))),
                at("2026-02-01T00:00:00Z"),
            ),
            "and the stored-value path agrees with the enum"
        );
    }

    #[test]
    fn a_superseded_entry_round_trips_its_reason_and_its_operation_id() {
        const OPERATION: &str = "7f1d9c2e-0f5a-4a3b-9c21-0d9f6a1b2c3d";
        let written = RetainedRecord::new(RetentionReason::SUPERSEDED, "zone-1", "example.com")
            .origin_record_id("cf-record-7")
            .operation_id(OPERATION)
            .snapshot(snapshot("A", "www.example.com", "203.0.113.4"))
            .removed_at(at("2026-03-01T12:00:00Z"))
            .expiring_after(Some(DEFAULT_RETENTION_DAYS), at("2026-03-01T12:00:00Z"))
            .into_value();

        assert_eq!(written["reason"], json!("superseded"));
        assert_eq!(written["operation_id"], json!(OPERATION));
        assert_eq!(operation_id_of(&written), Some(OPERATION));
        assert_eq!(zone_id_of(&written), Some("zone-1"));

        let parsed = RetainedRecord::of(&written).expect("parses");
        assert_eq!(parsed.reason_kind(), RetentionReason::Superseded);
        assert_eq!(parsed.operation_id.as_deref(), Some(OPERATION));
        assert_eq!(parsed.origin_record_id.as_deref(), Some("cf-record-7"));
        assert_eq!(
            parsed.snapshot.content, "203.0.113.4",
            "the exact prior state is the whole point of the entry"
        );
        assert_eq!(parsed.expires_at, Some(at("2026-03-31T12:00:00Z")));

        // Again, because an undo reads what a rewrite left behind as often as
        // what the original write did: every read of the store is a parse, and
        // every write of it is a re-serialise of every entry.
        let rewritten = parsed.into_value();
        assert_eq!(rewritten["reason"], json!("superseded"));
        assert_eq!(
            rewritten["operation_id"],
            json!(OPERATION),
            "a group id dropped on rewrite turns a bulk undo into nothing, \
             silently and only for entries that have been read once"
        );
        assert_eq!(rewritten["content"], json!("203.0.113.4"));
    }

    #[test]
    fn an_entry_with_no_operation_id_parses_and_is_not_reachable_as_a_group() {
        let legacy = json!({
            "entry_id": "ret_1",
            "reason": "deleted",
            "zone_id": "zone-1",
            "zone_name": "example.com",
            "type": "A",
            "name": "www.example.com",
            "content": "203.0.113.5",
        });

        let parsed = RetainedRecord::of(&legacy).expect("an object always parses");
        assert_eq!(
            parsed.operation_id, None,
            "a store that predates undo must keep working, not fail to read"
        );
        assert!(parsed.is_restorable(), "and must keep restoring");
        assert!(
            parsed.into_value().get("operation_id").is_none(),
            "absent, not a null a reader has to interpret"
        );

        assert_eq!(operation_id_of(&legacy), None);
        for needle in ["", "   "] {
            assert!(
                snapshots_for_operation(std::slice::from_ref(&legacy), needle).is_empty(),
                "asking for no operation must not return every ungrouped entry \
                 in the store"
            );
        }

        // A stored blank reads the same way the builder stores one: as no
        // group, so the two paths cannot disagree about what "ungrouped" is.
        let blank = json!({ "entry_id": "ret_2", "operation_id": "" });
        assert_eq!(
            RetainedRecord::of(&blank).expect("parses").operation_id,
            None
        );
        assert_eq!(operation_id_of(&blank), None);
        assert_eq!(
            RetainedRecord::new(RetentionReason::SUPERSEDED, "zone-1", "example.com")
                .operation_id("   ")
                .operation_id
                .as_deref(),
            None,
        );
    }

    // ── Bounds ──────────────────────────────────────────────────────────

    #[test]
    fn the_serialized_length_helper_agrees_with_serde_json() {
        for sample in [
            "plain",
            "with \"quotes\" and \\ backslash",
            "tab\there\nnewline",
            "\u{1}\u{2}\u{1f}",
            "héllo wörld",
            "emoji 😀 and ideographs 漢字",
            "",
        ] {
            let encoded = serde_json::to_string(sample).expect("a string always serialises");
            assert_eq!(
                serialized_text_len(sample),
                encoded.len(),
                "the byte budget must charge exactly what {sample:?} costs on disk"
            );
        }
    }

    #[test]
    fn the_widest_entry_the_builder_can_make_fits_the_per_entry_ceiling() {
        // Content that doubles when it is serialised, so the ceiling is tested
        // against escaping rather than against plain ASCII.
        let nasty = "\"\\".repeat(MAX_RETAINED_CONTENT_BYTES);
        let long = "n".repeat(MAX_RETAINED_TEXT_BYTES * 2);
        let tags: Vec<String> = (0..MAX_RETAINED_TAGS * 2)
            .map(|index| format!("{index}{}", "t".repeat(MAX_RETAINED_TAG_BYTES * 2)))
            .collect();
        let mut entry = RetainedRecord::new(&long, &long, &long)
            .origin_record_id(&long)
            .operation_id(&long)
            .snapshot(RecordSnapshot {
                record_type: long.clone(),
                name: long.clone(),
                content: nasty.clone(),
                ttl: Some(u32::MAX),
                priority: Some(u16::MAX),
                proxied: Some(true),
                comment: Some(nasty.clone()),
            })
            .local_tags(&tags)
            .removed_at(at("2026-01-01T00:00:00Z"))
            .expiring_after(Some(MAX_RETENTION_DAYS), at("2026-01-01T00:00:00Z"));
        for index in 0..64 {
            entry
                .extra
                .insert(format!("future_{index}"), json!(nasty.clone()));
        }

        let serialized = entry.into_value().to_string();
        assert!(
            serialized.len() <= MAX_RETAINED_ENTRY_BYTES,
            "entry serialised to {} bytes, over the {MAX_RETAINED_ENTRY_BYTES} ceiling",
            serialized.len()
        );
    }

    #[test]
    fn a_multibyte_name_is_truncated_on_a_character_boundary() {
        let long = "é".repeat(MAX_RETAINED_TEXT_BYTES);
        let bounded = bounded_text(&long, MAX_RETAINED_TEXT_BYTES);
        assert!(serialized_text_len(&bounded) <= MAX_RETAINED_TEXT_BYTES);
        assert!(long.starts_with(&bounded));
        assert!(!bounded.is_empty(), "truncation must keep what it can");
    }

    #[test]
    fn an_over_budget_future_field_is_dropped_and_the_identifying_ones_are_not() {
        let mut entry = RetainedRecord::new(RetentionReason::DELETED, "zone-1", "example.com")
            .snapshot(snapshot("A", "www.example.com", "203.0.113.9"));
        entry
            .extra
            .insert("kept".to_string(), json!("a".repeat(64)));
        entry.extra.insert(
            "dropped".to_string(),
            json!("b".repeat(MAX_RETAINED_EXTRA_BYTES * 2)),
        );

        let value = entry.into_value();
        assert_eq!(value["zone_id"], json!("zone-1"));
        assert_eq!(value["name"], json!("www.example.com"));
        assert!(value.get("kept").is_some());
        assert!(
            value.get("dropped").is_none(),
            "the overrun is what gets dropped, not the record's identity"
        );
    }

    #[test]
    fn a_future_field_cannot_impersonate_a_known_one() {
        let mut entry = RetainedRecord::new(RetentionReason::DISABLED, "zone-1", "example.com")
            .snapshot(snapshot("A", "www.example.com", "203.0.113.9"));
        entry
            .extra
            .insert("zone_id".to_string(), json!("zone-evil"));
        assert_eq!(entry.into_value()["zone_id"], json!("zone-1"));
    }

    // ── Expiry and purging ──────────────────────────────────────────────

    #[test]
    fn a_binned_entry_expires_exactly_its_retention_window_after_removal() {
        let removed = at("2026-01-01T00:00:00Z");
        let entry = RetainedRecord::new(RetentionReason::DELETED, "zone-1", "example.com")
            .removed_at(removed)
            .expiring_after(Some(DEFAULT_RETENTION_DAYS), removed);
        assert_eq!(entry.expires_at, Some(at("2026-01-31T00:00:00Z")));
        assert!(!entry.is_expired(at("2026-01-30T23:59:59Z")));
        assert!(entry.is_expired(at("2026-01-31T00:00:00Z")));
    }

    #[test]
    fn a_configured_window_is_clamped_before_it_reaches_an_entry() {
        let removed = at("2026-01-01T00:00:00Z");
        let zero = RetainedRecord::new(RetentionReason::DELETED, "z", "example.com")
            .removed_at(removed)
            .expiring_after(Some(0), removed);
        assert_eq!(
            zero.expires_at,
            Some(removed + Duration::days(i64::from(MIN_RETENTION_DAYS))),
            "a zero-day window would bin a record into nothing"
        );

        let forever = RetainedRecord::new(RetentionReason::DELETED, "z", "example.com")
            .removed_at(removed)
            .expiring_after(Some(100_000), removed);
        assert_eq!(
            forever.expires_at,
            Some(removed + Duration::days(i64::from(MAX_RETENTION_DAYS)))
        );
    }

    #[test]
    fn purging_drops_exactly_what_the_clock_says_and_nothing_else() {
        let mut entries = vec![
            deleted_entry(0, Some(at("2026-01-10T00:00:00Z"))),
            disabled_entry(1),
            deleted_entry(2, Some(at("2026-02-10T00:00:00Z"))),
            deleted_entry(3, None),
        ];

        let purged = purge_expired(&mut entries, at("2026-01-15T00:00:00Z"));
        assert_eq!(purged.len(), 1);
        assert_eq!(purged[0]["seq"], json!(0));
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry["seq"].clone())
                .collect::<Vec<_>>(),
            vec![json!(1), json!(2), json!(3)],
            "a disable and an entry with no expiry both outlive the purge"
        );

        let later = purge_expired(&mut entries, at("2099-01-01T00:00:00Z"));
        assert_eq!(later.len(), 1, "only the dated entry ever becomes due");
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn an_entry_is_due_at_its_expiry_and_not_a_moment_before() {
        // The instant itself, on the stored-value path the purge actually uses.
        // A boundary off by one here either keeps a record a day past the date
        // the user was shown, or deletes it a day early.
        let expires_at = at("2026-01-31T00:00:00Z");
        let entry = deleted_entry(0, Some(expires_at));
        assert!(!is_expired(&entry, expires_at - Duration::milliseconds(1)));
        assert!(is_expired(&entry, expires_at));

        let mut just_before = vec![entry.clone()];
        assert!(purge_expired(&mut just_before, expires_at - Duration::milliseconds(1)).is_empty());
        let mut exactly = vec![entry];
        assert_eq!(purge_expired(&mut exactly, expires_at).len(), 1);
        assert!(exactly.is_empty());
    }

    #[test]
    fn purging_an_empty_store_is_not_an_error() {
        let mut entries: Vec<Value> = Vec::new();
        assert!(purge_expired(&mut entries, Utc::now()).is_empty());
    }

    // ── Eviction ────────────────────────────────────────────────────────

    #[test]
    fn eviction_gives_up_an_expired_entry_before_a_live_one() {
        let now = at("2026-02-01T00:00:00Z");
        let mut entries = vec![
            disabled_entry(0),
            deleted_entry(1, Some(at("2026-03-01T00:00:00Z"))),
            deleted_entry(2, Some(at("2026-01-01T00:00:00Z"))),
        ];

        let evicted = evict_to_cap(&mut entries, MIN_RETAINED_ENTRY_LIMIT.max(2), now);
        assert_eq!(evicted.len(), 0, "two entries is under the floor of ten");

        // Every entry here is an expendable bin entry, and the expired one is
        // the *newest* of them. So the two rules disagree about the victim —
        // "oldest expendable" would take seq 0 — and only the expiry rule
        // produces seq 11. A test where both rules agree proves neither.
        let mut entries: Vec<Value> = (0..11)
            .map(|seq| deleted_entry(seq, Some(at("2026-06-01T00:00:00Z"))))
            .collect();
        entries.push(deleted_entry(11, Some(at("2026-01-01T00:00:00Z"))));
        let evicted = evict_to_cap(&mut entries, 10, now);

        assert_eq!(evicted.len(), 2);
        assert_eq!(
            evicted[0].entry["seq"],
            json!(11),
            "the expired entry goes first even though it is the newest"
        );
        assert_eq!(evicted[0].cause, EvictionCause::EntryLimit);
        assert_eq!(
            evicted[1].entry["seq"],
            json!(0),
            "and only then does the oldest live bin entry yield"
        );
    }

    #[test]
    fn eviction_gives_up_the_recycle_bin_before_a_disabled_record() {
        let now = at("2026-02-01T00:00:00Z");
        let mut entries = Vec::new();
        for seq in 0..6 {
            entries.push(disabled_entry(seq));
        }
        for seq in 10..16 {
            entries.push(deleted_entry(seq, Some(at("2026-06-01T00:00:00Z"))));
        }

        let evicted = evict_to_cap(&mut entries, 10, now);
        assert_eq!(evicted.len(), 2);
        assert_eq!(
            evicted
                .iter()
                .map(|e| e.entry["seq"].clone())
                .collect::<Vec<_>>(),
            vec![json!(10), json!(11)],
            "the oldest bin entries yield; a disable has no other copy anywhere"
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| reason_of(entry) == RetentionReason::Disabled)
                .count(),
            6,
            "every disabled record survives while the bin still has anything to give"
        );
    }

    #[test]
    fn a_disabled_record_is_never_evicted_even_when_that_means_staying_over_the_bound() {
        let now = at("2026-02-01T00:00:00Z");
        let mut entries = (0..14).map(disabled_entry).collect::<Vec<_>>();
        let evicted = evict_to_cap(&mut entries, 10, now);

        assert!(
            evicted.is_empty(),
            "a disabled record is the only copy of something already gone from \
             the provider; the bound yields before it does"
        );
        assert_eq!(entries.len(), 14, "nothing was given up");
        assert!(
            !fits_after_eviction(&entries, 512, 10, now),
            "so the store has to refuse the newcomer instead, which costs \
             nothing: the record stays live at the provider"
        );
    }

    #[test]
    fn an_unknown_reason_is_protected_the_way_a_disable_is() {
        let now = at("2026-02-01T00:00:00Z");
        let mut quarantined = disabled_entry(0);
        quarantined["reason"] = json!("quarantined_by_a_newer_build");
        assert!(
            is_protected(&quarantined, now),
            "a reason this build cannot classify must not be the expendable one"
        );

        let mut entries: Vec<Value> = (0..14)
            .map(|seq| {
                let mut entry = disabled_entry(seq);
                entry["reason"] = json!("quarantined_by_a_newer_build");
                entry
            })
            .collect();
        assert!(evict_to_cap(&mut entries, 10, now).is_empty());
        assert_eq!(entries.len(), 14);
    }

    #[test]
    fn a_bin_entry_is_expendable_and_an_expired_one_is_not_protected() {
        let now = at("2026-02-01T00:00:00Z");
        assert!(
            !is_protected(&deleted_entry(0, Some(at("2026-06-01T00:00:00Z"))), now),
            "a live bin entry has a finite life the user already accepted"
        );
        assert!(
            !is_protected(&deleted_entry(1, None), now),
            "a bin entry with no expiry is still a bin entry"
        );
        let mut expired_disable = disabled_entry(2);
        expired_disable["expires_at"] = json!("2026-01-01T00:00:00+00:00");
        assert!(
            !is_protected(&expired_disable, now),
            "an entry past the date it was given is not protected, whatever \
             its reason"
        );
    }

    #[test]
    fn the_capacity_check_answers_the_worst_case_eviction_could_reach() {
        let now = at("2026-02-01T00:00:00Z");
        // Nine protected entries under a cap of ten: one slot left.
        let nine_disabled: Vec<Value> = (0..9).map(disabled_entry).collect();
        assert!(fits_after_eviction(&nine_disabled, 512, 10, now));

        let ten_disabled: Vec<Value> = (0..10).map(disabled_entry).collect();
        assert!(!fits_after_eviction(&ten_disabled, 512, 10, now));

        // The same ten slots, but filled with bin entries: every one of them
        // can be given up, so there is always room.
        let ten_binned: Vec<Value> = (0..10)
            .map(|seq| deleted_entry(seq, Some(at("2026-06-01T00:00:00Z"))))
            .collect();
        assert!(
            fits_after_eviction(&ten_binned, 512, 10, now),
            "a full bin of bin entries is room, not a refusal"
        );

        // And a `true` has to be honest: eviction must actually get there.
        let mut entries = ten_binned;
        entries.push(deleted_entry(99, Some(at("2026-06-01T00:00:00Z"))));
        let evicted = evict_to_cap(&mut entries, 10, now);
        assert_eq!(evicted.len(), 1);
        assert_eq!(entries.len(), 10);
    }

    #[test]
    fn the_capacity_check_refuses_on_bytes_as_well_as_on_count() {
        let now = at("2026-02-01T00:00:00Z");
        // One protected entry and a newcomer the size of the whole budget:
        // nowhere near the entry cap, and still no room. Without the byte term
        // this reads as "plenty of slots free".
        let one_disabled = vec![disabled_entry(0)];
        assert!(
            !fits_after_eviction(&one_disabled, MAX_RETAINED_BYTES, MAX_RETAINED_ENTRIES, now),
            "two entries is far under the entry cap, so only the byte budget \
             can be what refuses this"
        );
        assert!(
            fits_after_eviction(
                &one_disabled,
                MAX_RETAINED_ENTRY_BYTES,
                MAX_RETAINED_ENTRIES,
                now
            ),
            "and one maximal entry still fits, or retaining would be impossible"
        );

        // Bulky protected entries, well inside the entry cap, that between them
        // fill the budget.
        let bulky = "x".repeat(MAX_RETAINED_CONTENT_BYTES - 2);
        let heavy: Vec<Value> = (0..400)
            .map(|seq| {
                let mut value =
                    RetainedRecord::new(RetentionReason::DISABLED, "zone-1", "example.com")
                        .snapshot(snapshot("TXT", "big.example.com", &bulky))
                        .removed_at(at("2026-01-01T00:00:00Z"))
                        .into_value();
                value["seq"] = json!(seq);
                value
            })
            .collect();
        assert!(
            heavy.len() < MAX_RETAINED_ENTRIES,
            "the count is not the bound here"
        );
        assert!(serialized_store_len(&heavy) > MAX_RETAINED_BYTES);
        assert!(!fits_after_eviction(&heavy, 512, MAX_RETAINED_ENTRIES, now));
    }

    #[test]
    fn a_mixed_store_keeps_every_disable_and_gives_up_the_bin_entirely() {
        let now = at("2026-02-01T00:00:00Z");
        let mut entries: Vec<Value> = (0..8).map(disabled_entry).collect();
        for seq in 20..26 {
            entries.push(deleted_entry(seq, Some(at("2026-06-01T00:00:00Z"))));
        }

        let evicted = evict_to_cap(&mut entries, 10, now);
        assert_eq!(evicted.len(), 4, "four bin entries bought the four slots");
        assert!(
            evicted
                .iter()
                .all(|item| reason_of(&item.entry) == RetentionReason::Deleted),
            "and not one disable was touched"
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| reason_of(entry) == RetentionReason::Disabled)
                .count(),
            8
        );
    }

    #[test]
    fn eviction_holds_the_byte_bound_even_under_the_entry_bound() {
        let now = at("2026-02-01T00:00:00Z");
        let bulky = "x".repeat(MAX_RETAINED_CONTENT_BYTES - 2);
        let mut entries: Vec<Value> = (0..MAX_RETAINED_ENTRIES)
            .map(|seq| {
                let mut value =
                    RetainedRecord::new(RetentionReason::DELETED, "zone-1", "example.com")
                        .snapshot(snapshot("TXT", "big.example.com", &bulky))
                        .removed_at(at("2026-01-01T00:00:00Z"))
                        .expiring_after(Some(MAX_RETENTION_DAYS), at("2026-01-01T00:00:00Z"))
                        .into_value();
                value["seq"] = json!(seq);
                value
            })
            .collect();

        let evicted = evict_to_cap(&mut entries, MAX_RETAINED_ENTRIES, now);
        assert!(
            !evicted.is_empty(),
            "a thousand four-kilobyte entries cannot all be kept"
        );
        assert!(
            evicted.iter().all(|e| e.cause == EvictionCause::ByteLimit),
            "and the bound that bound was the byte one, not the count"
        );
        assert!(
            serialized_store_len(&entries) <= MAX_RETAINED_BYTES,
            "the store is {} bytes, over the {MAX_RETAINED_BYTES} budget",
            serialized_store_len(&entries)
        );
        assert!(
            serialized_store_len(&entries) + MAX_RETAINED_ENTRIES + 2 <= MAX_SECRET_BYTES,
            "and therefore still fits the secret it is written into"
        );
    }

    #[test]
    fn the_byte_accounting_matches_what_is_actually_written() {
        let entries = vec![disabled_entry(0), deleted_entry(1, None)];
        assert_eq!(
            serialized_store_len(&entries),
            Value::Array(entries.clone()).to_string().len(),
            "an eviction loop that mismeasures the store either over-evicts or \
             overruns the secret"
        );
    }

    // ── Eviction: where undo material sits in the order ─────────────────

    #[test]
    fn eviction_gives_up_a_superseded_snapshot_before_a_deleted_records_only_copy() {
        let now = at("2026-02-01T00:00:00Z");
        let live = Some(at("2026-06-01T00:00:00Z"));
        // The bin entries are the older ones, so "oldest expendable" and
        // "cheapest class" disagree about the victim: only the class rule
        // produces 20 and 21. A test where both rules agree proves neither.
        let mut entries: Vec<Value> = (0..10).map(|seq| deleted_entry(seq, live)).collect();
        for seq in 20..22 {
            entries.push(superseded_entry(seq, "zone-1", "op-1", live));
        }

        let evicted = evict_to_cap(&mut entries, 10, now);
        assert_eq!(evicted.len(), 2);
        assert_eq!(
            evicted
                .iter()
                .map(|item| item.entry["seq"].clone())
                .collect::<Vec<_>>(),
            vec![json!(20), json!(21)],
            "the revert yields first even though it is the newest thing in the \
             store: a deleted record's snapshot is the only copy of a record \
             that exists nowhere, and a superseded one is not"
        );
        assert!(
            entries
                .iter()
                .all(|entry| reason_of(entry) == RetentionReason::Deleted),
            "and the bin is untouched while there was undo material to give"
        );
    }

    #[test]
    fn an_expired_entry_still_goes_before_a_live_superseded_snapshot() {
        let now = at("2026-02-01T00:00:00Z");
        let live = Some(at("2026-06-01T00:00:00Z"));
        let mut entries: Vec<Value> = (0..10)
            .map(|seq| superseded_entry(seq, "zone-1", "op-1", live))
            .collect();
        let mut past_its_date = disabled_entry(99);
        past_its_date["expires_at"] = json!("2026-01-01T00:00:00+00:00");
        entries.push(past_its_date);

        let evicted = evict_to_cap(&mut entries, 10, now);
        assert_eq!(evicted.len(), 1);
        assert_eq!(
            evicted[0].entry["seq"],
            json!(99),
            "an entry past the date the user was shown costs nothing that was \
             promised, so it goes before a snapshot that is still inside its"
        );
    }

    #[test]
    fn one_zones_bulk_edit_cannot_crowd_out_another_zones_undo() {
        let now = at("2026-02-01T00:00:00Z");
        let live = Some(at("2026-06-01T00:00:00Z"));
        // The quiet zone's snapshot is the oldest thing in the store, so plain
        // oldest-first eviction would take it first — and it is the only undo
        // that zone has.
        let mut entries = vec![superseded_entry(0, "zone-quiet", "op-quiet", live)];
        for seq in 1..12 {
            entries.push(superseded_entry(seq, "zone-busy", "op-busy", live));
        }

        let evicted = evict_to_cap(&mut entries, 10, now);
        assert_eq!(evicted.len(), 2);
        assert_eq!(
            evicted
                .iter()
                .map(|item| item.entry["seq"].clone())
                .collect::<Vec<_>>(),
            vec![json!(1), json!(2)],
            "the zone being worked in pays for its own history, oldest of its \
             own first"
        );
        assert!(
            entries.iter().any(|entry| entry["seq"] == json!(0)),
            "a zone untouched for a month does not lose its undo to one the \
             user is hammering"
        );
    }

    #[test]
    fn two_zones_holding_the_same_number_are_separated_by_store_order() {
        let now = at("2026-02-01T00:00:00Z");
        let live = Some(at("2026-06-01T00:00:00Z"));
        // Five each, interleaved, zone-b first. Tied on count, so the choice
        // can only come from position — a hash map's iteration order would
        // make this test flap instead of fail.
        let mut entries: Vec<Value> = (0..10)
            .map(|seq| {
                let zone = if seq % 2 == 0 { "zone-b" } else { "zone-a" };
                superseded_entry(seq, zone, "op-1", live)
            })
            .collect();
        entries.push(deleted_entry(99, live));

        let evicted = evict_to_cap(&mut entries, 10, now);
        assert_eq!(evicted.len(), 1);
        assert_eq!(
            evicted[0].entry["seq"],
            json!(0),
            "the oldest snapshot of a zone tied for the most of them"
        );
    }

    #[test]
    fn a_store_full_of_superseded_snapshots_is_room_rather_than_a_refusal() {
        let now = at("2026-02-01T00:00:00Z");
        let live = Some(at("2026-06-01T00:00:00Z"));
        let full: Vec<Value> = (0..10)
            .map(|seq| superseded_entry(seq, "zone-1", "op-1", live))
            .collect();
        assert!(
            fits_after_eviction(&full, 512, 10, now),
            "every one of them may be given up, so a retain is not refused"
        );

        // And the `true` has to be honest: eviction must actually get there.
        let mut entries = full;
        entries.push(superseded_entry(99, "zone-1", "op-2", live));
        assert_eq!(evict_to_cap(&mut entries, 10, now).len(), 1);
        assert_eq!(entries.len(), 10);
    }

    // ── Reads ───────────────────────────────────────────────────────────

    #[test]
    fn a_zone_read_is_newest_first_and_takes_the_newest_at_a_limit() {
        let made = |seq: usize, zone: &str, removed: Option<&str>| {
            let mut entry = RetainedRecord::new(RetentionReason::SUPERSEDED, zone, "example.com")
                .operation_id("op-1")
                .snapshot(snapshot("A", &format!("r{seq}.example.com"), "203.0.113.7"));
            if let Some(removed) = removed {
                entry = entry.removed_at(at(removed));
            }
            entry.into_value()
        };
        let entries = vec![
            made(0, "zone-1", Some("2026-01-01T00:00:00Z")),
            made(1, "zone-2", Some("2026-05-01T00:00:00Z")),
            made(2, "zone-1", Some("2026-03-01T00:00:00Z")),
            made(3, "zone-1", None),
            made(4, "zone-1", Some("2026-02-01T00:00:00Z")),
        ];

        let names = |read: Vec<RetainedRecord>| {
            read.into_iter()
                .map(|entry| entry.snapshot.name)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(snapshots_for_zone(
                &entries,
                "zone-1",
                MAX_RETAINED_READ_ENTRIES
            )),
            vec![
                "r2.example.com",
                "r4.example.com",
                "r0.example.com",
                "r3.example.com",
            ],
            "newest first, another zone's entry left out, and the entry with \
             no recorded moment last — an unknown date is not a recent one"
        );
        assert_eq!(
            names(snapshots_for_zone(&entries, "zone-1", 1)),
            vec!["r2.example.com"],
            "a limit takes the newest, not whichever the store happens to hold \
             first"
        );
        assert_eq!(snapshots_for_zone(&entries, "zone-1", 2).len(), 2);
        assert!(
            snapshots_for_zone(&entries, "zone-1", 0).is_empty(),
            "zero is a count, not a sentinel for 'everything'"
        );
        assert!(snapshots_for_zone(&entries, "zone-3", 10).is_empty());
        for blank in ["", "   "] {
            assert!(snapshots_for_zone(&entries, blank, 10).is_empty());
        }
    }

    #[test]
    fn a_zone_read_hides_neither_a_binned_record_nor_an_expired_snapshot() {
        let entries = vec![
            disabled_entry(0),
            deleted_entry(1, Some(at("2026-06-01T00:00:00Z"))),
            superseded_entry(2, "zone-1", "op-1", Some(at("2026-01-10T00:00:00Z"))),
            superseded_entry(3, "zone-2", "op-1", Some(at("2026-06-01T00:00:00Z"))),
        ];

        let read = snapshots_for_zone(&entries, "zone-1", MAX_RETAINED_READ_ENTRIES);
        assert_eq!(
            read.iter()
                .map(|entry| entry.reason_kind())
                .collect::<Vec<_>>(),
            vec![
                RetentionReason::Disabled,
                RetentionReason::Deleted,
                RetentionReason::Superseded,
            ],
            "undoing a delete means re-creating from the deleted entry, so the \
             read cannot filter by reason — and entries sharing a moment keep \
             the order the store holds them in"
        );

        let expired = read
            .iter()
            .find(|entry| entry.reason_kind() == RetentionReason::Superseded)
            .expect("the superseded entry");
        assert!(
            expired.is_expired(at("2026-02-01T00:00:00Z")),
            "an expired snapshot no purge has swept yet is still readable, so \
             the UI can say 'expired on the 10th' rather than 'no snapshot' — \
             two things a user reads very differently"
        );
    }

    #[test]
    fn an_operation_read_returns_that_actions_entries_in_the_order_written() {
        let live = Some(at("2026-06-01T00:00:00Z"));
        let entries = vec![
            superseded_entry(0, "zone-1", "op-bulk", live),
            deleted_entry(1, live),
            superseded_entry(2, "zone-2", "op-bulk", live),
            superseded_entry(3, "zone-1", "op-other", live),
            superseded_entry(4, "zone-1", "op-bulk", live),
        ];

        let group = snapshots_for_operation(&entries, "op-bulk");
        assert_eq!(
            group
                .iter()
                .map(|entry| entry.snapshot.name.clone())
                .collect::<Vec<_>>(),
            vec!["s0.example.com", "s2.example.com", "s4.example.com"],
            "the whole action in the order it was recorded, which is the order \
             an undo replays it in, and nothing that belongs to another action"
        );
        assert!(group
            .iter()
            .all(|entry| entry.operation_id.as_deref() == Some("op-bulk")));
        assert!(snapshots_for_operation(&entries, "op-missing").is_empty());
    }

    #[test]
    fn a_read_cannot_be_made_to_return_more_than_the_store_may_hold() {
        let live = Some(at("2026-06-01T00:00:00Z"));
        let oversized: Vec<Value> = (0..MAX_RETAINED_READ_ENTRIES + 5)
            .map(|seq| superseded_entry(seq, "zone-1", "op-1", live))
            .collect();

        assert_eq!(
            snapshots_for_zone(&oversized, "zone-1", usize::MAX).len(),
            MAX_RETAINED_READ_ENTRIES,
            "a limit past the bound is clamped to it"
        );
        assert_eq!(
            snapshots_for_operation(&oversized, "op-1").len(),
            MAX_RETAINED_READ_ENTRIES,
            "and a store somehow holding more than the bound — hand edited into \
             the keyring — cannot make a read unbounded"
        );
    }

    // ── Operation manifests ─────────────────────────────────────────────

    /// A manifest listing `ids` plausible Cloudflare record ids: 32 hex-ish
    /// characters each, distinct across both arguments.
    fn manifest_entry(
        seq: usize,
        zone_id: &str,
        operation_id: &str,
        ids: usize,
        expires_at: Option<DateTime<Utc>>,
    ) -> Value {
        let created: Vec<String> = (0..ids)
            .map(|index| format!("{seq:02}{index:030}"))
            .collect();
        let mut manifest = OperationManifest::new(zone_id, operation_id)
            .created_record_ids(&created)
            .recorded_at(at("2026-01-01T00:00:00Z"));
        manifest.expires_at = expires_at;
        let mut value = manifest.into_value();
        value["seq"] = json!(seq);
        value
    }

    #[test]
    fn a_manifest_round_trips_its_ids_its_count_and_its_expiry() {
        let ids = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
        let written = OperationManifest::new("zone-1", "op-import")
            .created_record_ids(&ids)
            .recorded_at(at("2026-03-01T12:00:00Z"))
            .expiring_after(Some(DEFAULT_RETENTION_DAYS), at("2026-03-01T12:00:00Z"))
            .into_value();

        assert_eq!(written["reason"], json!("operation_manifest"));
        assert_eq!(written["zone_id"], json!("zone-1"));
        assert_eq!(written["operation_id"], json!("op-import"));
        assert_eq!(written["created_record_count"], json!(3));
        assert_eq!(written["created_record_ids"][2], json!(ids[2]));
        assert!(
            entry_id_of(&written).is_some_and(|id| id.starts_with("man_")),
            "the store addresses a manifest by entry id like anything else"
        );
        assert!(
            is_manifest(&written),
            "and a caller can tell it is not a record without parsing it"
        );

        let parsed = OperationManifest::of(&written).expect("parses");
        assert_eq!(parsed.created_record_ids, ids);
        assert_eq!(parsed.created_record_count, Some(3));
        assert_eq!(parsed.operation_id, "op-import");
        assert_eq!(parsed.recorded_at, Some(at("2026-03-01T12:00:00Z")));
        assert_eq!(parsed.expires_at, Some(at("2026-03-31T12:00:00Z")));
        assert!(parsed.is_complete(), "it listed everything it was given");
        assert_eq!(parsed.omitted(), 0);

        let rewritten = parsed.into_value();
        assert_eq!(rewritten["created_record_ids"][1], json!(ids[1]));
        assert_eq!(
            rewritten["created_record_count"],
            json!(3),
            "a count dropped on rewrite reads as an incomplete manifest, which \
             silently withdraws the undo of an import that was fine"
        );
    }

    #[test]
    fn a_manifest_that_cannot_hold_every_id_says_how_many_it_is_missing() {
        let created: Vec<String> = (0..MAX_MANIFEST_RECORD_IDS + 212)
            .map(|index| format!("{index:032}"))
            .collect();
        let manifest = OperationManifest::new("zone-1", "op-big").created_record_ids(&created);

        assert_eq!(manifest.created_record_ids.len(), MAX_MANIFEST_RECORD_IDS);
        assert_eq!(
            manifest.created_record_count,
            Some(MAX_MANIFEST_RECORD_IDS + 212)
        );
        assert!(
            !manifest.is_complete(),
            "half an undo is worse than none, so this must be visibly partial"
        );
        assert_eq!(manifest.omitted(), 212, "and say by how much, in records");

        // Through the store, because that is where the reader sees it.
        let parsed = OperationManifest::of(&manifest.into_value()).expect("parses");
        assert!(!parsed.is_complete());
        assert_eq!(parsed.omitted(), 212);
    }

    #[test]
    fn an_unusable_record_id_is_left_out_whole_rather_than_cut_down_to_fit() {
        let absurd = "f".repeat(MAX_MANIFEST_RECORD_ID_BYTES * 4);
        let ids = [
            "a".repeat(32),
            absurd.clone(),
            String::new(),
            "   ".to_string(),
            "b".repeat(32),
        ];
        let manifest = OperationManifest::new("zone-1", "op-odd").created_record_ids(&ids);

        assert_eq!(
            manifest.created_record_ids,
            vec!["a".repeat(32), "b".repeat(32)],
            "an over-long id and a blank one are dropped, and nothing stored \
             is a piece of an id: a delete issued against half an id is a \
             delete issued against a guess"
        );
        assert!(manifest
            .created_record_ids
            .iter()
            .all(|id| !absurd.starts_with(id.as_str()) || id.len() == absurd.len()));
        assert_eq!(manifest.created_record_count, Some(5));
        assert!(
            !manifest.is_complete() && manifest.omitted() == 3,
            "the three it could not keep are counted, so the undo is refused \
             rather than run against four fifths of an import"
        );
    }

    #[test]
    fn a_manifest_with_no_count_reads_as_incomplete_rather_than_as_whole() {
        let stored = json!({
            "entry_id": "man_1",
            "reason": "operation_manifest",
            "zone_id": "zone-1",
            "operation_id": "op-1",
            "created_record_ids": ["a".repeat(32), "b".repeat(32)],
        });
        let parsed = OperationManifest::of(&stored).expect("parses");
        assert_eq!(parsed.created_record_ids.len(), 2);
        assert!(
            !parsed.is_complete(),
            "a manifest that cannot prove it is complete must not be treated \
             as complete; the fail-closed direction refuses an undo, the other \
             one runs a partial delete and reports success"
        );
        assert_eq!(
            parsed.omitted(),
            0,
            "but it cannot say how many are missing"
        );
    }

    #[test]
    fn a_newer_builds_manifest_fields_survive_a_round_trip_through_this_one() {
        let stored = json!({
            "entry_id": "man_1",
            "reason": "operation_manifest",
            "zone_id": "zone-1",
            "operation_id": "op-1",
            "created_record_ids": ["a".repeat(32)],
            "created_record_count": 1,
            "created_record_names": ["www.example.com"],
        });
        let rewritten = OperationManifest::of(&stored).expect("parses").into_value();
        assert_eq!(
            rewritten["created_record_names"],
            json!(["www.example.com"])
        );
        assert_eq!(rewritten["created_record_count"], json!(1));
    }

    #[test]
    fn a_manifest_is_not_a_record_and_a_record_is_not_a_manifest() {
        let record = superseded_entry(0, "zone-1", "op-1", None);
        assert!(
            OperationManifest::of(&record).is_none(),
            "reading a record as a manifest would be an operation that created \
             nothing, which an undo would carry out happily"
        );
        assert!(!is_manifest(&record));
        assert!(OperationManifest::of(&json!({})).is_none());
        assert!(OperationManifest::of(&json!("not an object")).is_none());

        let manifest = manifest_entry(1, "zone-1", "op-1", 3, None);
        assert!(
            !RetainedRecord::of(&manifest)
                .expect("any object parses as a record")
                .is_restorable(),
            "and a manifest read as a record is at least unrestorable, which \
             is why the reads leave it out rather than relying on this"
        );
    }

    #[test]
    fn the_record_reads_leave_manifests_out() {
        let live = Some(at("2026-06-01T00:00:00Z"));
        let entries = vec![
            superseded_entry(0, "zone-1", "op-1", live),
            manifest_entry(1, "zone-1", "op-1", 3, live),
        ];

        let by_zone = snapshots_for_zone(&entries, "zone-1", MAX_RETAINED_READ_ENTRIES);
        assert_eq!(by_zone.len(), 1);
        assert_eq!(by_zone[0].snapshot.name, "s0.example.com");

        let by_operation = snapshots_for_operation(&entries, "op-1");
        assert_eq!(
            by_operation.len(),
            1,
            "an undo that iterated a manifest as a record would try to restore \
             a record with no name"
        );
        assert_eq!(by_operation[0].reason_kind(), RetentionReason::Superseded);
    }

    /// The ids a bulk create of `count` records would hand over.
    fn created_ids(count: usize) -> Vec<String> {
        (0..count).map(|index| format!("{index:032}")).collect()
    }

    /// An import, written the way a caller writes it, and read back as stored
    /// values.
    fn import(zone_id: &str, operation_id: &str, ids: &[String]) -> Vec<Value> {
        manifests_for_created_records(
            zone_id,
            operation_id,
            ids,
            Some(DEFAULT_RETENTION_DAYS),
            at("2026-01-01T00:00:00Z"),
        )
        .into_iter()
        .map(OperationManifest::into_value)
        .collect()
    }

    #[test]
    fn a_manifest_is_found_by_operation_id_and_other_operations_are_not() {
        let live = Some(at("2026-06-01T00:00:00Z"));
        let entries = vec![
            manifest_entry(0, "zone-1", "op-other", 2, live),
            superseded_entry(1, "zone-1", "op-import", live),
            manifest_entry(2, "zone-1", "op-import", 3, live),
        ];

        let found = created_records_for_operation(&entries, "op-import").expect("the import");
        assert_eq!(found.record_ids.len(), 3);
        assert_eq!(found.operation_id, "op-import");
        assert_eq!(found.parts, 1, "the superseded entry is not a manifest");
        assert!(created_records_for_operation(&entries, "op-missing").is_none());
        for blank in ["", "   "] {
            assert!(created_records_for_operation(&entries, blank).is_none());
        }
        assert_eq!(manifests_for_operation(&entries, "op-import").len(), 1);
        assert!(manifests_for_operation(&entries, "").is_empty());
    }

    #[test]
    fn a_large_import_is_written_as_several_manifests_and_read_back_whole() {
        let ids = created_ids(412);
        let parts = manifests_for_created_records(
            "zone-1",
            "op-import",
            &ids,
            Some(DEFAULT_RETENTION_DAYS),
            at("2026-01-01T00:00:00Z"),
        );

        assert_eq!(parts.len(), 3, "200 + 200 + 12");
        assert_eq!(
            parts
                .iter()
                .map(|part| part.created_record_ids.len())
                .collect::<Vec<_>>(),
            vec![200, 200, 12]
        );
        assert!(
            parts
                .iter()
                .all(|part| part.created_record_count == Some(412)),
            "every part carries the operation's total, not its own slice's — \
             that is what makes a lost part detectable"
        );
        assert!(
            parts.iter().all(|part| !part.is_complete()),
            "and so no single part of a set ever reads as a whole operation; a \
             reader that finds one in isolation refuses"
        );
        assert!(
            parts
                .iter()
                .all(|part| part.expires_at == Some(at("2026-01-31T00:00:00Z"))),
            "one window for the whole import"
        );
        for part in &parts {
            assert!(
                part.clone().into_value().to_string().len() <= MAX_RETAINED_ENTRY_BYTES,
                "every part has to fit the ceiling it was split to respect"
            );
        }

        let held = import("zone-1", "op-import", &ids);
        let found = created_records_for_operation(&held, "op-import").expect("the import");
        assert_eq!(found.parts, 3);
        assert_eq!(
            found.record_ids, ids,
            "concatenated in write order, so a preview lists the records in the \
             order the import created them"
        );
        assert!(found.is_complete(), "412 of 412");
        assert_eq!(found.omitted(), 0);
        assert_eq!(found.created_record_count, Some(412));
        assert_eq!(found.zone_id, "zone-1");
        assert_eq!(found.recorded_at, Some(at("2026-01-01T00:00:00Z")));
    }

    #[test]
    fn an_import_that_has_lost_a_part_is_incomplete_rather_than_short() {
        let ids = created_ids(412);
        let mut held = import("zone-1", "op-import", &ids);
        assert!(created_records_for_operation(&held, "op-import")
            .expect("the import")
            .is_complete());

        // Evicted, purged, or hand-deleted: the middle two hundred are gone.
        held.remove(1);

        let found = created_records_for_operation(&held, "op-import").expect("what is left");
        assert_eq!(found.parts, 2);
        assert_eq!(found.record_ids.len(), 212);
        assert!(
            !found.is_complete(),
            "the surviving parts still say the operation created 412, so the \
             gap is visible instead of the undo deleting 212 of them and \
             reporting success"
        );
        assert_eq!(
            found.omitted(),
            200,
            "and the UI can say which 200 are gone"
        );
    }

    #[test]
    fn a_retried_write_does_not_make_a_whole_import_look_incomplete() {
        let ids = created_ids(412);
        let mut held = import("zone-1", "op-import", &ids);
        let retried = import("zone-1", "op-import", &ids);
        held.extend(retried);

        let found = created_records_for_operation(&held, "op-import").expect("the import");
        assert_eq!(found.parts, 6, "the store really does hold six manifests");
        assert_eq!(
            found.record_ids, ids,
            "but a record id names one record, so a repeat is a duplicate write \
             and not a second record"
        );
        assert!(found.is_complete());
    }

    #[test]
    fn parts_that_disagree_about_the_total_are_read_at_the_larger_one() {
        let ids = created_ids(412);
        let mut held = import("zone-1", "op-import", &ids);
        assert!(created_records_for_operation(&held, "op-import")
            .expect("the import")
            .is_complete());

        // One part understates the total. Taking the smallest, or the first,
        // would read 412 held ids against a total of 12 and call the set whole
        // on the strength of the part that knows least.
        held[1]["created_record_count"] = json!(12);
        let found = created_records_for_operation(&held, "op-import").expect("the import");
        assert_eq!(found.created_record_count, Some(412));
        assert!(found.is_complete(), "the parts that do know still say 412");

        // One part overstates it. A store that disagrees with itself was
        // written by something other than this build, and the total that
        // refuses the undo is the one to believe.
        held[1]["created_record_count"] = json!(900);
        let found = created_records_for_operation(&held, "op-import").expect("the import");
        assert_eq!(found.created_record_count, Some(900));
        assert!(!found.is_complete());
        assert_eq!(found.omitted(), 488);
    }

    #[test]
    fn an_import_past_the_part_ceiling_is_recorded_and_visibly_incomplete() {
        let total = MAX_MANIFEST_PARTS * MAX_MANIFEST_RECORD_IDS + 37;
        let ids = created_ids(total);
        let held = import("zone-1", "op-huge", &ids);

        assert_eq!(held.len(), MAX_MANIFEST_PARTS, "the parts are bounded");
        let found = created_records_for_operation(&held, "op-huge").expect("the import");
        assert_eq!(
            found.record_ids.len(),
            MAX_MANIFEST_PARTS * MAX_MANIFEST_RECORD_IDS
        );
        assert!(!found.is_complete());
        assert_eq!(found.omitted(), 37);

        // And a store holding more parts than this build writes is read at the
        // bound, not past it — which leaves the set incomplete, the safe way to
        // be wrong about a store this build did not write.
        let mut overfull = import("zone-1", "op-over", &created_ids(37));
        for _ in 0..MAX_MANIFEST_PARTS * 2 {
            overfull.extend(import("zone-1", "op-over", &created_ids(37)));
        }
        assert_eq!(
            manifests_for_operation(&overfull, "op-over").len(),
            MAX_MANIFEST_PARTS
        );
    }

    #[test]
    fn a_small_import_is_one_manifest_and_an_empty_one_is_none() {
        let ids = created_ids(12);
        let parts = manifests_for_created_records(
            "zone-1",
            "op-small",
            &ids,
            Some(DEFAULT_RETENTION_DAYS),
            at("2026-01-01T00:00:00Z"),
        );
        assert_eq!(parts.len(), 1);
        assert!(
            parts[0].is_complete(),
            "a one-part set's only part does account for the whole operation"
        );

        let held = import("zone-1", "op-small", &ids);
        let found = created_records_for_operation(&held, "op-small").expect("the import");
        assert!(found.is_complete() && found.omitted() == 0);
        assert_eq!(found.record_ids.len(), 12);

        let nothing: Vec<String> = Vec::new();
        assert!(
            manifests_for_created_records(
                "zone-1",
                "op-nothing",
                &nothing,
                Some(DEFAULT_RETENTION_DAYS),
                at("2026-01-01T00:00:00Z")
            )
            .is_empty(),
            "an operation that created nothing has nothing to undo, so it \
             writes no entry at all rather than an empty one"
        );
    }

    #[test]
    fn an_id_a_part_could_not_store_is_a_gap_in_the_whole_import() {
        let mut ids = created_ids(412);
        ids[5] = String::new();
        ids[204] = "f".repeat(MAX_MANIFEST_RECORD_ID_BYTES * 3);

        let held = import("zone-1", "op-import", &ids);
        let found = created_records_for_operation(&held, "op-import").expect("the import");
        assert_eq!(found.record_ids.len(), 410);
        assert!(
            !found.is_complete() && found.omitted() == 2,
            "a blank id and an unusable one are two records the undo cannot \
             name, counted across the whole set rather than lost inside a part"
        );
    }

    #[test]
    fn a_set_stops_being_whole_when_its_first_part_expires() {
        let ids = created_ids(412);
        let mut held = import("zone-1", "op-import", &ids);
        held[1]["expires_at"] = json!(at("2026-01-10T00:00:00Z").to_rfc3339());

        let found = created_records_for_operation(&held, "op-import").expect("the import");
        assert_eq!(
            found.expires_at,
            Some(at("2026-01-10T00:00:00Z")),
            "the earliest part's expiry governs: the set stops being whole when \
             its first part becomes due, not its last"
        );
        assert!(found.is_expired(at("2026-01-10T00:00:00Z")));
        assert!(!found.is_expired(at("2026-01-09T23:59:59Z")));

        // And the purge agrees with that reading.
        let purged = purge_expired(&mut held, at("2026-01-11T00:00:00Z"));
        assert_eq!(purged.len(), 1);
        assert!(!created_records_for_operation(&held, "op-import")
            .expect("what is left")
            .is_complete());
    }

    #[test]
    fn a_manifest_is_given_up_after_an_edits_snapshot_and_before_the_bin() {
        let now = at("2026-02-01T00:00:00Z");
        let live = Some(at("2026-06-01T00:00:00Z"));
        let mut entries = vec![
            superseded_entry(0, "zone-1", "op-edit", live),
            superseded_entry(1, "zone-1", "op-edit", live),
            manifest_entry(10, "zone-1", "op-import-a", 4, live),
            manifest_entry(11, "zone-1", "op-import-b", 4, live),
        ];
        for seq in 20..31 {
            entries.push(deleted_entry(seq, live));
        }

        let evicted = evict_to_cap(&mut entries, 10, now);
        assert_eq!(
            evicted
                .iter()
                .map(|item| item.entry["seq"].clone())
                .collect::<Vec<_>>(),
            vec![json!(0), json!(1), json!(10), json!(11), json!(20)],
            "both edit snapshots, then both manifests, and only then the \
             oldest binned record — a manifest holds no record data, but one \
             covers a whole import, so it outranks a single edit's snapshot \
             and yields to the one copy of a deleted record"
        );
        assert_eq!(entries.len(), 10);
        assert!(
            entries
                .iter()
                .all(|entry| reason_of(entry) == RetentionReason::Deleted),
            "what is left is the bin"
        );
    }

    #[test]
    fn a_manifest_purges_and_is_unprotected_like_any_other_dated_entry() {
        let now = at("2026-02-01T00:00:00Z");
        assert!(RetentionReason::Manifest.is_expendable());
        assert!(!is_protected(
            &manifest_entry(0, "zone-1", "op-1", 2, Some(at("2026-06-01T00:00:00Z"))),
            now
        ));

        let mut entries = vec![
            manifest_entry(1, "zone-1", "op-1", 2, Some(at("2026-01-10T00:00:00Z"))),
            manifest_entry(2, "zone-1", "op-2", 2, Some(at("2026-06-01T00:00:00Z"))),
        ];
        let purged = purge_expired(&mut entries, now);
        assert_eq!(purged.len(), 1, "a manifest expires on the shared key");
        assert_eq!(purged[0]["seq"], json!(1));
        assert_eq!(entries.len(), 1);

        let fresh = OperationManifest::new("zone-1", "op-3")
            .recorded_at(at("2026-01-01T00:00:00Z"))
            .expiring_after(Some(0), at("2026-01-01T00:00:00Z"));
        assert_eq!(
            fresh.expires_at,
            Some(at("2026-01-01T00:00:00Z") + Duration::days(i64::from(MIN_RETENTION_DAYS))),
            "and its window is clamped the way a record's is"
        );
    }

    #[test]
    fn the_widest_manifest_the_builder_can_make_fits_the_per_entry_ceiling() {
        let long = "n".repeat(MAX_RETAINED_TEXT_BYTES * 2);
        let ids: Vec<String> = (0..MAX_MANIFEST_RECORD_IDS * 2)
            .map(|index| format!("{index:0width$}", width = MAX_MANIFEST_RECORD_ID_BYTES - 2))
            .collect();
        let mut manifest = OperationManifest::new(&long, &long)
            .created_record_ids(&ids)
            .recorded_at(at("2026-01-01T00:00:00Z"))
            .expiring_after(Some(MAX_RETENTION_DAYS), at("2026-01-01T00:00:00Z"));
        for index in 0..64 {
            manifest
                .extra
                .insert(format!("future_{index}"), json!("x".repeat(512)));
        }

        let serialized = manifest.into_value().to_string();
        assert!(
            serialized.len() <= MAX_RETAINED_ENTRY_BYTES,
            "manifest serialised to {} bytes, over the {MAX_RETAINED_ENTRY_BYTES} ceiling",
            serialized.len()
        );
    }

    // ── Restore ─────────────────────────────────────────────────────────

    #[test]
    fn a_free_name_has_no_obstacle_and_no_occupants() {
        let report = inspect_destination(
            &snapshot("A", "www.example.com", "203.0.113.1"),
            &[existing("A", "other.example.com", "203.0.113.2")],
        );
        assert!(report.obstacle.is_none());
        assert!(report.occupants.is_empty());
    }

    #[test]
    fn restoring_a_record_that_is_already_back_is_refused_rather_than_duplicated() {
        let report = inspect_destination(
            &snapshot("A", "www.example.com", "203.0.113.1"),
            &[existing("A", "WWW.example.com.", "203.0.113.1")],
        );
        let obstacle = report.obstacle.expect("an obstacle");
        assert_eq!(obstacle.as_str(), "already_present");
        assert_eq!(
            obstacle.existing().record_id.as_deref(),
            Some("cf-A-WWW.example.com."),
            "the caller is told which record matched, so the user can discard \
             the entry instead of restoring it"
        );
    }

    #[test]
    fn a_second_value_at_the_same_name_is_allowed_and_reported() {
        let report = inspect_destination(
            &snapshot("A", "www.example.com", "203.0.113.1"),
            &[
                existing("A", "www.example.com", "203.0.113.2"),
                existing("TXT", "www.example.com", "hello"),
            ],
        );
        assert!(
            report.obstacle.is_none(),
            "two A records at one name is ordinary DNS, not a conflict"
        );
        assert_eq!(
            report.occupants.len(),
            2,
            "but the user is told what it now shares the name with"
        );
    }

    #[test]
    fn a_cname_never_shares_a_name() {
        let onto_occupied = inspect_destination(
            &snapshot("CNAME", "www.example.com", "target.example.com"),
            &[existing("A", "www.example.com", "203.0.113.2")],
        );
        assert_eq!(
            onto_occupied.obstacle.expect("an obstacle").as_str(),
            "cname_collision"
        );

        let under_a_cname = inspect_destination(
            &snapshot("A", "www.example.com", "203.0.113.2"),
            &[existing("CNAME", "www.example.com", "target.example.com")],
        );
        assert_eq!(
            under_a_cname.obstacle.expect("an obstacle").as_str(),
            "cname_collision"
        );
    }

    #[test]
    fn a_duplicate_is_recognised_before_a_cname_collision_is() {
        // Both apply to the same pair; "it is already there" is the more
        // useful thing to tell the user, so it wins.
        let report = inspect_destination(
            &snapshot("CNAME", "www.example.com", "target.example.com"),
            &[existing("CNAME", "www.example.com", "TARGET.example.com")],
        );
        assert_eq!(
            report.obstacle.expect("an obstacle").as_str(),
            "already_present"
        );
    }

    #[test]
    fn an_entry_needs_a_zone_a_type_and_a_name_to_be_restorable() {
        let complete = RetainedRecord::new(RetentionReason::DELETED, "zone-1", "example.com")
            .snapshot(snapshot("A", "www.example.com", "203.0.113.1"));
        assert!(complete.is_restorable());

        let zoneless = RetainedRecord::new(RetentionReason::DELETED, "", "example.com")
            .snapshot(snapshot("A", "www.example.com", "203.0.113.1"));
        assert!(!zoneless.is_restorable());

        let nameless = RetainedRecord::new(RetentionReason::DELETED, "zone-1", "example.com")
            .snapshot(snapshot("A", "", "203.0.113.1"));
        assert!(!nameless.is_restorable());
    }

    #[test]
    fn tags_are_bounded_and_blank_ones_are_dropped() {
        let tags: Vec<String> = std::iter::once("  ".to_string())
            .chain((0..MAX_RETAINED_TAGS * 2).map(|index| format!("tag-{index}")))
            .collect();
        let entry =
            RetainedRecord::new(RetentionReason::DISABLED, "z", "example.com").local_tags(&tags);
        assert_eq!(entry.local_tags.len(), MAX_RETAINED_TAGS);
        assert_eq!(entry.local_tags[0], "tag-0");
    }
}
