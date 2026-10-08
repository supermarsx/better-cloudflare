/**
 * The diagnostics report must not be able to carry the audit trail.
 *
 * The trail records record *content* for the user's own actions — see
 * `src-tauri/src/commands/trail.rs`, which argues why a change log that will
 * not say what a record holds is nearly useless. Content can be key material:
 * a DKIM private key, a service verification token. The diagnostics report is
 * the one artefact in this application built to be pasted into a public issue,
 * and `diagnosticsReport.test.ts` already pins that a record's content never
 * reaches it.
 *
 * This file pins the other end of the same promise: that the report's
 * collector never *asks* for the log. That is the structural reason the two
 * cannot meet, and it is worth a test of its own because it is the kind of
 * thing a later "include recent activity in diagnostics" change would undo
 * without anyone noticing — the content would arrive through the entries, not
 * through the records `diagnosticsReport.test.ts` watches.
 *
 * # The report now does say something about the trail
 *
 * It says how many entries there are, when the oldest and newest were written,
 * and how they split by actor and by outcome. That is six numbers and two
 * timestamps, and none of it is an entry.
 *
 * The obvious way to produce it — fetch the entries, count them in the
 * renderer — is exactly what this file forbids, so it is not how it is done.
 * `audit_trail_summary` counts on the host side and returns only the counts,
 * which means an entry is never transmitted at all. That is a *stronger*
 * guarantee than a renderer that merely chooses not to ask: the content cannot
 * reach the webview even if a later change wanted it to. Both halves are
 * pinned below.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { collectDiagnosticsSnapshot } from "../src/lib/diagnostics/collect-diagnostics";
import {
  buildDiagnosticsReport,
  DIAGNOSTICS_SCHEMA,
  type DiagnosticsSnapshot,
} from "../src/lib/diagnostics/diagnostics-report";
import {
  renderDiagnosticsJson,
  renderDiagnosticsMarkdown,
} from "../src/lib/diagnostics/diagnostics-markdown";
import { AUDIT_SUMMARY_COMMAND } from "../src/lib/diagnostics/host-facts";
import { TauriClient } from "../src/lib/api/tauri-client";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readRepositoryFile(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

/** Key material a trail entry legitimately carries and a report must not. */
const TRAIL_SECRET = "v=DKIM1; p=MIIBIjANBgkqhkiG9w0-secret-key-material";

const originalWindow = (globalThis as { window?: unknown }).window;
const originalGetAuditEntries = TauriClient.getAuditEntries;

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  TauriClient.getAuditEntries = originalGetAuditEntries;
});

/** A trail as the backend would hand it over, content and all. */
function trailWithSecrets(): unknown[] {
  return [
    {
      timestamp: "2026-10-07T09:00:00.000Z",
      operation: "dns:update",
      resource: "record-1",
      actor: "user",
      outcome: "succeeded",
      zone_id: "zone-1",
      record_type: "TXT",
      record_name: "selector._domainkey.example.com",
      changes: { content: { from: "v=DKIM1; p=old", to: TRAIL_SECRET } },
    },
  ];
}

test("collecting a diagnostics snapshot never asks for the audit log", async () => {
  let asked = 0;
  TauriClient.getAuditEntries = async () => {
    asked += 1;
    return trailWithSecrets();
  };
  // Desktop mode, so every host probe the collector has is actually attempted
  // rather than short-circuited. The harness forwards `__TAURI__` onto the
  // jsdom window, which is what `isDesktop()` reads.
  (globalThis as { window?: unknown }).window = { __TAURI__: {} };

  const snapshot = await collectDiagnosticsSnapshot();

  assert.equal(
    asked,
    0,
    "the report is built to be pasted in public; the trail holds record content",
  );
  assert.ok(
    !JSON.stringify(snapshot).includes(TRAIL_SECRET),
    "and nothing from the trail reached the snapshot",
  );

  // A positive control for the tripwire itself: a zero above only means
  // something if a real call would have been counted.
  await TauriClient.getAuditEntries();
  assert.equal(asked, 1, "the probe counts a call when one is made");
});

