//! Tauri glue for the background notification service.
//!
//! `bc-notify` owns the logic (passes, diffing, inbox); this module owns the
//! schedule, the API token (memory only, zeroized on stop/exit), the Tauri
//! commands and the two frontend events:
//! `notifications://changed` `{ unread }` after any inbox mutation and
//! `notifications://status` after every pass.

use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use bc_cloudflare_api::CloudflareClient;
use bc_notify::model::{format_ts, parse_ts};
use bc_notify::settings::ExpirySource;
use bc_notify::{
    days_left, Notification, NotificationKind, NotificationQuery, NotificationSettings,
    NotifyStore, OwnChangeLedger, PassKind, PassReport,
};
use bc_registrar::{DomainInfo, RegistrarCredential};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::app_config::AppConfigStore;
use crate::storage::Storage;

/// Sub-directory of app-data holding `inbox.json`, `state.json`, `snapshots/`.
pub const STORE_DIRECTORY: &str = "notifications";
pub const CHANGED_EVENT: &str = "notifications://changed";
pub const STATUS_EVENT: &str = "notifications://status";
/// How often an idle (disabled/paused) loop re-reads settings.
const IDLE_RECHECK: Duration = Duration::from_secs(60);
const MIN_SLEEP: Duration = Duration::from_secs(1);

/// Every command this module registers (asserted by `main.rs` tests).
#[cfg(test)]
pub const COMMAND_NAMES: [&str; 21] = [
    "notifications_start",
    "notifications_stop",
    "notifications_status",
    "notifications_check_now",
    "notifications_list",
    "notifications_unread_count",
    "notifications_mark_read",
    "notifications_mark_all_read",
    "notifications_archive",
    "notifications_unarchive",
    "notifications_archive_all_read",
    "notifications_archive_kind",
    "notifications_dismiss",
    "notifications_clear_archived",
    "notifications_reconfigure",
    "notifications_pause",
    "notifications_resume",
    "notifications_get_settings",
    "notifications_update_settings",
    "notifications_reset_state",
    "notifications_zone_summary",
];

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ── host (preferences, audit log, registrar, events) ─────────────────────────

/// What the service needs from the surrounding app; `TauriHost` in production,
/// an in-memory implementation in tests.
pub trait NotificationHost: Send + Sync {
    fn load_settings(&self) -> BoxFuture<'_, NotificationSettings>;
    fn save_settings(&self, settings: NotificationSettings) -> BoxFuture<'_, Result<(), String>>;
    /// Record ids this app mutated (per the local audit log) after `since`.
    fn own_audit_record_ids(&self, since: Option<DateTime<Utc>>) -> BoxFuture<'_, HashSet<String>>;
    fn registrar_domains(&self) -> BoxFuture<'_, Vec<DomainInfo>>;
    fn emit(&self, event: &str, payload: Value);
    /// Show an OS-level notification (`tauri-plugin-notification` in production).
    /// Hosts without a notification centre may leave the default no-op.
    fn notify_os(&self, _notification: &Notification) -> Result<(), String> {
        Ok(())
    }
}

/// Items from `created` that should also reach the OS notification centre under
/// `settings` at `now` (kind toggle, `osNotifications.enabled` + `minSeverity`,
/// quiet hours and per-zone mutes, all via `NotificationSettings::os_notify_allowed`).
pub fn os_notifications_due<'a>(
    created: &'a [Notification],
    settings: &NotificationSettings,
    now: DateTime<Utc>,
) -> Vec<&'a Notification> {
    created
        .iter()
        .filter(|n| settings.os_notify_allowed(n.kind, n.severity, n.zone_id.as_deref(), now))
        .collect()
}

/// Send OS notifications for the items that pass the settings gates. A failure
/// is logged and never fails the pass. Returns how many were handed to the host.
pub fn send_os_notifications(
    host: &dyn NotificationHost,
    created: &[Notification],
    settings: &NotificationSettings,
    now: DateTime<Utc>,
) -> usize {
    let mut sent = 0;
    for notification in os_notifications_due(created, settings, now) {
        match host.notify_os(notification) {
            Ok(()) => sent += 1,
            Err(error) => eprintln!(
                "[notifications] OS notification failed for {}: {error}",
                notification.id
            ),
        }
    }
    sent
}

/// Extract record ids of own DNS mutations newer than `since` from audit entries.
pub fn own_record_ids_from_audit(
    entries: &[Value],
    since: Option<DateTime<Utc>>,
) -> HashSet<String> {
    entries
        .iter()
        .filter(|entry| match since {
            None => true,
            Some(since) => entry
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(parse_ts)
                .map(|ts| ts > since)
                .unwrap_or(false),
        })
        .filter_map(own_changed_record_id)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect()
}

/// The record a single audit entry says this application changed, if it says
/// one at all.
///
/// Three writers reach the DNS API and only one of them logs a `dns:*`
/// operation. The app's own commands do; the MCP server's tools and the
/// assistant's go straight to the Cloudflare client, recording a tool call
/// instead. Reading only `dns:*` meant a record the user's own assistant had
/// just edited came back on the next poll as a change made outside the
/// application -- a false alarm about the user's own action, and one that
/// would train them to ignore the real thing.
///
/// Only a call that *succeeded* counts. A refused or failed call changed
/// nothing, and treating it as our own would suppress the notification for a
/// genuine outside change to that same record. Only a mutating tier counts
/// for the same reason: a successful read says the record was looked at, not
/// touched.
fn own_changed_record_id(entry: &Value) -> Option<&str> {
    let operation = entry.get("operation").and_then(Value::as_str)?;
    match operation {
        // The app's own commands name the record in `resource`.
        "dns:create" | "dns:update" | "dns:delete" => entry.get("resource").and_then(Value::as_str),
        // A tool call names the tool in `resource`, so the record is a detail.
        "mcp:tool_call" | "assistant:tool_call" => {
            if entry.get("outcome").and_then(Value::as_str) != Some("succeeded") {
                return None;
            }
            match entry.get("effect").and_then(Value::as_str) {
                Some("write" | "destructive") => entry.get("record_id").and_then(Value::as_str),
                _ => None,
            }
        }
        _ => None,
    }
}

pub struct TauriHost<R: Runtime> {
    handle: AppHandle<R>,
}

impl<R: Runtime> TauriHost<R> {
    pub fn new(handle: AppHandle<R>) -> Self {
        Self { handle }
    }
}

impl<R: Runtime> NotificationHost for TauriHost<R> {
    fn load_settings(&self) -> BoxFuture<'_, NotificationSettings> {
        Box::pin(async move {
            let config = self.handle.state::<AppConfigStore>();
            let storage = self.handle.state::<Storage>();
            config
                .get_preferences(
                    || storage.get_legacy_preferences(),
                    || storage.delete_legacy_preferences(),
                )
                .await
                .ok()
                .and_then(|preferences| preferences.notifications)
                .map(NotificationSettings::normalize)
                .unwrap_or_default()
        })
    }

    fn save_settings(&self, settings: NotificationSettings) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let config = self.handle.state::<AppConfigStore>();
            let storage = self.handle.state::<Storage>();
            let value = serde_json::to_value(settings).map_err(|error| error.to_string())?;
            let mut fields = Map::new();
            fields.insert("notifications".to_string(), value);
            config
                .update_preferences(
                    fields,
                    || storage.get_legacy_preferences(),
                    || storage.delete_legacy_preferences(),
                )
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn own_audit_record_ids(&self, since: Option<DateTime<Utc>>) -> BoxFuture<'_, HashSet<String>> {
        Box::pin(async move {
            let storage = self.handle.state::<Storage>();
            let entries = storage.get_audit_entries().await.unwrap_or_default();
            own_record_ids_from_audit(&entries, since)
        })
    }

    fn registrar_domains(&self) -> BoxFuture<'_, Vec<DomainInfo>> {
        Box::pin(async move {
            let storage = self.handle.state::<Storage>();
            let credentials: Vec<RegistrarCredential> = storage
                .get_registrar_credentials()
                .await
                .unwrap_or_default();
            let mut all = Vec::new();
            for credential in &credentials {
                let Ok(secrets) = storage.get_registrar_secrets(&credential.id).await else {
                    continue;
                };
                let Ok(client) = bc_registrar::build_client(credential, &secrets) else {
                    continue;
                };
                if let Ok(domains) = client.list_domains().await {
                    all.extend(domains);
                }
            }
            all
        })
    }

    fn emit(&self, event: &str, payload: Value) {
        let _ = self.handle.emit(event, payload);
    }

    fn notify_os(&self, notification: &Notification) -> Result<(), String> {
        use tauri_plugin_notification::NotificationExt;
        self.handle
            .notification()
            .builder()
            .title(notification.title.clone())
            .body(notification.body.clone())
            .show()
            .map_err(|error| error.to_string())
    }
}

// ── pass runner (erases the zone source type) ────────────────────────────────

/// Runs the three `bc-notify` passes against one API token.
pub trait PassRunner: Send + Sync {
    fn run_record<'a>(
        &'a self,
        store: &'a mut NotifyStore,
        ledger: &'a OwnChangeLedger,
        own_audit_ids: &'a HashSet<String>,
        settings: &'a NotificationSettings,
        now: DateTime<Utc>,
    ) -> BoxFuture<'a, PassReport>;

    fn run_expiry<'a>(
        &'a self,
        registrar_domains: &'a [DomainInfo],
        store: &'a mut NotifyStore,
        settings: &'a NotificationSettings,
        now: DateTime<Utc>,
    ) -> BoxFuture<'a, PassReport>;

    /// Run the scheduled domain audit over the monitored zones.
    ///
    /// Takes neither the change ledger nor the registrar domains, unlike the
    /// other two, and that is deliberate. A finding is a statement about the
    /// zone's *current* configuration: suppressing "SPF is missing" because
    /// this application is what deleted the record would hide a live problem
    /// from the person who needs to hear it — whereas for the record pass a
    /// self-inflicted edit is exactly the noise the ledger exists to filter.
    /// Registrar data only carries expiry dates, which no audit check reads.
    fn run_audit<'a>(
        &'a self,
        store: &'a mut NotifyStore,
        settings: &'a NotificationSettings,
        now: DateTime<Utc>,
    ) -> BoxFuture<'a, PassReport>;
}

