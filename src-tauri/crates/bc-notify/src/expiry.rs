//! Domain-expiry milestones and RDAP payload parsing.

use std::collections::HashSet;

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{json, Value};

use crate::model::{format_ts, parse_ts, Notification, NotificationKind, Severity};
use crate::settings::{
    NotificationSettings, StaleExpiryAction, MAX_MILESTONES, MILESTONE_RANGE,
};

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

fn date_only(expires_at: DateTime<Utc>) -> String {
    expires_at.date_naive().format("%Y-%m-%d").to_string()
}

/// How to name the notice in prose. `0` is the expired notice, which is not a
/// countdown and must not be called a "0-day reminder".
fn notice_label(milestone: u32) -> String {
    if milestone == EXPIRED_MILESTONE {
        "expiry notice".to_string()
    } else {
        format!("{milestone}-day reminder")
    }
}

/// Title and body for an expiry notice, from the date and the days left at the
/// instant it is being written — which is every pass, not just the first: see
/// [`refresh_expiry_notification`].
fn render_expiry(
    domain: &str,
    expires_at: DateTime<Utc>,
    days_left: i64,
    milestone: u32,
    source: &str,
) -> (String, String) {
    let date = date_only(expires_at);
    if milestone == EXPIRED_MILESTONE {
        return (
            format!("{domain} has expired"),
            format!("The domain registration for {domain} expired on {date}. Renew it now to keep the zone online."),
        );
    }
    let days = if days_left <= 1 {
        "1 day".to_string()
    } else {
        format!("{days_left} days")
    };
    (
        format!("{domain} expires in {days}"),
        format!("The domain registration for {domain} expires on {date} ({milestone}-day reminder, source: {source})."),
    )
}

/// The `domain_expiry` payload. `expiresAt` and `daysLeft` are the pair the
/// frontend renders from, so a refresh rewrites both together or neither.
fn expiry_payload(
    domain: &str,
    expires_at: DateTime<Utc>,
    days_left: i64,
    milestone: u32,
    source: &str,
) -> Value {
    json!({
        "domain": domain,
        "expiresAt": format_ts(expires_at),
        "daysLeft": days_left,
        "milestone": milestone,
        "source": source,
    })
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
    let (title, body) = render_expiry(domain, expires_at, days_left, milestone, source);
    let mut notification = Notification::new(
        NotificationKind::DomainExpiry,
        settings.severity_for_expiry(days_left),
        title,
        body,
        milestone_key(domain, expires_at, milestone),
        expiry_payload(domain, expires_at, days_left, milestone, source),
        now,
    );
    if let Some((zone_id, zone_name)) = zone {
        notification = notification.with_zone(zone_id, zone_name);
    }
    notification
}

/// What a refresh needs back out of an existing notice: which domain it is
/// about, which date it was written for, which milestone it stands for, and
/// whether a pass has already withdrawn it.
struct ExpiryNotice {
    domain: String,
    expires_at: DateTime<Utc>,
    milestone: u32,
    superseded: bool,
}

