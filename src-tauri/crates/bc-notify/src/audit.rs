//! Scheduled domain audit: episode tracking and notification bodies.
//!
//! The findings themselves come from `bc-domain-audit`, which is the one audit
//! engine — nothing here re-implements a check. This module only decides *when*
//! a finding is news and how to say it.

use std::collections::BTreeMap;

use bc_domain_audit::AuditItem;
use chrono::{DateTime, Duration, Utc};
use serde_json::json;

use crate::model::{format_ts, parse_ts, Notification, NotificationKind};
use crate::settings::NotificationSettings;
use crate::store::AuditFindingState;

/// How long a closed episode is remembered after the finding stopped being
/// reported. Long enough that "this came back" is still accurate for a zone
/// someone is actively fixing; short enough that state does not accumulate for
/// findings nobody will see again. Forgetting one early only costs the
/// "came back" wording — a recurrence still notifies, as a first sighting.
pub const RESOLVED_EPISODE_RETENTION_DAYS: i64 = 30;

/// Findings the scheduled pass never raises, whatever the settings say.
///
/// `domain-expiry` is the `domain_expiry` kind's ground, and the pass
/// deliberately withholds the expiry date from the audit (see
/// [`crate::settings::AuditFindingKindSettings::audit_options`]). All the
/// finding can report here is that the date is unavailable — which would be
/// noise at best and, since the expiry pass does have the date, wrong.
pub const EXCLUDED_FINDING_IDS: &[&str] = &["domain-expiry"];

/// Whether this finding is one the scheduled pass never raises.
pub fn is_excluded(item: &AuditItem) -> bool {
    EXCLUDED_FINDING_IDS.contains(&item.id.as_str())
}

/// A finding that is news: either not seen before, seen at another severity, or
/// resolved and now back.
#[derive(Debug, Clone)]
pub struct AuditAlert<'a> {
    pub item: &'a AuditItem,
    /// Start of the episode this alert opens — the dedupe key's changing input.
    pub episode_started_at: String,
    /// The finding had been resolved and has come back.
    pub regressed: bool,
}

/// Dedupe key for an audit finding.
///
/// Identity is (zone, finding id, audit severity, episode start), the same
/// shape as [`crate::diff::change_dedupe_key`]: the first three say *which*
/// finding this is, and the episode start is what makes a second episode of the
/// same finding a different notification. Without it a finding that was fixed
/// and regressed would collide with the still-unarchived notice from the first
/// time and stay silent, which is the failure this whole module exists to avoid.
///
/// The finding's `details` is deliberately not an input. Several findings list
/// the records they flagged (TTL outliers, TXT sprawl, CNAME conflicts), so
/// including it would restart the episode every time an unrelated record moved.
pub fn audit_dedupe_key(zone_id: &str, item: &AuditItem, episode_started_at: &str) -> String {
    format!(
        "audit:{zone_id}:{}:{}:{episode_started_at}",
        item.id,
        item.severity.as_str()
    )
}

/// Decide what is news for one zone and what its episode state becomes.
///
/// `findings` must already be filtered to the findings the user wants (see
/// [`crate::settings::AuditFindingKindSettings::allows`]) — a finding excluded
/// by the severity threshold or the category filter counts as not reported, so
/// lowering the threshold later surfaces it as a new episode.
pub fn reconcile_findings<'a>(
    previous: &BTreeMap<String, AuditFindingState>,
    findings: &'a [AuditItem],
    now: DateTime<Utc>,
) -> (BTreeMap<String, AuditFindingState>, Vec<AuditAlert<'a>>) {
    let stamp = format_ts(now);
    let mut next: BTreeMap<String, AuditFindingState> = BTreeMap::new();
    let mut alerts: Vec<AuditAlert<'a>> = Vec::new();

    for item in findings {
        let prior = previous.get(&item.id);
        let same_episode = prior.filter(|state| {
            state.resolved_at.is_none() && state.severity == item.severity.as_str()
        });
        match same_episode {
            // Still open at the same severity: already said once, say nothing.
            Some(state) => {
                next.insert(
                    item.id.clone(),
                    AuditFindingState {
                        last_seen_at: stamp.clone(),
                        ..state.clone()
                    },
                );
            }
            // New, back after a fix, or now at a different severity.
            None => {
                next.insert(
                    item.id.clone(),
                    AuditFindingState {
                        severity: item.severity.as_str().to_string(),
                        first_seen_at: stamp.clone(),
                        last_seen_at: stamp.clone(),
                        resolved_at: None,
                    },
                );
                alerts.push(AuditAlert {
                    item,
                    episode_started_at: stamp.clone(),
                    regressed: prior.is_some_and(|state| state.resolved_at.is_some()),
                });
            }
        }
    }

    // Findings this pass did not report: close the episode, and remember it for
    // a while so a recurrence can be told apart from a first sighting.
    let cutoff = now - Duration::days(RESOLVED_EPISODE_RETENTION_DAYS);
    for (id, state) in previous {
        if next.contains_key(id) {
            continue;
        }
        let resolved_at = state.resolved_at.clone().unwrap_or_else(|| stamp.clone());
        let expired = parse_ts(&resolved_at).is_some_and(|at| at <= cutoff);
        if !expired {
            next.insert(
                id.clone(),
                AuditFindingState {
                    resolved_at: Some(resolved_at),
                    ..state.clone()
                },
            );
        }
    }

    (next, alerts)
}

/// One notification for one audit finding.
///
/// The body names the zone, states the finding in the audit's own words, and
/// ends on something to do: the record the audit suggests, or — for findings
/// with no single record to add — a pointer back at the audit for that zone.
pub fn build_audit_notification(
    settings: &NotificationSettings,
    zone_id: &str,
    zone_name: &str,
    alert: &AuditAlert<'_>,
    now: DateTime<Utc>,
) -> Notification {
    let item = alert.item;
    let severity = settings.severity_for_audit(item.severity);
    let title = format!("{zone_name}: {}", item.title);

    let mut body = String::new();
    if alert.regressed {
        body.push_str("This was fixed and has come back. ");
    }
    body.push_str(&format!(
        "The scheduled audit of {zone_name} reports: {}",
        item.details.trim()
    ));
    match &item.suggestion {
        Some(suggestion) => body.push_str(&format!(
            "\n\nSuggested record \u{2014} {} {}: {}",
            suggestion.record_type, suggestion.name, suggestion.content
        )),
        None => body.push_str(&format!(
            "\n\nRun the domain audit for {zone_name} to review this finding against the zone."
        )),
    }

    Notification::new(
        NotificationKind::AuditFinding,
        severity,
        title,
        body,
        audit_dedupe_key(zone_id, item, &alert.episode_started_at),
        json!({
            "findingId": item.id,
            "category": item.category.as_str(),
            "auditSeverity": item.severity.as_str(),
            "auditTitle": item.title,
            "details": item.details,
            "suggestion": item.suggestion,
            "regressed": alert.regressed,
            "episodeStartedAt": alert.episode_started_at,
        }),
        now,
    )
    .with_zone(zone_id, zone_name)
}
