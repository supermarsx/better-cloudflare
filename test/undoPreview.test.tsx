/**
 * The undo preview dialog: what it plans, what it leaves unchecked, and what
 * it says happened.
 *
 * Five things are pinned here, and all five are about not making a mess of
 * somebody else's zone.
 *
 * **A drifted row is never pre-checked.** `src/lib/history/types.ts` is
 * explicit that silently reverting a later edit — possibly made in the
 * Cloudflare dashboard — is worse than doing nothing, so the record that moved
 * since needs a deliberate click before the undo will touch it.
 *
 * **Each drift state gets its own words.** A changed record says what it holds
 * now, an absent one says the undo becomes a re-create, and a conflict says
 * that the name and type now belong to a record this undo did not create. One
 * generic warning for all three would leave the only genuinely dangerous case
 * looking like the other two.
 *
 * **The dialog never writes a record.** Applying belongs to the existing
 * `DNSOp` engine, so the confirmed rows leave through `onConfirm` and the
 * component source is checked for any direct write call — a regression here
 * would be a second applier beside one that already handles the cases this
 * dialog would get wrong.
 *
 * **What leaves is exactly what the button promised.** The count on the button
 * and the rows handed to `onConfirm` are the same set, checked against the
 * call rather than against the component's state.
 *
 * **A partial result is reported per row.** `UndoResult.failed` is normal, and
 * a batch where 36 of 37 landed is a success with a footnote; reporting it as
 * a failure would send someone looking for 37 records to put back by hand.
 *
 * The rules themselves are tested without a DOM in
 * `test/undoSelection.test.ts`; what is tested here is that the dialog honours
 * them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { UndoPreviewDialog } from "../src/components/dns/UndoPreviewDialog";
import type {
  RetainedRecordSnapshot,
  UndoPlanRow,
  UndoPreview,
  UndoRefusalCode,
  UndoResult,
} from "../src/lib/history/types";

import { useEnglishLocale } from "./i18n-ready";

const ZONE_ID = "zone-abcdef0123456789";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY = "cf-api-key";

afterEach(() => {
  cleanup();
});

function snapshot(
  overrides: Partial<RetainedRecordSnapshot> = {},
): RetainedRecordSnapshot {
  return {
    recordType: "A",
    name: "api.example.test",
    content: "203.0.113.10",
    ttl: 3600,
    priority: null,
    proxied: false,
    comment: null,
    tags: [],
    ...overrides,
  };
}

function row(overrides: Partial<UndoPlanRow> = {}): UndoPlanRow {
  const drift = overrides.drift ?? ({ state: "unchanged" } as const);
  return {
    entryId: "entry-1",
    recordType: "A",
    recordName: "api.example.test",
    target: snapshot(),
    drift,
    selectedByDefault: drift.state === "unchanged",
    ...overrides,
  };
}

function plan(
  rows: readonly UndoPlanRow[],
  unavailable: UndoPreview["unavailable"] = [],
): UndoPreview {
  return { operationId: OPERATION_ID, zoneId: ZONE_ID, rows, unavailable };
}

function undoResult(overrides: Partial<UndoResult> = {}): UndoResult {
  return {
    operationId: "22222222-2222-4222-8222-222222222222",
    applied: 0,
    skipped: 0,
    failed: [],
    ...overrides,
  };
}

type PreviewCall = {
  zoneId: string;
  operationId: string;
  apiKey: string;
  email?: string;
  entryIds?: readonly string[];
};

interface Harness {
  previewCalls: PreviewCall[];
  /** Every batch of rows handed out for applying, in call order. */
  confirmed: readonly UndoPlanRow[][];
  applied: UndoResult[];
  openChanges: boolean[];
}

