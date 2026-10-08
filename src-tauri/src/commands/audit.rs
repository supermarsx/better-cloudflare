use base64::Engine;
use bc_storage::{AuditOutcome, AuditTrail};
use chrono::Utc;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};

use crate::app_config::{AppConfigError, AppConfigStore, PreferenceChange};
use crate::storage::{Preferences, Storage};

use super::trail;
use super::{resolve_export_directory, serialize_audit_entries};

/// Record that a copy of the trail left the application.
///
/// An export is how the log leaves the machine, so "when was a copy of this
/// made, and in what shape" is a question the log should answer about itself.
/// The format and the number of entries, and for a save the folder *preset*
/// rather than the path: a path carries the user's account name, and the entry
/// does not need it to be useful.
fn record_export(
    storage: &Storage,
    operation: &str,
    format: &str,
    entries: usize,
    destination: Option<&str>,
) {
    storage.record(
        trail::user_action(operation, AuditOutcome::Succeeded)
            .detail("format", format)
            .detail("entries", entries as u64)
            .optional_detail("destination", destination.map(str::to_string)),
    );
}

// ─── App lifecycle ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_path_in_file_manager(path: String) -> Result<(), String> {
    let input = std::path::PathBuf::from(path);
    let target = if input.is_dir() {
        input
    } else {
        input
            .parent()
            .map(std::path::Path::to_path_buf)
            .ok_or_else(|| "Invalid path".to_string())?
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(target.as_os_str());
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(target.as_os_str());
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(target.as_os_str());
        c
    };

    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn restart_app(app: AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let args: Vec<String> = std::env::args().skip(1).collect();

    std::process::Command::new(exe)
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;

    app.exit(0);
    Ok(())
}

