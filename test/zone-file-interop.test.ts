/**
 * Interoperability with the zone exports users actually migrate from.
 *
 * Each fixture is a realistic fragment of another system's output — an Amazon
 * Route 53 BIND-style export, a Cloudflare "Export DNS records" file, and a
 * `dig` transcript. Every test asserts both what parses *and* what does not, so
 * the import boundary is documented here rather than discovered in production.
 *
 * All domains are RFC 2606 reserved names and all addresses are RFC 5737 /
 * RFC 3849 documentation addresses; no fixture references a real host.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { unquoteCharacterString } from "../src/lib/dns/character-string";
import { parseBINDZone, parseCSVRecords } from "../src/lib/dns/dns-parsers";
import { normalizeRecordListCharacterStrings } from "../src/lib/dns/record-normalize";

/** `type name` pairs, the shape used to assert what a fixture yielded. */
function summarize(records: ReturnType<typeof parseBINDZone>) {
  return records.map((r) => `${r.type} ${r.name}`);
}

/** The one record of `type` a fixture is expected to contain. */
function only(records: ReturnType<typeof parseBINDZone>, type: string) {
  const matches = records.filter((r) => r.type === type);
  assert.equal(matches.length, 1, `expected exactly one ${type} record`);
  return matches[0];
}

/**
 * Amazon Route 53 "Export zone file", which is BIND master-file syntax with
 * tab separators, fully qualified owner names, an explicit class, and a SOA
 * written on a single line rather than in parentheses.
 */
const ROUTE53_EXPORT = [
  "example.com.\t172800\tIN\tNS\tns-2048.awsdns-64.example.",
  "example.com.\t172800\tIN\tNS\tns-0.awsdns-00.example.",
  "example.com.\t900\tIN\tSOA\tns-2048.awsdns-64.example. awsdns-hostmaster.example.net. 1 7200 900 1209600 86400",
  "example.com.\t300\tIN\tA\t192.0.2.1",
  "example.com.\t300\tIN\tAAAA\t2001:db8::1",
  "example.com.\t300\tIN\tMX\t10 inbound-smtp.example.net.",
  'example.com.\t300\tIN\tTXT\t"v=spf1 include:_spf.example.net -all"',
  '_dmarc.example.com.\t300\tIN\tTXT\t"v=DMARC1;p=quarantine;rua=mailto:reports@example.com;pct=100"',
  'selector1._domainkey.example.com.\t300\tIN\tTXT\t"v=DKIM1;k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA"',
  "www.example.com.\t300\tIN\tCNAME\texample.com.",
  "_sip._tcp.example.com.\t300\tIN\tSRV\t10 60 5060 sip.example.com.",
  'example.com.\t300\tIN\tCAA\t0 issue "ca.example.net"',
].join("\n");

/**
 * Cloudflare's "Export DNS records" output: a `;;` comment banner, `;;`
 * per-type section headings, and a TTL of `1` standing in for "Auto".
 */
const CLOUDFLARE_EXPORT = [
  ";;",
  ";; Domain:     example.com.",
  ";; Exported:   2026-08-07 00:00:00",
  ";;",
  ";; This file is intended for use for informational and archival",
  ";; purposes ONLY and MUST be edited before use on a production",
  ";; DNS server.",
  ";;",
  ";; In particular, you must",
  ";;   -- update the SOA record with the correct authoritative name server",
  ";;",
  "",
  ";; A Records",
  "example.com.\t1\tIN\tA\t192.0.2.1",
  "mail.example.com.\t300\tIN\tA\t192.0.2.20",
  "",
  ";; CNAME Records",
  "www.example.com.\t1\tIN\tCNAME\texample.com.",
  "",
  ";; MX Records",
  "example.com.\t1\tIN\tMX\t10 mail.example.com.",
  "",
  ";; TXT Records",
  'example.com.\t1\tIN\tTXT\t"v=spf1 ip4:192.0.2.20 ~all"',
  'default._domainkey.example.com.\t1\tIN\tTXT\t"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQ" "EFAAOCAQ8AMIIBCgKCAQEAtest=="',
  '_dmarc.example.com.\t1\tIN\tTXT\t"v=DMARC1; p=none; rua=mailto:dmarc@example.com"',
  "",
  ";; CAA Records",
  'example.com.\t1\tIN\tCAA\t0 issue "ca.example.net"',
].join("\n");

