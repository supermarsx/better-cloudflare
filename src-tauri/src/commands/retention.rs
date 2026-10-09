//! Commands for records that are gone from Cloudflare and kept here.
//!
//! Read [`bc_storage::retention`]'s header first. The one-sentence version:
//! **Cloudflare has no disabled state for a DNS record**, so "disable" is
//! implemented as delete-and-retain, and "re-enable" as create-again with a
//! new provider id. Nothing in this file pretends otherwise, and the UI must
//! not either.
//!
//! This is the layer where the three things the feature needs meet — the
//! retained-record store in `bc_storage`, the Cloudflare client in
//! `bc_cloudflare_api`, and the audit trail — because the store must not depend
//! on an HTTP client and the client must not know what a recycle bin is.
//!
//! # Ordering, and why it is this way round
//!
//! Retaining happens **before** the Cloudflare delete, always. If the entry
//! were written afterwards, a failure between the two steps would leave a
//! record that exists in no zone and in no store: gone, with no copy. Written
//! first, the same failure leaves an entry for a record that still exists,
//! which the restore path recognises (`already_present`) and the user can
//! discard. The worst case is over-retention, never loss.
//!
//! Restoring is the mirror image: the entry is dropped only after Cloudflare
//! has confirmed the new record. A restore never issues anything but a `POST`,
//! so it cannot overwrite a record that exists now; the pre-flight scan is
//! there to avoid creating a *duplicate* and to name what is in the way.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use bc_cloudflare_api::CloudflareError;
use bc_storage::retention::{
    self, DestinationReport, ExistingRecord, RecordSnapshot, RestoreObstacle, RetainedRecord,
    RetentionReason,
};
use bc_storage::{AuditActor, AuditEntry, AuditOutcome, AuditTrail, RetainOutcome};

use crate::cloudflare_api::{CloudflareClient, DNSRecord, DNSRecordInput};
use crate::notifications::NotificationManager;
use crate::storage::Storage;

use super::trail::{self, RecordFacts};

/// Records asked for per page while scanning a zone before a restore.
const RESTORE_SCAN_PER_PAGE: u32 = 1_000;

/// Pages scanned before the pre-flight gives up and lets Cloudflare be the
/// judge.
///
/// Ten thousand records is past the size of any zone a person administers by
/// hand. Beyond it the restore still goes ahead, with
/// `destination_unverified` set, because refusing to restore anything in a
/// large zone would be a worse answer than creating a record the provider is
/// perfectly willing to accept.
const RESTORE_SCAN_MAX_PAGES: u32 = 10;

// ── Wire shapes ─────────────────────────────────────────────────────────────

/// A record in the zone at the moment a restore was attempted.
#[derive(Clone, Debug, Serialize)]
pub struct ExistingRecordView {
    pub record_id: Option<String>,
    #[serde(rename = "type")]
    pub record_type: String,
    pub name: String,
    pub content: String,
}

impl From<&ExistingRecord> for ExistingRecordView {
    fn from(record: &ExistingRecord) -> Self {
        Self {
            record_id: record.record_id.clone(),
            record_type: record.record_type.clone(),
            name: record.name.clone(),
            content: record.content.clone(),
        }
    }
}

/// What the record snapshot the UI hands in looks like on the wire.
///
/// Field names match Cloudflare's, so the caller can pass the record it already
/// has rather than translating it. A translation is a place for a field to go
/// missing, and a field that goes missing here is a field the restore cannot
/// put back.
#[derive(Clone, Debug, Deserialize)]
pub struct RetainRecordInput {
    #[serde(rename = "type")]
    pub record_type: String,
    pub name: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub ttl: Option<u32>,
    #[serde(default)]
    pub priority: Option<u16>,
    #[serde(default)]
    pub proxied: Option<bool>,
    #[serde(default)]
    pub comment: Option<String>,
}

impl RetainRecordInput {
    fn into_snapshot(self) -> RecordSnapshot {
        RecordSnapshot {
            record_type: self.record_type,
            name: self.name,
            content: self.content,
            ttl: self.ttl,
            priority: self.priority,
            proxied: self.proxied,
            comment: self.comment,
        }
    }
}

/// What one retain decided.
///
/// A tagged union, because the two cases are not degrees of the same thing: in
/// one the record has been removed from Cloudflare, and in the other it is
/// still there and the user has to make room before it can be touched.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RetainDecision {
    /// The record is kept here and gone from Cloudflare.
    Retained {
        /// Address this entry by this from now on. The record's Cloudflare id
        /// is dead.
        entry_id: String,
        /// When the entry may be purged, or `null` for an indefinite disable.
        expires_at: Option<String>,
        /// Entries swept because their expiry had passed.
        purged: usize,
        /// Recycle-bin entries given up to make room. Non-zero means something
        /// restorable was forgotten; the audit trail names each one.
        evicted: usize,
    },
    /// **Nothing happened.** The record is still live at Cloudflare.
    ///
    /// The store is full of entries that may never be given up — disabled
    /// records, which exist nowhere else. The user has to empty or shrink the
    /// bin, or delete without keeping a copy. Refusing costs nothing; evicting
    /// a disabled record would destroy the only copy of it.
    StoreFull {
        held: usize,
        /// How many of those may never be given up.
        protected: usize,
        bytes_held: usize,
        max_bytes: usize,
        max_entries: usize,
        /// Expired entries swept before the refusal.
        purged: usize,
    },
}

