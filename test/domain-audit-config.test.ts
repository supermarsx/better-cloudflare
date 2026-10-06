/**
 * The audit's configuration surface: per-check enable/disable, per-check
 * severity override, and tunable thresholds.
 *
 * One property matters more than the three mechanisms put together: **an absent
 * or empty config must produce exactly the findings this audit produced before
 * any of it was configurable.** Anything else is a silent behavioural change for
 * every existing user, delivered by a feature nobody switched on.
 *
 * That property is pinned three ways here, because no single one of them is
 * enough:
 *
 * 1. **Every no-op shape agrees with the empty one.** A stored config can ask
 *    for "no change" in several shapes — the categories spelled out, every
 *    threshold set to its own default, a check entry that says nothing, keys
 *    from a newer build, values out of range. All of them must produce the
 *    identical finding list, compared whole: id, category, severity, title,
 *    details and suggestion.
 * 2. **The default-rendered text is written out here as literals.** Every
 *    threshold that used to be a number inside a sentence (`<30s`, `often
 *    3600+`, `≤2 hops`, `≥2 authoritative`) now interpolates that number, so
 *    the sentence stays true when the number moves. Interpolating the default
 *    must reproduce the old sentence to the byte, and the only way to check that
 *    is to hold a copy of the old sentence somewhere the implementation cannot
 *    reach — here.
 * 3. **The table is pinned against the Rust one.** Keys, defaults and bounds
 *    are read out of `bc-domain-audit`'s source and compared, because the two
 *    implementations read the *same* stored object and a default that differed
 *    between them would mean the desktop app and the web app audited the same
 *    zone differently.
 *
 * `test/domain-audit-parity.test.ts` covers the text both implementations show;
 * this file covers the configuration that decides which of it a user sees.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DOMAIN_AUDIT_CHECKS,
  DOMAIN_AUDIT_OVERRIDE_SEVERITIES,
  DOMAIN_AUDIT_THRESHOLDS,
  resolveDomainAuditThresholds,
  runDomainAudit,
} from "../src/lib/audit/domain-audit";
import type {
  DomainAuditCategory,
  DomainAuditItem,
  DomainAuditOptions,
  DomainAuditThresholdKey,
} from "../src/lib/audit/domain-audit";
import type { DNSRecord } from "../src/types/dns";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const AUDIT_TS = path.join(REPO_ROOT, "src/lib/audit/domain-audit.ts");
const AUDIT_RS = path.join(
  REPO_ROOT,
  "src-tauri/crates/bc-domain-audit/src/lib.rs",
);

const ZONE = "example.com";

function record(
  type: string,
  name: string,
  content: string,
  ttl = 300,
): DNSRecord {
  return {
    id: `${type}-${name}-${content}`,
    type,
    name,
    content,
    ttl,
    zone_id: "zone-id",
    zone_name: ZONE,
    created_on: "",
    modified_on: "",
  };
}

function mx(target: string, priority: number): DNSRecord {
  return { ...record("MX", ZONE, target), priority };
}

function thresholds(
  pairs: Array<[string, number]>,
): DomainAuditOptions["thresholds"] {
  return Object.fromEntries(pairs) as DomainAuditOptions["thresholds"];
}

function hygieneOnly(pairs: Array<[string, number]> = []): DomainAuditOptions {
  return {
    includeCategories: { email: false, security: false, hygiene: true },
    thresholds: thresholds(pairs),
  };
}

function auditOf(
  records: DNSRecord[],
  options: DomainAuditOptions = {},
): DomainAuditItem[] {
  return runDomainAudit(ZONE, records, options);
}

function findingOf(
  records: DNSRecord[],
  id: string,
  options: DomainAuditOptions = {},
): DomainAuditItem {
  const item = auditOf(records, options).find((entry) => entry.id === id);
  assert.ok(item, `expected a finding with id ${id}`);
  return item;
}

function idsOf(records: DNSRecord[], options: DomainAuditOptions): string[] {
  return auditOf(records, options).map((item) => item.id);
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * A zone that reaches as many checks at once as can be compared exactly.
 *
 * Findings whose `details` gather several lines out of a hash map — a CNAME
 * conflict list with more than one offending name, TXT sprawl with more than
 * one — are deliberately not triggered: the Rust implementation iterates a
 * `HashMap` there, so their line order is not fixed, and a fixture that relied
 * on it would pin something neither implementation promises. One conflicting
 * name carrying one other record type is stable in both.
 */
