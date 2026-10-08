/**
 * Reading a file and saying what it is, without writing anything.
 *
 * The rejection tests are the reason this file is long. `PortableRejection` is
 * a seven-tag vocabulary that `src/lib/portable/types.ts` keeps as tags
 * specifically so the renderer owns the wording, and a tag with no arm --
 * or with the wrong arm -- reaches a user only on the path that was already
 * going badly. Each one is pinned to a file that actually provokes it, rather
 * than to a hand-made parse result, so these also check that the panel runs
 * the parser the user asked for.
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

import { PortableImportPanel } from "../src/components/portable/PortableImportPanel";
import {
  exportPersonas,
  exportSettings,
  MAX_PORTABLE_FILE_BYTES,
  PORTABLE_FORMAT,
} from "../src/lib/portable";
import type { AiPersona } from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";

const EXPORTED_AT = new Date("2026-03-04T05:06:07.000Z");
const OPTIONS = { appVersion: "1.0.0", now: EXPORTED_AT };

const CUSTOM_PERSONA: AiPersona = {
  id: "custom-1",
  name: "Zone reviewer",
  description: "Reads a zone and reports on it",
  systemPrompt: "You review DNS zones.",
  builtin: false,
};

const SETTINGS_FILE = JSON.stringify(
  exportSettings(
    { autoRefreshInterval: 30, confirmDeleteRecord: true },
    OPTIONS,
  ),
);

const PERSONAS_FILE = JSON.stringify(exportPersonas([CUSTOM_PERSONA], OPTIONS));

/** A well-formed envelope whose payload this build does not fully recognise. */
function handBuilt(kind: string, payload: unknown): string {
  return JSON.stringify({
    format: PORTABLE_FORMAT,
    version: 1,
    kind,
    exportedAt: EXPORTED_AT.toISOString(),
    appVersion: "1.0.0",
    payload,
  });
}

interface Harness {
  parsed: string[];
}

function renderPanel(
  file: string | null | (() => never),
  overrides: Partial<React.ComponentProps<typeof PortableImportPanel>> = {},
): Harness {
  const harness: Harness = { parsed: [] };
  render(
    <PortableImportPanel
      onPickFile={async () => (typeof file === "function" ? file() : file)}
      onParsed={(envelope) => harness.parsed.push(envelope.kind)}
      {...overrides}
    />,
  );
  return harness;
}

function chooseKind(kind: string): void {
  const radio = document.querySelector<HTMLInputElement>(
    `input[name="portable-import-kind"][value="${kind}"]`,
  );
  assert.ok(radio, `expected a radio for ${kind}`);
  fireEvent.click(radio);
}

function pick(): void {
  fireEvent.click(screen.getByRole("button", { name: "Choose a file" }));
}

async function rejection(): Promise<HTMLElement> {
  return await screen.findByTestId("portable-import-rejection");
}

beforeEach(async () => {
  await useEnglishLocale();
});

afterEach(() => {
  cleanup();
});

test("a file this build wrote is read, summarized, and handed on", async () => {
  const harness = renderPanel(SETTINGS_FILE);
  pick();

  const outcome = await screen.findByTestId("portable-import-outcome");
  assert.equal(outcome.getAttribute("data-kind"), "settings");
  assert.match(
    screen.getByTestId("portable-import-summary").textContent ?? "",
    /^2 preference\(s\)$/,
  );
  // The panel writes nothing, and says so: everything after this is the
  // owner's, starting with the diff a settings import must show.
  assert.match(outcome.textContent ?? "", /Nothing has been changed yet\./);
  assert.deepEqual(harness.parsed, ["settings"]);
});

test("something that is not JSON is refused as broken, with the parser's reason", async () => {
  renderPanel("not json at all");
  pick();

  const alert = await rejection();
  // `not-json` and `malformed-payload` deliberately share one sentence -- the
  // reader acts on both the same way -- so the distinction lives in the tag,
  // which is what an owner branches on, and in the untranslated detail, which
  // is what a support thread needs.
  assert.equal(alert.getAttribute("data-rejection"), "not-json");
  assert.match(alert.textContent ?? "", /That file is damaged or incomplete\./);
  assert.match(alert.textContent ?? "", /is not valid JSON/);
});

test("an unrelated JSON file is refused before its kind is considered", async () => {
  renderPanel(JSON.stringify({ hello: "world", kind: "settings" }));
  pick();

  const alert = await rejection();
  // "Not ours", not "the wrong kind": the marker is checked first, so a
  // stranger's file that happens to carry a `kind` is not coerced into our
  // shape.
  assert.equal(alert.getAttribute("data-rejection"), "not-our-format");
  assert.match(alert.textContent ?? "", /was not written by this app/);
});

test("one of our files opened on the wrong screen says which", async () => {
  renderPanel(PERSONAS_FILE);
  pick();

  const alert = await rejection();
  assert.equal(alert.getAttribute("data-rejection"), "wrong-kind");
  assert.match(alert.textContent ?? "", /a different kind of configuration/);
  // The parser's own detail names what was found, untranslated.
  assert.match(alert.textContent ?? "", /expected settings, found personas/);
});

