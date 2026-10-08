use crate::storage::Preferences;
use bc_storage::StorageError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
#[cfg(any(unix, test))]
use std::fs::File;
use std::fs::{self, Metadata, OpenOptions};
use std::future::Future;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

const FILE_NAME: &str = "preferences-v1.json";
const VERSION: u32 = 1;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_FIELDS: usize = 64;

#[derive(Debug)]
pub enum AppConfigError {
    Io(String),
    Corrupt(String),
    Oversize,
    UnsupportedVersion(u32),
    InvalidUpdate(String),
    LegacyUnavailable(String),
}

impl std::fmt::Display for AppConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(message) => write!(formatter, "preference file I/O failed: {message}"),
            Self::Corrupt(message) => write!(formatter, "preference file is corrupt: {message}"),
            Self::Oversize => write!(formatter, "preference file exceeds {MAX_BYTES} bytes"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported preference file version {version}")
            }
            Self::InvalidUpdate(message) => {
                write!(formatter, "invalid preference update: {message}")
            }
            Self::LegacyUnavailable(message) => write!(
                formatter,
                "previous preferences could not be read, so they were left untouched: {message}"
            ),
        }
    }
}

/// One preference whose **stored** value an update actually altered.
///
/// Stored, not requested: the merge round-trips the whole object through
/// `Preferences`, so a nested object the UI sent half-filled arrives here
/// normalised the way it was written to disk. That is what makes "did this
/// write change anything" answerable at all. The renderer re-persists whole
/// groups of preferences on every save — one topology save sends a dozen keys
/// it did not touch — so comparing what it *sent* against what was stored
/// would call almost every one of those a change, and the audit trail would
/// fill with saves that changed nothing.
#[derive(Clone, Debug, PartialEq)]
pub struct PreferenceChange {
    pub key: String,
    pub before: Value,
    pub after: Value,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    preferences: Preferences,
}

impl Envelope {
    fn new(preferences: Preferences) -> Self {
        Self {
            version: VERSION,
            preferences,
        }
    }
}

