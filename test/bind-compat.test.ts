/**
 * BIND zone file (master file) compatibility — RFC 1035 §5.
 *
 * `parseBINDZone` is documented as a *lightweight convenience parser* for
 * simplified zone lines of the form `<name> [ttl] [class] <type> <rdata>`. These
 * tests pin the syntax it genuinely implements against RFC 1035 §5.1, and pin
 * the boundary of what it deliberately does not implement so that the boundary
 * is documented here rather than discovered during a production import.
 *
 * Every domain is an RFC 2606 reserved name and every address is an RFC 5737 /
 * RFC 3849 documentation address.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { unquoteCharacterString } from "../src/lib/dns/character-string";
import { parseBINDZone } from "../src/lib/dns/dns-parsers";

/** Parse a snippet expected to yield exactly one record. */
function parseOne(line: string) {
  const records = parseBINDZone(line);
  assert.equal(records.length, 1, `expected one record from: ${line}`);
  return records[0];
}

/**
 * Re-emit a parsed record as a zone line in the canonical
 * `<name> <ttl> IN <type> <rdata>` form of RFC 1035 §5.1. MX splits its
 * preference into `priority`, so it has to be put back in front of the exchange.
 */
function toZoneLine(record: ReturnType<typeof parseOne>): string {
  const rdata =
    record.priority === undefined
      ? record.content
      : `${record.priority} ${record.content}`;
  return `${record.name} ${record.ttl} IN ${record.type} ${rdata}`;
}

test("owner names are preserved verbatim in every RFC 1035 §5.1 form", () => {
  // RFC 1035 §5.1: the owner field may be fully qualified (trailing dot),
  // relative to the current origin, or `@` for the origin itself. RFC 4592
  // adds the `*` wildcard label. None of these are rewritten on import.
  const owners = [
    "example.com.", // fully qualified
    "www.example.com.", // fully qualified subdomain
    "www", // relative to $ORIGIN
    "@", // origin shorthand (RFC 1035 §5.1)
    "*.example.com.", // wildcard (RFC 4592 §2)
    "_sip._tcp.example.com.", // underscore service labels (RFC 8552)
    "EXAMPLE.com.", // case is preserved, not folded (RFC 4343)
    "xn--bcher-kva.example.", // A-label (RFC 5890)
  ];

  for (const owner of owners) {
    assert.equal(
      parseOne(`${owner} 3600 IN A 192.0.2.1`).name,
      owner,
      `owner ${owner}`,
    );
  }
});

test("TTL and class are optional and may appear in either order", () => {
  // RFC 1035 §5.1: "<TTL> <class>" and "<class> <TTL>" are both permitted and
  // either may be omitted. The parser's documented default TTL is 300.
  const cases = [
    { line: "example.com. 3600 IN A 192.0.2.1", ttl: 3600 },
    { line: "example.com. IN 3600 A 192.0.2.1", ttl: 3600 },
    { line: "example.com. 3600 A 192.0.2.1", ttl: 3600 },
    { line: "example.com. IN A 192.0.2.1", ttl: 300 },
  ] as const;

  for (const entry of cases) {
    assert.deepEqual(
      parseOne(entry.line),
      {
        name: "example.com.",
        ttl: entry.ttl,
        type: "A",
        content: "192.0.2.1",
      },
      entry.line,
    );
  }
});

test("classes other than IN are accepted and dropped from the record", () => {
  // RFC 1035 §3.2.4 defines IN, CS, CH and HS. Cloudflare only serves IN, so a
  // non-IN class is consumed as a field but not carried on the record.
  for (const cls of ["IN", "in", "CH", "CS", "HS", "hs"]) {
    const record = parseOne(`example.com. 3600 ${cls} TXT "value"`);
    assert.equal(record.type, "TXT", cls);
    assert.equal(record.content, '"value"', cls);
    assert.equal(record.ttl, 3600, cls);
  }
});

