/**
 * Gathering the inputs the diagnostics payload is built from.
 *
 * The split is deliberate: everything that touches the host, the browser or
 * the clock lives here, and {@link buildDiagnosticsReport} — which decides
 * what reaches the payload — is pure. That is what lets the security test
 * drive the decision-making with a handcrafted snapshot full of credentials
 * instead of having to stand up a desktop shell.
 *
 * Every probe is independent and every failure is local: a refused keyring, a
 * stopped notification service or a browser with no `Intl` support each cost
 * their own rows and nothing else. A diagnostics screen that cannot open
 * because one of its probes threw is the one outcome worth engineering
 * against, since the reason a user opened it is that something is already
 * broken.
 */
import { TauriClient } from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import { getRuntimeDiagnostics } from "@/lib/errors/runtime-reporting";
import { createRecordRetentionClient } from "@/lib/records/retention";
import { getCacheIndexEntries } from "@/lib/storage/offline-cache";
import { storageManager } from "@/lib/storage/storage";

import {
  buildDiagnosticsReport,
  type DiagnosticsBrowserFacts,
  type DiagnosticsDevFacts,
  type DiagnosticsOptions,
  type DiagnosticsRecord,
  type DiagnosticsReport,
  type DiagnosticsSessionFacts,
  type DiagnosticsSnapshot,
  type DiagnosticsUpdateCheck,
  type DiagnosticsUpdateSettings,
  type DiagnosticsZone,
} from "./diagnostics-report";
import { fetchAuditTrailSummary, fetchHostFacts } from "./host-facts";
import { hostInvoke } from "./host-invoke";

/**
 * The recycle bin's command surface, over the diagnostics invoke.
 *
 * `createRecordRetentionClient` takes an `invoke` rather than importing the
 * client, which is what lets the diagnostics collector reuse it without
 * depending on whichever component owns the bin's UI.
 */
const retentionClient = createRecordRetentionClient(
  <T>(command: string, args: Record<string, unknown>): Promise<T> =>
    hostInvoke<T>(command, args),
);

/**
 * What the caller knows and the collector cannot discover.
 *
 * Zones, records and the open tab count live in the workspace's React state,
 * so they are passed in rather than re-fetched: a diagnostics panel must
 * report what the user is looking at, and a fresh fetch would report something
 * else. The records are passed whole — the builder reads `type` and nothing
 * else, and `includeUserData` governs zone names.
 */
export interface DiagnosticsCollectionInput {
  zones?: readonly DiagnosticsZone[] | null;
  records?: readonly DiagnosticsRecord[] | null;
  zoneTabsOpen?: number | null;
  passkeysRegistered?: number | null;
  /**
   * The last `update_check` result, if one ran in this session.
   *
   * Passed in rather than fetched: a check is a network request to GitHub,
   * which rate-limits unauthenticated callers, and opening a diagnostics panel
   * must not spend one. The settings around it are persisted and read directly;
   * only the verdict needs handing over.
   */
  updateCheck?: DiagnosticsUpdateCheck | null;
  signal?: AbortSignal;
}

/** Resolve a probe to `null` rather than letting it reject. */
async function attempt<T>(probe: () => Promise<T>): Promise<T | null> {
  try {
    return await probe();
  } catch {
    return null;
  }
}

/** Count a list-returning probe, or `null` if it could not be read. */
async function count(probe: () => Promise<unknown[]>): Promise<number | null> {
  const value = await attempt(probe);
  return Array.isArray(value) ? value.length : null;
}

/**
 * The part of a `Window` the browser facts are read from.
 *
 * Declared structurally, and every member optional, because that is what the
 * reads have to cope with: jsdom, a locked-down webview and a private window
 * each omit a different one. It is also what lets
 * {@link describeBrowserFacts} be driven from a plain object in a test — the
 * test harness's `window` is a getter that cannot be replaced.
 */
