/**
 * Format handling for the DNS CLI: every supported format survives a round trip
 * through the application's own exporter and parser, and `migrate` rewrites
 * hostnames correctly when records move between zones.
 *
 * All fixtures use RFC 2606 reserved domains and RFC 5737 / RFC 3849
 * documentation addresses. Nothing here touches the network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { DNSRecord } from "../src/types/dns";
import { unquoteCharacterString } from "../src/lib/dns/character-string";
import {
  inferFormat,
  parseRecords,
  RECORD_FORMATS,
  serializeRecords,
  type RecordFormat,
} from "../scripts/cli/records";
import { GOOD_ZONE, runHarness } from "./dns-cli-harness";

/** Records exercising a name, a hostname content, a priority and a TXT payload. */
const SEED: Partial<DNSRecord>[] = [
  { type: "A", name: "www.example.com", content: "192.0.2.1", ttl: 300 },
  { type: "AAAA", name: "ipv6.example.com", content: "2001:db8::1", ttl: 300 },
  {
    type: "CNAME",
    name: "alias.example.com",
    content: "www.example.com",
    ttl: 3600,
  },
  {
    type: "MX",
    name: "example.com",
    content: "mail.example.com",
    ttl: 3600,
    priority: 10,
  },
  {
    type: "TXT",
    name: "example.com",
    content: "v=spf1 include:_spf.example.com ~all",
    ttl: 300,
  },
];

/**
 * Compare records across a round trip.
 *
 * BIND presentation format is *canonical*, not byte-preserving: names and
 * hostname RDATA come back fully qualified with a root dot, and TXT content
 * comes back as a quoted `<character-string>`. Both are correct output, so the
 * comparison normalizes them through the same helpers the application uses
 * rather than demanding byte equality.
 */
function comparable(record: Partial<DNSRecord>): Record<string, unknown> {
  const bare = (value: string) =>
    value.endsWith(".") ? value.slice(0, -1) : value;
  const type = (record.type ?? "").toUpperCase();
  const content =
    type === "TXT" || type === "SPF"
      ? unquoteCharacterString(record.content)
      : bare(record.content ?? "");
  return {
    type,
    name: bare(record.name ?? ""),
    content,
    ttl: record.ttl,
    priority: record.priority,
  };
}

for (const format of RECORD_FORMATS) {
  test(`${format} round-trips through export and import`, () => {
    const serialized = serializeRecords(SEED, format);
    const parsed = parseRecords(serialized, format);

    assert.equal(parsed.length, SEED.length);
    assert.deepEqual(
      parsed.map((entry) => comparable(entry.record)),
      SEED.map(comparable),
    );
  });
}

test("csv round trip preserves an automatic TTL", () => {
  const seed: Partial<DNSRecord>[] = [
    { type: "A", name: "auto.example.com", content: "192.0.2.9", ttl: "auto" },
  ];
  const parsed = parseRecords(serializeRecords(seed, "csv"), "csv");
  assert.equal(parsed[0].record.ttl, "auto");
});

test("json export drops server-assigned identifiers", () => {
  const serialized = serializeRecords(
    [
      {
        id: "abc123",
        zone_id: "zone123",
        type: "A",
        name: "www.example.com",
        content: "192.0.2.1",
        ttl: 300,
      },
    ],
    "json",
  );
  const parsed = JSON.parse(serialized) as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(parsed[0]), ["type", "name", "content", "ttl"]);
});

test("format is inferred from the file extension", () => {
  const cases: Array<[string, RecordFormat | null]> = [
    ["/zones/example.json", "json"],
    ["/zones/example.csv", "csv"],
    ["/zones/example.zone", "bind"],
    ["/zones/example.db", "bind"],
    ["/zones/example.bind", "bind"],
    ["/zones/EXAMPLE.ZONE", "bind"],
    ["/zones/example.dat", null],
    ["/zones/example", null],
  ];
  for (const [filePath, expected] of cases) {
    assert.equal(inferFormat(filePath), expected, filePath);
  }
});

