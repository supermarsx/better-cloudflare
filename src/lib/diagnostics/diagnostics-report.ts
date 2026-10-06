/**
 * The diagnostics payload: what a user is about to paste into a bug report.
 *
 * # The threat this module is built around
 *
 * A diagnostics blob exists to be pasted somewhere public. Every field is
 * therefore chosen on the assumption that it *will* be published, by a user
 * who did not read it first. Two things follow.
 *
 * **Credentials are absent by construction, not by filtering.** The builder
 * reads a fixed allow-list of fields from each input. The inputs are the real
 * objects — {@link DiagnosticsMcpStatus} is the actual `mcp_get_server_status`
 * reply, bearer token included; {@link DiagnosticsAiProvider} is the actual
 * provider profile, base URL included — and the builder simply never reads
 * those fields. This is deliberate: a payload assembled by projection cannot
 * leak a field that is added to an input later, because the new field is not
 * in the allow-list. A payload assembled by copy-then-redact would leak it.
 * `test/diagnosticsReport.test.ts` drives this module with inputs full of
 * credentials and asserts over the whole serialised result.
 *
 * **Identifying data is reduced to counts by default.** Zone names, domain
 * names, record names and record contents are user data. They are not secret,
 * but a user pasting diagnostics into a public issue has not consented to
 * publishing their DNS estate, and the great majority of bugs are diagnosable
 * without it: "14 zones, 212 records loaded, 38 TXT" answers the questions a
 * maintainer actually asks. So the default payload carries counts and a record
 * **type** histogram — types are a closed vocabulary and identify nothing —
 * and no names at all.
 *
 * {@link DiagnosticsOptions.includeUserData} opts in to zone names and their
 * record counts, and nothing more. Record *contents* have no opt-in at any
 * level: an SPF include list, a DKIM public key or an internal hostname in a
 * CNAME is the most sensitive non-credential material this application holds,
 * it is almost never what a bug turns on, and a user who does need to show one
 * record can quote that record. The application's own export feature exists
 * for moving record data deliberately.
 *
 * # What is scrubbed rather than projected
 *
 * Free-form text that arrives from outside — a backend's `lastError`, a
 * passkey refusal reason, a runtime error's message and stack — cannot be
 * allow-listed field by field, because the secret would be inside the prose.
 * Those strings go through a scrubber from `redaction.ts`, which applies the
 * credential patterns from `@/lib/errors/runtime-reporting` and then removes
 * the local account name, every email address, and — while user data is
 * withheld — the workspace's own zone names wherever they appear in prose.
 */
import {
  formatRuntimeDiagnostic,
  type RuntimeDiagnostic,
  type RuntimeErrorSource,
} from "@/lib/errors/runtime-reporting";
import { PROVIDER_PROTOCOLS } from "@/types/ai";

import { DEPENDENCY_TOTALS } from "@/lib/about/dependency-totals.generated";
import {
  createDiagnosticsScrubber,
  type DiagnosticsScrubber,
} from "./redaction";
import type { HostFacts, KeyringAvailability } from "./host-facts";

/** Identifies the payload shape in a pasted blob. */
export const DIAGNOSTICS_SCHEMA = "better-cloudflare-diagnostics/1";

/** Byte ceilings for the free-form strings the payload carries. */
const TEXT_LIMITS = {
  /** A backend `lastError`, a refusal reason, a webview version. */
  shortDetail: 400,
  /** One rendered runtime diagnostic, stack included. */
  runtimeError: 4000,
} as const;

/** How many recent runtime errors the payload carries. */
const MAX_RUNTIME_ERRORS = 10;

/** How many record types the histogram names before collapsing the tail. */
const MAX_RECORD_TYPES = 24;

/** How many zone names the opt-in payload carries. */
const MAX_NAMED_ZONES = 100;

// ── Inputs ──────────────────────────────────────────────────────────────────
//
// These describe the objects the collector already holds. They are wider than
// what the builder reads, on purpose: passing the real reply — token, base URL,
// record content and all — is what makes the no-secrets test meaningful.

/**
 * `mcp_get_server_status`, verbatim.
 *
 * `authToken`/`auth_token` is real: `McpServerStatus` in `bc-mcp/src/lib.rs`
 * carries the bearer token protecting the MCP server, and it is serialised to
 * the frontend. It is declared here so that it is visibly in the input and
 * visibly not in the output, and so the test can pass one.
 */
