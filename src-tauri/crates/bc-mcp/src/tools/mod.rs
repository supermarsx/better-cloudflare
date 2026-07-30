//! MCP tool registry and dispatch.
//!
//! Centralises the list of all available tools, their metadata, and the
//! top-level `execute_tool` dispatcher that routes to sub-modules.

mod audit_tools;
mod cloudflare;
mod dns_tools;
mod spf_tools;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::permissions::{
    permission_for_invocation, requires_high_risk_confirmation, validate_arguments,
    ArgumentProfile, PermissionDefinition, PermissionGrantSet,
};
use crate::schemas;

// ─── Tool descriptor ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDescriptor {
    pub permission_id: String,
    pub invocation_name: String,
    pub legacy_aliases: Vec<String>,
    pub name: String,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
    pub enabled: bool,
    pub category: String,
    pub effect: String,
    pub risk: String,
    pub network_access: bool,
    pub credential_access: bool,
    pub argument_profile: ArgumentProfile,
}

// ─── Tool catalogue ────────────────────────────────────────────────────────

/// (name, title, description, category)
const TOOL_CATALOGUE: &[(&str, &str, &str, &str)] = &[
    // ── DNS Core ────────────────────────────────────────────────────────
    ("cf_verify_token", "Verify Cloudflare token", "Validate a Cloudflare API token or key/email pair.", "cloudflare"),
    ("cf_list_zones", "List zones", "List all Cloudflare zones for an account.", "cloudflare"),
    ("cf_list_dns_records", "List DNS records", "Fetch DNS records for a zone with optional filtering and pagination.", "cloudflare"),
    ("cf_create_dns_record", "Create DNS record", "Create a DNS record in a zone.", "cloudflare"),
    ("cf_update_dns_record", "Update DNS record", "Update an existing DNS record by record ID.", "cloudflare"),
    ("cf_delete_dns_record", "Delete DNS record", "Delete a DNS record by record ID.", "cloudflare"),
    ("cf_bulk_create_dns_records", "Bulk create DNS records", "Create many DNS records in one operation with optional dry-run.", "cloudflare"),
    ("cf_bulk_delete_dns_records", "Bulk delete DNS records", "Delete many DNS records by ID in one operation.", "cloudflare"),
    ("cf_export_dns_records", "Export DNS records", "Export DNS records in JSON, CSV, or BIND format.", "cloudflare"),
    // ── Cache ───────────────────────────────────────────────────────────
    ("cf_purge_cache", "Purge cache", "Purge all or selected files from Cloudflare cache.", "cloudflare"),
    // ── Zone Settings ───────────────────────────────────────────────────
    ("cf_get_zone_setting", "Get zone setting", "Read a single Cloudflare zone setting by ID (ssl, minify, etc.).", "cloudflare"),
    ("cf_update_zone_setting", "Update zone setting", "Update a single Cloudflare zone setting by ID.", "cloudflare"),
    ("cf_get_dnssec", "Get DNSSEC", "Fetch DNSSEC configuration for a zone.", "cloudflare"),
    ("cf_update_dnssec", "Update DNSSEC", "Update DNSSEC configuration for a zone.", "cloudflare"),
    // ── Analytics ───────────────────────────────────────────────────────
    ("cf_get_zone_analytics", "Get zone analytics", "Fetch zone-level analytics (requests, bandwidth, threats) over a time range.", "cloudflare"),
    ("cf_get_dns_analytics", "Get DNS analytics", "Fetch DNS query analytics with configurable dimensions and metrics.", "cloudflare"),
    // ── Firewall / WAF ─────────────────────────────────────────────────
    ("cf_list_firewall_rules", "List firewall rules", "List all custom firewall rules for a zone.", "cloudflare"),
    ("cf_create_firewall_rule", "Create firewall rule", "Create a custom firewall rule with expression-based filter.", "cloudflare"),
    ("cf_update_firewall_rule", "Update firewall rule", "Update a custom firewall rule by ID.", "cloudflare"),
    ("cf_delete_firewall_rule", "Delete firewall rule", "Delete a custom firewall rule by ID.", "cloudflare"),
    ("cf_list_ip_access_rules", "List IP access rules", "List IP-based access rules (allow/block/challenge).", "cloudflare"),
    ("cf_create_ip_access_rule", "Create IP access rule", "Create an IP-based access rule (block, challenge, whitelist).", "cloudflare"),
    ("cf_delete_ip_access_rule", "Delete IP access rule", "Delete an IP-based access rule by ID.", "cloudflare"),
    ("cf_list_waf_rulesets", "List WAF rulesets", "List managed WAF rulesets for a zone.", "cloudflare"),
    // ── Workers ─────────────────────────────────────────────────────────
    ("cf_list_worker_routes", "List worker routes", "List Worker routes for a zone.", "cloudflare"),
    ("cf_create_worker_route", "Create worker route", "Create a Worker route pattern mapping to a script.", "cloudflare"),
    ("cf_delete_worker_route", "Delete worker route", "Delete a Worker route by ID.", "cloudflare"),
    // ── Email Routing ───────────────────────────────────────────────────
    ("cf_get_email_routing_settings", "Get email routing settings", "Fetch email routing status and settings for a zone.", "cloudflare"),
    ("cf_list_email_routing_rules", "List email routing rules", "List all email routing rules for a zone.", "cloudflare"),
    ("cf_create_email_routing_rule", "Create email routing rule", "Create an email routing rule with matchers and actions.", "cloudflare"),
    ("cf_delete_email_routing_rule", "Delete email routing rule", "Delete an email routing rule by ID.", "cloudflare"),
    // ── Page Rules ──────────────────────────────────────────────────────
    ("cf_list_page_rules", "List page rules", "List page rules for a zone.", "cloudflare"),
    // ── SPF ─────────────────────────────────────────────────────────────
    ("spf_simulate", "Simulate SPF", "Run SPF evaluation for a domain/IP combination. Returns pass/fail verdict and mechanism trace.", "spf"),
    ("spf_graph", "Build SPF graph", "Build a complete SPF include/redirect dependency graph for a domain.", "spf"),
    ("spf_parse", "Parse SPF record", "Parse an SPF content string into structured mechanisms, qualifiers, and modifiers.", "spf"),
    // ── DNS Tools ───────────────────────────────────────────────────────
    ("dns_validate_record", "Validate DNS record", "Validate a DNS record for correctness (type, name, content, TTL).", "dns"),
    ("dns_check_propagation", "Check DNS propagation", "Check DNS record propagation across 15+ global resolvers.", "dns"),
    ("dns_resolve_topology", "Resolve topology", "Resolve CNAME chains, reverse DNS, and geo-location for hostnames.", "dns"),
    ("dns_parse_csv", "Parse CSV records", "Parse CSV text into partial DNS records for import.", "dns"),
    ("dns_parse_bind", "Parse BIND zone", "Parse a BIND zone file into partial DNS records for import.", "dns"),
    ("dns_export_csv", "Export as CSV", "Export DNS records array to CSV format.", "dns"),
    ("dns_export_bind", "Export as BIND", "Export DNS records array to BIND zone file format.", "dns"),
    ("dns_export_json", "Export as JSON", "Export DNS records array to pretty-printed JSON.", "dns"),
    ("dns_parse_srv", "Parse SRV record", "Parse an SRV record content into priority, weight, port, target fields.", "dns"),
    ("dns_compose_srv", "Compose SRV record", "Build an SRV record content string from component fields.", "dns"),
    ("dns_parse_tlsa", "Parse TLSA record", "Parse a TLSA record content into usage, selector, matching_type, data.", "dns"),
    ("dns_compose_tlsa", "Compose TLSA record", "Build a TLSA record content string from component fields.", "dns"),
    ("dns_parse_sshfp", "Parse SSHFP record", "Parse an SSHFP record content into algorithm, fptype, fingerprint.", "dns"),
    ("dns_compose_sshfp", "Compose SSHFP record", "Build an SSHFP record content string from component fields.", "dns"),
    ("dns_parse_naptr", "Parse NAPTR record", "Parse a NAPTR record content into order, preference, flags, service, regexp, replacement.", "dns"),
    ("dns_compose_naptr", "Compose NAPTR record", "Build a NAPTR record content string from component fields.", "dns"),
    ("dns_parse_spf", "Parse SPF content", "Parse an SPF TXT content string into structured mechanisms. Alias for spf_parse.", "dns"),
    // ── Domain Audit ────────────────────────────────────────────────────
    ("audit_run_domain", "Run domain audit", "Run a comprehensive security/email/hygiene audit on a domain's DNS records. Checks SPF, DKIM, DMARC, DNSSEC, CAA, bogon IPs, TTL best practices, and more.", "audit"),
];