pub struct AppConfigStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl AppConfigStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            path: app_data_dir.join(FILE_NAME),
            lock: Mutex::new(()),
        }
    }

    pub async fn get_preferences<L, LFut, D, DFut>(
        &self,
        load_legacy: L,
        delete_legacy: D,
    ) -> Result<Preferences, AppConfigError>
    where
        L: FnOnce() -> LFut,
        LFut: Future<Output = Result<Option<Preferences>, StorageError>>,
        D: FnOnce() -> DFut,
        DFut: Future<Output = Result<(), StorageError>>,
    {
        let (preferences, migrated) = {
            let _guard = self.lock.lock().await;
            match self.read()? {
                Some(envelope) => return Ok(envelope.preferences),
                None => match load_legacy().await {
                    Ok(Some(preferences)) => {
                        self.write_verified(&Envelope::new(preferences.clone()))?;
                        (preferences, true)
                    }
                    Ok(None) => {
                        let preferences = Preferences::default();
                        self.write_verified(&Envelope::new(preferences.clone()))?;
                        (preferences, false)
                    }
                    // Serve defaults for this session but deliberately do not write:
                    // the legacy store may still hold real preferences, and creating
                    // this file would permanently shadow them.
                    Err(_) => (Preferences::default(), false),
                },
            }
        };
        if migrated {
            let _ = delete_legacy().await;
        }
        Ok(preferences)
    }

    /// Persist `fields`, discarding the report of what changed.
    ///
    /// The entry point for a writer that is **not** the person at the keyboard:
    /// the background notification service persists its own normalised settings
    /// through here on its own schedule. Those writes are deliberately not
    /// audited — the trail's only actor for a preference write is `user`, and
    /// labelling the service's housekeeping as something the user did would be
    /// a false entry, printed at the service's polling rate.
    pub async fn update_preferences<L, LFut, D, DFut>(
        &self,
        fields: Map<String, Value>,
        load_legacy: L,
        delete_legacy: D,
    ) -> Result<(), AppConfigError>
    where
        L: FnOnce() -> LFut,
        LFut: Future<Output = Result<Option<Preferences>, StorageError>>,
        D: FnOnce() -> DFut,
        DFut: Future<Output = Result<(), StorageError>>,
    {
        self.update_preferences_reporting_changes(fields, load_legacy, delete_legacy)
            .await
            .map(|_| ())
    }

    /// Persist `fields`, and report every preference whose stored value that
    /// actually altered.
    ///
    /// The comparison happens here rather than in the caller because it has to
    /// happen under the same lock as the read and the write. `AppConfigStore`
    /// serialises concurrent updates, and two of them do interleave in practice
    /// (see `concurrent_updates_merge_atomically`); a before-state read outside
    /// the lock would be the state before *someone else's* write, and the
    /// change set would name keys this call did not touch.
    ///
    /// An empty report means the write landed and changed nothing. That is a
    /// success, not an error: the file was rewritten with identical contents.
    pub async fn update_preferences_reporting_changes<L, LFut, D, DFut>(
        &self,
        fields: Map<String, Value>,
        load_legacy: L,
        delete_legacy: D,
    ) -> Result<Vec<PreferenceChange>, AppConfigError>
    where
        L: FnOnce() -> LFut,
        LFut: Future<Output = Result<Option<Preferences>, StorageError>>,
        D: FnOnce() -> DFut,
        DFut: Future<Output = Result<(), StorageError>>,
    {
        self.validate_fields(&fields)?;
        let (changes, migrated) = {
            let _guard = self.lock.lock().await;
            let (current, migrated) = match self.read()? {
                Some(envelope) => (envelope.preferences, false),
                None => match load_legacy().await {
                    Ok(Some(preferences)) => (preferences, true),
                    Ok(None) => (Preferences::default(), false),
                    // The legacy store answered with an error rather than "no data".
                    // Writing defaults here would make this file authoritative and
                    // orphan preferences that may still exist in the legacy store,
                    // so refuse the write and let the caller retry or surface it.
                    Err(error) => return Err(AppConfigError::LegacyUnavailable(error.to_string())),
                },
            };
            let before = preference_object(&current)?;
            let preferences = self.merge(before.clone(), fields)?;
            let after = preference_object(&preferences)?;
            self.write_verified(&Envelope::new(preferences))?;
            // Only after the write landed. A change set describing a write that
            // then failed would claim a setting holds a value it does not.
            (changed_preferences(&before, &after), migrated)
        };
        if migrated {
            let _ = delete_legacy().await;
        }
        Ok(changes)
    }

    fn validate_fields(&self, fields: &Map<String, Value>) -> Result<(), AppConfigError> {
        if fields.len() > MAX_FIELDS
            || serde_json::to_vec(fields)
                .map_err(|error| AppConfigError::InvalidUpdate(error.to_string()))?
                .len()
                > MAX_BYTES
        {
            return Err(AppConfigError::Oversize);
        }
        Ok(())
    }

    /// Lay `fields` over the current preferences, as an object.
    ///
    /// Takes the serialised form rather than the struct because the caller
    /// needs that same object as the before-state of the change report, and
    /// serialising twice would be two chances for the two copies to disagree.
    fn merge(
        &self,
        mut current: Map<String, Value>,
        fields: Map<String, Value>,
    ) -> Result<Preferences, AppConfigError> {
        for (key, value) in fields {
            if !current.contains_key(&key) {
                return Err(AppConfigError::InvalidUpdate(format!(
                    "unknown field {key}"
                )));
            }
            current.insert(key, value);
        }
        serde_json::from_value(Value::Object(current))
            .map_err(|error| AppConfigError::InvalidUpdate(error.to_string()))
    }

    fn read(&self) -> Result<Option<Envelope>, AppConfigError> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(self.io("inspect", &self.path, source)),
        };
        validate_metadata(&metadata, false)?;
        if metadata.len() > MAX_BYTES as u64 {
            return Err(AppConfigError::Oversize);
        }

        let mut options = OpenOptions::new();
        options.read(true);
        set_no_follow(&mut options);
        let file = options
            .open(&self.path)
            .map_err(|source| self.io("open", &self.path, source))?;
        let opened = file
            .metadata()
            .map_err(|source| self.io("inspect opened", &self.path, source))?;
        validate_metadata(&opened, false)?;
        let mut bytes = Vec::with_capacity((opened.len() as usize).min(MAX_BYTES));
        file.take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|source| self.io("read", &self.path, source))?;
        if bytes.len() > MAX_BYTES {
            return Err(AppConfigError::Oversize);
        }
        let envelope: Envelope = serde_json::from_slice(&bytes)
            .map_err(|error| AppConfigError::Corrupt(error.to_string()))?;
        if envelope.version != VERSION {
            return Err(AppConfigError::UnsupportedVersion(envelope.version));
        }
        Ok(Some(envelope))
    }

    fn write_verified(&self, envelope: &Envelope) -> Result<(), AppConfigError> {
        let bytes = serde_json::to_vec(envelope)
            .map_err(|error| AppConfigError::InvalidUpdate(error.to_string()))?;
        if bytes.len() > MAX_BYTES {
            return Err(AppConfigError::Oversize);
        }
        let parent = self
            .path
            .parent()
            .ok_or_else(|| AppConfigError::Corrupt("missing app-data directory".into()))?;
        fs::create_dir_all(parent).map_err(|source| self.io("create directory", parent, source))?;
        let parent_metadata = fs::symlink_metadata(parent)
            .map_err(|source| self.io("inspect directory", parent, source))?;
        validate_metadata(&parent_metadata, true)?;
        match fs::symlink_metadata(&self.path) {
            Ok(existing) => validate_metadata(&existing, false)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(self.io("inspect destination", &self.path, source)),
        }

        let temp = parent.join(format!(".{FILE_NAME}.{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            set_private_mode(&mut options);
            let mut file = options
                .open(&temp)
                .map_err(|source| self.io("create temporary", &temp, source))?;
            file.write_all(&bytes)
                .map_err(|source| self.io("write temporary", &temp, source))?;
            file.flush()
                .map_err(|source| self.io("flush temporary", &temp, source))?;
            file.sync_all()
                .map_err(|source| self.io("sync temporary", &temp, source))?;
            drop(file);
            atomic_replace(&temp, &self.path)
                .map_err(|source| self.io("replace", &self.path, source))?;
            sync_parent(parent).map_err(|source| self.io("sync directory", parent, source))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
        if self.read()?.as_ref() != Some(envelope) {
            return Err(AppConfigError::Corrupt(
                "post-write verification failed".into(),
            ));
        }
        Ok(())
    }

    fn io(&self, operation: &'static str, path: &Path, source: std::io::Error) -> AppConfigError {
        AppConfigError::Io(format!("{operation} {}: {source}", path.display()))
    }
}

/// Preferences as a flat object, which is the form both the merge and the
/// change report work in.
///
/// Every field of `Preferences` is an `Option` with no `skip_serializing_if`,
/// so the object always carries every key — an unset preference is a present
/// `null`. Two such objects therefore have identical key sets, which is what
/// lets [`changed_preferences`] compare them key by key without having to
/// decide what an absent key would have meant.
fn preference_object(preferences: &Preferences) -> Result<Map<String, Value>, AppConfigError> {
    match serde_json::to_value(preferences) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err(AppConfigError::Corrupt(
            "preferences are not an object".into(),
        )),
        Err(error) => Err(AppConfigError::InvalidUpdate(error.to_string())),
    }
}

