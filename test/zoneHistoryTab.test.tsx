/**
 * The zone History subtab.
 *
 * What is pinned here is the thing this feature is easiest to get wrong, and
 * which `src/lib/history/types.ts` exists to warn about: **history reaches
 * further back than undo does.** A change can be in the trail and have no
 * snapshot left to restore from, and the subtab's job in that case is to keep
 * the row and say why in words. So the claims below are mostly about what the
 * screen *says*, not about what it disables:
 *
 *  - a row whose snapshot expired is present, carries a sentence naming the
 *    expiry date, and offers no undo control at all — a disabled button with
 *    no explanation is how a user concludes the feature is broken, so the
 *    absence of the control is asserted together with the presence of the
 *    reason, and neither is accepted on its own;
 *  - `changesOmitted` is printed on the row it belongs to, because the trail
 *    dropped part of that change set and the row is therefore not the whole
 *    truth;
 *  - `truncated` is printed on the operation, for the same reason one level up;
 *  - the first paint asks for exactly one `ZONE_HISTORY_PAGE_SIZE` page with no
 *    cursor, and the second asks from the oldest row loaded — a subtab that
 *    fetched the whole trail would be invisible in a test that only counted
 *    rows;
 *  - a row-level undo scopes the dialog to that row. This is the prop that
 *    silently turns one record's undo into thirty-seven, so it is asserted on
 *    the props the dialog actually receives rather than on a click not
 *    throwing.
 *
 * Two local conventions, both learned the hard way in this repo:
 *
 * Absence is `assert.ok(node === null, …)`, never `assert.equal(node, null)`.
 * The latter serialises the whole jsdom tree to build its diff and takes the
 * worker — and the rest of the batch — with it instead of failing.
 *
 * Every wait is on the node the assertion then reads, never on a container
 * that an earlier state also rendered. `zone-history-panel` is present while
 * loading, so awaiting it and then reading inside would pass on a spinner.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import ts from "typescript";
import { afterEach, beforeEach, mock, test } from "node:test";
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
import { Toaster } from "../src/components/ui/toaster";
import { resetToastRuntimeForTests } from "../src/hooks/use-toast";
import { storageManager } from "../src/lib/storage/storage";
import {
  ZONE_HISTORY_CHANGE_PREVIEW_LIMIT,
  ZONE_HISTORY_ENTRY_PREVIEW_LIMIT,
  ZoneHistoryTab,
  describeUndoAvailability,
  describeUndoRefusal,
  findCommonChange,
  formatOperationLabel,
  normalizeOperationName,
  undoableEntryIds,
  type ZoneHistoryTabProps,
  type ZoneHistoryUndoDialogProps,
} from "../src/components/dns/ZoneHistoryTab";
import {
  planUndoRows,
  repointPairedDnsOp,
  runUndoPlan,
  type DNSLeafOp,
} from "../src/components/dns/DNSManager";
import {
  TauriClient,
  type McpServerStatus,
  type TauriDNSRecord,
  type TauriZone,
} from "../src/lib/api/tauri-client";
import {
  ZONE_HISTORY_PAGE_SIZE,
  type HistoryChangeKind,
  type RetainedRecordSnapshot,
  type UndoAvailability,
  type UndoPlanRow,
  type UndoRefusalCode,
  type UndoResult,
  type UndoRowDrift,
  type ZoneHistoryEntry,
  type ZoneHistoryOperation,
} from "../src/lib/history/types";
import type { DNSRecord } from "../src/types/dns";
import i18n from "../src/i18n";

import { useEnglishLocale } from "./i18n-ready";
import { enableThemedSelectEnvironment } from "./radix-select";

const ZONE_ID = "history-zone";
const ZONE_NAME = "history.test";
const API_KEY = "history-key";
const EMAIL = "owner@history.test";

/** The bound `t`, so expectations are built from the same strings the UI is. */
const t = i18n.t.bind(i18n);

interface EntryOptions {
  id?: string;
  recordName?: string;
  recordType?: string;
  kind?: HistoryChangeKind;
  changes?: ZoneHistoryEntry["changes"];
  changesOmitted?: boolean;
  undo?: UndoAvailability;
}

function entry(operationId: string, options: EntryOptions = {}) {
  const id = options.id ?? `${operationId}-entry`;
  return {
    id,
    operationId,
    kind: options.kind ?? "updated",
    recordType: options.recordType ?? "A",
    recordName: options.recordName ?? `${id}.${ZONE_NAME}`,
    recordId: options.kind === "deleted" ? null : `${id}-record`,
    changes:
      options.changes ?? ([{ field: "ttl", from: "3600", to: "300" }] as const),
    changesOmitted: options.changesOmitted ?? false,
    undo: options.undo ?? ({ state: "available" } as const),
  } satisfies ZoneHistoryEntry;
}

interface OperationOptions {
  operationId?: string;
  operation?: string;
  actor?: ZoneHistoryOperation["actor"];
  outcome?: ZoneHistoryOperation["outcome"];
  at?: string;
  entries?: readonly ZoneHistoryEntry[];
  truncated?: boolean;
}

function operation(options: OperationOptions = {}): ZoneHistoryOperation {
  const operationId = options.operationId ?? "op-1";
  return {
    operationId,
    zoneId: ZONE_ID,
    operation: options.operation ?? "dns:bulk_update",
    actor: options.actor ?? "user",
    outcome: options.outcome ?? "ok",
    at: options.at ?? "2026-10-09T14:02:00.000Z",
    entries: options.entries ?? [entry(operationId)],
    truncated: options.truncated ?? false,
  } satisfies ZoneHistoryOperation;
}

interface ListCall {
  zoneId: string;
  options: { before?: string; limit?: number };
}

/**
 * Serve the history list from a queue of pages.
 *
 * A queue rather than a single value, because paging is one of the claims:
 * the second call has to be able to return something different from the first,
 * and an exhausted queue returning `[]` is what "no more pages" looks like.
 */
function mockHistory(pages: readonly ZoneHistoryOperation[][]): ListCall[] {
  const calls: ListCall[] = [];
  const queue = pages.map((page) => [...page]);
  mock.method(
    TauriClient,
    "listZoneHistory",
    async (zoneId: string, options: ListCall["options"] = {}) => {
      calls.push({ zoneId, options });
      return queue.shift() ?? [];
    },
  );
  return calls;
}

function mockHistoryFailure(message: string): void {
  mock.method(TauriClient, "listZoneHistory", async () => {
    throw new Error(message);
  });
}

/** Records every set of props the tab hands the undo dialog. */
function recordingDialog(seen: ZoneHistoryUndoDialogProps[]) {
  return function Dialog(props: ZoneHistoryUndoDialogProps) {
    seen.push(props);
    return <div data-testid="undo-dialog-stub" />;
  };
}

