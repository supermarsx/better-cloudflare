import assert from "node:assert/strict";
import { test } from "node:test";

import { unquoteCharacterString } from "../src/lib/dns/character-string";
import { parseBINDZone } from "../src/lib/dns/dns-parsers";
import {
  recordsToBIND,
  recordsToCSV,
  recordsToJSON,
} from "../src/lib/dns/export-api";
import type { DNSRecord } from "../src/types/dns";

const records = [
  {
    type: "TXT",
    name: "quoted.example.com",
    content: 'say "hello", then continue',
    ttl: 1,
    proxied: false,
  },
  {
    type: "MX",
    name: "example.com",
    content: "mail.example.com",
    ttl: 3600,
    priority: 10,
    proxied: true,
  },
] as DNSRecord[];

test("CSV export quotes every field and escapes embedded quotes", () => {
  assert.equal(
    recordsToCSV(records),
    [
      '"Type","Name","Content","TTL","Priority","Proxied"',
      '"TXT","quoted.example.com","say ""hello"", then continue","1","","false"',
      '"MX","example.com","mail.example.com","3600","10","true"',
    ].join("\n"),
  );
});

test("BIND export normalizes automatic TTL and includes record priority", () => {
  assert.equal(
    recordsToBIND(records),
    [
      'quoted.example.com.\t300\tIN\tTXT\t"say \\"hello\\", then continue"',
      "example.com.\t3600\tIN\tMX\t10 mail.example.com.",
    ].join("\n"),
  );
});

