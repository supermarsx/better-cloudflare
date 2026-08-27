//! On-disk inbox, monitoring state and per-zone record snapshots
//! (`<dir>/inbox.json`, `<dir>/state.json`, `<dir>/snapshots/<zone_id>.json`).
//! Every write is temp file + fsync + atomic rename. Corrupt files are recovered
//! as empty and the error is surfaced through `recovered_errors()`; nothing panics.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use bc_cloudflare_api::DNSRecord;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::{format_ts, parse_ts, Notification, NotificationQuery, Scope};
use crate::settings::RetentionSettings;

pub const INBOX_FILE: &str = "inbox.json";
pub const STATE_FILE: &str = "state.json";
pub const SNAPSHOT_DIR: &str = "snapshots";
pub const DEFAULT_MAX_ITEMS: usize = 2_000;
pub const MAX_SNAPSHOT_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_INBOX_BYTES: u64 = 16 * 1024 * 1024;
const STATE_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Corrupt(String),
    #[error("snapshot for zone {0} exceeds {MAX_SNAPSHOT_BYTES} bytes")]
    SnapshotTooLarge(String),
    #[error("invalid zone id")]
    InvalidZoneId,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DomainExpiryState {
    pub expires_at: Option<String>,
    pub source: Option<String>,
    pub fetched_at: Option<String>,
    pub emitted: Vec<u32>,
    pub last_error: Option<String>,
    pub last_error_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ZoneState {
    pub zone_name: String,
    pub last_checked_at: Option<String>,
    pub snapshot_taken_at: Option<String>,
    pub snapshot_records: Option<u32>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NotifyState {
    pub version: u32,
    pub last_record_check_at: Option<String>,
    pub last_expiry_check_at: Option<String>,
    /// Round-robin cursor for `service.maxZonesPerPass`.
    pub zone_cursor: u32,
    pub zones: BTreeMap<String, ZoneState>,
    /// Keyed by apex domain (= zone name).
    pub expiry: BTreeMap<String, DomainExpiryState>,
    /// Items buffered during quiet hours with `behaviour = hold`.
    pub held: Vec<Notification>,
}

impl Default for NotifyState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            last_record_check_at: None,
            last_expiry_check_at: None,
            zone_cursor: 0,
            zones: BTreeMap::new(),
            expiry: BTreeMap::new(),
            held: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct InboxFile {
    version: u32,
    items: Vec<Notification>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SnapshotFile {
    version: u32,
    zone_id: String,
    taken_at: String,
    records: Vec<DNSRecord>,
}

#[derive(Debug)]
pub struct NotifyStore {
    dir: PathBuf,
    inbox: Vec<Notification>,
    state: NotifyState,
    max_items: usize,
    recovered_errors: Vec<String>,
}

fn io_err(operation: &str, path: &Path, source: std::io::Error) -> StoreError {
    StoreError::Io(format!("{operation} {}: {source}", path.display()))
}

fn is_valid_zone_id(zone_id: &str) -> bool {
    !zone_id.is_empty()
        && zone_id.len() <= 128
        && zone_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl NotifyStore {
    /// Open (creating directories) and load inbox + state.
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = dir.into();
        fs::create_dir_all(dir.join(SNAPSHOT_DIR))
            .map_err(|e| io_err("create directory", &dir, e))?;
        let mut store = Self {
            dir,
            inbox: Vec::new(),
            state: NotifyState::default(),
            max_items: DEFAULT_MAX_ITEMS,
            recovered_errors: Vec::new(),
        };
        match read_json::<InboxFile>(&store.dir.join(INBOX_FILE), MAX_INBOX_BYTES) {
            Ok(Some(file)) => store.inbox = file.items,
            Ok(None) => {}
            Err(error) => store.recovered_errors.push(format!("inbox reset: {error}")),
        }
        match read_json::<NotifyState>(&store.dir.join(STATE_FILE), MAX_INBOX_BYTES) {
            Ok(Some(state)) => store.state = state,
            Ok(None) => {}
            Err(error) => store.recovered_errors.push(format!("state reset: {error}")),
        }
        store.state.version = STATE_VERSION;
        // Persist recovered (empty) files so the corruption is not reported again.
        if !store.recovered_errors.is_empty() {
            store.save_inbox()?;
            store.save_state()?;
        }
        Ok(store)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Errors encountered while loading corrupt files (already recovered as empty).
    pub fn recovered_errors(&self) -> &[String] {
        &self.recovered_errors
    }

    pub fn set_max_items(&mut self, max_items: usize) {
        self.max_items = max_items.max(1);
    }

    pub fn max_items(&self) -> usize {
        self.max_items
    }

    // ── inbox ────────────────────────────────────────────────────────────

    pub fn items(&self) -> &[Notification] {
        &self.inbox
    }

    pub fn len(&self) -> usize {
        self.inbox.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inbox.is_empty()
    }

    pub fn unread_count(&self) -> u32 {
        self.inbox
            .iter()
            .filter(|n| n.is_unread() && !n.is_archived())
            .count() as u32
    }

    /// Insert unless an unarchived item with the same `dedupeKey` exists. Persists.
    pub fn insert_deduped(&mut self, notification: Notification) -> Result<bool, StoreError> {
        if self.inbox.iter().any(|existing| {
            !existing.is_archived() && existing.dedupe_key == notification.dedupe_key
        }) {
            return Ok(false);
        }
        self.inbox.push(notification);
        self.prune_to_cap();
        self.save_inbox()?;
        Ok(true)
    }

    /// Insert many with one write; returns how many were actually inserted.
    pub fn insert_many(&mut self, notifications: Vec<Notification>) -> Result<usize, StoreError> {
        let mut inserted = 0;
        for notification in notifications {
            let duplicate = self.inbox.iter().any(|existing| {
                !existing.is_archived() && existing.dedupe_key == notification.dedupe_key
            });
            if !duplicate {
                self.inbox.push(notification);
                inserted += 1;
            }
        }
        if inserted > 0 {
            self.prune_to_cap();
            self.save_inbox()?;
        }
        Ok(inserted)
    }

    pub fn get(&self, id: &str) -> Option<&Notification> {
        self.inbox.iter().find(|n| n.id == id)
    }

    /// Newest first, filtered by scope/kind/zone/cursor, capped by `limit`.
    pub fn list(&self, query: &NotificationQuery) -> Vec<Notification> {
        let before = query.before.as_deref().and_then(parse_ts);
        let mut items: Vec<&Notification> = self
            .inbox
            .iter()
            .filter(|n| match query.scope {
                Scope::All => !n.is_archived(),
                Scope::Unread => !n.is_archived() && n.is_unread(),
                Scope::Archived => n.is_archived(),
            })
            .filter(|n| {
                query
                    .kind
                    .as_deref()
                    .map(|kind| n.kind.as_str() == kind)
                    .unwrap_or(true)
            })
            .filter(|n| {
                query
                    .zone_id
                    .as_deref()
                    .map(|zone| n.zone_id.as_deref() == Some(zone))
                    .unwrap_or(true)
            })
            .filter(|n| match before {
                Some(cursor) => n.created_at_utc().map(|ts| ts < cursor).unwrap_or(false),
                None => true,
            })
            .collect();
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
        items
            .into_iter()
            .take(query.effective_limit())
            .cloned()
            .collect()
    }

    pub fn mark_read(&mut self, ids: &[String], read: bool) -> Result<usize, StoreError> {
        let now = format_ts(Utc::now());
        let mut affected = 0;
        for item in self.inbox.iter_mut().filter(|n| ids.contains(&n.id)) {
            match (read, item.read_at.is_some()) {
                (true, false) => {
                    item.read_at = Some(now.clone());
                    affected += 1;
                }
                (false, true) => {
                    item.read_at = None;
                    affected += 1;
                }
                _ => {}
            }
        }
        self.save_if(affected)
    }

    pub fn mark_all_read(&mut self) -> Result<usize, StoreError> {
        let now = format_ts(Utc::now());
        let mut affected = 0;
        for item in self
            .inbox
            .iter_mut()
            .filter(|n| !n.is_archived() && n.is_unread())
        {
            item.read_at = Some(now.clone());
            affected += 1;
        }
        self.save_if(affected)
    }

    pub fn archive(&mut self, ids: &[String]) -> Result<usize, StoreError> {
        let now = format_ts(Utc::now());
        let mut affected = 0;
        for item in self
            .inbox
            .iter_mut()
            .filter(|n| ids.contains(&n.id) && !n.is_archived())
        {
            item.archived_at = Some(now.clone());
            if item.read_at.is_none() {
                item.read_at = Some(now.clone());
            }
            affected += 1;
        }
        self.save_if(affected)
    }

    pub fn unarchive(&mut self, ids: &[String]) -> Result<usize, StoreError> {
        let mut affected = 0;
        for item in self
            .inbox
            .iter_mut()
            .filter(|n| ids.contains(&n.id) && n.is_archived())
        {
            item.archived_at = None;
            affected += 1;
        }
        self.save_if(affected)
    }

    pub fn archive_all_read(&mut self) -> Result<usize, StoreError> {
        let ids: Vec<String> = self
            .inbox
            .iter()
            .filter(|n| !n.is_archived() && !n.is_unread())
            .map(|n| n.id.clone())
            .collect();
        self.archive(&ids)
    }

    /// Delete permanently.
    pub fn dismiss(&mut self, ids: &[String]) -> Result<usize, StoreError> {
        let before = self.inbox.len();
        self.inbox.retain(|n| !ids.contains(&n.id));
        self.save_if(before - self.inbox.len())
    }

    pub fn clear_archived(&mut self) -> Result<usize, StoreError> {
        let before = self.inbox.len();
        self.inbox.retain(|n| !n.is_archived());
        self.save_if(before - self.inbox.len())
    }

    pub fn clear_inbox(&mut self) -> Result<usize, StoreError> {
        let before = self.inbox.len();
        self.inbox.clear();
        self.save_inbox()?;
        Ok(before)
    }

    /// Auto-archive read items, purge old archived items, cap `maxItems`.
    pub fn apply_retention(
        &mut self,
        retention: &RetentionSettings,
        now: DateTime<Utc>,
    ) -> Result<usize, StoreError> {
        let mut affected = 0;
        if let Some(days) = retention.auto_archive_read_after_days {
            let cutoff = now - Duration::days(i64::from(days));
            let stamp = format_ts(now);
            for item in self.inbox.iter_mut().filter(|n| !n.is_archived()) {
                let read_at = item.read_at.as_deref().and_then(parse_ts);
                if matches!(read_at, Some(ts) if ts <= cutoff) {
                    item.archived_at = Some(stamp.clone());
                    affected += 1;
                }
            }
        }
        if let Some(days) = retention.purge_archived_after_days {
            let cutoff = now - Duration::days(i64::from(days));
            let before = self.inbox.len();
            self.inbox.retain(|n| {
                let archived_at = n.archived_at.as_deref().and_then(parse_ts);
                !matches!(archived_at, Some(ts) if ts <= cutoff)
            });
            affected += before - self.inbox.len();
        }
        self.max_items = (retention.max_items as usize).max(1);
        affected += self.prune_to_cap();
        self.save_if(affected)
    }

    /// Drop oldest archived → oldest read → oldest unread until `max_items` fits.
    pub fn prune(&mut self) -> Result<usize, StoreError> {
        let removed = self.prune_to_cap();
        self.save_if(removed)
    }

    fn prune_to_cap(&mut self) -> usize {
        let excess = self.inbox.len().saturating_sub(self.max_items);
        if excess == 0 {
            return 0;
        }
        let mut order: Vec<(u8, String, String)> = self
            .inbox
            .iter()
            .map(|n| {
                let class = if n.is_archived() {
                    0
                } else if !n.is_unread() {
                    1
                } else {
                    2
                };
                (class, n.created_at.clone(), n.id.clone())
            })
            .collect();
        order.sort();
        let victims: std::collections::HashSet<String> = order
            .into_iter()
            .take(excess)
            .map(|(_, _, id)| id)
            .collect();
        self.inbox.retain(|n| !victims.contains(&n.id));
        excess
    }

    fn save_if(&mut self, affected: usize) -> Result<usize, StoreError> {
        if affected > 0 {
            self.save_inbox()?;
        }
        Ok(affected)
    }

    pub fn save_inbox(&self) -> Result<(), StoreError> {
        let file = InboxFile {
            version: 1,
            items: self.inbox.clone(),
        };
        write_json(&self.dir.join(INBOX_FILE), &file)
    }

    // ── held items (quiet hours "hold") ───────────────────────────────────

    pub fn hold(&mut self, notification: Notification) -> Result<(), StoreError> {
        if !self
            .state
            .held
            .iter()
            .any(|h| h.dedupe_key == notification.dedupe_key)
        {
            self.state.held.push(notification);
        }
        self.save_state()
    }

    pub fn held_count(&self) -> usize {
        self.state.held.len()
    }

    /// Move held items into the inbox (original `createdAt` kept).
    pub fn release_held(&mut self) -> Result<usize, StoreError> {
        if self.state.held.is_empty() {
            return Ok(0);
        }
        let held = std::mem::take(&mut self.state.held);
        let inserted = self.insert_many(held)?;
        self.save_state()?;
        Ok(inserted)
    }

    // ── state ────────────────────────────────────────────────────────────

    pub fn state(&self) -> &NotifyState {
        &self.state
    }

    pub fn state_mut(&mut self) -> &mut NotifyState {
        &mut self.state
    }

    pub fn save_state(&self) -> Result<(), StoreError> {
        write_json(&self.dir.join(STATE_FILE), &self.state)
    }

    pub fn reset_expiry_ledger(&mut self) -> Result<(), StoreError> {
        for entry in self.state.expiry.values_mut() {
            entry.emitted.clear();
        }
        self.save_state()
    }

    pub fn clear_expiry_state(&mut self) -> Result<(), StoreError> {
        self.state.expiry.clear();
        self.save_state()
    }

    // ── snapshots ────────────────────────────────────────────────────────

    fn snapshot_path(&self, zone_id: &str) -> Result<PathBuf, StoreError> {
        if !is_valid_zone_id(zone_id) {
            return Err(StoreError::InvalidZoneId);
        }
        Ok(self.dir.join(SNAPSHOT_DIR).join(format!("{zone_id}.json")))
    }

    pub fn has_snapshot(&self, zone_id: &str) -> bool {
        self.snapshot_path(zone_id)
            .map(|p| p.is_file())
            .unwrap_or(false)
    }

    pub fn load_snapshot(&self, zone_id: &str) -> Result<Option<Vec<DNSRecord>>, StoreError> {
        let path = self.snapshot_path(zone_id)?;
        match read_json::<SnapshotFile>(&path, MAX_SNAPSHOT_BYTES) {
            Ok(Some(file)) => Ok(Some(file.records)),
            Ok(None) => Ok(None),
            Err(StoreError::SnapshotTooLarge(_)) => {
                Err(StoreError::SnapshotTooLarge(zone_id.into()))
            }
            Err(error) => Err(error),
        }
    }

    pub fn save_snapshot(
        &mut self,
        zone_id: &str,
        records: &[DNSRecord],
        now: DateTime<Utc>,
    ) -> Result<(), StoreError> {
        let path = self.snapshot_path(zone_id)?;
        let file = SnapshotFile {
            version: 1,
            zone_id: zone_id.to_string(),
            taken_at: format_ts(now),
            records: records.to_vec(),
        };
        let bytes = serde_json::to_vec(&file).map_err(|e| StoreError::Corrupt(e.to_string()))?;
        if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
            return Err(StoreError::SnapshotTooLarge(zone_id.into()));
        }
        write_bytes(&path, &bytes)?;
        let entry = self.state.zones.entry(zone_id.to_string()).or_default();
        entry.snapshot_taken_at = Some(format_ts(now));
        entry.snapshot_records = Some(records.len() as u32);
        Ok(())
    }

    pub fn delete_snapshot(&mut self, zone_id: &str) -> Result<bool, StoreError> {
        let path = self.snapshot_path(zone_id)?;
        if let Some(entry) = self.state.zones.get_mut(zone_id) {
            entry.snapshot_taken_at = None;
            entry.snapshot_records = None;
        }
        match fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(io_err("remove", &path, e)),
        }
    }

    pub fn delete_all_snapshots(&mut self) -> Result<usize, StoreError> {
        let dir = self.dir.join(SNAPSHOT_DIR);
        let mut removed = 0;
        let entries = fs::read_dir(&dir).map_err(|e| io_err("read directory", &dir, e))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                fs::remove_file(&path).map_err(|e| io_err("remove", &path, e))?;
                removed += 1;
            }
        }
        for zone in self.state.zones.values_mut() {
            zone.snapshot_taken_at = None;
            zone.snapshot_records = None;
        }
        self.save_state()?;
        Ok(removed)
    }

    pub fn snapshot_zone_ids(&self) -> Vec<String> {
        let dir = self.dir.join(SNAPSHOT_DIR);
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut ids: Vec<String> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    return None;
                }
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .map(str::to_string)
            })
            .collect();
        ids.sort();
        ids
    }
}