/**
 * Mount the dialog with the preview injected and the apply captured.
 *
 * The preview wrapper is a `TauriClient` static; injecting instead of patching
 * it keeps one test's stub out of the next test's module state, which in a
 * single jsdom process shared by the whole file is the difference between a
 * failure and a mystery. The apply is not a wrapper at all — the dialog hands
 * its rows to `onConfirm` and the host writes them — so capturing that call is
 * how the write path is observed.
 */
async function mount(
  preview: UndoPreview | (() => Promise<UndoPreview>),
  options: {
    confirm?: (rows: readonly UndoPlanRow[]) => Promise<UndoResult>;
    entryIds?: readonly string[];
    operationLabel?: string;
    email?: string;
  } = {},
): Promise<Harness> {
  await useEnglishLocale();
  const confirmed: UndoPlanRow[][] = [];
  const harness: Harness = {
    previewCalls: [],
    confirmed,
    applied: [],
    openChanges: [],
  };

  await act(async () => {
    render(
      <UndoPreviewDialog
        open
        onOpenChange={(open) => harness.openChanges.push(open)}
        zoneId={ZONE_ID}
        operationId={OPERATION_ID}
        entryIds={options.entryIds}
        apiKey={API_KEY}
        email={options.email}
        operationLabel={options.operationLabel}
        onApplied={(result) => harness.applied.push(result)}
        previewUndo={async (zoneId, operationId, apiKey, email, entryIds) => {
          harness.previewCalls.push({
            zoneId,
            operationId,
            apiKey,
            email,
            entryIds,
          });
          return typeof preview === "function" ? preview() : preview;
        }}
        onConfirm={async (rows) => {
          confirmed.push([...rows]);
          return options.confirm
            ? options.confirm(rows)
            : undoResult({ applied: rows.length });
        }}
      />,
    );
  });

  return harness;
}

/** The entry ids of one captured apply, for comparing against a plan. */
function confirmedIds(harness: Harness, call = 0): readonly string[] {
  return (harness.confirmed[call] ?? []).map((row) => row.entryId);
}

