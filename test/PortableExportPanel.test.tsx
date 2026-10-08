/**
 * Choosing what leaves the app, and seeing what the file will hold.
 *
 * The tests that matter are the ones pinning the summary to the *projected*
 * payload rather than to the inputs. Each exporter drops things -- builtin
 * personas, machine-local preferences, tool ids that have left the catalogue --
 * and a summary counted from what the caller passed in would promise a file
 * this app does not write. The round-trip tests close the other half: what the
 * panel hands the host is a file this build's own parsers accept.
 *
 * `assert.ok(node === null)` rather than `assert.equal(node, null)`: under
 * `node:assert/strict` a failed comparison inspects the actual value, and
 * inspecting a jsdom element walks its whole document graph.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { PortableExportPanel } from "../src/components/portable/PortableExportPanel";
import {
  parsePersonasFile,
  parseSettingsFile,
  parseToolPermissionsFile,
} from "../src/lib/portable";
import type { AiPersona } from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";

const EXPORTED_AT = new Date("2026-03-04T05:06:07.000Z");

const PERSONAS: AiPersona[] = [
  {
    id: "dns-expert",
    name: "DNS expert",
    description: "Ships with the app",
    systemPrompt: "You are a DNS expert.",
    builtin: true,
  },
  {
    id: "custom-1",
    name: "Zone reviewer",
    description: "Reads a zone and reports on it",
    systemPrompt: "You review DNS zones.",
    builtin: false,
  },
];

interface Written {
  name: string;
  contents: string;
}

interface Harness {
  written: Written[];
}

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof PortableExportPanel>> = {},
  failure?: unknown,
): Harness {
  const harness: Harness = { written: [] };
  render(
    <PortableExportPanel
      appVersion="9.9.9"
      preferences={{
        autoRefreshInterval: 30,
        confirmDeleteRecord: true,
        // Machine-local: the exporter leaves it out, so the summary must not
        // count it either.
        lastZone: "example.com",
      }}
      personas={PERSONAS}
      toolPermissions={{
        enabledToolIds: ["cf_list_zones", "cf_not_a_real_tool"],
        sets: { "Read only": ["cf_list_zones"] },
      }}
      onExportFile={async (name, contents) => {
        if (failure !== undefined) throw failure;
        harness.written.push({ name, contents });
      }}
      now={EXPORTED_AT}
      {...overrides}
    />,
  );
  return harness;
}

function chooseKind(kind: string): void {
  const radio = document.querySelector<HTMLInputElement>(
    `input[name="portable-export-kind"][value="${kind}"]`,
  );
  assert.ok(radio, `expected a radio for ${kind}`);
  fireEvent.click(radio);
}

function summary(): string {
  return screen.getByTestId("portable-export-summary").textContent ?? "";
}

async function clickExport(harness: Harness): Promise<Written> {
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => {
    assert.ok(harness.written.length === 1, "expected one write");
  });
  return harness.written[0];
}

beforeEach(async () => {
  await useEnglishLocale();
});

afterEach(() => {
  cleanup();
});

test("the settings summary counts the preferences the file will carry", () => {
  renderPanel();
  // Two, not three: `lastZone` is machine-local and never travels.
  assert.match(summary(), /^2 preference\(s\)$/);
});

test("a settings export round-trips through this build's own parser", async () => {
  const harness = renderPanel();
  const written = await clickExport(harness);

  assert.equal(written.name, "better-cloudflare-settings.json");
  const parsed = parseSettingsFile(written.contents);
  assert.ok(parsed.ok, "expected the written file to parse");
  assert.equal(parsed.value.kind, "settings");
  assert.equal(parsed.value.appVersion, "9.9.9");
  assert.equal(parsed.value.exportedAt, EXPORTED_AT.toISOString());
  assert.deepEqual(Object.keys(parsed.value.payload.preferences).sort(), [
    "autoRefreshInterval",
    "confirmDeleteRecord",
  ]);
  assert.equal(parsed.warnings.length, 0);
});

test("the persona summary counts only the custom ones", () => {
  renderPanel();
  chooseKind("personas");
  // One of the two personas is builtin: the backend computes those from its
  // own presets, so re-importing one would duplicate or shadow it.
  assert.match(summary(), /^1 custom persona\(s\)$/);
});

test("a persona export carries no id and no builtin flag", async () => {
  const harness = renderPanel();
  chooseKind("personas");
  const written = await clickExport(harness);

  assert.equal(written.name, "better-cloudflare-personas.json");
  const parsed = parsePersonasFile(written.contents);
  assert.ok(parsed.ok, "expected the written file to parse");
  assert.deepEqual(parsed.value.payload, [
    {
      name: "Zone reviewer",
      description: "Reads a zone and reports on it",
      systemPrompt: "You review DNS zones.",
    },
  ]);
});

test("the tool-permissions summary counts what the catalogue still knows", () => {
  renderPanel();
  chooseKind("tool-permissions");
  // One of the two enabled ids is not in the reviewed catalogue, so the
  // exporter reconciles it away rather than writing a file that would report
  // it as unknown on the machine reading it.
  assert.match(summary(), /^1 enabled tool\(s\), 1 saved set\(s\)$/);
});

test("a tool-permissions export round-trips with its sets", async () => {
  const harness = renderPanel();
  chooseKind("tool-permissions");
  const written = await clickExport(harness);

  assert.equal(written.name, "better-cloudflare-tool-permissions.json");
  const parsed = parseToolPermissionsFile(written.contents);
  assert.ok(parsed.ok, "expected the written file to parse");
  assert.deepEqual(parsed.value.payload.enabledToolIds, ["cf_list_zones"]);
  assert.deepEqual(parsed.value.payload.sets, [
    { name: "Read only", toolIds: ["cf_list_zones"] },
  ]);
});

test("the file is indented and newline-terminated", async () => {
  const harness = renderPanel();
  const written = await clickExport(harness);

  assert.ok(written.contents.endsWith("}\n"));
  assert.match(written.contents, /\n {2}"kind": "settings",/);
});

test("a host that refuses the write says so", async () => {
  renderPanel({}, new Error("the folder is read-only"));

  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const alert = await screen.findByTestId("portable-export-error");
  assert.match(alert.textContent ?? "", /Export failed/);
  assert.match(alert.textContent ?? "", /the folder is read-only/);
});

test("a host that refuses with nothing to say still reports the failure", async () => {
  // A dialog can reject with a bare value. The heading is the fact; the detail
  // is optional, and a panel that rendered only the detail would show nothing
  // at all for a write that failed.
  renderPanel({}, {});

  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const alert = await screen.findByTestId("portable-export-error");
  assert.match(alert.textContent ?? "", /Export failed/);
});

test("changing the selection clears the previous failure", async () => {
  renderPanel({}, new Error("the folder is read-only"));

  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await screen.findByTestId("portable-export-error");

  chooseKind("personas");
  assert.ok(
    document.querySelector('[data-testid="portable-export-error"]') === null,
  );
});