function configurableZone(): DNSRecord[] {
  return [
    mx("mail1.example.com", 10),
    mx("mail2.example.com", 10),
    record("A", "mail1.example.com", "1.1.1.1"),
    record("A", ZONE, "192.0.2.5"),
    record("NS", ZONE, "ns1.example.com"),
    record("CAA", ZONE, '0 issue "letsencrypt.org"'),
    record("TXT", ZONE, "v=spf1 include:_spf.example.net mx ~all"),
    record("TXT", "_dmarc.example.com", "v=DMARC1; p=none;"),
    record(
      "SOA",
      ZONE,
      "ns.example.com. hostmaster.example.com. 2024010101 7200 700 604800 3600",
    ),
    record("CNAME", "a.example.com", "b.example.com"),
    record("CNAME", "b.example.com", "c.example.com"),
    record("CNAME", "alias.example.com", "elsewhere.example.net"),
    record("A", "alias.example.com", "198.51.100.7"),
    record("A", "slow.example.com", "203.0.113.9", 100000),
    record("SRV", "_sip._tcp.example.com", "10 5 5060 sip.example.com"),
  ];
}

// ── Defaults are today's behaviour ──────────────────────────────────────────

test("every config that asks for no change produces the same findings", () => {
  const records = configurableZone();
  const baseline = auditOf(records);
  assert.ok(baseline.length > 10, "the fixture should reach most of the audit");

  const everyDefault = thresholds(
    Object.entries(DOMAIN_AUDIT_THRESHOLDS).map(([key, spec]) => [
      key,
      spec.default,
    ]),
  );

  const noOpConfigs: DomainAuditOptions[] = [
    {},
    { includeCategories: { email: true, security: true, hygiene: true } },
    { includeCategories: {} },
    { checks: {}, thresholds: {} },
    { thresholds: everyDefault },
    { checks: { "caa-analysis": {} } },
    { checks: { "caa-analysis": { enabled: true } } },
    // Keys and ids a newer build might have written.
    {
      checks: { "no-such-check": { enabled: false, severity: "fail" } },
      thresholds: thresholds([["noSuchThreshold", 1]]),
    },
    // Out of range in both directions, and values that are not numbers.
    {
      thresholds: thresholds([
        ["nsMinimumAtApex", 1],
        ["ttlHighAboveSeconds", 99999999],
        ["cnameChainWarnHops", Number.NaN],
        ["txtRecordsPerNameLimit", Number.POSITIVE_INFINITY],
      ]),
    },
    {
      thresholds: {
        spfLookupWarnCount: "4",
        caaIssuerLimit: null,
      } as unknown as DomainAuditOptions["thresholds"],
    },
    {
      checks: {
        "caa-analysis": { severity: "severe" },
      } as unknown as DomainAuditOptions["checks"],
    },
  ];

  for (const [index, options] of noOpConfigs.entries()) {
    assert.deepEqual(
      auditOf(records, options),
      baseline,
      `config ${index} asked for no change but got one`,
    );
  }
});

