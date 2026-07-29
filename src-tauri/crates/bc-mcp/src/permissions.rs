//! Authoritative MCP permission registry and opaque canonical grant set.
//!
//! Persisted settings may contain a stable permission ID, the registered
//! invocation name, or an explicitly registered legacy alias. Resolution is
//! exact and fail-closed: unknown values and registry collisions grant nothing.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionCategory {
    Cloudflare,
    Dns,
    Spf,
    Audit,
}

impl PermissionCategory {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cloudflare => "cloudflare",
            Self::Dns => "dns",
            Self::Spf => "spf",
            Self::Audit => "audit",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionEffect {
    Read,
    Analysis,
    Write,
    Destructive,
}

impl PermissionEffect {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Analysis => "analysis",
            Self::Write => "write",
            Self::Destructive => "destructive",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionRisk {
    Low,
    High,
    Critical,
}

impl PermissionRisk {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }
}

/// High-risk acknowledgement is required for every high-risk or destructive
/// permission. Keeping this decision at the registry boundary prevents new
/// handlers from accidentally omitting the acknowledgement check.
pub const fn requires_high_risk_confirmation(permission: &PermissionDefinition) -> bool {
    matches!(
        permission.risk,
        PermissionRisk::High | PermissionRisk::Critical
    ) || matches!(permission.effect, PermissionEffect::Destructive)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgumentProfile {
    pub max_json_bytes: usize,
    pub max_collection_items: usize,
    pub max_string_bytes: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct PermissionDefinition {
    pub id: &'static str,
    pub invocation_name: &'static str,
    pub legacy_aliases: &'static [&'static str],
    pub category: PermissionCategory,
    pub effect: PermissionEffect,
    pub risk: PermissionRisk,
    pub network_access: bool,
    pub credential_access: bool,
    pub argument_profile: ArgumentProfile,
}

const READ: ArgumentProfile = ArgumentProfile {
    max_json_bytes: 64 * 1024,
    max_collection_items: 100,
    max_string_bytes: 32 * 1024,
};
const MUTATION: ArgumentProfile = ArgumentProfile {
    max_json_bytes: 64 * 1024,
    max_collection_items: 100,
    max_string_bytes: 32 * 1024,
};
const BULK_MUTATION: ArgumentProfile = ArgumentProfile {
    max_json_bytes: 256 * 1024,
    max_collection_items: 100,
    max_string_bytes: 64 * 1024,
};
const LOCAL: ArgumentProfile = ArgumentProfile {
    max_json_bytes: 256 * 1024,
    max_collection_items: 1_000,
    max_string_bytes: 192 * 1024,
};
const NETWORK_DIAGNOSTIC: ArgumentProfile = ArgumentProfile {
    max_json_bytes: 64 * 1024,
    max_collection_items: 100,
    max_string_bytes: 32 * 1024,
};

macro_rules! permission {
    (
        $id:literal, $name:literal, $category:ident, $effect:ident, $risk:ident,
        $network:literal, $credentials:literal, $profile:ident
    ) => {
        PermissionDefinition {
            id: $id,
            invocation_name: $name,
            legacy_aliases: &[],
            category: PermissionCategory::$category,
            effect: PermissionEffect::$effect,
            risk: PermissionRisk::$risk,
            network_access: $network,
            credential_access: $credentials,
            argument_profile: $profile,
        }
    };
}

/// One explicit entry for every tool in the catalogue. Security metadata must
/// never be inferred from an invocation prefix or spelling.
pub const PERMISSION_REGISTRY: &[PermissionDefinition] = &[
    permission!(
        "bc.mcp.v1.cf.verify_token",
        "cf_verify_token",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.list_zones",
        "cf_list_zones",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.list_dns_records",
        "cf_list_dns_records",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.create_dns_record",
        "cf_create_dns_record",
        Cloudflare,
        Write,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.update_dns_record",
        "cf_update_dns_record",
        Cloudflare,
        Write,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.delete_dns_record",
        "cf_delete_dns_record",
        Cloudflare,
        Destructive,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.bulk_create_dns_records",
        "cf_bulk_create_dns_records",
        Cloudflare,
        Write,
        High,
        true,
        true,
        BULK_MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.bulk_delete_dns_records",
        "cf_bulk_delete_dns_records",
        Cloudflare,
        Destructive,
        High,
        true,
        true,
        BULK_MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.export_dns_records",
        "cf_export_dns_records",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.purge_cache",
        "cf_purge_cache",
        Cloudflare,
        Destructive,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.get_zone_setting",
        "cf_get_zone_setting",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.update_zone_setting",
        "cf_update_zone_setting",
        Cloudflare,
        Write,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.get_dnssec",
        "cf_get_dnssec",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.update_dnssec",
        "cf_update_dnssec",
        Cloudflare,
        Write,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.get_zone_analytics",
        "cf_get_zone_analytics",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.get_dns_analytics",
        "cf_get_dns_analytics",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.list_firewall_rules",
        "cf_list_firewall_rules",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.create_firewall_rule",
        "cf_create_firewall_rule",
        Cloudflare,
        Write,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.update_firewall_rule",
        "cf_update_firewall_rule",
        Cloudflare,
        Write,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.delete_firewall_rule",
        "cf_delete_firewall_rule",
        Cloudflare,
        Destructive,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.list_ip_access_rules",
        "cf_list_ip_access_rules",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.create_ip_access_rule",
        "cf_create_ip_access_rule",
        Cloudflare,
        Write,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.delete_ip_access_rule",
        "cf_delete_ip_access_rule",
        Cloudflare,
        Destructive,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.list_waf_rulesets",
        "cf_list_waf_rulesets",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.list_worker_routes",
        "cf_list_worker_routes",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.create_worker_route",
        "cf_create_worker_route",
        Cloudflare,
        Write,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.delete_worker_route",
        "cf_delete_worker_route",
        Cloudflare,
        Destructive,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.get_email_routing_settings",
        "cf_get_email_routing_settings",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.list_email_routing_rules",
        "cf_list_email_routing_rules",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.cf.create_email_routing_rule",
        "cf_create_email_routing_rule",
        Cloudflare,
        Write,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.delete_email_routing_rule",
        "cf_delete_email_routing_rule",
        Cloudflare,
        Destructive,
        High,
        true,
        true,
        MUTATION
    ),
    permission!(
        "bc.mcp.v1.cf.list_page_rules",
        "cf_list_page_rules",
        Cloudflare,
        Read,
        Low,
        true,
        true,
        READ
    ),
    permission!(
        "bc.mcp.v1.spf.simulate",
        "spf_simulate",
        Spf,
        Analysis,
        Low,
        true,
        false,
        NETWORK_DIAGNOSTIC
    ),
    permission!(
        "bc.mcp.v1.spf.graph",
        "spf_graph",
        Spf,
        Analysis,
        Low,
        true,
        false,
        NETWORK_DIAGNOSTIC
    ),
    permission!(
        "bc.mcp.v1.spf.parse",
        "spf_parse",
        Spf,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.validate_record",
        "dns_validate_record",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.check_propagation",
        "dns_check_propagation",
        Dns,
        Analysis,
        Low,
        true,
        false,
        NETWORK_DIAGNOSTIC
    ),
    permission!(
        "bc.mcp.v1.dns.resolve_topology",
        "dns_resolve_topology",
        Dns,
        Analysis,
        Low,
        true,
        false,
        NETWORK_DIAGNOSTIC
    ),
    permission!(
        "bc.mcp.v1.dns.parse_csv",
        "dns_parse_csv",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.parse_bind",
        "dns_parse_bind",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.export_csv",
        "dns_export_csv",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.export_bind",
        "dns_export_bind",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.export_json",
        "dns_export_json",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.parse_srv",
        "dns_parse_srv",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.compose_srv",
        "dns_compose_srv",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.parse_tlsa",
        "dns_parse_tlsa",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.compose_tlsa",
        "dns_compose_tlsa",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.parse_sshfp",
        "dns_parse_sshfp",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.compose_sshfp",
        "dns_compose_sshfp",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.parse_naptr",
        "dns_parse_naptr",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.compose_naptr",
        "dns_compose_naptr",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.dns.parse_spf",
        "dns_parse_spf",
        Dns,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
    permission!(
        "bc.mcp.v1.audit.run_domain",
        "audit_run_domain",
        Audit,
        Analysis,
        Low,
        false,
        false,
        LOCAL
    ),
];

/// The default permission set is deliberately empty. Even nominally read-only
/// Cloudflare tools handle credentials, while network and local-analysis tools
/// can still consume attacker-controlled input or perform outbound lookups.
/// Every tool therefore requires an explicit grant, and future registry entries
/// remain denied until a caller opts into their stable permission ID.
const DEFAULT_PERMISSION_IDS: &[&str] = &[];

pub fn permission_registry() -> &'static [PermissionDefinition] {
    PERMISSION_REGISTRY
}

fn unique_match(
    mut matches: impl Iterator<Item = &'static PermissionDefinition>,
) -> Option<&'static PermissionDefinition> {
    let first = matches.next()?;
    if matches.next().is_some() {
        None
    } else {
        Some(first)
    }
}

pub fn permission_by_id(id: &str) -> Option<&'static PermissionDefinition> {
    unique_match(
        PERMISSION_REGISTRY
            .iter()
            .filter(|permission| permission.id == id),
    )
}

