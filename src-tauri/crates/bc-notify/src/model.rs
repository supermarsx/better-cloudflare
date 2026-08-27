//! Wire model for notifications (serde camelCase; shared with the frontend).

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Maximum page size a `NotificationQuery` may request.
pub const MAX_QUERY_LIMIT: u32 = 500;
/// Page size used when a query does not specify one.
pub const DEFAULT_QUERY_LIMIT: u32 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationKind {
    DomainExpiry,
    RecordChange,
    Service,
}

impl NotificationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NotificationKind::DomainExpiry => "domain_expiry",
            NotificationKind::RecordChange => "record_change",
            NotificationKind::Service => "service",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "domain_expiry" => Some(NotificationKind::DomainExpiry),
            "record_change" => Some(NotificationKind::RecordChange),
            "service" => Some(NotificationKind::Service),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::Critical => "critical",
        }
    }
}

/// One inbox item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    pub kind: NotificationKind,
    pub severity: Severity,
    #[serde(default)]
    pub zone_id: Option<String>,
    #[serde(default)]
    pub zone_name: Option<String>,
    pub title: String,
    pub body: String,
    pub created_at: String,
    #[serde(default)]
    pub read_at: Option<String>,
    #[serde(default)]
    pub archived_at: Option<String>,
    pub dedupe_key: String,
    #[serde(default)]
    pub payload: Value,
}

impl Notification {
    pub fn new(
        kind: NotificationKind,
        severity: Severity,
        title: impl Into<String>,
        body: impl Into<String>,
        dedupe_key: impl Into<String>,
        payload: Value,
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            severity,
            zone_id: None,
            zone_name: None,
            title: title.into(),
            body: body.into(),
            created_at: format_ts(now),
            read_at: None,
            archived_at: None,
            dedupe_key: dedupe_key.into(),
            payload,
        }
    }

    pub fn with_zone(mut self, zone_id: impl Into<String>, zone_name: impl Into<String>) -> Self {
        self.zone_id = Some(zone_id.into());
        self.zone_name = Some(zone_name.into());
        self
    }

    pub fn is_unread(&self) -> bool {
        self.read_at.is_none()
    }

    pub fn is_archived(&self) -> bool {
        self.archived_at.is_some()
    }

    pub fn created_at_utc(&self) -> Option<DateTime<Utc>> {
        parse_ts(&self.created_at)
    }
}

/// Inbox scope for `NotificationQuery`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// Every non-archived item.
    #[default]
    All,
    /// Non-archived items without `readAt`.
    Unread,
    /// Archived items only.
    Archived,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NotificationQuery {
    pub scope: Scope,
    /// Kind filter (`domain_expiry` | `record_change` | `service`). Unknown values match nothing.
    pub kind: Option<String>,
    pub zone_id: Option<String>,
    /// Page size, clamped to `MAX_QUERY_LIMIT`; default `DEFAULT_QUERY_LIMIT`.
    pub limit: Option<u32>,
    /// Cursor: only items with `createdAt` strictly before this RFC 3339 timestamp.
    pub before: Option<String>,
}

impl NotificationQuery {
    pub fn effective_limit(&self) -> usize {
        self.limit
            .unwrap_or(DEFAULT_QUERY_LIMIT)
            .clamp(1, MAX_QUERY_LIMIT) as usize
    }
}

/// Format a timestamp the way every wire field in this crate does.
pub fn format_ts(ts: DateTime<Utc>) -> String {
    ts.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Parse an RFC 3339 timestamp; `None` when malformed.
pub fn parse_ts(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|ts| ts.with_timezone(&Utc))
}
