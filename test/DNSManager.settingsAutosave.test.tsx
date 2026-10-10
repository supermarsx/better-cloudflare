/**
 * The settings panel's autosave, wired to the screen.
 *
 * `DNSManager` persists its settings from one effect that writes *everything*
 * from current state: around sixty `storageManager` keys and, on desktop, a
 * 45-field preference payload over IPC. Before the autosave that ran once per
 * state change, so a free-text setting cost the whole lot per keystroke; what
 * is measured here is that a change now costs one write, and — the half that
 * matters more — that making it cheaper did not make it lossy.
 *
 * Every claim is measured at the host boundary, as the payloads
 * `TauriClient.updatePreferenceFields` was handed, filtered to the ones
 * carrying `domain_audit_categories`: that key is written by the settings
 * effect and by nothing else, so the tab-state and auto-refresh writes that
 * share the same method cannot be mistaken for a settings write. The
 * `storageManager` half is counted separately, through the one setter that
 * effect always calls, because the two halves could regress apart.
 *
 * `useDebouncedAutosave.test.tsx` holds the properties this file cannot
 * separate — a burst spread across the window, the two halves of the ready
 * gate, a flush being synchronous.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { TauriEvent, emit } from "@tauri-apps/api/event";

import { DNSManager } from "../src/components/dns/DNSManager";
import { SETTINGS_SUBTABS } from "../src/components/dns/settings-search";
import { Toaster } from "../src/components/ui/toaster";
import { SETTINGS_AUTOSAVE_DEBOUNCE_MS } from "../src/hooks/dns/use-debounced-autosave";
import { resetToastRuntimeForTests } from "../src/hooks/use-toast";
import {
  TauriClient,
  type McpServerStatus,
  type TauriDNSRecord,
  type TauriZone,
} from "../src/lib/api/tauri-client";
import { resetRuntimeReportingForTests } from "../src/lib/errors/runtime-reporting";
import { storageManager } from "../src/lib/storage/storage";

import { useEnglishLocale } from "./i18n-ready";
import { enableThemedSelectEnvironment } from "./radix-select";

const originalFetch = globalThis.fetch;

const ZONE = {
  id: "autosave-zone",
  name: "autosave.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

const RECORD = {
  id: "rec-a",
  type: "A",
  name: "a.autosave.test",
  content: "1.1.1.1",
  ttl: 300,
  proxied: false,
  zone_id: ZONE.id,
  zone_name: ZONE.name,
  created_on: "2026-09-01T10:00:00Z",
  modified_on: "2026-09-01T10:01:00Z",
} as TauriDNSRecord;

/**
 * The field that identifies a settings write.
 *
 * Written by the settings persistence effect and by no other caller of
 * `updatePreferenceFields`, which is what makes a count of payloads carrying
 * it a count of settings writes rather than of preference writes in general.
 */
const SETTINGS_MARKER = "domain_audit_categories";

/** Five host-backed switches in the General subtab, and the fields they set. */
const SWITCHES = [
  ["rewrite-copied-record-domains", "rewrite_copied_record_domains"],
  ["unsupported-record-types", "show_unsupported_record_types"],
  ["middle-click-closes-tabs", "close_tab_on_middle_click"],
  ["confirm-logout", "confirm_logout"],
  ["reopen-last-tabs", "reopen_last_tabs"],
] as const;