// ── file helpers ─────────────────────────────────────────────────────────────

fn read_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
    max_bytes: u64,
) -> Result<Option<T>, StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_err("inspect", path, e)),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(StoreError::Corrupt(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    if metadata.len() > max_bytes {
        if max_bytes == MAX_SNAPSHOT_BYTES {
            return Err(StoreError::SnapshotTooLarge(String::new()));
        }
        return Err(StoreError::Corrupt(format!(
            "{} exceeds {max_bytes} bytes",
            path.display()
        )));
    }
    let bytes = fs::read(path).map_err(|e| io_err("read", path, e))?;
    serde_json::from_slice::<T>(&bytes)
        .map(Some)
        .map_err(|e| StoreError::Corrupt(format!("{}: {e}", path.display())))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StoreError> {
    let bytes = serde_json::to_vec(value).map_err(|e| StoreError::Corrupt(e.to_string()))?;
    write_bytes(path, &bytes)
}

/// Write `bytes` to `path` via a private temp file + fsync + atomic replace.
fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| StoreError::Io("missing parent directory".into()))?;
    fs::create_dir_all(parent).map_err(|e| io_err("create directory", parent, e))?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let temp = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        set_private_mode(&mut options);
        let mut file = options
            .open(&temp)
            .map_err(|e| io_err("create temporary", &temp, e))?;
        file.write_all(bytes)
            .map_err(|e| io_err("write temporary", &temp, e))?;
        file.flush()
            .map_err(|e| io_err("flush temporary", &temp, e))?;
        file.sync_all()
            .map_err(|e| io_err("sync temporary", &temp, e))?;
        drop(file);
        atomic_replace(&temp, path).map_err(|e| io_err("replace", path, e))?;
        sync_parent(parent);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn set_private_mode(_options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        _options.mode(0o600);
    }
}

fn sync_parent(_parent: &Path) {
    #[cfg(unix)]
    {
        if let Ok(dir) = fs::File::open(_parent) {
            let _ = dir.sync_all();
        }
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
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both buffers are NUL-terminated UTF-16 strings that outlive the call.
    let ok = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
