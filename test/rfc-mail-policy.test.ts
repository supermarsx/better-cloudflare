/**
 * Mail authentication policy semantics — SPF (RFC 7208) and DMARC (RFC 7489).
 *
 * Both policies are carried in TXT records whose payload is a
 * `<character-string>`, so the tests below deliberately exercise each policy in
 * every presentation shape a real zone contains it in: bare, quoted, and split
 * across adjacent quoted strings.
 *
 * The DMARC *tag* validator lives inside `DmarcBuilder.tsx`; this file covers
 * the DMARC surface reachable from `src/lib/dns/**` — the tag list surviving
 * import and cross-zone copy intact, which is where the semicolon truncation
 * bug destroyed policies.
 *
 * Domains are RFC 2606 reserved; addresses are RFC 5737 / RFC 3849.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { unquoteCharacterString } from "../src/lib/dns/character-string";
import { parseBINDZone } from "../src/lib/dns/dns-parsers";
import { normalizeRecordContent } from "../src/lib/dns/record-normalize";
import { prepareCopiedDnsRecord } from "../src/lib/dns/record-copy";
import {
  composeSPF,
  parseSPF,
  resetDnsResolver,
  setDnsResolverForTest,
  simulateSPF,
  validateSPF,
  validateSPFContentAsync,
  type DNSResolver,
} from "../src/lib/dns/spf";
import type { DNSRecord } from "../src/types/dns";

const SOURCE_ZONE = "origin.example";
const TARGET_ZONE = "target.test";

after(() => {
  resetDnsResolver();
});

/** A resolver that answers TXT from `zone` and nothing else. */
function txtResolver(zone: Record<string, string>): DNSResolver {
  return {
    resolveTxt: async (domain: string) =>
      zone[domain] === undefined ? [] : [[zone[domain]]],
    resolve4: async () => [],
    resolve6: async () => [],
    resolveMx: async () => [],
    reverse: async () => [],
  };
}

