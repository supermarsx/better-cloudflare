/**
 * Portable configuration, as the Settings screen actually drives it.
 *
 * The unit tests under `test/portable*` and `test/SettingsImportDiff.test.tsx`
 * already pin the library and the panels. What they cannot see is the wiring,
 * and the wiring is where the format's two load-bearing promises are either
 * kept or quietly broken:
 *
 *  1. **No write without the preview.** A settings file that parses produces a
 *     diff and nothing else. `src/lib/portable/types.ts` states this as part
 *     of the format rather than as a courtesy, so `a parsed settings file
 *     writes nothing until the preview is applied` reads the preferences back
 *     out of storage *before* Apply all is pressed and asserts they have not
 *     moved.
 *  2. **Apply all writes `changed` only.** Never an untouched `optIn` row, and
 *     never a `withheld` one. `apply all writes the changed rows and leaves
 *     opt-in and withheld alone` is the test that fails if the owner ever
 *     hands `diff.optIn` to its writer.
 *
 * The fixture puts one preference in each of the three lanes, and the lanes
 * are not symmetric — which is the thing worth being careful about. Turning
 * `registryMonitoringEnabled` *off* is an ordinary change; turning
 * `cloudflareLatencyEnabled` *on* needs a tick; turning `passkeysEnabled`
 * *off* is refused outright. So the current state is arranged to make the
 * file's values travel in those directions, and `the fixture lands one row in
 * each lane` asserts the arrangement worked rather than leaving the two
 * negative claims to pass vacuously on an empty diff.
 *
 * Preferences are read back through `storageManager`, not through the DOM, and
 * every key in the fixture was picked because it can be: these five are
 * browser-preference leaves with no field in the Rust `Preferences` object, so
 * `storageManager` is the one store on either platform and reading it is
 * reading what was actually written. A key that persists through
 * `updatePreferenceFields` on desktop would have been measured against a mock
 * instead.
 *
 * `assert.ok(node === null)` rather than `assert.equal(node, null)`
 * throughout — a failed strict comparison inspects the jsdom element and walks
 * its whole document graph, which has taken a worker down in this suite
 * before.
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
import { exportSettings, exportToolPermissions } from "../src/lib/portable";
import { storageManager } from "../src/lib/storage/storage";
import type { BrowserPreferenceData } from "../src/lib/storage/storage-util";

import { useEnglishLocale } from "./i18n-ready";
import { enableThemedSelectEnvironment } from "./radix-select";

const originalFetch = globalThis.fetch;

const ZONE = {
  id: "portable-zone",
  name: "portable.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

const RECORD = {
  id: "rec-portable",
  type: "A",
  name: "a.portable.test",
  content: "1.1.1.1",
  ttl: 300,
  proxied: false,
  zone_id: ZONE.id,
  zone_name: ZONE.name,
  created_on: "2026-09-01T10:00:00Z",
  modified_on: "2026-09-01T10:01:00Z",
} as TauriDNSRecord;

/**
 * The preferences the imported file carries.
 *
 * Three ordinary changes and two switches, chosen so that one row lands in
 * each of the diff's three lanes given the state {@link presetPreferences}
 * arranges. `cloudflareLatencyEnabled: true` is an opt-in only because the
 * machine has it explicitly off; `passkeysEnabled: false` is withheld only
 * because the machine has it on, which for that preference means absent.
 */
const IMPORTED_PREFERENCES: BrowserPreferenceData = {
  recycleBinRetentionDays: 45,
  updateCheckIntervalHours: 48,
  registryMonitoringEnabled: false,
  cloudflareLatencyEnabled: true,
  passkeysEnabled: false,
};

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
 * The host, intercepted at the IPC boundary.
 *
 * An unrecognised command throws rather than resolving, so a new call cannot
 * slip through unnoticed — which is what makes the two "nothing was written"
 * claims below measurements rather than absences of assertions.
 */