function snapshot(
  overrides: Partial<RetainedRecordSnapshot> = {},
): RetainedRecordSnapshot {
  return {
    recordType: "A",
    name: `a.${ZONE_NAME}`,
    content: "1.1.1.1",
    ttl: 300,
    priority: null,
    proxied: false,
    comment: null,
    tags: [],
    ...overrides,
  };
}

function planRow(overrides: Partial<UndoPlanRow> = {}): UndoPlanRow {
  return {
    entryId: "row",
    recordType: "A",
    recordName: `a.${ZONE_NAME}`,
    target: snapshot(),
    drift: { state: "unchanged" } as UndoRowDrift,
    selectedByDefault: true,
    ...overrides,
  };
}

function liveRecord(overrides: Partial<DNSRecord> = {}): DNSRecord {
  return {
    id: "live-1",
    type: "A",
    name: `a.${ZONE_NAME}`,
    content: "9.9.9.9",
    ttl: 60,
    proxied: true,
    zone_id: ZONE_ID,
    zone_name: ZONE_NAME,
    created_on: "2026-09-01T10:00:00Z",
    modified_on: "2026-09-02T10:00:00Z",
    ...overrides,
  };
}

interface ApplyCall {
  zoneId: string;
  rows: readonly UndoPlanRow[];
}

/**
 * Stand in for `DNSManager`'s applier.
 *
 * The real one writes through the `DNSOp` engine; what the tab owes it is the
 * zone and the confirmed rows, and what it owes the tab is a result or a
 * rejection. Both directions are what the tests below measure.
 */
