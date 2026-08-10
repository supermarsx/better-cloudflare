/**
 * Per-type RDATA presentation formats.
 *
 * Each test pins the *field order* and the field-level validity rules a
 * particular RFC defines, across the three places the app touches RDATA:
 *
 * - the structured parsers / composers in `src/lib/dns/dns-parsers.ts`,
 * - the create/update schema in `src/lib/dns/validation.ts`,
 * - `prepareCopiedDnsRecord`, which must rewrite the domain-name fields of a
 *   record when it is copied between zones and must leave every opaque field
 *   (key material, digests, coordinates) untouched.
 *
 * Builder components (`src/components/dns/builders/**`) are deliberately out of
 * scope here; the LOC, DS, DNSKEY and SVCB parse/compose helpers live inside
 * those components and are not exported.
 *
 * Domains are RFC 2606 reserved; addresses are RFC 5737 / RFC 3849.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeNAPTR,
  composeSRV,
  composeSSHFP,
  composeTLSA,
  parseBINDZone,
  parseNAPTR,
  parseSRV,
  parseSSHFP,
  parseTLSA,
} from "../src/lib/dns/dns-parsers";
import { prepareCopiedDnsRecord } from "../src/lib/dns/record-copy";
import { dnsRecordSchema } from "../src/lib/dns/validation";
import type { DNSRecord } from "../src/types/dns";

const SOURCE_ZONE = "origin.example";
const TARGET_ZONE = "target.test";

function record(overrides: Partial<DNSRecord>): DNSRecord {
  return {
    id: "record-id",
    type: "A",
    name: SOURCE_ZONE,
    content: "192.0.2.1",
    ttl: 300,
    zone_id: "zone-id",
    zone_name: SOURCE_ZONE,
    created_on: "2026-01-01T00:00:00.000Z",
    modified_on: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Content of `record` after a cross-zone copy with rewriting enabled. */
function copiedContent(overrides: Partial<DNSRecord>): string {
  return prepareCopiedDnsRecord(
    record(overrides),
    SOURCE_ZONE,
    TARGET_ZONE,
    true,
  ).content;
}

/** Validation result reduced to `ok` plus the messages, for table assertions. */
function validate(input: unknown): { ok: boolean; problems: string[] } {
  const result = dnsRecordSchema.safeParse(input);
  return result.success
    ? { ok: true, problems: [] }
    : {
        ok: false,
        problems: result.error.issues.map((issue) => issue.message),
      };
}

/** The single record a one-line zone snippet must produce. */
function parseZoneLine(line: string) {
  const records = parseBINDZone(line);
  assert.equal(records.length, 1, line);
  return records[0];
}

test("SRV RDATA is priority, weight, port, target in that order (RFC 2782)", () => {
  // RFC 2782: "_Service._Proto.Name TTL Class SRV Priority Weight Port Target".
  const parsed = parseSRV("10 60 5060 sip.example.com.");
  assert.deepEqual(parsed, {
    priority: 10,
    weight: 60,
    port: 5060,
    target: "sip.example.com.",
  });

  // The fields are positional: a permutation is a different record.
  assert.notDeepEqual(parseSRV("60 10 5060 sip.example.com."), parsed);

  // RFC 2782: a target of "." means the service is decidedly not available.
  assert.deepEqual(parseSRV("0 0 0 ."), {
    priority: 0,
    weight: 0,
    port: 0,
    target: ".",
  });

  assert.equal(
    composeSRV(10, 60, 5060, "sip.example.com."),
    "10 60 5060 sip.example.com.",
  );
  assert.equal(
    composeSRV(parsed.priority, parsed.weight, parsed.port, parsed.target),
    "10 60 5060 sip.example.com.",
  );

  // Fewer than four fields is not an SRV record; the content is handed back
  // whole rather than being guessed at.
  assert.deepEqual(parseSRV("10 60 5060"), {
    priority: undefined,
    weight: undefined,
    port: undefined,
    target: "10 60 5060",
  });

  // RFC 2782 priority/weight/port are unsigned 16-bit; validation requires the
  // three numeric fields plus a target.
  const validations = [
    { content: "10 60 5060 sip.example.com.", ok: true },
    { content: "0 0 0 .", ok: true },
    { content: "10 60 sip.example.com.", ok: false }, // missing a number
    { content: "10 60 5060", ok: false }, // missing the target
    { content: "sip.example.com. 10 60 5060", ok: false }, // wrong order
  ] as const;
  for (const entry of validations) {
    assert.equal(
      validate({
        type: "SRV",
        name: "_sip._tcp.example.com",
        content: entry.content,
      }).ok,
      entry.ok,
      entry.content,
    );
  }

  // Only the target is a domain name, so only the target is rewritten on copy.
  assert.equal(
    copiedContent({ type: "SRV", content: `10 60 5060 sip.${SOURCE_ZONE}.` }),
    `10 60 5060 sip.${TARGET_ZONE}.`,
  );
  // The numeric fields never move, even when they look like a suffix match.
  assert.equal(copiedContent({ type: "SRV", content: "0 0 0 ." }), "0 0 0 .");
});

