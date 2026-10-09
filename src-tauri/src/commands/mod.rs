use chrono::Utc;

use crate::storage::Storage;

pub mod audit;
pub mod auth;
pub mod dns;
/// A zone's change history and the undo it offers. Not glob-re-exported, so
/// its wire types stay behind `commands::history::` the way `retention`'s do —
/// they are named after the renderer's contract, not after this module, and
/// `UndoResult` in the crate root would be anybody's.
pub mod history;
/// Records removed from Cloudflare and kept here — disables and the recycle
/// bin. Not glob-re-exported, so its wire types stay behind
/// `commands::retention::`.
pub mod retention;
pub mod services;
/// How a person's action is described for the audit trail. Not
/// glob-re-exported: it holds no commands, only the vocabulary the commands
/// record through.
pub mod trail;

pub use audit::*;
pub use auth::*;
pub use dns::*;
pub use services::*;

// ─── Shared Helpers ─────────────────────────────────────────────────────────

/// The columns a CSV export writes, in order.
///
/// `actor` and `outcome` have columns of their own rather than sitting inside
/// the details blob, because the first thing anyone does with the log in a
/// spreadsheet is filter by who did it and whether it worked, and you cannot
/// filter on a substring of a JSON string. The DNS identifiers get columns for
/// the same reason — a sheet of a zone's history sorts by name — and `change`
/// is the one the log exists for: what the action did.
///
/// Anything not named here goes to `details` as JSON, so a field added to an
/// entry later still reaches the file without anyone widening this list.
const AUDIT_CSV_HEADERS: [&str; 10] = [
    "timestamp",
    "operation",
    "actor",
    "outcome",
    "resource",
    "zone_id",
    "record_type",
    "record_name",
    "change",
    "details",
];

/// Entry fields that have their own column, and so are not repeated in the
/// `details` blob.
const AUDIT_CSV_PROMOTED_KEYS: [&str; 9] = [
    "timestamp",
    "operation",
    "actor",
    "outcome",
    "resource",
    "zone_id",
    "record_type",
    "record_name",
    "change",
];

/// What `change` renders from, in preference order. Only one of the two is ever
/// present on an entry: a change set needs a known before-state, and a record
/// snapshot is what a creation or a deletion carries instead.
const AUDIT_CSV_CHANGE_KEYS: [&str; 2] = ["changes", "record"];

pub(crate) fn serialize_audit_entries(
    entries: Vec<serde_json::Value>,
    format: &str,
) -> Result<String, String> {
    if format == "json" {
        return serde_json::to_string_pretty(&entries).map_err(|e| e.to_string());
    }
    if format == "csv" {
        let mut rows = Vec::with_capacity(entries.len() + 1);
        rows.push(AUDIT_CSV_HEADERS.join(","));
        for entry in entries {
            rows.push(audit_csv_row(&entry));
        }
        return Ok(rows.join("\n"));
    }
    Err("Unsupported format".to_string())
}

fn audit_csv_row(entry: &serde_json::Value) -> String {
    let text = |key: &str| {
        entry
            .get(key)
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string()
    };
    // An entry written before the trail carried an actor has no field to read,
    // and every writer that existed then was a person acting in the app. The
    // same default `AuditActor::of` applies, so the column never reads as
    // "unknown" for a record that is not ambiguous.
    let actor = match entry.get("actor").and_then(|value| value.as_str()) {
        Some(actor @ ("mcp_client" | "assistant")) => actor.to_string(),
        _ => "user".to_string(),
    };
    let mut details = entry.clone();
    if let serde_json::Value::Object(ref mut map) = details {
        for key in AUDIT_CSV_PROMOTED_KEYS {
            map.remove(key);
        }
        for key in AUDIT_CSV_CHANGE_KEYS {
            map.remove(key);
        }
    }
    let details = serde_json::to_string(&details).unwrap_or_else(|_| "{}".to_string());
    [
        text("timestamp"),
        text("operation"),
        actor,
        text("outcome"),
        text("resource"),
        text("zone_id"),
        text("record_type"),
        text("record_name"),
        audit_csv_change(entry),
        details,
    ]
    .iter()
    .map(|cell| escape_csv_cell(cell))
    .collect::<Vec<_>>()
    .join(",")
}

