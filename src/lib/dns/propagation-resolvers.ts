/**
 * Propagation-checker resolver catalogue and option handling.
 *
 * This is the TypeScript mirror of the Rust catalogue in
 * `src-tauri/crates/bc-topology/src/lib.rs` (`PROPAGATION_RESOLVER_CATALOGUE`).
 * Rust is the source of truth for what the checker actually queries; this file
 * exists so the UI can render the option panel without a round-trip and so the
 * browser preferences can be validated. `test/propagationResolvers.test.ts`
 * asserts the two stay identical (ids, IPs, labels, default set, clamps).
 */

export interface PropagationResolverEntry {
  /** Stable identifier — currently the IPv4 literal. Also the wire `resolver`. */
  readonly id: string;
  readonly ip: string;
  readonly label: string;
  readonly provider: string;
  readonly region: string;
  readonly defaultEnabled: boolean;
}

function entry(
  id: string,
  label: string,
  provider: string,
  region: string,
  defaultEnabled: boolean,
): PropagationResolverEntry {
  return Object.freeze({ id, ip: id, label, provider, region, defaultEnabled });
}

/** Same rows, same order as the Rust catalogue. */
export const PROPAGATION_RESOLVER_CATALOGUE: readonly PropagationResolverEntry[] =
  Object.freeze([
    entry("1.1.1.1", "Cloudflare", "Cloudflare", "Global", true),
    entry("1.0.0.1", "Cloudflare (secondary)", "Cloudflare", "Global", false),
    entry("8.8.8.8", "Google", "Google", "Global", true),
    entry("8.8.4.4", "Google (secondary)", "Google", "Global", false),
    entry("9.9.9.9", "Quad9", "Quad9", "Global", true),
    entry("149.112.112.112", "Quad9 (secondary)", "Quad9", "Global", false),
    entry("208.67.222.222", "OpenDNS", "Cisco OpenDNS", "Global", true),
    entry(
      "208.67.220.220",
      "OpenDNS (secondary)",
      "Cisco OpenDNS",
      "Global",
      false,
    ),
    entry("185.228.168.9", "CleanBrowsing", "CleanBrowsing", "Global", true),
    entry("76.76.19.19", "Alternate DNS", "Alternate DNS", "US", false),
    entry("94.140.14.14", "AdGuard", "AdGuard", "Global", true),
    entry("8.26.56.26", "Comodo", "Comodo Secure DNS", "US", true),
    entry("4.2.2.2", "Level3 / Lumen", "Lumen", "US", true),
    entry("64.6.64.6", "Neustar UltraDNS", "Neustar / Vercara", "US", true),
    entry("84.200.69.80", "DNS.WATCH", "DNS.WATCH", "Germany", true),
    entry("77.88.8.8", "Yandex", "Yandex", "Russia", false),
    entry(
      "74.82.42.42",
      "Hurricane Electric",
      "Hurricane Electric",
      "US",
      true,
    ),
    entry("76.76.2.0", "Control D", "Control D", "Global", true),
    entry("45.90.28.0", "NextDNS", "NextDNS", "Global", false),
    entry(
      "156.154.70.1",
      "Neustar (secondary)",
      "Neustar / Vercara",
      "US",
      false,
    ),
    entry("101.101.101.101", "Quad101 (TWNIC)", "TWNIC", "Taiwan", false),
    entry("114.114.114.114", "114DNS", "114DNS", "China", false),
    entry("80.80.80.80", "Freenom World", "Freenom", "Global", false),
  ]);

export const DEFAULT_PROPAGATION_RESOLVER_IDS: readonly string[] =
  Object.freeze(
    PROPAGATION_RESOLVER_CATALOGUE.filter((r) => r.defaultEnabled).map(
      (r) => r.id,
    ),
  );

const CATALOGUE_IDS: ReadonlySet<string> = new Set(
  PROPAGATION_RESOLVER_CATALOGUE.map((r) => r.id),
);

export function isCataloguePropagationResolverId(id: string): boolean {
  return CATALOGUE_IDS.has(id);
}

/** Clamp ranges — must match `limits.rs` / the Rust option validation. */
export const PROPAGATION_SETTING_LIMITS = Object.freeze({
  timeoutMs: Object.freeze({ min: 500, max: 15000, default: 3000 }),
  attempts: Object.freeze({ min: 1, max: 3, default: 1 }),
  consensusPercent: Object.freeze({ min: 50, max: 100, default: 100 }),
  watchIntervalS: Object.freeze({ min: 5, max: 600, default: 15 }),
  /** Custom IP literals (Rust `MAX_EXTRA_RESOLVERS`). */
  maxCustomResolvers: 32,
  /** Catalogue selection + customs combined (Rust `MAX_PROPAGATION_RESOLVERS`). */
  maxResolvers: 64,
  /** Rust `MAX_IP_LITERAL_BYTES`. */
  maxIpLiteralBytes: 45,
});

