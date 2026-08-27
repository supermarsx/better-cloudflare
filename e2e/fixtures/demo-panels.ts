/**
 * Seeded responses for the non-DNS panels (analytics, firewall, workers, email
 * routing, registrar monitoring, MCP, audit, topology, propagation).
 *
 * Same rules as `demo-workspace.ts`: invented company, RFC 2606 `.test`
 * domains, RFC 5737 / RFC 3849 documentation IPs, no real credentials.
 *
 * Field names mirror what the app destructures from each native command, so
 * these objects can be returned verbatim from the stubbed `invoke`.
 */

export const DEMO_MODIFIED_ON = "2026-06-18T14:41:00.000Z";

/** `get_dnssec` */
export const DEMO_DNSSEC = {
  status: "active",
  algorithm: "13",
  digest: "6f1b2c0d4e8a7b39c5d21e4f60a8b7c9d3e5f10273849a6b5c4d3e2f10a9b8c7",
  digest_algorithm: "SHA256",
  digest_type: "2",
  ds: "harborline.test. IN DS 2371 13 2 6f1b2c0d4e8a7b39c5d21e4f60a8b7c9d3e5f10273849a6b5c4d3e2f10a9b8c7",
  flags: 257,
  key_tag: 2371,
  key_type: "ECDSAP256SHA256",
  public_key:
    "mdsswUyr3DPW132mOi8V9xESWE8jTo0dxCjjnopKl+GqJxpVXckHAeF+KkxLbxIL",
  modified_on: DEMO_MODIFIED_ON,
};

function setting(id: string, value: unknown) {
  return { id, value, editable: true, modified_on: DEMO_MODIFIED_ON };
}

/** `get_zone_setting`, keyed by setting id. */
export const DEMO_ZONE_SETTINGS: Record<string, unknown> = {
  ssl: setting("ssl", "strict"),
  always_use_https: setting("always_use_https", "on"),
  min_tls_version: setting("min_tls_version", "1.2"),
  tls_1_3: setting("tls_1_3", "on"),
  automatic_https_rewrites: setting("automatic_https_rewrites", "on"),
  opportunistic_encryption: setting("opportunistic_encryption", "on"),
  browser_cache_ttl: setting("browser_cache_ttl", 14400),
  cache_level: setting("cache_level", "aggressive"),
  development_mode: setting("development_mode", "off"),
  always_online: setting("always_online", "on"),
  security_level: setting("security_level", "medium"),
  ipv6: setting("ipv6", "on"),
  http3: setting("http3", "on"),
  websockets: setting("websockets", "on"),
  brotli: setting("brotli", "on"),
  early_hints: setting("early_hints", "on"),
  rocket_loader: setting("rocket_loader", "off"),
  hotlink_protection: setting("hotlink_protection", "off"),
  email_obfuscation: setting("email_obfuscation", "on"),
  challenge_ttl: setting("challenge_ttl", 1800),
};

/** `benchmark_encryption` resolves to a plain number of milliseconds. */
export const DEMO_ENCRYPTION_BENCHMARK = 412.84;

/**
 * `mcp_get_server_status().enabledTools`.
 *
 * This is exactly the read-only default set the app reconciles to on start-up,
 * so the MCP panel opens without the "confirm elevated capability" modal.
 */
export const DEMO_MCP_ENABLED_TOOLS = [
  "cf_list_zones",
  "cf_list_dns_records",
  "cf_get_zone_setting",
  "cf_get_dnssec",
  "cf_get_zone_analytics",
  "cf_get_dns_analytics",
  "cf_list_firewall_rules",
  "cf_list_ip_access_rules",
  "cf_list_waf_rulesets",
  "cf_list_worker_routes",
  "cf_get_email_routing_settings",
  "cf_list_email_routing_rules",
  "cf_list_page_rules",
  "spf_simulate",
  "spf_graph",
  "spf_parse",
  "dns_validate_record",
  "dns_check_propagation",
  "dns_resolve_topology",
  "dns_parse_csv",
  "dns_parse_bind",
  "dns_export_csv",
  "dns_export_bind",
  "dns_export_json",
  "dns_parse_srv",
  "dns_compose_srv",
  "dns_parse_tlsa",
  "dns_compose_tlsa",
  "dns_parse_sshfp",
  "dns_compose_sshfp",
  "dns_parse_naptr",
  "dns_compose_naptr",
  "dns_parse_spf",
  "audit_run_domain",
];

/**
 * The MCP panel builds its own catalogue from a static, reviewed tool list, so
 * an empty descriptor array is both valid and the least brittle option.
 */
export const DEMO_MCP_TOOLS: Array<{
  name: string;
  title: string;
  description: string;
}> = [];

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

