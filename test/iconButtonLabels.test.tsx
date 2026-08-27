/**
 * Every control here works fine with a mouse. These tests check the other
 * half: that each one has an accessible name, so it can be found and operated
 * by a screen reader or by keyboard.
 *
 * Assertions deliberately go through `getByRole(role, { name })` rather than
 * reading `aria-label` off the element. That is the query a screen reader
 * makes, and it stays true no matter which of the several legal ways of naming
 * a control the implementation picks.
 */
import assert from "node:assert/strict";
import React, { useState } from "react";
import { afterEach, mock, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { DNSManager } from "../src/components/dns/DNSManager";
import { ImportPreviewDialog } from "../src/components/dns/ImportPreviewDialog";
import { TxtBuilder } from "../src/components/dns/builders/TxtBuilder";
import { ZoneTopologyTab } from "../src/components/dns/ZoneTopologyTab";
import { RegistryMonitor } from "../src/components/registrar/RegistryMonitor";
import { Tooltip } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/toaster";
import { resetToastRuntimeForTests, toast } from "../src/hooks/use-toast";
import {
  TauriClient,
  type McpServerStatus,
  type TauriDNSRecord,
  type TauriZone,
} from "../src/lib/api/tauri-client";
import { storageManager } from "../src/lib/storage/storage";
import type { UseRegistrarMonitorResult } from "../src/hooks/registrar/use-registrar-monitor";
import type { DNSRecord } from "../src/types/dns";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  mock.restoreAll();
  resetToastRuntimeForTests();
  storageManager.clearSettings();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

// ── The Tooltip primitive ──────────────────────────────────────────────────
//
// The tooltip bubble is portalled and `pointer-events: none`, so it is only
// ever a visual hint. These tests pin the association that makes it count.

test("a tooltip names the icon-only control it wraps", () => {
  render(
    <Tooltip tip="Refresh all domains">
      <button type="button">
        <svg aria-hidden="true" />
      </button>
    </Tooltip>,
  );

  // No hover, no focus: the name has to be there the whole time.
  assert.ok(screen.getByRole("button", { name: "Refresh all domains" }));
});

test("a tooltip does not overwrite a name the control already has", () => {
  render(
    <Tooltip tip="Actions">
      <button type="button" aria-label="Record Actions">
        <svg aria-hidden="true" />
      </button>
    </Tooltip>,
  );

  assert.ok(screen.getByRole("button", { name: "Record Actions" }));
  assert.equal(screen.queryByRole("button", { name: "Actions" }), null);
});

test("a tooltip on an already-named control describes it while open", () => {
  render(
    <Tooltip tip="Always on top: On">
      <button type="button" aria-label="Disable always on top">
        T
      </button>
    </Tooltip>,
  );

  const button = screen.getByRole("button", { name: "Disable always on top" });
  assert.equal(button.getAttribute("aria-describedby"), null);

  fireEvent.focus(button);
  const describedBy = button.getAttribute("aria-describedby");
  assert.ok(describedBy, "the open tip must be attached as a description");
  assert.equal(
    document.getElementById(describedBy)?.textContent,
    "Always on top: On",
  );

  fireEvent.blur(button);
  assert.equal(button.getAttribute("aria-describedby"), null);
});

test("a tooltip counts visible text as a name and adds no hidden duplicate", () => {
  render(
    <Tooltip tip="www.example.test">
      <div>www.example.test</div>
    </Tooltip>,
  );

  // A second, visually hidden copy of the same string would be read twice.
  assert.equal(screen.getAllByText("www.example.test").length, 1);
});

// ── 1. RegistryMonitor's refresh button ────────────────────────────────────

function registrarMonitor(): UseRegistrarMonitorResult {
  const noop = async () => undefined;
  return {
    credentials: [],
    domains: [],
    healthChecks: [],
    isLoading: false,
    error: null,
    addCredential: async () => "id",
    deleteCredential: noop,
    verifyCredential: async () => true,
    refreshCredentials: noop,
    listDomains: async () => [],
    refreshAllDomains: noop,
    runHealthChecks: noop,
    runHealthCheck: async () => ({}) as never,
    clearError: () => {},
  } as unknown as UseRegistrarMonitorResult;
}

test("the registry monitor refresh button announces what it refreshes", () => {
  render(<RegistryMonitor monitor={registrarMonitor()} />);

  const refresh = screen.getByRole("button", { name: /refresh all domains/i });
  assert.equal(refresh.tagName, "BUTTON");
});

// ── 3. Topology zoom controls ──────────────────────────────────────────────

function topologyRecord(index: number): DNSRecord {
  const timestamp = new Date(index * 1000).toISOString();
  return {
    id: `record-${index}`,
    type: "A",
    name: `host-${index}.example.com`,
    content: `192.0.2.${index % 255}`,
    ttl: 300,
    proxied: false,
    zone_id: "zone-id",
    zone_name: "example.com",
    created_on: timestamp,
    modified_on: timestamp,
  };
}

test("the topology zoom and refresh controls are reachable by name", async () => {
  render(
    <ZoneTopologyTab
      zoneName="example.com"
      records={[topologyRecord(0)]}
      disableServiceDiscovery
      onRefresh={() => {}}
    />,
  );

  await screen.findByRole("button", { name: /zoom in/i });
  for (const name of [
    /zoom in/i,
    /zoom out/i,
    /reset view/i,
    /refresh topology/i,
    /normalize zoom to 100%/i,
  ]) {
    assert.ok(
      screen.getByRole("button", { name }),
      `no control is announced as ${name}`,
    );
  }
});

// ── 4. The TXT helper select ───────────────────────────────────────────────

function TxtHarness() {
  const [record, setRecord] = useState<Partial<DNSRecord>>({
    type: "TXT",
    name: "@",
    content: "hello",
  });
  return (
    <TxtBuilder
      record={record}
      onRecordChange={setRecord}
      zoneName="example.com"
    />
  );
}

test("the TXT helper select is announced with its label", () => {
  render(<TxtHarness />);
  assert.ok(screen.getByRole("combobox", { name: /TXT helper/i }));
});

// ── 5. The import preview Dry Run checkbox ─────────────────────────────────

test("the dry run switch is announced by name and reports its state", () => {
  let dryRun: boolean | undefined;
  render(
    <ImportPreviewDialog
      open
      onOpenChange={() => undefined}
      items={[{ type: "A", name: "www.example.test", content: "203.0.113.1" }]}
      onConfirm={(_items, flag) => {
        dryRun = flag;
      }}
      onCancel={() => undefined}
    />,
  );

  // Writing to a production zone versus previewing hangs on this control, so
  // its state has to be readable, not only its position on screen.
  const checkbox = screen.getByRole("checkbox", { name: /dry run/i });
  assert.equal((checkbox as HTMLInputElement).checked, false);

  fireEvent.click(checkbox);
  assert.equal((checkbox as HTMLInputElement).checked, true);

  fireEvent.click(screen.getByRole("button", { name: "Import Selected" }));
  assert.equal(dryRun, true);
});

// ── Also found in the audit: the toast dismiss button ──────────────────────

test("the toast dismiss button is announced by name", async () => {
  render(<Toaster />);
  act(() => {
    toast({ title: "Saved" });
  });

  assert.ok(
    await screen.findByRole("button", { name: /dismiss notification/i }),
  );
});

// ── 2. The records table refresh button ────────────────────────────────────

const ZONE = {
  id: "zone-1",
  name: "example.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

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

const RECORD = {
  id: "rec-1",
  type: "A",
  name: "www.example.test",
  content: "203.0.113.10",
  ttl: 300,
  proxied: false,
  zone_id: ZONE.id,
  zone_name: ZONE.name,
  created_on: "2026-08-06T10:00:00Z",
  modified_on: "2026-08-06T10:01:00Z",
} as TauriDNSRecord;

test("the records table refresh button has a name, not only a hover title", async () => {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  let recordFetches = 0;
  mock.method(TauriClient, "getPreferences", async () => ({
    reopen_last_tabs: true,
    reopen_zone_tabs: { [ZONE.id]: true },
    last_open_tabs: [ZONE.id],
    last_zone: ZONE.id,
    last_active_tab: `${ZONE.id}|records`,
  }));
  mock.method(TauriClient, "updatePreferences", async () => undefined);
  mock.method(TauriClient, "getZones", async () => [ZONE]);
  mock.method(TauriClient, "getDNSRecords", async () => {
    recordFetches += 1;
    return [RECORD];
  });
  mock.method(TauriClient, "getAuditEntries", async () => []);
  mock.method(TauriClient, "getMcpServerStatus", async () => createMcpStatus());
  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await screen.findByTestId("dns-records-table");

  const refresh = await screen.findByRole("button", {
    name: /refresh records from cloudflare/i,
  });
  // The two toolbar filters next to it announce only their current value
  // ("A", "50") unless they are labelled; nothing on screen names them.
  assert.ok(screen.getByRole("combobox", { name: /filter by record type/i }));
  assert.ok(screen.getByRole("combobox", { name: /records per page/i }));

  const before = recordFetches;
  fireEvent.click(refresh);
  // Labelling must not have changed what the button does.
  await waitFor(() =>
    assert.ok(recordFetches > before, "the refresh button still refreshes"),
  );
});

// ── t9: the notifications bell and per-item inbox actions ──────────────────

test("the notifications bell and inbox item actions are announced by name", async () => {
  const { DnsAppCommandBar } =
    await import("../src/components/dns/DnsAppCommandBar");
  const { NotificationItem } =
    await import("../src/components/dns/NotificationItem");

  render(
    <DnsAppCommandBar
      accountLabel="admin@example.test"
      sessionLabel="Active session"
      showAudit
      showNotifications
      unreadCount={3}
      onOpenNotifications={() => {}}
      onOpenAudit={() => {}}
      onOpenRegistry={() => {}}
      onOpenSettings={() => {}}
      onOpenTags={() => {}}
      onLogout={() => {}}
    />,
  );
  assert.ok(screen.getByRole("button", { name: "Notifications, 3 unread" }));
  cleanup();

  const noop = () => {};
  render(
    <NotificationItem
      item={{
        id: "n-1",
        kind: "record_change",
        severity: "warning",
        zoneId: "zone-1",
        zoneName: "example.test",
        title: "A www.example.test changed outside Better Cloudflare",
        body: "203.0.113.10 → 203.0.113.11",
        createdAt: "2026-08-07T08:00:00Z",
        readAt: null,
        archivedAt: null,
        dedupeKey: "k",
        payload: {
          change: "changed",
          recordId: "rec-1",
          recordType: "A",
          recordName: "www.example.test",
          before: { content: "203.0.113.10" },
          after: { content: "203.0.113.11" },
        },
      }}
      onMarkRead={noop}
      onArchive={noop}
      onUnarchive={noop}
      onDismiss={noop}
      onOpenZone={noop}
      onRevealRecord={noop}
    />,
  );
  for (const name of ["Mark read", "Archive", "Dismiss", "Go to record"]) {
    assert.ok(
      screen.getByRole("button", { name }),
      `no inbox action is announced as ${name}`,
    );
  }
});