test("MX RDATA is preference then exchange (RFC 1035 §3.3.9)", () => {
  // The zone parser splits the 16-bit preference into `priority` and keeps the
  // exchange as the content.
  const parsed = parseZoneLine(
    "example.com. 3600 IN MX 10 inbound.example.net.",
  );
  assert.equal(parsed.priority, 10);
  assert.equal(parsed.content, "inbound.example.net.");

  // RFC 7505: "0 ." is the null MX, a valid record meaning "accepts no mail".
  const nullMx = parseZoneLine("example.com. 3600 IN MX 0 .");
  assert.equal(nullMx.priority, 0);
  assert.equal(nullMx.content, ".");

  const validations = [
    {
      input: { content: "inbound.example.net.", priority: 10 },
      ok: true,
    },
    // RFC 1035 §3.3.9 requires the preference; it is not optional.
    { input: { content: "inbound.example.net." }, ok: false },
    // The exchange is a single domain name, so embedded whitespace (which is
    // what a preference left in the content field looks like) is rejected.
    { input: { content: "10 inbound.example.net.", priority: 10 }, ok: false },
    { input: { content: "", priority: 10 }, ok: false },
  ] as const;
  for (const entry of validations) {
    assert.equal(
      validate({ type: "MX", name: "example.com", ...entry.input }).ok,
      entry.ok,
      JSON.stringify(entry.input),
    );
  }

  // The exchange is a domain name and is rewritten on a cross-zone copy.
  assert.equal(
    copiedContent({
      type: "MX",
      content: `inbound.${SOURCE_ZONE}.`,
      priority: 10,
    }),
    `inbound.${TARGET_ZONE}.`,
  );
});

test("TLSA RDATA is usage, selector, matching type, association data (RFC 6698 §2.1)", () => {
  const parsed = parseTLSA("3 1 1 0123456789abcdef");
  assert.deepEqual(parsed, {
    usage: 3,
    selector: 1,
    matchingType: 1,
    data: "0123456789abcdef",
  });
  assert.equal(
    composeTLSA(3, 1, 1, "0123456789abcdef"),
    "3 1 1 0123456789abcdef",
  );

  // RFC 6698 §2.1.1-2.1.3: usage 0-3, selector 0-1, matching type 0-2. The
  // registered combinations all parse with their fields in position.
  const combinations = [
    { content: "0 0 0 aabb", usage: 0, selector: 0, matchingType: 0 },
    { content: "1 0 1 aabb", usage: 1, selector: 0, matchingType: 1 },
    { content: "2 1 2 aabb", usage: 2, selector: 1, matchingType: 2 },
    { content: "3 1 1 aabb", usage: 3, selector: 1, matchingType: 1 }, // DANE-EE
  ] as const;
  for (const entry of combinations) {
    const fields = parseTLSA(entry.content);
    assert.equal(fields.usage, entry.usage, entry.content);
    assert.equal(fields.selector, entry.selector, entry.content);
    assert.equal(fields.matchingType, entry.matchingType, entry.content);
    assert.equal(fields.data, "aabb", entry.content);
    assert.equal(
      validate({
        type: "TLSA",
        name: "_443._tcp.example.com",
        content: entry.content,
      }).ok,
      true,
      entry.content,
    );
  }

  // Three fields is not a TLSA record.
  assert.equal(parseTLSA("3 1 1").data, "3 1 1");
  assert.equal(
    validate({ type: "TLSA", name: "_443._tcp.example.com", content: "3 1 1" })
      .ok,
    false,
  );

  // The association data is opaque hex and must survive a copy byte-for-byte.
  assert.equal(
    copiedContent({ type: "TLSA", content: "3 1 1 0123456789abcdef" }),
    "3 1 1 0123456789abcdef",
  );
});

