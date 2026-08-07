/**
 * Seeded demo data for the documentation screenshot harness.
 *
 * Everything in this file is fictional. It describes an invented company
 * ("Harborline Freight Systems") and uses only names and addresses that are
 * reserved for documentation and testing:
 *
 * - domains use the RFC 2606 `.test` TLD, so nothing resolves anywhere;
 * - IPv4 addresses come from the RFC 5737 documentation blocks
 *   192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24;
 * - IPv6 addresses come from the RFC 3849 documentation block 2001:db8::/32;
 * - there are no real API keys, tokens, credentials or mailboxes.
 *
 * The data is intentionally plain JSON so the screenshot script can hand it
 * straight to `page.addInitScript(fn, data)`, which structured-clones its
 * argument into the page.
 */

import * as panels from "./demo-panels.js";

/** Shape returned by the native `get_zones` command. */
export interface DemoZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  development_mode: number;
  name_servers: string[];
}

/** Shape returned by the native `get_dns_records` command. */
export interface DemoRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  comment?: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
  zone_id: string;
  zone_name: string;
  created_on: string;
  modified_on: string;
}

/** Fixed timestamps keep every regenerated screenshot byte-comparable. */
const CREATED_ON = "2025-03-04T09:12:00.000Z";
const MODIFIED_ON = "2026-06-18T14:41:00.000Z";

export const PRIMARY_ZONE_ID = "zone-harborline";

export const DEMO_ZONES: DemoZone[] = [
  {
    id: PRIMARY_ZONE_ID,
    name: "harborline.test",
    status: "active",
    paused: false,
    type: "full",
    development_mode: 0,
    name_servers: ["arla.ns.example.net", "bex.ns.example.net"],
  },
  {
    id: "zone-harborline-cdn",
    name: "harborlinecdn.test",
    status: "active",
    paused: false,
    type: "full",
    development_mode: 0,
    name_servers: ["arla.ns.example.net", "bex.ns.example.net"],
  },
  {
    id: "zone-shipwright",
    name: "shipwright.test",
    status: "active",
    paused: false,
    type: "full",
    development_mode: 0,
    name_servers: ["arla.ns.example.net", "bex.ns.example.net"],
  },
  {
    id: "zone-harborline-labs",
    name: "harborline-labs.test",
    status: "active",
    paused: false,
    type: "full",
    development_mode: 0,
    name_servers: ["arla.ns.example.net", "bex.ns.example.net"],
  },
];

type RecordSeed = Omit<
  DemoRecord,
  "id" | "zone_id" | "zone_name" | "created_on" | "modified_on"
>;

function buildRecords(
  zoneId: string,
  zoneName: string,
  seeds: RecordSeed[],
): DemoRecord[] {
  return seeds.map((seed, index) => ({
    ...seed,
    id: `${zoneId}-rec-${String(index + 1).padStart(2, "0")}`,
    zone_id: zoneId,
    zone_name: zoneName,
    created_on: CREATED_ON,
    modified_on: MODIFIED_ON,
  }));
}

