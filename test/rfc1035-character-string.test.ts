/**
 * `<character-string>` conformance — RFC 1035 §3.3 and §5.1.
 *
 * RFC 1035 §3.3: "<character-string> is a single length octet followed by that
 * number of characters. <character-string> is treated as binary information,
 * and can be up to 256 characters in length (including the length octet)." That
 * is a hard 255 *octet* payload limit, measured in the wire encoding — UTF-8
 * here — not in JavaScript UTF-16 code units.
 *
 * `test/character-string.test.ts` covers the module's own contract. This file
 * covers the RFC requirements around it: the byte-measured limit at and across
 * the boundary for 1-, 2-, 3- and 4-byte code points, the escape forms of
 * §5.1, and the way the limit interacts with the record types that are built
 * from character-strings (RFC 1035 §3.3.14 TXT, §3.3.2 HINFO, RFC 8659 §4
 * CAA, RFC 7208 §3 SPF).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHARACTER_STRING_MAX_BYTES,
  characterStringByteLength,
  escapeCharacterString,
  normalizeCharacterString,
  parseCharacterStrings,
  quoteCharacterString,
  splitCharacterString,
  unquoteCharacterString,
} from "../src/lib/dns/character-string";
import { normalizeRecordContent } from "../src/lib/dns/record-normalize";

/** UTF-8 byte length according to the platform, used as the RFC oracle. */
const wireBytes = (value: string) => Buffer.byteLength(value, "utf8");

/** `a<octet>b`, built without putting a raw control character in this file. */
const around = (codePoint: number) => `a${String.fromCharCode(codePoint)}b`;

test("the 255 octet limit is measured in UTF-8 bytes, not JS string length", () => {
  assert.equal(CHARACTER_STRING_MAX_BYTES, 255);

  // Code points of every UTF-8 width, checked against the platform encoder.
  const samples = [
    { value: "a", bytes: 1 }, // ASCII
    { value: "é", bytes: 2 }, // é — U+00E9
    { value: "€", bytes: 3 }, // € — U+20AC
    { value: "\u{1f600}", bytes: 4 }, // 😀 — U+1F600
  ] as const;

  for (const sample of samples) {
    assert.equal(characterStringByteLength(sample.value), sample.bytes);
    assert.equal(
      characterStringByteLength(sample.value),
      wireBytes(sample.value),
    );
  }

  // A 4-byte code point is two UTF-16 code units: measuring `.length` would
  // under-count the wire size by half.
  assert.equal("\u{1f600}".length, 2);
  assert.equal(characterStringByteLength("\u{1f600}"), 4);

  // 128 two-byte characters are 256 bytes but only 128 JS characters, so a
  // length-based limit would wrongly consider them to fit.
  const twoByte = "é".repeat(128);
  assert.equal(twoByte.length, 128);
  assert.equal(characterStringByteLength(twoByte), 256);
  assert.ok(characterStringByteLength(twoByte) > CHARACTER_STRING_MAX_BYTES);
});

test("a value is split at the byte boundary without ever splitting a code point", () => {
  // Table of payloads built from a single repeated code point of each UTF-8
  // width, sized to sit exactly on and exactly over the 255 byte limit.
  const cases = [
    { label: "1-byte", unit: "a", fit: 255, over: 256 },
    { label: "2-byte", unit: "é", fit: 127, over: 128 },
    { label: "3-byte", unit: "€", fit: 85, over: 86 },
    { label: "4-byte", unit: "\u{1f600}", fit: 63, over: 64 },
  ] as const;

  for (const entry of cases) {
    const fits = entry.unit.repeat(entry.fit);
    assert.ok(
      characterStringByteLength(fits) <= CHARACTER_STRING_MAX_BYTES,
      entry.label,
    );
    assert.deepEqual(splitCharacterString(fits), [fits], entry.label);

    const overflows = entry.unit.repeat(entry.over);
    const chunks = splitCharacterString(overflows);
    assert.equal(chunks.length, 2, entry.label);
    assert.equal(chunks.join(""), overflows, entry.label);
    for (const chunk of chunks) {
      // Never over the wire limit, and never a lone surrogate half.
      assert.ok(wireBytes(chunk) <= CHARACTER_STRING_MAX_BYTES, entry.label);
      assert.ok(!/\p{Surrogate}/u.test(chunk), entry.label);
    }
  }
});

