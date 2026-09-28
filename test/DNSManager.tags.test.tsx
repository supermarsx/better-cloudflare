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
} from "@testing-library/react";

import { DNSManager } from "../src/components/dns/DNSManager";
import {
  TauriClient,
  type McpServerStatus,
  type TauriDNSRecord,
  type TauriZone,
} from "../src/lib/api/tauri-client";
import { storageManager } from "../src/lib/storage/storage";
import { DEFAULT_TAG_COLOR_ID } from "../src/components/tags/tag-colors";

const originalFetch = globalThis.fetch;

const ZONE = {
  id: "zone-1",
  name: "example.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

/** `TauriDNSRecord.id` is optional, so the id is named separately. */
const RECORD_ID = "rec-1";

const RECORD = {
  id: RECORD_ID,
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

/** Boot straight into the Tag manager tab by restoring it as the last tab. */
function mockRuntime(): void {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  mock.method(TauriClient, "getPreferences", async () => ({
    reopen_last_tabs: true,
    last_open_tabs: ["__tags"],
    last_active_tab: "__tags",
    last_zone: ZONE.id,
  }));
  mock.method(TauriClient, "updatePreferences", async () => {});
  mock.method(TauriClient, "getZones", async () => [ZONE]);
  mock.method(TauriClient, "getDNSRecords", async () => [RECORD]);
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
}

afterEach(() => {
  cleanup();
  mock.restoreAll();
  for (const tag of storageManager.getZoneTags(ZONE.id))
    storageManager.deleteTag(ZONE.id, tag);
  storageManager.clearRecordTags(ZONE.id, RECORD_ID);
  storageManager.clearSettings();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

/**
 * Deliver the change notification a browser would deliver on its own.
 *
 * Every tag write ends in `StorageManager.dispatchRecordTagsChanged`, which is
 * what makes the Tag manager re-read the catalog and the colours. That event
 * cannot survive this harness: `node-test-env.ts` wraps `window.dispatchEvent`
 * in a try/catch that swallows failures, and jsdom rejects the Node-global
 * `CustomEvent` the storage layer constructs. So the write below is the
 * component's own, and only the announcement is re-sent by hand -- with jsdom's
 * constructor and the payload the real dispatcher uses.
 */
async function deliverTagChange(): Promise<void> {
  const jsdomWindow = window as unknown as { CustomEvent: typeof CustomEvent };
  await act(async () => {
    window.dispatchEvent(
      new jsdomWindow.CustomEvent("record-tags-changed", {
        detail: { zoneId: ZONE.id },
      }),
    );
  });
}

/**
 * The catalog row that configures `tag`. Only catalog rows carry a colour
 * picker, which is what separates them from the record-association rows below
 * (those render chips for the same tag names).
 */
function tagRow(tag: string): HTMLElement {
  for (const node of screen.getAllByText(tag)) {
    if (!node.hasAttribute("data-tag-color")) continue;
    const row = node.closest(".grid");
    if (
      row instanceof HTMLElement &&
      row.querySelector("[data-tag-color-option]")
    )
      return row;
  }
  assert.fail(`expected a Tag manager catalog row for ${tag}`);
}

function chipColor(row: HTMLElement): string | null {
  return (
    row.querySelector("[data-tag-color]")?.getAttribute("data-tag-color") ??
    null
  );
}

function swatch(row: HTMLElement, colorId: string): HTMLButtonElement {
  const button = row.querySelector<HTMLButtonElement>(
    `[data-tag-color-option="${colorId}"]`,
  );
  assert.ok(button, `expected a ${colorId} swatch in the row`);
  return button;
}

function rowButton(row: HTMLElement, label: string): HTMLButtonElement {
  const button = screen
    .getAllByRole("button", { name: label })
    .find((candidate) => row.contains(candidate));
  assert.ok(button, `expected a ${label} button in the row`);
  return button as HTMLButtonElement;
}

async function openTagManager(): Promise<void> {
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await screen.findByText("Tag manager");
  // The zone select defaults to the first available zone, which is what unlocks
  // the catalog table and the association list below it.
  await screen.findByText("Record associations");
}

test("the add form creates a tag in the colour chosen beside it", async () => {
  mockRuntime();
  await openTagManager();

  // With no tags yet, the only picker on screen is the add form's.
  const addFormSwatch = document.querySelector<HTMLButtonElement>(
    '[data-tag-color-option="violet"]',
  );
  assert.ok(addFormSwatch, "the add form must offer the palette");
  assert.equal(addFormSwatch.getAttribute("aria-pressed"), "false");

  fireEvent.click(addFormSwatch);
  fireEvent.change(screen.getByPlaceholderText("New tag"), {
    target: { value: "  staging  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add tag" }));

  await waitFor(
    () => assert.deepEqual(storageManager.getZoneTags(ZONE.id), ["staging"]),
    { timeout: 2000 },
  );
  assert.equal(storageManager.getTagColor(ZONE.id, "staging"), "violet");

  await deliverTagChange();
  assert.equal(chipColor(tagRow("staging")), "violet");
});

test("a tag added with no colour picked renders in the default colour", async () => {
  mockRuntime();
  storageManager.addZoneTag(ZONE.id, "legacy");
  await openTagManager();

  const row = tagRow("legacy");
  assert.equal(chipColor(row), DEFAULT_TAG_COLOR_ID);
  assert.equal(
    swatch(row, DEFAULT_TAG_COLOR_ID).getAttribute("aria-pressed"),
    "true",
  );
});

test("clicking a swatch recolours the tag and redraws its chip", async () => {
  mockRuntime();
  storageManager.addZoneTag(ZONE.id, "prod", "blue");
  await openTagManager();

  const row = tagRow("prod");
  assert.equal(chipColor(row), "blue");
  assert.equal(swatch(row, "blue").getAttribute("aria-pressed"), "true");
  assert.equal(swatch(row, "green").getAttribute("aria-pressed"), "false");

  fireEvent.click(swatch(row, "green"));

  await waitFor(
    () => assert.equal(storageManager.getTagColor(ZONE.id, "prod"), "green"),
    { timeout: 2000 },
  );
  // The tag itself is untouched by a recolour.
  assert.deepEqual(storageManager.getZoneTags(ZONE.id), ["prod"]);

  await deliverTagChange();
  const redrawn = tagRow("prod");
  assert.equal(chipColor(redrawn), "green");
  assert.equal(swatch(redrawn, "green").getAttribute("aria-pressed"), "true");
  assert.equal(swatch(redrawn, "blue").getAttribute("aria-pressed"), "false");
});

test("renaming a tag from the manager keeps its colour and its records", async () => {
  mockRuntime();
  storageManager.addZoneTag(ZONE.id, "ops", "teal");
  storageManager.setRecordTags(ZONE.id, RECORD_ID, ["ops"]);
  await openTagManager();

  fireEvent.click(rowButton(tagRow("ops"), "Rename"));
  fireEvent.change(await screen.findByDisplayValue("ops"), {
    target: { value: "operations" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(
    () => assert.deepEqual(storageManager.getZoneTags(ZONE.id), ["operations"]),
    { timeout: 2000 },
  );
  assert.equal(storageManager.getTagColor(ZONE.id, "operations"), "teal");
  assert.equal(storageManager.getTagColor(ZONE.id, "ops"), undefined);
  assert.deepEqual(storageManager.getRecordTags(ZONE.id, RECORD_ID), [
    "operations",
  ]);

  await deliverTagChange();
  assert.equal(chipColor(tagRow("operations")), "teal");
});

test("deleting a tag from the manager takes its colour and references with it", async () => {
  mockRuntime();
  storageManager.addZoneTag(ZONE.id, "doomed", "red");
  storageManager.addZoneTag(ZONE.id, "kept", "amber");
  storageManager.setRecordTags(ZONE.id, RECORD_ID, ["doomed", "kept"]);
  await openTagManager();

  fireEvent.click(rowButton(tagRow("doomed"), "Delete"));

  await waitFor(
    () => assert.deepEqual(storageManager.getZoneTags(ZONE.id), ["kept"]),
    { timeout: 2000 },
  );
  assert.equal(storageManager.getTagColor(ZONE.id, "doomed"), undefined);
  // Deleting one tag must not disturb the others or their records.
  assert.equal(storageManager.getTagColor(ZONE.id, "kept"), "amber");
  assert.deepEqual(storageManager.getRecordTags(ZONE.id, RECORD_ID), ["kept"]);

  await deliverTagChange();
  assert.equal(chipColor(tagRow("kept")), "amber");
  assert.equal(
    screen
      .queryAllByText("doomed")
      .filter((node) => node.hasAttribute("data-tag-color")).length,
    0,
    "a deleted tag must stop rendering anywhere",
  );
});

test("tag chips being configured stay at full size", async () => {
  mockRuntime();
  storageManager.addZoneTag(ZONE.id, "prod", "blue");
  storageManager.setRecordTags(ZONE.id, RECORD_ID, ["prod"]);
  await openTagManager();

  const chips = Array.from(
    document.querySelectorAll<HTMLElement>("[data-tag-color]"),
  );
  assert.ok(chips.length > 0, "the manager must render tag chips");
  for (const chip of chips) {
    assert.equal(
      chip.getAttribute("data-tag-size"),
      "default",
      "a tag being configured must not be shrunk",
    );
    assert.equal(chip.style.fontSize, "");
  }
});
