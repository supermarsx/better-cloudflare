/**
 * The collector's own behaviour: the browser reads, the dev-server detection,
 * and that a failing probe costs its own rows and nothing else.
 *
 * What reaches the payload is decided by `buildDiagnosticsReport`, which is
 * pure and is covered by `diagnosticsReport.test.ts`. This file covers the
 * other half — that the collector copes with a webview missing half of what it
 * asks for, which is the state a diagnostics screen is most likely to be
 * opened in.
 *
 * The two readers are driven through their pure forms,
 * {@link describeBrowserFacts} and {@link describeDevServer}, because the test
 * harness installs `window` as a getter whose setter forwards only the three
 * Tauri probe flags (`test/node-test-env.ts`) — a stub assigned to
 * `globalThis.window` is silently ignored, so a test written that way would
 * assert against jsdom and pass for the wrong reason.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  collectBrowserFacts,
  collectDevFacts,
  collectDiagnosticsReport,
  collectDiagnosticsSnapshot,
  collectSessionFacts,
  collectUpdateSettings,
  describeBrowserFacts,
  describeDevServer,
} from "../src/lib/diagnostics/collect-diagnostics";

// `globalThis.Intl` is getter-only in Node, so it is swapped by descriptor and
// put back the same way rather than by assignment.
const realIntlDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Intl");

/**
 * The harness installs `window` as a getter whose setter forwards only the
 * three Tauri probe flags (`test/node-test-env.ts`). So assigning
 * `{ __TAURI__: {} }` is how `isDesktop()` is made to answer true, and
 * assigning `undefined` is how those flags are cleared again — a stub object
 * will not replace the window itself.
 */
const globals = globalThis as unknown as { window?: unknown };

afterEach(() => {
  globals.window = undefined;
  if (realIntlDescriptor !== undefined) {
    Object.defineProperty(globalThis, "Intl", realIntlDescriptor);
  }
});

function stubIntl(value: unknown): void {
  Object.defineProperty(globalThis, "Intl", {
    configurable: true,
    writable: true,
    value,
  });
}

const FULL_WINDOW = {
  navigator: { userAgent: "Stub/1.0", language: "en-GB", onLine: true },
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1.5,
  matchMedia: (query: string) => ({ matches: query.includes("dark") }),
};

test("browser facts come back from a webview that supplies everything", () => {
  assert.deepEqual(describeBrowserFacts(FULL_WINDOW), {
    userAgent: "Stub/1.0",
    language: "en-GB",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    viewportWidth: 1280,
    viewportHeight: 800,
    devicePixelRatio: 1.5,
    online: true,
    prefersDarkColorScheme: true,
    prefersReducedMotion: false,
  });
});

test("a missing matchMedia costs its own rows and nothing else", () => {
  const facts = describeBrowserFacts({
    ...FULL_WINDOW,
    matchMedia: undefined,
  });

  assert.equal(facts.prefersDarkColorScheme, null);
  assert.equal(facts.prefersReducedMotion, null);
  // The reads that did work are still there.
  assert.equal(facts.userAgent, "Stub/1.0");
  assert.equal(facts.viewportWidth, 1280);
});

test("a matchMedia that throws is caught rather than failing the panel", () => {
  const facts = describeBrowserFacts({
    ...FULL_WINDOW,
    matchMedia: () => {
      throw new Error("not implemented");
    },
  });

  assert.equal(facts.prefersDarkColorScheme, null);
  assert.equal(facts.prefersReducedMotion, null);
  assert.equal(facts.userAgent, "Stub/1.0");
});

test("a build with no ICU data reports no time zone and keeps the rest", () => {
  stubIntl({
    DateTimeFormat: () => {
      throw new Error("no ICU data in this build");
    },
  });

  const facts = describeBrowserFacts(FULL_WINDOW);
  assert.equal(facts.timeZone, null);
  assert.equal(facts.language, "en-GB");
  assert.equal(facts.prefersDarkColorScheme, true);
});

test("a webview with no navigator reports those rows as unknown", () => {
  const facts = describeBrowserFacts({ ...FULL_WINDOW, navigator: undefined });

  assert.equal(facts.userAgent, null);
  assert.equal(facts.language, null);
  assert.equal(facts.online, null);
  assert.equal(facts.viewportWidth, 1280);
});

