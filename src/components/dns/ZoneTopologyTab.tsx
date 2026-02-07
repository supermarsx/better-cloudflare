import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import {
  ChevronDown,
  Copy,
  Edit3,
  ExternalLink,
  FileDown,
  Hand,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  StickyNote,
  ZoomIn,
} from "lucide-react";
import type { DNSRecord } from "@/types/dns";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { TauriClient } from "@/lib/tauri-client";
import { isDesktop } from "@/lib/environment";

type Annotation = {
  id: string;
  x: number;
  y: number;
  text: string;
};

type TopologySummary = {
  cnameChains: Array<{ start: string; chain: string[] }>;
  sharedIps: Array<{ ip: string; names: string[] }>;
  detectedServices: Array<{ name: string; via: string }>;
  mxTrails: Array<{
    from: string;
    priority: number | null;
    target: string;
    chain: string[];
    terminal: string;
    ipv4: string[];
    ipv6: string[];
  }>;
  areas: {
    email: number;
    web: number;
    infra: number;
    misc: number;
  };
  nodeSummaries: Array<{
    name: string;
    records: DNSRecord[];
    resolvedTo: string[];
    areas: Array<"email" | "web" | "infra" | "misc">;
    terminal: string;
    ipv4: string[];
    ipv6: string[];
  }>;
};

type ZoneTopologyTabProps = {
  zoneName: string;
  records: DNSRecord[];
  isLoading?: boolean;
  maxResolutionHops?: number;
  resolverMode?: "dns" | "doh";
  dnsServer?: string;
  customDnsServer?: string;
  dohProvider?: "google" | "cloudflare" | "quad9" | "custom";
  dohCustomUrl?: string;
  exportConfirmPath?: boolean;
  exportFolderPreset?: "system" | "documents" | "downloads" | "desktop" | "custom";
  exportCustomPath?: string;
  disableAnnotations?: boolean;
  disableFullWindow?: boolean;
  lookupTimeoutMs?: number;
  disablePtrLookups?: boolean;
  disableGeoLookups?: boolean;
  geoProvider?: "auto" | "ipwhois" | "ipapi_co" | "ip_api" | "internal";
  scanResolutionChain?: boolean;
  disableServiceDiscovery?: boolean;
  tcpServicePorts?: number[];
  onRefresh: () => Promise<void> | void;
  onEditRecord?: (record: DNSRecord) => void;
};

type ServiceDiscoveryItem = {
  service: string;
  status: "up" | "down" | "inferred";
  details: string;
};

type ExternalDnsResolution = {
  requestedName?: string;
  chain: string[];
  terminal: string;
  ipv4: string[];
  ipv6: string[];
  reverseHostnamesByIp?: Record<string, string[]>;
  geoByIp?: Record<string, { country: string; countryCode?: string }>;
  source: "external";
  error?: string;
};

type TopologyResolutionProgress = {
  running: boolean;
  total: number;
  done: number;
};
type TopologyResolutionCacheEntry = {
  value: ExternalDnsResolution;
  ts: number;
};
type TopologyProbeCacheEntry = {
  host: string;
  httpsUp: boolean;
  httpUp: boolean;
  ts: number;
};
const TOPOLOGY_CACHE_TTL_MS = 5 * 60 * 1000;

