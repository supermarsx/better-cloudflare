import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDiagnosticsReport,
  classifyMcpBinding,
  describeVersion,
  DIAGNOSTICS_SCHEMA,
  type DiagnosticsReport,
  type DiagnosticsSnapshot,
} from "../src/lib/diagnostics/diagnostics-report";
import {
  diagnosticsSummaryLine,
  fencedBlock,
  inlineCode,
  renderDiagnosticsJson,
  renderDiagnosticsMarkdown,
} from "../src/lib/diagnostics/diagnostics-markdown";
import {
  buildZoneRedactor,
  redactEmailAddresses,
  redactUserPaths,
} from "../src/lib/diagnostics/redaction";
import type { RuntimeDiagnostic } from "../src/lib/errors/runtime-reporting";

/**
 * Credentials. None of these may appear anywhere in any rendering, at any
 * opt-in level.
 *
 * Two mechanisms are being exercised, and the placement of each value says
 * which one. A bare opaque token (`MCP_BEARER_TOKEN`) sits in a field the
 * builder never reads, so it is structure that removes it. A token in
 * recognisable syntax (`AUTHORIZED_ERROR`, `CREDENTIALED_BASE_URL`) sits in
 * free prose, where the credential patterns in
 * `@/lib/errors/runtime-reporting` are what remove it.
 */
const SECRETS = {
  cloudflareApiToken: "cf-api-token-MUST-NEVER-BE-PUBLISHED",
  mcpBearerToken: "mcp-bearer-token-MUST-NEVER-BE-PUBLISHED",
  aiProviderKey: "sk-ai-provider-key-MUST-NEVER-BE-PUBLISHED",
  vaultPassword: "vault-password-MUST-NEVER-BE-PUBLISHED",
  credentialedBaseUrl: "https://admin:hunter2@llm.internal.example/v1",
  /**
   * The per-launch dev-server identity token (`src/lib/dev-identity.ts`).
   * 43 characters of base64url, which no credential pattern can recognise —
   * it is excluded by having no field to travel in.
   */
  devIdentityToken: "Zm9vYmFyYmF6cXV1eHdvbWJhdHNxdWlkb2N0bzEyMzQ1",
  /**
   * An assistant persona's system prompt. Free text the user wrote, and the
   * longest free-text field in the application — people paste their whole
   * working context into one, credentials included.
   */
  personaPrompt:
    "You manage DNS. The account token is persona-prompt-MUST-NEVER-BE-PUBLISHED.",
} as const;

/**
 * Identifying but non-secret values. All withheld by default; only the zone
 * names are published by the opt-in.
 */
const IDENTIFYING = {
  zoneName: "primary-zone-example.test",
  otherZoneName: "second-zone-example.test",
  /** A zone only the recycle bin remembers — the workspace has it closed. */
  binnedZoneName: "retired-zone-example.test",
  recordName: "selector._domainkey.primary-zone-example.test",
  recordContent: "v=DKIM1; p=MIIBIjANBgkqhkiG9w0-dkim-public-key-material",
  recordComment: "rotation note for the finance team",
  binnedRecordName: "old-mail.retired-zone-example.test",
  binnedRecordContent: "10 mx-provider-the-user-left.example",
  binnedRecordComment: "deleted during the december migration",
  accountEmail: "named.person@example.invalid",
  accountId: "cf-account-identifier-0a1b2c3d",
  retentionEntryId: "retention-entry-9f8e7d6c",
  localAccountName: "RealPersonName",
  personaName: "Finance team DNS reviewer",
} as const;

/**
 * Every value that must never appear, regardless of the opt-in.
 *
 * The recycle bin's zone name is here rather than in {@link CONSENT_GATED} on
 * purpose: the opt-in publishes the zones the user is *looking at*, which is
 * what they can see before they paste. A zone they closed months ago and a
 * record they deleted from it are not on the screen and are not part of that
 * consent.
 */
const ALWAYS_FORBIDDEN: readonly string[] = [
  ...Object.values(SECRETS),
  IDENTIFYING.recordName,
  IDENTIFYING.recordContent,
  IDENTIFYING.recordComment,
  IDENTIFYING.binnedZoneName,
  IDENTIFYING.binnedRecordName,
  IDENTIFYING.binnedRecordContent,
  IDENTIFYING.binnedRecordComment,
  IDENTIFYING.accountEmail,
  IDENTIFYING.accountId,
  IDENTIFYING.retentionEntryId,
  IDENTIFYING.localAccountName,
  IDENTIFYING.personaName,
];

/** Values withheld by default and published only on an explicit opt-in. */
const CONSENT_GATED: readonly string[] = [
  IDENTIFYING.zoneName,
  IDENTIFYING.otherZoneName,
];

function runtimeDiagnostic(
  overrides: Partial<RuntimeDiagnostic> = {},
): RuntimeDiagnostic {
  return {
    id: "runtime-1",
    fingerprint: "abc123",
    source: "react-boundary",
    name: "TypeError",
    message: `Failed to load records for ${IDENTIFYING.zoneName} (api_key=${SECRETS.cloudflareApiToken})`,
    stack: [
      "TypeError: Failed to load records",
      `    at loadZone (file:///C:/Users/${IDENTIFYING.localAccountName}/AppData/Local/app/_next/static/chunks/main.js:12:9)`,
      `    at refresh (/home/${IDENTIFYING.localAccountName}/app/src/lib/dns/propagation.ts:42:1)`,
      `    at Object.keys (webpack-internal:///./src/lib/dns/records.ts:8:3)`,
    ].join("\n"),
    componentStack: "    in DNSManager\n    in ErrorBoundary",
    timestamp: "2026-10-06T10:00:00.000Z",
    lastSeenAt: "2026-10-06T10:00:05.000Z",
    occurrences: 3,
    ...overrides,
  };
}