function record(overrides: Partial<DNSRecord>): DNSRecord {
  return {
    id: "record-id",
    type: "TXT",
    name: SOURCE_ZONE,
    content: "",
    ttl: 300,
    zone_id: "zone-id",
    zone_name: SOURCE_ZONE,
    created_on: "2026-01-01T00:00:00.000Z",
    modified_on: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("SPF mechanisms, qualifiers and modifiers parse per RFC 7208 §5 and §6", () => {
  // RFC 7208 §4.6.1: a term is either a mechanism or a "name=value" modifier.
  // §4.6.2: the qualifiers are "+" (pass), "-" (fail), "~" (softfail) and
  // "?" (neutral), with "+" implied when none is written.
  const parsed = parseSPF(
    "v=spf1 +mx a:mail.example.com ip4:192.0.2.0/24 ip6:2001:db8::/32 " +
      "~include:_spf.example.net ?exists:%{i}._spf.example.net -all",
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.mechanisms, [
    { qualifier: "+", mechanism: "mx", value: undefined },
    { qualifier: undefined, mechanism: "a", value: "mail.example.com" },
    { qualifier: undefined, mechanism: "ip4", value: "192.0.2.0/24" },
    { qualifier: undefined, mechanism: "ip6", value: "2001:db8::/32" },
    { qualifier: "~", mechanism: "include", value: "_spf.example.net" },
    {
      qualifier: "?",
      mechanism: "exists",
      value: "%{i}._spf.example.net",
    },
    { qualifier: "-", mechanism: "all", value: undefined },
  ]);

  // RFC 7208 §6.1 (redirect) and §6.2 (exp) are modifiers, not mechanisms, and
  // must not be evaluated in mechanism order.
  const withModifiers = parseSPF(
    "v=spf1 ip4:192.0.2.1 redirect=_spf.example.net exp=why.example.net",
  );
  assert.ok(withModifiers);
  assert.deepEqual(withModifiers.mechanisms, [
    { qualifier: undefined, mechanism: "ip4", value: "192.0.2.1" },
  ]);
  assert.deepEqual(withModifiers.modifiers, [
    { key: "redirect", value: "_spf.example.net" },
    { key: "exp", value: "why.example.net" },
  ]);

  // RFC 7208 §4.6.1: record and mechanism names are case-insensitive.
  const upper = parseSPF("V=SPF1 IP4:192.0.2.1 INCLUDE:_spf.example.net -ALL");
  assert.ok(upper);
  assert.deepEqual(
    upper.mechanisms.map((m) => m.mechanism),
    ["ip4", "include", "all"],
  );

  // Content that is not an SPF record at all is rejected outright (§4.5).
  for (const content of [
    "v=DMARC1; p=none",
    "google-site-verification=abc",
    "spf1 -all",
    "",
    undefined,
  ]) {
    assert.equal(parseSPF(content), null, String(content));
  }
});

test("SPF parses identically bare, quoted, and split across adjacent strings", () => {
  // RFC 7208 §3.3: an SPF record longer than 255 octets is published as
  // multiple character-strings that the evaluator concatenates with no
  // separator before parsing.
  const logical = "v=spf1 ip4:192.0.2.0/24 include:_spf.example.net ~all";
  const shapes = [
    logical,
    `"${logical}"`,
    '"v=spf1 ip4:192.0.2.0/24 include:" "_spf.example.net ~all"',
    '"v=spf1 ip4:192.0.2.0/24" " include:_spf.example.net ~all"',
  ];

  for (const shape of shapes) {
    const parsed = parseSPF(shape);
    assert.ok(parsed, shape);
    assert.deepEqual(
      parsed.mechanisms.map((m) => `${m.qualifier ?? ""}${m.mechanism}`),
      ["ip4", "include", "~all"],
      shape,
    );
    assert.equal(composeSPF(parsed), logical, shape);
  }

  // A long SPF record normalizes into <=255 byte strings that re-parse the same.
  const long = `v=spf1 ${Array.from(
    { length: 30 },
    (_, index) => `ip4:192.0.2.${index}`,
  ).join(" ")} -all`;
  const normalized = normalizeRecordContent("TXT", long);
  assert.ok(normalized.split('" "').length > 1);
  assert.equal(unquoteCharacterString(normalized), long);
  assert.deepEqual(parseSPF(normalized), parseSPF(long));
});

test("SPF syntax validation flags unknown mechanisms and duplicate redirects", () => {
  const cases = [
    { content: "v=spf1 -all", ok: true },
    {
      content: "v=spf1 ip4:192.0.2.0/24 include:_spf.example.net ~all",
      ok: true,
    },
    { content: "v=spf1 a mx ptr exists:%{i}.example.net -all", ok: true },
    // Not a registered mechanism (RFC 7208 §5).
    { content: "v=spf1 frobnicate:x -all", ok: false },
    // RFC 7208 §5.6/§5.7: these mechanisms require a value.
    { content: "v=spf1 ip4 -all", ok: false },
    { content: "v=spf1 include -all", ok: false },
    { content: "v=spf1 exists -all", ok: false },
    // RFC 7208 §6.1: "there MUST be at most one redirect modifier".
    {
      content: "v=spf1 redirect=a.example.net redirect=b.example.net",
      ok: false,
    },
    // Missing the version prefix (RFC 7208 §4.5).
    { content: "include:_spf.example.net -all", ok: false },
  ] as const;

  for (const entry of cases) {
    assert.equal(validateSPF(entry.content).ok, entry.ok, entry.content);
  }

  assert.deepEqual(validateSPF("v=spf1 frobnicate:x -all").problems, [
    "unknown mechanism: frobnicate",
  ]);
  assert.deepEqual(
    validateSPF("v=spf1 redirect=a.example.net redirect=b.example.net")
      .problems,
    ["only one redirect modifier allowed"],
  );
});

test("SPF include chains over ten deep are rejected (RFC 7208 §4.6.4)", async () => {
  // RFC 7208 §4.6.4: "SPF implementations MUST limit the total number of
  // mechanisms and modifiers that do DNS lookups to at most 10 per SPF check."
  const zone: Record<string, string> = {};
  for (let index = 0; index < 12; index++) {
    zone[`inc${index}.example.net`] = "v=spf1 -all";
  }
  setDnsResolverForTest(txtResolver(zone));

  const includes = (count: number) =>
    `v=spf1 ${Array.from(
      { length: count },
      (_, index) => `include:inc${index}.example.net`,
    ).join(" ")} -all`;

  const atLimit = await validateSPFContentAsync(includes(10), "example.com");
  assert.equal(atLimit.graph.lookups, 10);
  assert.equal(atLimit.ok, true);
  assert.deepEqual(atLimit.problems, []);

  const overLimit = await validateSPFContentAsync(includes(11), "example.com");
  assert.equal(overLimit.graph.lookups, 11);
  assert.equal(overLimit.ok, false);
  assert.match(overLimit.problems.join(" "), /exceeds the 10 limit/u);
});

test("documents that a deeply nested include chain is truncated, not flagged", async () => {
  // GAP: RFC 7208 §4.6.4 counts lookups per check, so a chain of includes 11
  // deep must be rejected exactly like 11 includes side by side. `buildSPFGraph`
  // stops recursing at `maxDepth = 10` *before* the eleventh lookup is counted,
  // so the walk reports exactly 10 lookups and the record is reported as clean
  // no matter how deep the chain actually goes.
  const chainOf = (length: number) =>
    txtResolver(
      Object.fromEntries(
        Array.from({ length }, (_, index) => [
          `chain${index}.example.net`,
          index === length - 1
            ? "v=spf1 -all"
            : `v=spf1 include:chain${index + 1}.example.net -all`,
        ]),
      ),
    );

  for (const depth of [12, 20]) {
    setDnsResolverForTest(chainOf(depth));
    const nested = await validateSPFContentAsync(
      "v=spf1 include:chain0.example.net -all",
      "example.com",
    );
    assert.equal(nested.graph.lookups, 10, `depth ${depth}`);
    assert.equal(nested.ok, true, `depth ${depth}`);
  }
});

test("an SPF include cycle is reported instead of looping forever", async () => {
  // RFC 7208 §11.1 warns that processing loops must be bounded.
  setDnsResolverForTest(
    txtResolver({
      "a.example.net": "v=spf1 include:b.example.net -all",
      "b.example.net": "v=spf1 include:a.example.net -all",
    }),
  );

  const result = await validateSPFContentAsync(
    "v=spf1 include:a.example.net -all",
    "example.com",
  );
  assert.equal(result.graph.cyclic, true);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "SPF include/redirect graph contains a cycle",
  ]);
});

