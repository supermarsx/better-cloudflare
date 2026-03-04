//! Cloudflare API tool handlers.
//!
//! All tools that call the Cloudflare REST API (DNS CRUD, firewall, workers,
//! email routing, analytics, cache, zone settings, page rules).

use serde_json::{json, Value};

use bc_cloudflare_api::{DNSRecordInput, EmailRoutingRule, FirewallRuleInput};

use crate::protocol::*;

/// Execute a Cloudflare API tool.
pub async fn execute(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "cf_verify_token" => {
            let client = make_cf_client(args)?;
            let ok = client.verify_token().await.map_err(|e| e.to_string())?;
            Ok(json!({ "valid": ok }))
        }

        "cf_list_zones" => {
            let client = make_cf_client(args)?;
            let zones = client.get_zones().await.map_err(|e| e.to_string())?;
            serde_json::to_value(zones).map_err(|e| e.to_string())
        }

        "cf_list_dns_records" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let page = get_optional_u32(args, "page");
            let per_page = get_optional_u32(args, "per_page");
            let records = client
                .get_dns_records(&zone_id, page, per_page)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(records).map_err(|e| e.to_string())
        }

        "cf_create_dns_record" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let record: DNSRecordInput = serde_json::from_value(
                args.get("record")
                    .cloned()
                    .ok_or("Missing required argument 'record'")?,
            )
            .map_err(|e| format!("Invalid record payload: {}", e))?;
            let created = client
                .create_dns_record(&zone_id, record)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(created).map_err(|e| e.to_string())
        }

        "cf_update_dns_record" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let record_id = get_required_string(args, "record_id")?;
            let record: DNSRecordInput = serde_json::from_value(
                args.get("record")
                    .cloned()
                    .ok_or("Missing required argument 'record'")?,
            )
            .map_err(|e| format!("Invalid record payload: {}", e))?;
            let updated = client
                .update_dns_record(&zone_id, &record_id, record)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(updated).map_err(|e| e.to_string())
        }

        "cf_delete_dns_record" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let record_id = get_required_string(args, "record_id")?;
            client
                .delete_dns_record(&zone_id, &record_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "deleted": true, "record_id": record_id }))
        }

        "cf_bulk_create_dns_records" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let dryrun = get_optional_bool(args, "dryrun").unwrap_or(false);
            let records: Vec<DNSRecordInput> = serde_json::from_value(
                args.get("records")
                    .cloned()
                    .ok_or("Missing required argument 'records'")?,
            )
            .map_err(|e| format!("Invalid records payload: {}", e))?;
            let result = client
                .create_bulk_dns_records(&zone_id, records, dryrun)
                .await
                .map_err(|e| e.to_string())?;
            Ok(result)
        }

        "cf_bulk_delete_dns_records" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let ids: Vec<String> = serde_json::from_value(
                args.get("record_ids")
                    .cloned()
                    .ok_or("Missing required argument 'record_ids'")?,
            )
            .map_err(|e| format!("Invalid record_ids: {}", e))?;
            let result = client
                .delete_bulk_dns_records(&zone_id, &ids)
                .await
                .map_err(|e| e.to_string())?;
            Ok(result)
        }

        "cf_export_dns_records" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let format = get_optional_string(args, "format").unwrap_or_else(|| "json".to_string());
            let page = get_optional_u32(args, "page");
            let per_page = get_optional_u32(args, "per_page");
            let data = client
                .export_dns_records(&zone_id, &format, page, per_page)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "format": format, "data": data }))
        }

        // ── Cache ───────────────────────────────────────────────────────
        "cf_purge_cache" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let purge_everything = get_optional_bool(args, "purge_everything").unwrap_or(false);
            let files = get_string_array(args, "files");
            let result = client
                .purge_cache(&zone_id, purge_everything, files)
                .await
                .map_err(|e| e.to_string())?;
            Ok(result)
        }

        // ── Zone Settings ───────────────────────────────────────────────
        "cf_get_zone_setting" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let setting_id = get_required_string(args, "setting_id")?;
            client
                .get_zone_setting(&zone_id, &setting_id)
                .await
                .map_err(|e| e.to_string())
        }

        "cf_update_zone_setting" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let setting_id = get_required_string(args, "setting_id")?;
            let value = args
                .get("value")
                .cloned()
                .ok_or("Missing required argument 'value'")?;
            client
                .update_zone_setting(&zone_id, &setting_id, value)
                .await
                .map_err(|e| e.to_string())
        }

        // ── DNSSEC ──────────────────────────────────────────────────────
        "cf_get_dnssec" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            client.get_dnssec(&zone_id).await.map_err(|e| e.to_string())
        }

        "cf_update_dnssec" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let payload = args
                .get("payload")
                .cloned()
                .ok_or("Missing required argument 'payload'")?;
            client
                .update_dnssec(&zone_id, payload)
                .await
                .map_err(|e| e.to_string())
        }

        // ── Analytics ───────────────────────────────────────────────────
        "cf_get_zone_analytics" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let since = get_required_string(args, "since")?;
            let until = get_required_string(args, "until")?;
            let continuous = get_optional_bool(args, "continuous");
            client
                .get_zone_analytics(&zone_id, &since, &until, continuous)
                .await
                .map_err(|e| e.to_string())
        }

        "cf_get_dns_analytics" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let since = get_required_string(args, "since")?;
            let until = get_required_string(args, "until")?;
            let dimensions = get_string_array(args, "dimensions");
            let metrics = get_string_array(args, "metrics");
            client
                .get_dns_analytics(&zone_id, &since, &until, dimensions, metrics)
                .await
                .map_err(|e| e.to_string())
        }

        // ── Firewall / WAF ─────────────────────────────────────────────
        "cf_list_firewall_rules" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let rules = client
                .get_firewall_rules(&zone_id)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rules).map_err(|e| e.to_string())
        }

        "cf_create_firewall_rule" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let rule: FirewallRuleInput = serde_json::from_value(
                args.get("rule")
                    .cloned()
                    .ok_or("Missing required argument 'rule'")?,
            )
            .map_err(|e| format!("Invalid rule payload: {}", e))?;
            let created = client
                .create_firewall_rule(&zone_id, rule)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(created).map_err(|e| e.to_string())
        }

        "cf_update_firewall_rule" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let rule_id = get_required_string(args, "rule_id")?;
            let rule: FirewallRuleInput = serde_json::from_value(
                args.get("rule")
                    .cloned()
                    .ok_or("Missing required argument 'rule'")?,
            )
            .map_err(|e| format!("Invalid rule payload: {}", e))?;
            let updated = client
                .update_firewall_rule(&zone_id, &rule_id, rule)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(updated).map_err(|e| e.to_string())
        }

        "cf_delete_firewall_rule" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let rule_id = get_required_string(args, "rule_id")?;
            client
                .delete_firewall_rule(&zone_id, &rule_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "deleted": true, "rule_id": rule_id }))
        }

        "cf_list_ip_access_rules" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let rules = client
                .get_ip_access_rules(&zone_id)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rules).map_err(|e| e.to_string())
        }

        "cf_create_ip_access_rule" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let mode = get_required_string(args, "mode")?;
            let value = get_required_string(args, "value")?;
            let notes = get_optional_string(args, "notes").unwrap_or_default();
            let created = client
                .create_ip_access_rule(&zone_id, &mode, &value, &notes)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(created).map_err(|e| e.to_string())
        }

        "cf_delete_ip_access_rule" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let rule_id = get_required_string(args, "rule_id")?;
            client
                .delete_ip_access_rule(&zone_id, &rule_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "deleted": true, "rule_id": rule_id }))
        }

        "cf_list_waf_rulesets" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let rulesets = client
                .get_waf_rulesets(&zone_id)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rulesets).map_err(|e| e.to_string())
        }

        // ── Workers ─────────────────────────────────────────────────────
        "cf_list_worker_routes" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let routes = client
                .get_worker_routes(&zone_id)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(routes).map_err(|e| e.to_string())
        }

        "cf_create_worker_route" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let pattern = get_required_string(args, "pattern")?;
            let script = get_required_string(args, "script")?;
            let created = client
                .create_worker_route(&zone_id, &pattern, &script)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(created).map_err(|e| e.to_string())
        }

        "cf_delete_worker_route" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let route_id = get_required_string(args, "route_id")?;
            client
                .delete_worker_route(&zone_id, &route_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "deleted": true, "route_id": route_id }))
        }

        // ── Email Routing ───────────────────────────────────────────────
        "cf_get_email_routing_settings" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let settings = client
                .get_email_routing_settings(&zone_id)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(settings).map_err(|e| e.to_string())
        }

        "cf_list_email_routing_rules" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let rules = client
                .get_email_routing_rules(&zone_id)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rules).map_err(|e| e.to_string())
        }

        "cf_create_email_routing_rule" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let rule: EmailRoutingRule = serde_json::from_value(
                args.get("rule")
                    .cloned()
                    .ok_or("Missing required argument 'rule'")?,
            )
            .map_err(|e| format!("Invalid rule payload: {}", e))?;
            let created = client
                .create_email_routing_rule(&zone_id, &rule)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(created).map_err(|e| e.to_string())
        }

        "cf_delete_email_routing_rule" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let rule_id = get_required_string(args, "rule_id")?;
            client
                .delete_email_routing_rule(&zone_id, &rule_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "deleted": true, "rule_id": rule_id }))
        }

        // ── Page Rules ──────────────────────────────────────────────────
        "cf_list_page_rules" => {
            let client = make_cf_client(args)?;
            let zone_id = get_required_string(args, "zone_id")?;
            let rules = client
                .get_page_rules(&zone_id)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rules).map_err(|e| e.to_string())
        }

        _ => Err(format!("Unknown Cloudflare tool '{}'", name)),
    }
}