/// Every preference whose value differs between two stored states.
///
/// Compared on the whole object rather than only on the keys the caller asked
/// to write, because the merge round-trips through `Preferences` and that
/// normalises more than it was handed: a nested settings object is clamped and
/// deduped on the way in (`bc_notify::NotificationSettings::normalize` and the
/// lenient field decoders), so a write to one key can legitimately change the
/// stored value of another. A diff restricted to the requested keys would miss
/// exactly those, which are the ones a reader would least expect and most want
/// to see.
///
/// The returned order is the object's own key order — alphabetical, since
/// `serde_json::Map` is a `BTreeMap` in this build — so an entry built from
/// this names the same keys in the same order every time, and a test can pin
/// which ones survive a budget overrun.
fn changed_preferences(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
) -> Vec<PreferenceChange> {
    after
        .iter()
        .filter_map(|(key, after_value)| {
            // `Null` for a key missing from the before-state, which the shared
            // key set above means cannot happen. Defaulting rather than
            // skipping keeps a key that somehow appeared *in* the report: a new
            // preference the trail cannot explain is worth an entry, and
            // silently dropping it would be the one outcome with no evidence.
            let before_value = before.get(key).unwrap_or(&Value::Null);
            if before_value == after_value {
                return None;
            }
            Some(PreferenceChange {
                key: key.clone(),
                before: before_value.clone(),
                after: after_value.clone(),
            })
        })
        .collect()
}