export interface DiagnosticsMcpStatus {
  running?: unknown;
  host?: unknown;
  port?: unknown;
  /** Contains the host and port, and is never read. */
  url?: unknown;
  /** The MCP bearer token. Never read. Never rendered. */
  authToken?: unknown;
  /** Snake-case spelling of the same token. Never read. */
  auth_token?: unknown;
  enabledTools?: unknown;
  enabled_tools?: unknown;
  tools?: unknown;
  lastError?: unknown;
  last_error?: unknown;
}

/** `notifications_status`, verbatim. */
export interface DiagnosticsNotificationStatus {
  running?: unknown;
  enabled?: unknown;
  paused?: unknown;
  quietHoursActive?: unknown;
  zonesTracked?: unknown;
  unread?: unknown;
  lastRecordCheckAt?: unknown;
  lastExpiryCheckAt?: unknown;
  lastAuditCheckAt?: unknown;
  nextRecordCheckAt?: unknown;
  nextExpiryCheckAt?: unknown;
  nextAuditCheckAt?: unknown;
  backoffUntil?: unknown;
  lastError?: unknown;
  lastPass?: unknown;
}

/**
 * One provider profile from `ai_list_providers`, verbatim.
 *
 * `baseUrl` is reachable in the renderer and may be a self-hosted endpoint or
 * carry userinfo credentials; `label` is free text the user typed. Neither is
 * read. `protocol` is, because it is a closed three-value set, and
 * `hasApiKey` is, because it is a boolean about a key rather than a key.
 */
export interface DiagnosticsAiProvider {
  id?: unknown;
  /** User-typed free text. Never read. */
  label?: unknown;
  protocol?: unknown;
  /** May embed credentials or name a private host. Never read. */
  baseUrl?: unknown;
  model?: unknown;
  hasApiKey?: unknown;
}

/** `biometric_status`, verbatim. */
export interface DiagnosticsBiometricStatus {
  available?: unknown;
  biometricType?: unknown;
  reason?: unknown;
}

/** `get_passkey_status`, verbatim. */
export interface DiagnosticsPasskeyStatus {
  registrationAvailable?: unknown;
  authenticationAvailable?: unknown;
  legacyCredentialsRequireReregistration?: unknown;
  unavailableReason?: unknown;
  nativeCeremony?: unknown;
  nativeClient?: unknown;
}

/**
 * One DNS record exactly as the workspace holds it.
 *
 * The index signature is the point: the collector hands over the real records,
 * content and comments included, and the builder reads `type` alone. A record
 * field added to the application later is covered by that without anyone
 * revisiting this file.
 */
export interface DiagnosticsRecord {
  type?: unknown;
  [field: string]: unknown;
}

/** One zone exactly as the workspace holds it. */
export interface DiagnosticsZone {
  id?: unknown;
  name?: unknown;
  [field: string]: unknown;
}

/** One entry from `getCacheIndexEntries()`. */
export interface DiagnosticsCacheEntry {
  /** Never read; the zone's identity is not a diagnostic. */
  zoneId?: unknown;
  /** Never read. */
  zoneName?: unknown;
  ageMs?: unknown;
  expired?: unknown;
}

/** Browser-side facts, read from `window`/`navigator` by the collector. */
export interface DiagnosticsBrowserFacts {
  /** The webview's user agent. Carries the OS release, which Rust does not. */
  userAgent?: string | null;
  language?: string | null;
  /** IANA zone from `Intl.DateTimeFormat`. */
  timeZone?: string | null;
  viewportWidth?: number | null;
  viewportHeight?: number | null;
  devicePixelRatio?: number | null;
  online?: boolean | null;
  /** `(prefers-color-scheme: dark)`. */
  prefersDarkColorScheme?: boolean | null;
  /** `(prefers-reduced-motion: reduce)`. */
  prefersReducedMotion?: boolean | null;
}

/**
 * Dev-server facts, for a desktop shell pointed at `next dev`.
 *
 * There is deliberately no field for the dev identity token. That token is a
 * per-launch secret that proves a dev server is this checkout's
 * (`src/lib/dev-identity.ts`), and none of the credential patterns would
 * recognise it as one — it is 43 characters of base64url and looks like
 * nothing. It is excluded by having nowhere to go.
 */
