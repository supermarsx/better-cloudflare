import type { McpToolDescriptor } from "@/lib/api/tauri-client";

export type McpToolRisk =
  "read" | "write" | "bulk-sensitive" | "destructive" | "credential" | "admin";

export interface McpToolCategory {
  id: string;
  label: string;
  description: string;
}

export interface McpToolFallback {
  id: string;
  categoryId: string;
  label: string;
  description: string;
  risk: McpToolRisk;
}

export interface ResolvedMcpTool extends McpToolFallback {
  known: boolean;
  backend: McpToolDescriptor;
}

export interface McpToolIdReconciliation {
  enabledToolIds: string[];
  removedToolIds: string[];
}

export interface McpPermissionChangePlan extends McpToolIdReconciliation {
  newlyEnabledHighRiskToolIds: string[];
}

export interface McpPermissionPolicyPartition extends McpToolIdReconciliation {
  pendingHighRiskToolIds: string[];
}

export const MCP_PERMISSION_POLICY_VERSION = 1;

export const MCP_TOOL_CATEGORIES: readonly McpToolCategory[] = [
  {
    id: "access",
    label: "Access and zones",
    description:
      "Validate credentials and discover the Cloudflare zones they can access.",
  },
  {
    id: "dns-records",
    label: "DNS records",
    description: "Read, create, change, delete, or export zone DNS records.",
  },
  {
    id: "zone-operations",
    label: "Zone operations",
    description:
      "Inspect and change zone-wide settings or invalidate cached content.",
  },
  {
    id: "dnssec",
    label: "DNSSEC",
    description:
      "Inspect or change DNSSEC, which affects validation for the whole zone.",
  },
  {
    id: "analytics",
    label: "Analytics",
    description: "Read zone traffic and DNS query analytics.",
  },
  {
    id: "security",
    label: "Firewall and security",
    description:
      "Inspect or administer firewall, IP access, and managed WAF rules.",
  },
  {
    id: "workers",
    label: "Worker routes",
    description: "Inspect or change Worker routes that handle zone traffic.",
  },
  {
    id: "email-routing",
    label: "Email routing",
    description: "Inspect or change Cloudflare email-routing configuration.",
  },
  {
    id: "page-rules",
    label: "Page rules",
    description: "Inspect legacy page rules configured for a zone.",
  },
  {
    id: "spf-analysis",
    label: "SPF analysis",
    description:
      "Parse, simulate, and visualize SPF policy without changing DNS.",
  },
  {
    id: "dns-diagnostics",
    label: "DNS diagnostics",
    description:
      "Validate records and inspect DNS propagation or resolution topology.",
  },
  {
    id: "data-conversion",
    label: "DNS import and export",
    description:
      "Parse or generate CSV, BIND, and JSON representations supplied by the user.",
  },
  {
    id: "record-formats",
    label: "Structured record helpers",
    description:
      "Parse or compose SRV, TLSA, SSHFP, and NAPTR record content locally.",
  },
  {
    id: "audits",
    label: "Domain audits",
    description:
      "Run read-only security, email, and DNS hygiene checks for a domain.",
  },
] as const;