test("no rendering of a report has a place to put a trail entry", () => {
  // The payload is built from a `DiagnosticsSnapshot`, and the snapshot type
  // has no audit field — so the only way an entry could reach a rendering is
  // as an unknown extra, which `buildDiagnosticsReport` does not copy through.
  const snapshot = {
    auditEntries: trailWithSecrets(),
  } as unknown as DiagnosticsSnapshot;
  const report = buildDiagnosticsReport(snapshot, { includeUserData: true });

  for (const [label, text] of [
    ["JSON.stringify", JSON.stringify(report)],
    ["renderDiagnosticsJson", renderDiagnosticsJson(report)],
    ["renderDiagnosticsMarkdown", renderDiagnosticsMarkdown(report)],
  ] as const) {
    // A positive control first, so the two absences below are absences in a
    // rendering that actually rendered something.
    assert.ok(
      text.includes(DIAGNOSTICS_SCHEMA),
      `${label} produced no payload to search`,
    );
    assert.ok(
      !text.includes(TRAIL_SECRET),
      `${label} carried record content out of an audit entry`,
    );
    assert.ok(
      !text.includes("dns:update"),
      `${label} carried an audit operation`,
    );
  }
});

test("the host-side summary is the only audit command the report names", () => {
  // The collector reaches the trail through one command, and that command is
  // the counting one. A grep is the right check here: the guarantee is about
  // which command names appear in the module at all, not about what one call
  // happened to return.
  const collector = readRepositoryFile(
    "src/lib/diagnostics/collect-diagnostics.ts",
  );
  const hostFacts = readRepositoryFile("src/lib/diagnostics/host-facts.ts");

  assert.equal(AUDIT_SUMMARY_COMMAND, "audit_trail_summary");
  assert.ok(
    hostFacts.includes(AUDIT_SUMMARY_COMMAND),
    "the summary command is reached through host-facts.ts",
  );
  for (const forbidden of [
    "get_audit_entries",
    "getAuditEntries",
    "export_audit_entries",
    "exportAuditEntries",
  ] as const) {
    assert.ok(
      !collector.includes(forbidden) && !hostFacts.includes(forbidden),
      `${forbidden} would bring whole entries into the renderer`,
    );
  }
});

test("the counting command returns no field that could hold an entry", () => {
  // Driven with a reply that smuggles entry-shaped fields alongside the
  // counts, because a host command is still an input and is still projected.
  const report = buildDiagnosticsReport(
    {
      auditSummary: {
        entries: 3,
        capacity: 1000,
        oldestAt: "2026-09-01T07:00:00.000Z",
        newestAt: "2026-10-07T09:00:00.000Z",
        byActor: { user: 3 },
        byOutcome: { succeeded: 3 },
        // Not in `AuditTrailSummary`, and so not read.
        ...({
          recentEntries: trailWithSecrets(),
          lastOperation: "dns:update",
          lastResource: "record-1",
        } as Record<string, unknown>),
      },
    },
    { includeUserData: true },
  );

  assert.equal(report.storage.auditTrail.entries, 3);
  assert.equal(report.storage.auditTrail.capacity, 1000);
  for (const [label, text] of [
    ["JSON.stringify", JSON.stringify(report)],
    ["renderDiagnosticsJson", renderDiagnosticsJson(report)],
    ["renderDiagnosticsMarkdown", renderDiagnosticsMarkdown(report)],
  ] as const) {
    assert.ok(
      text.includes(DIAGNOSTICS_SCHEMA),
      `${label} produced no payload to search`,
    );
    for (const forbidden of [
      TRAIL_SECRET,
      "dns:update",
      "record-1",
      "selector._domainkey.example.com",
      "recentEntries",
      "lastOperation",
    ]) {
      assert.ok(
        !text.includes(forbidden),
        `${forbidden} reached ${label} through the audit summary`,
      );
    }
  }
});

test("the reported trail capacity is the one bc-storage evicts to", () => {
  // `MAX_AUDIT_ENTRIES` is private to bc-storage, so the capacity is mirrored
  // in `diagnostics_commands.rs`. This is what keeps the mirror honest, and is
  // cheaper than widening another crate's surface for one diagnostics line.
  const storage = readRepositoryFile("src-tauri/crates/bc-storage/src/lib.rs");
  const commands = readRepositoryFile("src-tauri/src/diagnostics_commands.rs");

  const actual = /const MAX_AUDIT_ENTRIES: usize = (\d+);/u.exec(storage)?.[1];
  const mirrored = /pub const AUDIT_TRAIL_CAPACITY: usize = (\d+);/u.exec(
    commands,
  )?.[1];

  assert.ok(actual !== undefined, "bc-storage declares MAX_AUDIT_ENTRIES");
  assert.equal(
    mirrored,
    actual,
    "AUDIT_TRAIL_CAPACITY mirrors MAX_AUDIT_ENTRIES and has drifted",
  );
});