/// The store, as the UI should show it.
#[derive(Debug, Serialize)]
pub struct RetainedStoreView {
    /// Entries that can still be restored, oldest first, exactly as stored —
    /// unknown fields from a newer build included.
    ///
    /// Expired entries are **not** here. The list and a purge are decided by
    /// the same clock, so the UI can never offer a restore the engine would
    /// refuse as expired.
    pub entries: Vec<Value>,
    /// Entries past their expiry that a purge has not reached yet. Non-zero is
    /// the UI's cue to call `purge_retained_records`.
    pub expired_pending_purge: usize,
    /// Everything held, expired included.
    pub total_held: usize,
    /// Serialised size of the whole store, and the budget it has.
    pub bytes_held: usize,
    pub max_bytes: usize,
    /// The entry cap in force, after clamping whatever was configured.
    pub max_entries: usize,
}

/// What one purge or clear did.
#[derive(Debug, Serialize)]
pub struct PurgeReport {
    pub purged: usize,
    pub remaining: usize,
}

/// How a restore ended.
///
/// A tagged union rather than an error string, because every one of these is a
/// different sentence for the user and several of them are not failures of this
/// application at all. `Err` is reserved for the store itself being
/// unreadable.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RestoreOutcome {
    /// The record is back in the zone, with a **new** Cloudflare id.
    Restored {
        entry_id: String,
        /// The newly created record. `record.id` is not the id it had before.
        record: Box<DNSRecord>,
        /// This application's own tags for the record, to be re-attached to
        /// `record.id`. They were keyed by the id that died.
        local_tags: Vec<String>,
        /// Records that now share the restored record's name, if any, so the
        /// UI can say what it was restored alongside.
        shares_name_with: Vec<ExistingRecordView>,
        /// `true` when the zone was too large to scan completely and
        /// Cloudflare was left to be the judge of conflicts.
        destination_unverified: bool,
        /// `false` when the record was created but the entry could not be
        /// dropped from the store. The restore succeeded; the bin now holds a
        /// stale entry that a later restore will report as `already_present`.
        entry_cleared: bool,
    },
    /// No entry with that id. A second click, or an entry already restored.
    NotFound { entry_id: String },
    /// The entry's expiry has passed. Deterministic regardless of when a purge
    /// last ran: what the UI listed and what a restore accepts agree.
    Expired {
        entry_id: String,
        expires_at: Option<String>,
    },
    /// The entry is missing something a restore needs. Only reachable for an
    /// entry written by something other than this application.
    Incomplete {
        entry_id: String,
        missing: Vec<String>,
    },
    /// The snapshot no longer describes a record Cloudflare would accept —
    /// a type this build has dropped, content that is no longer well formed.
    /// Reported before any network call.
    Invalid {
        entry_id: String,
        issues: Vec<String>,
    },
    /// Something is in the way at that name. Nothing was created, and the entry
    /// is untouched.
    Blocked {
        entry_id: String,
        /// `already_present` or `cname_collision`.
        obstacle: String,
        existing: ExistingRecordView,
    },
    /// The zone is gone, or this key can no longer see it. The entry is kept:
    /// a zone that comes back makes it restorable again.
    ZoneUnavailable {
        entry_id: String,
        zone_id: String,
        message: String,
    },
    /// Cloudflare refused the create, or the call did not complete. Nothing was
    /// half-applied here: the entry is kept exactly as it was.
    ProviderRefused { entry_id: String, message: String },
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Remove a record from Cloudflare and keep a complete copy here.
///
/// This is the one primitive behind both features. `reason` decides the intent
/// and the lifetime:
///
/// * `"disabled"` — indefinite, meant to be reversed. Pass `retention_days:
///   None`; a disable that expired would be a disable that deleted the user's
///   record while they were not looking.
/// * `"deleted"` — a recycle-bin entry. Pass the configured window; it is
///   clamped to 1–365 days here, so a mangled setting cannot produce a
///   zero-day bin.
///
/// `local_tags` are this application's own tags for the record. They are keyed
/// by the Cloudflare id that is about to die, so the caller reads them before
/// calling, passes them here, and clears them locally afterwards.
///
/// `operation_id` groups this deletion with the rest of the user action it
/// belongs to, and it is the whole reason a multi-record deletion can be undone
/// as one thing. **This is the command the UI deletes a selection through, one
/// record at a time** — `commands::dns::delete_bulk_dns_records` is handed ids
/// and keeps no copy, so it cannot be undone at all. Thirty-seven calls to this
/// command with one shared id are one undoable operation; thirty-seven calls
/// without it are thirty-seven. Omit it and each deletion is an operation of
/// one, with an id minted here; see [`trail::OperationId`] for why a supplied
/// id is validated rather than trusted.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn retain_dns_record(
    storage: State<'_, Storage>,
    notifications: State<'_, NotificationManager>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    zone_name: Option<String>,
    record_id: String,
    record: RetainRecordInput,
    reason: String,
    retention_days: Option<u32>,
    local_tags: Option<Vec<String>>,
    max_entries: Option<u32>,
    operation_id: Option<String>,
) -> Result<RetainDecision, String> {
    let now = Utc::now();
    let action = trail::OperationId::of(operation_id.as_deref());
    let entry_limit = retention::clamp_entry_limit(
        max_entries.map_or(retention::MAX_RETAINED_ENTRIES, |limit| limit as usize),
    );
    let snapshot = record.into_snapshot();
    // Taken before the snapshot is moved into the entry. This is the record
    // the trail has to be able to describe: after the delete it exists only in
    // the store, and after a purge or an eviction not even there.
    let facts = RecordFacts::of_snapshot(&snapshot);
    let reason_kind = RetentionReason::of(&reason);
    let entry = retained_entry(
        &reason,
        &zone_id,
        zone_name.as_deref().unwrap_or_default(),
        &record_id,
        snapshot,
        local_tags.as_deref().unwrap_or_default(),
        &action,
        retention_days,
        now,
    );
    let expires_at = entry.expires_at.map(|at| at.to_rfc3339());

    // Retain first. See the module header: the destructive step must not be
    // able to run without the copy already safe.
    let outcome = storage
        .retain_record(entry.into_value(), entry_limit, now)
        .await
        .map_err(|error| {
            record_retain_failure(
                &storage,
                &reason,
                &zone_id,
                &record_id,
                Some(&facts),
                &error.to_string(),
                &action,
            );
            format!("The record was not removed, because it could not be kept first: {error}")
        })?;

    let (entry_id, purged, evicted) = match outcome {
        RetainOutcome::Retained {
            entry_id,
            purged,
            evicted,
        } => (entry_id, purged, evicted),
        // The bin cannot make room without giving up a disabled record, which
        // is the only copy of something already gone from Cloudflare. Refuse,
        // and — this is the point — do **not** delete. The record stays live,
        // which the user can recover from; a forgotten disable they cannot.
        RetainOutcome::StoreFull {
            purged,
            held,
            protected,
            bytes_held,
        } => {
            trail::record_purged(&*storage, &purged);
            storage.record(trail::describe_record(
                trail::stamp(
                    AuditEntry::new(
                        AuditActor::User,
                        retain_operation(reason_kind),
                        AuditOutcome::Denied,
                    ),
                    &action,
                )
                .resource(&record_id)
                .detail("zone_id", zone_id.as_str())
                .detail("reason", reason.as_str())
                // `denied_by` rather than `failure`: nothing was dispatched,
                // and `failure` is the key a *failed* call uses. One
                // vocabulary across the whole trail — see `commands::trail`.
                .detail("denied_by", "store_full")
                .detail("protected_entries", protected as u64),
                &facts,
            ));
            return Ok(RetainDecision::StoreFull {
                held,
                protected,
                bytes_held,
                max_bytes: retention::MAX_RETAINED_BYTES,
                max_entries: entry_limit,
                purged: purged.len(),
            });
        }
    };

    let client = CloudflareClient::new(&api_key, email.as_deref());
    if let Err(error) = client.delete_dns_record(&zone_id, &record_id).await {
        // The delete failed, so the record is still live and the entry we just
        // wrote describes something that exists. Drop it again. If that also
        // fails the entry simply stays, and a later restore says
        // `already_present` — visible and harmless, unlike the alternative.
        let _ = storage.forget_retained_record(&entry_id).await;
        let message = error.to_string();
        record_retain_failure(
            &storage,
            &reason,
            &zone_id,
            &record_id,
            Some(&facts),
            &message,
            &action,
        );
        return Err(message);
    }

    notifications.ledger().note(&zone_id, &record_id, "delete");

    storage.record(trail::describe_record(
        trail::stamp(
            AuditEntry::new(
                AuditActor::User,
                retain_operation(reason_kind),
                AuditOutcome::Succeeded,
            ),
            &action,
        )
        .resource(&record_id)
        .detail("zone_id", zone_id.as_str())
        .detail("reason", reason.as_str())
        .detail("retention_entry_id", entry_id.as_str())
        .optional_detail("retained_until", expires_at.clone()),
        &facts,
    ));
    trail::record_purged(&*storage, &purged);
    for item in &evicted {
        trail::record_evicted(&*storage, &item.entry, item.cause);
    }

    Ok(RetainDecision::Retained {
        entry_id,
        expires_at,
        purged: purged.len(),
        evicted: evicted.len(),
    })
}