test("BIND export keeps TXT content in one safely escaped string", () => {
  const exported = recordsToBIND([
    {
      type: "TXT",
      name: "unsafe.example.com",
      content: 'backslash\\ quote"\tline\r\nnext; still text',
      ttl: "auto",
    } as DNSRecord,
  ]);

  assert.equal(
    exported,
    'unsafe.example.com.\t300\tIN\tTXT\t"backslash\\\\ quote\\"\\009line\\013\\010next; still text"',
  );
  assert.equal(exported.split("\n").length, 1);
  assert.doesNotMatch(exported, /\tTXT\t(?!")/);
});

test("BIND export safely represents known absolute DNS names and targets", () => {
  const namedRecords = [
    {
      type: "CNAME",
      name: "alias.example.com",
      content: "target.example.net",
      ttl: 300,
    },
    {
      type: "NS",
      name: "@",
      content: "ns1.example.com.",
      ttl: 300,
    },
    {
      type: "SRV",
      name: "_sip._tcp.example.com.",
      content: "0 5060 sip.example.net",
      ttl: 300,
      priority: 0,
    },
    {
      type: "HTTPS",
      name: "example.com",
      content: '1 . alpn="h2,h3"',
      ttl: 300,
    },
  ] as DNSRecord[];

  assert.equal(
    recordsToBIND(namedRecords),
    [
      "alias.example.com.\t300\tIN\tCNAME\ttarget.example.net.",
      "@\t300\tIN\tNS\tns1.example.com.",
      "_sip._tcp.example.com.\t300\tIN\tSRV\t0 0 5060 sip.example.net.",
      'example.com.\t300\tIN\tHTTPS\t1 . alpn="h2,h3"',
    ].join("\n"),
  );
});

/**
 * The character-string records a migration actually carries, each with the
 * logical value that must survive an export/import round trip untouched.
 */
const CHARACTER_STRING_RECORDS = [
  {
    label: "TXT",
    type: "TXT",
    name: "example.com",
    value: "hello world",
  },
  {
    label: "SPF",
    type: "SPF",
    name: "example.com",
    value: "v=spf1 include:_spf.example.net ~all",
  },
  {
    label: "SPF as TXT",
    type: "TXT",
    name: "example.com",
    value: "v=spf1 ip4:192.0.2.20 -all",
  },
  {
    label: "DMARC",
    type: "TXT",
    name: "_dmarc.example.com",
    value: "v=DMARC1; p=reject; rua=mailto:dmarc@example.com; pct=100",
  },
  {
    label: "DKIM",
    type: "TXT",
    name: "selector1._domainkey.example.com",
    value:
      "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest==",
  },
] as const;

/** Export one record, import the result, and return the single record back. */
function roundTrip(record: DNSRecord): Partial<DNSRecord> {
  const exported = recordsToBIND([record]);
  assert.equal(
    exported.split("\n").length,
    1,
    `a record must export as one line: ${JSON.stringify(exported)}`,
  );
  const imported = parseBINDZone(exported);
  assert.equal(imported.length, 1, `re-import of ${exported}`);
  return imported[0];
}

test("BIND export leaves already-quoted character-string content alone", () => {
  // The bug this pins: quoting quoted content again produced
  // TXT "\"v=DMARC1; p=reject\"", which reimports with a literal quote layer.
  assert.equal(
    recordsToBIND([
      {
        type: "TXT",
        name: "_dmarc.example.com",
        content: '"v=DMARC1; p=reject"',
        ttl: 300,
      } as DNSRecord,
    ]),
    '_dmarc.example.com.\t300\tIN\tTXT\t"v=DMARC1; p=reject"',
  );

  // A DKIM key already split into adjacent character-strings stays two strings
  // rather than becoming one escaped blob.
  assert.equal(
    recordsToBIND([
      {
        type: "TXT",
        name: "default._domainkey.example.com",
        content: '"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQ" "EFAAOCAQ8AMIIB"',
        ttl: 300,
      } as DNSRecord,
    ]),
    'default._domainkey.example.com.\t300\tIN\tTXT\t"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQ" "EFAAOCAQ8AMIIB"',
  );
});

test("quoted character-string content survives export then import byte for byte", () => {
  for (const { label, type, name, value } of CHARACTER_STRING_RECORDS) {
    const content = `"${value}"`;
    const record = { type, name, content, ttl: 300 } as DNSRecord;

    const imported = roundTrip(record);
    assert.equal(imported.content, content, label);
    assert.equal(imported.type, type, label);
    assert.equal(imported.name, `${name}.`, label);

    // No escaped-quote layer was introduced anywhere in the exported line.
    assert.doesNotMatch(recordsToBIND([record]), /\\"/u, label);

    // And the trip is a fixed point: exporting the imported record again and
    // reimporting yields the same bytes.
    assert.equal(
      roundTrip({ ...record, content: imported.content } as DNSRecord).content,
      content,
      label,
    );
  }
});

test("bare character-string content is quoted once and keeps its logical value", () => {
  for (const { label, type, name, value } of CHARACTER_STRING_RECORDS) {
    const record = { type, name, content: value, ttl: 300 } as DNSRecord;

    // Bare content must gain quotes — an unquoted ";" starts a zone comment —
    // but exactly one layer of them, and nothing else changes.
    const imported = roundTrip(record);
    assert.equal(imported.content, `"${value}"`, label);
    assert.equal(unquoteCharacterString(imported.content ?? ""), value, label);

    // The second trip changes nothing further.
    assert.equal(
      roundTrip({ ...record, content: imported.content } as DNSRecord).content,
      `"${value}"`,
      label,
    );
  }
});

test("damaged quoted content is repaired the way the importer reads it", () => {
  // An unbalanced quote is not emitted verbatim: it would produce a zone line
  // no parser agrees on. It is re-serialized from the value the import side
  // recovers, so the round trip converges instead of drifting.
  const imported = roundTrip({
    type: "TXT",
    name: "broken.example.com",
    content: '"v=spf1 -all',
    ttl: 300,
  } as DNSRecord);
  assert.equal(imported.content, '"v=spf1 -all"');
  assert.equal(
    roundTrip({
      type: "TXT",
      name: "broken.example.com",
      content: imported.content,
      ttl: 300,
    } as DNSRecord).content,
    '"v=spf1 -all"',
  );

  // A raw newline inside otherwise valid quoted content is escaped rather than
  // written out, so the record still occupies exactly one line. `roundTrip`
  // asserts the single line; the escaped form is what survives the import.
  assert.equal(
    roundTrip({
      type: "TXT",
      name: "multiline.example.com",
      content: '"first\nsecond"',
      ttl: 300,
    } as DNSRecord).content,
    '"first\\010second"',
  );
});

test("JSON export round-trips all record fields without mutation", () => {
  const before = structuredClone(records);
  const exported = recordsToJSON(records);

  assert.deepEqual(JSON.parse(exported), records);
  assert.deepEqual(records, before);
  assert.match(exported, /\n  \{/);
});

test("empty exports remain valid in every supported format", () => {
  assert.equal(
    recordsToCSV([]),
    '"Type","Name","Content","TTL","Priority","Proxied"\n',
  );
  assert.equal(recordsToBIND([]), "");
  assert.equal(recordsToJSON([]), "[]");
});