function recordingApplier(
  calls: ApplyCall[],
  outcome: UndoResult | Error = {
    operationId: "local-undo",
    applied: 1,
    skipped: 0,
    failed: [],
  },
) {
  return async (zoneId: string, rows: readonly UndoPlanRow[]) => {
    calls.push({ zoneId, rows });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
}

function renderTab(
  undoDialog?: (props: ZoneHistoryUndoDialogProps) => React.ReactElement,
  applyUndoRows: ZoneHistoryTabProps["applyUndoRows"] = recordingApplier([]),
) {
  render(
    <ZoneHistoryTab
      zoneId={ZONE_ID}
      zoneName={ZONE_NAME}
      apiKey={API_KEY}
      email={EMAIL}
      applyUndoRows={applyUndoRows}
      undoDialog={undoDialog}
    />,
  );
}

beforeEach(async () => {
  // The tab is desktop-only; without the bridge probe it renders the notice
  // and never calls the host, which is its own test below.
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  await useEnglishLocale();
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  clearMocks();
  resetToastRuntimeForTests();
  storageManager.clearSettings();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

// ── Formatting, on its own ──────────────────────────────────────────────────

test("an operation name is read the same whether the trail namespaces it or suffixes it", () => {
  assert.equal(normalizeOperationName("dns:bulk_update"), "bulk_update");
  assert.equal(normalizeOperationName("update_dns_record"), "update");
  assert.equal(normalizeOperationName("delete_dns_records"), "delete");
  assert.equal(normalizeOperationName("DNS:Update"), "update");

  assert.equal(formatOperationLabel("dns:bulk_update", t), "Bulk edit");
  assert.equal(formatOperationLabel("update_dns_record", t), "Edit");
  assert.equal(formatOperationLabel("dns:delete", t), "Delete");
  // An unmapped verb is humanised rather than dropped: a write command added
  // after this map must still be visible the day it ships.
  assert.equal(formatOperationLabel("dns:purge_cache", t), "Purge cache");
  assert.equal(formatOperationLabel("", t), "Change");
});

test("an operation headline is only claimed when every row agrees with it", () => {
  const same = [
    entry("op", {
      id: "a",
      changes: [{ field: "ttl", from: "3600", to: "300" }],
    }),
    entry("op", {
      id: "b",
      changes: [{ field: "ttl", from: "1800", to: "300" }],
    }),
  ];
  assert.deepEqual(findCommonChange(same), { field: "ttl", to: "300" });

  const differentTarget = [
    same[0]!,
    entry("op", {
      id: "c",
      changes: [{ field: "ttl", from: "60", to: "600" }],
    }),
  ];
  assert.equal(findCommonChange(differentTarget), null);

  const differentField = [
    same[0]!,
    entry("op", {
      id: "d",
      changes: [{ field: "content", from: "1.1.1.1", to: "300" }],
    }),
  ];
  assert.equal(findCommonChange(differentField), null);

  // A row that changed two fields has no single headline to contribute.
  const twoFields = [
    entry("op", {
      id: "e",
      changes: [
        { field: "ttl", from: "3600", to: "300" },
        { field: "content", from: "1.1.1.1", to: "2.2.2.2" },
      ],
    }),
  ];
  assert.equal(findCommonChange(twoFields), null);
  assert.equal(findCommonChange([]), null);
});

test("every unavailable state produces a sentence, and only the available one produces none", () => {
  assert.equal(describeUndoAvailability({ state: "available" }, t), null);

  const states: UndoAvailability[] = [
    { state: "expired", expiredAt: "2026-03-03T09:00:00.000Z" },
    { state: "evicted" },
    { state: "no-snapshot" },
    { state: "superseded-by-delete" },
    { state: "not-undoable", reason: "cache-purge" },
  ];
  for (const state of states) {
    const sentence = describeUndoAvailability(state, t);
    assert.ok(
      typeof sentence === "string" && sentence.length > 0,
      `${state.state} produced no sentence`,
    );
    // Only the hyphenated states are checked for a leaked identifier:
    // "expired" and "evicted" are the ordinary English words for what
    // happened, so their appearance is the sentence working, not a token
    // escaping into it.
    if (state.state.includes("-")) {
      assert.ok(
        !sentence.includes(state.state),
        `${state.state} leaked its identifier into the sentence: ${sentence}`,
      );
    }
    assert.ok(
      sentence.endsWith(".") || sentence.endsWith("…"),
      `${state.state} is not a sentence: ${sentence}`,
    );
  }

  // The expiry date is the whole point of the expired branch: it is what tells
  // the user the copy is gone for good rather than momentarily unavailable.
  const expired = describeUndoAvailability(
    { state: "expired", expiredAt: "2026-03-03T09:00:00.000Z" },
    t,
  );
  assert.ok(expired !== null);
  assert.ok(
    expired.includes("March"),
    `the expiry sentence names no date: ${expired}`,
  );
  // `not-undoable` delegates to the refusal wording, which is pinned below.
  assert.equal(
    describeUndoAvailability({ state: "not-undoable", reason: "dnssec" }, t),
    describeUndoRefusal("dnssec", t),
  );
});

/**
 * Every refusal code becomes a sentence, and the code never reaches the screen.
 *
 * This is the rule `src/lib/history/types.ts` sets for the whole feature — a
 * reason this app decides travels as a code and the renderer turns it into a
 * literal `t()` call — and it is checked here rather than trusted, because the
 * failure mode is invisible: interpolating the code into a frame renders
 * `cache-purge` in every locale, English included, while the coverage report
 * stays green. Each code is also required to read differently from the others,
 * since six codes sharing one sentence would pass every check above while
 * telling the user nothing.
 */
test("every refusal code produces its own sentence, and none leaks its identifier", () => {
  const codes: UndoRefusalCode[] = [
    "stale-record-list",
    "zone-setting",
    "cache-purge",
    "dnssec",
    "manifest-truncated",
    "summary-entry-only",
  ];
  const seen = new Set<string>();
  for (const code of codes) {
    const sentence = describeUndoRefusal(code, t);
    assert.ok(sentence.length > 0, `${code} produced no sentence`);
    assert.ok(
      !sentence.includes(code),
      `${code} leaked its identifier into the sentence: ${sentence}`,
    );
    assert.ok(sentence.endsWith("."), `${code} is not a sentence: ${sentence}`);
    assert.ok(!seen.has(sentence), `${code} reuses another code's sentence`);
    seen.add(sentence);
  }
  // The stale-list refusal is the only one a user can act on, so it has to say
  // what to do rather than only what went wrong.
  assert.ok(
    describeUndoRefusal("stale-record-list", t).includes("Refresh"),
    "the stale-list refusal names no fix",
  );
});

test("only rows with a snapshot are offered to an undo", () => {
  const op = operation({
    entries: [
      entry("op-1", { id: "keep" }),
      entry("op-1", { id: "gone", undo: { state: "evicted" } }),
    ],
  });
  assert.deepEqual(undoableEntryIds(op), ["keep"]);
  assert.deepEqual(
    undoableEntryIds(
      operation({
        entries: [entry("op-1", { id: "x", undo: { state: "no-snapshot" } })],
      }),
    ),
    [],
  );
});

// ── The list ────────────────────────────────────────────────────────────────

test("the first paint asks for one page and no cursor, and lists operations in the order given", async () => {
  const calls = mockHistory([
    [
      operation({ operationId: "newer", at: "2026-10-09T14:02:00.000Z" }),
      operation({ operationId: "older", at: "2026-10-09T13:12:00.000Z" }),
    ],
  ]);
  renderTab();

  const list = await screen.findByTestId("zone-history-list");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    zoneId: ZONE_ID,
    options: { limit: ZONE_HISTORY_PAGE_SIZE },
  });

  const rendered = Array.from(
    list.querySelectorAll("[data-testid^='zone-history-operation-']"),
  ).map((node) => node.getAttribute("data-testid"));
  assert.deepEqual(rendered, [
    "zone-history-operation-newer",
    "zone-history-operation-older",
  ]);
});

test("an empty trail says so by name, and a failure says why and offers a retry", async () => {
  mockHistory([[]]);
  renderTab();
  const empty = await screen.findByTestId("zone-history-empty");
  assert.ok(empty.textContent?.includes(ZONE_NAME));
  assert.ok(
    screen.queryByTestId("zone-history-list") === null,
    "an empty trail rendered a list",
  );

  cleanup();
  mock.restoreAll();
  mockHistoryFailure("the trail is locked");
  renderTab();
  const failure = await screen.findByTestId("zone-history-error");
  assert.ok(failure.textContent?.includes("the trail is locked"));
});

test("the records a change touched are rendered only once it is opened", async () => {
  mockHistory([[operation({ entries: [entry("op-1", { id: "row-a" })] })]]);
  renderTab();

  const toggle = await screen.findByTestId("zone-history-toggle-op-1");
  assert.ok(
    screen.queryByTestId("zone-history-entry-row-a") === null,
    "a collapsed operation rendered its record rows",
  );

  fireEvent.click(toggle);
  const row = await screen.findByTestId("zone-history-entry-row-a");
  assert.ok(row.textContent?.includes("row-a"));
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  fireEvent.click(toggle);
  assert.ok(
    screen.queryByTestId("zone-history-entry-row-a") === null,
    "a re-collapsed operation kept its record rows",
  );
});

test("a change set the trail could not record whole says so on the row and on the operation", async () => {
  mockHistory([
    [
      operation({
        truncated: true,
        entries: [entry("op-1", { id: "clipped", changesOmitted: true })],
      }),
    ],
  ]);
  renderTab();

  const truncated = await screen.findByTestId("zone-history-truncated-op-1");
  assert.ok(truncated.textContent && truncated.textContent.length > 0);

  fireEvent.click(screen.getByTestId("zone-history-toggle-op-1"));
  const omitted = await screen.findByTestId(
    "zone-history-entry-omitted-clipped",
  );
  assert.ok(
    omitted.textContent?.includes("not recorded"),
    `the omission is not stated: ${omitted.textContent}`,
  );
});

test("only the first few fields of a row are printed, and the rest are counted", async () => {
  const changes = Array.from(
    { length: ZONE_HISTORY_CHANGE_PREVIEW_LIMIT + 2 },
    (_, index) => ({
      field: `field${index}`,
      from: `from${index}`,
      to: `to${index}`,
    }),
  );
  mockHistory([
    [operation({ entries: [entry("op-1", { id: "wide", changes })] })],
  ]);
  renderTab();

  fireEvent.click(await screen.findByTestId("zone-history-toggle-op-1"));
  const row = await screen.findByTestId("zone-history-entry-wide");
  assert.ok(row.textContent?.includes("field0"));
  assert.ok(
    !row.textContent?.includes(`field${ZONE_HISTORY_CHANGE_PREVIEW_LIMIT}`),
    "a row printed more fields than its preview limit",
  );
  assert.ok(row.textContent?.includes("2 more fields"));
});

// ── What cannot be undone ───────────────────────────────────────────────────

test("a row whose snapshot expired keeps its place, names the date, and offers no control", async () => {
  mockHistory([
    [
      operation({
        entries: [
          entry("op-1", { id: "live" }),
          entry("op-1", {
            id: "stale",
            undo: { state: "expired", expiredAt: "2026-03-03T09:00:00.000Z" },
          }),
        ],
      }),
    ],
  ]);
  renderTab();

  fireEvent.click(await screen.findByTestId("zone-history-toggle-op-1"));

  // The row is present, which is the claim: it is not filtered out for being
  // un-undoable.
  const stale = await screen.findByTestId("zone-history-entry-stale");
  assert.ok(stale.textContent?.includes("stale"));

  const reason = await screen.findByTestId("zone-history-entry-reason-stale");
  assert.ok(
    reason.textContent?.includes("March"),
    `the reason names no date: ${reason.textContent}`,
  );
  assert.ok(
    screen.queryByTestId("zone-history-entry-undo-stale") === null,
    "an un-undoable row offered an undo control",
  );

  // …and the measurement is sound, because the undoable row beside it does
  // carry one.
  assert.ok(screen.getByTestId("zone-history-entry-undo-live"));
});

test("an operation nothing can be undone from states the one shared reason and offers no undo", async () => {
  mockHistory([
    [
      operation({
        entries: [
          entry("op-1", { id: "a", undo: { state: "evicted" } }),
          entry("op-1", { id: "b", undo: { state: "evicted" } }),
        ],
      }),
    ],
  ]);
  renderTab();

  const reason = await screen.findByTestId(
    "zone-history-operation-reason-op-1",
  );
  assert.ok(
    reason.textContent?.includes("size limit"),
    `the shared reason is not stated: ${reason.textContent}`,
  );
  assert.ok(
    screen.queryByTestId("zone-history-undo-op-1") === null,
    "an operation with no restorable rows offered an undo",
  );
});

test("an operation only partly undoable keeps its undo and says how many rows it will skip", async () => {
  mockHistory([
    [
      operation({
        entries: [
          entry("op-1", { id: "a" }),
          entry("op-1", { id: "b", undo: { state: "no-snapshot" } }),
          entry("op-1", { id: "c", undo: { state: "superseded-by-delete" } }),
        ],
      }),
    ],
  ]);
  renderTab();

  const partial = await screen.findByTestId(
    "zone-history-operation-partial-op-1",
  );
  assert.ok(
    partial.textContent?.includes("2 of 3"),
    `the blocked count is wrong: ${partial.textContent}`,
  );
  assert.ok(screen.getByTestId("zone-history-undo-op-1"));
});

test("undoing a delete is offered as a restore, and undoing an edit as an undo", async () => {
  mockHistory([
    [
      operation({
        operationId: "del",
        operation: "dns:delete",
        entries: [
          entry("del", { id: "d1", kind: "deleted", recordName: "old.test" }),
        ],
      }),
      operation({
        operationId: "edit",
        entries: [entry("edit", { id: "e1" }), entry("edit", { id: "e2" })],
      }),
    ],
  ]);
  renderTab();

  const restore = await screen.findByTestId("zone-history-undo-del");
  assert.equal(restore.textContent?.trim(), "Restore");
  const undoAll = await screen.findByTestId("zone-history-undo-edit");
  assert.equal(undoAll.textContent?.trim(), "Undo all");
});

// ── Paging ──────────────────────────────────────────────────────────────────

test("a full page offers more, pages from the oldest row loaded, and appends", async () => {
  const first = Array.from({ length: ZONE_HISTORY_PAGE_SIZE }, (_, index) =>
    operation({
      operationId: `first-${index}`,
      at: new Date(Date.UTC(2026, 9, 9, 14, 0) - index * 60_000).toISOString(),
    }),
  );
  const oldest = first[first.length - 1]!;
  const second = [
    operation({ operationId: "second-0", at: "2026-10-08T09:00:00.000Z" }),
  ];

  const calls = mockHistory([first, second]);
  renderTab();

  const more = await screen.findByTestId("zone-history-load-more");
  fireEvent.click(more);

  const appended = await screen.findByTestId("zone-history-operation-second-0");
  assert.ok(appended.isConnected);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    zoneId: ZONE_ID,
    options: { before: oldest.at, limit: ZONE_HISTORY_PAGE_SIZE },
  });
  // The first page is still on screen: the second page appended rather than
  // replaced.
  assert.ok(screen.getByTestId("zone-history-operation-first-0"));
  // A short second page means there is nothing further to ask for.
  assert.ok(
    screen.queryByTestId("zone-history-load-more") === null,
    "a short page still offered to load more",
  );
});

