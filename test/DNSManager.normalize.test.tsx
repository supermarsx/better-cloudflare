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
import { storageManager } from "../src/lib/storage/storage";

const originalFetch = globalThis.fetch;

const ZONE = {
  id: "normalize-zone",
  name: "example.com",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

type BulkInput = Parameters<typeof TauriClient.createBulkDNSRecords>[3];
type CreateInput = Parameters<typeof TauriClient.createDNSRecord>[3];

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

function mockNormalizeRuntime(records: TauriDNSRecord[] = []): {
  bulkCalls: Array<{ records: BulkInput; dryRun: boolean | undefined }>;
  createCalls: CreateInput[];
  deletedRecordIds: string[];
} {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  const bulkCalls: Array<{ records: BulkInput; dryRun: boolean | undefined }> =
    [];
  const createCalls: CreateInput[] = [];
  const deletedRecordIds: string[] = [];

  mock.method(storageManager, "getRewriteCopiedRecordDomains", () => true);
  mock.method(storageManager, "getConfirmPastePreview", () => true);
  mock.method(storageManager, "setConfirmPastePreview", () => {});
  mock.method(TauriClient, "getPreferences", async () => ({
    reopen_last_tabs: true,
    reopen_zone_tabs: { [ZONE.id]: true },
    last_open_tabs: [ZONE.id],
    last_zone: ZONE.id,
    last_active_tab: `${ZONE.id}|records`,
  }));
  mock.method(TauriClient, "updatePreferences", async () => {});
  mock.method(TauriClient, "getZones", async () => [ZONE]);
  mock.method(TauriClient, "getDNSRecords", async () => records);
  mock.method(
    TauriClient,
    "createDNSRecord",
    async (_apiKey, _email, zoneId, input) => {
      createCalls.push(input);
      return {
        id: `created-${createCalls.length}`,
        zone_id: zoneId,
        zone_name: ZONE.name,
        created_on: "2026-08-06T10:02:00Z",
        modified_on: "2026-08-06T10:02:00Z",
        ...input,
      } as TauriDNSRecord;
    },
  );
  mock.method(
    TauriClient,
    "createBulkDNSRecords",
    async (_apiKey, _email, zoneId, bulkRecords, dryRun) => {
      bulkCalls.push({ records: bulkRecords, dryRun });
      return {
        created: bulkRecords.map(
          (input, index) =>
            ({
              id: `bulk-${index}`,
              zone_id: zoneId,
              zone_name: ZONE.name,
              created_on: "2026-08-06T10:02:00Z",
              modified_on: "2026-08-06T10:02:00Z",
              ...input,
            }) as TauriDNSRecord,
        ),
        skipped: [],
      };
    },
  );
  mock.method(
    TauriClient,
    "deleteDNSRecord",
    async (_apiKey, _email, _zoneId, recordId) => {
      deletedRecordIds.push(recordId);
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

  return { bulkCalls, createCalls, deletedRecordIds };
}

afterEach(() => {
  cleanup();
  mock.restoreAll();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

test("adding a TXT record normalizes an unmatched quote before creating it", async () => {
  const { createCalls } = mockNormalizeRuntime();

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add Record" }));
  const dialog = await screen.findByRole("dialog", { name: "Add DNS Record" });

  // The type Select has no accessible name, so reach it through its label.
  const typeSelect = within(dialog)
    .getByText("Type", { selector: "label" })
    .parentElement?.querySelector("button");
  assert.ok(typeSelect);
  fireEvent.click(typeSelect);
  fireEvent.click(await screen.findByRole("option", { name: /^TXT/ }));

  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
    target: { value: "_dmarc" },
  });
  fireEvent.change(
    await within(dialog).findByRole("textbox", { name: "TXT content" }),
    { target: { value: 'v=DMARC1; p=none"' } },
  );

  const submit = within(dialog).getByRole("button", {
    name: /Create Record|Review Warnings/,
  });
  fireEvent.click(submit);
  if (createCalls.length === 0) {
    const review = within(dialog).queryByRole("button", {
      name: "Review Warnings",
    });
    if (review) fireEvent.click(review);
    const anyway = within(dialog).queryByRole("button", {
      name: "Create Anyway",
    });
    if (anyway) fireEvent.click(anyway);
  }

  await waitFor(() => assert.equal(createCalls.length, 1));
  assert.equal(createCalls[0]?.content, '"v=DMARC1; p=none"');
});

/** Drive the import dialog end to end with the given JSON payload. */
async function importJson(items: unknown[]): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Import/Export" }));
  fireEvent.click(await screen.findByRole("button", { name: "Import" }));

  const importDialog = await screen.findByRole("dialog", {
    name: "Import DNS Records",
  });
  fireEvent.change(within(importDialog).getByRole("textbox"), {
    target: { value: JSON.stringify(items) },
  });
  fireEvent.click(
    within(importDialog).getByRole("button", { name: "Import Records" }),
  );

  const preview = await screen.findByRole("dialog", { name: "Import Preview" });
  fireEvent.click(
    within(preview).getByRole("button", { name: "Import Selected" }),
  );
}

test("a bulk import is reversed by a single undo", async () => {
  const { bulkCalls, deletedRecordIds } = mockNormalizeRuntime();

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await importJson([
    { type: "A", name: "one.example.com", content: "192.0.2.1", ttl: 300 },
    { type: "A", name: "two.example.com", content: "192.0.2.2", ttl: 300 },
  ]);

  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.equal(bulkCalls[0]?.records.length, 2);

  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  await waitFor(() => assert.equal(deletedRecordIds.length, 2));
  assert.deepEqual([...deletedRecordIds].sort(), ["bulk-0", "bulk-1"]);
});

test("importing normalizes character strings and dedupes against normalized records", async () => {
  const existing = {
    id: "existing-txt",
    type: "TXT",
    name: "example.com",
    content: '"v=spf1 include:_spf.example.com ~all"',
    ttl: 300,
    proxied: false,
    zone_id: ZONE.id,
    zone_name: ZONE.name,
    created_on: "2026-08-06T10:00:00Z",
    modified_on: "2026-08-06T10:00:00Z",
  } as TauriDNSRecord;
  const { bulkCalls } = mockNormalizeRuntime([existing]);

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Import/Export" }));
  fireEvent.click(await screen.findByRole("button", { name: "Import" }));

  const importDialog = await screen.findByRole("dialog", {
    name: "Import DNS Records",
  });
  fireEvent.change(within(importDialog).getByRole("textbox"), {
    target: {
      value: JSON.stringify([
        // Same logical value as the existing record, written bare.
        {
          type: "TXT",
          name: "example.com",
          content: "v=spf1 include:_spf.example.com ~all",
          ttl: 300,
        },
        {
          type: "TXT",
          name: "verify.example.com",
          content: 'google-site-verification=abc"',
          ttl: 300,
        },
        {
          type: "CNAME",
          name: "www.example.com",
          content: "edge.example.com",
          ttl: 300,
        },
      ]),
    },
  });
  fireEvent.click(
    within(importDialog).getByRole("button", { name: "Import Records" }),
  );

  const preview = await screen.findByRole("dialog", { name: "Import Preview" });
  fireEvent.click(
    within(preview).getByRole("button", { name: "Import Selected" }),
  );

  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.deepEqual(
    bulkCalls[0]?.records.map((entry) => entry.content),
    ['"google-site-verification=abc"', "edge.example.com"],
  );
});
