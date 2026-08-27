//! # bc-storage
//!
//! Secure storage layer backed by the OS keyring.
//!
//! Durable writes use immutable, versioned chunks and atomically replace a
//! small manifest pointer only after every chunk has been read back and
//! verified. Legacy direct values and stable-name chunk records remain
//! readable. In-memory storage is used only when explicitly requested through
//! [`Storage::new(false)`].
//!
//! Higher-level helpers manage API keys, vault secrets, passkey credentials,
//! audit log entries, registrar credentials, encryption settings, and user
//! preferences.

use keyring::Entry;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use thiserror::Error;

pub use bc_crypto::EncryptionConfig;

// ── Constants ───────────────────────────────────────────────────────────────

const LEGACY_CHUNK_MARKER: &str = "__chunked__:";
const CHUNK_MANIFEST_MARKER: &str = "__bc_chunks_v2__:";
const KEYRING_MAX_VALUE_BYTES: usize = 2000;
/// Hard ceiling for one logical secret, checked before chunk allocation.
const MAX_SECRET_BYTES: usize = 2_000_000;
/// Hard ceiling for one caller-visible key, checked before lock-map allocation.
const MAX_LOGICAL_KEY_BYTES: usize = 512;
/// Hard ceiling for distinct in-flight logical-key operations.
const MAX_ACTIVE_LOGICAL_LOCKS: usize = 64;
/// Hard ceiling for chunk iteration, including legacy records.
const MAX_CHUNK_COUNT: usize = 1000;
const MAX_MANIFEST_BYTES: usize = 256;
const SERVICE_NAME: &str = "better-cloudflare";
const MAX_AUDIT_ENTRIES: usize = 1000;
type LogicalLockRegistry = Mutex<HashMap<String, Weak<Mutex<()>>>>;
static LOGICAL_LOCKS: OnceLock<LogicalLockRegistry> = OnceLock::new();

/// Acquire a synchronization lock that a panic cannot invalidate.
///
/// The logical-lock registry only ever holds `Weak` handles and each logical
/// lock guards the unit value, so unwinding cannot leave either in a state a
/// later caller could observe as inconsistent. Propagating poisoning instead
/// lets one panic anywhere in the process permanently fail every subsequent
/// secure storage operation, because the process-wide registry is on the path
/// of every read, write, and delete.
fn lock_ignoring_poison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ── Chunking helpers ────────────────────────────────────────────────────────

#[derive(Clone, Debug, Eq, PartialEq)]
struct ChunkManifest {
    generation: String,
    chunk_count: usize,
    byte_len: usize,
    digest: String,
}