// ─── Audit ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_audit_entries(
    storage: State<'_, Storage>,
) -> Result<Vec<serde_json::Value>, String> {
    storage.get_audit_entries().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_audit_entries(
    storage: State<'_, Storage>,
    format: Option<String>,
) -> Result<String, String> {
    let entries = storage
        .get_audit_entries()
        .await
        .map_err(|e| e.to_string())?;
    let fmt = format.unwrap_or_else(|| "json".to_string());
    let count = entries.len();
    let payload = serialize_audit_entries(entries, &fmt)?;
    record_export(&storage, "audit:export", &fmt, count, None);
    Ok(payload)
}

#[tauri::command]
pub async fn save_audit_entries(
    storage: State<'_, Storage>,
    format: Option<String>,
    folder_preset: Option<String>,
    custom_path: Option<String>,
    skip_destination_confirm: Option<bool>,
) -> Result<String, String> {
    let entries = storage
        .get_audit_entries()
        .await
        .map_err(|e| e.to_string())?;
    let fmt = format.unwrap_or_else(|| "json".to_string()).to_lowercase();
    let count = entries.len();
    let payload = serialize_audit_entries(entries, &fmt)?;
    let extension = if fmt == "csv" { "csv" } else { "json" };
    let should_skip_confirm = skip_destination_confirm.unwrap_or(true);
    if should_skip_confirm {
        let base_dir = resolve_export_directory(folder_preset.as_deref(), custom_path.as_deref())
            .or_else(dirs::document_dir)
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| "Unable to resolve export directory".to_string())?;
        let stamp = Utc::now().format("%Y%m%d-%H%M%S");
        let file_name = format!("audit-log-{}.{}", stamp, extension);
        let path = base_dir.join(file_name);
        std::fs::write(&path, payload).map_err(|e| e.to_string())?;
        record_export(
            &storage,
            "audit:save",
            &fmt,
            count,
            Some(folder_preset.as_deref().unwrap_or("documents")),
        );
        return Ok(path.display().to_string());
    }

    let file_name = format!("audit-log.{}", extension);
    let mut dialog = rfd::FileDialog::new().set_file_name(&file_name);
    if let Some(dir) = resolve_export_directory(folder_preset.as_deref(), custom_path.as_deref()) {
        dialog = dialog.set_directory(dir);
    }
    if fmt == "csv" {
        dialog = dialog.add_filter("CSV", &["csv"]);
    } else {
        dialog = dialog.add_filter("JSON", &["json"]);
    }
    let Some(path) = dialog.save_file() else {
        // Nothing happened and nothing left the machine, so there is nothing
        // to record: the trail is a record of what was done.
        return Err("Save cancelled".to_string());
    };
    std::fs::write(&path, payload).map_err(|e| e.to_string())?;
    record_export(&storage, "audit:save", &fmt, count, Some("chosen"));
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn save_topology_asset(
    format: String,
    file_name: String,
    payload: String,
    is_base64: Option<bool>,
    folder_preset: Option<String>,
    custom_path: Option<String>,
    confirm_path: Option<bool>,
) -> Result<String, String> {
    let fmt = format.trim().to_lowercase();
    if fmt.is_empty() {
        return Err("Format is required".to_string());
    }
    let extension = match fmt.as_str() {
        "png" => "png",
        "svg" => "svg",
        "mmd" | "code" | "txt" => "mmd",
        _ => return Err("Unsupported topology export format".to_string()),
    };
    let base_name = file_name.trim();
    let fallback_name = format!("zone-topology.{}", extension);
    let name = if base_name.is_empty() {
        fallback_name
    } else if base_name
        .to_lowercase()
        .ends_with(&format!(".{}", extension))
    {
        base_name.to_string()
    } else {
        format!("{}.{}", base_name, extension)
    };

    let bytes = if is_base64.unwrap_or(false) {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|e| e.to_string())?
    } else {
        payload.into_bytes()
    };
    let should_confirm = confirm_path.unwrap_or(true);
    if !should_confirm {
        let base_dir = resolve_export_directory(folder_preset.as_deref(), custom_path.as_deref())
            .or_else(dirs::document_dir)
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| "Unable to resolve export directory".to_string())?;
        let stamp = Utc::now().format("%Y%m%d-%H%M%S");
        let final_name = if name.contains('.') {
            let stem = std::path::Path::new(&name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("zone-topology");
            let ext = std::path::Path::new(&name)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or(extension);
            format!("{}-{}.{}", stem, stamp, ext)
        } else {
            format!("{}-{}.{}", name, stamp, extension)
        };
        let path = base_dir.join(final_name);
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        return Ok(path.display().to_string());
    }

    let mut dialog = rfd::FileDialog::new().set_file_name(&name);
    if let Some(dir) = resolve_export_directory(folder_preset.as_deref(), custom_path.as_deref()) {
        dialog = dialog.set_directory(dir);
    }
    dialog = match extension {
        "png" => dialog.add_filter("PNG", &["png"]),
        "svg" => dialog.add_filter("SVG", &["svg"]),
        _ => dialog.add_filter("Mermaid", &["mmd", "txt"]),
    };
    let Some(path) = dialog.save_file() else {
        return Err("Save cancelled".to_string());
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Erase the trail.
///
/// The erasure is itself recorded, in the log it just emptied. A trail that
/// can be wiped without leaving a mark cannot be relied on for the one thing
/// it is for, and a reader finding a single `audit:clear` entry knows exactly
/// what they are looking at — including how much is no longer there. The
/// count is read before the clear, because afterwards there is nothing to
/// count.
#[tauri::command]
pub async fn clear_audit_entries(storage: State<'_, Storage>) -> Result<(), String> {
    clear_audit_entries_with(&storage).await
}

/// The body of [`clear_audit_entries`], taking a plain reference so it is
/// callable from tests without a Tauri runtime.
async fn clear_audit_entries_with(storage: &Storage) -> Result<(), String> {
    let cleared = storage
        .get_audit_entries()
        .await
        .map_or(0, |entries| entries.len());
    storage
        .clear_audit_entries()
        .await
        .map_err(|e| e.to_string())?;
    storage.record(
        trail::user_action("audit:clear", AuditOutcome::Succeeded)
            .detail("entries", cleared as u64),
    );
    Ok(())
}

// ─── Preferences ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_preferences(
    config: State<'_, AppConfigStore>,
    storage: State<'_, Storage>,
) -> Result<Preferences, String> {
    config
        .get_preferences(
            || storage.get_legacy_preferences(),
            || storage.delete_legacy_preferences(),
        )
        .await
        .map_err(|error| error.to_string())
}

/// `operation` for a change to the application's own settings.
///
/// `<subject>:<verb>`, like every other entry in the log (`dns:create`,
/// `zone_setting:update`, `audit:clear`). Deliberately not under `dns:` or
/// `zone_setting:`: those name things that live in the user's Cloudflare
/// account, and `bc_notify`'s `own_changed_record_id` reads the `dns:*`
/// operations to decide which record changes this application made itself, so
/// a settings entry filed under one of those names would be read as a claim
/// about a DNS record.
const PREFERENCES_UPDATE: &str = "preferences:update";

/// Preferences whose value is never written to the trail, only its shape.
///
/// The trail does record the user's own data — see `commands::trail`'s header,
/// which explains why record content is in and credentials are out. These are
/// the preferences that fall on the credential side of that line, and each is
/// here for its own reason:
///
/// * The two **export paths** are filesystem paths, and a path carries the
///   user's account name. `record_export` already refuses to write one for
///   exactly this reason, recording the folder *preset* instead; recording the
///   same path here, in a different entry, would undo that decision rather
///   than respect it.
/// * **`topology_doh_custom_url`** is a URL the user typed. Several DoH
///   providers issue per-subscriber endpoints with the subscriber's token in
///   the path or query, so this field can hold a credential in a shape nothing
///   can distinguish from an ordinary URL.
/// * **`topology_custom_dns_server`** is the same family — an endpoint the user
///   typed by hand — and is treated the same way on purpose. An address on its
///   own is not a secret, so this one is redaction the trail does not strictly
///   owe. It is here because the alternative is splitting the family on a
///   judgment about which scheme can carry a token, and that judgment is the
///   one that goes wrong the next time a provider invents an endpoint format.
///   A reader still learns that the custom resolver changed, and to a value of
///   a different length.
/// * **`session_settings_profiles`** maps user-chosen profile names to
///   arbitrary saved values. It is the one preference whose contents this
///   application does not define, so it is the one that could hold anything at
///   all. Its shape is also already the common case: a profile is far past
///   [`trail::MAX_CHANGE_VALUE_BYTES`], so the size rule in [`recorded_value`]
///   would reduce it anyway — it is named here so that a *small* one is
///   reduced too.
///
/// Everything else is this application's own vocabulary: themes, locales,
/// counts, booleans, column names, record types, zone names. Zone and record
/// names are already in the trail, written there by the DNS entries, so a
/// preference naming one discloses nothing the log does not hold already.
const SHAPE_ONLY_PREFERENCES: [&str; 5] = [
    "audit_export_custom_path",
    "session_settings_profiles",
    "topology_custom_dns_server",
    "topology_doh_custom_url",
    "topology_export_custom_path",
];

#[tauri::command]
pub async fn update_preferences(
    config: State<'_, AppConfigStore>,
    storage: State<'_, Storage>,
    prefs: Map<String, Value>,
) -> Result<(), String> {
    update_preferences_with(&config, &storage, prefs).await
}

/// The body of [`update_preferences`], taking plain references so it is
/// callable from tests without a Tauri runtime.
async fn update_preferences_with(
    config: &AppConfigStore,
    storage: &Storage,
    prefs: Map<String, Value>,
) -> Result<(), String> {
    // Read out before the map is handed over: a refused write still has to be
    // able to say which settings it was asked to write, and by then the map is
    // gone.
    let requested: Vec<String> = prefs.keys().cloned().collect();
    match config
        .update_preferences_reporting_changes(
            prefs,
            || storage.get_legacy_preferences(),
            || storage.delete_legacy_preferences(),
        )
        .await
    {
        Ok(changes) => {
            record_preference_change(storage, &changes);
            Ok(())
        }
        Err(error) => {
            record_refused_preference_write(storage, &requested, &error);
            Err(error.to_string())
        }
    }
}

/// Record what a settings save changed — and nothing at all when it changed
/// nothing.
///
/// The silence is the point, and it is what makes the rest of these entries
/// readable. The renderer persists preferences by sending whole groups of them
/// back: one topology save carries a dozen keys the user never touched, and the
/// settings screen re-saves on mount. An entry per call would bury the handful
/// of real changes under hundreds of identical no-op saves, and because the
/// human half of the log has a fixed reservation
/// (`bc_storage::audit::evict_to_cap`), those no-ops would evict the user's own
/// DNS history to say nothing.
///
/// `changed` is the number of preferences that really differ, which is not the
/// number `changes` names: the change set is spent against the entry's detail
/// budget and says how many it could not afford. Keeping the total as its own
/// field means a reader can tell "the user changed two settings" from "the user
/// changed forty and the trail could only name six" — and the count is right
/// either way, because `attach_fields` is the only thing that drops a key and
/// `changes_omitted` is its own report of how many.
fn record_preference_change(storage: &Storage, changes: &[PreferenceChange]) {
    if changes.is_empty() {
        return;
    }
    let fields = changes
        .iter()
        .map(|change| {
            (
                change.key.clone(),
                json!({
                    "from": recorded_value(&change.key, &change.before),
                    "to": recorded_value(&change.key, &change.after),
                }),
            )
        })
        .collect();
    storage.record(trail::attach_fields(
        trail::user_action(PREFERENCES_UPDATE, AuditOutcome::Succeeded)
            .detail("changed", changes.len() as u64),
        "changes",
        "changes_omitted",
        fields,
    ));
}

/// Record a settings save that did not happen.
///
/// More interesting than one that did, not less: a preference the user believes
/// they set and which is not set is a question the trail should be able to
/// answer, and the refusals here include a keyring outage that silently left
/// the old value in place. There is no change set, because nothing changed —
/// the requested key *names* are the entry's content instead.
fn record_refused_preference_write(
    storage: &Storage,
    requested: &[String],
    error: &AppConfigError,
) {
    storage.record(
        trail::user_action(PREFERENCES_UPDATE, refusal_outcome(error))
            .detail("failure", refusal_kind(error))
            .detail("requested", requested.len() as u64)
            // Through `setting_value` like every other value, because on an
            // `InvalidUpdate` one of these names is a key the renderer made up
            // and this application does not know — free-form text, which the
            // trail bounds rather than trusts.
            .detail("settings", trail::setting_value(&json!(requested))),
    );
}

/// Whether a refused write was this application declining to make a change, or
/// the store failing to carry one out.
///
/// The line is whether anything could have been written. `Denied` promises a
/// reader that nothing was dispatched, and for all three of these nothing was:
/// the update was rejected on its own merits (`InvalidUpdate`), rejected on a
/// size bound before the merge (`Oversize`), or deliberately refused to protect
/// preferences still sitting in the legacy store (`LegacyUnavailable`).
///
/// The rest are `Failed`, which is the honest answer rather than the tidy one.
/// An `Io` error can come from the atomic replace itself and a `Corrupt` can
/// come from the post-write verification, so in both the new file may already
/// be on disk — `AuditOutcome::Failed` is the variant that says "a write
/// recorded this way may still have landed", and calling either of them a
/// denial would tell a reader the opposite of that.
fn refusal_outcome(error: &AppConfigError) -> AuditOutcome {
    match error {
        AppConfigError::InvalidUpdate(_)
        | AppConfigError::Oversize
        | AppConfigError::LegacyUnavailable(_) => AuditOutcome::Denied,
        AppConfigError::Io(_)
        | AppConfigError::Corrupt(_)
        | AppConfigError::UnsupportedVersion(_) => AuditOutcome::Failed,
    }
}

/// Why a settings save was refused, in this application's own words.
///
/// Classified from the error's variant and never from its message, the same
/// rule `trail::failure_kind` follows for a provider error — and here the rule
/// is not only about provenance. These messages are built to be read by a
/// person who hit the problem: `AppConfigError::Io` formats the full path of
/// the preference file, which carries the user's account name, and
/// `InvalidUpdate` and `Corrupt` carry serde's text, which quotes the value it
/// could not accept. Either one in the trail would route a preference value
/// around every bound in this module.
fn refusal_kind(error: &AppConfigError) -> &'static str {
    match error {
        AppConfigError::Io(_) => "io",
        AppConfigError::Corrupt(_) => "corrupt",
        AppConfigError::Oversize => "oversize",
        AppConfigError::UnsupportedVersion(_) => "unsupported_version",
        AppConfigError::InvalidUpdate(_) => "invalid_update",
        AppConfigError::LegacyUnavailable(_) => "legacy_unavailable",
    }
}

