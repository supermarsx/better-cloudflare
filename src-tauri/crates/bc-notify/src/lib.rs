//! Background notification logic for Better Cloudflare (no Tauri, no UI):
//! domain-expiry milestones, out-of-app record change detection via snapshot
//! diffs, dedupe, an on-disk inbox and the settings model shared with the UI.
//!
//! The Tauri layer (`src-tauri/src/notifications.rs`) owns scheduling and the
//! API token; this crate exposes two idempotent passes:
//! [`run_record_pass`] and [`run_expiry_pass`].

pub mod diff;
pub mod expiry;
pub mod ledger;
pub mod model;
pub mod rdap;
pub mod settings;
pub mod store;

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use bc_cloudflare_api::{CloudflareClient, CloudflareError};
use bc_cloudflare_api::{DNSRecord, Zone};
use bc_registrar::types::DomainInfo;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub use diff::{
    build_change_notification, change_dedupe_key, diff_snapshots, ChangeKind, DiffField,
    RecordChange, RecordFingerprint, RecordValues,
};
pub use expiry::{
    build_expiry_notification, days_left, due_milestone, normalize_milestones, parse_rdap_expiry,
    EXPIRED_MILESTONE,
};
pub use ledger::OwnChangeLedger;
pub use model::{
    format_ts, parse_ts, Notification, NotificationKind, NotificationQuery, Scope, Severity,
};
pub use rdap::{fetch_rdap_expiry, is_valid_hostname, RdapError};
pub use settings::{NotificationSettings, QuietBehaviour};
pub use store::{DomainExpiryState, NotifyState, NotifyStore, StoreError, ZoneState};

/// Records per page requested from Cloudflare (its maximum).
pub const RECORDS_PER_PAGE: u32 = 5_000;
/// Pause between zones inside one pass (rate-limit courtesy).
pub const INTER_ZONE_DELAY: Duration = Duration::from_millis(250);
/// After a failed RDAP lookup, do not retry the domain before this many hours.
pub const RDAP_RETRY_HOURS: i64 = 6;

/// Minimal zone reference used by the passes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZoneRef {
    pub id: String,
    pub name: String,
}

impl From<&Zone> for ZoneRef {
    fn from(zone: &Zone) -> Self {
        Self {
            id: zone.id.clone(),
            name: zone.name.clone(),
        }
    }
}

/// Source of zones and records. Implemented for `CloudflareClient`; tests use a fake.
#[allow(async_fn_in_trait)]
pub trait ZoneSource {
    async fn list_zones(&self) -> Result<Vec<ZoneRef>, String>;
    async fn list_records(
        &self,
        zone_id: &str,
        page: u32,
        per_page: u32,
    ) -> Result<Vec<DNSRecord>, String>;
}

impl ZoneSource for CloudflareClient {
    async fn list_zones(&self) -> Result<Vec<ZoneRef>, String> {
        self.get_zones()
            .await
            .map(|zones| zones.iter().map(ZoneRef::from).collect())
            .map_err(describe_cf_error)
    }

    async fn list_records(
        &self,
        zone_id: &str,
        page: u32,
        per_page: u32,
    ) -> Result<Vec<DNSRecord>, String> {
        self.get_dns_records(zone_id, Some(page), Some(per_page))
            .await
            .map_err(describe_cf_error)
    }
}

fn describe_cf_error(error: CloudflareError) -> String {
    match &error {
        CloudflareError::RateLimited(_) => format!("rate limited: {error}"),
        CloudflareError::AuthFailed => "authentication failed".to_string(),
        _ => error.to_string(),
    }
}