export interface DiagnosticsDevFacts {
  port?: number | null;
  /** The page's origin, which is `http://localhost:<port>` in development. */
  origin?: string | null;
}

/** Counts the workspace can report about itself. */
export interface DiagnosticsWorkspaceCounts {
  zoneTabsOpen?: number | null;
  zonesAvailable?: number | null;
  apiCredentialsStored?: number | null;
  registrarCredentialsStored?: number | null;
  passkeysRegistered?: number | null;
}

/** Everything the builder is given. Every field may be absent. */
export interface DiagnosticsSnapshot {
  capturedAt?: Date | string | null;
  shell?: "desktop" | "browser" | null;
  hostFacts?: HostFacts | null;
  browser?: DiagnosticsBrowserFacts | null;
  dev?: DiagnosticsDevFacts | null;
  biometrics?: DiagnosticsBiometricStatus | null;
  passkeys?: DiagnosticsPasskeyStatus | null;
  mcp?: DiagnosticsMcpStatus | null;
  notifications?: DiagnosticsNotificationStatus | null;
  aiProviders?: readonly DiagnosticsAiProvider[] | null;
  counts?: DiagnosticsWorkspaceCounts | null;
  zones?: readonly DiagnosticsZone[] | null;
  records?: readonly DiagnosticsRecord[] | null;
  cache?: readonly DiagnosticsCacheEntry[] | null;
  runtimeErrors?: readonly RuntimeDiagnostic[] | null;
}

export interface DiagnosticsOptions {
  /**
   * Include zone names and their record counts.
   *
   * Defaults to `false` and must stay that way: the user who benefits from
   * leaving it off is the one who did not read the blob before pasting it.
   */
  includeUserData?: boolean;
}

// ── Payload ─────────────────────────────────────────────────────────────────

export interface DiagnosticsBuildSection {
  /** The `YY.N` release tag, or `null` for an unstamped local build. */
  releaseTag: string | null;
  /** What to show a user: the tag, or an explicit "unstamped" phrase. */
  versionLabel: string;
  /** `tauri.conf.json`'s placeholder. Labelled, never used as the version. */
  bundleVersion: string | null;
  buildProfile: string | null;
  shell: "desktop" | "browser";
  tauriVersion: string | null;
  webviewVersion: string | null;
  appName: string | null;
}

export interface DiagnosticsPlatformSection {
  /** The target the binary was compiled for, e.g. `"windows"`. */
  os: string | null;
  arch: string | null;
  family: string | null;
  /** The OS release is only legible here; Rust reports no version. */
  userAgent: string | null;
  language: string | null;
  timeZone: string | null;
  viewport: { width: number; height: number } | null;
  devicePixelRatio: number | null;
  online: boolean | null;
  prefersDarkColorScheme: boolean | null;
  prefersReducedMotion: boolean | null;
}

export interface DiagnosticsSecuritySection {
  keyring: { status: KeyringAvailability | "unknown"; detail: string | null };
  biometrics: {
    available: boolean | null;
    type: string | null;
    reason: string | null;
  };
  passkeys: {
    registrationAvailable: boolean | null;
    authenticationAvailable: boolean | null;
    nativeCeremony: boolean | null;
    nativeClient: string | null;
    legacyCredentialsRequireReregistration: boolean | null;
    unavailableReason: string | null;
    registered: number | null;
  };
}

/** Where the MCP server is listening, without naming a host. */
export type McpBinding = "loopback" | "all-interfaces" | "other" | null;

export interface DiagnosticsServicesSection {
  mcp: {
    running: boolean | null;
    /** The *kind* of address, never the address. Binding to all interfaces is
     * the security-relevant fact; which interface is not. */
    binding: McpBinding;
    port: number | null;
    toolsEnabled: number | null;
    toolsAvailable: number | null;
    lastError: string | null;
  };
  notifications: {
    running: boolean | null;
    enabled: boolean | null;
    paused: boolean | null;
    quietHoursActive: boolean | null;
    zonesTracked: number | null;
    unread: number | null;
    lastRecordCheckAt: string | null;
    lastExpiryCheckAt: string | null;
    lastAuditCheckAt: string | null;
    nextRecordCheckAt: string | null;
    nextExpiryCheckAt: string | null;
    nextAuditCheckAt: string | null;
    backoffUntil: string | null;
    lastError: string | null;
    lastPass: {
      kind: string | null;
      startedAt: string | null;
      durationMs: number | null;
      zonesChecked: number | null;
      notificationsCreated: number | null;
      errors: number | null;
    } | null;
  };
  ai: {
    providersConfigured: number | null;
    /** Only values from the closed {@link PROVIDER_PROTOCOLS} set. */
    protocols: string[];
    providersWithStoredKey: number | null;
  };
}