export const MCP_TOOL_FALLBACKS: readonly McpToolFallback[] = [
  {
    id: "cf_verify_token",
    categoryId: "access",
    label: "Verify Cloudflare credential",
    description:
      "Validate a Cloudflare API token or API key and email combination.",
    risk: "credential",
  },
  {
    id: "cf_list_zones",
    categoryId: "access",
    label: "List zones",
    description:
      "View the Cloudflare zones available to the current credential.",
    risk: "read",
  },
  {
    id: "cf_list_dns_records",
    categoryId: "dns-records",
    label: "List DNS records",
    description: "View DNS records in a zone with filtering and pagination.",
    risk: "read",
  },
  {
    id: "cf_create_dns_record",
    categoryId: "dns-records",
    label: "Create DNS record",
    description: "Add a DNS record to a Cloudflare zone.",
    risk: "write",
  },
  {
    id: "cf_update_dns_record",
    categoryId: "dns-records",
    label: "Update DNS record",
    description: "Change an existing DNS record by record ID.",
    risk: "write",
  },
  {
    id: "cf_delete_dns_record",
    categoryId: "dns-records",
    label: "Delete DNS record",
    description: "Permanently remove a DNS record from a zone.",
    risk: "destructive",
  },
  {
    id: "cf_bulk_create_dns_records",
    categoryId: "dns-records",
    label: "Bulk create DNS records",
    description:
      "Create many DNS records in one operation, optionally as a dry run.",
    risk: "bulk-sensitive",
  },
  {
    id: "cf_bulk_delete_dns_records",
    categoryId: "dns-records",
    label: "Bulk delete DNS records",
    description: "Permanently delete many DNS records in one operation.",
    risk: "destructive",
  },
  {
    id: "cf_export_dns_records",
    categoryId: "dns-records",
    label: "Export DNS records",
    description:
      "Read and export a complete zone in JSON, CSV, or BIND format.",
    risk: "bulk-sensitive",
  },
  {
    id: "cf_purge_cache",
    categoryId: "zone-operations",
    label: "Purge zone cache",
    description:
      "Invalidate all or selected cached content, which can increase origin traffic.",
    risk: "destructive",
  },
  {
    id: "cf_get_zone_setting",
    categoryId: "zone-operations",
    label: "View zone setting",
    description: "Read a Cloudflare zone-wide setting by its identifier.",
    risk: "read",
  },
  {
    id: "cf_update_zone_setting",
    categoryId: "zone-operations",
    label: "Update zone setting",
    description:
      "Change zone-wide behavior, including settings that affect security or traffic.",
    risk: "admin",
  },
  {
    id: "cf_get_dnssec",
    categoryId: "dnssec",
    label: "View DNSSEC",
    description: "Inspect the zone's current DNSSEC configuration.",
    risk: "read",
  },
  {
    id: "cf_update_dnssec",
    categoryId: "dnssec",
    label: "Update DNSSEC",
    description:
      "Enable, disable, or change DNSSEC configuration for the whole zone.",
    risk: "admin",
  },
  {
    id: "cf_get_zone_analytics",
    categoryId: "analytics",
    label: "View zone analytics",
    description:
      "Read zone requests, bandwidth, and threat analytics over a time range.",
    risk: "read",
  },
  {
    id: "cf_get_dns_analytics",
    categoryId: "analytics",
    label: "View DNS analytics",
    description:
      "Read DNS query analytics with configurable dimensions and metrics.",
    risk: "read",
  },
  {
    id: "cf_list_firewall_rules",
    categoryId: "security",
    label: "List firewall rules",
    description: "View custom firewall rules configured for a zone.",
    risk: "read",
  },
  {
    id: "cf_create_firewall_rule",
    categoryId: "security",
    label: "Create firewall rule",
    description: "Create an expression-based custom firewall rule for a zone.",
    risk: "admin",
  },
  {
    id: "cf_update_firewall_rule",
    categoryId: "security",
    label: "Update firewall rule",
    description: "Change an existing custom firewall rule by ID.",
    risk: "admin",
  },
  {
    id: "cf_delete_firewall_rule",
    categoryId: "security",
    label: "Delete firewall rule",
    description: "Permanently remove a custom firewall rule by ID.",
    risk: "destructive",
  },
  {
    id: "cf_list_ip_access_rules",
    categoryId: "security",
    label: "List IP access rules",
    description: "View IP allow, block, and challenge rules for a zone.",
    risk: "read",
  },
  {
    id: "cf_create_ip_access_rule",
    categoryId: "security",
    label: "Create IP access rule",
    description: "Create an IP allow, block, or challenge rule.",
    risk: "admin",
  },
  {
    id: "cf_delete_ip_access_rule",
    categoryId: "security",
    label: "Delete IP access rule",
    description: "Permanently remove an IP access rule by ID.",
    risk: "destructive",
  },
  {
    id: "cf_list_waf_rulesets",
    categoryId: "security",
    label: "List WAF rulesets",
    description: "View managed WAF rulesets available for a zone.",
    risk: "read",
  },
  {
    id: "cf_list_worker_routes",
    categoryId: "workers",
    label: "List Worker routes",
    description: "View Worker route patterns configured for a zone.",
    risk: "read",
  },
  {
    id: "cf_create_worker_route",
    categoryId: "workers",
    label: "Create Worker route",
    description: "Map a route pattern to a Worker script for zone traffic.",
    risk: "admin",
  },
  {
    id: "cf_delete_worker_route",
    categoryId: "workers",
    label: "Delete Worker route",
    description: "Permanently remove a Worker route by ID.",
    risk: "destructive",
  },
  {
    id: "cf_get_email_routing_settings",
    categoryId: "email-routing",
    label: "View email-routing settings",
    description: "Read email-routing status and settings for a zone.",
    risk: "read",
  },
  {
    id: "cf_list_email_routing_rules",
    categoryId: "email-routing",
    label: "List email-routing rules",
    description: "View all email-routing rules configured for a zone.",
    risk: "read",
  },
  {
    id: "cf_create_email_routing_rule",
    categoryId: "email-routing",
    label: "Create email-routing rule",
    description: "Create an email-routing rule with matchers and actions.",
    risk: "admin",
  },
  {
    id: "cf_delete_email_routing_rule",
    categoryId: "email-routing",
    label: "Delete email-routing rule",
    description: "Permanently remove an email-routing rule by ID.",
    risk: "destructive",
  },
  {
    id: "cf_list_page_rules",
    categoryId: "page-rules",
    label: "List page rules",
    description: "View legacy page rules configured for a zone.",
    risk: "read",
  },
  {
    id: "spf_simulate",
    categoryId: "spf-analysis",
    label: "Simulate SPF",
    description:
      "Evaluate SPF for a domain and IP without changing DNS records.",
    risk: "read",
  },
  {
    id: "spf_graph",
    categoryId: "spf-analysis",
    label: "Build SPF graph",
    description:
      "Build the include and redirect dependency graph for an SPF policy.",
    risk: "read",
  },
  {
    id: "spf_parse",
    categoryId: "spf-analysis",
    label: "Parse SPF record",
    description:
      "Parse SPF content into mechanisms, qualifiers, and modifiers.",
    risk: "read",
  },
  {
    id: "dns_validate_record",
    categoryId: "dns-diagnostics",
    label: "Validate DNS record",
    description: "Validate DNS record type, name, content, and TTL values.",
    risk: "read",
  },
  {
    id: "dns_check_propagation",
    categoryId: "dns-diagnostics",
    label: "Check DNS propagation",
    description: "Check DNS propagation across multiple global resolvers.",
    risk: "read",
  },
  {
    id: "dns_resolve_topology",
    categoryId: "dns-diagnostics",
    label: "Resolve DNS topology",
    description:
      "Resolve CNAME chains, reverse DNS, and location data for hostnames.",
    risk: "read",
  },
  {
    id: "dns_parse_csv",
    categoryId: "data-conversion",
    label: "Parse DNS CSV",
    description: "Parse user-supplied CSV text into DNS record values.",
    risk: "read",
  },
  {
    id: "dns_parse_bind",
    categoryId: "data-conversion",
    label: "Parse BIND zone",
    description: "Parse a user-supplied BIND zone file into DNS record values.",
    risk: "read",
  },
  {
    id: "dns_export_csv",
    categoryId: "data-conversion",
    label: "Generate DNS CSV",
    description: "Convert a supplied DNS record array to CSV text locally.",
    risk: "read",
  },
  {
    id: "dns_export_bind",
    categoryId: "data-conversion",
    label: "Generate BIND zone",
    description: "Convert supplied DNS records to BIND zone-file text locally.",
    risk: "read",
  },
  {
    id: "dns_export_json",
    categoryId: "data-conversion",
    label: "Generate DNS JSON",
    description:
      "Convert a supplied DNS record array to formatted JSON locally.",
    risk: "read",
  },
  {
    id: "dns_parse_srv",
    categoryId: "record-formats",
    label: "Parse SRV record",
    description: "Parse SRV content into priority, weight, port, and target.",
    risk: "read",
  },
  {
    id: "dns_compose_srv",
    categoryId: "record-formats",
    label: "Compose SRV record",
    description: "Build SRV record content from structured component values.",
    risk: "read",
  },
  {
    id: "dns_parse_tlsa",
    categoryId: "record-formats",
    label: "Parse TLSA record",
    description:
      "Parse TLSA content into usage, selector, matching type, and data.",
    risk: "read",
  },
  {
    id: "dns_compose_tlsa",
    categoryId: "record-formats",
    label: "Compose TLSA record",
    description: "Build TLSA record content from structured component values.",
    risk: "read",
  },
  {
    id: "dns_parse_sshfp",
    categoryId: "record-formats",
    label: "Parse SSHFP record",
    description: "Parse SSHFP content into algorithm, type, and fingerprint.",
    risk: "read",
  },
  {
    id: "dns_compose_sshfp",
    categoryId: "record-formats",
    label: "Compose SSHFP record",
    description: "Build SSHFP record content from structured component values.",
    risk: "read",
  },
  {
    id: "dns_parse_naptr",
    categoryId: "record-formats",
    label: "Parse NAPTR record",
    description:
      "Parse NAPTR content into order, preference, flags, service, and replacement.",
    risk: "read",
  },
  {
    id: "dns_compose_naptr",
    categoryId: "record-formats",
    label: "Compose NAPTR record",
    description: "Build NAPTR record content from structured component values.",
    risk: "read",
  },
  {
    id: "dns_parse_spf",
    categoryId: "spf-analysis",
    label: "Parse SPF content",
    description: "Parse SPF TXT content using the SPF parser alias.",
    risk: "read",
  },
  {
    id: "audit_run_domain",
    categoryId: "audits",
    label: "Run domain audit",
    description:
      "Check a domain for DNS, email, security, and hygiene issues without changing it.",
    risk: "read",
  },
] as const;

