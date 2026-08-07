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

const ZONE = {
  id: "zone-1",
  name: "example.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

const SECOND_ZONE = {
  id: "zone-2",
  name: "second.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

const LONG_COMMENT =
  "this note is deliberately much longer than the row preview budget allows";

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

const RECORDS = [
  record({
    id: "rec-commented",
    type: "A",
    name: "www.example.test",
    content: "203.0.113.10",
    comment: LONG_COMMENT,
  }),
  record({
    id: "rec-bare",
    type: "A",
    name: "api.example.test",
    content: "203.0.113.11",
  }),
];

interface HarnessOptions {
  /** Omit entirely to simulate preferences saved before this feature. */
  dnsTableColumns?: string[];
  zones?: TauriZone[];
  records?: TauriDNSRecord[];
  storedTableColumns?: Record<string, string[]>;
}

interface Harness {
  preferenceUpdates: Array<Record<string, unknown>>;
  deletedRecordIds: string[];
  storedColumnWrites: Array<Record<string, string[]>>;
}

function mockRuntime(options: HarnessOptions = {}): Harness {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  const zones = options.zones ?? [ZONE];
  const preferenceUpdates: Array<Record<string, unknown>> = [];
  const deletedRecordIds: string[] = [];
  const storedColumnWrites: Array<Record<string, string[]>> = [];

  const preferences: Record<string, unknown> = {
    reopen_last_tabs: true,
    reopen_zone_tabs: Object.fromEntries(zones.map((z) => [z.id, true])),
    last_open_tabs: zones.map((z) => z.id),
    last_zone: zones[0]?.id,
    last_active_tab: `${zones[0]?.id}|records`,
    ...(options.dnsTableColumns
      ? { dns_table_columns: options.dnsTableColumns }
      : {}),
  };

  mock.method(
    storageManager,
    "getTableColumns",
    () => options.storedTableColumns,
  );
  mock.method(
    storageManager,
    "setTableColumns",
    (map: Record<string, string[]>) => {
      storedColumnWrites.push(map);
    },
  );
  mock.method(TauriClient, "getPreferences", async () => preferences);
  mock.method(TauriClient, "updatePreferences", async (next) => {
    preferenceUpdates.push(next as Record<string, unknown>);
  });
  mock.method(TauriClient, "getZones", async () => zones);
  mock.method(TauriClient, "getDNSRecords", async (_apiKey, _email, zoneId) =>
    zoneId === ZONE.id ? (options.records ?? RECORDS) : [],
  );
  mock.method(
    TauriClient,
    "deleteDNSRecord",
    async (
      _apiKey: string,
      _email: string,
      _zoneId: string,
      recordId: string,
    ) => {
      deletedRecordIds.push(recordId);
      return true;
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

  return { preferenceUpdates, deletedRecordIds, storedColumnWrites };
}

async function findRecordsTable(): Promise<HTMLElement> {
  return screen.findByTestId("dns-records-table");
}

function headerLabels(table: HTMLElement): string[] {
  const head = table.querySelector(".ui-table-head");
  assert.ok(head, "records table must render a header row");
  return (
    Array.from(head.children)
      .map((cell) => (cell.textContent ?? "").trim())
      .filter(Boolean)
      // Sort indicators are appended to the sortable header buttons.
      .map((label) => label.replace(/\s+/g, " "))
  );
}

async function openColumnsSettings(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  fireEvent.click(await screen.findByRole("button", { name: "Columns" }));
  return screen.findByTestId("settings-columns-panel");
}

afterEach(() => {
  cleanup();
  mock.restoreAll();
  // The storage manager is a module singleton; without this a tab order written
  // by one test leaks into the next one's hydration.
  storageManager.clearSettings();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

test("tab order hydrates from persisted preferences", async () => {
  mockRuntime({ zones: [ZONE, SECOND_ZONE] });
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  await screen.findByRole("tab", { name: ZONE.name });
  await waitFor(() => {
    const labels = screen
      .getAllByRole("tab")
      .map((tab) => tab.textContent?.trim() ?? "");
    assert.deepEqual(labels.slice(0, 2), [ZONE.name, SECOND_ZONE.name]);
  });
});

test("the default layout shows the comment column in place of actions", async () => {
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  const table = await findRecordsTable();
  const labels = headerLabels(table);
  assert.ok(
    labels.some((label) => label.startsWith("Comment")),
    `expected a Comment header, got ${JSON.stringify(labels)}`,
  );
  assert.ok(
    !labels.some((label) => label.startsWith("Actions")),
    `Actions must not be a default column, got ${JSON.stringify(labels)}`,
  );
});

test("comments truncate in the row and expose the full text on hover", async () => {
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await findRecordsTable();

  const truncated = `${LONG_COMMENT.slice(0, 30)}...`;
  const cell = await screen.findByText(truncated);
  assert.ok(cell.hasAttribute("data-record-comment"));
  // The untruncated comment stays reachable on hover via the title attribute.
  assert.equal(cell.getAttribute("title"), LONG_COMMENT);
});

test("a record without a comment renders an em dash rather than a blank cell", async () => {
  mockRuntime({
    records: [
      record({
        id: "rec-bare",
        type: "A",
        name: "api.example.test",
        content: "203.0.113.11",
      }),
    ],
  });
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  const table = await findRecordsTable();
  await waitFor(() =>
    assert.equal(table.querySelectorAll(".ui-table-row").length, 1),
  );
  const row = table.querySelector(".ui-table-row") as HTMLElement;
  assert.ok((row.textContent ?? "").includes("—"));
});

test("preferences that predate the feature hydrate to the new defaults", async () => {
  // No dns_table_columns in the desktop payload and nothing in browser storage.
  mockRuntime({ dnsTableColumns: undefined, storedTableColumns: undefined });
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  const table = await findRecordsTable();
  const labels = headerLabels(table);
  assert.ok(labels.some((label) => label.startsWith("Comment")));
  assert.ok(!labels.some((label) => label.startsWith("Actions")));
  assert.ok(labels.some((label) => label.startsWith("Type")));
  assert.ok(labels.some((label) => label.startsWith("Name")));
});

test("a persisted column set hydrates the records table", async () => {
  mockRuntime({
    dnsTableColumns: ["select", "type", "name", "content", "actions"],
  });
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  const table = await findRecordsTable();
  await waitFor(() => {
    const labels = headerLabels(table);
    assert.ok(
      labels.some((label) => label.startsWith("Actions")),
      `expected Actions to hydrate, got ${JSON.stringify(labels)}`,
    );
  });
  assert.ok(!headerLabels(table).some((label) => label.startsWith("Comment")));
});

test("a persisted set that drops every known column falls back to defaults", async () => {
  mockRuntime({ dnsTableColumns: ["not-a-column"] });
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  const table = await findRecordsTable();
  const labels = headerLabels(table);
  assert.ok(labels.some((label) => label.startsWith("Comment")));
  assert.ok(labels.length > 1);
});

test("toggling a column in Settings updates the table and persists", async () => {
  const harness = mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await findRecordsTable();

  const panel = await openColumnsSettings();
  const actionsToggle = screen.getByRole("checkbox", {
    name: "DNS records: Actions",
  }) as HTMLInputElement;
  assert.equal(actionsToggle.checked, false);
  assert.ok(panel.contains(actionsToggle));

  fireEvent.click(actionsToggle);

  await waitFor(() =>
    assert.ok(
      harness.preferenceUpdates.some((update) => {
        const columns = update.dns_table_columns;
        return Array.isArray(columns) && columns.includes("actions");
      }),
      "enabling Actions must reach the desktop preference store",
    ),
  );
  await waitFor(() =>
    assert.ok(
      harness.storedColumnWrites.some((write) =>
        write.dnsRecords?.includes("actions"),
      ),
      "enabling Actions must reach browser storage",
    ),
  );

  // The change is reflected back in the records table.
  fireEvent.click(screen.getByRole("tab", { name: ZONE.name }));
  const table = await findRecordsTable();
  await waitFor(() =>
    assert.ok(headerLabels(table).some((label) => label.startsWith("Actions"))),
  );
});

test("locked identity columns are rendered but not toggleable", async () => {
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await findRecordsTable();
  await openColumnsSettings();

  for (const column of ["Type", "Name", "Content"]) {
    const toggle = screen.getByRole("checkbox", {
      name: `DNS records: ${column}`,
    }) as HTMLInputElement;
    assert.equal(toggle.checked, true, `${column} must be visible`);
    assert.equal(toggle.disabled, true, `${column} must be locked on`);
  }
});

test("the picker guards against hiding every column", async () => {
  const harness = mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await findRecordsTable();
  await openColumnsSettings();

  // Turn off every optional DNS records column.
  for (const column of ["Selection", "Comment", "TTL", "Proxy"]) {
    const toggle = screen.getByRole("checkbox", {
      name: `DNS records: ${column}`,
    }) as HTMLInputElement;
    if (toggle.checked && !toggle.disabled) fireEvent.click(toggle);
  }

  await waitFor(() => {
    const remaining = harness.storedColumnWrites.at(-1)?.dnsRecords ?? [];
    assert.ok(
      remaining.length > 0,
      "the table must never end up with 0 columns",
    );
  });

  // The required columns are still on and still locked.
  for (const column of ["Type", "Name", "Content"]) {
    const toggle = screen.getByRole("checkbox", {
      name: `DNS records: ${column}`,
    }) as HTMLInputElement;
    assert.equal(toggle.checked, true);
    assert.equal(toggle.disabled, true);
  }

  fireEvent.click(screen.getByRole("tab", { name: ZONE.name }));
  const table = await findRecordsTable();
  assert.ok(headerLabels(table).length >= 3);
});

test("every registered table gets its own picker group", async () => {
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await findRecordsTable();
  await openColumnsSettings();

  assert.ok(screen.getByTestId("column-group-dnsRecords"));
  assert.ok(screen.getByTestId("column-group-zoneCompare"));
  assert.ok(screen.getByTestId("column-group-auditLog"));
  assert.ok(screen.getByRole("checkbox", { name: "Zone compare: Content" }));
  assert.ok(screen.getByRole("checkbox", { name: "Audit log: Resource" }));
});

test("Shift+F10 on a focused row opens the context menu", async () => {
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  const table = await findRecordsTable();

  const row = table.querySelector("[data-record-row]") as HTMLElement;
  assert.ok(row, "record rows must be individually addressable");

  const seen: string[] = [];
  const listener = (event: Event) => {
    seen.push(
      (event.target as HTMLElement).getAttribute("data-record-row") ?? "",
    );
  };
  document.addEventListener("contextmenu", listener);
  try {
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    assert.deepEqual(seen, ["rec-commented"]);

    // The dedicated Menu/ContextMenu key opens it too.
    fireEvent.keyDown(row, { key: "ContextMenu" });
    assert.deepEqual(seen, ["rec-commented", "rec-commented"]);
  } finally {
    document.removeEventListener("contextmenu", listener);
  }
});

test("the row context menu exposes every action and fires delete", async () => {
  const harness = mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  const table = await findRecordsTable();

  const row = table.querySelector("[data-record-row]") as HTMLElement;
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });

  const menuIds = Array.from(
    document.querySelectorAll("[data-record-action]"),
  ).map((node) => node.getAttribute("data-record-action"));
  for (const id of ["edit", "copy", "clone", "delete"]) {
    assert.ok(menuIds.includes(id), `context menu must offer ${id}`);
  }

  const deleteItem = document.querySelector(
    '[data-record-action="delete"]',
  ) as HTMLElement;
  fireEvent.click(deleteItem);

  await waitFor(() =>
    assert.deepEqual(harness.deletedRecordIds, ["rec-commented"]),
  );
});

test("row selection still works alongside the context menu", async () => {
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await findRecordsTable();

  const checkbox = (
    await screen.findAllByRole("checkbox", { name: "Select record" })
  )[0];
  fireEvent.click(checkbox);
  assert.ok(await screen.findByRole("button", { name: "Copy selected" }));
});

test("reordering tabs by keyboard persists the new tab order", async () => {
  const harness = mockRuntime({ zones: [ZONE, SECOND_ZONE] });
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  const firstTab = await screen.findByRole("tab", { name: ZONE.name });
  await screen.findByRole("tab", { name: SECOND_ZONE.name });

  fireEvent.keyDown(firstTab, {
    key: "ArrowRight",
    ctrlKey: true,
    shiftKey: true,
  });

  await waitFor(() => {
    const labels = screen
      .getAllByRole("tab")
      .map((tab) => tab.textContent?.trim() ?? "");
    assert.equal(labels[0], SECOND_ZONE.name);
  });

  await waitFor(() =>
    assert.ok(
      harness.preferenceUpdates.some((update) => {
        const order = update.last_open_tabs;
        return (
          Array.isArray(order) &&
          order[0] === SECOND_ZONE.id &&
          order[1] === ZONE.id
        );
      }),
      "the reordered tab list must be persisted",
    ),
  );
});
