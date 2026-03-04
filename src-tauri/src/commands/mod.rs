use chrono::Utc;

use crate::storage::Storage;

pub mod auth;
pub mod audit;
pub mod dns;
pub mod services;

pub use auth::*;
pub use audit::*;
pub use dns::*;
pub use services::*;

// ─── Shared Helpers ─────────────────────────────────────────────────────────

pub(crate) fn serialize_audit_entries(
    entries: Vec<serde_json::Value>,
    format: &str,
) -> Result<String, String> {
    if format == "json" {
        return serde_json::to_string_pretty(&entries).map_err(|e| e.to_string());
    }
    if format == "csv" {
        let headers = ["timestamp", "operation", "resource", "details"];
        let mut rows = Vec::new();
        rows.push(headers.join(","));
        for entry in entries {
            let timestamp = entry.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
            let operation = entry.get("operation").and_then(|v| v.as_str()).unwrap_or("");
            let resource = entry.get("resource").and_then(|v| v.as_str()).unwrap_or("");
            let mut details = entry.clone();
            if let serde_json::Value::Object(ref mut map) = details {
                map.remove("timestamp");
                map.remove("operation");
                map.remove("resource");
            }
            let detail_str = serde_json::to_string(&details).unwrap_or_else(|_| "{}".to_string());
            let escape = |value: &str| format!("\"{}\"", value.replace('"', "\"\""));
            rows.push(
                [escape(timestamp), escape(operation), escape(resource), escape(&detail_str)]
                    .join(","),
            );
        }
        return Ok(rows.join("\n"));
    }
    Err("Unsupported format".to_string())
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

pub(crate) async fn log_audit(storage: &Storage, entry: serde_json::Value) {
    let mut entry = entry;
    if let serde_json::Value::Object(ref mut map) = entry {
        map.entry("timestamp".to_string())
            .or_insert_with(|| serde_json::Value::String(Utc::now().to_rfc3339()));
    }
    let _ = storage.add_audit_entry(entry).await;
}
