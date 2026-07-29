import type { McpToolDescriptor } from "@/lib/api/tauri-client";

export type McpToolRisk = "read" | "write" | "destructive" | "credential-admin";

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

export const MCP_TOOL_CATEGORIES: readonly McpToolCategory[] = [
  {
    id: "access",
    label: "Access and zones",
    description:
      "Inspect the active credential and discover the zones it can access.",
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
    id: "spf-analysis",
    label: "SPF analysis",
    description: "Simulate and visualize SPF policy without changing DNS.",
  },
] as const;

export const MCP_TOOL_FALLBACKS: readonly McpToolFallback[] = [
  {
    id: "cf_verify_token",
    categoryId: "access",
    label: "Verify API token",
    description:
      "Check whether the current Cloudflare credential is valid and which access it grants.",
    risk: "credential-admin",
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
    description: "View DNS records in a zone.",
    risk: "read",
  },
  {
    id: "cf_create_dns_record",
    categoryId: "dns-records",
    label: "Create DNS record",
    description: "Add a DNS record to a zone.",
    risk: "write",
  },
  {
    id: "cf_update_dns_record",
    categoryId: "dns-records",
    label: "Update DNS record",
    description: "Change an existing DNS record.",
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
    description: "Add multiple DNS records to a zone in one operation.",
    risk: "write",
  },
  {
    id: "cf_export_dns_records",
    categoryId: "dns-records",
    label: "Export DNS records",
    description: "Read and export a complete set of DNS records for a zone.",
    risk: "read",
  },
  {
    id: "cf_purge_cache",
    categoryId: "zone-operations",
    label: "Purge zone cache",
    description:
      "Invalidate cached content, which can immediately increase origin traffic.",
    risk: "destructive",
  },
  {
    id: "cf_get_zone_setting",
    categoryId: "zone-operations",
    label: "View zone setting",
    description: "Read a zone-wide Cloudflare setting.",
    risk: "read",
  },
  {
    id: "cf_update_zone_setting",
    categoryId: "zone-operations",
    label: "Update zone setting",
    description:
      "Change zone-wide behavior, including settings that affect security or traffic.",
    risk: "credential-admin",
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
    risk: "credential-admin",
  },
  {
    id: "spf_simulate",
    categoryId: "spf-analysis",
    label: "Simulate SPF",
    description: "Evaluate SPF policy behavior without changing DNS records.",
    risk: "read",
  },
  {
    id: "spf_graph",
    categoryId: "spf-analysis",
    label: "Graph SPF",
    description: "Build a readable dependency graph for an SPF policy.",
    risk: "read",
  },
] as const;

export const STABLE_MCP_TOOL_IDS: readonly string[] = MCP_TOOL_FALLBACKS.map(
  ({ id }) => id,
);

export const DEFAULT_MCP_ENABLED_TOOL_IDS: readonly string[] =
  STABLE_MCP_TOOL_IDS;

const fallbackById = new Map(
  MCP_TOOL_FALLBACKS.map((fallback) => [fallback.id, fallback]),
);
const stableToolIds = new Set(STABLE_MCP_TOOL_IDS);

export function isStableMcpToolId(id: string): boolean {
  return stableToolIds.has(id);
}

export function reconcileMcpEnabledToolIds(
  enabledToolIds: readonly string[] | null | undefined,
): string[] {
  const requested = new Set(
    (enabledToolIds ?? [])
      .map((id) => String(id).trim())
      .filter((id) => stableToolIds.has(id)),
  );
  return STABLE_MCP_TOOL_IDS.filter((id) => requested.has(id));
}

export function requiresMcpPermissionConfirmation(risk: McpToolRisk): boolean {
  return risk === "destructive" || risk === "credential-admin";
}

export function resolveMcpTool(backend: McpToolDescriptor): ResolvedMcpTool {
  const id = String(backend.name ?? "").trim();
  const fallback = fallbackById.get(id);
  if (fallback) {
    return {
      ...fallback,
      known: true,
      backend,
    };
  }

  return {
    id,
    categoryId: "unclassified",
    label: String(backend.title ?? "").trim() || id || "Unnamed tool",
    description:
      String(backend.description ?? "").trim() ||
      "No reviewed permission metadata is available for this tool.",
    risk: "credential-admin",
    known: false,
    backend,
  };
}