/// Everything still restorable, plus what the store is spending.
///
/// Reading does not purge. A purge is a destructive act and it gets its own
/// command, so opening a screen cannot delete anything; the expired entries are
/// merely counted and hidden.
#[tauri::command]
pub async fn list_retained_records(
    storage: State<'_, Storage>,
    max_entries: Option<u32>,
) -> Result<RetainedStoreView, String> {
    let now = Utc::now();
    let held = storage
        .get_retained_records()
        .await
        .map_err(|error| error.to_string())?;
    let bytes_held = serde_json::to_string(&held)
        .map(|raw| raw.len())
        .unwrap_or(0);
    let total_held = held.len();
    // Only what the bin can put back. The store is shared: since the zone
    // History subtab landed it also holds `superseded` snapshots — the state a
    // record held before an edit, where the record itself is still at the
    // provider — and `operation_manifest` entries, which carry record ids and
    // no record at all. Listing either here would offer a restore that
    // `restore_retained_record` then refuses as `already_present`, so the bin
    // would fill with "deleted records" that were never deleted. This field is
    // documented as entries that can still be restored, and a reason filter is
    // what makes that true rather than aspirational.
    //
    // The counters below stay store-wide on purpose. `total_held` and
    // `bytes_held` are rendered as "N of 1000 entries, X KB of Y KB", which is
    // a statement about capacity, and the bin really does compete for those
    // slots with undo material. Filtering them would show "12 of 1000" while
    // evictions happened, which would misexplain why a bin entry vanished.
    let (entries, expired): (Vec<Value>, Vec<Value>) = held
        .into_iter()
        .filter(|entry| {
            matches!(
                retention::reason_of(entry),
                retention::RetentionReason::Disabled | retention::RetentionReason::Deleted
            )
        })
        .partition(|entry| !retention::is_expired(entry, now));

    Ok(RetainedStoreView {
        entries,
        expired_pending_purge: expired.len(),
        total_held,
        bytes_held,
        max_bytes: retention::MAX_RETAINED_BYTES,
        max_entries: retention::clamp_entry_limit(
            max_entries.map_or(retention::MAX_RETAINED_ENTRIES, |limit| limit as usize),
        ),
    })
}

