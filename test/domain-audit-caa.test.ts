/**
 * The `caa-analysis` finding's semi-automatic repair.
 *
 * A missing iodef tag is the only one of the three CAA problems this finding
 * reports that is fixed by *adding* a record, so it is the only one that
 * carries a `suggestion`. Two things have to hold for that suggestion to be
 * worth offering:
 *
 * 1. **The app can read it back.** The suggestion is pre-filled into the
 *    add-record form, where `parseCAAContent` splits it into the flags, tag
 *    and value fields the user edits, and the audit's own `parseCaa` has to
 *    agree it is an iodef tag or publishing it would not clear the finding.
 *    Both are asserted here against the real parsers rather than against a
 *    second reading of the same string.
 * 2. **It does not claim to fix more than it does.** The button offering it is
 *    labelled generically, and this finding can list three problems at once.
 *
 * Mirrors `the_suggested_iodef_record_parses_and_clears_the_finding` and
 * `the_caa_finding_scopes_its_suggestion_only_when_it_reports_more` in
 * `src-tauri/crates/bc-domain-audit/src/lib.rs`;
 * `test/domain-audit-parity.test.ts` pins the text the two share.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCAAContent } from "../src/components/dns/builders/CaaBuilder";
import { runDomainAudit } from "../src/lib/audit/domain-audit";
import type { DomainAuditItem } from "../src/lib/audit/domain-audit";
import type { DNSRecord } from "../src/types/dns";

const ZONE = "example.com";

/**
 * Written out rather than imported from the module under test.
 *
 * Both implementations hold this sentence in a named constant, so their own
 * unit tests assert against it and would keep passing if the wording changed
 * under them. `test/domain-audit-parity.test.ts` pins the two constants to
 * each other, which catches one side drifting but not both. This copy is the
 * one place that pins the words themselves.
 */
const SCOPE_NOTE =
  "The suggested record adds the iodef tag only; the other points listed here each need a separate change.";

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

const SECURITY_ONLY = {
  includeCategories: { email: false, security: true, hygiene: false },
  domainExpiresAt: null,
};

function caaFinding(records: DNSRecord[], zone = ZONE): DomainAuditItem {
  const item = runDomainAudit(zone, records, SECURITY_ONLY).find(
    (candidate) => candidate.id === "caa-analysis",
  );
  assert.ok(item, "expected a caa-analysis finding");
  return item;
}

const LETS_ENCRYPT = record("CAA", ZONE, '0 issue "letsencrypt.org"');

test("a missing iodef tag suggests a record both CAA parsers accept", () => {
  const suggestion = caaFinding([LETS_ENCRYPT]).suggestion;
  assert.ok(suggestion, "a missing iodef tag should carry a repair suggestion");
  assert.equal(suggestion.recordType, "CAA");
  assert.equal(suggestion.name, "@");
  assert.equal(suggestion.content, '0 iodef "mailto:security@example.com"');

  // The parser behind the add-record form the suggestion is pre-filled into.
  assert.deepEqual(parseCAAContent(suggestion.content), {
    flags: 0,
    tag: "iodef",
    value: "mailto:security@example.com",
  });
});

test("publishing the suggested record clears the finding it was offered for", () => {
  const suggestion = caaFinding([LETS_ENCRYPT]).suggestion;
  assert.ok(suggestion);

  const repaired = caaFinding([
    LETS_ENCRYPT,
    record("CAA", ZONE, suggestion.content),
  ]);
  assert.equal(repaired.severity, "pass");
  assert.equal(
    repaired.suggestion,
    undefined,
    "a zone that already has an iodef tag has nothing to add",
  );
});

test("the suggested mailbox follows the zone apex", () => {
  const finding = caaFinding(
    [record("CAA", "sub.example.org", '0 issue "letsencrypt.org"')],
    "sub.example.org.",
  );
  assert.equal(
    finding.suggestion?.content,
    '0 iodef "mailto:security@sub.example.org"',
  );
});

const FOUR_ISSUERS = [
  '0 issue "letsencrypt.org"',
  '0 issue "digicert.com"',
  '0 issue "sectigo.com"',
  '0 issue "globalsign.com"',
].map((content) => record("CAA", ZONE, content));

test("a finding that reports more than the iodef line scopes its suggestion", () => {
  const finding = caaFinding(FOUR_ISSUERS);

  assert.match(finding.details, /CAA allows many issuers \(4\)/);
  assert.ok(
    finding.details.includes(SCOPE_NOTE),
    `expected the suggestion to be scoped:\n${finding.details}`,
  );
  assert.ok(finding.suggestion);
});

test("a finding that reports only the iodef line has nothing to scope against", () => {
  const finding = caaFinding([LETS_ENCRYPT]);

  assert.equal(
    finding.details.includes(SCOPE_NOTE),
    false,
    `nothing else is listed, so the note would be untrue:\n${finding.details}`,
  );
  assert.ok(finding.suggestion);
});

test("CAA problems that adding a record cannot fix carry no suggestion", () => {
  const finding = caaFinding([
    ...FOUR_ISSUERS,
    record("CAA", ZONE, '0 iodef "mailto:security@example.com"'),
  ]);

  assert.equal(finding.severity, "warn");
  assert.equal(finding.suggestion, undefined);
  assert.equal(finding.details.includes(SCOPE_NOTE), false);
});
