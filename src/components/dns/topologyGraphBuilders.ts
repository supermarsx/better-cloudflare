/**
 * Pure (React-free) Mermaid builders for the focused topology graphs:
 * `buildEmailTopologyMermaid` (MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, BIMI,
 * client autodiscovery, Cloudflare Email Routing) and
 * `buildServicesTopologyMermaid` (hostnames by delivery path, third-party
 * platforms, discovered ports, Worker routes).
 *
 * Both share the Mermaid assumptions of the full graph: `flowchart LR`,
 * `securityLevel: "strict"`, `htmlLabels: false`, subgraph ids limited to
 * `[A-Za-z0-9_]`, titles/labels through `escapeMermaidLabel`, labels capped by
 * `buildNodeLabel`, node/edge counts capped by the `TOPOLOGY_GRAPH_DOM_*`
 * limits. Each relation is drawn once; groups get one zone edge each instead
 * of a per-record fan-out.
 */
import type { DNSRecord } from "@/types/dns";
import type {
  EmailRoutingRuleResponse,
  EmailRoutingSettingsResponse,
  WorkerRouteResponse,
} from "@/lib/api/tauri-client";
import {
  SERVICE_PATTERNS,
  TOPOLOGY_GRAPH_DOM_EDGE_LIMIT,
  TOPOLOGY_GRAPH_DOM_NODE_LIMIT,
  buildNodeLabel,
  escapeMermaidLabel,
  normalizeDomain,
  pickBestResolution,
  resolveNameToTerminal,
  type ExternalDnsResolution,
  type ServiceDiscoveryItem,
} from "./ZoneTopologyTab";
import {
  classifyEmailName,
  collectSpfTree,
  describeSpfAll,
  dkimSelectorFromName,
  isEmailOnlyName,
  isSpfRecord,
  parseBimi,
  parseDkim,
  parseDmarc,
  parseMtaSts,
  parseMxRecord,
  parseSrvRecord,
  parseTlsRpt,
  type SpfTreeNode,
} from "./emailRecordParsers";

// ── Public types ────────────────────────────────────────────────────────────

export type TopologyNodeMeta = {
  text: string;
  recordId?: string;
  address?: string;
};

export type TopologyResolvedName = Pick<
  ExternalDnsResolution,
  "chain" | "terminal" | "ipv4" | "ipv6"
> &
  Partial<Pick<ExternalDnsResolution, "reverseHostnamesByIp" | "geoByIp">>;

export type TopologyNameResolver = (name: string) => TopologyResolvedName;

export type TopologyMxTrail = {
  from: string;
  priority: number | null;
  target: string;
  chain: string[];
  terminal: string;
  ipv4: string[];
  ipv6: string[];
};

export type TopologyEmailRoutingInput = {
  settings?: Pick<EmailRoutingSettingsResponse, "enabled"> | null;
  rules?: EmailRoutingRuleResponse[] | null;
};

export type TopologyGraphInput = {
  zoneName: string;
  records: DNSRecord[];
  /** MX trails from the full graph summary; missing targets are resolved via `resolveName`. */
  mxTrails?: TopologyMxTrail[];
  resolveName: TopologyNameResolver;
  /** Provider fingerprints already detected by the full graph (`{ name, via }`). */
  detectedServices?: Array<{ name: string; via: string }>;
  discovery?: ServiceDiscoveryItem[];
  emailRouting?: TopologyEmailRoutingInput | null;
  workerRoutes?: WorkerRouteResponse[] | null;
  isDarkTheme: boolean;
};

export type EmailTopologySummary = {
  mxHosts: Array<{ target: string; priorities: number[] }>;
  spf: {
    present: boolean;
    all: string | null;
    includes: string[];
    lookupTerms: number;
  };
  dkimSelectors: string[];
  dmarc: {
    present: boolean;
    policy: string | null;
    subdomainPolicy: string | null;
    percent: number | null;
    rua: string[];
  };
  mtaSts: boolean;
  tlsRpt: boolean;
  bimi: boolean;
  clientEndpoints: number;
  routingRules: number;
  groups: string[];
};

export type ServicesTopologySummary = {
  hostnames: number;
  proxied: number;
  dnsOnly: number;
  platforms: Array<{ name: string; targets: string[] }>;
  sharedIps: Array<{ ip: string; names: string[] }>;
  workerRoutes: number;
  discovered: number;
  groups: string[];
};

export type TopologyGraphResult<TSummary> = {
  code: string;
  nodeMetaById: Record<string, TopologyNodeMeta>;
  summary?: TSummary;
  isEmpty: boolean;
  /** True when node or edge limits truncated the graph. */
  truncated: boolean;
};

export const EMAIL_TOPOLOGY_GROUPS = {
  inbound: "Inbound mail",
  auth: "Authentication",
  policy: "Transport & reporting",
  clients: "Client autodiscovery",
  routing: "Cloudflare Email Routing",
} as const;

export const SERVICES_TOPOLOGY_GROUPS = {
  proxied: "Proxied by Cloudflare",
  origins: "DNS-only origins",
  platforms: "Third-party platforms",
  workers: "Workers",
} as const;

export const EMAIL_TOPOLOGY_EMPTY_MESSAGE =
  "No email records (MX / SPF / DKIM / DMARC) in this zone";
export const SERVICES_TOPOLOGY_EMPTY_MESSAGE =
  "No service records in this zone";

const IPS_PER_FAMILY_LIMIT = 4;
const PTR_HOSTS_PER_IP_LIMIT = 2;
const CHAIN_HOPS_LIMIT = 8;

// ── Mermaid writer ──────────────────────────────────────────────────────────

type NodeClass =
  | "zone"
  | "record"
  | "target"
  | "ip"
  | "service"
  | "policy"
  | "disabled";
type EdgeStyle = "solid" | "dotted";

type GraphGroup = { id: string; title: string; nodeLines: string[] };

const ZONE_NODE_ID = "zone_root";

function esc(value: string): string {
  return escapeMermaidLabel(value);
}

function sanitizeGraphId(value: string): string {
  return (
    String(value ?? "")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^(\d)/, "_$1")
      .slice(0, 40) || "grp"
  );
}