export interface DiagnosticsCountsSection {
  zoneTabsOpen: number | null;
  zonesAvailable: number | null;
  recordsLoaded: number | null;
  /** `[type, count]`, commonest first. Types identify nothing. */
  recordTypes: { type: string; count: number }[];
  cachedZones: number | null;
  cachedZonesExpired: number | null;
  oldestCacheAgeMs: number | null;
  newestCacheAgeMs: number | null;
  apiCredentialsStored: number | null;
  registrarCredentialsStored: number | null;
}

export interface DiagnosticsErrorEntry {
  id: string;
  timestamp: string;
  source: RuntimeErrorSource;
  occurrences: number;
  /** The scrubbed rendering, identical in shape to the error dialog's. */
  detail: string;
}

export interface DiagnosticsUserDataSection {
  zones: { name: string; records: number | null }[];
  /** Set when {@link MAX_NAMED_ZONES} cut the list short. */
  omitted: number;
}

export interface DiagnosticsReport {
  schema: typeof DIAGNOSTICS_SCHEMA;
  capturedAt: string;
  /**
   * Whether zone names are included. Echoed so a maintainer reading a pasted
   * blob can tell "no zone names because none exist" from "no zone names
   * because they were withheld".
   */
  includesUserData: boolean;
  /** What this payload deliberately does not contain, in plain words. */
  withheld: string[];
  build: DiagnosticsBuildSection;
  platform: DiagnosticsPlatformSection;
  security: DiagnosticsSecuritySection;
  services: DiagnosticsServicesSection;
  counts: DiagnosticsCountsSection;
  dependencies: {
    npmDirect: number;
    npmTotal: number;
    rustDirect: number;
    rustTotal: number;
  };
  runtimeErrors: {
    retained: number;
    shown: number;
    entries: DiagnosticsErrorEntry[];
  };
  userData: DiagnosticsUserDataSection | null;
  dev: { port: number | null; origin: string | null } | null;
}

// ── Coercion helpers ────────────────────────────────────────────────────────
//
// Every input field crosses an IPC boundary, so none of it is trusted to have
// the declared type. A field that is the wrong shape becomes `null` — reported
// as unknown — rather than being coerced into a plausible-looking lie.

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A scrubber bound to one report's redaction policy, plus the byte ceiling. */
function shortTextWith(scrub: DiagnosticsScrubber) {
  return (value: unknown): string | null =>
    scrub(value, TEXT_LIMITS.shortDetail);
}

/**
 * An ISO timestamp, or `null`.
 *
 * Re-parsed rather than passed through: a timestamp is a field a reader will
 * compare against other timestamps, and anything that is not a date should not
 * look like one. Passing it through a scrub is also wrong here — it would
 * truncate rather than reject.
 */
function asTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A short identifier from a closed set.
 *
 * Used for values like a biometric type or a notification pass kind: they come
 * from a Rust enum, so anything unrecognised is a version skew rather than
 * free text, and letting arbitrary text through under a field a reader treats
 * as an enum is how prose ends up where an enum was expected.
 */
function asEnumerated(
  value: unknown,
  permitted: readonly string[],
): string | null {
  return typeof value === "string" && permitted.includes(value) ? value : null;
}

const BIOMETRIC_TYPES = [
  "touchId",
  "faceId",
  "windowsHello",
  "fingerprint",
  "none",
] as const;

const NOTIFICATION_PASS_KINDS = ["records", "expiry", "audit"] as const;

const KEYRING_STATUSES = ["available", "unavailable", "unknown"] as const;

/** `"windows"`, `"macos"`, … — short, lowercase, from `std::env::consts`. */
function asPlatformToken(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_]{1,32}$/u.test(value)
    ? value
    : null;
}

/** `"2.11.5"`, `"131.0.2903.70"` — a version, not prose. */
function asVersionToken(value: unknown): string | null {
  return typeof value === "string" && /^[0-9A-Za-z.+_-]{1,64}$/u.test(value)
    ? value
    : null;
}

