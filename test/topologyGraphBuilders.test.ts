import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEMO_RECORDS_BY_ZONE,
  PRIMARY_ZONE_ID,
} from "../e2e/fixtures/demo-workspace";
import {
  TOPOLOGY_NODE_LABEL_MAX_CHARS,
  TOPOLOGY_MERMAID_HTML_LABELS,
  TOPOLOGY_MERMAID_SECURITY_LEVEL,
} from "../src/components/dns/ZoneTopologyTab";
import {
  buildEmailTopologyMermaid,
  buildServicesTopologyMermaid,
  createTopologyNameResolver,
  type TopologyGraphInput,
} from "../src/components/dns/topologyGraphBuilders";
import {
  collectSpfTree,
  joinTxtStrings,
  parseDkim,
  parseDmarc,
  parseMxRecord,
  parseSpf,
  parseSrvRecord,
  parseTlsRpt,
} from "../src/components/dns/emailRecordParsers";
import type { DNSRecord } from "../src/types/dns";

const ZONE = "harborline.test";
const demoRecords = DEMO_RECORDS_BY_ZONE[PRIMARY_ZONE_ID] as DNSRecord[];

function makeRecord(
  id: string,
  type: string,
  name: string,
  content: string,
  extra: Partial<DNSRecord> = {},
): DNSRecord {
  return {
    id,
    type,
    name,
    content,
    ttl: 300,
    proxied: false,
    zone_id: "zone-test",
    zone_name: ZONE,
    created_on: "2026-01-01T00:00:00Z",
    modified_on: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

function baseInput(
  records: DNSRecord[],
  overrides: Partial<TopologyGraphInput> = {},
): TopologyGraphInput {
  return {
    zoneName: ZONE,
    records,
    resolveName: createTopologyNameResolver(records),
    isDarkTheme: false,
    ...overrides,
  };
}

function nodeLabels(code: string): string[] {
  return Array.from(code.matchAll(/^\s+\w+\["([^"]*)"\]:::\w+$/gm)).map(
    (m) => m[1],
  );
}

function nodeIds(code: string): string[] {
  return Array.from(code.matchAll(/^\s+(\w+)\["[^"]*"\]:::\w+$/gm)).map(
    (m) => m[1],
  );
}

function edgeLines(code: string): string[] {
  return code.split("\n").filter((line) => /-->|\.->/.test(line));
}

function subgraphIds(code: string): string[] {
  return Array.from(code.matchAll(/^\s+subgraph (\w+)\[/gm)).map((m) => m[1]);
}

function assertStructuralInvariants(code: string): void {
  assert.ok(code.startsWith("flowchart LR\n"));
  for (const id of subgraphIds(code)) assert.match(id, /^[A-Za-z0-9_]+$/);
  for (const label of nodeLabels(code)) {
    assert.ok(
      label.length <= TOPOLOGY_NODE_LABEL_MAX_CHARS,
      `label too long: ${label}`,
    );
    assert.doesNotMatch(label, /[<>`\\]/);
  }
  const lines = code.split("\n");
  const firstEdge = lines.findIndex((line) => /-->|\.->/.test(line));
  const lastNode = lines.reduce(
    (last, line, index) => (/^\s+\w+\["/.test(line) ? index : last),
    -1,
  );
  if (firstEdge >= 0) {
    assert.ok(lastNode < firstEdge, "all nodes declared before first edge");
  }
  const declared = new Set([...nodeIds(code), ...subgraphIds(code)]);
  for (const edge of edgeLines(code)) {
    const match = /^\s+(\w+) .*?(\w+)$/.exec(edge);
    assert.ok(match, `unparseable edge ${edge}`);
    assert.ok(declared.has(match[1]), `edge source undeclared: ${edge}`);
    assert.ok(declared.has(match[2]), `edge target undeclared: ${edge}`);
  }
  assert.ok(edgeLines(code).length === new Set(edgeLines(code)).size);
  assert.match(code, /classDef policy /);
  assert.match(code, /classDef disabled /);
}

async function parseWithMermaid(code: string): Promise<void> {
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: TOPOLOGY_MERMAID_SECURITY_LEVEL,
    flowchart: { htmlLabels: TOPOLOGY_MERMAID_HTML_LABELS },
  });
  const result = await mermaid.parse(code);
  assert.ok(result, "mermaid.parse accepted the diagram");
  assert.equal(result && result.diagramType, "flowchart-v2");
}

test("demo fixture carries the e-mail records the graph relies on", () => {
  assert.ok(demoRecords.some((r) => r.type === "MX"));
  assert.ok(demoRecords.some((r) => r.name.startsWith("_dmarc.")));
  assert.ok(demoRecords.some((r) => r.name.includes("._domainkey.")));
  assert.ok(demoRecords.some((r) => r.content.startsWith("v=spf1")));
});

test("parsers: SPF multi-string, redirect, includes, qualifiers", () => {
  assert.equal(
    joinTxtStrings('"v=spf1 inc" "lude:_spf.a.test -all"'),
    "v=spf1 include:_spf.a.test -all",
  );
  const spf = parseSpf(
    '"v=spf1 ip4:198.51.100.0/24 include:_spf.a.test ~include:_spf.b.test a mx:mail.c.test redirect=_spf.d.test"',
  );
  assert.ok(spf.valid);
  assert.deepEqual(
    spf.mechanisms.map((m) => `${m.qualifier}${m.type}:${m.value}`),
    [
      "+ip4:198.51.100.0/24",
      "+include:_spf.a.test",
      "~include:_spf.b.test",
      "+a:",
      "+mx:mail.c.test",
    ],
  );
  assert.equal(spf.redirect, "_spf.d.test");
  assert.equal(spf.allQualifier, null);
  assert.equal(spf.lookupTerms, 5);
  assert.equal(parseSpf("v=spf1 -all").allQualifier, "-");
  assert.equal(parseSpf("v=DMARC1; p=none").valid, false);
});

test("parsers: SPF include tree stays inside the zone and depth <= 2", () => {
  const txt = new Map<string, string>([
    ["z.test", "v=spf1 include:l1.z.test include:ext.example -all"],
    ["l1.z.test", "v=spf1 include:l2.z.test -all"],
    ["l2.z.test", "v=spf1 include:l3.z.test -all"],
    ["l3.z.test", "v=spf1 include:z.test -all"],
  ]);
  const tree = collectSpfTree("z.test", (n) => txt.get(n));
  assert.ok(tree);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].name, "l1.z.test");
  assert.equal(tree.children[0].children[0].name, "l2.z.test");
  assert.equal(tree.children[0].children[0].children.length, 0);
});

test("parsers: DKIM, DMARC, TLS-RPT, MX and SRV shapes", () => {
  const dkim = parseDkim("v=DKIM1; k=rsa; t=y; p=MIIB");
  assert.deepEqual(
    [dkim.valid, dkim.keyType, dkim.hasPublicKey, dkim.revoked, dkim.testing],
    [true, "rsa", true, false, true],
  );
  assert.equal(parseDkim("v=DKIM1; p=").revoked, true);
  const dmarc = parseDmarc(
    "v=DMARC1; p=reject; sp=quarantine; pct=50; rua=mailto:a@x.test!10m,mailto:b@x.test; ruf=mailto:f@x.test",
  );
  assert.deepEqual(
    [dmarc.policy, dmarc.subdomainPolicy, dmarc.percent, dmarc.rua, dmarc.ruf],
    ["reject", "quarantine", 50, ["a@x.test", "b@x.test"], ["f@x.test"]],
  );
  assert.deepEqual(
    parseTlsRpt("v=TLSRPTv1; rua=mailto:t@x.test,https://r.x.test/v1"),
    {
      valid: true,
      rua: ["t@x.test"],
      ruaUrls: ["https://r.x.test/v1"],
    },
  );
  assert.deepEqual(parseMxRecord({ content: "10 mx.a.test." }), {
    priority: 10,
    target: "mx.a.test",
  });
  assert.deepEqual(parseMxRecord({ content: "mx.a.test", priority: 20 }), {
    priority: 20,
    target: "mx.a.test",
  });
  assert.deepEqual(parseSrvRecord({ content: "10 0 993 imap.a.test" }), {
    priority: 10,
    weight: 0,
    port: 993,
    target: "imap.a.test",
  });
});

test("email graph: MX hosts, SPF includes, DKIM, DMARC, policy and clients from the demo zone", async () => {
  const result = buildEmailTopologyMermaid(baseInput(demoRecords));
  const { code, summary, nodeMetaById } = result;
  assert.equal(result.isEmpty, false);
  assertStructuralInvariants(code);
  assert.deepEqual(subgraphIds(code), ["inbound", "auth", "policy", "clients"]);

  // Every MX target is a node with an `MX <prio>` edge.
  const labels = nodeLabels(code);
  for (const target of ["mx01.mailrelay.test", "mx02.mailrelay.test"]) {
    assert.ok(
      labels.some((l) => l.startsWith(target)),
      `${target} node`,
    );
  }
  assert.match(code, /-- "MX 10" --> n_\d+/);
  assert.match(code, /-- "MX 20" --> n_\d+/);
  assert.deepEqual(
    summary?.mxHosts.map((m) => `${m.target}:${m.priorities.join(",")}`),
    ["mx01.mailrelay.test:10", "mx02.mailrelay.test:20"],
  );

  // SPF includes become nodes with labelled edges; ip4 becomes an IP node.
  assert.ok(labels.some((l) => l.startsWith("SPF — -all (hard fail)")));
  assert.ok(labels.some((l) => l.startsWith("_spf.mailrelay.test")));
  assert.ok(labels.some((l) => l.startsWith("_spf.ticketing.test")));
  assert.ok(labels.some((l) => l.startsWith("198.51.100.0/24")));
  assert.equal((code.match(/-- "SPF include" -->/g) ?? []).length, 2);
  assert.match(code, /-- "SPF ip4" -->/);
  assert.deepEqual(summary?.spf.includes, [
    "_spf.mailrelay.test",
    "_spf.ticketing.test",
  ]);

  // DKIM: TXT selector + CNAME selector -> target.
  assert.deepEqual(summary?.dkimSelectors.sort(), ["default", "s1"]);
  assert.ok(labels.some((l) => l.startsWith("DKIM s1 — CNAME")));
  assert.ok(
    labels.some((l) => l.startsWith("DKIM default — rsa · key present")),
  );
  assert.ok(labels.some((l) => l.startsWith("s1.dkim.mailrelay.test")));
  assert.match(code, /-- "DKIM" -->/);

  // DMARC parsed into a policy node with rua report node.
  assert.deepEqual(summary?.dmarc, {
    present: true,
    policy: "reject",
    subdomainPolicy: "reject",
    percent: 100,
    rua: ["dmarc-agg@harborline.test"],
  });
  assert.ok(labels.some((l) => l.startsWith("DMARC — p=reject · sp=reject")));
  assert.match(code, /-- "DMARC rua" -->/);

  // Transport & reporting and client autodiscovery.
  assert.equal(summary?.mtaSts, true);
  assert.equal(summary?.tlsRpt, true);
  assert.equal(summary?.bimi, false);
  assert.ok(labels.some((l) => l.startsWith("MTA-STS — id 20260114T120000Z")));
  assert.match(code, /-- "TLS-RPT rua" -->/);
  assert.match(code, /-- "SRV :443" -->/);
  assert.ok(labels.some((l) => l.startsWith("autoconfig.harborline.test")));
  assert.equal(summary?.clientEndpoints, 2);

  // No service-only hosts, and one zone edge per group (no hub fan-out).
  for (const host of [
    "www.harborline.test",
    "api.harborline.test",
    "docs.harborline.test",
    "_sip._tls",
  ]) {
    assert.ok(!labels.some((l) => l.startsWith(host)), `${host} absent`);
  }
  const zoneEdges = edgeLines(code).filter((l) => /^\s+zone_root /.test(l));
  assert.deepEqual(
    zoneEdges.map((l) => l.trim()),
    [
      "zone_root --> inbound",
      "zone_root --> auth",
      "zone_root --> policy",
      "zone_root --> clients",
    ],
  );

  // Metadata: record nodes carry recordId for editing; every node has meta.
  for (const id of nodeIds(code)) assert.ok(nodeMetaById[id], `meta for ${id}`);
  const dmarcRecord = demoRecords.find(
    (r) => r.name === "_dmarc.harborline.test",
  )!;
  assert.ok(
    Object.values(nodeMetaById).some((m) => m.recordId === dmarcRecord.id),
  );
  await parseWithMermaid(code);
});

test("email graph: Email Routing rules produce forward/worker/drop edges, disabled rules dotted", async () => {
  const records = demoRecords.filter((r) => r.type === "MX");
  const result = buildEmailTopologyMermaid(
    baseInput(records, {
      emailRouting: {
        settings: { enabled: true },
        rules: [
          {
            id: "r2",
            name: "sales",
            enabled: true,
            priority: 2,
            matchers: [
              { type: "literal", field: "to", value: "sales@harborline.test" },
            ],
            actions: [
              {
                type: "forward",
                value: ["team@example.net", "boss@example.net"],
              },
            ],
          },
          {
            id: "r1",
            enabled: false,
            priority: 1,
            matchers: [
              { type: "literal", field: "to", value: "old@harborline.test" },
            ],
            actions: [{ type: "drop" }],
          },
          {
            id: "r3",
            enabled: true,
            priority: 3,
            matchers: [{ type: "all" }],
            actions: [{ type: "worker", value: ["mail-router"] }],
          },
        ],
      },
    }),
  );
  const { code } = result;
  assertStructuralInvariants(code);
  assert.ok(subgraphIds(code).includes("routing"));
  assert.equal((code.match(/-- "forward" -->/g) ?? []).length, 2);
  assert.match(code, /-- "worker" --> n_\d+/);
  assert.match(code, /-\. "drop" \.-> n_\d+/);
  assert.match(code, /-\. "rule" \.-> n_\d+/);
  assert.match(code, /to=old@harborline\.test — disabled"\]:::disabled/);
  assert.match(code, /\["Catch-all"\]:::record/);
  assert.equal(result.summary?.routingRules, 3);
  // Ordered by priority: rule r1 (prio 1) declared before r2.
  assert.ok(code.indexOf("to=old@") < code.indexOf("to=sales@"));
  await parseWithMermaid(code);

  const disabled = buildEmailTopologyMermaid(
    baseInput(records, {
      emailRouting: { settings: { enabled: false }, rules: [] },
    }),
  );
  assert.ok(!subgraphIds(disabled.code).includes("routing"));
});

test("email graph: MX-only zone with API-shaped priorities and mxTrails resolution", () => {
  const records = [
    makeRecord("mx-1", "MX", ZONE, "mail.ext.test", { priority: 5 }),
  ];
  const result = buildEmailTopologyMermaid(
    baseInput(records, {
      mxTrails: [
        {
          from: ZONE,
          priority: 5,
          target: "mail.ext.test",
          chain: ["mail.ext.test", "edge.ext.test"],
          terminal: "edge.ext.test",
          ipv4: ["192.0.2.9"],
          ipv6: [],
        },
      ],
    }),
  );
  assertStructuralInvariants(result.code);
  assert.match(result.code, /-- "MX 5" -->/);
  assert.match(result.code, /-\. "CNAME" \.->/);
  assert.match(result.code, /-\. "A" \.->/);
  assert.ok(nodeLabels(result.code).some((l) => l.startsWith("192.0.2.9")));
  assert.deepEqual(subgraphIds(result.code), ["inbound"]);
});

test("both builders return isEmpty for zones without matching records", () => {
  const web = [
    makeRecord("a-1", "A", `www.${ZONE}`, "203.0.113.5", { proxied: true }),
  ];
  const email = buildEmailTopologyMermaid(baseInput(web));
  assert.equal(email.isEmpty, true);
  assert.deepEqual(subgraphIds(email.code), []);
  assert.equal(edgeLines(email.code).length, 0);

  const mailOnly = demoRecords.filter(
    (r) => r.type === "MX" || r.name.startsWith("_dmarc."),
  );
  const services = buildServicesTopologyMermaid(baseInput(mailOnly));
  assert.equal(services.isEmpty, true);
  assert.deepEqual(subgraphIds(services.code), []);
  assert.equal(buildServicesTopologyMermaid(baseInput([])).isEmpty, true);
});

test("services graph: proxied/origins groups, platforms, workers, discovery, no email names", async () => {
  const records = [
    ...demoRecords,
    makeRecord("cf-1", "CNAME", `edge.${ZONE}`, "d111.cloudfront.net"),
    makeRecord("cf-2", "CNAME", `static.${ZONE}`, "d222.cloudfront.net"),
  ];
  const result = buildServicesTopologyMermaid(
    baseInput(records, {
      workerRoutes: [
        { id: "w1", pattern: `api.${ZONE}/*`, script: "api-gateway" },
        { id: "w2", pattern: "*.unrelated.test/*", script: "other" },
      ],
      discovery: [
        { service: `HTTPS (api.${ZONE})`, status: "up", details: "443 open" },
        { service: `HTTP (www.${ZONE})`, status: "down", details: "closed" },
        { service: "SMTP", status: "inferred", details: "MX records present" },
      ],
    }),
  );
  const { code, summary } = result;
  assert.equal(result.isEmpty, false);
  assertStructuralInvariants(code);
  assert.deepEqual(subgraphIds(code), [
    "proxied",
    "origins",
    "platforms",
    "workers",
  ]);

  // Proxied records sit inside `subgraph proxied`, DNS-only inside `origins`.
  const section = (id: string) => {
    const start = code.indexOf(`subgraph ${id}[`);
    const end = code.indexOf("\n  end", start);
    return code.slice(start, end);
  };
  assert.match(section("proxied"), /api\.harborline\.test — proxied · auto/);
  assert.match(section("proxied"), /docs\.harborline\.test — proxied/);
  assert.match(
    section("origins"),
    /vpn\.harborline\.test — dns-only · ttl 3600/,
  );
  assert.match(section("origins"), /status\.harborline\.test — dns-only/);
  assert.doesNotMatch(section("origins"), /api\.harborline\.test/);

  // Platforms: one provider node, two targets grouped under it.
  assert.deepEqual(summary?.platforms, [
    {
      name: "AWS CloudFront",
      targets: ["d111.cloudfront.net", "d222.cloudfront.net"],
    },
  ]);
  assert.equal((code.match(/AWS CloudFront — provider/g) ?? []).length, 1);
  assert.match(section("platforms"), /d111\.cloudfront\.net/);

  // Edge labels by type and workers.
  assert.match(code, /-- "CNAME" -->/);
  assert.match(code, /-- "A" -->/);
  assert.match(code, /-- "AAAA" -->/);
  assert.match(code, /-- "SRV :5061" -->/);
  assert.match(code, /-- "route" -->/);
  assert.match(code, /-- "script" --> n_\d+/);
  assert.ok(nodeLabels(code).some((l) => l.startsWith("api-gateway — Worker")));
  assert.equal(summary?.workerRoutes, 2);

  // Discovery: up solid, inferred dotted, down omitted.
  assert.match(code, /-- "up" --> n_\d+/);
  assert.match(code, /zone_root -\. "inferred" \.-> n_\d+/);
  assert.ok(!nodeLabels(code).some((l) => l.startsWith("HTTP —")));
  assert.equal(summary?.discovered, 2);

  // No email names in the services graph.
  for (const label of nodeLabels(code)) {
    assert.doesNotMatch(
      label,
      /_dmarc|_domainkey|_mta-sts|_smtp\._tls|mx0[12]\.mailrelay|autoconfig|_autodiscover/,
    );
  }
  // Shared IPs appear once.
  const ipDeclarations = code.match(/\["203\.0\.113\.10 — IP"\]/g) ?? [];
  assert.equal(ipDeclarations.length, 1);
  // One zone edge per entry group, no zone -> record edges.
  const zoneEdges = edgeLines(code).filter((l) => /^\s+zone_root -->/.test(l));
  assert.deepEqual(
    zoneEdges.map((l) => l.trim()),
    ["zone_root --> proxied", "zone_root --> origins"],
  );
  await parseWithMermaid(code);
});

test("services graph: unmatched worker routes are still reachable from the zone", () => {
  const result = buildServicesTopologyMermaid(
    baseInput([makeRecord("a-1", "A", `www.${ZONE}`, "203.0.113.5")], {
      workerRoutes: [{ id: "w", pattern: "*.other.test/*", script: "s" }],
    }),
  );
  assertStructuralInvariants(result.code);
  assert.match(result.code, /zone_root --> workers/);
});

test("builders respect node and edge limits and never emit unescaped labels", () => {
  const records: DNSRecord[] = [];
  for (let i = 0; i < 200; i += 1) {
    records.push(
      makeRecord(`a-${i}`, "A", `h${i}.${ZONE}`, `198.51.100.${i % 250}`, {
        proxied: i % 2 === 0,
      }),
    );
  }
  records.push(makeRecord("weird", "CNAME", `x"y<z>.${ZONE}`, 'evil"].test'));
  const result = buildServicesTopologyMermaid(baseInput(records));
  assert.equal(result.truncated, true);
  assert.ok(nodeIds(result.code).length <= 80);
  assert.ok(edgeLines(result.code).length <= 160);
  assertStructuralInvariants(result.code);
  const email = buildEmailTopologyMermaid(
    baseInput([
      makeRecord("t", "TXT", ZONE, 'v=spf1 include:bad"].test -all'),
      makeRecord(
        "d",
        "TXT",
        `_dmarc.${ZONE}`,
        "v=DMARC1; p=none; rua=mailto:x<y>@z.test",
      ),
    ]),
  );
  assertStructuralInvariants(email.code);
  assert.doesNotMatch(email.code, /bad"\]/);
});