impl ChunkManifest {
    fn encode(&self) -> String {
        format!(
            "{CHUNK_MANIFEST_MARKER}{}:{}:{}:{}",
            self.generation, self.chunk_count, self.byte_len, self.digest
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum StoredRoot {
    Direct(String),
    LegacyChunks { chunk_count: usize },
    Manifest(ChunkManifest),
}

fn parse_decimal(raw: &str, field: &'static str) -> Result<usize, StorageError> {
    if !is_canonical_decimal(raw) {
        return Err(StorageError::CorruptData(field));
    }
    raw.parse().map_err(|_| StorageError::CorruptData(field))
}

fn is_canonical_decimal(raw: &str) -> bool {
    !raw.is_empty()
        && raw.bytes().all(|byte| byte.is_ascii_digit())
        && (raw.len() == 1 || !raw.starts_with('0'))
}

fn direct_stored_root(value: &str) -> Result<StoredRoot, StorageError> {
    if value.len() > MAX_SECRET_BYTES {
        return Err(StorageError::LimitExceeded);
    }
    Ok(StoredRoot::Direct(value.to_string()))
}

fn payload_digest(value: &str) -> String {
    // FNV-1a is used only as a deterministic corruption checksum. The secret
    // remains protected by the OS keyring; this is not a cryptographic MAC.
    let mut checksum = 0xcbf2_9ce4_8422_2325_u64;
    for byte in value.bytes() {
        checksum ^= u64::from(byte);
        checksum = checksum.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{checksum:016x}")
}

fn validate_chunk_metadata(
    chunk_count: usize,
    byte_len: Option<usize>,
) -> Result<(), StorageError> {
    if chunk_count == 0 || chunk_count > MAX_CHUNK_COUNT {
        return Err(StorageError::LimitExceeded);
    }
    if let Some(byte_len) = byte_len {
        if byte_len > MAX_SECRET_BYTES
            || byte_len > chunk_count.saturating_mul(KEYRING_MAX_VALUE_BYTES)
            || (byte_len > 0 && chunk_count > byte_len)
            || (byte_len == 0 && chunk_count != 1)
        {
            return Err(StorageError::LimitExceeded);
        }
    }
    Ok(())
}

fn parse_stored_root(value: &str) -> Result<StoredRoot, StorageError> {
    if let Some(raw_count) = value.strip_prefix(LEGACY_CHUNK_MARKER) {
        if !is_canonical_decimal(raw_count) {
            return direct_stored_root(value);
        }
        if raw_count.len() > MAX_CHUNK_COUNT.to_string().len() {
            return Err(StorageError::LimitExceeded);
        }
        let chunk_count = parse_decimal(raw_count, "invalid legacy chunk count")?;
        validate_chunk_metadata(chunk_count, None)?;
        return Ok(StoredRoot::LegacyChunks { chunk_count });
    }

    if let Some(raw_manifest) = value.strip_prefix(CHUNK_MANIFEST_MARKER) {
        let mut fields = raw_manifest.split(':');
        let candidate = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        );
        let (Some(generation), Some(raw_count), Some(raw_bytes), Some(digest), None) = candidate
        else {
            return direct_stored_root(value);
        };
        if digest.len() != 16
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !is_canonical_decimal(raw_count)
            || !is_canonical_decimal(raw_bytes)
        {
            return direct_stored_root(value);
        }

        let Ok(parsed_generation) = uuid::Uuid::parse_str(generation) else {
            return direct_stored_root(value);
        };
        if parsed_generation.to_string() != generation {
            return direct_stored_root(value);
        }
        if value.len() > MAX_MANIFEST_BYTES {
            return Err(StorageError::LimitExceeded);
        }

        let chunk_count = parse_decimal(raw_count, "invalid manifest chunk count")?;
        let byte_len = parse_decimal(raw_bytes, "invalid manifest byte length")?;
        validate_chunk_metadata(chunk_count, Some(byte_len))?;
        return Ok(StoredRoot::Manifest(ChunkManifest {
            generation: generation.to_string(),
            chunk_count,
            byte_len,
            digest: digest.to_string(),
        }));
    }

    // Exact canonical marker-shaped direct values are inherently ambiguous and
    // continue to be interpreted as metadata for backward compatibility.
    direct_stored_root(value)
}

fn next_chunk_end(value: &str, start: usize) -> Result<usize, StorageError> {
    let mut end = (start + KEYRING_MAX_VALUE_BYTES).min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    if end == start {
        return Err(StorageError::CorruptData("invalid UTF-8 chunk boundary"));
    }
    Ok(end)
}

fn utf8_aware_chunk_count(value: &str) -> Result<usize, StorageError> {
    if value.is_empty() {
        return Ok(1);
    }

    let mut chunk_count = 0_usize;
    let mut start = 0;
    while start < value.len() {
        start = next_chunk_end(value, start)?;
        chunk_count = chunk_count
            .checked_add(1)
            .ok_or(StorageError::LimitExceeded)?;
    }
    Ok(chunk_count)
}

fn split_value_for_keyring(value: &str) -> Result<Vec<String>, StorageError> {
    if value.len() > MAX_SECRET_BYTES {
        return Err(StorageError::LimitExceeded);
    }

    let chunk_count = utf8_aware_chunk_count(value)?;
    if chunk_count > MAX_CHUNK_COUNT {
        return Err(StorageError::LimitExceeded);
    }
    if value.is_empty() {
        return Ok(vec![String::new()]);
    }

    let mut chunks = Vec::with_capacity(chunk_count);
    let mut start = 0;
    while start < value.len() {
        let end = next_chunk_end(value, start)?;
        chunks.push(value[start..end].to_string());
        start = end;
    }
    Ok(chunks)
}

fn serialize_json<T: Serialize + ?Sized>(value: &T) -> Result<String, StorageError> {
    serde_json::to_string(value)
        .map_err(|_| StorageError::Error("secure storage serialization failed".to_string()))
}

fn deserialize_json<T: DeserializeOwned>(
    value: &str,
    context: &'static str,
) -> Result<T, StorageError> {
    serde_json::from_str(value).map_err(|_| StorageError::CorruptData(context))
}

fn to_json_value<T: Serialize + ?Sized>(value: &T) -> Result<Value, StorageError> {
    serde_json::to_value(value)
        .map_err(|_| StorageError::Error("secure storage serialization failed".to_string()))
}

fn from_json_value<T: DeserializeOwned>(
    value: Value,
    context: &'static str,
) -> Result<T, StorageError> {
    serde_json::from_value(value).map_err(|_| StorageError::CorruptData(context))
}

// ── API Key model ───────────────────────────────────────────────────────────

/// A stored API key with per-key encryption metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
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

// ── Preferences ─────────────────────────────────────────────────────────────

/// User preferences covering every feature area.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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
    pub close_tab_on_middle_click: Option<bool>,
    pub rewrite_copied_record_domains: Option<bool>,
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
    #[serde(default)]
    pub propagation_resolvers: Option<Vec<String>>,
    #[serde(default)]
    pub propagation_custom_resolvers: Option<Vec<String>>,
    #[serde(default)]
    pub propagation_timeout_ms: Option<u32>,
    #[serde(default)]
    pub propagation_attempts: Option<u8>,
    #[serde(default)]
    pub propagation_consensus_percent: Option<u8>,
    #[serde(default)]
    pub propagation_watch_interval_s: Option<u32>,
    /// Background notification service settings (one nested, versioned object;
    /// see `bc_notify::NotificationSettings::normalize`).
    #[serde(default)]
    pub notifications: Option<bc_notify::NotificationSettings>,
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

// ── Error ───────────────────────────────────────────────────────────────────

#[derive(Error, Debug)]
pub enum StorageError {
    #[error("Storage error: {0}")]
    Error(String),
    #[error("Not found")]
    NotFound,
    #[error("Keyring error: {0}")]
    KeyringError(String),
    #[error("Stored data is corrupt: {0}")]
    CorruptData(&'static str),
    #[error("Stored value exceeds secure storage limits")]
    LimitExceeded,
    #[error("Invalid secure storage key")]
    InvalidKey,
}

// ── Backend ─────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackendError {
    NotFound,
    Failure,
}

trait SecretBackend: Send + Sync {
    fn get(&self, key: &str) -> Result<String, BackendError>;
    fn set(&self, key: &str, value: &str) -> Result<(), BackendError>;
    fn delete(&self, key: &str) -> Result<(), BackendError>;
}

#[derive(Default)]
struct KeyringBackend;

impl KeyringBackend {
    fn entry(key: &str) -> Result<Entry, BackendError> {
        Entry::new(SERVICE_NAME, key).map_err(|_| BackendError::Failure)
    }

    fn map_error(error: keyring::Error) -> BackendError {
        if matches!(error, keyring::Error::NoEntry) {
            BackendError::NotFound
        } else {
            BackendError::Failure
        }
    }
}

impl SecretBackend for KeyringBackend {
    fn get(&self, key: &str) -> Result<String, BackendError> {
        Self::entry(key)?.get_password().map_err(Self::map_error)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), BackendError> {
        Self::entry(key)?
            .set_password(value)
            .map_err(Self::map_error)
    }

    fn delete(&self, key: &str) -> Result<(), BackendError> {
        Self::entry(key)?.delete_password().map_err(Self::map_error)
    }
}

#[derive(Default)]
struct MemoryBackend {
    values: Mutex<HashMap<String, String>>,
}

impl SecretBackend for MemoryBackend {
    fn get(&self, key: &str) -> Result<String, BackendError> {
        let values = self.values.lock().map_err(|_| BackendError::Failure)?;
        values.get(key).cloned().ok_or(BackendError::NotFound)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), BackendError> {
        let mut values = self.values.lock().map_err(|_| BackendError::Failure)?;
        values.insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), BackendError> {
        let mut values = self.values.lock().map_err(|_| BackendError::Failure)?;
        if values.remove(key).is_some() {
            Ok(())
        } else {
            Err(BackendError::NotFound)
        }
    }
}

// ── Storage ─────────────────────────────────────────────────────────────────

/// Secure storage backed by the OS keyring, or by explicit in-memory mode.
pub struct Storage {
    backend: Arc<dyn SecretBackend>,
}

impl Default for Storage {
    fn default() -> Self {
        Self::with_backend(Arc::new(KeyringBackend))
    }
}

impl Storage {
    /// Construct storage in durable keyring mode (`true`) or explicit
    /// process-local memory mode (`false`).
    pub fn new(use_keyring: bool) -> Self {
        if use_keyring {
            Self::default()
        } else {
            Self::with_backend(Arc::new(MemoryBackend::default()))
        }
    }

    fn with_backend(backend: Arc<dyn SecretBackend>) -> Self {
        Self { backend }
    }

    fn backend_error(operation: &'static str) -> StorageError {
        StorageError::KeyringError(format!("secure storage {operation} failed"))
    }

    fn validate_logical_key(key: &str) -> Result<(), StorageError> {
        if key.is_empty() || key.len() > MAX_LOGICAL_KEY_BYTES {
            return Err(StorageError::InvalidKey);
        }
        Ok(())
    }

    fn validate_mutating_logical_key(key: &str) -> Result<(), StorageError> {
        Self::validate_logical_key(key)?;
        if key.contains("::chunk:") || key.contains("::generation:") {
            return Err(StorageError::InvalidKey);
        }
        Ok(())
    }

    fn logical_lock(&self, key: &str) -> Result<Arc<Mutex<()>>, StorageError> {
        Self::logical_lock_in_registry(
            key,
            LOGICAL_LOCKS.get_or_init(|| Mutex::new(HashMap::new())),
        )
    }

    fn logical_lock_in_registry(
        key: &str,
        registry: &LogicalLockRegistry,
    ) -> Result<Arc<Mutex<()>>, StorageError> {
        Self::validate_logical_key(key)?;
        let mut locks = lock_ignoring_poison(registry);
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
            return Ok(lock);
        }
        if locks.len() >= MAX_ACTIVE_LOGICAL_LOCKS {
            return Err(StorageError::LimitExceeded);
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(key.to_string(), Arc::downgrade(&lock));
        Ok(lock)
    }

    fn get_backend_value(&self, key: &str) -> Result<String, StorageError> {
        match self.backend.get(key) {
            Ok(value) => Ok(value),
            Err(BackendError::NotFound) => Err(StorageError::NotFound),
            Err(BackendError::Failure) => Err(Self::backend_error("read")),
        }
    }

    fn set_backend_value(&self, key: &str, value: &str) -> Result<(), StorageError> {
        self.backend
            .set(key, value)
            .map_err(|_| Self::backend_error("write"))
    }

    fn delete_backend_value(&self, key: &str) -> Result<(), StorageError> {
        self.backend
            .delete(key)
            .map_err(|_| Self::backend_error("delete"))
    }

    // ── Low-level chunk helpers ────────────────────────────────────────

    fn legacy_chunk_key(key: &str, index: usize) -> String {
        format!("{key}::chunk:{index}")
    }

    fn generation_chunk_key(key: &str, generation: &str, index: usize) -> String {
        format!("{key}::generation:{generation}:chunk:{index}")
    }

    fn read_legacy_chunks(&self, key: &str, chunk_count: usize) -> Result<String, StorageError> {
        validate_chunk_metadata(chunk_count, None)?;
        let mut combined = String::new();
        for idx in 0..chunk_count {
            let chunk = match self.get_backend_value(&Self::legacy_chunk_key(key, idx)) {
                Ok(chunk) => chunk,
                Err(StorageError::NotFound) => {
                    return Err(StorageError::CorruptData("missing legacy chunk"));
                }
                Err(error) => return Err(error),
            };
            if chunk.is_empty() || chunk.len() > KEYRING_MAX_VALUE_BYTES {
                return Err(StorageError::CorruptData("invalid legacy chunk"));
            }
            let combined_len = combined
                .len()
                .checked_add(chunk.len())
                .ok_or(StorageError::LimitExceeded)?;
            if combined_len > MAX_SECRET_BYTES {
                return Err(StorageError::LimitExceeded);
            }
            combined.push_str(&chunk);
        }
        Ok(combined)
    }

    fn read_generation(&self, key: &str, manifest: &ChunkManifest) -> Result<String, StorageError> {
        validate_chunk_metadata(manifest.chunk_count, Some(manifest.byte_len))?;
        let mut combined = String::with_capacity(manifest.byte_len);
        for idx in 0..manifest.chunk_count {
            let chunk_key = Self::generation_chunk_key(key, &manifest.generation, idx);
            let chunk = match self.get_backend_value(&chunk_key) {
                Ok(chunk) => chunk,
                Err(StorageError::NotFound) => {
                    return Err(StorageError::CorruptData("missing generation chunk"));
                }
                Err(error) => return Err(error),
            };
            let is_valid_empty = manifest.byte_len == 0 && manifest.chunk_count == 1 && idx == 0;
            if (!is_valid_empty && chunk.is_empty()) || chunk.len() > KEYRING_MAX_VALUE_BYTES {
                return Err(StorageError::CorruptData("invalid generation chunk"));
            }
            let combined_len = combined
                .len()
                .checked_add(chunk.len())
                .ok_or(StorageError::LimitExceeded)?;
            if combined_len > manifest.byte_len || combined_len > MAX_SECRET_BYTES {
                return Err(StorageError::CorruptData(
                    "generation exceeds declared byte length",
                ));
            }
            combined.push_str(&chunk);
        }
        if combined.len() != manifest.byte_len {
            return Err(StorageError::CorruptData("generation byte length mismatch"));
        }
        if payload_digest(&combined) != manifest.digest {
            return Err(StorageError::CorruptData("generation digest mismatch"));
        }
        Ok(combined)
    }

    fn read_secret_unlocked(&self, key: &str) -> Result<String, StorageError> {
        let root = self.get_backend_value(key)?;
        match parse_stored_root(&root)? {
            StoredRoot::Direct(value) => Ok(value),
            StoredRoot::LegacyChunks { chunk_count } => self.read_legacy_chunks(key, chunk_count),
            StoredRoot::Manifest(manifest) => self.read_generation(key, &manifest),
        }
    }

    fn best_effort_delete_generation(&self, key: &str, manifest: &ChunkManifest) {
        for idx in 0..manifest.chunk_count {
            let chunk_key = Self::generation_chunk_key(key, &manifest.generation, idx);
            let _ = self.backend.delete(&chunk_key);
        }
    }

    fn best_effort_cleanup_root(&self, key: &str, root: &StoredRoot) {
        match root {
            StoredRoot::Direct(_) => {}
            // Released versions did not reserve legacy chunk-shaped logical
            // keys. A chunk may therefore also be an independently readable
            // direct value; deleting it during migration could destroy data.
            // Preserve ambiguous legacy chunks and prefer a bounded keyring
            // leak over irreversible loss.
            StoredRoot::LegacyChunks { .. } => {}
            StoredRoot::Manifest(manifest) => {
                self.best_effort_delete_generation(key, manifest);
            }
        }
    }

    fn write_secret_unlocked(&self, key: &str, value: &str) -> Result<(), StorageError> {
        Self::validate_mutating_logical_key(key)?;
        let chunks = split_value_for_keyring(value)?;
        let previous_root = match self.backend.get(key) {
            Ok(value) => Some(parse_stored_root(&value)?),
            Err(BackendError::NotFound) => None,
            Err(BackendError::Failure) => return Err(Self::backend_error("read")),
        };
        let previous_generation = match previous_root.as_ref() {
            Some(StoredRoot::Manifest(manifest)) => Some(manifest.generation.as_str()),
            _ => None,
        };
        let generation = loop {
            let candidate = uuid::Uuid::new_v4().to_string();
            if previous_generation != Some(candidate.as_str()) {
                break candidate;
            }
        };

        let manifest = ChunkManifest {
            generation,
            chunk_count: chunks.len(),
            byte_len: value.len(),
            digest: payload_digest(value),
        };

        for (idx, chunk) in chunks.iter().enumerate() {
            let chunk_key = Self::generation_chunk_key(key, &manifest.generation, idx);
            if let Err(error) = self.set_backend_value(&chunk_key, chunk) {
                self.best_effort_delete_generation(key, &manifest);
                return Err(error);
            }
        }

        match self.read_generation(key, &manifest) {
            Ok(verified) if verified == value => {}
            Ok(_) => {
                self.best_effort_delete_generation(key, &manifest);
                return Err(StorageError::CorruptData(
                    "generation verification mismatch",
                ));
            }
            Err(error) => {
                self.best_effort_delete_generation(key, &manifest);
                return Err(error);
            }
        }

        let encoded_manifest = manifest.encode();
        if let Err(error) = self.set_backend_value(key, &encoded_manifest) {
            match self.backend.get(key) {
                Ok(active_root) if active_root == encoded_manifest => {
                    if let Some(previous_root) = previous_root {
                        self.best_effort_cleanup_root(key, &previous_root);
                    }
                    return Ok(());
                }
                Ok(_) | Err(BackendError::NotFound) => {
                    self.best_effort_delete_generation(key, &manifest);
                    return Err(error);
                }
                Err(BackendError::Failure) => {
                    return Err(error);
                }
            }
        }

        if let Some(previous_root) = previous_root {
            self.best_effort_cleanup_root(key, &previous_root);
        }
        Ok(())
    }

    fn delete_secret_unlocked(&self, key: &str) -> Result<(), StorageError> {
        Self::validate_mutating_logical_key(key)?;
        let root = match self.backend.get(key) {
            Ok(value) => parse_stored_root(&value)?,
            Err(BackendError::NotFound) => return Ok(()),
            Err(BackendError::Failure) => return Err(Self::backend_error("read")),
        };
        self.delete_backend_value(key)?;
        self.best_effort_cleanup_root(key, &root);
        Ok(())
    }

    // ── Public low-level API ────────────────────────────────────────────

    pub async fn store_secret(&self, key: &str, value: &str) -> Result<(), StorageError> {
        let lock = self.logical_lock(key)?;
        let _guard = lock_ignoring_poison(&lock);
        self.write_secret_unlocked(key, value)
    }

    pub async fn get_secret(&self, key: &str) -> Result<String, StorageError> {
        let lock = self.logical_lock(key)?;
        let _guard = lock_ignoring_poison(&lock);
        self.read_secret_unlocked(key)
    }

    pub async fn delete_secret(&self, key: &str) -> Result<(), StorageError> {
        let lock = self.logical_lock(key)?;
        let _guard = lock_ignoring_poison(&lock);
        self.delete_secret_unlocked(key)
    }

    fn read_json_list_unlocked<T: DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<Vec<T>, StorageError> {
        match self.read_secret_unlocked(key) {
            Ok(json) => deserialize_json(&json, "invalid stored list"),
            Err(StorageError::NotFound) => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }

    fn write_json_list_unlocked<T: Serialize>(
        &self,
        key: &str,
        list: &[T],
    ) -> Result<(), StorageError> {
        let json = serialize_json(list)?;
        self.write_secret_unlocked(key, &json)
    }

    /// Serialize a complete read-modify-write transaction for one logical
    /// JSON-list key. Callers must not acquire the same logical lock or call a
    /// locking public low-level method from `mutate`.
    fn mutate_json_list<T, R>(
        &self,
        key: &str,
        delete_when_empty: bool,
        mutate: impl FnOnce(&mut Vec<T>) -> Result<R, StorageError>,
    ) -> Result<R, StorageError>
    where
        T: DeserializeOwned + Serialize,
    {
        Self::validate_mutating_logical_key(key)?;
        let lock = self.logical_lock(key)?;
        let _guard = lock_ignoring_poison(&lock);
        let mut list = self.read_json_list_unlocked(key)?;
        let result = mutate(&mut list)?;
        if delete_when_empty && list.is_empty() {
            self.delete_secret_unlocked(key)?;
        } else {
            self.write_json_list_unlocked(key, &list)?;
        }
        Ok(result)
    }

    // ── API Key management ──────────────────────────────────────────────

    pub async fn get_api_keys(&self) -> Result<Vec<ApiKey>, StorageError> {
        match self.get_secret("api_keys_list").await {
            Ok(json) => deserialize_json(&json, "invalid API key collection"),
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
        let id = format!("key_{}", uuid::Uuid::new_v4());
        let stored_id = id.clone();
        self.mutate_json_list("api_keys_list", false, move |keys: &mut Vec<ApiKey>| {
            keys.push(ApiKey {
                id: stored_id,
                label,
                email,
                encrypted_key,
                iterations: config.iterations,
                key_length: config.key_length,
                algorithm: config.algorithm,
            });
            Ok(())
        })?;
        Ok(id)
    }

    pub async fn get_encrypted_key(&self, id: &str) -> Result<String, StorageError> {
        let keys = self.get_api_keys().await?;
        keys.iter()
            .find(|k| k.id == id)
            .map(|k| k.encrypted_key.clone())
            .ok_or(StorageError::NotFound)
    }

    pub async fn get_api_key(&self, id: &str) -> Result<ApiKey, StorageError> {
        let keys = self.get_api_keys().await?;
        keys.into_iter()
            .find(|k| k.id == id)
            .ok_or(StorageError::NotFound)
    }

    #[allow(clippy::too_many_arguments)]
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
        self.mutate_json_list("api_keys_list", false, move |keys: &mut Vec<ApiKey>| {
            if let Some(key) = keys.iter_mut().find(|key| key.id == id) {
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
                Ok(())
            } else {
                Err(StorageError::NotFound)
            }
        })
    }

    pub async fn delete_api_key(&self, id: String) -> Result<(), StorageError> {
        self.mutate_json_list("api_keys_list", false, move |keys: &mut Vec<ApiKey>| {
            keys.retain(|key| key.id != id);
            Ok(())
        })
    }

    // ── Vault operations ────────────────────────────────────────────────

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

    // ── Passkey storage ─────────────────────────────────────────────────

    pub async fn get_passkeys(&self, id: &str) -> Result<Vec<Value>, StorageError> {
        let key = format!("passkeys:{}", id);
        match self.get_secret(&key).await {
            Ok(json) => deserialize_json(&json, "invalid passkey collection"),
            Err(StorageError::NotFound) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    pub async fn store_passkey(&self, id: &str, credential: Value) -> Result<(), StorageError> {
        let key = format!("passkeys:{}", id);
        self.mutate_json_list(&key, false, move |list: &mut Vec<Value>| {
            list.push(credential);
            Ok(())
        })
    }

    pub async fn delete_passkey(&self, id: &str, credential_id: &str) -> Result<(), StorageError> {
        let key = format!("passkeys:{}", id);
        self.mutate_json_list(&key, true, |list: &mut Vec<Value>| {
            list.retain(|credential| {
                credential.get("id").and_then(Value::as_str) != Some(credential_id)
                    && credential.get("rawId").and_then(Value::as_str) != Some(credential_id)
            });
            Ok(())
        })
    }

    // ── Generic typed-list helpers (used by registrar credentials) ──────

    /// Get a typed list stored under `key`.  Returns an empty Vec when the
    /// key does not exist.
    pub async fn get_typed_list<T: DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<Vec<T>, StorageError> {
        match self.get_secret(key).await {
            Ok(json) => deserialize_json(&json, "invalid stored typed list"),
            Err(StorageError::NotFound) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    /// Store a typed list under `key`.
    pub async fn set_typed_list<T: Serialize>(
        &self,
        key: &str,
        list: &[T],
    ) -> Result<(), StorageError> {
        let json = serialize_json(list)?;
        self.store_secret(key, &json).await
    }

    /// Get a typed map stored under `key`.  Returns an empty map on miss.
    pub async fn get_typed_map<T: DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<HashMap<String, T>, StorageError> {
        match self.get_secret(key).await {
            Ok(json) => deserialize_json(&json, "invalid stored typed map"),
            Err(StorageError::NotFound) => Ok(HashMap::new()),
            Err(e) => Err(e),
        }
    }

    /// Store a typed map under `key`.
    pub async fn set_typed_map<T: Serialize>(
        &self,
        key: &str,
        map: &HashMap<String, T>,
    ) -> Result<(), StorageError> {
        let json = serialize_json(map)?;
        self.store_secret(key, &json).await
    }

    // ── Registrar credential storage (generic) ─────────────────────────

    pub async fn get_registrar_credentials<T: DeserializeOwned>(
        &self,
    ) -> Result<Vec<T>, StorageError> {
        self.get_typed_list("registrar_credentials").await
    }

    pub async fn store_registrar_credential<T: Serialize + DeserializeOwned>(
        &self,
        cred: &T,
    ) -> Result<(), StorageError> {
        let value = to_json_value(cred)?;
        self.mutate_json_list(
            "registrar_credentials",
            false,
            move |credentials: &mut Vec<Value>| {
                credentials.push(value);
                Ok(())
            },
        )
    }

    /// Fetch a single registrar credential by its `id` field.
    pub async fn get_registrar_credential<T: DeserializeOwned>(
        &self,
        id: &str,
    ) -> Result<T, StorageError> {
        let creds: Vec<Value> = self.get_typed_list("registrar_credentials").await?;
        let val = creds
            .into_iter()
            .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(id))
            .ok_or(StorageError::NotFound)?;
        from_json_value(val, "invalid registrar credential")
    }

    pub async fn delete_registrar_credential(&self, id: &str) -> Result<(), StorageError> {
        self.mutate_json_list(
            "registrar_credentials",
            false,
            |credentials: &mut Vec<Value>| {
                credentials
                    .retain(|credential| credential.get("id").and_then(Value::as_str) != Some(id));
                Ok(())
            },
        )
    }

    pub async fn store_registrar_secrets(
        &self,
        credential_id: &str,
        secrets: &HashMap<String, String>,
    ) -> Result<(), StorageError> {
        let key = format!("registrar_secrets:{}", credential_id);
        let json = serialize_json(secrets)?;
        self.store_secret(&key, &json).await
    }

    pub async fn get_registrar_secrets(
        &self,
        credential_id: &str,
    ) -> Result<HashMap<String, String>, StorageError> {
        let key = format!("registrar_secrets:{}", credential_id);
        match self.get_secret(&key).await {
            Ok(json) => deserialize_json(&json, "invalid registrar secret collection"),
            Err(StorageError::NotFound) => Ok(HashMap::new()),
            Err(e) => Err(e),
        }
    }

    pub async fn delete_registrar_secrets(&self, credential_id: &str) -> Result<(), StorageError> {
        let key = format!("registrar_secrets:{}", credential_id);
        self.delete_secret(&key).await
    }

    // ── Audit log ───────────────────────────────────────────────────────

    pub async fn get_audit_entries(&self) -> Result<Vec<Value>, StorageError> {
        match self.get_secret("audit_log").await {
            Ok(json) => deserialize_json(&json, "invalid audit log"),
            Err(StorageError::NotFound) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    pub async fn clear_audit_entries(&self) -> Result<(), StorageError> {
        self.delete_secret("audit_log").await
    }

    pub async fn add_audit_entry(&self, entry: Value) -> Result<(), StorageError> {
        self.mutate_json_list("audit_log", false, move |entries: &mut Vec<Value>| {
            entries.push(entry);
            if entries.len() > MAX_AUDIT_ENTRIES {
                let drop_count = entries.len() - MAX_AUDIT_ENTRIES;
                entries.drain(..drop_count);
            }
            Ok(())
        })
    }

    // ── Encryption settings ─────────────────────────────────────────────

    pub async fn get_encryption_settings(&self) -> Result<EncryptionConfig, StorageError> {
        match self.get_secret("encryption_settings").await {
            Ok(json) => deserialize_json(&json, "invalid encryption settings"),
            Err(StorageError::NotFound) => Err(StorageError::NotFound),
            Err(e) => Err(e),
        }
    }

    pub async fn set_encryption_settings(
        &self,
        config: &EncryptionConfig,
    ) -> Result<(), StorageError> {
        let json = serialize_json(config)?;
        self.store_secret("encryption_settings", &json).await
    }

    // ── Preferences ─────────────────────────────────────────────────────

    pub async fn get_legacy_preferences(&self) -> Result<Option<Preferences>, StorageError> {
        match self.get_secret("preferences").await {
            Ok(json) => deserialize_json(&json, "invalid preferences").map(Some),
            Err(StorageError::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn delete_legacy_preferences(&self) -> Result<(), StorageError> {
        self.delete_secret("preferences").await
    }

    #[cfg(test)]
    async fn set_preferences(&self, prefs: &Preferences) -> Result<(), StorageError> {
        let json = serialize_json(prefs)?;
        self.store_secret("preferences", &json).await
    }

    #[cfg(test)]
    async fn get_preferences(&self) -> Result<Preferences, StorageError> {
        self.get_legacy_preferences()
            .await?
            .ok_or(StorageError::NotFound)
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests;