test("the shipped defaults render the text they always rendered", () => {
  const records = [
    record("A", "fast.example.com", "198.51.100.1", 15),
    record("NS", ZONE, "ns1.example.com", 120),
    record(
      "SOA",
      ZONE,
      "ns.example.com. hostmaster.example.com. 2024010101 7200 700 604800 3600",
      1800,
    ),
  ];

  const critical = findingOf(records, "ttl-critical", hygieneOnly()).details;
  assert.ok(
    critical.includes(
      "A fast.example.com: TTL 15s is dangerously low (<30s should only be temporary)",
    ),
    critical,
  );
  assert.ok(
    critical.includes(
      "TTL <30s should only be used temporarily before DNS changes.",
    ),
    critical,
  );

  const hygiene = findingOf(records, "ttl-hygiene", hygieneOnly()).details;
  assert.ok(
    hygiene.includes("NS example.com: TTL 120s is low (often 300+)."),
    hygiene,
  );
  assert.ok(
    hygiene.includes("SOA example.com: TTL 1800s is low (often 3600+)."),
    hygiene,
  );

  const ns = findingOf(records, "ns-single", hygieneOnly());
  assert.equal(ns.title, "Single NS record at apex");
  assert.equal(
    ns.details.split("\n")[0],
    "Best practice requires ≥2 authoritative name servers for redundancy.",
  );

  assert.equal(
    findingOf(records, "cname-chains", hygieneOnly()).details,
    "No excessive CNAME chains detected (all ≤2 hops).",
  );

  const chain = [
    record("CNAME", "a.example.com", "b.example.com"),
    record("CNAME", "b.example.com", "c.example.com"),
    record("CNAME", "c.example.com", "d.example.com"),
  ];
  assert.ok(
    findingOf(chain, "cname-chains-warn", hygieneOnly()).details.includes(
      "CNAME chain is 3 hops (best practice ≤2)",
    ),
    findingOf(chain, "cname-chains-warn", hygieneOnly()).details,
  );

  const expiring = findingOf([], "domain-expiry", {
    ...hygieneOnly(),
    domainExpiresAt: daysFromNow(7),
  });
  assert.equal(expiring.title, "Domain expiry critical (<15 days)");
  assert.equal(expiring.severity, "fail");
});

// ── Per-check enable / disable ──────────────────────────────────────────────

test("a check switched off is the only finding that disappears", () => {
  const records = configurableZone();
  const baseline = auditOf(records);
  const expected = baseline.filter((item) => item.id !== "caa-analysis");
  assert.ok(
    expected.length < baseline.length,
    "the fixture must emit caa-analysis for this to mean anything",
  );

  assert.deepEqual(
    auditOf(records, { checks: { "caa-analysis": { enabled: false } } }),
    expected,
  );
});

test("switching off one variant leaves its siblings reporting", () => {
  // `cname-chains-warn` and `cname-chains-fail` are separate ids and configure
  // separately: the unit is the finding the audit emits, not the subject a
  // reader would group them under. That is the same key the UI's per-zone
  // dismissal uses, so the two mechanisms line up.
  const records = [
    record("CNAME", "a.example.com", "b.example.com"),
    record("CNAME", "b.example.com", "c.example.com"),
    record("CNAME", "c.example.com", "d.example.com"),
  ];
  const ids = idsOf(records, {
    ...hygieneOnly(),
    checks: { "cname-chains-warn": { enabled: false } },
  });

  assert.ok(!ids.includes("cname-chains-warn"));
  assert.ok(!ids.includes("cname-chains"), "the pass variant did not fire");
  assert.ok(ids.includes("soa-missing"), "an unrelated finding must survive");
});

test("disabling every check leaves nothing, and says so without crashing", () => {
  const disabled = Object.fromEntries(
    DOMAIN_AUDIT_CHECKS.map((check) => [check.id, { enabled: false }]),
  );

  assert.deepEqual(auditOf(configurableZone(), { checks: disabled }), []);
});

// ── Per-check severity override ─────────────────────────────────────────────

test("a finding can be reported at a lower or higher severity", () => {
  const records = configurableZone();
  const before = findingOf(records, "caa-analysis");
  assert.equal(before.severity, "warn");

  // The published list is what a settings surface offers, so it is the list
  // the engine has to honour — and `pass` must not be on it.
  assert.deepEqual(
    [...DOMAIN_AUDIT_OVERRIDE_SEVERITIES],
    ["info", "warn", "fail"],
  );

  for (const severity of DOMAIN_AUDIT_OVERRIDE_SEVERITIES) {
    assert.equal(
      findingOf(records, "caa-analysis", {
        checks: { "caa-analysis": { severity } },
      }).severity,
      severity,
    );
  }
});

