import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { CryptoManager } from "../src/lib/auth/crypto";
import { TauriClient } from "../src/lib/api/tauri-client";
import {
  MCP_TOOL_CATEGORIES,
  MCP_TOOL_FALLBACKS,
  STABLE_MCP_TOOL_IDS,
  reconcileMcpEnabledToolIds,
} from "../src/lib/mcp/tool-permissions";
import { StorageManager } from "../src/lib/storage/storage";

const STORAGE_KEY = "cloudflare-dns-manager";

const EXPECTED_STABLE_TOOL_IDS = [
  "cf_verify_token",
  "cf_list_zones",
  "cf_list_dns_records",
  "cf_create_dns_record",
  "cf_update_dns_record",
  "cf_delete_dns_record",
  "cf_bulk_create_dns_records",
  "cf_export_dns_records",
  "cf_purge_cache",
  "cf_get_zone_setting",
  "cf_update_zone_setting",
  "cf_get_dnssec",
  "cf_update_dnssec",
  "spf_simulate",
  "spf_graph",
] as const;

class LocalStorageMock {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? this.store[key]
      : null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }
}

afterEach(() => {
  clearMocks();
});

test("MCP fallback metadata preserves the reviewed stable tool contract", () => {
  assert.deepEqual(STABLE_MCP_TOOL_IDS, EXPECTED_STABLE_TOOL_IDS);
  assert.equal(new Set(STABLE_MCP_TOOL_IDS).size, STABLE_MCP_TOOL_IDS.length);
  assert.deepEqual(
    MCP_TOOL_CATEGORIES.map(({ id, label }) => ({ id, label })),
    [
      { id: "access", label: "Access and zones" },
      { id: "dns-records", label: "DNS records" },
      { id: "zone-operations", label: "Zone operations" },
      { id: "dnssec", label: "DNSSEC" },
      { id: "spf-analysis", label: "SPF analysis" },
    ],
  );
  assert.deepEqual(
    MCP_TOOL_FALLBACKS.map(({ id, categoryId, label, risk }) => ({
      id,
      categoryId,
      label,
      risk,
    })),
    [
      {
        id: "cf_verify_token",
        categoryId: "access",
        label: "Verify API token",
        risk: "credential-admin",
      },
      {
        id: "cf_list_zones",
        categoryId: "access",
        label: "List zones",
        risk: "read",
      },
      {
        id: "cf_list_dns_records",
        categoryId: "dns-records",
        label: "List DNS records",
        risk: "read",
      },
      {
        id: "cf_create_dns_record",
        categoryId: "dns-records",
        label: "Create DNS record",
        risk: "write",
      },
      {
        id: "cf_update_dns_record",
        categoryId: "dns-records",
        label: "Update DNS record",
        risk: "write",
      },
      {
        id: "cf_delete_dns_record",
        categoryId: "dns-records",
        label: "Delete DNS record",
        risk: "destructive",
      },
      {
        id: "cf_bulk_create_dns_records",
        categoryId: "dns-records",
        label: "Bulk create DNS records",
        risk: "write",
      },
      {
        id: "cf_export_dns_records",
        categoryId: "dns-records",
        label: "Export DNS records",
        risk: "read",
      },
      {
        id: "cf_purge_cache",
        categoryId: "zone-operations",
        label: "Purge zone cache",
        risk: "destructive",
      },
      {
        id: "cf_get_zone_setting",
        categoryId: "zone-operations",
        label: "View zone setting",
        risk: "read",
      },
      {
        id: "cf_update_zone_setting",
        categoryId: "zone-operations",
        label: "Update zone setting",
        risk: "credential-admin",
      },
      {
        id: "cf_get_dnssec",
        categoryId: "dnssec",
        label: "View DNSSEC",
        risk: "read",
      },
      {
        id: "cf_update_dnssec",
        categoryId: "dnssec",
        label: "Update DNSSEC",
        risk: "credential-admin",
      },
      {
        id: "spf_simulate",
        categoryId: "spf-analysis",
        label: "Simulate SPF",
        risk: "read",
      },
      {
        id: "spf_graph",
        categoryId: "spf-analysis",
        label: "Graph SPF",
        risk: "read",
      },
    ],
  );

  const categoryIds = new Set(MCP_TOOL_CATEGORIES.map(({ id }) => id));
  for (const tool of MCP_TOOL_FALLBACKS) {
    assert.ok(categoryIds.has(tool.categoryId));
    assert.ok(tool.label.length >= 4);
    assert.ok(tool.description.length >= 20);
  }
});

test("MCP enabled-tool persistence keeps only stable IDs and preserves an intentional empty selection", () => {
  const storage = new LocalStorageMock();
  const manager = new StorageManager(storage, new CryptoManager({}, storage));

  assert.deepEqual(manager.getMcpEnabledTools(), EXPECTED_STABLE_TOOL_IDS);

  manager.setMcpEnabledTools([
    "future_unreviewed_tool",
    "cf_delete_dns_record",
    "cf_delete_dns_record",
    " cf_list_zones ",
  ]);

  assert.deepEqual(manager.getMcpEnabledTools(), [
    "cf_list_zones",
    "cf_delete_dns_record",
  ]);
  assert.deepEqual(
    new StorageManager(
      storage,
      new CryptoManager({}, storage),
    ).getMcpEnabledTools(),
    ["cf_list_zones", "cf_delete_dns_record"],
  );

  manager.setMcpEnabledTools([]);
  assert.deepEqual(manager.getMcpEnabledTools(), []);
  assert.deepEqual(
    JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}").mcpEnabledTools,
    [],
  );
  assert.deepEqual(
    new StorageManager(
      storage,
      new CryptoManager({}, storage),
    ).getMcpEnabledTools(),
    [],
  );
});

test("MCP reconciliation defaults unknown and malformed IDs to denied", () => {
  assert.deepEqual(
    reconcileMcpEnabledToolIds([
      "future_unreviewed_tool",
      "",
      "cf_list_zones",
      "cf_list_zones",
      " cf_get_dnssec ",
    ]),
    ["cf_list_zones", "cf_get_dnssec"],
  );
  assert.deepEqual(reconcileMcpEnabledToolIds(["future_unreviewed_tool"]), []);
  assert.deepEqual(reconcileMcpEnabledToolIds(undefined), []);
});

test("mcp_set_enabled_tools invoke uses the exact camelCase enabledTools payload", async () => {
  const calls: Array<{
    command: string;
    payload: Record<string, unknown> | undefined;
  }> = [];
  mockIPC((command, payload) => {
    calls.push({
      command,
      payload: payload as Record<string, unknown> | undefined,
    });
    return {
      running: false,
      host: "127.0.0.1",
      port: 8787,
      url: "http://127.0.0.1:8787/mcp",
      enabledTools: ["cf_list_zones"],
      tools: [],
    };
  });

  const enabledTools = ["cf_list_zones"];
  await TauriClient.setMcpEnabledTools(enabledTools);

  assert.deepEqual(calls, [
    {
      command: "mcp_set_enabled_tools",
      payload: { enabledTools },
    },
  ]);
  assert.deepEqual(Object.keys(calls[0]?.payload ?? {}), ["enabledTools"]);
  assert.equal("enabled_tools" in (calls[0]?.payload ?? {}), false);
});