test("an empty window produces a complete row set of nulls", () => {
  assert.deepEqual(describeBrowserFacts({}), {
    userAgent: null,
    language: null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    viewportWidth: null,
    viewportHeight: null,
    devicePixelRatio: null,
    online: null,
    prefersDarkColorScheme: null,
    prefersReducedMotion: null,
  });
});

test("the real window is readable, which is what the panel does", () => {
  // Driven against jsdom rather than a stub: this is the one assertion that
  // proves the wrapper reaches a real window at all.
  const facts = collectBrowserFacts();
  assert.ok(facts, "a window is present under the test harness");
  assert.equal(typeof facts.userAgent, "string");
  assert.equal(typeof facts.viewportWidth, "number");
});

test("the dev server is detected on loopback over http and nowhere else", () => {
  assert.deepEqual(
    describeDevServer({
      hostname: "localhost",
      port: "3001",
      protocol: "http:",
      origin: "http://localhost:3001",
    }),
    { port: 3001, origin: "http://localhost:3001" },
  );
  assert.deepEqual(
    describeDevServer({
      hostname: "127.0.0.1",
      port: "3002",
      protocol: "http:",
      origin: "http://127.0.0.1:3002",
    }),
    { port: 3002, origin: "http://127.0.0.1:3002" },
  );

  for (const [label, location] of [
    [
      "a production desktop bundle serves from the custom protocol",
      {
        hostname: "tauri.localhost",
        port: "",
        protocol: "http:",
        origin: "http://tauri.localhost",
      },
    ],
    [
      "and its loopback-shaped host is why the protocol is checked too",
      {
        hostname: "localhost",
        port: "",
        protocol: "tauri:",
        origin: "tauri://localhost",
      },
    ],
    [
      "a deployed static export is not a dev server",
      {
        hostname: "app.example.com",
        port: "443",
        protocol: "https:",
        origin: "https://app.example.com",
      },
    ],
    ["an empty location says nothing", {}],
  ] as const) {
    assert.equal(describeDevServer(location), null, label);
  }
});

test("a loopback page with no port reports no port rather than a guess", () => {
  assert.deepEqual(
    describeDevServer({
      hostname: "localhost",
      port: "",
      protocol: "http:",
      origin: "http://localhost",
    }),
    { port: null, origin: "http://localhost" },
  );
});

test("the real location is readable without throwing", () => {
  // jsdom serves the harness from `http://localhost`, so this is the dev-server
  // branch; what matters is that the wrapper returns rather than throws.
  assert.deepEqual(collectDevFacts(), {
    port: null,
    origin: "http://localhost",
  });
});

test("the snapshot skips every host probe when there is no desktop shell", async () => {
  const snapshot = await collectDiagnosticsSnapshot();

  assert.equal(snapshot.shell, "browser");
  assert.equal(snapshot.hostFacts, null);
  assert.equal(snapshot.mcp, null);
  assert.equal(snapshot.notifications, null);
  assert.equal(snapshot.aiProviders, null);
  assert.equal(snapshot.aiPersonas, null);
  assert.equal(snapshot.aiPermissions, null);
  assert.equal(snapshot.retainedStore, null);
  assert.equal(snapshot.auditSummary, null);
  assert.equal(snapshot.biometrics, null);
  assert.equal(snapshot.passkeys, null);
  assert.equal(snapshot.counts?.apiCredentialsStored, null);
  assert.ok(snapshot.capturedAt instanceof Date);
  // The reads that need no host still happen.
  assert.ok(snapshot.browser);
  assert.ok(snapshot.session);
  assert.ok(snapshot.updateSettings);
});