test("SSHFP RDATA is algorithm, fingerprint type, fingerprint (RFC 4255 §3.1)", () => {
  const parsed = parseSSHFP("4 2 0123456789abcdef");
  assert.deepEqual(parsed, {
    algorithm: 4,
    fptype: 2,
    fingerprint: "0123456789abcdef",
  });
  assert.equal(composeSSHFP(4, 2, "0123456789abcdef"), "4 2 0123456789abcdef");

  // RFC 4255 §3.1.1-3.1.2 plus the IANA registry: algorithm 1=RSA, 2=DSA,
  // 3=ECDSA, 4=Ed25519; fingerprint type 1=SHA-1, 2=SHA-256.
  for (const algorithm of [1, 2, 3, 4]) {
    for (const fptype of [1, 2]) {
      const content = `${algorithm} ${fptype} 0123abcd`;
      const fields = parseSSHFP(content);
      assert.equal(fields.algorithm, algorithm, content);
      assert.equal(fields.fptype, fptype, content);
      assert.equal(
        validate({ type: "SSHFP", name: "example.com", content }).ok,
        true,
        content,
      );
    }
  }

  // The fingerprint is hex; a non-hex fingerprint is rejected by validation.
  assert.equal(
    validate({ type: "SSHFP", name: "example.com", content: "4 2 nothex!" }).ok,
    false,
  );
  assert.equal(parseSSHFP("4 2").fingerprint, "4 2");

  assert.equal(
    copiedContent({ type: "SSHFP", content: "4 2 0123456789abcdef" }),
    "4 2 0123456789abcdef",
  );
});

test("NAPTR RDATA is order, preference, flags, service, regexp, replacement (RFC 3403 §4.1)", () => {
  // RFC 3403 §4.1: flags, service and regexp are <character-string>s; the
  // replacement is a <domain-name> and is therefore NOT quoted.
  const parsed = parseNAPTR('100 10 "S" "SIP+D2U" "" _sip._udp.example.com.');
  assert.deepEqual(parsed, {
    order: 100,
    preference: 10,
    flags: "S",
    service: "SIP+D2U",
    regexp: "",
    replacement: "_sip._udp.example.com.",
  });

  // A "u" flag record carries a regexp and a "." replacement (RFC 3403 §4.1:
  // regexp and replacement are mutually exclusive).
  const withRegexp = parseNAPTR(
    '100 50 "u" "E2U+sip" "!^.*$!sip:info@example.com!" .',
  );
  assert.equal(withRegexp.flags, "u");
  assert.equal(withRegexp.service, "E2U+sip");
  assert.equal(withRegexp.regexp, "!^.*$!sip:info@example.com!");
  assert.equal(withRegexp.replacement, ".");

  // An empty character-string field must still occupy its position, otherwise
  // the record collapses to five fields and stops being a NAPTR.
  assert.equal(
    composeNAPTR(100, 10, "S", "SIP+D2U", "", "_sip._udp.example.com."),
    '100 10 S SIP+D2U "" _sip._udp.example.com.',
  );
  assert.deepEqual(
    parseNAPTR(
      composeNAPTR(100, 10, "S", "SIP+D2U", "", "_sip._udp.example.com."),
    ),
    parsed,
  );

  // Fewer than six fields is not a NAPTR record.
  assert.deepEqual(parseNAPTR('100 10 "S" "SIP+D2U" ""'), {
    order: undefined,
    preference: undefined,
    flags: "",
    service: "",
    regexp: "",
    replacement: "",
  });
  assert.equal(
    validate({
      type: "NAPTR",
      name: "example.com",
      content: '100 10 "S" "SIP+D2U" ""',
    }).ok,
    false,
  );

  // Only the replacement is a domain name, so only it is rewritten on copy —
  // the regexp, which may itself contain a hostname, must not be touched.
  assert.equal(
    copiedContent({
      type: "NAPTR",
      content: `100 10 "S" "SIP+D2U" "" _sip._udp.${SOURCE_ZONE}.`,
    }),
    `100 10 "S" "SIP+D2U" "" _sip._udp.${TARGET_ZONE}.`,
  );
  assert.equal(
    copiedContent({
      type: "NAPTR",
      content: `100 50 "u" "E2U+sip" "!^.*$!sip:info@${SOURCE_ZONE}!" .`,
    }),
    `100 50 "u" "E2U+sip" "!^.*$!sip:info@${SOURCE_ZONE}!" .`,
  );
});

