import assert from "node:assert/strict";
import { test } from "node:test";

import { unquoteCharacterString } from "../src/lib/dns/character-string";
import { parseBINDZone, parseCSVRecords } from "../src/lib/dns/dns-parsers";
import { normalizeRecordCharacterStrings } from "../src/lib/dns/record-normalize";

const DMARC_VALUE = "v=DMARC1; p=reject; rua=mailto:dmarc@example.com";
const DKIM_VALUE = `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA${"Ab3Zx".repeat(
  40,
)}==`;

/** The single record a one-line zone snippet must produce. */
function parseOne(line: string) {
  const records = parseBINDZone(line);
  assert.equal(records.length, 1, line);
  return records[0];
}

test("BIND import keeps the semicolons inside a quoted DMARC value", () => {
  const record = parseOne(
    `_dmarc.example.com.\t3600\tIN\tTXT\t"${DMARC_VALUE}"`,
  );

  assert.equal(record.type, "TXT");
  assert.equal(record.name, "_dmarc.example.com.");
  assert.equal(record.ttl, 3600);
  assert.equal(record.content, `"${DMARC_VALUE}"`);
  // The policy and the reporting address are what a naive `;` split destroys.
  assert.ok(record.content?.includes("p=reject"));
  assert.ok(record.content?.includes("rua=mailto:dmarc@example.com"));
  assert.equal(unquoteCharacterString(record.content ?? ""), DMARC_VALUE);
});

test("BIND import keeps a DKIM public key whole despite its internal semicolons", () => {
  const record = parseOne(
    `default._domainkey.example.com. 3600 IN TXT "${DKIM_VALUE}"`,
  );

  assert.equal(record.type, "TXT");
  assert.equal(unquoteCharacterString(record.content ?? ""), DKIM_VALUE);
  assert.ok(record.content?.includes("k=rsa"));
  assert.ok(record.content?.endsWith('=="'));
});

test("BIND import still strips a genuine trailing comment", () => {
  const record = parseOne(
    "example.com. 3600 IN A 192.0.2.1 ; this is a comment",
  );

  assert.deepEqual(record, {
    name: "example.com.",
    ttl: 3600,
    type: "A",
    content: "192.0.2.1",
  });
});

test("BIND import strips a comment that follows a quoted TXT value", () => {
  const record = parseOne(
    `_dmarc.example.com. 3600 IN TXT "${DMARC_VALUE}" ; keep the value, drop this`,
  );

  assert.equal(record.content, `"${DMARC_VALUE}"`);
});

test("BIND import treats an escaped quote as data, not as a string terminator", () => {
  const record = parseOne(
    'example.com. 3600 IN TXT "say \\"hello\\"; and stay quoted"',
  );

  assert.equal(record.content, '"say \\"hello\\"; and stay quoted"');
  assert.equal(
    unquoteCharacterString(record.content ?? ""),
    'say "hello"; and stay quoted',
  );
});

test("BIND import ignores comment-only and blank lines", () => {
  const records = parseBINDZone(
    [
      "; a whole-line comment",
      "",
      "   ",
      "\t; an indented comment",
      "example.com. 3600 IN A 192.0.2.1",
    ].join("\n"),
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].content, "192.0.2.1");
});

test("BIND import keeps adjacent quoted strings in a single TXT record", () => {
  const record = parseOne(
    'example.com. 3600 IN TXT "v=DKIM1; k=rsa; " "p=MIIBIjANBgkq"',
  );

  assert.equal(record.content, '"v=DKIM1; k=rsa; " "p=MIIBIjANBgkq"');
  assert.equal(
    unquoteCharacterString(record.content ?? ""),
    "v=DKIM1; k=rsa; p=MIIBIjANBgkq",
  );
});

test("BIND import preserves whitespace inside a quoted value", () => {
  const record = parseOne('example.com. 3600 IN TXT "two  spaces  kept"');

  assert.equal(record.content, '"two  spaces  kept"');
});

test("BIND import parses records written without an explicit TTL", () => {
  assert.deepEqual(parseOne("example.com. IN MX 10 mail.example.com."), {
    name: "example.com.",
    ttl: 300,
    type: "MX",
    content: "mail.example.com.",
    priority: 10,
  });

  assert.deepEqual(parseOne("example.com. IN A 192.0.2.1"), {
    name: "example.com.",
    ttl: 300,
    type: "A",
    content: "192.0.2.1",
  });

  assert.deepEqual(parseOne(`_dmarc.example.com. IN TXT "${DMARC_VALUE}"`), {
    name: "_dmarc.example.com.",
    ttl: 300,
    type: "TXT",
    content: `"${DMARC_VALUE}"`,
  });
});

test("BIND import accepts a TTL without a class and a class before the TTL", () => {
  assert.deepEqual(parseOne("example.com. 3600 A 192.0.2.1"), {
    name: "example.com.",
    ttl: 3600,
    type: "A",
    content: "192.0.2.1",
  });

  assert.deepEqual(parseOne("example.com. IN 3600 A 192.0.2.1"), {
    name: "example.com.",
    ttl: 3600,
    type: "A",
    content: "192.0.2.1",
  });
});

test("BIND import falls back to the default TTL for a duration suffix", () => {
  assert.deepEqual(parseOne("example.com. 1h IN A 192.0.2.1"), {
    name: "example.com.",
    ttl: 300,
    type: "A",
    content: "192.0.2.1",
  });
});

test("BIND import still skips lines with too few fields", () => {
  assert.deepEqual(parseBINDZone("garbage"), []);
  assert.deepEqual(parseBINDZone("$TTL 3600"), []);
  assert.deepEqual(parseBINDZone("example.com. 3600 IN"), []);
  assert.deepEqual(parseBINDZone(""), []);
});

test("BIND import leaves an MX line without a target as unparsed content", () => {
  // Genuinely malformed RDATA is passed through rather than guessed at.
  assert.deepEqual(parseOne("example.com. 3600 IN MX 10"), {
    name: "example.com.",
    ttl: 3600,
    type: "MX",
    content: "10",
  });
});

test("importing then normalizing a DMARC record preserves the whole value", () => {
  // Normalization repairs unmatched quotes, so a truncated import used to be
  // rewritten into a well-formed — but silently gutted — record.
  const [parsed] = parseBINDZone(
    `_dmarc.example.com. 3600 IN TXT "${DMARC_VALUE}"`,
  );
  const saved = normalizeRecordCharacterStrings(parsed);

  assert.equal(saved.content, `"${DMARC_VALUE}"`);
  assert.equal(unquoteCharacterString(saved.content ?? ""), DMARC_VALUE);
});

test("importing then normalizing a DKIM record preserves the public key", () => {
  const [parsed] = parseBINDZone(
    `default._domainkey.example.com. 3600 IN TXT "${DKIM_VALUE}"`,
  );
  const saved = normalizeRecordCharacterStrings(parsed);

  assert.equal(unquoteCharacterString(saved.content ?? ""), DKIM_VALUE);
});

test("CSV import keeps commas and semicolons inside a quoted value", () => {
  const records = parseCSVRecords(
    [
      "Type,Name,Content,TTL,Priority,Proxied",
      `TXT,_dmarc.example.com.,"${DMARC_VALUE}",3600,,false`,
    ].join("\n"),
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].content, DMARC_VALUE);
  assert.equal(records[0].ttl, 3600);
  assert.equal(records[0].proxied, false);
});
