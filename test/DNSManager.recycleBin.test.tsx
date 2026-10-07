/**
 * The recycle bin, wired to the screen.
 *
 * The engine, the store and the six commands were built and tested before any
 * of this existed, so what is left to prove is not that retention works — it is
 * that the UI reaches it, and that it never says something the commands did not
 * say. Four claims are load-bearing here, and each one is a way a user loses a
 * record:
 *
 *  1. **A binned delete is a retain, not a delete.** `retain_dns_record` keeps
 *     the copy before it removes the record, so a path that called
 *     `delete_dns_record` and then retained — or called it at all — would
 *     destroy a record with no copy in exactly the window the feature exists
 *     to close. Nothing in the binned path may touch the delete commands.
 *  2. **`store_full` is not a success and not a crash.** The record is still
 *     live and still resolving, and the user has to be told so and given the
 *     ways out, because the one thing they must not do is assume it is gone.
 *  3. **A restore's nine endings are nine sentences.** The command went to the
 *     trouble of distinguishing them; four of them leave the entry restorable
 *     and two mean the record is already live, so a flat "failed" would be
 *     actively misleading.
 *  4. **Disabling says what disabling is.** Cloudflare has no disabled state:
 *     the record is deleted there and this application holds the only copy. A
 *     confirmation that implies a dormant record waits in the zone is the one
 *     copy bug that can cost someone a record permanently.
 *
 * Absence is asserted as `assert.ok(node === null, …)` throughout, never
 * `assert.equal(node, null)`: the latter makes `assert` deep-inspect a jsdom
 * element on failure and can take the worker — and the rest of the batch —
 * down with it.
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
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { DNSManager } from "../src/components/dns/DNSManager";
import { SETTINGS_SUBTABS } from "../src/components/dns/settings-search";
import { Toaster } from "../src/components/ui/toaster";
import { resetToastRuntimeForTests } from "../src/hooks/use-toast";
import {
  TauriClient,
  type McpServerStatus,
  type TauriDNSRecord,
  type TauriZone,
} from "../src/lib/api/tauri-client";
import {
  RETAINED_FIELD_LOSSES,
  RETENTION_COMMANDS,
  RETENTION_LIMITS,
  type PurgeReport,
  type RestoreOutcome,
  type RetainDecision,
} from "../src/lib/records/retention";
import { storageManager } from "../src/lib/storage/storage";

import { useEnglishLocale } from "./i18n-ready";
import { enableThemedSelectEnvironment } from "./radix-select";

const originalFetch = globalThis.fetch;

const ZONE = {
  id: "bin-zone",
  name: "bin.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

/** Every record id this suite ever tags, so `afterEach` can un-tag them. */
const TAGGED_RECORD_IDS = ["rec-a", "rec-b", "restored-rec"];

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
    created_on: "2026-09-01T10:00:00Z",
    modified_on: "2026-09-01T10:01:00Z",
    ...overrides,
  } as TauriDNSRecord;
}

/** A stored entry, in the snake_case shape `parseRetainedRecord` reads. */
function storedEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    entry_id: "entry-a",
    reason: "deleted",
    zone_id: ZONE.id,
    zone_name: ZONE.name,
    origin_record_id: "rec-a",
    removed_from_provider_at: "2026-09-01T12:00:00Z",
    // Far enough out that the countdown is stable whenever the suite runs.
    expires_at: "2126-10-01T00:00:00Z",
    type: "A",
    name: "a.bin.test",
    content: "1.1.1.1",
    ttl: 300,
    proxied: false,
    local_tags: [],
    ...overrides,
  };
}

const RESTORED: RestoreOutcome = {
  status: "restored",
  entryId: "entry-a",
  record: {
    id: "restored-rec",
    type: "A",
    name: "a.bin.test",
    content: "1.1.1.1",
    ttl: 300,
    proxied: false,
    zone_id: ZONE.id,
    zone_name: ZONE.name,
    created_on: "2026-10-01T00:00:00Z",
    modified_on: "2026-10-01T00:00:00Z",
  },
  localTags: [],
  sharesNameWith: [],
  destinationUnverified: false,
  entryCleared: true,
};