function classDefLines(isDarkTheme: boolean): string[] {
  const zoneText = isDarkTheme ? "#dce6ff" : "#1f2a44";
  const recordText = isDarkTheme ? "#ddfff2" : "#143727";
  const targetText = isDarkTheme ? "#fff5db" : "#4a3600";
  const ipText = isDarkTheme ? "#ffe3e3" : "#5d1b1b";
  const serviceText = isDarkTheme ? "#efe8ff" : "#2f1f5d";
  const areaText = isDarkTheme ? "#c7d2fe" : "#334155";
  const policyText = isDarkTheme ? "#f3e8ff" : "#3b0764";
  const disabledText = isDarkTheme ? "#c9ced6" : "#495057";
  return [
    `  classDef zone fill:#5b8cff22,stroke:#5b8cff,stroke-width:1.5px,color:${zoneText};`,
    `  classDef record fill:#20c99722,stroke:#20c997,stroke-width:1.2px,color:${recordText};`,
    `  classDef target fill:#f59f0022,stroke:#f59f00,stroke-width:1.2px,color:${targetText};`,
    `  classDef ip fill:#fa525222,stroke:#fa5252,stroke-width:1.2px,color:${ipText};`,
    `  classDef service fill:#845ef722,stroke:#845ef7,stroke-width:1.2px,color:${serviceText};`,
    `  classDef policy fill:#7048e822,stroke:#7048e8,stroke-width:1.2px,color:${policyText};`,
    `  classDef disabled fill:#868e961a,stroke:#868e96,stroke-width:1px,stroke-dasharray:4 3,color:${disabledText};`,
    `  classDef area fill:#5b8cff0f,stroke:#5b8cff66,stroke-width:1px,stroke-dasharray:4 3,color:${areaText};`,
  ];
}

/**
 * Collects nodes (per group or top-level), edges and metadata, then emits
 * Mermaid with every node declared before the first edge.
 */
class MermaidGraphWriter {
  readonly nodeMetaById: Record<string, TopologyNodeMeta> = {};
  truncated = false;
  private readonly ids = new Map<string, string>();
  private readonly groups = new Map<string, GraphGroup>();
  private readonly groupOrder: string[] = [];
  private readonly topLevelNodeLines: string[] = [];
  private readonly edges: Array<{ from: string; to: string; line: string }> =
    [];
  private readonly edgeKeys = new Set<string>();
  private readonly groupsWithIncomingEdge = new Set<string>();
  private readonly groupByNodeId = new Map<string, string>();
  private nodeCount = 0;
  private nextId = 0;

  constructor(private readonly isDarkTheme: boolean) {}

  group(id: string, title: string): string {
    const safeId = sanitizeGraphId(id);
    if (!this.groups.has(safeId)) {
      this.groups.set(safeId, { id: safeId, title, nodeLines: [] });
      this.groupOrder.push(safeId);
    }
    return safeId;
  }

  hasNode(key: string): boolean {
    return this.ids.has(key);
  }

  idOf(key: string): string | null {
    return this.ids.get(key) ?? null;
  }

  groupSize(groupId: string): number {
    return this.groups.get(groupId)?.nodeLines.length ?? 0;
  }

  /** Declares a node once per `key`; returns its id or null when over the limit. */
  node(
    key: string,
    title: string,
    options: {
      subtitle?: string;
      cls: NodeClass;
      group?: string | null;
      meta?: Partial<TopologyNodeMeta>;
      id?: string;
    },
  ): string | null {
    const existing = this.ids.get(key);
    if (existing) return existing;
    if (this.nodeCount >= TOPOLOGY_GRAPH_DOM_NODE_LIMIT) {
      this.truncated = true;
      return null;
    }
    const id = options.id ?? `n_${this.nextId++}`;
    this.ids.set(key, id);
    this.nodeCount += 1;
    const label = buildNodeLabel(title, options.subtitle ?? "");
    const line = `${id}["${esc(label)}"]:::${options.cls}`;
    const group = options.group ? this.groups.get(options.group) : null;
    if (group) {
      group.nodeLines.push(`    ${line}`);
      this.groupByNodeId.set(id, group.id);
    } else {
      this.topLevelNodeLines.push(`  ${line}`);
    }
    const text =
      options.meta?.text ??
      (options.subtitle ? `${title} | ${options.subtitle}` : title);
    this.nodeMetaById[id] = {
      text,
      ...(options.meta?.recordId ? { recordId: options.meta.recordId } : {}),
      ...(options.meta?.address ? { address: options.meta.address } : {}),
    };
    return id;
  }

  edge(
    from: string | null,
    to: string | null,
    options: { label?: string; style?: EdgeStyle } = {},
  ): void {
    if (!from || !to || from === to) return;
    const label = options.label ?? "";
    const style = options.style ?? "solid";
    const key = `${from}|${label}|${to}`;
    if (this.edgeKeys.has(key)) return;
    if (this.edges.length >= TOPOLOGY_GRAPH_DOM_EDGE_LIMIT) {
      this.truncated = true;
      return;
    }
    this.edgeKeys.add(key);
    const arrow =
      style === "dotted"
        ? label
          ? `-. "${esc(label)}" .->`
          : "-.->"
        : label
          ? `-- "${esc(label)}" -->`
          : "-->";
    this.edges.push({ from, to, line: `  ${from} ${arrow} ${to}` });
    // A group counts as "entered" once an edge from outside it reaches the
    // group itself or one of its nodes.
    const toGroup = this.groups.has(to) ? to : this.groupByNodeId.get(to);
    const fromGroup = this.groupByNodeId.get(from);
    if (toGroup && fromGroup !== toGroup)
      this.groupsWithIncomingEdge.add(toGroup);
  }

  /** One edge from the zone node to a group, only for non-empty groups without another entry edge. */
  connectZoneToGroups(groupIds: string[]): void {
    for (const groupId of groupIds) {
      if (this.groupSize(groupId) === 0) continue;
      if (this.groupsWithIncomingEdge.has(groupId)) continue;
      this.edge(ZONE_NODE_ID, groupId);
    }
  }

  usedGroupIds(): string[] {
    return this.groupOrder.filter((id) => this.groupSize(id) > 0);
  }

  get edgeCount(): number {
    return this.edges.length;
  }

  get totalNodes(): number {
    return this.nodeCount;
  }

