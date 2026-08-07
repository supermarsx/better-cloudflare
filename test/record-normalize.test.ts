import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHARACTER_STRING_RECORD_TYPES,
  isCharacterStringRecordType,
  normalizeRecordCharacterStrings,
  normalizeRecordContent,
  normalizeRecordListCharacterStrings,
} from "../src/lib/dns/record-normalize";

test("recognizes only the character-string record types", () => {
  for (const type of CHARACTER_STRING_RECORD_TYPES) {
    assert.ok(isCharacterStringRecordType(type), type);
    assert.ok(isCharacterStringRecordType(type.toLowerCase()), type);
  }
  for (const type of ["A", "AAAA", "CNAME", "MX", "NS", "SRV", "PTR"]) {
    assert.equal(isCharacterStringRecordType(type), false, type);
  }
  assert.equal(isCharacterStringRecordType(undefined), false);
});

test("quotes TXT and SPF payloads and repairs unbalanced quotes", () => {
  const spf = "v=spf1 include:_spf.example.com ~all";
  for (const type of ["TXT", "SPF", "txt"]) {
    assert.equal(normalizeRecordContent(type, spf), `"${spf}"`, type);
    assert.equal(normalizeRecordContent(type, `"${spf}`), `"${spf}"`, type);
    assert.equal(normalizeRecordContent(type, `${spf}"`), `"${spf}"`, type);
    assert.equal(normalizeRecordContent(type, `"${spf}"`), `"${spf}"`, type);
  }
});

test("normalization is stable and splits payloads over 255 bytes", () => {
  const long = "a".repeat(300);
  const once = normalizeRecordContent("TXT", long);
  assert.equal(once, `"${"a".repeat(255)}" "${"a".repeat(45)}"`);
  assert.equal(normalizeRecordContent("TXT", once), once);
});

test("HINFO keeps each field a separate character-string", () => {
  assert.equal(
    normalizeRecordContent("HINFO", "Intel Linux"),
    '"Intel" "Linux"',
  );
  assert.equal(
    normalizeRecordContent("HINFO", '"Intel" "Linux"'),
    '"Intel" "Linux"',
  );
  assert.equal(
    normalizeRecordContent("HINFO", '"Intel Xeon" Linux'),
    '"Intel Xeon" "Linux"',
  );
});

test("CAA quotes only the value field and leaves flags and tag bare", () => {
  assert.equal(
    normalizeRecordContent("CAA", "0 issue letsencrypt.org"),
    '0 issue "letsencrypt.org"',
  );
  assert.equal(
    normalizeRecordContent("CAA", '0 issue "letsencrypt.org'),
    '0 issue "letsencrypt.org"',
  );
  assert.equal(
    normalizeRecordContent("CAA", '128 iodef "mailto:security@example.com"'),
    '128 iodef "mailto:security@example.com"',
  );
  // Unparseable content is preserved rather than mangled.
  assert.equal(normalizeRecordContent("CAA", "not-a-caa"), "not-a-caa");
});

test("types whose RDATA quoting would be invalid are untouched", () => {
  const cases: Array<[string, string]> = [
    ["A", "192.0.2.10"],
    ["AAAA", "2001:db8::1"],
    ["CNAME", "edge.example.com"],
    ["MX", "10 mail.example.com"],
    ["NS", "ns1.example.com"],
    ["SRV", "10 5 443 service.example.com"],
    ["PTR", "host.example.com"],
  ];
  for (const [type, content] of cases) {
    assert.equal(normalizeRecordContent(type, content), content, type);
  }
});

test("empty and missing content are left alone", () => {
  assert.equal(normalizeRecordContent("TXT", ""), "");
  assert.equal(normalizeRecordContent("TXT", "   "), "   ");
  assert.equal(normalizeRecordContent("TXT", undefined), "");
});

test("records are only cloned when the content actually changes", () => {
  const unchanged = { type: "A", content: "192.0.2.10" };
  assert.strictEqual(normalizeRecordCharacterStrings(unchanged), unchanged);

  const changed = { type: "TXT", name: "@", content: "hello" };
  const result = normalizeRecordCharacterStrings(changed);
  assert.notStrictEqual(result, changed);
  assert.equal(changed.content, "hello", "input is not mutated");
  assert.deepEqual(result, { type: "TXT", name: "@", content: '"hello"' });
});

test("lists normalize in place, preserving order", () => {
  assert.deepEqual(
    normalizeRecordListCharacterStrings([
      { type: "TXT", content: "one" },
      { type: "A", content: "192.0.2.10" },
      { type: "TXT", content: 'two"' },
    ]),
    [
      { type: "TXT", content: '"one"' },
      { type: "A", content: "192.0.2.10" },
      { type: "TXT", content: '"two"' },
    ],
  );
});