/// Render what the action did as one sentence per field.
///
/// `field: from -> to` for a change set, `field: value` for a record snapshot.
/// ASCII, deliberately: a spreadsheet opening a CSV without a byte-order mark
/// guesses the encoding, and an arrow glyph is the kind of thing it guesses
/// wrong about.
fn audit_csv_change(entry: &serde_json::Value) -> String {
    for key in AUDIT_CSV_CHANGE_KEYS {
        let Some(fields) = entry.get(key).and_then(|value| value.as_object()) else {
            continue;
        };
        let rendered = fields
            .iter()
            .map(|(field, value)| match value.as_object() {
                Some(pair) if pair.contains_key("from") || pair.contains_key("to") => format!(
                    "{field}: {} -> {}",
                    render_csv_value(pair.get("from")),
                    render_csv_value(pair.get("to"))
                ),
                _ => format!("{field}: {}", render_csv_value(Some(value))),
            })
            .collect::<Vec<_>>()
            .join("; ");
        if !rendered.is_empty() {
            return rendered;
        }
    }
    String::new()
}

fn render_csv_value(value: Option<&serde_json::Value>) -> String {
    match value {
        None | Some(serde_json::Value::Null) => "(unset)".to_string(),
        Some(serde_json::Value::String(text)) => format!("\"{text}\""),
        Some(other) => other.to_string(),
    }
}

/// Quote one cell, and defuse a leading character a spreadsheet would read as
/// the start of a formula.
///
/// The log now carries record content the user typed, and a TXT value may
/// legitimately begin with `=` or `+`. Quoting alone does not help — Excel and
/// Sheets evaluate the cell anyway — so such a cell is prefixed with an
/// apostrophe, which is the one mitigation those programs honour and which
/// leaves the value readable.
fn escape_csv_cell(value: &str) -> String {
    let needs_guard = value
        .chars()
        .next()
        .is_some_and(|first| matches!(first, '=' | '+' | '-' | '@' | '\t' | '\r'));
    let guarded = if needs_guard {
        format!("'{value}")
    } else {
        value.to_string()
    };
    format!("\"{}\"", guarded.replace('"', "\"\""))
}

pub(crate) fn resolve_export_directory(
    folder_preset: Option<&str>,
    custom_path: Option<&str>,
) -> Option<std::path::PathBuf> {
    let preset = folder_preset.unwrap_or("documents").to_lowercase();
    match preset.as_str() {
        "documents" => dirs::document_dir(),
        "downloads" => dirs::download_dir(),
        "desktop" => dirs::desktop_dir(),
        "home" => dirs::home_dir(),
        "custom" => {
            let candidate = custom_path.unwrap_or("").trim();
            if candidate.is_empty() {
                None
            } else {
                let path = std::path::PathBuf::from(candidate);
                if path.exists() && path.is_dir() {
                    Some(path)
                } else {
                    None
                }
            }
        }
        _ => None,
    }
}

/// Append an entry the caller assembled itself.
///
/// The untyped path, kept for the credential and session commands that have
/// always written the log this way. Their entries are small and of a fixed
/// shape, which is the condition for using it: nothing here bounds the entry,
/// and the whole log is one stored secret with a hard ceiling that a write over
/// it fails — silently, because the trail swallows its write errors. One
/// oversized entry therefore does not produce one big record, it stops the log
/// recording anything again.
///
/// So a command that puts a caller-supplied value in an entry uses
/// [`bc_storage::AuditEntry`] through [`trail`] instead, which bounds every
/// field on the way in.
pub(crate) async fn log_audit(storage: &Storage, entry: serde_json::Value) {
    let mut entry = entry;
    if let serde_json::Value::Object(ref mut map) = entry {
        map.entry("timestamp".to_string())
            .or_insert_with(|| serde_json::Value::String(Utc::now().to_rfc3339()));
        if let Some(outcome) = derived_outcome(map) {
            map.insert(
                "outcome".to_string(),
                serde_json::Value::String(outcome.to_string()),
            );
        }
    }
    let _ = storage.add_audit_entry(entry).await;
}

/// The outcome an entry implies but does not state.
///
/// The credential and session commands have recorded a `success` boolean since
/// long before the trail had an outcome, and `success` is the parallel shape
/// `bc_storage::audit::AuditOutcome` replaced. Deriving one from the other here
/// means every one of those entries gains the field the trail filters on —
/// there is no "Failed" view of a log where a rejected passkey records
/// `success: false` and nothing else — without touching twenty call sites or
/// dropping the key an existing reader may still be looking at.
///
/// `failed` rather than `denied` for a false: those commands dispatch and are
/// told no, which is what `AuditOutcome::Failed` is for. Nothing is derived for
/// an entry that already states an outcome, or one that never claimed a
/// success.
fn derived_outcome(entry: &serde_json::Map<String, serde_json::Value>) -> Option<&'static str> {
    if entry.contains_key("outcome") {
        return None;
    }
    match entry.get("success").and_then(serde_json::Value::as_bool)? {
        true => Some("succeeded"),
        false => Some("failed"),
    }
}

