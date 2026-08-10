/**
 * Bulk-path honesty tests.
 *
 * Every case here is about the same failure mode: the manager telling the user
 * something happened that the API never confirmed. Bulk delete, bulk field
 * edits and import all report per-record outcomes, so the UI must be rebuilt
 * from what came back rather than from what was attempted.
 */
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
import { Toaster } from "../src/components/ui/toaster";
import { resetToastRuntimeForTests } from "../src/hooks/use-toast";
import {
  normalizeBulkDnsDeleteResult,
  TauriClient,
  type BulkDnsDeleteResult,
  type McpServerStatus,
  type TauriDNSRecord,
  type TauriDNSRecordInput,
  type TauriZone,
} from "../src/lib/api/tauri-client";
import type { DNSRecord } from "../src/types/dns";

const originalFetch = globalThis.fetch;

const ZONE = {
  id: "bulk-zone",
  name: "bulk.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

type BulkCreateInput = Parameters<typeof TauriClient.createBulkDNSRecords>[3];
type BulkCreateResult = Awaited<
  ReturnType<typeof TauriClient.createBulkDNSRecords>
>;

interface UpdateCall {
  recordId: string;
  input: Record<string, unknown>;
}

interface BulkHarnessOptions {
  records?: TauriDNSRecord[];
  bulkDelete?: (recordIds: string[]) => Promise<BulkDnsDeleteResult>;
  updateRecord?: (
    recordId: string,
    input: Record<string, unknown>,
  ) => Promise<TauriDNSRecord | void>;
  bulkCreate?: (
    records: BulkCreateInput,
    dryRun: boolean | undefined,
  ) => Promise<BulkCreateResult>;
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
    zone_id: ZONE.id,
    zone_name: ZONE.name,
    created_on: "2026-08-06T10:00:00Z",
    modified_on: "2026-08-06T10:01:00Z",
    ...overrides,
  } as TauriDNSRecord;
}

/** A record in the shape the manager holds in tab state. */
function uiRecord(id: string, name: string, content: string): DNSRecord {
  return {
    id,
    type: "A",
    name,
    content,
    ttl: 300,
    proxied: false,
    zone_id: ZONE.id,
    zone_name: ZONE.name,
    created_on: "2026-08-06T10:00:00Z",
    modified_on: "2026-08-06T10:01:00Z",
  };
}

