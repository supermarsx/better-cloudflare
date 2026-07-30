import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { DNSManager } from "../src/components/dns/DNSManager";
import {
  TauriClient,
  type McpServerStatus,
  type TauriDNSRecord,
  type TauriZone,
} from "../src/lib/api/tauri-client";
import type { DNSRecord } from "../src/types/dns";
import {
  getRuntimeDiagnostics,
  reportRuntimeError,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";
import { storageManager } from "../src/lib/storage/storage";
import { MCP_PERMISSION_POLICY_VERSION } from "../src/lib/mcp/tool-permissions";
import { RuntimeErrorListener } from "../src/components/layout/RuntimeErrorListener";
import { Toaster } from "../src/components/ui/toaster";

const {
  DNS_API_PAGE_SIZE_LIMIT,
  DNS_EXPORT_ESTIMATED_BYTE_LIMIT,
  DNS_EXPORT_RECORD_LIMIT,
  DNS_OPEN_ZONE_TAB_LIMIT,
  DNS_RECORD_MEMORY_LIMIT,
  DNS_RECORD_RENDER_LIMIT,
  DNS_TOPOLOGY_RECORD_LIMIT,
  DNS_TOPOLOGY_SCAN_PAGE_LIMIT,
  appendBoundedZoneTab,
  clampAutoRefreshInterval,
  clampDnsPageSize,
  createCompletionScheduledPoller,
  createRequestGenerationTracker,
  evictInactiveTabRecords,
  limitRestoredTabIds,
  loadAuthoritativeDnsRecordsForTopology,
  loadCompleteDnsRecordsForExport,
  retainDnsRecordsForUi,
} = DNSManager;

const originalWindow = (globalThis as { window?: unknown }).window;
const originalFetch = globalThis.fetch;

function setDesktopWindow(): void {
  const currentWindow = (globalThis as { window?: unknown }).window;
  if (currentWindow && typeof currentWindow === "object") {
    (currentWindow as { __TAURI__?: unknown }).__TAURI__ = {};
    return;
  }
  (globalThis as { window?: unknown }).window = { __TAURI__: {} };
}

function createMcpStatus(
  enabledTools: string[] = [],
  binding: {
    running?: boolean;
    host?: string;
    port?: number;
  } = {},
): McpServerStatus {
  const host = binding.host ?? "127.0.0.1";
  const port = binding.port ?? 8787;
  return {
    running: binding.running ?? false,
    host,
    port,
    url: `http://${host}:${port}/mcp`,
    enabledTools,
    tools: [
      {
        name: "dns_read",
        title: "Read DNS",
        description: "Read DNS records",
        enabled: enabledTools.includes("dns_read"),
      },
    ],
    lastError: null,
  };
}

function mockMcpPermissionStorage(
  enabledTools: string[],
  pendingHighRiskToolIds: string[] = [],
): void {
  mock.method(storageManager, "getMcpEnabledToolsSnapshot", () => ({
    enabledTools,
    removedToolIds: [],
    pendingHighRiskToolIds,
    configured: true,
    permissionPolicyVersion: MCP_PERMISSION_POLICY_VERSION,
  }));
  mock.method(storageManager, "setMcpEnabledTools", () => {});
  mock.method(storageManager, "stageMcpEnabledTools", () => {});
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockDnsRuntime(
  getPreferences: () => Promise<Record<string, unknown>>,
  setTools: (tools: string[]) => Promise<McpServerStatus> = async (tools) =>
    createMcpStatus(tools),
  overrides: {
    zones?: TauriZone[];
    getDNSRecords?: (
      apiKey: string,
      email: string | undefined,
      zoneId: string,
      page?: number,
      perPage?: number,
    ) => Promise<TauriDNSRecord[]>;
    getMcpServerStatus?: () => Promise<McpServerStatus>;
    startMcpServer?: (
      host: string,
      port: number,
      enabledTools: string[],
    ) => Promise<McpServerStatus>;
    stopMcpServer?: () => Promise<McpServerStatus>;
  } = {},
): void {
  mock.method(TauriClient, "getPreferences", getPreferences);
  mock.method(TauriClient, "updatePreferences", async () => {});
  mock.method(TauriClient, "getZones", async () => overrides.zones ?? []);
  mock.method(
    TauriClient,
    "getDNSRecords",
    overrides.getDNSRecords ?? (async () => []),
  );
  mock.method(TauriClient, "getAuditEntries", async () => []);
  mock.method(TauriClient, "setMcpEnabledTools", setTools);
  mock.method(
    TauriClient,
    "startMcpServer",
    overrides.startMcpServer ?? (async () => createMcpStatus()),
  );
  mock.method(
    TauriClient,
    "stopMcpServer",
    overrides.stopMcpServer ?? (async () => createMcpStatus()),
  );
  mock.method(
    TauriClient,
    "getMcpServerStatus",
    overrides.getMcpServerStatus ?? (async () => createMcpStatus()),
  );
  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

async function openMcpServerSettings(): Promise<{
  serverSwitch: HTMLElement;
  hostInput: HTMLInputElement;
  portInput: HTMLInputElement;
  applyButton: HTMLElement;
}> {
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  fireEvent.click(await screen.findByRole("button", { name: "MCP" }));

  const serverSetting = await screen.findByText("Enable MCP server");
  const serverSettingRow = serverSetting.parentElement;
  assert.ok(serverSettingRow);
  const bindingSetting = await screen.findByText("Bind host");
  const bindingSettingRow = bindingSetting.parentElement;
  assert.ok(bindingSettingRow);

  return {
    serverSwitch: within(serverSettingRow).getByRole("switch", {
      hidden: true,
    }),
    hostInput: within(bindingSettingRow).getByRole("textbox", {
      hidden: true,
    }) as HTMLInputElement,
    portInput: within(bindingSettingRow).getByRole("spinbutton", {
      hidden: true,
    }) as HTMLInputElement,
    applyButton: within(bindingSettingRow).getByRole("button", {
      name: "Apply + restart",
      hidden: true,
    }),
  };
}

afterEach(() => {
  cleanup();
  mock.restoreAll();
  resetRuntimeReportingForTests();
  if (originalWindow && typeof originalWindow === "object") {
    delete (originalWindow as { __TAURI__?: unknown }).__TAURI__;
  }
  (globalThis as { window?: unknown }).window = originalWindow;
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
});

function dnsRecord(index: number): DNSRecord {
  const timestamp = new Date(index * 1000).toISOString();
  return {
    id: `record-${index}`,
    type: "A",
    name: `host-${index}.example.com`,
    content: `192.0.2.${index % 255}`,
    ttl: 300,
    proxied: false,
    zone_id: "large-zone",
    zone_name: "example.com",
    created_on: timestamp,
    modified_on: timestamp,
  };
}

function zoneTab(
  index: number,
  records: DNSRecord[] = [],
): Parameters<typeof appendBoundedZoneTab>[0][number] {
  return {
    kind: "zone",
    id: `zone-${index}`,
    zoneId: `zone-${index}`,
    zoneName: `zone-${index}.example.com`,
    records,
    recordsLimited: false,
    sourceRecordCount: records.length,
    isLoading: false,
    editingRecord: null,
    searchTerm: "",
    typeFilter: "",
    page: 1,
    perPage: 50,
    sortKey: null,
    sortDir: null,
    selectedIds: [],
    showAddRecord: false,
    showImport: false,
    newRecord: {},
    importData: "",
    importFormat: "json",
  };
}

test("bounds DNS retention and page sizes at exact deterministic limits", () => {
  const records = Array.from(
    { length: DNS_RECORD_MEMORY_LIMIT + 1 },
    (_, index) => dnsRecord(index),
  );
  const retained = retainDnsRecordsForUi(records);

  assert.equal(retained.records.length, DNS_RECORD_MEMORY_LIMIT);
  assert.equal(retained.sourceRecordCount, DNS_RECORD_MEMORY_LIMIT + 1);
  assert.equal(retained.limited, true);
  assert.equal(retained.records[0], records[0]);
  assert.equal(retained.records.at(-1), records[DNS_RECORD_MEMORY_LIMIT - 1]);
  assert.equal(records.length, DNS_RECORD_MEMORY_LIMIT + 1);

  assert.equal(clampDnsPageSize(0), 0);
  assert.equal(clampDnsPageSize(1), 25);
  assert.equal(clampDnsPageSize(DNS_API_PAGE_SIZE_LIMIT + 1), 500);
  assert.equal(clampDnsPageSize(Number.NaN), 50);
});

test("walks every authoritative DNS page for export and aborts without returning a partial set", async () => {
  const records = Array.from(
    { length: DNS_RECORD_MEMORY_LIMIT + 1 },
    (_, index) => dnsRecord(index),
  );
  const pages: number[] = [];
  const complete = await loadCompleteDnsRecordsForExport(
    async (_zoneId, page, perPage) => {
      pages.push(page);
      const start = (page - 1) * perPage;
      return records.slice(start, start + perPage);
    },
    "large-zone",
  );

  assert.equal(complete.length, DNS_RECORD_MEMORY_LIMIT + 1);
  assert.equal(complete.at(-1)?.id, `record-${DNS_RECORD_MEMORY_LIMIT}`);
  assert.deepEqual(
    pages,
    Array.from(
      { length: Math.ceil(records.length / DNS_API_PAGE_SIZE_LIMIT) },
      (_, index) => index + 1,
    ),
  );

  const controller = new AbortController();
  await assert.rejects(
    () =>
      loadCompleteDnsRecordsForExport(
        async () => {
          controller.abort();
          return records.slice(0, DNS_API_PAGE_SIZE_LIMIT);
        },
        "large-zone",
        controller.signal,
      ),
    (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, "AbortError");
      return true;
    },
  );
});

test("refuses DNS exports before aggregate record or estimated-byte limits are exceeded", async () => {
  let requestedPages = 0;
  const minimalRecord: DNSRecord = {
    id: "",
    type: "A",
    name: "",
    content: "",
    ttl: 1,
    proxied: false,
    zone_id: "",
    zone_name: "",
    created_on: "",
    modified_on: "",
  };
  await assert.rejects(
    () =>
      loadCompleteDnsRecordsForExport(async () => {
        requestedPages += 1;
        return Array.from(
          { length: DNS_API_PAGE_SIZE_LIMIT },
          () => minimalRecord,
        );
      }, "too-large-zone"),
    new RegExp(DNS_EXPORT_RECORD_LIMIT.toLocaleString()),
  );
  assert.equal(
    requestedPages,
    DNS_EXPORT_RECORD_LIMIT / DNS_API_PAGE_SIZE_LIMIT + 1,
  );

  const oversizedRecord = {
    ...dnsRecord(1),
    content: "x".repeat(Math.ceil(DNS_EXPORT_ESTIMATED_BYTE_LIMIT / 6) + 1),
  };
  await assert.rejects(
    () =>
      loadCompleteDnsRecordsForExport(
        async () => [oversizedRecord],
        "oversized-content-zone",
      ),
    /estimated output safety limit/i,
  );
});

test("clamps restored refresh settings and caps excessive restored zone tabs", () => {
  assert.equal(clampAutoRefreshInterval(null), null);
  assert.equal(clampAutoRefreshInterval(Number.NaN), null);
  assert.equal(clampAutoRefreshInterval(1), 60_000);
  assert.equal(clampAutoRefreshInterval(60 * 60_000), 30 * 60_000);

  const restored = limitRestoredTabIds([
    "__settings",
    ...Array.from(
      { length: DNS_OPEN_ZONE_TAB_LIMIT + 5 },
      (_, index) => `zone-${index}`,
    ),
    "zone-0",
    "",
    null,
  ]);
  assert.deepEqual(restored.slice(0, 2), ["__settings", "zone-0"]);
  assert.equal(
    restored.filter((tabId) => !tabId.startsWith("__")).length,
    DNS_OPEN_ZONE_TAB_LIMIT,
  );
  assert.equal(new Set(restored).size, restored.length);

  const openTabs = Array.from({ length: DNS_OPEN_ZONE_TAB_LIMIT }, (_, index) =>
    zoneTab(index),
  );
  const bounded = appendBoundedZoneTab(
    openTabs,
    zoneTab(DNS_OPEN_ZONE_TAB_LIMIT),
    "zone-0",
  );
  assert.equal(bounded.tabs.length, DNS_OPEN_ZONE_TAB_LIMIT);
  assert.ok(bounded.tabs.some((tab) => tab.id === "zone-0"));
  assert.ok(
    bounded.tabs.some((tab) => tab.id === `zone-${DNS_OPEN_ZONE_TAB_LIMIT}`),
  );

  const dirtyFirst = {
    ...zoneTab(0),
    showImport: true,
    importData:
      '[{"type":"A","name":"draft.example.com","content":"192.0.2.1"}]',
  };
  const withDirtyTab = appendBoundedZoneTab(
    [
      dirtyFirst,
      ...Array.from({ length: DNS_OPEN_ZONE_TAB_LIMIT - 1 }, (_, index) =>
        zoneTab(index + 1),
      ),
    ],
    zoneTab(DNS_OPEN_ZONE_TAB_LIMIT),
    `zone-${DNS_OPEN_ZONE_TAB_LIMIT - 1}`,
  );
  assert.ok(
    withDirtyTab.tabs.some(
      (tab) =>
        tab.id === dirtyFirst.id && tab.importData === dirtyFirst.importData,
    ),
    "a tab with an unsubmitted import draft must never be evicted",
  );
  assert.equal(withDirtyTab.evictedTabId, "zone-1");

  const largeRecords = Array.from({ length: 1_000 }, (_, index) =>
    dnsRecord(index),
  );
  const evicted = evictInactiveTabRecords(
    [zoneTab(0, largeRecords), zoneTab(1, largeRecords)],
    "zone-0",
  );
  assert.equal(evicted[0]?.records.length, largeRecords.length);
  assert.equal(evicted[1]?.records.length, 0);
});

test("completion-scheduled refresh remains single-flight and cleanup prevents another call", async () => {
  const gate = deferred<void>();
  let calls = 0;
  const dispose = createCompletionScheduledPoller(async () => {
    calls += 1;
    await gate.promise;
  }, 5);

  const deadline = Date.now() + 500;
  while (calls === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "an unresolved refresh cannot overlap itself");

  dispose();
  gate.resolve(undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "cleanup suppresses completion rescheduling");
});

test("record request generations reject reverse stale completions", () => {
  const generations = createRequestGenerationTracker();
  const older = generations.begin("zone-id");
  const newer = generations.begin("zone-id");
  assert.equal(generations.isCurrent("zone-id", older), false);
  assert.equal(generations.isCurrent("zone-id", newer), true);
  generations.invalidate("zone-id");
  assert.equal(generations.isCurrent("zone-id", newer), false);
});

test("renders at most 200 rows for an exact 5,000-record UI dataset", async () => {
  setDesktopWindow();
  const records = Array.from(
    { length: DNS_RECORD_MEMORY_LIMIT },
    (_, index) => dnsRecord(index) as TauriDNSRecord,
  );
  const requestedPages: number[] = [];
  mockDnsRuntime(
    async () => ({
      last_zone: "large-zone",
      default_per_page: 0,
    }),
    async (tools) => createMcpStatus(tools),
    {
      zones: [
        {
          id: "large-zone",
          name: "example.com",
          status: "active",
          paused: false,
          type: "full",
          development_mode: 0,
        },
      ],
      getDNSRecords: async (
        _apiKey,
        _email,
        _zoneId,
        page = 1,
        perPage = DNS_API_PAGE_SIZE_LIMIT,
      ) => {
        requestedPages.push(page);
        const start = (page - 1) * perPage;
        return records.slice(start, start + perPage);
      },
    },
  );

  const view = render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  const notice = await screen.findByTestId("dns-record-limit-notice");
  assert.match(notice.textContent ?? "", /retained 5000 source records/i);
  assert.match(notice.textContent ?? "", /first 200 of 5000 matching rows/i);
  await waitFor(() =>
    assert.equal(
      view.container.querySelectorAll(".ui-table-row").length,
      DNS_RECORD_RENDER_LIMIT,
    ),
  );
  assert.deepEqual(
    Array.from(new Set(requestedPages)),
    Array.from({ length: 11 }, (_, index) => index + 1),
  );
  assert.ok(
    requestedPages.filter((page) => page === 1).length <= 2,
    "React development effect replay may restart only the first page",
  );
});

test("DNSManager passes an exact 10,000-record authoritative set to topology independently of the table", async () => {
  setDesktopWindow();
  const records = Array.from(
    { length: DNS_TOPOLOGY_RECORD_LIMIT },
    (_, index) => dnsRecord(index) as TauriDNSRecord,
  );
  const requestedPages: number[] = [];
  mockDnsRuntime(
    async () => ({
      last_zone: "large-zone",
      default_per_page: 50,
    }),
    async (tools) => createMcpStatus(tools),
    {
      zones: [
        {
          id: "large-zone",
          name: "example.com",
          status: "active",
          paused: false,
          type: "full",
          development_mode: 0,
        },
      ],
      getDNSRecords: async (
        _apiKey,
        _email,
        _zoneId,
        page = 1,
        perPage = DNS_API_PAGE_SIZE_LIMIT,
      ) => {
        requestedPages.push(page);
        const start = (page - 1) * perPage;
        return records.slice(start, start + perPage);
      },
    },
  );

  const view = render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await waitFor(() =>
    assert.equal(view.container.querySelectorAll(".ui-table-row").length, 50),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Topology" }));

  await waitFor(
    () =>
      assert.match(
        screen.getByTestId("topology-model-count").textContent ?? "",
        /all 10000 matching nodes/i,
      ),
    { timeout: 10_000 },
  );
  assert.equal(
    view.container.querySelectorAll('[data-testid="topology-graph-node"]')
      .length,
    80,
  );
  assert.equal(view.container.querySelectorAll(".ui-table-row").length, 0);
  assert.deepEqual(
    Array.from(new Set(requestedPages)),
    Array.from({ length: 21 }, (_, index) => index + 1),
  );
});

test("DNSManager refuses a 10,001-record topology without passing a truncated graph", async () => {
  setDesktopWindow();
  const records = Array.from(
    { length: DNS_TOPOLOGY_RECORD_LIMIT + 1 },
    (_, index) => dnsRecord(index) as TauriDNSRecord,
  );
  const requestedPages: number[] = [];
  mockDnsRuntime(
    async () => ({
      last_zone: "large-zone",
      default_per_page: 50,
    }),
    async (tools) => createMcpStatus(tools),
    {
      zones: [
        {
          id: "large-zone",
          name: "example.com",
          status: "active",
          paused: false,
          type: "full",
          development_mode: 0,
        },
      ],
      getDNSRecords: async (
        _apiKey,
        _email,
        _zoneId,
        page = 1,
        perPage = DNS_API_PAGE_SIZE_LIMIT,
      ) => {
        requestedPages.push(page);
        const start = (page - 1) * perPage;
        return records.slice(start, start + perPage);
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Topology" }));

  const refusal = await screen.findByTestId("dns-topology-record-limit");
  assert.match(refusal.textContent ?? "", /more than 10,000 authoritative/i);
  assert.match(refusal.textContent ?? "", /no graph was constructed/i);
  assert.ok(screen.getByRole("button", { name: "Narrow in Records" }));
  assert.equal(screen.queryByTestId("topology-model-count"), null);
  assert.deepEqual(
    Array.from(new Set(requestedPages)),
    Array.from({ length: 21 }, (_, index) => index + 1),
  );

  fireEvent.click(screen.getByRole("button", { name: "Narrow in Records" }));
  fireEvent.change(screen.getByPlaceholderText("Search records"), {
    target: { value: "host-1" },
  });
  requestedPages.length = 0;
  fireEvent.click(screen.getByRole("button", { name: "Topology" }));

  await waitFor(
    () => {
      assert.match(
        screen.getByTestId("dns-topology-source-filter-notice").textContent ??
          "",
        /all 1112 matching records were retained after scanning 10001 source records/i,
      );
      assert.match(
        screen.getByTestId("topology-model-count").textContent ?? "",
        /all 1112 matching nodes/i,
      );
    },
    { timeout: 10_000 },
  );
  assert.deepEqual(
    Array.from(new Set(requestedPages)),
    Array.from({ length: 21 }, (_, index) => index + 1),
  );
});

test("authoritative topology loading aborts and never returns a partial retained set", async () => {
  const controller = new AbortController();
  await assert.rejects(
    () =>
      loadAuthoritativeDnsRecordsForTopology(
        async () => {
          controller.abort();
          return Array.from({ length: DNS_API_PAGE_SIZE_LIMIT }, (_, index) =>
            dnsRecord(index),
          );
        },
        "large-zone",
        { searchTerm: "", typeFilter: "" },
        controller.signal,
      ),
    (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, "AbortError");
      return true;
    },
  );
});

test("authoritative topology loading stops at its deterministic page scan bound", async () => {
  const batch = Array.from({ length: DNS_API_PAGE_SIZE_LIMIT }, (_, index) =>
    dnsRecord(index),
  );
  let requestedPages = 0;
  const result = await loadAuthoritativeDnsRecordsForTopology(
    async () => {
      requestedPages += 1;
      return batch;
    },
    "large-zone",
    { searchTerm: "does-not-match", typeFilter: "" },
  );

  assert.equal(result.status, "scan-limited");
  assert.equal(requestedPages, DNS_TOPOLOGY_SCAN_PAGE_LIMIT);
  assert.equal(result.records.length, 0);
  assert.equal(
    result.scannedRecordCount,
    DNS_TOPOLOGY_SCAN_PAGE_LIMIT * DNS_API_PAGE_SIZE_LIMIT,
  );
});

test("rejected desktop DNS preferences are reported without destroying the manager", async () => {
  setDesktopWindow();
  mockDnsRuntime(async () => {
    throw new Error("preferences failed token=desktop-secret");
  });

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  await waitFor(() => {
    assert.ok(
      getRuntimeDiagnostics().some((diagnostic) =>
        diagnostic.label?.includes("Load desktop DNS preferences"),
      ),
    );
  });
  assert.ok(screen.getByRole("button", { name: "Settings" }));
  assert.doesNotMatch(
    getRuntimeDiagnostics()
      .map((diagnostic) => diagnostic.message)
      .join("\n"),
    /desktop-secret/,
  );
});

test("login-time MCP synchronization is contained to one apply and one bounded rollback", async () => {
  setDesktopWindow();
  let attempts = 0;
  let serverStopAttempts = 0;
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: false,
      mcp_enabled_tools: ["dns_read"],
    }),
    async () => {
      attempts += 1;
      throw new Error(
        "invalid args `enabledTools` for command `mcp_set_enabled_tools` token=bootstrap-secret",
      );
    },
    {
      stopMcpServer: async () => {
        serverStopAttempts += 1;
        return createMcpStatus();
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  await waitFor(() => {
    assert.ok(
      getRuntimeDiagnostics().some(
        (diagnostic) =>
          diagnostic.label === "Synchronize MCP server preferences",
      ),
    );
  });
  assert.equal(attempts, 2);
  const synchronizationDiagnostics = getRuntimeDiagnostics().filter(
    (diagnostic) => diagnostic.label === "Synchronize MCP server preferences",
  );
  assert.equal(synchronizationDiagnostics.length, 1);
  assert.match(synchronizationDiagnostics[0].message, /token=\[redacted\]/);
  assert.doesNotMatch(
    synchronizationDiagnostics[0].message,
    /bootstrap-secret/,
  );
  assert.equal(serverStopAttempts, 0);
  assert.ok(screen.getByRole("button", { name: "Settings" }));
});

test("MCP command-count 1/8: initial hydrated off-view synchronization invokes exactly one lifecycle command", async () => {
  setDesktopWindow();
  const statusLoad = deferred<McpServerStatus>();
  const setToolCalls: string[][] = [];
  const startCalls: string[][] = [];
  let statusLoadCalls = 0;

  mock.method(storageManager, "getMcpEnabledToolsSnapshot", () => {
    return {
      enabledTools: ["cf_list_zones"],
      removedToolIds: [],
      pendingHighRiskToolIds: ["cf_create_dns_record"],
      configured: true,
      permissionPolicyVersion: MCP_PERMISSION_POLICY_VERSION,
    };
  });
  mock.method(storageManager, "setMcpEnabledTools", () => {});
  mock.method(storageManager, "stageMcpEnabledTools", () => {});
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: true,
      mcp_enabled_tools: [],
    }),
    async (tools) => {
      setToolCalls.push([...tools]);
      return createMcpStatus(tools);
    },
    {
      getMcpServerStatus: () => {
        statusLoadCalls += 1;
        return statusLoad.promise;
      },
      startMcpServer: async (_host, _port, enabledTools) => {
        startCalls.push([...enabledTools]);
        return createMcpStatus(enabledTools);
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  await waitFor(() => assert.equal(statusLoadCalls, 1));
  statusLoad.resolve(createMcpStatus(["cf_list_zones"]));
  await waitFor(() => {
    assert.deepEqual(setToolCalls, [["cf_list_zones"]]);
    assert.deepEqual(startCalls, [["cf_list_zones"]]);
  });

  const parking = screen.getByTestId("mcp-permissions-parking");
  assert.equal(parking.hidden, true);
  assert.ok(
    parking.querySelector('[data-mcp-permissions-mount="true"]'),
    "the single MCP permission instance remains mounted in the hidden parking host",
  );
  assert.equal(within(parking).queryByRole("alertdialog"), null);
  assert.equal(
    within(parking).queryByRole("heading", {
      name: "MCP tool permissions",
    }),
    null,
  );

  const applicationControls = document.querySelector<HTMLElement>(
    '[role="toolbar"][aria-label="Global application controls"]',
  );
  assert.ok(applicationControls);
  fireEvent.click(
    within(applicationControls).getByRole("button", { name: "Settings" }),
  );
  const settingsSections = await waitFor(() => {
    const toolbar = document.querySelector<HTMLElement>(
      '[role="toolbar"][aria-label="Session settings sections"]',
    );
    assert.ok(toolbar);
    return toolbar;
  });
  fireEvent.click(
    within(settingsSections).getByRole("button", { name: "MCP" }),
  );

  const modalBackdrop = await waitFor(() => {
    const backdrop = document.querySelector<HTMLElement>(
      '[data-testid="mcp-permission-modal-backdrop"]',
    );
    assert.ok(backdrop);
    return backdrop;
  });
  const confirmation = within(modalBackdrop).getByRole("alertdialog");
  assert.ok(within(confirmation).getByText(/Create DNS record/));
  assert.deepEqual(setToolCalls, [["cf_list_zones"]]);
  assert.deepEqual(startCalls, [["cf_list_zones"]]);
});

test("MCP command-count 2/8: manual switch start invokes start exactly once without background replay", async () => {
  setDesktopWindow();
  const confirmedTools = ["cf_list_zones"];
  const configuredHost = "127.0.0.2";
  const configuredPort = 8811;
  const startCalls: Array<{
    host: string;
    port: number;
    enabledTools: string[];
  }> = [];
  let stopCalls = 0;
  const stoppedStatus = createMcpStatus(confirmedTools, {
    running: false,
    host: configuredHost,
    port: configuredPort,
  });

  mockMcpPermissionStorage(confirmedTools);
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: false,
      mcp_server_host: configuredHost,
      mcp_server_port: configuredPort,
      mcp_enabled_tools: confirmedTools,
    }),
    async (tools) =>
      createMcpStatus(tools, {
        running: false,
        host: configuredHost,
        port: configuredPort,
      }),
    {
      getMcpServerStatus: async () => stoppedStatus,
      startMcpServer: async (host, port, enabledTools) => {
        startCalls.push({ host, port, enabledTools: [...enabledTools] });
        return createMcpStatus(enabledTools, { running: true, host, port });
      },
      stopMcpServer: async () => {
        stopCalls += 1;
        return stoppedStatus;
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await waitFor(() => assert.equal(stopCalls, 1));

  const { serverSwitch } = await openMcpServerSettings();
  await waitFor(() =>
    assert.equal(serverSwitch.hasAttribute("disabled"), false),
  );
  assert.equal(serverSwitch.getAttribute("aria-checked"), "false");
  fireEvent.click(serverSwitch);

  await waitFor(() => {
    assert.equal(startCalls.length, 1);
    assert.equal(serverSwitch.getAttribute("aria-checked"), "true");
  });
  await act(async () => {
    await Promise.resolve();
  });

  assert.deepEqual(startCalls, [
    {
      host: configuredHost,
      port: configuredPort,
      enabledTools: confirmedTools,
    },
  ]);
  assert.equal(stopCalls, 1);
});

test("MCP command-count 3/8: manual switch stop invokes stop exactly once without background replay", async () => {
  setDesktopWindow();
  const confirmedTools = ["cf_list_zones"];
  const configuredHost = "127.0.0.3";
  const configuredPort = 8812;
  const startCalls: Array<{
    host: string;
    port: number;
    enabledTools: string[];
  }> = [];
  let stopCalls = 0;
  const runningStatus = createMcpStatus(confirmedTools, {
    running: true,
    host: configuredHost,
    port: configuredPort,
  });

  mockMcpPermissionStorage(confirmedTools);
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: true,
      mcp_server_host: configuredHost,
      mcp_server_port: configuredPort,
      mcp_enabled_tools: confirmedTools,
    }),
    async (tools) =>
      createMcpStatus(tools, {
        running: true,
        host: configuredHost,
        port: configuredPort,
      }),
    {
      getMcpServerStatus: async () => runningStatus,
      startMcpServer: async (host, port, enabledTools) => {
        startCalls.push({ host, port, enabledTools: [...enabledTools] });
        return createMcpStatus(enabledTools, { running: true, host, port });
      },
      stopMcpServer: async () => {
        stopCalls += 1;
        return createMcpStatus(confirmedTools, {
          running: false,
          host: configuredHost,
          port: configuredPort,
        });
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await waitFor(() => assert.equal(startCalls.length, 1));

  const { serverSwitch } = await openMcpServerSettings();
  await waitFor(() =>
    assert.equal(serverSwitch.hasAttribute("disabled"), false),
  );
  assert.equal(serverSwitch.getAttribute("aria-checked"), "true");
  fireEvent.click(serverSwitch);

  await waitFor(() => {
    assert.equal(stopCalls, 1);
    assert.equal(serverSwitch.getAttribute("aria-checked"), "false");
  });
  await act(async () => {
    await Promise.resolve();
  });

  assert.equal(startCalls.length, 1);
  assert.equal(stopCalls, 1);
});

test("MCP command-count 4/8: editing the draft host invokes zero lifecycle commands before Apply", async () => {
  setDesktopWindow();
  const confirmedTools = ["cf_list_zones"];
  const configuredHost = "127.0.0.4";
  const configuredPort = 8813;
  const lifecycleCalls: string[] = [];
  const runningStatus = createMcpStatus(confirmedTools, {
    running: true,
    host: configuredHost,
    port: configuredPort,
  });

  mockMcpPermissionStorage(confirmedTools);
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: true,
      mcp_server_host: configuredHost,
      mcp_server_port: configuredPort,
      mcp_enabled_tools: confirmedTools,
    }),
    async (tools) =>
      createMcpStatus(tools, {
        running: true,
        host: configuredHost,
        port: configuredPort,
      }),
    {
      getMcpServerStatus: async () => runningStatus,
      startMcpServer: async (host, port, enabledTools) => {
        lifecycleCalls.push(`start:${host}:${port}`);
        return createMcpStatus(enabledTools, { running: true, host, port });
      },
      stopMcpServer: async () => {
        lifecycleCalls.push("stop");
        return runningStatus;
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await waitFor(() => assert.equal(lifecycleCalls.length, 1));
  const { hostInput } = await openMcpServerSettings();
  await waitFor(() => assert.equal(hostInput.hasAttribute("disabled"), false));
  lifecycleCalls.length = 0;

  fireEvent.change(hostInput, { target: { value: "192.0.2.40" } });
  await act(async () => {
    await Promise.resolve();
  });

  assert.equal(hostInput.value, "192.0.2.40");
  assert.deepEqual(lifecycleCalls, []);
});

test("MCP command-count 5/8: editing the draft port invokes zero lifecycle commands before Apply", async () => {
  setDesktopWindow();
  const confirmedTools = ["cf_list_zones"];
  const configuredHost = "127.0.0.5";
  const configuredPort = 8814;
  const lifecycleCalls: string[] = [];
  const runningStatus = createMcpStatus(confirmedTools, {
    running: true,
    host: configuredHost,
    port: configuredPort,
  });

  mockMcpPermissionStorage(confirmedTools);
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: true,
      mcp_server_host: configuredHost,
      mcp_server_port: configuredPort,
      mcp_enabled_tools: confirmedTools,
    }),
    async (tools) =>
      createMcpStatus(tools, {
        running: true,
        host: configuredHost,
        port: configuredPort,
      }),
    {
      getMcpServerStatus: async () => runningStatus,
      startMcpServer: async (host, port, enabledTools) => {
        lifecycleCalls.push(`start:${host}:${port}`);
        return createMcpStatus(enabledTools, { running: true, host, port });
      },
      stopMcpServer: async () => {
        lifecycleCalls.push("stop");
        return runningStatus;
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await waitFor(() => assert.equal(lifecycleCalls.length, 1));
  const { portInput } = await openMcpServerSettings();
  await waitFor(() => assert.equal(portInput.hasAttribute("disabled"), false));
  lifecycleCalls.length = 0;

  fireEvent.change(portInput, { target: { value: "18814" } });
  await act(async () => {
    await Promise.resolve();
  });

  assert.equal(portInput.value, "18814");
  assert.deepEqual(lifecycleCalls, []);
});

test("MCP command-count 6/8: Apply and restart invokes one start with the final draft binding", async () => {
  setDesktopWindow();
  const confirmedTools = ["cf_list_zones"];
  const configuredHost = "127.0.0.6";
  const configuredPort = 8815;
  const startCalls: Array<{
    host: string;
    port: number;
    enabledTools: string[];
  }> = [];
  const runningStatus = createMcpStatus(confirmedTools, {
    running: true,
    host: configuredHost,
    port: configuredPort,
  });

  mockMcpPermissionStorage(confirmedTools);
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: true,
      mcp_server_host: configuredHost,
      mcp_server_port: configuredPort,
      mcp_enabled_tools: confirmedTools,
    }),
    async (tools) =>
      createMcpStatus(tools, {
        running: true,
        host: configuredHost,
        port: configuredPort,
      }),
    {
      getMcpServerStatus: async () => runningStatus,
      startMcpServer: async (host, port, enabledTools) => {
        startCalls.push({ host, port, enabledTools: [...enabledTools] });
        return createMcpStatus(enabledTools, { running: true, host, port });
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await waitFor(() => assert.equal(startCalls.length, 1));
  const { hostInput, portInput, applyButton } = await openMcpServerSettings();
  await waitFor(() =>
    assert.equal(applyButton.hasAttribute("disabled"), false),
  );
  startCalls.length = 0;

  fireEvent.change(hostInput, { target: { value: "192.0.2.60" } });
  fireEvent.change(portInput, { target: { value: "18815" } });
  assert.deepEqual(startCalls, []);
  fireEvent.click(applyButton);

  await waitFor(() => assert.equal(startCalls.length, 1));
  await act(async () => {
    await Promise.resolve();
  });
  assert.deepEqual(startCalls, [
    {
      host: "192.0.2.60",
      port: 18815,
      enabledTools: confirmedTools,
    },
  ]);
});

test("MCP command-count 7/8: changed permissions serialize one resynchronization from authoritative applied binding", async () => {
  setDesktopWindow();
  const configuredHost = "127.0.0.7";
  const configuredPort = 8816;
  const authoritativeHost = "127.0.0.77";
  const authoritativePort = 18777;
  const permissionApplication = deferred<McpServerStatus>();
  const setToolCalls: string[][] = [];
  const startCalls: Array<{
    host: string;
    port: number;
    enabledTools: string[];
  }> = [];
  const authoritativeEmptyStatus = createMcpStatus([], {
    running: true,
    host: authoritativeHost,
    port: authoritativePort,
  });

  mockMcpPermissionStorage([]);
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: true,
      mcp_server_host: configuredHost,
      mcp_server_port: configuredPort,
      mcp_enabled_tools: [],
    }),
    async (tools) => {
      setToolCalls.push([...tools]);
      if (setToolCalls.length === 1) {
        return authoritativeEmptyStatus;
      }
      return permissionApplication.promise;
    },
    {
      getMcpServerStatus: async () => authoritativeEmptyStatus,
      startMcpServer: async (host, port, enabledTools) => {
        startCalls.push({ host, port, enabledTools: [...enabledTools] });
        return createMcpStatus(enabledTools, { running: true, host, port });
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await waitFor(() => assert.equal(startCalls.length, 1));
  assert.deepEqual(startCalls[0], {
    host: configuredHost,
    port: configuredPort,
    enabledTools: [],
  });

  const { hostInput, portInput } = await openMcpServerSettings();
  fireEvent.change(hostInput, { target: { value: "192.0.2.77" } });
  fireEvent.change(portInput, { target: { value: "28777" } });
  startCalls.length = 0;

  const accessGroup = await screen.findByRole("group", {
    name: /Access and zones/,
  });
  fireEvent.click(
    within(accessGroup).getByRole("button", { name: "Select visible" }),
  );
  await waitFor(() => assert.equal(setToolCalls.length, 2));
  assert.deepEqual(setToolCalls[1], ["cf_list_zones"]);
  assert.deepEqual(
    startCalls,
    [],
    "lifecycle synchronization must wait for authoritative permission status",
  );

  permissionApplication.resolve(
    createMcpStatus(["cf_list_zones"], {
      running: true,
      host: authoritativeHost,
      port: authoritativePort,
    }),
  );
  await waitFor(() => assert.equal(startCalls.length, 1));
  assert.deepEqual(startCalls, [
    {
      host: authoritativeHost,
      port: authoritativePort,
      enabledTools: ["cf_list_zones"],
    },
  ]);
});

test("MCP command-count 8/8: equal final cancel settlement adds no command while manual start completes", async () => {
  setDesktopWindow();
  const confirmedTools = ["cf_list_zones"];
  const configuredHost = "127.0.0.8";
  const configuredPort = 8817;
  const manualStart = deferred<McpServerStatus>();
  const startCalls: Array<{
    host: string;
    port: number;
    enabledTools: string[];
  }> = [];
  let stopCalls = 0;
  let activeLifecycleCommands = 0;
  let peakActiveLifecycleCommands = 0;
  const stoppedStatus = createMcpStatus(confirmedTools, {
    running: false,
    host: configuredHost,
    port: configuredPort,
  });

  mockMcpPermissionStorage(confirmedTools, ["cf_create_dns_record"]);
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: false,
      mcp_server_host: configuredHost,
      mcp_server_port: configuredPort,
      mcp_enabled_tools: [],
    }),
    async (tools) =>
      createMcpStatus(tools, {
        running: false,
        host: configuredHost,
        port: configuredPort,
      }),
    {
      getMcpServerStatus: async () => stoppedStatus,
      startMcpServer: (host, port, enabledTools) => {
        startCalls.push({ host, port, enabledTools: [...enabledTools] });
        activeLifecycleCommands += 1;
        peakActiveLifecycleCommands = Math.max(
          peakActiveLifecycleCommands,
          activeLifecycleCommands,
        );
        return manualStart.promise.finally(() => {
          activeLifecycleCommands -= 1;
        });
      },
      stopMcpServer: async () => {
        stopCalls += 1;
        activeLifecycleCommands += 1;
        peakActiveLifecycleCommands = Math.max(
          peakActiveLifecycleCommands,
          activeLifecycleCommands,
        );
        activeLifecycleCommands -= 1;
        return stoppedStatus;
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await waitFor(() => assert.equal(stopCalls, 1));
  const { serverSwitch } = await openMcpServerSettings();
  const confirmation = await screen.findByRole("alertdialog");
  assert.ok(within(confirmation).getByText(/Create DNS record/));

  fireEvent.click(serverSwitch);
  await waitFor(() => assert.equal(startCalls.length, 1));
  assert.equal(activeLifecycleCommands, 1);
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
  assert.equal(startCalls.length, 1);

  manualStart.resolve(
    createMcpStatus(confirmedTools, {
      running: true,
      host: configuredHost,
      port: configuredPort,
    }),
  );
  await waitFor(() => {
    assert.equal(activeLifecycleCommands, 0);
    assert.equal(serverSwitch.getAttribute("aria-checked"), "true");
  });
  await act(async () => {
    await Promise.resolve();
  });

  assert.deepEqual(startCalls, [
    {
      host: configuredHost,
      port: configuredPort,
      enabledTools: confirmedTools,
    },
  ]);
  assert.equal(stopCalls, 1);
  assert.equal(peakActiveLifecycleCommands, 1);
});

test("an equal hydrated session profile preserves MCP readiness after reconciliation", async () => {
  setDesktopWindow();
  const preferences = deferred<Record<string, unknown>>();
  const setToolCalls: string[][] = [];
  let stopCalls = 0;
  const currentSessionId = storageManager.getCurrentSession() ?? "__default";

  mock.method(storageManager, "getMcpEnabledToolsSnapshot", () => ({
    enabledTools: ["cf_list_zones"],
    removedToolIds: [],
    pendingHighRiskToolIds: [],
    configured: true,
    permissionPolicyVersion: MCP_PERMISSION_POLICY_VERSION,
  }));
  mock.method(storageManager, "setMcpEnabledTools", () => {});
  mock.method(storageManager, "stageMcpEnabledTools", () => {});
  mockDnsRuntime(
    () => preferences.promise,
    async (tools) => {
      setToolCalls.push([...tools]);
      return createMcpStatus(tools);
    },
    {
      stopMcpServer: async () => {
        stopCalls += 1;
        return createMcpStatus(["cf_list_zones"]);
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await waitFor(() => {
    assert.deepEqual(setToolCalls, [["cf_list_zones"]]);
  });
  assert.equal(
    stopCalls,
    0,
    "permission readiness cannot synchronize before session preferences settle",
  );

  preferences.resolve({
    mcp_server_enabled: false,
    mcp_enabled_tools: ["cf_list_zones"],
    session_settings_profiles: {
      [currentSessionId]: {
        mcpEnabledTools: ["cf_list_zones"],
      },
    },
  });

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(await screen.findByRole("button", { name: "MCP" }));
  const serverSetting = await screen.findByText("Enable MCP server");
  const serverSettingRow = serverSetting.parentElement;
  assert.ok(serverSettingRow);
  const serverSwitch = within(serverSettingRow).getByRole("switch");
  await waitFor(() => {
    assert.equal(serverSwitch.hasAttribute("disabled"), false);
    assert.equal(stopCalls, 1);
  });
  assert.deepEqual(setToolCalls, [["cf_list_zones"]]);
  assert.equal(stopCalls, 1);
});

test("rejected MCP tool mutation rolls back selection and shows sanitized context", async () => {
  setDesktopWindow();
  let rejectToolMutation = false;
  let rejectedMutation = false;
  const setToolCalls: string[][] = [];
  mock.method(storageManager, "getMcpEnabledToolsSnapshot", () => ({
    enabledTools: [],
    removedToolIds: [],
    pendingHighRiskToolIds: [],
    configured: true,
    permissionPolicyVersion: MCP_PERMISSION_POLICY_VERSION,
  }));
  mock.method(storageManager, "setMcpEnabledTools", () => {});
  mock.method(storageManager, "stageMcpEnabledTools", () => {});
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: false,
      mcp_enabled_tools: [],
    }),
    async (tools) => {
      setToolCalls.push([...tools]);
      if (rejectToolMutation && !rejectedMutation) {
        rejectedMutation = true;
        throw new Error("MCP tools failed token=hidden-tool-secret");
      }
      return createMcpStatus(tools);
    },
  );

  render(
    <>
      <RuntimeErrorListener />
      <Toaster />
      <DNSManager apiKey="test-key" onLogout={() => {}} />
    </>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  fireEvent.click(await screen.findByRole("button", { name: "MCP" }));

  const accessGroup = await screen.findByRole("group", {
    name: /Access and zones/,
  });
  const selectVisible = within(accessGroup).getByRole("button", {
    name: "Select visible",
  });
  await waitFor(() =>
    assert.equal(selectVisible.hasAttribute("disabled"), false),
  );

  const bootstrapReport = reportRuntimeError(
    new Error("MCP tools failed token=hidden-tool-secret"),
    {
      source: "runtime",
      label: "Synchronize MCP server preferences",
    },
  );
  const bootstrapMessage = await screen.findByText(
    "MCP tools failed token=[redacted]",
  );
  const bootstrapToast = bootstrapMessage.closest('[data-state="open"]');
  assert.ok(bootstrapToast, "the bootstrap diagnostic owns an open toast");
  for (const closeButton of document.querySelectorAll<HTMLElement>(
    "[toast-close]",
  )) {
    fireEvent.click(closeButton);
  }
  await waitFor(() =>
    assert.equal(
      document.querySelector('[data-state="open"] [toast-close]'),
      null,
    ),
  );
  rejectToolMutation = true;
  fireEvent.click(selectVisible);

  await waitFor(() => {
    assert.deepEqual(setToolCalls, [[], ["cf_list_zones"], []]);
    assert.ok(
      getRuntimeDiagnostics().some(
        (diagnostic) =>
          diagnostic.label === "Update MCP tool access" &&
          diagnostic.message === "MCP tools failed token=[redacted]",
      ),
    );
  });
  const mutationMessage = await screen.findByText(
    "MCP tools failed token=[redacted]",
  );
  assert.equal(
    screen.getAllByText("MCP tools failed token=[redacted]").length,
    1,
  );
  const mutationDiagnostic = getRuntimeDiagnostics().find(
    (diagnostic) =>
      diagnostic.label === "Update MCP tool access" &&
      diagnostic.message === "MCP tools failed token=[redacted]",
  );
  assert.ok(mutationDiagnostic, "the rejected mutation emits a diagnostic");
  assert.notEqual(mutationDiagnostic.id, bootstrapReport.diagnostic.id);
  assert.doesNotMatch(mutationDiagnostic.message, /hidden-tool-secret/);
  const mutationToast = mutationMessage.closest('[data-state="open"]');
  assert.ok(
    mutationToast,
    "the rejected mutation owns an open diagnostic toast",
  );
  fireEvent.click(
    within(mutationToast).getByRole("button", { name: "More info" }),
  );
  const diagnosticDialog = await screen.findByRole("dialog", {
    name: "Error details",
  });
  assert.match(diagnosticDialog.textContent ?? "", /Diagnostic ID:/);
  assert.match(
    diagnosticDialog.textContent ?? "",
    /Area: Update MCP tool access/,
  );
  assert.match(
    diagnosticDialog.textContent ?? "",
    /MCP tools failed token=\[redacted\]/,
  );
  assert.doesNotMatch(diagnosticDialog.textContent ?? "", /hidden-tool-secret/);
  fireEvent.click(
    within(diagnosticDialog).getByRole("button", {
      name: "Close error details",
    }),
  );
  await waitFor(() =>
    assert.equal(screen.queryByRole("dialog", { name: "Error details" }), null),
  );
  const checkbox = within(accessGroup).getByRole("checkbox", {
    name: /^List zones/,
  }) as HTMLInputElement;
  assert.equal(checkbox.checked, false);
  assert.ok(
    getRuntimeDiagnostics().some(
      (diagnostic) => diagnostic.label === "Update MCP tool access",
    ),
  );
  assert.doesNotMatch(document.body.textContent ?? "", /hidden-tool-secret/);
});