test("an overridden finding says exactly what it said before", () => {
  // Only the severity moves. The explanation still applies, the suggestion
  // survives, and the UI's own per-zone dismissal marker — which it recovers
  // out of `details` with /Original severity: (\w+)/ — is not written here, so
  // the two mechanisms cannot be mistaken for each other.
  const records = configurableZone();
  const before = findingOf(records, "caa-analysis");
  const after = findingOf(records, "caa-analysis", {
    checks: { "caa-analysis": { severity: "info" } },
  });

  assert.deepEqual(after, { ...before, severity: "info" });
  assert.ok(!after.details.includes("Original severity:"));
  assert.ok(after.suggestion, "the suggestion must survive the downgrade");
});

test("a passing finding is never promoted by an override", () => {
  // A healthy check has nothing to report, so an override asking for `fail`
  // must not invent a failure — nor attach the explanation a real one carries.
  const healthy = [
    record("CAA", ZONE, '0 issue "letsencrypt.org"'),
    record("CAA", ZONE, '0 iodef "mailto:security@example.com"'),
  ];
  const caa = findingOf(healthy, "caa-analysis", {
    includeCategories: { email: false, security: true, hygiene: false },
    checks: { "caa-analysis": { severity: "fail" } },
  });

  assert.equal(caa.severity, "pass");
  assert.equal(caa.details, "CAA present and looks reasonable.");
});

test("pass is not an accepted override", () => {
  // Forcing `pass` would leave a live problem labelled healthy, with the text
  // describing it hidden behind the UI's "show passed" filter. Silencing a
  // check is `enabled: false`, which removes the finding instead.
  const forced = {
    checks: { "caa-analysis": { severity: "pass" } },
  } as unknown as DomainAuditOptions;

  assert.equal(
    findingOf(configurableZone(), "caa-analysis", forced).severity,
    "warn",
  );
});

// ── Thresholds reach the checks they belong to ──────────────────────────────

test("the expiry bands follow their thresholds", () => {
  const severityWith = (pairs: Array<[string, number]>) =>
    findingOf([], "domain-expiry", {
      ...hygieneOnly(pairs),
      domainExpiresAt: daysFromNow(20),
    }).severity;

  assert.equal(severityWith([]), "warn");
  assert.equal(severityWith([["domainExpiryCriticalDays", 30]]), "fail");
  assert.equal(severityWith([["domainExpiryWarnDays", 10]]), "pass");
});

test("the TTL bands follow their thresholds", () => {
  const detailsOf = (
    ttl: number,
    type: string,
    pairs: Array<[string, number]>,
    id: string,
  ) =>
    auditOf(
      [record(type, "host.example.com", "1.1.1.1", ttl)],
      hygieneOnly(pairs),
    ).find((item) => item.id === id)?.details;

  assert.equal(detailsOf(45, "A", [], "ttl-critical"), undefined);
  assert.ok(
    detailsOf(
      45,
      "A",
      [["ttlCriticalBelowSeconds", 60]],
      "ttl-critical",
    )?.includes("(<60s should only be temporary)"),
  );

  assert.ok(detailsOf(90, "A", [], "ttl-hygiene")?.includes("No obvious TTL"));
  assert.ok(
    detailsOf(90, "A", [["ttlLowBelowSeconds", 120]], "ttl-hygiene")?.includes(
      "TTL 90s is very low",
    ),
  );
  assert.ok(
    detailsOf(100000, "A", [], "ttl-hygiene")?.includes("is very high"),
  );
  assert.ok(
    detailsOf(
      100000,
      "A",
      [["ttlHighAboveSeconds", 200000]],
      "ttl-hygiene",
    )?.includes("No obvious TTL"),
  );
  assert.ok(
    detailsOf(
      400,
      "NS",
      [["ttlDelegationLowBelowSeconds", 600]],
      "ttl-hygiene",
    )?.includes("TTL 400s is low (often 600+)."),
  );
  assert.ok(
    detailsOf(
      1800,
      "SOA",
      [["ttlSoaLowBelowSeconds", 900]],
      "ttl-hygiene",
    )?.includes("No obvious TTL"),
  );
});

