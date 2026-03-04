use tauri::State;

use crate::cloudflare_api::{
    CloudflareClient,
    FirewallRule, FirewallRuleInput, IpAccessRule, WafRuleset,
    WorkerRoute, EmailRoutingRule, EmailRoutingSettings, PageRule,
};
use crate::storage::Storage;

use super::log_audit;

// ─── Analytics ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_zone_analytics(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    since: String,
    until: String,
    continuous: Option<bool>,
) -> Result<serde_json::Value, String> {
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
    since: String,
    until: String,
    dimensions: Option<Vec<String>>,
    metrics: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_dns_analytics(&zone_id, &since, &until, dimensions, metrics)
        .await
        .map_err(|e| e.to_string())
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
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = client
        .create_firewall_rule(&zone_id, rule)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "firewall:create",
            "resource": created.id.clone().unwrap_or_default(),
            "zone_id": zone_id,
        }),
    )
    .await;
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
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let updated = client
        .update_firewall_rule(&zone_id, &rule_id, rule)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "firewall:update",
            "resource": rule_id,
            "zone_id": zone_id,
        }),
    )
    .await;
    Ok(updated)
}

#[tauri::command]
pub async fn delete_firewall_rule(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    rule_id: String,
) -> Result<(), String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .delete_firewall_rule(&zone_id, &rule_id)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "firewall:delete",
            "resource": rule_id,
            "zone_id": zone_id,
        }),
    )
    .await;
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
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = client
        .create_ip_access_rule(&zone_id, &mode, &value, &notes)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "ip_access_rule:create",
            "resource": created.id.clone().unwrap_or_default(),
            "zone_id": zone_id,
            "mode": mode,
            "value": value,
        }),
    )
    .await;
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
    client
        .delete_ip_access_rule(&zone_id, &rule_id)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "ip_access_rule:delete",
            "resource": rule_id,
            "zone_id": zone_id,
        }),
    )
    .await;
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
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = client
        .create_worker_route(&zone_id, &pattern, &script)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "worker_route:create",
            "resource": created.id.clone().unwrap_or_default(),
            "zone_id": zone_id,
            "pattern": pattern,
            "script": script,
        }),
    )
    .await;
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
    client
        .delete_worker_route(&zone_id, &route_id)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "worker_route:delete",
            "resource": route_id,
            "zone_id": zone_id,
        }),
    )
    .await;
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
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = client
        .create_email_routing_rule(&zone_id, &rule)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "email_routing:create",
            "resource": created.id.clone().unwrap_or_default(),
            "zone_id": zone_id,
        }),
    )
    .await;
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
    client
        .delete_email_routing_rule(&zone_id, &rule_id)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "email_routing:delete",
            "resource": rule_id,
            "zone_id": zone_id,
        }),
    )
    .await;
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
