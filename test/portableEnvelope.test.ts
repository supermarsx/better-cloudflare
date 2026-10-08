/**
 * The order the envelope checks run in, and the projection they produce.
 *
 * The order is the point of most of these. Each rejection is asserted with a
 * document that would fail a *later* check too, so a parser that moved the
 * ceiling below `JSON.parse`, or the marker check below the kind check, fails
 * here rather than passing with a differently-worded refusal. The oversized
 * document is deliberately not valid JSON: `too-large` proves the ceiling ran
 * first, because anything else would have said `not-json`.
 *
 * The projection is pinned by key, not by field: the whole reason a parser
 * builds a fresh object is that returning the parsed JSON would carry every
 * other field the file chose to include.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildEnvelope, parseEnvelope } from "../src/lib/portable/envelope";
import {
  MAX_PORTABLE_FILE_BYTES,
  PORTABLE_FORMAT,
  PORTABLE_FORMAT_VERSION,
} from "../src/lib/portable/types";

const NOW = new Date("2026-03-04T05:06:07.000Z");
const OPTIONS = { appVersion: "1.2.3", now: NOW };

function envelopeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: PORTABLE_FORMAT,
    version: PORTABLE_FORMAT_VERSION,
    kind: "settings",
    exportedAt: NOW.toISOString(),
    appVersion: "1.2.3",
    payload: { preferences: {} },
    ...overrides,
  });
}

test("buildEnvelope stamps the format, the version and the injected moment", () => {
  const envelope = buildEnvelope("personas", [{ name: "a" }], OPTIONS);
  assert.deepEqual(envelope, {
    format: PORTABLE_FORMAT,
    version: PORTABLE_FORMAT_VERSION,
    kind: "personas",
    exportedAt: "2026-03-04T05:06:07.000Z",
    appVersion: "1.2.3",
    payload: [{ name: "a" }],
  });
});

test("the byte ceiling is checked before the file is parsed", () => {
  // Two-byte characters: half as many of them as the ceiling has bytes, plus
  // one, is under the ceiling by `.length` and over it by UTF-8 bytes. A
  // parser measuring `.length` accepts this; one measuring bytes does not.
  const oversized = "é".repeat(MAX_PORTABLE_FILE_BYTES / 2 + 1);
  assert.ok(oversized.length < MAX_PORTABLE_FILE_BYTES);

  const parse = parseEnvelope(oversized, "settings");
  assert.equal(parse.ok, false);
  // Not `not-json`, which is what this document is: the ceiling ran first.
  assert.equal(parse.ok === false && parse.rejection, "too-large");
});

test("an empty file is refused as empty rather than as broken JSON", () => {
  for (const raw of ["", "   ", "\n\t "]) {
    const parse = parseEnvelope(raw, "settings");
    assert.equal(parse.ok === false && parse.rejection, "empty");
  }
});

test("a file that is not JSON is refused with the parser's own message", () => {
  const parse = parseEnvelope("{ not json", "settings");
  assert.equal(parse.ok === false && parse.rejection, "not-json");
  assert.ok(parse.ok === false && parse.detail.length > 0);
});

test("the format marker is checked before anything about the content", () => {
  // Each of these would also fail a later check -- the first has no kind, the
  // second is not even an object -- and each must be refused on the marker.
  for (const raw of [
    JSON.stringify({ version: 1, payload: {} }),
    JSON.stringify([1, 2, 3]),
    JSON.stringify("a string"),
    envelopeJson({ format: "some-other-app/config" }),
  ]) {
    const parse = parseEnvelope(raw, "settings");
    assert.equal(parse.ok === false && parse.rejection, "not-our-format");
  }
});

test("a newer version is refused and an older one is read", () => {
  const newer = parseEnvelope(
    envelopeJson({ version: PORTABLE_FORMAT_VERSION + 1 }),
    "settings",
  );
  assert.equal(newer.ok === false && newer.rejection, "unsupported-version");

  const missing = parseEnvelope(envelopeJson({ version: "1" }), "settings");
  assert.equal(
    missing.ok === false && missing.rejection,
    "unsupported-version",
  );

  // Lower is accepted: this build knows every field that one wrote.
  const older = parseEnvelope(envelopeJson({ version: 0 }), "settings");
  assert.equal(older.ok, true);
  assert.equal(older.ok === true && older.value.version, 0);
});

test("a file of the wrong kind is refused even though it is ours", () => {
  const parse = parseEnvelope(envelopeJson({ kind: "personas" }), "settings");
  assert.equal(parse.ok === false && parse.rejection, "wrong-kind");

  const kindless = parseEnvelope(envelopeJson({ kind: 7 }), "settings");
  assert.equal(kindless.ok === false && kindless.rejection, "wrong-kind");
});

test("a missing payload is malformed rather than an empty import", () => {
  for (const raw of [
    JSON.stringify({
      format: PORTABLE_FORMAT,
      version: PORTABLE_FORMAT_VERSION,
      kind: "settings",
    }),
    envelopeJson({ payload: null }),
  ]) {
    const parse = parseEnvelope(raw, "settings");
    assert.equal(parse.ok === false && parse.rejection, "malformed-payload");
  }
});

test("the parsed envelope carries nothing the file added", () => {
  const parse = parseEnvelope(
    envelopeJson({ evil: "smuggled", __proto__sneak: 1, kind: "settings" }),
    "settings",
  );
  assert.equal(parse.ok, true);
  if (!parse.ok) return;
  assert.deepEqual(Object.keys(parse.value).sort(), [
    "appVersion",
    "exportedAt",
    "format",
    "kind",
    "payload",
    "version",
  ]);
});

test("the two human-facing fields are bounded and stripped, never trusted", () => {
  const parse = parseEnvelope(
    envelopeJson({ exportedAt: { not: "a string" }, appVersion: "1.0" }),
    "settings",
  );
  assert.equal(parse.ok, true);
  if (!parse.ok) return;
  // A field that is only ever shown to a person loses its value rather than
  // taking the whole file down with it.
  assert.equal(parse.value.exportedAt, "");
  assert.equal(parse.value.appVersion, "1.0");
});

test("an envelope this build writes is one this build reads", () => {
  const raw = JSON.stringify(buildEnvelope("settings", { a: 1 }, OPTIONS));
  const parse = parseEnvelope(raw, "settings");
  assert.equal(parse.ok, true);
  assert.deepEqual(parse.ok === true && parse.value.payload, { a: 1 });
  assert.deepEqual(parse.ok === true && parse.warnings, []);
});