test("a file from a newer build is refused with its version", async () => {
  renderPanel(
    JSON.stringify({
      format: PORTABLE_FORMAT,
      version: 99,
      kind: "settings",
      exportedAt: EXPORTED_AT.toISOString(),
      appVersion: "99.0.0",
      payload: { preferences: {} },
    }),
  );
  pick();

  const alert = await rejection();
  assert.equal(alert.getAttribute("data-rejection"), "unsupported-version");
  assert.match(alert.textContent ?? "", /written by a newer version/);
});

test("an empty file is refused", async () => {
  renderPanel("   \n  ");
  pick();

  const alert = await rejection();
  assert.equal(alert.getAttribute("data-rejection"), "empty");
  assert.match(alert.textContent ?? "", /That file is empty\./);
});

test("a file past the ceiling is refused before it is parsed", async () => {
  renderPanel("x".repeat(MAX_PORTABLE_FILE_BYTES + 1));
  pick();

  const alert = await rejection();
  // Not `not-json`, even though it is not JSON: the ceiling is checked first,
  // because parsing is what turns an oversized string into an oversized
  // object graph.
  assert.equal(alert.getAttribute("data-rejection"), "too-large");
  assert.match(alert.textContent ?? "", /too large to read/);
});

test("a payload of the wrong shape is refused as damaged", async () => {
  renderPanel(handBuilt("settings", { preferences: "not an object" }));
  pick();

  const alert = await rejection();
  assert.equal(alert.getAttribute("data-rejection"), "malformed-payload");
  assert.match(alert.textContent ?? "", /damaged or incomplete/);
});

test("a preference this build does not accept is reported, not refused", async () => {
  const harness = renderPanel(
    handBuilt("settings", {
      preferences: { autoRefreshInterval: 30, someRetiredPreference: true },
    }),
  );
  pick();

  await screen.findByTestId("portable-import-outcome");
  const warning = document.querySelector<HTMLElement>(
    '[data-testid="portable-import-warnings"] [data-reason="unknown-preference"]',
  );
  assert.ok(warning, "expected an unknown-preference warning");
  assert.match(warning.textContent ?? "", /someRetiredPreference/);
  // A file holding one bad key and one good one imports the good one.
  assert.deepEqual(harness.parsed, ["settings"]);
});

test("one bad persona does not sink the bundle", async () => {
  const harness = renderPanel(
    handBuilt("personas", [
      {
        name: "Zone reviewer",
        description: "Reads a zone",
        systemPrompt: "You review DNS zones.",
      },
      { name: "Nameless", description: "", systemPrompt: "   " },
    ]),
  );
  chooseKind("personas");
  pick();

  await screen.findByTestId("portable-import-outcome");
  assert.match(
    screen.getByTestId("portable-import-summary").textContent ?? "",
    /^1 custom persona\(s\)$/,
  );
  const warning = document.querySelector<HTMLElement>(
    '[data-reason="invalid-persona"]',
  );
  assert.ok(warning, "expected an invalid-persona warning");
  assert.match(warning.textContent ?? "", /Nameless/);
  assert.deepEqual(harness.parsed, ["personas"]);
});

test("a cancelled dialog leaves the screen alone", async () => {
  const harness = renderPanel(null);
  pick();

  await waitFor(() => {
    const button = screen.getByRole("button", { name: "Choose a file" });
    assert.ok(button instanceof HTMLButtonElement && !button.disabled);
  });
  assert.ok(
    document.querySelector('[data-testid="portable-import-outcome"]') === null,
  );
  assert.ok(
    document.querySelector('[data-testid="portable-import-rejection"]') ===
      null,
  );
  assert.deepEqual(harness.parsed, []);
});

test("a host failure is not dressed up as a bad file", async () => {
  renderPanel(() => {
    throw new Error("the dialog could not be opened");
  });
  pick();

  const alert = await screen.findByTestId("portable-import-host-error");
  assert.match(alert.textContent ?? "", /Import failed/);
  assert.match(alert.textContent ?? "", /the dialog could not be opened/);
  // No file arrived, so there is nothing to refuse and no rejection to show.
  assert.ok(
    document.querySelector('[data-testid="portable-import-rejection"]') ===
      null,
  );
});

test("changing the kind drops an outcome that no longer applies", async () => {
  renderPanel(SETTINGS_FILE);
  pick();
  await screen.findByTestId("portable-import-outcome");

  chooseKind("personas");
  assert.ok(
    document.querySelector('[data-testid="portable-import-outcome"]') === null,
  );
});

test("the offered kinds can be narrowed", () => {
  renderPanel(SETTINGS_FILE, { kinds: ["tool-permissions"] });

  assert.equal(
    document.querySelectorAll('input[name="portable-import-kind"]').length,
    1,
  );
  assert.ok(
    document.querySelector(
      'input[name="portable-import-kind"][value="settings"]',
    ) === null,
  );
});
