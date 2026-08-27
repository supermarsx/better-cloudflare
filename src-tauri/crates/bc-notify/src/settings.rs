//! `NotificationSettings`: the single, versioned preference object shared by the
//! Rust service and the UI. `normalize()` is the source of truth for limits; the
//! TypeScript mirror is parity-tested against `test/fixtures/notification-settings.json`.

use std::collections::BTreeMap;

use chrono::{DateTime, Datelike, NaiveDateTime, NaiveTime, TimeZone, Timelike, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::diff::{ChangeKind, DiffField};
use crate::model::{parse_ts, NotificationKind, Severity};

pub const SETTINGS_VERSION: u32 = 1;

pub const RECORD_POLL_MINUTES: (u32, u32) = (5, 1440);
pub const EXPIRY_POLL_MINUTES: (u32, u32) = (60, 10080);
pub const RDAP_CACHE_HOURS: (u32, u32) = (6, 168);
pub const MAX_ZONES_PER_PASS: (u32, u32) = (1, 1000);
pub const BACKOFF_MAX_MINUTES: (u32, u32) = (5, 1440);
pub const MILESTONE_RANGE: (u32, u32) = (1, 365);
pub const MAX_MILESTONES: usize = 12;
pub const SEVERITY_THRESHOLD_RANGE: (u32, u32) = (0, 365);
pub const ARCHIVE_DAYS_RANGE: (u32, u32) = (1, 365);
pub const MAX_ITEMS_RANGE: (u32, u32) = (100, 10000);
pub const DEFAULT_MILESTONES: [u32; 7] = [90, 60, 30, 14, 7, 3, 1];

// ── lenient deserialisation helpers ──────────────────────────────────────────

/// Deserialize `T`, falling back to `T::default()` when the JSON does not fit
/// (unknown enum string, wrong type). Missing keys are handled by `#[serde(default)]`.
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let value = Value::deserialize(deserializer)?;
    Ok(T::deserialize(value).unwrap_or_default())
}

/// Deserialize a list keeping only elements that are non-negative integers.
fn lenient_u32_list<'de, D>(deserializer: D) -> Result<Vec<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(match value {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| item.as_u64().and_then(|n| u32::try_from(n).ok()))
            .collect(),
        _ => Vec::new(),
    })
}

/// Deserialize a list keeping only string elements.
fn lenient_string_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(match value {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    })
}

/// `Option<u32>` where `null` = None and any other non-integer becomes the default.
fn lenient_opt_u32<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Null => Ok(None),
        Value::Number(n) => n
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("expected a non-negative integer or null")),
        _ => Err(serde::de::Error::custom(
            "expected a non-negative integer or null",
        )),
    }
}

fn clamp(value: u32, (min, max): (u32, u32)) -> u32 {
    value.clamp(min, max)
}

fn dedup_ids(list: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in list {
        let id = raw.trim();
        if id.is_empty() || out.iter().any(|seen| seen == id) {
            continue;
        }
        out.push(id.to_string());
    }
    out
}

// ── enums ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SeverityMode {
    #[default]
    Auto,
    Info,
    Warning,
    Critical,
}

impl SeverityMode {
    pub fn fixed(self) -> Option<Severity> {
        match self {
            SeverityMode::Auto => None,
            SeverityMode::Info => Some(Severity::Info),
            SeverityMode::Warning => Some(Severity::Warning),
            SeverityMode::Critical => Some(Severity::Critical),
        }
    }
}

/// `SeverityMode` whose default is `info` (the `service` kind).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceSeverityMode {
    Auto,
    #[default]
    Info,
    Warning,
    Critical,
}