const HARBORLINE_SEEDS: RecordSeed[] = [
  // --- Apex and edge ------------------------------------------------------
  {
    type: "A",
    name: "harborline.test",
    content: "203.0.113.10",
    ttl: 1,
    proxied: true,
    comment: "Apex origin, pool iad-01",
  },
  {
    type: "AAAA",
    name: "harborline.test",
    content: "2001:db8:41d0:2::10",
    ttl: 1,
    proxied: true,
    comment: "IPv6 parity for the apex",
  },
  {
    type: "A",
    name: "www.harborline.test",
    content: "203.0.113.10",
    ttl: 1,
    proxied: true,
    comment: "Marketing site, apex mirror",
  },
  {
    type: "AAAA",
    name: "www.harborline.test",
    content: "2001:db8:41d0:2::10",
    ttl: 1,
    proxied: true,
    comment: "IPv6 parity for www",
  },
  {
    type: "A",
    name: "app.harborline.test",
    content: "203.0.113.20",
    ttl: 1,
    proxied: true,
    comment: "Shipper console (blue/green)",
  },
  {
    type: "A",
    name: "api.harborline.test",
    content: "203.0.113.21",
    ttl: 1,
    proxied: true,
    comment: "Public REST gateway",
  },
  {
    type: "AAAA",
    name: "api.harborline.test",
    content: "2001:db8:41d0:2::21",
    ttl: 1,
    proxied: true,
    comment: "IPv6 parity for the API",
  },
  {
    type: "A",
    name: "admin.harborline.test",
    content: "203.0.113.22",
    ttl: 300,
    proxied: true,
    comment: "Back office, SSO enforced",
  },
  {
    type: "A",
    name: "ingest.harborline.test",
    content: "198.51.100.40",
    ttl: 300,
    proxied: false,
    comment: "gRPC ingest, keep unproxied",
  },
  {
    type: "A",
    name: "vpn.harborline.test",
    content: "198.51.100.12",
    ttl: 3600,
    proxied: false,
    comment: "WireGuard, keep unproxied",
  },
  {
    type: "A",
    name: "build.harborline.test",
    content: "198.51.100.77",
    ttl: 300,
    proxied: false,
    comment: "CI runner coordinator",
  },
  {
    type: "A",
    name: "metrics.harborline.test",
    content: "198.51.100.61",
    ttl: 1,
    proxied: true,
    comment: "Grafana, behind SSO",
  },
  {
    type: "A",
    name: "legacy.harborline.test",
    content: "192.0.2.44",
    ttl: 900,
    proxied: false,
    comment: "Retire after 2026-09-30",
  },

  // --- Aliases ------------------------------------------------------------
  {
    type: "CNAME",
    name: "docs.harborline.test",
    content: "harborline-docs.pages.test",
    ttl: 1,
    proxied: true,
    comment: "Docs site, deploys from main",
  },
  {
    type: "CNAME",
    name: "cdn.harborline.test",
    content: "assets.harborlinecdn.test",
    ttl: 1,
    proxied: true,
    comment: "Asset host, long cache rules",
  },
  {
    type: "CNAME",
    name: "status.harborline.test",
    content: "harborline.statuspage.test",
    ttl: 300,
    proxied: false,
    comment: "Proxy breaks vendor TLS",
  },
  {
    type: "CNAME",
    name: "shop.harborline.test",
    content: "storefront.commerce.test",
    ttl: 3600,
    proxied: false,
    comment: "Storefront wants DNS-only",
  },
  {
    type: "CNAME",
    name: "autoconfig.harborline.test",
    content: "autoconfig.mailrelay.test",
    ttl: 3600,
    proxied: false,
    comment: "Mail client autoconfig",
  },
  {
    type: "CNAME",
    name: "s1._domainkey.harborline.test",
    content: "s1.dkim.mailrelay.test",
    ttl: 1,
    proxied: false,
    comment: "Relay-managed DKIM selector",
  },

  // --- Mail ---------------------------------------------------------------
  {
    type: "MX",
    name: "harborline.test",
    content: "mx01.mailrelay.test",
    priority: 10,
    ttl: 3600,
    proxied: false,
    comment: "Primary MX, contract HL-4471",
  },
  {
    type: "MX",
    name: "harborline.test",
    content: "mx02.mailrelay.test",
    priority: 20,
    ttl: 3600,
    proxied: false,
    comment: "Secondary MX, failover only",
  },
  {
    type: "TXT",
    name: "harborline.test",
    content:
      "v=spf1 ip4:198.51.100.0/24 include:_spf.mailrelay.test include:_spf.ticketing.test -all",
    ttl: 3600,
    proxied: false,
    comment: "Hard fail, 6/10 lookups used",
  },
  {
    type: "TXT",
    name: "_dmarc.harborline.test",
    content:
      "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; pct=100; rua=mailto:dmarc-agg@harborline.test",
    ttl: 3600,
    proxied: false,
    comment: "Enforcing since 2025-11",
  },
  {
    type: "TXT",
    name: "default._domainkey.harborline.test",
    content:
      "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxu7Qd2mVn0aLpR8dYcE1fJhG5aZoK3sW",
    ttl: 3600,
    proxied: false,
    comment: "In-house key, rotate 2026-10",
  },
  {
    type: "TXT",
    name: "_mta-sts.harborline.test",
    content: "v=STSv1; id=20260114T120000Z",
    ttl: 3600,
    proxied: false,
    comment: "Bump id on policy change",
  },
  {
    type: "TXT",
    name: "_smtp._tls.harborline.test",
    content: "v=TLSRPTv1; rua=mailto:tls-reports@harborline.test",
    ttl: 3600,
    proxied: false,
    comment: "SMTP TLS reporting endpoint",
  },
  {
    type: "TXT",
    name: "harborline.test",
    content: "harborline-site-verification=8f3c9a1d2e4b60775c1a",
    ttl: 300,
    proxied: false,
    comment: "Ownership proof, keep it",
  },
  {
    type: "TXT",
    name: "_acme-challenge.harborline.test",
    content: "n0Vb7QwK2m9Xs4tLpR8dYcE1fJhG5aZoQ7uT3vB1",
    ttl: 60,
    proxied: false,
    comment: "DNS-01 token, cert-manager",
  },

  // --- Service discovery --------------------------------------------------
  {
    type: "SRV",
    name: "_sip._tls.harborline.test",
    content: "100 1 5061 sipdir.harborline.test",
    priority: 100,
    ttl: 3600,
    proxied: false,
    comment: "Dispatch desk softphones",
  },
  {
    type: "SRV",
    name: "_autodiscover._tcp.harborline.test",
    content: "10 0 443 autodiscover.mailrelay.test",
    priority: 10,
    ttl: 3600,
    proxied: false,
    comment: "Autodiscover for the relay",
  },

  // --- Policy -------------------------------------------------------------
  {
    type: "CAA",
    name: "harborline.test",
    content: '0 issue "ca.example.net"',
    ttl: 3600,
    proxied: false,
    comment: "Only the corporate ACME CA",
  },
  {
    type: "CAA",
    name: "harborline.test",
    content: '0 issuewild ";"',
    ttl: 3600,
    proxied: false,
    comment: "Wildcard issuance refused",
  },
  {
    type: "CAA",
    name: "harborline.test",
    content: '0 iodef "mailto:tls-abuse@harborline.test"',
    ttl: 3600,
    proxied: false,
    comment: "Where CAs report violations",
  },
  {
    type: "NS",
    name: "lab.harborline.test",
    content: "ns1.labdns.test",
    ttl: 86400,
    proxied: false,
    comment: "Delegated to the lab team",
  },
  {
    type: "NS",
    name: "lab.harborline.test",
    content: "ns2.labdns.test",
    ttl: 86400,
    proxied: false,
    comment: "Second delegation target",
  },
];