/// Create a retained record again, in the zone it came from.
///
/// Serves both re-enable and restore-from-bin: the entry's reason says which
/// one the user called it, and the mechanism is identical. Never issues
/// anything but a create, so it cannot overwrite a record that exists now.
///
/// The returned record carries a **new** Cloudflare id. Anything the caller
/// keyed on the old one — this application's tags above all — has to be moved
/// across; `local_tags` in the result is what to move.
#[tauri::command]
pub async fn restore_retained_record(
    storage: State<'_, Storage>,
    notifications: State<'_, NotificationManager>,
    api_key: String,
    email: Option<String>,
    entry_id: String,
) -> Result<RestoreOutcome, String> {
    let now = Utc::now();
    let held = storage
        .get_retained_records()
        .await
        .map_err(|error| error.to_string())?;
    let Some(entry) = held
        .iter()
        .find(|entry| retention::entry_id_of(entry) == Some(entry_id.as_str()))
        .and_then(RetainedRecord::of)
    else {
        return Ok(RestoreOutcome::NotFound { entry_id });
    };

    if entry.is_expired(now) {
        return Ok(RestoreOutcome::Expired {
            expires_at: entry.expires_at.map(|at| at.to_rfc3339()),
            entry_id,
        });
    }
    let missing = missing_restore_fields(&entry);
    if !missing.is_empty() {
        return Ok(RestoreOutcome::Incomplete { entry_id, missing });
    }

    let input = DNSRecordInput {
        r#type: entry.snapshot.record_type.clone(),
        name: entry.snapshot.name.clone(),
        content: entry.snapshot.content.clone(),
        comment: entry.snapshot.comment.clone(),
        ttl: entry.snapshot.ttl,
        priority: entry.snapshot.priority,
        proxied: entry.snapshot.proxied,
    };
    let validation = bc_dns_tools::validate_record_input(&input);
    if !validation.ok {
        record_restore_failure(&storage, &entry, "invalid", &validation.issues.join("; "));
        return Ok(RestoreOutcome::Invalid {
            entry_id,
            issues: validation.issues,
        });
    }

    let client = CloudflareClient::new(&api_key, email.as_deref());
    let (existing, destination_unverified) = match scan_zone(&client, &entry.zone_id).await {
        Ok(scanned) => scanned,
        Err(error) => {
            let message = error.to_string();
            if is_zone_unavailable(&error) {
                record_restore_failure(&storage, &entry, "zone_unavailable", &message);
                return Ok(RestoreOutcome::ZoneUnavailable {
                    entry_id,
                    zone_id: entry.zone_id.clone(),
                    message,
                });
            }
            record_restore_failure(&storage, &entry, "provider_refused", &message);
            return Ok(RestoreOutcome::ProviderRefused { entry_id, message });
        }
    };

    let DestinationReport {
        obstacle,
        occupants,
    } = retention::inspect_destination(&entry.snapshot, &existing);
    if let Some(obstacle) = obstacle {
        let existing = ExistingRecordView::from(obstacle.existing());
        let kind = obstacle.as_str().to_string();
        record_restore_failure(&storage, &entry, &kind, describe_obstacle(&obstacle));
        return Ok(RestoreOutcome::Blocked {
            entry_id,
            obstacle: kind,
            existing,
        });
    }

    let created = match client.create_dns_record(&entry.zone_id, input).await {
        Ok(created) => created,
        Err(error) => {
            let message = error.to_string();
            record_restore_failure(&storage, &entry, "provider_refused", &message);
            return Ok(RestoreOutcome::ProviderRefused { entry_id, message });
        }
    };

    if let Some(new_id) = created.id.as_deref() {
        notifications
            .ledger()
            .note(&entry.zone_id, new_id, "create");
    }
    // Only now is the entry expendable: the record is confirmed back.
    let entry_cleared = storage.forget_retained_record(&entry_id).await.is_ok();

    storage.record(trail::describe_record(
        AuditEntry::new(AuditActor::User, "dns:restore", AuditOutcome::Succeeded)
            .resource(created.id.as_deref().unwrap_or_default())
            .detail("zone_id", entry.zone_id.as_str())
            .detail("reason", entry.reason.as_str())
            .detail("retention_entry_id", entry_id.as_str())
            .optional_detail("origin_record_id", entry.origin_record_id.clone()),
        &RecordFacts::of_record(&created),
    ));

    Ok(RestoreOutcome::Restored {
        entry_id,
        record: Box::new(created),
        local_tags: entry.local_tags,
        shares_name_with: occupants.iter().map(ExistingRecordView::from).collect(),
        destination_unverified,
        entry_cleared,
    })
}