/// Return all tool definitions with proper schemas.
pub fn available_tool_definitions() -> Vec<McpToolDescriptor> {
    TOOL_CATALOGUE
        .iter()
        .filter_map(|(name, title, description, _legacy_category)| {
            let permission = permission_for_invocation(name)?;
            Some(McpToolDescriptor {
                permission_id: permission.id.to_string(),
                invocation_name: permission.invocation_name.to_string(),
                legacy_aliases: permission
                    .legacy_aliases
                    .iter()
                    .map(|alias| (*alias).to_string())
                    .collect(),
                name: name.to_string(),
                title: title.to_string(),
                description: description.to_string(),
                input_schema: schemas::tool_input_schema(name),
                enabled: true,
                category: permission.category.as_str().to_string(),
                effect: permission.effect.as_str().to_string(),
                risk: permission.risk.as_str().to_string(),
                network_access: permission.network_access,
                credential_access: permission.credential_access,
                argument_profile: permission.argument_profile,
            })
        })
        .collect()
}

/// All tool names in the catalogue.
pub fn all_tool_names() -> Vec<String> {
    TOOL_CATALOGUE
        .iter()
        .map(|(n, _, _, _)| n.to_string())
        .collect()
}

/// Number of tools in the catalogue.
pub fn tool_count() -> usize {
    TOOL_CATALOGUE.len()
}

