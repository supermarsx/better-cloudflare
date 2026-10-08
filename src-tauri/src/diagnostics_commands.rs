//! Host-side facts the diagnostics and About screens cannot see from the
//! webview: what this build is, what it is running on, and whether the OS
//! keyring is answering.
//!
//! # What is deliberately not here
//!
//! No credential, and nothing derived from one. The keyring probe reads a key
//! that is never written ([`KEYRING_PROBE_KEY`]) precisely so it can report
//! *reachability* without touching a stored secret: the answer is which error
//! came back, not any value. Nothing in [`HostFacts`] is read from secure
//! storage, from the MCP server's token, or from a provider profile.
//!
//! No user data either. There is no zone, record, domain or account field in
//! this payload, and there is no parameter that could ask for one.
//!
//! # Where the version comes from
//!
//! [`bc_update::embedded_release_tag`] and nowhere else. That is the `YY.N`
//! tag the release workflow stamps into the binary, and `None` means an
//! unstamped local build rather than "unknown, assume old". `tauri.conf.json`
//! says `0.0.0` and always will; it is reported as [`HostFacts::bundle_version`]
//! so a reader can see the placeholder for what it is, never as the version.
//!
//! # Why the audit summary is computed here
//!
//! [`audit_trail_summary`] counts the trail and returns six numbers and two
//! timestamps. It would be shorter to hand the entries to the renderer and
//! count them there, and that is precisely what must not happen: a trail entry
//! records record *content* for the user's own edits — see
//! `src/commands/trail.rs` — and content can be key material. Counting on this
//! side of the IPC boundary means an entry is never transmitted at all, which
//! is a stronger guarantee than a renderer that merely chooses not to ask.
//! `test/diagnosticsAuditIsolation.test.ts` pins both halves.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use bc_storage::{AuditActor, AuditOutcome};

use crate::storage::Storage;

/// A logical key the application never writes.
///
/// The probe needs to distinguish "the keyring answered, and there is no such
/// entry" from "the keyring could not be reached at all", and reading a key
/// that cannot exist is the only way to ask that question without either
/// writing to the user's keyring or reading one of their secrets.
const KEYRING_PROBE_KEY: &str = "diagnostics-reachability-probe";

/// What the keyring probe concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyringAvailability {
    /// The keyring answered. Secrets can be stored and read.
    Available,
    /// The keyring refused or could not be reached. On Linux this is usually a
    /// missing or locked Secret Service; elsewhere it is a denied prompt.
    Unavailable,
    /// The probe failed in a way that says nothing about the keyring itself.
    Unknown,
}

/// The keyring probe's verdict, with the refusal text when there was one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyringProbe {
    pub status: KeyringAvailability,
    /// The backend's own message, or `None`. Carries no secret: it is produced
    /// by a read of [`KEYRING_PROBE_KEY`], which holds nothing.
    pub detail: Option<String>,
}

/// What operating system this is, as the OS itself reports it.
///
/// Distinct from [`HostFacts::os`], which is `std::env::consts::OS` — the
/// target the binary was *compiled* for, with no version in it. The webview
/// user agent is no substitute either: every Windows 11 reports `Windows NT
/// 10.0` in its UA by design, so "Windows 11 26200" is only reachable by
/// asking the OS.
///
/// Mapped field by field from `os_info::Info` rather than serialising it, so
/// the payload the frontend reads is this project's shape and a change in that
/// crate cannot silently alter it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsRelease {
    /// `"Windows"`, `"Macos"`, `"Ubuntu"`, `"Arch"`, … or `"Unknown"`.
    pub os_type: String,
    /// `"11"`, `"15.1"`, `"24.04"`, or `None` when the OS would not say.
    pub version: Option<String>,
    /// Windows build / distribution edition, e.g. `"Windows 11 Pro"`.
    pub edition: Option<String>,
    /// Release codename where there is one, e.g. `"noble"`, `"sonoma"`.
    pub codename: Option<String>,
    /// `"64-bit"`, `"32-bit"`, or `None` when unknown.
    pub bitness: Option<String>,
    /// The machine's own architecture, which can differ from the binary's —
    /// an x86_64 build under Rosetta on an arm64 Mac reports both.
    pub architecture: Option<String>,
}

