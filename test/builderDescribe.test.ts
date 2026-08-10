import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDMARC } from "../src/components/dns/builders/DmarcBuilder";
import { describeSPF } from "../src/components/dns/builders/SpfBuilder";
import {
  describeReportUris,
  humanizeSeconds,
  joinList,
  pluralize,
} from "../src/components/dns/builders/describe-utils";
import { parseSPF } from "../src/lib/dns/spf";

const BASE_DMARC = {
  policy: "none" as const,
  subdomainPolicy: "" as const,
  adkim: "r" as const,
  aspf: "r" as const,
  pct: undefined,
  rua: "",
  ruf: "",
  fo: "",
  rf: "",
  ri: undefined,
};

test("describe-utils render prose fragments", () => {
  assert.equal(joinList([]), "");
  assert.equal(joinList(["a"]), "a");
  assert.equal(joinList(["a", "b"]), "a and b");
  assert.equal(joinList(["a", "b", "c"]), "a, b and c");
  assert.equal(pluralize(1, "record"), "1 record");
  assert.equal(pluralize(2, "record"), "2 records");
  assert.equal(humanizeSeconds(86400), "1 day");
  assert.equal(humanizeSeconds(7200), "2 hours");
  assert.equal(humanizeSeconds(90), "90 seconds");
  assert.equal(
    describeReportUris("mailto:a@x.test, mailto:b@y.test"),
    "a@x.test and b@y.test",
  );
});

test("describeDMARC states the delivery action, portion and report address", () => {
  const summary = describeDMARC(
    {
      ...BASE_DMARC,
      policy: "quarantine",
      pct: 50,
      rua: "mailto:x@example.test",
    },
    "example.com",
  );

  assert.match(summary.headline, /quarantine half of the messages/);
  assert.match(summary.headline, /fail authentication/);
  assert.match(summary.headline, /aggregate reports to x@example\.test/);

  // RFC 7489 §6.6.4: the remainder drops to the next lower action.
  assert.ok(
    summary.details?.some((line) =>
      /remaining failing messages are delivered normally/.test(line),
    ),
    "partial rollout fallback must be spelled out",
  );
});

test("describeDMARC does not claim enforcement for p=none", () => {
  const summary = describeDMARC(
    { ...BASE_DMARC, policy: "none" },
    "example.com",
  );
  assert.match(summary.headline, /no delivery change/);
  assert.match(summary.headline, /monitoring only/);
  assert.doesNotMatch(summary.headline, /reject|quarantine/);
});

test("describeDMARC explains inherited subdomain policy and alignment", () => {
  const inherited = describeDMARC(
    { ...BASE_DMARC, policy: "reject" },
    "example.com",
  );
  assert.ok(
    inherited.details?.some((line) =>
      /Subdomains inherit this same policy/.test(line),
    ),
  );

  const strict = describeDMARC(
    { ...BASE_DMARC, policy: "reject", adkim: "s", aspf: "s" },
    "example.com",
  );
  assert.ok(
    strict.details?.some((line) => /DKIM alignment is strict/.test(line)),
  );
  assert.ok(
    strict.details?.some((line) => /SPF alignment is strict/.test(line)),
  );
});

test("describeDMARC flags external report destinations as unverifiable", () => {
  const external = describeDMARC(
    { ...BASE_DMARC, policy: "none", rua: "mailto:agg@reports.vendor.test" },
    "example.com",
  );
  assert.ok(
    external.unknowns?.some((line) => /reports\.vendor\.test/.test(line)),
    "an external report domain needs its authorization caveat",
  );

  const internal = describeDMARC(
    { ...BASE_DMARC, policy: "none", rua: "mailto:agg@example.com" },
    "example.com",
  );
  assert.equal(internal.unknowns?.length ?? 0, 0);
});

test("describeSPF names the authorized senders and the fate of everything else", () => {
  const summary = describeSPF(
    parseSPF("v=spf1 ip4:192.0.2.0/24 include:_spf.example.net ~all"),
    { hasContent: true, lookupEstimate: 1 },
  );

  assert.match(summary.headline, /the IPv4 range 192\.0\.2\.0\/24/);
  assert.match(summary.headline, /_spf\.example\.net's own SPF record/);
  assert.match(
    summary.headline,
    /marked suspicious but usually still delivered \(softfail\)/,
  );
  assert.ok(
    summary.unknowns?.some((line) => /can change without notice/.test(line)),
    "include: content is not knowable from the form",
  );
});

test("describeSPF distinguishes hard fail, neutral and the +all footgun", () => {
  const hard = describeSPF(parseSPF("v=spf1 mx -all"));
  assert.match(
    hard.headline,
    /the mail servers listed in this domain's MX records/,
  );
  assert.match(hard.headline, /rejected as a forgery \(fail\)/);

  const neutral = describeSPF(parseSPF("v=spf1 mx ?all"));
  assert.match(neutral.headline, /no verdict either way \(neutral\)/);

  const open = describeSPF(parseSPF("v=spf1 mx +all"));
  assert.match(open.headline, /disables SPF protection entirely/);
});

test("describeSPF explains redirect only when it can actually apply", () => {
  const used = describeSPF(
    parseSPF("v=spf1 ip4:192.0.2.1 redirect=_spf.example.net"),
  );
  assert.match(
    used.headline,
    /the SPF policy published at _spf\.example\.net is used/,
  );

  const shadowed = describeSPF(
    parseSPF("v=spf1 ip4:192.0.2.1 -all redirect=_spf.example.net"),
  );
  assert.ok(
    shadowed.details?.some((line) =>
      /is ignored while an all mechanism is present/.test(line),
    ),
  );
});

test("describeSPF reports lookup pressure and unreachable entries", () => {
  const overLimit = describeSPF(parseSPF("v=spf1 mx -all"), {
    lookupEstimate: 12,
  });
  assert.ok(
    overLimit.details?.some((line) => /over the limit of 10/.test(line)),
  );

  const dead = describeSPF(parseSPF("v=spf1 -all include:_spf.example.net"));
  assert.ok(
    dead.details?.some((line) => /never be evaluated/.test(line)),
    "entries after all must be called out as dead",
  );
});

test("describeSPF describes an empty and an unparseable record without guessing", () => {
  const empty = describeSPF(null);
  assert.match(empty.headline, /Will list the servers allowed to send mail/);
  assert.equal(empty.details, undefined);

  const broken = describeSPF(null, { hasContent: true });
  assert.match(broken.headline, /not a readable SPF record/);
});
