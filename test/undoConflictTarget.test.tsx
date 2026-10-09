/**
 * The record the undo dialog *names* must be the record the engine *writes to*.
 *
 * This is the one invariant in the zone-history feature that no single file can
 * hold, which is why it is tested here rather than in either half's own suite.
 *
 * `UndoPreviewDialog` renders a `conflict` row by naming an id out of the
 * preview — "Another record (rec-9) now holds this name and type. This undo did
 * not create it, and applying would overwrite it" — and labels its checkbox
 * "Overwrite the record that now holds www.example.test". `DNSManager`'s
 * `resolveUndoTargetRecord` separately decides what the write lands on. Both
 * read `UndoRowDrift`, neither reads the other, and if they ever disagree the
 * dialog is naming one record while the engine overwrites a different one — on
 * the single drift state where applying destroys a record the undo never
 * created.
 *
 * The decoy below is what makes these tests mean anything. Two A records share
 * one name, which Cloudflare allows and round-robin DNS depends on, and the
 * decoy is *first* in the list. A resolver that looked the row up by record
 * type and name — the obvious implementation, and what every other drift state
 * correctly does — would find the decoy and write to it. So the conflict path
 * has to be a deliberate branch keyed on the id, and this file fails if it
 * stops being one.
 *
 * The decoy alone was not enough, which is worth recording. It catches a
 * resolver that *ignores* the conflict id, and the first version of this file
 * stopped there — so it stayed green against a resolver that preferred the id
 * and then quietly fell back to the name lookup when the id was not in the
 * loaded list:
 *
 *     const byId = records.find((record) => record.id === id);
 *     if (byId) return byId;   // falls through to the name lookup
 *
 * That back door is reachable, because the preview asked Cloudflare and the
 * loaded list is a cache: a real conflicting id can legitimately be absent
 * locally. `conflictAbsentLocally` below is the fixture that closes it, and
 * without it this file claimed an invariant it did not hold on the one drift
 * state where applying destroys a record the undo never created. Found by the
 * agent that owns the resolver, against a test written to check its work.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { planUndoRows } from "../src/components/dns/DNSManager";
import type {
  RetainedRecordSnapshot,
  UndoPlanRow,
} from "../src/lib/history/types";
import type { DNSRecord } from "../src/types/dns";

const ZONE_ID = "zone-1";
const ZONE_NAME = "example.test";

/** First in the list, and a name-and-type match for every row below. */
const DECOY: DNSRecord = {
  id: "rec-decoy",
  type: "A",
  name: "www.example.test",
  content: "203.0.113.9",
  ttl: 300,
  zone_id: ZONE_ID,
  zone_name: ZONE_NAME,
  created_on: "2026-10-01T00:00:00Z",
  modified_on: "2026-10-01T00:00:00Z",
};

/** The record the preview named, deliberately second. */
const CONFLICTING: DNSRecord = {
  id: "rec-9",
  type: "A",
  name: "www.example.test",
  content: "203.0.113.50",
  ttl: 120,
  zone_id: ZONE_ID,
  zone_name: ZONE_NAME,
  created_on: "2026-10-02T00:00:00Z",
  modified_on: "2026-10-02T00:00:00Z",
};

/** What the undo would put back. */
const TARGET: RetainedRecordSnapshot = {
  recordType: "A",
  name: "www.example.test",
  content: "198.51.100.1",
  ttl: 3600,
  priority: null,
  proxied: false,
  comment: null,
  tags: [],
};

function row(drift: UndoPlanRow["drift"]): UndoPlanRow {
  return {
    entryId: "entry-1",
    recordType: "A",
    recordName: "www.example.test",
    target: TARGET,
    drift,
    // Irrelevant to planning — the dialog decides what reaches here, and a
    // confirmed row arrives selected whatever its default was.
    selectedByDefault: drift.state === "unchanged",
  };
}

test("a conflict row writes to the id the dialog named, not a name match", () => {
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [row({ state: "conflict", conflictingRecordId: "rec-9" })],
    [DECOY, CONFLICTING],
  );

  assert.equal(plan.planned.length, 1, "the row should plan a write");
  assert.equal(plan.refused.length, 0);
  assert.equal(plan.skipped.length, 0);

  const forward = plan.planned[0].forward;
  assert.equal(forward.kind, "update");
  assert.equal(
    forward.kind === "update" ? forward.record.id : null,
    "rec-9",
    "the write must land on the id the preview named and the dialog displayed",
  );
  assert.notEqual(
    forward.kind === "update" ? forward.record.id : null,
    DECOY.id,
    "resolving a conflict by type and name would overwrite an unrelated record that happens to share them",
  );
});

test("the reverse of a conflict write restores the record it overwrote", () => {
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [row({ state: "conflict", conflictingRecordId: "rec-9" })],
    [DECOY, CONFLICTING],
  );

  // Redo has to be able to put back what the undo clobbered, which is the
  // whole reason the user was asked to confirm an overwrite rather than told
  // it had happened.
  const reverse = plan.planned[0].reverse;
  assert.equal(reverse.kind, "update");
  assert.deepEqual(
    reverse.kind === "update" ? reverse.record : null,
    CONFLICTING,
  );
});

test("every other drift state still resolves by type and name", () => {
  // The contrast is the point: if this stopped working, the conflict branch
  // above could be passing because the resolver had been keyed on ids for
  // every state, which would break re-creates and plain reverts instead.
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [row({ state: "changed", current: TARGET })],
    [DECOY, CONFLICTING],
  );

  const forward = plan.planned[0].forward;
  assert.equal(
    forward.kind === "update" ? forward.record.id : null,
    DECOY.id,
    "a non-conflict row takes the first record matching its type and name",
  );
});

test("an absent row re-creates even while the loaded list still shows the record", () => {
  // The preview asked Cloudflare; this zone's loaded records are a cache. A
  // write aimed at an id Cloudflare has already destroyed is the worse error,
  // so `absent` must ignore the stale hit entirely.
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [row({ state: "absent" })],
    [DECOY, CONFLICTING],
  );

  assert.equal(plan.planned.length, 1);
  const forward = plan.planned[0].forward;
  assert.equal(forward.kind, "create");
  assert.equal(
    forward.kind === "create" ? forward.record.content : null,
    TARGET.content,
    "the re-create carries the retained snapshot, not the stale cached record",
  );
});

test("a conflict whose id is not in the loaded list is refused, never guessed", () => {
  // The id the preview named is real at Cloudflare and absent from this
  // zone's cached records — the list is stale, not the record gone. A decoy
  // sharing the row's type and name is present, so a resolver that falls back
  // to a name lookup has something wrong to find and will write to it.
  const plan = planUndoRows(
    ZONE_ID,
    ZONE_NAME,
    [row({ state: "conflict", conflictingRecordId: "rec-not-loaded" })],
    [DECOY],
  );

  assert.deepEqual(
    plan.planned.map((planned) => planned.row.entryId),
    [],
    "a conflict with no local record produced a write, against a record the preview did not name",
  );
  assert.equal(
    plan.refused.length,
    1,
    "the row should be refused, with a reason",
  );
  // A code, not prose: the planner stays locale-free and the renderer turns
  // this into a literal `t()` call. See `UndoRefusalCode`.
  assert.equal(plan.refused[0].code, "stale-record-list");
});