test("CAA RDATA is flags, tag, value with the issuer left alone on copy (RFC 8659)", () => {
  // RFC 8659 §4.1: flags is an unsigned 8-bit field where bit 0 (value 128) is
  // "issuer critical"; §4.2 defines the issue/issuewild/iodef tags.
  const cases = [
    { content: '0 issue "ca.example.net"', flags: "0", tag: "issue" },
    { content: '128 issue "ca.example.net"', flags: "128", tag: "issue" },
    { content: '0 issuewild ";"', flags: "0", tag: "issuewild" },
    {
      content: '0 iodef "mailto:security@example.com"',
      flags: "0",
      tag: "iodef",
    },
  ] as const;

  for (const entry of cases) {
    const parsed = parseZoneLine(`example.com. 3600 IN CAA ${entry.content}`);
    assert.equal(parsed.type, "CAA", entry.content);
    assert.equal(parsed.content, entry.content, entry.content);
    const [flags, tag] = entry.content.split(" ");
    assert.equal(flags, entry.flags);
    assert.equal(tag, entry.tag);
  }

  // The issuer name in a CAA value identifies a certification authority, not a
  // record in the zone, so a cross-zone copy must leave it exactly as it was.
  assert.equal(
    copiedContent({ type: "CAA", content: `0 issue "ca.${SOURCE_ZONE}"` }),
    `0 issue "ca.${SOURCE_ZONE}"`,
  );
});

test("SVCB and HTTPS RDATA is priority, target, then key=value params (RFC 9460 §2.1)", () => {
  // RFC 9460 §2.4.1: priority 0 is AliasMode; a non-zero priority is
  // ServiceMode. §2.5: "." as the target means "the owner name itself".
  const cases = [
    { type: "SVCB", content: "0 svc.example.net." }, // AliasMode
    { type: "HTTPS", content: "1 ." }, // ServiceMode, self target
    { type: "HTTPS", content: '1 . alpn="h2,h3" ipv4hint=192.0.2.1' },
    {
      type: "HTTPS",
      content: "16 svc.example.net. alpn=h2 port=8443 ipv6hint=2001:db8::1",
    },
    { type: "SVCB", content: "1 svc.example.net. no-default-alpn" }, // valueless key
  ] as const;

  for (const entry of cases) {
    const parsed = parseZoneLine(
      `example.com. 3600 IN ${entry.type} ${entry.content}`,
    );
    assert.equal(parsed.type, entry.type, entry.content);
    // The whole RDATA survives verbatim: quoted param values keep their commas
    // and their quotes, which is what an ALPN list depends on.
    assert.equal(parsed.content, entry.content, entry.content);
    assert.match(parsed.content ?? "", /^\d{1,5}\s/u, entry.content);
  }

  // The TargetName is a domain name and is rewritten on a cross-zone copy, in
  // both AliasMode and ServiceMode; the SvcParams are not.
  assert.equal(
    copiedContent({ type: "SVCB", content: `0 svc.${SOURCE_ZONE}.` }),
    `0 svc.${TARGET_ZONE}.`,
  );
  assert.equal(
    copiedContent({
      type: "HTTPS",
      content: `1 svc.${SOURCE_ZONE}. alpn="h2,h3" ipv4hint=192.0.2.1`,
    }),
    `1 svc.${TARGET_ZONE}. alpn="h2,h3" ipv4hint=192.0.2.1`,
  );
});