/**
 * A snapshot as credential-laden and as identifying as the real inputs allow.
 *
 * Every secret-bearing field the real replies carry is populated, in both the
 * camelCase and snake_case spellings where the backend sends both, so a leak
 * through either shows up here.
 */
function loadedSnapshot(): DiagnosticsSnapshot {
  return {
    capturedAt: "2026-10-06T12:00:00.000Z",
    shell: "desktop",
    hostFacts: {
      releaseTag: "26.14",
      bundleVersion: "0.0.0",
      appName: "Better Cloudflare",
      buildProfile: "release",
      os: "windows",
      arch: "x86_64",
      family: "windows",
      tauriVersion: "2.11.5",
      webviewVersion: "131.0.2903.70",
      osRelease: {
        osType: "Windows",
        version: "10.0.26200",
        edition: "Windows 11 Professional",
        codename: null,
        bitness: "64-bit",
        architecture: "x86_64",
      },
      keyring: {
        status: "unavailable",
        detail: `could not open C:\\Users\\${IDENTIFYING.localAccountName}\\AppData\\Roaming\\vault (password=${SECRETS.vaultPassword})`,
      },
    },
    session: {
      startedAt: "2026-10-04T08:30:00.000Z",
      uptimeMs: 185_400_000,
    },
    browser: {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      language: "en-GB",
      timeZone: "Europe/Lisbon",
      viewportWidth: 1512,
      viewportHeight: 945,
      devicePixelRatio: 2,
      online: true,
      prefersDarkColorScheme: true,
      prefersReducedMotion: false,
    },
    dev: {
      port: 3001,
      // The launcher never puts the identity token in the URL; it is here to
      // prove that even if something did, nothing carries it through.
      origin: `http://localhost:3001/?identity=${SECRETS.devIdentityToken}`,
    },
    biometrics: {
      available: false,
      biometricType: "windowsHello",
      reason: `Hello is not enrolled for ${IDENTIFYING.accountEmail}`,
    },
    passkeys: {
      registrationAvailable: true,
      authenticationAvailable: true,
      legacyCredentialsRequireReregistration: false,
      unavailableReason: `no authenticator for ${IDENTIFYING.accountEmail}`,
      nativeCeremony: true,
      nativeClient: "windows-webauthn",
    },
    mcp: {
      running: true,
      host: "127.0.0.1",
      port: 8787,
      url: `http://127.0.0.1:8787/mcp?token=${SECRETS.mcpBearerToken}`,
      authToken: SECRETS.mcpBearerToken,
      auth_token: SECRETS.mcpBearerToken,
      enabledTools: ["cf_list_zones", "cf_list_dns_records"],
      tools: [
        { name: "cf_list_zones", enabled: true },
        { name: "cf_list_dns_records", enabled: true },
        { name: "cf_delete_dns_record", enabled: false },
      ],
      toolCount: 3,
      promptCount: 4,
      resourceCount: 5,
      lastError: `Authorization: Bearer ${SECRETS.mcpBearerToken} was rejected`,
    },
    notifications: {
      running: true,
      enabled: true,
      paused: false,
      quietHoursActive: false,
      zonesTracked: 2,
      unread: 7,
      lastRecordCheckAt: "2026-10-06T11:55:00.000Z",
      lastExpiryCheckAt: "2026-10-06T06:00:00.000Z",
      lastAuditCheckAt: null,
      nextRecordCheckAt: "2026-10-06T12:10:00.000Z",
      nextExpiryCheckAt: "2026-10-07T06:00:00.000Z",
      nextAuditCheckAt: null,
      backoffUntil: null,
      lastError: `RDAP lookup for ${IDENTIFYING.zoneName} failed for account ${IDENTIFYING.accountId}`,
      lastPass: {
        kind: "records",
        startedAt: "2026-10-06T11:55:00.000Z",
        durationMs: 812,
        zonesChecked: 2,
        notificationsCreated: 1,
        // The four fields `PassSummary` does not forward yet. Present here so
        // the report is driven as it will be once the Rust side sends them.
        notificationsRefreshed: 3,
        notificationsSuperseded: 1,
        errors: 0,
        skipped: false,
        backoff: false,
      },
    },
    aiProviders: [
      {
        id: "local-llm",
        label: `${IDENTIFYING.accountEmail}'s private endpoint`,
        protocol: "openai",
        baseUrl: SECRETS.credentialedBaseUrl,
        model: "gpt-4o-mini",
        hasApiKey: true,
      },
      {
        id: "anthropic-main",
        label: "Anthropic",
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-5",
        hasApiKey: false,
      },
    ],
    aiPersonas: [
      { id: "builtin-dns", name: "DNS helper", builtin: true },
      {
        id: "custom-1",
        name: IDENTIFYING.personaName,
        description: `Reviews ${IDENTIFYING.zoneName} changes`,
        systemPrompt: SECRETS.personaPrompt,
        builtin: false,
      },
      {
        id: "custom-2",
        name: "Migration notes",
        description: "",
        systemPrompt: `Remember ${IDENTIFYING.recordContent}`,
        builtin: false,
      },
    ],
    aiPermissions: {
      mode: "ask",
      tools: {
        cf_list_zones: "allow",
        cf_list_dns_records: "allow",
        cf_delete_dns_record: "deny",
        cf_update_dns_record: "ask",
        // An unknown permission value must widen no tally.
        cf_future_tool: "escalate",
      },
      catalog: [{ name: "cf_list_zones" }, { name: "cf_delete_dns_record" }],
      availability: {
        dispatchAvailable: true,
        grantedToolCount: 12,
        usableToolCount: 9,
        registeredToolCount: 48,
      },
    },
    retainedStore: {
      // Entries exactly as the command returns them: whole record snapshots.
      entries: [
        {
          entry_id: IDENTIFYING.retentionEntryId,
          reason: "deleted",
          zone_id: "zone-retired",
          zone_name: IDENTIFYING.binnedZoneName,
          expires_at: "2026-11-01T00:00:00.000Z",
          snapshot: {
            record_type: "MX",
            name: IDENTIFYING.binnedRecordName,
            content: IDENTIFYING.binnedRecordContent,
            comment: IDENTIFYING.binnedRecordComment,
          },
        },
        {
          entry_id: "retention-entry-disabled-1",
          reason: "disabled",
          zone_id: "zone-1",
          zone_name: IDENTIFYING.zoneName,
          snapshot: {
            record_type: "TXT",
            name: IDENTIFYING.recordName,
            content: IDENTIFYING.recordContent,
          },
        },
        { entry_id: "retention-entry-new-1", reason: "quarantined" },
      ],
      expiredPendingPurge: 1,
      totalHeld: 3,
      bytesHeld: 24_576,
      maxBytes: 262_144,
      maxEntries: 50,
    },
    auditSummary: {
      entries: 847,
      capacity: 1000,
      oldestAt: "2026-09-01T07:00:00.000Z",
      newestAt: "2026-10-06T11:59:00.000Z",
      byActor: { user: 700, mcp_client: 100, assistant: 47 },
      byOutcome: { succeeded: 800, failed: 30, denied: 17 },
    },
    updateCheck: {
      current: "26.14",
      status: "updateAvailable",
      checkedAt: "2026-10-06T09:00:00.000Z",
      latest: {
        tag: "26.15",
        url: "https://github.com/supermarsx/better-cloudflare/releases/tag/26.15",
        publishedAt: "2026-10-05T18:00:00.000Z",
        prerelease: false,
      },
    },
    updateSettings: {
      enabled: true,
      intervalHours: 24,
      includePrereleases: false,
      lastCheckedAt: "2026-10-06T09:00:00.000Z",
      due: false,
    },
    counts: {
      zoneTabsOpen: 2,
      zonesAvailable: 2,
      apiCredentialsStored: 3,
      registrarCredentialsStored: 1,
      passkeysRegistered: 2,
    },
    zones: [
      {
        id: "zone-1",
        name: IDENTIFYING.zoneName,
        account: { id: IDENTIFYING.accountId, name: "Finance" },
      },
      { id: "zone-2", name: IDENTIFYING.otherZoneName },
    ],
    records: [
      {
        id: "record-1",
        zone_id: "zone-1",
        type: "TXT",
        name: IDENTIFYING.recordName,
        content: IDENTIFYING.recordContent,
        comment: IDENTIFYING.recordComment,
      },
      {
        id: "record-2",
        zone_id: "zone-1",
        type: "MX",
        name: IDENTIFYING.zoneName,
        content: `10 mail.${IDENTIFYING.zoneName}`,
      },
      {
        id: "record-3",
        zone_id: "zone-2",
        type: "A",
        name: IDENTIFYING.otherZoneName,
        content: "203.0.113.7",
      },
      {
        id: "record-4",
        zone_id: "zone-2",
        type: "a",
        name: `www.${IDENTIFYING.otherZoneName}`,
        content: "203.0.113.8",
      },
    ],
    cache: [
      {
        zoneId: "zone-1",
        zoneName: IDENTIFYING.zoneName,
        ageMs: 5_000,
        expired: false,
      },
      {
        zoneId: "zone-2",
        zoneName: IDENTIFYING.otherZoneName,
        ageMs: 900_000,
        expired: true,
      },
    ],
    runtimeErrors: [runtimeDiagnostic()],
  };
}