export interface PropagationSettings {
  /** Catalogue ids that are enabled. */
  resolvers: string[];
  /** User-supplied IP literals (sent as `extraResolvers`). */
  customResolvers: string[];
  timeoutMs: number;
  attempts: number;
  consensusPercent: number;
  watchIntervalS: number;
}

/** Wire options accepted by `check_dns_propagation` (camelCase; Tauri args). */
export interface PropagationCheckOptions {
  /** Catalogue ids; absent = the default-enabled set. */
  resolvers?: string[];
  timeoutMs?: number;
  attempts?: number;
  consensusPercent?: number;
}

export function clampPropagationNumber(
  value: unknown,
  limit: { min: number; max: number; default: number },
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return limit.default;
  return Math.max(limit.min, Math.min(limit.max, Math.round(n)));
}

const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/u;
const IPV6_CHARSET = /^[0-9a-fA-F:.]+$/u;

/**
 * True when `value` is a bare IPv4/IPv6 literal the Rust side would accept
 * (`IpAddr::from_str`): no zone id, no brackets, no port, ≤ 45 bytes.
 */
export function isResolverIpLiteral(value: string): boolean {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (s.length === 0 || s.length > PROPAGATION_SETTING_LIMITS.maxIpLiteralBytes)
    return false;
  if (IPV4_PATTERN.test(s)) return true;
  if (!s.includes(":") || !IPV6_CHARSET.test(s)) return false;
  try {
    // `URL` canonicalises IPv6 hosts and rejects anything malformed.
    const url = new URL(`http://[${s}]/`);
    return url.hostname.startsWith("[") && url.hostname.endsWith("]");
  } catch {
    return false;
  }
}

/** Trim, drop invalid/duplicate literals, cap at the custom-resolver limit. */
export function normalizeCustomResolvers(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (!isResolverIpLiteral(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= PROPAGATION_SETTING_LIMITS.maxCustomResolvers) break;
  }
  return out;
}

/** Keep only known catalogue ids, in catalogue order, without duplicates. */
export function normalizeResolverIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [...DEFAULT_PROPAGATION_RESOLVER_IDS];
  const wanted = new Set(
    values
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim()),
  );
  return PROPAGATION_RESOLVER_CATALOGUE.filter((r) => wanted.has(r.id)).map(
    (r) => r.id,
  );
}

export function defaultPropagationSettings(): PropagationSettings {
  return {
    resolvers: [...DEFAULT_PROPAGATION_RESOLVER_IDS],
    customResolvers: [],
    timeoutMs: PROPAGATION_SETTING_LIMITS.timeoutMs.default,
    attempts: PROPAGATION_SETTING_LIMITS.attempts.default,
    consensusPercent: PROPAGATION_SETTING_LIMITS.consensusPercent.default,
    watchIntervalS: PROPAGATION_SETTING_LIMITS.watchIntervalS.default,
  };
}

/**
 * Fill a partial settings object with defaults and clamp every field into
 * range. Unknown resolver ids and invalid custom IPs are dropped.
 */
export function clampPropagationSettings(
  partial: Partial<PropagationSettings> | null | undefined,
): PropagationSettings {
  const p = partial ?? {};
  const limits = PROPAGATION_SETTING_LIMITS;
  return {
    resolvers: normalizeResolverIds(p.resolvers),
    customResolvers: normalizeCustomResolvers(p.customResolvers),
    timeoutMs: clampPropagationNumber(p.timeoutMs, limits.timeoutMs),
    attempts: clampPropagationNumber(p.attempts, limits.attempts),
    consensusPercent: clampPropagationNumber(
      p.consensusPercent,
      limits.consensusPercent,
    ),
    watchIntervalS: clampPropagationNumber(
      p.watchIntervalS,
      limits.watchIntervalS,
    ),
  };
}

export interface ResolvedPropagationRequest {
  resolverIds: string[];
  customResolvers: string[];
  options: PropagationCheckOptions;
}

/**
 * Turn persisted settings into what a check call needs: the catalogue ids to
 * send as `options.resolvers`, the custom IPs to send as `extraResolvers`,
 * and the numeric options. The combined count is capped at `maxResolvers`
 * (customs are dropped first, then trailing catalogue entries).
 */
export function resolvePropagationSettings(
  settings: Partial<PropagationSettings> | null | undefined,
): ResolvedPropagationRequest {
  const s = clampPropagationSettings(settings);
  let resolverIds = s.resolvers;
  let customResolvers = s.customResolvers.filter(
    (ip) => !isCataloguePropagationResolverId(ip),
  );
  const max = PROPAGATION_SETTING_LIMITS.maxResolvers;
  if (resolverIds.length + customResolvers.length > max) {
    customResolvers = customResolvers.slice(
      0,
      Math.max(0, max - resolverIds.length),
    );
    resolverIds = resolverIds.slice(0, max);
  }
  return {
    resolverIds,
    customResolvers,
    options: {
      resolvers: resolverIds,
      timeoutMs: s.timeoutMs,
      attempts: s.attempts,
      consensusPercent: s.consensusPercent,
    },
  };
}
