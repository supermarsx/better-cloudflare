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
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

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
import { TauriClient } from "../src/lib/api/tauri-client";

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
