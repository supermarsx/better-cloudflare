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
  /** Initial value of the persisted paste-preview preference. */
  pastePreviewPreference?: boolean;
  bulkHandler?: (
    zoneId: string,
    records: BulkInput,
    dryRun: boolean | undefined,
    callIndex: number,
  ) => Promise<BulkResult>;
  deleteHandler?: (zoneId: string, recordId: string) => Promise<void>;
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
  pastePreviewWrites: boolean[];
  deletedRecordIds: string[];
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

  const pastePreviewWrites: boolean[] = [];
  const deletedRecordIds: string[] = [];
  const pastePreviewPreference = options.pastePreviewPreference ?? true;

  mock.method(storageManager, "getRewriteCopiedRecordDomains", () => true);
  mock.method(storageManager, "setRewriteCopiedRecordDomains", () => {});
  mock.method(
    storageManager,
    "getConfirmPastePreview",
    () => pastePreviewPreference,
  );
  mock.method(storageManager, "setConfirmPastePreview", (enabled: boolean) => {
    pastePreviewWrites.push(enabled);
  });
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
  mock.method(
    TauriClient,
    "deleteDNSRecord",
    async (_apiKey, _email, zoneId, recordId) => {
      deletedRecordIds.push(recordId);
      if (options.deleteHandler) await options.deleteHandler(zoneId, recordId);
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

  return { bulkCalls, preferenceUpdates, pastePreviewWrites, deletedRecordIds };
}

/** Render the manager with a toast viewport so toast copy is assertable. */
function renderManager() {
  return render(
    <>
      <DNSManager apiKey="test-key" onLogout={() => {}} />
      <Toaster />
    </>,
  );
}

/** Confirm the paste preview dialog, asserting it is on screen first. */
async function confirmPastePreview(): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: "Paste Preview" });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Paste Selected" }),
  );
  await waitFor(() =>
    assert.equal(screen.queryByRole("dialog", { name: "Paste Preview" }), null),
  );
}

function queryPastePreview(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: "Paste Preview" });
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

/** Select the first `count` rows, copy them, and optionally switch zones. */
async function copyRecords(
  count: number,
  targetZoneName?: string,
): Promise<HTMLElement> {
  const checkboxes = await screen.findAllByRole("checkbox", {
    name: "Select record",
  });
  for (const checkbox of checkboxes.slice(0, count)) {
    fireEvent.click(checkbox);
  }
  fireEvent.click(screen.getByRole("button", { name: "Copy selected" }));

  if (targetZoneName) {
    const targetTab = await screen.findByRole("tab", { name: targetZoneName });
    fireEvent.click(targetTab);
    await waitFor(() =>
      assert.equal(targetTab.getAttribute("aria-selected"), "true"),
    );
  }

  return screen.getByRole("button", {
    name: new RegExp(`^Paste\\s+${count}$`),
  });
}

afterEach(() => {
  cleanup();
  resetToastRuntimeForTests();
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

  renderManager();
  const pasteButton = await copySelectedRecord(TARGET_ZONE.name);
  fireEvent.click(pasteButton);
  await confirmPastePreview();

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

  renderManager();
  fireEvent.click(await copySelectedRecord(TARGET_ZONE.name));

  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.equal(bulkCalls[0].records[0]?.name, sourceRecord.name);
  assert.equal(bulkCalls[0].records[0]?.content, sourceRecord.content);
  // Nothing was rewritten, so the quick paste is never interrupted.
  assert.equal(queryPastePreview(), null);
});

test("pasting a record back into its own zone is refused as a duplicate", async () => {
  // Same-zone copy rewrites nothing, so the record is byte-identical to the
  // one already in the zone and the client-side dedupe must drop it rather
  // than silently creating a second copy.
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

  renderManager();
  fireEvent.click(await copySelectedRecord());

  assert.ok(
    await screen.findByText(
      "No new records pasted. Skipped 1 duplicate or invalid record(s).",
    ),
  );
  assert.equal(queryPastePreview(), null);
  assert.equal(bulkCalls.length, 0);
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

  renderManager();
  const pasteButton = await copySelectedRecord(TARGET_ZONE.name);
  fireEvent.click(pasteButton);
  await confirmPastePreview();
  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.equal(pasteButton.hasAttribute("disabled"), false);

  fireEvent.click(pasteButton);
  await confirmPastePreview();
  await waitFor(() => assert.equal(bulkCalls.length, 2));
  assert.deepEqual(bulkCalls[1], bulkCalls[0]);
});