  build(): string {
    const lines: string[] = ["flowchart LR"];
    const zoneLine = this.topLevelNodeLines.find((line) =>
      line.trimStart().startsWith(`${ZONE_NODE_ID}[`),
    );
    if (zoneLine) lines.push(zoneLine);
    const usedGroups = this.usedGroupIds();
    for (const groupId of usedGroups) {
      const group = this.groups.get(groupId)!;
      lines.push(
        `  subgraph ${group.id}["${esc(group.title)}"]`,
        "    direction LR",
        ...group.nodeLines,
        "  end",
      );
    }
    for (const line of this.topLevelNodeLines) {
      if (line !== zoneLine) lines.push(line);
    }
    // Edges that point at a group which stayed empty would make Mermaid
    // invent a node with the group's id; drop them.
    const emptyGroups = new Set(
      this.groupOrder.filter((id) => this.groupSize(id) === 0),
    );
    for (const edge of this.edges) {
      if (emptyGroups.has(edge.from) || emptyGroups.has(edge.to)) continue;
      lines.push(edge.line);
    }
    lines.push(...classDefLines(this.isDarkTheme));
    if (usedGroups.length > 0)
      lines.push(`  class ${usedGroups.join(",")} area`);
    return lines.join("\n");
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function zoneOf(zoneName: string): string {
  return normalizeDomain(zoneName);
}

function recordName(record: DNSRecord, zone: string): string {
  const raw = normalizeDomain(record.name);
  return !raw || raw === "@" ? zone : raw;
}

function shortName(name: string, zone: string): string {
  if (name === zone) return zone;
  return zone && name.endsWith(`.${zone}`)
    ? name.slice(0, -(zone.length + 1))
    : name;
}

function ttlText(records: DNSRecord[]): string {
  const values = Array.from(
    new Set(records.map((r) => String(r.ttl ?? "auto"))),
  );
  if (values.length !== 1) return "mixed ttl";
  return values[0] === "1" || values[0] === "auto"
    ? "auto"
    : `ttl ${values[0]}`;
}

function proxyText(records: DNSRecord[]): string {
  const values = Array.from(
    new Set(records.map((r) => (r.proxied ? "proxied" : "dns-only"))),
  );
  return values.length === 1 ? values[0] : "proxy mixed";
}

function fingerprint(target: string): string | null {
  for (const fp of SERVICE_PATTERNS) {
    if (fp.pattern.test(target)) return fp.service;
  }
  return null;
}

function singleRecordId(records: DNSRecord[]): string | undefined {
  return records.length === 1 && records[0]?.id
    ? String(records[0].id)
    : undefined;
}

function resolveSafely(
  resolveName: TopologyNameResolver,
  name: string,
): TopologyResolvedName {
  try {
    const resolved = resolveName(name);
    return {
      chain: Array.isArray(resolved?.chain) ? resolved.chain : [name],
      terminal: resolved?.terminal || name,
      ipv4: Array.isArray(resolved?.ipv4) ? resolved.ipv4 : [],
      ipv6: Array.isArray(resolved?.ipv6) ? resolved.ipv6 : [],
      reverseHostnamesByIp: resolved?.reverseHostnamesByIp,
      geoByIp: resolved?.geoByIp,
    };
  } catch {
    return { chain: [name], terminal: name, ipv4: [], ipv6: [] };
  }
}

function ipSubtitle(ip: string, geo?: TopologyResolvedName["geoByIp"]): string {
  const entry = geo?.[ip];
  if (!entry?.country) return "IP";
  const code = entry.countryCode ? `${entry.countryCode.toUpperCase()} - ` : "";
  return `IP | GEO: ${code}${entry.country}`;
}

/**
 * Draws `host → CNAME chain → IPs (→ PTR)` starting from an already declared
 * host node. Chain/IP nodes are keyed globally so shared targets appear once.
 */
function emitHostChain(
  writer: MermaidGraphWriter,
  hostNodeId: string | null,
  hostName: string,
  resolved: TopologyResolvedName,
  options: { group?: string | null; ips?: boolean; ptr?: boolean } = {},
): string[] {
  if (!hostNodeId) return [];
  const includeIps = options.ips ?? true;
  const ipNodeIds: string[] = [];
  let previousId = hostNodeId;
  const chain = resolved.chain.slice(0, CHAIN_HOPS_LIMIT + 1);
  for (let i = 1; i < chain.length; i += 1) {
    const hop = normalizeDomain(chain[i]);
    if (!hop || hop === hostName) continue;
    const hopId = writer.node(`target:${hop}`, hop, {
      cls: "target",
      group: options.group,
      meta: { address: hop },
    });
    writer.edge(previousId, hopId, { label: "CNAME", style: "dotted" });
    if (!hopId) break;
    previousId = hopId;
  }
  if (!includeIps) return ipNodeIds;
  const attachIps = (ips: string[], family: "A" | "AAAA") => {
    const visible = ips.slice(0, IPS_PER_FAMILY_LIMIT);
    for (const ip of visible) {
      const ipId = writer.node(`ip:${ip}`, ip, {
        subtitle: ipSubtitle(ip, resolved.geoByIp),
        cls: "ip",
        group: options.group,
        meta: { address: ip },
      });
      writer.edge(previousId, ipId, { label: family, style: "dotted" });
      if (!ipId) continue;
      ipNodeIds.push(ipId);
      if (!options.ptr) continue;
      const ptrNames = (resolved.reverseHostnamesByIp?.[ip] ?? []).slice(
        0,
        PTR_HOSTS_PER_IP_LIMIT,
      );
      for (const ptrName of ptrNames) {
        const ptr = normalizeDomain(ptrName);
        if (!ptr) continue;
        const ptrId = writer.node(`target:${ptr}`, ptr, {
          cls: "target",
          group: options.group,
          meta: { address: ptr },
        });
        writer.edge(ipId, ptrId, { label: "PTR", style: "dotted" });
      }
    }
  };
  attachIps(resolved.ipv4, "A");
  attachIps(resolved.ipv6, "AAAA");
  return ipNodeIds;
}

function emitProviderNode(
  writer: MermaidGraphWriter,
  targetNodeId: string | null,
  target: string,
  group: string | null,
): string | null {
  const provider = fingerprint(target);
  if (!provider || !targetNodeId) return null;
  const providerId = writer.node(`provider:${provider}`, provider, {
    subtitle: "provider",
    cls: "service",
    group,
  });
  writer.edge(targetNodeId, providerId, { style: "dotted" });
  return provider;
}

/**
 * Local resolver over the zone's own records (CNAME chain → A/AAAA), merged
 * with external resolutions when available. Handy for callers that do not
 * already keep the full graph's maps.
 */
export function createTopologyNameResolver(
  records: DNSRecord[],
  externalResolutionByName: Record<string, ExternalDnsResolution> = {},
  maxHops = CHAIN_HOPS_LIMIT,
): TopologyNameResolver {
  const cnameMap = new Map<string, string>();
  const ipv4ByName = new Map<string, string[]>();
  const ipv6ByName = new Map<string, string[]>();
  for (const record of records) {
    const name = normalizeDomain(record.name);
    if (!name) continue;
    if (record.type === "CNAME") {
      const to = normalizeDomain(record.content);
      if (to && !cnameMap.has(name)) cnameMap.set(name, to);
    } else if (record.type === "A" || record.type === "AAAA") {
      const ip = String(record.content ?? "").trim();
      if (!ip) continue;
      const map = record.type === "A" ? ipv4ByName : ipv6ByName;
      const list = map.get(name) ?? [];
      if (!list.includes(ip)) list.push(ip);
      map.set(name, list);
    }
  }
  return (name: string) => {
    const local = resolveNameToTerminal(
      name,
      cnameMap,
      ipv4ByName,
      ipv6ByName,
      maxHops,
    );
    return pickBestResolution(name, local, externalResolutionByName);
  };
}

function groupRecordsByName(
  records: DNSRecord[],
  zone: string,
): Map<string, DNSRecord[]> {
  const byName = new Map<string, DNSRecord[]>();
  for (const record of records) {
    const name = recordName(record, zone);
    const list = byName.get(name) ?? [];
    list.push(record);
    byName.set(name, list);
  }
  return byName;
}

function emailNamesFromMx(
  records: DNSRecord[],
  mxTrails: TopologyMxTrail[],
): Set<string> {
  const names = new Set<string>();
  for (const trail of mxTrails) {
    for (const hop of trail.chain) names.add(normalizeDomain(hop));
    if (trail.terminal) names.add(normalizeDomain(trail.terminal));
    if (trail.target) names.add(normalizeDomain(trail.target));
  }
  for (const record of records) {
    if (record.type !== "MX") continue;
    const parsed = parseMxRecord(record);
    if (parsed) names.add(parsed.target);
  }
  names.delete("");
  return names;
}

// ── Email graph ─────────────────────────────────────────────────────────────

export function buildEmailTopologyMermaid(
  input: TopologyGraphInput,
): TopologyGraphResult<EmailTopologySummary> {
  const zone = zoneOf(input.zoneName);
  const records = Array.isArray(input.records) ? input.records : [];
  const mxTrails = input.mxTrails ?? [];
  const writer = new MermaidGraphWriter(Boolean(input.isDarkTheme));
  const byName = groupRecordsByName(records, zone);
  const zoneTitle = `Zone: ${zone || input.zoneName}`;
  writer.node("zone", zoneTitle, {
    cls: "zone",
    id: ZONE_NODE_ID,
    meta: { text: zoneTitle },
  });
  const G = {
    inbound: writer.group("inbound", EMAIL_TOPOLOGY_GROUPS.inbound),
    auth: writer.group("auth", EMAIL_TOPOLOGY_GROUPS.auth),
    policy: writer.group("policy", EMAIL_TOPOLOGY_GROUPS.policy),
    clients: writer.group("clients", EMAIL_TOPOLOGY_GROUPS.clients),
    routing: writer.group("routing", EMAIL_TOPOLOGY_GROUPS.routing),
  };
  const summary: EmailTopologySummary = {
    mxHosts: [],
    spf: { present: false, all: null, includes: [], lookupTerms: 0 },
    dkimSelectors: [],
    dmarc: {
      present: false,
      policy: null,
      subdomainPolicy: null,
      percent: null,
      rua: [],
    },
    mtaSts: false,
    tlsRpt: false,
    bimi: false,
    clientEndpoints: 0,
    routingRules: 0,
    groups: [],
  };

  // 1. Inbound mail: zone → MX anchor → hosts (MX prio) → chain → IPs → PTR.
  const mxRecords = records.filter((r) => r.type === "MX");
  const mxByTarget = new Map<
    string,
    { priorities: number[]; records: DNSRecord[] }
  >();
  for (const record of mxRecords) {
    const parsed = parseMxRecord(record);
    if (!parsed) continue;
    const entry = mxByTarget.get(parsed.target) ?? {
      priorities: [],
      records: [],
    };
    if (parsed.priority !== null && !entry.priorities.includes(parsed.priority))
      entry.priorities.push(parsed.priority);
    entry.records.push(record);
    mxByTarget.set(parsed.target, entry);
  }
  let mxAnchorId: string | null = null;
  if (mxByTarget.size > 0) {
    mxAnchorId = writer.node("mx:anchor", "MX", {
      subtitle: `${mxByTarget.size} host${mxByTarget.size === 1 ? "" : "s"}`,
      cls: "record",
      group: G.inbound,
      meta: {
        text: `MX | ${mxRecords.length} record${mxRecords.length === 1 ? "" : "s"}`,
        recordId: singleRecordId(mxRecords),
        address: zone,
      },
    });
    writer.edge(ZONE_NODE_ID, G.inbound);
    const ordered = Array.from(mxByTarget.entries()).sort((a, b) => {
      const pa = a[1].priorities[0] ?? Number.MAX_SAFE_INTEGER;
      const pb = b[1].priorities[0] ?? Number.MAX_SAFE_INTEGER;
      return pa - pb || a[0].localeCompare(b[0]);
    });
    for (const [target, entry] of ordered) {
      const priorities = [...entry.priorities].sort((a, b) => a - b);
      summary.mxHosts.push({ target, priorities });
      const hostId = writer.node(`target:${target}`, target, {
        subtitle: "mail host",
        cls: "target",
        group: G.inbound,
        meta: { recordId: singleRecordId(entry.records), address: target },
      });
      const prioLabel =
        priorities.length > 0 ? `MX ${priorities.join(", ")}` : "MX";
      writer.edge(mxAnchorId, hostId, { label: prioLabel });
      const trail = mxTrails.find((t) => normalizeDomain(t.target) === target);
      const resolved: TopologyResolvedName = trail
        ? {
            chain: trail.chain.length ? trail.chain : [target],
            terminal: trail.terminal || target,
            ipv4: trail.ipv4,
            ipv6: trail.ipv6,
          }
        : resolveSafely(input.resolveName, target);
      emitHostChain(writer, hostId, target, resolved, {
        group: G.inbound,
        ips: true,
        ptr: true,
      });
      emitProviderNode(writer, hostId, target, G.inbound);
    }
  }

  // 2. Authentication: SPF, DKIM, DMARC.
  const spfTxtByName = new Map<string, DNSRecord>();
  for (const record of records) {
    if (
      (record.type !== "TXT" && record.type !== "SPF") ||
      !isSpfRecord(record.content)
    )
      continue;
    const name = recordName(record, zone);
    if (!spfTxtByName.has(name)) spfTxtByName.set(name, record);
  }
  const lookupSpfTxt = (name: string) =>
    spfTxtByName.get(normalizeDomain(name))?.content ?? null;
  const apexSpf = zone ? spfTxtByName.get(zone) : undefined;
  if (apexSpf) {
    const tree = collectSpfTree(zone, lookupSpfTxt);
    if (tree) {
      summary.spf.present = true;
      summary.spf.all = tree.record.allQualifier;
      summary.spf.lookupTerms = tree.record.lookupTerms;
      writer.edge(ZONE_NODE_ID, G.auth);
      emitSpfNode(
        writer,
        tree,
        zone,
        G.auth,
        spfTxtByName,
        mxAnchorId,
        summary,
      );
    }
  }

  const dkimRecords = records.filter(
    (r) => classifyEmailName(recordName(r, zone)) === "dkim",
  );
  if (dkimRecords.length > 0) writer.edge(ZONE_NODE_ID, G.auth);
  for (const record of dkimRecords) {
    const name = recordName(record, zone);
    const selector = dkimSelectorFromName(name) ?? name;
    if (!summary.dkimSelectors.includes(selector))
      summary.dkimSelectors.push(selector);
    const key = `dkim:${name}:${record.type}`;
    if (record.type === "CNAME") {
      const target = normalizeDomain(record.content);
      const dkimId = writer.node(key, `DKIM ${selector}`, {
        subtitle: "CNAME",
        cls: "record",
        group: G.auth,
        meta: {
          text: `${name} | DKIM selector ${selector} | CNAME ${target}`,
          recordId: record.id,
          address: name,
        },
      });
      if (!target) continue;
      const targetId = writer.node(`target:${target}`, target, {
        cls: "target",
        group: G.auth,
        meta: { address: target },
      });
      writer.edge(dkimId, targetId, { label: "DKIM" });
      const resolved = resolveSafely(input.resolveName, target);
      emitHostChain(writer, targetId, target, resolved, {
        group: G.auth,
        ips: false,
      });
      emitProviderNode(writer, targetId, target, G.auth);
      continue;
    }
    const dkim = parseDkim(record.content);
    const state = dkim.revoked
      ? "revoked"
      : dkim.hasPublicKey
        ? "key present"
        : "no key";
    const subtitleParts = [dkim.keyType, state, dkim.testing ? "testing" : ""];
    writer.node(key, `DKIM ${selector}`, {
      subtitle: subtitleParts.filter(Boolean).join(" · "),
      cls: dkim.revoked ? "disabled" : "record",
      group: G.auth,
      meta: {
        text: `${name} | DKIM ${dkim.keyType} | ${state}${dkim.testing ? " | testing" : ""}`,
        recordId: record.id,
        address: name,
      },
    });
  }

  const dmarcRecords = records.filter(
    (r) =>
      r.type === "TXT" && classifyEmailName(recordName(r, zone)) === "dmarc",
  );
  for (const record of dmarcRecords) {
    const name = recordName(record, zone);
    const dmarc = parseDmarc(record.content);
    if (!dmarc.valid) continue;
    writer.edge(ZONE_NODE_ID, G.auth);
    const scope = name.replace(/^_dmarc\.?/, "");
    const isApex = !scope || scope === zone;
    if (isApex) {
      summary.dmarc = {
        present: true,
        policy: dmarc.policy,
        subdomainPolicy: dmarc.subdomainPolicy,
        percent: dmarc.percent,
        rua: dmarc.rua,
      };
    }
    const subtitle = [
      `p=${dmarc.policy ?? "?"}`,
      dmarc.subdomainPolicy ? `sp=${dmarc.subdomainPolicy}` : "",
      dmarc.percent !== 100 ? `pct=${dmarc.percent}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const dmarcId = writer.node(
      `dmarc:${name}`,
      isApex ? "DMARC" : `DMARC ${shortName(scope, zone)}`,
      {
        subtitle,
        cls: "policy",
        group: G.auth,
        meta: {
          text: `${name} | DMARC p=${dmarc.policy ?? "?"} sp=${dmarc.subdomainPolicy ?? "-"} pct=${dmarc.percent} adkim=${dmarc.adkim} aspf=${dmarc.aspf}`,
          recordId: record.id,
          address: name,
        },
      },
    );
    for (const address of dmarc.rua) {
      const reportId = writer.node(`mailto:${address}`, address, {
        subtitle: "reports",
        cls: "target",
        group: G.auth,
        meta: { address },
      });
      writer.edge(dmarcId, reportId, { label: "DMARC rua" });
    }
    for (const address of dmarc.ruf) {
      const reportId = writer.node(`mailto:${address}`, address, {
        subtitle: "reports",
        cls: "target",
        group: G.auth,
        meta: { address },
      });
      writer.edge(dmarcId, reportId, { label: "DMARC ruf" });
    }
  }

  // 3. Transport & reporting: MTA-STS, TLS-RPT, BIMI.
  for (const record of records) {
    if (record.type !== "TXT") continue;
    const name = recordName(record, zone);
    const kind = classifyEmailName(name);
    if (kind === "mta-sts") {
      const sts = parseMtaSts(record.content);
      if (!sts.valid) continue;
      summary.mtaSts = true;
      writer.edge(ZONE_NODE_ID, G.policy);
      const stsId = writer.node(`mtasts:${name}`, "MTA-STS", {
        subtitle: sts.id ? `id ${sts.id}` : "policy",
        cls: "policy",
        group: G.policy,
        meta: {
          text: `${name} | MTA-STS id ${sts.id ?? "?"}`,
          recordId: record.id,
          address: name,
        },
      });
      const hostName = `mta-sts.${name.replace(/^_mta-sts\.?/, "")}`.replace(
        /\.$/,
        "",
      );
      const hostRecords = byName.get(hostName) ?? [];
      const hostRecord = hostRecords.find((r) =>
        ["A", "AAAA", "CNAME"].includes(r.type),
      );
      if (hostRecord) {
        const hostId = writer.node(`host:${hostName}`, hostName, {
          subtitle: `${hostRecord.type} · ${proxyText(hostRecords)}`,
          cls: "record",
          group: G.policy,
          meta: {
            text: `${hostName} | policy host | ${hostRecord.type} | ${proxyText(hostRecords)}`,
            recordId: singleRecordId(hostRecords),
            address: hostName,
          },
        });
        writer.edge(stsId, hostId, { label: "policy host" });
        emitHostChain(
          writer,
          hostId,
          hostName,
          resolveSafely(input.resolveName, hostName),
          { group: G.policy, ips: true },
        );
      }
    } else if (kind === "tls-rpt") {
      const tlsRpt = parseTlsRpt(record.content);
      if (!tlsRpt.valid) continue;
      summary.tlsRpt = true;
      writer.edge(ZONE_NODE_ID, G.policy);
      const tlsId = writer.node(`tlsrpt:${name}`, "TLS-RPT", {
        subtitle: `${tlsRpt.rua.length + tlsRpt.ruaUrls.length} report target${tlsRpt.rua.length + tlsRpt.ruaUrls.length === 1 ? "" : "s"}`,
        cls: "policy",
        group: G.policy,
        meta: { text: `${name} | TLS-RPT`, recordId: record.id, address: name },
      });
      for (const address of tlsRpt.rua) {
        const reportId = writer.node(`mailto:${address}`, address, {
          subtitle: "reports",
          cls: "target",
          group: G.policy,
          meta: { address },
        });
        writer.edge(tlsId, reportId, { label: "TLS-RPT rua" });
      }
      for (const url of tlsRpt.ruaUrls) {
        const reportId = writer.node(`url:${url}`, url, {
          subtitle: "reports",
          cls: "target",
          group: G.policy,
          meta: { address: url },
        });
        writer.edge(tlsId, reportId, { label: "TLS-RPT rua" });
      }
    } else if (kind === "bimi") {
      const bimi = parseBimi(record.content);
      if (!bimi.valid) continue;
      summary.bimi = true;
      writer.edge(ZONE_NODE_ID, G.policy);
      const bimiId = writer.node(`bimi:${name}`, "BIMI", {
        subtitle: bimi.logoUrl ? "logo published" : "no logo",
        cls: "policy",
        group: G.policy,
        meta: { text: `${name} | BIMI`, recordId: record.id, address: name },
      });
      if (bimi.logoUrl) {
        const logoId = writer.node(`url:${bimi.logoUrl}`, bimi.logoUrl, {
          subtitle: "logo",
          cls: "target",
          group: G.policy,
          meta: { address: bimi.logoUrl },
        });
        writer.edge(bimiId, logoId, { label: "BIMI logo" });
      }
      if (bimi.authorityUrl) {
        const vmcId = writer.node(
          `url:${bimi.authorityUrl}`,
          bimi.authorityUrl,
          {
            subtitle: "VMC",
            cls: "target",
            group: G.policy,
            meta: { address: bimi.authorityUrl },
          },
        );
        writer.edge(bimiId, vmcId, { label: "BIMI authority" });
      }
    }
  }

  // 4. Client autodiscovery: SRV endpoints and autoconfig/autodiscover hosts.
  for (const [name, nameRecords] of byName.entries()) {
    const kind = classifyEmailName(name);
    if (kind === "client-srv") {
      for (const record of nameRecords) {
        if (record.type !== "SRV") continue;
        const srv = parseSrvRecord(record);
        if (!srv) continue;
        summary.clientEndpoints += 1;
        writer.edge(ZONE_NODE_ID, G.clients);
        const service = shortName(name, zone);
        const srvId = writer.node(`srv:${record.id || name}`, service, {
          subtitle: `SRV${srv.priority !== null ? ` · prio ${srv.priority}` : ""}`,
          cls: "record",
          group: G.clients,
          meta: {
            text: `${name} | SRV | ${record.content}`,
            recordId: record.id,
            address: name,
          },
        });
        const hostId = writer.node(`target:${srv.target}`, srv.target, {
          cls: "target",
          group: G.clients,
          meta: { address: srv.target },
        });
        writer.edge(srvId, hostId, {
          label: srv.port !== null ? `SRV :${srv.port}` : "SRV",
        });
        emitHostChain(
          writer,
          hostId,
          srv.target,
          resolveSafely(input.resolveName, srv.target),
          { group: G.clients, ips: true },
        );
      }
    } else if (kind === "client-host") {
      const hostRecords = nameRecords.filter((r) =>
        ["A", "AAAA", "CNAME"].includes(r.type),
      );
      if (hostRecords.length === 0) continue;
      summary.clientEndpoints += 1;
      writer.edge(ZONE_NODE_ID, G.clients);
      const types = Array.from(new Set(hostRecords.map((r) => r.type)));
      const hostId = writer.node(`host:${name}`, name, {
        subtitle: `${types.join("/")} · ${proxyText(hostRecords)}`,
        cls: "record",
        group: G.clients,
        meta: {
          text: `${name} | ${types.join("/")} | ${proxyText(hostRecords)} | ${ttlText(hostRecords)}`,
          recordId: singleRecordId(hostRecords),
          address: name,
        },
      });
      const cname = hostRecords.find((r) => r.type === "CNAME");
      if (cname) {
        const target = normalizeDomain(cname.content);
        const targetId = writer.node(`target:${target}`, target, {
          cls: "target",
          group: G.clients,
          meta: { address: target },
        });
        writer.edge(hostId, targetId, { label: "CNAME" });
        emitHostChain(
          writer,
          targetId,
          target,
          resolveSafely(input.resolveName, target),
          { group: G.clients, ips: true },
        );
      } else {
        emitHostChain(
          writer,
          hostId,
          name,
          resolveSafely(input.resolveName, name),
          { group: G.clients, ips: true },
        );
      }
    }
  }

  // 5. Cloudflare Email Routing.
  const routing = input.emailRouting;
  if (routing?.settings?.enabled) {
    const rules = [...(routing.rules ?? [])].sort(
      (a, b) =>
        (a.priority ?? Number.MAX_SAFE_INTEGER) -
        (b.priority ?? Number.MAX_SAFE_INTEGER),
    );
    summary.routingRules = rules.length;
    writer.edge(ZONE_NODE_ID, G.routing);
    const routingId = writer.node("routing:root", "Email Routing", {
      subtitle: `enabled · ${rules.length} rule${rules.length === 1 ? "" : "s"}`,
      cls: "service",
      group: G.routing,
      meta: {
        text: `Cloudflare Email Routing | enabled | ${rules.length} rules`,
      },
    });
    rules.forEach((rule, index) => {
      const enabled = rule.enabled !== false;
      const matcher = rule.matchers?.[0];
      const isCatchAll = !matcher || matcher.type === "all" || !matcher.value;
      const title = isCatchAll
        ? "Catch-all"
        : `${matcher.field || "to"}=${matcher.value}`;
      const ruleKey = `rule:${rule.id || rule.tag || index}`;
      const ruleId = writer.node(ruleKey, title, {
        subtitle: [rule.name || "", enabled ? "" : "disabled"]
          .filter(Boolean)
          .join(" · "),
        cls: enabled ? "record" : "disabled",
        group: G.routing,
        meta: {
          text: `Email Routing rule${rule.name ? ` ${rule.name}` : ""} | ${title} | ${enabled ? "enabled" : "disabled"}`,
        },
      });
      writer.edge(routingId, ruleId, {
        label: "rule",
        style: enabled ? "solid" : "dotted",
      });
      for (const action of rule.actions ?? []) {
        const type = String(action.type ?? "").toLowerCase();
        const style: EdgeStyle = enabled ? "solid" : "dotted";
        if (type === "forward") {
          for (const destination of action.value ?? []) {
            const address = String(destination ?? "")
              .trim()
              .toLowerCase();
            if (!address) continue;
            const destId = writer.node(`mailto:${address}`, address, {
              subtitle: "destination",
              cls: enabled ? "target" : "disabled",
              group: G.routing,
              meta: { address },
            });
            writer.edge(ruleId, destId, { label: "forward", style });
          }
        } else if (type === "worker") {
          for (const script of action.value ?? []) {
            const name = String(script ?? "").trim();
            if (!name) continue;
            const workerId = writer.node(`worker:${name}`, name, {
              subtitle: "Worker",
              cls: enabled ? "service" : "disabled",
              group: G.routing,
            });
            writer.edge(ruleId, workerId, { label: "worker", style });
          }
        } else if (type === "drop") {
          const dropId = writer.node(`drop:${ruleKey}`, "Drop", {
            cls: "disabled",
            group: G.routing,
            meta: { text: "Drop message" },
          });
          writer.edge(ruleId, dropId, { label: "drop", style });
        }
      }
    });
  }

  const usedGroups = writer.usedGroupIds();
  summary.groups = usedGroups;
  const isEmpty = usedGroups.length === 0;
  return {
    code: writer.build(),
    nodeMetaById: writer.nodeMetaById,
    summary,
    isEmpty,
    truncated: writer.truncated,
  };
}

function emitSpfNode(
  writer: MermaidGraphWriter,
  node: SpfTreeNode,
  zone: string,
  group: string,
  spfTxtByName: Map<string, DNSRecord>,
  mxAnchorId: string | null,
  summary: EmailTopologySummary,
): string | null {
  const record = node.record;
  const source = spfTxtByName.get(node.name);
  const isApex = node.name === zone;
  const title = isApex ? "SPF" : `SPF ${shortName(node.name, zone)}`;
  const subtitle = [
    describeSpfAll(record.allQualifier),
    record.lookupTerms > 0
      ? `${record.lookupTerms} lookup${record.lookupTerms === 1 ? "" : "s"}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const spfId = writer.node(`spf:${node.name}`, title, {
    subtitle,
    cls: "record",
    group,
    meta: {
      text: `${node.name} | SPF | ${source?.content ?? ""}`.trim(),
      recordId: source?.id,
      address: node.name,
    },
  });
  if (!spfId) return null;
  const childByName = new Map(node.children.map((c) => [c.name, c]));
  const qualifierPrefix = (q: string) => (q === "+" ? "" : q);
  for (const mechanism of record.mechanisms) {
    const label = `SPF ${qualifierPrefix(mechanism.qualifier)}${mechanism.type}`;
    if (mechanism.type === "include") {
      if (!mechanism.value) continue;
      if (node.depth === 0 && !summary.spf.includes.includes(mechanism.value))
        summary.spf.includes.push(mechanism.value);
      const child = childByName.get(mechanism.value);
      if (child && child.via === "include") {
        const childId = emitSpfNode(
          writer,
          child,
          zone,
          group,
          spfTxtByName,
          mxAnchorId,
          summary,
        );
        writer.edge(spfId, childId, { label });
        continue;
      }
      const includeId = writer.node(
        `spfinc:${mechanism.value}`,
        mechanism.value,
        {
          subtitle: "include",
          cls: "target",
          group,
          meta: { address: mechanism.value },
        },
      );
      writer.edge(spfId, includeId, { label });
      emitProviderNode(writer, includeId, mechanism.value, group);
    } else if (mechanism.type === "ip4" || mechanism.type === "ip6") {
      if (!mechanism.value) continue;
      const ipId = writer.node(`ip:${mechanism.value}`, mechanism.value, {
        subtitle: mechanism.value.includes("/") ? "network" : "IP",
        cls: "ip",
        group,
        meta: { address: mechanism.value },
      });
      writer.edge(spfId, ipId, { label });
    } else if (mechanism.type === "mx") {
      if (!mechanism.value && mxAnchorId) {
        writer.edge(spfId, mxAnchorId, { label, style: "dotted" });
      } else if (mechanism.value) {
        const hostId = writer.node(
          `target:${mechanism.value}`,
          mechanism.value,
          {
            cls: "target",
            group,
            meta: { address: mechanism.value },
          },
        );
        writer.edge(spfId, hostId, { label, style: "dotted" });
      }
    } else if (mechanism.type === "a") {
      const host = mechanism.value || node.name;
      const hostId = writer.node(`spfhost:${host}`, host, {
        subtitle: "A/AAAA",
        cls: "target",
        group,
        meta: { address: host },
      });
      writer.edge(spfId, hostId, { label, style: "dotted" });
    } else if (mechanism.type === "exists" || mechanism.type === "ptr") {
      if (!mechanism.value) continue;
      const hostId = writer.node(
        `spfhost:${mechanism.value}`,
        mechanism.value,
        {
          subtitle: mechanism.type,
          cls: "target",
          group,
          meta: { address: mechanism.value },
        },
      );
      writer.edge(spfId, hostId, { label, style: "dotted" });
    }
  }
  if (record.redirect) {
    const child = childByName.get(record.redirect);
    if (child && child.via === "redirect") {
      const childId = emitSpfNode(
        writer,
        child,
        zone,
        group,
        spfTxtByName,
        mxAnchorId,
        summary,
      );
      writer.edge(spfId, childId, { label: "SPF redirect" });
    } else {
      const redirectId = writer.node(
        `spfinc:${record.redirect}`,
        record.redirect,
        {
          subtitle: "redirect",
          cls: "target",
          group,
          meta: { address: record.redirect },
        },
      );
      writer.edge(spfId, redirectId, { label: "SPF redirect" });
      emitProviderNode(writer, redirectId, record.redirect, group);
    }
  }
  return spfId;
}

// ── Services graph ──────────────────────────────────────────────────────────

const SERVICE_RECORD_TYPES = new Set([
  "A",
  "AAAA",
  "CNAME",
  "SRV",
  "HTTPS",
  "SVCB",
]);

function workerRouteHostPattern(pattern: string): RegExp | null {
  const raw = String(pattern ?? "")
    .trim()
    .replace(/^[a-z]+:\/\//i, "");
  const host = raw.split("/")[0]?.toLowerCase() ?? "";
  if (!host) return null;
  const escaped = host
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  try {
    return new RegExp(`^${escaped}$`, "i");
  } catch {
    return null;
  }
}

function discoveryHost(item: ServiceDiscoveryItem): {
  label: string;
  host: string | null;
} {
  const service = String(item.service ?? "").trim();
  const match = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(service);
  if (!match) return { label: service, host: null };
  const host = normalizeDomain(match[2].replace(/:\d+$/, ""));
  return { label: match[1].trim() || service, host: host || null };
}

export function buildServicesTopologyMermaid(
  input: TopologyGraphInput,
): TopologyGraphResult<ServicesTopologySummary> {
  const zone = zoneOf(input.zoneName);
  const records = Array.isArray(input.records) ? input.records : [];
  const writer = new MermaidGraphWriter(Boolean(input.isDarkTheme));
  const byName = groupRecordsByName(records, zone);
  const emailNames = emailNamesFromMx(records, input.mxTrails ?? []);
  const zoneTitle = `Zone: ${zone || input.zoneName}`;
  writer.node("zone", zoneTitle, {
    cls: "zone",
    id: ZONE_NODE_ID,
    meta: { text: zoneTitle },
  });
  const G = {
    proxied: writer.group("proxied", SERVICES_TOPOLOGY_GROUPS.proxied),
    origins: writer.group("origins", SERVICES_TOPOLOGY_GROUPS.origins),
    platforms: writer.group("platforms", SERVICES_TOPOLOGY_GROUPS.platforms),
    workers: writer.group("workers", SERVICES_TOPOLOGY_GROUPS.workers),
  };
  const summary: ServicesTopologySummary = {
    hostnames: 0,
    proxied: 0,
    dnsOnly: 0,
    platforms: [],
    sharedIps: [],
    workerRoutes: 0,
    discovered: 0,
    groups: [],
  };
  const platformTargets = new Map<string, Set<string>>();
  const ipOwners = new Map<string, Set<string>>();
  const ipNodeIdsByHost = new Map<string, string[]>();
  const hostNodeIds = new Map<string, string>();

  const workerRoutes = (input.workerRoutes ?? []).filter(
    (route) => route && String(route.pattern ?? "").trim(),
  );
  const workerMatchers = workerRoutes.map((route) => ({
    route,
    regex: workerRouteHostPattern(route.pattern),
  }));

  const hostNames = Array.from(byName.keys())
    .filter((name) => {
      if (emailNames.has(name) || isEmailOnlyName(name)) return false;
      return (byName.get(name) ?? []).some((r) =>
        SERVICE_RECORD_TYPES.has(r.type),
      );
    })
    .sort((a, b) => {
      if (a === zone) return -1;
      if (b === zone) return 1;
      return a.localeCompare(b);
    });

  for (const name of hostNames) {
    const nameRecords = (byName.get(name) ?? []).filter((r) =>
      SERVICE_RECORD_TYPES.has(r.type),
    );
    const proxied = nameRecords.some((r) => r.proxied);
    summary.hostnames += 1;
    if (proxied) summary.proxied += 1;
    else summary.dnsOnly += 1;
    const group = proxied ? G.proxied : G.origins;
    const types = Array.from(new Set(nameRecords.map((r) => r.type)));
    const hostId = writer.node(`host:${name}`, name, {
      subtitle: `${proxyText(nameRecords)} · ${ttlText(nameRecords)}`,
      cls: "record",
      group,
      meta: {
        text: `${name} | ${types.join("/")} | ${proxyText(nameRecords)} | ${ttlText(nameRecords)}`,
        recordId: singleRecordId(nameRecords),
        address: name,
      },
    });
    if (!hostId) break;
    hostNodeIds.set(name, hostId);

    const ipIds: string[] = [];
    const attachAddresses = (family: "A" | "AAAA") => {
      const ips = Array.from(
        new Set(
          nameRecords
            .filter((r) => r.type === family)
            .map((r) => String(r.content ?? "").trim())
            .filter(Boolean),
        ),
      );
      for (const ip of ips.slice(0, IPS_PER_FAMILY_LIMIT)) {
        const owners = ipOwners.get(ip) ?? new Set<string>();
        owners.add(name);
        ipOwners.set(ip, owners);
        const ipId = writer.node(`ip:${ip}`, ip, {
          subtitle: "IP",
          cls: "ip",
          meta: { address: ip },
        });
        writer.edge(hostId, ipId, { label: family });
        if (ipId) ipIds.push(ipId);
      }
    };
    attachAddresses("A");
    attachAddresses("AAAA");

    const cnameTargets = Array.from(
      new Set(
        nameRecords
          .filter((r) => r.type === "CNAME")
          .map((r) => normalizeDomain(r.content))
          .filter(Boolean),
      ),
    );
    for (const target of cnameTargets) {
      const provider = fingerprint(target);
      const targetGroup = provider ? G.platforms : null;
      const targetId = writer.node(`target:${target}`, target, {
        cls: "target",
        group: targetGroup,
        meta: { address: target },
      });
      writer.edge(hostId, targetId, { label: "CNAME" });
      if (provider) {
        const set = platformTargets.get(provider) ?? new Set<string>();
        set.add(target);
        platformTargets.set(provider, set);
        emitProviderNode(writer, targetId, target, G.platforms);
      }
      const resolved = resolveSafely(input.resolveName, target);
      ipIds.push(
        ...emitHostChain(writer, targetId, target, resolved, {
          group: targetGroup,
          ips: true,
          ptr: false,
        }),
      );
      for (const ip of [...resolved.ipv4, ...resolved.ipv6]) {
        const owners = ipOwners.get(ip) ?? new Set<string>();
        owners.add(name);
        ipOwners.set(ip, owners);
      }
    }

    for (const record of nameRecords) {
      if (record.type === "SRV") {
        const srv = parseSrvRecord(record);
        if (!srv) continue;
        const targetId = writer.node(`target:${srv.target}`, srv.target, {
          cls: "target",
          meta: { address: srv.target },
        });
        writer.edge(hostId, targetId, {
          label: srv.port !== null ? `SRV :${srv.port}` : "SRV",
        });
        ipIds.push(
          ...emitHostChain(
            writer,
            targetId,
            srv.target,
            resolveSafely(input.resolveName, srv.target),
            { ips: true },
          ),
        );
      } else if (record.type === "HTTPS" || record.type === "SVCB") {
        const parts = String(record.content ?? "")
          .trim()
          .split(/\s+/);
        const target = normalizeDomain(parts[1] ?? "");
        if (!target || target === "." || target === name) continue;
        const targetId = writer.node(`target:${target}`, target, {
          cls: "target",
          meta: { address: target },
        });
        writer.edge(hostId, targetId, { label: record.type });
      }
    }
    ipNodeIdsByHost.set(name, ipIds);

    for (const { route, regex } of workerMatchers) {
      if (!regex || !regex.test(name)) continue;
      const patternId = writer.node(`route:${route.pattern}`, route.pattern, {
        subtitle: "route",
        cls: "policy",
        group: G.workers,
        meta: { text: `Worker route ${route.pattern} → ${route.script}` },
      });
      writer.edge(hostId, patternId, { label: "route" });
    }
  }

  // Worker routes: pattern → script, including patterns no hostname matched.
  for (const route of workerRoutes) {
    summary.workerRoutes += 1;
    const patternId = writer.node(`route:${route.pattern}`, route.pattern, {
      subtitle: "route",
      cls: "policy",
      group: G.workers,
      meta: { text: `Worker route ${route.pattern} → ${route.script}` },
    });
    const script = String(route.script ?? "").trim();
    if (!script) continue;
    const scriptId = writer.node(`worker:${script}`, script, {
      subtitle: "Worker",
      cls: "service",
      group: G.workers,
      meta: { text: `Worker script ${script}` },
    });
    writer.edge(patternId, scriptId, { label: "script" });
  }

  // Discovered services: attach to the host's IP (or host) node.
  for (const item of input.discovery ?? []) {
    if (!item || item.status === "down") continue;
    const { label, host } = discoveryHost(item);
    const style: EdgeStyle = item.status === "up" ? "solid" : "dotted";
    let fromId: string | null = ZONE_NODE_ID;
    if (host) {
      const hostId = hostNodeIds.get(host);
      if (!hostId) continue;
      fromId = ipNodeIdsByHost.get(host)?.[0] ?? hostId;
    }
    summary.discovered += 1;
    const serviceId = writer.node(
      `discovered:${label}:${host ?? zone}`,
      label,
      {
        subtitle: item.status,
        cls: "service",
        meta: { text: `${item.service} | ${item.status} | ${item.details}` },
      },
    );
    writer.edge(fromId, serviceId, { label: item.status, style });
  }

  writer.connectZoneToGroups([G.proxied, G.origins, G.workers]);

  summary.platforms = Array.from(platformTargets.entries()).map(
    ([name, targets]) => ({ name, targets: Array.from(targets).sort() }),
  );
  summary.sharedIps = Array.from(ipOwners.entries())
    .filter(([, owners]) => owners.size > 1)
    .map(([ip, owners]) => ({ ip, names: Array.from(owners).sort() }));
  const usedGroups = writer.usedGroupIds();
  summary.groups = usedGroups;
  return {
    code: writer.build(),
    nodeMetaById: writer.nodeMetaById,
    summary,
    isEmpty: summary.hostnames === 0 && summary.workerRoutes === 0,
    truncated: writer.truncated,
  };
}
