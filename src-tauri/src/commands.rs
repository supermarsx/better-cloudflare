use base64::Engine;
use chrono::Utc;
use tauri::{AppHandle, State};

use crate::cloudflare_api::{CloudflareClient, DNSRecord, DNSRecordInput, Zone};
use crate::crypto::{CryptoManager, EncryptionConfig};
use crate::passkey::PasskeyManager;
use crate::storage::{ApiKey, Preferences, Storage};

// ─── Helpers ────────────────────────────────────────────────────────────────

fn serialize_audit_entries(
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
                vec![escape(timestamp), escape(operation), escape(resource), escape(&detail_str)]
                    .join(","),
            );
        }
        return Ok(rows.join("\n"));
    }
    Err("Unsupported format".to_string())
}

fn resolve_export_directory(
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

async fn log_audit(storage: &Storage, entry: serde_json::Value) {
    let mut entry = entry;
    if let serde_json::Value::Object(ref mut map) = entry {
        map.entry("timestamp".to_string())
            .or_insert_with(|| serde_json::Value::String(Utc::now().to_rfc3339()));
    }
    let _ = storage.add_audit_entry(entry).await;
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

// ─── Authentication & Key Management ────────────────────────────────────────

#[tauri::command]
pub async fn verify_token(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
) -> Result<bool, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    match client.verify_token().await {
        Ok(ok) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "auth:verify_token",
                    "resource": "api_token",
                    "success": ok
                }),
            )
            .await;
            Ok(ok)
        }
        Err(err) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "auth:verify_token",
                    "resource": "api_token",
                    "success": false,
                    "error": err.to_string()
                }),
            )
            .await;
            Err(err.to_string())
        }
    }
}

#[tauri::command]
pub async fn get_api_keys(storage: State<'_, Storage>) -> Result<Vec<ApiKey>, String> {
    storage.get_api_keys().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_api_key(
    storage: State<'_, Storage>,
    label: String,
    api_key: String,
    email: Option<String>,
    password: String,
) -> Result<String, String> {
    let config = match storage.get_encryption_settings().await {
        Ok(config) => config,
        Err(bc_storage::StorageError::NotFound) => CryptoManager::default().get_config(),
        Err(e) => return Err(e.to_string()),
    };
    let crypto = CryptoManager::new(config.clone());
    let encrypted = crypto.encrypt(&api_key, &password).map_err(|e| e.to_string())?;

    let id = storage
        .add_api_key(label.clone(), encrypted, email.clone(), config)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "api_key:add",
            "resource": id,
            "label": label,
            "email": email,
        }),
    )
    .await;
    Ok(id)
}

#[tauri::command]
pub async fn update_api_key(
    storage: State<'_, Storage>,
    id: String,
    label: Option<String>,
    email: Option<String>,
    current_password: Option<String>,
    new_password: Option<String>,
) -> Result<(), String> {
    let mut encrypted_key: Option<String> = None;
    let mut iterations: Option<u32> = None;
    let mut key_length: Option<usize> = None;
    let mut algorithm: Option<String> = None;
    if let Some(new_password) = new_password {
        let current_password = current_password.ok_or("Current password required")?;
        let existing = storage.get_api_key(&id).await.map_err(|e| e.to_string())?;
        let crypto = CryptoManager::new(EncryptionConfig {
            iterations: existing.iterations,
            key_length: existing.key_length,
            algorithm: existing.algorithm.clone(),
        });
        let decrypted = crypto
            .decrypt(&existing.encrypted_key, &current_password)
            .map_err(|e| e.to_string())?;
        let updated_config = match storage.get_encryption_settings().await {
            Ok(config) => config,
            Err(bc_storage::StorageError::NotFound) => crypto.get_config(),
            Err(e) => return Err(e.to_string()),
        };
        let updated_crypto = CryptoManager::new(updated_config.clone());
        encrypted_key = Some(
            updated_crypto
                .encrypt(&decrypted, &new_password)
                .map_err(|e| e.to_string())?,
        );
        iterations = Some(updated_config.iterations);
        key_length = Some(updated_config.key_length);
        algorithm = Some(updated_config.algorithm);
    }
    storage
        .update_api_key(
            id.clone(),
            label.clone(),
            email.clone(),
            encrypted_key,
            iterations,
            key_length,
            algorithm,
        )
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "api_key:update",
            "resource": id,
            "label": label,
            "email": email,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn delete_api_key(storage: State<'_, Storage>, id: String) -> Result<(), String> {
    storage
        .delete_api_key(id.clone())
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "api_key:delete",
            "resource": id,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn decrypt_api_key(
    storage: State<'_, Storage>,
    id: String,
    password: String,
) -> Result<String, String> {
    let encrypted = storage.get_api_key(&id).await.map_err(|e| e.to_string())?;
    let crypto = CryptoManager::new(EncryptionConfig {
        iterations: encrypted.iterations,
        key_length: encrypted.key_length,
        algorithm: encrypted.algorithm,
    });
    match crypto.decrypt(&encrypted.encrypted_key, &password) {
        Ok(value) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "auth:decrypt_api_key",
                    "resource": id,
                    "success": true
                }),
            )
            .await;
            Ok(value)
        }
        Err(err) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "auth:decrypt_api_key",
                    "resource": id,
                    "success": false,
                    "error": err.to_string()
                }),
            )
            .await;
            Err(err.to_string())
        }
    }
}