function mockBulkRuntime(options: BulkHarnessOptions = {}): {
  bulkDeleteCalls: string[][];
  createdInputs: Array<Record<string, unknown>>;
  createdIds: string[];
  deletedRecordIds: string[];
  updateCalls: UpdateCall[];
  bulkCreateCalls: BulkCreateInput[];
} {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};

  const zoneRecords = options.records ?? [];
  const bulkDeleteCalls: string[][] = [];
  const createdInputs: Array<Record<string, unknown>> = [];
  const createdIds: string[] = [];
  const deletedRecordIds: string[] = [];
  const updateCalls: UpdateCall[] = [];
  const bulkCreateCalls: BulkCreateInput[] = [];

  mock.method(TauriClient, "getPreferences", async () => ({
    reopen_last_tabs: true,
    reopen_zone_tabs: { [ZONE.id]: true },
    last_open_tabs: [ZONE.id],
    last_zone: ZONE.id,
    last_active_tab: `${ZONE.id}|records`,
  }));
  mock.method(TauriClient, "updatePreferences", async () => {});
  mock.method(TauriClient, "getZones", async () => [ZONE]);
  mock.method(TauriClient, "getDNSRecords", async () => zoneRecords);
  mock.method(
    TauriClient,
    "createDNSRecord",
    async (
      _apiKey: string,
      _email: string | undefined,
      zoneId: string,
      input: TauriDNSRecordInput,
    ) => {
      const id = `recreated-${createdIds.length}`;
      createdInputs.push(input as unknown as Record<string, unknown>);
      createdIds.push(id);
      return {
        id,
        zone_id: zoneId,
        zone_name: ZONE.name,
        created_on: "2026-08-06T11:00:00Z",
        modified_on: "2026-08-06T11:00:00Z",
        ...input,
      } as TauriDNSRecord;
    },
  );
  mock.method(
    TauriClient,
    "updateDNSRecord",
    async (
      _apiKey: string,
      _email: string | undefined,
      zoneId: string,
      recordId: string,
      input: TauriDNSRecordInput,
    ) => {
      const typed = input as unknown as Record<string, unknown>;
      updateCalls.push({ recordId, input: typed });
      if (options.updateRecord) {
        const result = await options.updateRecord(recordId, typed);
        if (result) return result;
      }
      return {
        id: recordId,
        zone_id: zoneId,
        zone_name: ZONE.name,
        created_on: "2026-08-06T10:00:00Z",
        modified_on: "2026-08-06T12:00:00Z",
        ...typed,
      } as TauriDNSRecord;
    },
  );
  mock.method(
    TauriClient,
    "deleteDNSRecord",
    async (
      _apiKey: string,
      _email: string | undefined,
      _zoneId: string,
      recordId: string,
    ) => {
      deletedRecordIds.push(recordId);
    },
  );
  mock.method(
    TauriClient,
    "deleteBulkDnsRecords",
    async (_apiKey: string, _zoneId: string, recordIds: string[]) => {
      bulkDeleteCalls.push([...recordIds]);
      if (options.bulkDelete) return options.bulkDelete(recordIds);
      return { deleted: [...recordIds], failed: [] };
    },
  );
  mock.method(
    TauriClient,
    "createBulkDNSRecords",
    async (
      _apiKey: string,
      _email: string | undefined,
      zoneId: string,
      records: TauriDNSRecordInput[],
      dryRun?: boolean,
    ) => {
      bulkCreateCalls.push(records);
      if (options.bulkCreate) return options.bulkCreate(records, dryRun);
      return {
        created: records.map(
          (input: TauriDNSRecordInput, index: number) =>
            ({
              id: `bulk-created-${index}`,
              zone_id: zoneId,
              zone_name: ZONE.name,
              created_on: "2026-08-06T11:00:00Z",
              modified_on: "2026-08-06T11:00:00Z",
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

  return {
    bulkDeleteCalls,
    createdInputs,
    createdIds,
    deletedRecordIds,
    updateCalls,
    bulkCreateCalls,
  };
}

function renderManager() {
  return render(
    <>
      <DNSManager apiKey="test-key" onLogout={() => {}} />
      <Toaster />
    </>,
  );
}

/** Tick every row's checkbox so the bulk bar is acting on the whole zone. */
async function selectAllRecords(expected: number): Promise<void> {
  const checkboxes = await screen.findAllByRole("checkbox", {
    name: "Select record",
  });
  assert.equal(checkboxes.length, expected);
  for (const checkbox of checkboxes) fireEvent.click(checkbox);
  await screen.findByText(`${expected} records selected`);
}

/** Bulk delete needs a second click to confirm. */
async function confirmBulkDelete(count: number): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: `Delete ${count}` }));
  fireEvent.click(
    await screen.findByRole("button", { name: `Confirm Delete (${count})` }),
  );
}

/**
 * The TTL/proxy select renders its label as content rather than an accessible
 * name, so it has to be picked out of the comboboxes by text.
 */
function bulkTtlSelect(): HTMLElement {
  const trigger = screen
    .getAllByRole("combobox")
    .find((element) => element.textContent === "Set TTL");
  assert.ok(trigger, "expected the bulk TTL select to be rendered");
  return trigger;
}

/** Row text, which carries the record's rendered TTL as "TTL <value>". */
function recordRowTexts(): string[] {
  return screen
    .queryAllByRole("button")
    .map((element) => element.textContent ?? "")
    .filter((text) => text.includes(".bulk.test") && text.includes("TTL "));
}

afterEach(() => {
  cleanup();
  resetToastRuntimeForTests();
  mock.restoreAll();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

test("normalizeBulkDnsDeleteResult reads the backend's per-record verdict", () => {
  assert.deepEqual(
    normalizeBulkDnsDeleteResult(
      { deleted: ["a"], failed: [{ id: "b", error: "rate limited" }] },
      ["a", "b"],
    ),
    { deleted: ["a"], failed: [{ id: "b", error: "rate limited" }] },
  );
  // Every id failing must never be read as success.
  assert.deepEqual(
    normalizeBulkDnsDeleteResult({ deleted: [], failed: [{ id: "a" }] }, ["a"]),
    { deleted: [], failed: [{ id: "a", error: "Unknown error" }] },
  );
  // A backend with no verdict to give resolved, which was its only signal.
  assert.deepEqual(normalizeBulkDnsDeleteResult(null, ["a", "b"]), {
    deleted: ["a", "b"],
    failed: [],
  });
});

test("repointPairedDnsOp re-aims a reverse op at the ids that were minted", () => {
  const recreated: DNSRecord[] = [
    uiRecord("new-1", "a.bulk.test", "192.0.2.1"),
    uiRecord("new-2", "b.bulk.test", "192.0.2.2"),
  ];

  const repointedSingle = DNSManager.repointPairedDnsOp(
    {
      kind: "delete",
      zoneId: ZONE.id,
      recordId: "dead-1",
      record: recreated[0],
    },
    [recreated[0]],
  );
  assert.equal(repointedSingle?.kind, "delete");
  assert.equal(
    repointedSingle?.kind === "delete" ? repointedSingle.recordId : null,
    "new-1",
  );

  const repointedBulk = DNSManager.repointPairedDnsOp(
    { kind: "bulk-delete", zoneId: ZONE.id, records: [] },
    recreated,
  );
  assert.deepEqual(
    repointedBulk?.kind === "bulk-delete"
      ? repointedBulk.records.map((r) => r.id)
      : null,
    ["new-1", "new-2"],
  );

  // Nothing created means nothing to re-point; the entry stays as it was.
  assert.equal(
    DNSManager.repointPairedDnsOp(
      { kind: "bulk-delete", zoneId: ZONE.id, records: [] },
      [],
    ),
    null,
  );
});

test("a partly refused bulk delete keeps the records that are still live", async () => {
  const { bulkDeleteCalls } = mockBulkRuntime({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bulk.test",
        content: "1.1.1.1",
      }),
      record({
        id: "rec-b",
        type: "A",
        name: "b.bulk.test",
        content: "2.2.2.2",
      }),
      record({
        id: "rec-c",
        type: "A",
        name: "c.bulk.test",
        content: "3.3.3.3",
      }),
    ],
    bulkDelete: async () => ({
      deleted: ["rec-a", "rec-c"],
      failed: [{ id: "rec-b", error: "rate limited" }],
    }),
  });

  renderManager();
  await selectAllRecords(3);
  await confirmBulkDelete(3);

  await waitFor(() => assert.equal(bulkDeleteCalls.length, 1));
  assert.deepEqual(bulkDeleteCalls[0], ["rec-a", "rec-b", "rec-c"]);

  // The toast names the count and the reason, not a flat "3 records deleted".
  const toast = await screen.findByText(/still exist/);
  assert.match(toast.textContent ?? "", /Deleted 2 of 3/);
  assert.match(toast.textContent ?? "", /1 record\(s\) still exist/);
  assert.match(toast.textContent ?? "", /A b\.bulk\.test: rate limited/);
  assert.equal(screen.queryByText("3 records deleted"), null);

  // The refused record is still in the zone, so it is still in the table and
  // still selected — the rows that really went away are the ones that vanish.
  await waitFor(() =>
    assert.equal(
      screen.queryAllByRole("checkbox", { name: "Select record" }).length,
      1,
    ),
  );
  assert.ok(screen.getByText("b.bulk.test"));
  assert.equal(screen.queryByText("a.bulk.test"), null);
  assert.equal(screen.queryByText("c.bulk.test"), null);
  assert.ok(screen.getByText("1 record selected"));
});