/**
 * An origin, reduced to scheme, host and port.
 *
 * Re-derived from a parse rather than scrubbed as text, and that distinction
 * is the point. `location.origin` carries no path or query, but a value
 * reaching this field with one — a caller passing `href` by mistake — would
 * be carrying whatever was in the query string, and the dev-server identity
 * token is the kind of thing that lives there. A scrub would have to recognise
 * the token to remove it, and nothing can: it is 43 characters of base64url.
 * Rebuilding the origin discards everything after the authority, so there is
 * no pattern to get right.
 */
function asOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

// ── Section builders ────────────────────────────────────────────────────────

/**
 * How to describe this build's version to a person.
 *
 * `null` is never rendered as "0.0.0" or as "unknown version, probably old".
 * An unstamped build is a local `cargo build`, and saying so is both true and
 * the single most useful thing a maintainer can learn from a bug report that
 * carries it.
 */
export function describeVersion(releaseTag: string | null): string {
  return releaseTag ?? "local build (no release tag stamped)";
}

/** The bound, byte-limited short-text scrub a section builder is handed. */
type ShortText = (value: unknown) => string | null;

function buildSection(
  snapshot: DiagnosticsSnapshot,
  asShortText: ShortText,
): DiagnosticsBuildSection {
  const host = snapshot.hostFacts ?? null;
  const releaseTag =
    typeof host?.releaseTag === "string" && host.releaseTag.trim().length > 0
      ? host.releaseTag.trim()
      : null;
  return {
    releaseTag,
    versionLabel: describeVersion(releaseTag),
    bundleVersion: asVersionToken(host?.bundleVersion),
    buildProfile: asEnumerated(host?.buildProfile, ["debug", "release"]),
    shell: snapshot.shell === "desktop" ? "desktop" : "browser",
    tauriVersion: asVersionToken(host?.tauriVersion),
    webviewVersion: asVersionToken(host?.webviewVersion),
    appName: asShortText(host?.appName),
  };
}

function platformSection(
  snapshot: DiagnosticsSnapshot,
  asShortText: ShortText,
): DiagnosticsPlatformSection {
  const host = snapshot.hostFacts ?? null;
  const browser = snapshot.browser ?? null;
  const width = asCount(browser?.viewportWidth);
  const height = asCount(browser?.viewportHeight);
  return {
    os: asPlatformToken(host?.os),
    arch: asPlatformToken(host?.arch),
    family: asPlatformToken(host?.family),
    userAgent: asShortText(browser?.userAgent),
    language: asShortText(browser?.language),
    timeZone: asShortText(browser?.timeZone),
    viewport: width !== null && height !== null ? { width, height } : null,
    devicePixelRatio: asFiniteNumber(browser?.devicePixelRatio),
    online: asBoolean(browser?.online),
    prefersDarkColorScheme: asBoolean(browser?.prefersDarkColorScheme),
    prefersReducedMotion: asBoolean(browser?.prefersReducedMotion),
  };
}

function securitySection(
  snapshot: DiagnosticsSnapshot,
  asShortText: ShortText,
): DiagnosticsSecuritySection {
  const keyring = asRecord(snapshot.hostFacts?.keyring);
  const biometrics = snapshot.biometrics ?? null;
  const passkeys = snapshot.passkeys ?? null;
  return {
    keyring: {
      status:
        (asEnumerated(
          keyring.status,
          KEYRING_STATUSES,
        ) as KeyringAvailability | null) ?? "unknown",
      detail: asShortText(keyring.detail),
    },
    biometrics: {
      available: asBoolean(biometrics?.available),
      type: asEnumerated(biometrics?.biometricType, BIOMETRIC_TYPES),
      reason: asShortText(biometrics?.reason),
    },
    passkeys: {
      registrationAvailable: asBoolean(passkeys?.registrationAvailable),
      authenticationAvailable: asBoolean(passkeys?.authenticationAvailable),
      nativeCeremony: asBoolean(passkeys?.nativeCeremony),
      // Descriptive only: `"windows-webauthn"` names a broker, not a user.
      nativeClient: asShortText(passkeys?.nativeClient),
      legacyCredentialsRequireReregistration: asBoolean(
        passkeys?.legacyCredentialsRequireReregistration,
      ),
      unavailableReason: asShortText(passkeys?.unavailableReason),
      registered: asCount(snapshot.counts?.passkeysRegistered),
    },
  };
}

