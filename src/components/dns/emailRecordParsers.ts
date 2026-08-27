/**
 * Pure parsers for the e-mail related DNS records the topology graphs draw:
 * SPF, DKIM, DMARC, MTA-STS, TLS-RPT, BIMI, MX and SRV. No network access —
 * the SPF include walker only follows includes whose TXT records are already
 * present in the zone (`lookupTxt`) and stops at `SPF_INCLUDE_MAX_DEPTH`.
 */
import type { DNSRecord } from "@/types/dns";

export const SPF_INCLUDE_MAX_DEPTH = 2;

/** Highest number of SPF terms we model per record; the rest is dropped. */
export const SPF_TERM_LIMIT = 32;

function normalizeName(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
}

/**
 * Joins a multi-string TXT payload (`"part one" "part two"`) into one string.
 * Unquoted content is returned trimmed; escaped quotes inside strings are kept.
 */
export function joinTxtStrings(content: string): string {
  const raw = String(content ?? "").trim();
  if (!raw.startsWith('"')) return raw;
  const parts: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    parts.push(match[1].replace(/\\(["\\])/g, "$1"));
  }
  return parts.length > 0 ? parts.join("") : raw.replace(/^"|"$/g, "");
}

function parseTagList(content: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const chunk of joinTxtStrings(content).split(";")) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (!tags.has(key)) tags.set(key, value);
  }
  return tags;
}

function parseMailtoList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const address = trimmed
      .replace(/^mailto:/i, "")
      .replace(/!.*$/, "")
      .trim()
      .toLowerCase();
    if (address && !out.includes(address)) out.push(address);
  }
  return out;
}

// ── SPF ─────────────────────────────────────────────────────────────────────

export type SpfQualifier = "+" | "-" | "~" | "?";
export type SpfMechanismType =
  | "all"
  | "include"
  | "a"
  | "mx"
  | "ptr"
  | "ip4"
  | "ip6"
  | "exists";

export type SpfMechanism = {
  qualifier: SpfQualifier;
  type: SpfMechanismType;
  /** Domain, IP/CIDR or empty (for bare `a`/`mx`/`all`). */
  value: string;
};

export type SpfRecord = {
  valid: boolean;
  mechanisms: SpfMechanism[];
  redirect: string | null;
  explanation: string | null;
  /** Qualifier of the trailing `all` term, if any. */
  allQualifier: SpfQualifier | null;
  /** Number of terms that trigger a DNS lookup (include/a/mx/ptr/exists/redirect). */
  lookupTerms: number;
};

const SPF_MECHANISMS = new Set<SpfMechanismType>([
  "all",
  "include",
  "a",
  "mx",
  "ptr",
  "ip4",
  "ip6",
  "exists",
]);

export function isSpfRecord(content: string): boolean {
  return /^v=spf1(\s|$)/i.test(joinTxtStrings(content));
}

export function parseSpf(content: string): SpfRecord {
  const text = joinTxtStrings(content);
  const result: SpfRecord = {
    valid: false,
    mechanisms: [],
    redirect: null,
    explanation: null,
    allQualifier: null,
    lookupTerms: 0,
  };
  if (!/^v=spf1(\s|$)/i.test(text)) return result;
  result.valid = true;
  const terms = text.split(/\s+/).slice(1).slice(0, SPF_TERM_LIMIT);
  for (const term of terms) {
    if (!term) continue;
    const modifier = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(term);
    if (modifier) {
      const key = modifier[1].toLowerCase();
      const value = normalizeName(modifier[2]);
      if (key === "redirect" && value) {
        result.redirect = value;
        result.lookupTerms += 1;
      } else if (key === "exp" && value) {
        result.explanation = value;
      }
      continue;
    }
    let qualifier: SpfQualifier = "+";
    let body = term;
    if (/^[+\-~?]/.test(body)) {
      qualifier = body[0] as SpfQualifier;
      body = body.slice(1);
    }
    const colon = body.indexOf(":");
    const slash = body.indexOf("/");
    const splitAt = colon >= 0 && (slash < 0 || colon < slash) ? colon : -1;
    const rawType = (splitAt >= 0 ? body.slice(0, splitAt) : body)
      .toLowerCase()
      .replace(/\/.*$/, "");
    if (!SPF_MECHANISMS.has(rawType as SpfMechanismType)) continue;
    const type = rawType as SpfMechanismType;
    let value = splitAt >= 0 ? body.slice(splitAt + 1) : "";
    if (type === "ip4" || type === "ip6") {
      value = value.trim();
    } else if (type === "a" || type === "mx") {
      // Keep an explicit domain, drop a bare CIDR (`a/24`).
      value = splitAt >= 0 ? normalizeName(value.replace(/\/.*$/, "")) : "";
    } else {
      value = normalizeName(value);
    }
    if (type === "all") {
      result.allQualifier = qualifier;
    } else if (type !== "ip4" && type !== "ip6") {
      result.lookupTerms += 1;
    }
    result.mechanisms.push({ qualifier, type, value });
  }
  return result;
}

