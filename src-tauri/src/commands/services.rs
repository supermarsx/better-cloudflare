use bc_cloudflare_api::CloudflareError;
use bc_storage::{AuditEntry, AuditOutcome, AuditTrail};
use chrono::{DateTime, Duration, Utc};
use serde_json::json;
use tauri::State;

use crate::cloudflare_api::{
    CloudflareClient, EmailRoutingRule, EmailRoutingSettings, FirewallRule, FirewallRuleInput,
    IpAccessRule, PageRule, WafRuleset, WorkerRoute,
};
use crate::storage::Storage;

use super::trail;

// ─── Analytics ──────────────────────────────────────────────────────────────

/// Resolve one stable range for provider requests. Open-ended ranges end at the
/// captured UTC instant, and a missing start defaults to 24 hours before it.
fn resolve_analytics_range(
    since: Option<String>,
    until: Option<String>,
    now: DateTime<Utc>,
) -> (String, String) {
    let default_since = (now - Duration::hours(24)).to_rfc3339();
    let default_until = now.to_rfc3339();
    (
        since.unwrap_or(default_since),
        until.unwrap_or(default_until),
    )
}

#[tauri::command]
pub async fn get_zone_analytics(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    since: Option<String>,
    until: Option<String>,
    continuous: Option<bool>,
) -> Result<serde_json::Value, String> {
    let (since, until) = resolve_analytics_range(since, until, Utc::now());
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_zone_analytics(&zone_id, &since, &until, continuous)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_dns_analytics(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    since: Option<String>,
    until: Option<String>,
    dimensions: Option<Vec<String>>,
    metrics: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let (since, until) = resolve_analytics_range(since, until, Utc::now());
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_dns_analytics(&zone_id, &since, &until, dimensions, metrics)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod analytics_tests {
    use super::resolve_analytics_range;
    use chrono::{TimeZone, Utc};

    #[test]
    fn analytics_range_preserves_bounded_values() {
        let now = Utc.with_ymd_and_hms(2026, 7, 29, 12, 0, 0).unwrap();
        let since = "2026-07-28T09:30:00Z".to_string();
        let until = "2026-07-29T09:30:00Z".to_string();

        assert_eq!(
            resolve_analytics_range(Some(since.clone()), Some(until.clone()), now),
            (since, until)
        );
    }

    #[test]
    fn analytics_range_resolves_open_values_from_one_instant() {
        let now = Utc.with_ymd_and_hms(2026, 7, 29, 12, 0, 0).unwrap();

        assert_eq!(
            resolve_analytics_range(None, None, now),
            (
                "2026-07-28T12:00:00+00:00".to_string(),
                "2026-07-29T12:00:00+00:00".to_string(),
            )
        );
    }
}

// ─── Recording a service action ─────────────────────────────────────────────
//
// Same vocabulary as the DNS commands — see `commands::trail`. These resources
// have no backing store in this application, so a deletion's entry is all that
// is left of the thing afterwards; where the command is handed the resource it
// is describing, the entry describes it.

/// Open an entry for an action on one zone-scoped resource.
///
/// A resource that does not exist yet — a creation Cloudflare refused — names
/// nothing, and an entry whose `resource` is a blank string reads as a record
/// the trail failed to identify rather than as one that had no id.
fn service_entry(
    operation: &str,
    outcome: AuditOutcome,
    zone_id: &str,
    resource: Option<&str>,
) -> AuditEntry {
    let entry = trail::user_action(operation, outcome).detail("zone_id", zone_id);
    match resource {
        Some(resource) if !resource.is_empty() => entry.resource(resource),
        _ => entry,
    }
}

/// Record an action Cloudflare did not carry out, with the application's own
/// classification of where it stopped and never the provider's message.
fn record_failure(
    storage: &Storage,
    operation: &str,
    zone_id: &str,
    resource: Option<&str>,
    error: &CloudflareError,
    describe: impl FnOnce(AuditEntry) -> AuditEntry,
) {
    storage.record(describe(trail::attach_failure(
        service_entry(operation, AuditOutcome::Failed, zone_id, resource),
        error,
    )));
}

/// What a firewall rule *is*, as the trail records it.
///
/// The expression included, shortened like any other long value. This is the
/// one place the user half of the trail parts company with the tool-call half,
/// which refuses an `expression` outright: there it is an unvetted tool
/// argument covered by an allowlist, here it is the user's own rule and the
/// only thing that distinguishes one from another. It carries no credential.
fn firewall_rule_fields(rule: &FirewallRuleInput) -> Vec<(&'static str, serde_json::Value)> {
    vec![
        ("action", trail::setting_value(&json!(rule.action))),
        (
            "expression",
            trail::setting_value(&json!(rule.filter.expression)),
        ),
        ("paused", json!(rule.paused)),
        ("priority", json!(rule.priority)),
        (
            "description",
            trail::setting_value(&json!(rule.description)),
        ),
    ]
}

/// What an email routing rule is, as the trail records it.
///
/// Its name, whether it is on, and the **scale** of what it matches and where
/// it forwards — not the addresses. A forwarding destination is a third
/// party's address rather than the user's own data, and the audit log is a
/// file the user can export; the rule's name is what identifies it to whoever
/// wrote it, and that is enough for a trail to be useful without accumulating
/// other people's contact details.
fn email_rule_fields(rule: &EmailRoutingRule) -> Vec<(&'static str, serde_json::Value)> {
    vec![
        ("name", trail::setting_value(&json!(rule.name))),
        ("enabled", json!(rule.enabled)),
        ("priority", json!(rule.priority)),
        ("matchers", json!(rule.matchers.len())),
        ("actions", json!(rule.actions.len())),
    ]
}

// ─── Firewall / WAF ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_firewall_rules(
    api_key: String,
    email: Option<String>,
    zone_id: String,
) -> Result<Vec<FirewallRule>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_firewall_rules(&zone_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_firewall_rule(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    rule: FirewallRuleInput,
) -> Result<FirewallRule, String> {
    let fields = firewall_rule_fields(&rule);
    let describe = |entry: AuditEntry| trail::attach_fields(entry, "rule", "rule_omitted", fields);
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = match client.create_firewall_rule(&zone_id, rule).await {
        Ok(created) => created,
        Err(error) => {
            record_failure(
                &storage,
                "firewall:create",
                &zone_id,
                None,
                &error,
                describe,
            );
            return Err(error.to_string());
        }
    };
    storage.record(describe(service_entry(
        "firewall:create",
        AuditOutcome::Succeeded,
        &zone_id,
        created.id.as_deref(),
    )));
    Ok(created)
}

#[tauri::command]
pub async fn update_firewall_rule(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    rule_id: String,
    rule: FirewallRuleInput,
) -> Result<FirewallRule, String> {
    let fields = firewall_rule_fields(&rule);
    let describe = |entry: AuditEntry| trail::attach_fields(entry, "rule", "rule_omitted", fields);
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let updated = match client.update_firewall_rule(&zone_id, &rule_id, rule).await {
        Ok(updated) => updated,
        Err(error) => {
            record_failure(
                &storage,
                "firewall:update",
                &zone_id,
                Some(&rule_id),
                &error,
                describe,
            );
            return Err(error.to_string());
        }
    };
    storage.record(describe(service_entry(
        "firewall:update",
        AuditOutcome::Succeeded,
        &zone_id,
        Some(&rule_id),
    )));
    Ok(updated)
}

/// Delete one firewall rule.
///
/// The entry names the rule's id and nothing else, because that is all this
/// command is given — and once the rule is gone the id names nothing. Closing
/// that gap needs the rule passed in the way `delete_dns_record` takes
/// `previous`; until a caller does, a reader has the `firewall:create` or
/// `firewall:update` entry that the same id appears in.
#[tauri::command]
pub async fn delete_firewall_rule(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    rule_id: String,
) -> Result<(), String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    if let Err(error) = client.delete_firewall_rule(&zone_id, &rule_id).await {
        record_failure(
            &storage,
            "firewall:delete",
            &zone_id,
            Some(&rule_id),
            &error,
            |entry: AuditEntry| entry,
        );
        return Err(error.to_string());
    }
    storage.record(service_entry(
        "firewall:delete",
        AuditOutcome::Succeeded,
        &zone_id,
        Some(&rule_id),
    ));
    Ok(())
}

#[tauri::command]
pub async fn get_ip_access_rules(
    api_key: String,
    email: Option<String>,
    zone_id: String,
) -> Result<Vec<IpAccessRule>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_ip_access_rules(&zone_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_ip_access_rule(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    mode: String,
    value: String,
    notes: String,
) -> Result<IpAccessRule, String> {
    // `mode` and `value` keep the keys they have always had. `notes` is the
    // user's own label for the rule and is what tells two blocks of the same
    // range apart later.
    let describe = |entry: AuditEntry| {
        entry
            .detail("mode", mode.as_str())
            .detail("value", value.as_str())
            .detail("notes", trail::setting_value(&json!(notes)))
    };
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = match client
        .create_ip_access_rule(&zone_id, &mode, &value, &notes)
        .await
    {
        Ok(created) => created,
        Err(error) => {
            record_failure(
                &storage,
                "ip_access_rule:create",
                &zone_id,
                None,
                &error,
                describe,
            );
            return Err(error.to_string());
        }
    };
    storage.record(describe(service_entry(
        "ip_access_rule:create",
        AuditOutcome::Succeeded,
        &zone_id,
        created.id.as_deref(),
    )));
    Ok(created)
}

#[tauri::command]
pub async fn delete_ip_access_rule(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    rule_id: String,
) -> Result<(), String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    if let Err(error) = client.delete_ip_access_rule(&zone_id, &rule_id).await {
        record_failure(
            &storage,
            "ip_access_rule:delete",
            &zone_id,
            Some(&rule_id),
            &error,
            |entry: AuditEntry| entry,
        );
        return Err(error.to_string());
    }
    storage.record(service_entry(
        "ip_access_rule:delete",
        AuditOutcome::Succeeded,
        &zone_id,
        Some(&rule_id),
    ));
    Ok(())
}

#[tauri::command]
pub async fn get_waf_rulesets(
    api_key: String,
    email: Option<String>,
    zone_id: String,
) -> Result<Vec<WafRuleset>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_waf_rulesets(&zone_id)
        .await
        .map_err(|e| e.to_string())
}