test("the CNAME chain bands follow their thresholds", () => {
  const records = [
    record("CNAME", "a.example.com", "b.example.com"),
    record("CNAME", "b.example.com", "c.example.com"),
  ];
  const chainIds = (pairs: Array<[string, number]>) =>
    idsOf(records, hygieneOnly(pairs)).filter((id) =>
      id.startsWith("cname-chains"),
    );

  assert.deepEqual(chainIds([]), ["cname-chains"]);
  assert.deepEqual(chainIds([["cnameChainWarnHops", 2]]), [
    "cname-chains-warn",
  ]);
  assert.deepEqual(
    chainIds([
      ["cnameChainWarnHops", 2],
      ["cnameChainFailHops", 2],
    ]),
    ["cname-chains-fail"],
  );

  // The advice has to follow the threshold it came from.
  assert.ok(
    findingOf(
      records,
      "cname-chains-warn",
      hygieneOnly([["cnameChainWarnHops", 2]]),
    ).details.includes("(best practice ≤1)"),
  );
});

test("the TXT sprawl limit follows its threshold", () => {
  const records = [0, 1, 2, 3].map((n) =>
    record("TXT", "many.example.com", `note-${n}`),
  );

  assert.ok(!idsOf(records, hygieneOnly()).includes("txt-sprawl"));
  assert.ok(
    findingOf(
      records,
      "txt-sprawl",
      hygieneOnly([["txtRecordsPerNameLimit", 3]]),
    ).details.includes("many.example.com: 4 TXT records"),
  );
});

test("the NS minimum follows its threshold", () => {
  const records = [
    record("NS", ZONE, "ns1.example.com"),
    record("NS", ZONE, "ns2.example.com"),
  ];

  assert.equal(
    findingOf(records, "ns-redundancy", hygieneOnly()).severity,
    "pass",
  );

  const ns = findingOf(
    records,
    "ns-single",
    hygieneOnly([["nsMinimumAtApex", 3]]),
  );
  assert.equal(ns.severity, "fail");
  assert.equal(
    ns.title,
    "Too few NS records at apex",
    'with two records present, "Single NS record at apex" would be false',
  );
  assert.ok(ns.details.includes("requires ≥3 authoritative name servers"));
});

test("the MX, SPF and CAA limits follow their thresholds", () => {
  const mail = [
    mx("mail1.example.com", 10),
    mx("mail2.example.com", 20),
    mx("mail3.example.com", 30),
    record("TXT", ZONE, "v=spf1 mx a -all"),
  ];
  const emailOnly = (pairs: Array<[string, number]>): DomainAuditOptions => ({
    includeCategories: { email: true, security: false, hygiene: false },
    thresholds: thresholds(pairs),
  });

  assert.ok(!idsOf(mail, emailOnly([])).includes("mx-too-many"));
  assert.equal(
    findingOf(mail, "mx-too-many", emailOnly([["mxManyAtApexLimit", 2]]))
      .severity,
    "warn",
  );

  assert.equal(
    findingOf(mail, "spf-lookups-estimate", emailOnly([])).severity,
    "info",
  );
  assert.equal(
    findingOf(
      mail,
      "spf-lookups-estimate",
      emailOnly([["spfLookupWarnCount", 2]]),
    ).severity,
    "warn",
  );

  const caaRecords = [
    record("CAA", ZONE, '0 issue "letsencrypt.org"'),
    record("CAA", ZONE, '0 issue "digicert.com"'),
    record("CAA", ZONE, '0 iodef "mailto:security@example.com"'),
  ];
  const securityOnly = (
    pairs: Array<[string, number]>,
  ): DomainAuditOptions => ({
    includeCategories: { email: false, security: true, hygiene: false },
    thresholds: thresholds(pairs),
  });

  assert.equal(
    findingOf(caaRecords, "caa-analysis", securityOnly([])).severity,
    "pass",
  );
  const tightened = findingOf(
    caaRecords,
    "caa-analysis",
    securityOnly([["caaIssuerLimit", 1]]),
  );
  assert.equal(tightened.severity, "warn");
  assert.ok(tightened.details.includes("CAA allows many issuers (2)"));
});