test("a multi-byte code point straddling the boundary moves whole to the next string", () => {
  // 254 ASCII bytes + one 2-byte character: the character cannot be cut in half,
  // so the first string stops at 254 bytes rather than 255.
  const straddling = `${"a".repeat(254)}é`;
  const chunks = splitCharacterString(straddling);

  assert.deepEqual(chunks, ["a".repeat(254), "é"]);
  assert.equal(wireBytes(chunks[0]), 254);
  assert.equal(chunks.join(""), straddling);

  // The same holds for a 4-byte code point spanning the last three bytes.
  const emoji = `${"a".repeat(252)}\u{1f600}`;
  assert.deepEqual(splitCharacterString(emoji), ["a".repeat(252), "\u{1f600}"]);
  assert.equal(wireBytes("a".repeat(252)), 252);
});

test("adjacent strings from a split concatenate back to the original value", () => {
  // RFC 1035 §3.3.14 / RFC 7208 §3.3: multiple character-strings in one RR are
  // concatenated with no separator, which is what makes the split lossless.
  const payloads = [
    `v=DKIM1; k=rsa; p=${"A".repeat(500)}==`,
    "é".repeat(400),
    "\u{1f600}".repeat(200),
    `${"x".repeat(255)}${"y".repeat(255)}${"z".repeat(10)}`,
  ];

  for (const payload of payloads) {
    const normalized = normalizeCharacterString(payload);
    const parts = parseCharacterStrings(normalized);

    assert.ok(parts.length > 1, payload.slice(0, 16));
    for (const part of parts) {
      assert.ok(wireBytes(part) <= CHARACTER_STRING_MAX_BYTES);
    }
    assert.equal(parts.join(""), payload);
    assert.equal(unquoteCharacterString(normalized), payload);
    // Normalization is idempotent, so a saved record does not drift on re-save.
    assert.equal(normalizeCharacterString(normalized), normalized);
  }
});

test("only the characters RFC 1035 §5.1 requires are escaped", () => {
  // §5.1: '"' and '\' must be escaped inside a quoted string; non-printable
  // octets use the \DDD decimal form. Everything else stays literal.
  const cases = [
    { input: 'a"b', escaped: String.raw`a\"b` },
    { input: String.raw`a\b`, escaped: String.raw`a\\b` },
    { input: "a;b", escaped: "a;b" }, // ";" needs no escape inside quotes
    { input: "a b", escaped: "a b" }, // spaces are literal inside quotes
    { input: around(0x09), escaped: String.raw`a\009b` }, // TAB
    { input: around(0x0a), escaped: String.raw`a\010b` }, // LF
    { input: around(0x00), escaped: String.raw`a\000b` }, // NUL
    { input: around(0x7f), escaped: String.raw`a\127b` }, // DEL
    { input: "é", escaped: "é" }, // printable non-ASCII stays literal
  ] as const;

  for (const entry of cases) {
    assert.equal(escapeCharacterString(entry.input), entry.escaped);
    assert.equal(quoteCharacterString(entry.input), `"${entry.escaped}"`);
    // Every escaped form decodes back to the original octets.
    assert.equal(unquoteCharacterString(`"${entry.escaped}"`), entry.input);
  }
});

test("decimal escapes decode across the whole 0-255 octet range", () => {
  // RFC 1035 §5.1: "\DDD where each D is a digit is the octet corresponding to
  // the decimal number described by DDD."
  const cases = [
    { escape: String.raw`"\000"`, codePoint: 0 },
    { escape: String.raw`"\009"`, codePoint: 9 },
    { escape: String.raw`"\034"`, codePoint: 34 }, // '"'
    { escape: String.raw`"\092"`, codePoint: 92 }, // '\'
    { escape: String.raw`"\255"`, codePoint: 255 },
  ] as const;

  for (const entry of cases) {
    assert.deepEqual(parseCharacterStrings(entry.escape), [
      String.fromCharCode(entry.codePoint),
    ]);
  }

  // A decimal escape must be exactly three digits: "\10" is the literal "1"
  // followed by "0", not the octet 10.
  assert.deepEqual(parseCharacterStrings(String.raw`"\10"`), ["10"]);

  // GAP: an out-of-range escape such as "\256" is invalid per §5.1 and BIND
  // rejects the zone. This module is deliberately repair-oriented and decodes
  // it as the literal characters "256" instead of raising.
  assert.deepEqual(parseCharacterStrings(String.raw`"\256"`), ["256"]);
});