test("a short first page never offers to load more", async () => {
  mockHistory([[operation()]]);
  renderTab();
  await screen.findByTestId("zone-history-operation-op-1");
  assert.ok(
    screen.queryByTestId("zone-history-load-more") === null,
    "a short first page offered to load more",
  );
});

test("an expanded operation previews its rows and counts the rest", async () => {
  const total = ZONE_HISTORY_ENTRY_PREVIEW_LIMIT + 3;
  const entries = Array.from({ length: total }, (_, index) =>
    entry("op-1", { id: `row-${index}` }),
  );
  mockHistory([[operation({ entries })]]);
  renderTab();

  fireEvent.click(await screen.findByTestId("zone-history-toggle-op-1"));
  const more = await screen.findByTestId("zone-history-more-op-1");
  assert.equal(more.textContent?.trim(), "… 3 more");
  assert.ok(
    screen.queryByTestId(`zone-history-entry-row-${total - 1}`) === null,
    "a preview rendered every row",
  );

  fireEvent.click(more);
  const last = await screen.findByTestId(`zone-history-entry-row-${total - 1}`);
  assert.ok(last.isConnected);
  assert.ok(
    screen.queryByTestId("zone-history-more-op-1") === null,
    "the row count stayed on screen after every row was shown",
  );
});

// ── Handing off to the undo dialog ──────────────────────────────────────────

test("a row's undo scopes the dialog to that row, and the operation's undo does not", async () => {
  mockHistory([
    [
      operation({
        entries: [entry("op-1", { id: "a" }), entry("op-1", { id: "b" })],
      }),
    ],
  ]);
  const seen: ZoneHistoryUndoDialogProps[] = [];
  renderTab(recordingDialog(seen));

  fireEvent.click(await screen.findByTestId("zone-history-toggle-op-1"));
  assert.equal(seen.length, 0, "the dialog mounted before anything was undone");

  fireEvent.click(await screen.findByTestId("zone-history-entry-undo-b"));
  await screen.findByTestId("undo-dialog-stub");
  const rowProps = seen.at(-1);
  assert.ok(rowProps);
  assert.equal(rowProps.open, true);
  assert.equal(rowProps.zoneId, ZONE_ID);
  assert.equal(rowProps.operationId, "op-1");
  assert.deepEqual([...(rowProps.entryIds ?? [])], ["b"]);
  // The dialog makes the two authenticated calls, so the credentials have to
  // reach it; an undo that 403s is indistinguishable from one that is blocked.
  assert.equal(rowProps.apiKey, API_KEY);
  assert.equal(rowProps.email, EMAIL);
  // The header fragment is rendered verbatim by the dialog, so it must arrive
  // localised rather than as `dns:bulk_update`.
  assert.ok(
    rowProps.operationLabel?.startsWith("Bulk edit at "),
    `the dialog was handed a raw operation name: ${rowProps.operationLabel}`,
  );

  // Close it, then undo the whole operation: no scope this time, which is what
  // tells the dialog to plan every row.
  rowProps.onOpenChange(false);
  fireEvent.click(screen.getByTestId("zone-history-undo-op-1"));
  await screen.findByTestId("undo-dialog-stub");
  const operationProps = seen.at(-1);
  assert.ok(operationProps);
  assert.equal(operationProps.operationId, "op-1");
  assert.equal(operationProps.entryIds, undefined);
});

