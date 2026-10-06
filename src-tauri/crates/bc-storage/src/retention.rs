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
//! # One store, two intents
//!
//! A deletion and a disable are the same mechanism — removed there, retained
//! here — so they share one store and differ only in
//! [`reason`](RetainedRecord::reason) and lifetime:
//!
//! * `disabled` is indefinite and meant to be reversed. It has no expiry.
//! * `deleted` is a recycle-bin entry. It carries an
//!   [`expires_at`](RetainedRecord::expires_at) stamped when it was binned.
//!
//! Two stores would drift: the restore path, the conflict rules, the byte
//! budget and the audit entries are identical for both, and only one of them
//! would get the next bug fix.
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
const RETAINED_OVERHEAD_BYTES: usize = 318;

/// Serialised bytes a full tag list occupies: the tags, their commas, and the
/// brackets.
const RETAINED_TAGS_BYTES: usize = MAX_RETAINED_TAGS * MAX_RETAINED_TAG_BYTES + MAX_RETAINED_TAGS;

/// The six short text fields: `reason`, `zone_id`, `zone_name`,
/// `origin_record_id`, `type` and `name`.
const RETAINED_TEXT_FIELDS: usize = 6;

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
const KNOWN_KEYS: [&str; 15] = [
    KEY_ENTRY_ID,
    KEY_REASON,
    KEY_ZONE_ID,
    KEY_ZONE_NAME,
    KEY_ORIGIN_RECORD_ID,
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
            _ => Self::Unknown,
        }
    }

    /// Whether an entry with this reason is given up before one that is
    /// indefinite. See [`evict_to_cap`].
    pub const fn is_expendable(self) -> bool {
        matches!(self, Self::Deleted)
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
    /// When the record stopped existing at the provider. `None` for an entry
    /// that did not record it, or recorded something unparseable.
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
    /// [`RetentionReason::DELETED`], or whatever a future build uses.
    pub fn new(reason: &str, zone_id: &str, zone_name: &str) -> Self {
        Self {
            entry_id: format!("ret_{}", uuid::Uuid::new_v4()),
            reason: bounded_text(reason, MAX_RETAINED_TEXT_BYTES),
            zone_id: bounded_text(zone_id, MAX_RETAINED_TEXT_BYTES),
            zone_name: bounded_text(zone_name, MAX_RETAINED_TEXT_BYTES),
            origin_record_id: None,
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
/// An expired entry of any reason is not protected either — it is already past
/// the date it was given.
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
/// 2. **The oldest `deleted` entry.** A recycle-bin entry has a stated, finite
///    life the user already accepted; shortening it loses a little.
/// 3. **Nothing.** A protected entry — see [`is_protected`] — is never a
///    victim, so a store with no expired and no bin entries left simply stays
///    over its bound and this returns having evicted nothing.
///
/// That third case is why callers must ask [`fits_after_eviction`] *before*
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
    entries
        .iter()
        .position(|entry| reason_of(entry).is_expendable())
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
        for key in ["origin_record_id", "comment", "priority", "local_tags"] {
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