export const STABLE_MCP_TOOL_IDS: readonly string[] = MCP_TOOL_FALLBACKS.map(
  ({ id }) => id,
);

export const MAX_MCP_PERMISSION_DIAGNOSTIC_IDS = 64;
export const MAX_MCP_PERMISSION_TOOL_ID_LENGTH = 160;

export const DEFAULT_MCP_ENABLED_TOOL_IDS: readonly string[] =
  MCP_TOOL_FALLBACKS.filter(({ risk }) => risk === "read").map(({ id }) => id);

const fallbackById = new Map(
  MCP_TOOL_FALLBACKS.map((fallback) => [fallback.id, fallback]),
);
const stableToolIds = new Set(STABLE_MCP_TOOL_IDS);

function normalizeMcpToolId(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function boundedMcpPermissionDiagnosticId(id: string): string {
  if (id.length <= MAX_MCP_PERMISSION_TOOL_ID_LENGTH) return id;
  return `${id.slice(0, MAX_MCP_PERMISSION_TOOL_ID_LENGTH - 1)}…`;
}

export function capMcpPermissionDiagnosticIds(
  values: readonly unknown[] | null | undefined,
): string[] {
  const diagnostics = new Set<string>();
  for (const value of values ?? []) {
    const id = normalizeMcpToolId(value);
    if (!id) continue;
    diagnostics.add(boundedMcpPermissionDiagnosticId(id));
    if (diagnostics.size >= MAX_MCP_PERMISSION_DIAGNOSTIC_IDS) break;
  }
  return [...diagnostics];
}

export function isStableMcpToolId(id: string): boolean {
  return stableToolIds.has(id);
}

export function reconcileMcpEnabledToolIdsDetailed(
  enabledToolIds: readonly unknown[] | null | undefined,
): McpToolIdReconciliation {
  const requested = new Set<string>();
  const removed = new Set<string>();

  for (const value of enabledToolIds ?? []) {
    const id = normalizeMcpToolId(value);
    if (!id) continue;
    if (stableToolIds.has(id)) requested.add(id);
    else if (removed.size < MAX_MCP_PERMISSION_DIAGNOSTIC_IDS) {
      removed.add(boundedMcpPermissionDiagnosticId(id));
    }
  }

  return {
    enabledToolIds: STABLE_MCP_TOOL_IDS.filter((id) => requested.has(id)),
    removedToolIds: [...removed],
  };
}

export function reconcileMcpEnabledToolIds(
  enabledToolIds: readonly unknown[] | null | undefined,
): string[] {
  return reconcileMcpEnabledToolIdsDetailed(enabledToolIds).enabledToolIds;
}

export function requiresMcpPermissionConfirmation(risk: McpToolRisk): boolean {
  return risk !== "read";
}

export function partitionMcpPermissionPolicySelection(
  enabledToolIds: readonly unknown[] | null | undefined,
): McpPermissionPolicyPartition {
  const reconciliation = reconcileMcpEnabledToolIdsDetailed(enabledToolIds);
  const pendingHighRiskToolIds = reconciliation.enabledToolIds.filter((id) => {
    const tool = fallbackById.get(id);
    return tool !== undefined && requiresMcpPermissionConfirmation(tool.risk);
  });
  const pendingHighRiskSet = new Set(pendingHighRiskToolIds);

  return {
    enabledToolIds: reconciliation.enabledToolIds.filter(
      (id) => !pendingHighRiskSet.has(id),
    ),
    pendingHighRiskToolIds,
    removedToolIds: reconciliation.removedToolIds,
  };
}

export function planMcpPermissionChange(
  currentEnabledToolIds: readonly unknown[] | null | undefined,
  requestedEnabledToolIds: readonly unknown[] | null | undefined,
): McpPermissionChangePlan {
  const current = new Set(reconcileMcpEnabledToolIds(currentEnabledToolIds));
  const reconciled = reconcileMcpEnabledToolIdsDetailed(
    requestedEnabledToolIds,
  );
  return {
    ...reconciled,
    newlyEnabledHighRiskToolIds: reconciled.enabledToolIds.filter((id) => {
      const tool = fallbackById.get(id);
      return (
        !current.has(id) &&
        tool !== undefined &&
        requiresMcpPermissionConfirmation(tool.risk)
      );
    }),
  };
}

export function resolveMcpTool(backend: McpToolDescriptor): ResolvedMcpTool {
  const normalizedId = normalizeMcpToolId(backend.name);
  const fallback = fallbackById.get(normalizedId);
  if (fallback) {
    return {
      ...fallback,
      known: true,
      backend,
    };
  }

  const id = boundedMcpPermissionDiagnosticId(normalizedId);
  return {
    id,
    categoryId: "unclassified",
    label: String(backend.title ?? "").trim() || id || "Unnamed tool",
    description:
      String(backend.description ?? "").trim() ||
      "No reviewed permission metadata is available for this tool.",
    risk: "admin",
    known: false,
    backend,
  };
}