/** A full `dig example.com ANY` transcript, headers and footers included. */
const DIG_TRANSCRIPT = [
  "; <<>> DiG 9.18.1 <<>> example.com ANY",
  ";; global options: +cmd",
  ";; Got answer:",
  ";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 4242",
  ";; flags: qr rd ra; QUERY: 1, ANSWER: 4, AUTHORITY: 0, ADDITIONAL: 1",
  "",
  ";; OPT PSEUDOSECTION:",
  "; EDNS: version: 0, flags:; udp: 1232",
  ";; QUESTION SECTION:",
  ";example.com.\t\t\tIN\tANY",
  "",
  ";; ANSWER SECTION:",
  "example.com.\t\t300\tIN\tA\t192.0.2.1",
  "example.com.\t\t300\tIN\tMX\t10 inbound.example.net.",
  'example.com.\t\t300\tIN\tTXT\t"v=spf1 include:_spf.example.net -all"',
  "example.com.\t\t172800\tIN\tNS\tns1.example.net.",
  "",
  ";; Query time: 12 msec",
  ";; SERVER: 192.0.2.53#53(192.0.2.53) (UDP)",
  ";; WHEN: Fri Aug 07 00:00:00 UTC 2026",
  ";; MSG SIZE  rcvd: 213",
].join("\n");

test("a Route 53 BIND export imports every record with its RDATA intact", () => {
  const records = parseBINDZone(ROUTE53_EXPORT);

  assert.deepEqual(summarize(records), [
    "NS example.com.",
    "NS example.com.",
    "SOA example.com.",
    "A example.com.",
    "AAAA example.com.",
    "MX example.com.",
    "TXT example.com.",
    "TXT _dmarc.example.com.",
    "TXT selector1._domainkey.example.com.",
    "CNAME www.example.com.",
    "SRV _sip._tcp.example.com.",
    "CAA example.com.",
  ]);

  // Route 53 writes the SOA on one line, so it survives where the
  // parenthesised BIND form would not.
  assert.equal(
    only(records, "SOA").content,
    "ns-2048.awsdns-64.example. awsdns-hostmaster.example.net. 1 7200 900 1209600 86400",
  );

  // MX preference is split out of the RDATA; the exchange keeps its root dot.
  const mx = only(records, "MX");
  assert.equal(mx.priority, 10);
  assert.equal(mx.content, "inbound-smtp.example.net.");

  // Route 53 writes DMARC and DKIM with no space after the ";" separators —
  // the shape that a quote-blind comment stripper truncates hardest.
  const dmarc = records.find((r) => r.name === "_dmarc.example.com.");
  assert.equal(
    unquoteCharacterString(dmarc?.content ?? ""),
    "v=DMARC1;p=quarantine;rua=mailto:reports@example.com;pct=100",
  );
  const dkim = records.find((r) => r.name.startsWith("selector1."));
  assert.match(unquoteCharacterString(dkim?.content ?? ""), /p=MIIBIjANBgkq/u);

  assert.equal(only(records, "SRV").content, "10 60 5060 sip.example.com.");
  assert.equal(only(records, "CAA").content, '0 issue "ca.example.net"');
  assert.equal(only(records, "AAAA").content, "2001:db8::1");
  assert.deepEqual(
    records.map((r) => r.ttl),
    [172800, 172800, 900, 300, 300, 300, 300, 300, 300, 300, 300, 300],
  );
});