test("documents that the static validator only counts include and redirect", async () => {
  // GAP: RFC 7208 §4.6.4 counts the a, mx, ptr, exists, include and redirect
  // terms against the ten-lookup budget. `validateSPFContentAsync` walks an
  // include/redirect graph only, so a record with eleven `a:` terms — which a
  // conforming evaluator must reject with permerror — is reported as clean.
  // `simulateSPF` does count a/mx/ptr/exists (asserted in the next test), so
  // the shortfall is in the static validator, not in the evaluator.
  setDnsResolverForTest(txtResolver({}));

  const elevenATerms = `v=spf1 ${Array.from(
    { length: 11 },
    (_, index) => `a:h${index}.example.net`,
  ).join(" ")} -all`;
  const result = await validateSPFContentAsync(elevenATerms, "example.com");

  assert.equal(result.graph.lookups, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test("the SPF evaluator counts a, mx and include lookups and permerrors at the limit", async () => {
  // RFC 7208 §4.6.4: exceeding the ten-lookup budget is a permerror.
  const overBudget = `v=spf1 ${Array.from(
    { length: 11 },
    (_, index) => `a:h${index}.example.net`,
  ).join(" ")} -all`;
  setDnsResolverForTest(txtResolver({ "example.com": overBudget }));

  const result = await simulateSPF({ domain: "example.com", ip: "192.0.2.1" });
  assert.equal(result.result, "permerror");
  assert.ok(result.lookups > 10);
});

test("SPF qualifiers map onto the RFC 7208 §8 result codes", async () => {
  // §8.1 neutral, §8.2 pass, §8.3 fail, §8.4 softfail.
  const cases = [
    {
      record: "v=spf1 ip4:192.0.2.0/24 -all",
      ip: "192.0.2.10",
      result: "pass",
    },
    {
      record: "v=spf1 ip4:192.0.2.0/24 -all",
      ip: "198.51.100.1",
      result: "fail",
    },
    {
      record: "v=spf1 ip4:192.0.2.0/24 ~all",
      ip: "198.51.100.1",
      result: "softfail",
    },
    {
      record: "v=spf1 ip4:192.0.2.0/24 ?all",
      ip: "198.51.100.1",
      result: "neutral",
    },
    // No matching mechanism and no "all": RFC 7208 §4.7 default is neutral.
    {
      record: "v=spf1 ip4:192.0.2.0/24",
      ip: "198.51.100.1",
      result: "neutral",
    },
    // IPv6 (RFC 3849 documentation prefix) matched by an ip6 mechanism.
    {
      record: "v=spf1 ip6:2001:db8::/32 -all",
      ip: "2001:db8::1",
      result: "pass",
    },
  ] as const;

  for (const entry of cases) {
    setDnsResolverForTest(txtResolver({ "example.com": entry.record }));
    const result = await simulateSPF({ domain: "example.com", ip: entry.ip });
    assert.equal(result.result, entry.result, `${entry.record} @ ${entry.ip}`);
  }
});

test("a DMARC record keeps every tag through import, normalization and copy", () => {
  // RFC 7489 §6.4: DMARC RDATA is a semicolon-separated tag=value list carried
  // in a TXT record — the exact shape a naive comment stripper truncates at
  // "v=DMARC1".
  const policy =
    "v=DMARC1; p=reject; sp=quarantine; adkim=s; aspf=r; pct=100; " +
    "fo=1; rf=afrf; ri=86400; rua=mailto:agg@example.com; " +
    "ruf=mailto:forensic@example.com";

  const imported = parseBINDZone(
    `_dmarc.example.com. 3600 IN TXT "${policy}" ; exported 2026-08-07`,
  );
  assert.equal(imported.length, 1);
  assert.equal(imported[0].name, "_dmarc.example.com.");
  assert.equal(imported[0].content, `"${policy}"`);

  const saved = normalizeRecordContent("TXT", imported[0].content);
  assert.equal(unquoteCharacterString(saved), policy);

  // Every RFC 7489 §6.3 tag is still present and still carries its value.
  const tags = new Map(
    unquoteCharacterString(saved)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return [
          part.slice(0, separator).toLowerCase(),
          part.slice(separator + 1),
        ] as const;
      }),
  );
  assert.deepEqual(
    [...tags.keys()],
    ["v", "p", "sp", "adkim", "aspf", "pct", "fo", "rf", "ri", "rua", "ruf"],
  );
  assert.equal(tags.get("v"), "DMARC1");
  assert.equal(tags.get("p"), "reject");
  assert.equal(tags.get("sp"), "quarantine");
  assert.equal(tags.get("pct"), "100");
  assert.equal(tags.get("rua"), "mailto:agg@example.com");
});

test("DMARC report addresses are rewritten on a cross-zone copy, policy tags are not", () => {
  // RFC 7489 §6.3: rua/ruf are comma-separated DMARC URIs. Only the domain part
  // of a mailto: URI is a reference to the zone being copied.
  const cases = [
    {
      before: `v=DMARC1; p=reject; rua=mailto:agg@${SOURCE_ZONE}`,
      after: `v=DMARC1; p=reject; rua=mailto:agg@${TARGET_ZONE}`,
    },
    {
      before: `v=DMARC1; p=none; rua=mailto:a@${SOURCE_ZONE},mailto:b@${SOURCE_ZONE}`,
      after: `v=DMARC1; p=none; rua=mailto:a@${TARGET_ZONE},mailto:b@${TARGET_ZONE}`,
    },
    {
      // RFC 7489 §6.3 allows a "!size" suffix on a report URI.
      before: `v=DMARC1; p=reject; ruf=mailto:f@${SOURCE_ZONE}!10m`,
      after: `v=DMARC1; p=reject; ruf=mailto:f@${TARGET_ZONE}!10m`,
    },
    {
      // A third-party reporting address is outside the zone and must not move.
      before: `v=DMARC1; p=reject; rua=mailto:agg@reports.example.net`,
      after: `v=DMARC1; p=reject; rua=mailto:agg@reports.example.net`,
    },
  ] as const;

  for (const entry of cases) {
    for (const shape of [(v: string) => v, (v: string) => `"${v}"`]) {
      const prepared = prepareCopiedDnsRecord(
        record({ name: `_dmarc.${SOURCE_ZONE}`, content: shape(entry.before) }),
        SOURCE_ZONE,
        TARGET_ZONE,
        true,
      );
      assert.equal(prepared.name, `_dmarc.${TARGET_ZONE}`);
      assert.equal(
        unquoteCharacterString(prepared.content),
        entry.after,
        entry.before,
      );
      // Policy tags are never touched by the rewrite.
      assert.match(unquoteCharacterString(prepared.content), /v=DMARC1;/u);
    }
  }
});

test("SPF include and redirect targets are rewritten on a cross-zone copy", () => {
  // The SPF equivalent of the DMARC case above: a copied record that still
  // points at the source zone silently authorises the wrong senders.
  const cases = [
    {
      before: `v=spf1 include:_spf.${SOURCE_ZONE} ~all`,
      after: `v=spf1 include:_spf.${TARGET_ZONE} ~all`,
    },
    {
      before: `v=spf1 redirect=_spf.${SOURCE_ZONE}`,
      after: `v=spf1 redirect=_spf.${TARGET_ZONE}`,
    },
    {
      before: `v=spf1 a:mail.${SOURCE_ZONE}/24 mx:mx.${SOURCE_ZONE} -all`,
      after: `v=spf1 a:mail.${TARGET_ZONE}/24 mx:mx.${TARGET_ZONE} -all`,
    },
    {
      // ip4 literals are addresses, not zone references.
      before: "v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all",
      after: "v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all",
    },
    {
      // A third-party include is outside the zone and must not move.
      before: "v=spf1 include:_spf.example.net -all",
      after: "v=spf1 include:_spf.example.net -all",
    },
  ] as const;

  for (const entry of cases) {
    for (const type of ["TXT", "SPF"]) {
      for (const shape of [(v: string) => v, (v: string) => `"${v}"`]) {
        const prepared = prepareCopiedDnsRecord(
          record({ type, content: shape(entry.before) }),
          SOURCE_ZONE,
          TARGET_ZONE,
          true,
        );
        assert.equal(
          unquoteCharacterString(prepared.content),
          entry.after,
          `${type}: ${entry.before}`,
        );
      }
    }
  }
});