test("LOC RDATA keeps its RFC 1876 §3 field order and units through import and copy", () => {
  // RFC 1876 §3: d1 m1 s1 {"N"|"S"} d2 m2 s2 {"E"|"W"} alt["m"] [siz["m"]
  // [hp["m"] [vp["m"]]]]. Every field is positional and the trailing three are
  // optional, so nothing may be reordered or dropped.
  const cases = [
    "42 21 54.000 N 71 06 18.000 W -24m 30m",
    "42 21 54.000 N 71 06 18.000 W -24m 30m 10m 2m",
    "52 14 05.000 N 00 08 50.000 E 10.00m 0.00m 10000m 10m",
    "42 21 43.952 N 71 5 6.344 W -24m 1m 200m",
  ];

  for (const content of cases) {
    const parsed = parseZoneLine(`example.com. 3600 IN LOC ${content}`);
    assert.equal(parsed.type, "LOC", content);
    assert.equal(parsed.content, content, content);
    // Hemispheres stay in fields 4 and 8.
    const fields = content.split(/\s+/u);
    assert.match(fields[3], /^[NS]$/u, content);
    assert.match(fields[7], /^[EW]$/u, content);
    // Coordinates are not zone references: a copy must not touch them.
    assert.equal(copiedContent({ type: "LOC", content }), content, content);
  }
});

test("DS and DNSKEY RDATA survive import and copy byte-for-byte (RFC 4034)", () => {
  // RFC 4034 §5.1: DS is key tag, algorithm, digest type, digest.
  // RFC 4034 §2.1: DNSKEY is flags, protocol, algorithm, public key.
  const cases = [
    {
      type: "DS",
      content: "12345 8 2 49FD46E6C4B45C55D4AC69CBD3CD34AC1AFE51DE1AD",
      // key tag, algorithm 8 = RSASHA256, digest type 2 = SHA-256
      leading: [12345, 8, 2],
    },
    {
      type: "DS",
      content: "60485 5 1 2BB183AF5F22588179A53B0A98631FAD1A292118",
      leading: [60485, 5, 1],
    },
    {
      type: "DNSKEY",
      // flags 257 = zone key + secure entry point; protocol is always 3
      content: "257 3 8 AwEAAaHIwpx3w4VHKi6i1LHnTaWeHCL154Jug0Ykv",
      leading: [257, 3, 8],
    },
    {
      type: "DNSKEY",
      content: "256 3 13 oJB1W6WNstHEmgmZ7Ttq9WPgTOc0YQPDbPeXzP",
      leading: [256, 3, 13],
    },
  ] as const;

  for (const entry of cases) {
    const parsed = parseZoneLine(
      `example.com. 3600 IN ${entry.type} ${entry.content}`,
    );
    assert.equal(parsed.type, entry.type, entry.content);
    assert.equal(parsed.content, entry.content, entry.content);

    const numeric = (parsed.content ?? "")
      .split(/\s+/u)
      .slice(0, 3)
      .map(Number);
    assert.deepEqual(numeric, [...entry.leading], entry.content);

    // Key material and digests are opaque: rewriting one would break the chain
    // of trust silently, so a cross-zone copy must not alter them.
    assert.equal(
      copiedContent({ type: entry.type, content: entry.content }),
      entry.content,
      entry.content,
    );
  }
});

test("address and hostname RDATA is validated against the documentation ranges", () => {
  // RFC 5737 (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) and RFC 3849
  // (2001:db8::/32) are the reserved documentation ranges; they must validate
  // as ordinary addresses.
  const cases = [
    { type: "A", content: "192.0.2.1", ok: true },
    { type: "A", content: "198.51.100.255", ok: true },
    { type: "A", content: "203.0.113.7", ok: true },
    { type: "A", content: "2001:db8::1", ok: false }, // v6 in an A record
    { type: "A", content: "192.0.2.256", ok: false },
    { type: "AAAA", content: "2001:db8::1", ok: true },
    { type: "AAAA", content: "2001:db8:0:0:0:0:0:1", ok: true },
    { type: "AAAA", content: "192.0.2.1", ok: false }, // v4 in an AAAA record
    { type: "CNAME", content: "example.com.", ok: true },
    { type: "CNAME", content: "www.example.com", ok: true },
    { type: "CNAME", content: "not a hostname", ok: false },
    { type: "NS", content: "ns1.example.net.", ok: true },
    { type: "PTR", content: "host.example.com.", ok: true },
  ] as const;

  for (const entry of cases) {
    assert.equal(
      validate({
        type: entry.type,
        name: "example.com",
        content: entry.content,
      }).ok,
      entry.ok,
      `${entry.type} ${entry.content}`,
    );
  }
});