function detectDarkThemeMode(): boolean {
  if (typeof document === "undefined") return true;
  const root = document.documentElement;
  const dataTheme = String(root.getAttribute("data-theme") ?? "").toLowerCase();
  if (dataTheme.includes("light") || dataTheme.includes("midday")) return false;
  if (dataTheme.includes("dark") || dataTheme.includes("oled") || dataTheme.includes("night") || dataTheme.includes("sunset")) return true;
  const bgVar = getComputedStyle(root).getPropertyValue("--background").trim();
  const lightnessMatch = bgVar.match(/([0-9.]+)%\s*$/);
  if (lightnessMatch) {
    const lightness = Number(lightnessMatch[1]);
    if (Number.isFinite(lightness)) return lightness < 50;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? true;
}

function applyEdgeLabelTheme(svgMarkup: string, isDarkTheme: boolean): string {
  if (!svgMarkup.trim() || typeof document === "undefined") return svgMarkup;
  try {
    const styles = getComputedStyle(document.documentElement);
    const hslVar = (name: string, fallback: string) => {
      const v = styles.getPropertyValue(name).trim();
      return v ? `hsl(${v})` : fallback;
    };
    const labelText = hslVar("--foreground", isDarkTheme ? "#e6eeff" : "#1f2937");
    const labelBg = hslVar("--card", isDarkTheme ? "#1a2132" : "#ffffff");
    const labelBorder = hslVar("--border", isDarkTheme ? "#445" : "#cbd5e1");
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
    const svg = doc.querySelector("svg");
    if (!svg) return svgMarkup;
    const style = doc.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `
      .edgeLabel, .edgeLabel span, .edgeLabel p { color: ${labelText} !important; fill: ${labelText} !important; }
      .edgeLabel rect { fill: ${labelBg} !important; stroke: ${labelBorder} !important; opacity: 0.95; rx: 6px; ry: 6px; }
      .flowchart-link, .edgePath path { stroke-linecap: round; stroke-linejoin: round; }
    `;
    svg.prepend(style);
    return new XMLSerializer().serializeToString(svg);
  } catch {
    return svgMarkup;
  }
}

const SERVICE_PATTERNS: Array<{ pattern: RegExp; service: string }> = [
  { pattern: /cloudfront\.net$/i, service: "AWS CloudFront" },
  { pattern: /elb\.amazonaws\.com$/i, service: "AWS ELB" },
  { pattern: /azureedge\.net$/i, service: "Azure Edge/CDN" },
  { pattern: /trafficmanager\.net$/i, service: "Azure Traffic Manager" },
  { pattern: /fastly\.net$/i, service: "Fastly" },
  { pattern: /akamai(net|hd)\.net$/i, service: "Akamai" },
  { pattern: /herokudns\.com$/i, service: "Heroku DNS" },
  { pattern: /vercel-dns\.com$/i, service: "Vercel" },
  { pattern: /github\.io$/i, service: "GitHub Pages" },
  { pattern: /netlify\.(app|global)$/i, service: "Netlify" },
  { pattern: /cloudflare\.com$/i, service: "Cloudflare" },
];
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

function esc(value: string): string {
  return String(value ?? "").replace(/"/g, '\\"');
}

function normalizeDomain(value: string): string {
  return String(value ?? "").trim().replace(/\.$/, "").toLowerCase();
}

function isIpAddress(value: string): boolean {
  const v = String(value ?? "").trim();
  if (!v) return false;
  // Simple IPv4/IPv6 checks for candidate filtering.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return true;
  if (v.includes(":") && /^[0-9a-f:.]+$/i.test(v)) return true;
  return false;
}

function buildBrowserUrl(address?: string): string | null {
  const raw = String(address ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (isIpAddress(raw)) {
    return raw.includes(":") ? `http://[${raw}]` : `http://${raw}`;
  }
  if (/^[a-z0-9.-]+$/i.test(raw)) {
    return `https://${raw}`;
  }
  return null;
}

function extractTarget(record: DNSRecord): string | null {
  if (record.type === "CNAME" || record.type === "NS") {
    const target = normalizeDomain(record.content);
    return target || null;
  }
  if (record.type === "MX") {
    const parts = String(record.content ?? "").trim().split(/\s+/);
    const target = normalizeDomain(parts.slice(1).join(" "));
    return target || null;
  }
  if (record.type === "SRV") {
    const parts = String(record.content ?? "").trim().split(/\s+/);
    const target = normalizeDomain(parts.slice(3).join(" "));
    return target || null;
  }
  if (record.type === "A" || record.type === "AAAA") {
    const ip = String(record.content ?? "").trim();
    return ip || null;
  }
  return null;
}

function computeCnameChains(records: DNSRecord[], maxHops: number): Array<{ start: string; chain: string[] }> {
  const map = new Map<string, string>();
  for (const record of records) {
    if (record.type !== "CNAME") continue;
    const from = normalizeDomain(record.name);
    const to = normalizeDomain(record.content);
    if (from && to) map.set(from, to);
  }

  const chains: Array<{ start: string; chain: string[] }> = [];
  for (const [start] of map) {
    const seen = new Set<string>([start]);
    const chain = [start];
    let cur = start;
    let hops = 0;
    while (hops < maxHops) {
      const next = map.get(cur);
      if (!next) break;
      chain.push(next);
      hops += 1;
      if (seen.has(next)) break;
      seen.add(next);
      cur = next;
    }
    if (chain.length > 2) chains.push({ start, chain });
  }
  return chains;
}

function buildCnameMap(records: DNSRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of records) {
    if (record.type !== "CNAME") continue;
    const from = normalizeDomain(record.name);
    const to = normalizeDomain(record.content);
    if (!from || !to) continue;
    map.set(from, to);
  }
  return map;
}

function resolveCnameTerminal(name: string, cnameMap: Map<string, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = normalizeDomain(name);
  let hops = 0;
  while (cur && hops < 12) {
    const next = cnameMap.get(cur);
    if (!next || seen.has(next)) break;
    out.push(next);
    seen.add(next);
    cur = next;
    hops += 1;
  }
  return out;
}

function buildAddressMaps(records: DNSRecord[]): {
  ipv4ByName: Map<string, string[]>;
  ipv6ByName: Map<string, string[]>;
} {
  const ipv4Temp = new Map<string, Set<string>>();
  const ipv6Temp = new Map<string, Set<string>>();
  for (const r of records) {
    const name = normalizeDomain(r.name);
    if (!name) continue;
    if (r.type === "A") {
      const ip = String(r.content ?? "").trim();
      if (!ip) continue;
      if (!ipv4Temp.has(name)) ipv4Temp.set(name, new Set());
      ipv4Temp.get(name)!.add(ip);
    }
    if (r.type === "AAAA") {
      const ip = String(r.content ?? "").trim();
      if (!ip) continue;
      if (!ipv6Temp.has(name)) ipv6Temp.set(name, new Set());
      ipv6Temp.get(name)!.add(ip);
    }
  }
  return {
    ipv4ByName: new Map(Array.from(ipv4Temp.entries()).map(([k, v]) => [k, Array.from(v)])),
    ipv6ByName: new Map(Array.from(ipv6Temp.entries()).map(([k, v]) => [k, Array.from(v)])),
  };
}

function resolveNameToTerminal(
  startName: string,
  cnameMap: Map<string, string>,
  ipv4ByName: Map<string, string[]>,
  ipv6ByName: Map<string, string[]>,
  maxHops: number,
): { chain: string[]; terminal: string; ipv4: string[]; ipv6: string[] } {
  const start = normalizeDomain(startName);
  if (!start) return { chain: [], terminal: "", ipv4: [], ipv6: [] };
  const chain: string[] = [start];
  const seen = new Set<string>([start]);
  let cur = start;
  let hops = 0;
  while (hops < maxHops) {
    const next = cnameMap.get(cur);
    if (!next || seen.has(next)) break;
    chain.push(next);
    seen.add(next);
    cur = next;
    hops += 1;
  }
  return {
    chain,
    terminal: cur,
    ipv4: ipv4ByName.get(cur) ?? [],
    ipv6: ipv6ByName.get(cur) ?? [],
  };
}

function pickBestResolution(
  requestedName: string,
  local: { chain: string[]; terminal: string; ipv4: string[]; ipv6: string[] },
  externalByName: Record<string, ExternalDnsResolution>,
): ExternalDnsResolution {
  const requested = normalizeDomain(requestedName);
  const localTerminal = normalizeDomain(local.terminal || requested);
  const external =
    externalByName[requested] ||
    externalByName[localTerminal];
  const localFallback: ExternalDnsResolution = {
    chain: local.chain,
    terminal: local.terminal,
    ipv4: local.ipv4,
    ipv6: local.ipv6,
    source: "external",
  };
  if (!external) return localFallback;

  const localHasEndpoints = local.ipv4.length > 0 || local.ipv6.length > 0;
  const externalHasEndpoints = external.ipv4.length > 0 || external.ipv6.length > 0;
  const externalHasDeeperChain = external.chain.length > local.chain.length;

  // Prefer backend resolution whenever local chain does not end in IPs
  // and backend provides either deeper hop trail or terminal endpoints.
  if (!localHasEndpoints && (externalHasEndpoints || externalHasDeeperChain)) {
    return external;
  }
  if (localHasEndpoints && externalHasEndpoints) {
    return {
      ...localFallback,
      reverseHostnamesByIp: external.reverseHostnamesByIp,
    };
  }
  return localFallback;
}

function buildNodeLabel(
  title: string,
  subtitle = "",
): string {
  const cleanTitle = String(title ?? "");
  const cleanSubtitle = String(subtitle ?? "");
  const subtitleHtml = cleanSubtitle
    ? `<div style='font-size:11px;opacity:0.82;margin-top:2px'>${esc(cleanSubtitle)}</div>`
    : "";
  return `<div><div>${esc(cleanTitle)}</div>${subtitleHtml}</div>`;
}

function classifyAreas(
  name: string,
  records: DNSRecord[],
  emailPathNames: Set<string>,
): Array<"email" | "web" | "infra" | "misc"> {
  const areas = new Set<"email" | "web" | "infra" | "misc">();
  const lower = normalizeDomain(name);
  const hasEmailNameHints =
    lower.includes("_dmarc") || lower.includes("._domainkey") || lower.includes("_bimi");
  const hasEmailTypes = records.some((r) => r.type === "MX" || r.type === "SPF");
  const hasEmailTxt = records.some((r) => {
    if (r.type !== "TXT") return false;
    const txt = String(r.content ?? "").toLowerCase();
    return (
      txt.includes("v=spf1") ||
      txt.includes("v=dmarc1") ||
      txt.includes("v=dkim1") ||
      txt.includes("v=bimi1")
    );
  });
  if (hasEmailNameHints || hasEmailTypes || hasEmailTxt || emailPathNames.has(lower)) {
    areas.add("email");
  }

  const hasInfraTypes = records.some((r) =>
    ["NS", "SOA", "CAA", "DNSKEY", "DS", "RRSIG", "NSEC", "NSEC3"].includes(r.type),
  );
  if (hasInfraTypes) areas.add("infra");

  const hasWebTypes = records.some((r) =>
    ["A", "AAAA", "CNAME", "SVCB", "HTTPS", "SRV"].includes(r.type),
  );
  if (hasWebTypes) areas.add("web");

  if (areas.size === 0) areas.add("misc");
  return Array.from(areas);
}

function buildTopology(
  records: DNSRecord[],
  zoneName: string,
  maxResolutionHops: number,
  isDarkTheme: boolean,
  externalResolutionByName: Record<string, ExternalDnsResolution>,
): {
  code: string;
  summary: TopologySummary;
  nodeMetaById: Record<string, { text: string; recordId?: string; address?: string }>;
} {
  const lines: string[] = [];
  const nodeMetaById: Record<string, { text: string; recordId?: string; address?: string }> = {};
  const nodeIds = new Map<string, string>();
  let nextId = 0;
  const zoneNode = "zone_root";
  const zone = normalizeDomain(zoneName);

  const sharedIpMap = new Map<string, Set<string>>();
  const detectedServices = new Map<string, string>();
  const cnameChains = computeCnameChains(records, maxResolutionHops);
  const cnameMap = buildCnameMap(records);
  const { ipv4ByName, ipv6ByName } = buildAddressMaps(records);
  const ipGeoByIp = new Map<string, { country: string; countryCode?: string }>();
  for (const resolution of Object.values(externalResolutionByName)) {
    for (const [ip, geo] of Object.entries(resolution.geoByIp ?? {})) {
      if (!geo?.country) continue;
      if (!ipGeoByIp.has(ip)) {
        ipGeoByIp.set(ip, geo);
      }
    }
  }
  const ipSubtitle = (ip: string) => {
    const geo = ipGeoByIp.get(ip);
    if (!geo?.country) return "IP";
    const code = geo.countryCode ? `${geo.countryCode.toUpperCase()} - ` : "";
    return `IP | GEO: ${code}${geo.country}`;
  };
  const nodeRecords = new Map<string, DNSRecord[]>();
  const edgeSet = new Set<string>();
  for (const record of records) {
    const nameRaw = normalizeDomain(record.name) || "@";
    const labelName = nameRaw === "@" ? zone : nameRaw;
    if (!nodeRecords.has(labelName)) nodeRecords.set(labelName, []);
    nodeRecords.get(labelName)!.push(record);
  }

  const emailPathNames = new Set<string>();
  const mxTrails: TopologySummary["mxTrails"] = [];
  for (const r of records) {
    if (r.type !== "MX") continue;
    const fromName = normalizeDomain(r.name) || zone;
    const rawParts = String(r.content ?? "").trim().split(/\s+/);
    const maybePriority = Number(rawParts[0]);
    const priority = Number.isFinite(maybePriority) ? maybePriority : null;
    const mxTarget = extractTarget(r);
    if (!mxTarget) continue;
    const localResolved = resolveNameToTerminal(mxTarget, cnameMap, ipv4ByName, ipv6ByName, maxResolutionHops);
    const resolved = pickBestResolution(mxTarget, localResolved, externalResolutionByName);
    mxTrails.push({
      from: fromName,
      priority,
      target: mxTarget,
      chain: resolved.chain,
      terminal: resolved.terminal,
      ipv4: resolved.ipv4,
      ipv6: resolved.ipv6,
    });
    for (const n of resolved.chain) emailPathNames.add(n);
    if (resolved.terminal) emailPathNames.add(resolved.terminal);
  }

  const idFor = (key: string) => {
    if (nodeIds.has(key)) return nodeIds.get(key)!;
    const id = `n_${nextId++}`;
    nodeIds.set(key, id);
    return id;
  };
  const setNodeMeta = (nodeId: string, text: string, recordId?: string, address?: string) => {
    nodeMetaById[nodeId] = { text, ...(recordId ? { recordId } : {}), ...(address ? { address } : {}) };
  };
  lines.push("flowchart LR");
  const zoneTitle = `Zone: ${zone || zoneName}`;
  lines.push(`  ${zoneNode}["${esc(buildNodeLabel(zoneTitle))}"]:::zone`);
  setNodeMeta(zoneNode, zoneTitle);

  const usedNames = new Set<string>();
  const areaCounts = { email: 0, web: 0, infra: 0, misc: 0 };
  type GraphUnit = {
    key: string;
    type: DNSRecord["type"];
    name: string;
    records: DNSRecord[];
    aggregate: boolean;
  };
  const units: GraphUnit[] = [];
  const aggAaaaMap = new Map<string, DNSRecord[]>();
  for (const record of records) {
    const nameRaw = normalizeDomain(record.name) || "@";
    const labelName = nameRaw === "@" ? zone : nameRaw;
    if (record.type === "A" || record.type === "AAAA") {
      const k = `${record.type}:${labelName}`;
      if (!aggAaaaMap.has(k)) aggAaaaMap.set(k, []);
      aggAaaaMap.get(k)!.push(record);
    } else {
      units.push({
        key: `record:${record.id}`,
        type: record.type,
        name: labelName,
        records: [record],
        aggregate: false,
      });
    }
  }
  for (const [k, recs] of aggAaaaMap.entries()) {
    units.push({
      key: `agg:${k}`,
      type: recs[0].type,
      name: normalizeDomain(recs[0].name) || zone,
      records: recs,
      aggregate: true,
    });
  }

  for (const unit of units) {
    const nodeRecs = nodeRecords.get(unit.name) ?? unit.records;
    const areas = classifyAreas(unit.name, nodeRecs, emailPathNames);
    for (const area of areas) areaCounts[area] += 1;

    const recordId = idFor(unit.key);
    const localResolved = resolveNameToTerminal(unit.name, cnameMap, ipv4ByName, ipv6ByName, maxResolutionHops);
    const resolved = pickBestResolution(unit.name, localResolved, externalResolutionByName);
    const endpointInfo =
      resolved.ipv4.length || resolved.ipv6.length
        ? `A:${resolved.ipv4.length || 0} AAAA:${resolved.ipv6.length || 0}`
        : "";
    const ttlValues = Array.from(new Set(unit.records.map((r) => String(r.ttl ?? "auto"))));
    const proxyValues = Array.from(new Set(unit.records.map((r) => (r.proxied ? "proxied" : "dns-only"))));
    const info = [
      `type:${unit.type}${unit.aggregate ? ` x${unit.records.length}` : ""}`,
      unit.type === "MX"
        ? (() => {
            const parts = String(unit.records[0]?.content ?? "").trim().split(/\s+/);
            const parsedPriority = Number(parts[0]);
            return Number.isFinite(parsedPriority) ? `prio:${parsedPriority}` : "";
          })()
        : "",
      `ttl:${ttlValues.length === 1 ? ttlValues[0] : "mixed"}`,
      proxyValues.length === 1 ? proxyValues[0] : "proxy:mixed",
      resolved.chain.length > 1 ? `resolves:${resolved.terminal}` : "",
      endpointInfo,
    ]
      .filter(Boolean)
      .join(" | ");
    const editableRecordId =
      unit.records.length === 1 && unit.records[0]?.id ? String(unit.records[0].id) : undefined;
    lines.push(
      `  ${recordId}["${esc(buildNodeLabel(unit.name, info || "record"))}"]:::record`,
    );
    setNodeMeta(
      recordId,
      info ? `${unit.name} | ${info.replace(/<br\s*\/?>/gi, " ")}` : unit.name,
      editableRecordId,
      unit.name,
    );
    lines.push(`  ${zoneNode} --> ${recordId}`);

    const targetEntries =
      unit.type === "MX"
        ? unit.records
            .map((record) => {
              const target = extractTarget(record);
              if (!target) return null;
              const parts = String(record.content ?? "").trim().split(/\s+/);
              const parsedPriority = Number(parts[0]);
              return {
                recordId: record.id,
                target,
                priority: Number.isFinite(parsedPriority) ? parsedPriority : null,
              };
            })
            .filter((entry): entry is { recordId: string; target: string; priority: number | null } => Boolean(entry))
        : Array.from(
            new Set(unit.records.map((r) => extractTarget(r)).filter((v): v is string => Boolean(v))),
          ).map((target) => ({ recordId: "", target, priority: null as number | null }));

    for (const entry of targetEntries) {
      const target = entry.target;
      const isIp = unit.type === "A" || unit.type === "AAAA";
      const targetKey = `${isIp ? "ip" : "target"}:${target}`;
      const targetId = idFor(targetKey);
      const targetClass = isIp ? "ip" : "target";
      const mxPriorityNodeId =
        unit.type === "MX"
          ? idFor(`mxprio:${entry.recordId || unit.key}:${entry.priority ?? "na"}:${target}`)
          : null;
      const edgeFromNodeId = mxPriorityNodeId ?? recordId;

      if (!usedNames.has(targetKey)) {
        lines.push(
          `  ${targetId}["${esc(buildNodeLabel(target, targetClass === "ip" ? ipSubtitle(target) : ""))}"]:::${targetClass}`,
        );
        setNodeMeta(targetId, targetClass === "ip" ? `${target} | ${ipSubtitle(target)}` : target, undefined, target);
        usedNames.add(targetKey);
      }

      if (mxPriorityNodeId) {
        const mxPriorityLabel = `MX Priority ${entry.priority ?? "?"}`;
        lines.push(`  ${mxPriorityNodeId}["${esc(buildNodeLabel(mxPriorityLabel))}"]:::target`);
        setNodeMeta(mxPriorityNodeId, mxPriorityLabel, undefined);
        const mxEdge = `${recordId}|MX|${mxPriorityNodeId}`;
        if (!edgeSet.has(mxEdge)) {
          lines.push(`  ${recordId} -- "MX" --> ${mxPriorityNodeId}`);
          edgeSet.add(mxEdge);
        }
        const targetEdge = `${mxPriorityNodeId}|P${entry.priority ?? "?"}|${targetId}`;
        if (!edgeSet.has(targetEdge)) {
          lines.push(`  ${mxPriorityNodeId} -- "prio ${entry.priority ?? "?"}" --> ${targetId}`);
          edgeSet.add(targetEdge);
        }
      } else {
        lines.push(`  ${recordId} -- "${esc(unit.type)}" --> ${targetId}`);
        edgeSet.add(`${recordId}|${unit.type}|${targetId}`);
      }

      // Trace hostname -> CNAME chain -> terminal A/AAAA path for non-IP targets.
      if (!isIp) {
        const localResolvedTarget = resolveNameToTerminal(
          target,
          cnameMap,
          ipv4ByName,
          ipv6ByName,
          maxResolutionHops,
        );
        const resolvedTarget = pickBestResolution(target, localResolvedTarget, externalResolutionByName);
        for (let i = 0; i < resolvedTarget.chain.length - 1; i += 1) {
          const from = resolvedTarget.chain[i];
          const to = resolvedTarget.chain[i + 1];
          const fromId = idFor(`target:${from}`);
          const toId = idFor(`target:${to}`);
          if (!usedNames.has(`target:${from}`)) {
            lines.push(`  ${fromId}["${esc(buildNodeLabel(from))}"]:::target`);
            setNodeMeta(fromId, from, undefined, from);
            usedNames.add(`target:${from}`);
          }
          if (!usedNames.has(`target:${to}`)) {
            lines.push(`  ${toId}["${esc(buildNodeLabel(to))}"]:::target`);
            setNodeMeta(toId, to, undefined, to);
            usedNames.add(`target:${to}`);
          }
          const k = `${fromId}|CNAME|${toId}`;
          if (!edgeSet.has(k)) {
            lines.push(`  ${fromId} -. "CNAME" .-> ${toId}`);
            edgeSet.add(k);
          }
        }
        for (const ip of resolvedTarget.ipv4) {
          const ipId = idFor(`ip:${ip}`);
          if (!usedNames.has(`ip:${ip}`)) {
            lines.push(`  ${ipId}["${esc(buildNodeLabel(ip, ipSubtitle(ip)))}"]:::ip`);
            setNodeMeta(ipId, `${ip} | ${ipSubtitle(ip)}`, undefined, ip);
            usedNames.add(`ip:${ip}`);
          }
          const termId = idFor(`target:${resolvedTarget.terminal || target}`);
          const k = `${edgeFromNodeId}|A|${termId}|${ipId}`;
          if (!edgeSet.has(k)) {
            lines.push(`  ${termId} -. "A" .-> ${ipId}`);
            edgeSet.add(k);
          }
        }
        for (const ip of resolvedTarget.ipv6) {
          const ipId = idFor(`ip:${ip}`);
          if (!usedNames.has(`ip:${ip}`)) {
            lines.push(`  ${ipId}["${esc(buildNodeLabel(ip, ipSubtitle(ip)))}"]:::ip`);
            setNodeMeta(ipId, `${ip} | ${ipSubtitle(ip)}`, undefined, ip);
            usedNames.add(`ip:${ip}`);
          }
          const termId = idFor(`target:${resolvedTarget.terminal || target}`);
          const k = `${edgeFromNodeId}|AAAA|${termId}|${ipId}`;
          if (!edgeSet.has(k)) {
            lines.push(`  ${termId} -. "AAAA" .-> ${ipId}`);
            edgeSet.add(k);
          }
        }
        if (resolvedTarget.reverseHostnamesByIp) {
          for (const [ip, ptrNames] of Object.entries(resolvedTarget.reverseHostnamesByIp)) {
            if (!ptrNames?.length) continue;
            const ipId = idFor(`ip:${ip}`);
            if (!usedNames.has(`ip:${ip}`)) {
              lines.push(`  ${ipId}["${esc(buildNodeLabel(ip, ipSubtitle(ip)))}"]:::ip`);
              setNodeMeta(ipId, `${ip} | ${ipSubtitle(ip)}`, undefined, ip);
              usedNames.add(`ip:${ip}`);
            }
            for (const ptrName of ptrNames) {
              const ptrKey = `target:${normalizeDomain(ptrName)}`;
              const ptrId = idFor(ptrKey);
              if (!usedNames.has(ptrKey)) {
                lines.push(`  ${ptrId}["${esc(buildNodeLabel(normalizeDomain(ptrName)))}"]:::target`);
                setNodeMeta(ptrId, normalizeDomain(ptrName), undefined, normalizeDomain(ptrName));
                usedNames.add(ptrKey);
              }
              const ptrEdge = `${ipId}|PTR|${ptrId}`;
              if (!edgeSet.has(ptrEdge)) {
                lines.push(`  ${ipId} -. "PTR" .-> ${ptrId}`);
                edgeSet.add(ptrEdge);
              }
            }
          }
        }
      }

      if (isIp) {
        if (!sharedIpMap.has(target)) sharedIpMap.set(target, new Set());
        sharedIpMap.get(target)!.add(unit.name);
      } else {
        for (const fp of SERVICE_PATTERNS) {
          if (fp.pattern.test(target)) {
            detectedServices.set(`${fp.service}:${target}`, fp.service);
          }
        }
      }
    }
  }

  const sharedIps = Array.from(sharedIpMap.entries())
    .filter(([, names]) => names.size > 1)
    .map(([ip, names]) => ({ ip, names: Array.from(names).sort() }));

  let svcIdx = 0;
  for (const [serviceTarget, serviceName] of detectedServices.entries()) {
    const [, target] = serviceTarget.split(":", 2);
    const targetKey = `target:${target}`;
    const targetId = nodeIds.get(targetKey);
    if (!targetId) continue;
    const serviceId = `svc_${svcIdx++}`;
    lines.push(`  ${serviceId}["${esc(buildNodeLabel(serviceName))}"]:::service`);
    setNodeMeta(serviceId, serviceName, undefined);
    lines.push(`  ${targetId} -.-> ${serviceId}`);
  }

  const zoneText = isDarkTheme ? "#dce6ff" : "#1f2a44";
  const recordText = isDarkTheme ? "#ddfff2" : "#143727";
  const targetText = isDarkTheme ? "#fff5db" : "#4a3600";
  const ipText = isDarkTheme ? "#ffe3e3" : "#5d1b1b";
  const serviceText = isDarkTheme ? "#efe8ff" : "#2f1f5d";
  lines.push(`  classDef zone fill:#5b8cff22,stroke:#5b8cff,stroke-width:1.5px,color:${zoneText};`);
  lines.push(`  classDef record fill:#20c99722,stroke:#20c997,stroke-width:1.2px,color:${recordText};`);
  lines.push(`  classDef target fill:#f59f0022,stroke:#f59f00,stroke-width:1.2px,color:${targetText};`);
  lines.push(`  classDef ip fill:#fa525222,stroke:#fa5252,stroke-width:1.2px,color:${ipText};`);
  lines.push(`  classDef service fill:#845ef722,stroke:#845ef7,stroke-width:1.2px,color:${serviceText};`);

  return {
    code: lines.join("\n"),
    nodeMetaById,
    summary: {
      cnameChains,
      sharedIps,
      detectedServices: Array.from(detectedServices.keys()).map((key) => {
        const [name, via] = key.split(":", 2);
        return { name, via };
      }),
      mxTrails,
      areas: areaCounts,
      nodeSummaries: Array.from(nodeRecords.entries())
        .map(([name, nodeRecs]) => ({
          ...(() => {
            const resolved = resolveNameToTerminal(
              name,
              cnameMap,
              ipv4ByName,
              ipv6ByName,
              maxResolutionHops,
            );
            const bestResolved = pickBestResolution(name, resolved, externalResolutionByName);
            return {
              name,
              records: nodeRecs,
              resolvedTo: bestResolved.chain.slice(1),
              areas: classifyAreas(name, nodeRecs, emailPathNames),
              terminal: bestResolved.terminal,
              ipv4: bestResolved.ipv4,
              ipv6: bestResolved.ipv6,
            };
          })(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}

async function probeHttp(url: string, timeoutMs = 5000): Promise<"up" | "down"> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { method: "GET", mode: "no-cors", cache: "no-store", signal: controller.signal });
    return "up";
  } catch {
    return "down";
  } finally {
    window.clearTimeout(timer);
  }
}

function resolveDohEndpoints(
  resolverMode: "dns" | "doh",
  dnsServer: string,
  customDnsServer: string,
  customUrl: string,
): string[] {
  if (resolverMode !== "doh") return [];
  const selectedDns =
    dnsServer === "custom" ? customDnsServer.trim() || "1.1.1.1" : (dnsServer.trim() || "1.1.1.1");
  const preferred =
    customUrl.trim() ||
    (selectedDns === "1.1.1.1" || selectedDns === "1.0.0.1"
      ? "https://cloudflare-dns.com/dns-query"
      : selectedDns === "8.8.8.8" || selectedDns === "8.8.4.4"
        ? "https://dns.google/resolve"
        : selectedDns === "9.9.9.9" || selectedDns === "149.112.112.112"
          ? "https://dns.quad9.net:5053/dns-query"
          : "https://cloudflare-dns.com/dns-query");
  return Array.from(
    new Set([
      preferred,
      "https://cloudflare-dns.com/dns-query",
      "https://dns.google/resolve",
      "https://dns.quad9.net:5053/dns-query",
    ]),
  );
}

async function queryDoh(
  endpoints: string[],
  name: string,
  type: "CNAME" | "A" | "AAAA",
  timeoutMs: number,
): Promise<string[]> {
  for (const endpoint of endpoints) {
    try {
      const url = `${endpoint}${endpoint.includes("?") ? "&" : "?"}name=${encodeURIComponent(name)}&type=${type}`;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
      const res = await fetch(url, {
        cache: "no-store",
        headers: { accept: "application/dns-json" },
        signal: controller.signal,
      }).finally(() => window.clearTimeout(timer));
      if (!res.ok) continue;
      const data = (await res.json()) as {
        Answer?: Array<{ data?: string; type?: number }>;
      };
      const out = (data.Answer ?? [])
        .map((x) => String(x.data ?? "").trim())
        .filter(Boolean);
      const normalized = Array.from(new Set(out.map((x) => normalizeDomain(x))));
      if (normalized.length > 0) return normalized;
    } catch {
      continue;
    }
  }
  return [];
}

async function resolveExternalCnameToAddress(
  startName: string,
  maxHops: number,
  dohEndpoints: string[],
  timeoutMs: number,
  scanResolutionChain: boolean,
): Promise<ExternalDnsResolution> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = normalizeDomain(startName);
  if (!cur) {
    return { chain, terminal: "", ipv4: [], ipv6: [], source: "external", error: "empty name" };
  }
  chain.push(cur);
  seen.add(cur);
  let hops = 0;
  try {
    if (scanResolutionChain) {
      while (hops < maxHops) {
        const cnames = await queryDoh(dohEndpoints, cur, "CNAME", timeoutMs);
        const next = cnames.find(Boolean);
        if (!next || seen.has(next)) break;
        chain.push(next);
        seen.add(next);
        cur = next;
        hops += 1;
      }
    }
    const [a, aaaa] = await Promise.all([
      queryDoh(dohEndpoints, cur, "A", timeoutMs),
      queryDoh(dohEndpoints, cur, "AAAA", timeoutMs),
    ]);
    return {
      chain,
      terminal: cur,
      ipv4: a,
      ipv6: aaaa,
      source: "external",
    };
  } catch (error) {
    return {
      chain,
      terminal: cur,
      ipv4: [],
      ipv6: [],
      source: "external",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveTopologyBatchInBackend(
  hostnames: string[],
  maxHops: number,
  resolverMode: "dns" | "doh",
  dnsServer: string,
  customDnsServer: string,
  dohProvider: "google" | "cloudflare" | "quad9" | "custom",
  dohCustomUrl: string,
  lookupTimeoutMs: number,
  disablePtrLookups: boolean,
  tcpServicePorts: number[],
  disableGeoLookups: boolean,
  geoProvider: "auto" | "ipwhois" | "ipapi_co" | "ip_api" | "internal",
  scanResolutionChain: boolean,
  serviceHosts: string[] = [],
): Promise<{
  resolutions: ExternalDnsResolution[];
  probes: Array<{ host: string; httpsUp: boolean; httpUp: boolean }>;
  tcpProbes: Array<{ host: string; port: number; up: boolean }>;
} | null> {
  if (!TauriClient.isTauri()) return null;
  try {
    const result = await TauriClient.resolveTopologyBatch(
      hostnames,
      maxHops,
      serviceHosts,
      dohProvider,
      dohCustomUrl,
      resolverMode,
      dnsServer,
      customDnsServer,
      lookupTimeoutMs,
      disablePtrLookups,
      tcpServicePorts,
      disableGeoLookups,
      geoProvider,
      scanResolutionChain,
    );
    return {
      resolutions: (result.resolutions ?? []).map((item) => ({
        requestedName: normalizeDomain(item.name ?? ""),
        chain: item.chain ?? [],
        terminal: item.terminal ?? "",
        ipv4: item.ipv4 ?? [],
        ipv6: item.ipv6 ?? [],
        reverseHostnamesByIp: Object.fromEntries(
          (item.reverse_hostnames ?? []).map((entry) => [
            String(entry.ip ?? ""),
            Array.from(new Set((entry.hostnames ?? []).map((value) => normalizeDomain(value)).filter(Boolean))),
          ]),
        ),
        geoByIp: Object.fromEntries(
          (item.geo_by_ip ?? [])
            .map((entry) => {
              const ip = String(entry.ip ?? "").trim();
              const country = String(entry.country ?? "").trim();
              const countryCode = String(entry.country_code ?? "").trim();
              if (!ip || !country) return null;
              return [ip, { country, ...(countryCode ? { countryCode } : {}) }] as const;
            })
            .filter((entry): entry is readonly [string, { country: string; countryCode?: string }] => Boolean(entry)),
        ),
        source: "external" as const,
        error: item.error ?? undefined,
      })),
      probes: (result.probes ?? []).map((item) => ({
        host: item.host,
        httpsUp: Boolean(item.https_up),
        httpUp: Boolean(item.http_up),
      })),
      tcpProbes: (result.tcp_probes ?? []).map((item) => ({
        host: item.host,
        port: Number(item.port),
        up: Boolean(item.up),
      })),
    };
  } catch {
    return null;
  }
}

export function ZoneTopologyTab({
  zoneName,
  records,
  isLoading = false,
  maxResolutionHops = 15,
  resolverMode = "dns",
  dnsServer = "1.1.1.1",
  customDnsServer = "",
  dohProvider = "cloudflare",
  dohCustomUrl = "",
  exportConfirmPath = true,
  exportFolderPreset = "documents",
  exportCustomPath = "",
  disableAnnotations = false,
  disableFullWindow = false,
  lookupTimeoutMs = 1200,
  disablePtrLookups = false,
  disableGeoLookups = false,
  geoProvider = "auto",
  scanResolutionChain = true,
  disableServiceDiscovery = false,
  tcpServicePorts = [80, 443, 22],
  onRefresh,
  onEditRecord,
}: ZoneTopologyTabProps) {
  const { toast } = useToast();
  const desktop = isDesktop();
  const [svgMarkup, setSvgMarkup] = useState("");
  const [mermaidCode, setMermaidCode] = useState("");
  const [isRendering, setIsRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [handTool, setHandTool] = useState(true);
  const [annotationTool, setAnnotationTool] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState("Note");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [themeVersion, setThemeVersion] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const middleDragRestoreHandRef = useRef<boolean | null>(null);
  const userAdjustedViewRef = useRef(false);
  const autoFitDoneRef = useRef<string>("");
  const [graphSize, setGraphSize] = useState({ w: 1000, h: 600 });
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<ServiceDiscoveryItem[]>([]);
  const [nodeContextMenu, setNodeContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    text: string;
    recordId?: string;
    address?: string;
  }>({ open: false, x: 0, y: 0, text: "" });
  const [nodeMetaById, setNodeMetaById] = useState<Record<string, { text: string; recordId?: string; address?: string }>>({});
  const nodeContextMenuRef = useRef<HTMLDivElement | null>(null);
  const [expandGraph, setExpandGraph] = useState(false);
  const [externalResolutionByName, setExternalResolutionByName] = useState<
    Record<string, ExternalDnsResolution>
  >({});
  const [topologyResolutionReady, setTopologyResolutionReady] = useState(false);
  const [topologyResolutionProgress, setTopologyResolutionProgress] = useState<TopologyResolutionProgress>({
    running: false,
    total: 0,
    done: 0,
  });
  const [manualRefreshTick, setManualRefreshTick] = useState(0);
  const [activeResolutionRequests, setActiveResolutionRequests] = useState<string[]>([]);
  const resolutionCacheRef = useRef<Map<string, TopologyResolutionCacheEntry>>(new Map());
  const probeCacheRef = useRef<Map<string, TopologyProbeCacheEntry>>(new Map());
  const lastResolutionRunKeyRef = useRef<string>("");
  const [isDarkThemeMode, setIsDarkThemeMode] = useState(() => detectDarkThemeMode());
  const [summary, setSummary] = useState<TopologySummary>({
    cnameChains: [],
    sharedIps: [],
    detectedServices: [],
    mxTrails: [],
    areas: { email: 0, web: 0, infra: 0, misc: 0 },
    nodeSummaries: [],
  });
  const dohEndpoints = useMemo(
    () => resolveDohEndpoints(resolverMode, dnsServer, customDnsServer, dohCustomUrl),
    [customDnsServer, dnsServer, dohCustomUrl, resolverMode],
  );
  const recordsFingerprint = useMemo(
    () =>
      records
        .map((record) =>
          `${record.id ?? ""}|${record.type}|${normalizeDomain(record.name)}|${normalizeDomain(String(record.content ?? ""))}|${record.modified_on ?? ""}`,
        )
        .sort()
        .join("||"),
    [records],
  );
  const closeExpandGraph = useCallback(() => {
    setExpandGraph(false);
    autoFitDoneRef.current = "";
    userAdjustedViewRef.current = false;
  }, []);

  const closeNodeContextMenu = useCallback(() => {
    setNodeContextMenu((prev) => ({ ...prev, open: false }));
  }, []);
  const toggleExpandGraph = useCallback(() => {
    if (disableFullWindow) return;
    setExpandGraph((prev) => !prev);
    autoFitDoneRef.current = "";
    userAdjustedViewRef.current = false;
  }, [disableFullWindow]);

  useEffect(() => {
    if (disableFullWindow && expandGraph) {
      closeExpandGraph();
    }
  }, [closeExpandGraph, disableFullWindow, expandGraph]);

  useEffect(() => {
    if (disableAnnotations && annotationTool) {
      setAnnotationTool(false);
    }
  }, [annotationTool, disableAnnotations]);

  useEffect(() => {
    if (!nodeContextMenu.open) return;
    const close = () => closeNodeContextMenu();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && nodeContextMenuRef.current?.contains(target)) return;
      closeNodeContextMenu();
    };
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("scroll", close, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("scroll", close, { capture: true });
    };
  }, [closeNodeContextMenu, nodeContextMenu.open]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setThemeVersion((v) => v + 1);
      setIsDarkThemeMode(detectDarkThemeMode());
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setExternalResolutionByName({});
    setTopologyResolutionReady(false);
    setMermaidCode("");
    setSvgMarkup("");
    setNodeMetaById({});
    setActiveResolutionRequests([]);
  }, [
    resolverMode,
    dnsServer,
    customDnsServer,
    dohCustomUrl,
    dohProvider,
    manualRefreshTick,
    recordsFingerprint,
    zoneName,
    maxResolutionHops,
    lookupTimeoutMs,
    disablePtrLookups,
    disableGeoLookups,
    geoProvider,
    scanResolutionChain,
  ]);

  useEffect(() => {
    if (!topologyResolutionReady) return;
    const clampedMaxHops = Math.max(1, Math.min(15, Math.round(maxResolutionHops)));
    const { code, summary: nextSummary, nodeMetaById: nextNodeMetaById } = buildTopology(
      records,
      zoneName,
      clampedMaxHops,
      isDarkThemeMode,
      externalResolutionByName,
    );
    setMermaidCode(code);
    setSummary(nextSummary);
    setNodeMetaById(nextNodeMetaById);
  }, [externalResolutionByName, isDarkThemeMode, maxResolutionHops, records, topologyResolutionReady, zoneName]);

  useEffect(() => {
    const candidates = new Set<string>();
    for (const record of records) {
      const target = extractTarget(record);
      if (!target || isIpAddress(target)) continue;
      const hostname = normalizeDomain(target);
      if (hostname) candidates.add(hostname);
    }
    let cancelled = false;
    (async () => {
      const runKey = `${recordsFingerprint}|${zoneName}|${resolverMode}|${dnsServer}|${customDnsServer.trim()}|${dohProvider}|${dohCustomUrl.trim()}|${Math.max(1, Math.min(15, Math.round(maxResolutionHops)))}|${disablePtrLookups ? "noptr" : "ptr"}|${disableGeoLookups ? "nogeo" : `geo:${geoProvider}`}|${scanResolutionChain ? "chain" : "nochain"}|${manualRefreshTick}`;
      if (topologyResolutionReady && lastResolutionRunKeyRef.current === runKey) {
        return;
      }
      lastResolutionRunKeyRef.current = runKey;
      const queue = Array.from(candidates);
      const clampedHops = Math.max(1, Math.min(15, Math.round(maxResolutionHops)));
      let total = queue.length;
      let done = 0;
      const seenTopologyNodes = new Set(queue.map((name) => normalizeDomain(name)));
      const updateProgress = () =>
        setTopologyResolutionProgress({ running: true, total: Math.max(0, total), done: Math.max(0, done) });
      setTopologyResolutionProgress({ running: true, total, done });
      const now = Date.now();
      const cachePrefix = `${resolverMode}|${dnsServer}|${customDnsServer.trim()}|${dohProvider}|${dohCustomUrl.trim()}|${clampedHops}|${disablePtrLookups ? "noptr" : "ptr"}|${disableGeoLookups ? "nogeo" : `geo:${geoProvider}`}|${scanResolutionChain ? "chain" : "nochain"}|`;
      if (queue.length === 0) {
        if (!cancelled) {
          setExternalResolutionByName({});
          setTopologyResolutionReady(true);
          setTopologyResolutionProgress({ running: false, total: 0, done: 0 });
          setActiveResolutionRequests([]);
        }
        return;
      }

      const byName = new Map<string, ExternalDnsResolution>();
      const unresolvedQueue: string[] = [];
      const absorbResolved = (resolved: ExternalDnsResolution) => {
        for (const hop of resolved.chain) {
          const hk = normalizeDomain(hop);
          if (!hk) continue;
          if (!seenTopologyNodes.has(hk)) {
            seenTopologyNodes.add(hk);
            total += 1;
            done += 1;
          }
        }
      };
      for (const name of queue) {
        const key = normalizeDomain(name);
        const cacheKey = `${cachePrefix}${key}`;
        const cached = resolutionCacheRef.current.get(cacheKey);
        if (cached && now - cached.ts <= TOPOLOGY_CACHE_TTL_MS) {
          done += 1;
          byName.set(key, cached.value);
          absorbResolved(cached.value);
          const term = normalizeDomain(cached.value.terminal || "");
          if (term && !byName.has(term)) byName.set(term, cached.value);
          for (const hop of cached.value.chain) {
            const hk = normalizeDomain(hop);
            if (hk && !byName.has(hk)) byName.set(hk, cached.value);
          }
        } else {
          unresolvedQueue.push(name);
        }
      }
      updateProgress();
      if (unresolvedQueue.length > 0) {
        setActiveResolutionRequests(unresolvedQueue.slice(0, 12));
        const backendBatch = await resolveTopologyBatchInBackend(
          unresolvedQueue,
          clampedHops,
          resolverMode,
          dnsServer,
          customDnsServer,
          dohProvider,
          dohCustomUrl,
          lookupTimeoutMs,
          disablePtrLookups,
          tcpServicePorts,
          disableGeoLookups,
          geoProvider,
          scanResolutionChain,
        );
        if (backendBatch) {
          for (const resolved of backendBatch.resolutions) {
            done += 1;
            const requested = normalizeDomain(resolved.requestedName || "");
            if (requested) {
              byName.set(requested, resolved);
              resolutionCacheRef.current.set(`${cachePrefix}${requested}`, {
                value: resolved,
                ts: Date.now(),
              });
            }
            absorbResolved(resolved);
            const term = normalizeDomain(resolved.terminal || "");
            if (term && !byName.has(term)) byName.set(term, resolved);
            for (const hop of resolved.chain) {
              const hk = normalizeDomain(hop);
              if (hk && !byName.has(hk)) byName.set(hk, resolved);
            }
          }
        } else {
          const fallback = await Promise.all(
            unresolvedQueue.map(async (name) => {
              const resolved = await resolveExternalCnameToAddress(
                name,
                clampedHops,
                dohEndpoints,
                lookupTimeoutMs,
                scanResolutionChain,
              );
              return [name, resolved] as const;
            }),
          );
          for (const [name, resolved] of fallback) {
            done += 1;
            const requested = normalizeDomain(name);
            if (requested) {
              byName.set(requested, resolved);
              resolutionCacheRef.current.set(`${cachePrefix}${requested}`, {
                value: resolved,
                ts: Date.now(),
              });
            }
            absorbResolved(resolved);
            const term = normalizeDomain(resolved.terminal || "");
            if (term && !byName.has(term)) byName.set(term, resolved);
            for (const hop of resolved.chain) {
              const hk = normalizeDomain(hop);
              if (hk && !byName.has(hk)) byName.set(hk, resolved);
            }
          }
        }
        if (!cancelled) {
          updateProgress();
        }
      }
      if (cancelled) return;
      const next: Record<string, ExternalDnsResolution> = {};
      for (const name of queue) {
        const key = normalizeDomain(name);
        next[key] =
          byName.get(key) ??
          ({
            requestedName: key,
            chain: [key],
            terminal: key,
            ipv4: [],
            ipv6: [],
            source: "external",
            error: "no CNAME/A/AAAA records found",
          } satisfies ExternalDnsResolution);
      }
      setExternalResolutionByName(next);
      setTopologyResolutionReady(true);
      setTopologyResolutionProgress({ running: false, total, done: Math.max(done, total) });
      setActiveResolutionRequests([]);
    })().catch(() => {});
    return () => {
      cancelled = true;
      setTopologyResolutionProgress((prev) => ({ ...prev, running: false }));
      setActiveResolutionRequests([]);
    };
  }, [resolverMode, dnsServer, customDnsServer, dohCustomUrl, dohProvider, maxResolutionHops, records, dohEndpoints, manualRefreshTick, recordsFingerprint, zoneName, topologyResolutionReady, lookupTimeoutMs, disablePtrLookups, disableGeoLookups, geoProvider, scanResolutionChain]);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      setIsRendering(true);
      setRenderError(null);
      try {
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default;
        const styles = getComputedStyle(document.documentElement);
        const hslVar = (name: string, fallback: string) => {
          const v = styles.getPropertyValue(name).trim();
          return v ? `hsl(${v})` : fallback;
        };
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: "base",
          themeVariables: {
            primaryColor: hslVar("--primary", "#5b8cff"),
            primaryTextColor: hslVar("--foreground", isDarkThemeMode ? "#f2f5ff" : "#0f172a"),
            primaryBorderColor: hslVar("--border", "#445"),
            lineColor: hslVar("--foreground", "#d7deff"),
            background: hslVar("--card", isDarkThemeMode ? "#131824" : "#ffffff"),
            tertiaryColor: hslVar("--muted", isDarkThemeMode ? "#20263a" : "#e2e8f0"),
            textColor: hslVar("--foreground", isDarkThemeMode ? "#e6eeff" : "#0f172a"),
            secondaryTextColor: hslVar("--foreground", isDarkThemeMode ? "#d7deff" : "#1f2937"),
            tertiaryTextColor: hslVar("--foreground", isDarkThemeMode ? "#c7d2fe" : "#334155"),
            edgeLabelBackground: hslVar("--card", isDarkThemeMode ? "#1a2132" : "#ffffff"),
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          },
          flowchart: {
            curve: "basis",
            htmlLabels: true,
            defaultRenderer: "elk",
            nodeSpacing: 70,
            rankSpacing: 95,
            diagramPadding: 10,
            useMaxWidth: false,
          },
        });
        const id = `topology_${Date.now()}`;
        const rendered = await mermaid.render(id, mermaidCode);
        if (!cancelled) {
          const themedSvg = applyEdgeLabelTheme(rendered.svg, isDarkThemeMode);
          setSvgMarkup(themedSvg);
          const doc = new DOMParser().parseFromString(themedSvg, "image/svg+xml");
          const svg = doc.querySelector("svg");
          const vb = svg?.getAttribute("viewBox");
          if (vb) {
            const parts = vb.split(/\s+/).map((p) => Number(p));
            const w = Number.isFinite(parts[2]) ? parts[2] : 1000;
            const h = Number.isFinite(parts[3]) ? parts[3] : 600;
            setGraphSize({ w, h });
          }
        }
      } catch (error) {
        if (!cancelled) {
          setRenderError(error instanceof Error ? error.message : String(error));
          setSvgMarkup("");
        }
      } finally {
        if (!cancelled) setIsRendering(false);
      }
    }
    if (!mermaidCode.trim()) return;
    void render();
    return () => {
      cancelled = true;
    };
  }, [isDarkThemeMode, mermaidCode, themeVersion]);

  useEffect(() => {
    if (!viewportRef.current) return;
    const node = viewportRef.current;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setViewportSize({ w: rect.width, h: rect.height });
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [expandGraph]);

  useEffect(() => {
    if (!expandGraph || typeof document === "undefined") return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeExpandGraph();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [closeExpandGraph, expandGraph]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  const computeFitScale = useCallback(() => {
    if (!viewportSize.w || !viewportSize.h || !graphSize.w || !graphSize.h) return 1;
    const padding = expandGraph ? 10 : 16;
    const availW = Math.max(1, viewportSize.w - padding * 2);
    const availH = Math.max(1, viewportSize.h - padding * 2);
    const baseFit = Math.min(availW / graphSize.w, availH / graphSize.h);
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, baseFit));
  }, [expandGraph, graphSize.h, graphSize.w, viewportSize.h, viewportSize.w]);

  const fitAndCenterGraph = useCallback(() => {
    if (!viewportSize.w || !viewportSize.h || !graphSize.w || !graphSize.h) return;
    const fitScale = computeFitScale();
    const x = (viewportSize.w - graphSize.w * fitScale) / 2;
    const y = (viewportSize.h - graphSize.h * fitScale) / 2;
    setZoom(Number(fitScale.toFixed(2)));
    setPan({ x, y });
    userAdjustedViewRef.current = false;
  }, [computeFitScale, graphSize.h, graphSize.w, viewportSize.h, viewportSize.w]);

  const fitScaleReference = useMemo(() => computeFitScale(), [computeFitScale]);
  const zoomPercent = useMemo(() => {
    if (!fitScaleReference || !Number.isFinite(fitScaleReference)) return Math.round(zoom * 100);
    return Math.max(1, Math.round((zoom / fitScaleReference) * 100));
  }, [fitScaleReference, zoom]);

  useEffect(() => {
    const key = `${graphSize.w}x${graphSize.h}|${viewportSize.w}x${viewportSize.h}|${records.length}|${expandGraph ? "full" : "panel"}`;
    if (!graphSize.w || !viewportSize.w) return;
    if (autoFitDoneRef.current === key && userAdjustedViewRef.current) return;
    if (autoFitDoneRef.current !== key || !userAdjustedViewRef.current) {
      fitAndCenterGraph();
      autoFitDoneRef.current = key;
    }
  }, [expandGraph, fitAndCenterGraph, graphSize.h, graphSize.w, records.length, viewportSize.h, viewportSize.w]);

  const zoomBy = useCallback((delta: number) => {
    userAdjustedViewRef.current = true;
    const viewport = viewportRef.current;
    if (!viewport) {
      setZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number((z + delta).toFixed(2)))));
      return;
    }
    const oldZoom = zoomRef.current;
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number((oldZoom + delta).toFixed(2))));
    if (newZoom === oldZoom) return;
    const oldPan = panRef.current;
    const centerX = viewport.clientWidth / 2;
    const centerY = viewport.clientHeight / 2;
    const worldX = (centerX - oldPan.x) / oldZoom;
    const worldY = (centerY - oldPan.y) / oldZoom;
    const nextPan = {
      x: centerX - worldX * newZoom,
      y: centerY - worldY * newZoom,
    };
    setZoom(newZoom);
    setPan(nextPan);
  }, []);

  const zoomAtCursor = useCallback((delta: number, event: WheelEvent<HTMLDivElement>) => {
    userAdjustedViewRef.current = true;
    const viewport = viewportRef.current;
    if (!viewport) {
      zoomBy(delta);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const oldZoom = zoomRef.current;
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number((oldZoom + delta).toFixed(2))));
    if (newZoom === oldZoom) return;
    const oldPan = panRef.current;
    const worldX = (cursorX - oldPan.x) / oldZoom;
    const worldY = (cursorY - oldPan.y) / oldZoom;
    const nextPan = {
      x: cursorX - worldX * newZoom,
      y: cursorY - worldY * newZoom,
    };
    setZoom(newZoom);
    setPan(nextPan);
  }, [zoomBy]);

  const handleWheelCapture = useCallback((event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    zoomAtCursor(event.deltaY < 0 ? 0.08 : -0.08, event);
  }, [zoomAtCursor]);

  const normalizeTo100 = useCallback(() => {
    userAdjustedViewRef.current = true;
    const scale = fitScaleReference;
    setZoom(scale);
    if (!viewportSize.w || !viewportSize.h || !graphSize.w || !graphSize.h) return;
    const x = (viewportSize.w - graphSize.w * scale) / 2;
    const y = (viewportSize.h - graphSize.h * scale) / 2;
    setPan({ x, y });
  }, [fitScaleReference, graphSize.h, graphSize.w, viewportSize.h, viewportSize.w]);

  const resetView = useCallback(() => {
    autoFitDoneRef.current = "";
    fitAndCenterGraph();
  }, [fitAndCenterGraph]);

  const handleMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.button === 1) {
      event.preventDefault();
      middleDragRestoreHandRef.current = handTool;
      setHandTool(true);
    } else if (event.button !== 0) {
      return;
    } else if (!handTool) {
      return;
    }
    userAdjustedViewRef.current = true;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseX: pan.x,
      baseY: pan.y,
    };
  }, [handTool, pan.x, pan.y]);

  const handleMouseMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    setPan({ x: dragRef.current.baseX + dx, y: dragRef.current.baseY + dy });
  }, []);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    if (middleDragRestoreHandRef.current !== null) {
      setHandTool(middleDragRestoreHandRef.current);
      middleDragRestoreHandRef.current = null;
    }
  }, []);

  const handleViewportClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (nodeContextMenu.open) {
      setNodeContextMenu((prev) => ({ ...prev, open: false }));
    }
    if (!annotationTool || !viewportRef.current) return;
    const rect = viewportRef.current.getBoundingClientRect();
    const x = (event.clientX - rect.left - pan.x) / zoom;
    const y = (event.clientY - rect.top - pan.y) / zoom;
    setAnnotations((prev) => [
      ...prev,
      {
        id: `ann_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        x,
        y,
        text: annotationDraft.trim() || "Note",
      },
    ]);
  }, [annotationDraft, annotationTool, nodeContextMenu.open, pan.x, pan.y, zoom]);

  const handleNodeContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const nodeEl = target.closest(".node") as HTMLElement | null;
    if (!nodeEl) return;
    const rawId = nodeEl.getAttribute("id") ?? "";
    let normalizedNodeId = rawId.replace(/^flowchart-/, "").replace(/^graph-/, "");
    while (/-\d+$/.test(normalizedNodeId)) {
      normalizedNodeId = normalizedNodeId.replace(/-\d+$/, "");
    }
    const meta = nodeMetaById[normalizedNodeId];
    if (!meta) return;
    event.preventDefault();
    event.stopPropagation();
    setNodeContextMenu({
      open: true,
      x: event.clientX,
      y: event.clientY,
      text: meta.text,
      recordId: meta.recordId || undefined,
      address: meta.address || undefined,
    });
  }, [nodeMetaById]);

  const exportCode = useCallback(() => {
    const baseName = `${normalizeDomain(zoneName) || "zone"}-topology`;
    if (desktop) {
      void TauriClient.saveTopologyAsset(
        "mmd",
        `${baseName}.mmd`,
        mermaidCode,
        false,
        exportFolderPreset,
        exportCustomPath,
        exportConfirmPath,
      )
        .then((path) => {
          toast({ title: "Exported", description: path });
        })
        .catch((e) => {
          toast({
            title: "Export failed",
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        });
      return;
    }
    const blob = new Blob([mermaidCode], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.mmd`;
    a.click();
    URL.revokeObjectURL(url);
  }, [desktop, mermaidCode, zoneName, exportFolderPreset, exportCustomPath, exportConfirmPath, toast]);

  const copyCode = useCallback(async () => {
    await navigator.clipboard.writeText(mermaidCode);
    toast({ title: "Copied", description: "Topology Mermaid code copied to clipboard." });
  }, [mermaidCode, toast]);

  const renderSvgToPngBlob = useCallback(async (): Promise<Blob | null> => {
    if (!svgMarkup.trim()) return null;
    const sanitizeSvgForRasterization = (input: string): string => {
      try {
        const doc = new DOMParser().parseFromString(input, "image/svg+xml");
        const isExternalRef = (value: string | null) =>
          Boolean(value && /^(https?:)?\/\//i.test(value.trim()));
        const stripExternalUrls = (value: string) =>
          value
            .replace(/url\((['"]?)(https?:)?\/\/.*?\1\)/gi, "none")
            .replace(/@import\s+url\((['"]?)(https?:)?\/\/.*?\1\)\s*;?/gi, "");
        for (const el of Array.from(doc.querySelectorAll("image,use"))) {
          const href = el.getAttribute("href") ?? el.getAttribute("xlink:href");
          if (isExternalRef(href)) {
            el.remove();
          }
        }
        for (const el of Array.from(doc.querySelectorAll("[href],[xlink\\:href],[src]"))) {
          const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? el.getAttribute("src");
          if (isExternalRef(href)) {
            el.removeAttribute("href");
            el.removeAttribute("xlink:href");
            el.removeAttribute("src");
          }
        }
        for (const el of Array.from(doc.querySelectorAll("[style]"))) {
          const style = el.getAttribute("style");
          if (!style) continue;
          el.setAttribute("style", stripExternalUrls(style));
        }
        for (const styleNode of Array.from(doc.querySelectorAll("style"))) {
          styleNode.textContent = stripExternalUrls(styleNode.textContent ?? "");
        }
        const svg = doc.querySelector("svg");
        if (svg && !svg.getAttribute("xmlns")) {
          svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        }
        return svg ? new XMLSerializer().serializeToString(svg) : input;
      } catch {
        return input;
      }
    };
    const safeSvgMarkup = sanitizeSvgForRasterization(svgMarkup);
    const parsed = new DOMParser().parseFromString(safeSvgMarkup, "image/svg+xml");
    const svg = parsed.querySelector("svg");
    const vb = svg?.getAttribute("viewBox")?.split(/\s+/).map(Number) ?? [];
    const widthAttr = Number(svg?.getAttribute("width")?.replace(/[^\d.]/g, ""));
    const heightAttr = Number(svg?.getAttribute("height")?.replace(/[^\d.]/g, ""));
    const width =
      Number.isFinite(widthAttr) && widthAttr > 0
        ? widthAttr
        : Number.isFinite(vb[2]) && vb[2] > 0
          ? vb[2]
          : 1600;
    const height =
      Number.isFinite(heightAttr) && heightAttr > 0
        ? heightAttr
        : Number.isFinite(vb[3]) && vb[3] > 0
          ? vb[3]
          : 900;
    const svgBlob = new Blob([safeSvgMarkup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(safeSvgMarkup)}`;
    try {
      const loadSvgImage = async () =>
        await new Promise<HTMLImageElement>((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = () => reject(new Error("Failed to render SVG"));
          i.src = url;
        }).catch(
          async () =>
            await new Promise<HTMLImageElement>((resolve, reject) => {
              const i = new Image();
              i.onload = () => resolve(i);
              i.onerror = () => reject(new Error("Failed to render SVG data URL"));
              i.src = dataUrl;
            }),
        );
      const img = await loadSvgImage();
      const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      try {
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
      } catch {
        return null;
      }
      const blob = await new Promise<Blob | null>((resolve) => {
        try {
          canvas.toBlob((b) => resolve(b), "image/png");
        } catch {
          resolve(null);
        }
      });
      if (blob) return blob;
      try {
        const data = canvas.toDataURL("image/png");
        const fetched = await fetch(data);
        return await fetched.blob();
      } catch {
        return null;
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [svgMarkup]);

  const copySvg = useCallback(async () => {
    if (!svgMarkup.trim()) return;
    const svgBlob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
    try {
      if ("ClipboardItem" in window && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "image/svg+xml": svgBlob })]);
      } else {
        await navigator.clipboard.writeText(svgMarkup);
      }
      toast({ title: "Copied", description: "Topology SVG copied to clipboard." });
    } catch {
      await navigator.clipboard.writeText(svgMarkup);
      toast({ title: "Copied", description: "SVG markup copied to clipboard." });
    }
  }, [svgMarkup, toast]);

  const copyPng = useCallback(async () => {
    const pngBlob = await renderSvgToPngBlob();
    if (!pngBlob) {
      toast({ title: "Copy failed", description: "Unable to render PNG from topology.", variant: "destructive" });
      return;
    }
    if ("ClipboardItem" in window && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
      toast({ title: "Copied", description: "Topology PNG copied to clipboard." });
      return;
    }
    toast({
      title: "Copy unsupported",
      description: "PNG clipboard writing is not supported in this environment.",
      variant: "destructive",
    });
  }, [renderSvgToPngBlob, toast]);

  const exportSvg = useCallback(() => {
    if (!svgMarkup.trim()) return;
    const baseName = `${normalizeDomain(zoneName) || "zone"}-topology`;
    if (desktop) {
      void TauriClient.saveTopologyAsset(
        "svg",
        `${baseName}.svg`,
        svgMarkup,
        false,
        exportFolderPreset,
        exportCustomPath,
        exportConfirmPath,
      )
        .then((path) => {
          toast({ title: "Exported", description: path });
        })
        .catch((e) => {
          toast({
            title: "Export failed",
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        });
      return;
    }
    const blob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [desktop, exportConfirmPath, exportCustomPath, exportFolderPreset, svgMarkup, toast, zoneName]);

  const exportPng = useCallback(async () => {
    const pngBlob = await renderSvgToPngBlob();
    if (!pngBlob) {
      toast({ title: "Export failed", description: "Unable to render PNG from topology.", variant: "destructive" });
      return;
    }
    const baseName = `${normalizeDomain(zoneName) || "zone"}-topology`;
    if (desktop) {
      const bytes = await pngBlob.arrayBuffer();
      const arr = new Uint8Array(bytes);
      let binary = "";
      for (let i = 0; i < arr.length; i += 1) {
        binary += String.fromCharCode(arr[i]);
      }
      const b64 = btoa(binary);
      try {
        const path = await TauriClient.saveTopologyAsset(
          "png",
          `${baseName}.png`,
          b64,
          true,
          exportFolderPreset,
          exportCustomPath,
          exportConfirmPath,
        );
        toast({ title: "Exported", description: path });
      } catch (e) {
        toast({
          title: "Export failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        });
      }
      return;
    }
    const url = URL.createObjectURL(pngBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, [desktop, exportConfirmPath, exportCustomPath, exportFolderPreset, renderSvgToPngBlob, toast, zoneName]);

  const printToPdf = useCallback(() => {
    if (!svgMarkup.trim()) return;
    const win = window.open("", "_blank", "noopener,noreferrer");
    if (!win) return;
    const noteHtml = annotations
      .map((ann) => `<li><strong>${ann.text}</strong> (${Math.round(ann.x)}, ${Math.round(ann.y)})</li>`)
      .join("");
    win.document.write(`
      <html>
        <head>
          <title>${zoneName} topology</title>
          <style>
            body { font-family: system-ui, sans-serif; margin: 20px; color: #111; }
            .graph { border: 1px solid #ddd; border-radius: 10px; padding: 12px; }
          </style>
        </head>
        <body>
          <h1>${zoneName} topology</h1>
          <div class="graph">${svgMarkup}</div>
          ${noteHtml ? `<h3>Annotations</h3><ul>${noteHtml}</ul>` : ""}
          <script>window.onload = () => window.print();<\/script>
        </body>
      </html>
    `);
    win.document.close();
  }, [annotations, svgMarkup, zoneName]);

  const controlsDisabled = isLoading || isRendering || topologyResolutionProgress.running;
  const cursorClass = annotationTool ? "cursor-crosshair" : handTool ? "cursor-grab" : "cursor-default";
  const graphBackgroundClass = isDarkThemeMode
    ? "bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_55%),linear-gradient(to_bottom_right,rgba(255,255,255,0.04),rgba(0,0,0,0.15))]"
    : "bg-[radial-gradient(circle_at_top,rgba(15,23,42,0.09),transparent_55%),linear-gradient(to_bottom_right,rgba(255,255,255,0.95),rgba(226,232,240,0.75))]";
  const loadingOverlayClass = isDarkThemeMode ? "bg-black/35 backdrop-blur-md" : "bg-white/60 backdrop-blur-md";
  const panX = Math.round(pan.x);
  const panY = Math.round(pan.y);
  const topologyProgressLabel = useMemo(() => {
    if (!topologyResolutionProgress.running) return "Rendering topology...";
    const total = Math.max(1, topologyResolutionProgress.total);
    const done = Math.min(total, topologyResolutionProgress.done);
    const pct = Math.round((done / total) * 100);
    return `Resolving chain nodes ${done}/${total} (${pct}%)...`;
  }, [topologyResolutionProgress.done, topologyResolutionProgress.running, topologyResolutionProgress.total]);
  const activeRequestPreview = useMemo(() => {
    if (!topologyResolutionProgress.running || activeResolutionRequests.length === 0) return "";
    const head = activeResolutionRequests.slice(0, 4).join(", ");
    const extra = activeResolutionRequests.length > 4 ? ` (+${activeResolutionRequests.length - 4} more)` : "";
    return `Requests: ${head}${extra}`;
  }, [activeResolutionRequests, topologyResolutionProgress.running]);
  const zoneBase = useMemo(() => normalizeDomain(zoneName), [zoneName]);
  const emailRecords = useMemo(
    () =>
      records.filter((r) => {
        const n = normalizeDomain(r.name);
        const txt = String(r.content ?? "").toLowerCase();
        return (
          r.type === "MX" ||
          r.type === "SPF" ||
          n.includes("_dmarc") ||
          n.includes("._domainkey") ||
          n.includes("_bimi") ||
          (r.type === "TXT" &&
            (txt.includes("v=spf1") || txt.includes("v=dmarc1") || txt.includes("v=dkim1") || txt.includes("v=bimi1")))
        );
      }),
    [records],
  );
  const mxResolvedRows = useMemo(() => {
    const cnameMap = buildCnameMap(records);
    const { ipv4ByName, ipv6ByName } = buildAddressMaps(records);
    return records
      .filter((r) => r.type === "MX")
      .map((record) => {
        const from = normalizeDomain(record.name) || normalizeDomain(zoneName);
        const rawParts = String(record.content ?? "").trim().split(/\s+/);
        const maybePriority = Number(rawParts[0]);
        const priority = Number.isFinite(maybePriority) ? maybePriority : null;
        const target = extractTarget(record) || "";
        const local = resolveNameToTerminal(
          target,
          cnameMap,
          ipv4ByName,
          ipv6ByName,
          Math.max(1, Math.min(15, Math.round(maxResolutionHops))),
        );
        const best = pickBestResolution(target, local, externalResolutionByName);
        const chain = best.chain.length ? best.chain : local.chain;
        const ipv4 = best.ipv4.length ? best.ipv4 : local.ipv4;
        const ipv6 = best.ipv6.length ? best.ipv6 : local.ipv6;
        const terminal = best.terminal || local.terminal || target;
        const source =
          local.ipv4.length || local.ipv6.length
            ? "in-zone"
            : best.ipv4.length || best.ipv6.length || best.chain.length > local.chain.length
              ? "external"
              : "none";
        const reverse = Object.entries(best.reverseHostnamesByIp ?? {})
          .flatMap(([ip, hosts]) => hosts.map((host) => `${ip} => ${host}`));
        return {
          id: record.id,
          from,
          priority,
          target,
          chain,
          terminal,
          ipv4,
          ipv6,
          reverse,
          source,
        };
      });
  }, [externalResolutionByName, maxResolutionHops, records, zoneName]);

  const runDiscovery = useCallback(async () => {
    if (disableServiceDiscovery) {
      toast({ title: "Service discovery disabled", description: "Enable it in Topology settings to run checks." });
      return;
    }
    const items: ServiceDiscoveryItem[] = [];
    setDiscovering(true);
    try {
      const hasMx = records.some((r) => r.type === "MX");
      const hasNs = records.some((r) => r.type === "NS");
      const hasSshHost = records.some((r) => normalizeDomain(r.name).includes("ssh"));
      const hasSrv = records.filter((r) => r.type === "SRV");
      if (hasMx) items.push({ service: "SMTP", status: "inferred", details: "MX records present" });
      if (hasNs) items.push({ service: "DNS", status: "inferred", details: "NS records present" });
      if (hasSshHost || hasSrv.some((r) => String(r.content).toLowerCase().includes("22 "))) {
        items.push({ service: "SSH", status: "inferred", details: "SSH-like host/SRV detected" });
      }
      if (hasSrv.some((r) => normalizeDomain(r.name).includes("_ftp"))) {
        items.push({ service: "FTP", status: "inferred", details: "FTP SRV found" });
      }

      const httpTargets = new Set<string>([zoneBase, `www.${zoneBase}`]);
      for (const r of records) {
        if (!["A", "AAAA", "CNAME"].includes(r.type)) continue;
        const n = normalizeDomain(r.name);
        if (n && (n === zoneBase || n.startsWith("www.") || n.startsWith("api."))) {
          httpTargets.add(n);
        }
      }
      const probeHosts = Array.from(httpTargets).filter(Boolean).slice(0, 4);
      const clampedHops = Math.max(1, Math.min(15, Math.round(maxResolutionHops)));
      const probePrefix = `${resolverMode}|${dnsServer}|${customDnsServer.trim()}|${dohProvider}|${dohCustomUrl.trim()}|${clampedHops}|probe|`;
      const now = Date.now();
      const probeMap = new Map<string, { host: string; httpsUp: boolean; httpUp: boolean }>();
      for (const host of probeHosts) {
        const norm = normalizeDomain(host);
        const cacheKey = `${probePrefix}${norm}`;
        const cached = probeCacheRef.current.get(cacheKey);
        if (cached && now - cached.ts <= TOPOLOGY_CACHE_TTL_MS) {
          probeMap.set(norm, { host: norm, httpsUp: cached.httpsUp, httpUp: cached.httpUp });
        }
      }
      const backendBatch = await resolveTopologyBatchInBackend(
        [],
        clampedHops,
        resolverMode,
        dnsServer,
        customDnsServer,
        dohProvider,
        dohCustomUrl,
        lookupTimeoutMs,
        disablePtrLookups,
        tcpServicePorts,
        true,
        geoProvider,
        scanResolutionChain,
        probeHosts,
      );
      if (backendBatch && backendBatch.probes.length > 0) {
        for (const probe of backendBatch.probes) {
          const norm = normalizeDomain(probe.host);
          probeMap.set(norm, { host: norm, httpsUp: probe.httpsUp, httpUp: probe.httpUp });
          probeCacheRef.current.set(`${probePrefix}${norm}`, {
            host: norm,
            httpsUp: probe.httpsUp,
            httpUp: probe.httpUp,
            ts: Date.now(),
          });
        }
      }
      if (probeMap.size > 0) {
        for (const probe of probeMap.values()) {
          const httpsStatus: "up" | "down" = probe.httpsUp ? "up" : "down";
          const httpStatus: "up" | "down" = probe.httpUp ? "up" : "down";
          items.push({
            service: `HTTPS (${probe.host})`,
            status: httpsStatus,
            details: httpsStatus === "up" ? "Backend probe reachable" : "Backend probe failed",
          });
          items.push({
            service: `HTTP (${probe.host})`,
            status: httpStatus,
            details: httpStatus === "up" ? "Backend probe reachable" : "Backend probe failed",
          });
        }
      } else {
        for (const host of probeHosts) {
          const httpsStatus = await probeHttp(`https://${host}`);
          items.push({ service: `HTTPS (${host})`, status: httpsStatus, details: httpsStatus === "up" ? "Probe reachable" : "Probe failed/blocked" });
          const httpStatus = await probeHttp(`http://${host}`);
          items.push({ service: `HTTP (${host})`, status: httpStatus, details: httpStatus === "up" ? "Probe reachable" : "Probe failed/blocked" });
        }
      }
      if (backendBatch && backendBatch.tcpProbes.length > 0) {
        const serviceNameByPort: Record<number, string> = {
          21: "FTP",
          22: "SSH",
          23: "Telnet",
          25: "SMTP",
          53: "DNS",
          80: "HTTP",
          110: "POP3",
          143: "IMAP",
          443: "HTTPS",
          465: "SMTPS",
          587: "Submission",
          993: "IMAPS",
          995: "POP3S",
          3306: "MySQL",
          5432: "PostgreSQL",
        };
        for (const tcp of backendBatch.tcpProbes) {
          const label = serviceNameByPort[tcp.port] ?? `TCP ${tcp.port}`;
          items.push({
            service: `${label} (${tcp.host}:${tcp.port})`,
            status: tcp.up ? "up" : "down",
            details: tcp.up ? "TCP connect succeeded" : "TCP connect failed",
          });
        }
      }
      setDiscovery(items);
      toast({ title: "Discovery complete", description: `Found ${items.length} service signal(s).` });
    } finally {
      setDiscovering(false);
    }
  }, [disableServiceDiscovery, resolverMode, dnsServer, customDnsServer, dohCustomUrl, dohProvider, maxResolutionHops, records, toast, zoneBase, lookupTimeoutMs, disablePtrLookups, tcpServicePorts]);

  const renderGraphControls = (forLightbox: boolean) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => zoomBy(0.1)} disabled={controlsDisabled}>
        <Plus className="h-3.5 w-3.5" />
      </Button>
      <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => zoomBy(-0.1)} disabled={controlsDisabled}>
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <Button size="sm" variant="outline" className="h-8 px-2" onClick={resetView} disabled={controlsDisabled}>
        <ZoomIn className="h-3.5 w-3.5 mr-1" />
        <span
          role="button"
          tabIndex={0}
          className="select-none"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            normalizeTo100();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              normalizeTo100();
            }
          }}
          title="Normalize zoom to 100%"
        >
          {zoomPercent}%
        </span>
      </Button>
      <Button
        size="sm"
        variant={handTool ? "default" : "outline"}
        className="h-8 px-2"
        onClick={() => {
          setHandTool((v) => !v);
          setAnnotationTool(false);
        }}
      >
        <Hand className="h-3.5 w-3.5 mr-1" />
        Hand
      </Button>
      {!disableAnnotations && (
        <>
          <Button
            size="sm"
            variant={annotationTool ? "default" : "outline"}
            className="h-8 px-2"
            onClick={() => {
              setAnnotationTool((v) => !v);
              setHandTool(false);
            }}
          >
            <StickyNote className="h-3.5 w-3.5 mr-1" />
            Annotate
          </Button>
          <Input
            value={annotationDraft}
            onChange={(e) => setAnnotationDraft(e.target.value)}
            className="h-8 w-44"
            placeholder="Annotation text"
          />
        </>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="h-8 px-2" disabled={!mermaidCode && !svgMarkup}>
            <Copy className="h-3.5 w-3.5 mr-1" />
            Copy
            <ChevronDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="w-52">
          <DropdownMenuItem onClick={() => void copyCode()} disabled={!mermaidCode}>
            <Copy className="mr-2 h-3.5 w-3.5" />
            Copy Mermaid code
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copySvg()} disabled={!svgMarkup}>
            <Copy className="mr-2 h-3.5 w-3.5" />
            Copy SVG
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyPng()} disabled={!svgMarkup}>
            <Copy className="mr-2 h-3.5 w-3.5" />
            Copy PNG
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="h-8 px-2" disabled={!mermaidCode && !svgMarkup}>
            <FileDown className="h-3.5 w-3.5 mr-1" />
            Export
            <ChevronDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="w-52">
          <DropdownMenuItem onClick={exportCode} disabled={!mermaidCode}>
            <FileDown className="mr-2 h-3.5 w-3.5" />
            Export Mermaid code
          </DropdownMenuItem>
          <DropdownMenuItem onClick={exportSvg} disabled={!svgMarkup}>
            <FileDown className="mr-2 h-3.5 w-3.5" />
            Export SVG
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void exportPng()} disabled={!svgMarkup}>
            <FileDown className="mr-2 h-3.5 w-3.5" />
            Export PNG
          </DropdownMenuItem>
          <DropdownMenuItem onClick={printToPdf} disabled={!svgMarkup}>
            <FileDown className="mr-2 h-3.5 w-3.5" />
            Export PDF
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2"
        onClick={() => {
          resolutionCacheRef.current.clear();
          probeCacheRef.current.clear();
          setExternalResolutionByName({});
          setTopologyResolutionReady(false);
          setMermaidCode("");
          setSvgMarkup("");
          setActiveResolutionRequests([]);
          setManualRefreshTick((v) => v + 1);
          void onRefresh();
        }}
        disabled={isLoading}
      >
        <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
      </Button>
      {!disableFullWindow && (
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2"
          onClick={() => {
            toggleExpandGraph();
          }}
          title={expandGraph ? "Exit full window" : "Expand to full window"}
        >
          {expandGraph ? (
            <>
              <Minimize2 className="h-3.5 w-3.5 mr-1" />
              Exit full window
            </>
          ) : (
            <>
              <Maximize2 className="h-3.5 w-3.5 mr-1" />
              Full window
            </>
          )}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2"
        onClick={() => void runDiscovery()}
        disabled={discovering || disableServiceDiscovery}
      >
        <Search className={cn("h-3.5 w-3.5 mr-1", discovering && "animate-spin")} />
        Discover services
      </Button>
      {forLightbox && (
        <Button size="sm" variant="outline" className="h-8 px-2" onClick={closeExpandGraph}>
          <Minimize2 className="h-3.5 w-3.5 mr-1" />
          Close
        </Button>
      )}
    </div>
  );

  const fullscreenLightbox =
    expandGraph && typeof document !== "undefined"
      ? createPortal(
          <div className="fixed inset-0 z-[220]">
            <button
              type="button"
              aria-label="Close full window topology view"
              className="absolute inset-0 bg-black/45 backdrop-blur-sm"
              onClick={closeExpandGraph}
            />
            <div className="absolute inset-0 bg-background/96 p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <div>Topology graph - full window mode</div>
              </div>
              <div className="mb-2">{renderGraphControls(true)}</div>
              <div
                ref={expandGraph ? viewportRef : undefined}
                className={cn(
                  "relative h-[calc(100dvh-4rem)] overflow-hidden overscroll-contain rounded-xl border border-border/60 select-none",
                  graphBackgroundClass,
                  cursorClass,
                )}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheelCapture={(event) => {
                  handleWheelCapture(event);
                }}
                onTouchMoveCapture={(event) => {
                  event.stopPropagation();
                }}
                onPointerDownCapture={(event) => {
                  event.stopPropagation();
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                onKeyDownCapture={(event) => {
                  if (
                    [
                      "ArrowUp",
                      "ArrowDown",
                      "ArrowLeft",
                      "ArrowRight",
                      "PageUp",
                      "PageDown",
                      "Home",
                      "End",
                      " ",
                    ].includes(event.key)
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                tabIndex={0}
                onClick={handleViewportClick}
                onContextMenu={handleNodeContextMenu}
              >
                <div
                  className="absolute left-0 top-0"
                  style={{
                    transform: `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`,
                    transformOrigin: "0 0",
                  }}
                >
                  <div className="relative p-4">
                    {renderError ? (
                      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive-foreground">
                        Mermaid render failed: {renderError}
                      </div>
                    ) : (
                      <div
                        className="topology-svg-wrapper"
                        dangerouslySetInnerHTML={{ __html: svgMarkup }}
                      />
                    )}

                    {annotations.map((ann) => (
                      <div
                        key={ann.id}
                        className="absolute rounded-md border border-primary/40 bg-card/90 px-2 py-1 text-[11px] shadow-lg"
                        style={{ left: ann.x, top: ann.y }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="flex items-center gap-2">
                          <span>{ann.text}</span>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => setAnnotations((prev) => prev.filter((x) => x.id !== ann.id))}
                          >
                            x
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {(isRendering || isLoading || topologyResolutionProgress.running) && (
                  <div className={cn("absolute inset-0 z-20 flex items-center justify-center", loadingOverlayClass)}>
                    <div className="flex min-w-[280px] flex-col gap-2 rounded-lg border border-primary/40 bg-card/85 px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      {topologyProgressLabel}
                      </div>
                      {activeRequestPreview ? (
                        <div className="line-clamp-2 text-[11px] text-muted-foreground">{activeRequestPreview}</div>
                      ) : null}
                      {topologyResolutionProgress.running && (
                        <div className="h-1.5 w-full rounded bg-primary/20">
                          <div
                            className="h-full rounded bg-primary transition-all duration-200"
                            style={{
                              width: `${Math.round(
                                (Math.min(
                                  Math.max(topologyResolutionProgress.done, 0),
                                  Math.max(topologyResolutionProgress.total, 1),
                                ) /
                                  Math.max(topologyResolutionProgress.total, 1)) *
                                  100,
                              )}%`,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const nodeContextMenuPortal =
    nodeContextMenu.open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={nodeContextMenuRef}
            className="fixed z-[260] min-w-[220px] rounded-md border border-border/70 bg-card/95 p-1 shadow-2xl backdrop-blur pointer-events-auto"
            style={{ left: Math.max(8, nodeContextMenu.x), top: Math.max(8, nodeContextMenu.y) }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/60"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(nodeContextMenu.text);
                  toast({ title: "Copied", description: "Node text copied to clipboard." });
                } finally {
                  closeNodeContextMenu();
                }
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy node text
            </button>
            <button
              type="button"
              disabled={!buildBrowserUrl(nodeContextMenu.address)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/60",
                !buildBrowserUrl(nodeContextMenu.address) && "cursor-not-allowed opacity-50 hover:bg-transparent",
              )}
              onClick={() => {
                const url = buildBrowserUrl(nodeContextMenu.address);
                if (!url) return;
                window.open(url, "_blank", "noopener,noreferrer");
                closeNodeContextMenu();
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in browser
            </button>
            <button
              type="button"
              disabled={!nodeContextMenu.recordId}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/60",
                !nodeContextMenu.recordId && "cursor-not-allowed opacity-50 hover:bg-transparent",
              )}
              onClick={() => {
                if (!nodeContextMenu.recordId || !onEditRecord) return;
                const rec = records.find((r) => String(r.id ?? "") === nodeContextMenu.recordId);
                if (!rec) return;
                onEditRecord(rec);
                closeNodeContextMenu();
              }}
            >
              <Edit3 className="h-3.5 w-3.5" />
              Go to record and edit
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <Card className="border-border/60 bg-card/70">
      <CardHeader>
        <CardTitle className="text-lg">Topology</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {renderGraphControls(false)}

        <div>
          <div
            ref={!expandGraph ? viewportRef : undefined}
            className={cn(
              "relative overflow-hidden overscroll-contain rounded-xl border border-border/60 select-none",
              graphBackgroundClass,
              "h-[560px]",
              cursorClass,
            )}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheelCapture={(event) => {
            handleWheelCapture(event);
          }}
          onTouchMoveCapture={(event) => {
            event.stopPropagation();
          }}
          onPointerDownCapture={(event) => {
            event.stopPropagation();
          }}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onKeyDownCapture={(event) => {
            if (
              [
                "ArrowUp",
                "ArrowDown",
                "ArrowLeft",
                "ArrowRight",
                "PageUp",
                "PageDown",
                "Home",
                "End",
                " ",
              ].includes(event.key)
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          tabIndex={0}
          onClick={handleViewportClick}
          onContextMenu={handleNodeContextMenu}
          >
          <div
            className="absolute left-0 top-0"
            style={{
              transform: `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            <div className="relative p-4">
              {renderError ? (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive-foreground">
                  Mermaid render failed: {renderError}
                </div>
              ) : (
                <div
                  className="topology-svg-wrapper"
                  dangerouslySetInnerHTML={{ __html: svgMarkup }}
                />
              )}

              {annotations.map((ann) => (
                <div
                  key={ann.id}
                  className="absolute rounded-md border border-primary/40 bg-card/90 px-2 py-1 text-[11px] shadow-lg"
                  style={{ left: ann.x, top: ann.y }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="flex items-center gap-2">
                    <span>{ann.text}</span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setAnnotations((prev) => prev.filter((x) => x.id !== ann.id))}
                    >
                      x
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {(isRendering || isLoading || topologyResolutionProgress.running) && (
            <div className={cn("absolute inset-0 z-20 flex items-center justify-center", loadingOverlayClass)}>
              <div className="flex min-w-[280px] flex-col gap-2 rounded-lg border border-primary/40 bg-card/85 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                {topologyProgressLabel}
                </div>
                {activeRequestPreview ? (
                  <div className="line-clamp-2 text-[11px] text-muted-foreground">{activeRequestPreview}</div>
                ) : null}
                {topologyResolutionProgress.running && (
                  <div className="h-1.5 w-full rounded bg-primary/20">
                    <div
                      className="h-full rounded bg-primary transition-all duration-200"
                      style={{
                        width: `${Math.round(
                          (Math.min(
                            Math.max(topologyResolutionProgress.done, 0),
                            Math.max(topologyResolutionProgress.total, 1),
                          ) /
                            Math.max(topologyResolutionProgress.total, 1)) *
                            100,
                        )}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
          </div>
        </div>
        {fullscreenLightbox}
        {nodeContextMenuPortal}
        <div className="space-y-2">
          <details className="rounded-lg border border-border/60 bg-card/55 p-3 text-xs" open>
            <summary className="cursor-pointer select-none font-semibold">Topology summary</summary>
            <div className="mt-2 space-y-1 text-muted-foreground">
              {summary.cnameChains.slice(0, 6).map((chain) => (
                <div key={chain.start}>CNAME chain: {chain.chain.join(" -> ")}</div>
              ))}
              {summary.sharedIps.slice(0, 8).map((cluster) => (
                <div key={cluster.ip}>Shared IP {cluster.ip}: {cluster.names.join(", ")}</div>
              ))}
              {summary.detectedServices.slice(0, 8).map((svc) => (
                <div key={`${svc.name}:${svc.via}`}>Provider: {svc.name} via {svc.via}</div>
              ))}
              {summary.mxTrails.slice(0, 10).map((mx) => (
                <div key={`${mx.from}:${mx.priority ?? "na"}:${mx.target}`}>
                  {(() => {
                    const external = externalResolutionByName[normalizeDomain(mx.terminal || mx.target)];
                    const chain = mx.chain.length > 1 ? mx.chain : external?.chain ?? mx.chain;
                    const ipv4 = mx.ipv4.length ? mx.ipv4 : external?.ipv4 ?? [];
                    const ipv6 = mx.ipv6.length ? mx.ipv6 : external?.ipv6 ?? [];
                    return (
                      <>
                  MX trail {mx.from} (prio {mx.priority ?? "?"}) {"->"} {mx.target}
                  {chain.length > 1 ? ` -> ${chain.slice(1).join(" -> ")}` : ""}
                  {ipv4.length || ipv6.length
                    ? ` | A: ${ipv4.join(", ") || "none"} | AAAA: ${ipv6.join(", ") || "none"}`
                    : " | no terminal A/AAAA found"}
                      </>
                    );
                  })()}
                </div>
              ))}
            </div>
          </details>

          <details className="rounded-lg border border-border/60 bg-card/55 p-3 text-xs" open>
            <summary className="cursor-pointer select-none font-semibold">MX records resolved ({mxResolvedRows.length})</summary>
            <div className="mt-2 space-y-1 text-muted-foreground">
              {mxResolvedRows.length === 0 ? (
                <div>No MX records found.</div>
              ) : (
                mxResolvedRows.map((mx) => (
                  <div key={mx.id}>
                    {mx.from} | prio {mx.priority ?? "—"} | target {mx.target || "—"} | chain{" "}
                    {mx.chain.length ? mx.chain.join(" -> ") : "—"} | end {mx.terminal || "—"} | A{" "}
                    {mx.ipv4.join(", ") || "none"} | AAAA {mx.ipv6.join(", ") || "none"} | source {mx.source}
                    {mx.reverse.length > 0 ? ` | PTR ${mx.reverse.join("; ")}` : ""}
                  </div>
                ))
              )}
            </div>
          </details>

          <details className="rounded-lg border border-border/60 bg-card/55 p-3 text-xs">
            <summary className="cursor-pointer select-none font-semibold">Email and related records ({emailRecords.length})</summary>
            <div className="mt-2 space-y-1 text-muted-foreground">
              {emailRecords.length === 0 ? (
                <div>No email records found.</div>
              ) : (
                emailRecords.slice(0, 40).map((r) => (
                  <div key={r.id} className="truncate">
                    {r.type} {r.name} {"->"} {String(r.content ?? "—")}
                  </div>
                ))
              )}
            </div>
          </details>

          {discovery.length > 0 && (
            <details className="rounded-lg border border-border/60 bg-card/55 p-3 text-xs">
              <summary className="cursor-pointer select-none font-semibold">Basic service discovery ({discovery.length})</summary>
              <div className="mt-2 space-y-1 text-muted-foreground">
                {discovery.map((item) => (
                  <div key={`${item.service}:${item.details}`}>
                    {item.service}: {item.status} ({item.details})
                  </div>
                ))}
              </div>
            </details>
          )}

          <details className="rounded-lg border border-border/60 bg-card/55 p-3 text-xs">
            <summary className="cursor-pointer select-none font-semibold">Nodes ({summary.nodeSummaries.length})</summary>
            <div className="mt-2 space-y-2 max-h-72 overflow-auto pr-1">
              {summary.nodeSummaries.map((node) => (
                <div key={node.name} className="rounded-md border border-border/50 bg-background/25 p-2">
                  <div className="font-medium">{node.name}</div>
                  {node.resolvedTo.length > 0 && (
                    <div className="text-muted-foreground">CNAME resolves: {node.resolvedTo.join(" -> ")}</div>
                  )}
                  {(() => {
                    const external = externalResolutionByName[normalizeDomain(node.terminal || node.name)];
                    const ipv4 = node.ipv4.length ? node.ipv4 : external?.ipv4 ?? [];
                    const ipv6 = node.ipv6.length ? node.ipv6 : external?.ipv6 ?? [];
                    const chain = node.resolvedTo.length
                      ? [node.name, ...node.resolvedTo]
                      : external?.chain ?? [node.name];
                    const ptr = Object.entries(external?.reverseHostnamesByIp ?? {})
                      .flatMap(([ip, hosts]) => hosts.map((host) => `${ip} => ${host}`));
                    if (!ipv4.length && !ipv6.length && chain.length <= 1) return null;
                    return (
                    <div className="text-muted-foreground">
                      Chain: {chain.join(" -> ")} | End node: {node.terminal || external?.terminal || node.name} | IPv4: {ipv4.join(", ") || "none"} | IPv6: {ipv6.join(", ") || "none"}
                      {ptr.length > 0 ? ` | PTR: ${ptr.join("; ")}` : ""}
                    </div>
                    );
                  })()}
                  <div className="mt-1 space-y-1">
                    {node.records.slice(0, 8).map((record) => (
                      <div key={record.id} className="flex items-center justify-between gap-2 rounded bg-background/30 px-2 py-1">
                        <div className="min-w-0">
                          <div className="truncate">
                            <span className="font-medium">{record.type}</span>{" "}
                            <span className="text-muted-foreground">{String(record.content ?? "—")}</span>
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            TTL: {String(record.ttl ?? "auto")} {record.proxied ? "| Proxied" : "| DNS only"}
                          </div>
                        </div>
                        {onEditRecord && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2"
                            onClick={() => onEditRecord(record)}
                          >
                            <Edit3 className="h-3.5 w-3.5 mr-1" />
                            Edit
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      </CardContent>
    </Card>
  );
}
