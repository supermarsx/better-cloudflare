//! The shape of one audit-trail entry, and who it says acted.
//!
//! The trail answers two questions at once: *what* was done to the user's
//! zones, and *what did it* — a person working in the application window, a
//! client of the local MCP server, or the in-app AI assistant. All three write
//! through one log in one shape, because a record split across three logs
//! cannot be read in order, and "in order" is the whole value of a trail.
//!
//! What an entry deliberately does **not** carry is the call that produced it.
//! Every Cloudflare tool takes an `api_key`, and record content can itself be a
//! secret (a DKIM key, a service verification token), so an entry's details are
//! assembled field by field from an allowlist by the recording crate. Nothing
//! here copies a request body, and no field on this type is a place to put one.
//!
//! Entries written before the trail carried an actor have no `actor` field, and
//! every writer that existed then was a person acting in the app. So a missing
//! actor reads as [`AuditActor::User`] rather than as "unknown": the old
//! records are not ambiguous, they are human.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::MAX_AUDIT_ENTRIES;

// ── Bounds ──────────────────────────────────────────────────────────────────

/// Bytes one text field of an entry may occupy.
///
/// A tool name, a zone id, a permission id and a fully qualified DNS name
/// (253 bytes at most) all fit. Longer text is truncated on a character
/// boundary rather than rejected: a trail that drops an entry because a name
/// was long has lost the thing it exists to record.
pub const MAX_AUDIT_TEXT_BYTES: usize = 256;

/// Detail keys one entry may carry.
///
/// Enough for a tool call's effect tier, the layer that refused it, the zone,
/// record and name it targeted, and the conversation it came from, with a
/// little room left over.
pub const MAX_AUDIT_DETAIL_KEYS: usize = 12;

/// Bytes an entry's details may occupy in total, across all keys and values.
pub const MAX_AUDIT_DETAIL_BYTES: usize = 768;

/// Bytes one serialised entry may occupy.
///
/// The whole log is stored as a single secret, and storage caps one secret at
/// 2 MB, so a thousand-entry log has to average under 2 KB an entry. The
/// assertions below pin the worst case of the fields written through
/// [`AuditEntry`] against this ceiling, and this ceiling against the secret
/// size, so the three bounds cannot drift into disagreement.
pub const MAX_AUDIT_ENTRY_BYTES: usize = 1536;

/// Worst case for the fixed part of an entry: the four always-present keys,
/// a timestamp, and the JSON punctuation of every key including the details'.
const AUDIT_ENTRY_OVERHEAD_BYTES: usize = 224;

const _: () = assert!(
    AUDIT_ENTRY_OVERHEAD_BYTES + 2 * MAX_AUDIT_TEXT_BYTES + MAX_AUDIT_DETAIL_BYTES
        <= MAX_AUDIT_ENTRY_BYTES,
    "the widest entry AuditEntry can build must fit the per-entry ceiling"
);
const _: () = assert!(
    MAX_AUDIT_ENTRY_BYTES * MAX_AUDIT_ENTRIES <= super::MAX_SECRET_BYTES,
    "a full audit log must fit one stored secret"
);

// ── Actors ──────────────────────────────────────────────────────────────────

/// What performed the recorded action.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditActor {
    /// A person acting in the application window.
    User,
    /// A client of the local MCP server, over its HTTP transport.
    McpClient,
    /// The in-app AI assistant, dispatching through its own permission gate.
    Assistant,
}

impl AuditActor {
    /// Every actor, in the order eviction considers them.
    pub const ALL: [Self; 3] = [Self::User, Self::McpClient, Self::Assistant];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::McpClient => "mcp_client",
            Self::Assistant => "assistant",
        }
    }

    /// The actor a stored entry names.
    ///
    /// An absent, unrecognised or non-string `actor` reads as
    /// [`AuditActor::User`]. Absent means the entry predates the field, and
    /// those were all human. Unrecognised can only come from a newer build
    /// writing into the same keyring, and bucketing it with the human record
    /// means eviction protects it rather than preferring it as a victim —
    /// over-protecting an unreadable record is the safe direction to be wrong
    /// in.
    pub fn of(entry: &Value) -> Self {
        match entry.get("actor").and_then(Value::as_str) {
            Some("mcp_client") => Self::McpClient,
            Some("assistant") => Self::Assistant,
            _ => Self::User,
        }
    }

    /// Entries this actor's half of the trail is guaranteed. See
    /// [`evict_to_cap`].
    const fn reservation(self) -> usize {
        match self {
            Self::User => 400,
            Self::McpClient => 300,
            Self::Assistant => 300,
        }
    }
}

