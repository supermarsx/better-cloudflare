import assert from "node:assert/strict";
import { test } from "node:test";
import { composeNAPTR, parseNAPTR } from "../src/lib/dns/dns-parsers";
import { dnsRecordSchema } from "../src/lib/dns/validation";

const naptrWithReplacement = (replacement: string) =>
  `10 20 U E2U+sip "!^.*$!sip:info@example.com!" ${replacement}`;

const composeWithReplacement = (replacement: string) =>
  composeNAPTR(10, 20, "U", "E2U+sip", "!x!y!", replacement);

// Test-only RFC 1035 presentation decoder: escaped dots stay within a label.
const decodeDnsPresentationLabels = (input: string): string[] | null => {
  const labels: string[] = [];
  let label = "";

  for (let index = 0; index < input.length; index++) {
    const character = input[index] ?? "";
    if (character === ".") {
      if (!label) return null;
      labels.push(label);
      label = "";
      continue;
    }
    if (character !== "\\") {
      label += character;
      continue;
    }

    const escapedCharacter = input[index + 1];
    if (!escapedCharacter) return null;
    if (/^[0-9]$/u.test(escapedCharacter)) {
      const decimalEscape = input.slice(index + 1, index + 4);
      if (!/^[0-9]{3}$/u.test(decimalEscape)) return null;
      const octet = Number.parseInt(decimalEscape, 10);
      if (octet > 255) return null;
      label += String.fromCharCode(octet);
      index += 3;
      continue;
    }

    label += escapedCharacter;
    index++;
  }

  if (label) labels.push(label);
  else if (input.at(-1) !== ".") return null;
  return labels;
};

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

test("NAPTR replacement preserves valid DNS escapes and label boundaries", () => {
  const escapedDot = String.raw`foo\046bar.example.`;
  const plainDot = "foo.bar.example.";
  assert.deepEqual(decodeDnsPresentationLabels(escapedDot), [
    "foo.bar",
    "example",
  ]);
  assert.deepEqual(decodeDnsPresentationLabels(plainDot), [
    "foo",
    "bar",
    "example",
  ]);

  const parsedEscapedDot = parseNAPTR(naptrWithReplacement(escapedDot));
  const roundTrippedEscapedDot = parseNAPTR(
    composeWithReplacement(parsedEscapedDot.replacement),
  ).replacement;
  assert.equal(roundTrippedEscapedDot, escapedDot);
  assert.deepEqual(decodeDnsPresentationLabels(roundTrippedEscapedDot), [
    "foo.bar",
    "example",
  ]);

  const replacements = [
    escapedDot,
    String.raw`foo\.bar.example.`,
    String.raw`foo\\bar.example.`,
    String.raw`foo\092bar.example.`,
    String.raw`foo\032bar.example.`,
    String.raw`foo\ bar.example.`,
    "foo.example\\ ",
    String.raw`foo\010bar.example.`,
  ];

  for (const replacement of replacements) {
    const parsed = parseNAPTR(naptrWithReplacement(replacement));
    assert.equal(parsed.replacement, replacement);
    assert.equal(
      parseNAPTR(composeWithReplacement(parsed.replacement)).replacement,
      replacement,
    );
  }
});

test("NAPTR replacement rejects malformed escapes and raw injection", () => {
  const malformedEscapes = [
    "bad\\",
    String.raw`bad\1`,
    String.raw`bad\12`,
    String.raw`bad\12x`,
    String.raw`bad\256`,
  ];
  for (const replacement of malformedEscapes) {
    assert.equal(decodeDnsPresentationLabels(replacement), null);
  }

  const replacements = [
    ...malformedEscapes,
    "bad label.example.",
    "bad\u0000label.example.",
    "safe\\\nevil.example.",
    "safe\\\revil.example.",
    "safe\\\u2028evil.example.",
  ];

  for (const replacement of replacements) {
    assert.equal(composeWithReplacement(replacement), "");
    assert.equal(parseNAPTR(naptrWithReplacement(replacement)).replacement, "");
  }
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