/// Compatibility entry point. Dispatch without an explicit canonical grant set
/// is deliberately denied, including calls from other in-process crates.
pub async fn execute_tool(name: &str, args: &Value) -> Result<Value, String> {
    let _ = (name, args);
    Err("Tool dispatch denied: explicit canonical permission grants are required.".to_string())
}

/// Final dispatch boundary. Registry resolution, grant enforcement, and
/// argument bounds all happen here so callers cannot bypass them by invoking a
/// private sub-handler directly.
#[allow(dead_code)] // Retained for crate tests and in-process compatibility audits.
pub(crate) async fn execute_tool_with_grants(
    grants: &PermissionGrantSet,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    let prepared = prepare_tool_invocation(grants, name, args)?;
    dispatch_prepared_tool(prepared.canonical_name, &prepared.arguments).await
}

pub(crate) struct PreparedToolInvocation {
    pub(crate) canonical_name: &'static str,
    pub(crate) arguments: Value,
}

/// Resolve the exact registered permission, enforce the current grant and
/// per-call high-risk acknowledgement, and strip the acknowledgement before a
/// handler can observe the arguments.
pub(crate) fn prepare_tool_invocation(
    grants: &PermissionGrantSet,
    name: &str,
    args: &Value,
) -> Result<PreparedToolInvocation, String> {
    let permission = permission_for_invocation(name)
        .ok_or_else(|| "Tool dispatch denied: tool is not registered.".to_string())?;
    if !grants.allows(permission) {
        return Err(format!(
            "Tool '{}' is not enabled by the server permission grants.",
            permission.invocation_name
        ));
    }
    let handler_args = prepare_handler_arguments(permission, args)?;
    Ok(PreparedToolInvocation {
        canonical_name: permission.invocation_name,
        arguments: handler_args,
    })
}

/// Dispatch an invocation which has already crossed the authoritative
/// permission boundary. This remains crate-private so external callers cannot
/// bypass grants or confirmation.
pub(crate) async fn dispatch_prepared_tool(
    canonical_name: &str,
    args: &Value,
) -> Result<Value, String> {
    if canonical_name.starts_with("cf_") {
        return cloudflare::execute(canonical_name, args).await;
    }
    if canonical_name.starts_with("spf_") {
        return spf_tools::execute(canonical_name, args).await;
    }
    if canonical_name.starts_with("audit_") {
        return audit_tools::execute(canonical_name, args).await;
    }
    if canonical_name.starts_with("dns_") {
        if canonical_name == "dns_parse_spf" {
            return spf_tools::execute("spf_parse", args).await;
        }
        return dns_tools::execute(canonical_name, args).await;
    }

    Err("Tool dispatch denied: registered tool has no handler.".to_string())
}

