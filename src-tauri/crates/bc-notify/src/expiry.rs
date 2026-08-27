//! Domain-expiry milestones and RDAP payload parsing.

use std::collections::HashSet;

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{json, Value};

use crate::model::{format_ts, Notification, NotificationKind};
use crate::settings::{NotificationSettings, MAX_MILESTONES, MILESTONE_RANGE};

/// Milestone value that stands for "expired" (days left <= 0). Always on.
pub const EXPIRED_MILESTONE: u32 = 0;

/// Filter to `1..=365`, dedupe, sort descending, keep the largest 12.
pub fn normalize_milestones(milestones: Vec<u32>) -> Vec<u32> {
    let mut out: Vec<u32> = milestones
        .into_iter()
        .filter(|m| (MILESTONE_RANGE.0..=MILESTONE_RANGE.1).contains(m))
        .collect();
    out.sort_unstable_by(|a, b| b.cmp(a));
    out.dedup();
    out.truncate(MAX_MILESTONES);
    out
}

/// Whole days between `now` and `expires_at` (truncated; `<= 0` means expired).
pub fn days_left(expires_at: DateTime<Utc>, now: DateTime<Utc>) -> i64 {
    (expires_at - now).num_days()
}

/// Among milestones `m` with `days_left <= m` that were not yet emitted, return
/// the smallest (the one to notify about) and every newly-emitted milestone
/// (all qualifying ones, so a first run at 20 days yields one 30-day notice and
/// marks 90/60/30). `0` (expired) is implicit and qualifies when `days_left <= 0`.
pub fn due_milestone(
    days_left: i64,
    milestones: &[u32],
    emitted: &HashSet<u32>,
) -> (Option<u32>, Vec<u32>) {
    let mut newly: Vec<u32> = milestones
        .iter()
        .copied()
        .chain(std::iter::once(EXPIRED_MILESTONE))
        .filter(|m| {
            let qualifies = if *m == EXPIRED_MILESTONE {
                days_left <= 0
            } else {
                days_left <= i64::from(*m)
            };
            qualifies && !emitted.contains(m)
        })
        .collect();
    newly.sort_unstable();
    newly.dedup();
    let due = newly.first().copied();
    (due, newly)
}

/// Extract the expiration date from an RDAP domain object
/// (`events[].eventAction` containing "expiration", `eventDate` RFC 3339).
pub fn parse_rdap_expiry(value: &Value) -> Option<DateTime<Utc>> {
    let events = value.get("events")?.as_array()?;
    for event in events {
        let action = event
            .get("eventAction")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !action.contains("expiration") {
            continue;
        }
        if let Some(date) = event.get("eventDate").and_then(Value::as_str) {
            if let Some(parsed) = parse_flexible_date(date) {
                return Some(parsed);
            }
        }
    }
    None
}

/// Parse RFC 3339, or a bare `YYYY-MM-DD` (registrar APIs sometimes return dates only).
pub fn parse_flexible_date(value: &str) -> Option<DateTime<Utc>> {
    let value = value.trim();
    if let Ok(ts) = DateTime::parse_from_rfc3339(value) {
        return Some(ts.with_timezone(&Utc));
    }
    if let Ok(ts) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
        return Some(ts.and_utc());
    }
    if let Ok(ts) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S") {
        return Some(ts.and_utc());
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc())
}

/// Ledger key for a milestone: a renewal (new date) resets every milestone.
pub fn milestone_key(domain: &str, expires_at: DateTime<Utc>, milestone: u32) -> String {
    format!(
        "expiry:{domain}:{}:{milestone}",
        expires_at.date_naive().format("%Y-%m-%d")
    )
}

#[allow(clippy::too_many_arguments)]
pub fn build_expiry_notification(
    settings: &NotificationSettings,
    domain: &str,
    zone: Option<(&str, &str)>,
    expires_at: DateTime<Utc>,
    days_left: i64,
    milestone: u32,
    source: &str,
    now: DateTime<Utc>,
) -> Notification {
    let severity = settings.severity_for_expiry(days_left);
    let date = expires_at.date_naive().format("%Y-%m-%d").to_string();
    let (title, body) = if milestone == EXPIRED_MILESTONE {
        (
            format!("{domain} has expired"),
            format!("The domain registration for {domain} expired on {date}. Renew it now to keep the zone online."),
        )
    } else {
        let days = if days_left <= 1 {
            "1 day".to_string()
        } else {
            format!("{days_left} days")
        };
        (
            format!("{domain} expires in {days}"),
            format!("The domain registration for {domain} expires on {date} ({milestone}-day reminder, source: {source})."),
        )
    };
    let mut notification = Notification::new(
        NotificationKind::DomainExpiry,
        severity,
        title,
        body,
        milestone_key(domain, expires_at, milestone),
        json!({
            "domain": domain,
            "expiresAt": format_ts(expires_at),
            "daysLeft": days_left,
            "milestone": milestone,
            "source": source,
        }),
        now,
    );
    if let Some((zone_id, zone_name)) = zone {
        notification = notification.with_zone(zone_id, zone_name);
    }
    notification
}
