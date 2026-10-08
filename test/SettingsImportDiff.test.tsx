/**
 * The preview a settings import must show before anything is written.
 *
 * The load-bearing tests are the two about what "apply all" writes:
 * `apply all leaves an untouched feature switch out` and
 * `apply all writes neither an opt-in nor a withheld row`.
 * `src/lib/portable/types.ts` sorts a proposed change into three lanes so that
 * an import cannot restart outbound work someone stopped, and cannot at all
 * make a change whose guard is a password proof. This screen is where both
 * promises are either kept or quietly broken.
 *
 * The fixtures put each switch in the lane the lib actually puts it in, which
 * is not symmetric: turning the two outbound switches *on* needs a tick, while
 * turning `passkeysEnabled` *off* is refused outright and turning it *on* is
 * an ordinary change. `turning passkeys on is an ordinary change` guards the
 * half of that which is easy to get backwards.
 *
 * The rest covers the ticking, the unset-is-not-off distinction, and the
 * dropped-key report.
 *
 * `assert.ok(node === null)` rather than `assert.equal(node, null)` throughout.
 * Under `node:assert/strict` a failed comparison inspects the actual value, and
 * inspecting a jsdom element walks its whole document graph; the same mistake
 * cost `AiAssistantPanel.test.tsx` 184 seconds in one test.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SettingsImportDiff } from "../src/components/portable/SettingsImportDiff";
import type {
  PortableSettingsDiff,
  PortableSettingsDiffRow,
} from "../src/lib/portable";

import { useEnglishLocale } from "./i18n-ready";

const EMPTY_DIFF: PortableSettingsDiff = {
  changed: [],
  optIn: [],
  withheld: [],
  unchangedCount: 0,
  droppedKeys: [],
};

function row(
  key: PortableSettingsDiffRow["key"],
  current: unknown,
  incoming: unknown,
): PortableSettingsDiffRow {
  return { key, current, incoming };
}

interface Harness {
  applied: string[][];
  cancels: number;
  rerender(diff: Partial<PortableSettingsDiff>): void;
}

function renderDiff(diff: Partial<PortableSettingsDiff> = {}): Harness {
  const harness: Harness = {
    applied: [],
    cancels: 0,
    rerender: () => {},
  };
  const element = (next: Partial<PortableSettingsDiff>) => (
    <SettingsImportDiff
      diff={{ ...EMPTY_DIFF, ...next }}
      // Braced: a bare `push(...)` body returns its new length, and `onApply`
      // is declared `void | Promise<void>`.
      onApply={(rows) => {
        harness.applied.push(rows.map((entry) => entry.key));
      }}
      onCancel={() => {
        harness.cancels += 1;
      }}
    />
  );
  const { rerender } = render(element(diff));
  harness.rerender = (next) => rerender(element(next));
  return harness;
}

function applyAll(): void {
  fireEvent.click(screen.getByRole("button", { name: "Apply all" }));
}

function optInBox(key: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(
    `[data-row-kind="opt-in"][data-key="${key}"] input[type="checkbox"]`,
  );
  assert.ok(found, `expected an opt-in checkbox for ${key}`);
  return found;
}

beforeEach(async () => {
  await useEnglishLocale();
});

afterEach(() => {
  cleanup();
});

test("apply all writes every changed row", () => {
  const harness = renderDiff({
    changed: [
      row("autoRefreshInterval", 30, 60),
      row("confirmDeleteRecord", undefined, true),
    ],
  });

  applyAll();

  assert.deepEqual(harness.applied, [
    ["autoRefreshInterval", "confirmDeleteRecord"],
  ]);
});

test("apply all leaves an untouched feature switch out", () => {
  const harness = renderDiff({
    changed: [row("autoRefreshInterval", 30, 60)],
    optIn: [
      row("registryMonitoringEnabled", undefined, true),
      row("cloudflareLatencyEnabled", undefined, true),
    ],
  });

  // Both opt-in rows are on screen and neither has been ticked. This is the
  // whole point: the rows are offered, and "apply all" still writes none of
  // them.
  assert.ok(optInBox("registryMonitoringEnabled").checked === false);
  assert.ok(optInBox("cloudflareLatencyEnabled").checked === false);

  applyAll();

  assert.deepEqual(harness.applied, [["autoRefreshInterval"]]);
});

test("apply all writes neither an opt-in nor a withheld row", () => {
  // All three lanes at once, in the lanes the lib actually puts them in:
  // turning the two outbound switches *on* needs a tick, and turning passkeys
  // *off* is refused outright. Apply all writes the ordinary row and nothing
  // else.
  const harness = renderDiff({
    changed: [row("autoRefreshInterval", 30, 60)],
    optIn: [row("registryMonitoringEnabled", undefined, true)],
    withheld: [
      {
        ...row("passkeysEnabled", true, false),
        reason: "needs-password-proof",
      },
    ],
  });

  applyAll();

  assert.deepEqual(harness.applied, [["autoRefreshInterval"]]);
});

test("a ticked feature switch is applied, and only that one", () => {
  const harness = renderDiff({
    changed: [row("autoRefreshInterval", 30, 60)],
    optIn: [
      row("registryMonitoringEnabled", undefined, true),
      row("cloudflareLatencyEnabled", undefined, true),
    ],
  });

  fireEvent.click(optInBox("registryMonitoringEnabled"));
  applyAll();

  assert.deepEqual(harness.applied, [
    ["autoRefreshInterval", "registryMonitoringEnabled"],
  ]);
});

test("turning passkeys on is an ordinary change, not an opt-in", () => {
  // The mirror of the withheld case, and easy to get backwards: enabling
  // passkeys only adds a sign-in route and can strand nobody, so the lib puts
  // it in `changed` and Apply all writes it. A screen that derived the lane
  // from the key rather than from the array it arrived in would offer no way
  // to apply a change the user is entitled to make.
  const harness = renderDiff({
    changed: [row("passkeysEnabled", false, true)],
  });

  assert.ok(
    document.querySelector(
      '[data-row-kind="changed"][data-key="passkeysEnabled"]',
    ) !== null,
  );
  applyAll();
  assert.deepEqual(harness.applied, [["passkeysEnabled"]]);
});

test("unticking a feature switch takes it back out", () => {
  // A changed row as well, because an apply with nothing to write is refused
  // outright -- see the disabled-button test below -- and this test is about
  // the tick, not about that.
  const harness = renderDiff({
    changed: [row("vaultEnabled", false, true)],
    optIn: [row("registryMonitoringEnabled", undefined, true)],
  });

  fireEvent.click(optInBox("registryMonitoringEnabled"));
  fireEvent.click(optInBox("registryMonitoringEnabled"));
  applyAll();

  assert.deepEqual(harness.applied, [["vaultEnabled"]]);
});

test("an apply with nothing to write is refused", () => {
  // The only thing on offer is an untouched opt-in row, so there is nothing
  // "apply all" may legitimately write -- and a button that wrote the opt-in
  // row rather than nothing is exactly the failure this file exists for.
  renderDiff({ optIn: [row("registryMonitoringEnabled", undefined, true)] });

  const button = screen.getByRole("button", { name: "Apply all" });
  assert.ok(button instanceof HTMLButtonElement && button.disabled);
});

test("a new opt-in proposal drops a tick from the previous file", () => {
  const harness = renderDiff({
    changed: [row("autoRefreshInterval", 30, 60)],
    optIn: [row("registryMonitoringEnabled", undefined, true)],
  });

  fireEvent.click(optInBox("registryMonitoringEnabled"));
  assert.ok(optInBox("registryMonitoringEnabled").checked === true);

  // A second file proposing a different switch. The tick was agreement to the
  // first file's proposal and must not survive into this one.
  harness.rerender({
    changed: [row("autoRefreshInterval", 30, 60)],
    optIn: [row("cloudflareLatencyEnabled", undefined, true)],
  });

  assert.ok(optInBox("cloudflareLatencyEnabled").checked === false);
  applyAll();
  assert.deepEqual(harness.applied, [["autoRefreshInterval"]]);
});

test("an unset preference is not shown as off", () => {
  renderDiff({ changed: [row("recycleBinEnabled", undefined, false)] });

  const rendered = document.querySelector<HTMLElement>(
    '[data-row-kind="changed"][data-key="recycleBinEnabled"]',
  );
  assert.ok(rendered, "expected a row for recycleBinEnabled");
  // "Not set" on this machine and "Disabled" in the file, not "Disabled" twice:
  // this preference is documented "absent means on", so collapsing the two
  // would say an import changes nothing when it is about to turn the bin off.
  assert.match(rendered.textContent ?? "", /Not set/);
  assert.match(rendered.textContent ?? "", /Disabled/);
});

test("object values are rendered, bounded, as JSON", () => {
  renderDiff({
    changed: [row("dnsTableColumns", ["name"], ["name", "type", "content"])],
  });

  const rendered = document.querySelector<HTMLElement>(
    '[data-key="dnsTableColumns"]',
  );
  assert.ok(rendered, "expected a row for dnsTableColumns");
  assert.match(rendered.textContent ?? "", /\["name","type","content"\]/);
});

test("a withheld change is shown with its reason and no affordance", () => {
  const harness = renderDiff({
    changed: [row("autoRefreshInterval", 30, 60)],
    withheld: [
      {
        ...row("passkeysEnabled", true, false),
        reason: "needs-password-proof",
      },
    ],
  });

  const rendered = document.querySelector<HTMLElement>(
    '[data-row-kind="withheld"][data-key="passkeysEnabled"]',
  );
  assert.ok(rendered, "expected a withheld row for passkeysEnabled");
  assert.equal(rendered.getAttribute("data-reason"), "needs-password-proof");
  assert.match(rendered.textContent ?? "", /An import cannot make this change/);
  // Not a disabled tick: a control that exists only to be refused would offer
  // a waiver the user does not have.
  assert.ok(rendered.querySelector('input[type="checkbox"]') === null);

  applyAll();
  assert.deepEqual(harness.applied, [["autoRefreshInterval"]]);
});

test("a file holding only a withheld change is not called a no-op", () => {
  renderDiff({
    withheld: [
      {
        ...row("passkeysEnabled", true, false),
        reason: "needs-password-proof",
      },
    ],
  });

  assert.ok(document.querySelector('[data-testid="diff-empty"]') === null);
  const button = screen.getByRole("button", { name: "Apply all" });
  assert.ok(button instanceof HTMLButtonElement && button.disabled);
});

test("preferences this build did not accept are named", () => {
  renderDiff({ droppedKeys: ["someRetiredPreference"] });

  const warning = document.querySelector<HTMLElement>(
    '[data-testid="diff-dropped"] [data-reason="unknown-preference"]',
  );
  assert.ok(warning, "expected a dropped-preference warning");
  assert.match(warning.textContent ?? "", /someRetiredPreference/);
});

test("preferences already the same are counted rather than listed", () => {
  renderDiff({ unchangedCount: 7 });

  assert.ok(screen.getByTestId("diff-unchanged").textContent?.includes("7"));
  assert.ok(document.querySelector('[data-testid="diff-row"]') === null);
});

test("a file that would change nothing says so and offers no apply", () => {
  renderDiff({ unchangedCount: 3 });

  assert.ok(screen.getByTestId("diff-empty"));
  const button = screen.getByRole("button", { name: "Apply all" });
  assert.ok(button instanceof HTMLButtonElement && button.disabled);
});

test("cancel is offered only when the owner gave somewhere to go", () => {
  const harness = renderDiff({ changed: [row("vaultEnabled", false, true)] });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.equal(harness.cancels, 1);

  cleanup();
  render(
    <SettingsImportDiff
      diff={{ ...EMPTY_DIFF, changed: [row("vaultEnabled", false, true)] }}
      onApply={() => {}}
    />,
  );
  assert.ok(screen.queryByRole("button", { name: "Cancel" }) === null);
});