function analyticsSeries() {
  const start = Date.parse("2026-08-06T12:00:00Z");
  const requests = [
    51200, 58730, 44210, 67340, 72110, 64980, 59240, 48310, 41120, 39870, 45260,
    53980, 61240, 69870, 74320, 70110, 63450, 57820, 52130, 47690, 43280, 40910,
    46550, 55420,
  ];
  return requests.map((count, index) => {
    const since = new Date(start + index * 3_600_000).toISOString();
    const until = new Date(start + (index + 1) * 3_600_000).toISOString();
    return {
      since,
      until,
      requests: count,
      bandwidth: count * 37_400,
      threats: 40 + ((index * 37) % 190),
      pageviews: Math.round(count * 0.32),
      uniques: Math.round(count * 0.068),
    };
  });
}

const ANALYTICS_TIMESERIES = analyticsSeries();

/** `get_zone_analytics` */
export const DEMO_ZONE_ANALYTICS = {
  totals: {
    requests: ANALYTICS_TIMESERIES.reduce((sum, p) => sum + p.requests, 0),
    bandwidth: ANALYTICS_TIMESERIES.reduce((sum, p) => sum + p.bandwidth, 0),
    threats: ANALYTICS_TIMESERIES.reduce((sum, p) => sum + p.threats, 0),
    pageviews: ANALYTICS_TIMESERIES.reduce((sum, p) => sum + p.pageviews, 0),
    uniques: ANALYTICS_TIMESERIES.reduce((sum, p) => sum + p.uniques, 0),
  },
  timeseries: ANALYTICS_TIMESERIES,
};

/** `get_dns_analytics` */
export const DEMO_DNS_ANALYTICS = {
  totals: { queryCount: 8_412_330, responseTimeAvg: 11.4 },
  timeseries: ANALYTICS_TIMESERIES.map((point) => ({
    since: point.since,
    until: point.until,
    queryCount: point.requests * 6,
    responseTimeAvg: 9 + (point.threats % 7),
  })),
};

// ---------------------------------------------------------------------------
// Firewall
// ---------------------------------------------------------------------------

/** `get_firewall_rules` */
export const DEMO_FIREWALL_RULES = [
  {
    id: "f1a2b3c4d5e6f70819a2b3c4d5e6f708",
    paused: false,
    action: "block",
    priority: 1,
    description: "Block the scanner subnet reported on 2026-07-14",
    filter: {
      id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      expression: "(ip.src in {192.0.2.0/24})",
      paused: false,
      description: "Scanner subnet",
    },
  },
  {
    id: "aa11bb22cc33dd44ee55ff6677889900",
    paused: false,
    action: "managed_challenge",
    priority: 2,
    description: "Challenge unauthenticated console logins",
    filter: {
      id: "99887766554433221100ffeeddccbbaa",
      expression:
        '(http.host eq "app.harborline.test" and http.request.uri.path eq "/login")',
      paused: false,
      description: "Console login",
    },
  },
  {
    id: "bb22cc33dd44ee55ff66778899001122",
    paused: false,
    action: "js_challenge",
    priority: 3,
    description: "Slow down bulk quote scraping",
    filter: {
      id: "8877665544332211ffeeddccbbaa9900",
      expression:
        '(http.request.uri.path contains "/quote" and cf.threat_score gt 14)',
      paused: false,
      description: "Quote scraping",
    },
  },
  {
    id: "cc33dd44ee55ff6677889900112233444",
    paused: true,
    action: "allow",
    priority: 4,
    description:
      "Allow the partner integration range (paused during migration)",
    filter: {
      id: "776655443322110099aabbccddeeff00",
      expression: "(ip.src in {203.0.113.0/24})",
      paused: false,
      description: "Partner range",
    },
  },
];

/** `get_ip_access_rules` */
export const DEMO_IP_ACCESS_RULES = [
  {
    id: "1b2c3d4e5f60718293a4b5c6d7e8f900",
    mode: "block",
    notes: "Abuse report 2026-07-21",
    configuration: { target: "ip", value: "198.51.100.24" },
    allowed_modes: ["block", "challenge", "whitelist", "managed_challenge"],
  },
  {
    id: "2c3d4e5f60718293a4b5c6d7e8f90011",
    mode: "whitelist",
    notes: "Rotterdam office egress",
    configuration: { target: "ip_range", value: "203.0.113.0/24" },
    allowed_modes: ["block", "challenge", "whitelist"],
  },
  {
    id: "3d4e5f60718293a4b5c6d7e8f9001122",
    mode: "challenge",
    notes: "Noisy datacentre range, review 2026-10",
    configuration: { target: "ip_range", value: "192.0.2.128/25" },
    allowed_modes: ["block", "challenge", "whitelist"],
  },
];

