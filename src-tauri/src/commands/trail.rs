//! How a **person's** action is written into the application's audit trail.
//!
//! `bc_storage::audit` owns the entry shape, the actor and outcome vocabulary,
//! and the retention rule that keeps the log's three writers from crowding
//! each other out. `bc_mcp::audit` owns the same job for a tool call. This
//! module is the third of those three, and the oldest: the commands in
//! `crate::commands` record what the person at the keyboard did.
//!
//! The log has three writers, and they all write one shape:
//!
//! * **A person in the app.** The commands in `crate::commands`, through the
//!   helpers below. Entries are labelled [`AuditActor::User`].
//! * **A client of the local MCP server.** Recorded in `bc_mcp`'s HTTP
//!   transport, one entry per tool call including the ones it refuses, plus the
//!   server's own start, stop and permission edits.
//! * **The AI assistant.** Recorded in `bc_ai_agent`'s run ledger, one entry
//!   per settled tool call — free-turn and plan step alike — plus the user's
//!   approval of a plan.
//!
//! The two non-human writers reach the log through [`bc_storage::AuditTrail`],
//! which makes the actor a required argument rather than something a caller can
//! forget. `Storage::audit_trail` hands out the handle; the MCP commands in
//! `crate::mcp_server` and the AI commands in `crate::ai_commands` pass it
//! down, because the managers that need it are built in `main` before the
//! managed `Storage` exists.
//!
//! # What a user entry carries, and what it never carries
//!
//! A tool call's arguments are **not** recorded, because every Cloudflare tool
//! takes an `api_key`; `bc_mcp::audit::describe_target` lifts a short allowlist
//! of identifying fields instead, and record `content` is deliberately not on
//! it. A person's own edit is judged differently, and this is the one place the
//! two halves of the trail diverge on purpose:
//!
//! * **Credentials are never recorded, in any form.** No API key, no token, no
//!   password, and no account email — the email is half of Cloudflare's global
//!   key credential, so it is a credential field and not a contact detail.
//!   Nothing here reads a command's `api_key` or `email` argument.
//! * **Record content is recorded**, for user actions only. It is the user's
//!   own data, in their own local log, and a change log that will not say what
//!   a record's content changed *to* has not answered the question it was
//!   opened for. It can hold key material — a DKIM private key, a service
//!   verification token — so three things hold the line around it: values are
//!   truncated to [`MAX_CHANGE_VALUE_BYTES`], the trail is stored as an
//!   encrypted secret like every other secret this app holds, and the
//!   diagnostics report does not read the audit log at all. That last one is
//!   the one that matters, because the diagnostics report is built to be pasted
//!   into a public issue; `test/diagnosticsAuditIsolation.test.ts` pins it.
//! * **Provider text is not recorded by anything here.** A failed call records
//!   this application's own classification of *where* it failed
//!   ([`failure_kind`]) and the HTTP status, never the message that came back.
//!   A trail is the wrong place to accumulate text of unknown provenance, and
//!   the command boundary already redacts those messages for the same reason —
//!   see `commands::dns`'s mapping tests. (`commands::retention` does record a
//!   bounded provider message on a failed restore, which predates this module;
//!   bounded, because it goes through [`AuditEntry::detail`] like everything
//!   else.)
//!
//! # Volume
//!
//! Every helper here builds through [`AuditEntry`], which bounds each text
//! field, the number of detail keys, and the total detail bytes, so one entry
//! cannot exceed `MAX_AUDIT_ENTRY_BYTES` however long a TXT value is. That
//! matters more than it looks: the whole log is one stored secret with a hard
//! 2 MB ceiling, a write over the ceiling fails, and the trail swallows its
//! write errors — so a single unbounded entry does not produce one big record,
//! it silently stops the log recording anything ever again. The untyped
//! `log_audit` path has no such bound, which is why the mutating commands no
//! longer use it.
//!
//! A bulk operation is **one** entry, never one per record. See
//! `commands::dns::create_bulk_dns_records`.

use bc_cloudflare_api::{
    CloudflareError, CloudflareHttpError, CloudflareTransportCategory, VerificationFailureKind,
};
use bc_storage::{
    AuditActor, AuditEntry, AuditOutcome, AuditTrail, EvictionCause, RecordSnapshot, RetainedRecord,
};
use serde_json::{json, Map, Value};

use crate::cloudflare_api::{DNSRecord, DNSRecordInput};

// ── Bounds ──────────────────────────────────────────────────────────────────

/// Bytes one before-or-after value may occupy.
///
/// Enough to recognise what a record was: any address, any hostname, and the
/// front of an SPF or DMARC policy. A longer value is shortened rather than
/// dropped, because "content changed to something beginning like this" is
/// worth having and "content changed" is not.
pub const MAX_CHANGE_VALUE_BYTES: usize = 110;

/// Bytes a whole `changes` or `record` detail may occupy, serialised.
///
/// A ceiling on top of the room [`AuditEntry::remaining_detail_bytes`]
/// reports, so a record's fields can never be the only thing an entry has
/// space for. Whichever of the two is smaller wins.
pub const MAX_RECORD_DETAIL_BYTES: usize = 420;

