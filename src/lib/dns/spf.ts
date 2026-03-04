// runtime access to Node DNS and net modules without static imports to avoid Vite externalization
function getRuntimeRequire(): ((name: string) => any) | undefined {
  try {
    if (typeof (globalThis as any).require === "function") return (globalThis as any).require;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const r = eval("typeof require === 'function' ? require : undefined");
    return typeof r === "function" ? r : undefined;
  } catch {
    return undefined;
  }
}

function getDnsPromisesModule(): any | undefined {
  if ((globalThis as any).__dnsPromises) return (globalThis as any).__dnsPromises;
  const req = getRuntimeRequire();
  if (!req) return undefined;
  try {
    const mod = req("node:dns") || req("dns");
    const p = mod && mod.promises ? mod.promises : mod;
    (globalThis as any).__dnsPromises = p;
    return p;
  } catch {
    return undefined;
  }
}

function getNetModule(): any | undefined {
  if ((globalThis as any).__netModule) return (globalThis as any).__netModule;
  const req = getRuntimeRequire();
  if (!req) return undefined;
  try {
    const m = req("node:net") || req("net");
    (globalThis as any).__netModule = m;
    return m;
  } catch {
    return undefined;
  }
}

function getNetIsIP(addr: string): number {
  const m = getNetModule();
  if (m && typeof m.isIP === "function") return m.isIP(addr);
  // simple fallback
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(addr)) return 4;
  if (addr.includes(":")) return 6;
  return 0;
}


export type SPFMechanism = {
  qualifier?: string; // + - ~ ?
  mechanism: string; // ip4, ip6, a, mx, include, all, ptr, exists
  value?: string; // ip or domain
};

// debug: if tests assert unexpected results, this area can help trace
// mechanism evaluation
// console.debug('[simulateSPF] parsed', parsed, 'domain', domain, 'ip', ip);
export type SPFModifier = { key: string; value: string };

export interface SPFRecord {
  version: string; // v=spf1
  mechanisms: SPFMechanism[];
  modifiers?: SPFModifier[];
}

export function parseSPF(content?: string): SPFRecord | null {
  if (!content) return null;
  const s = String(content).trim();
  if (!s.toLowerCase().startsWith("v=spf1")) return null;
  const rest = s.substring(6).trim();
  if (rest.length === 0) return { version: "v=spf1", mechanisms: [] };
  const parts = rest.split(/\s+/);
  const mechanisms = parts.map((p) => {
    // handle modifier like redirect=domain or exp=uri
    if (p.includes("=")) {
      const [key, val] = p.split("=");
      const mech: SPFMechanism = {
        qualifier: undefined,
        mechanism: `modifier:${key.toLowerCase()}`,
        value: val,
      };
      return mech;
    }
    const qualifier =
      p[0] && ["+", "-", "~", "?"].includes(p[0]) ? p[0] : undefined;
    const core = qualifier ? p.substring(1) : p;
    const [mechanism, ...valParts] = core.split(":");
    const val = valParts.length ? valParts.join(":") : undefined;
    return {
      qualifier,
      mechanism: mechanism.toLowerCase(),
      value: val,
    } as SPFMechanism;
  });
  const modifiers = mechanisms
    .filter((m) => m.mechanism && m.mechanism.startsWith("modifier:"))
    .map((m) => ({
      key: (m.mechanism || "").split(":")[1],
      value: m.value || "",
    }));
  const realMechanisms = mechanisms.filter(
    (m) => !(m.mechanism && m.mechanism.startsWith("modifier:")),
  );
  return {
    version: "v=spf1",
    mechanisms: realMechanisms,
    modifiers: modifiers.length ? modifiers : undefined,
  };
}

// DNS resolver indirection so tests can swap in a mock resolver
export type DNSResolver = {
  resolveTxt(domain: string): Promise<string[][]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  reverse(ip: string): Promise<string[]>;
};

