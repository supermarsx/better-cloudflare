use keyring::Entry;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use thiserror::Error;
use crate::crypto::EncryptionConfig;

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

    pub async fn store_secret(&self, key: &str, value: &str) -> Result<(), StorageError> {
        if self.use_keyring {
            match self.get_entry(key) {
                Ok(entry) => {
                    entry.set_password(value)
                        .map_err(|e| StorageError::KeyringError(e.to_string()))?;
                    return Ok(());
                }
                Err(_) => {
                    // Fall through to memory store
                }
            }
        }

        let mut store = self.memory_store.lock()
            .map_err(|e| StorageError::Error(e.to_string()))?;
        store.insert(key.to_string(), value.to_string());
        Ok(())
    }

    pub async fn get_secret(&self, key: &str) -> Result<String, StorageError> {
        if self.use_keyring {
            if let Ok(entry) = self.get_entry(key) {
                if let Ok(password) = entry.get_password() {
                    return Ok(password);
                }
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
                let _ = entry.delete_credential();
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

    pub async fn add_audit_entry(&self, entry: Value) -> Result<(), StorageError> {
        let mut entries = self.get_audit_entries().await?;
        entries.push(entry);

        // Keep only last 1000 entries
        if entries.len() > 1000 {
            entries = entries.into_iter().skip(entries.len() - 1000).collect();
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
}
