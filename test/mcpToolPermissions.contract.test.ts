import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { CryptoManager } from "../src/lib/auth/crypto";
import { TauriClient } from "../src/lib/api/tauri-client";
import {
  DEFAULT_MCP_ENABLED_TOOL_IDS,
  MCP_TOOL_CATEGORIES,
  MCP_TOOL_FALLBACKS,
  STABLE_MCP_TOOL_IDS,
  planMcpPermissionChange,
  reconcileMcpEnabledToolIds,
  reconcileMcpEnabledToolIdsDetailed,
  requiresMcpPermissionConfirmation,
} from "../src/lib/mcp/tool-permissions";
import { StorageManager } from "../src/lib/storage/storage";

const STORAGE_KEY = "cloudflare-dns-manager";
const RUST_REGISTRY_PATH = join(
  process.cwd(),
  "src-tauri",
  "crates",
  "bc-mcp",
  "src",
  "tools",
  "mod.rs",
);

function rustRegistryToolIds(): string[] {
  const source = readFileSync(RUST_REGISTRY_PATH, "utf8");
  const catalogue = source.match(
    /const\s+TOOL_CATALOGUE\s*:[^=]+=\s*&\[(?<body>[\s\S]*?)\n\];/,
  );
  assert.ok(
    catalogue?.groups?.body,
    "The Rust TOOL_CATALOGUE declaration must remain parseable by this contract test",
  );

  return [...catalogue.groups.body.matchAll(/^\s*\(\s*"([^"]+)"/gm)].map(
    (match) => match[1],
  );
}

class LocalStorageMock {
  private store: Record<string, string> = {};
  failWrites = false;

  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? this.store[key]
      : null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("storage quota exceeded");
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }
}

afterEach(() => {
  clearMocks();
});

test("frontend MCP metadata exactly covers the live 53-tool Rust registry", () => {
  const rustToolIds = rustRegistryToolIds();

  assert.equal(rustToolIds.length, 53);
  assert.equal(new Set(rustToolIds).size, rustToolIds.length);
  assert.deepEqual(STABLE_MCP_TOOL_IDS, rustToolIds);
  assert.deepEqual(
    MCP_TOOL_FALLBACKS.map(({ id }) => id),
    rustToolIds,
  );

  const categoryIds = new Set(MCP_TOOL_CATEGORIES.map(({ id }) => id));
  assert.equal(categoryIds.size, MCP_TOOL_CATEGORIES.length);
  for (const category of MCP_TOOL_CATEGORIES) {
    assert.ok(category.label.length >= 4);
    assert.ok(category.description.length >= 20);
  }
  for (const tool of MCP_TOOL_FALLBACKS) {
    assert.ok(
      categoryIds.has(tool.categoryId),
      `${tool.id} has a known category`,
    );
    assert.ok(tool.label.length >= 4, `${tool.id} has a readable label`);
    assert.ok(
      tool.description.length >= 20,
      `${tool.id} has a useful description`,
    );
  }
});

test("fresh defaults grant only read-only tools and every high-risk tier requires confirmation", () => {
  const expectedReadOnlyIds = MCP_TOOL_FALLBACKS.filter(
    ({ risk }) => risk === "read",
  ).map(({ id }) => id);
  assert.deepEqual(DEFAULT_MCP_ENABLED_TOOL_IDS, expectedReadOnlyIds);
  assert.ok(DEFAULT_MCP_ENABLED_TOOL_IDS.length > 0);

  for (const tool of MCP_TOOL_FALLBACKS) {
    const enabledByDefault = DEFAULT_MCP_ENABLED_TOOL_IDS.includes(tool.id);
    assert.equal(
      enabledByDefault,
      tool.risk === "read",
      `${tool.id} default matches its reviewed risk`,
    );
    assert.equal(
      requiresMcpPermissionConfirmation(tool.risk),
      tool.risk !== "read",
      `${tool.id} confirmation matches its reviewed risk`,
    );
  }

  for (const requiredTier of [
    "write",
    "bulk-sensitive",
    "destructive",
    "credential",
    "admin",
  ] as const) {
    assert.ok(
      MCP_TOOL_FALLBACKS.some(({ risk }) => risk === requiredTier),
      `${requiredTier} is represented in the registry`,
    );
  }
});

