use serde::{Deserialize, Serialize};
use tauri::State;
use crate::storage::Storage;
use crate::cloudflare_api::CloudflareClient;
use crate::crypto::{CryptoManager, EncryptionConfig};
use crate::passkey::PasskeyManager;
use crate::spf;

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: String,
    pub label: String,
    pub email: Option<String>,
    pub encrypted_key: String,
    pub iterations: u32,
    pub key_length: usize,
    pub algorithm: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    pub status: String,
    pub paused: bool,
    pub r#type: String,
    pub development_mode: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DNSRecord {
    pub id: Option<String>,
    pub r#type: String,
    pub name: String,
    pub content: String,
    pub ttl: Option<u32>,
    pub priority: Option<u16>,
    pub proxied: Option<bool>,
    pub zone_id: String,
    pub zone_name: String,
    pub created_on: String,
    pub modified_on: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DNSRecordInput {
    pub r#type: String,
    pub name: String,
    pub content: String,
    pub ttl: Option<u32>,
    pub priority: Option<u16>,
    pub proxied: Option<bool>,
}

// Authentication & Key Management
#[tauri::command]
pub async fn verify_token(api_key: String, email: Option<String>) -> Result<bool, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client.verify_token().await
        .map_err(|e| e.to_string())
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
    
    storage.add_api_key(label, encrypted, email, config).await
        .map_err(|e| e.to_string())
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
        .update_api_key(id, label, email, encrypted_key, iterations, key_length, algorithm)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_api_key(storage: State<'_, Storage>, id: String) -> Result<(), String> {
    storage.delete_api_key(id).await
        .map_err(|e| e.to_string())
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
    crypto.decrypt(&encrypted.encrypted_key, &password)
        .map_err(|e| e.to_string())
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
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record: DNSRecordInput,
) -> Result<DNSRecord, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client.create_dns_record(&zone_id, record).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_dns_record(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_id: String,
    record: DNSRecordInput,
) -> Result<DNSRecord, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client.update_dns_record(&zone_id, &record_id, record).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_dns_record(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_id: String,
) -> Result<(), String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client.delete_dns_record(&zone_id, &record_id).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_bulk_dns_records(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    records: Vec<DNSRecordInput>,
    dryrun: Option<bool>,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .create_bulk_dns_records(&zone_id, records, dryrun.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_dns_records(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    format: String,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<String, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .export_dns_records(&zone_id, &format, page, per_page)
        .await
        .map_err(|e| e.to_string())
}

// Vault Operations
#[tauri::command]
pub async fn store_vault_secret(
    storage: State<'_, Storage>,
    id: String,
    secret: String,
) -> Result<(), String> {
    storage.store_vault_secret(&id, &secret).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_vault_secret(
    storage: State<'_, Storage>,
    id: String,
) -> Result<String, String> {
    storage.get_vault_secret(&id).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_vault_secret(
    storage: State<'_, Storage>,
    id: String,
) -> Result<(), String> {
    storage.delete_vault_secret(&id).await
        .map_err(|e| e.to_string())
}

// Passkey Operations
#[tauri::command]
pub async fn get_passkey_registration_options(
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
) -> Result<serde_json::Value, String> {
    passkey_mgr.get_registration_options(&id).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_passkey(
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    attestation: serde_json::Value,
) -> Result<(), String> {
    passkey_mgr.register_passkey(&id, attestation).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_passkey_auth_options(
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
) -> Result<serde_json::Value, String> {
    passkey_mgr.get_auth_options(&id).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn authenticate_passkey(
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    assertion: serde_json::Value,
) -> Result<serde_json::Value, String> {
    passkey_mgr.authenticate_passkey(&id, assertion).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_passkeys(
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
) -> Result<Vec<serde_json::Value>, String> {
    passkey_mgr.list_passkeys(&id).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_passkey(
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    credential_id: String,
) -> Result<(), String> {
    passkey_mgr.delete_passkey(&id, &credential_id).await
        .map_err(|e| e.to_string())
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
        .map_err(|e| e.to_string())
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

// SPF
#[tauri::command]
pub async fn simulate_spf(domain: String, ip: String) -> Result<spf::SPFSimulation, String> {
    spf::simulate_spf(&domain, &ip).await
}

#[tauri::command]
pub async fn spf_graph(domain: String) -> Result<spf::SPFGraph, String> {
    spf::build_spf_graph(&domain).await
}
