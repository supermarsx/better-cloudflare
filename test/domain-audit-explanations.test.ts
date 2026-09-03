/**
 * Every audit finding that reports a record as absent or misconfigured has to
 * say what that record does and what follows from its state — a finding that
 * only names the record tells a domain owner who already knows nothing new, and
 * one who does not nothing useful.
 *
 * These tests also pin the TypeScript and Rust explanation tables against each
 * other. Two implementations of the same user-facing text drifting apart is the
 * same failure mode as the two SPF detectors that produced the bug this file
 * ships alongside, so the parity check reads the Rust source directly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  FINDING_EXPLANATIONS,
  runDomainAudit,
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

const ALL_CATEGORIES = {
  includeCategories: { email: true, security: true, hygiene: true },
  domainExpiresAt: null,
};

function auditOf(records: DNSRecord[]) {
  return runDomainAudit(ZONE, records, ALL_CATEGORIES);
}

function detailsOf(records: DNSRecord[], id: string): string {
  const item = auditOf(records).find((entry) => entry.id === id);
  assert.ok(item, `expected a finding with id ${id}`);
  return item.details;
}

// ── The user's case: a missing record explains itself ───────────────────────

test("a zone with mail but no SPF explains what SPF does", () => {
  const details = detailsOf([mx("mail.example.com", 10)], "spf-missing");

  // The original technical detail survives...
  assert.match(details, /no SPF TXT record was found at @/i);
  // ...and the explanation follows it.
  assert.match(
    details,
    /lists the servers allowed to send mail using your domain/,
  );
  assert.match(details, /one less signal working in its favour/);
});

test("a zone with mail but no DMARC explains what DMARC does", () => {
  const details = detailsOf([mx("mail.example.com", 10)], "dmarc-missing");

  assert.match(
    details,
    /what to do with mail that fails your SPF and DKIM checks/,
  );
  assert.match(details, /you get no reports/);
});

test("a zone with mail but no DKIM explains what DKIM does", () => {
  const details = detailsOf([mx("mail.example.com", 10)], "dkim-missing");

  assert.match(details, /verify against a public key published in your DNS/);
  // Accuracy: the audit only sees this zone, so absence is not proof.
  assert.match(details, /somewhere this zone cannot see/);
});

test("explanations state the consequence rather than issuing instructions", () => {
  // The register the copy commits to: no "critical", no "you must" — the
  // severity the audit already assigns carries the weight.
  for (const [id, text] of Object.entries(FINDING_EXPLANATIONS)) {
    assert.doesNotMatch(text, /\byou must\b/i, `${id} issues an instruction`);
    assert.doesNotMatch(text, /\bcritical\b/i, `${id} editorialises severity`);
    assert.doesNotMatch(
      text,
      /\burgent(ly)?\b/i,
      `${id} editorialises severity`,
    );
  }
});

// ── p=none without a report address ─────────────────────────────────────────

test("the reporting statement lives on the reporting finding", () => {
  // This invariant used to sit on dmarc-policy-none, which carried a
  // conditional rua clause. The statement moved to its own finding rather
  // than disappearing — a domain with no rua must still be told plainly.
  const details = detailsOf(
    [
      mx("mail.example.com", 10),
      record("TXT", "_dmarc.example.com", "v=DMARC1; p=none;"),
    ],
    "dmarc-no-rua",
  );

  assert.match(details, /no aggregate reports are being sent/);
});

test("p=none with an rua is not told its reports are missing", () => {
  const withRua = [
    mx("mail.example.com", 10),
    record(
      "TXT",
      "_dmarc.example.com",
      "v=DMARC1; p=none; rua=mailto:dmarc@example.com",
    ),
  ];

  assert.equal(
    auditOf(withRua).find((item) => item.id === "dmarc-no-rua"),
    undefined,
  );
  assert.match(
    detailsOf(withRua, "dmarc-policy-none"),
    /Consider moving to quarantine\/reject/,
  );
});

test("no explanation claims reports are flowing", () => {
  // The p=none explanation is appended whether or not an rua exists, so it
  // must not assert reports are being sent. The rua explanation is only ever
  // appended when one is absent, so it must not either.
  assert.doesNotMatch(FINDING_EXPLANATIONS["dmarc-policy-none"], /report/i);
  assert.doesNotMatch(
    FINDING_EXPLANATIONS["dmarc-no-rua"],
    /reports are being sent/,
  );
  assert.match(
    FINDING_EXPLANATIONS["dmarc-no-rua"],
    /Without one nothing is sent anywhere/,
  );
});

// ── Application rules ───────────────────────────────────────────────────────

test("a passing finding carries no explanation", () => {
  const healthy = [
    mx("mail1.example.com", 10),
    mx("mail2.example.com", 20),
    record("A", "mail1.example.com", "1.1.1.1"),
    record("A", "mail2.example.com", "8.8.8.8"),
    record("TXT", ZONE, "v=spf1 -all"),
    record("TXT", "_dmarc.example.com", "v=DMARC1; p=reject"),
    record("TXT", "sel._domainkey.example.com", "v=DKIM1; k=rsa; p=key"),
  ];

  for (const item of auditOf(healthy)) {
    if (item.severity !== "pass") continue;
    const explanation = FINDING_EXPLANATIONS[item.id];
    if (!explanation) continue;
    assert.ok(
      !item.details.includes(explanation),
      `passing finding ${item.id} should not be explained`,
    );
  }
});

test("an explained finding keeps its original details as the first paragraph", () => {
  const details = detailsOf([mx("mail.example.com", 10)], "spf-missing");
  const [first] = details.split("\n\n");

  assert.equal(
    first,
    "MX exists at the zone apex but no SPF TXT record was found at @.",
  );
});

test("the override marker the UI parses is not disturbed by explanations", () => {
  // DNSManager re-reads the original severity out of `details` with
  // /Original severity: (\w+)/ after prefixing it. No explanation may contain
  // that phrase, or an overridden finding would report the wrong severity.
  for (const [id, text] of Object.entries(FINDING_EXPLANATIONS)) {
    assert.doesNotMatch(
      text,
      /Original severity:/,
      `${id} collides with the override marker`,
    );
  }
});

// ── Table hygiene ───────────────────────────────────────────────────────────

test("every explanation key is a finding the audit can actually emit", () => {
  const source = fs.readFileSync(AUDIT_TS, "utf8");
  const emitted = new Set(
    [...source.matchAll(/^\s*id: "([a-z0-9-]+)",$/gm)].map((m) => m[1]),
  );

  for (const id of Object.keys(FINDING_EXPLANATIONS)) {
    assert.ok(emitted.has(id), `${id} is explained but never emitted`);
  }
});

test("the bogon IP findings are left unexplained on purpose", () => {
  // Their details are replaced by <SpecialIpAuditFindings> in the UI, so text
  // added here would never reach the reader — and they report a record that
  // exists rather than one that is missing.
  assert.ok(!("special-a" in FINDING_EXPLANATIONS));
  assert.ok(!("special-aaaa" in FINDING_EXPLANATIONS));
});

// ── TypeScript / Rust parity ────────────────────────────────────────────────

/** Ids and texts of the Rust `FINDING_EXPLANATIONS` slice. */
function rustExplanations(): Map<string, string> {
  const source = fs.readFileSync(AUDIT_RS, "utf8");
  const start = source.indexOf(
    "const FINDING_EXPLANATIONS: &[(&str, &str)] = &[",
  );
  assert.notEqual(start, -1, "Rust FINDING_EXPLANATIONS table not found");
  const end = source.indexOf("\n];", start);
  assert.notEqual(end, -1, "Rust FINDING_EXPLANATIONS table is unterminated");

  const body = source.slice(start, end);
  const entries = new Map<string, string>();
  for (const match of body.matchAll(
    /^\s*\("([a-z0-9-]+)", "((?:[^"\\]|\\.)*)"\),$/gm,
  )) {
    entries.set(match[1], match[2]);
  }
  return entries;
}

test("the Rust explanation table matches the TypeScript one exactly", () => {
  const rust = rustExplanations();
  const ts = new Map(Object.entries(FINDING_EXPLANATIONS));

  assert.deepEqual(
    [...rust.keys()].sort(),
    [...ts.keys()].sort(),
    "the two tables explain different findings",
  );

  for (const [id, text] of ts) {
    assert.equal(
      rust.get(id),
      text,
      `explanation for ${id} differs between TypeScript and Rust`,
    );
  }
});

test("the Rust table is applied only to non-passing findings", () => {
  const source = fs.readFileSync(AUDIT_RS, "utf8");

  assert.match(source, /fn explain_finding\(item: &mut AuditItem\)/);
  assert.match(
    source,
    /if item\.severity == AuditSeverity::Pass \{\s*\n\s*return;/,
  );
  assert.match(
    source,
    /for item in &mut items \{\s*\n\s*explain_finding\(item\);/,
  );
});