test("bulk delete is undoable and the redo targets the recreated ids", async () => {
  const { createdInputs, createdIds, deletedRecordIds } = mockBulkRuntime({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bulk.test",
        content: "1.1.1.1",
      }),
      record({
        id: "rec-b",
        type: "A",
        name: "b.bulk.test",
        content: "2.2.2.2",
      }),
    ],
  });

  renderManager();
  await selectAllRecords(2);
  await confirmBulkDelete(2);
  assert.ok(await screen.findByText("2 records deleted"));
  await waitFor(() =>
    assert.equal(
      screen.queryAllByRole("checkbox", { name: "Select record" }).length,
      0,
    ),
  );

  // Undo recreates both records — Cloudflare mints brand new ids for them.
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  await waitFor(() => assert.equal(createdInputs.length, 2));
  assert.deepEqual(
    createdInputs.map((input) => input.name),
    ["a.bulk.test", "b.bulk.test"],
  );
  assert.deepEqual(createdIds, ["recreated-0", "recreated-1"]);

  // Redo must delete what now exists, not the ids that died with the undo.
  fireEvent.keyDown(document.body, {
    key: "z",
    ctrlKey: true,
    shiftKey: true,
  });
  await waitFor(() => assert.equal(deletedRecordIds.length, 2));
  assert.deepEqual([...deletedRecordIds].sort(), [
    "recreated-0",
    "recreated-1",
  ]);

  // And undoing again recreates them rather than replaying a stale op.
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  await waitFor(() => assert.equal(createdInputs.length, 4));
});

