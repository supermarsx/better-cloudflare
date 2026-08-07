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
import { storageManager } from "../src/lib/storage/storage";

const originalFetch = globalThis.fetch;

const SOURCE_ZONE = {
  id: "source-zone",
  name: "origin.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

const TARGET_ZONE = {
  id: "target-zone",
  name: "target.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

type BulkInput = Parameters<typeof TauriClient.createBulkDNSRecords>[3];
type BulkResult = Awaited<ReturnType<typeof TauriClient.createBulkDNSRecords>>;

interface BulkCall {
  zoneId: string;
  records: BulkInput;
  dryRun: boolean | undefined;
}

interface CopyHarnessOptions {
  zones?: TauriZone[];
  recordsByZone?: Record<string, TauriDNSRecord[]>;
  rewritePreference?: boolean;
  bulkHandler?: (
    zoneId: string,
    records: BulkInput,
    dryRun: boolean | undefined,
    callIndex: number,
  ) => Promise<BulkResult>;
}

function setDesktopWindow(): void {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
}

function createMcpStatus(): McpServerStatus {
  return {
    running: false,
    host: "127.0.0.1",
    port: 8787,
    url: "http://127.0.0.1:8787/mcp",
    enabledTools: [],
    tools: [],
    lastError: null,
  };
}

function record(
  overrides: Partial<TauriDNSRecord> &
    Pick<TauriDNSRecord, "id" | "type" | "name" | "content">,
): TauriDNSRecord {
  return {
    ttl: 300,
    proxied: false,
    zone_id: SOURCE_ZONE.id,
    zone_name: SOURCE_ZONE.name,
    created_on: "2026-08-06T10:00:00Z",
    modified_on: "2026-08-06T10:01:00Z",
    ...overrides,
  } as TauriDNSRecord;
}

function mockCopyRuntime(options: CopyHarnessOptions = {}): {
  bulkCalls: BulkCall[];
  preferenceUpdates: Array<Record<string, unknown>>;
} {
  setDesktopWindow();
  const zones = options.zones ?? [SOURCE_ZONE, TARGET_ZONE];
  const recordsByZone = options.recordsByZone ?? {};
  const bulkCalls: BulkCall[] = [];
  const preferenceUpdates: Array<Record<string, unknown>> = [];
  const firstZone = zones[0];
  const preferences: Record<string, unknown> = {
    reopen_last_tabs: zones.length > 0,
    reopen_zone_tabs: Object.fromEntries(zones.map((zone) => [zone.id, true])),
    last_open_tabs: zones.map((zone) => zone.id),
    ...(firstZone
      ? {
          last_zone: firstZone.id,
          last_active_tab: `${firstZone.id}|records`,
        }
      : {}),
    ...(options.rewritePreference === undefined
      ? {}
      : { rewrite_copied_record_domains: options.rewritePreference }),
  };

  mock.method(storageManager, "getRewriteCopiedRecordDomains", () => true);
  mock.method(storageManager, "setRewriteCopiedRecordDomains", () => {});
  mock.method(TauriClient, "getPreferences", async () => preferences);
  mock.method(TauriClient, "updatePreferences", async (next) => {
    preferenceUpdates.push(next as Record<string, unknown>);
  });
  mock.method(TauriClient, "getZones", async () => zones);
  mock.method(
    TauriClient,
    "getDNSRecords",
    async (_apiKey, _email, zoneId) => recordsByZone[zoneId] ?? [],
  );
  mock.method(
    TauriClient,
    "createDNSRecord",
    async (_apiKey, _email, zoneId, input) =>
      ({
        id: "created-single",
        zone_id: zoneId,
        zone_name: zones.find((zone) => zone.id === zoneId)?.name ?? "",
        created_on: "2026-08-06T10:02:00Z",
        modified_on: "2026-08-06T10:02:00Z",
        ...input,
      }) as TauriDNSRecord,
  );
  mock.method(
    TauriClient,
    "createBulkDNSRecords",
    async (_apiKey, _email, zoneId, records, dryRun) => {
      const callIndex = bulkCalls.length;
      bulkCalls.push({ zoneId, records, dryRun });
      if (options.bulkHandler) {
        return options.bulkHandler(zoneId, records, dryRun, callIndex);
      }
      return {
        created: records.map(
          (input, index) =>
            ({
              id: `created-${index}`,
              zone_id: zoneId,
              zone_name: zones.find((zone) => zone.id === zoneId)?.name ?? "",
              created_on: "2026-08-06T10:02:00Z",
              modified_on: "2026-08-06T10:02:00Z",
              ...input,
            }) as TauriDNSRecord,
        ),
        skipped: [],
      };
    },
  );
  mock.method(TauriClient, "getAuditEntries", async () => []);
  mock.method(TauriClient, "setMcpEnabledTools", async () => createMcpStatus());
  mock.method(TauriClient, "startMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "stopMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "getMcpServerStatus", async () => createMcpStatus());
  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  return { bulkCalls, preferenceUpdates };
}

async function copySelectedRecord(
  targetZoneName?: string,
): Promise<HTMLElement> {
  const recordCheckbox = await screen.findByRole("checkbox", {
    name: "Select record",
  });
  fireEvent.click(recordCheckbox);
  fireEvent.click(screen.getByRole("button", { name: "Copy selected" }));

  if (targetZoneName) {
    const targetTab = await screen.findByRole("tab", { name: targetZoneName });
    fireEvent.click(targetTab);
    await waitFor(() =>
      assert.equal(targetTab.getAttribute("aria-selected"), "true"),
    );
  }

  return screen.getByRole("button", { name: /^Paste\s+1$/ });
}

afterEach(() => {
  cleanup();
  mock.restoreAll();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

test("copy rewrite defaults on and submits an exact mutation-safe payload", async () => {
  const sourceRecord = record({
    id: "source-record",
    type: "CNAME",
    name: "www.origin.test.",
    content: "edge.origin.test.",
    comment: "preserve this comment",
  });
  const { bulkCalls } = mockCopyRuntime({
    recordsByZone: {
      [SOURCE_ZONE.id]: [sourceRecord],
      [TARGET_ZONE.id]: [],
    },
  });

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  const pasteButton = await copySelectedRecord(TARGET_ZONE.name);
  fireEvent.click(pasteButton);

  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.equal(bulkCalls[0].zoneId, TARGET_ZONE.id);
  assert.equal(bulkCalls[0].dryRun, false);
  assert.deepEqual(bulkCalls[0].records, [
    {
      type: "CNAME",
      name: "www.target.test.",
      content: "edge.target.test.",
      comment: "preserve this comment",
      ttl: 300,
      proxied: false,
    },
  ]);
});

test("native disabled preference preserves copied name and content byte-for-byte", async () => {
  const sourceRecord = record({
    id: "source-record",
    type: "SRV",
    name: "_sip._tcp.origin.test.",
    content: "10 5 443 service.origin.test.",
    priority: 10,
  });
  const { bulkCalls } = mockCopyRuntime({
    rewritePreference: false,
    recordsByZone: {
      [SOURCE_ZONE.id]: [sourceRecord],
      [TARGET_ZONE.id]: [],
    },
  });

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  fireEvent.click(await copySelectedRecord(TARGET_ZONE.name));

  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.equal(bulkCalls[0].records[0]?.name, sourceRecord.name);
  assert.equal(bulkCalls[0].records[0]?.content, sourceRecord.content);
});

test("copying within the source zone is a rewrite no-op", async () => {
  const sourceRecord = record({
    id: "source-record",
    type: "CNAME",
    name: "www.origin.test",
    content: "edge.origin.test",
  });
  const { bulkCalls } = mockCopyRuntime({
    zones: [SOURCE_ZONE],
    recordsByZone: { [SOURCE_ZONE.id]: [sourceRecord] },
  });

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  fireEvent.click(await copySelectedRecord());

  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.equal(bulkCalls[0].zoneId, SOURCE_ZONE.id);
  assert.equal(bulkCalls[0].records[0]?.name, sourceRecord.name);
  assert.equal(bulkCalls[0].records[0]?.content, sourceRecord.content);
});

test("a failed paste retains the copy buffer for an exact retry", async () => {
  const sourceRecord = record({
    id: "source-record",
    type: "CNAME",
    name: "www.origin.test",
    content: "edge.origin.test",
  });
  const { bulkCalls } = mockCopyRuntime({
    recordsByZone: {
      [SOURCE_ZONE.id]: [sourceRecord],
      [TARGET_ZONE.id]: [],
    },
    bulkHandler: async (zoneId, records, _dryRun, callIndex) => {
      if (callIndex === 0) throw new Error("temporary paste failure");
      return {
        created: records.map(
          (input, index) =>
            ({
              id: `retried-${index}`,
              zone_id: zoneId,
              zone_name: TARGET_ZONE.name,
              created_on: "2026-08-06T10:02:00Z",
              modified_on: "2026-08-06T10:02:00Z",
              ...input,
            }) as TauriDNSRecord,
        ),
        skipped: [],
      };
    },
  });

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  const pasteButton = await copySelectedRecord(TARGET_ZONE.name);
  fireEvent.click(pasteButton);
  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.equal(pasteButton.hasAttribute("disabled"), false);

  fireEvent.click(pasteButton);
  await waitFor(() => assert.equal(bulkCalls.length, 2));
  assert.deepEqual(bulkCalls[1], bulkCalls[0]);
});

test("native false hydrates the General setting and toggling persists true", async () => {
  const { preferenceUpdates } = mockCopyRuntime({
    zones: [],
    rewritePreference: false,
  });

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  const rewriteSwitch = await screen.findByRole("switch", {
    name: "Rewrite copied record domains",
  });
  await waitFor(() =>
    assert.equal(rewriteSwitch.getAttribute("aria-checked"), "false"),
  );
  assert.ok(
    screen.getByText(
      "Replace source-zone domain suffixes with the destination zone when pasting records.",
    ),
  );

  fireEvent.click(rewriteSwitch);
  await waitFor(() =>
    assert.equal(rewriteSwitch.getAttribute("aria-checked"), "true"),
  );
  await waitFor(() =>
    assert.ok(
      preferenceUpdates.some(
        (update) => update.rewrite_copied_record_domains === true,
      ),
    ),
  );
});