/// True when an error message came from a 429/5xx-class failure (drives backoff).
pub fn is_backoff_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("rate limit")
        || lower.contains("429")
        || lower.contains("500")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
        || lower.contains("server error")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PassKind {
    Records,
    Expiry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassReport {
    pub kind: PassKind,
    pub started_at: String,
    pub duration_ms: u64,
    pub zones_checked: u32,
    pub notifications_created: u32,
    pub errors: u32,
    #[serde(default)]
    pub error_messages: Vec<String>,
    /// The pass did nothing because settings disabled it.
    pub skipped: bool,
    /// Whether the caller should back off (429/5xx seen).
    #[serde(default)]
    pub backoff: bool,
}

impl PassReport {
    fn new(kind: PassKind, now: DateTime<Utc>) -> Self {
        Self {
            kind,
            started_at: format_ts(now),
            duration_ms: 0,
            zones_checked: 0,
            notifications_created: 0,
            errors: 0,
            error_messages: Vec::new(),
            skipped: false,
            backoff: false,
        }
    }

    fn record_error(&mut self, message: String) {
        self.errors += 1;
        if is_backoff_error(&message) {
            self.backoff = true;
        }
        if self.error_messages.len() < 20 {
            self.error_messages.push(message);
        }
    }

    fn finish(mut self, started: std::time::Instant) -> Self {
        self.duration_ms = started.elapsed().as_millis() as u64;
        self
    }
}

/// Deliver a notification: hold it during quiet hours with `behaviour = hold`,
/// otherwise insert (deduped). Returns `true` when something new was stored.
pub fn deliver(
    store: &mut NotifyStore,
    settings: &NotificationSettings,
    notification: Notification,
    now: DateTime<Utc>,
) -> Result<bool, StoreError> {
    if settings.quiet_hours.behaviour == QuietBehaviour::Hold && settings.quiet_hours_active(now) {
        let duplicate = store
            .items()
            .iter()
            .any(|n| !n.is_archived() && n.dedupe_key == notification.dedupe_key);
        if duplicate {
            return Ok(false);
        }
        store.hold(notification)?;
        return Ok(true);
    }
    store.insert_deduped(notification)
}

/// Release held items once the quiet window is over.
pub fn release_if_quiet_over(
    store: &mut NotifyStore,
    settings: &NotificationSettings,
    now: DateTime<Utc>,
) -> Result<usize, StoreError> {
    let holding =
        settings.quiet_hours.behaviour == QuietBehaviour::Hold && settings.quiet_hours_active(now);
    if holding {
        return Ok(0);
    }
    store.release_held()
}

/// Pick up to `max` zones starting at the persisted round-robin cursor.
fn select_round_robin(zones: &[ZoneRef], cursor: u32, max: usize) -> (Vec<ZoneRef>, u32) {
    if zones.is_empty() {
        return (Vec::new(), 0);
    }
    let len = zones.len();
    let start = (cursor as usize) % len;
    let take = max.clamp(1, len);
    let selected: Vec<ZoneRef> = (0..take)
        .map(|i| zones[(start + i) % len].clone())
        .collect();
    let next = ((start + take) % len) as u32;
    (selected, next)
}

async fn fetch_all_records<S: ZoneSource>(
    source: &S,
    zone_id: &str,
) -> Result<Vec<DNSRecord>, String> {
    let mut all = Vec::new();
    let mut page = 1;
    loop {
        let batch = source.list_records(zone_id, page, RECORDS_PER_PAGE).await?;
        let short = (batch.len() as u32) < RECORDS_PER_PAGE;
        all.extend(batch);
        if short || page >= 10_000 {
            break;
        }
        page += 1;
    }
    Ok(all)
}

/// Poll monitored zones, diff against the stored snapshot, create
/// `record_change` notifications for external edits, update snapshots and
/// state, then evaluate expiry milestones from cached dates and apply retention.
pub async fn run_record_pass<S: ZoneSource>(
    source: &S,
    store: &mut NotifyStore,
    ledger: &OwnChangeLedger,
    own_audit_ids: &HashSet<String>,
    settings: &NotificationSettings,
    now: DateTime<Utc>,
) -> PassReport {
    let started = std::time::Instant::now();
    let mut report = PassReport::new(PassKind::Records, now);
    let record_kind = &settings.kinds.record_change;

    if !settings.retention.keep_snapshots {
        if let Err(error) = store.delete_all_snapshots() {
            report.record_error(error.to_string());
        }
        report.skipped = true;
        finish_pass(store, settings, now, &mut report);
        return report.finish(started);
    }
    if !record_kind.enabled {
        report.skipped = true;
        finish_pass(store, settings, now, &mut report);
        return report.finish(started);
    }

    let zones = match source.list_zones().await {
        Ok(zones) => zones,
        Err(error) => {
            report.record_error(format!("list zones: {error}"));
            finish_pass(store, settings, now, &mut report);
            return report.finish(started);
        }
    };

    // Zones that disappeared from the account: drop their snapshot, one service notice.
    let live: HashSet<&str> = zones.iter().map(|z| z.id.as_str()).collect();
    let gone: Vec<(String, String)> = store
        .state()
        .zones
        .iter()
        .filter(|(id, _)| !live.contains(id.as_str()))
        .map(|(id, state)| (id.clone(), state.zone_name.clone()))
        .collect();
    for (zone_id, zone_name) in gone {
        let _ = store.delete_snapshot(&zone_id);
        store.state_mut().zones.remove(&zone_id);
        if settings.kinds.service.enabled {
            let notification = Notification::new(
                NotificationKind::Service,
                settings.severity_for_service(),
                format!("Zone no longer available: {zone_name}"),
                format!("{zone_name} is no longer listed for this token; its monitoring snapshot was removed."),
                format!("service:zone-removed:{zone_id}"),
                json!({ "event": "zone_removed", "zoneId": zone_id, "zoneName": zone_name }),
                now,
            )
            .with_zone(zone_id.clone(), zone_name.clone());
            match deliver(store, settings, notification, now) {
                Ok(true) => report.notifications_created += 1,
                Ok(false) => {}
                Err(error) => report.record_error(error.to_string()),
            }
        }
    }

    let monitored: Vec<ZoneRef> = zones
        .into_iter()
        .filter(|z| settings.is_zone_monitored(&z.id))
        .collect();
    let (selected, next_cursor) = select_round_robin(
        &monitored,
        store.state().zone_cursor,
        settings.service.max_zones_per_pass as usize,
    );
    store.state_mut().zone_cursor = next_cursor;
    let fields = record_kind.diff_fields();

    for (index, zone) in selected.iter().enumerate() {
        if index > 0 && !cfg!(test) {
            tokio::time::sleep(INTER_ZONE_DELAY).await;
        }
        let records = match fetch_all_records(source, &zone.id).await {
            Ok(records) => records,
            Err(error) => {
                report.record_error(format!("{}: {error}", zone.name));
                let entry = store.state_mut().zones.entry(zone.id.clone()).or_default();
                entry.zone_name = zone.name.clone();
                entry.last_error = Some(error);
                continue;
            }
        };
        report.zones_checked += 1;

        let previous = match store.load_snapshot(&zone.id) {
            Ok(previous) => previous,
            Err(error) => {
                report.record_error(format!(
                    "{}: snapshot unreadable, re-baselining: {error}",
                    zone.name
                ));
                None
            }
        };

        if let Some(previous) = previous {
            let suppressed = settings.is_zone_muted(&zone.id, now)
                || !settings.zone_kind_enabled(&zone.id, NotificationKind::RecordChange);
            for change in diff_snapshots(&previous, &records, &fields) {
                if ledger.consume_at(&zone.id, &change.record_id, now) {
                    continue;
                }
                if own_audit_ids.contains(&change.record_id) {
                    continue;
                }
                if suppressed || !record_kind.changes.allows(change.change) {
                    continue;
                }
                let notification =
                    build_change_notification(settings, &zone.id, &zone.name, &change, now);
                match deliver(store, settings, notification, now) {
                    Ok(true) => report.notifications_created += 1,
                    Ok(false) => {}
                    Err(error) => report.record_error(error.to_string()),
                }
            }
        }

        if let Err(error) = store.save_snapshot(&zone.id, &records, now) {
            report.record_error(format!("{}: {error}", zone.name));
        }
        let entry = store.state_mut().zones.entry(zone.id.clone()).or_default();
        entry.zone_name = zone.name.clone();
        entry.last_checked_at = Some(format_ts(now));
        entry.last_error = None;
    }

    store.state_mut().last_record_check_at = Some(format_ts(now));
    finish_pass(store, settings, now, &mut report);
    report.finish(started)
}

/// Common tail of both passes: milestone evaluation from cached expiry data,
/// release held items, retention, persist state.
fn finish_pass(
    store: &mut NotifyStore,
    settings: &NotificationSettings,
    now: DateTime<Utc>,
    report: &mut PassReport,
) {
    let created = evaluate_expiry_milestones(store, settings, now, report);
    report.notifications_created += created;
    match release_if_quiet_over(store, settings, now) {
        Ok(_) => {}
        Err(error) => report.record_error(error.to_string()),
    }
    if let Err(error) = store.apply_retention(&settings.retention, now) {
        report.record_error(error.to_string());
    }
    if let Err(error) = store.save_state() {
        report.record_error(error.to_string());
    }
}

/// Zone id/name for an apex domain from the tracked zone state.
fn zone_for_domain(store: &NotifyStore, domain: &str) -> Option<(String, String)> {
    store
        .state()
        .zones
        .iter()
        .find(|(_, state)| state.zone_name.eq_ignore_ascii_case(domain))
        .map(|(id, state)| (id.clone(), state.zone_name.clone()))
}

/// Walk cached expiry dates and emit due milestone notifications (no network).
pub fn evaluate_expiry_milestones(
    store: &mut NotifyStore,
    settings: &NotificationSettings,
    now: DateTime<Utc>,
    report: &mut PassReport,
) -> u32 {
    if !settings.kinds.domain_expiry.enabled {
        return 0;
    }
    let mut created = 0;
    let domains: Vec<String> = store.state().expiry.keys().cloned().collect();
    for domain in domains {
        let Some(entry) = store.state().expiry.get(&domain).cloned() else {
            continue;
        };
        let Some(expires_at) = entry.expires_at.as_deref().and_then(parse_ts) else {
            continue;
        };
        let zone = zone_for_domain(store, &domain);
        if let Some((zone_id, _)) = &zone {
            if !settings.is_zone_monitored(zone_id)
                || !settings.zone_kind_enabled(zone_id, NotificationKind::DomainExpiry)
                || settings.is_zone_muted(zone_id, now)
            {
                continue;
            }
        }
        let days = days_left(expires_at, now);
        let emitted: HashSet<u32> = entry.emitted.iter().copied().collect();
        let (due, newly) = due_milestone(days, &settings.expiry.milestones, &emitted);
        if newly.is_empty() {
            continue;
        }
        let source = entry.source.clone().unwrap_or_else(|| "rdap".to_string());
        if let Some(milestone) = due {
            if milestone != EXPIRED_MILESTONE || settings.expiry.notify_expired {
                let zone_ref = zone.as_ref().map(|(id, name)| (id.as_str(), name.as_str()));
                let notification = build_expiry_notification(
                    settings, &domain, zone_ref, expires_at, days, milestone, &source, now,
                );
                match deliver(store, settings, notification, now) {
                    Ok(true) => created += 1,
                    Ok(false) => {}
                    Err(error) => report.record_error(error.to_string()),
                }
            }
        }
        if let Some(state) = store.state_mut().expiry.get_mut(&domain) {
            for m in newly {
                if !state.emitted.contains(&m) {
                    state.emitted.push(m);
                }
            }
            state.emitted.sort_unstable();
        }
    }
    created
}

/// Record a freshly learned expiry date; a new date resets emitted milestones.
pub fn record_expiry(
    store: &mut NotifyStore,
    domain: &str,
    expires_at: Option<DateTime<Utc>>,
    source: &str,
    now: DateTime<Utc>,
) {
    let entry = store
        .state_mut()
        .expiry
        .entry(domain.to_string())
        .or_default();
    let new_date = expires_at.map(|d| d.date_naive());
    let old_date = entry
        .expires_at
        .as_deref()
        .and_then(parse_ts)
        .map(|d| d.date_naive());
    if new_date != old_date {
        entry.emitted.clear();
    }
    entry.expires_at = expires_at.map(format_ts);
    entry.source = Some(source.to_string());
    entry.fetched_at = Some(format_ts(now));
    entry.last_error = None;
    entry.last_error_at = None;
}

/// RDAP client bundle so the expiry pass can be pointed at a test server.
pub struct RdapClient {
    pub http: reqwest::Client,
    pub base_url: String,
    pub min_interval: Duration,
}

impl Default for RdapClient {
    fn default() -> Self {
        Self {
            http: rdap::default_client(),
            base_url: rdap::RDAP_BASE_URL.to_string(),
            min_interval: rdap::RDAP_MIN_INTERVAL,
        }
    }
}

/// Refresh expiry dates (registrar data first, RDAP second, per `expiry.source`)
/// for monitored zones, then evaluate milestones and apply retention.
pub async fn run_expiry_pass<S: ZoneSource>(
    source: &S,
    registrar_domains: &[DomainInfo],
    store: &mut NotifyStore,
    settings: &NotificationSettings,
    now: DateTime<Utc>,
) -> PassReport {
    run_expiry_pass_with(
        source,
        registrar_domains,
        store,
        settings,
        now,
        &RdapClient::default(),
    )
    .await
}

pub async fn run_expiry_pass_with<S: ZoneSource>(
    source: &S,
    registrar_domains: &[DomainInfo],
    store: &mut NotifyStore,
    settings: &NotificationSettings,
    now: DateTime<Utc>,
    rdap_client: &RdapClient,
) -> PassReport {
    use settings::ExpirySource;

    let started = std::time::Instant::now();
    let mut report = PassReport::new(PassKind::Expiry, now);
    if !settings.kinds.domain_expiry.enabled {
        report.skipped = true;
        finish_pass(store, settings, now, &mut report);
        return report.finish(started);
    }

    let zones = match source.list_zones().await {
        Ok(zones) => zones,
        Err(error) => {
            report.record_error(format!("list zones: {error}"));
            finish_pass(store, settings, now, &mut report);
            return report.finish(started);
        }
    };
    let registrar: HashMap<String, &DomainInfo> = registrar_domains
        .iter()
        .map(|d| {
            (
                d.domain.trim().trim_end_matches('.').to_ascii_lowercase(),
                d,
            )
        })
        .collect();
    let cache = chrono::Duration::hours(i64::from(settings.service.rdap_cache_hours));
    let retry = chrono::Duration::hours(RDAP_RETRY_HOURS);
    let mut rdap_calls = 0u32;

    for zone in zones.iter().filter(|z| settings.is_zone_monitored(&z.id)) {
        let entry = store.state_mut().zones.entry(zone.id.clone()).or_default();
        entry.zone_name = zone.name.clone();
        let domain = zone.name.trim_end_matches('.').to_ascii_lowercase();
        if !settings.zone_kind_enabled(&zone.id, NotificationKind::DomainExpiry) {
            continue;
        }
        report.zones_checked += 1;

        let use_registrar = settings.expiry.source != ExpirySource::Rdap;
        if use_registrar {
            if let Some(info) = registrar.get(&domain) {
                let parsed = expiry::parse_flexible_date(&info.expires_at);
                if parsed.is_some() {
                    record_expiry(store, &domain, parsed, "registrar", now);
                    continue;
                }
            }
        }
        if settings.expiry.source == ExpirySource::Registrar {
            continue;
        }

        // RDAP, cached for `rdapCacheHours`; failures retried after RDAP_RETRY_HOURS.
        let existing = store
            .state()
            .expiry
            .get(&domain)
            .cloned()
            .unwrap_or_default();
        let fresh = existing
            .fetched_at
            .as_deref()
            .and_then(parse_ts)
            .map(|at| now - at < cache)
            .unwrap_or(false);
        let recently_failed = existing
            .last_error_at
            .as_deref()
            .and_then(parse_ts)
            .map(|at| now - at < retry)
            .unwrap_or(false);
        if (fresh && existing.expires_at.is_some()) || recently_failed {
            continue;
        }
        if rdap_calls > 0 && !cfg!(test) {
            tokio::time::sleep(rdap_client.min_interval).await;
        }
        rdap_calls += 1;
        match rdap::fetch_rdap_expiry_from(&rdap_client.http, &rdap_client.base_url, &domain).await
        {
            Ok(parsed) => record_expiry(store, &domain, parsed, "rdap", now),
            Err(error) => {
                if !error.is_not_found() {
                    report.record_error(format!("{domain}: {error}"));
                }
                let state = store.state_mut().expiry.entry(domain.clone()).or_default();
                state.last_error = Some(error.to_string());
                state.last_error_at = Some(format_ts(now));
                state.fetched_at = Some(format_ts(now));
            }
        }
    }

    store.state_mut().last_expiry_check_at = Some(format_ts(now));
    finish_pass(store, settings, now, &mut report);
    report.finish(started)
}

#[cfg(test)]
mod tests;
