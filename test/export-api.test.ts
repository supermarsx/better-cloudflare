import assert from "node:assert/strict";
import { test } from "node:test";

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