impl OsRelease {
    /// Ask the OS. Never fails: every field is optional and `os_info` answers
    /// `Unknown` rather than erroring on a platform it cannot read.
    fn detect() -> Self {
        let info = os_info::get();
        let text = |value: &str| {
            let trimmed = value.trim();
            (!trimmed.is_empty() && trimmed != "Unknown").then(|| trimmed.to_string())
        };
        Self {
            os_type: info.os_type().to_string(),
            version: text(&info.version().to_string()),
            edition: info.edition().and_then(text),
            codename: info.codename().and_then(text),
            bitness: text(&info.bitness().to_string()),
            architecture: info.architecture().and_then(text),
        }
    }
}

/// Facts about the running build and its host.
///
/// Every field is either a compile-time constant, a Tauri-provided version
/// string, what the OS says about itself, or the keyring probe's verdict. None
/// of it varies with what the user has stored or which zones they manage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFacts {
    /// The `YY.N` release tag stamped at build time, or `None` for an
    /// unstamped local build. From [`bc_update::embedded_release_tag`].
    pub release_tag: Option<String>,
    /// `tauri.conf.json`'s version — the placeholder `0.0.0`, not a release.
    pub bundle_version: String,
    pub app_name: String,
    /// `"debug"` or `"release"`, from `cfg!(debug_assertions)`.
    pub build_profile: &'static str,
    /// The target this binary was compiled for: `std::env::consts::OS`.
    pub os: &'static str,
    pub arch: &'static str,
    pub family: &'static str,
    /// The Tauri runtime's own version.
    pub tauri_version: &'static str,
    /// The platform webview's version (WebView2, WebKitGTK, WKWebView), or
    /// `None` when it cannot be determined.
    pub webview_version: Option<String>,
    /// What the OS says about itself, including the release the target triple
    /// cannot carry.
    pub os_release: OsRelease,
    pub keyring: KeyringProbe,
}

/// Probe the keyring by reading a key that was never written.
///
/// `NotFound` is the good answer: the backend was reached and said there is no
/// such entry. A `KeyringError` means the backend itself refused. Any other
/// variant is a fault in the probe rather than a statement about the keyring,
/// so it reports [`KeyringAvailability::Unknown`] instead of claiming either.
async fn probe_keyring(storage: &Storage) -> KeyringProbe {
    use bc_storage::StorageError;

    match storage.get_secret(KEYRING_PROBE_KEY).await {
        // Nothing is ever stored here, so a value coming back still proves the
        // backend is reachable, which is all this probe claims.
        Ok(_) => KeyringProbe {
            status: KeyringAvailability::Available,
            detail: None,
        },
        Err(StorageError::NotFound) => KeyringProbe {
            status: KeyringAvailability::Available,
            detail: None,
        },
        Err(StorageError::KeyringError(message)) => KeyringProbe {
            status: KeyringAvailability::Unavailable,
            detail: Some(message),
        },
        Err(error) => KeyringProbe {
            status: KeyringAvailability::Unknown,
            detail: Some(error.to_string()),
        },
    }
}

/// Collect the host-side facts for the About and Diagnostics screens.
///
/// Takes no parameters: there is nothing a caller could ask to widen this, and
/// nothing returned that depends on the caller. Infallible in practice — the
/// `Result` exists so a future fact that can fail has somewhere to go, and so
/// the signature matches every other command on this surface.
#[tauri::command]
pub async fn app_host_facts(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
) -> Result<HostFacts, String> {
    let package = app.package_info();
    Ok(HostFacts {
        release_tag: bc_update::embedded_release_tag().map(str::to_string),
        bundle_version: package.version.to_string(),
        app_name: package.name.clone(),
        build_profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        family: std::env::consts::FAMILY,
        tauri_version: tauri::VERSION,
        webview_version: tauri::webview_version().ok(),
        os_release: OsRelease::detect(),
        keyring: probe_keyring(&storage).await,
    })
}