const _: () = assert!(
    AuditActor::User.reservation()
        + AuditActor::McpClient.reservation()
        + AuditActor::Assistant.reservation()
        == MAX_AUDIT_ENTRIES,
    "reservations must sum to the cap, so an over-cap log always has a victim"
);

// ── Outcomes ────────────────────────────────────────────────────────────────

/// How the recorded action ended.
///
/// There is no "pending" outcome: an action waiting for the user's approval
/// has not been done, and a trail is a record of what was done. It enters the
/// trail when it settles.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditOutcome {
    /// Carried out, and reported success.
    Succeeded,
    /// Carried out and reported a failure, or left the application and stopped
    /// being observable — cancelled or timed out in flight. A write recorded
    /// this way may still have landed.
    Failed,
    /// Refused before anything was dispatched.
    Denied,
}

impl AuditOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Denied => "denied",
        }
    }
}

// ── Entries ─────────────────────────────────────────────────────────────────

/// One trail entry, before it is serialised into the log.
///
/// Built field by field rather than from a struct literal so that every text
/// field passes the bound on the way in and the detail budget is enforced at
/// the point a detail is added. Details are kept in the order they were added
/// and the budget is spent in that order, so a caller puts what matters first
/// and a long tail is dropped rather than crowding out the identifying fields.
#[derive(Clone, Debug)]
pub struct AuditEntry {
    actor: AuditActor,
    operation: String,
    resource: Option<String>,
    outcome: AuditOutcome,
    details: Vec<(&'static str, Value)>,
    detail_bytes: usize,
}

impl AuditEntry {
    /// Open an entry. `operation` is the stable, machine-readable name of what
    /// was done, in the `domain:action` form the existing log already uses
    /// (`dns:create`, `mcp:tool_call`).
    pub fn new(actor: AuditActor, operation: &str, outcome: AuditOutcome) -> Self {
        Self {
            actor,
            operation: bounded_text(operation),
            resource: None,
            outcome,
            details: Vec::new(),
            detail_bytes: 0,
        }
    }

    /// Name the thing acted on: a record id, a zone id, or a tool name.
    #[must_use]
    pub fn resource(mut self, resource: &str) -> Self {
        self.resource = Some(bounded_text(resource));
        self
    }

    /// Add one detail, if the entry's detail budget still allows it.
    ///
    /// Strings are bounded like every other text field. A key already present
    /// is not replaced: the first value wins, so a caller cannot be surprised
    /// by a later overwrite it did not intend.
    #[must_use]
    pub fn detail(mut self, key: &'static str, value: impl Into<Value>) -> Self {
        let value = match value.into() {
            Value::String(text) => Value::String(bounded_text(&text)),
            other => other,
        };
        let cost = key.len().saturating_add(detail_value_bytes(&value));
        if self.details.len() >= MAX_AUDIT_DETAIL_KEYS
            || self.detail_bytes.saturating_add(cost) > MAX_AUDIT_DETAIL_BYTES
            || self.details.iter().any(|(seen, _)| *seen == key)
        {
            return self;
        }
        self.detail_bytes = self.detail_bytes.saturating_add(cost);
        self.details.push((key, value));
        self
    }

    /// [`Self::detail`] for a value that may be absent. An absent value adds
    /// no key at all rather than a `null`: a trail reader should not have to
    /// tell "we looked and there was nothing" from "we did not look".
    #[must_use]
    pub fn optional_detail(self, key: &'static str, value: Option<impl Into<Value>>) -> Self {
        match value {
            Some(value) => self.detail(key, value),
            None => self,
        }
    }