interface IpcCall {
  command: string;
  args: Record<string, unknown>;
}

interface HarnessOptions {
  records?: TauriDNSRecord[];
  /** The store's listed entries. Mutated by forget and clear, as the real one is. */
  entries?: Record<string, unknown>[];
  /** Expired and not yet swept — excluded from `entries`, as the engine excludes them. */
  expiredPendingPurge?: number;
  /** What each successive `retain_dns_record` decides. Last value repeats. */
  retain?: RetainDecision[];
  /** What each successive `restore_retained_record` reports. Last value repeats. */
  restore?: RestoreOutcome[];
}

interface Harness {
  ipc: IpcCall[];
  deletedRecordIds: string[];
  bulkDeleteCalls: string[][];
  calls: (command: string) => IpcCall[];
}

/**
 * Mock the host.
 *
 * The retention commands have no `TauriClient` wrapper to stub — they go
 * through `invoke` directly, the way `app_host_facts` does — so they are
 * intercepted at the IPC boundary with `mockIPC`, which is also what makes
 * `delete_dns_record` provably untouched: it is stubbed on `TauriClient` and
 * recorded there, and an unrecognised command throws rather than resolving.
 */
function mockRuntime(options: HarnessOptions = {}): Harness {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  enableThemedSelectEnvironment();

  const ipc: IpcCall[] = [];
  const deletedRecordIds: string[] = [];
  const bulkDeleteCalls: string[][] = [];
  let entries = options.entries ?? [];
  let expiredPendingPurge = options.expiredPendingPurge ?? 0;
  let retainIndex = 0;
  let restoreIndex = 0;

  const nextRetain = (): RetainDecision => {
    const scripted = options.retain;
    if (!scripted || scripted.length === 0) {
      return {
        status: "retained",
        entryId: `entry-${retainIndex++}`,
        expiresAt: "2026-11-01T00:00:00Z",
        purged: 0,
        evicted: 0,
      };
    }
    const value = scripted[Math.min(retainIndex, scripted.length - 1)];
    retainIndex += 1;
    return value;
  };

  const nextRestore = (): RestoreOutcome => {
    const scripted = options.restore;
    if (!scripted || scripted.length === 0) return RESTORED;
    const value = scripted[Math.min(restoreIndex, scripted.length - 1)];
    restoreIndex += 1;
    return value;
  };

  mockIPC((command, args) => {
    ipc.push({ command, args: (args ?? {}) as Record<string, unknown> });
    switch (command) {
      case RETENTION_COMMANDS.retain:
        return nextRetain();
      case RETENTION_COMMANDS.list:
        return {
          entries,
          expiredPendingPurge,
          totalHeld: entries.length + expiredPendingPurge,
          bytesHeld: 4096,
          maxBytes: RETENTION_LIMITS.storeBytes,
          maxEntries: RETENTION_LIMITS.maxEntries.default,
        };
      case RETENTION_COMMANDS.restore:
        return nextRestore();
      case RETENTION_COMMANDS.purge: {
        const purged = expiredPendingPurge;
        expiredPendingPurge = 0;
        return { purged, remaining: entries.length } satisfies PurgeReport;
      }
      case RETENTION_COMMANDS.forget: {
        const before = entries.length;
        const target = (args as { entryId?: string } | undefined)?.entryId;
        entries = entries.filter((entry) => entry.entry_id !== target);
        return before !== entries.length;
      }
      case RETENTION_COMMANDS.clear: {
        const purged = entries.length;
        entries = [];
        expiredPendingPurge = 0;
        return { purged, remaining: 0 } satisfies PurgeReport;
      }
      default:
        throw new Error(`unexpected command reached the host: ${command}`);
    }
  });

  const zoneRecords = options.records ?? [];
  mock.method(TauriClient, "getPreferences", async () => ({
    reopen_last_tabs: true,
    reopen_zone_tabs: { [ZONE.id]: true },
    last_open_tabs: [ZONE.id],
    last_zone: ZONE.id,
    last_active_tab: `${ZONE.id}|records`,
  }));
  mock.method(TauriClient, "updatePreferences", async () => {});
  mock.method(TauriClient, "updatePreferenceFields", async () => {});
  mock.method(TauriClient, "getZones", async () => [ZONE]);
  mock.method(TauriClient, "getDNSRecords", async () => zoneRecords);
  mock.method(TauriClient, "getAuditEntries", async () => []);
  mock.method(TauriClient, "getMcpServerStatus", async () => createMcpStatus());
  mock.method(TauriClient, "setMcpEnabledTools", async () => createMcpStatus());
  mock.method(TauriClient, "startMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "stopMcpServer", async () => createMcpStatus());
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
      return { deleted: [...recordIds], failed: [] };
    },
  );
  mock.method(
    TauriClient,
    "createDNSRecord",
    async (
      _apiKey: string,
      _email: string | undefined,
      zoneId: string,
      input: Record<string, unknown>,
    ) => ({ id: "created-0", zone_id: zoneId, ...input }) as TauriDNSRecord,
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  return {
    ipc,
    deletedRecordIds,
    bulkDeleteCalls,
    calls: (command) => ipc.filter((call) => call.command === command),
  };
}