#[cfg(test)]
mod audit_export_tests {
    use serde_json::json;

    use super::*;

    fn rows(entries: Vec<serde_json::Value>) -> Vec<String> {
        serialize_audit_entries(entries, "csv")
            .expect("csv is a supported format")
            .lines()
            .map(ToString::to_string)
            .collect()
    }

    #[test]
    fn the_filterable_fields_get_columns_and_are_not_repeated_in_the_blob() {
        let rows = rows(vec![json!({
            "timestamp": "2026-01-01T00:00:00+00:00",
            "operation": "dns:update",
            "actor": "user",
            "outcome": "succeeded",
            "resource": "record-1",
            "zone_id": "zone-1",
            "record_type": "A",
            "record_name": "www.example.com",
            "changes": { "ttl": { "from": 300, "to": 1 } },
            "failure": "none_of_your_business",
        })]);

        assert_eq!(
            rows[0],
            "timestamp,operation,actor,outcome,resource,zone_id,record_type,record_name,change,details"
        );
        assert_eq!(
            rows[1],
            "\"2026-01-01T00:00:00+00:00\",\"dns:update\",\"user\",\"succeeded\",\
             \"record-1\",\"zone-1\",\"A\",\"www.example.com\",\"ttl: 300 -> 1\",\
             \"{\"\"failure\"\":\"\"none_of_your_business\"\"}\""
        );
    }

    #[test]
    fn an_entry_written_before_the_actor_field_exports_as_the_human_who_wrote_it() {
        let rows = rows(vec![json!({
            "timestamp": "2026-01-01T00:00:00+00:00",
            "operation": "dns:create",
            "resource": "record-1",
        })]);
        let cells: Vec<&str> = rows[1].split(',').collect();
        assert_eq!(cells[2], "\"user\"");
        assert_eq!(cells[3], "\"\"", "and it claims no outcome it never had");
    }

    #[test]
    fn the_change_column_renders_a_record_snapshot_as_well_as_a_change_set() {
        let rows = rows(vec![json!({
            "operation": "dns:delete",
            "record": { "content": "203.0.113.1", "ttl": 300 },
        })]);
        assert!(
            rows[1].contains("\"content: \"\"203.0.113.1\"\"; ttl: 300\""),
            "unexpected row: {}",
            rows[1]
        );
    }

    #[test]
    fn a_field_that_became_unset_reads_as_unset_rather_than_as_nothing() {
        let rows = rows(vec![json!({
            "operation": "dns:update",
            "changes": { "comment": { "from": "note", "to": null } },
        })]);
        assert!(
            rows[1].contains("comment: \"\"note\"\" -> (unset)"),
            "unexpected row: {}",
            rows[1]
        );
    }

    #[test]
    fn a_cell_a_spreadsheet_would_evaluate_is_defused() {
        // The log now carries content the user typed, so this is reachable
        // from a TXT record rather than only from a hostile log.
        let rows = rows(vec![json!({
            "operation": "dns:create",
            "record_name": "=HYPERLINK(\"http://evil\",\"click\")",
        })]);
        assert!(
            rows[1].contains("\"'=HYPERLINK("),
            "a leading equals must not survive into a formula: {}",
            rows[1]
        );
    }

    #[test]
    fn a_success_boolean_gains_the_outcome_the_trail_filters_on() {
        let outcome = |entry: serde_json::Value| {
            let serde_json::Value::Object(map) = entry else {
                unreachable!("fixtures are objects")
            };
            derived_outcome(&map)
        };
        assert_eq!(
            outcome(json!({ "operation": "auth:verify_token", "success": true })),
            Some("succeeded")
        );
        assert_eq!(
            outcome(json!({ "operation": "auth:verify_token", "success": false })),
            Some("failed"),
            "a rejected credential has to be visible in the failed view"
        );
        assert_eq!(
            outcome(json!({ "operation": "x", "success": false, "outcome": "denied" })),
            None,
            "an entry that states its own outcome is not second-guessed"
        );
        assert_eq!(
            outcome(json!({ "operation": "api_key:add" })),
            None,
            "and an entry that never claimed a success is left alone"
        );
    }

    #[test]
    fn json_export_is_unchanged_and_an_unknown_format_is_refused() {
        let entries = vec![json!({ "operation": "dns:create" })];
        let json = serialize_audit_entries(entries.clone(), "json").expect("json");
        assert!(json.contains("\"operation\": \"dns:create\""));
        assert_eq!(
            serialize_audit_entries(entries, "xml"),
            Err("Unsupported format".to_string())
        );
    }
}