test("confirming hands the rows to the host applier, for this zone, and reloads the list", async () => {
  const listCalls = mockHistory([
    [operation()],
    [operation({ operationId: "op-2", operation: "dns:undo" })],
  ]);
  const applyCalls: ApplyCall[] = [];
  const seen: ZoneHistoryUndoDialogProps[] = [];
  renderTab(recordingDialog(seen), recordingApplier(applyCalls));

  fireEvent.click(await screen.findByTestId("zone-history-undo-op-1"));
  const props = seen.at(-1);
  assert.ok(props);

  const rows = [planRow({ entryId: "a" }), planRow({ entryId: "b" })];
  const result = await props.onConfirm(rows);
  assert.equal(result.applied, 1);

  // The tab writes nothing itself: the rows go to the one applier the screen
  // has, tagged with the zone the tab belongs to rather than whichever zone
  // happens to be open.
  assert.equal(applyCalls.length, 1);
  assert.equal(applyCalls[0]?.zoneId, ZONE_ID);
  assert.deepEqual(
    applyCalls[0]?.rows.map((row) => row.entryId),
    ["a", "b"],
  );

  // The undo is itself logged, so the list is re-read rather than patched.
  const reloaded = await screen.findByTestId("zone-history-operation-op-2");
  assert.ok(reloaded.isConnected);
  assert.equal(listCalls.length, 2);
  assert.deepEqual(listCalls[1], {
    zoneId: ZONE_ID,
    options: { limit: ZONE_HISTORY_PAGE_SIZE },
  });
});

test("a rejected apply still reloads the list, because some rows may already have landed", async () => {
  const listCalls = mockHistory([[operation()], [operation()]]);
  const applyCalls: ApplyCall[] = [];
  const seen: ZoneHistoryUndoDialogProps[] = [];
  renderTab(
    recordingDialog(seen),
    recordingApplier(applyCalls, new Error("the zone refused the write")),
  );

  fireEvent.click(await screen.findByTestId("zone-history-undo-op-1"));
  const props = seen.at(-1);
  assert.ok(props);

  await assert.rejects(
    () => props.onConfirm([planRow({ entryId: "a" })]),
    /the zone refused the write/,
  );
  // The rejection reaches the dialog, which is what shows an apply-failed
  // state — but the list is stale either way, so it is re-read regardless.
  await waitFor(() => assert.equal(listCalls.length, 2));
});

test("a clean apply closes the dialog and reports the counts", async () => {
  mockHistory([[operation()], [operation()]]);
  const seen: ZoneHistoryUndoDialogProps[] = [];
  renderTab(recordingDialog(seen));

  fireEvent.click(await screen.findByTestId("zone-history-undo-op-1"));
  const props = seen.at(-1);
  assert.ok(props);
  assert.ok(props.onApplied);

  props.onApplied({
    operationId: "local-undo",
    applied: 2,
    skipped: 1,
    failed: [],
  });

  const status = await screen.findByTestId("zone-history-undo-result");
  assert.ok(status.textContent?.includes("2 records written"));
  assert.ok(status.textContent?.includes("1 skipped"));
  assert.ok(status.textContent?.includes("0 failed"));
  assert.ok(
    screen.queryByTestId("undo-dialog-stub") === null,
    "a clean apply left the dialog open with nothing left to read",
  );
});

test("a partial apply keeps the dialog open, because only it can say which row failed", async () => {
  mockHistory([[operation()], [operation()]]);
  const seen: ZoneHistoryUndoDialogProps[] = [];
  renderTab(recordingDialog(seen));

  fireEvent.click(await screen.findByTestId("zone-history-undo-op-1"));
  const props = seen.at(-1);
  assert.ok(props);
  assert.ok(props.onApplied);

  props.onApplied({
    operationId: "local-undo",
    applied: 36,
    skipped: 0,
    failed: [
      { entryId: "x", recordName: "x.history.test", message: "rate limited" },
    ],
  });

  // The counts line appears, as before…
  const status = await screen.findByTestId("zone-history-undo-result");
  assert.ok(status.textContent?.includes("1 failed"));
  // …and the dialog stays, because `failed[].recordName` and
  // `failed[].message` are only readable there. Closing it would leave
  // someone knowing a record did not go back and unable to find out which.
  assert.ok(
    screen.getByTestId("undo-dialog-stub"),
    "a partial apply closed the dialog and took the per-row reasons with it",
  );
});

// ── Turning confirmed rows into writes ──────────────────────────────────────

/**
 * `planUndoRows` is where an undo becomes a write, and it is the part that can
 * destroy data if it is wrong.
 *
 * Three claims, and the third is the one that is easy to miss:
 *
 *  - each shape maps to the right pair, so a redo puts things back where they
 *    were rather than somewhere plausible;
 *  - a row whose record cannot be found is refused with a reason, never
 *    guessed at — creating a second copy of a record that is really still
 *    there is the worst available outcome;
 *  - `forward` and `reverse` are **positional mirrors of single-record ops**,
 *    because `repointPairedDnsOp` matches the nth delete to the nth create by
 *    position. Break that and a redo deletes by a dead id.
 */
test("a row reverting a create deletes the record, and reverses by creating it again", () => {
  const live = liveRecord({ id: "created-1" });
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [planRow({ entryId: "r", target: null })],
    [live],
  );
  assert.equal(plan.refused.length, 0);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.planned.length, 1);
  const [step] = plan.planned;
  assert.deepEqual(step?.forward, {
    kind: "delete",
    zoneId: ZONE_ID,
    recordId: "created-1",
    record: live,
  });
  assert.deepEqual(step?.reverse, {
    kind: "create",
    zoneId: ZONE_ID,
    record: live,
  });
});

test("a row reverting a create whose record has already gone is skipped, not failed", () => {
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [planRow({ entryId: "r", target: null, drift: { state: "absent" } })],
    [],
  );
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.refused.length, 0);
  assert.deepEqual(
    plan.skipped.map((row) => row.entryId),
    ["r"],
  );
});

test("a row with a snapshot updates the live record and reverses to its pre-undo state", () => {
  const live = liveRecord();
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [planRow({ target: snapshot({ content: "1.1.1.1", ttl: 300 }) })],
    [live],
  );
  const [step] = plan.planned;
  assert.equal(step?.forward.kind, "update");
  assert.ok(step?.forward.kind === "update");
  // Written to the live id, carrying the snapshot's values.
  assert.equal(step.forward.record.id, live.id);
  assert.equal(step.forward.record.content, "1.1.1.1");
  assert.equal(step.forward.record.ttl, 300);
  // The reverse is the record as it was a moment ago, not the snapshot again.
  assert.deepEqual(step.reverse, {
    kind: "update",
    zoneId: ZONE_ID,
    record: live,
  });
});