/**
 * Every rendering of a payload, so an assertion covers all of them at once.
 *
 * Asserting over the serialised whole rather than field by field is the point:
 * a field added to the payload later is covered by these tests without anyone
 * remembering to add an assertion for it.
 */
function allRenderings(
  report: DiagnosticsReport,
): { label: string; text: string }[] {
  return [
    { label: "JSON.stringify", text: JSON.stringify(report) },
    { label: "renderDiagnosticsJson", text: renderDiagnosticsJson(report) },
    {
      label: "renderDiagnosticsMarkdown",
      text: renderDiagnosticsMarkdown(report),
    },
  ];
}

test("no credential or identifying value reaches a default diagnostics payload", () => {
  const report = buildDiagnosticsReport(loadedSnapshot());

  for (const { label, text } of allRenderings(report)) {
    for (const forbidden of [...ALWAYS_FORBIDDEN, ...CONSENT_GATED]) {
      assert.ok(
        !text.includes(forbidden),
        `${forbidden} reached ${label}:\n${text}`,
      );
    }
  }
});

test("an opt-in publishes zone names and still no credential or record data", () => {
  const report = buildDiagnosticsReport(loadedSnapshot(), {
    includeUserData: true,
  });

  for (const { label, text } of allRenderings(report)) {
    for (const forbidden of ALWAYS_FORBIDDEN) {
      assert.ok(
        !text.includes(forbidden),
        `${forbidden} reached ${label} under the opt-in:\n${text}`,
      );
    }
    for (const consented of CONSENT_GATED) {
      assert.ok(
        text.includes(consented),
        `${consented} is what the opt-in exists to publish, and ${label} omitted it`,
      );
    }
  }
});

test("the payload says whether user data is included, and what is withheld", () => {
  const withheldOnly = buildDiagnosticsReport(loadedSnapshot());
  assert.equal(withheldOnly.includesUserData, false);
  assert.equal(withheldOnly.userData, null);
  assert.ok(
    withheldOnly.withheld.some((note) => note.includes("counts only")),
    "a reader must be able to tell a withheld zone list from an empty one",
  );

  const consented = buildDiagnosticsReport(loadedSnapshot(), {
    includeUserData: true,
  });
  assert.equal(consented.includesUserData, true);
  assert.ok(
    consented.withheld.some((note) => note.includes("at the user's request")),
    "the opt-in must be visible in the blob, not only in the UI that produced it",
  );
});

