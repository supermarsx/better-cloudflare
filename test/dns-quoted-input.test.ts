import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeCharacterString,
  unquoteCharacterString,
} from "../src/lib/dns/character-string";
import { composeNAPTR, parseNAPTR } from "../src/lib/dns/dns-parsers";
import { parseSPF, validateSPF } from "../src/lib/dns/spf";
import { dnsRecordSchema } from "../src/lib/dns/validation";
import {
  parseDMARC,
  validateDMARC,
} from "../src/components/dns/builders/DmarcBuilder";
import {
  parseDKIM,
  validateDKIM,
} from "../src/components/dns/builders/DkimBuilder";
import {
  composeCAA,
  parseCAAContent,
} from "../src/components/dns/builders/CaaBuilder";

const SPF_BARE = "v=spf1 ip4:192.0.2.0/24 include:_spf.example.com ~all";
const DMARC_BARE =
  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; pct=50;";
const DKIM_BARE = `v=DKIM1; k=rsa; p=${"A".repeat(242)}==;`;

/** Every presentation shape a user may paste for the same logical value. */
function shapesOf(value: string) {
  const half = Math.floor(value.length / 2);
  return {
    quoted: `"${value}"`,
    padded: `   "${value}"  `,
    split: `"${value.slice(0, half)}" "${value.slice(half)}"`,
    unmatchedLeading: `"${value}`,
    unmatchedTrailing: `${value}"`,
    normalized: normalizeCharacterString(value),
  };
}

test("SPF parses quoted input exactly like unquoted input", () => {
  const expected = parseSPF(SPF_BARE);
  assert.ok(expected);
  assert.equal(expected?.mechanisms.length, 3);

  for (const [shape, content] of Object.entries(shapesOf(SPF_BARE))) {
    assert.deepEqual(parseSPF(content), expected, shape);
    assert.deepEqual(validateSPF(content), { ok: true, problems: [] }, shape);
  }
});

test("SPF still rejects content that is not SPF once unquoted", () => {
  assert.equal(parseSPF('"ip4:192.0.2.1 -all"'), null);
  assert.equal(validateSPF('"ip4:192.0.2.1 -all"').ok, false);
  assert.equal(parseSPF('""'), null);
});

test("SPF records validate through the zod schema when quoted", () => {
  for (const content of Object.values(shapesOf(SPF_BARE))) {
    const result = dnsRecordSchema.safeParse({
      type: "SPF",
      name: "@",
      content,
      ttl: 300,
    });
    assert.equal(result.success, true, content);
  }

  assert.equal(
    dnsRecordSchema.safeParse({
      type: "SPF",
      name: "@",
      content: '"not spf at all"',
      ttl: 300,
    }).success,
    false,
  );
});

test("SPF multi-string content is joined without a separator", () => {
  const parsed = parseSPF('"v=spf1 include:_spf.exam" "ple.com -all"');
  assert.equal(parsed?.mechanisms[0].mechanism, "include");
  assert.equal(parsed?.mechanisms[0].value, "_spf.example.com");
});

test("DMARC parses quoted input exactly like unquoted input", () => {
  const expected = parseDMARC(DMARC_BARE);
  assert.equal(expected.policy, "quarantine");
  assert.equal(expected.rua, "mailto:dmarc@example.com");
  assert.equal(expected.pct, 50);

  for (const [shape, content] of Object.entries(shapesOf(DMARC_BARE))) {
    assert.deepEqual(parseDMARC(content), expected, shape);
    assert.deepEqual(validateDMARC(content), { ok: true, problems: [] }, shape);
  }
});

test("DMARC keeps rejecting content that is not DMARC once unquoted", () => {
  assert.equal(parseDMARC('"p=reject;"').policy, "none");
  assert.equal(validateDMARC('"p=reject;"').ok, false);
});

test("DKIM parses quoted and split input exactly like unquoted input", () => {
  const expected = parseDKIM(DKIM_BARE);
  assert.equal(expected.keyType, "rsa");
  assert.ok(expected.publicKey.startsWith("AAA"));

  for (const [shape, content] of Object.entries(shapesOf(DKIM_BARE))) {
    assert.deepEqual(parseDKIM(content), expected, shape);
    assert.deepEqual(validateDKIM(content), { ok: true, problems: [] }, shape);
  }
});

test("DKIM keys longer than 255 bytes survive the split representation", () => {
  const longKey = `v=DKIM1; k=rsa; p=${"B".repeat(400)}==;`;
  const normalized = normalizeCharacterString(longKey);

  assert.equal(normalized.split('" "').length, 2);
  assert.deepEqual(parseDKIM(normalized), parseDKIM(longKey));
  assert.equal(unquoteCharacterString(normalized), longKey);
});

test("NAPTR keeps empty character-string fields quoted so the record still parses", () => {
  const composed = composeNAPTR(
    100,
    10,
    "S",
    "SIP+D2U",
    "",
    "_sip._udp.example.com.",
  );
  assert.equal(composed, '100 10 S SIP+D2U "" _sip._udp.example.com.');
  assert.deepEqual(parseNAPTR(composed), {
    order: 100,
    preference: 10,
    flags: "S",
    service: "SIP+D2U",
    regexp: "",
    replacement: "_sip._udp.example.com.",
  });

  assert.equal(composeNAPTR(100, 10, "", "", "", "."), '100 10 "" "" "" .');
  // Quoted and bare character-string fields parse identically.
  assert.deepEqual(
    parseNAPTR('100 10 "S" "SIP+D2U" "" example.com.'),
    parseNAPTR('100 10 S SIP+D2U "" example.com.'),
  );
});

test("CAA values accept quoted, bare and half-quoted input", () => {
  const expected = "letsencrypt.org";
  for (const content of [
    `0 issue ${expected}`,
    `0 issue "${expected}"`,
    `0 issue "${expected}`,
    `0 issue ${expected}"`,
  ]) {
    const parsed = parseCAAContent(content);
    assert.equal(parsed.flags, 0, content);
    assert.equal(parsed.tag, "issue", content);
    assert.equal(parsed.value, expected, content);
  }

  // Only the value field is quoted; flags and tag stay bare.
  assert.equal(
    composeCAA({ flags: 0, tag: "issue", value: expected }),
    `0 issue "${expected}"`,
  );
});