test("a Cloudflare export imports past its banner and section headings", () => {
  const records = parseBINDZone(CLOUDFLARE_EXPORT);

  assert.deepEqual(summarize(records), [
    "A example.com.",
    "A mail.example.com.",
    "CNAME www.example.com.",
    "MX example.com.",
    "TXT example.com.",
    "TXT default._domainkey.example.com.",
    "TXT _dmarc.example.com.",
    "CAA example.com.",
  ]);

  // Cloudflare writes TTL 1 for "Auto"; it is carried through as the number 1
  // rather than being mistaken for a record type.
  assert.equal(records.filter((r) => r.ttl === 1).length, 7);
  assert.equal(records.find((r) => r.name === "mail.example.com.")?.ttl, 300);

  // A DKIM key exported as two adjacent character-strings stays two strings and
  // concatenates to the single logical key.
  const dkim = records.find((r) => r.name.startsWith("default."));
  assert.equal(
    dkim?.content,
    '"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQ" "EFAAOCAQ8AMIIBCgKCAQEAtest=="',
  );
  assert.equal(
    unquoteCharacterString(dkim?.content ?? ""),
    "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest==",
  );

  // Round trip through save-time normalization: nothing is lost or re-split.
  const saved = normalizeRecordListCharacterStrings(records);
  assert.equal(
    unquoteCharacterString(
      saved.find((r) => r.name.startsWith("default."))?.content ?? "",
    ),
    "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest==",
  );
  assert.equal(
    saved.find((r) => r.name === "_dmarc.example.com.")?.content,
    '"v=DMARC1; p=none; rua=mailto:dmarc@example.com"',
  );
  // Non-character-string types are untouched by normalization.
  assert.equal(
    saved.find((r) => r.type === "MX")?.content,
    "mail.example.com.",
  );
  assert.equal(saved.find((r) => r.type === "A")?.content, "192.0.2.1");
});

test("a full dig transcript imports only its answer section", () => {
  const records = parseBINDZone(DIG_TRANSCRIPT);

  // Everything dig prints outside the answer section starts with ";" and is
  // therefore a comment: the header, the OPT pseudosection, the question
  // section, and the query-time/server/when/size footer.
  assert.deepEqual(summarize(records), [
    "A example.com.",
    "MX example.com.",
    "TXT example.com.",
    "NS example.com.",
  ]);

  assert.equal(only(records, "A").content, "192.0.2.1");
  assert.equal(only(records, "MX").priority, 10);
  assert.equal(only(records, "MX").content, "inbound.example.net.");
  assert.equal(
    unquoteCharacterString(only(records, "TXT").content ?? ""),
    "v=spf1 include:_spf.example.net -all",
  );

  // The `dig +noall +answer` form — the answer section on its own — parses to
  // exactly the same records.
  const answerOnly = DIG_TRANSCRIPT.split("\n")
    .filter((line) => line.length > 0 && !line.startsWith(";"))
    .join("\n");
  assert.deepEqual(parseBINDZone(answerOnly), records);
});

test("documents the export shapes that do NOT import", () => {
  // 1. A zone that relies on $ORIGIN: the directive is skipped and the relative
  //    owner names arrive unqualified, so the records land on the wrong names.
  //    Export with fully qualified names, or qualify them before importing.
  const relativeZone = [
    "$ORIGIN example.com.",
    "$TTL 3600",
    "@\tIN\tA\t192.0.2.1",
    "www\tIN\tCNAME\t@",
    "mail\tIN\tA\t192.0.2.20",
  ].join("\n");
  assert.deepEqual(summarize(parseBINDZone(relativeZone)), [
    "A @",
    "CNAME www",
    "A mail",
  ]);

  // 2. A BIND-formatted SOA in parentheses: the continuation lines are dropped
  //    and the record keeps a dangling "(".
  const parenthesisedSoa = [
    "example.com.\t3600\tIN\tSOA\tns1.example.net. hostmaster.example.com. (",
    "\t\t\t2026080701\t; serial",
    "\t\t\t7200\t\t; refresh",
    "\t\t\t3600\t\t; retry",
    "\t\t\t1209600\t\t; expire",
    "\t\t\t3600 )\t\t; minimum",
  ].join("\n");
  assert.deepEqual(parseBINDZone(parenthesisedSoa), [
    {
      name: "example.com.",
      ttl: 3600,
      type: "SOA",
      content: "ns1.example.net. hostmaster.example.com. (",
    },
  ]);

  // 3. Repeated owner names elided as leading whitespace, which BIND, NSD and
  //    Knot all emit: the TTL is consumed as the owner name.
  const elidedOwners = [
    "example.com.\t300\tIN\tA\t192.0.2.1",
    "\t\t300\tIN\tA\t192.0.2.2",
  ].join("\n");
  // The second record's owner is the string "300" — the TTL field.
  assert.deepEqual(summarize(parseBINDZone(elidedOwners)), [
    "A example.com.",
    "A 300",
  ]);

  // 4. An export using BIND duration TTLs: the record imports but the TTL is
  //    replaced by the 300 second default.
  assert.equal(parseBINDZone("example.com. 1h IN A 192.0.2.1")[0].ttl, 300);

  // 5. Lower-case type mnemonics, which are legal in a zone file: the type is
  //    carried through in lower case and no longer matches RECORD_TYPES.
  assert.equal(parseBINDZone("example.com. 300 in a 192.0.2.1")[0].type, "a");

  // 6. A record written with neither TTL nor class, legal per RFC 1035 §5.1 but
  //    below the parser's four-field minimum.
  assert.deepEqual(parseBINDZone("example.com. A 192.0.2.1"), []);
});