test("user data is reduced to counts and a record type histogram", () => {
  const report = buildDiagnosticsReport(loadedSnapshot());

  assert.equal(report.counts.zonesAvailable, 2);
  assert.equal(report.counts.recordsLoaded, 4);
  assert.deepEqual(report.storage.offlineCache, {
    cachedZones: 2,
    cachedZonesExpired: 1,
    oldestCacheAgeMs: 900_000,
    newestCacheAgeMs: 5_000,
  });
  assert.deepEqual(report.counts.recordTypes, [
    // `a` and `A` are the same type; the histogram normalises case so a
    // mixed-case API reply does not split one type into two rows.
    { type: "A", count: 2 },
    { type: "MX", count: 1 },
    { type: "TXT", count: 1 },
  ]);
});

test("the opt-in names zones and counts their records, and nothing else", () => {
  const report = buildDiagnosticsReport(loadedSnapshot(), {
    includeUserData: true,
  });

  assert.deepEqual(report.userData, {
    zones: [
      { name: IDENTIFYING.zoneName, records: 2 },
      { name: IDENTIFYING.otherZoneName, records: 2 },
    ],
    omitted: 0,
  });
});

test("a record type that is not a type is counted without being printed", () => {
  const report = buildDiagnosticsReport({
    records: [
      { type: `prose about ${IDENTIFYING.recordContent}` },
      { type: "A" },
      { type: 42 },
    ],
  });

  assert.deepEqual(report.counts.recordTypes, [
    { type: "other", count: 2 },
    { type: "A", count: 1 },
  ]);
  assert.ok(
    !JSON.stringify(report).includes(IDENTIFYING.recordContent),
    "a type field holding prose must not put that prose in the payload",
  );
});

test("a long record type histogram collapses its tail into one row", () => {
  // A payload has to stay pasteable, so the histogram is bounded. The tail
  // collapses into a single row that still accounts for every record.
  const records = Array.from({ length: 40 }, (_unused, index) => ({
    type: `TYPE${index}`,
  }));
  const report = buildDiagnosticsReport({ records });

  assert.equal(report.counts.recordsLoaded, 40);
  assert.equal(report.counts.recordTypes.length, 25, "24 rows plus the tail");
  const tail = report.counts.recordTypes.at(-1);
  assert.deepEqual(tail, { type: "16 further types", count: 16 });
  assert.equal(
    report.counts.recordTypes.reduce((sum, entry) => sum + entry.count, 0),
    40,
    "the collapsed tail still accounts for every record",
  );
});

test("the opt-in zone list is bounded and says how many it left out", () => {
  const zones = Array.from({ length: 130 }, (_unused, index) => ({
    id: `zone-${index}`,
    name: `zone-${index}.example.test`,
  }));
  const report = buildDiagnosticsReport({ zones }, { includeUserData: true });

  assert.equal(report.userData?.zones.length, 100);
  assert.equal(report.userData?.omitted, 30);
  assert.ok(
    renderDiagnosticsMarkdown(report).includes("(30 further zones not listed)"),
    "a truncated zone list must say it was truncated",
  );
});

test("a zone with no readable name is counted as omitted, not printed blank", () => {
  const report = buildDiagnosticsReport(
    {
      zones: [
        { id: "zone-1", name: 42 },
        { id: "zone-2", name: "ok.example" },
      ],
    },
    { includeUserData: true },
  );

  assert.deepEqual(report.userData, {
    zones: [{ name: "ok.example", records: 0 }],
    omitted: 1,
  });
});

test("the platform section carries the OS release the target cannot", () => {
  const report = buildDiagnosticsReport(loadedSnapshot());

  // The whole reason `os_info` is a dependency: `os` is the compile target and
  // says only "windows", and the user agent says "Windows NT 10.0" for every
  // Windows 11 in existence.
  assert.equal(report.platform.os, "windows");
  assert.equal(report.platform.osName, "Windows");
  assert.equal(report.platform.osVersion, "10.0.26200");
  assert.equal(report.platform.osEdition, "Windows 11 Professional");
  assert.equal(report.platform.osBitness, "64-bit");
  assert.equal(report.platform.machineArch, "x86_64");

  const markdown = renderDiagnosticsMarkdown(report);
  assert.ok(
    markdown.includes(
      "- Operating system: Windows 11 Professional 10.0.26200 64-bit",
    ),
    `the OS belongs on one line:\n${markdown}`,
  );
  assert.ok(
    !markdown.includes("Machine architecture"),
    "the machine's architecture is a row only when it differs from the build's",
  );
});

test("an emulated build reports both architectures", () => {
  const report = buildDiagnosticsReport({
    hostFacts: {
      os: "macos",
      arch: "x86_64",
      osRelease: { osType: "Macos", version: "15.1", architecture: "arm64" },
    },
  });

  assert.equal(report.platform.machineArch, "arm64");
  assert.ok(
    renderDiagnosticsMarkdown(report).includes("- Machine architecture: arm64"),
    "an x86_64 binary on an arm64 machine is a real and confusing report",
  );
});

test("an OS release field that is not a token is dropped", () => {
  const report = buildDiagnosticsReport({
    hostFacts: {
      osRelease: {
        osType: "Windows",
        // A version is a short token. Prose here would be prose in the payload.
        version: `11 but actually ${IDENTIFYING.recordContent}`,
        bitness: "128-bit",
      },
    },
  });

  assert.equal(report.platform.osVersion, null);
  assert.equal(
    report.platform.osBitness,
    null,
    "`128-bit` is not in os_info's vocabulary",
  );
  assert.ok(!JSON.stringify(report).includes(IDENTIFYING.recordContent));
});

test("update checking reports its cadence, its verdict and the tag it saw", () => {
  const report = buildDiagnosticsReport(loadedSnapshot());

  assert.deepEqual(report.updates, {
    checkEnabled: true,
    intervalHours: 24,
    includePrereleases: false,
    lastCheckedAt: "2026-10-06T09:00:00.000Z",
    checkDue: false,
    lastStatus: "updateAvailable",
    lastCheckAt: "2026-10-06T09:00:00.000Z",
    latestSeenTag: "26.15",
    latestSeenPublishedAt: "2026-10-05T18:00:00.000Z",
    latestIsPrerelease: false,
  });
  assert.ok(
    !JSON.stringify(report).includes("releases/tag/26.15"),
    "the release URL is not reported; the tag is what a reader needs",
  );
});