/// Read an expiry notice's identity back out of its payload. `None` for
/// anything this module did not write (a payload missing a field, or carrying a
/// malformed date), which the refresh then leaves exactly as it found it.
fn read_expiry_notice(payload: &Value) -> Option<ExpiryNotice> {
    let domain = payload.get("domain")?.as_str()?.to_string();
    let expires_at = parse_ts(payload.get("expiresAt")?.as_str()?)?;
    let milestone = u32::try_from(payload.get("milestone")?.as_u64()?).ok()?;
    Some(ExpiryNotice {
        domain,
        expires_at,
        milestone,
        superseded: payload
            .get("superseded")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// The domain an expiry notice is about, without parsing the rest of it.
pub fn expiry_payload_domain(payload: &Value) -> Option<&str> {
    payload.get("domain")?.as_str()
}

/// What [`refresh_expiry_notification`] did to one notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpiryRefresh {
    /// The notice already says what the held date says at `now`: untouched, and
    /// in particular not re-written to disk.
    Unchanged,
    /// The countdown was recomputed against the same date.
    Refreshed,
    /// The notice was written for a date the registry no longer reports, so it
    /// was rewritten to state the new date and archived.
    Withdrawn,
}

/// Bring one existing expiry notice into line with `expires_at` at `now`.
///
/// This is the *refresh* half of the expiry kind, and it is deliberately not an
/// alert. It rewrites `title`, `body`, `severity` and the payload in place and
/// touches nothing else: `id`, `dedupeKey`, `createdAt` and `readAt` all
/// survive, so a refreshed notice is not in the set of items a pass added (the
/// Tauri layer diffs ids to decide what reaches the OS notification centre),
/// does not come back unread, and does not re-toast (the frontend toasts on
/// `createdAt`). Crossing a *new* milestone is the only thing that alerts, and
/// that still goes through [`build_expiry_notification`] and `deliver`.
///
/// `expires_at` is the date the store already holds — no lookup happens here,
/// which is why the countdown can be corrected on every pass while the date
/// itself is re-fetched only on `service.rdapCacheHours`.
///
/// When the held date is not the date the notice was written for, the notice no
/// longer applies — a renewal makes "expires in 12 days" false, and a false
/// warning left in the inbox is what teaches someone to ignore the whole
/// feature. What to do about it is `expiry.on_date_change`
/// ([`crate::settings::StaleExpiryAction`]); none of its options deletes
/// anything, and the milestone ledger was cleared by [`crate::record_expiry`]
/// when the date moved, so whatever milestone the *new* date crosses is raised
/// separately, as its own notification under its own key.
///
/// `expiry.refresh_countdown = false` turns off the countdown half only. A
/// notice the date has outrun is still dealt with: "do not tick the countdown"
/// is not "keep telling me something untrue".
pub fn refresh_expiry_notification(
    settings: &NotificationSettings,
    notification: &mut Notification,
    expires_at: DateTime<Utc>,
    source: &str,
    now: DateTime<Utc>,
) -> ExpiryRefresh {
    let Some(notice) = read_expiry_notice(&notification.payload) else {
        return ExpiryRefresh::Unchanged;
    };
    // A notice a pass has already withdrawn is finished. Without this, a
    // `resolve`d one — which stays in the inbox, its payload now carrying the
    // new date — would match on the next pass and have its withdrawal wording
    // overwritten by an ordinary countdown.
    if notice.superseded {
        return ExpiryRefresh::Unchanged;
    }
    let days = days_left(expires_at, now);
    // Day granularity, matching `milestone_key` and `record_expiry`: a registry
    // that re-states the same day at a different hour has not changed anything.
    if expires_at.date_naive() != notice.expires_at.date_naive() {
        return supersede(settings, notification, &notice, expires_at, days, source, now);
    }
    if !settings.expiry.refresh_countdown {
        return ExpiryRefresh::Unchanged;
    }
    let (title, body) = render_expiry(&notice.domain, expires_at, days, notice.milestone, source);
    let severity = settings.severity_for_expiry(days);
    let payload = expiry_payload(&notice.domain, expires_at, days, notice.milestone, source);
    // An expired notice reads the same on day 3 as on day 1 while its
    // `daysLeft` keeps falling, so the payload has to be part of this.
    if notification.title == title
        && notification.body == body
        && notification.severity == severity
        && notification.payload == payload
    {
        return ExpiryRefresh::Unchanged;
    }
    notification.title = title;
    notification.body = body;
    notification.severity = severity;
    notification.payload = payload;
    ExpiryRefresh::Refreshed
}

/// Deal with a notice the registry date has outrun, per `expiry.on_date_change`.
#[allow(clippy::too_many_arguments)]
fn supersede(
    settings: &NotificationSettings,
    notification: &mut Notification,
    notice: &ExpiryNotice,
    expires_at: DateTime<Utc>,
    days_left: i64,
    source: &str,
    now: DateTime<Utc>,
) -> ExpiryRefresh {
    let domain = &notice.domain;
    if settings.expiry.on_date_change == StaleExpiryAction::Update {
        // Re-point the notice at the new date, milestone and all, and say it the
        // way a notice for that date would be said. The dedupe key moves with
        // it: leaving the old date in the key would let a later re-emission of
        // this same milestone — after a ledger reset, say — insert a second row
        // saying exactly what this one now says.
        let (title, body) = render_expiry(domain, expires_at, days_left, notice.milestone, source);
        notification.title = title;
        notification.body = body;
        notification.severity = settings.severity_for_expiry(days_left);
        notification.payload =
            expiry_payload(domain, expires_at, days_left, notice.milestone, source);
        notification.dedupe_key = milestone_key(domain, expires_at, notice.milestone);
        return ExpiryRefresh::Refreshed;
    }

    let label = notice_label(notice.milestone);
    let previous = date_only(notice.expires_at);
    let date = date_only(expires_at);
    notification.title = if expires_at > notice.expires_at {
        format!("{domain} was renewed")
    } else {
        format!("{domain} expiry date moved earlier")
    };
    notification.body = format!(
        "The domain registration for {domain} now expires on {date}, not {previous} as this \
         {label} said (source: {source}). The {label} no longer applies and has been withdrawn."
    );
    // A withdrawn warning is not a warning, whatever grade it was issued at.
    notification.severity = Severity::Info;
    let mut payload = expiry_payload(domain, expires_at, days_left, notice.milestone, source);
    if let Some(map) = payload.as_object_mut() {
        map.insert("superseded".to_string(), Value::Bool(true));
        map.insert(
            "previousExpiresAt".to_string(),
            Value::String(format_ts(notice.expires_at)),
        );
    }
    notification.payload = payload;
    match settings.expiry.on_date_change {
        StaleExpiryAction::Archive => notification.archive_at(now),
        // Out of the unread count, still on the screen.
        StaleExpiryAction::Resolve => notification.mark_read_at(now),
        StaleExpiryAction::Update => unreachable!("handled above"),
    }
    ExpiryRefresh::Withdrawn
}