export interface BrowserFactsSource {
  navigator?: { userAgent?: string; language?: string; onLine?: boolean };
  innerWidth?: number;
  innerHeight?: number;
  devicePixelRatio?: number;
  matchMedia?: (query: string) => { matches: boolean };
}

/**
 * What a webview can say about itself.
 *
 * The user agent earns its place: `std::env::consts::OS` reports the target
 * the binary was *compiled* for and carries no version, so the OS release a
 * bug reproduces on is only legible here. The time zone earns its place too —
 * quiet hours and expiry milestones are scheduled against it, which makes it
 * the first thing to check on a "notified at the wrong time" report.
 *
 * Every read is guarded on its own, so one missing capability costs one row.
 */
export function describeBrowserFacts(
  source: BrowserFactsSource,
): DiagnosticsBrowserFacts {
  const media = (query: string): boolean | null => {
    try {
      return source.matchMedia?.(query).matches ?? null;
    } catch {
      return null;
    }
  };
  const resolvedTimeZone = (): string | null => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    } catch {
      return null;
    }
  };
  // Read through the window rather than from the bare `navigator` global, so
  // both reads are pointed at the same object.
  const agent = source.navigator;
  return {
    userAgent: agent?.userAgent ?? null,
    language: agent?.language ?? null,
    timeZone: resolvedTimeZone(),
    viewportWidth: source.innerWidth ?? null,
    viewportHeight: source.innerHeight ?? null,
    devicePixelRatio: source.devicePixelRatio ?? null,
    online: agent?.onLine ?? null,
    prefersDarkColorScheme: media("(prefers-color-scheme: dark)"),
    prefersReducedMotion: media("(prefers-reduced-motion: reduce)"),
  };
}

/** {@link describeBrowserFacts} for the real window, or `null` with no window. */
export function collectBrowserFacts(): DiagnosticsBrowserFacts | null {
  if (typeof window === "undefined") return null;
  return describeBrowserFacts(window);
}

/** The part of a `Location` the dev-server detection reads. */
export interface LocationSource {
  hostname?: string;
  port?: string;
  protocol?: string;
  origin?: string;
}

/**
 * The dev server this page came from, or `null` for a production bundle.
 *
 * Only the port and the origin. The dev identity token that proves a server is
 * this checkout's is a per-launch secret and is deliberately not collected:
 * the webview cannot read it from a response header anyway, but the point is
 * that there is no code path from it to a payload. See `DiagnosticsDevFacts`,
 * and the origin's own parse in `diagnostics-report.ts`.
 */
export function describeDevServer(
  location: LocationSource,
): DiagnosticsDevFacts | null {
  const isLoopback =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "[::1]" ||
    location.hostname === "::1";
  // A production desktop bundle serves from the custom protocol, and its host
  // happens to be loopback-shaped, so the protocol has to be checked too.
  if (!isLoopback || location.protocol !== "http:") return null;
  const port = Number.parseInt(location.port ?? "", 10);
  return {
    port: Number.isInteger(port) ? port : null,
    origin: location.origin ?? null,
  };
}

/** {@link describeDevServer} for the real location. */
export function collectDevFacts(): DiagnosticsDevFacts | null {
  if (typeof window === "undefined") return null;
  return describeDevServer(window.location);
}

/**
 * Run every probe and assemble the snapshot.
 *
 * The host-side probes run concurrently — they are independent reads and a
 * diagnostics panel should not take the sum of their latencies to open. On the
 * web there is no host, so they are skipped rather than attempted and failed.
 */