/// Appended to a value this module shortened, so a reader does not mistake the
/// truncation for the value.
///
/// Public because `commands::history` has to recognise it: a shortened value
/// cannot be compared for equality against what Cloudflare holds now, and a
/// drift check that treated a prefix match as a match would pre-select a row
/// and overwrite the rest of the record.
pub const TRUNCATION_MARKER: &str = "…";

/// `denied_by` for a record the local validation gate refused.
///
/// Same vocabulary as `bc_mcp::audit::DenialReason`: the layer that refused,
/// carried as a value rather than recovered from the refusal message.
pub const DENIED_BY_RECORD_VALIDATION: &str = "record_validation";

/// `denied_by` for a request this application refused on its own bounds —
/// an export page size, an unsupported format — before any HTTP call.
pub const DENIED_BY_REQUEST_BOUNDS: &str = "request_bounds";

// ── Operations ──────────────────────────────────────────────────────────────

/// The detail key that groups every entry one user action produced.
///
/// Read back by `commands::history`, which is the only reason it is a named
/// constant: a grouping key spelled by hand in two places is a grouping key
/// that silently stops grouping.
pub const OPERATION_ID_KEY: &str = "operation_id";

/// The detail key carrying when the snapshot that backs this entry's undo is
/// due to be purged.
///
/// On the *trail* entry as well as on the stored snapshot, and that redundancy
/// is the point. Once a snapshot leaves the store, the store cannot say why it
/// went — and `UndoAvailability` in `src/lib/history/types.ts` asks this
/// application to distinguish `expired` (which carries the date) from
/// `evicted`. With the expiry recorded here, a missing snapshot whose recorded
/// expiry has passed is `expired` and one whose expiry is still in the future
/// was `evicted`; without it, both are a guess, and telling a user their change
/// expired when the store actually threw it away early is a different
/// conversation about whether their retention window is too short.
///
/// Absent on an entry that took no snapshot, which is exactly what makes
/// `no-snapshot` decidable rather than assumed.
pub const UNDO_EXPIRES_AT_KEY: &str = "undo_expires_at";

/// Groups every entry produced by one user action.
///
/// One user action is not one command. A bulk entry is a single record of a
/// single call, but a selection the user deletes goes through
/// `commands::retention::retain_dns_record` once per record — thirty-seven
/// calls, thirty-seven entries, one thing the user did and expects to undo as
/// one. So the id can be *supplied* by the caller that knows the action's
/// extent, and is minted here when it is not. There is no second code path for
/// a single-record write: it is an operation of one with an id of its own.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct OperationId(String);