test("a bulk TTL change that fails partway reports and applies only what landed", async () => {
  const { updateCalls } = mockBulkRuntime({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bulk.test",
        content: "1.1.1.1",
      }),
      record({
        id: "rec-b",
        type: "A",
        name: "b.bulk.test",
        content: "2.2.2.2",
      }),
      record({
        id: "rec-c",
        type: "A",
        name: "c.bulk.test",
        content: "3.3.3.3",
      }),
    ],
    updateRecord: async (recordId) => {
      if (recordId === "rec-b") throw new Error("rate limited");
    },
  });

  renderManager();
  await selectAllRecords(3);

  fireEvent.click(bulkTtlSelect());
  fireEvent.click(await screen.findByRole("option", { name: "1 hour" }));

  await waitFor(() => assert.equal(updateCalls.length, 3));
  assert.deepEqual(
    updateCalls.map((call) => call.recordId),
    ["rec-a", "rec-b", "rec-c"],
  );

  // A rejection mid-batch used to produce no toast at all.
  const toast = await screen.findByText(/unchanged/);
  assert.match(toast.textContent ?? "", /2 of 3 updated/);
  assert.match(toast.textContent ?? "", /A b\.bulk\.test: rate limited/);
  assert.equal(screen.queryByText("TTL set on 3 records"), null);

  // The table shows the two records that changed and the one that did not.
  await waitFor(() =>
    assert.equal(
      recordRowTexts().filter((text) => text.includes("TTL 3600")).length,
      2,
    ),
  );
  assert.deepEqual(
    recordRowTexts()
      .filter((text) => text.includes("TTL 300"))
      .map((text) => text.includes("b.bulk.test")),
    [true],
  );
});

test("a fully successful bulk TTL change is undoable back to the old values", async () => {
  const { updateCalls } = mockBulkRuntime({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bulk.test",
        content: "1.1.1.1",
      }),
      record({
        id: "rec-b",
        type: "A",
        name: "b.bulk.test",
        content: "2.2.2.2",
      }),
    ],
  });

  renderManager();
  await selectAllRecords(2);
  fireEvent.click(bulkTtlSelect());
  fireEvent.click(await screen.findByRole("option", { name: "1 hour" }));

  assert.ok(await screen.findByText("TTL set on 2 records"));
  await waitFor(() => assert.equal(updateCalls.length, 2));

  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  await waitFor(() => assert.equal(updateCalls.length, 4));
  assert.deepEqual(
    updateCalls.slice(2).map((call) => call.input.ttl),
    [300, 300],
  );
});

test("import reports the records the backend created, not the ones attempted", async () => {
  const { bulkCreateCalls } = mockBulkRuntime({
    records: [],
    bulkCreate: async (records) => ({
      // Cloudflare accepted one of the three and named the two it refused.
      created: [
        {
          id: "imported-0",
          zone_id: ZONE.id,
          zone_name: ZONE.name,
          created_on: "2026-08-06T11:00:00Z",
          modified_on: "2026-08-06T11:00:00Z",
          ...records[0],
        } as TauriDNSRecord,
      ],
      skipped: [
        { index: 1, error: "content for A record is invalid" },
        { index: 2, error: "content for A record is invalid" },
      ],
    }),
  });

  renderManager();
  fireEvent.click(await screen.findByRole("tab", { name: /Import\/Export/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Import" }));

  const payload = JSON.stringify([
    { type: "A", name: "one.bulk.test", content: "1.1.1.1", ttl: 300 },
    { type: "A", name: "two.bulk.test", content: "2.2.2.2", ttl: 300 },
    { type: "A", name: "three.bulk.test", content: "3.3.3.3", ttl: 300 },
  ]);
  const dialog = await screen.findByRole("dialog", {
    name: "Import DNS Records",
  });
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: payload },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Import Records" }),
  );

  const preview = await screen.findByRole("dialog", { name: /Preview/ });
  fireEvent.click(
    within(preview).getByRole("button", { name: "Import Selected" }),
  );

  await waitFor(() => assert.equal(bulkCreateCalls.length, 1));
  assert.equal(bulkCreateCalls[0].length, 3);
  assert.ok(await screen.findByText("Imported 1 record(s), skipped 2"));
  assert.equal(screen.queryByText("Imported 3 record(s)"), null);
});

test("an import the backend refused entirely is reported as a failure", async () => {
  mockBulkRuntime({
    records: [],
    bulkCreate: async () => ({
      created: [],
      skipped: [{ index: 0, error: "content for A record is invalid" }],
    }),
  });

  renderManager();
  fireEvent.click(await screen.findByRole("tab", { name: /Import\/Export/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Import" }));

  const dialog = await screen.findByRole("dialog", {
    name: "Import DNS Records",
  });
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: {
      value: JSON.stringify([
        { type: "A", name: "one.bulk.test", content: "1.1.1.1", ttl: 300 },
      ]),
    },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Import Records" }),
  );

  const preview = await screen.findByRole("dialog", { name: /Preview/ });
  fireEvent.click(
    within(preview).getByRole("button", { name: "Import Selected" }),
  );

  assert.ok(
    await screen.findByText("No records were imported. Skipped 1 item(s)."),
  );
  assert.equal(recordRowTexts().length, 0);
});