// ─── Workers ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_worker_routes(
    api_key: String,
    email: Option<String>,
    zone_id: String,
) -> Result<Vec<WorkerRoute>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_worker_routes(&zone_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_worker_route(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    pattern: String,
    script: String,
) -> Result<WorkerRoute, String> {
    let describe = |entry: AuditEntry| {
        entry
            .detail("pattern", trail::setting_value(&json!(pattern)))
            .detail("script", trail::setting_value(&json!(script)))
    };
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = match client
        .create_worker_route(&zone_id, &pattern, &script)
        .await
    {
        Ok(created) => created,
        Err(error) => {
            record_failure(
                &storage,
                "worker_route:create",
                &zone_id,
                None,
                &error,
                describe,
            );
            return Err(error.to_string());
        }
    };
    storage.record(describe(service_entry(
        "worker_route:create",
        AuditOutcome::Succeeded,
        &zone_id,
        created.id.as_deref(),
    )));
    Ok(created)
}

#[tauri::command]
pub async fn delete_worker_route(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    route_id: String,
) -> Result<(), String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    if let Err(error) = client.delete_worker_route(&zone_id, &route_id).await {
        record_failure(
            &storage,
            "worker_route:delete",
            &zone_id,
            Some(&route_id),
            &error,
            |entry: AuditEntry| entry,
        );
        return Err(error.to_string());
    }
    storage.record(service_entry(
        "worker_route:delete",
        AuditOutcome::Succeeded,
        &zone_id,
        Some(&route_id),
    ));
    Ok(())
}