const CDN_SEEDS: RecordSeed[] = [
  {
    type: "A",
    name: "harborlinecdn.test",
    content: "203.0.113.30",
    ttl: 1,
    proxied: true,
    comment: "Asset edge apex",
  },
  {
    type: "CNAME",
    name: "assets.harborlinecdn.test",
    content: "harborlinecdn.test",
    ttl: 1,
    proxied: true,
    comment: "Canonical asset hostname",
  },
  {
    type: "CNAME",
    name: "img.harborlinecdn.test",
    content: "harborlinecdn.test",
    ttl: 1,
    proxied: true,
    comment: "Image resizing hostname",
  },
  {
    type: "TXT",
    name: "harborlinecdn.test",
    content: "v=spf1 -all",
    ttl: 3600,
    proxied: false,
    comment: "Never sends mail",
  },
  {
    type: "TXT",
    name: "_dmarc.harborlinecdn.test",
    content: "v=DMARC1; p=reject; rua=mailto:dmarc-agg@harborline.test",
    ttl: 3600,
    proxied: false,
    comment: "Parked for mail, reject all",
  },
  {
    type: "CAA",
    name: "harborlinecdn.test",
    content: '0 issue "ca.example.net"',
    ttl: 3600,
    proxied: false,
    comment: "Matches corporate CAA policy",
  },
];

const SHIPWRIGHT_SEEDS: RecordSeed[] = [
  {
    type: "A",
    name: "shipwright.test",
    content: "203.0.113.40",
    ttl: 1,
    proxied: true,
    comment: "Product marketing site",
  },
  {
    type: "A",
    name: "www.shipwright.test",
    content: "203.0.113.40",
    ttl: 1,
    proxied: true,
    comment: "Mirrors the apex",
  },
  {
    type: "A",
    name: "app.shipwright.test",
    content: "203.0.113.41",
    ttl: 1,
    proxied: true,
    comment: "Web app, shared API gateway",
  },
  {
    type: "CNAME",
    name: "docs.shipwright.test",
    content: "harborline-docs.pages.test",
    ttl: 1,
    proxied: true,
    comment: "Shared docs deployment",
  },
  {
    type: "MX",
    name: "shipwright.test",
    content: "mx01.mailrelay.test",
    priority: 10,
    ttl: 3600,
    proxied: false,
    comment: "Same relay as parent",
  },
  {
    type: "TXT",
    name: "shipwright.test",
    content: "v=spf1 include:_spf.mailrelay.test -all",
    ttl: 3600,
    proxied: false,
    comment: "Product mail via relay",
  },
  {
    type: "TXT",
    name: "_dmarc.shipwright.test",
    content:
      "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc-agg@harborline.test",
    ttl: 3600,
    proxied: false,
    comment: "Quarantine until clean",
  },
];

