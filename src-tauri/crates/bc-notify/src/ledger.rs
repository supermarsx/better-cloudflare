//! Ledger of this app's own DNS mutations so the snapshot diff can skip them.

use std::collections::VecDeque;
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};

pub const LEDGER_TTL_MINUTES: i64 = 60;
pub const LEDGER_MAX_ENTRIES: usize = 10_000;

#[derive(Debug, Clone)]
struct Entry {
    zone_id: String,
    record_id: String,
    op: String,
    noted_at: DateTime<Utc>,
}

/// Thread-safe, bounded, TTL-pruned set of `(zone_id, record_id)` pairs.
#[derive(Debug, Default)]
pub struct OwnChangeLedger {
    entries: Mutex<VecDeque<Entry>>,
}

impl OwnChangeLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn note(&self, zone_id: &str, record_id: &str, op: &str) {
        self.note_at(zone_id, record_id, op, Utc::now());
    }

    pub fn note_at(&self, zone_id: &str, record_id: &str, op: &str, now: DateTime<Utc>) {
        let mut entries = self.lock();
        Self::prune_locked(&mut entries, now);
        entries.push_back(Entry {
            zone_id: zone_id.to_string(),
            record_id: record_id.to_string(),
            op: op.to_string(),
            noted_at: now,
        });
        while entries.len() > LEDGER_MAX_ENTRIES {
            entries.pop_front();
        }
    }

    /// Remove every live entry for the pair; `true` when at least one existed.
    pub fn consume(&self, zone_id: &str, record_id: &str) -> bool {
        self.consume_at(zone_id, record_id, Utc::now())
    }

    pub fn consume_at(&self, zone_id: &str, record_id: &str, now: DateTime<Utc>) -> bool {
        let mut entries = self.lock();
        Self::prune_locked(&mut entries, now);
        let before = entries.len();
        entries.retain(|e| !(e.zone_id == zone_id && e.record_id == record_id));
        entries.len() != before
    }

    pub fn prune(&self, now: DateTime<Utc>) {
        Self::prune_locked(&mut self.lock(), now);
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Operation names recorded for a pair (diagnostics).
    pub fn ops_for(&self, zone_id: &str, record_id: &str) -> Vec<String> {
        self.lock()
            .iter()
            .filter(|e| e.zone_id == zone_id && e.record_id == record_id)
            .map(|e| e.op.clone())
            .collect()
    }

    fn prune_locked(entries: &mut VecDeque<Entry>, now: DateTime<Utc>) {
        let cutoff = now - Duration::minutes(LEDGER_TTL_MINUTES);
        entries.retain(|e| e.noted_at > cutoff);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
