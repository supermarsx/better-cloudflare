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
import { retentionReasonKind } from "@/lib/records/retention";
import { PROVIDER_PROTOCOLS } from "@/types/ai";

import { DEPENDENCY_TOTALS } from "@/lib/about/dependency-totals.generated";
import {
  createDiagnosticsScrubber,
  type DiagnosticsScrubber,
} from "./redaction";
import type { HostFacts, KeyringAvailability } from "./host-facts";

/**
 * Identifies the payload shape in a pasted blob.
 *
 * `/2` moved the notification service out of `services` into its own section
 * and added `updates`, `session` and `storage`. A reader comparing two pasted
 * reports can tell which shape each is rather than inferring it from which
 * keys happen to be present.
 */
export const DIAGNOSTICS_SCHEMA = "better-cloudflare-diagnostics/2";

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
  /**
   * `tool_count`, `prompt_count` and `resource_count` are sent by
   * `McpServerStatus` in `bc-mcp/src/lib.rs` but are absent from the frontend
   * interface in `tauri-client.ts`. They are declared here because this input
   * type describes the *reply*, not that interface — which is the same reason
   * `authToken` is declared above.
   */
  toolCount?: unknown;
  tool_count?: unknown;
  promptCount?: unknown;
  prompt_count?: unknown;
  resourceCount?: unknown;
  resource_count?: unknown;
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

/**
 * `list_retained_records`, verbatim — the recycle bin's own view of itself.
 *
 * `entries` is the trap. Each one holds a record snapshot: its name, its
 * content, its comment and the zone it came from, which is the densest
 * concentration of user data this application keeps. The builder reads each
 * entry's `reason` and nothing else, so the bin contributes counts and bytes.
 */
export interface DiagnosticsRetainedStore {
  /** Record snapshots. Only `reason` is ever read off one. */
  entries?: unknown;
  expiredPendingPurge?: unknown;
  totalHeld?: unknown;
  bytesHeld?: unknown;
  maxBytes?: unknown;
  maxEntries?: unknown;
}

/**
 * `audit_trail_summary`, verbatim.
 *
 * Already counts by the time it arrives: the command computes this host-side
 * precisely so a trail entry never crosses the IPC boundary. See the module
 * comment in `src-tauri/src/diagnostics_commands.rs`, and
 * `test/diagnosticsAuditIsolation.test.ts`.
 */
export interface DiagnosticsAuditSummary {
  entries?: unknown;
  capacity?: unknown;
  oldestAt?: unknown;
  newestAt?: unknown;
  byActor?: unknown;
  byOutcome?: unknown;
}

/**
 * One persona from `ai_list_personas`, verbatim.
 *
 * `name`, `description` and `systemPrompt` are all free text the user wrote —
 * a system prompt especially can contain anything, including the zone names
 * and record values they were working on. None of the three is read; a persona
 * contributes one to a count and whether it is built in.
 */
export interface DiagnosticsAiPersona {
  id?: unknown;
  /** Free text. Never read. */
  name?: unknown;
  /** Free text. Never read. */
  description?: unknown;
  /** Free text, and the longest of the three. Never read. */
  systemPrompt?: unknown;
  builtin?: unknown;
}

/** `ai_get_permissions`, verbatim: the stored policy plus what it resolves to. */
export interface DiagnosticsAiPermissions {
  mode?: unknown;
  /** Per-tool overrides. Counted by value; tool names are not reported. */
  tools?: unknown;
  /** The catalogue. Only its length is read. */
  catalog?: unknown;
  availability?: unknown;
}

/**
 * An `UpdateCheck` as `update_check` returned it, verbatim.
 *
 * Nothing here is user data: the releases list is public and the request is
 * unauthenticated. `latest.url` is validated host-side to be a `github.com`
 * page before it is returned, and is still reported as a tag rather than a URL
 * — a tag is what a reader needs, and a URL is a thing that could later point
 * somewhere else.
 */
export interface DiagnosticsUpdateCheck {
  current?: unknown;
  latest?: unknown;
  status?: unknown;
  checkedAt?: unknown;
}

