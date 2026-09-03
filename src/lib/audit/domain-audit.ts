import type { DNSRecord } from "@/types/dns";
import { unquoteCharacterString } from "@/lib/dns/character-string";
import { ipMatchesCIDR, isSpfRecord, parseSPF } from "@/lib/dns/spf";
import { parseSRV } from "@/lib/dns/dns-parsers";

export type DomainAuditSeverity = "pass" | "info" | "warn" | "fail";
export type DomainAuditCategory = "email" | "security" | "hygiene";

export type DomainAuditItem = {
  id: string;
  category: DomainAuditCategory;
  severity: DomainAuditSeverity;
  title: string;
  details: string;
  suggestion?: {
    recordType: DNSRecord["type"];
    name: string;
    content: string;
  };
};

export type DomainAuditOptions = {
  includeCategories: Record<DomainAuditCategory, boolean>;
  domainExpiresAt?: string | null;
};

/**
 * What each flagged record actually does, and what follows from its absence or
 * misconfiguration — appended to the finding's `details`.
 *
 * Written for a domain owner who knows DNS but not email authentication. The
 * register is deliberately flat: state the consequence and let the severity the
 * audit already assigns carry the weight. A missing SPF record does not mean
 * mail *will* be spoofed, it means nothing prevents it and receivers have less
 * to go on — overstating that in a tool the user is trusting to describe their
 * own zone is worse than saying nothing.
 *
 * Keyed by finding id and applied only to non-`pass` findings, so an id whose
 * `pass` variant reuses the same key (`caa-analysis`, `dkim-missing`,
 * `cname-conflicts`, `spf-type-deprecated`, …) stays silent when it passes.
 *
 * `special-a` / `special-aaaa` are deliberately absent: they report a record
 * that exists with a bad address rather than an absence, and the UI renders
 * `SpecialIpAuditFindings` in place of `details` for them, so text added here
 * would never be shown.
 *
 * **This table is the source of truth and is mirrored verbatim into
 * `bc-domain-audit`'s `FINDING_EXPLANATIONS`.** The two must not drift:
 * `test/domain-audit-explanations.test.ts` reads the Rust source and fails if
 * either side gains, loses or reworks an entry the other does not.
 */