// ─── DNS Operations ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_zones(api_key: String, email: Option<String>) -> Result<Vec<Zone>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client.get_zones().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_dns_records(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<Vec<DNSRecord>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_dns_records(&zone_id, page, per_page)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_dns_record(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record: DNSRecordInput,
) -> Result<DNSRecord, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = client
        .create_dns_record(&zone_id, record)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:create",
            "resource": created.id.clone().unwrap_or_default(),
            "zone_id": zone_id,
            "record_type": created.r#type,
            "record_name": created.name,
        }),
    )
    .await;
    Ok(created)
}

#[tauri::command]
pub async fn update_dns_record(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_id: String,
    record: DNSRecordInput,
) -> Result<DNSRecord, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let updated = client
        .update_dns_record(&zone_id, &record_id, record)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:update",
            "resource": record_id,
            "zone_id": zone_id,
            "record_type": updated.r#type,
            "record_name": updated.name,
        }),
    )
    .await;
    Ok(updated)
}

#[tauri::command]
pub async fn delete_dns_record(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_id: String,
) -> Result<(), String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .delete_dns_record(&zone_id, &record_id)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:delete",
            "resource": record_id,
            "zone_id": zone_id,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn create_bulk_dns_records(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    records: Vec<DNSRecordInput>,
    dryrun: Option<bool>,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .create_bulk_dns_records(&zone_id, records, dryrun.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:bulk_create",
            "resource": zone_id,
            "dry_run": dryrun.unwrap_or(false),
            "created": result.get("created").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
            "skipped": result.get("skipped").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
        }),
    )
    .await;
    Ok(result)
}

#[tauri::command]
pub async fn export_dns_records(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    format: String,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<String, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let data = client
        .export_dns_records(&zone_id, &format, page, per_page)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:export",
            "resource": zone_id,
            "format": format,
            "page": page,
            "per_page": per_page,
        }),
    )
    .await;
    Ok(data)
}

#[tauri::command]
pub async fn purge_cache(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    purge_everything: bool,
    files: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .purge_cache(&zone_id, purge_everything, files.clone())
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "cache:purge",
            "resource": zone_id,
            "purge_everything": purge_everything,
            "files_count": files.as_ref().map(|v| v.len()).unwrap_or(0),
        }),
    )
    .await;
    Ok(result)
}

#[tauri::command]
pub async fn get_zone_setting(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    setting_id: String,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_zone_setting(&zone_id, &setting_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_zone_setting(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    setting_id: String,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .update_zone_setting(&zone_id, &setting_id, value.clone())
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "zone_setting:update",
            "resource": setting_id,
            "zone_id": zone_id,
            "value": value,
        }),
    )
    .await;
    Ok(result)
}