    pub fn actor(&self) -> AuditActor {
        self.actor
    }

    pub fn operation(&self) -> &str {
        &self.operation
    }

    pub fn outcome(&self) -> AuditOutcome {
        self.outcome
    }

    /// Look up one detail. For tests and for callers that need to re-read what
    /// they built; the log itself only ever sees [`Self::into_value`].
    pub fn detail_value(&self, key: &str) -> Option<&Value> {
        self.details
            .iter()
            .find(|(seen, _)| *seen == key)
            .map(|(_, value)| value)
    }

    /// Serialise into the flat object the log stores.
    ///
    /// Flat, and additive over the existing shape: `operation`, `resource` and
    /// `timestamp` keep the names and positions the DNS mutation entries have
    /// always used, so an existing reader of the log — or an exported file
    /// from an older build — still parses. `actor` and `outcome` are the new
    /// fields, and the details sit alongside them exactly as the DNS entries'
    /// extra fields already do.
    pub fn into_value(self) -> Value {
        let mut map = Map::new();
        map.insert("timestamp".to_string(), Value::String(now_rfc3339()));
        map.insert("operation".to_string(), Value::String(self.operation));
        if let Some(resource) = self.resource {
            map.insert("resource".to_string(), Value::String(resource));
        }
        map.insert(
            "actor".to_string(),
            Value::String(self.actor.as_str().to_string()),
        );
        map.insert(
            "outcome".to_string(),
            Value::String(self.outcome.as_str().to_string()),
        );
        for (key, value) in self.details {
            map.insert(key.to_string(), value);
        }
        Value::Object(map)
    }
}

/// Where an audit entry goes.
///
/// A trait rather than a storage handle so the crates that record — the MCP
/// server and the AI agent — are written against the trail's shape, and so
/// their tests can assert exactly what would have been written without
/// standing up a store. Recording is infallible from the caller's side: a
/// failed write must never turn into a failed DNS change or a failed tool
/// call, so the implementation swallows storage errors the way the existing
/// `log_audit` helper always has.
pub trait AuditTrail: Send + Sync {
    fn record(&self, entry: AuditEntry);
}

/// An audit trail that keeps what it is given in memory.
///
/// Published rather than kept behind `cfg(test)` because the crates that
/// record are several layers away from a store, and their *integration* tests
/// — separate compilation units — are where "a refused call is recorded at
/// all" has to be pinned. Bounded by nothing: a test's lifetime is the bound.
#[derive(Default)]
pub struct RecordingAuditTrail {
    entries: std::sync::Mutex<Vec<Value>>,
}

impl RecordingAuditTrail {
    /// Everything recorded so far, oldest first, as it would have been stored.
    pub fn entries(&self) -> Vec<Value> {
        self.lock().clone()
    }