test("native false hydrates the General setting and toggling persists true", async () => {
  const { preferenceUpdates } = mockCopyRuntime({
    zones: [],
    rewritePreference: false,
  });

  renderManager();
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

test("Zone Compare queues the records the current zone is missing", async () => {
  const missing = record({
    id: "source-record",
    type: "CNAME",
    name: "www.origin.test",
    content: "edge.origin.test",
  });
  const { bulkCalls } = mockCopyRuntime({
    recordsByZone: {
      [SOURCE_ZONE.id]: [missing],
      [TARGET_ZONE.id]: [],
    },
  });

  renderManager();
  const targetTab = await screen.findByRole("tab", { name: TARGET_ZONE.name });
  fireEvent.click(targetTab);
  await waitFor(() =>
    assert.equal(targetTab.getAttribute("aria-selected"), "true"),
  );

  fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
  // A combobox takes its accessible name from a label, not its contents, so
  // the placeholder text is the only handle on the compare-zone picker.
  const zonePicker = (await screen.findByText("Select zone…")).closest(
    "button",
  );
  assert.ok(zonePicker);
  fireEvent.click(zonePicker);
  fireEvent.click(
    await screen.findByRole("option", { name: SOURCE_ZONE.name }),
  );
  const runComparison = screen
    .getAllByRole("button", { name: "Compare" })
    .at(-1);
  assert.ok(runComparison);
  fireEvent.click(runComparison);

  const copyMissing = await screen.findByRole("button", {
    name: "Copy 1 missing → current",
  });
  fireEvent.click(copyMissing);

  fireEvent.click(screen.getByRole("tab", { name: "Records" }));
  const pasteButton = await screen.findByRole("button", {
    name: /^Paste\s+1$/,
  });
  assert.ok(await screen.findByText("Buffer: 1 from origin.test"));

  fireEvent.click(pasteButton);
  await confirmPastePreview();

  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.equal(bulkCalls[0].zoneId, TARGET_ZONE.id);
  assert.deepEqual(bulkCalls[0].records, [
    {
      type: "CNAME",
      name: "www.target.test",
      content: "edge.target.test",
      ttl: 300,
      proxied: false,
    },
  ]);
});

test("the paste toast reports the records the backend skipped", async () => {
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
    bulkHandler: async () => ({
      created: [],
      skipped: [{ reason: "record already exists" }],
    }),
  });

  renderManager();
  fireEvent.click(await copySelectedRecord(TARGET_ZONE.name));
  await confirmPastePreview();

  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.ok(
    await screen.findByText("Created 0 record(s) in target.test, skipped 1"),
  );
});

test("pasting the same buffer twice creates no duplicates", async () => {
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
  });

  renderManager();
  const pasteButton = await copySelectedRecord(TARGET_ZONE.name);
  fireEvent.click(pasteButton);
  await confirmPastePreview();
  await waitFor(() => assert.equal(bulkCalls.length, 1));

  fireEvent.click(pasteButton);
  assert.ok(
    await screen.findByText(
      "No new records pasted. Skipped 1 duplicate or invalid record(s).",
    ),
  );
  assert.equal(queryPastePreview(), null);
  assert.equal(bulkCalls.length, 1);
});

test("the preview lists rewritten content and the opt-out persists", async () => {
  const sourceRecord = record({
    id: "source-record",
    type: "CNAME",
    name: "www.origin.test",
    content: "edge.origin.test",
  });
  const { bulkCalls, pastePreviewWrites } = mockCopyRuntime({
    recordsByZone: {
      [SOURCE_ZONE.id]: [sourceRecord],
      [TARGET_ZONE.id]: [],
    },
  });

  renderManager();
  fireEvent.click(await copySelectedRecord(TARGET_ZONE.name));

  const dialog = await screen.findByRole("dialog", { name: "Paste Preview" });
  assert.ok(within(dialog).getByText("CNAME www.target.test"));
  assert.ok(within(dialog).getByText("edge.target.test"));

  const askAgain = within(dialog).getByRole("checkbox", {
    name: "Ask before pasting rewritten records",
  }) as HTMLInputElement;
  assert.equal(askAgain.checked, true);
  fireEvent.click(askAgain);
  await waitFor(() => assert.equal(askAgain.checked, false));

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Paste Selected" }),
  );
  await waitFor(() => assert.equal(bulkCalls.length, 1));
  await waitFor(() =>
    assert.ok(pastePreviewWrites.includes(false), "preference was persisted"),
  );
});

