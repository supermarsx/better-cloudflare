import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNAPTR } from "../src/lib/dns/dns-parsers";
import { prepareCopiedDnsRecord } from "../src/lib/dns/record-copy";
import type { DNSRecord } from "../src/types/dns";

const SOURCE = "origin.example";
const TARGET = "target.test";

function dnsRecord(overrides: Partial<DNSRecord> = {}): DNSRecord {
  return {
    id: "record-id",
    type: "A",
    name: SOURCE,
    content: "192.0.2.10",
    comment: "preserve this comment",
    ttl: 300,
    priority: 10,
    proxied: false,
    zone_id: "source-zone-id",
    zone_name: SOURCE,
    created_on: "2026-01-01T00:00:00.000Z",
    modified_on: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

test("prepares a fresh mutation-only record and preserves defined metadata", () => {
  const input = Object.freeze(
    dnsRecord({
      type: "CNAME",
      name: `www.${SOURCE}`,
      content: `edge.${SOURCE}`,
      ttl: "auto",
    }),
  );
  const prepared = prepareCopiedDnsRecord(input, SOURCE, TARGET, true);

  assert.notStrictEqual(prepared, input);
  assert.deepEqual(prepared, {
    type: "CNAME",
    name: `www.${TARGET}`,
    content: `edge.${TARGET}`,
    comment: "preserve this comment",
    ttl: "auto",
    priority: 10,
    proxied: false,
  });
  assert.equal(input.name, `www.${SOURCE}`);
  assert.equal(input.content, `edge.${SOURCE}`);

  const withoutOptionals = prepareCopiedDnsRecord(
    dnsRecord({ comment: undefined, priority: undefined, proxied: undefined }),
    SOURCE,
    TARGET,
    true,
  );
  assert.deepEqual(Object.keys(withoutOptionals).sort(), [
    "content",
    "name",
    "ttl",
    "type",
  ]);
});

test("preserves name and content byte-for-byte when rewriting is unavailable", () => {
  const input = dnsRecord({
    type: "CNAME",
    name: `WWW.${SOURCE}.`,
    content: ` Edge.${SOURCE}. `,
  });
  const cases = [
    { source: SOURCE, target: TARGET, enabled: false },
    { source: SOURCE.toUpperCase(), target: `${SOURCE}.`, enabled: true },
    { source: "", target: TARGET, enabled: true },
    { source: "bad..zone", target: TARGET, enabled: true },
    { source: SOURCE, target: "bad target", enabled: true },
  ];

  for (const entry of cases) {
    const prepared = prepareCopiedDnsRecord(
      input,
      entry.source,
      entry.target,
      entry.enabled,
    );
    assert.equal(prepared.name, input.name);
    assert.equal(prepared.content, input.content);
  }
});

test("rewrites only owner apex and suffix boundaries", () => {
  const cases = [
    [SOURCE, TARGET],
    [`www.${SOURCE}`, `www.${TARGET}`],
    [`WWW.${SOURCE.toUpperCase()}`, `WWW.${TARGET}`],
    [`_sip._tcp.${SOURCE}.`, `_sip._tcp.${TARGET}.`],
    [`*.${SOURCE}.`, `*.${TARGET}.`],
    [`not${SOURCE}`, `not${SOURCE}`],
    [`foo.not${SOURCE}`, `foo.not${SOURCE}`],
    [`${SOURCE}.invalid`, `${SOURCE}.invalid`],
    ["www", "www"],
    ["@", "@"],
  ] as const;

  for (const [name, expected] of cases) {
    const prepared = prepareCopiedDnsRecord(
      dnsRecord({ name }),
      `${SOURCE.toUpperCase()}.`,
      `${TARGET}.`,
      true,
    );
    assert.equal(prepared.name, expected, name);
  }
});

test("rewrites whole-hostname record content and never address or external content", () => {
  for (const type of ["CNAME", "MX", "NS", "PTR", "DNAME", "ALIAS", "ANAME"]) {
    const prepared = prepareCopiedDnsRecord(
      dnsRecord({ type, content: `service.${SOURCE}.` }),
      SOURCE,
      TARGET,
      true,
    );
    assert.equal(prepared.content, `service.${TARGET}.`, type);
  }

  for (const [type, content] of [
    ["A", "192.0.2.20"],
    ["AAAA", "2001:db8::20"],
    ["CNAME", `not${SOURCE}`],
    ["MX", "mail.vendor.test"],
    ["NS", `https://host.${SOURCE}`],
  ] as const) {
    const prepared = prepareCopiedDnsRecord(
      dnsRecord({ type, content }),
      SOURCE,
      TARGET,
      true,
    );
    assert.equal(prepared.content, content, `${type}:${content}`);
  }
});

test("rewrites only valid SRV targets", () => {
  const cases = [
    {
      content: `10 20 443 service.${SOURCE}.`,
      expected: `10 20 443 service.${TARGET}.`,
      priority: undefined,
    },
    {
      content: `20\t443  service.${SOURCE}`,
      expected: `20\t443  service.${TARGET}`,
      priority: 10,
    },
    {
      content: `ten 20 443 service.${SOURCE}`,
      expected: `ten 20 443 service.${SOURCE}`,
      priority: undefined,
    },
    {
      content: `10 20 service.${SOURCE}`,
      expected: `10 20 service.${SOURCE}`,
      priority: undefined,
    },
    {
      content: `10 20 443 service.${SOURCE} extra`,
      expected: `10 20 443 service.${SOURCE} extra`,
      priority: undefined,
    },
    {
      content: "10 20 443 service.vendor.test",
      expected: "10 20 443 service.vendor.test",
      priority: undefined,
    },
  ];

  for (const entry of cases) {
    const prepared = prepareCopiedDnsRecord(
      dnsRecord({
        type: "SRV",
        content: entry.content,
        priority: entry.priority,
      }),
      SOURCE,
      TARGET,
      true,
    );
    assert.equal(prepared.content, entry.expected, entry.content);
  }
});

test("rewrites only valid HTTPS and SVCB target fields", () => {
  for (const type of ["HTTPS", "SVCB"]) {
    const content = `1 svc.${SOURCE}. alpn="h2 h3" port=443`;
    const prepared = prepareCopiedDnsRecord(
      dnsRecord({ type, content }),
      SOURCE,
      TARGET,
      true,
    );
    assert.equal(
      prepared.content,
      `1 svc.${TARGET}. alpn="h2 h3" port=443`,
      type,
    );
  }

  for (const content of [
    `bad svc.${SOURCE} alpn=h2`,
    "1",
    `1 svc.${SOURCE} =broken`,
    `1 svc.${SOURCE} alpn="unterminated`,
    "0 . no-default-alpn",
  ]) {
    const prepared = prepareCopiedDnsRecord(
      dnsRecord({ type: "SVCB", content }),
      SOURCE,
      TARGET,
      true,
    );
    assert.equal(prepared.content, content);
  }
});

test("rewrites only the NAPTR replacement field", () => {
  const input = `100 10 S SIP+D2U "" _sip._udp.${SOURCE}.`;
  const prepared = prepareCopiedDnsRecord(
    dnsRecord({ type: "NAPTR", content: input }),
    SOURCE,
    TARGET,
    true,
  );
  assert.equal(
    parseNAPTR(prepared.content).replacement,
    `_sip._udp.${TARGET}.`,
  );

  const regexp = `100 10 U E2U+sip "!^.*$!sip:user@${SOURCE}!" .`;
  assert.equal(
    prepareCopiedDnsRecord(
      dnsRecord({ type: "NAPTR", content: regexp }),
      SOURCE,
      TARGET,
      true,
    ).content,
    regexp,
  );

  for (const content of [
    `broken ${SOURCE}`,
    `100 broken S SIP+D2U "" _sip._udp.${SOURCE}`,
    '100 10 S SIP+D2U "" service.vendor.test',
  ]) {
    assert.equal(
      prepareCopiedDnsRecord(
        dnsRecord({ type: "NAPTR", content }),
        SOURCE,
        TARGET,
        true,
      ).content,
      content,
    );
  }
});

test("rewrites only URI authority, mail, and SIP domains", () => {
  const cases = [
    [
      `10 1 "https://api.${SOURCE}:8443/path/${SOURCE}?next=${SOURCE}"`,
      `10 1 "https://api.${TARGET}:8443/path/${SOURCE}?next=${SOURCE}"`,
    ],
    [
      `10 1 "https://user@api.${SOURCE}/resource"`,
      `10 1 "https://user@api.${TARGET}/resource"`,
    ],
    [
      `10 1 "mailto:user@${SOURCE}?subject=${SOURCE}"`,
      `10 1 "mailto:user@${TARGET}?subject=${SOURCE}"`,
    ],
    [
      `10 1 "sip:user@voice.${SOURCE}:5060;transport=tcp?subject=${SOURCE}"`,
      `10 1 "sip:user@voice.${TARGET}:5060;transport=tcp?subject=${SOURCE}"`,
    ],
    [
      `10 1 "https://vendor.test/path/${SOURCE}"`,
      `10 1 "https://vendor.test/path/${SOURCE}"`,
    ],
    [`10 1 "urn:${SOURCE}"`, `10 1 "urn:${SOURCE}"`],
    [`bad 1 "https://${SOURCE}"`, `bad 1 "https://${SOURCE}"`],
    [`10 1 "https://${SOURCE}`, `10 1 "https://${SOURCE}`],
  ] as const;

  for (const [content, expected] of cases) {
    const prepared = prepareCopiedDnsRecord(
      dnsRecord({ type: "URI", content }),
      SOURCE,
      TARGET,
      true,
    );
    assert.equal(prepared.content, expected, content);
  }
});

test("rewrites SPF domain-specs without changing external or unrelated terms", () => {
  const content =
    `v=spf1 ~include:${SOURCE} include:_spf.${SOURCE}. ` +
    `a:mail.${SOURCE}/24//64 mx:${SOURCE}//64 ` +
    `exists:%{ir}._spf.${SOURCE} redirect=${SOURCE} ` +
    `exp=explain.${SOURCE} include:vendor.test ip4:192.0.2.0/24 -all`;
  const expected =
    `v=spf1 ~include:${TARGET} include:_spf.${TARGET}. ` +
    `a:mail.${TARGET}/24//64 mx:${TARGET}//64 ` +
    `exists:%{ir}._spf.${TARGET} redirect=${TARGET} ` +
    `exp=explain.${TARGET} include:vendor.test ip4:192.0.2.0/24 -all`;

  for (const type of ["TXT", "SPF"]) {
    assert.equal(
      prepareCopiedDnsRecord(dnsRecord({ type, content }), SOURCE, TARGET, true)
        .content,
      expected,
      type,
    );
  }

  for (const value of [
    `verification=${SOURCE}`,
    `v=DKIM1; p=key-${SOURCE}`,
    `arbitrary prose mentioning ${SOURCE}`,
    `v=spf1 include: -all`,
    `v=spf1 include:not${SOURCE} -all`,
  ]) {
    assert.equal(
      prepareCopiedDnsRecord(
        dnsRecord({ type: "TXT", content: value }),
        SOURCE,
        TARGET,
        true,
      ).content,
      value,
    );
  }
});

test("rewrites only DMARC rua and ruf mailto domains", () => {
  const content =
    `v=DMARC1; p=reject; rua=mailto:agg@${SOURCE}, mailto:ext@vendor.test!10m; ` +
    `ruf=mailto:forensic@sub.${SOURCE}.; fo=1`;
  const expected =
    `v=DMARC1; p=reject; rua=mailto:agg@${TARGET}, mailto:ext@vendor.test!10m; ` +
    `ruf=mailto:forensic@sub.${TARGET}.; fo=1`;
  assert.equal(
    prepareCopiedDnsRecord(
      dnsRecord({ type: "TXT", content }),
      SOURCE,
      TARGET,
      true,
    ).content,
    expected,
  );

  for (const value of [
    `v=DMARC1; p=none; rua=mailto:missing-at-${SOURCE}`,
    `v=DMARC1; p=none; rua=https://reports.vendor.test/${SOURCE}`,
    `v=DKIM1; rua=mailto:agg@${SOURCE}`,
  ]) {
    assert.equal(
      prepareCopiedDnsRecord(
        dnsRecord({ type: "TXT", content: value }),
        SOURCE,
        TARGET,
        true,
      ).content,
      value,
    );
  }
});

test("rewrites only the AFSDB hostname field", () => {
  const cases = [
    [`1 afs.${SOURCE}.`, `1 afs.${TARGET}.`],
    [`1 afs.${SOURCE}`, `1 afs.${TARGET}`],
    [`1 AFS.${SOURCE.toUpperCase()}.`, `1 AFS.${TARGET}.`],
    [`0 vendor.test`, `0 vendor.test`],
    [`1 not${SOURCE}`, `1 not${SOURCE}`],
    [`1 afs.notorigin.example`, `1 afs.notorigin.example`],
  ] as const;

  for (const [content, expected] of cases) {
    const prepared = prepareCopiedDnsRecord(
      dnsRecord({ type: "AFSDB", content }),
      SOURCE,
      TARGET,
      true,
    );
    assert.equal(prepared.content, expected, content);
  }

  for (const content of [
    `ten afs.${SOURCE}`,
    `70000 afs.${SOURCE}`,
    `1`,
    `1 afs.${SOURCE} extra`,
  ]) {
    assert.equal(
      prepareCopiedDnsRecord(
        dnsRecord({ type: "AFSDB", content }),
        SOURCE,
        TARGET,
        true,
      ).content,
      content,
      content,
    );
  }

  assert.equal(
    prepareCopiedDnsRecord(
      dnsRecord({ type: "AFSDB", content: `1 afs.${SOURCE}` }),
      SOURCE,
      TARGET,
      false,
    ).content,
    `1 afs.${SOURCE}`,
  );
});

test("rewrites RP mbox and txt domain fields, leaving '.' unspecified", () => {
  const cases = [
    [`admin.${SOURCE}. txt.${SOURCE}.`, `admin.${TARGET}. txt.${TARGET}.`],
    [`admin.${SOURCE} txt.${SOURCE}`, `admin.${TARGET} txt.${TARGET}`],
    [
      `ADMIN.${SOURCE.toUpperCase()}. TXT.${SOURCE.toUpperCase()}.`,
      `ADMIN.${TARGET}. TXT.${TARGET}.`,
    ],
    [`admin.vendor.test txt.vendor.test`, `admin.vendor.test txt.vendor.test`],
    [
      `admin.notorigin.example txt.notorigin.example`,
      `admin.notorigin.example txt.notorigin.example`,
    ],
    [`. txt.${SOURCE}.`, `. txt.${TARGET}.`],
    [`admin.${SOURCE}. .`, `admin.${TARGET}. .`],
    [`. .`, `. .`],
  ] as const;

  for (const [content, expected] of cases) {
    const prepared = prepareCopiedDnsRecord(
      dnsRecord({ type: "RP", content }),
      SOURCE,
      TARGET,
      true,
    );
    assert.equal(prepared.content, expected, content);
  }

  for (const content of [
    `admin.${SOURCE}.`,
    `admin.${SOURCE}. txt.${SOURCE}. extra`,
    `admin..bad txt.${SOURCE}`,
  ]) {
    assert.equal(
      prepareCopiedDnsRecord(
        dnsRecord({ type: "RP", content }),
        SOURCE,
        TARGET,
        true,
      ).content,
      content,
      content,
    );
  }

  assert.equal(
    prepareCopiedDnsRecord(
      dnsRecord({ type: "RP", content: `admin.${SOURCE}. txt.${SOURCE}.` }),
      SOURCE,
      TARGET,
      false,
    ).content,
    `admin.${SOURCE}. txt.${SOURCE}.`,
  );
});

function copyContent(
  type: string,
  content: string,
  options: { source?: string; target?: string; enabled?: boolean } = {},
): string {
  return prepareCopiedDnsRecord(
    dnsRecord({ type, content }),
    options.source ?? SOURCE,
    options.target ?? TARGET,
    options.enabled ?? true,
  ).content;
}

const SPF_BARE = `v=spf1 include:_spf.${SOURCE} ~all`;
const SPF_BARE_REWRITTEN = `v=spf1 include:_spf.${TARGET} ~all`;
const DMARC_BARE = `v=DMARC1; p=none; rua=mailto:agg@${SOURCE}`;
const DMARC_BARE_REWRITTEN = `v=DMARC1; p=none; rua=mailto:agg@${TARGET}`;

/** Every presentation form save-time normalization can hand back to a copy. */
const SPF_PRESENTATION_FORMS = [
  { label: "bare", content: SPF_BARE, expected: SPF_BARE_REWRITTEN },
  {
    label: "quoted",
    content: `"${SPF_BARE}"`,
    expected: `"${SPF_BARE_REWRITTEN}"`,
  },
  {
    label: "adjacent quoted strings",
    content: `"v=spf1 include:_spf.${SOURCE}" " ~all"`,
    expected: `"${SPF_BARE_REWRITTEN}"`,
  },
  {
    label: "unbalanced leading quote",
    content: `"${SPF_BARE}`,
    expected: `"${SPF_BARE_REWRITTEN}"`,
  },
  {
    label: "unbalanced trailing quote",
    content: `${SPF_BARE}"`,
    expected: `"${SPF_BARE_REWRITTEN}"`,
  },
  {
    label: "escaped inner quotes",
    content: `"v=spf1 include:_spf.${SOURCE} note=\\"x\\" ~all"`,
    expected: `"v=spf1 include:_spf.${TARGET} note=\\"x\\" ~all"`,
  },
] as const;

const DMARC_PRESENTATION_FORMS = [
  { label: "bare", content: DMARC_BARE, expected: DMARC_BARE_REWRITTEN },
  {
    label: "quoted",
    content: `"${DMARC_BARE}"`,
    expected: `"${DMARC_BARE_REWRITTEN}"`,
  },
  {
    label: "adjacent quoted strings",
    content: `"v=DMARC1; p=none; " "rua=mailto:agg@${SOURCE}"`,
    expected: `"${DMARC_BARE_REWRITTEN}"`,
  },
  {
    label: "unbalanced leading quote",
    content: `"${DMARC_BARE}`,
    expected: `"${DMARC_BARE_REWRITTEN}"`,
  },
  {
    label: "unbalanced trailing quote",
    content: `${DMARC_BARE}"`,
    expected: `"${DMARC_BARE_REWRITTEN}"`,
  },
  {
    label: "escaped inner quotes",
    content: `"v=DMARC1; p=none; rua=mailto:agg@${SOURCE}; sp=\\"none\\""`,
    expected: `"v=DMARC1; p=none; rua=mailto:agg@${TARGET}; sp=\\"none\\""`,
  },
] as const;

test("rewrites SPF domain-specs in every character-string presentation form", () => {
  for (const type of ["TXT", "SPF"]) {
    for (const form of SPF_PRESENTATION_FORMS) {
      assert.equal(
        copyContent(type, form.content),
        form.expected,
        `${type}:${form.label}`,
      );
    }
  }
});

test("rewrites DMARC report addresses in every character-string presentation form", () => {
  for (const form of DMARC_PRESENTATION_FORMS) {
    assert.equal(copyContent("TXT", form.content), form.expected, form.label);
  }
});

test("copying preserves the quoting style of character-string content", () => {
  // Bare in, bare out: the rewrite never introduces quoting of its own.
  for (const bare of [SPF_BARE, DMARC_BARE]) {
    const prepared = copyContent("TXT", bare);
    assert.equal(prepared.includes('"'), false, bare);
    assert.notEqual(prepared, bare);
  }

  // Quoted in, quoted out: the payload stays one <character-string>.
  for (const form of [...SPF_PRESENTATION_FORMS, ...DMARC_PRESENTATION_FORMS]) {
    if (form.label === "bare") continue;
    const prepared = copyContent("TXT", form.content);
    assert.ok(prepared.startsWith('"'), form.label);
    assert.ok(prepared.endsWith('"'), form.label);
  }

  // Splitting an over-long payload back into adjacent strings stays the job of
  // record-normalize, so a rewritten payload is emitted as a single string.
  const long = `v=spf1 ${`include:${"x".repeat(60)}.vendor.test `.repeat(4)}include:_spf.${SOURCE} ~all`;
  const preparedLong = copyContent("TXT", `"${long}"`);
  assert.ok(preparedLong.length > 255);
  assert.equal(preparedLong.indexOf('"', 1), preparedLong.length - 1);
});

test("leaves quoted character-string content byte-exact when it rewrites nothing", () => {
  const untouched = [
    // Out-of-zone domains.
    `"v=spf1 include:_spf.vendor.test ~all"`,
    `"v=DMARC1; p=none; rua=mailto:agg@vendor.test"`,
    // Domains that merely share a substring with the source zone.
    `"v=spf1 include:_spf.not${SOURCE} ~all"`,
    `"v=spf1 include:${SOURCE}.vendor.test ~all"`,
    `"v=DMARC1; p=none; rua=mailto:agg@not${SOURCE}"`,
    // Content that does not parse as SPF or DMARC at all.
    `"v=spf1 include: -all"`,
    `"v=DMARC1; p=none; rua=mailto:missing-at-${SOURCE}"`,
    `"verification=${SOURCE}"`,
    `"v=DKIM1; p=key-${SOURCE}"`,
    // Damaged quoting is repaired by record-normalize, never by the copy.
    `"v=spf1 include:_spf.vendor.test ~all`,
    `v=spf1 include:_spf.vendor.test ~all"`,
  ];

  for (const content of untouched) {
    assert.equal(copyContent("TXT", content), content, content);
    assert.equal(copyContent("SPF", content), content, `SPF:${content}`);
  }
});

test("copying character-string content is a no-op without a zone rewrite", () => {
  for (const form of [...SPF_PRESENTATION_FORMS, ...DMARC_PRESENTATION_FORMS]) {
    // Rewriting disabled.
    assert.equal(
      copyContent("TXT", form.content, { enabled: false }),
      form.content,
      `disabled:${form.label}`,
    );

    // Source and target are the same zone, spelled two different ways.
    for (const target of [SOURCE, `${SOURCE.toUpperCase()}.`]) {
      assert.equal(
        copyContent("TXT", form.content, { target }),
        form.content,
        `${target}:${form.label}`,
      );
    }
  }
});

test("copying inside one zone rewrites nothing", () => {
  const records = [
    dnsRecord({
      type: "CNAME",
      name: `www.${SOURCE}`,
      content: `edge.${SOURCE}`,
    }),
    dnsRecord({ type: "TXT", content: `v=spf1 include:_spf.${SOURCE} ~all` }),
    dnsRecord({
      type: "SRV",
      name: `_sip._tcp.${SOURCE}`,
      content: `10 5 443 service.${SOURCE}`,
    }),
  ];

  for (const source of records) {
    const prepared = prepareCopiedDnsRecord(source, SOURCE, SOURCE, true);
    assert.equal(prepared.name, source.name, source.type);
    assert.equal(prepared.content, source.content, source.type);

    // A trailing root dot and a case difference still mean "the same zone".
    const sameZone = prepareCopiedDnsRecord(
      source,
      SOURCE,
      `${SOURCE.toUpperCase()}.`,
      true,
    );
    assert.equal(sameZone.name, source.name, source.type);
    assert.equal(sameZone.content, source.content, source.type);
  }
});