/// One preference value, as the trail records it.
///
/// Three treatments, in the order they are decided:
///
/// 1. A preference on [`SHAPE_ONLY_PREFERENCES`] is reduced to its shape at any
///    size. Its content never reaches the trail.
/// 2. A scalar goes through [`trail::setting_value`], which is also where a
///    long string is truncated rather than reshaped. That bargain is the one
///    the trail already makes for record content: a prefix answers "changed to
///    what", and a theme or a locale is not a secret.
/// 3. A structured value goes through [`trail::setting_value`] only while it
///    fits [`trail::MAX_CHANGE_VALUE_BYTES`] whole. Past that it is reshaped,
///    because a truncated object is the worst of both: the first hundred bytes
///    of `notifications` are the same `{"version":1,"service":{…` before and
///    after whatever the user actually changed, so the prefix costs the entry
///    its budget to say nothing, while still being content.
///
/// A reshaped key can therefore show the same shape on both sides. That still
/// means a real change: the comparison that put the key in the change set at
/// all ran on the stored values in `app_config`, before any of this.
fn recorded_value(key: &str, value: &Value) -> Value {
    if SHAPE_ONLY_PREFERENCES.contains(&key) {
        return value_shape(value);
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            trail::setting_value(value)
        }
        structured if structured.to_string().len() <= trail::MAX_CHANGE_VALUE_BYTES => {
            trail::setting_value(structured)
        }
        structured => value_shape(structured),
    }
}