/// What the audit trail holds, in numbers.
///
/// Six counts and two timestamps. No entry, no operation name, no resource id,
/// and no detail map — see the module comment for why that line is drawn on
/// this side of the IPC boundary rather than in the renderer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditTrailSummary {
    pub entries: usize,
    /// The cap the trail evicts down to, so a reader can see how close the
    /// oldest entries are to being dropped.
    pub capacity: usize,
    /// RFC 3339, or `None` for an empty trail. A timestamp is not an entry:
    /// it says when something happened, never what.
    pub oldest_at: Option<String>,
    pub newest_at: Option<String>,
    /// `user` / `mcp_client` / `assistant`, keyed by [`AuditActor::as_str`].
    pub by_actor: BTreeMap<String, usize>,
    /// `succeeded` / `failed` / `denied`.
    pub by_outcome: BTreeMap<String, usize>,
}

/// Which outcome a stored entry names.
///
/// [`AuditActor::of`] exists for the actor; there is no equivalent for the
/// outcome, so this reads the field the same way — an absent or unrecognised
/// value is not forced into one of the three, because a count that silently
/// bucketed unknown outcomes as successes would misreport the one thing this
/// summary is for.
fn outcome_of(entry: &Value) -> Option<&'static str> {
    match entry.get("outcome").and_then(Value::as_str) {
        Some(value) if value == AuditOutcome::Succeeded.as_str() => {
            Some(AuditOutcome::Succeeded.as_str())
        }
        Some(value) if value == AuditOutcome::Failed.as_str() => {
            Some(AuditOutcome::Failed.as_str())
        }
        Some(value) if value == AuditOutcome::Denied.as_str() => {
            Some(AuditOutcome::Denied.as_str())
        }
        _ => None,
    }
}

/// An entry's `timestamp`, if it is a string. Not parsed: the trail writes
/// RFC 3339 and a value that is not one should travel as whatever it is rather
/// than be reinterpreted — the renderer re-parses and drops what it cannot read.
fn timestamp_of(entry: &Value) -> Option<&str> {
    entry.get("timestamp").and_then(Value::as_str)
}

/// Summarise a trail that is already in hand. Separated from the command so it
/// can be tested without a keyring or an app handle.
fn summarize_trail(entries: &[Value], capacity: usize) -> AuditTrailSummary {
    let mut by_actor: BTreeMap<String, usize> = AuditActor::ALL
        .iter()
        .map(|actor| (actor.as_str().to_string(), 0))
        .collect();
    let mut by_outcome: BTreeMap<String, usize> = [
        AuditOutcome::Succeeded,
        AuditOutcome::Failed,
        AuditOutcome::Denied,
    ]
    .iter()
    .map(|outcome| (outcome.as_str().to_string(), 0))
    .collect();
    let mut oldest: Option<&str> = None;
    let mut newest: Option<&str> = None;

    for entry in entries {
        *by_actor
            .entry(AuditActor::of(entry).as_str().to_string())
            .or_insert(0) += 1;
        if let Some(outcome) = outcome_of(entry) {
            *by_outcome.entry(outcome.to_string()).or_insert(0) += 1;
        }
        // Lexicographic comparison is correct for RFC 3339 in a fixed offset,
        // which is what `now_rfc3339` writes, and avoids pulling a date parse
        // into a counting loop over a thousand entries.
        if let Some(stamp) = timestamp_of(entry) {
            if oldest.is_none_or(|current| stamp < current) {
                oldest = Some(stamp);
            }
            if newest.is_none_or(|current| stamp > current) {
                newest = Some(stamp);
            }
        }
    }

    AuditTrailSummary {
        entries: entries.len(),
        capacity,
        oldest_at: oldest.map(str::to_string),
        newest_at: newest.map(str::to_string),
        by_actor,
        by_outcome,
    }
}