test("a Cloudflare CSV export imports with its quoted values intact", () => {
  // The CSV path is the other half of the import workflow. RFC 4180 quoting has
  // to survive alongside the DNS semicolon and comma separators.
  const csv = [
    "Type,Name,Content,TTL,Priority,Proxied",
    "A,example.com,192.0.2.1,1,,true",
    "AAAA,example.com,2001:db8::1,1,,true",
    "CNAME,www.example.com,example.com,1,,true",
    "MX,example.com,mail.example.com,300,10,false",
    'TXT,example.com,"v=spf1 include:_spf.example.net ~all",300,,false',
    'TXT,_dmarc.example.com,"v=DMARC1; p=reject; rua=mailto:dmarc@example.com",300,,false',
    'CAA,example.com,"0 issue ""ca.example.net""",300,,false',
    "A,auto.example.com,192.0.2.2,auto,,false",
  ].join("\n");

  const records = parseCSVRecords(csv);
  assert.equal(records.length, 8);

  // A comma inside a quoted field does not split the row, and the DMARC
  // semicolons survive.
  assert.equal(
    records[5].content,
    "v=DMARC1; p=reject; rua=mailto:dmarc@example.com",
  );
  // RFC 4180 §2.7: a doubled quote inside a quoted field is one literal quote.
  assert.equal(records[6].content, '0 issue "ca.example.net"');

  assert.equal(records[3].priority, 10);
  assert.equal(records[0].proxied, true);
  assert.equal(records[3].proxied, false);
  assert.equal(records[0].ttl, 1);
  assert.equal(records[7].ttl, "auto");
});

test("records imported from every fixture normalize without losing content", () => {
  // Whatever the source, the logical payload of a character-string record must
  // be identical before and after the save-time normalization pass, and the
  // pass must be idempotent.
  for (const [label, fixture] of [
    ["route53", ROUTE53_EXPORT],
    ["cloudflare", CLOUDFLARE_EXPORT],
    ["dig", DIG_TRANSCRIPT],
  ] as const) {
    const imported = parseBINDZone(fixture);
    const saved = normalizeRecordListCharacterStrings(imported);
    const savedTwice = normalizeRecordListCharacterStrings(saved);

    assert.equal(saved.length, imported.length, label);
    for (const [index, record] of imported.entries()) {
      assert.equal(saved[index].name, record.name, label);
      assert.equal(saved[index].type, record.type, label);
      assert.equal(saved[index].ttl, record.ttl, label);
      assert.equal(
        unquoteCharacterString(saved[index].content ?? ""),
        unquoteCharacterString(record.content ?? ""),
        `${label}: ${record.name} ${record.type}`,
      );
      assert.equal(savedTwice[index].content, saved[index].content, label);
    }
  }
});