test("a null ttl in a snapshot restores Cloudflare's automatic ttl", () => {
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [planRow({ target: snapshot({ ttl: null }) })],
    [liveRecord()],
  );
  const [step] = plan.planned;
  assert.ok(step?.forward.kind === "update");
  assert.equal(step.forward.record.ttl, "auto");
});

test("a row whose record is gone from Cloudflare is re-created, with no id for the reverse yet", () => {
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [planRow({ entryId: "r", drift: { state: "absent" } })],
    [],
  );
  const [step] = plan.planned;
  assert.equal(step?.forward.kind, "create");
  assert.ok(step?.reverse.kind === "delete");
  // Deliberately empty: the id does not exist until the create runs, and
  // `repointPairedDnsOp` is what fills it in.
  assert.equal(step.reverse.recordId, "");
});

test("a conflict row resolves by the id the preview named, not by name and type", () => {
  // Two records share the name and type, which is legal and is exactly what a
  // conflict looks like. A name lookup finds the first; the preview named the
  // second, and that is the one the user confirmed overwriting. If these were
  // the same record the assertion below would pass either way and prove
  // nothing.
  const firstByName = liveRecord({ id: "ours" });
  const named = liveRecord({ id: "theirs" });
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [planRow({ drift: { state: "conflict", conflictingRecordId: "theirs" } })],
    [firstByName, named],
  );
  const [step] = plan.planned;
  assert.ok(step?.forward.kind === "update");
  assert.equal(
    step.forward.record.id,
    "theirs",
    "a conflict row was resolved by name, landing on a record the preview did not name",
  );
  assert.ok(step.reverse.kind === "update");
  assert.equal(step.reverse.record.id, "theirs");
});

test("a conflict naming an id the loaded list does not hold is refused, not fallen back on", () => {
  // The preview asked Cloudflare; the loaded list is a cache, so the id can be
  // real and absent locally. A name-and-type fallback here would be the decoy
  // bug through the back door: it would find the record that merely shares the
  // name and overwrite one the preview never named. Refusing is the only safe
  // answer, and it is the same reasoning as the `absent` branch — the cache is
  // not trusted to contradict the preview.
  const sameName = liveRecord({ id: "not-the-one" });
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [
      planRow({
        entryId: "r",
        drift: { state: "conflict", conflictingRecordId: "absent-locally" },
      }),
    ],
    [sameName],
  );
  assert.equal(
    plan.planned.length,
    0,
    "a conflict with no local record produced a write, against a record the preview did not name",
  );
  assert.deepEqual(
    plan.refused.map((refusal) => [refusal.entryId, refusal.code]),
    [["r", "stale-record-list"]],
  );
});

test("a run reports each row separately, and stacks only what landed", async () => {
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [
      planRow({ entryId: "ok", recordName: `a.${ZONE_NAME}` }),
      planRow({ entryId: "boom", recordName: `b.${ZONE_NAME}` }),
      planRow({ entryId: "missing", recordName: `gone.${ZONE_NAME}` }),
    ],
    [liveRecord(), liveRecord({ id: "live-2", name: `b.${ZONE_NAME}` })],
  );
  // The third row never planned a write, so it is already a failure.
  assert.equal(plan.planned.length, 2);
  assert.equal(plan.refused.length, 1);

  const attempted: string[] = [];
  const run = await runUndoPlan(plan, async (op) => {
    assert.ok(op.kind === "update");
    attempted.push(op.record.id);
    if (op.record.id === "live-2") throw new Error("rate limited");
  });

  // Both rows were attempted: one rejection does not stop the next row.
  assert.deepEqual(attempted, ["live-1", "live-2"]);
  assert.equal(run.applied, 1);
  // Upstream failures carry the provider's words; our own refusal stays a code
  // on a separate list until a renderer with a locale words it.
  assert.deepEqual(
    run.failed.map((failure) => [failure.entryId, failure.message]),
    [["boom", "rate limited"]],
  );
  assert.deepEqual(
    run.refused.map((refusal) => [refusal.entryId, refusal.code]),
    [["missing", "stale-record-list"]],
  );

  // Only the row that landed goes on the stack. A Ctrl+Z that also reversed
  // `boom` would write a record that was never changed.
  assert.equal(run.landedForward.length, 1);
  assert.equal(run.landedReverse.length, 1);
  assert.ok(run.landedForward[0]?.kind === "update");
  assert.equal(run.landedForward[0].record.id, "live-1");
  assert.ok(run.landedReverse[0]?.kind === "update");
  assert.equal(run.landedReverse[0].record.id, "live-1");
});

test("a run collects created records in order, so the reverse can be re-pointed", async () => {
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [
      planRow({ entryId: "one", drift: { state: "absent" } }),
      planRow({ entryId: "two", drift: { state: "absent" } }),
    ],
    [],
  );
  assert.equal(plan.planned.length, 2);

  let minted = 0;
  const run = await runUndoPlan(plan, async (op, onCreated) => {
    assert.ok(op.kind === "create");
    minted += 1;
    onCreated({ ...op.record, id: `fresh-${minted}` });
  });

  assert.deepEqual(
    run.created.map((record) => record.id),
    ["fresh-1", "fresh-2"],
  );

  const repointed = repointPairedDnsOp(
    { kind: "composite", zoneId: ZONE_ID, ops: run.landedReverse },
    run.created,
  );
  assert.ok(repointed?.kind === "composite");
  assert.deepEqual(
    repointed.ops.map((op) => (op.kind === "delete" ? op.recordId : op.kind)),
    ["fresh-1", "fresh-2"],
  );
});

test("a composite entry id round-trips verbatim and is never parsed", async () => {
  /*
   * A bulk-import preview expands one summary trail entry into one row per
   * imported record, with ids shaped `<entryId>#<recordId>` — so a plan row's
   * `entryId` is not a `ZoneHistoryEntry.id` and must not be matched against
   * the list's ids or split on the `#`. It is an opaque token to be handed
   * back exactly as given.
   *
   * Pinned because the failure is quiet: a half of a split id still looks like
   * an id, so the backend would scope the undo to the wrong rows, or to none,
   * and nothing here would throw.
   */
  const composite = "trail-entry-7#rec-abc123";
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [
      planRow({ entryId: composite, recordName: `a.${ZONE_NAME}` }),
      planRow({
        entryId: `${composite}-missing`,
        recordName: `gone.${ZONE_NAME}`,
      }),
    ],
    [liveRecord()],
  );

  assert.equal(plan.planned[0]?.row.entryId, composite);
  assert.equal(plan.refused[0]?.entryId, `${composite}-missing`);

  const run = await runUndoPlan(plan, async () => {
    throw new Error("upstream said no");
  });
  // Through a failure and a refusal, both ids come back byte-for-byte.
  assert.deepEqual(
    run.failed.map((failure) => failure.entryId),
    [composite],
  );
  assert.deepEqual(
    run.refused.map((refusal) => refusal.entryId),
    [`${composite}-missing`],
  );
});