impl PassRunner for CloudflareClient {
    fn run_record<'a>(
        &'a self,
        store: &'a mut NotifyStore,
        ledger: &'a OwnChangeLedger,
        own_audit_ids: &'a HashSet<String>,
        settings: &'a NotificationSettings,
        now: DateTime<Utc>,
    ) -> BoxFuture<'a, PassReport> {
        Box::pin(bc_notify::run_record_pass(
            self,
            store,
            ledger,
            own_audit_ids,
            settings,
            now,
        ))
    }

    fn run_expiry<'a>(
        &'a self,
        registrar_domains: &'a [DomainInfo],
        store: &'a mut NotifyStore,
        settings: &'a NotificationSettings,
        now: DateTime<Utc>,
    ) -> BoxFuture<'a, PassReport> {
        Box::pin(bc_notify::run_expiry_pass(
            self,
            registrar_domains,
            store,
            settings,
            now,
        ))
    }

    fn run_audit<'a>(
        &'a self,
        store: &'a mut NotifyStore,
        settings: &'a NotificationSettings,
        now: DateTime<Utc>,
    ) -> BoxFuture<'a, PassReport> {
        Box::pin(bc_notify::run_audit_pass(self, store, settings, now))
    }
}

// ── wire types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckKind {
    Records,
    Expiry,
    Audit,
    All,
}

