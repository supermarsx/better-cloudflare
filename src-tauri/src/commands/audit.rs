use base64::Engine;
use chrono::Utc;
use tauri::{AppHandle, State};

use crate::storage::{Preferences, Storage};

use super::{resolve_export_directory, serialize_audit_entries};

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
    let entries = storage.get_audit_entries().await.map_err(|e| e.to_string())?;
    let fmt = format.unwrap_or_else(|| "json".to_string());
    serialize_audit_entries(entries, &fmt)
}

#[tauri::command]
pub async fn save_audit_entries(
    storage: State<'_, Storage>,
    format: Option<String>,
    folder_preset: Option<String>,
    custom_path: Option<String>,
    skip_destination_confirm: Option<bool>,
) -> Result<String, String> {
    let entries = storage.get_audit_entries().await.map_err(|e| e.to_string())?;
    let fmt = format.unwrap_or_else(|| "json".to_string()).to_lowercase();
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
        return Err("Save cancelled".to_string());
    };
    std::fs::write(&path, payload).map_err(|e| e.to_string())?;
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
    } else if base_name.to_lowercase().ends_with(&format!(".{}", extension)) {
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

#[tauri::command]
pub async fn clear_audit_entries(storage: State<'_, Storage>) -> Result<(), String> {
    storage
        .clear_audit_entries()
        .await
        .map_err(|e| e.to_string())
}

// ─── Preferences ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_preferences(storage: State<'_, Storage>) -> Result<Preferences, String> {
    storage.get_preferences().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_preferences(
    storage: State<'_, Storage>,
    prefs: Preferences,
) -> Result<(), String> {
    storage
        .set_preferences(&prefs)
        .await
        .map_err(|e| e.to_string())
}