/**
 * Classify the MCP bind address without reporting it.
 *
 * `0.0.0.0` and `::` mean the server is reachable from the network, which is a
 * fact a maintainer needs. *Which* address it is reachable at is not, and on a
 * machine with a routable address it would be a network location.
 */
export function classifyMcpBinding(host: unknown): McpBinding {
  if (typeof host !== "string") return null;
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (normalized.length === 0) return null;
  if (normalized === "localhost" || normalized === "::1") return "loopback";
  if (/^127\./u.test(normalized)) return "loopback";
  if (normalized === "0.0.0.0" || normalized === "::") return "all-interfaces";
  return "other";
}

function mcpSummary(
  status: DiagnosticsMcpStatus | null,
  asShortText: ShortText,
): DiagnosticsServicesSection["mcp"] {
  const tools = asArray(status?.tools);
  const enabled = status
    ? asArray(status.enabledTools ?? status.enabled_tools)
    : [];
  return {
    running: asBoolean(status?.running),
    binding: classifyMcpBinding(status?.host),
    port: asCount(status?.port),
    toolsEnabled: status ? enabled.length : null,
    toolsAvailable: status ? tools.length : null,
    lastError: asShortText(status?.lastError ?? status?.last_error),
  };
}

function notificationsSummary(
  status: DiagnosticsNotificationStatus | null,
  asShortText: ShortText,
): DiagnosticsServicesSection["notifications"] {
  const pass = status?.lastPass != null ? asRecord(status.lastPass) : null;
  return {
    running: asBoolean(status?.running),
    enabled: asBoolean(status?.enabled),
    paused: asBoolean(status?.paused),
    quietHoursActive: asBoolean(status?.quietHoursActive),
    zonesTracked: asCount(status?.zonesTracked),
    unread: asCount(status?.unread),
    lastRecordCheckAt: asTimestamp(status?.lastRecordCheckAt),
    lastExpiryCheckAt: asTimestamp(status?.lastExpiryCheckAt),
    lastAuditCheckAt: asTimestamp(status?.lastAuditCheckAt),
    nextRecordCheckAt: asTimestamp(status?.nextRecordCheckAt),
    nextExpiryCheckAt: asTimestamp(status?.nextExpiryCheckAt),
    nextAuditCheckAt: asTimestamp(status?.nextAuditCheckAt),
    backoffUntil: asTimestamp(status?.backoffUntil),
    lastError: asShortText(status?.lastError),
    lastPass:
      pass === null
        ? null
        : {
            kind: asEnumerated(pass.kind, NOTIFICATION_PASS_KINDS),
            startedAt: asTimestamp(pass.startedAt),
            durationMs: asCount(pass.durationMs),
            zonesChecked: asCount(pass.zonesChecked),
            notificationsCreated: asCount(pass.notificationsCreated),
            errors: asCount(pass.errors),
          },
  };
}

function aiSummary(
  providers: readonly DiagnosticsAiProvider[] | null,
): DiagnosticsServicesSection["ai"] {
  if (providers === null) {
    return {
      providersConfigured: null,
      protocols: [],
      providersWithStoredKey: null,
    };
  }
  const protocols = new Set<string>();
  let withKey = 0;
  for (const provider of providers) {
    const protocol = asEnumerated(provider.protocol, PROVIDER_PROTOCOLS);
    if (protocol !== null) protocols.add(protocol);
    if (provider.hasApiKey === true) withKey += 1;
  }
  return {
    providersConfigured: providers.length,
    protocols: [...protocols].sort(),
    providersWithStoredKey: withKey,
  };
}

/**
 * Count records by type.
 *
 * A type is a short token from the DNS type registry, so it is validated as
 * one: a `type` field holding something else is counted under `"other"` rather
 * than printed, because a record whose type field contains prose would
 * otherwise put that prose in the payload.
 */