fn validate_metadata(metadata: &Metadata, directory: bool) -> Result<(), AppConfigError> {
    let expected = if directory {
        metadata.is_dir()
    } else {
        metadata.is_file()
    };
    if !expected || metadata.file_type().is_symlink() || is_windows_reparse(metadata) {
        return Err(AppConfigError::Corrupt(
            "path substitution or unexpected file type".into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn is_windows_reparse(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_windows_reparse(_: &Metadata) -> bool {
    false
}

fn set_no_follow(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let flag = if cfg!(target_os = "macos") {
            0x100
        } else {
            0x20_000
        };
        options.custom_flags(flag);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
}

fn set_private_mode(_options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        _options.mode(0o600);
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x1 | 0x8) };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> std::io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("bc-prefs-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fields(entries: &[(&str, Value)]) -> Map<String, Value> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone()))
            .collect()
    }

    async fn no_legacy() -> Result<Option<Preferences>, StorageError> {
        Ok(None)
    }

    async fn deleted() -> Result<(), StorageError> {
        Ok(())
    }

    async fn locked() -> Result<Option<Preferences>, StorageError> {
        Err(StorageError::KeyringError("locked".into()))
    }

    #[tokio::test]
    async fn locked_keyring_does_not_block_reads_and_never_overwrites_legacy() {
        let directory = TestDir::new();
        let store = AppConfigStore::new(directory.0.clone());
        let loaded = store
            .get_preferences(locked, deleted)
            .await
            .expect("locked read");
        assert_eq!(loaded.theme, None);
        assert!(
            !store.path.exists(),
            "a failed legacy read must not create the authoritative file"
        );
        assert!(
            matches!(
                store
                    .update_preferences(fields(&[("theme", json!("dark"))]), locked, deleted)
                    .await,
                Err(AppConfigError::LegacyUnavailable(_))
            ),
            "an update must not persist defaults over an unreadable legacy store"
        );
        assert!(
            !store.path.exists(),
            "a failed legacy read must not create the authoritative file"
        );

        // Once the legacy store answers, the file becomes authoritative and a
        // later keyring outage no longer blocks writes.
        store
            .update_preferences(
                fields(&[
                    ("theme", json!("dark")),
                    ("rewrite_copied_record_domains", json!(false)),
                ]),
                no_legacy,
                deleted,
            )
            .await
            .expect("first write after legacy answered");
        store
            .update_preferences(fields(&[("locale", json!("pt-PT"))]), locked, deleted)
            .await
            .expect("locked write once the file exists");
        let loaded = store
            .get_preferences(no_legacy, deleted)
            .await
            .expect("file read");
        assert_eq!(loaded.theme.as_deref(), Some("dark"));
        assert_eq!(loaded.locale.as_deref(), Some("pt-PT"));
        assert_eq!(loaded.rewrite_copied_record_domains, Some(false));

        let restarted = AppConfigStore::new(directory.0.clone());
        let loaded = restarted
            .get_preferences(no_legacy, deleted)
            .await
            .expect("restarted file read");
        assert_eq!(loaded.rewrite_copied_record_domains, Some(false));
    }

    #[tokio::test]
    async fn concurrent_updates_merge_atomically() {
        let directory = TestDir::new();
        let store = Arc::new(AppConfigStore::new(directory.0.clone()));
        let left = store.update_preferences(
            fields(&[("theme", json!("dark"))]),
            || async {
                tokio::task::yield_now().await;
                Ok::<_, StorageError>(None)
            },
            deleted,
        );
        let right =
            store.update_preferences(fields(&[("locale", json!("pt-PT"))]), no_legacy, deleted);
        let (left, right) = tokio::join!(left, right);
        left.expect("left update");
        right.expect("right update");
        let loaded = store
            .get_preferences(no_legacy, deleted)
            .await
            .expect("merged read");
        assert_eq!(loaded.theme.as_deref(), Some("dark"));
        assert_eq!(loaded.locale.as_deref(), Some("pt-PT"));
    }

    #[tokio::test]
    async fn corruption_and_version_errors_are_explicit() {
        let directory = TestDir::new();
        let store = AppConfigStore::new(directory.0.clone());
        fs::write(&store.path, br#"{"version":1,"preferences":{}}"#).expect("write old v1 file");
        let old = store
            .read()
            .expect("read old v1 file")
            .expect("old v1 envelope");
        assert_eq!(old.preferences.rewrite_copied_record_domains, None);
        fs::write(&store.path, b"{broken").expect("write corrupt file");
        assert!(matches!(store.read(), Err(AppConfigError::Corrupt(_))));
        fs::write(&store.path, br#"{"version":2,"preferences":{}}"#).expect("write future version");
        assert!(matches!(
            store.read(),
            Err(AppConfigError::UnsupportedVersion(2))
        ));
    }

    #[tokio::test]
    async fn one_mibibyte_bound_applies_to_reads_and_writes() {
        let read_dir = TestDir::new();
        let read_store = AppConfigStore::new(read_dir.0.clone());
        File::create(&read_store.path)
            .expect("create oversized file")
            .set_len((MAX_BYTES + 1) as u64)
            .expect("size oversized file");
        assert!(matches!(read_store.read(), Err(AppConfigError::Oversize)));

        let write_dir = TestDir::new();
        let write_store = AppConfigStore::new(write_dir.0.clone());
        let huge = "x".repeat(MAX_BYTES);
        let result = write_store
            .update_preferences(fields(&[("last_zone", json!(huge))]), no_legacy, deleted)
            .await;
        assert!(matches!(result, Err(AppConfigError::Oversize)));
    }

    #[tokio::test]
    async fn migration_is_copy_once_even_when_delete_fails() {
        let directory = TestDir::new();
        let store = AppConfigStore::new(directory.0.clone());
        let legacy = Preferences {
            theme: Some("legacy".into()),
            rewrite_copied_record_domains: Some(false),
            ..Preferences::default()
        };
        let loaded = store
            .get_preferences(
                || async { Ok::<_, StorageError>(Some(legacy)) },
                || async { Err(StorageError::KeyringError("delete failed".into())) },
            )
            .await
            .expect("migrate despite delete failure");
        assert_eq!(loaded.theme.as_deref(), Some("legacy"));
        assert_eq!(loaded.rewrite_copied_record_domains, Some(false));
        store
            .update_preferences(
                fields(&[("theme", json!("newer"))]),
                || async { Ok::<_, StorageError>(Some(Preferences::default())) },
                deleted,
            )
            .await
            .expect("newer update");
        let loaded = store
            .get_preferences(no_legacy, deleted)
            .await
            .expect("read authoritative file");
        assert_eq!(loaded.theme.as_deref(), Some("newer"));
    }

    fn rich_legacy() -> Preferences {
        Preferences {
            theme: Some("legacy".into()),
            locale: Some("pt-PT".into()),
            idle_logout_ms: Some(900_000),
            zone_per_page: Some(HashMap::from([("example.com".to_string(), 200)])),
            ..Preferences::default()
        }
    }

    #[tokio::test]
    async fn legacy_read_failure_during_update_never_destroys_preferences() {
        let directory = TestDir::new();
        let store = AppConfigStore::new(directory.0.clone());
        let deletes = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&deletes);
        let result = store
            .update_preferences(fields(&[("theme", json!("dark"))]), locked, || async move {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert!(matches!(result, Err(AppConfigError::LegacyUnavailable(_))));
        assert_eq!(deletes.load(Ordering::SeqCst), 0, "legacy must be retained");
        assert!(
            !store.path.exists(),
            "defaults must not be persisted over an unreadable legacy store"
        );

        // The outage was transient; every legacy preference is still reachable.
        let loaded = store
            .get_preferences(|| async { Ok(Some(rich_legacy())) }, deleted)
            .await
            .expect("migrate after the outage clears");
        assert_eq!(loaded, rich_legacy());
    }

    #[tokio::test]
    async fn legacy_read_failure_leaves_an_existing_file_untouched() {
        let directory = TestDir::new();
        let store = AppConfigStore::new(directory.0.clone());
        fs::write(
            &store.path,
            br#"{"version":1,"preferences":{"theme":"kept"}}"#,
        )
        .expect("seed the authoritative file");
        store
            .update_preferences(fields(&[("locale", json!("en"))]), locked, deleted)
            .await
            .expect("an existing file makes the legacy store irrelevant");
        let loaded = store.read().expect("read").expect("envelope").preferences;
        assert_eq!(loaded.theme.as_deref(), Some("kept"));
        assert_eq!(loaded.locale.as_deref(), Some("en"));
    }

    #[tokio::test]
    async fn absent_legacy_still_writes_defaults_plus_the_update() {
        let directory = TestDir::new();
        let store = AppConfigStore::new(directory.0.clone());
        let deletes = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&deletes);
        store
            .update_preferences(
                fields(&[("theme", json!("dark"))]),
                no_legacy,
                || async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
            .expect("no legacy data is not an error");
        let loaded = store.read().expect("read").expect("envelope").preferences;
        assert_eq!(loaded.theme.as_deref(), Some("dark"));
        assert_eq!(
            loaded,
            Preferences {
                theme: Some("dark".into()),
                ..Preferences::default()
            },
            "nothing beyond the updated field may be invented"
        );
        assert_eq!(
            deletes.load(Ordering::SeqCst),
            0,
            "there was nothing to delete"
        );
    }

    #[tokio::test]
    async fn successful_legacy_load_still_migrates_during_update() {
        let directory = TestDir::new();
        let store = AppConfigStore::new(directory.0.clone());
        let deletes = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&deletes);
        store
            .update_preferences(
                fields(&[("theme", json!("dark"))]),
                || async { Ok(Some(rich_legacy())) },
                || async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
            .expect("migrating update");
        assert_eq!(deletes.load(Ordering::SeqCst), 1, "legacy copy is removed");
        let loaded = store.read().expect("read").expect("envelope").preferences;
        assert_eq!(
            loaded,
            Preferences {
                theme: Some("dark".into()),
                ..rich_legacy()
            },
            "the update merges onto migrated preferences, not onto defaults"
        );
    }

    #[tokio::test]
    async fn nested_notifications_object_round_trips_and_is_replaced_whole() {
        let directory = TestDir::new();
        let store = AppConfigStore::new(directory.0.clone());
        store
            .update_preferences(fields(&[("theme", json!("dark"))]), no_legacy, deleted)
            .await
            .expect("seed a sibling preference");

        // A partial object is accepted: missing sections take their defaults.
        store
            .update_preferences(
                fields(&[(
                    "notifications",
                    json!({ "service": { "recordPollMinutes": 30, "paused": true } }),
                )]),
                no_legacy,
                deleted,
            )
            .await
            .expect("partial notifications object");
        let loaded = store
            .get_preferences(no_legacy, deleted)
            .await
            .expect("read");
        let notifications = loaded.notifications.clone().expect("notifications stored");
        assert_eq!(notifications.service.record_poll_minutes, 30);
        assert!(notifications.service.paused);
        assert_eq!(
            notifications.expiry.milestones,
            vec![90, 60, 30, 14, 7, 3, 1]
        );
        assert_eq!(
            loaded.theme.as_deref(),
            Some("dark"),
            "sibling preferences survive a nested write"
        );

        // The object is replaced, not deep-merged: a later write without
        // `service.paused` resets it (the UI therefore always sends the full object).
        store
            .update_preferences(
                fields(&[("notifications", json!({ "expiry": { "milestones": [45] } }))]),
                no_legacy,
                deleted,
            )
            .await
            .expect("second nested write");
        let loaded = store
            .get_preferences(no_legacy, deleted)
            .await
            .expect("read");
        let notifications = loaded.notifications.expect("notifications stored");
        assert!(
            !notifications.service.paused,
            "merge replaces the whole object"
        );
        assert_eq!(notifications.service.record_poll_minutes, 15);
        assert_eq!(notifications.expiry.milestones, vec![45]);

        // The file survives a restart with the typed field intact.
        let restarted = AppConfigStore::new(directory.0.clone());
        let again = restarted
            .get_preferences(no_legacy, deleted)
            .await
            .expect("restart read");
        assert_eq!(again.notifications, Some(notifications));
    }

    #[tokio::test]
    async fn get_preferences_does_not_write_on_legacy_error() {
        let directory = TestDir::new();
        let store = AppConfigStore::new(directory.0.clone());
        let deletes = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&deletes);
        let loaded = store
            .get_preferences(locked, || async move {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await
            .expect("a legacy outage must not break reads");
        assert_eq!(loaded, Preferences::default());
        assert!(!store.path.exists(), "reads must not persist defaults");
        assert_eq!(deletes.load(Ordering::SeqCst), 0);
        assert!(store.read().expect("read absent file").is_none());
    }
}