export const FINDING_EXPLANATIONS: Readonly<Record<string, string>> = {
  // ── Email: SPF ────────────────────────────────────────────────────────────
  "spf-missing":
    "An SPF record lists the servers allowed to send mail using your domain. " +
    "Without one, receiving servers have nothing to check a sender against, so mail claiming to come from your domain is harder for them to tell apart from mail that genuinely does, and your own mail has one less signal working in its favour.",
  "spf-multiple":
    "A domain may publish only one SPF record. When receivers find more than one they are required to treat the result as a permanent error, so none of your SPF rules apply at all — the effect is the same as publishing no SPF record.",
  "spf-all-missing":
    "The all mechanism at the end of an SPF record says what receivers should do about servers the record did not list. Without it they treat unlisted senders as neutral, so the record documents your own senders without asking receivers to act on anyone else.",
  "spf-too-permissive":
    "+all tells receivers that any server on the internet is authorised to send as your domain. That is broader than publishing no SPF record at all, because it actively vouches for senders you do not control.",
  "spf-neutral":
    "?all asks receivers to treat unlisted senders as neither authorised nor unauthorised, which is the answer they would reach with no SPF record at all. Listed servers still pass; nothing is asked about anyone else.",
  "spf-softfail":
    "~all asks receivers to accept mail from unlisted servers but mark it as suspect. It is the usual setting while you are still learning which of your senders would fail. -all asks receivers to reject them outright, once you are confident the list is complete.",
  "spf-ptr":
    "The ptr mechanism asks receivers to look up the sending server's address in reverse and check the name it returns. RFC 7208 discourages it: the lookups are slow, the answers are controlled by whoever owns the address block, and some receivers skip the mechanism entirely.",
  "spf-lookups-estimate":
    "Each include, a, mx, ptr, exists and redirect term makes receivers perform another DNS lookup, and SPF allows ten in total. Past that limit receivers stop evaluating and return a permanent error, at which point the record authorises nothing — including the senders listed before the limit was reached.",
  "spf-type-deprecated":
    "The dedicated SPF record type was retired by RFC 7208 in 2014. Receivers look for SPF policies in TXT records and most never query the SPF type at all, so a policy published only under this type is effectively invisible.",

  // ── Email: DMARC ──────────────────────────────────────────────────────────
  "dmarc-missing":
    "A DMARC record tells receiving servers what to do with mail that fails your SPF and DKIM checks, and asks them to send you reports on who is sending as your domain. Without one, receivers decide for themselves and most will still deliver the mail, and you get no reports, so you cannot see whether anyone is sending as you.",
  "dmarc-multiple":
    "A domain may publish only one DMARC record. Receivers that find several ignore the policy entirely, so the effect is the same as publishing none.",
  "dmarc-missing-policy":
    "The p= tag is what tells receivers how to treat mail that fails your checks. A DMARC record without it is incomplete, and receivers ignore the record — including any reporting addresses set alongside it.",
  "dmarc-policy-none":
    "p=none asks receivers to change nothing: mail that fails your checks is delivered exactly as it would be with no DMARC record at all. It is a reasonable place to start while you confirm your own senders pass, but on its own it does not stop anyone sending as your domain.",
  "dmarc-no-rua":
    "An rua= address is where receivers send the daily summaries naming every server that sent mail as your domain and whether it passed. Without one nothing is sent anywhere, so there is no way to find out which of your senders would fail — or, once receivers are enforcing, which of your legitimate mail is being quarantined or thrown away.",

  // ── Email: DKIM ───────────────────────────────────────────────────────────
  "dkim-missing":
    "DKIM adds a signature to outgoing mail that receivers verify against a public key published in your DNS, showing the message really came from your mail system and was not altered on the way. Without it your mail rests on SPF alone, which breaks when a message is forwarded. Selectors are chosen by the mail provider, so this may instead mean yours publishes them somewhere this zone cannot see.",

  // ── Email: MX ─────────────────────────────────────────────────────────────
  "mx-single":
    "MX records name the servers that accept mail for your domain, in priority order. With only one, delivery depends entirely on that host being reachable; senders retry for a while, so mail queues rather than arriving. Many providers cover this behind a single name that resolves to several hosts.",
  "mx-too-many":
    "MX records name the servers that accept mail for your domain. An unusually long list often means old entries were never removed, and a retired host still listed collects delivery attempts until senders give up on it.",
  "mx-cname-target":
    "An MX record must point at a hostname that has its own A or AAAA record. Pointing it at an alias is not permitted by the DNS specification, and some receiving servers decline to deliver rather than follow it.",
  "mx-duplicate-priority":
    "The priority number decides which mail server senders try first, and equal numbers leave them free to choose between those hosts. That is how round-robin delivery is set up deliberately; if it was not intended, mail will not favour the server you expect.",
  "mx-no-resolution":
    "Senders reach a mail server by resolving its hostname to an address. These targets have no A or AAAA record in this zone, which is fine if they resolve elsewhere, but if nothing answers for them anywhere then mail has nowhere to go.",

  // ── Security: CAA ─────────────────────────────────────────────────────────
  "caa-analysis":
    "CAA records name the certificate authorities allowed to issue certificates for your domain. Where no CAA record applies, any public authority may issue for the name, subject only to its own validation checks. CAA does not affect certificates that have already been issued.",

  // ── Hygiene: delegation and zone structure ────────────────────────────────
  "ns-missing":
    "NS records delegate the zone to the name servers that answer for it. Cloudflare serves these itself and does not always list them among the editable records, so their absence here usually reflects that rather than a delegation problem — what actually decides delegation is the set of name servers recorded at your registrar.",
  "ns-single":
    "NS records tell the rest of the internet which servers answer for your domain. With one listed, every lookup depends on that server; if it stops answering, the domain stops resolving altogether rather than slowing down. Two or more give resolvers somewhere to fall back to.",
  "soa-missing":
    "The SOA record carries the zone's administrative parameters: the primary name server, the contact address, and the timers other servers use when refreshing or caching it. Cloudflare generates and serves this automatically, so it is normal for it not to appear among the editable records.",
  "soa-multiple":
    "A zone has exactly one SOA record by definition. More than one means resolvers may read different administrative parameters depending on which they get, and some will treat the zone as malformed.",
  "soa-review":
    "The SOA timers govern how long other servers wait before refreshing the zone, how long they keep serving it when the primary is unreachable, and how long a negative answer stays cached. Values well outside the usual ranges mainly affect how quickly your changes propagate and how long a stale copy survives an outage.",
  "apex-single-ip":
    "The A records at the apex are what the bare domain resolves to. With a single address, reachability rests entirely on that host and resolvers have nothing to fall back to if it stops answering. One address is normal when a proxy or load balancer sits in front of it.",
  "apex-single-ipv6":
    "The AAAA records at the apex are what the bare domain resolves to over IPv6. With a single address, IPv6 reachability rests entirely on that host. One address is normal when a proxy or load balancer sits in front of it.",

  // ── Hygiene: TTL ──────────────────────────────────────────────────────────
  "ttl-critical":
    "The TTL is how long resolvers may cache an answer before asking again. Under 30 seconds they ask constantly, which puts steady load on the authoritative servers and leaves almost no cached copy to serve if those servers briefly stop answering. Very short TTLs earn their keep in the hours around a planned change, less so as a standing setting.",
  "ttl-hygiene":
    "The TTL is how long resolvers may cache an answer before asking again. Longer values mean fewer lookups and a zone that rides out brief outages; shorter ones make changes take effect sooner. The values listed here are only unusual relative to the rest of this zone, which is often deliberate.",

  // ── Hygiene: CNAME ────────────────────────────────────────────────────────
  "cname-conflicts":
    "A CNAME makes a name an alias for another name, and RFC 1034 requires that no other data exist at that name. Where it does, servers and resolvers disagree about which answer to return, so what a client gets back depends on which server it happens to ask.",
  "cname-at-apex":
    "A CNAME at the apex is not permitted by the DNS specification, because the apex has to carry SOA and NS records too. Cloudflare works around this by answering with the target's addresses directly, so it behaves correctly here; the constraint returns if the zone moves to a provider that does not do the same.",
  "cname-chains-fail":
    "Each CNAME in a chain costs a resolver another lookup before it reaches an address, and a cycle never reaches one at all. Resolvers abandon chains they judge too long, so the name fails to resolve rather than resolving slowly.",
  "cname-chains-warn":
    "Each CNAME hop is another lookup a resolver makes before it reaches an address. That adds delay to every request that is not already cached, and one more link that can break the chain.",

  // ── Hygiene: TXT and SRV ──────────────────────────────────────────────────
  "txt-sprawl":
    "All TXT records at a name are returned together, and each service picks out the one it recognises by its prefix. Several at one name is not an error in itself, but it makes it easy to leave behind verification strings for services you no longer use.",
  "srv-review":
    "An SRV record tells clients which host and port serve a particular service, along with the priority and weight used to choose between several. Where the fields are malformed, clients that cannot read the record fall back to whatever default they have, or do not find the service at all.",

  // ── Hygiene: registration ─────────────────────────────────────────────────
  "domain-expiry":
    "Domain registration is separate from the DNS hosting configured here. If the registration lapses, the registry stops delegating the domain and it stops resolving regardless of the records in this zone. Registrars differ in how long they hold an expired name before it is released.",
};

/**
 * Append the explanation for a finding, if one applies.
 *
 * Only non-`pass` findings are explained: a passing check has nothing whose
 * absence needs describing.
 */