async function renderManager(options: HarnessOptions = {}): Promise<Harness> {
  await useEnglishLocale();
  const harness = mockRuntime(options);
  render(
    <>
      <DNSManager apiKey="bin-key" email="owner@bin.test" onLogout={() => {}} />
      <Toaster />
    </>,
  );
  return harness;
}

afterEach(() => {
  cleanup();
  resetToastRuntimeForTests();
  mock.restoreAll();
  clearMocks();
  storageManager.clearSettings();
  // `clearSettings` does not reach the recycle-bin leaves or the record tags,
  // and `storageManager` is a module singleton, so both are put back by hand.
  storageManager.setRecycleBinEnabled(true);
  storageManager.setRecycleBinRetentionDays(
    RETENTION_LIMITS.retentionDays.default,
  );
  storageManager.setRecycleBinMaxEntries(RETENTION_LIMITS.maxEntries.default);
  storageManager.setRecycleBinAutoPurge(true);
  for (const id of TAGGED_RECORD_IDS) {
    storageManager.clearRecordTags(ZONE.id, id);
  }
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

// ── Driving the screen ──────────────────────────────────────────────────────

async function recordsTable(): Promise<HTMLElement> {
  return screen.findByTestId("dns-records-table");
}

function recordRowTexts(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-record-row]"),
  ).map((row) => row.textContent ?? "");
}

/** Delete one row through its context menu, the way the row menu does. */
async function deleteFirstRowFromMenu(): Promise<void> {
  const table = await recordsTable();
  const row = table.querySelector("[data-record-row]");
  assert.ok(row, "the zone must render at least one record row");
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  const item = document.querySelector<HTMLElement>(
    '[data-record-action="delete"]',
  );
  assert.ok(item, "the row menu must offer a delete action");
  fireEvent.click(item);
}

async function selectAllRecords(expected: number): Promise<void> {
  const checkboxes = await screen.findAllByRole("checkbox", {
    name: "Select record",
  });
  assert.equal(checkboxes.length, expected);
  for (const checkbox of checkboxes) fireEvent.click(checkbox);
  await screen.findByText(
    expected === 1 ? "1 record selected" : `${expected} records selected`,
  );
}

async function confirmBulkDelete(count: number): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: `Delete ${count}` }));
  fireEvent.click(
    await screen.findByRole("button", { name: `Confirm Delete (${count})` }),
  );
}

async function openSettings(): Promise<void> {
  const button = await screen.findByRole("button", { name: "Settings" });
  await waitFor(() => {
    fireEvent.click(button);
    assert.ok(
      screen.queryByTestId("settings-search"),
      "the Session settings tab did not open",
    );
  });
}

function subtabButton(id: string): HTMLElement {
  const descriptor = SETTINGS_SUBTABS.find((subtab) => subtab.id === id);
  assert.ok(descriptor, `no such subtab: ${id}`);
  return within(
    screen.getByRole("toolbar", { name: "Session settings sections" }),
  ).getByRole("button", { name: descriptor.label });
}