test("comments are stripped wherever RFC 1035 §5.1 allows them", () => {
  // ";" begins a comment that runs to end of line — but only outside a quoted
  // <character-string>.
  const cases = [
    {
      line: "example.com. 3600 IN A 192.0.2.1 ; trailing comment",
      content: "192.0.2.1",
    },
    {
      line: "example.com. 3600 IN A 192.0.2.1;no space before comment",
      content: "192.0.2.1",
    },
    {
      line: 'example.com. 3600 IN TXT "quoted value" ; comment after a string',
      content: '"quoted value"',
    },
    {
      line: 'example.com. 3600 IN TXT "one" "two" ; comment after two strings',
      content: '"one" "two"',
    },
  ] as const;

  for (const entry of cases) {
    assert.equal(parseOne(entry.line).content, entry.content, entry.line);
  }

  // Whole-line and indented comments, plus blank lines, contribute no records.
  assert.deepEqual(
    parseBINDZone(
      [
        "; a whole-line comment",
        ";; a doubled comment marker, as emitted by dig and Cloudflare",
        "",
        "   ",
        "\t; an indented comment",
        "example.com. 3600 IN A 192.0.2.1",
      ].join("\n"),
    ),
    [{ name: "example.com.", ttl: 3600, type: "A", content: "192.0.2.1" }],
  );
});

test("a semicolon inside a quoted character-string is data, not a comment", () => {
  // RFC 1035 §5.1 — ";" only starts a comment outside a quoted string. This is
  // the exact rule that, when broken, silently truncates DMARC policies and
  // DKIM public keys at their first tag separator.
  const cases = [
    {
      name: "DMARC policy (RFC 7489 §6.4)",
      value: "v=DMARC1; p=reject; sp=quarantine; rua=mailto:dmarc@example.com",
    },
    {
      name: "DKIM key record (RFC 6376 §3.6.1)",
      value: `v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8${"A".repeat(
        64,
      )}==`,
    },
    {
      name: "SPF explanation with a macro (RFC 7208 §6.2)",
      value: "See https://example.com/spf; contact postmaster@example.com",
    },
    {
      name: "a value that is nothing but separators",
      value: ";;;",
    },
  ] as const;

  for (const entry of cases) {
    const record = parseOne(`_x.example.com. 3600 IN TXT "${entry.value}"`);
    assert.equal(record.content, `"${entry.value}"`, entry.name);
    assert.equal(
      unquoteCharacterString(record.content),
      entry.value,
      entry.name,
    );
  }

  // A genuine comment after such a value is still removed.
  const withComment = parseOne(
    '_dmarc.example.com. 3600 IN TXT "v=DMARC1; p=reject" ; drop me',
  );
  assert.equal(withComment.content, '"v=DMARC1; p=reject"');

  // The CAA value field is a character-string too (RFC 8659 §4.2).
  assert.equal(
    parseOne(
      'example.com. 3600 IN CAA 0 iodef "mailto:security@example.com; urgent"',
    ).content,
    '0 iodef "mailto:security@example.com; urgent"',
  );
});

test("backslash escapes do not terminate a string or start a comment", () => {
  // RFC 1035 §5.1: "\X" is the literal character X, so an escaped quote stays
  // inside the string and an escaped semicolon is ordinary data.
  const escapedQuote = parseOne(
    'example.com. 3600 IN TXT "say \\"hello\\"; and stay quoted"',
  );
  assert.equal(escapedQuote.content, '"say \\"hello\\"; and stay quoted"');
  assert.equal(
    unquoteCharacterString(escapedQuote.content),
    'say "hello"; and stay quoted',
  );

  // An escaped semicolon in *bare* RDATA is data; the escape is left in the
  // presentation form, which is where it belongs.
  const escapedSemicolon = parseOne(
    String.raw`example.com. 3600 IN TXT bare\;value stays whole`,
  );
  assert.equal(escapedSemicolon.content, String.raw`bare\;value stays whole`);

  // A trailing backslash must not run the scanner past the end of the line.
  assert.equal(
    parseOne(String.raw`example.com. 3600 IN TXT "ends with a backslash \\"`)
      .content,
    String.raw`"ends with a backslash \\"`,
  );
});