impl ServiceSeverityMode {
    pub fn resolve(self) -> Severity {
        match self {
            ServiceSeverityMode::Auto | ServiceSeverityMode::Info => Severity::Info,
            ServiceSeverityMode::Warning => Severity::Warning,
            ServiceSeverityMode::Critical => Severity::Critical,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExpirySource {
    #[default]
    Auto,
    Rdap,
    Registrar,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ZoneMode {
    #[default]
    All,
    Allowlist,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuietBehaviour {
    #[default]
    Silence,
    Hold,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MinSeverity {
    Info,
    #[default]
    Warning,
    Critical,
}

impl MinSeverity {
    pub fn allows(self, severity: Severity) -> bool {
        let floor = match self {
            MinSeverity::Info => Severity::Info,
            MinSeverity::Warning => Severity::Warning,
            MinSeverity::Critical => Severity::Critical,
        };
        severity >= floor
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToastMinSeverity {
    Info,
    Warning,
    #[default]
    Critical,
    Never,
}

impl ToastMinSeverity {
    pub fn allows(self, severity: Severity) -> bool {
        match self {
            ToastMinSeverity::Never => false,
            ToastMinSeverity::Info => true,
            ToastMinSeverity::Warning => severity >= Severity::Warning,
            ToastMinSeverity::Critical => severity >= Severity::Critical,
        }
    }
}

// ── sections ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServiceSettings {
    pub enabled: bool,
    pub paused: bool,
    pub catch_up_on_launch: bool,
    pub record_poll_minutes: u32,
    pub expiry_poll_minutes: u32,
    pub rdap_cache_hours: u32,
    pub max_zones_per_pass: u32,
    pub backoff_max_minutes: u32,
}

impl Default for ServiceSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            paused: false,
            catch_up_on_launch: true,
            record_poll_minutes: 15,
            expiry_poll_minutes: 360,
            rdap_cache_hours: 24,
            max_zones_per_pass: 200,
            backoff_max_minutes: 120,
        }
    }
}

impl ServiceSettings {
    fn normalize(mut self) -> Self {
        self.record_poll_minutes = clamp(self.record_poll_minutes, RECORD_POLL_MINUTES);
        self.expiry_poll_minutes = clamp(self.expiry_poll_minutes, EXPIRY_POLL_MINUTES);
        self.rdap_cache_hours = clamp(self.rdap_cache_hours, RDAP_CACHE_HOURS);
        self.max_zones_per_pass = clamp(self.max_zones_per_pass, MAX_ZONES_PER_PASS);
        self.backoff_max_minutes = clamp(self.backoff_max_minutes, BACKOFF_MAX_MINUTES);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExpiryKindSettings {
    pub enabled: bool,
    #[serde(deserialize_with = "lenient")]
    pub severity: SeverityMode,
    pub os_notify: bool,
}

impl Default for ExpiryKindSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            severity: SeverityMode::Auto,
            os_notify: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChangeSubKinds {
    pub added: bool,
    pub changed: bool,
    pub removed: bool,
}

impl Default for ChangeSubKinds {
    fn default() -> Self {
        Self {
            added: true,
            changed: true,
            removed: true,
        }
    }
}

impl ChangeSubKinds {
    pub fn allows(&self, change: ChangeKind) -> bool {
        match change {
            ChangeKind::Added => self.added,
            ChangeKind::Changed => self.changed,
            ChangeKind::Removed => self.removed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RecordChangeKindSettings {
    pub enabled: bool,
    #[serde(deserialize_with = "lenient")]
    pub severity: SeverityMode,
    pub os_notify: bool,
    #[serde(deserialize_with = "lenient")]
    pub changes: ChangeSubKinds,
    #[serde(deserialize_with = "lenient_string_list")]
    pub fields: Vec<String>,
}

impl Default for RecordChangeKindSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            severity: SeverityMode::Auto,
            os_notify: true,
            changes: ChangeSubKinds::default(),
            fields: DiffField::all()
                .iter()
                .map(|f| f.as_str().to_string())
                .collect(),
        }
    }
}

impl RecordChangeKindSettings {
    fn normalize(mut self) -> Self {
        let selected: Vec<String> = DiffField::all()
            .iter()
            .filter(|field| self.fields.iter().any(|name| name == field.as_str()))
            .map(|field| field.as_str().to_string())
            .collect();
        self.fields = if selected.is_empty() {
            Self::default().fields
        } else {
            selected
        };
        self
    }

    /// The `DiffField`s that participate in change detection.
    pub fn diff_fields(&self) -> Vec<DiffField> {
        self.fields
            .iter()
            .filter_map(|f| DiffField::parse(f))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServiceKindSettings {
    pub enabled: bool,
    #[serde(deserialize_with = "lenient")]
    pub severity: ServiceSeverityMode,
    pub os_notify: bool,
}

impl Default for ServiceKindSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            severity: ServiceSeverityMode::Info,
            os_notify: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KindSettings {
    #[serde(deserialize_with = "lenient")]
    pub domain_expiry: ExpiryKindSettings,
    #[serde(deserialize_with = "lenient")]
    pub record_change: RecordChangeKindSettings,
    #[serde(deserialize_with = "lenient")]
    pub service: ServiceKindSettings,
}

impl KindSettings {
    pub fn enabled(&self, kind: NotificationKind) -> bool {
        match kind {
            NotificationKind::DomainExpiry => self.domain_expiry.enabled,
            NotificationKind::RecordChange => self.record_change.enabled,
            NotificationKind::Service => self.service.enabled,
        }
    }

    pub fn os_notify(&self, kind: NotificationKind) -> bool {
        match kind {
            NotificationKind::DomainExpiry => self.domain_expiry.os_notify,
            NotificationKind::RecordChange => self.record_change.os_notify,
            NotificationKind::Service => self.service.os_notify,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SeverityByMilestone {
    pub warning_at_or_below: u32,
    pub critical_at_or_below: u32,
}

impl Default for SeverityByMilestone {
    fn default() -> Self {
        Self {
            warning_at_or_below: 14,
            critical_at_or_below: 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExpirySettings {
    #[serde(deserialize_with = "lenient_u32_list")]
    pub milestones: Vec<u32>,
    pub notify_expired: bool,
    #[serde(deserialize_with = "lenient")]
    pub source: ExpirySource,
    #[serde(deserialize_with = "lenient")]
    pub severity_by_milestone: SeverityByMilestone,
}

impl Default for ExpirySettings {
    fn default() -> Self {
        Self {
            milestones: DEFAULT_MILESTONES.to_vec(),
            notify_expired: true,
            source: ExpirySource::Auto,
            severity_by_milestone: SeverityByMilestone::default(),
        }
    }
}

impl ExpirySettings {
    fn normalize(mut self) -> Self {
        self.milestones = crate::expiry::normalize_milestones(self.milestones);
        let warning = clamp(
            self.severity_by_milestone.warning_at_or_below,
            SEVERITY_THRESHOLD_RANGE,
        );
        let critical = clamp(
            self.severity_by_milestone.critical_at_or_below,
            SEVERITY_THRESHOLD_RANGE,
        )
        .min(warning);
        self.severity_by_milestone = SeverityByMilestone {
            warning_at_or_below: warning,
            critical_at_or_below: critical,
        };
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ZoneKindOverride {
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub domain_expiry: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub record_change: Option<bool>,
}

impl ZoneKindOverride {
    fn is_empty(&self) -> bool {
        self.domain_expiry.is_none() && self.record_change.is_none()
    }

    pub fn get(&self, kind: NotificationKind) -> Option<bool> {
        match kind {
            NotificationKind::DomainExpiry => self.domain_expiry,
            NotificationKind::RecordChange => self.record_change,
            NotificationKind::Service => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ZoneOverride {
    pub muted: bool,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub muted_until: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub kinds: Option<ZoneKindOverride>,
}

impl ZoneOverride {
    fn normalize(mut self, now: DateTime<Utc>) -> Option<Self> {
        self.muted_until = self.muted_until.and_then(|raw| {
            let ts = parse_ts(&raw)?;
            (ts > now).then_some(raw)
        });
        self.kinds = self.kinds.filter(|kinds| !kinds.is_empty());
        if !self.muted && self.muted_until.is_none() && self.kinds.is_none() {
            None
        } else {
            Some(self)
        }
    }

    /// True while the zone is muted (`muted` or a future `mutedUntil`).
    pub fn is_muted(&self, now: DateTime<Utc>) -> bool {
        self.muted
            || self
                .muted_until
                .as_deref()
                .and_then(parse_ts)
                .map(|until| until > now)
                .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ZoneSettings {
    #[serde(deserialize_with = "lenient")]
    pub mode: ZoneMode,
    #[serde(deserialize_with = "lenient_string_list")]
    pub include: Vec<String>,
    #[serde(deserialize_with = "lenient_string_list")]
    pub exclude: Vec<String>,
    #[serde(deserialize_with = "lenient")]
    pub overrides: BTreeMap<String, ZoneOverride>,
}

impl ZoneSettings {
    fn normalize(mut self, now: DateTime<Utc>) -> Self {
        self.include = dedup_ids(self.include);
        self.exclude = dedup_ids(self.exclude);
        self.overrides = self
            .overrides
            .into_iter()
            .filter_map(|(id, value)| {
                let id = id.trim().to_string();
                if id.is_empty() {
                    return None;
                }
                value.normalize(now).map(|v| (id, v))
            })
            .collect();
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QuietHoursSettings {
    pub enabled: bool,
    pub start: String,
    pub end: String,
    #[serde(deserialize_with = "lenient_u32_list")]
    pub days: Vec<u32>,
    pub timezone: String,
    #[serde(deserialize_with = "lenient")]
    pub behaviour: QuietBehaviour,
}

impl Default for QuietHoursSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            start: "22:00".into(),
            end: "07:00".into(),
            days: (0..7).collect(),
            timezone: "local".into(),
            behaviour: QuietBehaviour::Silence,
        }
    }
}

impl QuietHoursSettings {
    fn normalize(mut self) -> Self {
        let defaults = Self::default();
        if parse_hhmm(&self.start).is_none() || parse_hhmm(&self.end).is_none() {
            self.enabled = false;
            self.start = defaults.start;
            self.end = defaults.end;
        }
        let mut days: Vec<u32> = self.days.into_iter().filter(|d| *d <= 6).collect();
        days.sort_unstable();
        days.dedup();
        self.days = if days.is_empty() { defaults.days } else { days };
        if !is_valid_timezone(&self.timezone) {
            self.timezone = defaults.timezone;
        }
        self
    }

    /// Whether the quiet window covers the given wall-clock time.
    /// Days use the JS convention (0 = Sunday) and apply to the calendar day of `local`.
    pub fn covers(&self, local: NaiveDateTime) -> bool {
        if !self.enabled {
            return false;
        }
        let (Some(start), Some(end)) = (parse_hhmm(&self.start), parse_hhmm(&self.end)) else {
            return false;
        };
        let weekday = local.weekday().num_days_from_sunday();
        if !self.days.contains(&weekday) {
            return false;
        }
        let t = local.time();
        if start <= end {
            t >= start && t < end
        } else {
            t >= start || t < end
        }
    }

    /// Convert a UTC instant to the configured zone's wall clock.
    pub fn to_local(&self, now: DateTime<Utc>) -> NaiveDateTime {
        if self.timezone == "local" {
            return now.with_timezone(&chrono::Local).naive_local();
        }
        match self.timezone.parse::<chrono_tz::Tz>() {
            Ok(tz) => now.with_timezone(&tz).naive_local(),
            Err(_) => now.with_timezone(&chrono::Local).naive_local(),
        }
    }

    pub fn active_at(&self, now: DateTime<Utc>) -> bool {
        self.covers(self.to_local(now))
    }

    /// The next wall-clock instant (UTC) at which the window ends, if currently active.
    pub fn window_end(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        if !self.active_at(now) {
            return None;
        }
        let end = parse_hhmm(&self.end)?;
        let local = self.to_local(now);
        let mut candidate = local.date().and_time(end);
        if candidate <= local {
            candidate += chrono::Duration::days(1);
        }
        let delta = candidate - local;
        Some(now + delta)
    }
}

pub fn parse_hhmm(value: &str) -> Option<NaiveTime> {
    let (h, m) = value.split_once(':')?;
    if h.len() != 2 || m.len() != 2 || !h.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if !m.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hour: u32 = h.parse().ok()?;
    let minute: u32 = m.parse().ok()?;
    NaiveTime::from_hms_opt(hour, minute, 0)
}

pub fn is_valid_timezone(value: &str) -> bool {
    value == "local" || value.parse::<chrono_tz::Tz>().is_ok()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OsNotificationSettings {
    pub enabled: bool,
    #[serde(deserialize_with = "lenient")]
    pub min_severity: MinSeverity,
}

impl Default for OsNotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            min_severity: MinSeverity::Warning,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InAppSettings {
    #[serde(deserialize_with = "lenient")]
    pub toast_min_severity: ToastMinSeverity,
    pub badge: bool,
}

impl Default for InAppSettings {
    fn default() -> Self {
        Self {
            toast_min_severity: ToastMinSeverity::Critical,
            badge: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RetentionSettings {
    #[serde(deserialize_with = "lenient_opt_u32")]
    pub auto_archive_read_after_days: Option<u32>,
    #[serde(deserialize_with = "lenient_opt_u32")]
    pub purge_archived_after_days: Option<u32>,
    pub max_items: u32,
    pub keep_snapshots: bool,
}

impl Default for RetentionSettings {
    fn default() -> Self {
        Self {
            auto_archive_read_after_days: Some(30),
            purge_archived_after_days: Some(90),
            max_items: 2000,
            keep_snapshots: true,
        }
    }
}

impl RetentionSettings {
    fn normalize(mut self) -> Self {
        self.auto_archive_read_after_days = self
            .auto_archive_read_after_days
            .map(|d| clamp(d, ARCHIVE_DAYS_RANGE));
        self.purge_archived_after_days = self
            .purge_archived_after_days
            .map(|d| clamp(d, ARCHIVE_DAYS_RANGE));
        self.max_items = clamp(self.max_items, MAX_ITEMS_RANGE);
        self
    }
}

// ── root ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NotificationSettings {
    pub version: u32,
    #[serde(deserialize_with = "lenient")]
    pub service: ServiceSettings,
    #[serde(deserialize_with = "lenient")]
    pub kinds: KindSettings,
    #[serde(deserialize_with = "lenient")]
    pub expiry: ExpirySettings,
    #[serde(deserialize_with = "lenient")]
    pub zones: ZoneSettings,
    #[serde(deserialize_with = "lenient")]
    pub quiet_hours: QuietHoursSettings,
    #[serde(deserialize_with = "lenient")]
    pub os_notifications: OsNotificationSettings,
    #[serde(deserialize_with = "lenient")]
    pub in_app: InAppSettings,
    #[serde(deserialize_with = "lenient")]
    pub retention: RetentionSettings,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            service: ServiceSettings::default(),
            kinds: KindSettings::default(),
            expiry: ExpirySettings::default(),
            zones: ZoneSettings::default(),
            quiet_hours: QuietHoursSettings::default(),
            os_notifications: OsNotificationSettings::default(),
            in_app: InAppSettings::default(),
            retention: RetentionSettings::default(),
        }
    }
}

impl NotificationSettings {
    /// Clamp, dedupe and default every field (see the fixture for the rules).
    pub fn normalize(self) -> Self {
        self.normalize_at(Utc::now())
    }

    pub fn normalize_at(self, now: DateTime<Utc>) -> Self {
        Self {
            version: SETTINGS_VERSION,
            service: self.service.normalize(),
            kinds: KindSettings {
                domain_expiry: self.kinds.domain_expiry,
                record_change: self.kinds.record_change.normalize(),
                service: self.kinds.service,
            },
            expiry: self.expiry.normalize(),
            zones: self.zones.normalize(now),
            quiet_hours: self.quiet_hours.normalize(),
            os_notifications: self.os_notifications,
            in_app: self.in_app,
            retention: self.retention.normalize(),
        }
    }

    /// Parse a JSON value leniently and normalize. Never fails: garbage → defaults.
    pub fn from_value(value: &Value) -> Self {
        serde_json::from_value::<Self>(value.clone())
            .unwrap_or_default()
            .normalize()
    }

    /// Whether the service polls zone `zone_id` at all (allowlist/exclude; mute is separate).
    pub fn is_zone_monitored(&self, zone_id: &str) -> bool {
        match self.zones.mode {
            ZoneMode::Allowlist => self.zones.include.iter().any(|id| id == zone_id),
            ZoneMode::All => !self.zones.exclude.iter().any(|id| id == zone_id),
        }
    }

    pub fn is_zone_muted(&self, zone_id: &str, now: DateTime<Utc>) -> bool {
        self.zones
            .overrides
            .get(zone_id)
            .map(|o| o.is_muted(now))
            .unwrap_or(false)
    }

    /// Kind toggle for a zone: global kind switch AND per-zone override.
    pub fn zone_kind_enabled(&self, zone_id: &str, kind: NotificationKind) -> bool {
        if !self.kinds.enabled(kind) {
            return false;
        }
        self.zones
            .overrides
            .get(zone_id)
            .and_then(|o| o.kinds.as_ref())
            .and_then(|k| k.get(kind))
            .unwrap_or(true)
    }

    pub fn quiet_hours_active(&self, now: DateTime<Utc>) -> bool {
        self.quiet_hours.active_at(now)
    }

    /// Severity for an expiry notice given days left (`<= 0` = expired).
    pub fn severity_for_expiry(&self, days_left: i64) -> Severity {
        if let Some(fixed) = self.kinds.domain_expiry.severity.fixed() {
            return fixed;
        }
        let thresholds = &self.expiry.severity_by_milestone;
        if days_left <= 0 || days_left <= i64::from(thresholds.critical_at_or_below) {
            Severity::Critical
        } else if days_left <= i64::from(thresholds.warning_at_or_below) {
            Severity::Warning
        } else {
            Severity::Info
        }
    }

    pub fn severity_for_change(&self, change: ChangeKind) -> Severity {
        if let Some(fixed) = self.kinds.record_change.severity.fixed() {
            return fixed;
        }
        match change {
            ChangeKind::Removed => Severity::Critical,
            ChangeKind::Added | ChangeKind::Changed => Severity::Warning,
        }
    }

    pub fn severity_for_service(&self) -> Severity {
        self.kinds.service.severity.resolve()
    }

    /// Whether an OS notification may be shown for this item right now.
    pub fn os_notify_allowed(
        &self,
        kind: NotificationKind,
        severity: Severity,
        zone_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> bool {
        self.os_notifications.enabled
            && self.kinds.os_notify(kind)
            && self.os_notifications.min_severity.allows(severity)
            && !self.quiet_hours_active(now)
            && zone_id.map(|z| !self.is_zone_muted(z, now)).unwrap_or(true)
    }

    /// Whether an in-app toast may be shown for this item right now.
    pub fn toast_allowed(&self, severity: Severity, now: DateTime<Utc>) -> bool {
        self.in_app.toast_min_severity.allows(severity) && !self.quiet_hours_active(now)
    }
}

/// Convenience: hour/minute of a local time for tests and status lines.
pub fn hhmm(time: NaiveTime) -> String {
    format!("{:02}:{:02}", time.hour(), time.minute())
}

/// Build a UTC instant from a wall-clock time in the given IANA zone (`None` when invalid).
pub fn utc_from_zone(zone: &str, local: NaiveDateTime) -> Option<DateTime<Utc>> {
    let tz: chrono_tz::Tz = zone.parse().ok()?;
    tz.from_local_datetime(&local)
        .single()
        .map(|dt| dt.with_timezone(&Utc))
}