function recordTypeHistogram(
  records: readonly DiagnosticsRecord[],
): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const type =
      typeof record.type === "string" &&
      /^[A-Za-z0-9-]{1,16}$/u.test(record.type)
        ? record.type.toUpperCase()
        : "other";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        (left.type < right.type ? -1 : left.type > right.type ? 1 : 0),
    );
  if (sorted.length <= MAX_RECORD_TYPES) return sorted;
  const tail = sorted.slice(MAX_RECORD_TYPES);
  return [
    ...sorted.slice(0, MAX_RECORD_TYPES),
    {
      type: `${tail.length} further types`,
      count: tail.reduce((total, entry) => total + entry.count, 0),
    },
  ];
}

function countsSection(
  snapshot: DiagnosticsSnapshot,
): DiagnosticsCountsSection {
  const cache = snapshot.cache ?? null;
  const ages =
    cache
      ?.map((entry) => asFiniteNumber(entry.ageMs))
      .filter((age): age is number => age !== null) ?? [];
  return {
    zoneTabsOpen: asCount(snapshot.counts?.zoneTabsOpen),
    zonesAvailable:
      asCount(snapshot.counts?.zonesAvailable) ??
      snapshot.zones?.length ??
      null,
    recordsLoaded: snapshot.records?.length ?? null,
    recordTypes: recordTypeHistogram(snapshot.records ?? []),
    cachedZones: cache?.length ?? null,
    cachedZonesExpired:
      cache?.filter((entry) => entry.expired === true).length ?? null,
    oldestCacheAgeMs: ages.length > 0 ? Math.max(...ages) : null,
    newestCacheAgeMs: ages.length > 0 ? Math.min(...ages) : null,
    apiCredentialsStored: asCount(snapshot.counts?.apiCredentialsStored),
    registrarCredentialsStored: asCount(
      snapshot.counts?.registrarCredentialsStored,
    ),
  };
}

/**
 * Project the retained runtime errors.
 *
 * {@link formatRuntimeDiagnostic} does the rendering, so the text here is the
 * same text the error dialog shows — one format, so a user who recognises the
 * dialog recognises the blob. The result still goes through the scrub, because
 * the dialog's audience is the person at the keyboard and this one's is the
 * internet: a stack trace holds absolute paths, and those hold the account
 * name.
 */
function runtimeErrorSection(
  diagnostics: readonly RuntimeDiagnostic[] | null,
  scrub: DiagnosticsScrubber,
): DiagnosticsReport["runtimeErrors"] {
  if (diagnostics === null) {
    return { retained: 0, shown: 0, entries: [] };
  }
  const entries = diagnostics
    .slice(0, MAX_RUNTIME_ERRORS)
    .map((diagnostic) => ({
      id: diagnostic.id,
      timestamp: asTimestamp(diagnostic.timestamp) ?? diagnostic.timestamp,
      source: diagnostic.source,
      occurrences: asCount(diagnostic.occurrences) ?? 1,
      detail:
        scrub(formatRuntimeDiagnostic(diagnostic), TEXT_LIMITS.runtimeError) ??
        "(no detail)",
    }));
  return { retained: diagnostics.length, shown: entries.length, entries };
}

/**
 * The opt-in section: zone names, and how many records each holds.
 *
 * A zone name is a domain the user controls, so this is the one part of the
 * payload that identifies them, and it exists only because "zone X does not
 * refresh" is sometimes the bug. Record names and contents are not here at any
 * opt-in level — see the module comment.
 */
function userDataSection(
  snapshot: DiagnosticsSnapshot,
  asShortText: ShortText,
): DiagnosticsUserDataSection {
  const zones = snapshot.zones ?? [];
  const recordsByZone = new Map<string, number>();
  for (const record of snapshot.records ?? []) {
    const zoneId = record.zone_id ?? record.zoneId;
    if (typeof zoneId !== "string") continue;
    recordsByZone.set(zoneId, (recordsByZone.get(zoneId) ?? 0) + 1);
  }

  const named = zones.slice(0, MAX_NAMED_ZONES).flatMap((zone) => {
    const name = asShortText(zone.name);
    if (name === null) return [];
    const zoneId = typeof zone.id === "string" ? zone.id : null;
    return [
      {
        name,
        records: zoneId === null ? null : (recordsByZone.get(zoneId) ?? 0),
      },
    ];
  });
  return {
    zones: named,
    omitted: Math.max(0, zones.length - named.length),
  };
}

/**
 * What the payload leaves out, stated in the payload.
 *
 * This is for the maintainer who reads a pasted blob and wonders whether a
 * missing field means "absent" or "withheld", and for the user who skims
 * before pasting. It is generated from the policy rather than written once in
 * the UI, so the blob is self-describing wherever it ends up.
 */