const LABS_SEEDS: RecordSeed[] = [
  {
    type: "A",
    name: "harborline-labs.test",
    content: "192.0.2.80",
    ttl: 300,
    proxied: true,
    comment: "Experiments only, no SLA",
  },
  {
    type: "A",
    name: "sandbox.harborline-labs.test",
    content: "192.0.2.81",
    ttl: 300,
    proxied: false,
    comment: "Reset nightly at 03:00 UTC",
  },
  {
    type: "CNAME",
    name: "preview.harborline-labs.test",
    content: "harborline-labs-preview.pages.test",
    ttl: 300,
    proxied: true,
    comment: "Per-branch previews",
  },
  {
    type: "TXT",
    name: "harborline-labs.test",
    content: "v=spf1 -all",
    ttl: 3600,
    proxied: false,
    comment: "Lab zone never sends mail",
  },
];

/** Records keyed by zone id, exactly as `get_dns_records` returns them. */
export const DEMO_RECORDS_BY_ZONE: Record<string, DemoRecord[]> = {
  [PRIMARY_ZONE_ID]: buildRecords(
    PRIMARY_ZONE_ID,
    "harborline.test",
    HARBORLINE_SEEDS,
  ),
  "zone-harborline-cdn": buildRecords(
    "zone-harborline-cdn",
    "harborlinecdn.test",
    CDN_SEEDS,
  ),
  "zone-shipwright": buildRecords(
    "zone-shipwright",
    "shipwright.test",
    SHIPWRIGHT_SEEDS,
  ),
  "zone-harborline-labs": buildRecords(
    "zone-harborline-labs",
    "harborline-labs.test",
    LABS_SEEDS,
  ),
};

/**
 * The stored API keys the login screen lists. Labels are obviously fictional
 * and the "ciphertext" is a placeholder - no real secret exists anywhere in
 * this fixture.
 */
export const DEMO_API_KEYS = [
  {
    id: "demo-key-ops",
    label: "Harborline Ops (demo)",
    encrypted_key: "demo-ciphertext",
    email: "dns-ops@harborline.test",
    iterations: 310000,
    key_length: 256,
    algorithm: "AES-GCM",
  },
  {
    id: "demo-key-readonly",
    label: "Harborline Read-only (demo)",
    encrypted_key: "demo-ciphertext",
    email: "dns-audit@harborline.test",
    iterations: 310000,
    key_length: 256,
    algorithm: "AES-GCM",
  },
];

/** Password typed into the demo login form. Never leaves the fixture. */
export const DEMO_PASSWORD = "correct horse battery staple";

/** Placeholder returned by `decrypt_api_key`; must never appear on screen. */
export const DEMO_DECRYPTED_TOKEN = "demo-token-not-a-real-credential";

/**
 * Local-only record tags. These live in browser storage (`StorageManager`),
 * not in Cloudflare, so the harness seeds them straight into `localStorage`
 * under the key below. Indexes match the generated `-rec-NN` ids.
 */
export const DEMO_BROWSER_STORAGE_KEY = "cloudflare-dns-manager";

const PRIMARY_TAGS: Record<number, string[]> = {
  1: ["edge", "critical"],
  2: ["edge", "ipv6"],
  3: ["edge"],
  4: ["edge", "ipv6"],
  5: ["app", "critical"],
  6: ["app", "critical"],
  7: ["app", "ipv6"],
  8: ["internal"],
  9: ["internal"],
  10: ["internal"],
  11: ["internal"],
  12: ["internal"],
  13: ["legacy"],
  14: ["vendor"],
  15: ["edge"],
  16: ["vendor"],
  17: ["vendor"],
  18: ["mail"],
  19: ["mail"],
  20: ["mail", "critical"],
  21: ["mail"],
  22: ["mail", "critical"],
  23: ["mail", "critical"],
  24: ["mail"],
  25: ["mail"],
  26: ["mail"],
  27: ["automation"],
  28: ["automation"],
  33: ["security"],
  34: ["security"],
  35: ["security"],
};

function tagsForZone(zoneId: string, byIndex: Record<number, string[]>) {
  const map: Record<string, string[]> = {};
  for (const [index, tags] of Object.entries(byIndex)) {
    map[`${zoneId}-rec-${String(index).padStart(2, "0")}`] = tags;
  }
  return map;
}