test("a stored opt-out hydrates and pastes a rewritten record without asking", async () => {
  const sourceRecord = record({
    id: "source-record",
    type: "CNAME",
    name: "www.origin.test",
    content: "edge.origin.test",
  });
  const { bulkCalls } = mockCopyRuntime({
    pastePreviewPreference: false,
    recordsByZone: {
      [SOURCE_ZONE.id]: [sourceRecord],
      [TARGET_ZONE.id]: [],
    },
  });

  renderManager();
  fireEvent.click(await copySelectedRecord(TARGET_ZONE.name));

  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.equal(queryPastePreview(), null);
  assert.equal(bulkCalls[0].records[0]?.name, "www.target.test");
});

test("a bulk paste is reversed by a single undo", async () => {
  const { bulkCalls, deletedRecordIds } = mockCopyRuntime({
    recordsByZone: {
      [SOURCE_ZONE.id]: [
        record({
          id: "source-a",
          type: "CNAME",
          name: "www.origin.test",
          content: "edge.origin.test",
        }),
        record({
          id: "source-b",
          type: "CNAME",
          name: "cdn.origin.test",
          content: "edge.origin.test",
        }),
      ],
      [TARGET_ZONE.id]: [],
    },
  });

  renderManager();
  fireEvent.click(await copyRecords(2, TARGET_ZONE.name));
  await confirmPastePreview();
  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.equal(bulkCalls[0].records.length, 2);

  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  await waitFor(() => assert.equal(deletedRecordIds.length, 2));
  assert.deepEqual([...deletedRecordIds].sort(), ["created-0", "created-1"]);
});

test("the copy buffer can be inspected and cleared", async () => {
  const sourceRecord = record({
    id: "source-record",
    type: "CNAME",
    name: "www.origin.test",
    content: "edge.origin.test",
  });
  mockCopyRuntime({
    recordsByZone: {
      [SOURCE_ZONE.id]: [sourceRecord],
      [TARGET_ZONE.id]: [],
    },
  });

  renderManager();
  const pasteButton = await copySelectedRecord(TARGET_ZONE.name);
  assert.equal(pasteButton.hasAttribute("disabled"), false);

  fireEvent.click(screen.getByText("Buffer: 1 from origin.test"));
  const dialog = await screen.findByRole("dialog", { name: "Copy buffer" });
  const rows = within(dialog).getAllByTestId("copy-buffer-row");
  assert.equal(rows.length, 1);
  assert.ok(within(dialog).getByText("CNAME www.origin.test"));
  assert.ok(within(dialog).getByText("edge.origin.test"));

  fireEvent.click(within(dialog).getByRole("button", { name: "Clear buffer" }));

  await waitFor(() =>
    assert.equal(screen.queryByText("Buffer: 1 from origin.test"), null),
  );
  assert.ok(await screen.findByText("No records are queued for pasting."));
  await waitFor(() =>
    assert.ok(
      screen.getByRole("button", { name: /^Paste/ }).hasAttribute("disabled"),
    ),
  );
});

test("pasted character-string content is normalized after the rewrite", async () => {
  const { bulkCalls } = mockCopyRuntime({
    recordsByZone: {
      [SOURCE_ZONE.id]: [
        record({
          id: "spf-record",
          type: "TXT",
          name: "origin.test",
          content: "v=spf1 include:_spf.origin.test ~all",
        }),
        record({
          id: "broken-quote-record",
          type: "TXT",
          name: "verify.origin.test",
          content: 'google-site-verification=abc"',
        }),
      ],
      [TARGET_ZONE.id]: [],
    },
  });

  renderManager();
  fireEvent.click(await copyRecords(2, TARGET_ZONE.name));
  await confirmPastePreview();

  await waitFor(() => assert.equal(bulkCalls.length, 1));
  assert.deepEqual(
    bulkCalls[0].records.map((entry) => entry.content),
    [
      '"v=spf1 include:_spf.target.test ~all"',
      '"google-site-verification=abc"',
    ],
  );
  assert.deepEqual(
    bulkCalls[0].records.map((entry) => entry.name),
    ["target.test", "verify.target.test"],
  );
});