#[tauri::command]
pub async fn get_dnssec(
    api_key: String,
    email: Option<String>,
    zone_id: String,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client.get_dnssec(&zone_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_dnssec(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .update_dnssec(&zone_id, payload.clone())
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dnssec:update",
            "resource": zone_id,
            "payload": payload,
        }),
    )
    .await;
    Ok(result)
}

// ─── Vault Operations ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn store_vault_secret(
    storage: State<'_, Storage>,
    id: String,
    secret: String,
) -> Result<(), String> {
    storage
        .store_vault_secret(&id, &secret)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "vault:store",
            "resource": id,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn get_vault_secret(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    token: Option<String>,
) -> Result<String, String> {
    let token = token.ok_or("Passkey token required")?;
    let ok = passkey_mgr
        .verify_token(&id, &token, true)
        .await
        .map_err(|e| e.to_string())?;
    if !ok {
        return Err("Invalid passkey token".to_string());
    }
    storage
        .get_vault_secret(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_vault_secret(storage: State<'_, Storage>, id: String) -> Result<(), String> {
    storage
        .delete_vault_secret(&id)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "vault:delete",
            "resource": id,
        }),
    )
    .await;
    Ok(())
}

// ─── Passkey Operations ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_passkey_registration_options(
    _storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
) -> Result<serde_json::Value, String> {
    passkey_mgr
        .get_registration_options(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_passkey(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    attestation: serde_json::Value,
) -> Result<(), String> {
    passkey_mgr
        .register_passkey(&storage, &id, attestation)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "passkey:register",
            "resource": id,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn get_passkey_auth_options(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
) -> Result<serde_json::Value, String> {
    passkey_mgr
        .get_auth_options(&storage, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn authenticate_passkey(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    assertion: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match passkey_mgr
        .authenticate_passkey(&storage, &id, assertion)
        .await
    {
        Ok(result) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "passkey:authenticate",
                    "resource": id,
                    "success": true
                }),
            )
            .await;
            Ok(result)
        }
        Err(err) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "passkey:authenticate",
                    "resource": id,
                    "success": false,
                    "error": err.to_string()
                }),
            )
            .await;
            Err(err.to_string())
        }
    }
}

#[tauri::command]
pub async fn list_passkeys(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
) -> Result<Vec<serde_json::Value>, String> {
    passkey_mgr
        .list_passkeys(&storage, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_passkey(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    credential_id: String,
) -> Result<(), String> {
    passkey_mgr
        .delete_passkey(&storage, &id, &credential_id)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "passkey:delete",
            "resource": id,
            "credential_id": credential_id,
        }),
    )
    .await;
    Ok(())
}

