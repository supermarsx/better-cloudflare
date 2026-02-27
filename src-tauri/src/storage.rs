use keyring::Entry;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use thiserror::Error;
use crate::crypto::EncryptionConfig;

const KEYRING_CHUNK_MARKER: &str = "__chunked__:";
const KEYRING_MAX_VALUE_BYTES: usize = 2000;

fn parse_chunk_marker(value: &str) -> Option<usize> {
    value
        .strip_prefix(KEYRING_CHUNK_MARKER)
        .and_then(|raw| raw.parse::<usize>().ok())
}

fn split_value_for_keyring(value: &str, max_bytes: usize) -> Vec<String> {
    if value.is_empty() {
        return vec![String::new()];
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_bytes = 0usize;
    for ch in value.chars() {
        let ch_bytes = ch.len_utf8();
        if current_bytes + ch_bytes > max_bytes && !current.is_empty() {
            chunks.push(current);
            current = String::new();
            current_bytes = 0;
        }
        current.push(ch);
        current_bytes += ch_bytes;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Preferences {
    pub vault_enabled: Option<bool>,
    pub auto_refresh_interval: Option<u32>,
    pub last_zone: Option<String>,
    pub last_active_tab: Option<String>,
    pub default_per_page: Option<u32>,
    pub zone_per_page: Option<HashMap<String, u32>>,
    pub show_unsupported_record_types: Option<bool>,
    pub zone_show_unsupported_record_types: Option<HashMap<String, bool>>,
    pub confirm_delete_record: Option<bool>,
    pub zone_confirm_delete_record: Option<HashMap<String, bool>>,
    pub reopen_last_tabs: Option<bool>,
    pub reopen_zone_tabs: Option<HashMap<String, bool>>,
    pub last_open_tabs: Option<Vec<String>>,
    pub dns_table_columns: Option<Vec<String>>,
    pub zone_dns_table_columns: Option<HashMap<String, Vec<String>>>,
    pub confirm_logout: Option<bool>,
    pub idle_logout_ms: Option<u64>,
    pub confirm_window_close: Option<bool>,
    pub loading_overlay_timeout_ms: Option<u32>,
    pub audit_export_default_documents: Option<bool>,
    pub confirm_clear_audit_logs: Option<bool>,
    pub topology_resolution_max_hops: Option<u8>,
    pub topology_resolver_mode: Option<String>,
    pub topology_dns_server: Option<String>,
    pub topology_custom_dns_server: Option<String>,
    pub topology_doh_provider: Option<String>,
    pub topology_doh_custom_url: Option<String>,
    pub topology_export_folder_preset: Option<String>,
    pub topology_export_custom_path: Option<String>,
    pub topology_export_confirm_path: Option<bool>,
    pub topology_copy_actions: Option<Vec<String>>,
    pub topology_export_actions: Option<Vec<String>>,
    pub topology_disable_annotations: Option<bool>,
    pub topology_disable_full_window: Option<bool>,
    pub topology_lookup_timeout_ms: Option<u32>,
    pub topology_disable_ptr_lookups: Option<bool>,
    pub topology_disable_geo_lookups: Option<bool>,
    pub topology_geo_provider: Option<String>,
    pub topology_scan_resolution_chain: Option<bool>,
    pub topology_disable_service_discovery: Option<bool>,
    pub topology_tcp_services: Option<Vec<String>>,
    pub audit_export_folder_preset: Option<String>,
    pub audit_export_custom_path: Option<String>,
    pub audit_export_skip_destination_confirm: Option<bool>,
    pub domain_audit_categories: Option<HashMap<String, bool>>,
    pub session_settings_profiles: Option<HashMap<String, Value>>,
    pub mcp_server_enabled: Option<bool>,
    pub mcp_server_host: Option<String>,
    pub mcp_server_port: Option<u16>,
    pub mcp_enabled_tools: Option<Vec<String>>,
    pub theme: Option<String>,
    pub locale: Option<String>,
}

#[derive(Error, Debug)]
pub enum StorageError {
    #[error("Storage error: {0}")]
    Error(String),
    #[error("Not found")]
    NotFound,
    #[error("Keyring error: {0}")]
    KeyringError(String),
}

pub struct Storage {
    // In-memory fallback when keyring is unavailable
    memory_store: Mutex<HashMap<String, String>>,
    use_keyring: bool,
}

impl Default for Storage {
    fn default() -> Self {
        Self {
            memory_store: Mutex::new(HashMap::new()),
            use_keyring: true,
        }
    }
}

impl Storage {
    pub fn new(use_keyring: bool) -> Self {
        Self {
            memory_store: Mutex::new(HashMap::new()),
            use_keyring,
        }
    }

    fn get_entry(&self, key: &str) -> Result<Entry, StorageError> {
        Entry::new("better-cloudflare", key)
            .map_err(|e| StorageError::KeyringError(e.to_string()))
    }

    fn chunk_key(key: &str, index: usize) -> String {
        format!("{key}::chunk:{index}")
    }

    fn delete_chunk_entries(&self, key: &str, chunk_count: usize) {
        for idx in 0..chunk_count {
            if let Ok(entry) = self.get_entry(&Self::chunk_key(key, idx)) {
                let _ = entry.delete_password();
            }
        }
    }

    fn write_keyring_secret(&self, key: &str, value: &str) -> Result<(), StorageError> {
        let entry = self.get_entry(key)?;
        let previous_chunk_count = entry
            .get_password()
            .ok()
            .and_then(|v| parse_chunk_marker(&v))
            .unwrap_or(0);

        let chunks = split_value_for_keyring(value, KEYRING_MAX_VALUE_BYTES);
        if chunks.len() == 1 {
            entry
                .set_password(value)
                .map_err(|e| StorageError::KeyringError(e.to_string()))?;
            if previous_chunk_count > 0 {
                self.delete_chunk_entries(key, previous_chunk_count);
            }
            return Ok(());
        }

        for (idx, chunk) in chunks.iter().enumerate() {
            let chunk_entry = self.get_entry(&Self::chunk_key(key, idx))?;
            chunk_entry
                .set_password(chunk)
                .map_err(|e| StorageError::KeyringError(e.to_string()))?;
        }
        let marker = format!("{KEYRING_CHUNK_MARKER}{}", chunks.len());
        entry
            .set_password(&marker)
            .map_err(|e| StorageError::KeyringError(e.to_string()))?;
        if previous_chunk_count > chunks.len() {
            for idx in chunks.len()..previous_chunk_count {
                if let Ok(chunk_entry) = self.get_entry(&Self::chunk_key(key, idx)) {
                    let _ = chunk_entry.delete_password();
                }
            }
        }
        Ok(())
    }

    fn read_keyring_secret(&self, key: &str) -> Result<String, StorageError> {
        let entry = self.get_entry(key)?;
        let password = entry
            .get_password()
            .map_err(|e| StorageError::KeyringError(e.to_string()))?;
        if let Some(chunk_count) = parse_chunk_marker(&password) {
            let mut combined = String::new();
            for idx in 0..chunk_count {
                let chunk_entry = self.get_entry(&Self::chunk_key(key, idx))?;
                let chunk = chunk_entry
                    .get_password()
                    .map_err(|e| StorageError::KeyringError(e.to_string()))?;
                combined.push_str(&chunk);
            }
            return Ok(combined);
        }
        Ok(password)
    }

    pub async fn store_secret(&self, key: &str, value: &str) -> Result<(), StorageError> {
        if self.use_keyring {
            if self.write_keyring_secret(key, value).is_ok() {
                return Ok(());
            }
        }

        let mut store = self.memory_store.lock()
            .map_err(|e| StorageError::Error(e.to_string()))?;
        store.insert(key.to_string(), value.to_string());
        Ok(())
    }

    pub async fn get_secret(&self, key: &str) -> Result<String, StorageError> {
        if self.use_keyring {
            if let Ok(password) = self.read_keyring_secret(key) {
                return Ok(password);
            }
        }

        let store = self.memory_store.lock()
            .map_err(|e| StorageError::Error(e.to_string()))?;
        store.get(key)
            .cloned()
            .ok_or(StorageError::NotFound)
    }

    pub async fn delete_secret(&self, key: &str) -> Result<(), StorageError> {
        if self.use_keyring {
            if let Ok(entry) = self.get_entry(key) {
                let chunk_count = entry
                    .get_password()
                    .ok()
                    .and_then(|v| parse_chunk_marker(&v))
                    .unwrap_or(0);
                let _ = entry.delete_password();
                if chunk_count > 0 {
                    self.delete_chunk_entries(key, chunk_count);
                }
            }
        }

        let mut store = self.memory_store.lock()
            .map_err(|e| StorageError::Error(e.to_string()))?;
        store.remove(key);
        Ok(())
    }

    // API Key management (stored in app data directory as JSON)
    pub async fn get_api_keys(&self) -> Result<Vec<crate::commands::ApiKey>, StorageError> {
        match self.get_secret("api_keys_list").await {
            Ok(json) => {
                serde_json::from_str(&json)
                    .map_err(|e| StorageError::Error(e.to_string()))
            }
            Err(StorageError::NotFound) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    pub async fn add_api_key(
        &self,
        label: String,
        encrypted_key: String,
        email: Option<String>,
        config: EncryptionConfig,
    ) -> Result<String, StorageError> {
        let mut keys = self.get_api_keys().await?;
        let id = format!("key_{}", uuid::Uuid::new_v4());
        
        keys.push(crate::commands::ApiKey {
            id: id.clone(),
            label,
            email,
            encrypted_key,
            iterations: config.iterations,
            key_length: config.key_length,
            algorithm: config.algorithm,
        });

        let json = serde_json::to_string(&keys)
            .map_err(|e| StorageError::Error(e.to_string()))?;
        self.store_secret("api_keys_list", &json).await?;

        Ok(id)
    }

    pub async fn get_encrypted_key(&self, id: &str) -> Result<String, StorageError> {
        let keys = self.get_api_keys().await?;
        keys.iter()
            .find(|k| k.id == id)
            .map(|k| k.encrypted_key.clone())
            .ok_or(StorageError::NotFound)
    }

    pub async fn get_api_key(
        &self,
        id: &str,
    ) -> Result<crate::commands::ApiKey, StorageError> {
        let keys = self.get_api_keys().await?;
        keys.into_iter()
            .find(|k| k.id == id)
            .ok_or(StorageError::NotFound)
    }

    pub async fn update_api_key(
        &self,
        id: String,
        label: Option<String>,
        email: Option<String>,
        encrypted_key: Option<String>,
        iterations: Option<u32>,
        key_length: Option<usize>,
        algorithm: Option<String>,
    ) -> Result<(), StorageError> {
        let mut keys = self.get_api_keys().await?;
        
        if let Some(key) = keys.iter_mut().find(|k| k.id == id) {
            if let Some(label) = label {
                key.label = label;
            }
            if let Some(email) = email {
                key.email = Some(email);
            }
            if let Some(encrypted_key) = encrypted_key {
                key.encrypted_key = encrypted_key;
            }
            if let Some(iterations) = iterations {
                key.iterations = iterations;
            }
            if let Some(key_length) = key_length {
                key.key_length = key_length;
            }
            if let Some(algorithm) = algorithm {
                key.algorithm = algorithm;
            }
        } else {
            return Err(StorageError::NotFound);
        }

        let json = serde_json::to_string(&keys)
            .map_err(|e| StorageError::Error(e.to_string()))?;
        self.store_secret("api_keys_list", &json).await?;

        Ok(())
    }

    pub async fn delete_api_key(&self, id: String) -> Result<(), StorageError> {
        let mut keys = self.get_api_keys().await?;
        keys.retain(|k| k.id != id);

        let json = serde_json::to_string(&keys)
            .map_err(|e| StorageError::Error(e.to_string()))?;
        self.store_secret("api_keys_list", &json).await?;

        Ok(())
    }

    // Vault operations
    pub async fn store_vault_secret(&self, id: &str, secret: &str) -> Result<(), StorageError> {
        let key = format!("vault:{}", id);
        self.store_secret(&key, secret).await
    }

    pub async fn get_vault_secret(&self, id: &str) -> Result<String, StorageError> {
        let key = format!("vault:{}", id);
        self.get_secret(&key).await
    }

    pub async fn delete_vault_secret(&self, id: &str) -> Result<(), StorageError> {
        let key = format!("vault:{}", id);
        self.delete_secret(&key).await
    }

    // Passkey storage
    pub async fn get_passkeys(&self, id: &str) -> Result<Vec<Value>, StorageError> {
        let key = format!("passkeys:{}", id);
        match self.get_secret(&key).await {
            Ok(json) => serde_json::from_str(&json)
                .map_err(|e| StorageError::Error(e.to_string())),
            Err(StorageError::NotFound) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    pub async fn store_passkey(&self, id: &str, credential: Value) -> Result<(), StorageError> {
        let mut list = self.get_passkeys(id).await?;
        list.push(credential);
        let key = format!("passkeys:{}", id);
        let json = serde_json::to_string(&list)
            .map_err(|e| StorageError::Error(e.to_string()))?;
        self.store_secret(&key, &json).await
    }

    pub async fn delete_passkey(&self, id: &str, credential_id: &str) -> Result<(), StorageError> {
        let mut list = self.get_passkeys(id).await?;
        list.retain(|c| {
            c.get("id").and_then(|v| v.as_str()) != Some(credential_id)
                && c.get("rawId").and_then(|v| v.as_str()) != Some(credential_id)
        });
        let key = format!("passkeys:{}", id);
        if list.is_empty() {
            self.delete_secret(&key).await
        } else {
            let json = serde_json::to_string(&list)
                .map_err(|e| StorageError::Error(e.to_string()))?;
            self.store_secret(&key, &json).await
        }
    }

    // ─── Registrar credential storage ────────────────────────────────────

    pub async fn get_registrar_credentials(&self) -> Result<Vec<crate::registrar::types::RegistrarCredential>, StorageError> {
        match self.get_secret("registrar_credentials").await {
            Ok(json) => serde_json::from_str(&json)
                .map_err(|e| StorageError::Error(e.to_string())),
            Err(StorageError::NotFound) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    pub async fn get_registrar_credential(&self, id: &str) -> Result<crate::registrar::types::RegistrarCredential, StorageError> {
        let creds = self.get_registrar_credentials().await?;
        creds.into_iter()
            .find(|c| c.id == id)
            .ok_or(StorageError::NotFound)
    }

    pub async fn store_registrar_credential(&self, cred: &crate::registrar::types::RegistrarCredential) -> Result<(), StorageError> {
        let mut creds = self.get_registrar_credentials().await?;
        creds.push(cred.clone());
        let json = serde_json::to_string(&creds)
            .map_err(|e| StorageError::Error(e.to_string()))?;
        self.store_secret("registrar_credentials", &json).await
    }

    pub async fn delete_registrar_credential(&self, id: &str) -> Result<(), StorageError> {
        let mut creds = self.get_registrar_credentials().await?;
        creds.retain(|c| c.id != id);
        let json = serde_json::to_string(&creds)
            .map_err(|e| StorageError::Error(e.to_string()))?;
        self.store_secret("registrar_credentials", &json).await
    }

    pub async fn store_registrar_secrets(
        &self,
        credential_id: &str,
        secrets: &std::collections::HashMap<String, String>,
    ) -> Result<(), StorageError> {
        let key = format!("registrar_secrets:{}", credential_id);
        let json = serde_json::to_string(secrets)
            .map_err(|e| StorageError::Error(e.to_string()))?;
        self.store_secret(&key, &json).await
    }

    pub async fn get_registrar_secrets(
        &self,
        credential_id: &str,
    ) -> Result<std::collections::HashMap<String, String>, StorageError> {
        let key = format!("registrar_secrets:{}", credential_id);
        match self.get_secret(&key).await {
            Ok(json) => serde_json::from_str(&json)
                .map_err(|e| StorageError::Error(e.to_string())),
            Err(StorageError::NotFound) => Ok(std::collections::HashMap::new()),
            Err(e) => Err(e),
        }
    }

    pub async fn delete_registrar_secrets(&self, credential_id: &str) -> Result<(), StorageError> {
        let key = format!("registrar_secrets:{}", credential_id);
        self.delete_secret(&key).await
    }

    // Audit log
    pub async fn get_audit_entries(&self) -> Result<Vec<Value>, StorageError> {
        match self.get_secret("audit_log").await {
            Ok(json) => {
                serde_json::from_str(&json)
                    .map_err(|e| StorageError::Error(e.to_string()))
            }
            Err(StorageError::NotFound) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    pub async fn clear_audit_entries(&self) -> Result<(), StorageError> {
        self.delete_secret("audit_log").await
    }

    pub async fn add_audit_entry(&self, entry: Value) -> Result<(), StorageError> {
        let mut entries = self.get_audit_entries().await?;
        entries.push(entry);

        // Keep only last 1000 entries
        let len = entries.len();
        if len > 1000 {
            let skip = len - 1000;
            entries = entries.into_iter().skip(skip).collect();
        }

        let json = serde_json::to_string(&entries)
            .map_err(|e| StorageError::Error(e.to_string()))?;
        self.store_secret("audit_log", &json).await
    }

    pub async fn get_encryption_settings(&self) -> Result<EncryptionConfig, StorageError> {
        match self.get_secret("encryption_settings").await {
            Ok(json) => serde_json::from_str(&json)
                .map_err(|e| StorageError::Error(e.to_string())),
            Err(StorageError::NotFound) => Err(StorageError::NotFound),
            Err(e) => Err(e),
        }
    }

    pub async fn set_encryption_settings(
        &self,
        config: &EncryptionConfig,
    ) -> Result<(), StorageError> {
        let json = serde_json::to_string(config)
            .map_err(|e| StorageError::Error(e.to_string()))?;
        self.store_secret("encryption_settings", &json).await
    }

    pub async fn get_preferences(&self) -> Result<Preferences, StorageError> {
        match self.get_secret("preferences").await {
            Ok(json) => serde_json::from_str(&json)
                .map_err(|e| StorageError::Error(e.to_string())),
            Err(StorageError::NotFound) => Ok(Preferences {
                vault_enabled: None,
                auto_refresh_interval: None,
                last_zone: None,
                last_active_tab: None,
                default_per_page: None,
                zone_per_page: None,
                show_unsupported_record_types: None,
                zone_show_unsupported_record_types: None,
                confirm_delete_record: None,
                zone_confirm_delete_record: None,
                reopen_last_tabs: None,
                reopen_zone_tabs: None,
                last_open_tabs: None,
                dns_table_columns: None,
                zone_dns_table_columns: None,
                confirm_logout: None,
                idle_logout_ms: None,
                confirm_window_close: None,
                loading_overlay_timeout_ms: None,
                audit_export_default_documents: None,
                confirm_clear_audit_logs: None,
                topology_resolution_max_hops: None,
                topology_resolver_mode: None,
                topology_dns_server: None,
                topology_custom_dns_server: None,
                topology_doh_provider: None,
                topology_doh_custom_url: None,
                topology_export_folder_preset: None,
                topology_export_custom_path: None,
                topology_export_confirm_path: None,
                topology_copy_actions: None,
                topology_export_actions: None,
                topology_disable_annotations: None,
                topology_disable_full_window: None,
                topology_lookup_timeout_ms: None,
                topology_disable_ptr_lookups: None,
                topology_disable_geo_lookups: None,
                topology_geo_provider: None,
                topology_scan_resolution_chain: None,
                topology_disable_service_discovery: None,
                topology_tcp_services: None,
                audit_export_folder_preset: None,
                audit_export_custom_path: None,
                audit_export_skip_destination_confirm: None,
                domain_audit_categories: None,
                session_settings_profiles: None,
                mcp_server_enabled: None,
                mcp_server_host: None,
                mcp_server_port: None,
                mcp_enabled_tools: None,
                theme: None,
                locale: None,
            }),
            Err(e) => Err(e),
        }
    }

    pub async fn set_preferences(&self, prefs: &Preferences) -> Result<(), StorageError> {
        let json = serde_json::to_string(prefs)
            .map_err(|e| StorageError::Error(e.to_string()))?;
        self.store_secret("preferences", &json).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chunk_helpers_roundtrip() {
        let input = "a".repeat(KEYRING_MAX_VALUE_BYTES * 2 + 15);
        let chunks = split_value_for_keyring(&input, KEYRING_MAX_VALUE_BYTES);
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|c| c.len() <= KEYRING_MAX_VALUE_BYTES));
        assert_eq!(chunks.concat(), input);
        assert_eq!(parse_chunk_marker("__chunked__:12"), Some(12));
        assert_eq!(parse_chunk_marker("plain"), None);
    }

    #[tokio::test]
    async fn api_key_lifecycle() {
        let storage = Storage::new(false);
        let config = EncryptionConfig::default();
        let id = storage
            .add_api_key(
                "primary".to_string(),
                "enc_v1".to_string(),
                Some("user@example.com".to_string()),
                config.clone(),
            )
            .await
            .expect("add api key");

        let keys = storage.get_api_keys().await.expect("get api keys");
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].id, id);
        assert_eq!(keys[0].label, "primary");
        assert_eq!(keys[0].encrypted_key, "enc_v1");
        assert_eq!(keys[0].email.as_deref(), Some("user@example.com"));
        assert_eq!(keys[0].iterations, config.iterations);
        assert_eq!(keys[0].key_length, config.key_length);
        assert_eq!(keys[0].algorithm, config.algorithm);

        let encrypted = storage
            .get_encrypted_key(&id)
            .await
            .expect("get encrypted key");
        assert_eq!(encrypted, "enc_v1");

        storage
            .update_api_key(
                id.clone(),
                Some("updated".to_string()),
                Some("new@example.com".to_string()),
                Some("enc_v2".to_string()),
                Some(1234),
                Some(16),
                Some("AES-256-GCM".to_string()),
            )
            .await
            .expect("update api key");

        let keys = storage.get_api_keys().await.expect("get updated keys");
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].label, "updated");
        assert_eq!(keys[0].email.as_deref(), Some("new@example.com"));
        assert_eq!(keys[0].encrypted_key, "enc_v2");
        assert_eq!(keys[0].iterations, 1234);
        assert_eq!(keys[0].key_length, 16);
        assert_eq!(keys[0].algorithm, "AES-256-GCM");

        storage
            .delete_api_key(id.clone())
            .await
            .expect("delete api key");
        let keys = storage.get_api_keys().await.expect("get keys after delete");
        assert!(keys.is_empty());
        let missing = storage.get_encrypted_key(&id).await;
        assert!(matches!(missing, Err(StorageError::NotFound)));
    }

    #[tokio::test]
    async fn vault_secret_roundtrip() {
        let storage = Storage::new(false);
        storage
            .store_vault_secret("key_1", "secret")
            .await
            .expect("store vault secret");
        let secret = storage
            .get_vault_secret("key_1")
            .await
            .expect("get vault secret");
        assert_eq!(secret, "secret");
        storage
            .delete_vault_secret("key_1")
            .await
            .expect("delete vault secret");
        let missing = storage.get_vault_secret("key_1").await;
        assert!(matches!(missing, Err(StorageError::NotFound)));
    }

    #[tokio::test]
    async fn audit_log_roundtrip() {
        let storage = Storage::new(false);
        storage
            .add_audit_entry(json!({"event":"login","actor":"test"}))
            .await
            .expect("add audit entry");
        storage
            .add_audit_entry(json!({"event":"logout","actor":"test"}))
            .await
            .expect("add audit entry 2");

        let entries = storage.get_audit_entries().await.expect("get audit");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["event"], "login");
        assert_eq!(entries[1]["event"], "logout");
    }

    #[tokio::test]
    async fn audit_log_retains_last_1000() {
        let storage = Storage::new(false);
        for idx in 0..1005 {
            storage
                .add_audit_entry(json!({"event":"event","idx": idx}))
                .await
                .expect("add audit entry");
        }
        let entries = storage.get_audit_entries().await.expect("get audit");
        assert_eq!(entries.len(), 1000);
        assert_eq!(entries[0]["idx"], 5);
        assert_eq!(entries[999]["idx"], 1004);
    }

    #[tokio::test]
    async fn encryption_settings_roundtrip() {
        let storage = Storage::new(false);
        let config = EncryptionConfig {
            iterations: 42,
            key_length: 16,
            algorithm: "AES-256-GCM".to_string(),
        };
        storage
            .set_encryption_settings(&config)
            .await
            .expect("set encryption settings");
        let loaded = storage
            .get_encryption_settings()
            .await
            .expect("get encryption settings");
        assert_eq!(loaded.iterations, 42);
        assert_eq!(loaded.key_length, 16);
        assert_eq!(loaded.algorithm, "AES-256-GCM");
    }

    #[tokio::test]
    async fn passkey_storage_roundtrip() {
        let storage = Storage::new(false);
        let id = "key_passkey";
        storage
            .store_passkey(id, json!({"id":"cred_1"}))
            .await
            .expect("store passkey");
        storage
            .store_passkey(id, json!({"id":"cred_2"}))
            .await
            .expect("store passkey 2");
        let list = storage.get_passkeys(id).await.expect("get passkeys");
        assert_eq!(list.len(), 2);
        storage
            .delete_passkey(id, "cred_1")
            .await
            .expect("delete passkey");
        let list = storage.get_passkeys(id).await.expect("get passkeys after delete");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], "cred_2");
    }

    #[tokio::test]
    async fn preferences_roundtrip() {
        let storage = Storage::new(false);
        let prefs = Preferences {
            vault_enabled: Some(true),
            auto_refresh_interval: Some(60000),
            last_zone: Some("zone1".to_string()),
            last_active_tab: None,
            default_per_page: None,
            zone_per_page: None,
            show_unsupported_record_types: None,
            zone_show_unsupported_record_types: None,
            confirm_delete_record: None,
            zone_confirm_delete_record: None,
            reopen_last_tabs: None,
            reopen_zone_tabs: None,
            last_open_tabs: None,
            dns_table_columns: None,
            zone_dns_table_columns: None,
            confirm_logout: None,
            idle_logout_ms: None,
            confirm_window_close: None,
            loading_overlay_timeout_ms: None,
            audit_export_default_documents: None,
            confirm_clear_audit_logs: None,
            topology_resolution_max_hops: None,
            topology_resolver_mode: None,
            topology_dns_server: None,
            topology_custom_dns_server: None,
            topology_doh_provider: None,
            topology_doh_custom_url: None,
            topology_export_folder_preset: None,
            topology_export_custom_path: None,
            topology_export_confirm_path: None,
            topology_copy_actions: None,
            topology_export_actions: None,
            topology_disable_annotations: None,
            topology_disable_full_window: None,
            topology_lookup_timeout_ms: None,
            topology_disable_ptr_lookups: None,
            topology_disable_geo_lookups: None,
            topology_geo_provider: None,
            topology_scan_resolution_chain: None,
            topology_disable_service_discovery: None,
            topology_tcp_services: None,
            audit_export_folder_preset: None,
            audit_export_custom_path: None,
            audit_export_skip_destination_confirm: None,
            domain_audit_categories: None,
            session_settings_profiles: None,
            mcp_server_enabled: None,
            mcp_server_host: None,
            mcp_server_port: None,
            mcp_enabled_tools: None,
            theme: None,
            locale: None,
        };
        storage
            .set_preferences(&prefs)
            .await
            .expect("set preferences");
        let loaded = storage.get_preferences().await.expect("get preferences");
        assert_eq!(loaded.vault_enabled, Some(true));
        assert_eq!(loaded.auto_refresh_interval, Some(60000));
        assert_eq!(loaded.last_zone.as_deref(), Some("zone1"));
    }
}