// ── Threshold resolution rules ──────────────────────────────────────────────

test("every threshold has room to move and a default inside its bounds", () => {
  for (const [key, spec] of Object.entries(DOMAIN_AUDIT_THRESHOLDS)) {
    assert.ok(
      spec.min <= spec.default && spec.default <= spec.max,
      `${key}: default ${spec.default} is outside its own bounds ${spec.min}..${spec.max}`,
    );
    assert.ok(spec.min < spec.max, `${key}: bounds leave nothing to configure`);
    assert.match(key, /^[a-z][A-Za-z0-9]*$/, `${key} is not a camelCase key`);
  }
});

test("a value outside its bounds leaves the default in place", () => {
  const defaults = resolveDomainAuditThresholds();

  for (const [key, spec] of Object.entries(DOMAIN_AUDIT_THRESHOLDS)) {
    for (const value of [
      spec.min - 1,
      spec.max + 1,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      assert.deepEqual(
        resolveDomainAuditThresholds(
          thresholds([[key, value]]) as Partial<
            Record<DomainAuditThresholdKey, number>
          >,
        ),
        defaults,
        `${key} accepted ${value}`,
      );
    }
  }
});

test("a fractional value is truncated rather than rejected", () => {
  // Every JSON number is a float on the Rust side of the wire too, so `30.0`
  // and `30` arrive indistinguishably; rejecting fractions would mean the two
  // implementations disagreed about the same stored file.
  assert.equal(
    resolveDomainAuditThresholds({ ttlLowBelowSeconds: 90.7 })
      .ttlLowBelowSeconds,
    90,
  );
});

test("a value inside its bounds is the one the audit uses", () => {
  for (const [key, spec] of Object.entries(DOMAIN_AUDIT_THRESHOLDS)) {
    const resolved = resolveDomainAuditThresholds(
      thresholds([[key, spec.max]]) as Partial<
        Record<DomainAuditThresholdKey, number>
      >,
    );
    assert.equal(
      resolved[key as DomainAuditThresholdKey],
      spec.max,
      `${key} did not resolve to a value inside its own bounds`,
    );
  }
});

// ── The two implementations share one configuration surface ─────────────────

/** `AuditThresholdSpec` consts, read out of the crate's source. */
function rustThresholds(): Map<
  string,
  { default: number; min: number; max: number }
> {
  const source = fs.readFileSync(AUDIT_RS, "utf8");
  const specs = new Map<
    string,
    { default: number; min: number; max: number }
  >();
  const pattern =
    /AuditThresholdSpec\s*\{\s*key:\s*"([A-Za-z0-9]+)",\s*default:\s*([\d_]+),\s*min:\s*([\d_]+),\s*max:\s*([\d_]+),?\s*\}/g;
  for (const match of source.matchAll(pattern)) {
    const [, key, ...numbers] = match;
    const [def, min, max] = numbers.map((n) => Number(n.replace(/_/g, "")));
    specs.set(key, { default: def, min, max });
  }
  return specs;
}

test("the threshold table is the same in both implementations", () => {
  const rust = rustThresholds();
  const ts = new Map(Object.entries(DOMAIN_AUDIT_THRESHOLDS));

  assert.equal(
    rust.size,
    ts.size,
    `extracted ${rust.size} AuditThresholdSpec consts from the crate, expected ${ts.size}` +
      " — either a threshold exists on one side only, or the extraction above no" +
      " longer matches how they are written",
  );
  assert.deepEqual([...rust.keys()].sort(), [...ts.keys()].sort());
  for (const [key, spec] of ts) {
    assert.deepEqual(
      rust.get(key),
      { default: spec.default, min: spec.min, max: spec.max },
      `${key} is configured differently in Rust`,
    );
  }
});

/** The finding ids each implementation actually emits, with their category. */
function emittedFindings(
  source: string,
  pattern: RegExp,
  categories: Record<string, DomainAuditCategory>,
): Map<string, DomainAuditCategory> {
  const found = new Map<string, DomainAuditCategory>();
  for (const [, id, category] of source.matchAll(pattern)) {
    found.set(id, categories[category]);
  }
  return found;
}

function typeScriptFindings(): Map<string, DomainAuditCategory> {
  const source = fs.readFileSync(AUDIT_TS, "utf8");
  // From the audit function onward, so that DOMAIN_AUDIT_CHECKS — which is
  // written in the same `id` / `category` shape — cannot vouch for itself.
  const start = source.indexOf("export function runDomainAudit");
  assert.notEqual(start, -1, "the audit function moved or was renamed");
  return emittedFindings(
    source.slice(start),
    /\bid: "([a-z0-9-]+)",\s*\n\s*category: "(email|security|hygiene)"/g,
    { email: "email", security: "security", hygiene: "hygiene" },
  );
}

function rustFindings(): Map<string, DomainAuditCategory> {
  const source = fs.readFileSync(AUDIT_RS, "utf8");
  const tests = source.indexOf("#[cfg(test)]");
  assert.notEqual(tests, -1, "expected a test module to mark where to stop");
  return emittedFindings(
    source.slice(0, tests),
    /\bitem(?:_with_suggestion)?\(\s*"([a-z0-9-]+)",\s*AuditCategory::(Email|Security|Hygiene)/g,
    { Email: "email", Security: "security", Hygiene: "hygiene" },
  );
}

test("the published check list is exactly what the audit emits", () => {
  // A settings surface built from this list can only be as good as the list. A
  // row that is wrong offers a toggle that controls nothing; a missing row
  // leaves a finding a user cannot configure at all.
  const catalogue = new Map(
    DOMAIN_AUDIT_CHECKS.map((check) => [check.id, check.category]),
  );
  assert.equal(
    catalogue.size,
    DOMAIN_AUDIT_CHECKS.length,
    "the list repeats an id",
  );

  for (const [language, emitted] of [
    ["TypeScript", typeScriptFindings()],
    ["Rust", rustFindings()],
  ] as const) {
    assert.deepEqual(
      [...emitted.keys()].sort(),
      [...catalogue.keys()].sort(),
      `the ${language} audit emits findings this list does not name, or the other way about`,
    );
    for (const [id, category] of emitted) {
      assert.equal(
        catalogue.get(id),
        category,
        `${id} is ${category} in the ${language} audit`,
      );
    }
  }
});

test("every listed check is configurable through its id", () => {
  // The id in the list has to be the key the options object is read against —
  // not merely a label that happens to match. Disabling each in turn is what
  // proves the two are the same string.
  const records = configurableZone();
  const emitted = new Set(auditOf(records).map((item) => item.id));
  assert.ok(emitted.size > 10, "the fixture should reach most of the audit");

  for (const check of DOMAIN_AUDIT_CHECKS) {
    if (!emitted.has(check.id)) continue;
    const ids = idsOf(records, { checks: { [check.id]: { enabled: false } } });
    assert.ok(
      !ids.includes(check.id),
      `${check.id} is listed but switching it off did nothing`,
    );
    assert.equal(
      ids.length,
      emitted.size - 1,
      `switching off ${check.id} changed more than one finding`,
    );
  }
});
