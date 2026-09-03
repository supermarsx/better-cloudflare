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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runDomainAudit } from "../src/lib/audit/domain-audit";
import type { DNSRecord } from "../src/types/dns";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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

test("p=none with no rua reports the two halves without repeating either", () => {
  // Between them the findings say the record sends nothing and changes
  // nothing. Neither says both: dmarc-policy-none now fires for every p=none
  // domain, so restating the policy inside the reporting finding would put
  // the same clause in two adjacent findings.
  const reporting = detailsOf("v=DMARC1; p=none;", "dmarc-no-rua");
  const policy = detailsOf("v=DMARC1; p=none;", "dmarc-policy-none");

  assert.match(reporting, /no aggregate reports are being sent/);
  assert.doesNotMatch(reporting, /p=none/);

  assert.match(policy, /Only quarantine and reject ask receivers to act/);
  assert.match(policy, /delivered just as it would be if it had passed/);
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

// ── Policy findings are not gated on receiving mail ─────────────────────────

test("p=none is reported on a domain with no MX", () => {
  // DMARC governs what receivers do with mail *claiming* to be from the
  // domain. Whether the domain *accepts* mail is a separate question, and
  // parked or web-only domains are attractive spoofing targets precisely
  // because nobody is watching them.
  const dmarc = "v=DMARC1; p=none; rua=mailto:dmarc@example.com";

  assert.equal(severityOf(dmarc, "dmarc-policy-none", false), "warn");
  assert.equal(severityOf(dmarc, "dmarc-ok", false), undefined);
});

test("p=none is still reported on a domain that does receive mail", () => {
  const dmarc = "v=DMARC1; p=none; rua=mailto:dmarc@example.com";

  assert.equal(severityOf(dmarc, "dmarc-policy-none", true), "warn");
});

test("an enforcing policy on a domain with no MX still passes", () => {
  // Removing the MX gate must not turn every no-MX domain into a finding.
  const dmarc = "v=DMARC1; p=reject; rua=mailto:dmarc@example.com";

  assert.equal(severityOf(dmarc, "dmarc-policy-none", false), undefined);
  assert.equal(severityOf(dmarc, "dmarc-ok", false), "pass");
});

// ── Register ────────────────────────────────────────────────────────────────

test("no finding's details opens with a bare instruction", () => {
  // A finding states what is true and what follows; the severity carries the
  // weight and the explanation carries the consequence. An opening imperative
  // is the shape that drifts back in — `dmarc-policy-none` read "Consider
  // moving to quarantine/reject once aligned." while its own explanation was
  // already framed as consequence. The explanation table has had this rule
  // since it was written; this extends it to the line above.
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "src/lib/audit/domain-audit.ts"),
    "utf8",
  );
  const body = source.slice(source.indexOf("export function runDomainAudit"));
  const literals = [
    ...body.matchAll(/"([^"\\\n]{8,})"/g),
    ...body.matchAll(/`([^`\\]{8,})`/g),
  ].map((m) => m[1]);

  const imperative =
    /^(Consider|Ensure|Renew|Keep|Combine|Publish|Use|Add|Remove|Set|Verify|Check|Prefer|Move)\b/;
  const offenders = literals.filter((text) => imperative.test(text.trim()));

  assert.deepEqual(
    offenders,
    [],
    "a finding's details should state the consequence, not issue an instruction",
  );
});

// ── The reporting statement lives in exactly one finding ────────────────────

test("the p=none policy finding no longer talks about reports", () => {
  // One coherent statement about whether anyone is telling you what is
  // happening to your mail — not two findings each saying part of it.
  const details = detailsOf("v=DMARC1; p=none;", "dmarc-policy-none");

  assert.doesNotMatch(details, /rua/);
  assert.doesNotMatch(details, /report/i);
  assert.match(details, /Only quarantine and reject ask receivers to act/);
});

test("a record missing p= is reported for the policy, not the reporting", () => {
  // Receivers ignore a record with no p= entirely, so a missing rua on top of
  // that is not the thing to tell someone about.
  assert.equal(severityOf("v=DMARC1;", "dmarc-missing-policy"), "fail");
  assert.equal(severityOf("v=DMARC1;", "dmarc-no-rua"), undefined);
});
