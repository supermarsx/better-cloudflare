/**
 * The domain audit must recognise the e-mail TXT records a zone actually
 * publishes, in every presentation shape Cloudflare and zone-file imports
 * hand back: bare, quoted, split into adjacent character-strings, and with an
 * absolute (trailing dot) owner name.
 *
 * Regression: a plain `v=spf1 mx -all` at the apex was reported as
 * "SPF missing at apex" whenever the content arrived quoted, because the
 * audit's SPF detector compared the raw presentation text instead of the
 * logical TXT value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runDomainAudit } from "../src/lib/audit/domain-audit";
import type { DNSRecord } from "../src/types/dns";

const ZONE = "example.com";

function record(type: string, name: string, content: string): DNSRecord {
  return {
    id: `${type}-${name}-${content}`,
    type,
    name,
    content,
    ttl: 300,
    zone_id: "zone-id",
    zone_name: ZONE,
    created_on: "",
    modified_on: "",
  };
}

function mx(target: string, priority: number): DNSRecord {
  return { ...record("MX", ZONE, target), priority };
}

const EMAIL_ONLY = {
  includeCategories: { email: true, security: false, hygiene: false },
  domainExpiresAt: null,
};

function severityOf(records: DNSRecord[], id: string): string | undefined {
  return runDomainAudit(ZONE, records, EMAIL_ONLY).find(
    (item) => item.id === id,
  )?.severity;
}

function findingIds(records: DNSRecord[], prefix: string): string[] {
  return runDomainAudit(ZONE, records, EMAIL_ONLY)
    .filter((item) => item.id.startsWith(prefix))
    .map((item) => item.id);
}

// ── SPF at the apex ─────────────────────────────────────────────────────────

/** Every presentation shape of the same logical `v=spf1 mx -all` record. */
const SPF_SHAPES: [label: string, content: string][] = [
  ["bare", "v=spf1 mx -all"],
  ["quoted", '"v=spf1 mx -all"'],
  ["padded quoted", '  "v=spf1 mx -all"  '],
  ["split character-strings", '"v=spf1 " "mx -all"'],
  ["quoted uppercase", '"V=SPF1 MX -ALL"'],
];

for (const [label, content] of SPF_SHAPES) {
  test(`apex SPF is detected when content is ${label}`, () => {
    const records = [record("TXT", ZONE, content)];

    assert.equal(
      severityOf(records, "spf-ok"),
      "pass",
      `expected spf-ok for ${content}`,
    );
    assert.deepEqual(
      findingIds(records, "spf-missing"),
      [],
      `expected no spf-missing for ${content}`,
    );
  });
}

/** The apex owner name arrives as the zone name, `@`, or an absolute name. */
const APEX_NAMES = [ZONE, "@", "example.com.", "EXAMPLE.COM"];

for (const name of APEX_NAMES) {
  test(`apex SPF is detected when the owner name is ${name}`, () => {
    const records = [record("TXT", name, '"v=spf1 mx -all"')];

    assert.equal(severityOf(records, "spf-ok"), "pass");
  });
}

test("a bare mx mechanism still counts towards the SPF lookup estimate", () => {
  const items = runDomainAudit(
    ZONE,
    [record("TXT", ZONE, '"v=spf1 mx -all"')],
    EMAIL_ONLY,
  );
  const estimate = items.find((item) => item.id === "spf-lookups-estimate");

  assert.ok(estimate, "expected a lookup estimate for a record using mx");
  assert.match(estimate.details, /mechanisms: 1\b/);
});

test("a TXT record that only looks like SPF is not treated as SPF", () => {
  // RFC 7208 §4.5: the version section is `v=spf1` followed by whitespace or
  // the end of the record. `v=spf1foo` is a different record entirely.
  const records = [record("TXT", ZONE, "v=spf1foo bar")];

  assert.equal(severityOf(records, "spf-missing"), "warn");
});

test("SPF records are still counted per zone, not per presentation shape", () => {
  const records = [
    record("TXT", ZONE, "v=spf1 mx -all"),
    record("TXT", ZONE, '"v=spf1 include:_spf.example.net -all"'),
  ];

  assert.equal(severityOf(records, "spf-multiple"), "fail");
});

// ── DMARC ───────────────────────────────────────────────────────────────────

const DMARC_RUA = "rua=mailto:dmarc@example.com";

const DMARC_CASES: [label: string, name: string, content: string][] = [
  ["bare", "_dmarc.example.com", `v=DMARC1; p=reject; ${DMARC_RUA}`],
  ["quoted", "_dmarc.example.com", `"v=DMARC1; p=reject; ${DMARC_RUA}"`],
  [
    "split character-strings",
    "_dmarc.example.com",
    `"v=DMARC1; p=reject;" " ${DMARC_RUA}"`,
  ],
  [
    "absolute owner name",
    "_dmarc.example.com.",
    `v=DMARC1; p=reject; ${DMARC_RUA}`,
  ],
  [
    "uppercase owner name",
    "_DMARC.EXAMPLE.COM",
    `v=DMARC1; p=reject; ${DMARC_RUA}`,
  ],
];

for (const [label, name, content] of DMARC_CASES) {
  test(`DMARC is detected when ${label}`, () => {
    const records = [record("TXT", name, content)];

    assert.equal(
      severityOf(records, "dmarc-ok"),
      "pass",
      `expected dmarc-ok for ${name} / ${content}`,
    );
  });
}

// ── DKIM ────────────────────────────────────────────────────────────────────

const DKIM_CASES: [label: string, name: string, content: string][] = [
  ["bare", "sel._domainkey.example.com", "v=DKIM1; k=rsa; p=key"],
  ["quoted", "sel._domainkey.example.com", '"v=DKIM1; k=rsa; p=key"'],
  [
    "split character-strings",
    "sel._domainkey.example.com",
    '"v=DKIM1; k=rsa; " "p=key"',
  ],
  ["absolute owner name", "sel._domainkey.example.com.", "v=DKIM1; p=key"],
];

for (const [label, name, content] of DKIM_CASES) {
  test(`DKIM is detected when ${label}`, () => {
    const records = [mx("mail.example.com", 10), record("TXT", name, content)];

    assert.equal(
      severityOf(records, "dkim-missing"),
      "pass",
      `expected DKIM to be detected for ${name} / ${content}`,
    );
  });
}