impl CheckKind {
    fn records(self) -> bool {
        matches!(self, CheckKind::Records | CheckKind::All)
    }
    fn expiry(self) -> bool {
        matches!(self, CheckKind::Expiry | CheckKind::All)
    }
    fn audit(self) -> bool {
        matches!(self, CheckKind::Audit | CheckKind::All)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassSummary {
    pub kind: PassKind,
    pub started_at: String,
    pub duration_ms: u64,
    pub zones_checked: u32,
    pub notifications_created: u32,
    pub errors: u32,
}

impl From<&PassReport> for PassSummary {
    fn from(report: &PassReport) -> Self {
        Self {
            kind: report.kind,
            started_at: report.started_at.clone(),
            duration_ms: report.duration_ms,
            zones_checked: report.zones_checked,
            notifications_created: report.notifications_created,
            errors: report.errors,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationServiceStatus {
    pub running: bool,
    pub enabled: bool,
    pub paused: bool,
    pub quiet_hours_active: bool,
    pub zones_tracked: u32,
    pub unread: u32,
    pub last_record_check_at: Option<String>,
    pub last_expiry_check_at: Option<String>,
    pub last_audit_check_at: Option<String>,
    pub next_record_check_at: Option<String>,
    pub next_expiry_check_at: Option<String>,
    pub next_audit_check_at: Option<String>,
    /// Alias of `next_record_check_at` for the status line.
    pub next_check_at: Option<String>,
    pub backoff_until: Option<String>,
    pub last_error: Option<String>,
    pub last_pass: Option<PassSummary>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ResetRequest {
    pub expiry_ledger: bool,
    pub snapshots: bool,
    pub inbox: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneSummary {
    pub zone_id: String,
    pub zone_name: String,
    pub monitored: bool,
    pub muted: bool,
    pub muted_until: Option<String>,
    pub last_checked_at: Option<String>,
    pub snapshot_records: Option<u32>,
    pub expires_at: Option<String>,
    pub days_left: Option<i64>,
    pub expiry_source: Option<String>,
    pub last_error: Option<String>,
}

// ── manager ──────────────────────────────────────────────────────────────────

/// Schedule bookkeeping shared between commands and the loop task.
struct Schedule {
    settings: NotificationSettings,
    next_record: Option<Instant>,
    next_expiry: Option<Instant>,
    next_audit: Option<Instant>,
    last_record_run: Option<Instant>,
    last_expiry_run: Option<Instant>,
    last_audit_run: Option<Instant>,
    backoff_until: Option<Instant>,
    backoff: Duration,
    last_pass: Option<PassSummary>,
    last_error: Option<String>,
}

impl Default for Schedule {
    fn default() -> Self {
        Self {
            settings: NotificationSettings::default(),
            next_record: None,
            next_expiry: None,
            next_audit: None,
            last_record_run: None,
            last_expiry_run: None,
            last_audit_run: None,
            backoff_until: None,
            backoff: Duration::ZERO,
            last_pass: None,
            last_error: None,
        }
    }
}

fn record_interval(settings: &NotificationSettings) -> Duration {
    Duration::from_secs(u64::from(settings.service.record_poll_minutes) * 60)
}

fn expiry_interval(settings: &NotificationSettings) -> Duration {
    Duration::from_secs(u64::from(settings.service.expiry_poll_minutes) * 60)
}

/// The audit's own cadence (`service.auditPollMinutes`, daily by default).
///
/// Separate from [`record_interval`] on purpose: an audit re-reads every
/// monitored zone's records in full, so running it on the record pass's
/// 15-minute cadence would multiply the account's API traffic for findings that
/// change on the timescale of a DNS edit someone makes by hand.
fn audit_interval(settings: &NotificationSettings) -> Duration {
    Duration::from_secs(u64::from(settings.service.audit_poll_minutes) * 60)
}

impl Schedule {
    /// Re-arm every timer from its own last run (or from now) with the current
    /// intervals.
    fn rearm(&mut self, now: Instant) {
        let record = record_interval(&self.settings);
        let expiry = expiry_interval(&self.settings);
        let audit = audit_interval(&self.settings);
        self.next_record = Some(self.last_record_run.map_or(now, |t| t + record).max(now));
        self.next_expiry = Some(self.last_expiry_run.map_or(now, |t| t + expiry).max(now));
        // The audit alone has no "never ran, so run now" case: it does not catch
        // up at launch (see `start_with`), and re-arming is also what an
        // unrelated settings save goes through — neither is a reason to spend a
        // full-account audit this second.
        self.next_audit = Some((self.last_audit_run.unwrap_or(now) + audit).max(now));
    }

    fn note_pass(&mut self, report: &PassReport, now: Instant) {
        match report.kind {
            PassKind::Records => {
                self.last_record_run = Some(now);
                self.next_record = Some(now + record_interval(&self.settings));
            }
            PassKind::Expiry => {
                self.last_expiry_run = Some(now);
                self.next_expiry = Some(now + expiry_interval(&self.settings));
            }
            PassKind::Audit => {
                self.last_audit_run = Some(now);
                self.next_audit = Some(now + audit_interval(&self.settings));
            }
        }
        if report.backoff {
            let max =
                Duration::from_secs(u64::from(self.settings.service.backoff_max_minutes) * 60);
            let next = if self.backoff.is_zero() {
                record_interval(&self.settings)
            } else {
                self.backoff * 2
            };
            self.backoff = next.min(max);
            self.backoff_until = Some(now + self.backoff);
        } else if report.errors == 0 {
            self.backoff = Duration::ZERO;
            self.backoff_until = None;
        }
        self.last_error = report.error_messages.first().cloned();
        self.last_pass = Some(PassSummary::from(report));
    }
}

struct Shared {
    schedule: StdMutex<Schedule>,
    wake: Notify,
    reconfigure: AtomicBool,
    /// Serialises passes between the loop and `check_now`.
    pass_gate: Mutex<()>,
}

struct Running {
    token: Zeroizing<String>,
    runner: Arc<dyn PassRunner>,
    stop: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.task.abort();
        // `token` is `Zeroizing`: wiped as it drops.
    }
}

pub struct NotificationManager {
    ledger: Arc<OwnChangeLedger>,
    store: Arc<Mutex<Option<NotifyStore>>>,
    store_error: StdMutex<Option<String>>,
    host: OnceLock<Arc<dyn NotificationHost>>,
    running: StdMutex<Option<Running>>,
    shared: Arc<Shared>,
}

impl Default for NotificationManager {
    fn default() -> Self {
        Self {
            ledger: Arc::new(OwnChangeLedger::new()),
            store: Arc::new(Mutex::new(None)),
            store_error: StdMutex::new(None),
            host: OnceLock::new(),
            running: StdMutex::new(None),
            shared: Arc::new(Shared {
                schedule: StdMutex::new(Schedule::default()),
                wake: Notify::new(),
                reconfigure: AtomicBool::new(false),
                pass_gate: Mutex::new(()),
            }),
        }
    }
}

fn instant_to_ts(instant: Option<Instant>) -> Option<String> {
    let instant = instant?;
    let now = Instant::now();
    let at = if instant > now {
        Utc::now() + chrono::Duration::from_std(instant - now).ok()?
    } else {
        Utc::now()
    };
    Some(format_ts(at))
}

impl NotificationManager {
    /// Open the on-disk store and install the host. Called once from setup.
    pub fn attach(&self, dir: PathBuf, host: impl NotificationHost + 'static) {
        match NotifyStore::open(dir) {
            Ok(store) => {
                let recovered = store.recovered_errors().join("; ");
                if !recovered.is_empty() {
                    *self.store_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(recovered);
                }
                *self.store.try_lock().expect("store unused during attach") = Some(store);
            }
            Err(error) => {
                *self.store_error.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(error.to_string());
            }
        }
        let _ = self.host.set(Arc::new(host));
    }

    #[cfg(test)]
    pub fn is_attached(&self) -> bool {
        self.host.get().is_some()
    }

    pub fn ledger(&self) -> &OwnChangeLedger {
        &self.ledger
    }

    fn host(&self) -> Result<Arc<dyn NotificationHost>, String> {
        self.host
            .get()
            .cloned()
            .ok_or_else(|| "notification service is not initialised".to_string())
    }

    fn running(&self) -> std::sync::MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_running(&self) -> bool {
        self.running().is_some()
    }

    /// Stop the loop and drop the token synchronously (app exit, logout).
    pub fn shutdown(&self) {
        self.running().take();
    }

    /// Start with a Cloudflare client for `api_key`.
    pub async fn start(
        &self,
        api_key: String,
        email: Option<String>,
    ) -> Result<NotificationServiceStatus, String> {
        let client = CloudflareClient::new(&api_key, email.as_deref());
        self.start_with(Arc::new(client), api_key).await
    }

    /// Start (idempotent: same token → no-op, different token → restart).
    pub async fn start_with(
        &self,
        runner: Arc<dyn PassRunner>,
        api_key: String,
    ) -> Result<NotificationServiceStatus, String> {
        let host = self.host()?;
        if api_key.trim().is_empty() {
            return Err("an API token is required".to_string());
        }
        let already_running = self.running().as_ref().is_some_and(|current| {
            current.token.as_str() == api_key && !current.task.is_finished()
        });
        if already_running {
            return self.status().await;
        }
        self.shutdown();

        let settings = host.load_settings().await;
        let now = Instant::now();
        {
            let mut schedule = self
                .shared
                .schedule
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            schedule.settings = settings.clone();
            schedule.backoff = Duration::ZERO;
            schedule.backoff_until = None;
            if settings.service.catch_up_on_launch {
                schedule.next_record = Some(now);
                schedule.next_expiry = Some(now);
            } else {
                schedule.next_record = Some(now + record_interval(&settings));
                schedule.next_expiry = Some(now + expiry_interval(&settings));
            }
            // `catchUpOnLaunch` deliberately does not cover the audit: it reads
            // every monitored zone's records in full (up to `maxZonesPerPass`),
            // which at launch competes with the record pass doing the same reads
            // and with the UI's own first load, and a 429 there would back the
            // record pass off too. A daily pass also has little to catch up on —
            // a finding describes the configuration as it stands, so the next
            // tick reports it just as faithfully. `checkNow` is the way to ask
            // for one immediately.
            schedule.last_audit_run = None;
            schedule.next_audit = Some(now + audit_interval(&settings));
        }
        {
            let mut store = self.store.lock().await;
            if let Some(store) = store.as_mut() {
                store.set_max_items(settings.retention.max_items as usize);
            }
        }

        let stop = Arc::new(AtomicBool::new(false));
        let ctx = LoopContext {
            shared: Arc::clone(&self.shared),
            host,
            runner: Arc::clone(&runner),
            store: Arc::clone(&self.store),
            ledger: Arc::clone(&self.ledger),
            stop: Arc::clone(&stop),
        };
        let task = tokio::spawn(run_loop(ctx));
        *self.running() = Some(Running {
            token: Zeroizing::new(api_key),
            runner,
            stop,
            task,
        });
        self.status().await
    }

    pub async fn stop(&self) {
        self.shutdown();
        self.emit_status().await;
    }

    /// Re-read settings, re-arm timers, wake the loop.
    pub async fn reconfigure(&self) -> Result<NotificationServiceStatus, String> {
        let host = self.host()?;
        let settings = host.load_settings().await;
        {
            let mut schedule = self
                .shared
                .schedule
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            schedule.settings = settings.clone();
            if self.is_running() {
                schedule.rearm(Instant::now());
            }
        }
        {
            let mut store = self.store.lock().await;
            if let Some(store) = store.as_mut() {
                store.set_max_items(settings.retention.max_items as usize);
            }
        }
        self.shared.reconfigure.store(true, Ordering::SeqCst);
        self.shared.wake.notify_one();
        self.status().await
    }

    /// Run the requested passes now (even when paused), coalesced with the loop.
    pub async fn check_now(&self, kind: CheckKind) -> Result<NotificationServiceStatus, String> {
        let host = self.host()?;
        let runner = self
            .running()
            .as_ref()
            .map(|running| Arc::clone(&running.runner))
            .ok_or_else(|| "notification service is not running".to_string())?;
        let settings = host.load_settings().await;
        {
            let mut schedule = self
                .shared
                .schedule
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            schedule.settings = settings.clone();
        }
        let ctx = PassContext {
            shared: &self.shared,
            host: &host,
            runner: &runner,
            store: &self.store,
            ledger: &self.ledger,
        };
        if kind.expiry() {
            ctx.run(PassKind::Expiry, &settings).await;
        }
        if kind.records() {
            ctx.run(PassKind::Records, &settings).await;
        }
        // Last, and heaviest. Asking for an audit is also the only way to get
        // one promptly after enabling the kind, since the timer is armed a full
        // interval out; it still costs nothing while `auditFinding` is off,
        // because the pass itself returns skipped before any network call.
        if kind.audit() {
            ctx.run(PassKind::Audit, &settings).await;
        }
        self.status().await
    }

    pub async fn status(&self) -> Result<NotificationServiceStatus, String> {
        let (
            settings,
            next_record,
            next_expiry,
            next_audit,
            backoff_until,
            last_pass,
            mut last_error,
        ) = {
            let schedule = self
                .shared
                .schedule
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            (
                schedule.settings.clone(),
                schedule.next_record,
                schedule.next_expiry,
                schedule.next_audit,
                schedule.backoff_until,
                schedule.last_pass.clone(),
                schedule.last_error.clone(),
            )
        };
        if last_error.is_none() {
            last_error = self
                .store_error
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
        }
        let running = self.is_running();
        let store = self.store.lock().await;
        let (zones_tracked, unread, last_record, last_expiry, last_audit) = match store.as_ref() {
            Some(store) => (
                store.state().zones.len() as u32,
                store.unread_count(),
                store.state().last_record_check_at.clone(),
                store.state().last_expiry_check_at.clone(),
                store.state().last_audit_check_at.clone(),
            ),
            None => (0, 0, None, None, None),
        };
        let active = running && settings.service.enabled && !settings.service.paused;
        let next_record = if active {
            instant_to_ts(next_record)
        } else {
            None
        };
        Ok(NotificationServiceStatus {
            running,
            enabled: settings.service.enabled,
            paused: settings.service.paused,
            quiet_hours_active: settings.quiet_hours_active(Utc::now()),
            zones_tracked,
            unread,
            last_record_check_at: last_record,
            last_expiry_check_at: last_expiry,
            last_audit_check_at: last_audit,
            next_record_check_at: next_record.clone(),
            next_expiry_check_at: if active {
                instant_to_ts(next_expiry)
            } else {
                None
            },
            next_audit_check_at: if active {
                instant_to_ts(next_audit)
            } else {
                None
            },
            next_check_at: next_record,
            backoff_until: instant_to_ts(backoff_until.filter(|until| *until > Instant::now())),
            last_error,
            last_pass,
        })
    }

    async fn emit_status(&self) {
        if let (Ok(host), Ok(status)) = (self.host(), self.status().await) {
            if let Ok(payload) = serde_json::to_value(status) {
                host.emit(STATUS_EVENT, payload);
            }
        }
    }

    async fn emit_changed(&self) {
        let unread = {
            let store = self.store.lock().await;
            store.as_ref().map(NotifyStore::unread_count).unwrap_or(0)
        };
        if let Ok(host) = self.host() {
            host.emit(CHANGED_EVENT, json!({ "unread": unread }));
        }
    }

    /// Run `op` against the store, then emit `notifications://changed`.
    async fn mutate<T>(
        &self,
        op: impl FnOnce(&mut NotifyStore) -> Result<T, bc_notify::StoreError>,
    ) -> Result<T, String> {
        let result = {
            let mut store = self.store.lock().await;
            let store = store.as_mut().ok_or_else(|| self.store_unavailable())?;
            op(store).map_err(|error| error.to_string())?
        };
        self.emit_changed().await;
        Ok(result)
    }

    async fn read<T>(&self, op: impl FnOnce(&NotifyStore) -> T) -> Result<T, String> {
        let store = self.store.lock().await;
        let store = store.as_ref().ok_or_else(|| self.store_unavailable())?;
        Ok(op(store))
    }

    fn store_unavailable(&self) -> String {
        let detail = self
            .store_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_else(|| "not initialised".to_string());
        format!("notification store unavailable: {detail}")
    }

    pub async fn list(&self, query: NotificationQuery) -> Result<Vec<Notification>, String> {
        self.read(|store| store.list(&query)).await
    }

    pub async fn unread_count(&self) -> Result<u32, String> {
        self.read(NotifyStore::unread_count).await
    }

    pub async fn mark_read(&self, ids: Vec<String>, read: bool) -> Result<u32, String> {
        self.mutate(|store| store.mark_read(&ids, read).map(|n| n as u32))
            .await
    }

    pub async fn mark_all_read(&self) -> Result<u32, String> {
        self.mutate(|store| store.mark_all_read().map(|n| n as u32))
            .await
    }

    pub async fn archive(&self, ids: Vec<String>) -> Result<u32, String> {
        self.mutate(|store| store.archive(&ids).map(|n| n as u32))
            .await
    }

    pub async fn unarchive(&self, ids: Vec<String>) -> Result<u32, String> {
        self.mutate(|store| store.unarchive(&ids).map(|n| n as u32))
            .await
    }

    /// Archive every unarchived notification of one kind.
    ///
    /// The kind arrives as a string from the renderer and is parsed before the
    /// store is touched: an unrecognised one is an error rather than a silent
    /// no-op, because a typo that archives nothing and reports success looks
    /// exactly like an inbox that was already clear.
    pub async fn archive_kind(&self, kind: String) -> Result<u32, String> {
        let parsed = NotificationKind::parse(&kind)
            .ok_or_else(|| format!("Unknown notification kind: {kind}"))?;
        self.mutate(move |store| store.archive_kind(parsed).map(|n| n as u32))
            .await
    }

    pub async fn archive_all_read(&self) -> Result<u32, String> {
        self.mutate(|store| store.archive_all_read().map(|n| n as u32))
            .await
    }

    pub async fn dismiss(&self, ids: Vec<String>) -> Result<u32, String> {
        self.mutate(|store| store.dismiss(&ids).map(|n| n as u32))
            .await
    }

    pub async fn clear_archived(&self) -> Result<u32, String> {
        self.mutate(|store| store.clear_archived().map(|n| n as u32))
            .await
    }

    pub async fn get_settings(&self) -> Result<NotificationSettings, String> {
        Ok(self.host()?.load_settings().await)
    }

    /// Normalize → persist as `Preferences.notifications` → reconfigure.
    pub async fn update_settings(
        &self,
        settings: NotificationSettings,
    ) -> Result<NotificationSettings, String> {
        let host = self.host()?;
        let normalized = settings.normalize();
        host.save_settings(normalized.clone()).await?;
        self.reconfigure().await?;
        Ok(normalized)
    }

    pub async fn set_paused(&self, paused: bool) -> Result<NotificationServiceStatus, String> {
        let host = self.host()?;
        let mut settings = host.load_settings().await;
        settings.service.paused = paused;
        host.save_settings(settings).await?;
        let status = self.reconfigure().await?;
        self.emit_status().await;
        Ok(status)
    }

    pub async fn reset_state(&self, what: ResetRequest) -> Result<(), String> {
        self.mutate(|store| {
            if what.inbox {
                store.clear_inbox()?;
            }
            if what.expiry_ledger {
                store.reset_expiry_ledger()?;
            }
            if what.snapshots {
                store.delete_all_snapshots()?;
                for zone in store.state_mut().zones.values_mut() {
                    zone.snapshot_records = None;
                    zone.snapshot_taken_at = None;
                }
                store.save_state()?;
            }
            Ok(())
        })
        .await
    }

    pub async fn zone_summary(&self) -> Result<Vec<ZoneSummary>, String> {
        let settings = self
            .shared
            .schedule
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .settings
            .clone();
        let now = Utc::now();
        self.read(|store| {
            let state = store.state();
            state
                .zones
                .iter()
                .map(|(zone_id, zone)| {
                    let domain = zone.zone_name.trim_end_matches('.').to_ascii_lowercase();
                    let expiry = state.expiry.get(&domain);
                    let expires_at = expiry.and_then(|e| e.expires_at.clone());
                    let days = expires_at
                        .as_deref()
                        .and_then(parse_ts)
                        .map(|at| days_left(at, now));
                    ZoneSummary {
                        zone_id: zone_id.clone(),
                        zone_name: zone.zone_name.clone(),
                        monitored: settings.is_zone_monitored(zone_id),
                        muted: settings.is_zone_muted(zone_id, now),
                        muted_until: settings
                            .zones
                            .overrides
                            .get(zone_id)
                            .and_then(|o| o.muted_until.clone()),
                        last_checked_at: zone.last_checked_at.clone(),
                        snapshot_records: zone.snapshot_records,
                        expires_at,
                        days_left: days,
                        expiry_source: expiry.and_then(|e| e.source.clone()),
                        last_error: zone
                            .last_error
                            .clone()
                            .or_else(|| expiry.and_then(|e| e.last_error.clone())),
                    }
                })
                .collect()
        })
        .await
    }
}

// ── passes and loop ──────────────────────────────────────────────────────────

struct PassContext<'a> {
    shared: &'a Shared,
    host: &'a Arc<dyn NotificationHost>,
    runner: &'a Arc<dyn PassRunner>,
    store: &'a Mutex<Option<NotifyStore>>,
    ledger: &'a OwnChangeLedger,
}

impl PassContext<'_> {
    async fn run(&self, kind: PassKind, settings: &NotificationSettings) -> Option<PassReport> {
        let _gate = self.shared.pass_gate.lock().await;
        let now = Utc::now();
        let registrar = if kind == PassKind::Expiry
            && settings.kinds.domain_expiry.enabled
            && settings.expiry.source != ExpirySource::Rdap
        {
            self.host.registrar_domains().await
        } else {
            Vec::new()
        };
        let since = {
            let store = self.store.lock().await;
            store
                .as_ref()
                .and_then(|s| s.state().last_record_check_at.as_deref().and_then(parse_ts))
        };
        let own_ids = if kind == PassKind::Records {
            self.host.own_audit_record_ids(since).await
        } else {
            HashSet::new()
        };

        let (report, created) = {
            let mut store = self.store.lock().await;
            let store = store.as_mut()?;
            let before: HashSet<String> = store.items().iter().map(|n| n.id.clone()).collect();
            let report = match kind {
                PassKind::Records => {
                    self.runner
                        .run_record(store, self.ledger, &own_ids, settings, now)
                        .await
                }
                PassKind::Expiry => {
                    self.runner
                        .run_expiry(&registrar, store, settings, now)
                        .await
                }
                PassKind::Audit => self.runner.run_audit(store, settings, now).await,
            };
            let created: Vec<Notification> = store
                .items()
                .iter()
                .filter(|n| !before.contains(&n.id))
                .cloned()
                .collect();
            (report, created)
        };
        // OS notifications for whatever this pass (or a quiet-hours release) added.
        send_os_notifications(self.host.as_ref(), &created, settings, now);
        self.ledger.prune(now);
        {
            let mut schedule = self
                .shared
                .schedule
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            schedule.note_pass(&report, Instant::now());
        }
        let unread = {
            let store = self.store.lock().await;
            store.as_ref().map(NotifyStore::unread_count).unwrap_or(0)
        };
        // A refreshed or withdrawn expiry notice changes what the inbox says
        // without adding an item, and the panel renders `daysLeft` straight off
        // the payload — so it has to hear about those too, or it keeps showing
        // the figure the pass just corrected until something else reloads it.
        // This is only a reload cue: the badge is unaffected (a refresh leaves
        // `readAt` alone) and the toast path filters on `createdAt`, which a
        // refresh also leaves alone, so no refresh can toast.
        let touched = report.notifications_created
            + report.notifications_refreshed
            + report.notifications_superseded;
        if touched > 0 {
            self.host.emit(CHANGED_EVENT, json!({ "unread": unread }));
        }
        self.host.emit(
            STATUS_EVENT,
            json!({
                "running": true,
                "enabled": settings.service.enabled,
                "paused": settings.service.paused,
                "quietHoursActive": settings.quiet_hours_active(now),
                "unread": unread,
                "lastPass": PassSummary::from(&report),
                "lastError": report.error_messages.first(),
            }),
        );
        Some(report)
    }
}

struct LoopContext {
    shared: Arc<Shared>,
    host: Arc<dyn NotificationHost>,
    runner: Arc<dyn PassRunner>,
    store: Arc<Mutex<Option<NotifyStore>>>,
    ledger: Arc<OwnChangeLedger>,
    stop: Arc<AtomicBool>,
}

async fn run_loop(ctx: LoopContext) {
    loop {
        if ctx.stop.load(Ordering::SeqCst) {
            break;
        }
        let settings = ctx.host.load_settings().await;
        let now = Instant::now();
        let (due_records, due_expiry, due_audit, next_record, next_expiry, next_audit) = {
            let mut schedule = ctx
                .shared
                .schedule
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let intervals_changed = record_interval(&schedule.settings)
                != record_interval(&settings)
                || expiry_interval(&schedule.settings) != expiry_interval(&settings)
                || audit_interval(&schedule.settings) != audit_interval(&settings);
            schedule.settings = settings.clone();
            if ctx.shared.reconfigure.swap(false, Ordering::SeqCst) || intervals_changed {
                schedule.rearm(now);
            }
            let active = settings.service.enabled && !settings.service.paused;
            let backing_off = schedule.backoff_until.is_some_and(|until| until > now);
            let due =
                |next: Option<Instant>| active && !backing_off && next.is_some_and(|n| n <= now);
            (
                due(schedule.next_record),
                due(schedule.next_expiry),
                due(schedule.next_audit),
                schedule.next_record,
                schedule.next_expiry,
                schedule.next_audit,
            )
        };
        if ctx.stop.load(Ordering::SeqCst) {
            break;
        }
        let pass = PassContext {
            shared: &ctx.shared,
            host: &ctx.host,
            runner: &ctx.runner,
            store: &ctx.store,
            ledger: &ctx.ledger,
        };
        if due_expiry {
            pass.run(PassKind::Expiry, &settings).await;
        }
        if due_records {
            pass.run(PassKind::Records, &settings).await;
        }
        // Audit last: the passes share one gate, so the cheap timers should not
        // queue behind a full-account audit when they fall due on the same tick.
        // Its own timer is re-armed by `note_pass` whatever the pass returned,
        // so a failing or erroring audit delays nothing but the next audit.
        if due_audit {
            pass.run(PassKind::Audit, &settings).await;
        }

        let active = settings.service.enabled && !settings.service.paused;
        let sleep_for = if !active {
            IDLE_RECHECK
        } else {
            let now = Instant::now();
            let schedule = ctx
                .shared
                .schedule
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let candidates = [
                schedule.next_record.or(next_record),
                schedule.next_expiry.or(next_expiry),
                schedule.next_audit.or(next_audit),
                schedule.backoff_until,
            ];
            candidates
                .into_iter()
                .flatten()
                .map(|at| at.saturating_duration_since(now))
                .min()
                .unwrap_or(IDLE_RECHECK)
                .max(MIN_SLEEP)
        };
        tokio::select! {
            _ = tokio::time::sleep(sleep_for) => {}
            _ = ctx.shared.wake.notified() => {}
        }
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn notifications_start(
    manager: State<'_, NotificationManager>,
    api_key: String,
    email: Option<String>,
) -> Result<NotificationServiceStatus, String> {
    manager.start(api_key, email).await
}

#[tauri::command]
pub async fn notifications_stop(manager: State<'_, NotificationManager>) -> Result<(), String> {
    manager.stop().await;
    Ok(())
}

#[tauri::command]
pub async fn notifications_status(
    manager: State<'_, NotificationManager>,
) -> Result<NotificationServiceStatus, String> {
    manager.status().await
}

#[tauri::command]
pub async fn notifications_check_now(
    manager: State<'_, NotificationManager>,
    kind: Option<CheckKind>,
) -> Result<NotificationServiceStatus, String> {
    manager.check_now(kind.unwrap_or(CheckKind::All)).await
}

#[tauri::command]
pub async fn notifications_list(
    manager: State<'_, NotificationManager>,
    query: Option<NotificationQuery>,
) -> Result<Vec<Notification>, String> {
    manager.list(query.unwrap_or_default()).await
}

#[tauri::command]
pub async fn notifications_unread_count(
    manager: State<'_, NotificationManager>,
) -> Result<u32, String> {
    manager.unread_count().await
}

#[tauri::command]
pub async fn notifications_mark_read(
    manager: State<'_, NotificationManager>,
    ids: Vec<String>,
    read: Option<bool>,
) -> Result<u32, String> {
    manager.mark_read(ids, read.unwrap_or(true)).await
}

#[tauri::command]
pub async fn notifications_mark_all_read(
    manager: State<'_, NotificationManager>,
) -> Result<u32, String> {
    manager.mark_all_read().await
}

#[tauri::command]
pub async fn notifications_archive(
    manager: State<'_, NotificationManager>,
    ids: Vec<String>,
) -> Result<u32, String> {
    manager.archive(ids).await
}

#[tauri::command]
pub async fn notifications_unarchive(
    manager: State<'_, NotificationManager>,
    ids: Vec<String>,
) -> Result<u32, String> {
    manager.unarchive(ids).await
}

#[tauri::command]
pub async fn notifications_archive_all_read(
    manager: State<'_, NotificationManager>,
) -> Result<u32, String> {
    manager.archive_all_read().await
}

/// Archive every unarchived notification of one kind, and report how many.
#[tauri::command]
pub async fn notifications_archive_kind(
    manager: State<'_, NotificationManager>,
    kind: String,
) -> Result<u32, String> {
    manager.archive_kind(kind).await
}

#[tauri::command]
pub async fn notifications_dismiss(
    manager: State<'_, NotificationManager>,
    ids: Vec<String>,
) -> Result<u32, String> {
    manager.dismiss(ids).await
}

#[tauri::command]
pub async fn notifications_clear_archived(
    manager: State<'_, NotificationManager>,
) -> Result<u32, String> {
    manager.clear_archived().await
}

#[tauri::command]
pub async fn notifications_reconfigure(
    manager: State<'_, NotificationManager>,
) -> Result<NotificationServiceStatus, String> {
    manager.reconfigure().await
}

#[tauri::command]
pub async fn notifications_pause(
    manager: State<'_, NotificationManager>,
) -> Result<NotificationServiceStatus, String> {
    manager.set_paused(true).await
}

#[tauri::command]
pub async fn notifications_resume(
    manager: State<'_, NotificationManager>,
) -> Result<NotificationServiceStatus, String> {
    manager.set_paused(false).await
}

#[tauri::command]
pub async fn notifications_get_settings(
    manager: State<'_, NotificationManager>,
) -> Result<NotificationSettings, String> {
    manager.get_settings().await
}

#[tauri::command]
pub async fn notifications_update_settings(
    manager: State<'_, NotificationManager>,
    settings: NotificationSettings,
) -> Result<NotificationSettings, String> {
    manager.update_settings(settings).await
}

#[tauri::command]
pub async fn notifications_reset_state(
    manager: State<'_, NotificationManager>,
    what: Option<ResetRequest>,
) -> Result<(), String> {
    manager.reset_state(what.unwrap_or_default()).await
}

#[tauri::command]
pub async fn notifications_zone_summary(
    manager: State<'_, NotificationManager>,
) -> Result<Vec<ZoneSummary>, String> {
    manager.zone_summary().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use bc_cloudflare_api::DNSRecord;
    use bc_notify::{NotificationKind, Severity, ZoneRef, ZoneSource};
    use std::sync::atomic::AtomicUsize;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("bc-notify-glue-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// In-memory host: a real `AppConfigStore` on a temp path + memory `Storage`.
    struct TestHost {
        config: AppConfigStore,
        storage: Storage,
        events: StdMutex<Vec<(String, Value)>>,
    }

    impl TestHost {
        fn new(dir: &TestDir) -> Self {
            Self {
                config: AppConfigStore::new(dir.0.join("config")),
                storage: Storage::new(false),
                events: StdMutex::new(Vec::new()),
            }
        }

        fn events(&self, name: &str) -> usize {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(event, _)| event == name)
                .count()
        }
    }

    impl NotificationHost for TestHost {
        fn load_settings(&self) -> BoxFuture<'_, NotificationSettings> {
            Box::pin(async move {
                self.config
                    .get_preferences(
                        || self.storage.get_legacy_preferences(),
                        || self.storage.delete_legacy_preferences(),
                    )
                    .await
                    .ok()
                    .and_then(|p| p.notifications)
                    .map(NotificationSettings::normalize)
                    .unwrap_or_default()
            })
        }

        fn save_settings(
            &self,
            settings: NotificationSettings,
        ) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                let mut fields = Map::new();
                fields.insert(
                    "notifications".to_string(),
                    serde_json::to_value(settings).unwrap(),
                );
                self.config
                    .update_preferences(
                        fields,
                        || self.storage.get_legacy_preferences(),
                        || self.storage.delete_legacy_preferences(),
                    )
                    .await
                    .map_err(|e| e.to_string())
            })
        }

        fn own_audit_record_ids(
            &self,
            since: Option<DateTime<Utc>>,
        ) -> BoxFuture<'_, HashSet<String>> {
            Box::pin(async move {
                let entries = self.storage.get_audit_entries().await.unwrap_or_default();
                own_record_ids_from_audit(&entries, since)
            })
        }

        fn registrar_domains(&self) -> BoxFuture<'_, Vec<DomainInfo>> {
            Box::pin(async { Vec::new() })
        }

        fn emit(&self, event: &str, payload: Value) {
            self.events
                .lock()
                .unwrap()
                .push((event.to_string(), payload));
        }
    }

