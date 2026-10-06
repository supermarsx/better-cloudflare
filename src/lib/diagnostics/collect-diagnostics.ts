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
import { getCacheIndexEntries } from "@/lib/storage/offline-cache";

import {
  buildDiagnosticsReport,
  type DiagnosticsBrowserFacts,
  type DiagnosticsDevFacts,
  type DiagnosticsOptions,
  type DiagnosticsRecord,
  type DiagnosticsReport,
  type DiagnosticsSnapshot,
  type DiagnosticsZone,
} from "./diagnostics-report";
import { fetchHostFacts } from "./host-facts";

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
  const [
    hostFacts,
    biometrics,
    passkeys,
    mcp,
    notifications,
    aiProviders,
    apiCredentialsStored,
    registrarCredentialsStored,
  ] = await Promise.all([
    desktop ? fetchHostFacts(input.signal) : Promise.resolve(null),
    desktop
      ? attempt(() => TauriClient.biometricStatus())
      : Promise.resolve(null),
    desktop
      ? attempt(() => TauriClient.getPasskeyStatus())
      : Promise.resolve(null),
    desktop
      ? attempt(() => TauriClient.getMcpServerStatus())
      : Promise.resolve(null),
    desktop
      ? attempt(() => TauriClient.notificationsStatus())
      : Promise.resolve(null),
    desktop
      ? attempt(() => TauriClient.aiListProviders())
      : Promise.resolve(null),
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
    dev: collectDevFacts(),
    biometrics,
    passkeys,
    mcp,
    notifications,
    aiProviders,
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