function withheldNotes(includeUserData: boolean): string[] {
  return [
    "API keys, bearer tokens, passwords and anything held in the OS keyring",
    "the MCP server's bearer token and URL",
    "AI provider base URLs, labels and API keys",
    "DNS record names, contents and comments",
    "email addresses and account identifiers",
    includeUserData
      ? "zone names are included, at the user's request"
      : "zone and domain names, reported as counts only",
    "the local account name in file paths",
  ];
}

/**
 * The opaque identifiers this workspace holds, for the literal redactor.
 *
 * Zone ids and account ids, from the zones and the records. They cannot be
 * recognised by shape — a Cloudflare id is 32 undifferentiated hex characters
 * — so the only way to remove one from an error message is to know it.
 */
function collectWorkspaceIdentifiers(snapshot: DiagnosticsSnapshot): string[] {
  const identifiers = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) identifiers.add(value);
  };
  for (const zone of snapshot.zones ?? []) {
    add(zone.id);
    const account = zone.account;
    if (typeof account === "object" && account !== null) {
      add((account as Record<string, unknown>).id);
    }
  }
  for (const record of snapshot.records ?? []) {
    add(record.zone_id);
    add(record.zoneId);
  }
  for (const entry of snapshot.cache ?? []) {
    add(entry.zoneId);
  }
  return [...identifiers];
}

/**
 * Build the payload.
 *
 * Pure: same snapshot in, same payload out, no clock and no globals read
 * except through {@link DiagnosticsSnapshot.capturedAt}. That is what lets
 * `test/diagnosticsReport.test.ts` drive it with a snapshot full of
 * credentials and assert over the whole serialised result.
 */
export function buildDiagnosticsReport(
  snapshot: DiagnosticsSnapshot,
  options: DiagnosticsOptions = {},
): DiagnosticsReport {
  const includesUserData = options.includeUserData === true;
  const workspaceIdentifiers = collectWorkspaceIdentifiers(snapshot);

  // Two scrubbers, because the opt-in has exactly one channel. `scrub` removes
  // the workspace's zone names from every free-form string, opt-in or not: the
  // consented channel is the labelled `userData` section a user can read
  // before pasting, and an error message buried in a stack is not it.
  // `scrubPreservingNames` is that section's own scrubber — it still removes
  // credentials, paths, emails and identifiers, but not the names the section
  // exists to print.
  const scrub = createDiagnosticsScrubber({
    zoneNames: (snapshot.zones ?? []).flatMap((zone) =>
      typeof zone.name === "string" ? [zone.name] : [],
    ),
    identifiers: workspaceIdentifiers,
  });
  const scrubPreservingNames = createDiagnosticsScrubber({
    identifiers: workspaceIdentifiers,
  });
  const asShortText = shortTextWith(scrub);

  return {
    schema: DIAGNOSTICS_SCHEMA,
    capturedAt: asTimestamp(snapshot.capturedAt) ?? new Date(0).toISOString(),
    includesUserData,
    withheld: withheldNotes(includesUserData),
    build: buildSection(snapshot, asShortText),
    platform: platformSection(snapshot, asShortText),
    security: securitySection(snapshot, asShortText),
    services: {
      mcp: mcpSummary(snapshot.mcp ?? null, asShortText),
      notifications: notificationsSummary(
        snapshot.notifications ?? null,
        asShortText,
      ),
      ai: aiSummary(snapshot.aiProviders ?? null),
    },
    counts: countsSection(snapshot),
    dependencies: {
      npmDirect: DEPENDENCY_TOTALS.npm.direct,
      npmTotal: DEPENDENCY_TOTALS.npm.total,
      rustDirect: DEPENDENCY_TOTALS.rust.direct,
      rustTotal: DEPENDENCY_TOTALS.rust.total,
    },
    runtimeErrors: runtimeErrorSection(snapshot.runtimeErrors ?? null, scrub),
    userData: includesUserData
      ? userDataSection(snapshot, shortTextWith(scrubPreservingNames))
      : null,
    dev:
      snapshot.dev == null
        ? null
        : {
            port: asCount(snapshot.dev.port),
            origin: asOrigin(snapshot.dev.origin),
          },
  };
}