test("reconciliation preserves every current registry ID and reports unknown IDs fail-closed", () => {
  const reconciliation = reconcileMcpEnabledToolIdsDetailed([
    "future_unreviewed_tool",
    "",
    ...STABLE_MCP_TOOL_IDS.toReversed(),
    STABLE_MCP_TOOL_IDS[0],
    " another_unknown_tool ",
  ]);

  assert.deepEqual(reconciliation.enabledToolIds, STABLE_MCP_TOOL_IDS);
  assert.deepEqual(reconciliation.removedToolIds, [
    "future_unreviewed_tool",
    "another_unknown_tool",
  ]);
  assert.deepEqual(reconcileMcpEnabledToolIds(undefined), []);
});

test("all permission-change entry paths identify every newly enabled high-risk tool", () => {
  const readTool = MCP_TOOL_FALLBACKS.find(({ risk }) => risk === "read");
  const highRiskTools = MCP_TOOL_FALLBACKS.filter(
    ({ risk }) => risk !== "read",
  );
  assert.ok(readTool);

  const plan = planMcpPermissionChange(
    [highRiskTools[0].id],
    [
      "unknown_imported_tool",
      readTool.id,
      ...highRiskTools.map(({ id }) => id),
    ],
  );

  assert.deepEqual(plan.removedToolIds, ["unknown_imported_tool"]);
  assert.deepEqual(
    plan.newlyEnabledHighRiskToolIds,
    highRiskTools.slice(1).map(({ id }) => id),
  );
  assert.ok(plan.enabledToolIds.includes(highRiskTools[0].id));
});

test("MCP storage uses conservative defaults and preserves all legitimate migration IDs", () => {
  const freshStorage = new LocalStorageMock();
  const freshManager = new StorageManager(
    freshStorage,
    new CryptoManager({}, freshStorage),
  );

  assert.deepEqual(
    freshManager.getMcpEnabledTools(),
    DEFAULT_MCP_ENABLED_TOOL_IDS,
  );
  assert.deepEqual(freshManager.getMcpEnabledToolsSnapshot(), {
    enabledTools: DEFAULT_MCP_ENABLED_TOOL_IDS,
    removedToolIds: [],
    pendingHighRiskToolIds: [],
    configured: false,
  });

  const migratedStorage = new LocalStorageMock();
  migratedStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      apiKeys: [],
      mcpEnabledTools: [
        "legacy_removed_tool",
        ...STABLE_MCP_TOOL_IDS.toReversed(),
      ],
    }),
  );
  const migratedManager = new StorageManager(
    migratedStorage,
    new CryptoManager({}, migratedStorage),
  );

  assert.deepEqual(migratedManager.getMcpEnabledToolsSnapshot(), {
    enabledTools: STABLE_MCP_TOOL_IDS,
    removedToolIds: ["legacy_removed_tool"],
    pendingHighRiskToolIds: [],
    configured: true,
  });

  migratedManager.setMcpEnabledTools([...STABLE_MCP_TOOL_IDS]);
  assert.deepEqual(migratedManager.getMcpEnabledTools(), STABLE_MCP_TOOL_IDS);
  assert.deepEqual(
    JSON.parse(migratedStorage.getItem(STORAGE_KEY) ?? "{}").mcpEnabledTools,
    STABLE_MCP_TOOL_IDS,
  );

  migratedManager.setMcpEnabledTools([]);
  assert.deepEqual(migratedManager.getMcpEnabledTools(), []);
});