/// Drop every entry whose expiry has passed.
///
/// Idempotent, and safe to call on launch and on opening the bin: it takes
/// exactly the entries the list was already hiding.
#[tauri::command]
pub async fn purge_retained_records(storage: State<'_, Storage>) -> Result<PurgeReport, String> {
    let purged = storage
        .purge_retained_records(Utc::now())
        .await
        .map_err(|error| error.to_string())?;
    trail::record_purged(&*storage, &purged);
    let remaining = storage
        .get_retained_records()
        .await
        .map(|held| held.len())
        .unwrap_or(0);
    Ok(PurgeReport {
        purged: purged.len(),
        remaining,
    })
}

/// Discard one entry without restoring it.
///
/// The record is then gone for good — it is not in the zone and no longer here
/// — so this belongs behind a confirmation. `false` means there was no such
/// entry, which is not an error.
#[tauri::command]
pub async fn forget_retained_record(
    storage: State<'_, Storage>,
    entry_id: String,
) -> Result<bool, String> {
    let dropped = storage
        .forget_retained_record(&entry_id)
        .await
        .map_err(|error| error.to_string())?;
    let Some(entry) = dropped.as_ref().and_then(RetainedRecord::of) else {
        return Ok(false);
    };
    // The record is now gone for good — not in the zone, and no longer kept
    // here — so this entry is the last description of it that will exist.
    storage.record(trail::describe_record(
        AuditEntry::new(
            AuditActor::User,
            "retention:discard",
            AuditOutcome::Succeeded,
        )
        .resource(entry.origin_record_id.as_deref().unwrap_or_default())
        .detail("zone_id", entry.zone_id.as_str())
        .detail("reason", entry.reason.as_str())
        .detail("retention_entry_id", entry_id.as_str()),
        &RecordFacts::of_snapshot(&entry.snapshot),
    ));
    Ok(true)
}

/// Empty the store.
///
/// Every entry this drops is a record that exists nowhere else, disabled ones
/// included, so it belongs behind a clear confirmation that says so.
#[tauri::command]
pub async fn clear_retained_records(storage: State<'_, Storage>) -> Result<PurgeReport, String> {
    let cleared = storage
        .clear_retained_records()
        .await
        .map_err(|error| error.to_string())?;
    if !cleared.is_empty() {
        storage.record(
            AuditEntry::new(AuditActor::User, "retention:clear", AuditOutcome::Succeeded)
                .detail("entries", cleared.len() as u64)
                .detail(
                    "disabled_entries",
                    cleared
                        .iter()
                        .filter(|entry| retention::reason_of(entry) == RetentionReason::Disabled)
                        .count() as u64,
                ),
        );
    }
    Ok(PurgeReport {
        purged: cleared.len(),
        remaining: 0,
    })
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// The trail name for a retain, derived from the reason so a reader looking for
/// deletions finds binned ones under `dns:delete` and a parked record under its
/// own name.
/// `superseded` and `operation_manifest` are grouped with `unknown` rather than
/// given names of their own, because this command never produces either: the
/// state an edit replaced is retained by `commands::dns::update_dns_record`,
/// which still holds the record it is about to change, and a manifest is
/// written by `commands::dns::create_bulk_dns_records`, which deleted nothing
/// at all. Both arriving *here* would mean a caller asked to delete a record
/// and file the copy as something other than a deletion, which is a caller
/// error and not an operation worth a name of its own.
///
/// Matched exhaustively on purpose. A wildcard would compile silently the next
/// time a reason is added, and the whole point of this function is that someone
/// decides what the new one is called.
fn retain_operation(reason: RetentionReason) -> &'static str {
    match reason {
        RetentionReason::Disabled => "dns:disable",
        RetentionReason::Deleted => "dns:delete",
        RetentionReason::Superseded | RetentionReason::Manifest | RetentionReason::Unknown => {
            "dns:retain"
        }
    }
}