/** The apply button, whose name carries the count it is about to write. */
function applyButton(count: number): HTMLElement {
  return screen.getByRole("button", { name: `Apply ${count}` });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

test("the plan is fetched for the operation the host named", async () => {
  const harness = await mount(plan([row({ entryId: "a" })]), {
    email: "someone@example.test",
    entryIds: ["a"],
  });

  assert.deepEqual(harness.previewCalls, [
    {
      zoneId: ZONE_ID,
      operationId: OPERATION_ID,
      apiKey: API_KEY,
      email: "someone@example.test",
      entryIds: ["a"],
    },
  ]);
  // Planning writes nothing, so it is fetched on open and not cached.
  assert.equal(harness.confirmed.length, 0);
});

test("a whole-operation undo plans the whole operation", async () => {
  const harness = await mount(plan([row()]));

  assert.equal(harness.previewCalls[0]?.entryIds, undefined);
});

test("a drifted row opens unchecked and the clean rows open checked", async () => {
  await mount(
    plan([
      row({ entryId: "api", recordName: "api.example.test" }),
      row({ entryId: "cdn", recordName: "cdn.example.test" }),
      row({
        entryId: "mx",
        recordName: "mx.example.test",
        drift: { state: "changed", current: snapshot({ ttl: 120 }) },
      }),
    ]),
  );

  const clean = await screen.findByRole("checkbox", {
    name: "Put back api.example.test",
  });
  const drifted = screen.getByRole("checkbox", {
    name: "Overwrite the later change to mx.example.test",
  });

  assert.equal((clean as HTMLInputElement).checked, true);
  assert.equal((drifted as HTMLInputElement).checked, false);
  assert.ok(applyButton(2));
});

test("a plan that pre-checks a drifted row is not believed", async () => {
  // A backend bug or an older desktop build must not get a silent overwrite
  // of somebody else's later edit out of this dialog.
  await mount(
    plan([
      row({
        entryId: "mx",
        recordName: "mx.example.test",
        drift: { state: "changed", current: snapshot({ ttl: 120 }) },
        selectedByDefault: true,
      }),
    ]),
  );

  const drifted = await screen.findByRole("checkbox", {
    name: "Overwrite the later change to mx.example.test",
  });
  assert.equal((drifted as HTMLInputElement).checked, false);
  assert.ok(applyButton(0));
  assert.equal((applyButton(0) as HTMLButtonElement).disabled, true);
});

test("the apply count follows the selection", async () => {
  await mount(
    plan([
      row({ entryId: "api", recordName: "api.example.test" }),
      row({
        entryId: "mx",
        recordName: "mx.example.test",
        drift: { state: "changed", current: snapshot({ ttl: 120 }) },
      }),
    ]),
  );

  const drifted = await screen.findByRole("checkbox", {
    name: "Overwrite the later change to mx.example.test",
  });
  assert.ok(applyButton(1));

  await click(drifted);
  assert.ok(applyButton(2));

  await click(
    screen.getByRole("checkbox", { name: "Put back api.example.test" }),
  );
  assert.ok(applyButton(1));
});

test("only the rows left selected are handed out for applying", async () => {
  const target = snapshot({ name: "api.example.test", ttl: 3600 });
  const harness = await mount(
    plan([
      row({ entryId: "api", recordName: "api.example.test", target }),
      row({ entryId: "cdn", recordName: "cdn.example.test" }),
      row({
        entryId: "mx",
        recordName: "mx.example.test",
        drift: { state: "changed", current: snapshot({ ttl: 120 }) },
      }),
    ]),
    { confirm: async (rows) => undoResult({ applied: rows.length }) },
  );

  await click(await screen.findByRole("button", { name: "Apply 2" }));

  assert.equal(harness.confirmed.length, 1);
  assert.deepEqual(confirmedIds(harness), ["api", "cdn"]);
  // Whole rows, so the applier can build the reverse operation without
  // going back to the plan for the snapshot.
  assert.equal(harness.confirmed[0]?.[0]?.target, target);
  assert.deepEqual(
    harness.applied.map((result) => result.applied),
    [2],
  );
});

test("an overwritten row reaches the apply once it is chosen", async () => {
  const harness = await mount(
    plan([
      row({ entryId: "api", recordName: "api.example.test" }),
      row({
        entryId: "mx",
        recordName: "mx.example.test",
        drift: { state: "changed", current: snapshot({ ttl: 120 }) },
      }),
    ]),
  );

  await click(
    await screen.findByRole("checkbox", {
      name: "Overwrite the later change to mx.example.test",
    }),
  );
  await click(applyButton(2));

  assert.deepEqual(confirmedIds(harness), ["api", "mx"]);
});

test("a tagged record warns that its tags will not come back", async () => {
  await mount(
    plan([
      row({ entryId: "api", recordName: "api.example.test" }),
      row({
        entryId: "tagged",
        recordName: "tagged.example.test",
        target: snapshot({ name: "tagged.example.test", tags: ["prod"] }),
      }),
    ]),
  );

  const note = await screen.findByTestId("undo-preview-tags-note");
  assert.match(note.textContent ?? "", /Tags are not put back/);
  // And the row does not list them among what it puts back.
  const rows = screen.getAllByTestId("undo-preview-row");
  const taggedRow = rows.find(
    (candidate) => candidate.getAttribute("data-entry-id") === "tagged",
  );
  assert.ok(taggedRow);
  assert.ok(
    !(taggedRow?.textContent ?? "").includes("prod"),
    "a tag the apply cannot write must not appear as something it puts back",
  );
});

test("the tags warning tracks the selection", async () => {
  await mount(
    plan([
      row({
        entryId: "tagged",
        recordName: "tagged.example.test",
        target: snapshot({ name: "tagged.example.test", tags: ["prod"] }),
      }),
    ]),
  );

  const checkbox = await screen.findByRole("checkbox", {
    name: "Put back tagged.example.test",
  });
  assert.ok(screen.getByTestId("undo-preview-tags-note"));

  await click(checkbox);
  assert.ok(screen.queryByTestId("undo-preview-tags-note") === null);
});

test("an untagged plan says nothing about tags", async () => {
  await mount(plan([row({ entryId: "api" })]));

  await screen.findByRole("checkbox", { name: "Put back api.example.test" });
  assert.ok(screen.queryByTestId("undo-preview-tags-note") === null);
});

test("a changed row says what the record holds now", async () => {
  await mount(
    plan([
      row({
        entryId: "mx",
        recordName: "mx.example.test",
        target: snapshot({ name: "mx.example.test", ttl: 600 }),
        drift: {
          state: "changed",
          current: snapshot({ name: "mx.example.test", ttl: 120 }),
        },
      }),
    ]),
  );

  assert.ok(
    await screen.findByText(
      "Changed since this operation: it now holds TTL 120",
    ),
  );
});

test("an absent row says the undo re-creates the record", async () => {
  await mount(
    plan([
      row({
        entryId: "gone",
        recordName: "gone.example.test",
        drift: { state: "absent" },
      }),
    ]),
  );

  assert.ok(
    await screen.findByText("Gone from Cloudflare, so undoing re-creates it"),
  );
  assert.ok(
    screen.getByRole("checkbox", { name: "Re-create gone.example.test" }),
  );
});

test("a conflict names the record this undo did not create", async () => {
  await mount(
    plan([
      row({
        entryId: "clash",
        recordName: "www.example.test",
        drift: { state: "conflict", conflictingRecordId: "rec-9" },
      }),
    ]),
  );

  const notice = await screen.findByText(/rec-9/);
  assert.match(notice.textContent ?? "", /did not create it/);
  assert.ok(
    screen.getByRole("checkbox", {
      name: "Overwrite the record that now holds www.example.test",
    }),
  );
});

test("a create whose record is already gone cannot be selected", async () => {
  await mount(
    plan([
      row({
        entryId: "already",
        recordName: "temp.example.test",
        target: null,
        drift: { state: "absent" },
      }),
      row({ entryId: "api", recordName: "api.example.test" }),
    ]),
  );

  const nothingToDo = await screen.findByRole("checkbox", {
    name: "temp.example.test is already deleted",
  });
  assert.equal((nothingToDo as HTMLInputElement).disabled, true);
  // And it does not inflate the promise on the button.
  assert.ok(applyButton(1));
});

test("36 of 37 written is reported as 36 written, not as a failure", async () => {
  const rows = Array.from({ length: 37 }, (_unused, index) =>
    row({ entryId: `e${index}`, recordName: `r${index}.example.test` }),
  );
  const harness = await mount(plan(rows), {
    confirm: async () =>
      undoResult({
        applied: 36,
        failed: [
          {
            entryId: "e36",
            recordName: "r36.example.test",
            message: "rate limited",
          },
        ],
      }),
  });

  await click(await screen.findByRole("button", { name: "Apply 37" }));

  const outcome = await screen.findByTestId("undo-preview-outcome");
  assert.match(outcome.textContent ?? "", /Put back 36 of 37 record\(s\)/);
  assert.match(outcome.textContent ?? "", /1 could not be written/);
  assert.deepEqual(
    harness.applied.map((result) => result.applied),
    [36],
  );
});

test("a failed row carries its own reason", async () => {
  await mount(
    plan([
      row({ entryId: "api", recordName: "api.example.test" }),
      row({ entryId: "cdn", recordName: "cdn.example.test" }),
    ]),
    {
      confirm: async () =>
        undoResult({
          applied: 1,
          failed: [
            {
              entryId: "cdn",
              recordName: "cdn.example.test",
              message: "forbidden",
            },
          ],
        }),
    },
  );

  await click(await screen.findByRole("button", { name: "Apply 2" }));

  const failures = await screen.findAllByTestId("undo-preview-row-failure");
  assert.equal(failures.length, 1);
  assert.match(failures[0]?.textContent ?? "", /forbidden/);
  const failedRow = failures[0]?.closest("[data-entry-id]");
  assert.equal(failedRow?.getAttribute("data-entry-id"), "cdn");
});

test("a failure deep in a long plan is pulled out of the collapse", async () => {
  // The defect this closes: with six clean rows shown of thirty-seven, a
  // failure on row thirty is a number the user cannot act on. The record is
  // still in its post-change state and the dialog is the only thing that
  // knows which one it is.
  const rows = Array.from({ length: 37 }, (_unused, index) =>
    row({ entryId: `e${index}`, recordName: `r${index}.example.test` }),
  );
  await mount(plan(rows), {
    confirm: async () =>
      undoResult({
        applied: 36,
        failed: [
          {
            entryId: "e30",
            recordName: "r30.example.test",
            message: "rate limited",
          },
        ],
      }),
  });

  await click(await screen.findByRole("button", { name: "Apply 37" }));

  const failures = await screen.findAllByTestId("undo-preview-row-failure");
  assert.equal(failures.length, 1);
  assert.match(failures[0]?.textContent ?? "", /rate limited/);
  const failedRow = failures[0]?.closest("[data-entry-id]");
  assert.equal(failedRow?.getAttribute("data-entry-id"), "e30");
  // The row it belongs to names the record, and it was row thirty of a plan
  // that only shows six clean rows.
  assert.match(failedRow?.textContent ?? "", /r30\.example\.test/);
});

test("a failure the plan has no row for is still named", async () => {
  await mount(plan([row({ entryId: "api", recordName: "api.example.test" })]), {
    confirm: async () =>
      undoResult({
        applied: 1,
        failed: [
          {
            entryId: "not-in-this-plan",
            recordName: "ghost.example.test",
            message: "record vanished mid-apply",
          },
        ],
      }),
  });

  await click(await screen.findByRole("button", { name: "Apply 1" }));

  const unlisted = await screen.findByTestId("undo-preview-unlisted-failures");
  assert.match(unlisted.textContent ?? "", /ghost\.example\.test/);
  assert.match(unlisted.textContent ?? "", /record vanished mid-apply/);
});

test("a clean result reports no failures to read", async () => {
  await mount(plan([row({ entryId: "api" })]), {
    confirm: async () => undoResult({ applied: 1 }),
  });

  await click(await screen.findByRole("button", { name: "Apply 1" }));

  const outcome = await screen.findByTestId("undo-preview-outcome");
  assert.match(outcome.textContent ?? "", /Put back 1 record\(s\)/);
  assert.ok(screen.queryByTestId("undo-preview-row-failure") === null);
  assert.ok(screen.queryByTestId("undo-preview-unlisted-failures") === null);
});

test("skipped rows are reported alongside what was written", async () => {
  await mount(plan([row({ entryId: "api" })]), {
    confirm: async () => undoResult({ applied: 1, skipped: 4 }),
  });

  await click(await screen.findByRole("button", { name: "Apply 1" }));

  const outcome = await screen.findByTestId("undo-preview-outcome");
  assert.match(outcome.textContent ?? "", /Put back 1 record\(s\)/);
  assert.match(outcome.textContent ?? "", /4 record\(s\) were skipped/);
});

test("a long plan collapses the unchanged rows until asked", async () => {
  const rows = [
    ...Array.from({ length: 20 }, (_unused, index) =>
      row({ entryId: `clean-${index}`, recordName: `r${index}.example.test` }),
    ),
    row({
      entryId: "mx",
      recordName: "mx.example.test",
      drift: { state: "changed", current: snapshot({ ttl: 120 }) },
    }),
  ];
  await mount(plan(rows));

  const collapsed = await screen.findByTestId("undo-preview-collapsed");
  assert.match(collapsed.textContent ?? "", /14 more unchanged/);
  // The row that needs a decision is never the one hidden.
  assert.ok(
    screen.getByRole("checkbox", {
      name: "Overwrite the later change to mx.example.test",
    }),
  );
  assert.equal(screen.getAllByTestId("undo-preview-row").length, 7);

  await click(screen.getByRole("button", { name: "Show all" }));
  assert.equal(screen.getAllByTestId("undo-preview-row").length, 21);
  assert.ok(screen.queryByTestId("undo-preview-collapsed") === null);
});

test("the records undo cannot reach are listed with the reason", async () => {
  await mount(
    plan(
      [row({ entryId: "api" })],
      [
        {
          entryId: "old",
          recordName: "legacy.example.test",
          undo: { state: "no-snapshot" },
        },
        {
          entryId: "evicted",
          recordName: "dropped.example.test",
          undo: { state: "evicted" },
        },
      ],
    ),
  );

  const unavailable = await screen.findByTestId("undo-preview-unavailable");
  assert.match(unavailable.textContent ?? "", /legacy\.example\.test/);
  assert.match(
    unavailable.textContent ?? "",
    /Recorded before this app kept copies/,
  );
  assert.match(
    unavailable.textContent ?? "",
    /dropped to stay inside the size limit/,
  );
});

test("an expiry is shown as a date, not as a wire timestamp", async () => {
  // Mid-year so that no machine's timezone can shift the year, which is the
  // only part of a localised date that is stable across every runner.
  await mount(
    plan(
      [row({ entryId: "api" })],
      [
        {
          entryId: "old",
          recordName: "legacy.example.test",
          undo: { state: "expired", expiredAt: "2026-06-15T12:00:00Z" },
        },
      ],
    ),
  );

  const unavailable = await screen.findByTestId("undo-preview-unavailable");
  assert.match(unavailable.textContent ?? "", /2026/);
  assert.ok(
    !(unavailable.textContent ?? "").includes("2026-06-15T12:00:00Z"),
    "the raw ISO timestamp should not reach the user",
  );
});

test("an expiry this app cannot parse is shown rather than swallowed", async () => {
  await mount(
    plan(
      [row({ entryId: "api" })],
      [
        {
          entryId: "old",
          recordName: "legacy.example.test",
          undo: { state: "expired", expiredAt: "whenever" },
        },
      ],
    ),
  );

  const unavailable = await screen.findByTestId("undo-preview-unavailable");
  assert.match(unavailable.textContent ?? "", /whenever/);
});

test("every refusal code reaches the user as a sentence, never as a code", async () => {
  // `UndoAvailability.not-undoable.reason` is a `UndoRefusalCode`, so
  // interpolating it would put `stale-record-list` on screen in all twelve
  // locales. Every member is listed here rather than sampled: the union is
  // the backend's, and a code added without words is exactly the change that
  // would slip through a test of one.
  const codes: readonly UndoRefusalCode[] = [
    "stale-record-list",
    "zone-setting",
    "cache-purge",
    "dnssec",
    "manifest-truncated",
    "summary-entry-only",
  ];
  await mount(
    plan(
      [row({ entryId: "api" })],
      codes.map((code) => ({
        entryId: `refused-${code}`,
        recordName: `${code}.example.test`,
        undo: { state: "not-undoable" as const, reason: code },
      })),
    ),
  );

  const unavailable = await screen.findByTestId("undo-preview-unavailable");
  const text = unavailable.textContent ?? "";
  for (const code of codes) {
    // The record names deliberately contain the code, so the check is that
    // the code never appears as prose outside the name that carries it.
    assert.ok(
      !text.includes(`${code} `) && !text.includes(`: ${code}`),
      `the raw code ${code} should not be shown as its own explanation`,
    );
  }
  // And a stale list is the one refusal the user can act on, so it says so
  // rather than claiming this was not a record change.
  assert.match(text, /Refresh the Records tab/);
  assert.match(text, /cache purge/);
  assert.match(text, /DNSSEC/);
});

test("the header counts every record in the operation, undoable or not", async () => {
  await mount(
    plan(
      [row({ entryId: "api" }), row({ entryId: "cdn" })],
      [
        {
          entryId: "old",
          recordName: "legacy.example.test",
          undo: { state: "no-snapshot" },
        },
      ],
    ),
    { operationLabel: "bulk edit at 14:02" },
  );

  assert.ok(
    await screen.findByText(
      "bulk edit at 14:02 · 3 record(s) in this operation",
    ),
  );
});

test("a plan that cannot be fetched offers a retry rather than a dead dialog", async () => {
  let attempts = 0;
  const harness = await mount(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("zone unreachable");
    return plan([row({ entryId: "api", recordName: "api.example.test" })]);
  });

  const failure = await screen.findByTestId("undo-preview-plan-error");
  assert.match(failure.textContent ?? "", /zone unreachable/);
  assert.ok(screen.queryByTestId("undo-preview-row") === null);

  await click(screen.getByRole("button", { name: "Try again" }));

  assert.ok(
    await screen.findByRole("checkbox", { name: "Put back api.example.test" }),
  );
  assert.equal(harness.previewCalls.length, 2);
  assert.ok(screen.queryByTestId("undo-preview-plan-error") === null);
});

