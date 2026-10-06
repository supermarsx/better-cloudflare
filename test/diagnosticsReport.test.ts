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
} as const;

/**
 * Identifying but non-secret values. All withheld by default; only the zone
 * names are published by the opt-in.
 */
const IDENTIFYING = {
  zoneName: "primary-zone-example.test",
  otherZoneName: "second-zone-example.test",
  recordName: "selector._domainkey.primary-zone-example.test",
  recordContent: "v=DKIM1; p=MIIBIjANBgkqhkiG9w0-dkim-public-key-material",
  recordComment: "rotation note for the finance team",
  accountEmail: "named.person@example.invalid",
  accountId: "cf-account-identifier-0a1b2c3d",
  localAccountName: "RealPersonName",
} as const;

/** Every value that must never appear, regardless of the opt-in. */
const ALWAYS_FORBIDDEN: readonly string[] = [
  ...Object.values(SECRETS),
  IDENTIFYING.recordName,
  IDENTIFYING.recordContent,
  IDENTIFYING.recordComment,
  IDENTIFYING.accountEmail,
  IDENTIFYING.accountId,
  IDENTIFYING.localAccountName,
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
      keyring: {
        status: "unavailable",
        detail: `could not open C:\\Users\\${IDENTIFYING.localAccountName}\\AppData\\Roaming\\vault (password=${SECRETS.vaultPassword})`,
      },
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
        errors: 0,
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
  assert.equal(report.counts.cachedZones, 2);
  assert.equal(report.counts.cachedZonesExpired, 1);
  assert.equal(report.counts.oldestCacheAgeMs, 900_000);
  assert.equal(report.counts.newestCacheAgeMs, 5_000);
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
  assert.ok(
    !JSON.stringify(report).includes("127.0.0.1"),
    "the bind address is a network location and is not a diagnostic",
  );
});

test("AI providers are reduced to protocols, counts and whether a key exists", () => {
  const report = buildDiagnosticsReport(loadedSnapshot());

  assert.deepEqual(report.services.ai, {
    providersConfigured: 2,
    protocols: ["anthropic", "openai"],
    providersWithStoredKey: 1,
  });
  assert.ok(
    !JSON.stringify(report).includes("api.anthropic.com"),
    "a base URL is withheld even when it is a public endpoint, because the field cannot tell",
  );
});

test("a protocol outside the closed set is dropped rather than echoed", () => {
  const report = buildDiagnosticsReport({
    aiProviders: [
      { protocol: `smuggled ${SECRETS.aiProviderKey}`, hasApiKey: true },
      { protocol: "ollama", hasApiKey: false },
    ],
  });

  assert.deepEqual(report.services.ai.protocols, ["ollama"]);
  assert.ok(!JSON.stringify(report).includes(SECRETS.aiProviderKey));
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
  assert.deepEqual(report.services.ai.protocols, []);
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
    report.services.notifications.lastError?.includes("[zone]"),
    `the zone name should be redacted in prose: ${report.services.notifications.lastError}`,
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