/** Open the bin through the settings row, which is its registered entry point. */
async function openBinFromSettings(): Promise<HTMLElement> {
  await openSettings();
  fireEvent.click(subtabButton("general"));
  await waitFor(() =>
    assert.equal(subtabButton("general").getAttribute("data-active"), "true"),
  );
  fireEvent.click(await screen.findByTestId("open-recycle-bin"));
  return screen.findByTestId("recycle-bin");
}

function binRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="recycle-bin-row"]'),
  );
}

function binRow(entryId: string): HTMLElement {
  const found = binRows().find((row) => row.dataset.entryId === entryId);
  assert.ok(found, `the bin does not list an entry ${entryId}`);
  return found;
}

// ── Deleting ────────────────────────────────────────────────────────────────

test("a binned delete retains the record instead of destroying it", async () => {
  // The configured window and bin size are set to something other than their
  // defaults, so the assertions below are evidence the two settings are read
  // rather than evidence the defaults happen to match.
  storageManager.setRecycleBinEnabled(true);
  storageManager.setRecycleBinRetentionDays(90);
  storageManager.setRecycleBinMaxEntries(250);
  storageManager.setRecordTags(ZONE.id, "rec-a", ["prod", "edge"]);

  const harness = await renderManager({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bin.test",
        content: "1.1.1.1",
      }),
    ],
  });
  await deleteFirstRowFromMenu();

  const retains = await waitFor(() => {
    const calls = harness.calls(RETENTION_COMMANDS.retain);
    assert.equal(calls.length, 1, "the delete must retain exactly once");
    return calls;
  });
  assert.deepEqual(retains[0].args, {
    apiKey: "bin-key",
    email: "owner@bin.test",
    zoneId: ZONE.id,
    zoneName: ZONE.name,
    recordId: "rec-a",
    record: {
      type: "A",
      name: "a.bin.test",
      content: "1.1.1.1",
      ttl: 300,
      proxied: false,
    },
    reason: "deleted",
    retentionDays: 90,
    // Read before the call, because the id they are keyed by dies in it.
    localTags: ["prod", "edge"],
    maxEntries: 250,
  });

  // The whole point: the destructive commands are never reached. A path that
  // deleted and then retained would pass every other assertion here.
  assert.deepEqual(
    harness.deletedRecordIds,
    [],
    "a binned delete must not call delete_dns_record — the record would be destroyed before any copy existed",
  );
  assert.deepEqual(harness.bulkDeleteCalls, []);

  await waitFor(() => assert.deepEqual(recordRowTexts(), []));
  assert.ok(await screen.findByText(/only copy is in the recycle bin/u));
});

test("with the bin off a delete destroys the record and retains nothing", async () => {
  storageManager.setRecycleBinEnabled(false);
  const harness = await renderManager({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bin.test",
        content: "1.1.1.1",
      }),
    ],
  });
  await deleteFirstRowFromMenu();

  await waitFor(() => assert.deepEqual(harness.deletedRecordIds, ["rec-a"]));
  assert.deepEqual(
    harness.calls(RETENTION_COMMANDS.retain),
    [],
    "with the bin off nothing may be kept — the setting says the deletion is final",
  );
  assert.ok(await screen.findByText("DNS record deleted successfully"));
});

test("a bulk delete keeps a copy of each record and never bulk-deletes", async () => {
  storageManager.setRecycleBinEnabled(true);
  const harness = await renderManager({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bin.test",
        content: "1.1.1.1",
      }),
      record({
        id: "rec-b",
        type: "A",
        name: "b.bin.test",
        content: "2.2.2.2",
      }),
    ],
  });
  await selectAllRecords(2);
  await confirmBulkDelete(2);

  await waitFor(() =>
    assert.equal(harness.calls(RETENTION_COMMANDS.retain).length, 2),
  );
  assert.deepEqual(
    harness.calls(RETENTION_COMMANDS.retain).map((call) => call.args.recordId),
    ["rec-a", "rec-b"],
  );
  // `delete_bulk_dns_records` deletes without keeping anything, so the binned
  // path cannot use it however many records are selected.
  assert.deepEqual(harness.bulkDeleteCalls, []);
  assert.deepEqual(harness.deletedRecordIds, []);
  await waitFor(() => assert.deepEqual(recordRowTexts(), []));
});