/// How many entries the trail evicts down to.
///
/// Mirrors `MAX_AUDIT_ENTRIES` in `bc-storage/src/lib.rs`, which is private to
/// that crate. `test/aboutAppInfo.test.ts` reads the Rust source and fails if
/// the two drift, which is cheaper than widening another crate's surface for a
/// number that only a diagnostics line wants.
pub const AUDIT_TRAIL_CAPACITY: usize = 1000;

/// Count the audit trail without transmitting any of it.
#[tauri::command]
pub async fn audit_trail_summary(storage: State<'_, Storage>) -> Result<AuditTrailSummary, String> {
    let entries = storage
        .get_audit_entries()
        .await
        .map_err(|error| error.to_string())?;
    Ok(summarize_trail(&entries, AUDIT_TRAIL_CAPACITY))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The probe must never name a key the application actually stores under.
    ///
    /// A probe key that collided with a real logical key would turn a
    /// diagnostics read into a read of the user's secret, and the `Ok(_)` arm
    /// would then be reporting on a value rather than on reachability.
    #[test]
    fn the_probe_key_is_not_one_the_application_writes() {
        for stored in [
            "api_keys",
            "vault",
            "passkeys",
            "audit_log",
            "preferences",
            "encryption_settings",
            "registrar_credentials",
        ] {
            assert_ne!(
                KEYRING_PROBE_KEY, stored,
                "the keyring probe would read real stored data"
            );
        }
    }

    #[test]
    fn the_probe_reports_reachable_when_the_backend_answers_not_found() {
        // Memory mode stands in for a reachable backend: it answers
        // `NotFound` for an absent key exactly as the keyring does.
        let storage = Storage::new(false);
        let probe = tauri::async_runtime::block_on(probe_keyring(&storage));
        assert_eq!(probe.status, KeyringAvailability::Available);
        assert_eq!(
            probe.detail, None,
            "a reachable backend has no refusal to report"
        );
    }

    /// The OS reports *something* on whatever platform the tests run on, and
    /// nothing it reports is a path, a user name or a machine name.
    #[test]
    fn the_os_release_is_readable_and_names_no_one() {
        let release = OsRelease::detect();

        assert!(
            !release.os_type.is_empty(),
            "os_info always answers, even if only `Unknown`"
        );
        let serialized = serde_json::to_string(&release).expect("serialise release");
        // A host name or a user name would make the report identifying. The
        // crate reads version registries and `/etc/os-release`, neither of
        // which carries either, and this pins that it stays that way.
        for forbidden in ["/home/", "/Users/", ":\\Users\\", "C:\\"] {
            assert!(
                !serialized.contains(forbidden),
                "{forbidden:?} reached the OS release payload: {serialized}"
            );
        }
        assert!(
            release
                .version
                .as_deref()
                .is_none_or(|version| version.len() <= 64),
            "a version is a short token, not prose: {release:?}"
        );
    }

    /// Every actor and outcome bucket is present even when nothing matched, so
    /// a reader can tell "no denials" from "denials not counted".
    #[test]
    fn an_empty_trail_still_reports_every_bucket() {
        let summary = summarize_trail(&[], AUDIT_TRAIL_CAPACITY);

        assert_eq!(summary.entries, 0);
        assert_eq!(summary.capacity, AUDIT_TRAIL_CAPACITY);
        assert_eq!(summary.oldest_at, None);
        assert_eq!(summary.newest_at, None);
        assert_eq!(
            summary.by_actor.keys().collect::<Vec<_>>(),
            vec!["assistant", "mcp_client", "user"]
        );
        assert_eq!(
            summary.by_outcome.keys().collect::<Vec<_>>(),
            vec!["denied", "failed", "succeeded"]
        );
        assert!(summary.by_actor.values().all(|count| *count == 0));
    }

    #[test]
    fn the_trail_summary_counts_actors_outcomes_and_its_own_span() {
        let entries = vec![
            serde_json::json!({
                "timestamp": "2026-10-05T09:00:00Z",
                "actor": "user",
                "outcome": "succeeded",
            }),
            serde_json::json!({
                "timestamp": "2026-10-07T09:00:00Z",
                "actor": "mcp_client",
                "outcome": "denied",
            }),
            serde_json::json!({
                "timestamp": "2026-10-06T09:00:00Z",
                "actor": "assistant",
                "outcome": "failed",
            }),
            // No `actor` means an entry that predates the field, and those were
            // all human; no `outcome` is counted in no outcome bucket.
            serde_json::json!({ "timestamp": "2026-10-04T09:00:00Z" }),
        ];
        let summary = summarize_trail(&entries, 1000);

        assert_eq!(summary.entries, 4);
        assert_eq!(summary.oldest_at.as_deref(), Some("2026-10-04T09:00:00Z"));
        assert_eq!(summary.newest_at.as_deref(), Some("2026-10-07T09:00:00Z"));
        assert_eq!(summary.by_actor["user"], 2);
        assert_eq!(summary.by_actor["mcp_client"], 1);
        assert_eq!(summary.by_actor["assistant"], 1);
        assert_eq!(summary.by_outcome["succeeded"], 1);
        assert_eq!(summary.by_outcome["failed"], 1);
        assert_eq!(summary.by_outcome["denied"], 1);
        assert_eq!(
            summary.by_outcome.values().sum::<usize>(),
            3,
            "an unreadable outcome is counted nowhere rather than as a success"
        );
    }

    /// The summary is built from entries that hold record content, and none of
    /// it may survive the counting.
    #[test]
    fn no_part_of_an_entry_survives_the_summary() {
        let entries = vec![serde_json::json!({
            "timestamp": "2026-10-07T09:00:00Z",
            "actor": "user",
            "outcome": "succeeded",
            "operation": "dns:update",
            "resource": "record-1",
            "zone_id": "zone-abc",
            "record_name": "selector._domainkey.example.com",
            "details": {
                "content": "v=DKIM1; p=MIIBIjANBgkqhkiG9w0-secret-key-material",
                "comment": "rotation note",
            },
        })];
        let serialized =
            serde_json::to_string(&summarize_trail(&entries, 1000)).expect("serialise summary");

        for forbidden in [
            "MIIBIjANBgkqhkiG9w0-secret-key-material",
            "selector._domainkey.example.com",
            "example.com",
            "rotation note",
            "dns:update",
            "record-1",
            "zone-abc",
            "operation",
            "resource",
            "details",
            "content",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{forbidden:?} survived the audit summary: {serialized}"
            );
        }
        // A positive control, so the absences above are absences in a summary
        // that actually counted something.
        assert!(serialized.contains("\"entries\":1"));
    }

    /// The payload is serialised into a blob users paste into public issues.
    /// Nothing in it may be a credential, a zone, or a record.
    #[test]
    fn no_field_name_invites_a_secret_or_user_data() {
        let probe = KeyringProbe {
            status: KeyringAvailability::Unavailable,
            detail: Some("the collection is locked".to_string()),
        };
        let facts = HostFacts {
            release_tag: Some("26.14".to_string()),
            bundle_version: "0.0.0".to_string(),
            app_name: "Better Cloudflare".to_string(),
            build_profile: "release",
            os: "windows",
            arch: "x86_64",
            family: "windows",
            tauri_version: "2.11.5",
            webview_version: Some("131.0.2903.70".to_string()),
            os_release: OsRelease {
                os_type: "Windows".to_string(),
                version: Some("11".to_string()),
                edition: Some("Windows 11 Pro".to_string()),
                codename: None,
                bitness: Some("64-bit".to_string()),
                architecture: Some("x86_64".to_string()),
            },
            keyring: probe,
        };
        let serialized = serde_json::to_string(&facts).expect("serialise facts");

        for forbidden in [
            "apiKey",
            "api_key",
            "token",
            "authToken",
            "secret",
            "password",
            "email",
            "zone",
            "record",
            "domain",
            "account",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{forbidden:?} appears in the host facts payload: {serialized}"
            );
        }
    }
}