fn prepare_handler_arguments(
    permission: &PermissionDefinition,
    args: &Value,
) -> Result<Value, String> {
    validate_arguments(permission, args)?;
    if requires_high_risk_confirmation(permission)
        && args.get("confirmHighRisk") != Some(&Value::Bool(true))
    {
        return Err(format!(
            "Tool '{}' requires the exact boolean argument confirmHighRisk: true.",
            permission.invocation_name
        ));
    }

    let mut handler_args = args.clone();
    if requires_high_risk_confirmation(permission) {
        handler_args
            .as_object_mut()
            .expect("argument validation requires an object")
            .remove("confirmHighRisk");
    }
    Ok(handler_args)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::permissions::PermissionGrantSet;

    #[tokio::test]
    async fn unknown_and_ungranted_dispatch_deny_before_handlers() {
        let empty = PermissionGrantSet::default();
        let unknown = execute_tool_with_grants(&empty, "cf_future_write", &json!({})).await;
        assert!(unknown.unwrap_err().contains("not registered"));

        let ungranted = execute_tool_with_grants(&empty, "cf_delete_dns_record", &json!({})).await;
        assert!(ungranted.unwrap_err().contains("not enabled"));
    }

    #[tokio::test]
    async fn invocation_name_cannot_bypass_stable_high_risk_grant() {
        let grants = PermissionGrantSet::from_requested(&["cf_list_zones".to_string()]);
        let result =
            execute_tool_with_grants(&grants, "cf_bulk_delete_dns_records", &json!({})).await;
        assert!(result.unwrap_err().contains("not enabled"));
    }

    #[tokio::test]
    async fn malformed_and_oversized_bulk_arguments_fail_before_provider_access() {
        let grants =
            PermissionGrantSet::from_requested(&["cf_bulk_delete_dns_records".to_string()]);

        let malformed =
            execute_tool_with_grants(&grants, "cf_bulk_delete_dns_records", &json!([])).await;
        assert!(malformed.unwrap_err().contains("JSON object"));

        let oversized = json!({
            "confirmHighRisk": true,
            "record_ids": (0..101).map(|index| format!("id-{index}")).collect::<Vec<_>>()
        });
        let result =
            execute_tool_with_grants(&grants, "cf_bulk_delete_dns_records", &oversized).await;
        assert!(result.unwrap_err().contains("100 item"));
    }

    #[tokio::test]
    async fn every_high_risk_permission_requires_confirmation_before_its_handler() {
        for permission in crate::permissions::permission_registry()
            .iter()
            .filter(|permission| requires_high_risk_confirmation(permission))
        {
            let grants = PermissionGrantSet::from_requested(&[permission.id.to_string()]);
            let error = execute_tool_with_grants(&grants, permission.invocation_name, &json!({}))
                .await
                .unwrap_err();
            assert!(
                error.contains("confirmHighRisk: true"),
                "{} did not enforce acknowledgement: {error}",
                permission.invocation_name
            );
        }
    }

    #[tokio::test]
    async fn confirmation_bypass_values_aliases_and_case_variants_are_rejected() {
        let grants = PermissionGrantSet::from_requested(&["cf_delete_dns_record".to_string()]);
        let rejected = [
            json!({}),
            json!({"confirmHighRisk": false}),
            json!({"confirmHighRisk": "true"}),
            json!({"confirmHighRisk": "TRUE"}),
            json!({"confirmHighRisk": 1}),
            json!({"confirmHighRisk": null}),
            json!({"confirm_high_risk": true}),
            json!({"confirmhighrisk": true}),
            json!({"ConfirmHighRisk": true}),
            json!({"confirmHighrisk": true}),
        ];

        for args in rejected {
            let error = execute_tool_with_grants(&grants, "cf_delete_dns_record", &args)
                .await
                .unwrap_err();
            assert!(error.contains("confirmHighRisk: true"), "{args}: {error}");
        }

        let case_variant = execute_tool_with_grants(
            &grants,
            "CF_DELETE_DNS_RECORD",
            &json!({
                "confirmHighRisk": true
            }),
        )
        .await
        .unwrap_err();
        assert!(case_variant.contains("not registered"));

        let stable_id = execute_tool_with_grants(
            &grants,
            "bc.mcp.v1.cf.delete_dns_record",
            &json!({
                "confirmHighRisk": true
            }),
        )
        .await
        .unwrap_err();
        assert!(stable_id.contains("not registered"));
    }

    #[tokio::test]
    async fn bulk_operations_cannot_bypass_confirmation() {
        for name in ["cf_bulk_create_dns_records", "cf_bulk_delete_dns_records"] {
            let grants = PermissionGrantSet::from_requested(&[name.to_string()]);
            for args in [
                json!({"records": []}),
                json!({"confirmHighRisk": false, "records": []}),
                json!({"confirmHighRisk": "true", "records": []}),
                json!({"confirm_high_risk": true, "records": []}),
            ] {
                let error = execute_tool_with_grants(&grants, name, &args)
                    .await
                    .unwrap_err();
                assert!(error.contains("confirmHighRisk: true"), "{name}: {error}");
            }
        }
    }

    #[test]
    fn exact_confirmation_is_removed_before_handler_dispatch() {
        let permission =
            permission_for_invocation("cf_delete_dns_record").expect("registered tool");
        let args = json!({
            "confirmHighRisk": true,
            "api_key": "secret",
            "zone_id": "zone",
            "record_id": "record"
        });
        let prepared = prepare_handler_arguments(permission, &args).unwrap();
        assert!(prepared.get("confirmHighRisk").is_none());
        assert_eq!(prepared["api_key"], "secret");
        assert_eq!(prepared["record_id"], "record");
    }

    #[tokio::test]
    async fn compatibility_dispatch_without_grants_always_denies() {
        let result = execute_tool("dns_parse_spf", &json!({"content": "v=spf1 -all"})).await;
        assert!(result.unwrap_err().contains("explicit canonical"));
    }
}