test("no check this session is not reported as up to date", () => {
  const report = buildDiagnosticsReport({
    updateSettings: { enabled: true, intervalHours: 24, due: true },
  });

  assert.equal(report.updates.checkDue, true);
  assert.equal(
    report.updates.lastStatus,
    null,
    "`null` means not checked here, which is not `upToDate`",
  );
  const markdown = renderDiagnosticsMarkdown(report);
  assert.ok(
    !markdown.includes("Last verdict"),
    "an absent verdict is a dropped row, never a row reading `unknown`",
  );
  assert.ok(markdown.includes("- Check due now: yes"));
});

test("an update status outside the closed set is dropped", () => {
  const report = buildDiagnosticsReport({
    updateCheck: { status: `smuggled ${SECRETS.cloudflareApiToken}` },
  });

  assert.equal(report.updates.lastStatus, null);
  assert.ok(!JSON.stringify(report).includes(SECRETS.cloudflareApiToken));
});

test("the session section says how long the window has been open", () => {
  const report = buildDiagnosticsReport(loadedSnapshot());

  assert.deepEqual(report.session, {
    startedAt: "2026-10-04T08:30:00.000Z",
    uptimeMs: 185_400_000,
  });
  assert.ok(
    renderDiagnosticsMarkdown(report).includes("- Open for: 2d 3h"),
    "a window open for two days explains stale state, which is the point",
  );
});

test("notifications report each pass kind, its schedule and its counters", () => {
  const report = buildDiagnosticsReport(loadedSnapshot());
  const { notifications } = report;

  assert.equal(notifications.running, true);
  assert.equal(notifications.quietHoursActive, false);
  assert.equal(notifications.zonesTracked, 2);
  assert.equal(notifications.unread, 7);
  assert.deepEqual(
    notifications.passes.map((pass) => pass.kind),
    ["records", "expiry", "audit"],
    "every kind is a row, so a kind that never ran is visibly absent",
  );

  // The service retains one pass overall, so only its kind carries counters.
  const [records, expiry, audit] = notifications.passes;
  assert.deepEqual(records.lastPass, {
    startedAt: "2026-10-06T11:55:00.000Z",
    durationMs: 812,
    zonesChecked: 2,
    notificationsCreated: 1,
    notificationsRefreshed: 3,
    notificationsSuperseded: 1,
    errors: 0,
    skipped: false,
    backoff: false,
  });
  assert.ok(expiry.lastPass === null, "expiry was not the most recent pass");
  assert.ok(audit.lastPass === null, "and audit has never run");
  assert.equal(audit.lastCheckAt, null);
  assert.equal(expiry.lastCheckAt, "2026-10-06T06:00:00.000Z");

  const markdown = renderDiagnosticsMarkdown(report);
  assert.ok(markdown.includes("3 refreshed, 1 superseded"));
  assert.ok(
    !markdown.includes("Audit pass"),
    "a kind that has neither run nor been scheduled is three wasted lines",
  );
});

test("a pass whose refreshed counters are absent omits them rather than guessing", () => {
  // What the current `PassSummary` actually sends: no refreshed/superseded.
  const report = buildDiagnosticsReport({
    notifications: {
      lastRecordCheckAt: "2026-10-06T11:55:00.000Z",
      lastPass: {
        kind: "records",
        startedAt: "2026-10-06T11:55:00.000Z",
        durationMs: 10,
        zonesChecked: 1,
        notificationsCreated: 0,
        errors: 0,
      },
    },
  });
  const pass = report.notifications.passes[0].lastPass;

  assert.ok(pass !== null);
  assert.equal(pass.notificationsRefreshed, null);
  assert.equal(pass.notificationsSuperseded, null);
  assert.equal(pass.skipped, null);
  assert.ok(
    !renderDiagnosticsMarkdown(report).includes("refreshed"),
    "an absent counter is omitted, not printed as zero",
  );
});

test("the recycle bin reports counts and bytes, never an entry", () => {
  const report = buildDiagnosticsReport(loadedSnapshot());

  assert.deepEqual(report.storage.recycleBin, {
    entriesHeld: 3,
    disabled: 1,
    binned: 1,
    // `"quarantined"` is a reason this build does not know, and is counted as
    // unknown rather than passed through as text.
    unknownReason: 1,
    expiredPendingPurge: 1,
    bytesHeld: 24_576,
    maxBytes: 262_144,
    maxEntries: 50,
    percentOfByteCeiling: 9,
  });
  const text = JSON.stringify(report);
  assert.ok(!text.includes("quarantined"), "an unknown reason is not echoed");
  assert.ok(!text.includes("snapshot"), "no part of a record snapshot is read");
});

test("the recycle bin's own zones are redacted from prose even under the opt-in", () => {
  // A zone the workspace has closed is not on the screen the user read before
  // pasting, so it is not covered by the opt-in's consent.
  const report = buildDiagnosticsReport(loadedSnapshot(), {
    includeUserData: true,
  });
  const text = JSON.stringify(report);

  assert.ok(!text.includes(IDENTIFYING.binnedZoneName));
  assert.ok(!text.includes(IDENTIFYING.binnedRecordName));
  assert.deepEqual(
    report.userData?.zones.map((zone) => zone.name),
    [IDENTIFYING.zoneName, IDENTIFYING.otherZoneName],
    "only the zones the workspace has open are published",
  );
});