// ── A store with no room ────────────────────────────────────────────────────

const STORE_FULL: RetainDecision = {
  status: "store_full",
  held: 1000,
  protected: 7,
  bytesHeld: 1_499_000,
  maxBytes: RETENTION_LIMITS.storeBytes,
  maxEntries: 1000,
  purged: 0,
};

test("a full store leaves the record live and offers the ways out", async () => {
  const harness = await renderManager({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bin.test",
        content: "1.1.1.1",
      }),
    ],
    retain: [STORE_FULL],
  });
  await deleteFirstRowFromMenu();

  const dialog = await screen.findByTestId("recycle-bin-full");
  // Not a success and not a crash: the record is where it was.
  assert.match(dialog.textContent ?? "", /Nothing happened/u);
  assert.match(
    dialog.textContent ?? "",
    /still live at Cloudflare and still resolving/u,
  );
  assert.match(dialog.textContent ?? "", /no copy was kept/u);
  assert.match(
    screen.getByTestId("recycle-bin-full-usage").textContent ?? "",
    /Holding 1000 of 1000 entries/u,
  );
  assert.match(
    screen.getByTestId("recycle-bin-full-usage").textContent ?? "",
    /7 of them are disabled records/u,
  );
  // Make room, empty it, or give the copy up — all three, named.
  assert.ok(
    within(dialog).getByRole("button", {
      name: /forget what I no longer need/u,
    }),
  );
  assert.ok(
    within(dialog).getByRole("button", { name: /Empty the whole bin/u }),
  );
  assert.ok(
    within(dialog).getByRole("button", {
      name: /Delete without keeping a copy/u,
    }),
  );

  // Nothing was deleted, so the row is still there.
  assert.deepEqual(harness.deletedRecordIds, []);
  assert.equal(recordRowTexts().length, 1);
});

test("the full-store dialog can delete without keeping a copy, having said so", async () => {
  const harness = await renderManager({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bin.test",
        content: "1.1.1.1",
      }),
    ],
    retain: [STORE_FULL],
  });
  await deleteFirstRowFromMenu();

  const dialog = await screen.findByTestId("recycle-bin-full");
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: /Delete without keeping a copy/u,
    }),
  );

  await waitFor(() => assert.deepEqual(harness.deletedRecordIds, ["rec-a"]));
  assert.ok(await screen.findByText(/no copy kept\. They cannot be restored/u));
  await waitFor(() => assert.deepEqual(recordRowTexts(), []));
});

test("the full-store dialog can empty the bin and try the retain again", async () => {
  const harness = await renderManager({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bin.test",
        content: "1.1.1.1",
      }),
    ],
    entries: [storedEntry()],
    retain: [
      STORE_FULL,
      {
        status: "retained",
        entryId: "entry-retry",
        expiresAt: "2026-11-01T00:00:00Z",
        purged: 0,
        evicted: 0,
      },
    ],
  });
  await deleteFirstRowFromMenu();

  const dialog = await screen.findByTestId("recycle-bin-full");
  fireEvent.click(
    within(dialog).getByRole("button", { name: /Empty the whole bin/u }),
  );

  await waitFor(() =>
    assert.equal(harness.calls(RETENTION_COMMANDS.clear).length, 1),
  );
  await waitFor(() =>
    assert.equal(harness.calls(RETENTION_COMMANDS.retain).length, 2),
  );
  assert.deepEqual(harness.deletedRecordIds, []);
  await waitFor(() => assert.deepEqual(recordRowTexts(), []));
});

// ── Disabling ───────────────────────────────────────────────────────────────

async function openDisableConfirm(): Promise<HTMLElement> {
  await selectAllRecords(1);
  fireEvent.click(screen.getByRole("button", { name: "Disable" }));
  return screen.findByTestId("disable-record-confirm");
}