    /// Fake zone source counting record passes.
    #[derive(Default)]
    struct FakeSource {
        record_calls: AtomicUsize,
        records: StdMutex<Vec<DNSRecord>>,
        /// Times the scheduler dispatched an audit pass.
        audit_passes: AtomicUsize,
        /// Zones an audit pass actually read: still 0 when the kind is off.
        audit_zones: AtomicUsize,
        /// Make the audit pass come back as a failed pass.
        audit_fails: AtomicBool,
    }

    impl ZoneSource for FakeSource {
        async fn list_zones(&self) -> Result<Vec<ZoneRef>, String> {
            Ok(vec![ZoneRef {
                id: "zone1".to_string(),
                name: "example.com".to_string(),
            }])
        }

        async fn list_records(
            &self,
            _zone_id: &str,
            _page: u32,
            _per_page: u32,
        ) -> Result<Vec<DNSRecord>, String> {
            self.record_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.records.lock().unwrap().clone())
        }
    }

    impl PassRunner for FakeSource {
        fn run_record<'a>(
            &'a self,
            store: &'a mut NotifyStore,
            ledger: &'a OwnChangeLedger,
            own_audit_ids: &'a HashSet<String>,
            settings: &'a NotificationSettings,
            now: DateTime<Utc>,
        ) -> BoxFuture<'a, PassReport> {
            Box::pin(bc_notify::run_record_pass(
                self,
                store,
                ledger,
                own_audit_ids,
                settings,
                now,
            ))
        }

        fn run_expiry<'a>(
            &'a self,
            _registrar_domains: &'a [DomainInfo],
            store: &'a mut NotifyStore,
            settings: &'a NotificationSettings,
            now: DateTime<Utc>,
        ) -> BoxFuture<'a, PassReport> {
            // No RDAP in tests: only evaluate cached milestones + retention.
            Box::pin(async move {
                let mut report = PassReport::new(PassKind::Expiry, now);
                report.notifications_created +=
                    bc_notify::evaluate_expiry_milestones(store, settings, now, &mut report);
                store.state_mut().last_expiry_check_at = Some(format_ts(now));
                let _ = store.save_state();
                report
            })
        }

        fn run_audit<'a>(
            &'a self,
            store: &'a mut NotifyStore,
            settings: &'a NotificationSettings,
            now: DateTime<Utc>,
        ) -> BoxFuture<'a, PassReport> {
            Box::pin(async move {
                self.audit_passes.fetch_add(1, Ordering::SeqCst);
                if self.audit_fails.load(Ordering::SeqCst) {
                    // What a zone listing failure looks like to the scheduler.
                    let mut report = PassReport::new(PassKind::Audit, now);
                    report.errors = 1;
                    report.error_messages = vec!["list zones: boom".to_string()];
                    return report;
                }
                let report = bc_notify::run_audit_pass(self, store, settings, now).await;
                self.audit_zones
                    .fetch_add(report.zones_checked as usize, Ordering::SeqCst);
                report
            })
        }
    }

    struct Harness {
        _dir: TestDir,
        manager: NotificationManager,
        host: Arc<TestHost>,
        source: Arc<FakeSource>,
    }

    /// Adapter so the manager can hold `Arc<dyn NotificationHost>` while the
    /// test keeps its own `Arc<TestHost>`.
    struct SharedHost(Arc<TestHost>);

    impl NotificationHost for SharedHost {
        fn load_settings(&self) -> BoxFuture<'_, NotificationSettings> {
            self.0.load_settings()
        }
        fn save_settings(
            &self,
            settings: NotificationSettings,
        ) -> BoxFuture<'_, Result<(), String>> {
            self.0.save_settings(settings)
        }
        fn own_audit_record_ids(
            &self,
            since: Option<DateTime<Utc>>,
        ) -> BoxFuture<'_, HashSet<String>> {
            self.0.own_audit_record_ids(since)
        }
        fn registrar_domains(&self) -> BoxFuture<'_, Vec<DomainInfo>> {
            self.0.registrar_domains()
        }
        fn emit(&self, event: &str, payload: Value) {
            self.0.emit(event, payload)
        }
    }

    async fn harness_with(settings: Option<NotificationSettings>) -> Harness {
        let dir = TestDir::new();
        let host = Arc::new(TestHost::new(&dir));
        if let Some(settings) = settings {
            host.save_settings(settings).await.expect("seed settings");
        }
        let manager = NotificationManager::default();
        manager.attach(dir.0.join("notifications"), SharedHost(Arc::clone(&host)));
        Harness {
            _dir: dir,
            manager,
            host,
            source: Arc::new(FakeSource::default()),
        }
    }

    async fn harness() -> Harness {
        harness_with(None).await
    }

    fn record(id: &str, content: &str) -> DNSRecord {
        serde_json::from_value(json!({
            "id": id,
            "type": "A",
            "name": "www.example.com",
            "content": content,
            "ttl": 300,
            "proxied": false,
            "zone_id": "zone1",
            "zone_name": "example.com",
            "created_on": "2026-08-01T00:00:00Z",
            "modified_on": format!("2026-08-01T00:00:00Z#{content}")
        }))
        .expect("record")
    }

    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    fn fast_settings() -> NotificationSettings {
        let mut settings = NotificationSettings::default();
        settings.service.record_poll_minutes = 5;
        settings
    }

    /// Audit findings on, at the fastest cadences the settings allow: a record
    /// pass every 5 minutes against an audit every 60, so one cadence cannot
    /// pass for the other.
    fn audit_settings() -> NotificationSettings {
        let mut settings = fast_settings();
        settings.kinds.audit_finding.enabled = true;
        settings.service.audit_poll_minutes = 60;
        settings
    }

    /// Advance paused time in 10-minute steps, letting the loop run between
    /// them so a long jump really does produce every tick inside it.
    async fn advance_minutes(minutes: u64) {
        let mut left = minutes;
        while left > 0 {
            let step = left.min(10);
            tokio::time::advance(Duration::from_secs(step * 60)).await;
            settle().await;
            left -= step;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn start_is_idempotent_for_the_same_token_and_stop_drops_it() {
        let h = harness().await;
        let runner: Arc<dyn PassRunner> = h.source.clone();
        h.manager
            .start_with(Arc::clone(&runner), "token-a".into())
            .await
            .expect("start");
        settle().await;
        assert!(h.manager.is_running());
        let first_calls = h.source.record_calls.load(Ordering::SeqCst);
        assert_eq!(first_calls, 1, "catch-up pass runs immediately");

        h.manager
            .start_with(Arc::clone(&runner), "token-a".into())
            .await
            .expect("restart same token");
        settle().await;
        assert_eq!(
            h.source.record_calls.load(Ordering::SeqCst),
            first_calls,
            "same token must not restart the loop"
        );

        h.manager
            .start_with(Arc::clone(&runner), "token-b".into())
            .await
            .expect("restart new token");
        settle().await;
        assert_eq!(
            h.source.record_calls.load(Ordering::SeqCst),
            first_calls + 1,
            "a different token restarts and re-runs catch-up"
        );

        h.manager.stop().await;
        assert!(!h.manager.is_running());
        let status = h.manager.status().await.unwrap();
        assert!(!status.running);
        assert!(status.next_record_check_at.is_none());
        h.manager.stop().await;
        assert!(!h.manager.is_running(), "stop is idempotent");
    }

    #[tokio::test(start_paused = true)]
    async fn catch_up_off_waits_one_interval() {
        let mut settings = fast_settings();
        settings.service.catch_up_on_launch = false;
        let h = harness_with(Some(settings)).await;
        h.manager
            .start_with(h.source.clone(), "token".into())
            .await
            .expect("start");
        settle().await;
        assert_eq!(h.source.record_calls.load(Ordering::SeqCst), 0);
        tokio::time::advance(Duration::from_secs(5 * 60 + 5)).await;
        settle().await;
        assert_eq!(h.source.record_calls.load(Ordering::SeqCst), 1);
        h.manager.shutdown();
    }

    /// Mutation proof (a): make `audit_interval` read `record_poll_minutes`
    /// (or arm `next_audit` from `record_interval` in `rearm`/`start_with`) and
    /// this test fails on the first `audit_passes` assert.
    #[tokio::test(start_paused = true)]
    async fn audit_keeps_its_own_cadence_not_the_record_one() {
        let h = harness_with(Some(audit_settings())).await;
        h.manager
            .start_with(h.source.clone(), "token".into())
            .await
            .expect("start");
        settle().await;

        // Ten record intervals pass. The audit's is 60 minutes, so none of them
        // is an audit, however many times the record pass comes round.
        advance_minutes(50).await;
        let record_calls = h.source.record_calls.load(Ordering::SeqCst);
        assert!(
            record_calls >= 5,
            "the record pass should have ticked repeatedly, saw {record_calls}"
        );
        assert_eq!(
            h.source.audit_passes.load(Ordering::SeqCst),
            0,
            "an audit must not ride the record cadence"
        );

        // Past 60 minutes it fires, once, and does real work.
        advance_minutes(20).await;
        assert_eq!(h.source.audit_passes.load(Ordering::SeqCst), 1);
        assert_eq!(
            h.source.audit_zones.load(Ordering::SeqCst),
            1,
            "the enabled pass audited the monitored zone"
        );
        {
            let store = h.manager.store.lock().await;
            let state = store.as_ref().unwrap().state();
            assert!(state.audit.contains_key("zone1"), "episodes were recorded");
            assert!(state.last_audit_check_at.is_some());
        }
        assert!(
            h.manager
                .list(NotificationQuery::default())
                .await
                .unwrap()
                .iter()
                .any(|n| n.kind == NotificationKind::AuditFinding),
            "a wired-up audit raises its findings"
        );

        // And not again until the next interval.
        advance_minutes(20).await;
        assert_eq!(h.source.audit_passes.load(Ordering::SeqCst), 1);
        advance_minutes(50).await;
        assert_eq!(h.source.audit_passes.load(Ordering::SeqCst), 2);
        h.manager.shutdown();
    }

    /// Mutation proof (b): flip `enabled` to `true` in
    /// `AuditFindingKindSettings::default` and this test fails on `audit_zones`.
    #[tokio::test(start_paused = true)]
    async fn default_settings_do_no_audit_work() {
        let mut settings = fast_settings();
        // Only the cadence is shortened, to bring the daily timer within reach
        // of the test; `kinds.auditFinding` keeps whatever the defaults say.
        settings.service.audit_poll_minutes = 60;
        assert!(
            !settings.kinds.audit_finding.enabled,
            "the kind must still be off by default"
        );
        let h = harness_with(Some(settings)).await;
        h.manager
            .start_with(h.source.clone(), "token".into())
            .await
            .expect("start");
        settle().await;
        advance_minutes(70).await;

        assert!(
            h.source.audit_passes.load(Ordering::SeqCst) >= 1,
            "the timer should have come round"
        );
        assert_eq!(
            h.source.audit_zones.load(Ordering::SeqCst),
            0,
            "a disabled kind must not read a single zone"
        );
        // Nor does asking for every pass by hand.
        h.manager.check_now(CheckKind::All).await.expect("check");
        assert_eq!(h.source.audit_zones.load(Ordering::SeqCst), 0);
        {
            let store = h.manager.store.lock().await;
            assert!(store.as_ref().unwrap().state().audit.is_empty());
        }
        assert!(h
            .manager
            .list(NotificationQuery::default())
            .await
            .unwrap()
            .iter()
            .all(|n| n.kind != NotificationKind::AuditFinding));
        h.manager.shutdown();
    }

    /// The audit is the one pass `catchUpOnLaunch` does not cover.
    #[tokio::test(start_paused = true)]
    async fn catch_up_on_launch_runs_records_but_not_the_audit() {
        let settings = audit_settings();
        assert!(settings.service.catch_up_on_launch, "fixture precondition");
        let h = harness_with(Some(settings)).await;
        h.manager
            .start_with(h.source.clone(), "token".into())
            .await
            .expect("start");
        settle().await;
        assert_eq!(
            h.source.record_calls.load(Ordering::SeqCst),
            1,
            "the record pass still catches up"
        );
        assert_eq!(
            h.source.audit_passes.load(Ordering::SeqCst),
            0,
            "a full-account audit at launch is not what catch-up buys"
        );
        let status = h.manager.status().await.unwrap();
        assert!(
            status.next_audit_check_at.is_some(),
            "it is armed, just not now"
        );

        // A settings save re-arms the timers; that must not conjure an audit
        // either, even though this schedule has never run one.
        h.manager
            .update_settings(audit_settings())
            .await
            .expect("update settings");
        settle().await;
        assert_eq!(h.source.audit_passes.load(Ordering::SeqCst), 0);

        // Asking for one directly is the way to get it immediately.
        h.manager.check_now(CheckKind::Audit).await.expect("check");
        assert_eq!(h.source.audit_passes.load(Ordering::SeqCst), 1);
        assert_eq!(h.source.audit_zones.load(Ordering::SeqCst), 1);
        h.manager.shutdown();
    }

    /// A failing audit is the audit's problem and nobody else's.
    #[tokio::test(start_paused = true)]
    async fn a_failing_audit_leaves_the_other_timers_running() {
        let h = harness_with(Some(audit_settings())).await;
        h.source.audit_fails.store(true, Ordering::SeqCst);
        h.manager
            .start_with(h.source.clone(), "token".into())
            .await
            .expect("start");
        settle().await;
        let records_before = h.source.record_calls.load(Ordering::SeqCst);

        advance_minutes(70).await;
        assert_eq!(
            h.source.audit_passes.load(Ordering::SeqCst),
            1,
            "the audit ran and came back failed"
        );
        assert!(
            h.source.record_calls.load(Ordering::SeqCst) > records_before,
            "the record timer kept ticking through it"
        );
        let status = h.manager.status().await.unwrap();
        assert!(status.next_record_check_at.is_some());
        assert!(
            status.next_audit_check_at.is_some(),
            "re-armed after the failure, not abandoned"
        );
        assert!(status.backoff_until.is_none(), "an error is not a 429");

        advance_minutes(70).await;
        assert_eq!(
            h.source.audit_passes.load(Ordering::SeqCst),
            2,
            "and it comes back round at its own interval"
        );
        assert_eq!(h.source.audit_zones.load(Ordering::SeqCst), 0);
        h.manager.shutdown();
    }

    #[tokio::test(start_paused = true)]
    async fn paused_service_runs_no_pass_but_check_now_does() {
        let mut settings = fast_settings();
        settings.service.paused = true;
        let h = harness_with(Some(settings)).await;
        h.manager
            .start_with(h.source.clone(), "token".into())
            .await
            .expect("start");
        settle().await;
        tokio::time::advance(Duration::from_secs(30 * 60)).await;
        settle().await;
        assert_eq!(
            h.source.record_calls.load(Ordering::SeqCst),
            0,
            "paused: no network"
        );
        let status = h.manager.status().await.unwrap();
        assert!(status.paused && status.running);

        h.manager
            .check_now(CheckKind::Records)
            .await
            .expect("check");
        assert_eq!(h.source.record_calls.load(Ordering::SeqCst), 1);
        assert!(h.host.events(STATUS_EVENT) >= 1);
        h.manager.shutdown();
    }

    #[tokio::test(start_paused = true)]
    async fn reconfigure_rearms_the_interval() {
        let h = harness_with(Some(fast_settings())).await;
        h.manager
            .start_with(h.source.clone(), "token".into())
            .await
            .expect("start");
        settle().await;
        let before = h.manager.status().await.unwrap().next_record_check_at;
        let mut settings = fast_settings();
        settings.service.record_poll_minutes = 60;
        h.manager
            .update_settings(settings)
            .await
            .expect("update settings");
        settle().await;
        let after = h.manager.status().await.unwrap().next_record_check_at;
        assert!(before.is_some() && after.is_some());
        assert!(
            parse_ts(after.as_deref().unwrap()) > parse_ts(before.as_deref().unwrap()),
            "the next tick must move out with the longer interval"
        );
        tokio::time::advance(Duration::from_secs(6 * 60)).await;
        settle().await;
        assert_eq!(
            h.source.record_calls.load(Ordering::SeqCst),
            1,
            "the old 5-minute tick must not fire"
        );
        h.manager.shutdown();
    }

    #[tokio::test]
    async fn update_settings_persists_normalized_and_get_returns_it() {
        let h = harness().await;
        let mut settings = NotificationSettings::default();
        settings.service.record_poll_minutes = 1; // below min → 5
        settings.expiry.milestones = vec![1, 1, 400, 30];
        let returned = h.manager.update_settings(settings).await.expect("update");
        assert_eq!(returned.service.record_poll_minutes, 5);
        assert_eq!(returned.expiry.milestones, vec![30, 1]);
        let loaded = h.manager.get_settings().await.expect("get");
        assert_eq!(loaded, returned);
        // Persisted under Preferences.notifications as one object.
        let prefs = h
            .host
            .config
            .get_preferences(|| async { Ok(None) }, || async { Ok(()) })
            .await
            .unwrap();
        assert_eq!(prefs.notifications.as_ref(), Some(&returned));
    }

    #[tokio::test]
    async fn pause_and_resume_persist_service_paused() {
        let h = harness().await;
        let status = h.manager.set_paused(true).await.expect("pause");
        assert!(status.paused);
        assert!(h.manager.get_settings().await.unwrap().service.paused);
        let status = h.manager.set_paused(false).await.expect("resume");
        assert!(!status.paused);
        assert!(!h.manager.get_settings().await.unwrap().service.paused);
    }

    #[tokio::test(start_paused = true)]
    async fn external_change_notifies_but_own_change_does_not() {
        let h = harness_with(Some(fast_settings())).await;
        *h.source.records.lock().unwrap() = vec![record("r1", "1.1.1.1"), record("r2", "2.2.2.2")];
        h.manager
            .start_with(h.source.clone(), "token".into())
            .await
            .expect("start");
        settle().await;
        assert_eq!(h.manager.unread_count().await.unwrap(), 0, "baseline only");

        // r1 edited in the app (ledger), r2 edited elsewhere.
        h.manager.ledger().note("zone1", "r1", "update");
        *h.source.records.lock().unwrap() = vec![record("r1", "1.1.1.2"), record("r2", "9.9.9.9")];
        h.manager
            .check_now(CheckKind::Records)
            .await
            .expect("check");
        let items = h
            .manager
            .list(NotificationQuery::default())
            .await
            .expect("list");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].payload["recordId"], "r2");
        assert_eq!(h.host.events(CHANGED_EVENT), 1);

        // Audit-log backstop: r2 deleted through the app after a crash (no ledger entry).
        h.host
            .storage
            .add_audit_entry(json!({
                "operation": "dns:delete",
                "resource": "r2",
                "zone_id": "zone1",
                "timestamp": format_ts(Utc::now() + chrono::Duration::seconds(1)),
            }))
            .await
            .unwrap();
        *h.source.records.lock().unwrap() = vec![record("r1", "1.1.1.2")];
        h.manager
            .check_now(CheckKind::Records)
            .await
            .expect("check");
        assert_eq!(
            h.manager
                .list(NotificationQuery::default())
                .await
                .unwrap()
                .len(),
            1
        );
        h.manager.shutdown();
    }

    #[tokio::test]
    async fn inbox_commands_report_counts_and_emit_changed() {
        let h = harness().await;
        {
            let mut store = h.manager.store.lock().await;
            let store = store.as_mut().unwrap();
            for i in 0..3 {
                store
                    .insert_deduped(Notification::new(
                        bc_notify::NotificationKind::Service,
                        bc_notify::Severity::Info,
                        format!("t{i}"),
                        "b",
                        format!("k{i}"),
                        json!({}),
                        Utc::now(),
                    ))
                    .unwrap();
            }
        }
        let ids: Vec<String> = h
            .manager
            .list(NotificationQuery::default())
            .await
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect();
        assert_eq!(h.manager.unread_count().await.unwrap(), 3);
        assert_eq!(
            h.manager
                .mark_read(vec![ids[0].clone()], true)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            h.manager
                .mark_read(vec![ids[0].clone()], false)
                .await
                .unwrap(),
            1
        );
        assert_eq!(h.manager.mark_all_read().await.unwrap(), 3);
        assert_eq!(h.manager.archive(vec![ids[1].clone()]).await.unwrap(), 1);
        assert_eq!(h.manager.unarchive(vec![ids[1].clone()]).await.unwrap(), 1);
        assert_eq!(h.manager.archive_all_read().await.unwrap(), 3);
        assert_eq!(h.manager.dismiss(vec![ids[2].clone()]).await.unwrap(), 1);
        assert_eq!(h.manager.clear_archived().await.unwrap(), 2);
        assert_eq!(h.host.events(CHANGED_EVENT), 8);
        assert!(h
            .manager
            .list(NotificationQuery::default())
            .await
            .unwrap()
            .is_empty());
    }

    /// A refreshed expiry countdown must be invisible to the OS notification
    /// centre. What a pass "created" is decided here by diffing the inbox's ids
    /// across it (see `PassContext::run`), so that is the quantity to assert on:
    /// a refresh keeps the item's id, and therefore cannot reach `notify_os`.
    #[test]
    fn a_refreshed_expiry_countdown_is_not_something_the_pass_created() {
        let dir = TestDir::new();
        let mut store = NotifyStore::open(dir.0.join("notifications")).expect("open store");
        let settings = NotificationSettings::default();
        let written = Utc::now();
        // Twelve days out: warning severity, so it does clear every OS gate and
        // a silent second alert would really show up in `sent`.
        let expires = written + chrono::Duration::days(12) + chrono::Duration::hours(1);
        bc_notify::record_expiry(&mut store, "example.com", Some(expires), "rdap", written);
        let mut report = PassReport::new(PassKind::Expiry, written);
        assert_eq!(
            bc_notify::evaluate_expiry_milestones(&mut store, &settings, written, &mut report),
            1
        );
        let host = OsRecordingHost::default();
        let created: Vec<Notification> = store.items().to_vec();
        assert_eq!(
            send_os_notifications(&host, &created, &settings, written),
            1
        );

        // Four days on: no new milestone, so the pass only corrects the figure.
        let later = written + chrono::Duration::days(4);
        let before: HashSet<String> = store.items().iter().map(|n| n.id.clone()).collect();
        let mut report = PassReport::new(PassKind::Expiry, later);
        assert_eq!(
            bc_notify::evaluate_expiry_milestones(&mut store, &settings, later, &mut report),
            0
        );
        assert_eq!(report.notifications_refreshed, 1);
        let created: Vec<Notification> = store
            .items()
            .iter()
            .filter(|n| !before.contains(&n.id))
            .cloned()
            .collect();
        assert!(created.is_empty(), "a refresh keeps the item it corrects");
        assert_eq!(send_os_notifications(&host, &created, &settings, later), 0);
        assert_eq!(
            host.sent.lock().unwrap().len(),
            1,
            "one alert for the milestone, none for the countdown"
        );
        assert_eq!(store.items()[0].payload["daysLeft"], json!(8));
    }

    /// The inbox panel renders `daysLeft` straight off the payload, so a pass
    /// that corrected it has to say so even though it created nothing.
    #[tokio::test(start_paused = true)]
    async fn an_expiry_pass_that_only_refreshes_still_announces_the_change() {
        let h = harness_with(Some(fast_settings())).await;
        h.manager
            .start_with(h.source.clone(), "token".into())
            .await
            .expect("start");
        settle().await;
        let expires = Utc::now() + chrono::Duration::days(12) + chrono::Duration::hours(1);
        let (id, created_at) = {
            let mut store = h.manager.store.lock().await;
            let store = store.as_mut().unwrap();
            bc_notify::record_expiry(store, "example.com", Some(expires), "rdap", Utc::now());
            store
                .state_mut()
                .expiry
                .get_mut("example.com")
                .expect("seeded expiry")
                .emitted = vec![14, 30, 60, 90];
            // The notice as it was written two days ago, when 14 days were left:
            // the right date, a figure that has since gone stale.
            let stale = bc_notify::build_expiry_notification(
                &NotificationSettings::default(),
                "example.com",
                Some(("zone1", "example.com")),
                expires,
                14,
                14,
                "rdap",
                Utc::now() - chrono::Duration::days(2),
            );
            let id = stale.id.clone();
            let created_at = stale.created_at.clone();
            store.insert_deduped(stale).expect("seed notice");
            store
                .mark_read(std::slice::from_ref(&id), true)
                .expect("read it");
            (id, created_at)
        };

        let before = h.host.events(CHANGED_EVENT);
        h.manager
            .check_now(CheckKind::Expiry)
            .await
            .expect("check now");
        let last = h
            .manager
            .status()
            .await
            .unwrap()
            .last_pass
            .expect("last pass");
        assert_eq!(last.kind, PassKind::Expiry);
        assert_eq!(last.notifications_created, 0, "nothing new, so no alert");
        assert_eq!(
            h.host.events(CHANGED_EVENT),
            before + 1,
            "the inbox still has to hear that the figure moved"
        );

        let item = h
            .manager
            .list(NotificationQuery::default())
            .await
            .unwrap()
            .into_iter()
            .find(|n| n.id == id)
            .expect("the same notice, corrected");
        assert_eq!(item.created_at, created_at, "a refresh does not re-date it");
        assert!(item.read_at.is_some());
        assert_eq!(item.payload["daysLeft"], json!(12));
        assert_eq!(h.manager.unread_count().await.unwrap(), 0);
        h.manager.shutdown();
    }

    #[tokio::test(start_paused = true)]
    async fn reset_state_deletes_only_what_was_asked() {
        let h = harness_with(Some(fast_settings())).await;
        *h.source.records.lock().unwrap() = vec![record("r1", "1.1.1.1")];
        h.manager
            .start_with(h.source.clone(), "token".into())
            .await
            .expect("start");
        settle().await;
        {
            let mut store = h.manager.store.lock().await;
            let store = store.as_mut().unwrap();
            store
                .insert_deduped(Notification::new(
                    bc_notify::NotificationKind::Service,
                    bc_notify::Severity::Info,
                    "t",
                    "b",
                    "k",
                    json!({}),
                    Utc::now(),
                ))
                .unwrap();
            bc_notify::record_expiry(
                store,
                "example.com",
                Some(Utc::now() + chrono::Duration::days(10)),
                "rdap",
                Utc::now(),
            );
            store
                .state_mut()
                .expiry
                .get_mut("example.com")
                .unwrap()
                .emitted = vec![14];
            store.save_state().unwrap();
            assert!(store.has_snapshot("zone1"));
        }
        h.manager
            .reset_state(ResetRequest {
                expiry_ledger: true,
                ..ResetRequest::default()
            })
            .await
            .unwrap();
        {
            let store = h.manager.store.lock().await;
            let store = store.as_ref().unwrap();
            assert!(store.state().expiry["example.com"].emitted.is_empty());
            assert!(store.state().expiry["example.com"].expires_at.is_some());
            assert!(store.has_snapshot("zone1"), "snapshots untouched");
            assert_eq!(store.len(), 1, "inbox untouched");
        }
        h.manager
            .reset_state(ResetRequest {
                snapshots: true,
                ..ResetRequest::default()
            })
            .await
            .unwrap();
        {
            let store = h.manager.store.lock().await;
            let store = store.as_ref().unwrap();
            assert!(!store.has_snapshot("zone1"));
            assert_eq!(store.len(), 1);
        }
        h.manager
            .reset_state(ResetRequest {
                inbox: true,
                ..ResetRequest::default()
            })
            .await
            .unwrap();
        assert!(h.manager.store.lock().await.as_ref().unwrap().is_empty());
        h.manager.shutdown();
    }

    #[tokio::test(start_paused = true)]
    async fn zone_summary_reflects_state_and_settings() {
        let mut settings = fast_settings();
        settings.zones.exclude = vec!["zone1".to_string()];
        let h = harness_with(Some(settings)).await;
        h.manager
            .start_with(h.source.clone(), "token".into())
            .await
            .expect("start");
        settle().await;
        // Excluded zone is not polled, so seed its state directly.
        {
            let mut store = h.manager.store.lock().await;
            let store = store.as_mut().unwrap();
            store
                .state_mut()
                .zones
                .entry("zone1".into())
                .or_default()
                .zone_name = "example.com".into();
            bc_notify::record_expiry(
                store,
                "example.com",
                Some(Utc::now() + chrono::Duration::days(20) + chrono::Duration::hours(12)),
                "registrar",
                Utc::now(),
            );
        }
        let summary = h.manager.zone_summary().await.unwrap();
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0].zone_id, "zone1");
        assert!(!summary[0].monitored);
        assert_eq!(summary[0].days_left, Some(20));
        assert_eq!(summary[0].expiry_source.as_deref(), Some("registrar"));
        h.manager.shutdown();
    }

    #[test]
    fn own_record_ids_filter_by_operation_and_timestamp() {
        let since = parse_ts("2026-08-26T10:00:00.000Z");
        let entries = vec![
            json!({"operation": "dns:update", "resource": "new", "timestamp": "2026-08-26T10:00:01.000Z"}),
            json!({"operation": "dns:create", "resource": "old", "timestamp": "2026-08-26T09:00:00.000Z"}),
            json!({"operation": "dns:export", "resource": "zone", "timestamp": "2026-08-26T10:00:01.000Z"}),
            json!({"operation": "dns:delete", "resource": "nots"}),
        ];
        let ids = own_record_ids_from_audit(&entries, since);
        assert_eq!(ids, HashSet::from(["new".to_string()]));
        let all = own_record_ids_from_audit(&entries, None);
        assert_eq!(all.len(), 3);
    }

    /// A record the user's own assistant or MCP client changed is the
    /// application's own change, not an outside one.
    ///
    /// Those two writers reach the Cloudflare client directly and log a tool
    /// call rather than a `dns:*` operation, so reading only `dns:*` reported
    /// the user's own action back to them as a change made outside the app.
    #[test]
    fn a_tool_calls_own_change_is_not_an_outside_change() {
        let entries = vec![
            json!({
                "operation": "assistant:tool_call",
                "resource": "cf_update_dns_record",
                "actor": "assistant",
                "outcome": "succeeded",
                "effect": "write",
                "record_id": "by-assistant",
                "timestamp": "2026-08-26T10:00:01.000Z",
            }),
            json!({
                "operation": "mcp:tool_call",
                "resource": "cf_delete_dns_record",
                "actor": "mcp_client",
                "outcome": "succeeded",
                "effect": "destructive",
                "record_id": "by-mcp",
                "timestamp": "2026-08-26T10:00:01.000Z",
            }),
        ];
        let ids = own_record_ids_from_audit(&entries, None);
        assert_eq!(
            ids,
            HashSet::from(["by-assistant".to_string(), "by-mcp".to_string()])
        );
    }

    /// A call that changed nothing must not be claimed as our own change.
    ///
    /// Claiming it would suppress the notification for a genuine outside
    /// change to the very same record, which is worse than the false alarm
    /// this whole path exists to avoid.
    #[test]
    fn a_tool_call_that_changed_nothing_claims_no_record() {
        let entries = vec![
            json!({
                "operation": "assistant:tool_call", "resource": "cf_update_dns_record",
                "outcome": "denied", "effect": "write", "record_id": "refused",
                "timestamp": "2026-08-26T10:00:01.000Z",
            }),
            json!({
                "operation": "assistant:tool_call", "resource": "cf_update_dns_record",
                "outcome": "failed", "effect": "write", "record_id": "errored",
                "timestamp": "2026-08-26T10:00:01.000Z",
            }),
            json!({
                "operation": "mcp:tool_call", "resource": "cf_get_dns_record",
                "outcome": "succeeded", "effect": "read", "record_id": "only-read",
                "timestamp": "2026-08-26T10:00:01.000Z",
            }),
            json!({
                "operation": "mcp:tool_call", "resource": "cf_analyze_zone",
                "outcome": "succeeded", "effect": "analysis", "record_id": "analysed",
                "timestamp": "2026-08-26T10:00:01.000Z",
            }),
            json!({
                "operation": "mcp:server_start", "resource": "127.0.0.1:8787",
                "outcome": "succeeded", "timestamp": "2026-08-26T10:00:01.000Z",
            }),
        ];
        assert!(own_record_ids_from_audit(&entries, None).is_empty());
    }

    #[test]
    fn status_and_reset_request_wire_shapes_are_camel_case() {
        let request: ResetRequest =
            serde_json::from_value(json!({ "expiryLedger": true })).expect("partial request");
        assert!(request.expiry_ledger && !request.snapshots && !request.inbox);
        let kind: CheckKind = serde_json::from_value(json!("records")).expect("kind");
        assert_eq!(kind, CheckKind::Records);
        let kind: CheckKind = serde_json::from_value(json!("audit")).expect("kind");
        assert_eq!(kind, CheckKind::Audit);
        let status = serde_json::to_value(NotificationServiceStatus {
            running: true,
            enabled: true,
            paused: false,
            quiet_hours_active: false,
            zones_tracked: 0,
            unread: 0,
            last_record_check_at: None,
            last_expiry_check_at: None,
            last_audit_check_at: None,
            next_record_check_at: None,
            next_expiry_check_at: None,
            next_audit_check_at: None,
            next_check_at: None,
            backoff_until: None,
            last_error: None,
            last_pass: Some(PassSummary::from(&PassReport::new(
                PassKind::Audit,
                parse_ts("2026-09-04T00:00:00.000Z").expect("timestamp"),
            ))),
        })
        .unwrap();
        assert!(status.get("quietHoursActive").is_some());
        assert!(status.get("nextRecordCheckAt").is_some());
        assert!(status.get("nextAuditCheckAt").is_some());
        assert!(status.get("lastAuditCheckAt").is_some());
        // The audit's tag reaches the frontend through `lastPass`, unchanged by
        // the collapse of its own kind enum into `PassKind`.
        assert_eq!(status["lastPass"]["kind"], json!("audit"));
    }

    /// Host that only records what reaches the OS notification centre.
    #[derive(Default)]
    struct OsRecordingHost {
        sent: StdMutex<Vec<String>>,
        fail: bool,
    }

    impl NotificationHost for OsRecordingHost {
        fn load_settings(&self) -> BoxFuture<'_, NotificationSettings> {
            Box::pin(async { NotificationSettings::default() })
        }
        fn save_settings(&self, _: NotificationSettings) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn own_audit_record_ids(&self, _: Option<DateTime<Utc>>) -> BoxFuture<'_, HashSet<String>> {
            Box::pin(async { HashSet::new() })
        }
        fn registrar_domains(&self) -> BoxFuture<'_, Vec<DomainInfo>> {
            Box::pin(async { Vec::new() })
        }
        fn emit(&self, _: &str, _: Value) {}
        fn notify_os(&self, notification: &Notification) -> Result<(), String> {
            if self.fail {
                return Err("no notification centre".into());
            }
            self.sent.lock().unwrap().push(notification.id.clone());
            Ok(())
        }
    }

    fn os_item(kind: NotificationKind, severity: Severity, zone: Option<&str>) -> Notification {
        let mut n = Notification::new(
            kind,
            severity,
            "title",
            "body",
            uuid::Uuid::new_v4().to_string(),
            Value::Null,
            Utc::now(),
        );
        n.zone_id = zone.map(str::to_string);
        n
    }

    #[test]
    fn os_send_decision_respects_every_settings_gate() {
        use bc_notify::settings::{MinSeverity, ZoneOverride};
        let now = Utc::now();
        let created = vec![
            os_item(NotificationKind::RecordChange, Severity::Info, Some("z1")),
            os_item(
                NotificationKind::RecordChange,
                Severity::Warning,
                Some("z1"),
            ),
            os_item(
                NotificationKind::RecordChange,
                Severity::Critical,
                Some("muted"),
            ),
            os_item(NotificationKind::DomainExpiry, Severity::Critical, None),
            os_item(NotificationKind::Service, Severity::Critical, None),
        ];
        let ids = |v: Vec<&Notification>| v.iter().map(|n| n.id.clone()).collect::<Vec<_>>();

        // Defaults: minSeverity = warning, service kind has osNotify = false.
        let defaults = NotificationSettings::default().normalize();
        assert_eq!(
            ids(os_notifications_due(&created, &defaults, now)),
            vec![
                created[1].id.clone(),
                created[2].id.clone(),
                created[3].id.clone()
            ]
        );

        // Master switch off → nothing.
        let mut off = defaults.clone();
        off.os_notifications.enabled = false;
        assert!(os_notifications_due(&created, &off, now).is_empty());

        // Min severity critical drops the warning; kind toggle drops record changes.
        let mut critical = defaults.clone();
        critical.os_notifications.min_severity = MinSeverity::Critical;
        assert_eq!(
            ids(os_notifications_due(&created, &critical, now)),
            vec![created[2].id.clone(), created[3].id.clone()]
        );
        let mut no_records = defaults.clone();
        no_records.kinds.record_change.os_notify = false;
        assert_eq!(
            ids(os_notifications_due(&created, &no_records, now)),
            vec![created[3].id.clone()]
        );

        // Per-zone mute drops that zone only.
        let mut muted = defaults.clone();
        muted.zones.overrides.insert(
            "muted".into(),
            ZoneOverride {
                muted: true,
                ..ZoneOverride::default()
            },
        );
        assert_eq!(
            ids(os_notifications_due(&created, &muted, now)),
            vec![created[1].id.clone(), created[3].id.clone()]
        );

        // Quiet hours (all day, every day, UTC) silence the OS channel entirely.
        let mut quiet = defaults.clone();
        quiet.quiet_hours.enabled = true;
        quiet.quiet_hours.start = "00:00".into();
        quiet.quiet_hours.end = "23:59".into();
        quiet.quiet_hours.days = (0..7).collect();
        quiet.quiet_hours.timezone = "UTC".into();
        let quiet = quiet.normalize();
        assert!(
            quiet.quiet_hours_active(now),
            "fixture window must cover now"
        );
        assert!(os_notifications_due(&created, &quiet, now).is_empty());

        // The host receives exactly the gated set; failures never propagate.
        let host = OsRecordingHost::default();
        assert_eq!(send_os_notifications(&host, &created, &defaults, now), 3);
        assert_eq!(host.sent.lock().unwrap().len(), 3);
        let failing = OsRecordingHost {
            fail: true,
            ..OsRecordingHost::default()
        };
        assert_eq!(send_os_notifications(&failing, &created, &defaults, now), 0);
    }
}