test("a run with nothing planned reports the skips and stacks nothing", async () => {
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [planRow({ entryId: "r", target: null, drift: { state: "absent" } })],
    [],
  );
  let calls = 0;
  const run = await runUndoPlan(plan, async () => {
    calls += 1;
  });
  assert.equal(calls, 0, "a plan with no writes still called the applier");
  assert.equal(run.applied, 0);
  assert.equal(run.skipped, 1);
  assert.equal(run.failed.length, 0);
  assert.equal(run.landedForward.length, 0);
});

test("a row whose record is not in the loaded list is refused with a reason, never guessed at", () => {
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [planRow({ entryId: "r", recordName: `missing.${ZONE_NAME}` })],
    [],
  );
  assert.equal(
    plan.planned.length,
    0,
    "a row with no resolvable record produced a write",
  );
  assert.equal(plan.refused.length, 1);
  assert.equal(plan.refused[0]?.entryId, "r");
  // A code, not prose: the planner is pure and does not know a locale. The
  // wording is `describeUndoRefusal`'s and is pinned in its own test.
  assert.equal(plan.refused[0]?.code, "stale-record-list");
});

test("record names match across case and a trailing root dot", () => {
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [planRow({ recordName: `A.${ZONE_NAME.toUpperCase()}.` })],
    [liveRecord()],
  );
  assert.equal(
    plan.planned.length,
    1,
    "a name differing only in case or dot was treated as a different record",
  );
});

test("forward and reverse stay positional mirrors of single-record ops", () => {
  const live = liveRecord({ id: "still-here" });
  const created = liveRecord({
    id: "to-be-deleted",
    name: `made.${ZONE_NAME}`,
  });
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [
      // An update, a re-create, and a delete — one undo, three shapes.
      planRow({ entryId: "upd" }),
      planRow({ entryId: "gone", drift: { state: "absent" } }),
      planRow({ entryId: "made", target: null, recordName: created.name }),
    ],
    [live, created],
  );

  assert.equal(plan.planned.length, 3);
  assert.deepEqual(
    plan.planned.map((step) => step.forward.kind),
    ["update", "create", "delete"],
  );
  assert.deepEqual(
    plan.planned.map((step) => step.reverse.kind),
    ["update", "delete", "create"],
  );
  // No bulk op anywhere: the re-pointing invariant is only true one record at
  // a time.
  for (const step of plan.planned) {
    assert.ok(
      !step.forward.kind.startsWith("bulk-"),
      `${step.row.entryId} planned a bulk forward op`,
    );
    assert.ok(
      !step.reverse.kind.startsWith("bulk-"),
      `${step.row.entryId} planned a bulk reverse op`,
    );
  }
});

test("re-pointing a composite moves its deletes onto the ids the creates minted, in order", () => {
  const first = liveRecord({ id: "fresh-1", name: `one.${ZONE_NAME}` });
  const second = liveRecord({ id: "fresh-2", name: `two.${ZONE_NAME}` });
  const reverse = {
    kind: "composite" as const,
    zoneId: ZONE_ID,
    ops: [
      // The mirror of a forward `update`: untouched by re-pointing.
      { kind: "update" as const, zoneId: ZONE_ID, record: liveRecord() },
      // The mirrors of two forward `create`s, both still carrying no id.
      { kind: "delete" as const, zoneId: ZONE_ID, recordId: "", record: first },
      {
        kind: "delete" as const,
        zoneId: ZONE_ID,
        recordId: "",
        record: second,
      },
    ] satisfies DNSLeafOp[],
  };

  const repointed = repointPairedDnsOp(reverse, [first, second]);
  assert.ok(
    repointed,
    "a composite with placeholder deletes was not re-pointed",
  );
  assert.ok(repointed.kind === "composite");
  assert.deepEqual(
    repointed.ops.map((op) => (op.kind === "delete" ? op.recordId : op.kind)),
    ["update", "fresh-1", "fresh-2"],
  );

  // Nothing created means nothing to re-point, and the caller is told so
  // rather than handed an identical copy.
  assert.equal(repointPairedDnsOp(reverse, []), null);
});

// ── The before-state every write has to snapshot ────────────────────────────

/**
 * Every record write passes a `previous`, and the value reaches the backend.
 *
 * Without it there is no snapshot, so `history-commands` lists the edit as
 * `no-snapshot` and edit-undo does not exist however well the rest of this
 * feature works. That makes it a zone-history requirement rather than a
 * `DNSManager` detail, which is why it is pinned here.
 *
 * Two tests, because each catches what the other cannot. The first reads the
 * source with the TypeScript compiler and covers **every** call site including
 * ones added later — the actual regression risk, since a tenth write added
 * without a before-state would silently lose its undo and no behavioural test
 * would notice. The second drives one write through the real screen to the IPC
 * boundary, because an argument being present in the source is not evidence
 * that anything arrives: `previous` crosses a hook, a client and a normaliser
 * on the way, and this is the repo where a lower layer carried a comment
 * claiming an upper one passed a value it had no parameter for.
 */