test("the disable confirmation says what Cloudflare actually does", async () => {
  await renderManager({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bin.test",
        content: "1.1.1.1",
      }),
    ],
  });
  const dialog = await openDisableConfirm();
  const copy = dialog.textContent ?? "";

  // There is no dormant record in the zone, and the dialog has to say so.
  assert.match(copy, /Cloudflare has no disabled state for a DNS record/u);
  assert.match(
    copy,
    /deleting it from Cloudflare and keeping the only copy in this app/u,
  );
  assert.match(copy, /stops resolving immediately/u);
  assert.match(copy, /disappears from dig and from the Cloudflare dashboard/u);
  assert.match(copy, /record id is gone for good/u);
  assert.match(
    copy,
    /If this app's store is lost, the record is lost with it/u,
  );
  assert.match(copy, /backup, not a toggle/u);
  assert.match(copy, /kept indefinitely/u);
  // The losses come from the contract, not from a second hand-written list.
  const losses = screen.getByTestId("disable-record-losses");
  assert.deepEqual(
    Array.from(losses.querySelectorAll("li")).map(
      (item) => item.textContent ?? "",
    ),
    [...RETAINED_FIELD_LOSSES],
  );
  assert.match(copy, /A a\.bin\.test/u);
});

test("a confirmed disable is retained indefinitely, with no expiry", async () => {
  const harness = await renderManager({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bin.test",
        content: "1.1.1.1",
      }),
    ],
  });
  const dialog = await openDisableConfirm();
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: /Delete from Cloudflare, keep the only copy/u,
    }),
  );

  const retains = await waitFor(() => {
    const calls = harness.calls(RETENTION_COMMANDS.retain);
    assert.equal(calls.length, 1);
    return calls;
  });
  assert.equal(retains[0].args.reason, "disabled");
  // A disable that expired would be a disable that deleted the record while
  // the user was not looking.
  assert.equal(
    retains[0].args.retentionDays,
    undefined,
    "a disable must carry no retention window whatever the bin is set to",
  );
  assert.deepEqual(harness.deletedRecordIds, []);
  await waitFor(() => assert.deepEqual(recordRowTexts(), []));
  assert.ok(await screen.findByText(/kept here indefinitely/u));
});

test("cancelling a disable leaves the record resolving", async () => {
  const harness = await renderManager({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bin.test",
        content: "1.1.1.1",
      }),
    ],
  });
  const dialog = await openDisableConfirm();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Keep it resolving" }),
  );

  await waitFor(() =>
    assert.ok(
      screen.queryByTestId("disable-record-confirm") === null,
      "the confirmation must close",
    ),
  );
  assert.deepEqual(harness.calls(RETENTION_COMMANDS.retain), []);
  assert.deepEqual(harness.deletedRecordIds, []);
  assert.equal(recordRowTexts().length, 1);
});

// ── The bin view ────────────────────────────────────────────────────────────

test("the bin lists what is kept, and reading it never purges", async () => {
  storageManager.setRecycleBinAutoPurge(false);
  const harness = await renderManager({
    entries: [
      storedEntry({ entry_id: "entry-deleted", local_tags: ["prod"] }),
      storedEntry({
        entry_id: "entry-disabled",
        reason: "disabled",
        type: "MX",
        name: "mail.bin.test",
        content: "mx.bin.test",
        expires_at: undefined,
      }),
    ],
    expiredPendingPurge: 3,
  });
  const dialog = await openBinFromSettings();

  // The honest framing: a disabled record is absent from the zone, not parked.
  assert.match(dialog.textContent ?? "", /not parked at Cloudflare/u);
  assert.equal(binRows().length, 2);

  const deleted = binRow("entry-deleted");
  assert.match(deleted.textContent ?? "", /Deleted/u);
  assert.match(deleted.textContent ?? "", /A a\.bin\.test/u);
  assert.match(deleted.textContent ?? "", /day\(s\) left/u);
  assert.match(
    deleted.textContent ?? "",
    /Tags, re-attached on restore: prod/u,
  );
  assert.ok(within(deleted).getByRole("button", { name: /Restore/u }));

  const disabled = binRow("entry-disabled");
  assert.match(disabled.textContent ?? "", /Disabled/u);
  // No expiry, and the word for putting one back is not "restore".
  assert.match(
    disabled.textContent ?? "",
    /No expiry: kept until you forget it/u,
  );
  assert.ok(within(disabled).getByRole("button", { name: /Re-enable/u }));

  const summary = screen.getByTestId("recycle-bin-summary").textContent ?? "";
  assert.match(summary, /5 of 1000 entries/u);
  assert.match(summary, /3 expired and not listed/u);
  // With the sweep off, opening the bin must not throw anything away.
  assert.deepEqual(
    harness.calls(RETENTION_COMMANDS.purge),
    [],
    "reading the bin must never purge",
  );

  // Asked for, it sweeps.
  fireEvent.click(screen.getByRole("button", { name: "Sweep expired" }));
  await waitFor(() =>
    assert.equal(harness.calls(RETENTION_COMMANDS.purge).length, 1),
  );
  assert.ok(await screen.findByText(/3 expired entr\(ies\) removed/u));
});