function explainFinding(item: DomainAuditItem): DomainAuditItem {
  if (item.severity === "pass") return item;
  const explanation = FINDING_EXPLANATIONS[item.id];
  if (!explanation) return item;
  return { ...item, details: `${item.details}\n\n${explanation}` };
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function normalizeName(name: string, zoneName: string): string {
  const trimmed = String(name ?? "")
    .trim()
    .toLowerCase();
  if (!trimmed) return "";
  if (trimmed === "@") return zoneName.trim().toLowerCase();
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

function zoneApex(zoneName: string): string {
  return normalizeName(zoneName, zoneName);
}

function recordNameIsApex(recordName: string, zoneName: string): boolean {
  return normalizeName(recordName, zoneName) === zoneApex(zoneName);
}

function normalizeTargetDomain(value: string, zoneName: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const stripped = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  return normalizeName(stripped, zoneName);
}

/**
 * The logical value of a TXT record, with presentation quoting removed.
 *
 * Cloudflare and zone-file imports hand back the same record as `v=spf1 -all`,
 * `"v=spf1 -all"` or `"v=spf1 " "-all"` depending on the path it came in
 * through. Every content check below runs on this, so the audit never reports
 * a record missing purely because of how it was written down.
 */
function txtValue(content: string | undefined): string {
  return unquoteCharacterString(content).trim();
}

function getTxtContentsByName(
  records: DNSRecord[],
  name: string,
  zoneName: string,
): string[] {
  const needle = normalizeName(name, zoneName);
  return records
    .filter((r) => r.type === "TXT")
    .filter((r) => normalizeName(r.name, zoneName) === needle)
    .map((r) => txtValue(r.content))
    .filter(Boolean);
}

function parseTagRecord(txt: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of txt.split(";")) {
    const raw = part.trim();
    if (!raw) continue;
    const idx = raw.indexOf("=");
    if (idx === -1) continue;
    const k = raw.slice(0, idx).trim().toLowerCase();
    const v = raw.slice(idx + 1).trim();
    if (!k) continue;
    tags[k] = v;
  }
  return tags;
}

function getTtlSeconds(ttl: DNSRecord["ttl"] | undefined): number | null {
  if (ttl === undefined || ttl === null) return null;
  if (ttl === "auto") return null;
  const n = Number(ttl);
  if (!Number.isFinite(n)) return null;
  return n;
}

function isIPv4(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

const IPV4_SPECIAL_RANGES: Array<{ cidr: string; label: string }> = [
  { cidr: "0.0.0.0/8", label: "This network (0.0.0.0/8)" },
  { cidr: "10.0.0.0/8", label: "RFC1918 private (10.0.0.0/8)" },
  { cidr: "100.64.0.0/10", label: "CGNAT (100.64.0.0/10)" },
  { cidr: "127.0.0.0/8", label: "Loopback (127.0.0.0/8)" },
  { cidr: "169.254.0.0/16", label: "Link-local (169.254.0.0/16)" },
  { cidr: "172.16.0.0/12", label: "RFC1918 private (172.16.0.0/12)" },
  { cidr: "192.0.0.0/24", label: "IETF protocol assignments (192.0.0.0/24)" },
  { cidr: "192.0.2.0/24", label: "Documentation (192.0.2.0/24)" },
  { cidr: "192.88.99.0/24", label: "6to4 relay anycast (192.88.99.0/24)" },
  { cidr: "192.168.0.0/16", label: "RFC1918 private (192.168.0.0/16)" },
  { cidr: "198.18.0.0/15", label: "Benchmarking (198.18.0.0/15)" },
  { cidr: "198.51.100.0/24", label: "Documentation (198.51.100.0/24)" },
  { cidr: "203.0.113.0/24", label: "Documentation (203.0.113.0/24)" },
  { cidr: "224.0.0.0/4", label: "Multicast (224.0.0.0/4)" },
  { cidr: "233.252.0.0/24", label: "Multicast test net (233.252.0.0/24)" },
  { cidr: "240.0.0.0/4", label: "Reserved (240.0.0.0/4)" },
  { cidr: "255.255.255.255/32", label: "Limited broadcast (255.255.255.255)" },
];

const IPV6_SPECIAL_RANGES: Array<{ cidr: string; label: string }> = [
  { cidr: "::/128", label: "Unspecified (::)" },
  { cidr: "::1/128", label: "Loopback (::1)" },
  { cidr: "fc00::/7", label: "ULA private (fc00::/7)" },
  { cidr: "fe80::/10", label: "Link-local (fe80::/10)" },
  { cidr: "ff00::/8", label: "Multicast (ff00::/8)" },
  { cidr: "2001:db8::/32", label: "Documentation (2001:db8::/32)" },
  { cidr: "2002::/16", label: "6to4 (2002::/16, deprecated)" },
  { cidr: "2001:10::/28", label: "ORCHID (2001:10::/28, deprecated)" },
];

function classifySpecialIp(ip: string): string | null {
  const s = String(ip ?? "").trim();
  if (!s) return null;
  if (isIPv4(s)) {
    for (const r of IPV4_SPECIAL_RANGES) {
      if (ipMatchesCIDR(s, r.cidr)) return r.label;
    }
    return null;
  }
  for (const r of IPV6_SPECIAL_RANGES) {
    if (ipMatchesCIDR(s, r.cidr)) return r.label;
  }
  return null;
}

/** An A/AAAA record whose address falls in a special-use/bogon range. */
export type SpecialIpFinding = {
  record: DNSRecord;
  ip: string;
  issue: string;
};

/**
 * The A or AAAA records whose address is private, reserved or otherwise
 * special-use, so the UI can point at the exact record rather than a label.
 */
export function findSpecialIpRecords(
  records: DNSRecord[],
  type: "A" | "AAAA",
): SpecialIpFinding[] {
  const findings: SpecialIpFinding[] = [];
  for (const record of records) {
    if (record.type !== type) continue;
    const ip = String(record.content ?? "").trim();
    const issue = classifySpecialIp(ip);
    if (issue) findings.push({ record, ip, issue });
  }
  return findings;
}

function isDmarcRecord(txt: string): boolean {
  return txt.trim().toLowerCase().startsWith("v=dmarc1");
}

function isDkimRecord(txt: string): boolean {
  return txt.trim().toLowerCase().includes("v=dkim1");
}

function getSpfAllQualifier(spf: string): string | null {
  const s = spf.toLowerCase();
  const m = s.match(/\s([~\-+?])all(\s|$)/);
  return m ? m[1] : null;
}

function estimateSpfLookupCount(spf: string): number | null {
  const parsed = parseSPF(spf);
  if (!parsed) return null;
  let lookups = 0;
  for (const mech of parsed.mechanisms) {
    if (["include", "a", "mx", "ptr", "exists"].includes(mech.mechanism)) {
      lookups += 1;
    }
  }
  for (const mod of parsed.modifiers ?? []) {
    if (mod.key === "redirect") lookups += 1;
  }
  return lookups;
}

function buildCnameMap(
  zoneName: string,
  records: DNSRecord[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of records) {
    if (r.type !== "CNAME") continue;
    const from = normalizeName(r.name, zoneName);
    const to = normalizeTargetDomain(r.content, zoneName);
    if (!from || !to) continue;
    map.set(from, to);
  }
  return map;
}

function computeCnameChain(
  start: string,
  cnameMap: Map<string, string>,
  maxHops: number,
): { hops: number; cyclic: boolean; chain: string[] } {
  const seen = new Set<string>([start]);
  const chain: string[] = [start];
  let current = start;
  let hops = 0;
  while (hops < maxHops) {
    const next = cnameMap.get(current);
    if (!next) break;
    hops += 1;
    chain.push(next);
    if (seen.has(next)) return { hops, cyclic: true, chain };
    seen.add(next);
    current = next;
  }
  return { hops, cyclic: false, chain };
}

function parseCaa(content: string): {
  flag?: number;
  tag?: string;
  value?: string;
} {
  const parts = String(content ?? "")
    .trim()
    .split(/\s+/);
  if (parts.length < 3) return {};
  const flag = Number(parts[0]);
  const tag = parts[1]?.toLowerCase();
  const rest = parts.slice(2).join(" ").trim();
  const value = rest.replace(/^"(.*)"$/, "$1");
  return { flag: Number.isFinite(flag) ? flag : undefined, tag, value };
}

function parseMx(
  record: DNSRecord,
  zoneName: string,
): { priority?: number; target?: string } {
  // Cloudflare returns MX priority in record.priority and the target hostname
  // in record.content. Some providers put "priority target" in content, so
  // handle both formats.
  const raw = String(record.content ?? "").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  let priority: number | undefined = record.priority;
  let targetRaw: string;

  if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
    // "10 mail.example.com" format
    priority = priority ?? Number(parts[0]);
    targetRaw = parts.slice(1).join(" ");
  } else {
    // plain hostname format
    targetRaw = raw;
  }

  const target = normalizeTargetDomain(targetRaw, zoneName);
  return {
    priority: Number.isFinite(priority!) ? priority : undefined,
    target: target || undefined,
  };
}

export function runDomainAudit(
  zoneName: string,
  records: DNSRecord[],
  options: DomainAuditOptions = {
    includeCategories: { email: true, security: true, hygiene: true },
    domainExpiresAt: null,
  },
): DomainAuditItem[] {
  const apex = zoneApex(zoneName);
  const normalizedZone = apex;
  const items: DomainAuditItem[] = [];

  const mx = records.filter((r) => r.type === "MX");
  const mxAtApex = mx.filter((r) => recordNameIsApex(r.name, normalizedZone));

  const spfTxtAtApex = records
    .filter((r) => r.type === "TXT")
    .filter((r) => recordNameIsApex(r.name, normalizedZone))
    .map((r) => txtValue(r.content))
    .filter(Boolean)
    .filter(isSpfRecord);

  const spfTypeRecords = records.filter((r) => r.type === "SPF");

  const dmarcName = `_dmarc.${normalizedZone}`;
  const dmarcTxt = getTxtContentsByName(
    records,
    dmarcName,
    normalizedZone,
  ).filter(isDmarcRecord);

  const hasAnyDkim = records
    .filter((r) => r.type === "TXT")
    .some((r) => {
      const name = normalizeName(r.name, normalizedZone);
      return name.includes("._domainkey.") && isDkimRecord(txtValue(r.content));
    });

  const soaRecords = records.filter((r) => r.type === "SOA");
  const srvRecords = records.filter((r) => r.type === "SRV");
  const cnameRecords = records.filter((r) => r.type === "CNAME");
  const cnameMap = buildCnameMap(normalizedZone, records);

  const aByName = new Map<string, number>();
  const aaaaByName = new Map<string, number>();
  for (const r of records) {
    const n = normalizeName(r.name, normalizedZone);
    if (!n) continue;
    if (r.type === "A") aByName.set(n, (aByName.get(n) ?? 0) + 1);
    if (r.type === "AAAA") aaaaByName.set(n, (aaaaByName.get(n) ?? 0) + 1);
  }

  const byName = new Map<string, DNSRecord[]>();
  for (const r of records) {
    const n = normalizeName(r.name, normalizedZone);
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n)!.push(r);
  }

  if (options.includeCategories.hygiene) {
    const expiryDate = parseDate(options.domainExpiresAt);
    if (!expiryDate) {
      items.push({
        id: "domain-expiry",
        category: "hygiene",
        severity: "info",
        title: "Domain expiry check",
        details:
          "Domain expiry date is unavailable. Run a registry lookup to evaluate expiry risk.",
      });
    } else {
      const now = new Date();
      const daysUntilExpiry = Math.ceil(
        (expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
      );
      const fullExpiry = expiryDate.toLocaleString();
      if (daysUntilExpiry < 0) {
        items.push({
          id: "domain-expiry",
          category: "hygiene",
          severity: "fail",
          title: "Domain appears expired",
          details: `Expiry date: ${fullExpiry} (${daysUntilExpiry} days). Renew immediately.`,
        });
      } else if (daysUntilExpiry < 15) {
        items.push({
          id: "domain-expiry",
          category: "hygiene",
          severity: "fail",
          title: "Domain expiry critical (<15 days)",
          details: `Expiry date: ${fullExpiry} (${daysUntilExpiry} days remaining). Renew now.`,
        });
      } else if (daysUntilExpiry < 30) {
        items.push({
          id: "domain-expiry",
          category: "hygiene",
          severity: "warn",
          title: "Domain expiry approaching",
          details: `Expiry date: ${fullExpiry} (${daysUntilExpiry} days remaining).`,
        });
      } else {
        items.push({
          id: "domain-expiry",
          category: "hygiene",
          severity: "pass",
          title: "Domain expiry",
          details: `Expiry date: ${fullExpiry} (${daysUntilExpiry} days remaining).`,
        });
      }
    }

    const ttlIssues: string[] = [];
    const ttlCritical: string[] = [];
    for (const r of records) {
      const ttl = getTtlSeconds(r.ttl);
      if (ttl === null) continue;
      if (ttl <= 0) ttlCritical.push(`${r.type} ${r.name}: invalid TTL ${ttl}`);
      else if (ttl < 30)
        ttlCritical.push(
          `${r.type} ${r.name}: TTL ${ttl}s is dangerously low (<30s should only be temporary)`,
        );
      else if (ttl < 60)
        ttlIssues.push(`${r.type} ${r.name}: TTL ${ttl}s is very low`);
      else if (r.type === "SOA" && ttl < 3600)
        ttlIssues.push(`SOA ${r.name}: TTL ${ttl}s is low (often 3600+).`);
      else if (["NS", "MX"].includes(r.type) && ttl < 300)
        ttlIssues.push(`${r.type} ${r.name}: TTL ${ttl}s is low (often 300+).`);
      else if (ttl > 86400)
        ttlIssues.push(
          `${r.type} ${r.name}: TTL ${ttl}s is very high (changes propagate slowly).`,
        );
    }
    if (ttlCritical.length > 0) {
      items.push({
        id: "ttl-critical",
        category: "hygiene",
        severity: "fail",
        title: "TTL dangerously low",
        details:
          ttlCritical.slice(0, 8).join("\n") +
          "\n\nTTL <30s should only be used temporarily before DNS changes.",
      });
    }
    items.push({
      id: "ttl-hygiene",
      category: "hygiene",
      severity: ttlIssues.length ? "info" : "pass",
      title: "TTL review",
      details: ttlIssues.length
        ? ttlIssues.slice(0, 12).join("\n")
        : "No obvious TTL outliers detected.",
    });

    const cnameConflicts: string[] = [];
    const cnameAtApexWarnings: string[] = [];
    for (const [name, rrset] of byName.entries()) {
      const hasCname = rrset.some((r) => r.type === "CNAME");
      if (!hasCname) continue;
      const others = rrset.filter((r) => r.type !== "CNAME");
      if (others.length > 0) {
        const types = Array.from(new Set(others.map((r) => r.type))).join(", ");
        const isApex = name === normalizedZone;
        if (isApex) {
          cnameAtApexWarnings.push(
            `${name}: CNAME at apex with ${types}. Cloudflare flattens this to ANAME/ALIAS, which works but may not be portable.`,
          );
        } else {
          cnameConflicts.push(
            `${name}: CNAME coexists with ${types} at the same name (RFC violation)`,
          );
        }
      }
    }
    if (cnameConflicts.length > 0) {
      items.push({
        id: "cname-conflicts",
        category: "hygiene",
        severity: "fail",
        title: "CNAME conflicts",
        details:
          cnameConflicts.slice(0, 10).join("\n") +
          "\n\nRFC 1034: If a CNAME record is present at a name, no other data should exist at that exact same name.",
      });
    }
    if (cnameAtApexWarnings.length > 0) {
      items.push({
        id: "cname-at-apex",
        category: "hygiene",
        severity: "warn",
        title: "CNAME at apex (Cloudflare-specific behavior)",
        details:
          cnameAtApexWarnings.slice(0, 5).join("\n") +
          "\n\nCloudflare automatically flattens CNAME records at the apex to ANAME/ALIAS records, which works correctly. " +
          "However, this is Cloudflare-specific behavior. If you migrate to another DNS provider, you may need to convert these to A/AAAA records.",
      });
    }
    if (cnameConflicts.length === 0 && cnameAtApexWarnings.length === 0) {
      items.push({
        id: "cname-conflicts",
        category: "hygiene",
        severity: "pass",
        title: "CNAME conflicts",
        details: "No names have both CNAME and other record types.",
      });
    }

    const cnameChainIssues: string[] = [];
    const cnameChainWarnings: string[] = [];
    for (const r of cnameRecords) {
      const from = normalizeName(r.name, normalizedZone);
      if (!from) continue;
      const { hops, cyclic, chain } = computeCnameChain(from, cnameMap, 20);
      if (cyclic)
        cnameChainIssues.push(
          `${r.name}: CNAME cycle detected (${chain.join(" → ")})`,
        );
      else if (hops >= 5)
        cnameChainIssues.push(
          `${r.name}: CNAME chain is ${hops} hops (${chain.join(" → ")})`,
        );
      else if (hops >= 3)
        cnameChainWarnings.push(
          `${r.name}: CNAME chain is ${hops} hops (best practice ≤2)`,
        );
    }
    if (cnameChainIssues.length > 0) {
      items.push({
        id: "cname-chains-fail",
        category: "hygiene",
        severity: "fail",
        title: "CNAME chains or cycles",
        details: cnameChainIssues.slice(0, 8).join("\n"),
      });
    }
    if (cnameChainWarnings.length > 0) {
      items.push({
        id: "cname-chains-warn",
        category: "hygiene",
        severity: "warn",
        title: "CNAME chains exceed best practice",
        details: cnameChainWarnings.slice(0, 8).join("\n"),
      });
    }
    if (cnameChainIssues.length === 0 && cnameChainWarnings.length === 0) {
      items.push({
        id: "cname-chains",
        category: "hygiene",
        severity: "pass",
        title: "CNAME chaining",
        details: "No excessive CNAME chains detected (all ≤2 hops).",
      });
    }

    if (spfTypeRecords.length > 0) {
      items.push({
        id: "spf-type-deprecated",
        category: "hygiene",
        severity: "warn",
        title: "SPF record type present",
        details:
          "The SPF RR type is deprecated. Publish SPF as a TXT record instead.",
      });
    } else {
      items.push({
        id: "spf-type-deprecated",
        category: "hygiene",
        severity: "pass",
        title: "No deprecated SPF RR type",
        details: "No SPF-type records found.",
      });
    }

    const badA = findSpecialIpRecords(records, "A").map((x) => ({
      name: x.record.name,
      ip: x.ip,
      issue: x.issue,
    }));

    items.push({
      id: "special-a",
      category: "hygiene",
      severity: badA.length ? "warn" : "pass",
      title: "A records (special/private/bogon IPs)",
      details: badA.length
        ? badA
            .slice(0, 8)
            .map((x) => `${x.name}: ${x.ip} (${x.issue})`)
            .join("\n")
        : "No obvious special-use/bogon IPv4 addresses detected in A records.",
    });

    const badAAAA = findSpecialIpRecords(records, "AAAA").map((x) => ({
      name: x.record.name,
      ip: x.ip,
      issue: x.issue,
    }));

    items.push({
      id: "special-aaaa",
      category: "hygiene",
      severity: badAAAA.length ? "warn" : "pass",
      title: "AAAA records (special/private/bogon IPs)",
      details: badAAAA.length
        ? badAAAA
            .slice(0, 8)
            .map((x) => `${x.name}: ${x.ip} (${x.issue})`)
            .join("\n")
        : "No obvious special-use/bogon IPv6 addresses detected in AAAA records.",
    });

    const nsAtApex = records.filter(
      (r) => r.type === "NS" && recordNameIsApex(r.name, normalizedZone),
    );
    if (nsAtApex.length === 0) {
      items.push({
        id: "ns-missing",
        category: "hygiene",
        severity: "info",
        title: "NS records at apex",
        details:
          "No NS records visible at apex (Cloudflare manages these automatically).",
      });
    } else if (nsAtApex.length === 1) {
      items.push({
        id: "ns-single",
        category: "hygiene",
        severity: "fail",
        title: "Single NS record at apex",
        details:
          "Best practice requires ≥2 authoritative name servers for redundancy.",
      });
    } else {
      items.push({
        id: "ns-redundancy",
        category: "hygiene",
        severity: "pass",
        title: "NS redundancy",
        details: `Found ${nsAtApex.length} NS records at apex.`,
      });
    }

    const apexA = records.filter(
      (r) => r.type === "A" && recordNameIsApex(r.name, normalizedZone),
    );
    const apexAAAA = records.filter(
      (r) => r.type === "AAAA" && recordNameIsApex(r.name, normalizedZone),
    );
    if (apexA.length === 1 && apexAAAA.length === 0) {
      items.push({
        id: "apex-single-ip",
        category: "hygiene",
        severity: "warn",
        title: "Single A record at apex",
        details:
          "Apex has only one A record. Consider adding redundancy for critical services.",
      });
    }
    if (apexAAAA.length === 1 && apexA.length === 0) {
      items.push({
        id: "apex-single-ipv6",
        category: "hygiene",
        severity: "warn",
        title: "Single AAAA record at apex",
        details:
          "Apex has only one AAAA record. Consider adding redundancy for critical services.",
      });
    }

    if (soaRecords.length === 0) {
      items.push({
        id: "soa-missing",
        category: "hygiene",
        severity: "info",
        title: "SOA record",
        details:
          "No SOA record found (Cloudflare may manage SOA automatically).",
      });
    } else if (soaRecords.length > 1) {
      items.push({
        id: "soa-multiple",
        category: "hygiene",
        severity: "warn",
        title: "Multiple SOA records",
        details: `Found ${soaRecords.length} SOA records; typically there should be exactly one.`,
      });
    } else {
      const soa = soaRecords[0];
      const parts = String(soa.content ?? "")
        .trim()
        .split(/\s+/);
      const issues: string[] = [];
      if (!recordNameIsApex(soa.name, normalizedZone))
        issues.push('SOA name is usually "@".');
      if (parts.length < 7) {
        issues.push(
          "SOA content should have 7 fields: mname rname serial refresh retry expire minimum.",
        );
      } else {
        const [mname, rname, serial, refresh, retry, expire, minimum] = parts;
        if (!mname.includes("."))
          issues.push("SOA mname does not look like a hostname.");
        if (!rname.includes("."))
          issues.push(
            "SOA rname should look like an email with '.' instead of '@'.",
          );
        if (!/^\d{6,}$/.test(serial))
          issues.push("SOA serial should be numeric (often YYYYMMDDnn).");
        if (
          /^\d{10}$/.test(serial) &&
          !/^20\d{2}(0[1-9]|1[0-2])([0-2]\d|3[01])\d{2}$/.test(serial)
        ) {
          issues.push(
            "SOA serial looks like YYYYMMDDnn but the date part is unusual.",
          );
        }
        const nums = [refresh, retry, expire, minimum].map((x) => Number(x));
        if (nums.some((n) => !Number.isFinite(n)))
          issues.push("SOA timers must be numeric.");
        const [refreshN, retryN, expireN, minimumN] = nums as number[];
        if (Number.isFinite(refreshN) && refreshN < 3600)
          issues.push(
            "SOA refresh <3600s violates best practice (should be ≥3600).",
          );
        if (Number.isFinite(refreshN) && refreshN > 86400)
          issues.push("SOA refresh is very high (>86400).");
        if (Number.isFinite(retryN) && (retryN < 600 || retryN > 900))
          issues.push("SOA retry outside recommended range 600-900s.");
        if (Number.isFinite(expireN) && expireN < 604800)
          issues.push(
            "SOA expire <7 days violates best practice (should be ≥604800).",
          );
        if (Number.isFinite(expireN) && expireN > 2419200)
          issues.push("SOA expire is very high (>28 days).");
        if (Number.isFinite(minimumN) && (minimumN < 60 || minimumN > 86400))
          issues.push("SOA minimum is unusual (typical 60–86400).");
        if (
          Number.isFinite(refreshN) &&
          Number.isFinite(retryN) &&
          refreshN > 0 &&
          retryN > 0 &&
          retryN >= refreshN
        ) {
          issues.push("SOA retry is >= refresh (should be smaller).");
        }
        const lowestTTL = records
          .map((r) => getTtlSeconds(r.ttl))
          .filter((t): t is number => t !== null && t > 0)
          .sort((a, b) => a - b)[0];
        if (Number.isFinite(minimumN) && lowestTTL && minimumN < lowestTTL) {
          issues.push(
            `SOA minimum (${minimumN}s) is less than lowest record TTL (${lowestTTL}s). Best practice: SOA minimum ≥ lowest TTL.`,
          );
        }
      }
      items.push({
        id: "soa-review",
        category: "hygiene",
        severity: issues.length ? "info" : "pass",
        title: "SOA best-practice review",
        details: issues.length
          ? issues.join("\n")
          : "SOA record looks structurally valid.",
      });
    }

    const txtByName = new Map<string, number>();
    for (const r of records.filter((x) => x.type === "TXT")) {
      const n = normalizeName(r.name, normalizedZone);
      if (!n) continue;
      txtByName.set(n, (txtByName.get(n) ?? 0) + 1);
    }
    const txtSprawl = Array.from(txtByName.entries())
      .filter(([, count]) => count > 5)
      .map(([name, count]) => `${name}: ${count} TXT records`);
    if (txtSprawl.length > 0) {
      items.push({
        id: "txt-sprawl",
        category: "hygiene",
        severity: "info",
        title: "TXT record sprawl detected",
        details:
          txtSprawl.slice(0, 8).join("\n") +
          "\n\nMultiple TXT records at the same name can make management difficult. Ensure each serves a purpose.",
      });
    }

    if (srvRecords.length > 0) {
      const issues: string[] = [];
      for (const r of srvRecords.slice(0, 50)) {
        const name = String(r.name ?? "").trim();
        if (!/^_/.test(name) || !/\._(tcp|udp)/i.test(name)) {
          issues.push(
            `SRV ${name}: name should be like _service._tcp (or _udp).`,
          );
        }
        const parsed = parseSRV(r.content);
        if (
          parsed.priority === undefined ||
          parsed.weight === undefined ||
          parsed.port === undefined
        ) {
          issues.push(
            `SRV ${name}: content should be "priority weight port target".`,
          );
          continue;
        }
        if (parsed.port < 0 || parsed.port > 65535)
          issues.push(`SRV ${name}: port out of range.`);
        const tgt = String(parsed.target ?? "").trim();
        if (!tgt) issues.push(`SRV ${name}: target missing.`);
        if (tgt === "." && parsed.port !== 0) {
          issues.push(
            `SRV ${name}: target '.' indicates service not available; port should be 0.`,
          );
        }
      }
      items.push({
        id: "srv-review",
        category: "hygiene",
        severity: issues.length ? "info" : "pass",
        title: "SRV best-practice review",
        details: issues.length
          ? issues.slice(0, 12).join("\n")
          : "No obvious SRV issues detected.",
      });
    }
  }

  if (options.includeCategories.security) {
    const caaRecords = records.filter((r) => r.type === "CAA");
    if (caaRecords.length > 0) {
      const parsed = caaRecords.map((r) => ({ r, p: parseCaa(r.content) }));
      const hasIodef = parsed.some((x) => x.p.tag === "iodef" && x.p.value);
      const issues: string[] = [];
      if (!hasIodef)
        issues.push(
          "No iodef CAA tag detected (consider adding an incident contact URL/email).",
        );
      const issueValues = parsed
        .filter((x) => x.p.tag === "issue" || x.p.tag === "issuewild")
        .map((x) => (x.p.value ?? "").trim())
        .filter(Boolean);
      const distinct = Array.from(new Set(issueValues));
      if (distinct.length > 3)
        issues.push(
          `CAA allows many issuers (${distinct.length}). Consider tightening to fewer CAs.`,
        );
      const hasDenyAll = parsed.some(
        (x) => x.p.tag === "issue" && (x.p.value ?? "").trim() === ";",
      );
      if (!hasDenyAll && distinct.length === 0)
        issues.push(
          "CAA exists but contains no issue/issuewild tags (may be ineffective).",
        );
      items.push({
        id: "caa-analysis",
        category: "security",
        severity: issues.length ? "warn" : "pass",
        title: "CAA policy review",
        details: issues.length
          ? issues.join("\n")
          : "CAA present and looks reasonable.",
      });
    } else {
      items.push({
        id: "caa-analysis",
        category: "security",
        severity: "info",
        title: "CAA policy review",
        details: "No CAA records detected.",
      });
    }
  }

  if (options.includeCategories.email) {
    if (mxAtApex.length > 0) {
      items.push({
        id: "mx-present",
        category: "email",
        severity: "info",
        title: "MX records detected at apex",
        details: `Found ${mxAtApex.length} MX record(s) at ${apex}.`,
      });
    } else {
      items.push({
        id: "mx-present",
        category: "email",
        severity: mx.length > 0 ? "info" : "pass",
        title: "MX records",
        details:
          mx.length > 0
            ? `Found ${mx.length} MX record(s) (not at apex).`
            : "No MX records detected.",
      });
    }

    if (mxAtApex.length === 1) {
      items.push({
        id: "mx-single",
        category: "email",
        severity: "warn",
        title: "Single MX record at apex",
        details:
          "Having only one MX can be a single point of failure. Consider adding a secondary MX (or ensuring provider HA).",
      });
    } else if (mxAtApex.length > 10) {
      items.push({
        id: "mx-too-many",
        category: "email",
        severity: "warn",
        title: "Many MX records at apex",
        details: `Found ${mxAtApex.length} MX records at apex; this is unusual and may be misconfigured.`,
      });
    } else if (mxAtApex.length > 1) {
      items.push({
        id: "mx-redundancy",
        category: "email",
        severity: "pass",
        title: "MX redundancy",
        details: `Multiple MX records detected at apex (${mxAtApex.length}).`,
      });
    }

    const cnameNames = new Set(Array.from(cnameMap.keys()));
    const mxCnameTargets = mxAtApex
      .map((r) => normalizeTargetDomain(r.content, normalizedZone))
      .filter((t) => cnameNames.has(t));
    if (mxCnameTargets.length > 0) {
      items.push({
        id: "mx-cname-target",
        category: "email",
        severity: "fail",
        title: "MX points at a CNAME target",
        details: `One or more MX targets are CNAMEs in this zone: ${Array.from(new Set(mxCnameTargets)).join(", ")}`,
      });
    } else if (mxAtApex.length > 0) {
      items.push({
        id: "mx-cname-target",
        category: "email",
        severity: "pass",
        title: "MX targets are not CNAMEs (within zone)",
        details: "No MX targets match CNAME names in this zone.",
      });
    }

    if (mxAtApex.length > 1) {
      const parsed = mxAtApex.map((r) => parseMx(r, normalizedZone));
      const priorities = parsed
        .map((p) => p.priority)
        .filter((p): p is number => p !== undefined);
      const uniquePriorities = new Set(priorities);
      if (priorities.length > 1 && uniquePriorities.size < priorities.length) {
        items.push({
          id: "mx-duplicate-priority",
          category: "email",
          severity: "warn",
          title: "MX records have duplicate priorities",
          details:
            "Multiple MX records share the same priority. Ensure this is intentional for round-robin.",
        });
      }
      const mxTargetsWithoutResolution: string[] = [];
      for (const p of parsed) {
        if (!p.target) continue;
        const hasA = aByName.has(p.target);
        const hasAAAA = aaaaByName.has(p.target);
        if (!hasA && !hasAAAA) {
          mxTargetsWithoutResolution.push(p.target);
        }
      }
      if (mxTargetsWithoutResolution.length > 0) {
        items.push({
          id: "mx-no-resolution",
          category: "email",
          severity: "info",
          title: "MX targets without A/AAAA in zone",
          details:
            `The following MX targets have no A or AAAA records in this zone: ${Array.from(new Set(mxTargetsWithoutResolution)).join(", ")}. ` +
            "This is OK if they resolve externally, but verify they're reachable.",
        });
      }
    }

    if (spfTxtAtApex.length === 0) {
      items.push({
        id: "spf-missing",
        category: "email",
        severity: mxAtApex.length > 0 ? "fail" : "warn",
        title: "SPF missing at apex",
        details:
          mxAtApex.length > 0
            ? "MX exists at the zone apex but no SPF TXT record was found at @."
            : "No SPF TXT record was found at @.",
        suggestion: { recordType: "TXT", name: "@", content: "v=spf1 -all" },
      });
    } else if (spfTxtAtApex.length > 1) {
      items.push({
        id: "spf-multiple",
        category: "email",
        severity: "fail",
        title: "Multiple SPF TXT records at apex",
        details:
          "Multiple SPF records can cause permerror. Combine mechanisms into a single SPF TXT record.",
      });
    } else {
      const spf = spfTxtAtApex[0];
      const qualifier = getSpfAllQualifier(spf);
      const lookupEstimate = estimateSpfLookupCount(spf);

      if (!qualifier) {
        items.push({
          id: "spf-all-missing",
          category: "email",
          severity: "warn",
          title: "SPF missing an all mechanism",
          details: "SPF should typically end with one of -all or ~all.",
        });
      } else if (qualifier === "+") {
        items.push({
          id: "spf-too-permissive",
          category: "email",
          severity: "fail",
          title: "SPF is too permissive (+all)",
          details:
            "SPF with +all authorizes any sender and is usually a serious misconfiguration.",
        });
      } else if (qualifier === "?") {
        items.push({
          id: "spf-neutral",
          category: "email",
          severity: "warn",
          title: "SPF ends with ?all (neutral)",
          details:
            "Neutral SPF provides weak protection. Prefer -all or ~all once confident.",
        });
      } else if (qualifier === "~") {
        items.push({
          id: "spf-softfail",
          category: "email",
          severity: mxAtApex.length > 0 ? "warn" : "info",
          title: "SPF ends with ~all (softfail)",
          details:
            "Softfail is common during rollout. Consider moving to -all once aligned.",
        });
      } else {
        items.push({
          id: "spf-ok",
          category: "email",
          severity: "pass",
          title: "SPF present at apex",
          details: "Found one SPF TXT record at @ with an all mechanism.",
        });
      }

      const spfParsed = parseSPF(spf);
      if (spfParsed?.mechanisms.some((m) => m.mechanism === "ptr")) {
        items.push({
          id: "spf-ptr",
          category: "email",
          severity: "warn",
          title: "SPF uses ptr mechanism",
          details:
            "The ptr mechanism is discouraged; it is slow and unreliable.",
        });
      }

      if (typeof lookupEstimate === "number" && lookupEstimate >= 10) {
        items.push({
          id: "spf-lookups-estimate",
          category: "email",
          severity: "warn",
          title: "SPF may exceed DNS lookup budget",
          details: `Estimated lookup-triggering mechanisms: ${lookupEstimate}. SPF has a 10 DNS lookup limit; consider flattening or simplifying.`,
        });
      } else if (typeof lookupEstimate === "number") {
        items.push({
          id: "spf-lookups-estimate",
          category: "email",
          severity: "info",
          title: "SPF lookup estimate",
          details: `Estimated lookup-triggering mechanisms: ${lookupEstimate}. Use the SPF graph check for an exact count.`,
        });
      }
    }

    if (dmarcTxt.length === 0) {
      items.push({
        id: "dmarc-missing",
        category: "email",
        severity: mxAtApex.length > 0 ? "fail" : "warn",
        title: "DMARC record missing",
        details: `No DMARC TXT record found at ${dmarcName}.`,
        suggestion: {
          recordType: "TXT",
          name: "_dmarc",
          content: `v=DMARC1; p=none; rua=mailto:postmaster@${apex}; fo=1`,
        },
      });
    } else if (dmarcTxt.length > 1) {
      items.push({
        id: "dmarc-multiple",
        category: "email",
        severity: "fail",
        title: "Multiple DMARC TXT records",
        details: `Multiple DMARC records found at ${dmarcName}. Keep exactly one.`,
      });
    } else {
      const dmarc = dmarcTxt[0];
      const tags = parseTagRecord(dmarc);
      const p = (tags.p ?? "").toLowerCase();
      const hasRua = Boolean((tags.rua ?? "").trim());
      if (!p) {
        // Receivers ignore a record with no p= at all, so there is nothing to
        // say about its reporting: the record is not in effect either way.
        items.push({
          id: "dmarc-missing-policy",
          category: "email",
          severity: "fail",
          title: "DMARC missing policy (p=)",
          details: "DMARC must include a p= policy tag.",
        });
      } else {
        // Reporting is a separate question from policy strength, and it is the
        // one the audit used to be silent about. A record with no rua= sends
        // nothing anywhere: under p=none that makes it inert, and under an
        // enforcing policy it means receivers are acting on mail the domain
        // cannot see. Both deserve saying once, here, rather than in fragments
        // attached to the policy findings.
        if (!hasRua) {
          items.push({
            id: "dmarc-no-rua",
            category: "email",
            severity: "warn",
            title: "DMARC has no report address (rua=)",
            details:
              p === "none"
                ? `No rua= address is set at ${dmarcName}, so no aggregate reports are being sent. With p=none receivers are also asked to change nothing, so the record currently has no observable effect.`
                : `No rua= address is set at ${dmarcName}, so no aggregate reports are being sent. Receivers are acting on mail that fails your checks under p=${p}, and you have no way to see which mail that is.`,
          });
        }
        // Not gated on an apex MX. DMARC governs what receivers do with mail
        // *claiming* to be from the domain; whether the domain *accepts* mail
        // is a separate question. Parked and web-only domains are attractive
        // spoofing targets precisely because nobody is watching them.
        if (p === "none") {
          items.push({
            id: "dmarc-policy-none",
            category: "email",
            severity: "warn",
            title: "DMARC policy is p=none",
            details: "Consider moving to quarantine/reject once aligned.",
          });
        } else if (hasRua) {
          items.push({
            id: "dmarc-ok",
            category: "email",
            severity: "pass",
            title: "DMARC present",
            details: `DMARC is configured with p=${p} and an aggregate report address.`,
          });
        }
      }
    }

    if (mx.length > 0 && !hasAnyDkim) {
      items.push({
        id: "dkim-missing",
        category: "email",
        severity: "warn",
        title: "No DKIM records detected",
        details:
          "No DKIM TXT records (v=DKIM1) detected under selector._domainkey.*. DKIM selectors are provider-specific.",
      });
    } else {
      items.push({
        id: "dkim-missing",
        category: "email",
        severity: mx.length > 0 ? "pass" : "info",
        title: "DKIM records",
        details:
          mx.length > 0
            ? "DKIM TXT records detected."
            : "No MX detected; DKIM may be unnecessary.",
      });
    }
  }

  return items.map(explainFinding);
}