test("adjacent quoted character-strings stay in one record", () => {
  // RFC 1035 §3.3.14: TXT RDATA is one or more <character-string>s; a resolver
  // concatenates them with no separator.
  const record = parseOne(
    'example.com. 3600 IN TXT "v=DKIM1; k=rsa; " "p=MIIBIjANBgkq" "hkiG9w0=="',
  );

  assert.equal(
    record.content,
    '"v=DKIM1; k=rsa; " "p=MIIBIjANBgkq" "hkiG9w0=="',
  );
  assert.equal(
    unquoteCharacterString(record.content),
    "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0==",
  );

  // Whitespace *inside* a quoted string is significant and preserved exactly.
  assert.equal(
    parseOne('example.com. 3600 IN TXT "two  spaces  kept"').content,
    '"two  spaces  kept"',
  );
});

test("a parsed record re-emits to a zone line that parses identically", () => {
  // Round trip: zone line -> record -> canonical zone line -> record.
  const lines = [
    "example.com. 3600 IN A 192.0.2.1",
    "example.com. 3600 IN AAAA 2001:db8::1",
    "www.example.com. 300 IN CNAME example.com.",
    "example.com. 3600 IN NS ns1.example.net.",
    "example.com. 3600 IN MX 10 inbound.example.net.",
    "_sip._tcp.example.com. 3600 IN SRV 10 60 5060 sip.example.com.",
    'example.com. 3600 IN TXT "v=spf1 include:_spf.example.net -all"',
    '_dmarc.example.com. 3600 IN TXT "v=DMARC1; p=reject; rua=mailto:d@example.com"',
    'example.com. 3600 IN CAA 0 issue "ca.example.net"',
    "example.com. 3600 IN DS 12345 8 2 49FD46E6C4B45C55D4AC69CBD3CD34AC1AFE51DE",
    "example.com. 3600 IN LOC 42 21 54.000 N 71 06 18.000 W -24m 30m",
    "_443._tcp.example.com. 3600 IN TLSA 3 1 1 0123456789abcdef",
    "example.com. 3600 IN SSHFP 4 2 0123456789abcdef",
    'example.com. 3600 IN NAPTR 100 10 "S" "SIP+D2U" "" _sip._udp.example.com.',
    'example.com. 3600 IN HTTPS 1 . alpn="h2,h3" ipv4hint=192.0.2.1',
  ];

  for (const line of lines) {
    const first = parseOne(line);
    const reEmitted = toZoneLine(first);
    const second = parseOne(reEmitted);
    assert.deepEqual(second, first, line);
    // Canonical re-emission is itself stable.
    assert.equal(toZoneLine(second), reEmitted, line);
  }
});

test("documents that $ directives are skipped rather than interpreted", () => {
  // The parser's contract: "$ directives ... are not interpreted". A directive
  // short enough to fall under the four-field minimum is simply dropped, which
  // is the graceful outcome — but the origin and default TTL it carried are
  // then lost, so relative owner names arrive unqualified.
  for (const directive of [
    "$ORIGIN example.com.",
    "$TTL 3600",
    "$INCLUDE sub.example.com.zone",
    "$INCLUDE sub.zone example.com.",
  ]) {
    assert.deepEqual(parseBINDZone(directive), [], directive);
  }

  // GAP: `$GENERATE` (a BIND extension, not RFC 1035) has enough fields to look
  // like a record and is mis-parsed into one instead of being skipped.
  assert.deepEqual(parseBINDZone("$GENERATE 1-10 host$ A 192.0.2.1"), [
    {
      name: "$GENERATE",
      ttl: 300,
      type: "1-10",
      content: "host$ A 192.0.2.1",
    },
  ]);

  // A zone that relies on $ORIGIN keeps its owner names relative: `@` and `www`
  // are NOT expanded to example.com., and the $TTL default is not applied.
  assert.deepEqual(
    parseBINDZone(
      [
        "$ORIGIN example.com.",
        "$TTL 3600",
        "@\tIN\tA\t192.0.2.1",
        "www\tIN\tCNAME\t@",
      ].join("\n"),
    ),
    [
      { name: "@", ttl: 300, type: "A", content: "192.0.2.1" },
      { name: "www", ttl: 300, type: "CNAME", content: "@" },
    ],
  );
});