function mockRuntime(): void {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  enableThemedSelectEnvironment();

  mockIPC((command) => {
    switch (command) {
      case "set_registry_monitoring_enabled":
        return undefined;
      case "app_host_facts":
        return { releaseTag: "26.4", os: "windows", arch: "x86_64" };
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
    last_zone: ZONE.id,
    last_active_tab: `${ZONE.id}|records`,
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
  mock.method(TauriClient, "aiListPersonas", async () => []);

  globalThis.fetch = async () => {
    throw new Error("no test may reach the network");
  };
}

/**
 * The state the file is imported onto.
 *
 * Written before the screen mounts, because the diff is computed against the
 * preferences the component read at that point — and because
 * `cloudflareLatencyEnabled` has to be *explicitly* off for the file's `true`
 * to count as enabling. Absent would mean on, and an unchanged switch produces
 * no row at all.
 */
function presetPreferences(): void {
  storageManager.setCloudflareLatencyEnabled(false);
  storageManager.setRecycleBinRetentionDays(30);
  storageManager.setUpdateCheckIntervalHours(24);
}

async function renderManager(): Promise<void> {
  await useEnglishLocale();
  mockRuntime();
  presetPreferences();
  render(
    <>
      <DNSManager
        apiKey="portable-key"
        email="owner@portable.test"
        onLogout={() => {}}
      />
      <Toaster />
    </>,
  );
  await screen.findByTestId("dns-records-table");
}

afterEach(() => {
  cleanup();
  resetToastRuntimeForTests();
  mock.restoreAll();
  clearMocks();
  // The saved-set library is deliberately not a "setting": `clearSettings`
  // leaves `mcpPermissionSets` alone, because a set survives a session-profile
  // switch. So it is cleared by name, or the set one test imports is still
  // there for the next one to find.
  for (const name of Object.keys(storageManager.getMcpPermissionSets())) {
    storageManager.deleteMcpPermissionSet(name);
  }
  storageManager.clearSettings();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

// ── Driving the screen ──────────────────────────────────────────────────────

function subtabButton(id: string): HTMLElement {
  const descriptor = SETTINGS_SUBTABS.find((subtab) => subtab.id === id);
  assert.ok(descriptor, `no such subtab: ${id}`);
  return within(
    screen.getByRole("toolbar", { name: "Session settings sections" }),
  ).getByRole("button", { name: descriptor.label });
}

async function openSettingsSubtab(id: string): Promise<void> {
  const button = await screen.findByRole("button", { name: "Settings" });
  await waitFor(() => {
    fireEvent.click(button);
    assert.ok(
      screen.queryByTestId("settings-search"),
      "the Session settings tab did not open",
    );
  });
  fireEvent.click(subtabButton(id));
  await waitFor(() =>
    assert.equal(subtabButton(id).getAttribute("data-active"), "true"),
  );
}

async function openProfilesSettings(): Promise<void> {
  await openSettingsSubtab("profiles");
}

function settingRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`);
  assert.ok(row, `no settings row with data-setting-id="${id}"`);
  return row;
}

/** One exported settings file, written by the app's own exporter. */
function settingsFileContents(
  preferences: BrowserPreferenceData = IMPORTED_PREFERENCES,
): string {
  return JSON.stringify(
    exportSettings(preferences, {
      appVersion: "26.4",
      now: new Date("2026-02-02T00:00:00.000Z"),
    }),
  );
}

/**
 * One exported tool-permissions file, written by the app's own exporter.
 *
 * `cf_list_zones` is `read` risk and `cf_delete_dns_record` is `destructive`,
 * which is the whole point of the fixture: an import may enable the first and
 * must not enable the second.
 */
function toolPermissionsFileContents(): string {
  return JSON.stringify(
    exportToolPermissions(
      {
        enabledToolIds: ["cf_list_zones", "cf_delete_dns_record"],
        sets: { Imported: ["cf_list_zones"] },
      },
      { appVersion: "26.4", now: new Date("2026-02-02T00:00:00.000Z") },
    ),
  );
}

/**
 * Hand the screen a file, the way the host's dialog does.
 *
 * `input.click()` opens nothing under jsdom, so the pick is driven from the
 * other end: press the panel's button, which leaves `onPickFile`'s promise
 * waiting on the shared hidden input, then fire the `change` that a chosen
 * file produces. `window.File` rather than the global one — a `File` from
 * Node's realm is not the `File` jsdom's input accepts.
 */
async function importPortableFile(
  contents: string,
  kind: "Settings" | "Personas" | "Tool permissions" = "Settings",
): Promise<void> {
  const panel = within(settingRow("portable-import"));
  if (kind !== "Settings") {
    fireEvent.click(panel.getByRole("radio", { name: kind }));
  }
  fireEvent.click(panel.getByRole("button", { name: "Choose a file" }));

  const input = screen.getByTestId("portable-pick-input");
  const file = new window.File([contents], "better-cloudflare-settings.json", {
    type: "application/json",
  });
  fireEvent.change(input, { target: { files: [file] } });
}

/** The keys of each diff lane the preview is currently showing. */
function previewRows(kind: "changed" | "opt-in" | "withheld"): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-testid="diff-row"][data-row-kind="${kind}"]`,
    ),
  ).map((row) => row.dataset.key ?? "");
}

function applyAll(): void {
  const diff = screen.getByTestId("settings-import-diff");
  fireEvent.click(within(diff).getByRole("button", { name: "Apply all" }));
}

/** What storage says about the five preferences the file carries. */
function storedPreferences(): Record<string, unknown> {
  return {
    recycleBinRetentionDays: storageManager.getRecycleBinRetentionDays(),
    updateCheckIntervalHours: storageManager.getUpdateCheckIntervalHours(),
    registryMonitoringEnabled: storageManager.getRegistryMonitoringEnabled(),
    cloudflareLatencyEnabled: storageManager.getCloudflareLatencyEnabled(),
    passkeysEnabled: storageManager.getPasskeysEnabled(),
  };
}

// ── The group is reachable at all ───────────────────────────────────────────

test("the Profiles subtab mounts the export and import panels", async () => {
  await renderManager();
  await openProfilesSettings();

  assert.ok(
    within(settingRow("portable-export")).getByTestId("portable-export"),
    "the export panel is not mounted in its settings row",
  );
  assert.ok(
    within(settingRow("portable-import")).getByTestId("portable-import"),
    "the import panel is not mounted in its settings row",
  );
  // Nothing has been read, so there is nothing to preview.
  assert.ok(
    screen.queryByTestId("settings-import-diff") === null,
    "a preview is on screen before any file was chosen",
  );

  // The export preview counts the payload the exporter would actually write,
  // so a non-zero count is the proof that this machine's preferences reached
  // the panel at all — the one thing a mounted-but-unfed panel would fake.
  await waitFor(() => {
    const summary = screen.getByTestId("portable-export-summary");
    assert.match(summary.textContent ?? "", /^[1-9]\d* preference\(s\)$/u);
  });
});

// ── No write without the preview ────────────────────────────────────────────

test("a parsed settings file writes nothing until the preview is applied", async () => {
  await renderManager();
  await openProfilesSettings();

  const before = storedPreferences();
  await importPortableFile(settingsFileContents());

  await waitFor(() =>
    assert.ok(
      screen.queryByTestId("settings-import-diff"),
      "the settings import showed no preview",
    ),
  );
  assert.deepEqual(
    storedPreferences(),
    before,
    "a settings file changed a preference before its preview was applied",
  );
});

test("the fixture lands one row in each lane", async () => {
  // Guards the two negative claims below from passing on an empty diff: if the
  // lib ever re-lanes one of these, that is a change to read about here rather
  // than a silently vacuous assertion there.
  await renderManager();
  await openProfilesSettings();
  await importPortableFile(settingsFileContents());
  await waitFor(() => assert.ok(screen.queryByTestId("settings-import-diff")));

  assert.deepEqual(previewRows("changed").sort(), [
    "recycleBinRetentionDays",
    "registryMonitoringEnabled",
    "updateCheckIntervalHours",
  ]);
  assert.deepEqual(previewRows("opt-in"), ["cloudflareLatencyEnabled"]);
  assert.deepEqual(previewRows("withheld"), ["passkeysEnabled"]);
});

// ── Apply all writes `changed` only ─────────────────────────────────────────

test("apply all writes the changed rows and leaves opt-in and withheld alone", async () => {
  await renderManager();
  await openProfilesSettings();
  await importPortableFile(settingsFileContents());
  await waitFor(() => assert.ok(screen.queryByTestId("settings-import-diff")));

  applyAll();

  await waitFor(() =>
    assert.equal(storageManager.getRecycleBinRetentionDays(), 45),
  );
  assert.deepEqual(storedPreferences(), {
    // `changed`: written.
    recycleBinRetentionDays: 45,
    updateCheckIntervalHours: 48,
    registryMonitoringEnabled: false,
    // `optIn`, and nobody ticked it: an import does not get to restart
    // outbound work someone deliberately stopped.
    cloudflareLatencyEnabled: false,
    // `withheld`: turning passkeys off needs the signed-in key's password, and
    // a file cannot produce one. Absent means on, which is what `true` here is.
    passkeysEnabled: true,
  });

  // The preview is spent; leaving it up would offer to apply it twice.
  await waitFor(() =>
    assert.ok(
      screen.queryByTestId("settings-import-diff") === null,
      "the preview is still on screen after it was applied",
    ),
  );
});

// ── An imported tool permission cannot skip the gate ────────────────────────

test("an imported tool above read-only arrives pending rather than enabled", async () => {
  // The third non-negotiable: imported permissions go through
  // `applyPortableToolPermissions` and then `stageMcpEnabledTools`, so a
  // destructive tool in the file is *pending confirmation* and never lands in
  // `mcpEnabledTools`. A wiring that wrote the preference directly would pass
  // every other test in this file.
  await renderManager();
  await openProfilesSettings();
  await importPortableFile(toolPermissionsFileContents(), "Tool permissions");

  await waitFor(() => {
    const snapshot = storageManager.getMcpEnabledToolsSnapshot();
    assert.deepEqual(snapshot.pendingHighRiskToolIds, ["cf_delete_dns_record"]);
    assert.ok(
      snapshot.enabledTools.includes("cf_list_zones"),
      "the read-risk tool in the file was not enabled",
    );
    assert.ok(
      !snapshot.enabledTools.includes("cf_delete_dns_record"),
      "a destructive tool was enabled by an import",
    );
  });

  // The file's saved set is persisted too, under the name it carried.
  // `Object.entries` rather than the object: `getMcpPermissionSets` returns a
  // null-prototype object, and `deepEqual` under `node:assert/strict` compares
  // prototypes.
  assert.deepEqual(Object.entries(storageManager.getMcpPermissionSets()), [
    ["Imported", ["cf_list_zones"]],
  ]);
});

// ── The MCP subtab's Permission sets group ──────────────────────────────────

test("the MCP subtab mounts the permission set editor, and saving reaches storage", async () => {
  await renderManager();
  await openSettingsSubtab("mcp");

  const row = within(settingRow("mcp-permission-sets"));
  assert.ok(
    row.getByTestId("permission-set-editor"),
    "the permission set editor is not mounted in its settings row",
  );
  assert.ok(
    row.getByTestId("no-sets"),
    "the editor claims saved sets on a machine that has none",
  );

  fireEvent.change(row.getByRole("textbox"), {
    target: { value: "Read only" },
  });
  fireEvent.click(row.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    assert.deepEqual(Object.keys(storageManager.getMcpPermissionSets()), [
      "Read only",
    ]),
  );
  // The list re-reads from storage rather than from whatever the editor
  // remembered, which is what a revision bump is for.
  await waitFor(() =>
    assert.equal(
      row.getByTestId("permission-set-row").dataset.set,
      "Read only",
    ),
  );
});

test("a ticked opt-in row is the only way its switch is written", async () => {
  // The other half of the claim above: the row is not inert, it is waiting for
  // a deliberate choice. Without this, "opt-in was not written" would also
  // pass for a screen whose opt-in rows can never be written at all.
  await renderManager();
  await openProfilesSettings();
  await importPortableFile(settingsFileContents());
  await waitFor(() => assert.ok(screen.queryByTestId("settings-import-diff")));

  const optIn = document.querySelector<HTMLElement>(
    '[data-testid="diff-row"][data-row-kind="opt-in"]',
  );
  assert.ok(optIn, "the opt-in row is not on screen");
  fireEvent.click(within(optIn).getByRole("checkbox"));
  applyAll();

  await waitFor(() =>
    assert.equal(storageManager.getCloudflareLatencyEnabled(), true),
  );
  // Still never the withheld row, however many ticks are made.
  assert.equal(storageManager.getPasskeysEnabled(), true);
});
