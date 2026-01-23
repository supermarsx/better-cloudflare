use keyring::Entry;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use thiserror::Error;

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
    ) -> Result<String, StorageError> {
        let mut keys = self.get_api_keys().await?;
        let id = format!("key_{}", uuid::Uuid::new_v4());
        
        keys.push(crate::commands::ApiKey {
            id: id.clone(),
            label,
            email,
            encrypted_key,
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

    pub async fn update_api_key(
        &self,
        id: String,
        label: Option<String>,
        email: Option<String>,
        _current_password: Option<String>,
        _new_password: Option<String>,
    ) -> Result<(), StorageError> {
        let mut keys = self.get_api_keys().await?;
        
        if let Some(key) = keys.iter_mut().find(|k| k.id == id) {
            if let Some(label) = label {
                key.label = label;
            }
            if let Some(email) = email {
                key.email = Some(email);
            }
            // Note: Password re-encryption would need to be handled by the caller
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
}