export async function collectDiagnosticsSnapshot(
  input: DiagnosticsCollectionInput = {},
): Promise<DiagnosticsSnapshot> {
  const desktop = isDesktop();
  const onDesktop = <T>(probe: () => Promise<T>): Promise<T | null> =>
    desktop ? attempt(probe) : Promise.resolve(null);

  const [
    hostFacts,
    biometrics,
    passkeys,
    mcp,
    notifications,
    aiProviders,
    aiPersonas,
    aiPermissions,
    retainedStore,
    auditSummary,
    apiCredentialsStored,
    registrarCredentialsStored,
  ] = await Promise.all([
    desktop ? fetchHostFacts(input.signal) : Promise.resolve(null),
    onDesktop(() => TauriClient.biometricStatus()),
    onDesktop(() => TauriClient.getPasskeyStatus()),
    onDesktop(() => TauriClient.getMcpServerStatus()),
    onDesktop(() => TauriClient.notificationsStatus()),
    onDesktop(() => TauriClient.aiListProviders()),
    onDesktop(() => TauriClient.aiListPersonas()),
    onDesktop(() => TauriClient.aiGetPermissions()),
    // Reading the bin does not purge it: `list_retained_records` says so
    // explicitly, which is what makes it safe to call from a screen whose only
    // job is to look.
    onDesktop(() => retentionClient.list()),
    desktop ? fetchAuditTrailSummary(input.signal) : Promise.resolve(null),
    desktop ? count(() => TauriClient.getApiKeys()) : Promise.resolve(null),
    desktop
      ? count(() => TauriClient.listRegistrarCredentials())
      : Promise.resolve(null),
  ]);

  return {
    capturedAt: new Date(),
    shell: desktop ? "desktop" : "browser",
    hostFacts,
    browser: collectBrowserFacts(),
    session: collectSessionFacts(),
    dev: collectDevFacts(),
    biometrics,
    passkeys,
    mcp,
    notifications,
    aiProviders,
    aiPersonas,
    aiPermissions,
    retainedStore,
    auditSummary,
    updateCheck: input.updateCheck ?? null,
    updateSettings: attemptSync(() => collectUpdateSettings()),
    counts: {
      zoneTabsOpen: input.zoneTabsOpen ?? null,
      zonesAvailable: input.zones?.length ?? null,
      apiCredentialsStored,
      registrarCredentialsStored,
      passkeysRegistered: input.passkeysRegistered ?? null,
    },
    zones: input.zones ?? null,
    records: input.records ?? null,
    cache: attemptSync(() => getCacheIndexEntries()),
    runtimeErrors: getRuntimeDiagnostics(),
  };
}

/**
 * The update-check preferences as stored.
 *
 * `due` is evaluated here rather than stored, because "is a check overdue" is
 * a question about now — a report that said "due" an hour ago answers nothing.
 */
export function collectUpdateSettings(): DiagnosticsUpdateSettings {
  return {
    enabled: storageManager.getUpdateCheckEnabled(),
    intervalHours: storageManager.getUpdateCheckIntervalHours(),
    includePrereleases: storageManager.getUpdateCheckIncludePrereleases(),
    lastCheckedAt: storageManager.getUpdateCheckLastCheckedAt(),
    due: storageManager.isUpdateCheckDue(),
  };
}

/**
 * How long this window has been open.
 *
 * `performance.timeOrigin` is when the document started, which in a desktop
 * build is app launch unless the webview has been reloaded. It is labelled as
 * the window's lifetime rather than the process's for exactly that reason —
 * and it is the number that explains stale frontend state, which is what a
 * reader of this section is actually chasing.
 */
export function collectSessionFacts(): DiagnosticsSessionFacts | null {
  if (typeof performance === "undefined") return null;
  const origin = performance.timeOrigin;
  if (!Number.isFinite(origin) || origin <= 0) return null;
  return {
    startedAt: new Date(origin).toISOString(),
    uptimeMs: Math.max(0, Math.round(Date.now() - origin)),
  };
}

/** {@link attempt} for a synchronous read. */
function attemptSync<T>(probe: () => T): T | null {
  try {
    return probe();
  } catch {
    return null;
  }
}

/** Collect and build in one call: what the diagnostics panel calls. */
export async function collectDiagnosticsReport(
  input: DiagnosticsCollectionInput = {},
  options: DiagnosticsOptions = {},
): Promise<DiagnosticsReport> {
  return buildDiagnosticsReport(
    await collectDiagnosticsSnapshot(input),
    options,
  );
}
