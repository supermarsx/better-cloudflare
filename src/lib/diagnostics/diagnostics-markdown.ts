/**
 * Rendering a {@link DiagnosticsReport} into the text the copy button copies.
 *
 * # Markdown, and why not plain text
 *
 * The destination is a GitHub issue, and plain text does not survive one.
 * Markdown reflows consecutive lines into a paragraph, so a plain-text blob
 * arrives as a wall of run-together fragments; `#`, `*` and `_` inside error
 * messages are interpreted; and a 60-line blob pasted raw buries the actual
 * bug report above it.
 *
 * So the whole payload is one collapsed `<details>` block. It costs the issue
 * a single summary line that already carries the three facts a maintainer
 * triages on — version, platform, shell — and expands to the rest. Bullet
 * lists keep the fields skimmable, and every value that did not originate in
 * this codebase goes inside a code span or a fenced block, which is both why
 * a stack trace stays monospaced and why a value containing `</details>` or
 * `<script>` cannot break out of the block it is in.
 *
 * {@link renderDiagnosticsJson} is the second format, for the maintainer who
 * wants to diff two reports rather than read one.
 */
import type { DiagnosticsReport } from "./diagnostics-report";

/**
 * Wrap a value in a code span that cannot be escaped from.
 *
 * CommonMark delimits a code span with a run of backticks longer than any run
 * inside it, and pads with a space when the content starts or ends with a
 * backtick. Newlines are collapsed first: a code span cannot contain one, and
 * a value with an embedded newline would otherwise end the span early and
 * leave the remainder as live Markdown.
 */