test("TXT and SPF content over 255 bytes is normalized into adjacent strings", () => {
  // A DKIM 2048-bit key is the canonical case: ~400 characters, one logical
  // value, two character-strings on the wire (RFC 6376 §3.6.2.2).
  const dkim = `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA${"Ab3Zx".repeat(
    70,
  )}==`;
  assert.ok(wireBytes(dkim) > CHARACTER_STRING_MAX_BYTES);

  for (const type of ["TXT", "SPF"]) {
    const normalized = normalizeRecordContent(type, dkim);
    const parts = parseCharacterStrings(normalized);

    assert.ok(parts.length > 1, type);
    for (const part of parts) {
      assert.ok(wireBytes(part) <= CHARACTER_STRING_MAX_BYTES, type);
    }
    assert.equal(unquoteCharacterString(normalized), dkim, type);
    assert.equal(normalizeRecordContent(type, normalized), normalized, type);
  }
});

test("HINFO keeps its two fields as separate character-strings", () => {
  // RFC 1035 §3.3.2: HINFO RDATA is exactly two <character-string>s, CPU and OS.
  // They must not be merged into one string, and a value containing a space
  // must be quoted so it stays a single field.
  assert.equal(
    normalizeRecordContent("HINFO", "x86_64 Linux"),
    '"x86_64" "Linux"',
  );
  assert.equal(
    normalizeRecordContent("HINFO", 'x86_64 "Windows Server"'),
    '"x86_64" "Windows Server"',
  );
  assert.equal(
    normalizeRecordContent("HINFO", '"Intel i7" "Linux"'),
    '"Intel i7" "Linux"',
  );
});

test("CAA quotes only its value field, never its flags or tag", () => {
  // RFC 8659 §4.1-4.2: CAA RDATA is <flags> <tag> <value>; flags is an unsigned
  // 8-bit integer and tag is a US-ASCII token — both are bare in presentation
  // form. Only the value is a <character-string>.
  const cases = [
    { input: "0 issue ca.example.net", output: '0 issue "ca.example.net"' },
    { input: '0 issue "ca.example.net"', output: '0 issue "ca.example.net"' },
    { input: "0 issuewild ;", output: '0 issuewild ";"' }, // explicit refusal
    {
      input: "128 iodef mailto:security@example.com",
      output: '128 iodef "mailto:security@example.com"', // critical flag = 128
    },
    {
      input: '0 issue "ca.example.net; account=12345"',
      output: '0 issue "ca.example.net; account=12345"', // §4.2 parameters
    },
  ] as const;

  for (const entry of cases) {
    const normalized = normalizeRecordContent("CAA", entry.input);
    assert.equal(normalized, entry.output, entry.input);
    // Flags and tag stay bare: the first two fields never gain quotes.
    const [flags, tag] = normalized.split(/\s+/u);
    assert.match(flags, /^\d{1,3}$/u, entry.input);
    assert.match(tag, /^[A-Za-z0-9-]+$/u, entry.input);
    // Idempotent.
    assert.equal(
      normalizeRecordContent("CAA", normalized),
      normalized,
      entry.input,
    );
  }
});

test("types whose RDATA is not a character-string are never quoted", () => {
  // Quoting these would invalidate them: the RDATA is numeric fields, domain
  // names or base64/hex blobs, not <character-string>s.
  const untouched = [
    ["A", "192.0.2.1"],
    ["AAAA", "2001:db8::1"],
    ["CNAME", "example.com."],
    ["MX", "10 inbound.example.net."],
    ["NS", "ns1.example.net."],
    ["SRV", "10 60 5060 sip.example.com."],
    ["DS", "12345 8 2 49FD46E6C4B45C55D4AC69CBD3CD34AC1AFE51DE"],
    ["DNSKEY", "257 3 8 AwEAAaHIwpx3w4VHKi6i1LHnTaWeHCL154Jug0Ykv"],
    ["TLSA", "3 1 1 0123456789abcdef"],
    ["SSHFP", "4 2 0123456789abcdef"],
    ["LOC", "42 21 54.000 N 71 06 18.000 W -24m 30m"],
    ["NAPTR", '100 10 "S" "SIP+D2U" "" _sip._udp.example.com.'],
    ["HTTPS", '1 . alpn="h2,h3" ipv4hint=192.0.2.1'],
  ] as const;

  for (const [type, content] of untouched) {
    assert.equal(normalizeRecordContent(type, content), content, type);
  }
});