/** `get_waf_rulesets` */
export const DEMO_WAF_RULESETS = [
  {
    id: "efb7b8c949ac4650a09736fc376e9aee",
    name: "Harborline Managed Ruleset",
    description: "Baseline managed protections applied to every zone.",
    kind: "managed",
    phase: "http_request_firewall_managed",
  },
  {
    id: "4814384a9e5d4991b9815dcfc25d2f1f",
    name: "OWASP Core Ruleset",
    description: "Core Rule Set at paranoia level 2.",
    kind: "managed",
    phase: "http_request_firewall_managed",
  },
  {
    id: "5a1c9e0b7d2f43a8b6c1d0e9f8a7b6c5",
    name: "Harborline custom rules",
    description: "Zone-specific overrides maintained by the platform team.",
    kind: "zone",
    phase: "http_request_firewall_custom",
  },
];

// ---------------------------------------------------------------------------
// Workers / email routing
// ---------------------------------------------------------------------------

/** `get_worker_routes` */
export const DEMO_WORKER_ROUTES = [
  {
    id: "e7c1f1a4b0d94e9f8f3a2b1c0d9e8f70",
    pattern: "api.harborline.test/v2/*",
    script: "api-gateway",
  },
  {
    id: "5d4c3b2a19087f6e5d4c3b2a19087f6e",
    pattern: "cdn.harborline.test/*",
    script: "asset-rewriter",
  },
  {
    id: "0192837465afbecd0192837465afbecd",
    pattern: "harborline.test/track/*",
    script: "shipment-tracker",
  },
  {
    id: "abcdef0123456789abcdef0123456789",
    pattern: "app.harborline.test/preview*",
    script: "preview-router",
  },
];

/** `get_email_routing_settings` */
export const DEMO_EMAIL_ROUTING_SETTINGS = {
  enabled: true,
  name: "harborline.test",
  tag: "3f2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d",
  status: "ready",
  created: "2026-01-14T09:12:33Z",
  modified: "2026-07-30T18:44:02Z",
  skip_wizard: true,
};

/** `get_email_routing_rules` */
export const DEMO_EMAIL_ROUTING_RULES = [
  {
    id: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    tag: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    name: "Support inbox",
    enabled: true,
    priority: 0,
    matchers: [
      { type: "literal", field: "to", value: "support@harborline.test" },
    ],
    actions: [{ type: "forward", value: ["dispatch@harborline.test"] }],
  },
  {
    id: "b2c3d4e5f60718293a4b5c6d7e8f9001",
    tag: "b2c3d4e5f60718293a4b5c6d7e8f9001",
    name: "Billing",
    enabled: true,
    priority: 1,
    matchers: [
      { type: "literal", field: "to", value: "billing@harborline.test" },
    ],
    actions: [{ type: "forward", value: ["finance@harborline.test"] }],
  },
  {
    id: "c3d4e5f60718293a4b5c6d7e8f900112",
    tag: "c3d4e5f60718293a4b5c6d7e8f900112",
    name: "Abuse and security",
    enabled: true,
    priority: 2,
    matchers: [
      { type: "literal", field: "to", value: "abuse@harborline.test" },
    ],
    actions: [{ type: "forward", value: ["security@harborline.test"] }],
  },
  {
    id: "d4e5f60718293a4b5c6d7e8f90011223",
    tag: "d4e5f60718293a4b5c6d7e8f90011223",
    name: "Catch-all drop",
    enabled: false,
    priority: 3,
    matchers: [{ type: "all" }],
    actions: [{ type: "drop" }],
  },
];

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** `get_audit_entries` */
export const DEMO_AUDIT_ENTRIES = [
  {
    timestamp: "2026-08-07T10:41:02Z",
    operation: "dns.record.update",
    resource: "harborline.test/A/app",
    actor: "dns-ops@harborline.test",
    zone_id: "zone-harborline",
    result: "success",
  },
  {
    timestamp: "2026-08-07T10:12:55Z",
    operation: "dns.record.create",
    resource: "harborline.test/TXT/_acme-challenge",
    actor: "cert-manager (automation)",
    zone_id: "zone-harborline",
    result: "success",
  },
  {
    timestamp: "2026-08-07T09:12:44Z",
    operation: "api_key.decrypt",
    resource: "key:demo-key-ops",
    actor: "dns-ops@harborline.test",
    result: "success",
  },
  {
    timestamp: "2026-08-06T22:03:19Z",
    operation: "firewall.rule.create",
    resource: "harborline.test/firewall/f1a2b3c4",
    actor: "security@harborline.test",
    result: "success",
  },
  {
    timestamp: "2026-08-06T18:47:30Z",
    operation: "dns.records.export",
    resource: "shipwright.test",
    actor: "dns-audit@harborline.test",
    result: "success",
  },
  {
    timestamp: "2026-08-06T08:31:07Z",
    operation: "dns.record.delete",
    resource: "harborline-labs.test/A/scratch",
    actor: "dns-ops@harborline.test",
    result: "success",
  },
];