impl OperationId {
    /// Mint an id for one user action. A UUID v4, as the renderer's contract
    /// (`src/lib/history/types.ts`) states.
    pub fn mint() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    /// The id this action should be recorded under.
    ///
    /// A supplied id is honoured only if it is a well-formed, non-nil UUID;
    /// anything else is replaced with a fresh one rather than refused. Two
    /// reasons, and they point the same way:
    ///
    /// * **Refusing would cost the user their DNS edit.** An audit input must
    ///   never be able to fail a write — the same rule
    ///   [`RecordFacts::of_claim`] follows. Minting degrades the grouping of
    ///   one action; refusing degrades the zone.
    /// * **Trusting it would cost the grouping its meaning.** A free-text key
    ///   lets a caller file its entries under another action's id, or under a
    ///   constant — the nil UUID is the obvious one — which would collapse an
    ///   entire zone's history into one operation and offer to undo all of it
    ///   at once. A minted id is never wrong about which action it names.
    ///
    /// Any parseable UUID is accepted, not only a v4: minting is this
    /// application's choice, and rejecting a v7 from some later caller would
    /// be enforcing a version nothing here depends on.
    pub fn of(supplied: Option<&str>) -> Self {
        match supplied
            .map(str::trim)
            .and_then(|raw| uuid::Uuid::parse_str(raw).ok())
            .filter(|id| !id.is_nil())
        {
            Some(id) => Self(id.to_string()),
            None => Self::mint(),
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

// ── Entries ─────────────────────────────────────────────────────────────────

/// Open an entry for something the person at the keyboard did.
pub fn user_action(operation: &str, outcome: AuditOutcome) -> AuditEntry {
    AuditEntry::new(AuditActor::User, operation, outcome)
}

/// Stamp an entry with the action it belongs to.
///
/// Spent **first**, before the zone and before the record, and that ordering is
/// the point rather than a preference. [`AuditEntry::detail`] drops a detail
/// that does not fit the entry's budget, silently and by design, and an entry
/// whose operation id was dropped is an entry the history list cannot group and
/// undo cannot find — it would read as a separate, unundoable action. Forty-odd
/// bytes out of [`bc_storage::audit::MAX_AUDIT_DETAIL_BYTES`] buys that never
/// happening.
#[must_use]
pub fn stamp(entry: AuditEntry, operation: &OperationId) -> AuditEntry {
    entry.detail(OPERATION_ID_KEY, operation.as_str())
}

/// Record where a Cloudflare call stopped, and under what status.
///
/// Spent before the target fields, like the tool-call half does, because the
/// reason is the first thing a reader of a non-success entry wants.
#[must_use]
pub fn attach_failure(entry: AuditEntry, error: &CloudflareError) -> AuditEntry {
    entry
        .detail("failure", failure_kind(error))
        .optional_detail("status", failure_status(error))
}

/// Where a Cloudflare call stopped, in this application's own words.
///
/// Classified from the error's own type, never from its message: the messages
/// are provider text written for whoever was refused, and a trail that
/// string-matched them would quietly mis-file an entry the first time one was
/// reworded.
pub fn failure_kind(error: &CloudflareError) -> &'static str {
    match error {
        CloudflareError::HttpError(CloudflareHttpError::Transport(context)) => {
            match context.category {
                CloudflareTransportCategory::Timeout => "timeout",
                CloudflareTransportCategory::Dns
                | CloudflareTransportCategory::Connect
                | CloudflareTransportCategory::Other => "network",
            }
        }
        CloudflareError::HttpError(CloudflareHttpError::ResourceLimit(_))
        | CloudflareError::ResourceLimit(_) => "resource_limit",
        CloudflareError::Validation(_) => "request_bounds",
        CloudflareError::Request(detail) | CloudflareError::Verification(detail) => {
            match detail.kind {
                VerificationFailureKind::Authentication => "authentication",
                VerificationFailureKind::RateLimited => "rate_limited",
                VerificationFailureKind::Provider => "provider_refused",
                VerificationFailureKind::Network => "network",
                VerificationFailureKind::Timeout => "timeout",
                VerificationFailureKind::MalformedResponse => "malformed_response",
            }
        }
        CloudflareError::AuthFailed => "authentication",
        CloudflareError::RateLimited(_) => "rate_limited",
        CloudflareError::ApiError(_) => "provider_refused",
    }
}

/// The HTTP status a failure carried, where it had one. A number, so there is
/// nothing to redact.
pub fn failure_status(error: &CloudflareError) -> Option<u16> {
    match error {
        CloudflareError::Request(detail) | CloudflareError::Verification(detail) => detail.status,
        CloudflareError::ResourceLimit(context) => context.status,
        CloudflareError::RateLimited(_) => Some(429),
        _ => None,
    }
}

// ── Records ─────────────────────────────────────────────────────────────────

/// One DNS record's fields, as the trail records them.
///
/// Assembled field by field from the allowlist this struct *is*, so a field
/// added to `DNSRecord` later reaches the trail only if someone puts it here
/// on purpose. There is no constructor that takes a request body.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecordFacts {
    pub record_type: String,
    pub name: String,
    pub content: String,
    pub ttl: Option<u32>,
    pub priority: Option<u16>,
    pub proxied: Option<bool>,
    pub comment: Option<String>,
}

impl RecordFacts {
    /// The record Cloudflare says exists.
    pub fn of_record(record: &DNSRecord) -> Self {
        Self {
            record_type: record.r#type.clone(),
            name: record.name.clone(),
            content: record.content.clone(),
            ttl: record.ttl,
            priority: record.priority,
            proxied: record.proxied,
            comment: record.comment.clone(),
        }
    }

    /// The record a command was asked to write.
    pub fn of_input(record: &DNSRecordInput) -> Self {
        Self {
            record_type: record.r#type.clone(),
            name: record.name.clone(),
            content: record.content.clone(),
            ttl: record.ttl,
            priority: record.priority,
            proxied: record.proxied,
            comment: record.comment.clone(),
        }
    }

    /// The record a retained entry kept a copy of.
    ///
    /// The one case where a deletion's entry can describe what it removed
    /// without the caller having to say so, because the recycle bin was handed
    /// the whole record before anything was deleted.
    pub fn of_snapshot(snapshot: &RecordSnapshot) -> Self {
        Self {
            record_type: snapshot.record_type.clone(),
            name: snapshot.name.clone(),
            content: snapshot.content.clone(),
            ttl: snapshot.ttl,
            priority: snapshot.priority,
            proxied: snapshot.proxied,
            comment: snapshot.comment.clone(),
        }
    }