/** The update-check preferences, from `storageManager`. */
export interface DiagnosticsUpdateSettings {
  enabled?: unknown;
  intervalHours?: unknown;
  includePrereleases?: unknown;
  lastCheckedAt?: unknown;
  due?: unknown;
}

/**
 * How long this window has been open.
 *
 * The *page's* lifetime, not the process's, and labelled that way. It is the
 * number that actually explains stale frontend state, a leaked listener or a
 * cache that should have expired — and unlike a process start time it needs no
 * hook in `main.rs`.
 */
export interface DiagnosticsSessionFacts {
  /** `performance.timeOrigin` as an ISO timestamp. */
  startedAt?: unknown;
  uptimeMs?: unknown;
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
  session?: DiagnosticsSessionFacts | null;
  dev?: DiagnosticsDevFacts | null;
  biometrics?: DiagnosticsBiometricStatus | null;
  passkeys?: DiagnosticsPasskeyStatus | null;
  mcp?: DiagnosticsMcpStatus | null;
  notifications?: DiagnosticsNotificationStatus | null;
  aiProviders?: readonly DiagnosticsAiProvider[] | null;
  aiPersonas?: readonly DiagnosticsAiPersona[] | null;
  aiPermissions?: DiagnosticsAiPermissions | null;
  retainedStore?: DiagnosticsRetainedStore | null;
  auditSummary?: DiagnosticsAuditSummary | null;
  updateCheck?: DiagnosticsUpdateCheck | null;
  updateSettings?: DiagnosticsUpdateSettings | null;
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
  /**
   * What the OS says about itself — `"Windows 11 Professional 10.0.26200"`.
   *
   * The reason `os_info` is a dependency. {@link os} is the compile target and
   * carries no release, and the user agent cannot substitute: every Windows 11
   * reports `Windows NT 10.0` in its UA by design.
   */
  osName: string | null;
  osVersion: string | null;
  osEdition: string | null;
  osCodename: string | null;
  osBitness: string | null;
  /** The machine's architecture, which an emulated build's differs from. */
  machineArch: string | null;
  userAgent: string | null;
  language: string | null;
  timeZone: string | null;
  viewport: { width: number; height: number } | null;
  devicePixelRatio: number | null;
  online: boolean | null;
  prefersDarkColorScheme: boolean | null;
  prefersReducedMotion: boolean | null;
}

/** How long this window has been open. See {@link DiagnosticsSessionFacts}. */
export interface DiagnosticsSessionSection {
  startedAt: string | null;
  uptimeMs: number | null;
}