/** `run_domain_audit` */
export const DEMO_DOMAIN_AUDIT = [
  {
    id: "spf-single-record",
    title: "Exactly one SPF record",
    status: "pass",
    severity: "info",
    detail: "harborline.test publishes a single v=spf1 record.",
  },
  {
    id: "dmarc-enforced",
    title: "DMARC policy is enforcing",
    status: "pass",
    severity: "info",
    detail: "p=reject with aggregate reporting enabled.",
  },
  {
    id: "spf-lookup-budget",
    title: "SPF DNS lookup budget",
    status: "warn",
    severity: "warning",
    detail: "6 of the 10 permitted lookups are used.",
  },
  {
    id: "caa-present",
    title: "CAA records present",
    status: "pass",
    severity: "info",
    detail: "Issuance is restricted to a single certificate authority.",
  },
  {
    id: "dnssec-enabled",
    title: "DNSSEC is signed",
    status: "pass",
    severity: "info",
    detail: "Algorithm 13 (ECDSAP256SHA256), key tag 2371.",
  },
];

// ---------------------------------------------------------------------------
// Registrar monitoring
// ---------------------------------------------------------------------------

/** `list_registrar_credentials` */
export const DEMO_REGISTRAR_CREDENTIALS = [
  {
    id: "cred-porkbun",
    provider: "porkbun",
    label: "Harborline primary",
    username: "harborline-ops",
    email: "domains@harborline.test",
    created_at: "2026-03-02T10:00:00Z",
  },
  {
    id: "cred-namecheap",
    provider: "namecheap",
    label: "Legacy brands",
    username: "harborline-billing",
    email: "finance@harborline.test",
    created_at: "2026-05-19T08:30:00Z",
  },
];

function domain(
  name: string,
  registrar: string,
  status: string,
  expiresAt: string,
  options: {
    nameservers?: string[];
    custom?: boolean;
    lock?: boolean;
    autoRenew?: boolean;
    dnssec?: boolean;
    privacy?: boolean;
  } = {},
) {
  return {
    domain: name,
    registrar,
    status,
    created_at: "2019-06-11T00:00:00Z",
    expires_at: expiresAt,
    updated_at: "2026-07-22T14:05:00Z",
    nameservers: {
      current: options.nameservers ?? [
        "arla.ns.example.net",
        "bex.ns.example.net",
      ],
      is_custom: options.custom ?? true,
    },
    locks: {
      transfer_lock: options.lock ?? true,
      auto_renew: options.autoRenew ?? true,
    },
    dnssec: {
      enabled: options.dnssec ?? true,
      ds_records: options.dnssec
        ? [
            {
              key_tag: 2371,
              algorithm: 13,
              digest_type: 2,
              digest:
                "9F2C1A7B4E5D6082A31B4C5D6E7F8091A2B3C4D5E6F708192A3B4C5D6E7F8091",
            },
          ]
        : [],
    },
    privacy: {
      enabled: options.privacy ?? true,
      service_name: "WHOIS privacy",
    },
    contact: {
      first_name: "Registry",
      last_name: "Desk",
      organization: "Harborline Freight Systems",
      email: "domains@harborline.test",
      country: "NL",
    },
  };
}

/** `registrar_list_all_domains` */
export const DEMO_REGISTRAR_DOMAINS = [
  domain("harborline.test", "porkbun", "active", "2027-03-04T00:00:00Z"),
  domain("harborlinecdn.test", "porkbun", "active", "2026-11-18T00:00:00Z"),
  domain("shipwright.test", "porkbun", "active", "2026-09-02T00:00:00Z"),
  domain(
    "harborline-labs.test",
    "namecheap",
    "active",
    "2026-08-27T00:00:00Z",
    {
      autoRenew: false,
      dnssec: false,
    },
  ),
  domain(
    "harborline-eu.test",
    "namecheap",
    "pending_transfer",
    "2026-08-19T00:00:00Z",
    {
      nameservers: [
        "dns1.registrar-servers.test",
        "dns2.registrar-servers.test",
      ],
      custom: false,
      lock: false,
      autoRenew: false,
      dnssec: false,
      privacy: false,
    },
  ),
];

