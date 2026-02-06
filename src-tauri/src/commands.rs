use serde::{Deserialize, Serialize};
use chrono::Utc;
use tauri::{AppHandle, State};
use std::collections::HashSet;
use std::time::Duration;
use std::net::IpAddr;
use reqwest::redirect::Policy;
use trust_dns_resolver::TokioAsyncResolver;
use trust_dns_resolver::config::{ResolverConfig, ResolverOpts};
use crate::storage::{Preferences, Storage};
use crate::cloudflare_api::CloudflareClient;
use crate::crypto::{CryptoManager, EncryptionConfig};
use crate::passkey::PasskeyManager;
use crate::spf;

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
    #[cfg(all(unix, not(target_os = "macos")))]
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

async fn log_audit(storage: &Storage, entry: serde_json::Value) {
    let mut entry = entry;
    if let serde_json::Value::Object(ref mut map) = entry {
        map.entry("timestamp".to_string())
            .or_insert_with(|| serde_json::Value::String(Utc::now().to_rfc3339()));
    }
    let _ = storage.add_audit_entry(entry).await;
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: String,
    pub label: String,
    pub email: Option<String>,
    pub encrypted_key: String,
    #[serde(default = "default_iterations")]
    pub iterations: u32,
    #[serde(default = "default_key_length")]
    pub key_length: usize,
    #[serde(default = "default_algorithm")]
    pub algorithm: String,
}

fn default_iterations() -> u32 {
    EncryptionConfig::default().iterations
}

fn default_key_length() -> usize {
    EncryptionConfig::default().key_length
}