/// How long an entry is kept, from the reason it is kept for.
///
/// A named function rather than a `match` inside the command, because the
/// decision is worth a test of its own and a test that re-implements the match
/// cannot dissent from it. That is not hypothetical: the previous version of
/// this rule lived inline, the test beside it carried its own copy of the
/// match, and the copy agreed with the bug.
///
/// * **A disable is indefinite.** Not because it is precious in the abstract,
///   but because the record exists nowhere else and the user parked it meaning
///   to put it back — an expiry would be this application deleting their record
///   while they were not looking. The configured window is a *bin* window and
///   not a deadline on that.
/// * **An unknown reason is indefinite too**, for the same reason read the
///   other way: over-retaining something this build cannot classify is the safe
///   direction, because it may be the only copy.
/// * **Everything that is undo material expires on the window.** A binned
///   record, the state an edit replaced, and the ids an import created are all
///   things whose loss costs a revert and never the data. `Superseded` used to
///   fall through to "indefinite" here, which was not a leak — eviction gives
///   superseded entries up first — but it was worse than one: those entries
///   left by eviction rather than by age, so they accumulated silently and then
///   vanished in a burst once the store filled, and the reason the history list
///   showed for a missing undo was `evicted` when the honest answer was
///   `expired`.
///
/// Matched without a wildcard, so the next reason added has to be decided about
/// rather than silently kept for ever.
fn retention_window(reason: RetentionReason, configured: Option<u32>) -> Option<u32> {
    match reason {
        RetentionReason::Deleted | RetentionReason::Superseded | RetentionReason::Manifest => {
            configured.or(Some(retention::DEFAULT_RETENTION_DAYS))
        }
        RetentionReason::Disabled | RetentionReason::Unknown => None,
    }
}

/// The store entry one retain writes.
///
/// Assembled here rather than inline in the command for the same reason
/// [`retention_window`] is a function: the two things most worth asserting
/// about a retain are that it carries the operation id — without which the
/// deletion can never be undone as part of the action it belongs to — and that
/// it carries the right expiry. Neither is reachable from a test of the command
/// itself, which needs managed Tauri state and a provider.
#[allow(clippy::too_many_arguments)]
fn retained_entry(
    reason: &str,
    zone_id: &str,
    zone_name: &str,
    record_id: &str,
    snapshot: RecordSnapshot,
    local_tags: &[String],
    action: &trail::OperationId,
    retention_days: Option<u32>,
    now: DateTime<Utc>,
) -> RetainedRecord {
    RetainedRecord::new(reason, zone_id, zone_name)
        .origin_record_id(record_id)
        .operation_id(action.as_str())
        .snapshot(snapshot)
        .local_tags(local_tags)
        .removed_at(now)
        // After `removed_at`, which the window is measured from.
        .expiring_after(
            retention_window(RetentionReason::of(reason), retention_days),
            now,
        )
}

/// What an entry is missing before it can be restored, in words a UI can show.
fn missing_restore_fields(entry: &RetainedRecord) -> Vec<String> {
    let mut missing = Vec::new();
    if entry.zone_id.is_empty() {
        missing.push("zone_id".to_string());
    }
    if entry.snapshot.record_type.is_empty() {
        missing.push("type".to_string());
    }
    if entry.snapshot.name.is_empty() {
        missing.push("name".to_string());
    }
    missing
}

fn describe_obstacle(obstacle: &RestoreObstacle) -> &'static str {
    match obstacle {
        RestoreObstacle::AlreadyPresent { .. } => "a matching record is already in the zone",
        RestoreObstacle::CnameCollision { .. } => "a CNAME cannot share the name",
    }
}

/// Read the zone's records, up to [`RESTORE_SCAN_MAX_PAGES`].
///
/// Returns the records and whether the scan was complete. An incomplete scan is
/// reported rather than treated as a conflict: Cloudflare still refuses a real
/// collision on the create.
async fn scan_zone(
    client: &CloudflareClient,
    zone_id: &str,
) -> Result<(Vec<ExistingRecord>, bool), CloudflareError> {
    let mut existing = Vec::new();
    for page in 1..=RESTORE_SCAN_MAX_PAGES {
        let records = client
            .get_dns_records(zone_id, Some(page), Some(RESTORE_SCAN_PER_PAGE))
            .await?;
        let complete = records.len() < RESTORE_SCAN_PER_PAGE as usize;
        existing.extend(records.into_iter().map(|record| ExistingRecord {
            record_id: record.id,
            record_type: record.r#type,
            name: record.name,
            content: record.content,
        }));
        if complete {
            return Ok((existing, false));
        }
    }
    Ok((existing, true))
}

/// Whether the zone itself is the problem, rather than the request.
///
/// A 404 means the zone is gone from this account; a 403 means this key can no
/// longer see it. Either way the entry is worth keeping, because a zone that
/// comes back makes it restorable again — which is the opposite of what a
/// caller should conclude from a validation refusal.
fn is_zone_unavailable(error: &CloudflareError) -> bool {
    match error {
        CloudflareError::Verification(detail) | CloudflareError::Request(detail) => {
            matches!(detail.status, Some(403 | 404))
        }
        CloudflareError::AuthFailed => true,
        _ => false,
    }
}

