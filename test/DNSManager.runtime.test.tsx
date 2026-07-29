import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import {
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
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";
import { storageManager } from "../src/lib/storage/storage";
import { MCP_PERMISSION_POLICY_VERSION } from "../src/lib/mcp/tool-permissions";
import { RuntimeErrorListener } from "../src/components/layout/RuntimeErrorListener";
import { Toaster } from "../src/components/ui/toaster";

const {
  DNS_API_PAGE_SIZE_LIMIT,
  DNS_RECORD_MEMORY_LIMIT,
  DNS_RECORD_RENDER_LIMIT,
  DNS_TOPOLOGY_RECORD_LIMIT,
  DNS_TOPOLOGY_SCAN_PAGE_LIMIT,
  clampDnsPageSize,
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

function createMcpStatus(enabledTools: string[] = []): McpServerStatus {
  return {
    running: false,
    host: "127.0.0.1",
    port: 8787,
    url: "http://127.0.0.1:8787/mcp",
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

test("login-time MCP synchronization is contained and attempted only once", async () => {
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

test("login-time MCP reconciliation stays mounted off-view, preserves staged high-risk requests, and defers confirmation", async () => {
  setDesktopWindow();
  const statusLoad = deferred<McpServerStatus>();
  const setToolCalls: string[][] = [];
  const startCalls: string[][] = [];
  let snapshotReads = 0;

  mock.method(storageManager, "getMcpEnabledToolsSnapshot", () => {
    snapshotReads += 1;
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
      getMcpServerStatus: () => statusLoad.promise,
      startMcpServer: async (_host, _port, enabledTools) => {
        startCalls.push([...enabledTools]);
        return createMcpStatus(enabledTools);
      },
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  await waitFor(() => assert.ok(snapshotReads >= 3));
  statusLoad.resolve(createMcpStatus(["cf_list_zones"]));
  await waitFor(() => {
    assert.deepEqual(setToolCalls, [[]]);
    assert.deepEqual(startCalls, [["cf_list_zones"]]);
  });

  const parking = screen.getByTestId("mcp-permissions-parking");
  assert.equal(parking.hidden, true);
  assert.ok(
    parking.querySelector('[data-mcp-permissions-mount="true"]'),
    "the single MCP permission instance remains mounted in the hidden parking host",
  );
  assert.equal(screen.queryByRole("alertdialog"), null);
  assert.equal(
    screen.queryByRole("heading", { name: "MCP tool permissions" }),
    null,
  );

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(await screen.findByRole("button", { name: "MCP" }));

  const confirmation = await screen.findByRole("alertdialog");
  assert.ok(within(confirmation).getByText(/Create DNS record/));
  assert.deepEqual(setToolCalls, [[]]);
});

test("an equal hydrated session profile preserves MCP readiness after reconciliation", async () => {
  setDesktopWindow();
  const preferences = deferred<Record<string, unknown>>();
  const setToolCalls: string[][] = [];
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
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await waitFor(() => {
    assert.deepEqual(setToolCalls, [["cf_list_zones"]]);
  });

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
  });
  assert.deepEqual(setToolCalls, [["cf_list_zones"]]);
});

test("rejected MCP tool mutation rolls back selection and shows sanitized context", async () => {
  setDesktopWindow();
  let rejectToolMutation = false;
  let rejectedMutation = false;
  const setToolCalls: string[][] = [];
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
  rejectToolMutation = true;
  fireEvent.click(selectVisible);

  assert.ok(await screen.findByText("A runtime problem was contained"));
  assert.deepEqual(setToolCalls, [[], ["cf_list_zones"], []]);
  fireEvent.click(screen.getByRole("button", { name: "More info" }));
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