test("migrate converts between formats without contacting the network", async () => {
  const result = await runHarness(
    ["migrate", "/zones/good.zone", "--to", "json"],
    { files: { "/zones/good.zone": GOOD_ZONE } },
  );

  assert.equal(result.code, 0);
  assert.equal(result.factoryCalls, 0);
  const records = JSON.parse(result.stdout) as Partial<DNSRecord>[];
  assert.equal(records.length, 6);
  assert.equal(records[0].type, "A");
  assert.equal(records[0].content, "192.0.2.1");
});

test("migrate rewrites hostnames across zones, including inside RDATA", async () => {
  const result = await runHarness(
    [
      "migrate",
      "/zones/good.zone",
      "--to",
      "json",
      "--from-zone",
      "example.com",
      "--to-zone",
      "example.net",
    ],
    { files: { "/zones/good.zone": GOOD_ZONE } },
  );

  assert.equal(result.code, 0);
  const records = JSON.parse(result.stdout) as Partial<DNSRecord>[];
  const byType = new Map(records.map((record) => [record.type, record]));

  // The record name itself.
  assert.equal(byType.get("A")?.name, "example.net.");
  // Hostname-valued RDATA.
  assert.equal(byType.get("CNAME")?.content, "example.net.");
  assert.equal(byType.get("MX")?.content, "mail.example.net.");
  // Domains embedded in an SPF payload.
  const spf = records.find((record) => record.content?.includes("v=spf1"));
  assert.match(String(spf?.content), /include:_spf\.example\.net/u);
  // Domains embedded in a DMARC reporting address.
  const dmarc = records.find((record) => record.content?.includes("DMARC1"));
  assert.match(String(dmarc?.content), /rua=mailto:dmarc@example\.net/u);
  assert.equal(dmarc?.name, "_dmarc.example.net.");
});

test("migrate leaves records alone when no zone pair is given", async () => {
  const result = await runHarness(
    ["migrate", "/zones/good.zone", "--to", "json"],
    { files: { "/zones/good.zone": GOOD_ZONE } },
  );
  const records = JSON.parse(result.stdout) as Partial<DNSRecord>[];
  assert.ok(records.every((record) => !record.name?.includes("example.net")));
});

test("migrate writes to --out and requires both zone flags together", async () => {
  const written = await runHarness(
    [
      "migrate",
      "/zones/good.zone",
      "--to",
      "csv",
      "--out",
      "/zones/converted.csv",
    ],
    { files: { "/zones/good.zone": GOOD_ZONE } },
  );
  assert.equal(written.code, 0);
  assert.match(
    written.written.get("/zones/converted.csv") ?? "",
    /^"Type","Name","Content","TTL","Priority","Proxied"/u,
  );
  assert.equal(written.stdout, "");

  const halfZone = await runHarness(
    [
      "migrate",
      "/zones/good.zone",
      "--to",
      "csv",
      "--from-zone",
      "example.com",
    ],
    { files: { "/zones/good.zone": GOOD_ZONE } },
  );
  assert.equal(halfZone.code, 2);
  assert.match(halfZone.stderr, /must be given together/u);
});

test("migrate is a usage error without --to or with an unknown --to", async () => {
  const missing = await runHarness(["migrate", "/zones/good.zone"], {
    files: { "/zones/good.zone": GOOD_ZONE },
  });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--to is required/u);

  const unknown = await runHarness(
    ["migrate", "/zones/good.zone", "--to", "yaml"],
    { files: { "/zones/good.zone": GOOD_ZONE } },
  );
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown output format "yaml"/u);
});

test("a malformed JSON file fails as a usage error, not a crash", async () => {
  const result = await runHarness(["validate", "/zones/broken.json"], {
    files: { "/zones/broken.json": "{ not json" },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /not valid JSON/u);

  const wrongShape = await runHarness(["validate", "/zones/shape.json"], {
    files: { "/zones/shape.json": JSON.stringify({ nope: true }) },
  });
  assert.equal(wrongShape.code, 2);
  assert.match(wrongShape.stderr, /must be an array of records/u);
});