const defaultDnsResolver: DNSResolver = {
  resolveTxt: (d: string) => {
    const p = getDnsPromisesModule();
    if (p && typeof p.resolveTxt === "function") return p.resolveTxt(d);
    return Promise.reject(new Error("DNS resolver not available in this environment"));
  },
  resolve4: (d: string) => {
    const p = getDnsPromisesModule();
    if (p && typeof p.resolve4 === "function") return p.resolve4(d);
    return Promise.reject(new Error("DNS resolver not available in this environment"));
  },
  resolve6: (d: string) => {
    const p = getDnsPromisesModule();
    if (p && typeof p.resolve6 === "function") return p.resolve6(d);
    return Promise.reject(new Error("DNS resolver not available in this environment"));
  },
  resolveMx: (d: string) => {
    const p = getDnsPromisesModule();
    if (p && typeof p.resolveMx === "function") return p.resolveMx(d);
    return Promise.reject(new Error("DNS resolver not available in this environment"));
  },
  reverse: (d: string) => {
    const p = getDnsPromisesModule();
    if (p && typeof p.reverse === "function") return p.reverse(d);
    return Promise.reject(new Error("DNS resolver not available in this environment"));
  },
};


let dnsResolver: DNSResolver = defaultDnsResolver;
export function setDnsResolverForTest(resolver: DNSResolver | undefined) {
  dnsResolver = resolver ?? defaultDnsResolver;
}
export function resetDnsResolver() {
  dnsResolver = defaultDnsResolver;
}

export function composeSPF(record: SPFRecord): string {
  const mechGuts = record.mechanisms
    .map(
      (m) =>
        `${m.qualifier ?? ""}${m.mechanism}${m.value ? `:${m.value}` : ""}`,
    )
    .join(" ");
  const modifierGuts = (record.modifiers || [])
    .map((mm) => `${mm.key}=${mm.value}`)
    .join(" ");
  return `${record.version} ${[mechGuts, modifierGuts].filter(Boolean).join(" ")}`.trim();
}

export function validateSPF(content?: string): {
  ok: boolean;
  problems: string[];
} {
  const record = parseSPF(content);
  if (!record) return { ok: false, problems: ["missing v=spf1 prefix"] };
  const problems: string[] = [];
  // Basic validation rules: each mechanism allowed, ip4/6 value appears to be network
  for (const m of record.mechanisms) {
    if (
      !["all", "a", "mx", "ip4", "ip6", "include", "ptr", "exists"].includes(
        m.mechanism,
      )
    ) {
      problems.push(`unknown mechanism: ${m.mechanism}`);
    }
    if ((m.mechanism === "ip4" || m.mechanism === "ip6") && !m.value) {
      problems.push(`${m.mechanism} mechanism requires a value`);
    }
    if (
      (m.mechanism === "include" ||
        m.mechanism === "exists" ||
        m.mechanism === "redirect") &&
      !m.value
    ) {
      problems.push(`${m.mechanism} mechanism requires a domain/value`);
    }
  }
  // check modifiers if any
  if (record.modifiers) {
    let redirectCount = 0;
    for (const mod of record.modifiers) {
      if (mod.key === "redirect") redirectCount++;
    }
    if (redirectCount > 1) problems.push("only one redirect modifier allowed");
  }
  return { ok: problems.length === 0, problems };
}

export async function getSPFRecordForDomain(
  domain: string,
): Promise<string | null> {
  try {
    const records = await dnsResolver.resolveTxt(domain);
    // debug: report what resolver returned for troubleshooting
    console.debug("[getSPFRecordForDomain] domain", domain, "records", records);
    for (const rec of records) {
      const txt = rec.join("");
      if (txt.toLowerCase().startsWith("v=spf1")) return txt;
    }
    return null;
  } catch {
    return null;
  }
}

export type SPFGraphNode = {
  domain: string;
  txt?: string | null;
  record?: SPFRecord | null;
};

export type SPFGraph = {
  nodes: SPFGraphNode[];
  edges: { from: string; to: string; type: "include" | "redirect" }[];
  lookups: number;
  cyclic?: boolean;
};

type DNSCacheValue =
  | string[][]
  | string[]
  | { exchange: string; priority: number }[]
  | Error;
const dnsCache = new Map<string, DNSCacheValue>();

async function resolveTxtCached(domain: string): Promise<string[][]> {
  const key = `TXT:${domain}`;
  if (dnsCache.has(key)) return dnsCache.get(key) as string[][];
  try {
    const val = await dnsResolver.resolveTxt(domain);
    dnsCache.set(key, val);
    return val;
  } catch (err) {
    dnsCache.set(key, err as Error);
    throw err;
  }
}