    /// The `operation` of everything recorded so far, for the common
    /// assertion about which events reached the trail and in what order.
    pub fn operations(&self) -> Vec<String> {
        self.lock()
            .iter()
            .map(|entry| {
                entry
                    .get("operation")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            })
            .collect()
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Value>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl AuditTrail for RecordingAuditTrail {
    fn record(&self, entry: AuditEntry) {
        self.lock().push(entry.into_value());
    }
}

// ── Stored-entry helpers ────────────────────────────────────────────────────

/// Fill in the fields every stored entry must have.
///
/// `timestamp` and `actor` are only added when absent, so a caller that set
/// either keeps its value. The `actor` default is `user`, which is what every
/// caller of the untyped append path is: the application's own commands,
/// acting for the person at the keyboard.
pub(crate) fn stamped(entry: Value) -> Value {
    let Value::Object(mut map) = entry else {
        return entry;
    };
    map.entry("timestamp".to_string())
        .or_insert_with(|| Value::String(now_rfc3339()));
    map.entry("actor".to_string())
        .or_insert_with(|| Value::String(AuditActor::User.as_str().to_string()));
    Value::Object(map)
}

/// Bring the log back inside its entry cap by dropping the oldest entry of
/// whichever actor is furthest over its reservation.
///
/// A plain FIFO was the previous rule and it is the wrong one now that three
/// actors share the log. They write at wildly different rates: a person makes
/// a handful of record changes in a day, while an agent can make a hundred
/// tool calls in a minute. Under a FIFO, one busy conversation pushes every
/// human record change out of the log — and the human half is the part nothing
/// else can reconstruct.
///
/// So each actor has a reservation it is never evicted below, and the
/// reservations sum to the cap. That makes the rule total: whenever the log is
/// over the cap, at least one actor is over its reservation, so there is always
/// a victim and the loop always terminates. Unused reservation is lendable — a
/// log containing nothing but human entries holds a thousand of them — because
/// an actor at zero entries is never the one furthest over budget.
///
/// Ties between two equally over-budget actors go to the later of the two in
/// [`AuditActor::ALL`]: arbitrary, but deterministic, and both are fair
/// victims by construction.
pub(crate) fn evict_to_cap(entries: &mut Vec<Value>) {
    while entries.len() > MAX_AUDIT_ENTRIES {
        let Some(victim) = actor_furthest_over_budget(entries) else {
            break;
        };
        let Some(oldest) = entries
            .iter()
            .position(|entry| AuditActor::of(entry) == victim)
        else {
            // Unreachable: the victim is over its reservation, so it has
            // entries. Dropping the oldest entry of any actor still makes
            // progress, which matters more than being right about which.
            entries.remove(0);
            continue;
        };
        entries.remove(oldest);
    }
}

fn actor_furthest_over_budget(entries: &[Value]) -> Option<AuditActor> {
    AuditActor::ALL
        .into_iter()
        .max_by_key(|actor| {
            let held = entries
                .iter()
                .filter(|entry| AuditActor::of(entry) == *actor)
                .count();
            held as isize - actor.reservation() as isize
        })
        .filter(|actor| {
            entries
                .iter()
                .filter(|entry| AuditActor::of(entry) == *actor)
                .count()
                > actor.reservation()
        })
}

// ── Local helpers ───────────────────────────────────────────────────────────

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Truncate to [`MAX_AUDIT_TEXT_BYTES`] on a character boundary, so a
/// multi-byte name is shortened rather than turned into invalid UTF-8.
fn bounded_text(value: &str) -> String {
    if value.len() <= MAX_AUDIT_TEXT_BYTES {
        return value.to_string();
    }
    let end = value
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= MAX_AUDIT_TEXT_BYTES)
        .last()
        .unwrap_or(0);
    value[..end].to_string()
}

/// What one detail value costs against [`MAX_AUDIT_DETAIL_BYTES`].
///
/// Serialised length for anything structured, so a nested value is charged for
/// what it actually occupies rather than for being "one value".
fn detail_value_bytes(value: &Value) -> usize {
    match value {
        Value::String(text) => text.len(),
        Value::Null => 4,
        Value::Bool(_) => 5,
        Value::Number(number) => number.to_string().len(),
        other => other.to_string().len(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn entry_of(actor: AuditActor, seq: usize) -> Value {
        AuditEntry::new(actor, "test:op", AuditOutcome::Succeeded)
            .detail("seq", seq as u64)
            .into_value()
    }

    #[test]
    fn an_entry_keeps_the_legacy_field_names_and_adds_the_actor_and_outcome() {
        let value = AuditEntry::new(AuditActor::McpClient, "mcp:tool_call", AuditOutcome::Denied)
            .resource("cf_delete_dns_record")
            .detail("zone_id", "zone-1")
            .into_value();

        assert_eq!(value["operation"], json!("mcp:tool_call"));
        assert_eq!(value["resource"], json!("cf_delete_dns_record"));
        assert_eq!(value["actor"], json!("mcp_client"));
        assert_eq!(value["outcome"], json!("denied"));
        assert_eq!(value["zone_id"], json!("zone-1"));
        assert!(
            value["timestamp"].as_str().is_some_and(|ts| ts.len() > 10),
            "every entry is timestamped at the moment it is recorded"
        );
    }

    /// Thirty candidate keys, so the loop below can overrun both the key count
    /// and the byte budget without needing dynamic `&'static str`s.
    const SPARE_KEYS: [&str; 30] = [
        "k00", "k01", "k02", "k03", "k04", "k05", "k06", "k07", "k08", "k09", "k10", "k11", "k12",
        "k13", "k14", "k15", "k16", "k17", "k18", "k19", "k20", "k21", "k22", "k23", "k24", "k25",
        "k26", "k27", "k28", "k29",
    ];

    #[test]
    fn text_fields_and_the_detail_budget_are_bounded() {
        let long = "n".repeat(MAX_AUDIT_TEXT_BYTES * 2);
        let mut entry = AuditEntry::new(AuditActor::Assistant, &long, AuditOutcome::Succeeded)
            .resource(&long)
            .detail("first", long.as_str());
        for key in SPARE_KEYS {
            entry = entry.detail(key, long.as_str());
        }

        assert_eq!(entry.operation().len(), MAX_AUDIT_TEXT_BYTES);
        assert!(
            entry.detail_value("first").is_some(),
            "the first detail added is the one kept when the budget runs out"
        );
        assert!(
            entry.detail_value("k29").is_none(),
            "and the overrun is dropped rather than growing the entry"
        );
        let serialized = entry.into_value().to_string();
        assert!(
            serialized.len() <= MAX_AUDIT_ENTRY_BYTES,
            "entry serialised to {} bytes, over the {MAX_AUDIT_ENTRY_BYTES} ceiling",
            serialized.len()
        );
    }

    #[test]
    fn the_widest_entry_the_builder_can_make_fits_the_per_entry_ceiling() {
        // The const assertion at the top of the module says the arithmetic
        // adds up. This says the arithmetic describes the real serialised
        // form, punctuation and timestamp included.
        let long = "n".repeat(MAX_AUDIT_TEXT_BYTES * 2);
        let mut entry =
            AuditEntry::new(AuditActor::McpClient, &long, AuditOutcome::Denied).resource(&long);
        for key in SPARE_KEYS {
            entry = entry.detail(key, long.as_str());
        }
        let serialized = entry.into_value().to_string();
        assert!(
            serialized.len() <= MAX_AUDIT_ENTRY_BYTES,
            "widest entry serialised to {} bytes, over the {MAX_AUDIT_ENTRY_BYTES} ceiling",
            serialized.len()
        );
    }

    #[test]
    fn a_multibyte_name_is_truncated_on_a_character_boundary() {
        let long = "é".repeat(MAX_AUDIT_TEXT_BYTES);
        let bounded = bounded_text(&long);
        assert!(bounded.len() <= MAX_AUDIT_TEXT_BYTES);
        assert!(long.starts_with(&bounded));
    }

    #[test]
    fn a_detail_key_is_not_overwritten_by_a_later_value() {
        let entry = AuditEntry::new(AuditActor::User, "test:op", AuditOutcome::Succeeded)
            .detail("zone_id", "first")
            .detail("zone_id", "second");
        assert_eq!(entry.detail_value("zone_id"), Some(&json!("first")));
    }

    #[test]
    fn an_absent_detail_adds_no_key() {
        let value = AuditEntry::new(AuditActor::User, "test:op", AuditOutcome::Succeeded)
            .optional_detail("zone_id", None::<String>)
            .into_value();
        assert!(
            value.get("zone_id").is_none(),
            "an absent value must not become a null a reader has to interpret"
        );
    }

    #[test]
    fn an_entry_without_an_actor_reads_as_the_human_who_wrote_it() {
        assert_eq!(
            AuditActor::of(&json!({ "operation": "dns:create" })),
            AuditActor::User
        );
        assert_eq!(
            AuditActor::of(&json!({ "actor": "assistant" })),
            AuditActor::Assistant
        );
        assert_eq!(
            AuditActor::of(&json!({ "actor": "mcp_client" })),
            AuditActor::McpClient
        );
        assert_eq!(
            AuditActor::of(&json!({ "actor": "something_newer" })),
            AuditActor::User,
            "an actor this build cannot name is protected, not preferred as a victim"
        );
    }

    #[test]
    fn stamping_fills_only_what_is_missing() {
        let stamped_value = stamped(json!({ "operation": "dns:create" }));
        assert_eq!(stamped_value["actor"], json!("user"));
        assert!(stamped_value["timestamp"].as_str().is_some());

        let preserved = stamped(json!({
            "operation": "mcp:tool_call",
            "actor": "mcp_client",
            "timestamp": "2026-01-01T00:00:00+00:00",
        }));
        assert_eq!(preserved["actor"], json!("mcp_client"));
        assert_eq!(preserved["timestamp"], json!("2026-01-01T00:00:00+00:00"));
    }

    #[test]
    fn one_actor_alone_may_fill_the_whole_log() {
        let mut entries: Vec<Value> = (0..MAX_AUDIT_ENTRIES + 10)
            .map(|seq| entry_of(AuditActor::User, seq))
            .collect();
        evict_to_cap(&mut entries);
        assert_eq!(entries.len(), MAX_AUDIT_ENTRIES);
        assert_eq!(
            entries[0]["seq"],
            json!(10),
            "the oldest entries are the ones dropped"
        );
    }

    #[test]
    fn a_chatty_assistant_cannot_evict_the_human_record() {
        // The human half is small and old; the assistant then floods the log.
        let mut entries: Vec<Value> = (0..40).map(|seq| entry_of(AuditActor::User, seq)).collect();
        for seq in 0..MAX_AUDIT_ENTRIES * 2 {
            entries.push(entry_of(AuditActor::Assistant, seq));
            evict_to_cap(&mut entries);
        }

        assert_eq!(entries.len(), MAX_AUDIT_ENTRIES);
        let human = entries
            .iter()
            .filter(|entry| AuditActor::of(entry) == AuditActor::User)
            .count();
        assert_eq!(
            human, 40,
            "every human entry survives: 40 is under the human reservation"
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| AuditActor::of(entry) == AuditActor::User)
                .map(|entry| entry["seq"].clone())
                .collect::<Vec<_>>(),
            (0..40).map(|seq| json!(seq)).collect::<Vec<_>>(),
            "and they are the original forty, not a window of recent ones"
        );
    }

    #[test]
    fn an_over_budget_human_record_gives_room_back_but_never_below_its_floor() {
        // The human record starts holding the whole log; the MCP client then
        // asks for more than its reservation. The human half has to give room
        // back — but only room it was over-holding.
        let mut entries: Vec<Value> = (0..MAX_AUDIT_ENTRIES)
            .map(|seq| entry_of(AuditActor::User, seq))
            .collect();
        for seq in 0..MAX_AUDIT_ENTRIES {
            entries.push(entry_of(AuditActor::McpClient, seq));
            evict_to_cap(&mut entries);
        }

        assert_eq!(entries.len(), MAX_AUDIT_ENTRIES);
        let held = |actor: AuditActor| {
            entries
                .iter()
                .filter(|entry| AuditActor::of(entry) == actor)
                .count()
        };
        assert!(
            held(AuditActor::User) >= AuditActor::User.reservation(),
            "the human record never falls below its reservation, however busy \
             the MCP client is: held {}",
            held(AuditActor::User)
        );
        assert!(
            held(AuditActor::McpClient) >= AuditActor::McpClient.reservation(),
            "and the MCP client still gets its own: held {}",
            held(AuditActor::McpClient)
        );
        // The slack left by the idle third actor is shared out evenly, so the
        // two active actors end up equally far above their floors.
        let over = |actor: AuditActor| held(actor) as isize - actor.reservation() as isize;
        assert!(
            (over(AuditActor::User) - over(AuditActor::McpClient)).abs() <= 1,
            "unused reservation is shared, not claimed: user over by {}, MCP over by {}",
            over(AuditActor::User),
            over(AuditActor::McpClient)
        );
    }
}