test("every host probe is attempted on desktop, and a failure costs one row", async () => {
  // No Tauri bridge is actually present, so every native probe rejects. That
  // is the case worth pinning: the snapshot must still come back whole, with
  // the unreachable rows as `null`, because a diagnostics screen is opened
  // precisely when something is already broken.
  globals.window = { __TAURI__: {} };

  const snapshot = await collectDiagnosticsSnapshot();

  assert.equal(snapshot.shell, "desktop");
  for (const [label, value] of [
    ["hostFacts", snapshot.hostFacts],
    ["mcp", snapshot.mcp],
    ["notifications", snapshot.notifications],
    ["aiProviders", snapshot.aiProviders],
    ["aiPersonas", snapshot.aiPersonas],
    ["aiPermissions", snapshot.aiPermissions],
    ["retainedStore", snapshot.retainedStore],
    ["auditSummary", snapshot.auditSummary],
  ] as const) {
    assert.ok(value === null, `${label} should be null, not a thrown error`);
  }
  assert.ok(snapshot.session, "the session read needs no host");
  assert.ok(snapshot.updateSettings, "nor do the update preferences");
});

test("the update preferences are read from storage, and due-ness from now", async () => {
  const settings = collectUpdateSettings();

  assert.equal(typeof settings.enabled, "boolean");
  assert.equal(typeof settings.intervalHours, "number");
  assert.equal(typeof settings.includePrereleases, "boolean");
  // `due` is evaluated at collection time rather than stored: "a check is
  // overdue" is a question about now, and a stored answer would be stale.
  assert.equal(typeof settings.due, "boolean");
  assert.ok(
    settings.lastCheckedAt === null ||
      typeof settings.lastCheckedAt === "string",
  );
});

test("session facts report the window's own lifetime", () => {
  const facts = collectSessionFacts();

  assert.ok(facts, "a page always has a time origin");
  assert.equal(typeof facts.startedAt, "string");
  assert.ok(
    typeof facts.uptimeMs === "number" && facts.uptimeMs >= 0,
    "uptime is never negative, even if the clock moved",
  );
  assert.ok(
    Date.parse(facts.startedAt as string) <= Date.now(),
    "the window cannot have opened in the future",
  );
});

test("no time origin means no session section rather than a fabricated one", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "performance");
  try {
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      writable: true,
      value: { timeOrigin: Number.NaN },
    });
    assert.ok(collectSessionFacts() === null);

    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      writable: true,
      value: { timeOrigin: 0 },
    });
    assert.ok(
      collectSessionFacts() === null,
      "a zero origin is absent, not 1970",
    );
  } finally {
    if (original !== undefined) {
      Object.defineProperty(globalThis, "performance", original);
    }
  }
});

test("the caller's zones and records reach the snapshot untouched", async () => {
  const zones = [{ id: "zone-1", name: "example.test" }];
  const records = [
    { id: "r1", zone_id: "zone-1", type: "A", content: "1.2.3.4" },
  ];

  const snapshot = await collectDiagnosticsSnapshot({
    zones,
    records,
    zoneTabsOpen: 1,
    passkeysRegistered: 2,
  });

  // The builder is what narrows these; the collector must not pre-filter, or
  // the record type histogram would have nothing to count.
  assert.equal(snapshot.zones, zones);
  assert.equal(snapshot.records, records);
  assert.equal(snapshot.counts?.zoneTabsOpen, 1);
  assert.equal(snapshot.counts?.zonesAvailable, 1);
  assert.equal(snapshot.counts?.passkeysRegistered, 2);
});

test("collecting and building in one call produces a usable report", async () => {
  const report = await collectDiagnosticsReport({
    zones: [{ id: "zone-1", name: "example.test" }],
    records: [
      { id: "r1", zone_id: "zone-1", type: "TXT", content: "v=spf1 -all" },
    ],
  });

  assert.equal(report.build.shell, "browser");
  assert.equal(report.counts.recordsLoaded, 1);
  assert.deepEqual(report.counts.recordTypes, [{ type: "TXT", count: 1 }]);
  assert.equal(report.includesUserData, false);
  assert.equal(report.userData, null);
  assert.ok(
    !JSON.stringify(report).includes("example.test"),
    "the default report still withholds the zone name it was handed",
  );
  assert.ok(
    !JSON.stringify(report).includes("v=spf1 -all"),
    "and still withholds record content",
  );
});

test("the opt-in reaches through the collector too", async () => {
  const report = await collectDiagnosticsReport(
    { zones: [{ id: "zone-1", name: "example.test" }] },
    { includeUserData: true },
  );

  assert.equal(report.includesUserData, true);
  assert.deepEqual(report.userData?.zones, [
    { name: "example.test", records: 0 },
  ]);
});