test("an apply that throws says so and writes nothing silently", async () => {
  const harness = await mount(plan([row({ entryId: "api" })]), {
    confirm: async () => {
      throw new Error("token expired");
    },
  });

  await click(await screen.findByRole("button", { name: "Apply 1" }));

  const failure = await screen.findByTestId("undo-preview-apply-error");
  assert.match(failure.textContent ?? "", /token expired/);
  // No outcome is claimed, and the host is not told an undo landed.
  assert.ok(screen.queryByTestId("undo-preview-outcome") === null);
  assert.deepEqual(harness.applied, []);
});

test("cancelling closes without writing", async () => {
  const harness = await mount(plan([row({ entryId: "api" })]));

  await click(await screen.findByRole("button", { name: "Cancel" }));

  assert.deepEqual(harness.openChanges, [false]);
  assert.equal(harness.confirmed.length, 0);
});

test("a plan with nothing undoable offers nothing to apply", async () => {
  await mount(
    plan(
      [],
      [
        {
          entryId: "old",
          recordName: "legacy.example.test",
          undo: { state: "superseded-by-delete" },
        },
      ],
    ),
  );

  assert.ok(await screen.findByTestId("undo-preview-empty"));
  assert.ok(screen.queryByTestId("undo-preview-row") === null);
  assert.equal((applyButton(0) as HTMLButtonElement).disabled, true);
});

test("the dialog reads the plan and nothing else from the backend", () => {
  // Read as source rather than inferred from a stub, because the thing being
  // ruled out is a call this dialog should never make at all. This app already
  // applies undo through `useUndoRedo` and the `DNSOp` union, which answers
  // questions a second applier would have to answer again and worse — a binned
  // deletion reverses through `retain`/`restore` so that replaying history
  // cannot destroy a record with no copy, and `repointPairedDnsOp` re-points
  // an operation when a record id dies under it. A `createDNSRecord` appearing
  // here would be that second applier, and no behavioural test would notice
  // until it had written to somebody's zone.
  const source = readFileSync(
    new URL("../src/components/dns/UndoPreviewDialog.tsx", import.meta.url),
    "utf8",
  );
  const members = [
    ...source.matchAll(/TauriClient\.(?<member>[A-Za-z_$][\w$]*)/gu),
  ].map((match) => match.groups?.member);

  assert.deepEqual([...new Set(members)], ["previewUndoOperation"]);
});