test("with the sweep on, opening the bin clears the expired entries", async () => {
  storageManager.setRecycleBinAutoPurge(true);
  const harness = await renderManager({
    entries: [storedEntry()],
    expiredPendingPurge: 2,
  });
  await openBinFromSettings();

  await waitFor(() =>
    assert.equal(harness.calls(RETENTION_COMMANDS.purge).length, 1),
  );
  // And the list is read again afterwards, so the count on screen is the one
  // the sweep left behind rather than the one that prompted it.
  await waitFor(() =>
    assert.ok(
      !(screen.getByTestId("recycle-bin-summary").textContent ?? "").includes(
        "expired and not listed",
      ),
    ),
  );
});

test("forgetting an entry and emptying the bin both need a second click", async () => {
  const harness = await renderManager({
    entries: [
      storedEntry({ entry_id: "entry-a" }),
      storedEntry({ entry_id: "entry-b" }),
    ],
  });
  await openBinFromSettings();

  // One click arms it; nothing has been dropped yet.
  fireEvent.click(
    within(binRow("entry-a")).getByRole("button", { name: /Forget/u }),
  );
  assert.deepEqual(harness.calls(RETENTION_COMMANDS.forget), []);
  fireEvent.click(
    await within(binRow("entry-a")).findByRole("button", {
      name: /Confirm: forget for good/u,
    }),
  );
  await waitFor(() =>
    assert.equal(harness.calls(RETENTION_COMMANDS.forget).length, 1),
  );
  assert.ok(await screen.findByText(/existed nowhere but here/u));
  await waitFor(() => assert.equal(binRows().length, 1));

  fireEvent.click(screen.getByRole("button", { name: /Empty the bin/u }));
  assert.deepEqual(harness.calls(RETENTION_COMMANDS.clear), []);
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Confirm: empty the bin for good/u,
    }),
  );
  await waitFor(() =>
    assert.equal(harness.calls(RETENTION_COMMANDS.clear).length, 1),
  );
  await waitFor(() => assert.ok(screen.queryByTestId("recycle-bin-empty")));
});

// ── Restoring ───────────────────────────────────────────────────────────────

test("delete, restore, and the record is back in the table with its tags", async () => {
  // The whole round trip, driven the way a user hits it: the delete toast's
  // own action opens the bin, so the zone tab stays active and the restored
  // record has somewhere visible to land.
  storageManager.setRecordTags(ZONE.id, "rec-a", ["prod", "edge"]);
  const harness = await renderManager({
    records: [
      record({
        id: "rec-a",
        type: "A",
        name: "a.bin.test",
        content: "1.1.1.1",
      }),
    ],
    entries: [storedEntry({ local_tags: ["prod", "edge"] })],
    restore: [
      {
        ...RESTORED,
        localTags: ["prod", "edge"],
        sharesNameWith: [
          {
            recordId: "other-rec",
            type: "A",
            name: "a.bin.test",
            content: "9.9.9.9",
          },
        ],
      },
    ],
  });

  await deleteFirstRowFromMenu();
  await waitFor(() => assert.deepEqual(recordRowTexts(), []));
  assert.deepEqual(harness.deletedRecordIds, []);

  fireEvent.click(await screen.findByRole("button", { name: "Recycle bin" }));
  await screen.findByTestId("recycle-bin");
  fireEvent.click(
    within(binRow("entry-a")).getByRole("button", { name: /Restore/u }),
  );

  await screen.findByText(/Restored A a\.bin\.test/u);
  const toast = await screen.findByText(
    /new record id \(restored-rec\); the id it had before is gone for good/u,
  );
  assert.match(toast.textContent ?? "", /2 tag\(s\) re-attached/u);
  assert.match(
    toast.textContent ?? "",
    /alongside 1 other record\(s\) at this name/u,
  );
  // The tags were keyed by an id that died with the record, so the restore is
  // the only moment they could have been moved.
  assert.deepEqual(storageManager.getRecordTags(ZONE.id, "restored-rec"), [
    "prod",
    "edge",
  ]);

  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => {
    const rows = recordRowTexts();
    assert.equal(rows.length, 1, "the restored record must be in the table");
    assert.match(rows[0], /a\.bin\.test/u);
  });
});