export async function buildSPFGraph(
  domain: string,
  maxDepth = 10,
): Promise<SPFGraph> {
  const nodes: Record<string, SPFGraphNode> = {};
  const edges: { from: string; to: string; type: "include" | "redirect" }[] =
    [];
  let lookups = 0;
  let cyclic = false;

  const visited = new Set<string>();

  async function walk(d: string, depth = 0) {
    if (depth > maxDepth) return;
    if (visited.has(d)) {
      cyclic = true;
      return;
    }
    visited.add(d);
    let txt: string | null = null;
    try {
      const recs = await resolveTxtCached(d);
      lookups++;
      for (const r of recs) {
        const s = r.join("");
        if (s.toLowerCase().startsWith("v=spf1")) {
          txt = s;
          break;
        }
      }
    } catch {
      txt = null;
    }
    const parsed = parseSPF(txt ?? undefined);
    nodes[d] = { domain: d, txt, record: parsed };
    if (parsed?.mechanisms) {
      for (const m of parsed.mechanisms) {
        if (m.mechanism === "include" && m.value) {
          edges.push({ from: d, to: m.value, type: "include" });
          await walk(m.value, depth + 1);
        }
      }
    }
    if (parsed?.modifiers) {
      for (const mod of parsed.modifiers) {
        if (mod.key === "redirect" && mod.value) {
          edges.push({ from: d, to: mod.value, type: "redirect" });
          await walk(mod.value, depth + 1);
        }
      }
    }
  }

  await walk(domain, 0);
  return { nodes: Object.values(nodes), edges, lookups, cyclic } as SPFGraph;
}

export async function buildSPFGraphFromContent(
  domain: string,
  content: string,
  maxDepth = 10,
): Promise<SPFGraph> {
  const nodes: Record<string, SPFGraphNode> = {};
  const edges: { from: string; to: string; type: "include" | "redirect" }[] =
    [];
  let lookups = 0;
  let cyclic = false;
  const visited = new Set<string>();

  async function walk(d: string, depth = 0) {
    if (depth > maxDepth) return;
    if (visited.has(d)) {
      cyclic = true;
      return;
    }
    visited.add(d);
    let txt: string | null = null;
    if (d === domain) {
      txt = content;
    } else {
      try {
        const recs = await resolveTxtCached(d);
        lookups++;
        for (const r of recs) {
          const s = r.join("");
          if (s.toLowerCase().startsWith("v=spf1")) {
            txt = s;
            break;
          }
        }
      } catch {
        txt = null;
      }
    }
    const parsed = parseSPF(txt ?? undefined);
    nodes[d] = { domain: d, txt, record: parsed };
    if (parsed?.mechanisms) {
      for (const m of parsed.mechanisms) {
        if (m.mechanism === "include" && m.value) {
          edges.push({ from: d, to: m.value, type: "include" });
          await walk(m.value, depth + 1);
        }
      }
    }
    if (parsed?.modifiers) {
      for (const mod of parsed.modifiers) {
        if (mod.key === "redirect" && mod.value) {
          edges.push({ from: d, to: mod.value, type: "redirect" });
          await walk(mod.value, depth + 1);
        }
      }
    }
  }

  await walk(domain, 0);
  return { nodes: Object.values(nodes), edges, lookups, cyclic } as SPFGraph;
}

export async function validateSPFContentAsync(
  content: string,
  domain: string,
  options?: { maxLookups?: number },
) {
  const maxLookups = options?.maxLookups ?? 10;
  const graph = await buildSPFGraphFromContent(domain, content);
  const problems: string[] = [];
  if (graph.lookups > maxLookups)
    problems.push(
      `SPF content would require ${graph.lookups} DNS lookups which exceeds the ${maxLookups} limit`,
    );
  if (graph.cyclic)
    problems.push("SPF include/redirect graph contains a cycle");
  return { ok: problems.length === 0, problems, graph };
}

export async function validateSPFAsync(
  domain: string,
  options?: { maxLookups?: number },
) {
  const maxLookups = options?.maxLookups ?? 10;
  const graph = await buildSPFGraph(domain);
  const problems: string[] = [];
  if (graph.lookups > maxLookups)
    problems.push(
      `SPF record would require ${graph.lookups} DNS lookups which exceeds the ${maxLookups} limit`,
    );
  if (graph.cyclic)
    problems.push("SPF include/redirect graph contains a cycle");
  // check for multiple SPF TXT records
  try {
    const records = await dnsResolver.resolveTxt(domain);
    const spfCount = records.filter((r) =>
      r.join("").toLowerCase().startsWith("v=spf1"),
    ).length;
    if (spfCount > 1)
      problems.push(
        "Multiple SPF TXT records found for domain; only one is allowed",
      );
  } catch {
    // ignore DNS errors; they will be surfaced as lookup issues below
  }
  return { ok: problems.length === 0, problems, graph };
}