#[allow(clippy::too_many_arguments)]
fn record_retain_failure(
    storage: &Storage,
    reason: &str,
    zone_id: &str,
    record_id: &str,
    facts: Option<&RecordFacts>,
    message: &str,
    action: &trail::OperationId,
) {
    let entry = trail::stamp(
        AuditEntry::new(
            AuditActor::User,
            retain_operation(RetentionReason::of(reason)),
            AuditOutcome::Failed,
        ),
        action,
    )
    .resource(record_id)
    .detail("zone_id", zone_id)
    .detail("reason", reason)
    .detail("error", message);
    storage.record(match facts {
        Some(facts) => trail::describe_record(entry, facts),
        None => entry,
    });
}

fn record_restore_failure(storage: &Storage, entry: &RetainedRecord, kind: &str, message: &str) {
    storage.record(trail::describe_record(
        AuditEntry::new(AuditActor::User, "dns:restore", AuditOutcome::Failed)
            .resource(entry.origin_record_id.as_deref().unwrap_or_default())
            .detail("zone_id", entry.zone_id.as_str())
            .detail("reason", entry.reason.as_str())
            .detail("retention_entry_id", entry.entry_id.as_str())
            .detail("failure", kind)
            .detail("error", message),
        &RecordFacts::of_snapshot(&entry.snapshot),
    ));
}