export function inlineCode(value: string): string {
  const flattened = value.replace(/\s*[\r\n]+\s*/gu, " ").trim();
  if (flattened.length === 0) return "``";
  const longestRun = Math.max(
    0,
    ...[...flattened.matchAll(/`+/gu)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longestRun + 1);
  const pad = flattened.startsWith("`") || flattened.endsWith("`") ? " " : "";
  return `${fence}${pad}${flattened}${pad}${fence}`;
}

/**
 * Wrap multi-line text in a fenced block that cannot be escaped from.
 *
 * The fence is longer than the longest backtick run in the content, which is
 * what stops a stack trace containing ``` from closing the block and spilling
 * the rest into the issue as markup.
 */
export function fencedBlock(value: string, language = ""): string {
  const longestRun = Math.max(
    0,
    ...[...value.matchAll(/`+/gu)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

/** A bullet whose value came from this codebase and needs no quoting. */
function plainRow(label: string, value: string | number | boolean): string {
  return `- ${label}: ${String(value)}`;
}

/** A bullet whose value came from outside and is quoted as code. */
function quotedRow(label: string, value: string): string {
  return `- ${label}: ${inlineCode(value)}`;
}

/**
 * A bullet, or nothing at all for an absent value.
 *
 * Absent fields are dropped rather than rendered as `unknown`: a reader
 * skimming 60 bullets needs the ones that say something, and "the keyring row
 * is missing" and "the keyring row says unknown" mean the same thing while the
 * first is shorter. The JSON rendering keeps every `null` for a reader who
 * needs to tell them apart.
 */
function optionalRow(
  label: string,
  value: string | number | boolean | null,
  quote = false,
): string[] {
  if (value === null) return [];
  if (typeof value === "string") {
    return value.length === 0
      ? []
      : [quote ? quotedRow(label, value) : plainRow(label, value)];
  }
  return [plainRow(label, value)];
}

/** `yes` / `no`, which reads better in a bullet list than `true` / `false`. */
function yesNo(value: boolean | null): string | null {
  return value === null ? null : value ? "yes" : "no";
}

function section(title: string, rows: string[]): string[] {
  if (rows.length === 0) return [];
  return [`**${title}**`, "", ...rows, ""];
}

/**
 * The one-line summary the issue shows before the block is expanded.
 *
 * Carries exactly what triage needs to route a report: which release, which
 * platform, and whether this is the desktop shell or a browser against the dev
 * server — the three facts most often missing from a bug report.
 */
export function diagnosticsSummaryLine(report: DiagnosticsReport): string {
  const platform = [report.platform.os, report.platform.arch]
    .filter((part): part is string => part !== null)
    .join(" ");
  const parts = [
    report.build.versionLabel,
    platform.length > 0 ? platform : null,
    `${report.build.shell} shell`,
  ].filter((part): part is string => part !== null && part.length > 0);
  return `Better Cloudflare diagnostics — ${parts.join(", ")}`;
}

function buildRows(report: DiagnosticsReport): string[] {
  const { build } = report;
  return [
    plainRow("Version", build.versionLabel),
    ...optionalRow("Build profile", build.buildProfile),
    plainRow("Shell", build.shell),
    ...optionalRow("Tauri", build.tauriVersion),
    ...optionalRow("Webview", build.webviewVersion),
    // Named as a placeholder so nobody quotes it back as the version.
    ...optionalRow(
      "Bundle version (placeholder, not the release)",
      build.bundleVersion,
    ),
  ];
}

function platformRows(report: DiagnosticsReport): string[] {
  const { platform } = report;
  const target = [platform.os, platform.arch, platform.family]
    .filter((part): part is string => part !== null)
    .join(" / ");
  return [
    ...optionalRow("Target", target.length > 0 ? target : null),
    ...optionalRow("User agent", platform.userAgent, true),
    ...optionalRow("Language", platform.language, true),
    ...optionalRow("Time zone", platform.timeZone, true),
    ...optionalRow(
      "Viewport",
      platform.viewport === null
        ? null
        : `${platform.viewport.width}x${platform.viewport.height}`,
    ),
    ...optionalRow("Device pixel ratio", platform.devicePixelRatio),
    ...optionalRow("Online", yesNo(platform.online)),
    ...optionalRow(
      "Dark colour scheme",
      yesNo(platform.prefersDarkColorScheme),
    ),
    ...optionalRow("Reduced motion", yesNo(platform.prefersReducedMotion)),
  ];
}

function securityRows(report: DiagnosticsReport): string[] {
  const { keyring, biometrics, passkeys } = report.security;
  return [
    plainRow("Keyring", keyring.status),
    ...optionalRow("Keyring detail", keyring.detail, true),
    ...optionalRow("Biometrics available", yesNo(biometrics.available)),
    ...optionalRow("Biometric type", biometrics.type),
    ...optionalRow("Biometrics detail", biometrics.reason, true),
    ...optionalRow(
      "Passkey registration",
      yesNo(passkeys.registrationAvailable),
    ),
    ...optionalRow(
      "Passkey authentication",
      yesNo(passkeys.authenticationAvailable),
    ),
    ...optionalRow("Native passkey ceremony", yesNo(passkeys.nativeCeremony)),
    ...optionalRow("Native passkey client", passkeys.nativeClient, true),
    ...optionalRow(
      "Legacy passkeys need re-registration",
      yesNo(passkeys.legacyCredentialsRequireReregistration),
    ),
    ...optionalRow(
      "Passkeys unavailable because",
      passkeys.unavailableReason,
      true,
    ),
    ...optionalRow("Passkeys registered", passkeys.registered),
  ];
}

function servicesRows(report: DiagnosticsReport): string[] {
  const { mcp, notifications, ai } = report.services;
  const notificationState = [
    notifications.running === null
      ? null
      : notifications.running
        ? "running"
        : "stopped",
    notifications.enabled === true ? "enabled" : null,
    notifications.paused === true ? "paused" : null,
    notifications.quietHoursActive === true ? "quiet hours" : null,
  ].filter((part): part is string => part !== null);

  return [
    ...optionalRow("MCP server", yesNo(mcp.running)),
    ...optionalRow("MCP binding", mcp.binding),
    ...optionalRow("MCP port", mcp.port),
    ...optionalRow(
      "MCP tools",
      mcp.toolsEnabled === null || mcp.toolsAvailable === null
        ? null
        : `${mcp.toolsEnabled} enabled of ${mcp.toolsAvailable}`,
    ),
    ...optionalRow("MCP last error", mcp.lastError, true),
    ...optionalRow(
      "Notifications",
      notificationState.length > 0 ? notificationState.join(", ") : null,
    ),
    ...optionalRow("Notifications zones tracked", notifications.zonesTracked),
    ...optionalRow("Notifications unread", notifications.unread),
    ...optionalRow("Last record check", notifications.lastRecordCheckAt),
    ...optionalRow("Last expiry check", notifications.lastExpiryCheckAt),
    ...optionalRow("Last audit check", notifications.lastAuditCheckAt),
    ...optionalRow("Next record check", notifications.nextRecordCheckAt),
    ...optionalRow("Next expiry check", notifications.nextExpiryCheckAt),
    ...optionalRow("Next audit check", notifications.nextAuditCheckAt),
    ...optionalRow("Notification backoff until", notifications.backoffUntil),
    ...optionalRow("Notifications last error", notifications.lastError, true),
    ...optionalRow(
      "Last notification pass",
      notifications.lastPass === null
        ? null
        : `${notifications.lastPass.kind ?? "unknown"} in ${notifications.lastPass.durationMs ?? "?"}ms, ${notifications.lastPass.zonesChecked ?? "?"} zones, ${notifications.lastPass.notificationsCreated ?? "?"} created, ${notifications.lastPass.errors ?? "?"} errors`,
    ),
    ...optionalRow("AI providers configured", ai.providersConfigured),
    ...optionalRow(
      "AI protocols",
      ai.protocols.length > 0 ? ai.protocols.join(", ") : null,
    ),
    ...optionalRow("AI providers with a stored key", ai.providersWithStoredKey),
  ];
}

function countsRows(report: DiagnosticsReport): string[] {
  const { counts } = report;
  const histogram = counts.recordTypes
    .map((entry) => `${entry.type} ${entry.count}`)
    .join(", ");
  return [
    ...optionalRow("Zone tabs open", counts.zoneTabsOpen),
    ...optionalRow("Zones available", counts.zonesAvailable),
    ...optionalRow("Records loaded", counts.recordsLoaded),
    ...optionalRow("Record types", histogram.length > 0 ? histogram : null),
    ...optionalRow("Cached zones", counts.cachedZones),
    ...optionalRow("Cached zones expired", counts.cachedZonesExpired),
    ...optionalRow("Oldest cache entry (ms)", counts.oldestCacheAgeMs),
    ...optionalRow("Newest cache entry (ms)", counts.newestCacheAgeMs),
    ...optionalRow("API credentials stored", counts.apiCredentialsStored),
    ...optionalRow(
      "Registrar credentials stored",
      counts.registrarCredentialsStored,
    ),
  ];
}

function dependencyRows(report: DiagnosticsReport): string[] {
  const { dependencies } = report;
  return [
    plainRow(
      "npm packages",
      `${dependencies.npmDirect} direct, ${dependencies.npmTotal} total`,
    ),
    plainRow(
      "Rust crates",
      `${dependencies.rustDirect} direct, ${dependencies.rustTotal} total`,
    ),
  ];
}

function devRows(report: DiagnosticsReport): string[] {
  if (report.dev === null) return [];
  return [
    ...optionalRow("Dev server port", report.dev.port),
    ...optionalRow("Origin", report.dev.origin, true),
  ];
}

/**
 * The retained runtime errors, each in its own fenced block.
 *
 * Fenced rather than quoted inline because a stack trace is multi-line and
 * monospaced text is how a reader finds a frame in it.
 */
function runtimeErrorLines(report: DiagnosticsReport): string[] {
  const { runtimeErrors } = report;
  if (runtimeErrors.entries.length === 0) {
    return section("Recent runtime errors", ["- None recorded this session"]);
  }
  const heading =
    runtimeErrors.retained > runtimeErrors.shown
      ? `**Recent runtime errors** (${runtimeErrors.shown} of ${runtimeErrors.retained} retained)`
      : `**Recent runtime errors** (${runtimeErrors.shown})`;
  const blocks = runtimeErrors.entries.flatMap((entry) => [
    `${entry.source} · ${entry.timestamp}${entry.occurrences > 1 ? ` · ${entry.occurrences} occurrences` : ""}`,
    "",
    fencedBlock(entry.detail, "text"),
    "",
  ]);
  return [heading, "", ...blocks];
}

/**
 * The opt-in zone names, present only when the user asked for them.
 *
 * The heading says so explicitly, because a maintainer reading the block needs
 * to know these arrived by a deliberate choice and a user re-reading their own
 * paste needs to see what they published.
 */
function userDataLines(report: DiagnosticsReport): string[] {
  if (report.userData === null) return [];
  const rows = report.userData.zones.map(
    (zone) =>
      `- ${inlineCode(zone.name)}${zone.records === null ? "" : ` — ${zone.records} records loaded`}`,
  );
  if (report.userData.omitted > 0) {
    rows.push(`- (${report.userData.omitted} further zones not listed)`);
  }
  return section(
    "Zones (included at the user's request)",
    rows.length > 0 ? rows : ["- None"],
  );
}

/**
 * Render the payload as the text the copy button puts on the clipboard.
 *
 * One `<details>` block, so pasting it into an issue costs one line until
 * someone expands it. The blank line after `</summary>` is required: without
 * it GitHub treats the contents as raw HTML and the bullet lists do not
 * render.
 */
export function renderDiagnosticsMarkdown(report: DiagnosticsReport): string {
  const body = [
    `Captured ${report.capturedAt} · ${report.schema}`,
    "",
    ...section("Build", buildRows(report)),
    ...section("Platform", platformRows(report)),
    ...section("Security", securityRows(report)),
    ...section("Services", servicesRows(report)),
    ...section("Counts", countsRows(report)),
    ...section("Dependencies", dependencyRows(report)),
    ...section("Dev server", devRows(report)),
    ...runtimeErrorLines(report),
    ...userDataLines(report),
    ...section(
      "Not included",
      report.withheld.map((note) => `- ${note}`),
    ),
  ];

  return [
    "<details>",
    `<summary>${diagnosticsSummaryLine(report)}</summary>`,
    "",
    ...body,
    "</details>",
    "",
  ].join("\n");
}

/**
 * The same payload as JSON, for diffing two reports rather than reading one.
 *
 * Keeps every `null` the Markdown rendering drops, so "absent" and "unknown"
 * remain distinguishable.
 */
export function renderDiagnosticsJson(report: DiagnosticsReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
