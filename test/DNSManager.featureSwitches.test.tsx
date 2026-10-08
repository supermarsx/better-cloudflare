/**
 * The feature switches, wired to the screen.
 *
 * What is pinned here is behaviour, not storage. A switch whose "off" hid a
 * button while the work carried on would be worse than no switch at all,
 * because the user would believe they had stopped it — so every claim below is
 * measured as "this request was not made" or "this control does not exist",
 * and every one of them is paired with a control proving the measurement would
 * have seen the real thing.
 *
 * Three switches, three claims:
 *
 *  1. **Registry monitoring.** Off means no RDAP request, no registrar API
 *     call, no credential listing, and no Registry UI: not the zone's Registry
 *     tab, and not a mounted `RegistryMonitor` (which starts asking the moment
 *     it mounts). The host is told too, through
 *     `set_registry_monitoring_enabled`, because the background expiry pass
 *     spends the same requests from a timer rather than a click.
 *  2. **The Cloudflare latency probe.** Off means the chip is absent because
 *     nothing was measured. The request-level proof lives in
 *     `cloudflare-latency.test.tsx`, which counts the authenticated read the
 *     probe is timed on; what this file adds is that the preference reaches the
 *     connection bar at all.
 *  3. **Passkeys.** Off is guarded: the row will not go off until the password
 *     for the signed-in key has been proven, because a passkey can be the only
 *     route a user still remembers. A wrong password leaves the switch on.
 *
 * Absence is `assert.ok(node === null, …)` throughout, never
 * `assert.equal(node, null)`: the latter deep-inspects a jsdom element on
 * failure and can take the worker — and the rest of the batch — with it.
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
import { storageManager } from "../src/lib/storage/storage";

import { useEnglishLocale } from "./i18n-ready";
import { enableThemedSelectEnvironment } from "./radix-select";

const originalFetch = globalThis.fetch;

const ZONE = {
  id: "switch-zone",
  name: "switch.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

const RECORD = {
  id: "rec-a",
  type: "A",
  name: "a.switch.test",
  content: "1.1.1.1",
  ttl: 300,
  proxied: false,
  zone_id: ZONE.id,
  zone_name: ZONE.name,
  created_on: "2026-09-01T10:00:00Z",
  modified_on: "2026-09-01T10:01:00Z",
} as TauriDNSRecord;

/** The host commands this suite cares about, by name. */
const REGISTRY_COMMANDS = [
  "list_registrar_credentials",
  "registrar_list_all_domains",
  "registrar_health_check_all",
  "lookup_domain_registry",
] as const;
const SWITCH_COMMAND = "set_registry_monitoring_enabled";

interface IpcCall {
  command: string;
  args: Record<string, unknown>;
}

