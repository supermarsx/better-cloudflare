import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNAPTR } from "../src/lib/dns/dns-parsers";
import { dnsRecordSchema } from "../src/lib/dns/validation";

const validates = (content: string) =>
  dnsRecordSchema.safeParse({ type: "NAPTR", name: "naptr", content }).success;

/** Raw bytes that must never survive into a stored NAPTR field. */
const NUL = "\u0000";
const LF = "\n";

test('NAPTR content validated as "order preference flags service regexp replacement"', () => {
  const bad = dnsRecordSchema.safeParse({
    type: "NAPTR",
    name: "naptr",
    content: "bad",
  });
  assert.equal(bad.success, false);
  const badOrder = dnsRecordSchema.safeParse({
    type: "NAPTR",
    name: "naptr",
    content: 'x 10 A S "!" example.com',
  });
  assert.equal(badOrder.success, false);
  const badPref = dnsRecordSchema.safeParse({
    type: "NAPTR",
    name: "naptr",
    content: '10 x A S "!" example.com',
  });
  assert.equal(badPref.success, false);
  const ok = dnsRecordSchema.safeParse({
    type: "NAPTR",
    name: "naptr",
    content: '10 20 A S "!" example.com',
  });
  assert.equal(ok.success, true);
});

test("NAPTR schema and parser agree on what a record is", () => {
  // The schema used to carry its own, weaker tokeniser: no length caps, no
  // control-character handling, no escape handling, and a `parts.length < 6`
  // gate that waved through a seventh field. Content could therefore pass
  // validation and then be re-read by `parseNAPTR` as something else — or as
  // nothing at all — everywhere downstream.
  const contents = [
    // Well-formed: both must accept.
    '10 20 U E2U+sip "!^.*$!sip:info@example.com!" example.com.',
    '10 20 A S "!" example.com',
    '100 10 "S" "SIP+D2U" "" _sip._udp.example.com.',
    "65535 65535 U E2U+sip !x!y! example.com.",
    // Malformed: both must reject.
    "bad",
    '10 20 U E2U+sip "!^.*$!sip:info@example.com!" . trailing',
    '10 20 U E2U+sip "unterminated .',
    'x 10 A S "!" example.com',
    '10 x A S "!" example.com',
    '65536 20 U E2U+sip "!x!y!" .',
    '10 65536 U E2U+sip "!x!y!" .',
    '999999 20 U E2U+sip "!x!y!" .',
    '0000010 20 U E2U+sip "!x!y!" .',
    `10 20 U E2U+sip ${"x".repeat(4_097)} .`,
    `10 20 U E2U+sip ${"x".repeat(16_385)} .`,
    '10 20 U E2U+sip "!^.*$!" .\nevil',
    '10 20 U E2U+sip "!^.*$!" .\revil',
    '10 20 U E2U+sip "!^.*$!" .\u2028evil',
    '10 20 U E2U+sip "!^.*$!" .\u2029evil',
    '10 20 U E2U+sip "!x\\' + NUL + 'y!" .',
    '10 20 U E2U+sip "!x\\' + LF + 'y!" .',
    '10 20 U E2U+sip "!x!y!" ev' + NUL + "il",
  ];

  for (const content of contents) {
    const parserAccepts = parseNAPTR(content).order !== undefined;
    assert.equal(
      validates(content),
      parserAccepts,
      `schema and parser disagree on ${JSON.stringify(content)}`,
    );
  }
});

test("NAPTR validation rejects structural, multiline, control and resource bypasses", () => {
  const hostileContents = [
    '10 20 U E2U+sip "!^.*$!sip:info@example.com!" . trailing',
    '10 20 U E2U+sip "!^.*$!sip:info@example.com!" .\nevil',
    '10 20 U E2U+sip "!^.*$!sip:info@example.com!" .\u2028evil',
    '10 20 U E2U+sip "!x\\' + NUL + 'y!" .',
    '999999 20 U E2U+sip "!x!y!" .',
    `10 20 U E2U+sip ${"x".repeat(16_385)} .`,
  ];

  for (const content of hostileContents) {
    assert.equal(validates(content), false, JSON.stringify(content));
  }
});