// `record_purged` and `record_evicted` used to live here. They are in
// `commands::trail` now, because this is no longer the only caller of
// `Storage::retain_record`: `commands::dns` retains the state an edit
// supersedes and the ids a bulk create produced, and every caller owes the log
// the same account of what its write cost the store. The trail-module versions
// also stamp the operation id, which these could not, and take the trail rather
// than the store so what they write can be asserted without standing one up.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_trail_name_follows_the_reason_so_deletions_stay_findable() {
        assert_eq!(retain_operation(RetentionReason::Deleted), "dns:delete");
        assert_eq!(retain_operation(RetentionReason::Disabled), "dns:disable");
        assert_eq!(
            retain_operation(RetentionReason::Unknown),
            "dns:retain",
            "a reason this build cannot name still produces a readable event"
        );
    }

    #[test]
    fn an_entry_reports_exactly_which_fields_a_restore_is_missing() {
        let complete = RetainedRecord::of(&json!({
            "entry_id": "ret_1",
            "zone_id": "zone-1",
            "type": "A",
            "name": "www.example.com",
        }))
        .expect("parses");
        assert!(missing_restore_fields(&complete).is_empty());

        let bare = RetainedRecord::of(&json!({ "entry_id": "ret_2" })).expect("parses");
        assert_eq!(
            missing_restore_fields(&bare),
            vec!["zone_id", "type", "name"],
            "the UI needs to say what is wrong, not just that something is"
        );
    }

    #[test]
    fn a_missing_zone_is_told_apart_from_a_refused_request() {
        let gone = CloudflareError::Request(Box::new(bc_cloudflare_api::CloudflareRequestError {
            kind: bc_cloudflare_api::VerificationFailureKind::Provider,
            message: "zone not found".to_string(),
            status: Some(404),
            source: bc_cloudflare_api::VerificationErrorSource::Cloudflare,
            operation: "dns:list".to_string(),
            retryable: false,
            provider_errors: Vec::new(),
            retry_after_secs: None,
            remediation: String::new(),
            request_id: None,
        }));
        assert!(is_zone_unavailable(&gone));

        let refused =
            CloudflareError::Request(Box::new(bc_cloudflare_api::CloudflareRequestError {
                kind: bc_cloudflare_api::VerificationFailureKind::Provider,
                message: "content is invalid".to_string(),
                status: Some(400),
                source: bc_cloudflare_api::VerificationErrorSource::Cloudflare,
                operation: "dns:create".to_string(),
                retryable: false,
                provider_errors: Vec::new(),
                retry_after_secs: None,
                remediation: String::new(),
                request_id: None,
            }));
        assert!(
            !is_zone_unavailable(&refused),
            "a validation refusal must not read as a zone that might come back"
        );
        assert!(!is_zone_unavailable(&CloudflareError::RateLimited(3)));
    }

    #[test]
    fn a_disable_never_gets_an_expiry_however_the_caller_was_configured() {
        let now = Utc::now();
        for reason in [RetentionReason::DISABLED, "quarantined"] {
            let entry = RetainedRecord::new(reason, "zone-1", "example.com")
                .removed_at(now)
                .expiring_after(retention_window(RetentionReason::of(reason), Some(30)), now);
            assert_eq!(
                entry.expires_at, None,
                "{reason} is indefinite; an expiry here would delete a parked record"
            );
        }
    }

    #[test]
    fn every_kind_of_undo_material_expires_rather_than_waiting_to_be_evicted() {
        // The bug this exists for: `superseded` fell through to "indefinite",
        // so an edit's undo material was never purged by age. It still left the
        // store, by eviction — which means it accumulated quietly and then went
        // in a burst, and the history list said `evicted` where the truthful
        // answer was `expired`.
        for reason in [
            RetentionReason::DELETED,
            RetentionReason::SUPERSEDED,
            RetentionReason::MANIFEST,
        ] {
            assert_eq!(
                retention_window(RetentionReason::of(reason), Some(7)),
                Some(7),
                "{reason} is undo material and takes the configured window"
            );
            assert_eq!(
                retention_window(RetentionReason::of(reason), None),
                Some(retention::DEFAULT_RETENTION_DAYS),
                "{reason} must never end up indefinite because nothing was configured"
            );
        }
    }

    #[test]
    fn a_retained_deletion_carries_the_action_it_belongs_to() {
        // Without this the entry cannot be found by operation id, so a
        // thirty-seven-record deletion is thirty-seven separate undos and the
        // zone history list cannot group it. It is one builder call, and it is
        // the whole mechanism.
        let action = trail::OperationId::mint();
        let entry = retained_entry(
            RetentionReason::DELETED,
            "zone-1",
            "example.com",
            "record-1",
            RecordSnapshot {
                record_type: "A".to_string(),
                name: "www.example.com".to_string(),
                content: "203.0.113.1".to_string(),
                ttl: Some(300),
                priority: None,
                proxied: Some(false),
                comment: None,
            },
            &["billing".to_string()],
            &action,
            Some(7),
            Utc::now(),
        );

        assert_eq!(entry.operation_id.as_deref(), Some(action.as_str()));
        assert_eq!(entry.origin_record_id.as_deref(), Some("record-1"));
        assert!(
            entry.expires_at.is_some(),
            "a binned record takes the configured window"
        );
        assert_eq!(
            entry.local_tags,
            vec!["billing".to_string()],
            "the tags are keyed by the id that is about to die, so a restore needs them"
        );
        // And the id survives the round trip through the store's wire form,
        // which is where it would silently be spent out of the byte budget.
        let stored = entry.into_value();
        assert_eq!(
            retention::operation_id_of(&stored),
            Some(action.as_str()),
            "an operation id that does not survive serialisation is an undo that cannot \
             be found"
        );
    }

    #[test]
    fn a_disabled_record_is_still_grouped_even_though_it_never_expires() {
        let action = trail::OperationId::mint();
        let entry = retained_entry(
            RetentionReason::DISABLED,
            "zone-1",
            "example.com",
            "record-1",
            RecordSnapshot::default(),
            &[],
            &action,
            Some(7),
            Utc::now(),
        );
        assert_eq!(entry.operation_id.as_deref(), Some(action.as_str()));
        assert_eq!(
            entry.expires_at, None,
            "grouping and lifetime are separate decisions"
        );
    }

    #[test]
    fn a_reason_this_build_cannot_classify_is_kept_rather_than_aged_out() {
        assert_eq!(
            retention_window(RetentionReason::of("something-from-a-newer-build"), Some(7)),
            None,
            "over-retaining what cannot be classified is the safe direction: it may be \
             the only copy"
        );
    }

    #[test]
    fn a_refused_retain_is_told_apart_from_a_successful_one_on_the_wire() {
        // The caller must be able to see "nothing happened, the record is still
        // live" without parsing a message. A shared struct with a flag would
        // let a caller read `entry_id` off a refusal.
        let full = serde_json::to_value(RetainDecision::StoreFull {
            held: 10,
            protected: 10,
            bytes_held: 4_096,
            max_bytes: retention::MAX_RETAINED_BYTES,
            max_entries: 10,
            purged: 0,
        })
        .expect("serialise");
        assert_eq!(full["status"], json!("store_full"));
        assert_eq!(full["protected"], json!(10));
        assert!(
            full.get("entry_id").is_none(),
            "a refusal has no entry, because nothing was stored"
        );

        let kept = serde_json::to_value(RetainDecision::Retained {
            entry_id: "ret_1".to_string(),
            expires_at: None,
            purged: 0,
            evicted: 0,
        })
        .expect("serialise");
        assert_eq!(kept["status"], json!("retained"));
        assert_eq!(kept["entry_id"], json!("ret_1"));
    }

    #[test]
    fn the_restore_outcome_is_tagged_so_a_caller_can_switch_on_it() {
        let blocked = RestoreOutcome::Blocked {
            entry_id: "ret_1".to_string(),
            obstacle: "already_present".to_string(),
            existing: ExistingRecordView {
                record_id: Some("cf-1".to_string()),
                record_type: "A".to_string(),
                name: "www.example.com".to_string(),
                content: "203.0.113.1".to_string(),
            },
        };
        let value = serde_json::to_value(&blocked).expect("serialise");
        assert_eq!(value["status"], json!("blocked"));
        assert_eq!(value["obstacle"], json!("already_present"));
        assert_eq!(value["existing"]["type"], json!("A"));

        let not_found = serde_json::to_value(RestoreOutcome::NotFound {
            entry_id: "ret_2".to_string(),
        })
        .expect("serialise");
        assert_eq!(not_found["status"], json!("not_found"));
    }
}
