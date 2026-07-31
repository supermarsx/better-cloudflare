import assert from "node:assert/strict";
import { test } from "node:test";
import { composeNAPTR, parseNAPTR } from "../src/lib/dns/dns-parsers";
import { dnsRecordSchema } from "../src/lib/dns/validation";

test("NAPTR quoted regexp is accepted", () => {
  const ok = dnsRecordSchema.safeParse({
    type: "NAPTR",
    name: "foo",
    content: '10 20 A S "!^.*$!" example.com',
  });
  assert.equal(ok.success, true);
});

test("NAPTR parser handles every whitespace separator outside quoted fields", () => {
  const parsed = parseNAPTR(
    '10\t20\r\n"U"\u2028"E2U+sip"\n"!^.*$!sip:info@example.com!"\texample.com.',
  );
  assert.deepEqual(parsed, {
    order: 10,
    preference: 20,
    flags: "U",
    service: "E2U+sip",
    regexp: "!^.*$!sip:info@example.com!",
    replacement: "example.com.",
  });
});

test("NAPTR serializer preserves quotes and backslashes through one boundary", () => {
  const regexp = String.raw`!^\"([0-9]+)\"$!sip:\1@example.com!`;
  const composed = composeNAPTR(10, 20, "U", "E2U+sip", regexp, ".");
  assert.equal(parseNAPTR(composed).regexp, regexp);
  assert.match(composed, /^10 20 U E2U\+sip ".+" \.$/u);
});

test("NAPTR serializer safely represents controls and rejects field injection", () => {
  const regexp = "!line1\nline2\u0000!replacement!";
  const composed = composeNAPTR(10, 20, "U", "E2U+sip", regexp, ".");
  assert.equal(composed.includes("\n"), false);
  assert.match(composed, /\\010/u);
  assert.match(composed, /\\000/u);
  assert.equal(parseNAPTR(composed).regexp, regexp);
  assert.equal(
    composeNAPTR(10, 20, "U", "E2U+sip", "!x!y!", "safe.example\nevil"),
    "",
  );
});

test("NAPTR parser rejects malformed and resource-exhausting forms", () => {
  const rejected = {
    order: undefined,
    preference: undefined,
    flags: "",
    service: "",
    regexp: "",
    replacement: "",
  };
  assert.deepEqual(parseNAPTR('10 20 U E2U+sip "unterminated .'), rejected);
  assert.deepEqual(parseNAPTR("10 20 U E2U+sip !x!y!"), rejected);
  assert.deepEqual(
    parseNAPTR(`10 20 U E2U+sip ${"x".repeat(4_097)} .`),
    rejected,
  );
  assert.deepEqual(
    parseNAPTR(`10 20 U E2U+sip ${"x".repeat(16_385)} .`),
    rejected,
  );
  assert.deepEqual(parseNAPTR("10 20 U E2U+sip !x!y! . trailing"), rejected);
  assert.equal(
    composeNAPTR(10, 20, "U", "E2U+sip", "x".repeat(4_097), "."),
    "",
  );
});
