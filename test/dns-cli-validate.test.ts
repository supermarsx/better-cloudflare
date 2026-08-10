/**
 * `dns validate` — the command that exists so a migration can be checked
 * before a live zone is touched. These tests cover a clean file, a file with
 * several distinct defects, the location reported for each defect in all three
 * formats, and the exit codes CI depends on.
 *
 * They also pin the behaviour of `src/lib/dns/validation.ts`'s SRV rule on the
 * three-field-plus-separate-priority shape Cloudflare commonly returns: the CLI
 * passes that content to the schema untouched and the schema accepts it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dnsRecordSchema } from "../src/lib/dns/validation";
import { parseRecords } from "../scripts/cli/records";
import { validateRecords } from "../scripts/cli/validate";
import { BROKEN_ZONE, GOOD_ZONE, runHarness } from "./dns-cli-harness";

const files = {
  "/zones/good.zone": GOOD_ZONE,
  "/zones/broken.zone": BROKEN_ZONE,
};

test("validate reports no problems for a clean zone file", async () => {
  const result = await runHarness(
    ["validate", "/zones/good.zone", "--zone", "example.com"],
    { files },
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /6 record\(s\), 0 error\(s\), 0 warning\(s\)/u);
  assert.doesNotMatch(result.stdout, /error {2}/u);
});

test("validate reports every distinct defect with its source line", async () => {
  const result = await runHarness(
    ["validate", "/zones/broken.zone", "--zone", "example.com"],
    { files },
  );

  assert.equal(result.code, 1);

  // Each defect is attributed to the line it is on. Line 1 is a comment, so
  // the first record is on line 2.
  const expected: Array<[string, RegExp]> = [
    ["line 2", /A record content must be a valid IPv4 address/u],
    ["line 3", /ttl 5 is outside Cloudflare's accepted range/u],
    ["line 4", /AAAA record content must be a valid IPv6 address/u],
    ["line 5", /SRV content must be/u],
    ["line 6", /CNAME may not share its name/u],
    ["line 8", /is not inside zone "example\.com"/u],
  ];
  for (const [location, message] of expected) {
    const block = result.stdout
      .split(/^ {2}(?=line |record\[)/mu)
      .find((section) => section.startsWith(location));
    assert.ok(block, `no report block for ${location}`);
    assert.match(block, message);
  }

  // A CNAME sharing its owner name is reported on both records, not just one.
  assert.equal(
    result.stdout.match(/CNAME may not share its name/gu)?.length,
    2,
  );
});

test("validate distinguishes errors from warnings and --strict fails on warnings", async () => {
  const warningOnly = {
    "/zones/warn.zone": "short.example.com. 5 IN A 192.0.2.2\n",
  };

  const lenient = await runHarness(["validate", "/zones/warn.zone"], {
    files: warningOnly,
  });
  assert.equal(lenient.code, 0);
  assert.match(lenient.stdout, /1 record\(s\), 0 error\(s\), 1 warning\(s\)/u);

  const strict = await runHarness(
    ["validate", "/zones/warn.zone", "--strict"],
    {
      files: warningOnly,
    },
  );
  assert.equal(strict.code, 1);
});

test("validate locates CSV defects by line and JSON defects by index", async () => {
  const csv = [
    "Type,Name,Content,TTL",
    "A,www.example.com,192.0.2.1,300",
    "A,broken.example.com,not-an-ip,300",
  ].join("\n");
  const csvResult = await runHarness(["validate", "/zones/zone.csv"], {
    files: { "/zones/zone.csv": `${csv}\n` },
  });
  assert.equal(csvResult.code, 1);
  assert.match(csvResult.stdout, /line 3 {2}A broken\.example\.com/u);

  const json = JSON.stringify([
    { type: "A", name: "www.example.com", content: "192.0.2.1", ttl: 300 },
    { type: "A", name: "broken.example.com", content: "not-an-ip", ttl: 300 },
  ]);
  const jsonResult = await runHarness(["validate", "/zones/zone.json"], {
    files: { "/zones/zone.json": json },
  });
  assert.equal(jsonResult.code, 1);
  assert.match(jsonResult.stdout, /record\[1\] {2}A broken\.example\.com/u);
});

test("validate rejects non-object JSON entries instead of throwing", async () => {
  const result = await runHarness(["validate", "/zones/zone.json"], {
    files: { "/zones/zone.json": JSON.stringify([42, "nope"]) },
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /entry is not a JSON object/u);
});

test("validate flags proxying on a record type that cannot be proxied", async () => {
  const result = await runHarness(["validate", "/zones/zone.json"], {
    files: {
      "/zones/zone.json": JSON.stringify([
        {
          type: "TXT",
          name: "example.com",
          content: '"hello"',
          ttl: 300,
          proxied: true,
        },
      ]),
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /TXT records cannot be proxied/u);
});

test("validate emits a machine-readable report with --json", async () => {
  const result = await runHarness(
    ["validate", "/zones/broken.zone", "--json", "--zone", "example.com"],
    { files },
  );

  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as {
    file: string;
    format: string;
    recordCount: number;
    errorCount: number;
    warningCount: number;
    reports: Array<{ line: number | null; issues: unknown[] }>;
  };
  assert.equal(report.format, "bind");
  assert.equal(report.recordCount, 7);
  assert.ok(report.errorCount > 0);
  assert.equal(report.warningCount, 1);
  assert.equal(report.reports.length, 7);
  assert.equal(report.reports[0].line, 2);
});

test("validate is a usage error for an unreadable file or unknown format", async () => {
  const missing = await runHarness(["validate", "/zones/absent.zone"], {
    files,
  });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Could not read/u);

  const badFormat = await runHarness(
    ["validate", "/zones/good.zone", "--format", "yaml"],
    { files },
  );
  assert.equal(badFormat.code, 2);
  assert.match(badFormat.stderr, /Unknown format "yaml"/u);

  const unknownExtension = await runHarness(
    ["validate", "/zones/records.dat"],
    {
      files: { "/zones/records.dat": "" },
    },
  );
  assert.equal(unknownExtension.code, 2);
  assert.match(unknownExtension.stderr, /Could not infer the format/u);
});

test("dnsRecordSchema accepts both SRV content shapes", () => {
  // Cloudflare commonly returns SRV content as "weight port target" with the
  // priority carried in its own field — the shape `src/lib/dns/record-copy.ts`
  // and `src/lib/dns/export-api.ts` both handle explicitly. The schema accepts
  // it, so the CLI hands the record over untouched.
  const cloudflareShape = {
    type: "SRV" as const,
    name: "_sip._tcp.example.com",
    content: "5 5060 sip.example.com",
    priority: 10,
  };
  assert.equal(dnsRecordSchema.safeParse(cloudflareShape).success, true);

  // The four-field presentation form is accepted with or without a priority.
  assert.equal(
    dnsRecordSchema.safeParse({
      ...cloudflareShape,
      content: "10 5 5060 sip.example.com",
    }).success,
    true,
  );
  assert.equal(
    dnsRecordSchema.safeParse({
      type: "SRV",
      name: "_sip._tcp.example.com",
      content: "10 5 5060 sip.example.com",
    }).success,
    true,
  );

  // Three fields with no separate priority: the priority is genuinely missing.
  const missingPriority = dnsRecordSchema.safeParse({
    type: "SRV",
    name: "_sip._tcp.example.com",
    content: "5 5060 sip.example.com",
  });
  assert.equal(missingPriority.success, false);
  assert.ok(
    missingPriority.error?.issues.some((issue) =>
      issue.message.includes("SRV content"),
    ),
  );

  // Three tokens that are not "weight port target" stay rejected even with a
  // priority, so the relaxation cannot swallow malformed content.
  assert.equal(
    dnsRecordSchema.safeParse({
      ...cloudflareShape,
      content: "a b sip.example.com",
    }).success,
    false,
  );
});

test("validate accepts Cloudflare's SRV shape with nothing to compensate for", async () => {
  const json = JSON.stringify([
    {
      type: "SRV",
      name: "_sip._tcp.example.com",
      content: "5 5060 sip.example.com",
      priority: 10,
      ttl: 300,
    },
  ]);
  const result = await runHarness(["validate", "/zones/srv.json"], {
    files: { "/zones/srv.json": json },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /1 record\(s\), 0 error\(s\), 0 warning\(s\)/u);
  // The record is validated as it stands: no rule is relaxed, so no note.
  assert.doesNotMatch(result.stdout, /note {2}/u);
});

test("validateRecords flags an exact duplicate as a warning", () => {
  const line = "www.example.com. 300 IN A 192.0.2.1";
  const report = validateRecords(parseRecords(`${line}\n${line}\n`, "bind"));
  assert.equal(report.errorCount, 0);
  assert.equal(report.warningCount, 1);
  assert.match(report.reports[1].issues[0].message, /duplicate of the record/u);
});
