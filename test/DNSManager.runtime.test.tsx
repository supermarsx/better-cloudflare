import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

const {
  DNS_API_PAGE_SIZE_LIMIT,
  DNS_RECORD_MEMORY_LIMIT,
  DNS_RECORD_RENDER_LIMIT,
  clampDnsPageSize,
  loadCompleteDnsRecordsForExport,
  retainDnsRecordsForUi,
} = DNSManager;

const originalWindow = (globalThis as { window?: unknown }).window;
const originalFetch = globalThis.fetch;

function setDesktopWindow(): void {
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
  mock.method(TauriClient, "startMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "stopMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "getMcpServerStatus", async () => createMcpStatus());
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
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: false,
      mcp_enabled_tools: ["dns_read"],
    }),
    async () => {
      attempts += 1;
      throw new Error(
        "invalid args `enabledTools` for command `mcp_set_enabled_tools`",
      );
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
  assert.equal(attempts, 1);
  assert.ok(screen.getByRole("button", { name: "Settings" }));
});

test("rejected MCP tool mutation rolls back selection and shows sanitized context", async () => {
  setDesktopWindow();
  let rejectToolMutation = false;
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: false,
      mcp_enabled_tools: [],
    }),
    async (tools) => {
      if (rejectToolMutation) {
        throw new Error("MCP tools failed token=hidden-tool-secret");
      }
      return createMcpStatus(tools);
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  fireEvent.click(await screen.findByRole("button", { name: "MCP" }));

  const enableAll = await screen.findByRole("button", { name: "Enable all" });
  await waitFor(() => assert.equal(enableAll.hasAttribute("disabled"), false));
  rejectToolMutation = true;
  fireEvent.click(enableAll);

  await waitFor(() => {
    assert.ok(screen.getByText("MCP tools failed token=[redacted]"));
  });
  const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
  assert.equal(checkbox.checked, false);
  assert.ok(
    getRuntimeDiagnostics().some(
      (diagnostic) => diagnostic.label === "Update MCP tool access",
    ),
  );
  assert.doesNotMatch(document.body.textContent ?? "", /hidden-tool-secret/);
});