pub fn permission_for_invocation(name: &str) -> Option<&'static PermissionDefinition> {
    unique_match(PERMISSION_REGISTRY.iter().filter(|permission| {
        permission.invocation_name == name || permission.legacy_aliases.contains(&name)
    }))
}

pub fn canonical_permission_id(value: &str) -> Option<&'static str> {
    unique_match(PERMISSION_REGISTRY.iter().filter(|permission| {
        permission.id == value
            || permission.invocation_name == value
            || permission.legacy_aliases.contains(&value)
    }))
    .map(|permission| permission.id)
}

/// Canonical grants are intentionally opaque: callers can construct them only
/// through exact registry resolution and cannot insert arbitrary strings.
#[derive(Debug, Clone, Default)]
pub struct PermissionGrantSet {
    ids: HashSet<&'static str>,
}

impl PermissionGrantSet {
    pub fn from_requested(values: &[String]) -> Self {
        Self {
            ids: values
                .iter()
                .filter_map(|value| canonical_permission_id(value))
                .collect(),
        }
    }

    pub fn all() -> Self {
        Self {
            ids: PERMISSION_REGISTRY
                .iter()
                .map(|permission| permission.id)
                .collect(),
        }
    }

    pub fn defaults() -> Self {
        Self {
            ids: DEFAULT_PERMISSION_IDS
                .iter()
                .filter_map(|id| permission_by_id(id).map(|permission| permission.id))
                .collect(),
        }
    }