    /// A before-state the caller claims the record had.
    ///
    /// Taken as a raw [`Value`] and parsed leniently on purpose. This is an
    /// audit input: a malformed one must cost the entry its change set, never
    /// cost the user their DNS edit, so there is no deserialisation here that
    /// can fail a command. A value that does not name both a type and a name
    /// is not a record state at all and produces nothing, rather than a change
    /// set claiming the type changed from nothing.
    pub fn of_claim(value: &Value) -> Option<Self> {
        let record_type = non_empty(value, "type")?;
        let name = non_empty(value, "name")?;
        Some(Self {
            record_type,
            name,
            content: value
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            ttl: value
                .get("ttl")
                .and_then(Value::as_u64)
                .map(|ttl| ttl as u32),
            priority: value
                .get("priority")
                .and_then(Value::as_u64)
                .map(|priority| priority as u16),
            proxied: value.get("proxied").and_then(Value::as_bool),
            comment: value
                .get("comment")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        })
    }
}

/// Name the record an entry is about, and say what it holds.
///
/// `record_type` and `record_name` keep the key names and the order the DNS
/// entries have always used, so a reader of an older log reads a newer one.
/// The rest of the record goes under one `record` key, which is the whole
/// point for a deletion: the record is gone from the zone, so the id in
/// `resource` means nothing afterwards and the copy in the entry is all there
/// is.
///
/// A field the record does not have is left out rather than written as
/// `null` — within a `record` there is nothing to tell apart, because the
/// whole state was read.
#[must_use]
pub fn describe_record(entry: AuditEntry, facts: &RecordFacts) -> AuditEntry {
    let entry = entry
        .detail("record_type", facts.record_type.as_str())
        .detail("record_name", facts.name.as_str());
    let fields = vec![
        ("content", Some(shortened(&facts.content))),
        ("ttl", facts.ttl.map(Value::from)),
        ("proxied", facts.proxied.map(Value::from)),
        ("priority", facts.priority.map(Value::from)),
        ("comment", facts.comment.as_deref().map(shortened)),
    ]
    .into_iter()
    .filter_map(|(field, value)| value.map(|value| (field, value)))
    .collect();
    attach_fields(entry, "record", "record_omitted", fields)
}

/// Name the record, and say what about it changed.
///
/// The shape is `{"<field>": {"from": …, "to": …}}`, one key per field whose
/// value differs. `record_type` and `record_name` carry the state *after* the
/// change, as they always have; a type or name that changed is in the change
/// set as well, because the new value alone does not say it moved.
///
/// A `null` on either side is a field that was unset at that point — a
/// comment cleared, a priority added. Absence is not used for that: every
/// field present here has both sides, so nothing has to be inferred from a
/// missing key.
///
/// A record where nothing differs records an empty change set rather than no
/// key, because "the user saved this record and changed nothing" is a fact
/// about the action and not an absence of one.
#[must_use]
pub fn describe_change(entry: AuditEntry, before: &RecordFacts, after: &RecordFacts) -> AuditEntry {
    let entry = entry
        .detail("record_type", after.record_type.as_str())
        .detail("record_name", after.name.as_str());
    let fields = changed_fields(before, after);
    attach_fields(entry, "changes", "changes_omitted", fields)
}

// ── Retention side effects ──────────────────────────────────────────────────
//
// Retaining a snapshot can cost the store other entries, and
// `bc_storage::retention::evict_to_cap` hands every one of them back for
// exactly this reason: "a record this application forgets must not be a record
// it forgot silently". These live here rather than in one command's file
// because there are now two callers of `Storage::retain_record` —
// `commands::retention::retain_dns_record`, which deletes a record and keeps
// it, and `commands::dns::update_dns_record`, which keeps the state an edit
// supersedes — and both owe the log the same account of what the write cost.
//
// They take the trail rather than the store so the entries they write can be
// asserted without standing one up.

/// One entry for a whole purge, not one per entry purged.
///
/// A purge of five hundred expired entries would otherwise fill half the audit
/// log with events the user was already shown a date for. Eviction is the
/// opposite case and gets an entry each.
pub fn record_purged(trail: &dyn AuditTrail, purged: &[Value]) {
    if purged.is_empty() {
        return;
    }
    trail.record(
        user_action("retention:purge", AuditOutcome::Succeeded)
            .detail("entries", purged.len() as u64)
            .optional_detail(
                "record_name",
                purged
                    .first()
                    .and_then(|entry| entry.get("name"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            ),
    );
}

/// One entry per evicted record.
///
/// An eviction means the application forgot something the user could still have
/// restored. For a `disabled` record that is the only copy there was; for a
/// `superseded` one it is an undo the user will reach for and not find. Neither
/// may be a thing that happened silently, and the entry names the reason so a
/// reader can tell the two apart.
pub fn record_evicted(trail: &dyn AuditTrail, entry: &Value, cause: EvictionCause) {
    let parsed = RetainedRecord::of(entry);
    let (zone_id, reason) = parsed
        .as_ref()
        .map(|entry| (entry.zone_id.clone(), entry.reason.clone()))
        .unwrap_or_default();
    let facts = parsed
        .as_ref()
        .map(|entry| RecordFacts::of_snapshot(&entry.snapshot))
        .unwrap_or_default();
    trail.record(describe_record(
        user_action("retention:evict", AuditOutcome::Succeeded)
            .resource(
                parsed
                    .as_ref()
                    .and_then(|entry| entry.origin_record_id.as_deref())
                    .unwrap_or_default(),
            )
            .detail("zone_id", zone_id.as_str())
            .detail("reason", reason.as_str())
            .detail("cause", cause.as_str())
            .optional_detail(
                OPERATION_ID_KEY,
                parsed.as_ref().and_then(|entry| entry.operation_id.clone()),
            ),
        &facts,
    ));
}

// ── Settings ────────────────────────────────────────────────────────────────

/// One configuration value, as the trail records it.
///
/// Scalars pass through; anything structured is recorded as its serialised
/// form, shortened. Either way it is **bounded**, which the raw value a
/// command was handed is not: a zone setting can carry a whole custom error
/// page, and an unbounded value in an entry is not a big record, it is a log
/// that silently stops recording. See this module's header.
pub fn setting_value(value: &Value) -> Value {
    match value {
        Value::String(text) => shortened(text),
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        structured => shortened(&structured.to_string()),
    }
}

/// Record what one named value was set to, and what it was before.
///
/// The field keeps its own key, so a reader of an older log still finds the
/// value where it has always been, and the before-and-after goes under the
/// same `changes` key a record edit uses — one shape for "what changed",
/// whether the thing that changed was a DNS record or a zone setting.
///
/// No before-state, or one equal to the new value, records only the value: a
/// change set saying a setting went from `full` to `full` would be noise, and
/// one inventing a `from` it never read would be worse.
#[must_use]
pub fn describe_value_change(
    entry: AuditEntry,
    field: &'static str,
    before: Option<&Value>,
    after: &Value,
) -> AuditEntry {
    let after_value = setting_value(after);
    let before_value = before.map(setting_value);
    let entry = entry.detail(field, after_value.clone());
    match before_value {
        Some(before_value) if before_value != after_value => attach_fields(
            entry,
            "changes",
            "changes_omitted",
            vec![(field, json!({ "from": before_value, "to": after_value }))],
        ),
        _ => entry,
    }
}

/// Every field that differs, in the order the budget is spent on them.
///
/// Content leads because it is what a record *is*, and the field a reader most
/// often opened the log to check. Name follows, then the cheap scalars — which
/// together cost less than one long value, so they survive whatever content
/// and name spend. Comment is last: it is the field whose loss costs least.
fn changed_fields(before: &RecordFacts, after: &RecordFacts) -> Vec<(&'static str, Value)> {
    let mut fields = Vec::new();
    let mut compare = |field: &'static str, from: Value, to: Value| {
        if from != to {
            fields.push((field, json!({ "from": from, "to": to })));
        }
    };
    compare(
        "content",
        shortened(&before.content),
        shortened(&after.content),
    );
    compare("name", shortened(&before.name), shortened(&after.name));
    compare(
        "type",
        shortened(&before.record_type),
        shortened(&after.record_type),
    );
    compare("ttl", optional(before.ttl), optional(after.ttl));
    compare("proxied", optional(before.proxied), optional(after.proxied));
    compare(
        "priority",
        optional(before.priority),
        optional(after.priority),
    );
    compare(
        "comment",
        before.comment.as_deref().map_or(Value::Null, shortened),
        after.comment.as_deref().map_or(Value::Null, shortened),
    );
    fields
}

/// Add as many of `fields` as fit under one key, and say how many did not.
///
/// The budget is whatever [`AuditEntry::remaining_detail_bytes`] still allows,
/// capped by [`MAX_RECORD_DETAIL_BYTES`], minus the two keys this spends. A
/// field that does not fit is counted rather than silently missing, because a
/// reader has to be able to tell a record that changed in two ways from one
/// whose third change the trail could not afford.
///
/// `fields` is spent in order, so a caller puts what matters first.
///
/// A field name is only ever used as a key *inside* the one detail value this
/// writes, never as a detail key, so it does not have to be `&'static str` —
/// hence the generic. A settings change set is keyed by preference name, which
/// is read out of the stored object at runtime and so cannot be static; before
/// this was generic the only way to record one was a hand-maintained table of
/// every preference name, which would have silently dropped the next
/// preference someone added from the trail.
pub fn attach_fields<K: Into<String>>(
    entry: AuditEntry,
    key: &'static str,
    omitted_key: &'static str,
    fields: Vec<(K, Value)>,
) -> AuditEntry {
    // `omitted_key` is only spent when something was dropped, but the budget
    // reserves it either way: a value sized to the last byte and then found to
    // have left a field out would have nowhere to say so.
    let reserved = key.len() + omitted_key.len() + 3;
    let budget = entry
        .remaining_detail_bytes()
        .min(MAX_RECORD_DETAIL_BYTES)
        .saturating_sub(reserved);
    let mut kept = Map::new();
    let mut omitted = 0_u64;
    for (field, value) in fields {
        let field = field.into();
        kept.insert(field.clone(), value);
        if serialised_len(&kept) > budget {
            kept.remove(&field);
            omitted += 1;
        }
    }
    let entry = entry.detail(key, Value::Object(kept));
    if omitted == 0 {
        return entry;
    }
    entry.detail(omitted_key, omitted)
}

fn serialised_len(fields: &Map<String, Value>) -> usize {
    serde_json::to_string(fields).map_or(usize::MAX, |raw| raw.len())
}

/// A set value, or `Value::Null` for one that is not set.
fn optional<T: Into<Value>>(value: Option<T>) -> Value {
    value.map_or(Value::Null, Into::into)
}

/// One value, shortened to [`MAX_CHANGE_VALUE_BYTES`] on a character boundary
/// so a multi-byte value is cut rather than turned into invalid UTF-8.
fn shortened(value: &str) -> Value {
    if value.len() <= MAX_CHANGE_VALUE_BYTES {
        return Value::String(value.to_string());
    }
    let room = MAX_CHANGE_VALUE_BYTES - TRUNCATION_MARKER.len();
    let end = value
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= room)
        .last()
        .unwrap_or(0);
    Value::String(format!("{}{TRUNCATION_MARKER}", &value[..end]))
}

/// Read one non-blank string field, so a blank does not become a value that
/// says nothing.
fn non_empty(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use bc_cloudflare_api::{
        CloudflareProviderError, CloudflareRequestError, CloudflareTransportError,
        VerificationErrorSource, CLOUDFLARE_API_HOST, DNS_LIST_OPERATION,
    };

    use super::*;

    fn facts(content: &str) -> RecordFacts {
        RecordFacts {
            record_type: "A".to_string(),
            name: "www.example.com".to_string(),
            content: content.to_string(),
            ttl: Some(300),
            priority: None,
            proxied: Some(false),
            comment: None,
        }
    }

    fn recorded(entry: AuditEntry) -> Value {
        entry.into_value()
    }

    #[test]
    fn an_update_says_which_fields_changed_and_what_they_were() {
        let before = facts("203.0.113.1");
        let after = RecordFacts {
            content: "203.0.113.9".to_string(),
            ttl: Some(1),
            proxied: Some(true),
            ..before.clone()
        };
        let value = recorded(describe_change(
            user_action("dns:update", AuditOutcome::Succeeded).resource("record-1"),
            &before,
            &after,
        ));

        assert_eq!(value["operation"], json!("dns:update"));
        assert_eq!(value["actor"], json!("user"));
        assert_eq!(value["outcome"], json!("succeeded"));
        assert_eq!(value["record_name"], json!("www.example.com"));
        assert_eq!(
            value["changes"],
            json!({
                "content": { "from": "203.0.113.1", "to": "203.0.113.9" },
                "ttl": { "from": 300, "to": 1 },
                "proxied": { "from": false, "to": true },
            }),
            "only the fields that differ, each with both sides"
        );
        assert!(
            value.get("changes_omitted").is_none(),
            "nothing was left out, so nothing claims it was"
        );
    }

    #[test]
    fn a_field_becoming_unset_is_a_null_rather_than_an_absence() {
        let before = RecordFacts {
            comment: Some("rotation note".to_string()),
            priority: None,
            ..facts("203.0.113.1")
        };
        let after = RecordFacts {
            comment: None,
            priority: Some(10),
            ..before.clone()
        };
        let value = recorded(describe_change(
            user_action("dns:update", AuditOutcome::Succeeded),
            &before,
            &after,
        ));

        assert_eq!(
            value["changes"]["comment"],
            json!({ "from": "rotation note", "to": null })
        );
        assert_eq!(
            value["changes"]["priority"],
            json!({ "from": null, "to": 10 })
        );
    }

    #[test]
    fn a_save_that_changed_nothing_records_an_empty_change_set() {
        let before = facts("203.0.113.1");
        let value = recorded(describe_change(
            user_action("dns:update", AuditOutcome::Succeeded),
            &before,
            &before,
        ));
        assert_eq!(
            value["changes"],
            json!({}),
            "the action happened; a missing key would read as an older build"
        );
    }

    #[test]
    fn a_deletion_records_enough_of_the_record_to_recognise_it() {
        let value = recorded(describe_record(
            user_action("dns:delete", AuditOutcome::Succeeded).resource("record-1"),
            &RecordFacts {
                comment: Some("mail".to_string()),
                priority: Some(10),
                ttl: None,
                ..facts("mx1.example.com")
            },
        ));

        assert_eq!(value["record_type"], json!("A"));
        assert_eq!(value["record_name"], json!("www.example.com"));
        assert_eq!(
            value["record"],
            json!({
                "content": "mx1.example.com",
                "proxied": false,
                "priority": 10,
                "comment": "mail",
            }),
            "a field the record does not have is left out, not written as null"
        );
    }

    #[test]
    fn a_long_value_is_shortened_rather_than_dropped() {
        let long = "v=DKIM1; p=".to_string() + &"A".repeat(600);
        let before = facts("203.0.113.1");
        let after = RecordFacts {
            content: long.clone(),
            ..before.clone()
        };
        let value = recorded(describe_change(
            user_action("dns:update", AuditOutcome::Succeeded),
            &before,
            &after,
        ));

        let recorded_content = value["changes"]["content"]["to"]
            .as_str()
            .expect("the change set must keep the content field");
        assert!(
            recorded_content.len() <= MAX_CHANGE_VALUE_BYTES,
            "shortened to {} bytes",
            recorded_content.len()
        );
        assert!(recorded_content.ends_with(TRUNCATION_MARKER));
        assert!(long.starts_with(recorded_content.trim_end_matches(TRUNCATION_MARKER)));
    }

    #[test]
    fn a_multibyte_value_is_cut_on_a_character_boundary() {
        let long = "é".repeat(MAX_CHANGE_VALUE_BYTES);
        let shortened = shortened(&long);
        let text = shortened.as_str().expect("a string value");
        assert!(text.len() <= MAX_CHANGE_VALUE_BYTES);
        assert!(long.starts_with(text.trim_end_matches(TRUNCATION_MARKER)));
    }

    #[test]
    fn a_change_set_that_cannot_fit_says_how_much_it_left_out() {
        // Every field changed, every text field as long as the trail allows:
        // more than the per-detail budget can hold.
        let before = RecordFacts {
            record_type: "TXT".to_string(),
            name: "a".repeat(200),
            content: "b".repeat(400),
            ttl: Some(300),
            priority: Some(1),
            proxied: Some(false),
            comment: Some("c".repeat(400)),
        };
        let after = RecordFacts {
            record_type: "SPF".to_string(),
            name: "d".repeat(200),
            content: "e".repeat(400),
            ttl: Some(1),
            priority: Some(2),
            proxied: Some(true),
            comment: Some("f".repeat(400)),
        };
        let value = recorded(describe_change(
            user_action("dns:update", AuditOutcome::Succeeded)
                .resource("record-1")
                .detail("zone_id", "z".repeat(32).as_str()),
            &before,
            &after,
        ));

        let changes = value["changes"]
            .as_object()
            .expect("the change set must survive a budget overrun");
        assert!(
            changes.contains_key("content"),
            "content is spent first, so it is the field that survives"
        );
        assert_eq!(
            value["changes_omitted"].as_u64().unwrap_or_default() as usize,
            7 - changes.len(),
            "every field that did not fit is counted"
        );
        assert!(
            value.to_string().len() <= bc_storage::audit::MAX_AUDIT_ENTRY_BYTES,
            "entry serialised to {} bytes",
            value.to_string().len()
        );
    }

    #[test]
    fn the_cheap_fields_survive_a_long_content_change() {
        let before = RecordFacts {
            content: "b".repeat(400),
            ..facts("")
        };
        let after = RecordFacts {
            content: "e".repeat(400),
            ttl: Some(1),
            proxied: Some(true),
            priority: Some(5),
            ..before.clone()
        };
        let value = recorded(describe_change(
            user_action("dns:update", AuditOutcome::Succeeded)
                .resource("record-1")
                .detail("zone_id", "z".repeat(32).as_str()),
            &before,
            &after,
        ));
        for field in ["content", "ttl", "proxied", "priority"] {
            assert!(
                value["changes"].get(field).is_some(),
                "{field} should fit alongside a shortened content change: {value}"
            );
        }
    }

    #[test]
    fn a_claimed_before_state_without_a_type_and_name_produces_nothing() {
        assert!(RecordFacts::of_claim(&json!({})).is_none());
        assert!(RecordFacts::of_claim(&json!({ "type": "A" })).is_none());
        assert!(RecordFacts::of_claim(&json!({ "type": " ", "name": "www" })).is_none());
        assert!(RecordFacts::of_claim(&json!("not an object")).is_none());

        let claimed = RecordFacts::of_claim(&json!({
            "type": "A",
            "name": "www.example.com",
            "content": "203.0.113.1",
            "ttl": 300,
            "proxied": false,
        }))
        .expect("a type and a name is a record state");
        assert_eq!(claimed.content, "203.0.113.1");
        assert_eq!(claimed.ttl, Some(300));
        assert_eq!(claimed.proxied, Some(false));
        assert_eq!(claimed.comment, None);
    }

    #[test]
    fn a_failure_records_where_it_stopped_and_never_the_provider_text() {
        let secret = "https://proxy.internal/zones/zone-1/dns_records?api_token=token-secret";
        for (error, kind, status) in [
            (
                CloudflareError::ApiError(secret.to_string()),
                "provider_refused",
                None,
            ),
            (CloudflareError::AuthFailed, "authentication", None),
            (
                CloudflareError::RateLimited(3),
                "rate_limited",
                Some(429_u16),
            ),
            (
                CloudflareError::HttpError(CloudflareHttpError::Transport(
                    CloudflareTransportError {
                        category: CloudflareTransportCategory::Timeout,
                        host: CLOUDFLARE_API_HOST,
                        operation: DNS_LIST_OPERATION,
                        attempt: 1,
                        max_attempts: 1,
                        retryable: false,
                        remediation: "Retry when connectivity is stable.",
                    },
                )),
                "timeout",
                None,
            ),
            (
                CloudflareError::Request(Box::new(CloudflareRequestError {
                    kind: VerificationFailureKind::Provider,
                    message: secret.to_string(),
                    status: Some(400),
                    source: VerificationErrorSource::Cloudflare,
                    operation: "dns:update".to_string(),
                    retryable: false,
                    provider_errors: vec![CloudflareProviderError {
                        code: Some("1004".to_string()),
                        message: secret.to_string(),
                    }],
                    retry_after_secs: None,
                    remediation: secret.to_string(),
                    request_id: Some("ray".to_string()),
                })),
                "provider_refused",
                Some(400_u16),
            ),
        ] {
            let value = recorded(attach_failure(
                user_action("dns:update", AuditOutcome::Failed).resource("record-1"),
                &error,
            ));
            assert_eq!(value["failure"], json!(kind));
            assert_eq!(
                value.get("status").and_then(Value::as_u64),
                status.map(u64::from)
            );
            let serialized = value.to_string();
            for forbidden in ["proxy.internal", "token-secret", "https://", "api_token"] {
                assert!(
                    !serialized.contains(forbidden),
                    "{forbidden:?} reached the trail: {serialized}"
                );
            }
        }
    }
    // ── Operation ids ───────────────────────────────────────────────────────

    #[test]
    fn a_minted_id_is_a_distinct_uuid_v4() {
        let first = OperationId::mint();
        let second = OperationId::mint();
        assert_ne!(first, second, "every action gets its own id");
        let parsed = uuid::Uuid::parse_str(first.as_str()).expect("a minted id parses");
        assert_eq!(
            parsed.get_version_num(),
            4,
            "the renderer's contract says v4"
        );
    }

    #[test]
    fn a_caller_that_knows_the_action_keeps_its_id_so_its_entries_group() {
        let shared = OperationId::mint();
        let first = OperationId::of(Some(shared.as_str()));
        let second = OperationId::of(Some(shared.as_str()));
        assert_eq!(first, shared);
        assert_eq!(
            second, shared,
            "thirty-seven single-record deletes have to land under one id"
        );
    }

    #[test]
    fn a_supplied_id_that_would_corrupt_the_grouping_is_replaced_not_refused() {
        // Each of these would group entries under something that is not an
        // action: a constant that collapses a whole zone's history into one
        // undoable operation, or a key with no bound at all.
        for supplied in [
            "",
            "   ",
            "not-a-uuid",
            "00000000-0000-0000-0000-000000000000",
            "'; drop table --",
            &"f".repeat(4096),
        ] {
            let minted = OperationId::of(Some(supplied));
            assert_ne!(
                minted.as_str(),
                supplied.trim(),
                "{supplied:?} must not become a grouping key"
            );
            let parsed = uuid::Uuid::parse_str(minted.as_str())
                .expect("the replacement is a well-formed id");
            assert!(!parsed.is_nil());
        }
        assert_ne!(
            OperationId::of(None).as_str(),
            "",
            "an operation of one still gets an id of its own"
        );
    }

    #[test]
    fn a_supplied_id_is_normalised_rather_than_stored_as_typed() {
        let id = OperationId::of(Some("  3F2504E0-4F89-41D3-9A0C-0305E82C3301  "));
        assert_eq!(
            id.as_str(),
            "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            "two spellings of one id would read as two operations"
        );
    }

    #[test]
    fn the_stamp_survives_an_entry_whose_budget_is_otherwise_spent() {
        // The failure this guards: `AuditEntry::detail` drops silently, so an
        // id added after a long change set would vanish and the entry would
        // read as an action of its own that undo cannot find.
        let operation = OperationId::mint();
        let long = "x".repeat(4_000);
        let before = facts(&long);
        let after = RecordFacts {
            content: format!("{long}-moved"),
            comment: Some(long.clone()),
            ..before.clone()
        };
        let value = recorded(describe_change(
            stamp(
                user_action("dns:update", AuditOutcome::Succeeded).resource("record-1"),
                &operation,
            )
            .detail("zone_id", "zone-1"),
            &before,
            &after,
        ));
        assert_eq!(
            value[OPERATION_ID_KEY],
            json!(operation.as_str()),
            "the grouping key must outlive every field that competes with it"
        );
    }

    #[test]
    fn stamping_does_not_disturb_what_the_entry_already_said() {
        let operation = OperationId::mint();
        let before = facts("203.0.113.1");
        let after = RecordFacts {
            content: "203.0.113.9".to_string(),
            ..before.clone()
        };
        let value = recorded(describe_change(
            stamp(
                user_action("dns:update", AuditOutcome::Succeeded).resource("record-1"),
                &operation,
            ),
            &before,
            &after,
        ));
        assert_eq!(value["operation"], json!("dns:update"));
        assert_eq!(value["record_name"], json!("www.example.com"));
        assert_eq!(
            value["changes"],
            json!({ "content": { "from": "203.0.113.1", "to": "203.0.113.9" } })
        );
    }
}