export type SPFResult = {
  result: "pass" | "fail" | "softfail" | "neutral" | "permerror" | "temperror";
  reasons: string[];
  lookups: number;
};

export function ipMatchesCIDR(ip: string, cidr: string) {
  try {
    // naive implementation: exact match for IPs without netmask or prefix check
    if (!cidr.includes("/")) return ip === cidr;
    const parts = cidr.split("/");
    let base = parts[0];
    const prefix = parts[1];
    // Use net.isIP and compare network prefix via buffer
    let ipType = getNetIsIP(ip);
    let baseType = getNetIsIP(base);
    // Support IPv4-mapped IPv6 addresses (e.g. ::ffff:1.2.3.4) by treating
    // them as IPv4 for the purpose of IPv4 CIDR comparisons.
    const isIPv4Mapped = (addr: string) =>
      /::ffff:(\d+\.\d+\.\d+\.\d+)$/i.test(addr);
    if (ipType === 6 && isIPv4Mapped(ip)) {
      const m = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
      if (m) {
        ip = m[1];
        ipType = 4;
      }
    }
    if (baseType === 6 && isIPv4Mapped(base)) {
      const m = base.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
      if (m) {
        base = m[1];
        baseType = 4;
      }
    }
    if (ipType === 0 || baseType === 0 || ipType !== baseType) return false;
    // for simplicity use string prefix matching for IPv4
    if (ipType === 4) {
      const ipBytes = ip.split(".").map(Number);
      const baseBytes = base.split(".").map(Number);
      const bitCount = Number(prefix);
      const ipVal =
        ((ipBytes[0] << 24) >>> 0) +
        (ipBytes[1] << 16) +
        (ipBytes[2] << 8) +
        ipBytes[3];
      const baseVal =
        ((baseBytes[0] << 24) >>> 0) +
        (baseBytes[1] << 16) +
        (baseBytes[2] << 8) +
        baseBytes[3];
      const mask = bitCount === 0 ? 0 : (~0 << (32 - bitCount)) >>> 0;
      return (ipVal & mask) === (baseVal & mask);
    }
    // IPv6: implement prefix comparison across 128-bit values
    const expandIPv6 = (addr: string) => {
      // Expand shorthand :: and return array of 8 hextets
      const parts = addr.split("::");
      if (parts.length === 1) {
        return addr.split(":").map((h) => h.padStart(4, "0"));
      }
      const left = parts[0] ? parts[0].split(":").filter(Boolean) : [];
      const right = parts[1] ? parts[1].split(":").filter(Boolean) : [];
      const missing = 8 - (left.length + right.length);
      const zeros = new Array(missing).fill("0000");
      const full = [...left, ...zeros, ...right].map((h) => h.padStart(4, "0"));
      // Support IPv4-mapped IPv6 addresses like ::ffff:192.0.2.1
      const last = full[full.length - 1] ?? "";
      if (last.includes(".")) {
        // convert dotted IPv4 at the end into two hextets
        const ipv4 = last;
        const octets = ipv4.split(".").map(Number);
        if (octets.length === 4 && octets.every((o: number) => !Number.isNaN(o))) {
          const hex1 = ((octets[0] << 8) | octets[1])
            .toString(16)
            .padStart(4, "0");
          const hex2 = ((octets[2] << 8) | octets[3])
            .toString(16)
            .padStart(4, "0");
          full.splice(full.length - 1, 1, hex1, hex2);
        }
      }
      return full;
    };
    const toBytes = (hextets: string[]) => {
      const out: number[] = [];
      for (const h of hextets) {
        const val = parseInt(h, 16) & 0xffff;
        out.push((val >> 8) & 0xff);
        out.push(val & 0xff);
      }
      return out;
    };
    try {
      const baseParts = expandIPv6(base);
      const ipParts = expandIPv6(ip);
      if (baseParts.length !== 8 || ipParts.length !== 8) return false;
      const baseBytes = toBytes(baseParts);
      const ipBytes = toBytes(ipParts);
      const maskBits = Number(prefix);
      let bitsRemaining = maskBits;
      for (let i = 0; i < baseBytes.length; i++) {
        if (bitsRemaining <= 0) break;
        const bitsToCheck = Math.min(8, bitsRemaining);
        const shift = 8 - bitsToCheck;
        const mask = ((0xff << shift) & 0xff) >>> 0;
        if ((baseBytes[i] & mask) !== (ipBytes[i] & mask)) return false;
        bitsRemaining -= bitsToCheck;
      }
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/** Expand a small subset of SPF macros. This handles common cases used by
 * the 'exp' modifier: %{s}, %{l}, %{d}, %{i} and the escaped forms %% %_ %-.
 * For robustness this function implements just enough of the RFC macro
 * expansion rules for the simulator and tests; it is not a full RFC
 * compliant macro evaluator.
 */
export function expandSPFMacro(
  template: string,
  ctx: { domain: string; ip: string; sender?: string },
) {
  // simple escape sequences
  return template.replace(/%{([^}]+)}|%%|%_ |%-/g, (m, g1) => {
    if (m === "%%") return "%";
    if (m === "%_") return " ";
    if (m === "%-") return "%20";
    if (!g1) return m;
    const token = g1;
    // handle simple macros with optional transformers (not implementing full spec)
    // e.g. s, l, d, i
    switch (token[0]) {
      case "s":
        return ctx.sender ?? "";
      case "l":
        return (ctx.sender ?? "").split("@")[0] ?? "";
      case "d":
        return ctx.domain ?? "";
      case "i":
        return ctx.ip ?? "";
      default:
        return "";
    }
  });
}

async function resolveA(domain: string): Promise<string[]> {
  const key = `A:${domain}`;
  if (dnsCache.has(key)) return dnsCache.get(key) as string[];
  try {
    const v4 = await dnsResolver.resolve4(domain);
    dnsCache.set(key, v4);
    return v4;
  } catch {
    dnsCache.set(key, []);
    return [];
  }
}

async function resolveAAAA(domain: string): Promise<string[]> {
  const key = `AAAA:${domain}`;
  if (dnsCache.has(key)) return dnsCache.get(key) as string[];
  try {
    const v6 = await dnsResolver.resolve6(domain);
    dnsCache.set(key, v6);
    return v6;
  } catch {
    dnsCache.set(key, []);
    return [];
  }
}

async function resolveMX(
  domain: string,
): Promise<{ exchange: string; priority: number }[]> {
  const key = `MX:${domain}`;
  if (dnsCache.has(key))
    return dnsCache.get(key) as { exchange: string; priority: number }[];
  try {
    const v = await dnsResolver.resolveMx(domain);
    dnsCache.set(key, v);
    return v;
  } catch {
    dnsCache.set(key, []);
    return [];
  }
}

async function resolvePTR(ip: string): Promise<string[]> {
  const key = `PTR:${ip}`;
  if (dnsCache.has(key)) return dnsCache.get(key) as string[];
  try {
    const v = await dnsResolver.reverse(ip);
    dnsCache.set(key, v);
    return v;
  } catch {
    dnsCache.set(key, []);
    return [];
  }
}

export async function simulateSPF({
  domain,
  ip,
  sender,
  maxLookups = 10,
}: {
  domain: string;
  ip: string;
  sender?: string;
  maxLookups?: number;
}): Promise<SPFResult> {
  dnsCache.clear();
  const txt = await getSPFRecordForDomain(domain);
  const parsed = parseSPF(txt ?? undefined);
  if (!parsed)
    return { result: "neutral", reasons: ["no spf record"], lookups: 0 };
  let lookups = 0;

  async function evalMechanism(
    m: SPFMechanism,
  ): Promise<"match" | "no" | "permerror" | "temperror"> {
    // ip4/ip6
    if (m.mechanism === "ip4" || m.mechanism === "ip6") {
      if (!m.value) return "no";
      if (ipMatchesCIDR(ip, m.value)) return "match";
      return "no";
    }
    if (m.mechanism === "a") {
      lookups++;
      if (lookups > maxLookups) return "permerror";
      const target = m.value ?? domain;
      const addrs = await resolveA(target);
      const addrs6 = await resolveAAAA(target);
      const all = [...(addrs || []), ...(addrs6 || [])];
      if (all.includes(ip)) return "match";
      return "no";
    }
    if (m.mechanism === "mx") {
      lookups++;
      if (lookups > maxLookups) return "permerror";
      const target = m.value ?? domain;
      const mx = await resolveMX(target);
      if (!mx || mx.length === 0) return "no";
      for (const item of mx) {
        const addrs = await resolveA(item.exchange);
        const addrs6 = await resolveAAAA(item.exchange);
        if (addrs.includes(ip) || addrs6.includes(ip)) return "match";
      }
      return "no";
    }
    if (m.mechanism === "ptr") {
      lookups++;
      if (lookups > maxLookups) return "permerror";
      const ptrs = await resolvePTR(ip);
      const value = m.value ?? domain;
      for (const p of ptrs) {
        // match if PTR ends with value
        if (p.toLowerCase().endsWith(value.toLowerCase())) {
          // forward-confirmed PTR: resolve A/AAAA of p and check if ip exists
          const a = await resolveA(p);
          const aaaa = await resolveAAAA(p);
          if ((a && a.includes(ip)) || (aaaa && aaaa.includes(ip)))
            return "match";
        }
      }
      return "no";
    }
    if (m.mechanism === "include") {
      lookups++;
      if (lookups > maxLookups) return "permerror";
      // recursively evaluate include
      const incDomain = m.value || "";
      const incResult = await simulateSPF({
        domain: incDomain,
        ip,
        sender,
        maxLookups: maxLookups - lookups,
      });
      lookups += incResult.lookups;
      if (incResult.result === "pass") return "match";
      if (incResult.result === "fail") return "no";
      // otherwise continue
      return "no";
    }
    if (m.mechanism === "exists") {
      lookups++;
      if (lookups > maxLookups) return "permerror";
      // naive check: try resolve A for value
      const exists = m.value ?? "";
      const a = await resolveA(exists);
      if (a && a.length > 0) return "match";
      return "no";
    }
    if (m.mechanism === "all") {
      return "match";
    }
    return "no";
  }

  try {
    for (const m of parsed.mechanisms) {
      const res = await evalMechanism(m);
      if (res === "permerror")
        return {
          result: "permerror",
          reasons: ["lookup limit reached or permerror"],
          lookups,
        };
      if (res === "temperror")
        return {
          result: "temperror",
          reasons: ["temporary lookup error"],
          lookups,
        };
      if (res === "match") {
        const qual = m.qualifier ?? "+";
        const mapping: Record<string, SPFResult["result"]> = {
          "+": "pass",
          "-": "fail",
          "~": "softfail",
          "?": "neutral",
        };
        const outcome = mapping[qual] || "pass";
        // For any matching mechanism we should return the mapped outcome
        // (pass/fail/softfail/neutral). For a fail we also attempt to
        // include an expanded explanation if the 'exp' modifier exists.
        let reasons: string[] = [`matched mechanism ${m.mechanism}`];
        if (outcome === "fail") {
          const expMod = parsed.modifiers
            ? parsed.modifiers.find((mm) => mm.key === "exp")
            : undefined;
          if (expMod && expMod.value) {
            try {
              const expanded = expandSPFMacro(expMod.value, {
                domain,
                ip,
                sender,
              });
              // ensure we respect lookup limits
              lookups++;
              if (lookups <= maxLookups) {
                const txts = await resolveTxtCached(expanded).catch(
                  () => [] as string[][],
                );
                if (Array.isArray(txts) && txts.length > 0) {
                  const expl = txts[0].join("");
                  reasons = reasons.concat([
                    `exp=${expanded}`,
                    `explain=${expl}`,
                  ]);
                } else {
                  reasons = reasons.concat([`exp=${expanded}`, "explain=none"]);
                }
              } else {
                reasons = reasons.concat(["exp=skipped (lookup limit)"]);
              }
            } catch {
              // ignore explanation failures
            }
          }
        }
        return { result: outcome, reasons, lookups };
      }
    }
    // if no match, check for modifiers redirect
    if (parsed.modifiers) {
      const redirect = parsed.modifiers.find((mm) => mm.key === "redirect");
      if (redirect) {
        const r = await simulateSPF({
          domain: redirect.value,
          ip,
          sender,
          maxLookups: maxLookups - lookups,
        });
        lookups += r.lookups;
        return r;
      }
    }
    return { result: "neutral", reasons: ["no matching mechanism"], lookups };
  } catch {
    return { result: "temperror", reasons: ["dns error"], lookups };
  }
}