export function describeSpfAll(qualifier: SpfQualifier | null): string {
  switch (qualifier) {
    case "-":
      return "-all (hard fail)";
    case "~":
      return "~all (soft fail)";
    case "?":
      return "?all (neutral)";
    case "+":
      return "+all (pass all)";
    default:
      return "no all";
  }
}

export type SpfTreeNode = {
  /** Name whose SPF record this node describes. */
  name: string;
  record: SpfRecord;
  depth: number;
  /** How this node was reached from its parent. */
  via: "root" | "include" | "redirect";
  /** Nested SPF nodes for includes/redirects that resolve inside the zone. */
  children: SpfTreeNode[];
};

/**
 * Walks `include:` / `redirect=` terms of an SPF record, following only names
 * for which `lookupTxt` returns an SPF TXT (i.e. records already loaded in the
 * zone). Depth is bounded by `maxDepth`; cycles are broken by a visited set.
 */
export function collectSpfTree(
  name: string,
  lookupTxt: (name: string) => string | null | undefined,
  maxDepth: number = SPF_INCLUDE_MAX_DEPTH,
): SpfTreeNode | null {
  const visited = new Set<string>();
  const walk = (
    target: string,
    depth: number,
    via: SpfTreeNode["via"],
  ): SpfTreeNode | null => {
    const key = normalizeName(target);
    if (!key || visited.has(key)) return null;
    const txt = lookupTxt(key);
    if (!txt || !isSpfRecord(txt)) return null;
    visited.add(key);
    const record = parseSpf(txt);
    const node: SpfTreeNode = { name: key, record, depth, via, children: [] };
    if (depth >= maxDepth) return node;
    for (const mechanism of record.mechanisms) {
      if (mechanism.type !== "include" || !mechanism.value) continue;
      const child = walk(mechanism.value, depth + 1, "include");
      if (child) node.children.push(child);
    }
    if (record.redirect) {
      const child = walk(record.redirect, depth + 1, "redirect");
      if (child) node.children.push(child);
    }
    return node;
  };
  return walk(name, 0, "root");
}

// ── DKIM ────────────────────────────────────────────────────────────────────

export type DkimRecord = {
  valid: boolean;
  keyType: string;
  /** `p=` is present and non-empty. */
  hasPublicKey: boolean;
  /** `p=` is present but empty: the key is revoked. */
  revoked: boolean;
  testing: boolean;
  hashAlgorithms: string[];
  serviceTypes: string[];
};

export function parseDkim(content: string): DkimRecord {
  const tags = parseTagList(content);
  const hasKeyTag = tags.has("p");
  const publicKey = (tags.get("p") ?? "").replace(/\s+/g, "");
  const version = (tags.get("v") ?? "").toUpperCase();
  const flags = (tags.get("t") ?? "")
    .split(":")
    .map((flag) => flag.trim().toLowerCase())
    .filter(Boolean);
  return {
    valid: version === "DKIM1" || hasKeyTag,
    keyType: (tags.get("k") ?? "rsa").toLowerCase(),
    hasPublicKey: publicKey.length > 0,
    revoked: hasKeyTag && publicKey.length === 0,
    testing: flags.includes("y"),
    hashAlgorithms: (tags.get("h") ?? "")
      .split(":")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    serviceTypes: (tags.get("s") ?? "")
      .split(":")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  };
}

/** `selector._domainkey.example.com` → `selector`; null when not a DKIM name. */
export function dkimSelectorFromName(name: string): string | null {
  const match = /^(.+?)\._domainkey(?:\.|$)/i.exec(normalizeName(name));
  return match ? match[1] : null;
}

// ── DMARC ───────────────────────────────────────────────────────────────────

export type DmarcPolicy = "none" | "quarantine" | "reject";

export type DmarcRecord = {
  valid: boolean;
  policy: DmarcPolicy | null;
  subdomainPolicy: DmarcPolicy | null;
  percent: number;
  rua: string[];
  ruf: string[];
  adkim: "r" | "s";
  aspf: "r" | "s";
  failureOptions: string | null;
};

function parseDmarcPolicy(value: string | undefined): DmarcPolicy | null {
  const lowered = (value ?? "").trim().toLowerCase();
  return lowered === "none" || lowered === "quarantine" || lowered === "reject"
    ? lowered
    : null;
}

export function parseDmarc(content: string): DmarcRecord {
  const tags = parseTagList(content);
  const version = (tags.get("v") ?? "").toUpperCase();
  const pctRaw = Number(tags.get("pct") ?? "100");
  const alignment = (value: string | undefined): "r" | "s" =>
    (value ?? "r").trim().toLowerCase() === "s" ? "s" : "r";
  return {
    valid: version === "DMARC1",
    policy: parseDmarcPolicy(tags.get("p")),
    subdomainPolicy: parseDmarcPolicy(tags.get("sp")),
    percent:
      Number.isFinite(pctRaw) && pctRaw >= 0 && pctRaw <= 100 ? pctRaw : 100,
    rua: parseMailtoList(tags.get("rua")),
    ruf: parseMailtoList(tags.get("ruf")),
    adkim: alignment(tags.get("adkim")),
    aspf: alignment(tags.get("aspf")),
    failureOptions: tags.get("fo") ?? null,
  };
}

