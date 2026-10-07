use base64::Engine;
use bc_storage::{AuditOutcome, AuditTrail};
use chrono::Utc;
use serde_json::{Map, Value};
use tauri::{AppHandle, State};

use crate::app_config::AppConfigStore;
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

#[tauri::command]
pub async fn update_preferences(
    config: State<'_, AppConfigStore>,
    storage: State<'_, Storage>,
    prefs: Map<String, Value>,
) -> Result<(), String> {
    config
        .update_preferences(
            prefs,
            || storage.get_legacy_preferences(),
            || storage.delete_legacy_preferences(),
        )
        .await
        .map_err(|error| error.to_string())
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