test("the audit trail is counts and a date range, with every bucket present", () => {
  const report = buildDiagnosticsReport(loadedSnapshot());

  assert.deepEqual(report.storage.auditTrail, {
    entries: 847,
    capacity: 1000,
    oldestAt: "2026-09-01T07:00:00.000Z",
    newestAt: "2026-10-06T11:59:00.000Z",
    byActor: [
      { actor: "user", count: 700 },
      { actor: "mcp_client", count: 100 },
      { actor: "assistant", count: 47 },
    ],
    byOutcome: [
      { outcome: "succeeded", count: 800 },
      { outcome: "failed", count: 30 },
      { outcome: "denied", count: 17 },
    ],
  });
  assert.ok(
    renderDiagnosticsMarkdown(report).includes(
      "- Audit trail: 847 entries of 1000",
    ),
    "how close the trail is to evicting is why the capacity is reported",
  );
});

test("an audit bucket a newer build invented puts no text in the payload", () => {
  const report = buildDiagnosticsReport({
    auditSummary: {
      entries: 2,
      byActor: { user: 1, [`smuggled ${SECRETS.cloudflareApiToken}`]: 1 },
      byOutcome: { [IDENTIFYING.recordContent]: 1 },
    },
  });
  const text = JSON.stringify(report);

  // Driven from the closed vocabulary, not from the reply's keys.
  assert.deepEqual(
    report.storage.auditTrail.byActor.map((entry) => entry.actor),
    ["user", "mcp_client", "assistant"],
  );
  assert.ok(!text.includes(SECRETS.cloudflareApiToken));
  assert.ok(!text.includes(IDENTIFYING.recordContent));
});

test("the MCP server's binding is classified, never named", () => {
  assert.equal(classifyMcpBinding("127.0.0.1"), "loopback");
  assert.equal(classifyMcpBinding("127.1.2.3"), "loopback");
  assert.equal(classifyMcpBinding("localhost"), "loopback");
  assert.equal(classifyMcpBinding("::1"), "loopback");
  assert.equal(classifyMcpBinding("[::1]"), "loopback");
  assert.equal(classifyMcpBinding("0.0.0.0"), "all-interfaces");
  assert.equal(classifyMcpBinding("::"), "all-interfaces");
  assert.equal(classifyMcpBinding("192.168.1.40"), "other");
  assert.equal(classifyMcpBinding(""), null);
  assert.equal(classifyMcpBinding(undefined), null);

  const report = buildDiagnosticsReport(loadedSnapshot());
  assert.equal(report.services.mcp.binding, "loopback");
  assert.equal(report.services.mcp.port, 8787);
  assert.equal(report.services.mcp.toolsEnabled, 2);
  assert.equal(report.services.mcp.toolsAvailable, 3);
  assert.equal(report.services.mcp.promptsAvailable, 4);
  assert.equal(report.services.mcp.resourcesAvailable, 5);
  assert.ok(
    !JSON.stringify(report).includes("127.0.0.1"),
    "the bind address is a network location and is not a diagnostic",
  );
});

test("the assistant is reduced to counts, closed-set tokens and booleans", () => {
  const report = buildDiagnosticsReport(loadedSnapshot());

  assert.deepEqual(report.services.assistant, {
    providersConfigured: 2,
    protocols: ["anthropic", "openai"],
    providersWithStoredKey: 1,
    personasTotal: 3,
    personasBuiltin: 1,
    personasCustom: 2,
    permissionMode: "ask",
    // `cf_future_tool: "escalate"` is in the input and in none of the tallies.
    toolOverrides: { allow: 2, ask: 1, deny: 1 },
    dispatchAvailable: true,
    toolsGranted: 12,
    toolsUsable: 9,
    toolsRegistered: 48,
  });
  assert.ok(
    !JSON.stringify(report).includes("api.anthropic.com"),
    "a base URL is withheld even when it is a public endpoint, because the field cannot tell",
  );
  assert.ok(
    !JSON.stringify(report).includes("cf_delete_dns_record"),
    "which tools someone granted is the shape of their workflow, not a diagnostic",
  );
});

test("a persona's name, description and prompt never reach the payload", () => {
  const report = buildDiagnosticsReport(
    {
      aiPersonas: [
        {
          id: "p1",
          name: IDENTIFYING.personaName,
          description: `About ${IDENTIFYING.zoneName}`,
          systemPrompt: SECRETS.personaPrompt,
          builtin: false,
        },
      ],
    },
    { includeUserData: true },
  );
  const text = JSON.stringify(report);

  assert.equal(report.services.assistant.personasTotal, 1);
  assert.equal(report.services.assistant.personasCustom, 1);
  for (const forbidden of [
    IDENTIFYING.personaName,
    SECRETS.personaPrompt,
    "About ",
  ]) {
    assert.ok(!text.includes(forbidden), `${forbidden} reached the payload`);
  }
});

test("an absent assistant reports null rather than zero", () => {
  const report = buildDiagnosticsReport({});

  // Zero providers and "the assistant could not be asked" are different
  // answers, and a report that conflated them would send someone looking for
  // a configuration problem that does not exist.
  assert.equal(report.services.assistant.providersConfigured, null);
  assert.equal(report.services.assistant.personasTotal, null);
  assert.equal(report.services.assistant.permissionMode, null);
  assert.equal(report.services.assistant.toolOverrides, null);
  assert.equal(report.services.assistant.toolsRegistered, null);
  assert.deepEqual(report.services.assistant.protocols, []);
});

test("a protocol or permission mode outside its closed set is dropped", () => {
  const report = buildDiagnosticsReport({
    aiProviders: [
      { protocol: `smuggled ${SECRETS.aiProviderKey}`, hasApiKey: true },
      { protocol: "ollama", hasApiKey: false },
    ],
    aiPermissions: { mode: `smuggled ${SECRETS.cloudflareApiToken}` },
  });

  assert.deepEqual(report.services.assistant.protocols, ["ollama"]);
  assert.equal(report.services.assistant.permissionMode, null);
  assert.ok(!JSON.stringify(report).includes(SECRETS.aiProviderKey));
  assert.ok(!JSON.stringify(report).includes(SECRETS.cloudflareApiToken));
});