fn default_algorithm() -> String {
    EncryptionConfig::default().algorithm
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub name_servers: Vec<String>,
    pub status: String,
    pub paused: bool,
    pub r#type: String,
    pub development_mode: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DNSRecord {
    pub id: Option<String>,
    pub r#type: String,
    pub name: String,
    pub content: String,
    pub comment: Option<String>,
    pub ttl: Option<u32>,
    pub priority: Option<u16>,
    pub proxied: Option<bool>,
    pub zone_id: String,
    pub zone_name: String,
    pub created_on: String,
    pub modified_on: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DNSRecordPage {
    pub records: Vec<DNSRecord>,
    pub page: u32,
    pub per_page: u32,
    pub total_count: u32,
    pub total_pages: u32,
    pub cached: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CacheControl {
    pub mode: Option<String>,
    pub ttl_seconds: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DNSRecordInput {
    pub r#type: String,
    pub name: String,
    pub content: String,
    pub comment: Option<String>,
    pub ttl: Option<u32>,
    pub priority: Option<u16>,
    pub proxied: Option<bool>,
}

// Authentication & Key Management
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
    storage.get_api_keys().await
        .map_err(|e| e.to_string())
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
        Err(crate::storage::StorageError::NotFound) => CryptoManager::default().get_config(),
        Err(e) => return Err(e.to_string()),
    };
    let crypto = CryptoManager::new(config.clone());
    let encrypted = crypto.encrypt(&api_key, &password)
        .map_err(|e| e.to_string())?;
    
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
            Err(crate::storage::StorageError::NotFound) => crypto.get_config(),
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
        .update_api_key(id.clone(), label.clone(), email.clone(), encrypted_key, iterations, key_length, algorithm)
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
    storage.delete_api_key(id.clone()).await
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
    let encrypted = storage.get_api_key(&id).await
        .map_err(|e| e.to_string())?;
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

// DNS Operations
#[tauri::command]
pub async fn get_zones(api_key: String, email: Option<String>) -> Result<Vec<Zone>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client.get_zones().await
        .map_err(|e| e.to_string())
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
    client.get_dns_records(&zone_id, page, per_page).await
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
    let created = client.create_dns_record(&zone_id, record).await
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
    let updated = client.update_dns_record(&zone_id, &record_id, record).await
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
    client.delete_dns_record(&zone_id, &record_id).await
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
    client
        .get_dnssec(&zone_id)
        .await
        .map_err(|e| e.to_string())
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

// Vault Operations
#[tauri::command]
pub async fn store_vault_secret(
    storage: State<'_, Storage>,
    id: String,
    secret: String,
) -> Result<(), String> {
    storage.store_vault_secret(&id, &secret).await
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
    storage.get_vault_secret(&id).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_vault_secret(
    storage: State<'_, Storage>,
    id: String,
) -> Result<(), String> {
    storage.delete_vault_secret(&id).await
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

// Passkey Operations
#[tauri::command]
pub async fn get_passkey_registration_options(
    _storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
) -> Result<serde_json::Value, String> {
    passkey_mgr.get_registration_options(&id).await
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

// Encryption Settings
#[tauri::command]
pub async fn get_encryption_settings(
    storage: State<'_, Storage>,
) -> Result<EncryptionConfig, String> {
    match storage.get_encryption_settings().await {
        Ok(config) => Ok(config),
        Err(crate::storage::StorageError::NotFound) => Ok(CryptoManager::default().get_config()),
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
    crypto.benchmark(iterations).await
        .map_err(|e| e.to_string())
}

// Audit
#[tauri::command]
pub async fn get_audit_entries(storage: State<'_, Storage>) -> Result<Vec<serde_json::Value>, String> {
    storage.get_audit_entries().await
        .map_err(|e| e.to_string())
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
    if let Some(dir) = resolve_export_directory(
        folder_preset.as_deref(),
        custom_path.as_deref(),
    ) {
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
pub async fn clear_audit_entries(storage: State<'_, Storage>) -> Result<(), String> {
    storage
        .clear_audit_entries()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_preferences(
    storage: State<'_, Storage>,
) -> Result<Preferences, String> {
    storage.get_preferences().await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_preferences(
    storage: State<'_, Storage>,
    prefs: Preferences,
) -> Result<(), String> {
    storage.set_preferences(&prefs).await
        .map_err(|e| e.to_string())
}

// SPF
#[tauri::command]
pub async fn simulate_spf(domain: String, ip: String) -> Result<spf::SPFSimulation, String> {
    spf::simulate_spf(&domain, &ip).await
}

#[tauri::command]
pub async fn spf_graph(domain: String) -> Result<spf::SPFGraph, String> {
    spf::build_spf_graph(&domain).await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HostnameChainResult {
    pub name: String,
    pub chain: Vec<String>,
    pub terminal: String,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
    pub reverse_hostnames: Vec<ReverseHostnameResult>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReverseHostnameResult {
    pub ip: String,
    pub hostnames: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ServiceProbeResult {
    pub host: String,
    pub https_up: bool,
    pub http_up: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TopologyBatchResult {
    pub resolutions: Vec<HostnameChainResult>,
    pub probes: Vec<ServiceProbeResult>,
}

fn normalize_domain(input: &str) -> String {
    input.trim().trim_end_matches('.').to_lowercase()
}

#[derive(Debug, Deserialize)]
struct DnsGoogleAnswer {
    data: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DnsGoogleResponse {
    #[serde(rename = "Answer")]
    answer: Option<Vec<DnsGoogleAnswer>>,
}

async fn query_doh_records(
    client: &reqwest::Client,
    doh_endpoint: &str,
    name: &str,
    record_type: &str,
) -> Vec<String> {
    let Ok(resp) = client
        .get(doh_endpoint)
        .header("accept", "application/dns-json")
        .query(&[("name", name), ("type", record_type)])
        .send()
        .await
    else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(payload) = resp.json::<DnsGoogleResponse>().await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ans in payload.answer.unwrap_or_default() {
        let raw = ans.data.unwrap_or_default().trim().to_string();
        if raw.is_empty() {
            continue;
        }
        let value = if record_type == "CNAME" {
            normalize_domain(&raw)
        } else {
            raw
        };
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

async fn resolve_chain_for_host(
    resolver: &TokioAsyncResolver,
    client: &reqwest::Client,
    doh_endpoint: &str,
    host: &str,
    max_hops: usize,
) -> HostnameChainResult {
    let name = normalize_domain(host);
    if name.is_empty() {
        return HostnameChainResult {
            name,
            chain: Vec::new(),
            terminal: String::new(),
            ipv4: Vec::new(),
            ipv6: Vec::new(),
            reverse_hostnames: Vec::new(),
            error: Some("empty hostname".to_string()),
        };
    }

    let mut chain = vec![name.clone()];
    let mut seen = HashSet::new();
    seen.insert(name.clone());
    let mut cur = name.clone();

    for _ in 0..max_hops {
        let cname_lookup = resolver.lookup(cur.clone(), trust_dns_resolver::proto::rr::RecordType::CNAME).await;
        let direct_next = match cname_lookup {
            Ok(lookup) => lookup
                .iter()
                .next()
                .map(|r| normalize_domain(&r.to_string()))
                .filter(|s| !s.is_empty()),
            Err(_) => None,
        };
        let next = if direct_next.is_some() {
            direct_next
        } else {
            query_doh_records(client, doh_endpoint, &cur, "CNAME")
                .await
                .into_iter()
                .next()
        };
        let Some(next_name) = next else {
            break;
        };
        if seen.contains(&next_name) {
            break;
        }
        chain.push(next_name.clone());
        seen.insert(next_name.clone());
        cur = next_name;
    }

    let mut ipv4 = Vec::new();
    if let Ok(v4) = resolver.ipv4_lookup(cur.clone()).await {
        for ip in v4.iter() {
            let v = ip.to_string();
            if !ipv4.contains(&v) {
                ipv4.push(v);
            }
        }
    }
    if ipv4.is_empty() {
        ipv4 = query_doh_records(client, doh_endpoint, &cur, "A").await;
    }

    let mut ipv6 = Vec::new();
    if let Ok(v6) = resolver.ipv6_lookup(cur.clone()).await {
        for ip in v6.iter() {
            let v = ip.to_string();
            if !ipv6.contains(&v) {
                ipv6.push(v);
            }
        }
    }
    if ipv6.is_empty() {
        ipv6 = query_doh_records(client, doh_endpoint, &cur, "AAAA").await;
    }

    let mut reverse_hostnames = Vec::new();
    let mut all_ips = Vec::new();
    all_ips.extend(ipv4.iter().cloned());
    all_ips.extend(ipv6.iter().cloned());
    for ip in all_ips {
        let Ok(parsed) = ip.parse::<IpAddr>() else {
            continue;
        };
        let mut names = Vec::new();
        if let Ok(ptr_lookup) = resolver.reverse_lookup(parsed).await {
            for name in ptr_lookup.iter() {
                let host = normalize_domain(&name.to_utf8());
                if !host.is_empty() && !names.contains(&host) {
                    names.push(host);
                }
            }
        }
        if !names.is_empty() {
            reverse_hostnames.push(ReverseHostnameResult {
                ip,
                hostnames: names,
            });
        }
    }

    let unresolved = chain.len() <= 1 && ipv4.is_empty() && ipv6.is_empty();
    HostnameChainResult {
        name,
        chain,
        terminal: cur,
        ipv4,
        ipv6,
        reverse_hostnames,
        error: if unresolved {
            Some("no CNAME/A/AAAA records found".to_string())
        } else {
            None
        },
    }
}

async fn probe_url(client: &reqwest::Client, url: String) -> bool {
    let fut = client.get(url).send();
    let resp = tokio::time::timeout(Duration::from_secs(5), fut).await;
    matches!(resp, Ok(Ok(_)))
}

fn build_dns_resolver() -> Result<TokioAsyncResolver, String> {
    match TokioAsyncResolver::tokio_from_system_conf() {
        Ok(resolver) => Ok(resolver),
        Err(_) => Ok(TokioAsyncResolver::tokio(
            ResolverConfig::cloudflare(),
            ResolverOpts::default(),
        )),
    }
}

fn resolve_doh_endpoint(provider: Option<&str>, custom_url: Option<&str>) -> String {
    let p = provider.unwrap_or("cloudflare").trim().to_lowercase();
    match p.as_str() {
        "cloudflare" => "https://cloudflare-dns.com/dns-query".to_string(),
        "quad9" => "https://dns.quad9.net:5053/dns-query".to_string(),
        "custom" => {
            let raw = custom_url.unwrap_or("").trim();
            if raw.is_empty() {
                "https://cloudflare-dns.com/dns-query".to_string()
            } else {
                raw.to_string()
            }
        }
        _ => "https://cloudflare-dns.com/dns-query".to_string(),
    }
}

#[tauri::command]
pub async fn resolve_topology_batch(
    hostnames: Vec<String>,
    max_hops: Option<u8>,
    service_hosts: Option<Vec<String>>,
    doh_provider: Option<String>,
    doh_custom_url: Option<String>,
) -> Result<TopologyBatchResult, String> {
    let max_hops = usize::from(max_hops.unwrap_or(15)).clamp(1, 15);
    let doh_endpoint = resolve_doh_endpoint(doh_provider.as_deref(), doh_custom_url.as_deref());
    let resolver = build_dns_resolver()?;
    let resolver_http_client = reqwest::Client::builder()
        .redirect(Policy::limited(4))
        .build()
        .map_err(|e| e.to_string())?;
    let mut seen_hosts = HashSet::new();
    let mut resolutions = Vec::new();

    for h in hostnames {
        let normalized = normalize_domain(&h);
        if normalized.is_empty() || !seen_hosts.insert(normalized.clone()) {
            continue;
        }
        let result = resolve_chain_for_host(
            &resolver,
            &resolver_http_client,
            &doh_endpoint,
            &normalized,
            max_hops,
        )
        .await;
        resolutions.push(result);
    }

    let mut probes = Vec::new();
    let mut seen_probe_hosts = HashSet::new();
    for host in service_hosts.unwrap_or_default() {
        let normalized = normalize_domain(&host);
        if normalized.is_empty() || !seen_probe_hosts.insert(normalized.clone()) {
            continue;
        }
        let https = probe_url(&resolver_http_client, format!("https://{}", normalized)).await;
        let http = probe_url(&resolver_http_client, format!("http://{}", normalized)).await;
        probes.push(ServiceProbeResult {
            host: normalized,
            https_up: https,
            http_up: http,
        });
    }

    Ok(TopologyBatchResult { resolutions, probes })
}
