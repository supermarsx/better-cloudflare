import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Copy,
  Download,
  Edit3,
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
  onRefresh: () => Promise<void> | void;
  onEditRecord?: (record: DNSRecord) => void;
};

type ServiceDiscoveryItem = {
  service: string;
  status: "up" | "down" | "inferred";
  details: string;
};

type ExternalDnsResolution = {
  chain: string[];
  terminal: string;
  ipv4: string[];
  ipv6: string[];
  source: "external";
  error?: string;
};

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

function safeNodeLabel(name: string, info: string): string {
  const compactInfo = info.replace(/\n/g, "<br/>");
  return `${esc(name)}<br/><span style='font-size:11px;opacity:0.8'>${esc(compactInfo)}</span>`;
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
): { code: string; summary: TopologySummary } {
  const lines: string[] = [];
  const nodeIds = new Map<string, string>();
  let nextId = 0;
  const zoneNode = "zone_root";
  const zone = normalizeDomain(zoneName);

  const sharedIpMap = new Map<string, Set<string>>();
  const detectedServices = new Map<string, string>();
  const cnameChains = computeCnameChains(records, maxResolutionHops);
  const cnameMap = buildCnameMap(records);
  const { ipv4ByName, ipv6ByName } = buildAddressMaps(records);
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
    const mxTarget = extractTarget(r);
    if (!mxTarget) continue;
    const resolved = resolveNameToTerminal(mxTarget, cnameMap, ipv4ByName, ipv6ByName, maxResolutionHops);
    mxTrails.push({
      from: fromName,
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

  lines.push("flowchart LR");
  lines.push(`  ${zoneNode}["${esc(`Zone: ${zone || zoneName}`)}"]:::zone`);

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
    const resolved = resolveNameToTerminal(unit.name, cnameMap, ipv4ByName, ipv6ByName, maxResolutionHops);
    const endpointInfo =
      resolved.ipv4.length || resolved.ipv6.length
        ? `A:${resolved.ipv4.length || 0} AAAA:${resolved.ipv6.length || 0}`
        : "";
    const ttlValues = Array.from(new Set(unit.records.map((r) => String(r.ttl ?? "auto"))));
    const proxyValues = Array.from(new Set(unit.records.map((r) => (r.proxied ? "proxied" : "dns-only"))));
    const info = [
      `type:${unit.type}${unit.aggregate ? ` x${unit.records.length}` : ""}`,
      `ttl:${ttlValues.length === 1 ? ttlValues[0] : "mixed"}`,
      proxyValues.length === 1 ? proxyValues[0] : "proxy:mixed",
      resolved.chain.length > 1 ? `resolves:${resolved.terminal}` : "",
      endpointInfo,
    ]
      .filter(Boolean)
      .join(" | ");
    lines.push(`  ${recordId}["${safeNodeLabel(unit.name, info || "record")}"]:::record`);
    lines.push(`  ${zoneNode} --> ${recordId}`);

    const targets = Array.from(
      new Set(unit.records.map((r) => extractTarget(r)).filter((v): v is string => Boolean(v))),
    );
    for (const target of targets) {
      const isIp = unit.type === "A" || unit.type === "AAAA";
      const targetKey = `${isIp ? "ip" : "target"}:${target}`;
      const targetId = idFor(targetKey);
      const targetClass = isIp ? "ip" : "target";

      if (!usedNames.has(targetKey)) {
        lines.push(`  ${targetId}["${esc(target)}"]:::${targetClass}`);
        usedNames.add(targetKey);
      }

      lines.push(`  ${recordId} -- "${esc(unit.type)}" --> ${targetId}`);
      edgeSet.add(`${recordId}|${unit.type}|${targetId}`);

      // Trace hostname -> CNAME chain -> terminal A/AAAA path for non-IP targets.
      if (!isIp) {
        const resolvedTarget = resolveNameToTerminal(
          target,
          cnameMap,
          ipv4ByName,
          ipv6ByName,
          maxResolutionHops,
        );
        for (let i = 0; i < resolvedTarget.chain.length - 1; i += 1) {
          const from = resolvedTarget.chain[i];
          const to = resolvedTarget.chain[i + 1];
          const fromId = idFor(`target:${from}`);
          const toId = idFor(`target:${to}`);
          if (!usedNames.has(`target:${from}`)) {
            lines.push(`  ${fromId}["${esc(from)}"]:::target`);
            usedNames.add(`target:${from}`);
          }
          if (!usedNames.has(`target:${to}`)) {
            lines.push(`  ${toId}["${esc(to)}"]:::target`);
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
            lines.push(`  ${ipId}["${esc(ip)}"]:::ip`);
            usedNames.add(`ip:${ip}`);
          }
          const termId = idFor(`target:${resolvedTarget.terminal || target}`);
          const k = `${termId}|A|${ipId}`;
          if (!edgeSet.has(k)) {
            lines.push(`  ${termId} -. "A" .-> ${ipId}`);
            edgeSet.add(k);
          }
        }
        for (const ip of resolvedTarget.ipv6) {
          const ipId = idFor(`ip:${ip}`);
          if (!usedNames.has(`ip:${ip}`)) {
            lines.push(`  ${ipId}["${esc(ip)}"]:::ip`);
            usedNames.add(`ip:${ip}`);
          }
          const termId = idFor(`target:${resolvedTarget.terminal || target}`);
          const k = `${termId}|AAAA|${ipId}`;
          if (!edgeSet.has(k)) {
            lines.push(`  ${termId} -. "AAAA" .-> ${ipId}`);
            edgeSet.add(k);
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
    lines.push(`  ${serviceId}["${esc(serviceName)}"]:::service`);
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
            return {
              name,
              records: nodeRecs,
              resolvedTo: resolved.chain.slice(1),
              areas: classifyAreas(name, nodeRecs, emailPathNames),
              terminal: resolved.terminal,
              ipv4: resolved.ipv4,
              ipv6: resolved.ipv6,
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

async function queryDnsGoogle(name: string, type: "CNAME" | "A" | "AAAA"): Promise<string[]> {
  const res = await fetch(
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
    { cache: "no-store" },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    Answer?: Array<{ data?: string; type?: number }>;
  };
  const out = (data.Answer ?? [])
    .map((x) => String(x.data ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(out.map((x) => normalizeDomain(x))));
}

async function resolveExternalCnameToAddress(
  startName: string,
  maxHops: number,
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
    while (hops < maxHops) {
      const cnames = await queryDnsGoogle(cur, "CNAME");
      const next = cnames.find(Boolean);
      if (!next || seen.has(next)) break;
      chain.push(next);
      seen.add(next);
      cur = next;
      hops += 1;
    }
    const [a, aaaa] = await Promise.all([
      queryDnsGoogle(cur, "A"),
      queryDnsGoogle(cur, "AAAA"),
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

export function ZoneTopologyTab({
  zoneName,
  records,
  isLoading = false,
  maxResolutionHops = 15,
  onRefresh,
  onEditRecord,
}: ZoneTopologyTabProps) {
  const { toast } = useToast();
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
  const [expandGraph, setExpandGraph] = useState(false);
  const [externalResolutionByName, setExternalResolutionByName] = useState<
    Record<string, ExternalDnsResolution>
  >({});
  const [isDarkThemeMode, setIsDarkThemeMode] = useState(() => detectDarkThemeMode());
  const [summary, setSummary] = useState<TopologySummary>({
    cnameChains: [],
    sharedIps: [],
    detectedServices: [],
    mxTrails: [],
    areas: { email: 0, web: 0, infra: 0, misc: 0 },
    nodeSummaries: [],
  });
  const closeExpandGraph = useCallback(() => {
    setExpandGraph(false);
    autoFitDoneRef.current = "";
    userAdjustedViewRef.current = false;
  }, []);
  const toggleExpandGraph = useCallback(() => {
    setExpandGraph((prev) => !prev);
    autoFitDoneRef.current = "";
    userAdjustedViewRef.current = false;
  }, []);

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
    const clampedMaxHops = Math.max(1, Math.min(15, Math.round(maxResolutionHops)));
    const { code, summary: nextSummary } = buildTopology(records, zoneName, clampedMaxHops, isDarkThemeMode);
    setMermaidCode(code);
    setSummary(nextSummary);
  }, [isDarkThemeMode, maxResolutionHops, records, zoneName]);

  useEffect(() => {
    const candidates = new Set<string>();
    for (const node of summary.nodeSummaries) {
      if (node.ipv4.length || node.ipv6.length) continue;
      const n = normalizeDomain(node.terminal || node.name);
      if (n) candidates.add(n);
    }
    for (const mx of summary.mxTrails) {
      if (mx.ipv4.length || mx.ipv6.length) continue;
      const n = normalizeDomain(mx.terminal || mx.target);
      if (n) candidates.add(n);
    }
    const missing = Array.from(candidates).filter((n) => !externalResolutionByName[n]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        missing.slice(0, 20).map(async (name) => {
          const resolved = await resolveExternalCnameToAddress(
            name,
            Math.max(1, Math.min(15, Math.round(maxResolutionHops))),
          );
          return [name, resolved] as const;
        }),
      );
      if (cancelled) return;
      setExternalResolutionByName((prev) => {
        const next = { ...prev };
        for (const [name, resolved] of entries) next[name] = resolved;
        return next;
      });
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [externalResolutionByName, maxResolutionHops, summary.mxTrails, summary.nodeSummaries]);

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
  }, [annotationDraft, annotationTool, pan.x, pan.y, zoom]);

  const exportCode = useCallback(() => {
    const blob = new Blob([mermaidCode], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${normalizeDomain(zoneName) || "zone"}-topology.mmd`;
    a.click();
    URL.revokeObjectURL(url);
  }, [mermaidCode, zoneName]);

  const copyCode = useCallback(async () => {
    await navigator.clipboard.writeText(mermaidCode);
    toast({ title: "Copied", description: "Topology Mermaid code copied to clipboard." });
  }, [mermaidCode, toast]);

  const exportSvg = useCallback(() => {
    if (!svgMarkup.trim()) return;
    const blob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${normalizeDomain(zoneName) || "zone"}-topology.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [svgMarkup, zoneName]);

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

  const controlsDisabled = isLoading || isRendering;
  const cursorClass = annotationTool ? "cursor-crosshair" : handTool ? "cursor-grab" : "cursor-default";
  const graphBackgroundClass = isDarkThemeMode
    ? "bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_55%),linear-gradient(to_bottom_right,rgba(255,255,255,0.04),rgba(0,0,0,0.15))]"
    : "bg-[radial-gradient(circle_at_top,rgba(15,23,42,0.09),transparent_55%),linear-gradient(to_bottom_right,rgba(255,255,255,0.95),rgba(226,232,240,0.75))]";
  const loadingOverlayClass = isDarkThemeMode ? "bg-black/35 backdrop-blur-md" : "bg-white/60 backdrop-blur-md";
  const panX = Math.round(pan.x);
  const panY = Math.round(pan.y);
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
        const external = externalResolutionByName[normalizeDomain(local.terminal || target)];
        const chain = local.chain.length > 1 ? local.chain : external?.chain ?? local.chain;
        const ipv4 = local.ipv4.length ? local.ipv4 : external?.ipv4 ?? [];
        const ipv6 = local.ipv6.length ? local.ipv6 : external?.ipv6 ?? [];
        const terminal = local.terminal || external?.terminal || target;
        const source = local.ipv4.length || local.ipv6.length ? "in-zone" : external ? "external" : "none";
        return {
          id: record.id,
          from,
          priority,
          target,
          chain,
          terminal,
          ipv4,
          ipv6,
          source,
        };
      });
  }, [externalResolutionByName, maxResolutionHops, records, zoneName]);

  const runDiscovery = useCallback(async () => {
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
      for (const host of Array.from(httpTargets).filter(Boolean).slice(0, 4)) {
        const httpsStatus = await probeHttp(`https://${host}`);
        items.push({ service: `HTTPS (${host})`, status: httpsStatus, details: httpsStatus === "up" ? "Probe reachable" : "Probe failed/blocked" });
        const httpStatus = await probeHttp(`http://${host}`);
        items.push({ service: `HTTP (${host})`, status: httpStatus, details: httpStatus === "up" ? "Probe reachable" : "Probe failed/blocked" });
      }
      setDiscovery(items);
      toast({ title: "Discovery complete", description: `Found ${items.length} service signal(s).` });
    } finally {
      setDiscovering(false);
    }
  }, [records, toast, zoneBase]);

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
      <Button size="sm" variant="outline" className="h-8 px-2" onClick={copyCode} disabled={!mermaidCode}>
        <Copy className="h-3.5 w-3.5 mr-1" />
        Copy code
      </Button>
      <Button size="sm" variant="outline" className="h-8 px-2" onClick={exportCode} disabled={!mermaidCode}>
        <Download className="h-3.5 w-3.5 mr-1" />
        Export code
      </Button>
      <Button size="sm" variant="outline" className="h-8 px-2" onClick={exportSvg} disabled={!svgMarkup}>
        <FileDown className="h-3.5 w-3.5 mr-1" />
        Export SVG
      </Button>
      <Button size="sm" variant="outline" className="h-8 px-2" onClick={printToPdf} disabled={!svgMarkup}>
        <FileDown className="h-3.5 w-3.5 mr-1" />
        Export PDF
      </Button>
      <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => void onRefresh()} disabled={isLoading}>
        <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
      </Button>
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
      <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => void runDiscovery()} disabled={discovering}>
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

                {(isRendering || isLoading) && (
                  <div className={cn("absolute inset-0 z-20 flex items-center justify-center", loadingOverlayClass)}>
                    <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-card/85 px-3 py-2 text-xs">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      Rendering topology...
                    </div>
                  </div>
                )}
              </div>
            </div>
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

          {(isRendering || isLoading) && (
            <div className={cn("absolute inset-0 z-20 flex items-center justify-center", loadingOverlayClass)}>
              <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-card/85 px-3 py-2 text-xs">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                Rendering topology...
              </div>
            </div>
          )}
          </div>
        </div>
        {fullscreenLightbox}
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
                <div key={`${mx.from}:${mx.target}`}>
                  {(() => {
                    const external = externalResolutionByName[normalizeDomain(mx.terminal || mx.target)];
                    const chain = mx.chain.length > 1 ? mx.chain : external?.chain ?? mx.chain;
                    const ipv4 = mx.ipv4.length ? mx.ipv4 : external?.ipv4 ?? [];
                    const ipv6 = mx.ipv6.length ? mx.ipv6 : external?.ipv6 ?? [];
                    return (
                      <>
                  MX trail {mx.from} {"->"} {mx.target}
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
                    if (!ipv4.length && !ipv6.length && chain.length <= 1) return null;
                    return (
                    <div className="text-muted-foreground">
                      Chain: {chain.join(" -> ")} | End node: {node.terminal || external?.terminal || node.name} | IPv4: {ipv4.join(", ") || "none"} | IPv6: {ipv6.join(", ") || "none"}
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
