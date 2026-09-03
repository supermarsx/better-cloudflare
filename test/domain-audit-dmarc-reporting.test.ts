/**
 * A DMARC record with no `rua=` address sends no reports anywhere. Under an
 * enforcing policy that is the worst configuration the audit can encounter:
 * receivers are quarantining or destroying mail that fails the domain's checks,
 * and the domain has no way to discover that legitimate mail is among it.
 *
 * The audit used to call that `dmarc-ok`, severity `pass` — a green light on the
 * highest-stakes configuration there is, and the same false-reassurance family
 * as the SPF false negative these files ship alongside.
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

function auditOf(dmarc: string, withMx = true) {
  const records = [record("TXT", "_dmarc.example.com", dmarc)];
  if (withMx) records.unshift(mx("mail.example.com", 10));
  return runDomainAudit(ZONE, records, EMAIL_ONLY);
}

function severityOf(dmarc: string, id: string, withMx = true) {
  return auditOf(dmarc, withMx).find((item) => item.id === id)?.severity;
}

function detailsOf(dmarc: string, id: string, withMx = true) {
  const item = auditOf(dmarc, withMx).find((entry) => entry.id === id);
  assert.ok(item, `expected a finding with id ${id} for ${dmarc}`);
  return item.details;
}

// ── Enforcing without reporting ─────────────────────────────────────────────

for (const policy of ["reject", "quarantine"]) {
  test(`p=${policy} with no rua is reported, not passed`, () => {
    const dmarc = `v=DMARC1; p=${policy};`;

    assert.equal(
      severityOf(dmarc, "dmarc-no-rua"),
      "warn",
      "enforcing with no report address should be a warning",
    );
    assert.equal(
      severityOf(dmarc, "dmarc-ok"),
      undefined,
      "a domain enforcing blind is not a clean DMARC pass",
    );
  });

  test(`p=${policy} with no rua says what is being acted on unseen`, () => {
    const details = detailsOf(`v=DMARC1; p=${policy};`, "dmarc-no-rua");

    assert.match(details, /no aggregate reports are being sent/);
    assert.match(details, /no way to see which mail that is/);
    assert.match(details, new RegExp(`p=${policy}`));
  });
}

// ── Monitoring without reporting ────────────────────────────────────────────

test("p=none with no rua says the record has no observable effect", () => {
  const details = detailsOf("v=DMARC1; p=none;", "dmarc-no-rua");

  assert.match(details, /no aggregate reports are being sent/);
  assert.match(details, /no observable effect/);
});

test("p=none with no rua and no MX is still reported", () => {
  // The p=none policy finding is gated on an apex MX; the reporting finding
  // must not be, or a non-receiving domain publishing a record that does
  // nothing at all still reads as a pass.
  assert.equal(severityOf("v=DMARC1; p=none;", "dmarc-no-rua", false), "warn");
  assert.equal(severityOf("v=DMARC1; p=none;", "dmarc-ok", false), undefined);
});

// ── Reporting present ───────────────────────────────────────────────────────

test("a policy with an rua address is not reported for reporting", () => {
  const dmarc = "v=DMARC1; p=reject; rua=mailto:dmarc@example.com";

  assert.equal(severityOf(dmarc, "dmarc-no-rua"), undefined);
  assert.equal(severityOf(dmarc, "dmarc-ok"), "pass");
});

test("an empty rua value counts as no report address", () => {
  assert.equal(severityOf("v=DMARC1; p=reject; rua=", "dmarc-no-rua"), "warn");
  assert.equal(
    severityOf("v=DMARC1; p=reject; rua=   ", "dmarc-no-rua"),
    "warn",
  );
});

test("a quoted DMARC record is read the same way", () => {
  // The presentation-shape fix has to hold here too, or the new finding
  // inherits the bug that started this work.
  const dmarc = '"v=DMARC1; p=reject;"';

  assert.equal(severityOf(dmarc, "dmarc-no-rua"), "warn");
});

// ── The reporting statement lives in exactly one finding ────────────────────

test("the p=none policy finding no longer talks about reports", () => {
  // One coherent statement about whether anyone is telling you what is
  // happening to your mail — not two findings each saying part of it.
  const details = detailsOf("v=DMARC1; p=none;", "dmarc-policy-none");

  assert.doesNotMatch(details, /rua/);
  assert.doesNotMatch(details, /report/i);
  assert.match(details, /Consider moving to quarantine\/reject once aligned/);
});

test("a record missing p= is reported for the policy, not the reporting", () => {
  // Receivers ignore a record with no p= entirely, so a missing rua on top of
  // that is not the thing to tell someone about.
  assert.equal(severityOf("v=DMARC1;", "dmarc-missing-policy"), "fail");
  assert.equal(severityOf("v=DMARC1;", "dmarc-no-rua"), undefined);
});