test("documents that parenthesised multi-line RDATA is not joined", () => {
  // RFC 1035 §5.1 allows RDATA to span lines inside parentheses; SOA is almost
  // always written that way. The parser keeps the opening paren as content and
  // drops the continuation lines (each has fewer than four fields).
  const records = parseBINDZone(
    [
      "example.com. 3600 IN SOA ns1.example.net. hostmaster.example.com. (",
      "    2026080701 ; serial",
      "    7200       ; refresh",
      "    3600       ; retry",
      "    1209600    ; expire",
      "    3600 )     ; minimum",
    ].join("\n"),
  );

  assert.deepEqual(records, [
    {
      name: "example.com.",
      ttl: 3600,
      type: "SOA",
      content: "ns1.example.net. hostmaster.example.com. (",
    },
  ]);

  // The single-line SOA form that Route 53 and dig emit parses correctly.
  assert.equal(
    parseOne(
      "example.com. 900 IN SOA ns1.example.net. hostmaster.example.com. 2026080701 7200 3600 1209600 3600",
    ).content,
    "ns1.example.net. hostmaster.example.com. 2026080701 7200 3600 1209600 3600",
  );
});

test("documents that a blank owner does not inherit the previous owner", () => {
  // RFC 1035 §5.1: "if a line begins with a blank, then the owner is assumed to
  // be the same as that of the previous RR". The parser does not implement
  // inheritance, and the failure is not graceful: the TTL field is consumed as
  // the owner name, producing a record whose owner is the string "3600".
  assert.deepEqual(
    parseBINDZone(
      ["example.com. 3600 IN A 192.0.2.1", "\t3600 IN A 192.0.2.2"].join("\n"),
    ),
    [
      { name: "example.com.", ttl: 3600, type: "A", content: "192.0.2.1" },
      { name: "3600", ttl: 300, type: "A", content: "192.0.2.2" },
    ],
  );
});

test("documents that a record with neither TTL nor class is dropped", () => {
  // RFC 1035 §5.1 permits "<name> <type> <rdata>" with both optional fields
  // omitted. The four-field minimum drops it instead of parsing it.
  assert.deepEqual(parseBINDZone("example.com. A 192.0.2.1"), []);
  assert.deepEqual(parseBINDZone("www.example.com. CNAME example.com."), []);

  // Two-field RDATA survives the minimum, so the same omission parses here.
  assert.deepEqual(parseBINDZone("example.com. MX 10 inbound.example.net."), [
    {
      name: "example.com.",
      ttl: 300,
      type: "MX",
      content: "inbound.example.net.",
      priority: 10,
    },
  ]);
});

test("documents that the record type is carried through verbatim, including case", () => {
  // RFC 1035 §5.1 type mnemonics are case-insensitive, and BIND, PowerDNS and
  // NSD all accept lower case. The parser does not fold the case, so a
  // lower-case export yields a `type` that no longer matches RECORD_TYPES.
  const record = parseOne("example.com. 3600 in a 192.0.2.1");
  assert.equal(record.type, "a");

  // The MX preference is still split out, because that check folds case itself.
  assert.deepEqual(
    parseOne("example.com. 3600 in mx 10 inbound.example.net."),
    {
      name: "example.com.",
      ttl: 3600,
      type: "mx",
      content: "inbound.example.net.",
      priority: 10,
    },
  );
});

test("documents that BIND duration suffixes fall back to the default TTL", () => {
  // BIND accepts `1h` / `2d` / `1w` TTLs. The parser recognises the shape well
  // enough not to mistake it for a type, but does not convert it, so the
  // configured TTL is silently replaced by the 300 second default.
  for (const ttl of ["1h", "1H", "2d", "1w", "30m", "60s"]) {
    assert.equal(parseOne(`example.com. ${ttl} IN A 192.0.2.1`).ttl, 300, ttl);
  }
});

// BUG (not in flight, no fix pending): `ttl = Number(field) || 300` treats a
// TTL of 0 as falsy and replaces it with 300. RFC 1035 §3.2.1 defines TTL as an
// unsigned 32-bit value and RFC 2181 §8 explicitly permits 0 to mean "do not
// cache". dig writes 0 for a record fetched at the end of its life, and
// `version.bind. 0 CH TXT` is the canonical CHAOS probe. Un-skip once fixed.
test(
  "a TTL of zero is preserved (RFC 2181 §8)",
  { skip: "parseBINDZone replaces a zero TTL with the 300 second default" },
  () => {
    assert.equal(parseOne("example.com. 0 IN A 192.0.2.1").ttl, 0);
  },
);