test("an unstamped build is named as one rather than shown a placeholder", () => {
  assert.equal(describeVersion("26.14"), "26.14");
  assert.equal(
    describeVersion(null),
    "local build (no release tag stamped)",
    "a build with no tag must not be reported as 0.0.0 or as unknown",
  );

  const report = buildDiagnosticsReport({
    hostFacts: { releaseTag: null, bundleVersion: "0.0.0" },
  });
  assert.equal(report.build.releaseTag, null);
  assert.equal(
    report.build.versionLabel,
    "local build (no release tag stamped)",
  );
  assert.equal(
    report.build.bundleVersion,
    "0.0.0",
    "the placeholder is reported, and labelled as one by the renderer",
  );
  assert.ok(
    renderDiagnosticsMarkdown(report).includes(
      "Bundle version (placeholder, not the release)",
    ),
  );
});

test("a whitespace-only release stamp reads as no stamp", () => {
  const report = buildDiagnosticsReport({ hostFacts: { releaseTag: "   " } });
  assert.equal(report.build.releaseTag, null);
});

test("an empty snapshot still produces a complete, well-formed payload", () => {
  const report = buildDiagnosticsReport({});

  assert.equal(report.schema, DIAGNOSTICS_SCHEMA);
  assert.equal(report.build.shell, "browser");
  assert.equal(report.services.mcp.running, null);
  assert.deepEqual(report.services.assistant.protocols, []);
  assert.deepEqual(report.notifications.passes, [
    { kind: "records", lastCheckAt: null, nextCheckAt: null, lastPass: null },
    { kind: "expiry", lastCheckAt: null, nextCheckAt: null, lastPass: null },
    { kind: "audit", lastCheckAt: null, nextCheckAt: null, lastPass: null },
  ]);
  assert.equal(report.storage.recycleBin.entriesHeld, null);
  assert.equal(report.storage.auditTrail.entries, null);
  assert.deepEqual(report.storage.auditTrail.byActor, []);
  assert.equal(report.updates.lastStatus, null);
  assert.equal(report.session.startedAt, null);
  assert.deepEqual(report.runtimeErrors, {
    retained: 0,
    shown: 0,
    entries: [],
  });
  assert.equal(report.dev, null);
  // Round-trips, which is what a payload pasted into an issue has to do.
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test("retained runtime errors are projected, scrubbed and capped", () => {
  const many = Array.from({ length: 14 }, (_unused, index) =>
    runtimeDiagnostic({ id: `runtime-${index}` }),
  );
  const report = buildDiagnosticsReport({ runtimeErrors: many });

  assert.equal(report.runtimeErrors.retained, 14);
  assert.equal(report.runtimeErrors.shown, 10);
  assert.equal(report.runtimeErrors.entries.length, 10);
  const markdown = renderDiagnosticsMarkdown(report);
  assert.ok(
    markdown.includes("10 of 14 retained"),
    "a truncated error list must say it was truncated",
  );
  // The frames themselves survive; only the account name in them is gone.
  assert.ok(
    report.runtimeErrors.entries[0].detail.includes("propagation.ts:42"),
  );
  assert.ok(report.runtimeErrors.entries[0].detail.includes("[user]"));
});

test("a stack frame that looks like a hostname is not mistaken for one", () => {
  const report = buildDiagnosticsReport({
    runtimeErrors: [runtimeDiagnostic()],
  });
  const detail = report.runtimeErrors.entries[0].detail;

  // `Object.keys`, `propagation.ts` and `main.js` are all domain-shaped. A
  // shape-based domain redactor would destroy every one of them, which is why
  // the redaction is driven by the zone list instead.
  for (const frame of [
    "Object.keys",
    "propagation.ts",
    "main.js",
    "records.ts",
  ]) {
    assert.ok(
      detail.includes(frame),
      `${frame} is a stack frame, not a domain, and must survive the scrub`,
    );
  }
});

test("redactUserPaths removes the account name and keeps the path", () => {
  assert.equal(
    redactUserPaths("C:\\Users\\Mariana\\AppData\\Roaming\\app"),
    "C:\\Users\\[user]\\AppData\\Roaming\\app",
  );
  assert.equal(
    redactUserPaths("/home/mariana/projects/app"),
    "/home/[user]/projects/app",
  );
  assert.equal(
    redactUserPaths("/Users/mariana/Library"),
    "/Users/[user]/Library",
  );
  assert.equal(
    redactUserPaths("file:///C:/Users/Mariana/app/main.js:1:2"),
    "file:///C:/Users/[user]/app/main.js:1:2",
  );
  assert.equal(
    redactUserPaths("no path here"),
    "no path here",
    "text with no home directory must come through unchanged",
  );
});

test("redactEmailAddresses removes the whole address, local part included", () => {
  assert.equal(
    redactEmailAddresses("sent to named.person@example.invalid at 10:00"),
    "sent to [email] at 10:00",
  );
  assert.equal(redactEmailAddresses("x+tag@sub.example.co.uk"), "[email]");
  assert.equal(redactEmailAddresses("no address here"), "no address here");
});

test("the zone redactor removes subdomains and prefers the longest match", () => {
  const redact = buildZoneRedactor(["example.test", "mail.example.test"]);

  assert.equal(
    redact("lookup for mail.example.test failed"),
    "lookup for [zone] failed",
  );
  assert.equal(
    redact("lookup for example.test failed"),
    "lookup for [zone] failed",
  );
  assert.equal(
    redact("lookup for deep.sub.example.test."),
    "lookup for [zone]",
    "a trailing dot is part of the hostname, not of the sentence",
  );
  assert.equal(
    redact("EXAMPLE.TEST is the same zone"),
    "[zone] is the same zone",
  );
  assert.equal(
    redact("unrelated.invalid is not ours"),
    "unrelated.invalid is not ours",
  );
});

test("the zone redactor ignores values too short or malformed to be a zone", () => {
  const redact = buildZoneRedactor(["", "ab", "nodot", "a.co"]);
  assert.equal(redact("ab nodot a.co"), "ab nodot [zone]");
});

test("a code span cannot be escaped from by its content", () => {
  assert.equal(inlineCode("plain"), "`plain`");
  assert.equal(
    inlineCode("has `one` backtick run"),
    "``has `one` backtick run``",
  );
  // Four backticks: one more than the longest run inside, which is three.
  assert.equal(inlineCode("```fence```"), "```` ```fence``` ````");
  assert.equal(
    inlineCode("line one\nline two"),
    "`line one line two`",
    "a newline would end the span early and leave the rest as live markup",
  );
  assert.equal(inlineCode("   "), "``");
});

test("a fenced block cannot be escaped from by its content", () => {
  assert.equal(fencedBlock("plain", "text"), "```text\nplain\n```");
  assert.equal(
    fencedBlock("stack with ``` inside"),
    "````\nstack with ``` inside\n````",
  );
});

test("markup in a scrubbed value cannot break out of the details block", () => {
  const report = buildDiagnosticsReport({
    hostFacts: {
      keyring: {
        status: "unavailable",
        detail: "</summary></details><script>alert(1)</script>",
      },
    },
  });
  const markdown = renderDiagnosticsMarkdown(report);
  const lines = markdown.split("\n");

  // The literal does occur twice — once as the block's own terminator and once
  // inside the value. What matters is that the second occurrence is inside a
  // code span, where the renderer emits it as text rather than acting on it.
  for (const line of lines.filter((candidate) =>
    candidate.includes("</details>"),
  )) {
    assert.ok(
      line === "</details>" || line.includes("`"),
      `a bare </details> outside a code span would close the block early: ${line}`,
    );
  }
  assert.equal(
    lines.at(-2),
    "</details>",
    "the block's own terminator is the last line of the rendering",
  );
  assert.ok(
    lines.includes(
      "- Keyring detail: `</summary></details><script>alert(1)</script>`",
    ),
    `the value belongs inside a code span, where no markup is live:\n${markdown}`,
  );
});

test("a dev origin is rebuilt from a parse rather than scrubbed as text", () => {
  const report = buildDiagnosticsReport({
    dev: {
      port: 3001,
      origin: `http://localhost:3001/page?identity=${SECRETS.devIdentityToken}#frag`,
    },
  });

  assert.deepEqual(report.dev, {
    port: 3001,
    origin: "http://localhost:3001",
    // Nothing after the authority survives, so there is no token pattern to
    // get right — and the identity token has no pattern to get right.
  });
  assert.ok(!JSON.stringify(report).includes(SECRETS.devIdentityToken));
});

test("an origin that is not an http(s) URL is dropped, not echoed", () => {
  for (const origin of [
    "tauri://localhost",
    `javascript:alert("${SECRETS.devIdentityToken}")`,
    "not a url at all",
    "",
  ]) {
    const report = buildDiagnosticsReport({ dev: { port: null, origin } });
    assert.equal(report.dev?.origin, null, `${origin} should not be reported`);
  }
});

test("opaque zone and account identifiers are removed from prose at every level", () => {
  const snapshot = loadedSnapshot();
  for (const includeUserData of [false, true]) {
    const report = buildDiagnosticsReport(snapshot, { includeUserData });
    const text = JSON.stringify(report);
    for (const identifier of [IDENTIFYING.accountId, "zone-1", "zone-2"]) {
      assert.ok(
        !text.includes(identifier),
        `${identifier} survived with includeUserData=${includeUserData}: ${text}`,
      );
    }
  }
});

test("a zone name in an error message is withheld even under the opt-in", () => {
  // The opt-in's channel is the labelled zone list, which a user can read
  // before pasting. An error message buried under a stack trace is not that
  // channel, so the name is removed from prose either way.
  const report = buildDiagnosticsReport(loadedSnapshot(), {
    includeUserData: true,
  });

  assert.ok(
    report.notifications.lastError?.includes("[zone]"),
    `the zone name should be redacted in prose: ${report.notifications.lastError}`,
  );
  assert.deepEqual(
    report.userData?.zones.map((zone) => zone.name),
    [IDENTIFYING.zoneName, IDENTIFYING.otherZoneName],
    "and still printed in full in the section that exists to print it",
  );
});

test("the markdown rendering is one collapsed block with a triage summary", () => {
  const report = buildDiagnosticsReport(loadedSnapshot());
  const markdown = renderDiagnosticsMarkdown(report);
  const lines = markdown.split("\n");

  assert.equal(lines[0], "<details>");
  assert.equal(
    lines[1],
    `<summary>${diagnosticsSummaryLine(report)}</summary>`,
  );
  assert.equal(
    lines[2],
    "",
    "GitHub needs a blank line after </summary> or the markdown inside is not rendered",
  );
  assert.equal(
    diagnosticsSummaryLine(report),
    "Better Cloudflare diagnostics — 26.14, windows x86_64, desktop shell",
  );
  for (const heading of [
    "**Build**",
    "**Platform**",
    "**Security**",
    "**Services**",
    "**Counts**",
    "**Dependencies**",
    "**Not included**",
  ]) {
    assert.ok(markdown.includes(heading), `${heading} is missing`);
  }
});

test("the dependency counts come from the generated manifest", async () => {
  const { DEPENDENCY_TOTALS } =
    await import("../src/lib/about/dependency-totals.generated");
  const report = buildDiagnosticsReport({});

  assert.deepEqual(report.dependencies, {
    npmDirect: DEPENDENCY_TOTALS.npm.direct,
    npmTotal: DEPENDENCY_TOTALS.npm.total,
    rustDirect: DEPENDENCY_TOTALS.rust.direct,
    rustTotal: DEPENDENCY_TOTALS.rust.total,
  });
});