test("a re-enable is reported as a re-enable, not as a restore", async () => {
  await renderManager({
    entries: [storedEntry({ reason: "disabled", expires_at: undefined })],
  });
  await openBinFromSettings();
  fireEvent.click(
    within(binRow("entry-a")).getByRole("button", { name: /Re-enable/u }),
  );

  assert.ok(await screen.findByText(/Re-enabled A a\.bin\.test/u));
});

test("every way a restore can end is reported in its own words", async () => {
  // Each of these leaves the entry in the bin, so one render drives them all,
  // in order, on the same entry. A flat "restore failed" would pass none of
  // the assertions below, which is the point: the command distinguishes nine
  // endings and four of them mean "try again, nothing is lost".
  const existing = {
    recordId: "live-rec",
    type: "A",
    name: "a.bin.test",
    content: "9.9.9.9",
  };
  const script: Array<[RestoreOutcome, RegExp]> = [
    [
      {
        status: "blocked",
        entryId: "entry-a",
        obstacle: "already_present",
        existing,
      },
      /already exists at Cloudflare \(A a\.bin\.test → 9\.9\.9\.9\)/u,
    ],
    [
      {
        status: "blocked",
        entryId: "entry-a",
        obstacle: "cname_collision",
        existing,
      },
      /A CNAME at this name cannot coexist/u,
    ],
    [
      {
        status: "blocked",
        entryId: "entry-a",
        obstacle: "zone_locked",
        existing,
      },
      /in the way of A a\.bin\.test \(zone_locked/u,
    ],
    [
      {
        status: "zone_unavailable",
        entryId: "entry-a",
        zoneId: ZONE.id,
        message: "502 from Cloudflare",
      },
      // The entry survives a zone outage, and the user has to be told that.
      /Nothing was lost.*still in the recycle bin and still restorable/u,
    ],
    [
      {
        status: "provider_refused",
        entryId: "entry-a",
        message: "content for A record is invalid",
      },
      /Cloudflare would not create A a\.bin\.test: content for A record is invalid/u,
    ],
    [
      {
        status: "invalid",
        entryId: "entry-a",
        issues: ["name is not in zone"],
      },
      /cannot be created as it stands: name is not in zone/u,
    ],
    [
      { status: "incomplete", entryId: "entry-a", missing: ["type", "name"] },
      /missing type, name, so it cannot be re-created/u,
    ],
    [
      {
        status: "expired",
        entryId: "entry-a",
        expiresAt: "2026-09-30T00:00:00Z",
      },
      /only kept until 2026-09-30T00:00:00Z and can no longer be restored/u,
    ],
    [
      { status: "not_found", entryId: "entry-a" },
      /no longer an entry for A a\.bin\.test/u,
    ],
  ];

  await renderManager({
    entries: [storedEntry()],
    restore: script.map(([outcome]) => outcome),
  });
  await openBinFromSettings();

  const restoreButton = (): HTMLElement =>
    within(binRow("entry-a")).getByRole("button", { name: /Restore/u });

  for (const [, expected] of script) {
    // Re-queried immediately before the click: each attempt re-reads the list,
    // which replaces the row's DOM node and leaves the button briefly
    // disabled while the call is in flight.
    await waitFor(() =>
      assert.equal(restoreButton().hasAttribute("disabled"), false),
    );
    fireEvent.click(restoreButton());
    await screen.findByText(expected);
  }
});