/** `registrar_health_check_all` */
export const DEMO_REGISTRAR_HEALTH = [
  {
    domain: "harborline.test",
    status: "healthy",
    checked_at: "2026-08-07T11:02:00Z",
    checks: [
      {
        name: "expiry_window",
        passed: true,
        severity: "info",
        message: "Expires in 209 days",
      },
      {
        name: "transfer_lock",
        passed: true,
        severity: "info",
        message: "Transfer lock enabled",
      },
      {
        name: "dnssec",
        passed: true,
        severity: "info",
        message: "DNSSEC signed",
      },
    ],
  },
  {
    domain: "harborlinecdn.test",
    status: "healthy",
    checked_at: "2026-08-07T11:02:00Z",
    checks: [
      {
        name: "expiry_window",
        passed: true,
        severity: "info",
        message: "Expires in 103 days",
      },
      {
        name: "auto_renew",
        passed: true,
        severity: "info",
        message: "Auto-renew enabled",
      },
    ],
  },
  {
    domain: "shipwright.test",
    status: "warning",
    checked_at: "2026-08-07T11:02:00Z",
    checks: [
      {
        name: "expiry_window",
        passed: false,
        severity: "warning",
        message: "Expires in 26 days",
      },
      {
        name: "transfer_lock",
        passed: true,
        severity: "info",
        message: "Transfer lock enabled",
      },
    ],
  },
  {
    domain: "harborline-labs.test",
    status: "warning",
    checked_at: "2026-08-07T11:02:00Z",
    checks: [
      {
        name: "auto_renew",
        passed: false,
        severity: "warning",
        message: "Auto-renew disabled",
      },
      {
        name: "dnssec",
        passed: false,
        severity: "warning",
        message: "DNSSEC not enabled",
      },
    ],
  },
  {
    domain: "harborline-eu.test",
    status: "critical",
    checked_at: "2026-08-07T11:02:00Z",
    checks: [
      {
        name: "expiry_window",
        passed: false,
        severity: "critical",
        message: "Expires in 12 days",
      },
      {
        name: "transfer_lock",
        passed: false,
        severity: "critical",
        message: "Transfer lock disabled",
      },
      {
        name: "auto_renew",
        passed: false,
        severity: "warning",
        message: "Auto-renew disabled",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// SPF / topology / propagation (refined against the components)
// ---------------------------------------------------------------------------

export const DEMO_SPF_PARSE: unknown = {
  version: "spf1",
  mechanisms: [
    { qualifier: "+", type: "ip4", value: "198.51.100.0/24" },
    { qualifier: "+", type: "include", value: "_spf.mailrelay.test" },
    { qualifier: "+", type: "include", value: "_spf.ticketing.test" },
    { qualifier: "-", type: "all", value: "" },
  ],
  lookupCount: 6,
  warnings: [],
};

export const DEMO_SPF_SIMULATION: unknown = {
  result: "pass",
  matched: "ip4:198.51.100.0/24",
  lookups: 2,
  explanation: "198.51.100.40 is inside an explicitly permitted range.",
};

export const DEMO_SPF_GRAPH: unknown = {
  root: "harborline.test",
  nodes: [
    { id: "harborline.test", lookups: 0 },
    { id: "_spf.mailrelay.test", lookups: 3 },
    { id: "_spf.ticketing.test", lookups: 2 },
  ],
  edges: [
    { from: "harborline.test", to: "_spf.mailrelay.test" },
    { from: "harborline.test", to: "_spf.ticketing.test" },
  ],
};

/**
 * `resolve_topology_batch`.
 *
 * `name` must be the exact lowercase hostname the graph asked about - the
 * component keys resolutions by the requested name - so this list mirrors every
 * non-IP target in the primary zone (CNAME, MX, NS and SRV content).
 */
function resolution(
  name: string,
  chain: string[],
  ipv4: string[],
  ipv6: string[],
  country: [string, string],
  ptr?: Record<string, string[]>,
) {
  const addresses = [...ipv4, ...ipv6];
  return {
    name,
    chain,
    terminal: chain[chain.length - 1],
    ipv4,
    ipv6,
    reverse_hostnames: Object.entries(ptr ?? {}).map(([ip, hostnames]) => ({
      ip,
      hostnames,
    })),
    geo_by_ip: addresses.map((ip) => ({
      ip,
      country: country[0],
      country_code: country[1],
    })),
    error: null,
  };
}

export const DEMO_TOPOLOGY_BATCH = {
  resolutions: [
    resolution(
      "harborline-docs.pages.test",
      ["harborline-docs.pages.test", "edge.pages.test"],
      ["203.0.113.60"],
      ["2001:db8:41d0:4::60"],
      ["Netherlands", "NL"],
      { "203.0.113.60": ["edge-60.pages.test"] },
    ),
    resolution(
      "assets.harborlinecdn.test",
      ["assets.harborlinecdn.test", "harborlinecdn.test"],
      ["203.0.113.30"],
      ["2001:db8:41d0:3::30"],
      ["Netherlands", "NL"],
      { "203.0.113.30": ["cdn-30.harborlinecdn.test"] },
    ),
    resolution(
      "harborline.statuspage.test",
      ["harborline.statuspage.test", "pool.statuspage.test"],
      ["198.51.100.90"],
      [],
      ["United States", "US"],
      { "198.51.100.90": ["status-90.statuspage.test"] },
    ),
    resolution(
      "storefront.commerce.test",
      ["storefront.commerce.test", "shops.commerce.test"],
      ["198.51.100.120"],
      [],
      ["Ireland", "IE"],
      { "198.51.100.120": ["shop-120.commerce.test"] },
    ),
    resolution(
      "autoconfig.mailrelay.test",
      ["autoconfig.mailrelay.test"],
      ["198.51.100.20"],
      [],
      ["Germany", "DE"],
      { "198.51.100.20": ["relay-20.mailrelay.test"] },
    ),
    resolution(
      "s1.dkim.mailrelay.test",
      ["s1.dkim.mailrelay.test"],
      ["198.51.100.21"],
      [],
      ["Germany", "DE"],
    ),
    resolution(
      "mx01.mailrelay.test",
      ["mx01.mailrelay.test"],
      ["198.51.100.10"],
      ["2001:db8:beef::10"],
      ["Germany", "DE"],
      { "198.51.100.10": ["mx01.mailrelay.test"] },
    ),
    resolution(
      "mx02.mailrelay.test",
      ["mx02.mailrelay.test"],
      ["198.51.100.11"],
      ["2001:db8:beef::11"],
      ["Germany", "DE"],
      { "198.51.100.11": ["mx02.mailrelay.test"] },
    ),
    resolution(
      "ns1.labdns.test",
      ["ns1.labdns.test"],
      ["192.0.2.101"],
      [],
      ["United Kingdom", "GB"],
    ),
    resolution(
      "ns2.labdns.test",
      ["ns2.labdns.test"],
      ["192.0.2.102"],
      [],
      ["United Kingdom", "GB"],
    ),
    resolution(
      "sipdir.harborline.test",
      ["sipdir.harborline.test"],
      ["198.51.100.55"],
      [],
      ["Netherlands", "NL"],
    ),
    resolution(
      "autodiscover.mailrelay.test",
      ["autodiscover.mailrelay.test"],
      ["198.51.100.22"],
      [],
      ["Germany", "DE"],
    ),
  ],
  probes: [
    { host: "harborline.test", https_up: true, http_up: true },
    { host: "www.harborline.test", https_up: true, http_up: true },
    { host: "api.harborline.test", https_up: true, http_up: false },
    { host: "app.harborline.test", https_up: true, http_up: false },
  ],
  tcp_probes: [
    { host: "harborline.test", port: 443, up: true },
    { host: "harborline.test", port: 80, up: true },
    { host: "harborline.test", port: 22, up: false },
  ],
};

/** `check_dns_propagation` */
export const DEMO_PROPAGATION = {
  domain: "www.harborline.test",
  record_type: "A",
  results: [
    {
      resolver: "1.1.1.1",
      resolver_label: "Cloudflare",
      answers: ["203.0.113.10"],
      rcode: "NOERROR",
      latency_ms: 12,
      error: null,
    },
    {
      resolver: "8.8.8.8",
      resolver_label: "Google",
      answers: ["203.0.113.10"],
      rcode: "NOERROR",
      latency_ms: 21,
      error: null,
    },
    {
      resolver: "9.9.9.9",
      resolver_label: "Quad9",
      answers: ["203.0.113.10"],
      rcode: "NOERROR",
      latency_ms: 34,
      error: null,
    },
    {
      resolver: "208.67.222.222",
      resolver_label: "OpenDNS",
      answers: ["203.0.113.10"],
      rcode: "NOERROR",
      latency_ms: 47,
      error: null,
    },
    {
      resolver: "185.228.168.9",
      resolver_label: "CleanBrowsing",
      answers: ["203.0.113.10"],
      rcode: "NOERROR",
      latency_ms: 58,
      error: null,
    },
    {
      resolver: "94.140.14.14",
      resolver_label: "AdGuard",
      answers: ["203.0.113.10"],
      rcode: "NOERROR",
      latency_ms: 63,
      error: null,
    },
    {
      resolver: "76.76.19.19",
      resolver_label: "Alternate DNS",
      answers: ["203.0.113.10"],
      rcode: "NOERROR",
      latency_ms: 71,
      error: null,
    },
    {
      resolver: "8.26.56.26",
      resolver_label: "Comodo",
      answers: ["203.0.113.10"],
      rcode: "NOERROR",
      latency_ms: 96,
      error: null,
    },
  ],
  consistent: true,
};

/**
 * Text pasted into the import dialog for the import-preview screenshot. JSON is
 * parsed in the renderer, so the preview is fully deterministic. The two
 * trailing non-object entries exercise the "rejected by safety limits" banner
 * and the TXT record without content shows a retained-but-invalid row.
 */
export const DEMO_IMPORT_JSON = JSON.stringify(
  [
    {
      type: "A",
      name: "warehouse.harborline.test",
      content: "203.0.113.24",
      ttl: 300,
      proxied: true,
      comment: "New Rotterdam warehouse portal",
    },
    {
      type: "AAAA",
      name: "warehouse.harborline.test",
      content: "2001:db8:41d0:2::24",
      ttl: 300,
      proxied: true,
      comment: "IPv6 parity for the warehouse portal",
    },
    {
      type: "CNAME",
      name: "kiosk.harborline.test",
      content: "warehouse.harborline.test",
      ttl: 300,
      proxied: true,
      comment: "Depot kiosks",
    },
    {
      type: "MX",
      name: "warehouse.harborline.test",
      content: "mx01.mailrelay.test",
      ttl: 3600,
      priority: 10,
      comment: "Warehouse mail via the shared relay",
    },
    { type: "TXT", name: "incomplete.harborline.test" },
    "not-an-object",
    42,
  ],
  null,
  2,
);

/** `parse_csv_records` / `parse_bind_zone` */
export const DEMO_PARSED_IMPORT_RECORDS = [
  {
    type: "A",
    name: "warehouse.harborline.test",
    content: "203.0.113.24",
    ttl: 300,
    proxied: true,
  },
  {
    type: "CNAME",
    name: "kiosk.harborline.test",
    content: "warehouse.harborline.test",
    ttl: 300,
    proxied: true,
  },
];

// ---------------------------------------------------------------------------
// Notifications (t9)
// ---------------------------------------------------------------------------

/**
 * Seeded inbox for the `notifications_*` stub cases. Three items: one
 * critical domain-expiry notice, one out-of-console record change with
 * before/after values, and one archived service notice. Wire shape mirrors
 * `bc_notify::Notification` (camelCase).
 */
export interface DemoNotification {
  id: string;
  kind: "domain_expiry" | "record_change" | "service";
  severity: "info" | "warning" | "critical";
  zoneId: string | null;
  zoneName: string | null;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  archivedAt: string | null;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

export const DEMO_NOTIFICATIONS: DemoNotification[] = [
  {
    id: "ntf-expiry-labs",
    kind: "domain_expiry",
    severity: "critical",
    zoneId: "zone-harborline-labs",
    zoneName: "harborline-labs.test",
    title: "harborline-labs.test expires in 3 days",
    body: "Registration ends on 2026-08-10. Renew it with the registrar to keep the zone resolving.",
    createdAt: "2026-08-07T08:00:12Z",
    readAt: null,
    archivedAt: null,
    dedupeKey: "expiry:harborline-labs.test:2026-08-10:3",
    payload: {
      domain: "harborline-labs.test",
      expiresAt: "2026-08-10T00:00:00Z",
      daysLeft: 3,
      milestone: 3,
      source: "rdap",
    },
  },
  {
    id: "ntf-change-app",
    kind: "record_change",
    severity: "warning",
    zoneId: "zone-harborline",
    zoneName: "harborline.test",
    title: "A app.harborline.test changed outside Better Cloudflare",
    body: "203.0.113.20 → 203.0.113.99",
    createdAt: "2026-08-07T07:41:00Z",
    readAt: null,
    archivedAt: null,
    dedupeKey:
      "change:zone-harborline:zone-harborline-rec-05:2026-08-07T07:39:51Z",
    payload: {
      change: "changed",
      recordId: "zone-harborline-rec-05",
      recordType: "A",
      recordName: "app.harborline.test",
      before: {
        content: "203.0.113.20",
        ttl: 1,
        proxied: true,
        comment: "Shipper console (blue/green)",
      },
      after: {
        content: "203.0.113.99",
        ttl: 1,
        proxied: true,
        comment: "Shipper console (blue/green)",
      },
    },
  },
  {
    id: "ntf-service-baseline",
    kind: "service",
    severity: "info",
    zoneId: null,
    zoneName: null,
    title: "Monitoring started",
    body: "Baseline snapshots were taken for 4 zones. Changes made from now on will be reported here.",
    createdAt: "2026-08-06T09:15:30Z",
    readAt: "2026-08-06T09:20:00Z",
    archivedAt: "2026-08-06T18:00:00Z",
    dedupeKey: "service:baseline:2026-08-06",
    payload: { event: "baseline", zones: 4 },
  },
];

/** `notifications_status` / `notifications_start` / `notifications_check_now` */
export const DEMO_NOTIFICATION_STATUS = {
  running: true,
  enabled: true,
  paused: false,
  quietHoursActive: false,
  zonesTracked: 4,
  unread: 2,
  lastRecordCheckAt: "2026-08-07T10:30:00Z",
  lastExpiryCheckAt: "2026-08-07T08:00:00Z",
  nextRecordCheckAt: "2026-08-07T10:45:00Z",
  nextExpiryCheckAt: "2026-08-07T14:00:00Z",
  nextCheckAt: "2026-08-07T10:45:00Z",
  backoffUntil: null,
  lastError: null,
  lastPass: {
    kind: "records",
    startedAt: "2026-08-07T10:30:00Z",
    durationMs: 1840,
    zonesChecked: 4,
    notificationsCreated: 0,
    errors: 0,
  },
};

/** `notifications_get_settings` (already normalized — the TS/Rust defaults). */
export const DEMO_NOTIFICATION_SETTINGS = {
  version: 1,
  service: {
    enabled: true,
    paused: false,
    catchUpOnLaunch: true,
    recordPollMinutes: 15,
    expiryPollMinutes: 360,
    rdapCacheHours: 24,
    maxZonesPerPass: 200,
    backoffMaxMinutes: 120,
  },
  kinds: {
    domainExpiry: { enabled: true, severity: "auto", osNotify: true },
    recordChange: {
      enabled: true,
      severity: "auto",
      osNotify: true,
      changes: { added: true, changed: true, removed: true },
      fields: [
        "content",
        "ttl",
        "proxied",
        "priority",
        "comment",
        "name",
        "type",
      ],
    },
    service: { enabled: true, severity: "info", osNotify: false },
  },
  expiry: {
    milestones: [90, 60, 30, 14, 7, 3, 1],
    notifyExpired: true,
    source: "auto",
    severityByMilestone: { warningAtOrBelow: 14, criticalAtOrBelow: 3 },
  },
  zones: { mode: "all", include: [], exclude: [], overrides: {} },
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "07:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    timezone: "local",
    behaviour: "silence",
  },
  osNotifications: { enabled: true, minSeverity: "warning" },
  inApp: { toastMinSeverity: "critical", badge: true },
  retention: {
    autoArchiveReadAfterDays: 30,
    purgeArchivedAfterDays: 90,
    maxItems: 2000,
    keepSnapshots: true,
  },
};

/** `notifications_zone_summary` */
export const DEMO_NOTIFICATION_ZONE_SUMMARY = [
  {
    zoneId: "zone-harborline",
    zoneName: "harborline.test",
    monitored: true,
    muted: false,
    mutedUntil: null,
    lastCheckedAt: "2026-08-07T10:30:00Z",
    snapshotRecords: 12,
    expiresAt: "2027-03-14T00:00:00Z",
    daysLeft: 219,
    expirySource: "registrar",
    lastError: null,
  },
  {
    zoneId: "zone-harborline-cdn",
    zoneName: "harborlinecdn.test",
    monitored: true,
    muted: false,
    mutedUntil: null,
    lastCheckedAt: "2026-08-07T10:30:01Z",
    snapshotRecords: 5,
    expiresAt: "2027-01-02T00:00:00Z",
    daysLeft: 148,
    expirySource: "rdap",
    lastError: null,
  },
  {
    zoneId: "zone-shipwright",
    zoneName: "shipwright.test",
    monitored: true,
    muted: true,
    mutedUntil: "2026-08-08T10:00:00Z",
    lastCheckedAt: "2026-08-07T10:30:01Z",
    snapshotRecords: 8,
    expiresAt: null,
    daysLeft: null,
    expirySource: null,
    lastError: "RDAP lookup failed: no RDAP server for .test",
  },
  {
    zoneId: "zone-harborline-labs",
    zoneName: "harborline-labs.test",
    monitored: true,
    muted: false,
    mutedUntil: null,
    lastCheckedAt: "2026-08-07T10:30:02Z",
    snapshotRecords: 3,
    expiresAt: "2026-08-10T00:00:00Z",
    daysLeft: 3,
    expirySource: "rdap",
    lastError: null,
  },
];