interface Harness {
  ipc: IpcCall[];
  calls: (command: string) => IpcCall[];
  /** Every registry-flavoured command the host was asked for. */
  registryCalls: () => IpcCall[];
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

/**
 * Mock the host.
 *
 * The registry commands and the feature-switch command have no `TauriClient`
 * wrapper worth stubbing — `hostCommand` and `TauriClient`'s registrar methods
 * both go through `invoke` — so everything is intercepted at the IPC boundary,
 * which is also what makes "no request was made" a real measurement rather
 * than an absence of assertions. An unrecognised command throws instead of
 * resolving, so a new call cannot slip through unnoticed.
 */
interface RuntimeOptions {
  decryptPassword?: string;
  /** The zone view a restored profile asks for. */
  lastActionTab?: string;
  /** Restore the Registry workspace tab, as a saved profile would. */
  restoreRegistryTab?: boolean;
}

function mockRuntime(options: RuntimeOptions = {}): Harness {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  enableThemedSelectEnvironment();

  const ipc: IpcCall[] = [];

  mockIPC((command, args) => {
    ipc.push({ command, args: (args ?? {}) as Record<string, unknown> });
    switch (command) {
      case SWITCH_COMMAND:
        return undefined;
      case "list_registrar_credentials":
        return [
          {
            id: "reg-1",
            provider: "namecheap",
            label: "Registrar",
            created_at: "2026-01-01T00:00:00Z",
          },
        ];
      case "registrar_list_all_domains":
        return [
          {
            domain: ZONE.name,
            registrar: "Namecheap",
            expires_at: "2027-01-01T00:00:00Z",
            auto_renew: true,
            locked: true,
            nameservers: [],
            status: [],
          },
        ];
      case "registrar_health_check_all":
        return [];
      case "lookup_domain_registry":
        return { domain: ZONE.name, expiresAt: "2027-01-01T00:00:00Z" };
      case "decrypt_api_key": {
        const password = (args as { password?: string } | undefined)?.password;
        if (password !== options.decryptPassword) {
          throw new Error("decryption failed");
        }
        return "cf-secret";
      }
      case "retention_list_records":
        return {
          entries: [],
          expiredPendingPurge: 0,
          totalHeld: 0,
          bytesHeld: 0,
          maxBytes: 1_572_864,
          maxEntries: 1000,
        };
      default:
        throw new Error(`unexpected command reached the host: ${command}`);
    }
  });

  mock.method(TauriClient, "getPreferences", async () => ({
    reopen_last_tabs: true,
    reopen_zone_tabs: { [ZONE.id]: true },
    last_open_tabs: options.restoreRegistryTab
      ? [ZONE.id, "__registry"]
      : [ZONE.id],
    last_zone: ZONE.id,
    last_active_tab: options.restoreRegistryTab
      ? "__registry"
      : `${ZONE.id}|${options.lastActionTab ?? "records"}`,
  }));
  mock.method(TauriClient, "updatePreferences", async () => {});
  mock.method(TauriClient, "updatePreferenceFields", async () => {});
  mock.method(TauriClient, "getZones", async () => [ZONE]);
  mock.method(TauriClient, "getDNSRecords", async () => [RECORD]);
  mock.method(TauriClient, "getAuditEntries", async () => []);
  mock.method(TauriClient, "getMcpServerStatus", async () => createMcpStatus());
  mock.method(TauriClient, "setMcpEnabledTools", async () => createMcpStatus());
  mock.method(TauriClient, "startMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "stopMcpServer", async () => createMcpStatus());

  globalThis.fetch = async () => {
    throw new Error("no test may reach the network");
  };

  return {
    ipc,
    calls: (command) => ipc.filter((call) => call.command === command),
    registryCalls: () =>
      ipc.filter((call) =>
        (REGISTRY_COMMANDS as readonly string[]).includes(call.command),
      ),
  };
}

async function renderManager(options: RuntimeOptions = {}): Promise<Harness> {
  await useEnglishLocale();
  const harness = mockRuntime(options);
  render(
    <>
      <DNSManager
        apiKey="switch-key"
        email="owner@switch.test"
        onLogout={() => {}}
      />
      <Toaster />
    </>,
  );
  // The records table is the sign the screen has settled — unless the restored
  // profile put a workspace tab in front of it, in which case there is no zone
  // table to wait for and the test waits on its own landmark.
  if (!options.restoreRegistryTab) {
    await screen.findByTestId("dns-records-table");
  }
  return harness;
}

afterEach(() => {
  cleanup();
  resetToastRuntimeForTests();
  mock.restoreAll();
  clearMocks();
  storageManager.clearSettings();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

// ── Driving the screen ──────────────────────────────────────────────────────

function zoneViewTabs(): HTMLElement[] {
  return Array.from(
    within(screen.getByRole("tablist", { name: "Zone views" })).getAllByRole(
      "tab",
    ),
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

async function openGeneralSettings(): Promise<void> {
  await openSettings();
  fireEvent.click(subtabButton("general"));
  await waitFor(() =>
    assert.equal(subtabButton("general").getAttribute("data-active"), "true"),
  );
}

function settingRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`);
  assert.ok(row, `no settings row with data-setting-id="${id}"`);
  return row;
}

/**
 * The switch inside one settings row.
 *
 * `hidden: true` because a Radix dialog marks the rest of the document
 * `aria-hidden` while it is open, and the passkey guard's dialog is opened by
 * one of these switches — so the row behind it would otherwise become
 * unqueryable at exactly the moment its state is the thing being checked.
 */
function rowSwitch(id: string): HTMLElement {
  return within(settingRow(id)).getByRole("switch", { hidden: true });
}

/** What the host was told about registry monitoring, in order. */
function switchPushes(harness: Harness): unknown[] {
  return harness.calls(SWITCH_COMMAND).map((call) => call.args.enabled);
}

/** Switch the zone to one of its view tabs, by the label the tab shows. */
function openZoneView(label: string): void {
  const tab = zoneViewTabs().find((item) => item.textContent === label);
  assert.ok(tab, `no zone view tab labelled ${label}`);
  fireEvent.click(tab);
}

// ── Registry monitoring ─────────────────────────────────────────────────────

test("absent means on: the Registry tab is offered and the registry is asked", async () => {
  const harness = await renderManager();

  assert.ok(
    zoneViewTabs().some((tab) => tab.textContent === "Registry"),
    "the zone's Registry tab must be there when nothing has turned it off",
  );

  // The audit's own registry lookup first, while the zone tab is still the
  // active one: a third place the feature spends a request, and the one a user
  // never asked for — it happens because an audit is on screen.
  openZoneView("Audits");
  await waitFor(() =>
    assert.ok(
      harness.calls("lookup_domain_registry").length >= 1,
      "an audit on screen looks the expiry date up at the registry",
    ),
  );

  fireEvent.click(
    await screen.findByRole("button", { name: "Registry Monitoring" }),
  );
  await waitFor(() =>
    assert.ok(
      harness.calls("list_registrar_credentials").length >= 1,
      "the monitor asks for credentials the moment it mounts",
    ),
  );
  await waitFor(() =>
    assert.ok(
      harness.calls("registrar_list_all_domains").length >= 1,
      "and then goes out to the registrar for its domains",
    ),
  );
  const pushes = switchPushes(harness);
  assert.ok(pushes.length >= 1, "the host has to be told at all");
  assert.ok(
    pushes.every((value) => value === true),
    `the host must only ever have been told "on": ${JSON.stringify(pushes)}`,
  );
});

test("registry monitoring off removes the Registry UI and makes no registry request", async () => {
  storageManager.setRegistryMonitoringEnabled(false);
  const harness = await renderManager();

  // The zone's Registry tab is gone, not disabled: there is nothing to press.
  assert.ok(
    zoneViewTabs().every((tab) => tab.textContent !== "Registry"),
    `the Registry tab must be absent, found: ${JSON.stringify(
      zoneViewTabs().map((tab) => tab.textContent),
    )}`,
  );

  // The audit is the quiet one: it spends a registry lookup because it is on
  // screen, not because anyone pressed anything. Opening it has to cost
  // nothing now.
  openZoneView("Audits");
  await screen.findByText(/best-practice heuristics/i);
  assert.deepEqual(
    harness.registryCalls().map((call) => call.command),
    [],
    "an audit must not spend a registry lookup while the switch is off",
  );

  // And the chrome's own way in is gone, which is the last one a user has.
  assert.ok(
    screen.queryByRole("button", { name: "Registry Monitoring" }) === null,
    "the command bar must not offer a way into the Registry workspace",
  );

  assert.deepEqual(
    harness.registryCalls().map((call) => call.command),
    [],
    "nothing may be asked of a registry or registrar while the switch is off",
  );

  const pushes = switchPushes(harness);
  assert.ok(
    pushes.length >= 1,
    "the host has to be told, or the background expiry pass keeps polling",
  );
  assert.ok(
    pushes.every((value) => value === false),
    `the host must never have been told "on": ${JSON.stringify(pushes)}`,
  );
});

test("turning registry monitoring off from the settings row stops it there and then", async () => {
  const harness = await renderManager();
  await openGeneralSettings();

  const control = rowSwitch("registry-monitoring-enabled");
  assert.equal(control.getAttribute("aria-checked"), "true");
  fireEvent.click(control);

  await waitFor(() => {
    const pushes = switchPushes(harness);
    assert.equal(
      pushes.at(-1),
      false,
      `the host has to be told again, with the new answer: ${JSON.stringify(pushes)}`,
    );
  });
  assert.ok(
    switchPushes(harness).includes(true),
    "and it was told 'on' first, or this proves nothing changed",
  );
  assert.equal(
    rowSwitch("registry-monitoring-enabled").getAttribute("aria-checked"),
    "false",
  );
  assert.equal(storageManager.getRegistryMonitoringEnabled(), false);
});

test("a profile that was left on the Registry tab does not come back to a blank panel", async () => {
  // The tab restore writes `domain-registry` into state after the first
  // render, so a switch checked only once would leave the zone showing a panel
  // that is no longer rendered, with no tab in the list to leave by.
  storageManager.setRegistryMonitoringEnabled(false);
  const harness = await renderManager({ lastActionTab: "domain-registry" });

  await waitFor(() => {
    const active = zoneViewTabs().filter(
      (tab) => tab.getAttribute("aria-selected") === "true",
    );
    assert.deepEqual(
      active.map((tab) => tab.textContent),
      ["Records"],
      "the restored Registry view has to fall back to a tab that exists",
    );
  });
  assert.deepEqual(
    harness.registryCalls().map((call) => call.command),
    [],
    "and the restore must not have spent a registry request on the way",
  );
});

test("a restored Registry workspace says it is off and mounts no monitor", async () => {
  // Every button that opens this workspace is gone while the switch is off, but
  // two paths can still land on it: a profile that had the tab open, and a
  // notice or assistant link that names a domain. So it has to say what
  // happened rather than show an empty monitor that reads as "no domains" —
  // and `RegistryMonitor` must stay unmounted, because mounting it is what
  // makes the requests.
  storageManager.setRegistryMonitoringEnabled(false);
  const harness = await renderManager({ restoreRegistryTab: true });

  await screen.findByTestId("registry-monitoring-off");
  assert.ok(
    screen.queryByRole("button", { name: /refresh/i }) === null,
    "a disabled feature must not leave the monitor's refresh button behind",
  );
  assert.deepEqual(
    harness.registryCalls().map((call) => call.command),
    [],
    "an unmounted monitor is the measurement: nothing may have been asked",
  );

  // The notice is only useful if it leads somewhere, so it offers the switch —
  // on the General subtab, already revealed, showing the state it is actually
  // in.
  fireEvent.click(
    screen.getByRole("button", {
      name: "Open the registry monitoring setting",
    }),
  );
  await waitFor(() =>
    assert.equal(
      rowSwitch("registry-monitoring-enabled").getAttribute("aria-checked"),
      "false",
    ),
  );
});

// ── The Cloudflare latency probe ─────────────────────────────────────────────

test("the latency preference reaches the connection bar", async () => {
  await renderManager();
  // Control: on by default, so a reading arrives and the chip is there.
  await waitFor(() => assert.ok(screen.getByTestId("cloudflare-latency")));

  cleanup();
  mock.restoreAll();
  clearMocks();
  storageManager.setCloudflareLatencyEnabled(false);
  await renderManager();

  assert.ok(
    screen.queryByTestId("cloudflare-latency") === null,
    "with the probe off the chip must be absent, not showing a stale reading",
  );
});

// ── Passkeys ────────────────────────────────────────────────────────────────

test("the passkey switch will not go off until the password route is proven", async () => {
  storageManager.setCurrentSession("switch-key-id");
  const harness = await renderManager({ decryptPassword: "correct-horse" });
  await openGeneralSettings();

  fireEvent.click(rowSwitch("passkeys-enabled"));
  await screen.findByTestId("passkey-disable-confirm");

  // A wrong password leaves the feature on. This is the whole point of the
  // guard: a passkey may be the only route the user still remembers, and the
  // switch must not take it away on the strength of a click.
  fireEvent.change(screen.getByTestId("passkey-disable-password"), {
    target: { value: "wrong" },
  });
  fireEvent.click(screen.getByTestId("passkey-disable-submit"));
  await screen.findByRole("alert");
  assert.equal(storageManager.getPasskeysEnabled(), true);
  assert.equal(
    rowSwitch("passkeys-enabled").getAttribute("aria-checked"),
    "true",
  );

  // The right one proves there is another way in, and the switch goes off.
  fireEvent.change(screen.getByTestId("passkey-disable-password"), {
    target: { value: "correct-horse" },
  });
  fireEvent.click(screen.getByTestId("passkey-disable-submit"));
  await waitFor(() =>
    assert.equal(
      rowSwitch("passkeys-enabled").getAttribute("aria-checked"),
      "false",
    ),
  );
  assert.equal(storageManager.getPasskeysEnabled(), false);
  assert.ok(
    harness.calls("decrypt_api_key").length >= 2,
    "both attempts have to have gone through a real decrypt, not a string compare",
  );
});