test("storage imports stage high-risk permissions for confirmation and retain unknown-ID diagnostics", () => {
  const storage = new LocalStorageMock();
  const manager = new StorageManager(storage, new CryptoManager({}, storage));

  manager.importData(
    JSON.stringify({
      apiKeys: [],
      mcpEnabledTools: [
        "cf_list_zones",
        "cf_create_dns_record",
        "cf_bulk_create_dns_records",
        "unknown_imported_tool",
      ],
    }),
  );

  assert.deepEqual(manager.getMcpEnabledToolsSnapshot(), {
    enabledTools: ["cf_list_zones"],
    removedToolIds: ["unknown_imported_tool"],
    pendingHighRiskToolIds: [
      "cf_create_dns_record",
      "cf_bulk_create_dns_records",
    ],
    configured: true,
  });
  assert.deepEqual(manager.getMcpEnabledTools(), ["cf_list_zones"]);
  const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
  assert.deepEqual(persisted.mcpEnabledTools, ["cf_list_zones"]);
  assert.deepEqual(persisted.mcpPendingHighRiskTools, [
    "cf_create_dns_record",
    "cf_bulk_create_dns_records",
  ]);
  assert.deepEqual(persisted.mcpRemovedImportedToolIds, [
    "unknown_imported_tool",
  ]);
});

test("profile storage preserves legitimate high-risk requests for the controlled confirmation path while denying unknown IDs", () => {
  const storage = new LocalStorageMock();
  const manager = new StorageManager(storage, new CryptoManager({}, storage));

  manager.setSessionSettingsProfile("production", {
    mcpEnabledTools: [
      "cf_list_zones",
      "cf_update_dnssec",
      "unknown_profile_tool",
    ],
  });

  assert.deepEqual(
    manager.getSessionSettingsProfile("production")?.mcpEnabledTools,
    ["cf_list_zones", "cf_update_dnssec"],
  );
});

test("staged permission persistence cannot smuggle read-only or unknown IDs into the high-risk confirmation path", () => {
  const storage = new LocalStorageMock();
  const manager = new StorageManager(storage, new CryptoManager({}, storage));

  manager.stageMcpEnabledTools(
    ["cf_list_zones", "unknown_enabled_tool"],
    ["cf_list_dns_records", "cf_create_dns_record", "unknown_pending_tool"],
    ["cf_get_dnssec", "unknown_diagnostic_tool"],
  );

  assert.deepEqual(manager.getMcpEnabledToolsSnapshot(), {
    enabledTools: ["cf_list_zones"],
    removedToolIds: [
      "unknown_enabled_tool",
      "unknown_pending_tool",
      "unknown_diagnostic_tool",
    ],
    pendingHighRiskToolIds: ["cf_create_dns_record"],
    configured: true,
  });
});

test("failed MCP persistence restores the storage manager's previous in-memory permission state", () => {
  const storage = new LocalStorageMock();
  const manager = new StorageManager(storage, new CryptoManager({}, storage));
  manager.setMcpEnabledTools(["cf_list_zones"]);
  storage.failWrites = true;

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.throws(
      () =>
        manager.stageMcpEnabledTools(
          ["cf_list_dns_records"],
          ["cf_create_dns_record"],
          ["unknown_tool"],
        ),
      /storage quota exceeded/,
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(manager.getMcpEnabledToolsSnapshot(), {
    enabledTools: ["cf_list_zones"],
    removedToolIds: [],
    pendingHighRiskToolIds: [],
    configured: true,
  });
});

test("an imported transient staging payload is ignored unless it is derived from an imported selection", () => {
  const storage = new LocalStorageMock();
  const manager = new StorageManager(storage, new CryptoManager({}, storage));

  manager.importData(
    JSON.stringify({
      apiKeys: [],
      mcpPendingHighRiskTools: ["cf_create_dns_record", "unknown_pending_tool"],
      mcpRemovedImportedToolIds: ["spoofed_diagnostic"],
    }),
  );

  assert.deepEqual(manager.getMcpEnabledToolsSnapshot(), {
    enabledTools: DEFAULT_MCP_ENABLED_TOOL_IDS,
    removedToolIds: [],
    pendingHighRiskToolIds: [],
    configured: false,
  });
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
