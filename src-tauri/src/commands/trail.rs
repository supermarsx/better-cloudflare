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
use bc_storage::{AuditActor, AuditEntry, AuditOutcome, RecordSnapshot};
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
const TRUNCATION_MARKER: &str = "…";

/// `denied_by` for a record the local validation gate refused.
///
/// Same vocabulary as `bc_mcp::audit::DenialReason`: the layer that refused,
/// carried as a value rather than recovered from the refusal message.
pub const DENIED_BY_RECORD_VALIDATION: &str = "record_validation";

/// `denied_by` for a request this application refused on its own bounds —
/// an export page size, an unsupported format — before any HTTP call.
pub const DENIED_BY_REQUEST_BOUNDS: &str = "request_bounds";

// ── Entries ─────────────────────────────────────────────────────────────────

/// Open an entry for something the person at the keyboard did.
pub fn user_action(operation: &str, outcome: AuditOutcome) -> AuditEntry {
    AuditEntry::new(AuditActor::User, operation, outcome)
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
pub fn attach_fields(
    entry: AuditEntry,
    key: &'static str,
    omitted_key: &'static str,
    fields: Vec<(&'static str, Value)>,
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
        kept.insert(field.to_string(), value);
        if serialised_len(&kept) > budget {
            kept.remove(field);
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
}