/// What a value is, carrying no part of what it says.
///
/// A size rather than a sample, so the entry stays useful where it cannot be
/// specific: a reader learns that a path was set and then cleared, or that a
/// profile grew, without the trail holding either. Bounded by construction —
/// the longest of these is a few dozen bytes whatever it describes — which is
/// the other half of why an oversized value is reshaped instead of truncated.
fn value_shape(value: &Value) -> Value {
    Value::String(match value {
        Value::Null => "[unset]".to_string(),
        Value::Bool(_) => "[boolean]".to_string(),
        Value::Number(_) => "[number]".to_string(),
        Value::String(text) => format!("[string, {}]", counted(text.len(), "byte")),
        Value::Array(items) => format!(
            "[array, {}, {}]",
            counted(items.len(), "item"),
            counted(value.to_string().len(), "byte")
        ),
        Value::Object(fields) => format!(
            "[object, {}, {}]",
            counted(fields.len(), "key"),
            counted(value.to_string().len(), "byte")
        ),
    })
}

/// `1 key`, `2 keys`. Pluralised because these strings are read by a person
/// looking for one setting in a log, not parsed.
fn counted(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("{count} {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

#[cfg(test)]
mod audit_self_record_tests {
    use super::*;

    async fn log(storage: &Storage) -> Vec<Value> {
        storage
            .get_audit_entries()
            .await
            .expect("the memory-backed store must return its log")
    }

    struct TestDir(std::path::PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("bc-settings-audit-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn prefs(entries: &[(&str, Value)]) -> Map<String, Value> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone()))
            .collect()
    }

    /// A preference store and a trail, wired the way the command wires them.
    ///
    /// The directory comes back so the caller holds it: dropping it removes the
    /// preference file, and a store whose file vanished mid-test reads as a
    /// fresh install.
    fn settings_store() -> (TestDir, AppConfigStore, Storage) {
        let directory = TestDir::new();
        let config = AppConfigStore::new(directory.0.clone());
        (directory, config, Storage::new(false))
    }

    #[tokio::test]
    async fn a_settings_change_records_which_settings_changed_and_what_they_became() {
        let (_directory, config, storage) = settings_store();
        update_preferences_with(&config, &storage, prefs(&[("theme", json!("dark"))]))
            .await
            .expect("first settings write");

        let entries = log(&storage).await;
        assert_eq!(entries.len(), 1, "one entry for one save: {entries:?}");
        assert_eq!(entries[0]["operation"], json!("preferences:update"));
        assert_eq!(entries[0]["actor"], json!("user"));
        assert_eq!(entries[0]["outcome"], json!("succeeded"));
        assert_eq!(entries[0]["changed"], json!(1));
        assert_eq!(
            entries[0]["changes"],
            json!({ "theme": { "from": null, "to": "dark" } }),
            "a preference that was unset reads as a null side, not a missing one"
        );
        assert!(
            entries[0].get("changes_omitted").is_none(),
            "nothing was left out, so nothing claims it was"
        );

        update_preferences_with(
            &config,
            &storage,
            prefs(&[("theme", json!("light")), ("locale", json!("pt-PT"))]),
        )
        .await
        .expect("second settings write");

        let entries = log(&storage).await;
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1]["changed"], json!(2));
        assert_eq!(
            entries[1]["changes"],
            json!({
                "locale": { "from": null, "to": "pt-PT" },
                "theme": { "from": "dark", "to": "light" },
            }),
            "the before-state is what was stored, so a second edit of the same \
             setting reads from the first"
        );
    }

    #[tokio::test]
    async fn a_save_that_changes_nothing_leaves_no_trace() {
        let (_directory, config, storage) = settings_store();
        let save = prefs(&[
            ("theme", json!("dark")),
            ("locale", json!("en")),
            ("confirm_logout", json!(true)),
            ("default_per_page", json!(50)),
        ]);
        update_preferences_with(&config, &storage, save.clone())
            .await
            .expect("the first save does change things");
        assert_eq!(log(&storage).await.len(), 1);

        // The renderer persists preferences by sending whole groups of them
        // back: the settings screen re-saves on mount and after any unrelated
        // edit. None of those is a change, and an entry for each would bury
        // the real ones -- and, because the human half of the log has a fixed
        // reservation, evict the user's own DNS history to say nothing.
        for _ in 0..5 {
            update_preferences_with(&config, &storage, save.clone())
                .await
                .expect("re-persisting identical values still succeeds");
        }

        let entries = log(&storage).await;
        assert_eq!(
            entries.len(),
            1,
            "a write that changed nothing must add nothing: {entries:?}"
        );
    }

    #[tokio::test]
    async fn only_the_renderers_command_records_a_settings_change() {
        let (_directory, config, storage) = settings_store();
        config
            .update_preferences(
                prefs(&[("notifications", json!({ "service": { "paused": true } }))]),
                || storage.get_legacy_preferences(),
                || storage.delete_legacy_preferences(),
            )
            .await
            .expect("the notification service persists its own settings");

        assert!(
            log(&storage).await.is_empty(),
            "the background service writes preferences on its own schedule and \
             is not a person; an entry would be a user action nobody performed"
        );
    }

    #[tokio::test]
    async fn a_shape_only_preference_records_its_shape_and_never_its_value() {
        let (_directory, config, storage) = settings_store();
        let path = "C:\\Users\\ada\\Documents\\audit-exports";
        let doh = "https://dns.example.net/9f3c-subscriber-token/dns-query";
        let resolver = "resolver.internal.example:5353";
        let profiles = json!({ "work": { "note": "s3cr3t" } });
        update_preferences_with(
            &config,
            &storage,
            prefs(&[
                ("audit_export_custom_path", json!(path)),
                ("topology_doh_custom_url", json!(doh)),
                ("topology_custom_dns_server", json!(resolver)),
                ("session_settings_profiles", profiles.clone()),
            ]),
        )
        .await
        .expect("a save of every shape-only preference");

        let entries = log(&storage).await;
        let serialized = entries[0].to_string();
        for forbidden in [
            "ada",
            "Documents",
            "subscriber-token",
            "dns-query",
            "resolver.internal",
            "s3cr3t",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{forbidden:?} reached the trail: {serialized}"
            );
        }

        assert_eq!(entries[0]["changed"], json!(4));
        let changes = &entries[0]["changes"];
        assert_eq!(
            changes["audit_export_custom_path"],
            json!({
                "from": "[unset]",
                "to": format!("[string, {} bytes]", path.len()),
            }),
            "a path is a length, and clearing one is still legible"
        );
        assert_eq!(
            changes["topology_doh_custom_url"]["to"],
            json!(format!("[string, {} bytes]", doh.len()))
        );
        assert_eq!(
            changes["topology_custom_dns_server"]["to"],
            json!(format!("[string, {} bytes]", resolver.len()))
        );
        assert_eq!(
            changes["session_settings_profiles"]["to"],
            json!(format!(
                "[object, 1 key, {} bytes]",
                profiles.to_string().len()
            )),
            "a small free-form value is reshaped too, not only one over the bound"
        );
    }

    #[tokio::test]
    async fn a_large_nested_setting_is_reshaped_rather_than_truncated() {
        let (_directory, config, storage) = settings_store();
        update_preferences_with(
            &config,
            &storage,
            prefs(&[("notifications", json!({ "service": { "paused": true } }))]),
        )
        .await
        .expect("a notifications save");

        let entries = log(&storage).await;
        let change = &entries[0]["changes"]["notifications"];
        assert_eq!(
            change["from"],
            json!(null),
            "the size rule reshapes a value it cannot fit; an unset one fits, \
             and reads as the same null side every other preference uses"
        );
        let after = change["to"].as_str().expect("a shape for the new value");
        assert!(
            after.starts_with("[object, "),
            "a whole settings object cannot fit a value, so it is reshaped: {after}"
        );
        assert!(
            !after.contains("paused") && !after.contains("version"),
            "a truncated prefix of an object is still content, and the first \
             hundred bytes of this one are identical either way: {after}"
        );
    }

    #[tokio::test]
    async fn an_absurd_settings_save_still_produces_a_bounded_entry() {
        let (_directory, config, storage) = settings_store();
        // Deep as well as long, and deep in the one preference whose contents
        // this application does not define. Sixty-four levels is the order of
        // what can actually arrive: serde_json refuses to parse past its own
        // recursion limit, so the command boundary has already rejected
        // anything deeper before it reaches here.
        let mut nested = json!("leaf");
        for _ in 0..64 {
            nested = json!({ "deeper": nested });
        }
        let long = "x".repeat(400);
        let save = prefs(&[
            ("session_settings_profiles", json!({ "profile": nested })),
            ("theme", json!(long.clone())),
            ("locale", json!(long.clone())),
            ("last_zone", json!(long.clone())),
            ("last_active_tab", json!(long.clone())),
            ("topology_dns_server", json!(long.clone())),
            ("topology_geo_provider", json!(long.clone())),
            ("topology_resolver_mode", json!(long.clone())),
            ("topology_doh_provider", json!(long.clone())),
            ("mcp_server_host", json!(long.clone())),
            ("audit_export_folder_preset", json!(long.clone())),
            ("topology_export_folder_preset", json!(long)),
            ("dns_table_columns", json!(vec!["column"; 60])),
            ("topology_tcp_services", json!(vec!["service"; 60])),
        ]);
        let changed = save.len();
        update_preferences_with(&config, &storage, save)
            .await
            .expect("an absurd save is still a legal one");

        let entries = log(&storage).await;
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(
            entry["changed"],
            json!(changed as u64),
            "every change is counted even when it cannot be named"
        );
        let named = entry["changes"]
            .as_object()
            .expect("the change set must survive a budget overrun")
            .len();
        assert!(named > 0, "the entry must still name something: {entry}");
        assert_eq!(
            entry["changes_omitted"].as_u64().unwrap_or_default() as usize,
            changed - named,
            "what the budget could not afford is counted, not silently missing"
        );
        let serialized = entry.to_string();
        assert!(
            serialized.len() <= bc_storage::audit::MAX_AUDIT_ENTRY_BYTES,
            "entry serialised to {} bytes, over the ceiling: {serialized}",
            serialized.len()
        );
    }

    #[tokio::test]
    async fn a_refused_settings_write_is_recorded_too() {
        let (_directory, config, storage) = settings_store();
        let refusal = update_preferences_with(
            &config,
            &storage,
            prefs(&[("theme", json!("dark")), ("not_a_preference", json!(1))]),
        )
        .await
        .expect_err("an unknown field is refused");
        assert!(refusal.contains("unknown field"), "{refusal}");

        let entries = log(&storage).await;
        assert_eq!(entries.len(), 1, "a refusal is an entry: {entries:?}");
        assert_eq!(entries[0]["operation"], json!("preferences:update"));
        assert_eq!(
            entries[0]["outcome"],
            json!("denied"),
            "nothing reached the file"
        );
        assert_eq!(entries[0]["failure"], json!("invalid_update"));
        assert_eq!(entries[0]["requested"], json!(2));
        assert_eq!(
            entries[0]["settings"],
            json!("[\"not_a_preference\",\"theme\"]"),
            "a refusal names what it was asked to write, since it changed nothing"
        );
        assert!(
            entries[0].get("changes").is_none(),
            "no change set, because there was no change"
        );

        // The other half: a save refused on its own size, before the merge.
        update_preferences_with(
            &config,
            &storage,
            prefs(&[("last_zone", json!("z".repeat(2 * 1024 * 1024)))]),
        )
        .await
        .expect_err("an oversized save is refused");

        let entries = log(&storage).await;
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1]["outcome"], json!("denied"));
        assert_eq!(entries[1]["failure"], json!("oversize"));
        assert!(
            entries[1].to_string().len() <= bc_storage::audit::MAX_AUDIT_ENTRY_BYTES,
            "a refusal handed two megabytes still fits: {}",
            entries[1]
        );
    }

    #[tokio::test]
    async fn erasing_the_trail_leaves_a_mark_in_the_trail() {
        let storage = Storage::new(false);
        for index in 0..3_u64 {
            storage.record(
                trail::user_action("dns:create", AuditOutcome::Succeeded).detail("seq", index),
            );
        }

        clear_audit_entries_with(&storage)
            .await
            .expect("clearing an existing log succeeds");

        let entries = log(&storage).await;
        assert_eq!(
            entries.len(),
            1,
            "the erasure is the only thing left: {entries:?}"
        );
        assert_eq!(entries[0]["operation"], serde_json::json!("audit:clear"));
        assert_eq!(entries[0]["actor"], serde_json::json!("user"));
        assert_eq!(entries[0]["outcome"], serde_json::json!("succeeded"));
        assert_eq!(
            entries[0]["entries"],
            serde_json::json!(3),
            "a reader has to be able to see how much is no longer there"
        );
    }

    #[tokio::test]
    async fn an_export_records_its_shape_and_not_the_path_it_was_written_to() {
        let storage = Storage::new(false);
        record_export(&storage, "audit:save", "csv", 42, Some("downloads"));

        let entries = log(&storage).await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["operation"], serde_json::json!("audit:save"));
        assert_eq!(entries[0]["format"], serde_json::json!("csv"));
        assert_eq!(entries[0]["entries"], serde_json::json!(42));
        assert_eq!(entries[0]["destination"], serde_json::json!("downloads"));

        // A folder preset, never a path: a path carries the account name and
        // the entry does not need it to be useful.
        record_export(&storage, "audit:export", "json", 0, None);
        let entries = log(&storage).await;
        assert!(
            entries[1].get("destination").is_none(),
            "an in-app export has no destination to name"
        );
    }
}