// ── MTA-STS / TLS-RPT / BIMI ────────────────────────────────────────────────

export type MtaStsRecord = { valid: boolean; id: string | null };

export function parseMtaSts(content: string): MtaStsRecord {
  const tags = parseTagList(content);
  return {
    valid: (tags.get("v") ?? "").toUpperCase() === "STSV1",
    id: tags.get("id") ?? null,
  };
}

export type TlsRptRecord = { valid: boolean; rua: string[]; ruaUrls: string[] };

export function parseTlsRpt(content: string): TlsRptRecord {
  const tags = parseTagList(content);
  const targets = (tags.get("rua") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return {
    valid: (tags.get("v") ?? "").toUpperCase() === "TLSRPTV1",
    rua: parseMailtoList(targets.filter((v) => /^mailto:/i.test(v)).join(",")),
    ruaUrls: targets.filter((v) => /^https?:/i.test(v)),
  };
}

export type BimiRecord = {
  valid: boolean;
  logoUrl: string | null;
  authorityUrl: string | null;
};

export function parseBimi(content: string): BimiRecord {
  const tags = parseTagList(content);
  const logo = (tags.get("l") ?? "").trim();
  const authority = (tags.get("a") ?? "").trim();
  return {
    valid: (tags.get("v") ?? "").toUpperCase() === "BIMI1",
    logoUrl: logo || null,
    authorityUrl: authority || null,
  };
}

// ── MX / SRV ────────────────────────────────────────────────────────────────

export type MxTarget = { priority: number | null; target: string };

/**
 * Accepts both Cloudflare's API shape (`priority` field + bare host content)
 * and the zone-file shape (`"10 mail.example.com"`).
 */
export function parseMxRecord(
  record: Pick<DNSRecord, "content" | "priority">,
): MxTarget | null {
  const parts = String(record.content ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return null;
  const leading = Number(parts[0]);
  if (parts.length >= 2 && Number.isFinite(leading)) {
    const target = normalizeName(parts.slice(1).join(" "));
    return target ? { priority: leading, target } : null;
  }
  const target = normalizeName(parts.join(" "));
  if (!target || /^\d+$/.test(target)) return null;
  const priority =
    typeof record.priority === "number" && Number.isFinite(record.priority)
      ? record.priority
      : null;
  return { priority, target };
}

export type SrvTarget = {
  priority: number | null;
  weight: number | null;
  port: number | null;
  target: string;
};

export function parseSrvRecord(
  record: Pick<DNSRecord, "content" | "priority">,
): SrvTarget | null {
  const parts = String(record.content ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const asNumber = (value: string | undefined) => {
    const n = Number(value);
    return value !== undefined && Number.isFinite(n) ? n : null;
  };
  if (parts.length >= 4) {
    const target = normalizeName(parts.slice(3).join(" "));
    if (!target) return null;
    return {
      priority: asNumber(parts[0]),
      weight: asNumber(parts[1]),
      port: asNumber(parts[2]),
      target,
    };
  }
  if (parts.length === 3) {
    // Cloudflare API shape: priority lives in its own field.
    const target = normalizeName(parts[2]);
    if (!target) return null;
    return {
      priority: typeof record.priority === "number" ? record.priority : null,
      weight: asNumber(parts[0]),
      port: asNumber(parts[1]),
      target,
    };
  }
  return null;
}

// ── Name classification ─────────────────────────────────────────────────────

export type EmailNameKind =
  | "dmarc"
  | "dkim"
  | "mta-sts"
  | "mta-sts-host"
  | "tls-rpt"
  | "bimi"
  | "client-srv"
  | "client-host";

/** SRV service labels that describe mail-client autodiscovery. */
export const EMAIL_CLIENT_SRV_SERVICES = [
  "_imaps",
  "_imap",
  "_pop3s",
  "_pop3",
  "_submission",
  "_submissions",
  "_smtps",
  "_autodiscover",
  "_sieve",
] as const;

export function classifyEmailName(name: string): EmailNameKind | null {
  const lower = normalizeName(name);
  if (!lower) return null;
  const first = lower.split(".")[0] ?? "";
  if (first === "_dmarc") return "dmarc";
  if (/\._domainkey(\.|$)/.test(lower)) return "dkim";
  if (first === "_mta-sts") return "mta-sts";
  if (first === "mta-sts") return "mta-sts-host";
  if (lower.startsWith("_smtp._tls.") || lower === "_smtp._tls")
    return "tls-rpt";
  if (/(^|\.)_bimi(\.|$)/.test(lower)) return "bimi";
  if (
    (EMAIL_CLIENT_SRV_SERVICES as readonly string[]).includes(first) &&
    /^_(tcp|udp|tls)$/.test(lower.split(".")[1] ?? "")
  ) {
    return "client-srv";
  }
  if (first === "autoconfig" || first === "autodiscover") return "client-host";
  return null;
}

export function isEmailOnlyName(name: string): boolean {
  return classifyEmailName(name) !== null;
}