test("every record write in DNSManager passes a before-state", () => {
  const path = "src/components/dns/DNSManager.tsx";
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  /** `previous` sits at this index, after the arguments the write needs. */
  const required: Record<string, number> = {
    // (zoneId, recordId, record, previous)
    updateDNSRecord: 4,
    // (zoneId, recordId, previous)
    deleteDNSRecord: 3,
  };

  const sites: { name: string; line: number; args: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name in required) {
        sites.push({
          name,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          args: node.arguments.length,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // If this drops to zero the test has stopped measuring anything — a rename
  // of either function would do it.
  assert.ok(
    sites.length >= 9,
    `expected at least the nine known write sites, found ${sites.length}`,
  );

  const missing = sites.filter((site) => site.args < required[site.name]!);
  assert.deepEqual(
    missing,
    [],
    `these record writes pass no before-state, so their edits cannot be undone: ${missing
      .map((site) => `${path}:${site.line} ${site.name}`)
      .join(", ")}`,
  );
});

test("a bulk TTL change sends the record's before-state to the host", async () => {
  mockZoneWorkspace();
  mockHistory([[]]);
  await useEnglishLocale();
  render(
    <>
      <DNSManager
        apiKey="wiring-key"
        email="owner@wiring.test"
        onLogout={() => {}}
      />
      <Toaster />
    </>,
  );
  await screen.findByTestId("dns-records-table");

  const checkbox = await screen.findByRole("checkbox", {
    name: "Select record",
  });
  fireEvent.click(checkbox);

  // Awaited on the control about to be used, not on the selection count beside
  // it: the bulk bar appears as one unit, so waiting for the select is both
  // sufficient and the thing the next line depends on.
  const ttlSelect = await waitFor(() => {
    const trigger = screen
      .getAllByRole("combobox")
      .find((element) => element.textContent === "Set TTL");
    assert.ok(trigger, "the bulk TTL select was not rendered");
    return trigger;
  });
  fireEvent.click(ttlSelect);
  fireEvent.click(await screen.findByRole("option", { name: "1 hour" }));

  await waitFor(() => assert.equal(hostWrites("update_dns_record").length, 1));
  const [write] = hostWrites("update_dns_record");
  const previous = write?.previous as Record<string, unknown> | null;

  // The whole point: a before-state arrived, and it is the record as it was
  // rather than the record as it is about to be.
  assert.ok(
    previous,
    "the host received no before-state, so this edit cannot be undone",
  );
  assert.equal(previous.ttl, WIRING_RECORD.ttl);
  assert.notEqual(
    previous.ttl,
    3600,
    "the before-state carried the new TTL, so it snapshots the wrong state",
  );
  assert.equal(previous.name, WIRING_RECORD.name);
  assert.equal(previous.content, WIRING_RECORD.content);
  // …and the record being written did get the new value, so the measurement
  // above is not passing because nothing happened.
  assert.equal((write?.record as Record<string, unknown>).ttl, 3600);
});

// ── Wired into the zone view ────────────────────────────────────────────────

/**
 * `DNSManager` mounts the subtab, and nothing above asserts that.
 *
 * Every test above renders `ZoneHistoryTab` directly, which proves the panel
 * and proves nothing about whether a user can reach it. A tab added to the
 * union and the registry but never rendered — or rendered under the wrong
 * zone's id — passes all of them. So this one goes through the real screen:
 * open a zone, press the tab the tablist offers, and watch the panel ask the
 * host for *that* zone.
 */
const WIRING_ZONE = {
  id: "wiring-zone",
  name: "wiring.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

const WIRING_RECORD = {
  id: "wiring-rec",
  type: "A",
  name: `a.${WIRING_ZONE.name}`,
  content: "1.1.1.1",
  ttl: 300,
  proxied: false,
  zone_id: WIRING_ZONE.id,
  zone_name: WIRING_ZONE.name,
  created_on: "2026-09-01T10:00:00Z",
  modified_on: "2026-09-01T10:01:00Z",
} as TauriDNSRecord;

function mcpStatus(): McpServerStatus {
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

const originalFetch = globalThis.fetch;

/** Every command the host was asked for, in order, with its arguments. */
const hostCalls: { command: string; args: Record<string, unknown> }[] = [];

/** The arguments of each call to one write command. */
function hostWrites(command: string): Record<string, unknown>[] {
  return hostCalls
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

function mockZoneWorkspace(): void {
  enableThemedSelectEnvironment();
  // The zone workspace has Cloudflare-facing code paths this test does not
  // mock one by one. Fencing the network off makes "nothing reached it" a
  // measurement rather than an assumption about the sandbox.
  globalThis.fetch = async () => {
    throw new Error("no test may reach the network");
  };
  hostCalls.length = 0;
  mockIPC((command, args) => {
    hostCalls.push({
      command,
      args: (args ?? {}) as Record<string, unknown>,
    });
    if (command === "retention_list_records") {
      return {
        entries: [],
        expiredPendingPurge: 0,
        totalHeld: 0,
        bytesHeld: 0,
        maxBytes: 1_572_864,
        maxEntries: 1000,
      };
    }
    if (command === "update_dns_record") {
      const record = (args as { record?: Record<string, unknown> }).record;
      return { ...WIRING_RECORD, ...record };
    }
    // Anything else throws rather than returning `undefined`: a permissive
    // default made the records table render nothing at all, and the only
    // symptom was a `reading 'map'` TypeError that named no command.
    throw new Error(`unexpected command reached the host: ${command}`);
  });
  mock.method(TauriClient, "getPreferences", async () => ({
    reopen_last_tabs: true,
    reopen_zone_tabs: { [WIRING_ZONE.id]: true },
    last_open_tabs: [WIRING_ZONE.id],
    last_zone: WIRING_ZONE.id,
    last_active_tab: `${WIRING_ZONE.id}|records`,
  }));
  mock.method(TauriClient, "updatePreferences", async () => {});
  mock.method(TauriClient, "updatePreferenceFields", async () => {});
  mock.method(TauriClient, "getZones", async () => [WIRING_ZONE]);
  mock.method(TauriClient, "getDNSRecords", async () => [WIRING_RECORD]);
  mock.method(TauriClient, "getAuditEntries", async () => []);
  mock.method(TauriClient, "getMcpServerStatus", async () => mcpStatus());
}

function zoneViewTab(label: string): HTMLElement {
  const tab = within(screen.getByRole("tablist", { name: "Zone views" }))
    .getAllByRole("tab")
    .find((item) => item.textContent === label);
  assert.ok(tab, `no zone view tab labelled ${label}`);
  return tab;
}

test("the zone view offers a History tab, and it asks for that zone only once opened", async () => {
  mockZoneWorkspace();
  const calls = mockHistory([[operation({ operationId: "wired" })]]);
  await useEnglishLocale();
  render(
    <>
      <DNSManager
        apiKey="wiring-key"
        email="owner@wiring.test"
        onLogout={() => {}}
      />
      <Toaster />
    </>,
  );
  await screen.findByTestId("dns-records-table");

  // Eagerly imported, like every sibling panel, but not eagerly fetched: the
  // trail is not read for a tab nobody has opened.
  assert.equal(calls.length, 0, "the trail was read before the tab was opened");

  const tab = zoneViewTab("History");
  fireEvent.click(tab);

  // Awaited on the row itself, not on the panel: the panel is on screen while
  // loading too, so waiting for it and then reading inside would pass on a
  // spinner.
  const row = await screen.findByTestId("zone-history-operation-wired");
  assert.ok(row.isConnected);
  assert.equal(tab.getAttribute("aria-selected"), "true");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.zoneId,
    WIRING_ZONE.id,
    "the panel asked for a zone other than the open one",
  );
});

// ── The web build ───────────────────────────────────────────────────────────

test("the web build shows the desktop-only notice and never asks the host", async () => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  const calls = mockHistory([[operation()]]);
  renderTab();

  const panel = await screen.findByTestId("zone-history-panel");
  assert.ok(panel.textContent?.includes("only available in the desktop app"));
  assert.equal(calls.length, 0, "the web build reached the host");
  assert.ok(
    screen.queryByTestId("zone-history-list") === null,
    "the web build rendered a history list",
  );
});