// ─── Email Routing ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_email_routing_settings(
    api_key: String,
    email: Option<String>,
    zone_id: String,
) -> Result<EmailRoutingSettings, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_email_routing_settings(&zone_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_email_routing_rules(
    api_key: String,
    email: Option<String>,
    zone_id: String,
) -> Result<Vec<EmailRoutingRule>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_email_routing_rules(&zone_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_email_routing_rule(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    rule: EmailRoutingRule,
) -> Result<EmailRoutingRule, String> {
    let fields = email_rule_fields(&rule);
    let describe = |entry: AuditEntry| trail::attach_fields(entry, "rule", "rule_omitted", fields);
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = match client.create_email_routing_rule(&zone_id, &rule).await {
        Ok(created) => created,
        Err(error) => {
            record_failure(
                &storage,
                "email_routing:create",
                &zone_id,
                None,
                &error,
                describe,
            );
            return Err(error.to_string());
        }
    };
    storage.record(describe(service_entry(
        "email_routing:create",
        AuditOutcome::Succeeded,
        &zone_id,
        created.id.as_deref(),
    )));
    Ok(created)
}

#[tauri::command]
pub async fn delete_email_routing_rule(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    rule_id: String,
) -> Result<(), String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    if let Err(error) = client.delete_email_routing_rule(&zone_id, &rule_id).await {
        record_failure(
            &storage,
            "email_routing:delete",
            &zone_id,
            Some(&rule_id),
            &error,
            |entry: AuditEntry| entry,
        );
        return Err(error.to_string());
    }
    storage.record(service_entry(
        "email_routing:delete",
        AuditOutcome::Succeeded,
        &zone_id,
        Some(&rule_id),
    ));
    Ok(())
}

// ─── Page Rules ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_page_rules(
    api_key: String,
    email: Option<String>,
    zone_id: String,
) -> Result<Vec<PageRule>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_page_rules(&zone_id)
        .await
        .map_err(|e| e.to_string())
}