    pub fn allows(&self, permission: &PermissionDefinition) -> bool {
        self.ids.contains(permission.id)
    }

    pub fn allows_id(&self, permission_id: &str) -> bool {
        self.ids.contains(permission_id)
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    pub fn permission_ids(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.ids.iter().copied()
    }
}

pub fn validate_arguments(permission: &PermissionDefinition, args: &Value) -> Result<(), String> {
    if !args.is_object() {
        return Err("Tool arguments must be a JSON object.".to_string());
    }

    let encoded_bytes = serde_json::to_vec(args)
        .map_err(|_| "Tool arguments could not be encoded safely.".to_string())?
        .len();
    if encoded_bytes > permission.argument_profile.max_json_bytes {
        return Err(format!(
            "Tool arguments exceed the {} byte permission limit.",
            permission.argument_profile.max_json_bytes
        ));
    }
    validate_value_bounds(args, permission.argument_profile)
}

fn validate_value_bounds(value: &Value, profile: ArgumentProfile) -> Result<(), String> {
    match value {
        Value::String(value) if value.len() > profile.max_string_bytes => Err(format!(
            "A string argument exceeds the {} byte permission limit.",
            profile.max_string_bytes
        )),
        Value::Array(values) => {
            if values.len() > profile.max_collection_items {
                return Err(format!(
                    "A collection argument exceeds the {} item permission limit.",
                    profile.max_collection_items
                ));
            }
            for value in values {
                validate_value_bounds(value, profile)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            if values.len() > profile.max_collection_items {
                return Err(format!(
                    "An object argument exceeds the {} member permission limit.",
                    profile.max_collection_items
                ));
            }
            for value in values.values() {
                validate_value_bounds(value, profile)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_invocation_or_alias_resolution_fails_closed() {
        static COLLIDING: &[PermissionDefinition] = &[
            PermissionDefinition {
                id: "one",
                invocation_name: "first",
                legacy_aliases: &["shared"],
                category: PermissionCategory::Dns,
                effect: PermissionEffect::Read,
                risk: PermissionRisk::Low,
                network_access: false,
                credential_access: false,
                argument_profile: READ,
            },
            PermissionDefinition {
                id: "two",
                invocation_name: "shared",
                legacy_aliases: &[],
                category: PermissionCategory::Dns,
                effect: PermissionEffect::Read,
                risk: PermissionRisk::Low,
                network_access: false,
                credential_access: false,
                argument_profile: READ,
            },
        ];

        let resolved = unique_match(COLLIDING.iter().filter(|permission| {
            permission.invocation_name == "shared" || permission.legacy_aliases.contains(&"shared")
        }));
        assert!(resolved.is_none());
    }

    #[test]
    fn defaults_are_empty_and_new_permissions_default_deny() {
        let defaults = PermissionGrantSet::defaults();
        assert!(defaults.is_empty());

        let future = PermissionDefinition {
            id: "bc.mcp.v1.cf.future_mutation",
            invocation_name: "cf_future_mutation",
            legacy_aliases: &[],
            category: PermissionCategory::Cloudflare,
            effect: PermissionEffect::Write,
            risk: PermissionRisk::Critical,
            network_access: true,
            credential_access: true,
            argument_profile: MUTATION,
        };
        assert!(!defaults.allows(&future));
        assert!(requires_high_risk_confirmation(&future));
    }
}