// ─── Encryption Settings ────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_encryption_settings(
    storage: State<'_, Storage>,
) -> Result<EncryptionConfig, String> {
    match storage.get_encryption_settings().await {
        Ok(config) => Ok(config),
        Err(bc_storage::StorageError::NotFound) => Ok(CryptoManager::default().get_config()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn update_encryption_settings(
    storage: State<'_, Storage>,
    config: EncryptionConfig,
) -> Result<(), String> {
    storage
        .set_encryption_settings(&config)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "encryption:update",
            "resource": "encryption_settings",
            "iterations": config.iterations,
            "key_length": config.key_length,
            "algorithm": config.algorithm,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn benchmark_encryption(iterations: u32) -> Result<f64, String> {
    let crypto = CryptoManager::default();
    crypto.benchmark(iterations).await.map_err(|e| e.to_string())
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

// ─── SPF ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn simulate_spf(
    domain: String,
    ip: String,
) -> Result<bc_spf::SPFSimulation, String> {
    bc_spf::simulate_spf(&domain, &ip).await
}

#[tauri::command]
pub async fn spf_graph(domain: String) -> Result<bc_spf::SPFGraph, String> {
    bc_spf::build_spf_graph(&domain).await
}

// ─── Topology ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn resolve_topology_batch(
    hostnames: Vec<String>,
    max_hops: Option<u8>,
    service_hosts: Option<Vec<String>>,
    doh_provider: Option<String>,
    doh_custom_url: Option<String>,
    resolver_mode: Option<String>,
    dns_server: Option<String>,
    custom_dns_server: Option<String>,
    lookup_timeout_ms: Option<u32>,
    disable_ptr_lookups: Option<bool>,
    disable_geo_lookups: Option<bool>,
    geo_provider: Option<String>,
    scan_resolution_chain: Option<bool>,
    tcp_service_ports: Option<Vec<u16>>,
) -> Result<bc_topology::TopologyBatchResult, String> {
    bc_topology::resolve_topology_batch(
        hostnames,
        max_hops,
        service_hosts,
        doh_provider,
        doh_custom_url,
        resolver_mode,
        dns_server,
        custom_dns_server,
        lookup_timeout_ms,
        disable_ptr_lookups,
        disable_geo_lookups,
        geo_provider,
        scan_resolution_chain,
        tcp_service_ports,
    )
    .await
}

// ─── DNS Tools ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn parse_csv_records(text: String) -> Vec<bc_dns_tools::PartialDNSRecord> {
    bc_dns_tools::parse_csv_records(&text)
}

#[tauri::command]
pub fn parse_bind_zone(text: String) -> Vec<bc_dns_tools::PartialDNSRecord> {
    bc_dns_tools::parse_bind_zone(&text)
}

#[tauri::command]
pub fn validate_dns_record(
    input: bc_dns_tools::DNSRecordValidationInput,
) -> bc_dns_tools::ValidationResult {
    bc_dns_tools::validate_dns_record(&input)
}

#[tauri::command]
pub fn parse_srv(content: String) -> bc_dns_tools::SRVFields {
    bc_dns_tools::parse_srv(&content)
}

#[tauri::command]
pub fn compose_srv(
    priority: Option<u16>,
    weight: Option<u16>,
    port: Option<u16>,
    target: String,
) -> String {
    bc_dns_tools::compose_srv(priority, weight, port, &target)
}

#[tauri::command]
pub fn parse_tlsa(content: String) -> bc_dns_tools::TLSAFields {
    bc_dns_tools::parse_tlsa(&content)
}

#[tauri::command]
pub fn compose_tlsa(
    usage: Option<u8>,
    selector: Option<u8>,
    matching_type: Option<u8>,
    data: String,
) -> String {
    bc_dns_tools::compose_tlsa(usage, selector, matching_type, &data)
}

#[tauri::command]
pub fn parse_sshfp(content: String) -> bc_dns_tools::SSHFPFields {
    bc_dns_tools::parse_sshfp(&content)
}

#[tauri::command]
pub fn compose_sshfp(algorithm: Option<u8>, fptype: Option<u8>, fingerprint: String) -> String {
    bc_dns_tools::compose_sshfp(algorithm, fptype, &fingerprint)
}

#[tauri::command]
pub fn parse_naptr(content: String) -> bc_dns_tools::NAPTRFields {
    bc_dns_tools::parse_naptr(&content)
}

#[tauri::command]
pub fn compose_naptr(
    order: Option<u16>,
    preference: Option<u16>,
    flags: String,
    service: String,
    regexp: String,
    replacement: String,
) -> String {
    bc_dns_tools::compose_naptr(order, preference, &flags, &service, &regexp, &replacement)
}

#[tauri::command]
pub fn records_to_csv(records: Vec<DNSRecord>) -> String {
    bc_dns_tools::records_to_csv(&records)
}

#[tauri::command]
pub fn records_to_bind(records: Vec<DNSRecord>) -> String {
    bc_dns_tools::records_to_bind(&records)
}

#[tauri::command]
pub fn records_to_json(records: Vec<DNSRecord>) -> String {
    bc_dns_tools::records_to_json(&records)
}

#[tauri::command]
pub fn parse_spf(content: String) -> Option<bc_spf::SPFRecord> {
    bc_spf::parse_spf(&content)
}