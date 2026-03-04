//! MCP tool registry and dispatch.
//!
//! Centralises the list of all available tools, their metadata, and the
//! top-level `execute_tool` dispatcher that routes to sub-modules.

pub mod audit_tools;
pub mod cloudflare;
pub mod dns_tools;
pub mod spf_tools;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schemas;

// ─── Tool descriptor ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDescriptor {
    pub name: String,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
    pub enabled: bool,
    /// Category for UI grouping ("cloudflare", "dns", "spf", "audit").
    pub category: String,
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
        .map(|(name, title, description, category)| McpToolDescriptor {
            name: name.to_string(),
            title: title.to_string(),
            description: description.to_string(),
            input_schema: schemas::tool_input_schema(name),
            enabled: true,
            category: category.to_string(),
        })
        .collect()
}

/// All tool names in the catalogue.
pub fn all_tool_names() -> Vec<String> {
    TOOL_CATALOGUE.iter().map(|(n, _, _, _)| n.to_string()).collect()
}

/// Number of tools in the catalogue.
pub fn tool_count() -> usize {
    TOOL_CATALOGUE.len()
}

/// Dispatch tool execution to the correct sub-module.
pub async fn execute_tool(name: &str, args: &Value) -> Result<Value, String> {
    // Route by prefix/category
    if name.starts_with("cf_") {
        return cloudflare::execute(name, args).await;
    }
    if name.starts_with("spf_") {
        return spf_tools::execute(name, args).await;
    }
    if name.starts_with("audit_") {
        return audit_tools::execute(name, args).await;
    }
    if name.starts_with("dns_") {
        // dns_parse_spf is an alias for spf_parse
        if name == "dns_parse_spf" {
            return spf_tools::execute("spf_parse", args).await;
        }
        return dns_tools::execute(name, args).await;
    }

    Err(format!("Unknown tool '{}'", name))
}