interface Harness {
  /** Every settings payload the host was handed, in order. */
  settingsWrites: () => Record<string, unknown>[];
  /** How many times the effect's `storageManager` half ran. */
  localWrites: () => number;
  /** Forget what has been seen so far. */
  reset: () => void;
  /** Make the next host write fail with this message. */
  failNextWrite: (message: string) => void;
  /** Let a held-back preference load complete. */
  releasePreferences: () => void;
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

interface RuntimeOptions {
  /** Hold the preference load open, so `prefsReady` stays false. */
  holdPreferences?: boolean;
}

/**
 * Mock the host.
 *
 * `shouldMockEvents` is on because the close-request flush is registered with
 * `listen`, and the only way to prove it fires is to emit the event the host
 * would have sent. An unrecognised command throws rather than resolving: a
 * permissive `undefined` crashes `DNSManager`'s render somewhere else entirely
 * and never names the command that was missing.
 */
function mockRuntime(options: RuntimeOptions = {}): Harness {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  enableThemedSelectEnvironment();
  mockWindows("main");

  mockIPC(
    (command) => {
      switch (command) {
        case "set_registry_monitoring_enabled":
          return undefined;
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
    },
    { shouldMockEvents: true },
  );

  const written: Record<string, unknown>[] = [];
  let seen = 0;
  let failure: string | null = null;
  let release: (() => void) | null = null;
  const gate = options.holdPreferences
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : null;

  mock.method(
    TauriClient,
    "updatePreferenceFields",
    async (fields: Record<string, unknown>) => {
      written.push(fields);
      if (failure !== null && SETTINGS_MARKER in fields) {
        const message = failure;
        failure = null;
        throw new Error(message);
      }
    },
  );
  // No implementation: the real setter still runs, so the state the effect
  // writes is the state a reload would read. Only the call count is new.
  const localSpy = mock.method(storageManager, "setDomainAuditCategories");

  mock.method(TauriClient, "getPreferences", async () => {
    if (gate) await gate;
    // A held-back load must not also restore a workspace tab: the restore
    // navigates away from Session settings, which would unmount the indicator
    // the test is reading at the exact moment the gate opens.
    if (gate) return { reopen_last_tabs: false };
    return {
      reopen_last_tabs: true,
      reopen_zone_tabs: { [ZONE.id]: true },
      last_open_tabs: [ZONE.id],
      last_zone: ZONE.id,
      last_active_tab: `${ZONE.id}|records`,
    };
  });
  mock.method(TauriClient, "updatePreferences", async () => {});
  mock.method(TauriClient, "getZones", async () => [ZONE]);
  mock.method(TauriClient, "getDNSRecords", async () => [RECORD]);
  mock.method(TauriClient, "getAuditEntries", async () => []);
  mock.method(TauriClient, "getMcpServerStatus", async () => createMcpStatus());
  mock.method(TauriClient, "setMcpEnabledTools", async () => createMcpStatus());

  globalThis.fetch = async () => {
    throw new Error("no test may reach the network");
  };

  const settingsWrites = () =>
    written.slice(seen).filter((fields) => SETTINGS_MARKER in fields);

  return {
    settingsWrites,
    localWrites: () => localSpy.mock.callCount() - localBaseline.count,
    reset: () => {
      seen = written.length;
      localBaseline.count = localSpy.mock.callCount();
    },
    failNextWrite: (message) => {
      failure = message;
    },
    releasePreferences: () => release?.(),
  };
}

/** Mutable so `reset` can rebase the `storageManager` count. */
const localBaseline = { count: 0 };

async function renderManager(options: RuntimeOptions = {}): Promise<Harness> {
  await useEnglishLocale();
  localBaseline.count = 0;
  const harness = mockRuntime(options);
  render(
    <>
      <DNSManager
        apiKey="autosave-key"
        email="owner@autosave.test"
        onLogout={() => {}}
      />
      <Toaster />
    </>,
  );
  return harness;
}

afterEach(() => {
  cleanup();
  resetToastRuntimeForTests();
  resetRuntimeReportingForTests();
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

function saveState(): HTMLElement {
  return screen.getByTestId("settings-save-state");
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

function settingRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`);
  assert.ok(row, `no settings row with data-setting-id="${id}"`);
  return row;
}

function rowSwitch(id: string): HTMLElement {
  return within(settingRow(id)).getByRole("switch", { hidden: true });
}

function switchIsOn(id: string): boolean {
  return rowSwitch(id).getAttribute("aria-checked") === "true";
}

async function pause(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

/**
 * Open the General subtab and wait until the panel has stopped writing.
 *
 * The indicator is the readiness signal, and `saved` is the one that means
 * ready here: mounting schedules a write of its own (the loaded preferences,
 * and then the session profile rebuilt from them), so `idle` is a state the
 * panel passes through on its way rather than one it settles in. Settling is
 * then confirmed rather than assumed — a `fireEvent` fired while a startup
 * write is still outstanding would be counted as part of it.
 */
async function openGeneralSettings(harness: Harness): Promise<void> {
  await openSettings();
  fireEvent.click(subtabButton("general"));
  await waitFor(
    () =>
      assert.equal(subtabButton("general").getAttribute("data-active"), "true"),
    { timeout: 5000 },
  );
  await waitFor(
    () => assert.equal(saveState().getAttribute("data-state"), "saved"),
    { timeout: 10000 },
  );
  const before = harness.settingsWrites().length;
  await pause(SETTINGS_AUTOSAVE_DEBOUNCE_MS);
  assert.equal(
    harness.settingsWrites().length,
    before,
    "the panel was still writing when a test started measuring",
  );
  harness.reset();
}

// ── One change, one write ───────────────────────────────────────────────────

test("a burst of changes costs one write, not one each", async () => {
  const harness = await renderManager();
  await openGeneralSettings(harness);

  const expected = new Map<string, boolean>();
  for (const [row, field] of SWITCHES) {
    const next = !switchIsOn(row);
    fireEvent.click(rowSwitch(row));
    expected.set(field, next);
  }

  // Nothing has gone out yet, which is the debounce itself: without it these
  // five clicks are five payloads and five passes over `storageManager`.
  assert.equal(
    harness.settingsWrites().length,
    0,
    "a settings write went out mid-burst",
  );
  assert.equal(harness.localWrites(), 0);
  assert.equal(saveState().getAttribute("data-dirty"), "true");

  // `data-dirty`, not `data-state`: `saved` is sticky until the next change,
  // so it is already on the indicator from the startup write and waiting for
  // it would return before this burst had been written at all.
  await waitFor(
    () => assert.equal(saveState().getAttribute("data-dirty"), "false"),
    { timeout: 5000 },
  );
  assert.equal(saveState().getAttribute("data-state"), "saved");

  const writes = harness.settingsWrites();
  assert.equal(writes.length, 1, "the burst cost more than one host write");
  assert.equal(harness.localWrites(), 1, "the local half was written twice");
  for (const [field, value] of expected) {
    assert.equal(
      writes[0]?.[field],
      value,
      `the single write did not carry ${field}`,
    );
  }
  for (const [row, field] of SWITCHES) {
    assert.equal(
      switchIsOn(row),
      expected.get(field),
      `${row} does not show what was written`,
    );
  }
});

// ── The loss cases ──────────────────────────────────────────────────────────

test("a change made inside the debounce window survives unmount", async () => {
  const harness = await renderManager();
  await openGeneralSettings(harness);

  const next = !switchIsOn("confirm-logout");
  fireEvent.click(rowSwitch("confirm-logout"));
  assert.equal(harness.settingsWrites().length, 0);

  // The window closes with the write still only a timer. Before the flush on
  // unmount this change existed nowhere but in that timer.
  cleanup();

  const writes = harness.settingsWrites();
  assert.equal(
    writes.length,
    1,
    "a change made inside the debounce window was lost at unmount",
  );
  assert.equal(writes[0]?.confirm_logout, next);
});

test("a window close request flushes the pending write", async () => {
  const harness = await renderManager();
  await openGeneralSettings(harness);

  const next = !switchIsOn("confirm-logout");
  fireEvent.click(rowSwitch("confirm-logout"));
  assert.equal(harness.settingsWrites().length, 0);

  // What the host sends when the window is asked to close. With
  // `confirm_window_close` off there is no dialog between this and the window
  // going, so this is the last moment a pending write has.
  await act(async () => {
    await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  });

  const writes = harness.settingsWrites();
  assert.equal(
    writes.length,
    1,
    "a close request did not flush the pending write",
  );
  assert.equal(writes[0]?.confirm_logout, next);
});

test("a change made before stored preferences arrive is not written", async () => {
  const harness = await renderManager({ holdPreferences: true });
  await openSettings();
  fireEvent.click(subtabButton("general"));
  await waitFor(() =>
    assert.equal(subtabButton("general").getAttribute("data-active"), "true"),
  );

  assert.equal(
    saveState().getAttribute("data-state"),
    "loading",
    "the panel claimed to be ready while preferences were still loading",
  );

  fireEvent.click(rowSwitch("confirm-logout"));
  await pause(SETTINGS_AUTOSAVE_DEBOUNCE_MS * 3);

  // The gate exists so that a first render cannot write component defaults
  // over stored preferences. A debounced write is the one thing that could
  // cross it, so it has to be measured after the window has passed.
  assert.equal(
    harness.settingsWrites().length,
    0,
    "a settings write went out before stored preferences had loaded",
  );
  assert.equal(harness.localWrites(), 0);
  assert.equal(saveState().getAttribute("data-dirty"), "false");

  // And the measurement would have seen a write: the same panel, once the
  // load completes, writes.
  harness.releasePreferences();
  await waitFor(
    () => assert.equal(saveState().getAttribute("data-state"), "saved"),
    { timeout: 10000 },
  );
  assert.ok(
    harness.settingsWrites().length >= 1,
    "nothing was written even after the preferences arrived",
  );
});

// ── Failure ─────────────────────────────────────────────────────────────────

test("a refused write says so instead of reporting a save", async () => {
  const harness = await renderManager();
  await openGeneralSettings(harness);

  harness.failNextWrite("the host refused the preference write");
  fireEvent.click(rowSwitch("confirm-logout"));

  await waitFor(
    () => assert.equal(saveState().getAttribute("data-state"), "error"),
    { timeout: 5000 },
  );
  const text = saveState().textContent ?? "";
  assert.match(text, /Could not save/);
  assert.match(text, /the host refused the preference write/);

  // And it recovers: the next change is not stuck reporting the old failure.
  fireEvent.click(rowSwitch("confirm-logout"));
  await waitFor(
    () => assert.equal(saveState().getAttribute("data-state"), "saved"),
    { timeout: 5000 },
  );
});