/** What update checking has been doing. */
export interface DiagnosticsUpdatesSection {
  checkEnabled: boolean | null;
  intervalHours: number | null;
  includePrereleases: boolean | null;
  lastCheckedAt: string | null;
  /** Whether a check is overdue right now, by the stored interval. */
  checkDue: boolean | null;
  /**
   * The last check's verdict, if one ran in this session. Not persisted
   * anywhere, so `null` means "no check this session" and never "up to date".
   */
  lastStatus: string | null;
  lastCheckAt: string | null;
  /** The release the last check settled on, as a `YY.N` tag — never a URL. */
  latestSeenTag: string | null;
  latestSeenPublishedAt: string | null;
  latestIsPrerelease: boolean | null;
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

/** One pass the notification service ran, in counters. */
export interface DiagnosticsNotificationPass {
  startedAt: string | null;
  durationMs: number | null;
  zonesChecked: number | null;
  notificationsCreated: number | null;
  /**
   * Existing expiry notices whose countdown the pass brought up to date, and
   * notices withdrawn because the date they were written for changed.
   *
   * `PassReport` in `bc-notify/src/lib.rs` counts both; the `PassSummary` that
   * `notifications_status` returns does not yet carry them, so these read
   * `null` until it does. They are declared and read here so that the moment
   * the Rust side forwards them the report shows them, with no change needed
   * on this side — see the note in the handover for the four-field addition.
   */
  notificationsRefreshed: number | null;
  notificationsSuperseded: number | null;
  errors: number | null;
  /** The pass did nothing because settings disabled it. */
  skipped: boolean | null;
  /** The pass saw 429/5xx and asked the caller to back off. */
  backoff: boolean | null;
}

/**
 * The notification service, in its own section rather than under `services`.
 *
 * "Why did I not get a notification" is the commonest question a diagnostics
 * report could answer, and answering it needs all of this at once: whether the
 * service is running, whether it is paused, whether quiet hours are in force
 * *now*, when each kind of pass last ran and next will, and what the last pass
 * of each kind actually did.
 */
export interface DiagnosticsNotificationsSection {
  running: boolean | null;
  enabled: boolean | null;
  paused: boolean | null;
  /** Evaluated host-side at collection time, so it means "right now". */
  quietHoursActive: boolean | null;
  zonesTracked: number | null;
  unread: number | null;
  backoffUntil: string | null;
  lastError: string | null;
  /** Keyed by pass kind, so a missing kind is visibly a kind that never ran. */
  passes: {
    kind: string;
    lastCheckAt: string | null;
    nextCheckAt: string | null;
    /** Only the most recent pass overall is retained by the service, so at
     * most one kind carries counters. */
    lastPass: DiagnosticsNotificationPass | null;
  }[];
}

export interface DiagnosticsServicesSection {
  mcp: {
    running: boolean | null;
    /** The *kind* of address, never the address. Binding to all interfaces is
     * the security-relevant fact; which interface is not. */
    binding: McpBinding;
    port: number | null;
    toolsEnabled: number | null;
    toolsAvailable: number | null;
    promptsAvailable: number | null;
    resourcesAvailable: number | null;
    lastError: string | null;
  };
  assistant: {
    providersConfigured: number | null;
    /** Only values from the closed {@link PROVIDER_PROTOCOLS} set. */
    protocols: string[];
    providersWithStoredKey: number | null;
    personasTotal: number | null;
    personasBuiltin: number | null;
    personasCustom: number | null;
    /** `readOnly` / `ask` / `autonomous`, or `null` when unreadable. */
    permissionMode: string | null;
    /** How many tools carry an explicit override, by the value chosen. */
    toolOverrides: { allow: number; ask: number; deny: number } | null;
    /** From `AiToolAvailability`: what can actually be dispatched now. */
    dispatchAvailable: boolean | null;
    toolsGranted: number | null;
    toolsUsable: number | null;
    toolsRegistered: number | null;
  };
}

/** What the recycle bin is holding, and what it is spending. */
export interface DiagnosticsRecycleBinSection {
  entriesHeld: number | null;
  /** Records taken out of service but not deleted. Never evicted to make room. */
  disabled: number | null;
  /** Records deleted at Cloudflare and restorable from here. */
  binned: number | null;
  /** A `reason` this build does not know — a newer build wrote it. */
  unknownReason: number | null;
  expiredPendingPurge: number | null;
  bytesHeld: number | null;
  maxBytes: number | null;
  maxEntries: number | null;
  /** Rounded percentage of the byte ceiling, which is what fills up first. */
  percentOfByteCeiling: number | null;
}

/** The offline record cache, by age and count. */
export interface DiagnosticsOfflineCacheSection {
  cachedZones: number | null;
  cachedZonesExpired: number | null;
  oldestCacheAgeMs: number | null;
  newestCacheAgeMs: number | null;
}

/** The audit trail, in numbers. Never an entry. */
export interface DiagnosticsAuditTrailSection {
  entries: number | null;
  capacity: number | null;
  oldestAt: string | null;
  newestAt: string | null;
  byActor: { actor: string; count: number }[];
  byOutcome: { outcome: string; count: number }[];
}

export interface DiagnosticsStorageSection {
  recycleBin: DiagnosticsRecycleBinSection;
  offlineCache: DiagnosticsOfflineCacheSection;
  auditTrail: DiagnosticsAuditTrailSection;
}

export interface DiagnosticsCountsSection {
  zoneTabsOpen: number | null;
  zonesAvailable: number | null;
  recordsLoaded: number | null;
  /** `[type, count]`, commonest first. Types identify nothing. */
  recordTypes: { type: string; count: number }[];
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
  // The order below is the order the Markdown renders in, and it is ordered by
  // how often a section is the answer. Version and platform first because they
  // are asked of every report; notifications next because "why did I not get
  // one" is the commonest specific question; errors last because they are the
  // longest and a reader who needs them scrolls for them.
  build: DiagnosticsBuildSection;
  updates: DiagnosticsUpdatesSection;
  platform: DiagnosticsPlatformSection;
  session: DiagnosticsSessionSection;
  security: DiagnosticsSecuritySection;
  notifications: DiagnosticsNotificationsSection;
  services: DiagnosticsServicesSection;
  storage: DiagnosticsStorageSection;
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

/** `os_info::Bitness`'s whole vocabulary. */
const OS_BITNESS = ["32-bit", "64-bit", "unknown"] as const;

/** `AiPermissionMode` (`src/types/ai.ts`). */
const AI_PERMISSION_MODES = ["readOnly", "ask", "autonomous"] as const;

/** `AiToolPermission` — the value an explicit per-tool override can take. */
const AI_TOOL_PERMISSIONS = ["allow", "ask", "deny"] as const;

/** `UpdateStatus` as `bc_update` serialises it. */
const UPDATE_STATUSES = [
  "upToDate",
  "updateAvailable",
  "unknownVersion",
  "noReleases",
] as const;

/** `AuditActor::as_str` and `AuditOutcome::as_str`, the summary's two keyings. */
const AUDIT_ACTORS = ["user", "mcp_client", "assistant"] as const;
const AUDIT_OUTCOMES = ["succeeded", "failed", "denied"] as const;

/**
 * `RetentionReasonKind` (`src/lib/records/retention.ts`).
 *
 * A type rather than a value: {@link retentionReasonKind} is what maps a raw
 * `reason` onto it, so nothing here needs to compare against the list — it
 * only needs a tally with one slot per kind, which the compiler then checks is
 * exhaustive.
 */
type RetentionReasonTally = Record<
  ReturnType<typeof retentionReasonKind>,
  number
>;

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
  const release = asRecord(host?.osRelease);
  return {
    os: asPlatformToken(host?.os),
    arch: asPlatformToken(host?.arch),
    family: asPlatformToken(host?.family),
    // `os_info` reads version registries and `/etc/os-release`; its strings are
    // short tokens and short product names, so they are bounded as such rather
    // than scrubbed as prose. A value that is not token-shaped is dropped.
    osName: asShortText(release.osType),
    osVersion: asVersionToken(release.version),
    osEdition: asShortText(release.edition),
    osCodename: asShortText(release.codename),
    osBitness: asEnumerated(release.bitness, OS_BITNESS),
    machineArch: asShortText(release.architecture),
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
    // `toolCount`/`promptCount`/`resourceCount` are sent by `McpServerStatus`
    // in `bc-mcp` but are not on the frontend's declared interface; they are
    // read off the real reply, which is why every input field here is typed
    // `unknown` rather than borrowed from `tauri-client.ts`.
    promptsAvailable: asCount(status?.promptCount ?? status?.prompt_count),
    resourcesAvailable: asCount(
      status?.resourceCount ?? status?.resource_count,
    ),
    lastError: asShortText(status?.lastError ?? status?.last_error),
  };
}

/**
 * One pass's counters.
 *
 * `notificationsRefreshed` and `notificationsSuperseded` are read from the
 * reply even though the current `PassSummary` does not send them — see
 * {@link DiagnosticsNotificationPass}. Reading a field that is not there yet
 * costs nothing and means the Rust-side addition needs no change here.
 */
function notificationPass(value: unknown): DiagnosticsNotificationPass | null {
  if (value == null) return null;
  const pass = asRecord(value);
  return {
    startedAt: asTimestamp(pass.startedAt),
    durationMs: asCount(pass.durationMs),
    zonesChecked: asCount(pass.zonesChecked),
    notificationsCreated: asCount(pass.notificationsCreated),
    notificationsRefreshed: asCount(pass.notificationsRefreshed),
    notificationsSuperseded: asCount(pass.notificationsSuperseded),
    errors: asCount(pass.errors),
    skipped: asBoolean(pass.skipped),
    backoff: asBoolean(pass.backoff),
  };
}

/**
 * The notification service, one row per pass kind.
 *
 * The service retains the most recent pass overall rather than one per kind,
 * so at most one row carries counters — which is why the counters hang off the
 * row rather than the section. The per-kind timestamps are always all three.
 */
function notificationsSection(
  status: DiagnosticsNotificationStatus | null,
  asShortText: ShortText,
): DiagnosticsNotificationsSection {
  const lastPass = notificationPass(status?.lastPass);
  const lastPassKind =
    status?.lastPass != null
      ? asEnumerated(asRecord(status.lastPass).kind, NOTIFICATION_PASS_KINDS)
      : null;
  const perKind: Record<
    (typeof NOTIFICATION_PASS_KINDS)[number],
    { last: unknown; next: unknown }
  > = {
    records: {
      last: status?.lastRecordCheckAt,
      next: status?.nextRecordCheckAt,
    },
    expiry: {
      last: status?.lastExpiryCheckAt,
      next: status?.nextExpiryCheckAt,
    },
    audit: { last: status?.lastAuditCheckAt, next: status?.nextAuditCheckAt },
  };

  return {
    running: asBoolean(status?.running),
    enabled: asBoolean(status?.enabled),
    paused: asBoolean(status?.paused),
    quietHoursActive: asBoolean(status?.quietHoursActive),
    zonesTracked: asCount(status?.zonesTracked),
    unread: asCount(status?.unread),
    backoffUntil: asTimestamp(status?.backoffUntil),
    lastError: asShortText(status?.lastError),
    passes: NOTIFICATION_PASS_KINDS.map((kind) => ({
      kind,
      lastCheckAt: asTimestamp(perKind[kind].last),
      nextCheckAt: asTimestamp(perKind[kind].next),
      lastPass: kind === lastPassKind ? lastPass : null,
    })),
  };
}

/**
 * The assistant, in counts and closed-set tokens.
 *
 * Nothing user-written reaches this. A provider contributes its protocol and
 * whether a key is stored; a persona contributes one to a count; a per-tool
 * override contributes one to a tally of its *value*, never its tool name —
 * which tools someone granted is a shape of their workflow, and the four
 * availability numbers already say what can be dispatched.
 */
function assistantSection(
  providers: readonly DiagnosticsAiProvider[] | null,
  personas: readonly DiagnosticsAiPersona[] | null,
  permissions: DiagnosticsAiPermissions | null,
): DiagnosticsServicesSection["assistant"] {
  const protocols = new Set<string>();
  let withKey = 0;
  for (const provider of providers ?? []) {
    const protocol = asEnumerated(provider.protocol, PROVIDER_PROTOCOLS);
    if (protocol !== null) protocols.add(protocol);
    if (provider.hasApiKey === true) withKey += 1;
  }

  const builtin = (personas ?? []).filter(
    (persona) => persona.builtin === true,
  ).length;

  let toolOverrides: { allow: number; ask: number; deny: number } | null = null;
  if (permissions?.tools != null) {
    const tally = { allow: 0, ask: 0, deny: 0 };
    for (const value of Object.values(asRecord(permissions.tools))) {
      // Narrowed against the closed set before it is used as a key, so a
      // `tools` map carrying an unknown permission cannot widen the tally.
      for (const permission of AI_TOOL_PERMISSIONS) {
        if (value === permission) tally[permission] += 1;
      }
    }
    toolOverrides = tally;
  }

  const availability = asRecord(permissions?.availability);
  return {
    providersConfigured: providers === null ? null : providers.length,
    protocols: [...protocols].sort(),
    providersWithStoredKey: providers === null ? null : withKey,
    personasTotal: personas === null ? null : personas.length,
    personasBuiltin: personas === null ? null : builtin,
    personasCustom: personas === null ? null : personas.length - builtin,
    permissionMode: asEnumerated(permissions?.mode, AI_PERMISSION_MODES),
    toolOverrides,
    dispatchAvailable: asBoolean(availability.dispatchAvailable),
    toolsGranted: asCount(availability.grantedToolCount),
    toolsUsable: asCount(availability.usableToolCount),
    toolsRegistered: asCount(availability.registeredToolCount),
  };
}

/**
 * The recycle bin, in counts and bytes.
 *
 * `store.entries` holds a record snapshot each — name, content, comment, zone.
 * The only field read off an entry is `reason`, and it is read through
 * {@link retentionReasonKind}, which maps anything it does not recognise onto
 * `"unknown"` rather than passing the raw string through. So a `reason` field
 * carrying something other than a reason cannot become payload text.
 */
function recycleBinSection(
  store: DiagnosticsRetainedStore | null,
): DiagnosticsRecycleBinSection {
  if (store === null) {
    return {
      entriesHeld: null,
      disabled: null,
      binned: null,
      unknownReason: null,
      expiredPendingPurge: null,
      bytesHeld: null,
      maxBytes: null,
      maxEntries: null,
      percentOfByteCeiling: null,
    };
  }
  const tally: RetentionReasonTally = { disabled: 0, deleted: 0, unknown: 0 };
  for (const entry of asArray(store.entries)) {
    tally[retentionReasonKind(asRecord(entry).reason)] += 1;
  }
  const bytesHeld = asCount(store.bytesHeld);
  const maxBytes = asCount(store.maxBytes);
  return {
    // `totalHeld` counts the expired entries too, which is the honest figure
    // for "what is this store holding"; `expiredPendingPurge` says how many of
    // them are already past the point of being offered back.
    entriesHeld: asCount(store.totalHeld),
    disabled: tally.disabled,
    binned: tally.deleted,
    unknownReason: tally.unknown,
    expiredPendingPurge: asCount(store.expiredPendingPurge),
    bytesHeld,
    maxBytes,
    maxEntries: asCount(store.maxEntries),
    percentOfByteCeiling:
      bytesHeld !== null && maxBytes !== null && maxBytes > 0
        ? Math.round((bytesHeld / maxBytes) * 100)
        : null,
  };
}

/** The audit trail summary, already counted host-side. */
function auditTrailSection(
  summary: DiagnosticsAuditSummary | null,
): DiagnosticsAuditTrailSection {
  const tally = (
    value: unknown,
    permitted: readonly string[],
  ): { key: string; count: number }[] => {
    const source = asRecord(value);
    // Driven from the closed vocabulary rather than from the reply's keys, so
    // a key a newer build invented cannot put its own text in the payload, and
    // a bucket with nothing in it is still visibly zero rather than absent.
    return permitted.map((key) => ({
      key,
      count: asCount(source[key]) ?? 0,
    }));
  };
  return {
    entries: asCount(summary?.entries),
    capacity: asCount(summary?.capacity),
    oldestAt: asTimestamp(summary?.oldestAt),
    newestAt: asTimestamp(summary?.newestAt),
    byActor:
      summary == null
        ? []
        : tally(summary.byActor, AUDIT_ACTORS).map(({ key, count }) => ({
            actor: key,
            count,
          })),
    byOutcome:
      summary == null
        ? []
        : tally(summary.byOutcome, AUDIT_OUTCOMES).map(({ key, count }) => ({
            outcome: key,
            count,
          })),
  };
}

/** The offline cache, by count and age. Zone names are never read. */
function offlineCacheSection(
  cache: readonly DiagnosticsCacheEntry[] | null,
): DiagnosticsOfflineCacheSection {
  const ages =
    cache
      ?.map((entry) => asFiniteNumber(entry.ageMs))
      .filter((age): age is number => age !== null) ?? [];
  return {
    cachedZones: cache?.length ?? null,
    cachedZonesExpired:
      cache?.filter((entry) => entry.expired === true).length ?? null,
    oldestCacheAgeMs: ages.length > 0 ? Math.max(...ages) : null,
    newestCacheAgeMs: ages.length > 0 ? Math.min(...ages) : null,
  };
}

/** How long this window has been open. */
function sessionSection(
  session: DiagnosticsSessionFacts | null,
): DiagnosticsSessionSection {
  return {
    startedAt: asTimestamp(session?.startedAt),
    uptimeMs: asCount(session?.uptimeMs),
  };
}

/**
 * What update checking has been doing.
 *
 * The settings are persisted and always available; the last verdict is not
 * persisted anywhere, so it is only here when a check ran in this session.
 * `null` for `lastStatus` therefore means "not checked here", which is a
 * different thing from `upToDate` and must not read as it.
 */
function updatesSection(
  settings: DiagnosticsUpdateSettings | null,
  check: DiagnosticsUpdateCheck | null,
): DiagnosticsUpdatesSection {
  const latest = asRecord(check?.latest);
  return {
    checkEnabled: asBoolean(settings?.enabled),
    intervalHours: asCount(settings?.intervalHours),
    includePrereleases: asBoolean(settings?.includePrereleases),
    lastCheckedAt: asTimestamp(settings?.lastCheckedAt),
    checkDue: asBoolean(settings?.due),
    lastStatus: asEnumerated(check?.status, UPDATE_STATUSES),
    lastCheckAt: asTimestamp(check?.checkedAt),
    // A `YY.N` tag, validated as a version token — never `latest.url`, even
    // though the host checks that it is a github.com page. A tag is what a
    // reader needs and a URL is a thing that could later point elsewhere.
    latestSeenTag: asVersionToken(latest.tag),
    latestSeenPublishedAt: asTimestamp(latest.publishedAt),
    latestIsPrerelease: asBoolean(latest.prerelease),
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
  return {
    zoneTabsOpen: asCount(snapshot.counts?.zoneTabsOpen),
    zonesAvailable:
      asCount(snapshot.counts?.zonesAvailable) ??
      snapshot.zones?.length ??
      null,
    recordsLoaded: snapshot.records?.length ?? null,
    recordTypes: recordTypeHistogram(snapshot.records ?? []),
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
    "AI provider base URLs and labels, and assistant persona text",
    "DNS record names, contents and comments",
    "every audit trail entry — only counts and the trail's date range",
    "every recycle bin entry — only counts and bytes held",
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
  // The recycle bin holds zones the workspace may not have open — a record
  // deleted from a zone since closed. Harvesting its ids too means an error
  // message naming one is still redacted. Only the two id fields are read; the
  // snapshot alongside them is never touched.
  for (const entry of asArray(snapshot.retainedStore?.entries)) {
    const held = asRecord(entry);
    add(held.zone_id);
    add(held.zoneId);
    add(held.entry_id);
    add(held.entryId);
  }
  return [...identifiers];
}

/**
 * Zone names the scrubber should remove from prose.
 *
 * The workspace's open zones, plus the zone names the recycle bin is holding.
 * A bin entry records the zone a record came from, and an error message about
 * a failed restore would name it.
 */
function collectZoneNames(snapshot: DiagnosticsSnapshot): string[] {
  const names = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) names.add(value);
  };
  for (const zone of snapshot.zones ?? []) add(zone.name);
  for (const entry of asArray(snapshot.retainedStore?.entries)) {
    add(asRecord(entry).zone_name);
    add(asRecord(entry).zoneName);
  }
  return [...names];
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
    zoneNames: collectZoneNames(snapshot),
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
    updates: updatesSection(
      snapshot.updateSettings ?? null,
      snapshot.updateCheck ?? null,
    ),
    platform: platformSection(snapshot, asShortText),
    session: sessionSection(snapshot.session ?? null),
    security: securitySection(snapshot, asShortText),
    notifications: notificationsSection(
      snapshot.notifications ?? null,
      asShortText,
    ),
    services: {
      mcp: mcpSummary(snapshot.mcp ?? null, asShortText),
      assistant: assistantSection(
        snapshot.aiProviders ?? null,
        snapshot.aiPersonas ?? null,
        snapshot.aiPermissions ?? null,
      ),
    },
    storage: {
      recycleBin: recycleBinSection(snapshot.retainedStore ?? null),
      offlineCache: offlineCacheSection(snapshot.cache ?? null),
      auditTrail: auditTrailSection(snapshot.auditSummary ?? null),
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