export const DEMO_RECORD_TAGS: Record<string, Record<string, string[]>> = {
  [PRIMARY_ZONE_ID]: tagsForZone(PRIMARY_ZONE_ID, PRIMARY_TAGS),
  "zone-shipwright": tagsForZone("zone-shipwright", {
    1: ["edge"],
    2: ["edge"],
    3: ["app"],
    5: ["mail"],
    6: ["mail"],
  }),
};

export const DEMO_TAG_CATALOG: Record<string, string[]> = {
  [PRIMARY_ZONE_ID]: [
    "app",
    "automation",
    "critical",
    "edge",
    "internal",
    "ipv6",
    "legacy",
    "mail",
    "security",
    "vendor",
  ],
  "zone-shipwright": ["app", "edge", "mail"],
};

/** Everything the init script needs, in one structured-cloneable object. */
export interface DemoSeed {
  apiKeys: typeof DEMO_API_KEYS;
  zones: DemoZone[];
  recordsByZone: Record<string, DemoRecord[]>;
  primaryZoneId: string;
  decryptedToken: string;
  theme: string;
  modifiedOn: string;

  dnssec: unknown;
  zoneSettings: Record<string, unknown>;
  encryptionBenchmark: unknown;

  mcpTools: Array<{ name: string; title: string; description: string }>;
  mcpEnabledTools: string[];

  zoneAnalytics: unknown;
  dnsAnalytics: unknown;
  firewallRules: unknown;
  ipAccessRules: unknown;
  wafRulesets: unknown;
  workerRoutes: unknown;
  emailRoutingSettings: unknown;
  emailRoutingRules: unknown;

  topologyBatch: unknown;
  propagation: unknown;
  spfParse: unknown;
  spfSimulation: unknown;
  spfGraph: unknown;

  auditEntries: unknown;
  domainAudit: unknown;

  registrarCredentials: unknown;
  registrarDomains: unknown;
  registrarHealth: unknown;

  parsedImportRecords: unknown;
  importJson: string;

  browserStorageKey: string;
  browserStorage: Record<string, unknown>;
}

export function createDemoSeed(theme: string): DemoSeed {
  return {
    apiKeys: DEMO_API_KEYS,
    zones: DEMO_ZONES,
    recordsByZone: DEMO_RECORDS_BY_ZONE,
    primaryZoneId: PRIMARY_ZONE_ID,
    decryptedToken: DEMO_DECRYPTED_TOKEN,
    theme,
    modifiedOn: MODIFIED_ON,

    dnssec: panels.DEMO_DNSSEC,
    zoneSettings: panels.DEMO_ZONE_SETTINGS,
    encryptionBenchmark: panels.DEMO_ENCRYPTION_BENCHMARK,

    mcpTools: panels.DEMO_MCP_TOOLS,
    mcpEnabledTools: panels.DEMO_MCP_ENABLED_TOOLS,

    zoneAnalytics: panels.DEMO_ZONE_ANALYTICS,
    dnsAnalytics: panels.DEMO_DNS_ANALYTICS,
    firewallRules: panels.DEMO_FIREWALL_RULES,
    ipAccessRules: panels.DEMO_IP_ACCESS_RULES,
    wafRulesets: panels.DEMO_WAF_RULESETS,
    workerRoutes: panels.DEMO_WORKER_ROUTES,
    emailRoutingSettings: panels.DEMO_EMAIL_ROUTING_SETTINGS,
    emailRoutingRules: panels.DEMO_EMAIL_ROUTING_RULES,

    topologyBatch: panels.DEMO_TOPOLOGY_BATCH,
    propagation: panels.DEMO_PROPAGATION,
    spfParse: panels.DEMO_SPF_PARSE,
    spfSimulation: panels.DEMO_SPF_SIMULATION,
    spfGraph: panels.DEMO_SPF_GRAPH,

    auditEntries: panels.DEMO_AUDIT_ENTRIES,
    domainAudit: panels.DEMO_DOMAIN_AUDIT,

    registrarCredentials: panels.DEMO_REGISTRAR_CREDENTIALS,
    registrarDomains: panels.DEMO_REGISTRAR_DOMAINS,
    registrarHealth: panels.DEMO_REGISTRAR_HEALTH,

    parsedImportRecords: panels.DEMO_PARSED_IMPORT_RECORDS,
    importJson: panels.DEMO_IMPORT_JSON,

    browserStorageKey: DEMO_BROWSER_STORAGE_KEY,
    browserStorage: {
      apiKeys: [],
      recordTags: DEMO_RECORD_TAGS,
      tagCatalog: DEMO_TAG_CATALOG,
    },
  };
}
