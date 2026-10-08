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
  // The OS on one line, because it is read as one fact. `edition` already
  // contains the marketing name on Windows ("Windows 11 Professional"), so the
  // type is only prepended when it would not repeat it.
  const osParts = [
    platform.osEdition ??
      (platform.osName === null ? null : platform.osName) ??
      null,
    platform.osEdition !== null &&
    platform.osName !== null &&
    !platform.osEdition.toLowerCase().includes(platform.osName.toLowerCase())
      ? `(${platform.osName})`
      : null,
    platform.osVersion,
    platform.osCodename === null ? null : `"${platform.osCodename}"`,
    platform.osBitness,
  ].filter((part): part is string => part !== null && part.length > 0);

  return [
    ...optionalRow(
      "Operating system",
      osParts.length > 0 ? osParts.join(" ") : null,
    ),
    ...optionalRow("Build target", target.length > 0 ? target : null),
    // Only when it differs from the build's: an x86_64 binary under Rosetta on
    // an arm64 Mac is a real and confusing bug report, and a repeated row is
    // noise in every other one.
    ...optionalRow(
      "Machine architecture",
      platform.machineArch !== null && platform.machineArch !== platform.arch
        ? platform.machineArch
        : null,
    ),
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

/**
 * What update checking has been doing.
 *
 * `lastStatus` is absent unless a check ran in this session, and the row is
 * then dropped rather than printed as "unknown" — see
 * {@link DiagnosticsUpdatesSection.lastStatus}, which must not read as
 * "up to date".
 */
function updateRows(report: DiagnosticsReport): string[] {
  const { updates } = report;
  const cadence =
    updates.checkEnabled === null
      ? null
      : updates.checkEnabled
        ? `every ${updates.intervalHours ?? "?"}h${updates.includePrereleases === true ? ", pre-releases included" : ""}`
        : "disabled";
  return [
    ...optionalRow("Checking", cadence),
    ...optionalRow("Last checked", updates.lastCheckedAt),
    ...optionalRow("Check due now", yesNo(updates.checkDue)),
    ...optionalRow("Last verdict", updates.lastStatus),
    ...optionalRow(
      "Latest release seen",
      updates.latestSeenTag === null
        ? null
        : `${updates.latestSeenTag}${updates.latestIsPrerelease === true ? " (pre-release)" : ""}${updates.latestSeenPublishedAt === null ? "" : `, published ${updates.latestSeenPublishedAt}`}`,
    ),
  ];
}

/** How long the window has been open, in whole units a reader can scan. */
function describeDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function sessionRows(report: DiagnosticsReport): string[] {
  const { session } = report;
  return [
    ...optionalRow("Window opened", session.startedAt),
    ...optionalRow(
      "Open for",
      session.uptimeMs === null ? null : describeDuration(session.uptimeMs),
    ),
  ];
}

/**
 * The notification service.
 *
 * One row per pass kind rather than six timestamp rows: "records — last …,
 * next …" is the shape of the question, and collapsing it keeps the section
 * readable now that it carries counters too.
 */
function notificationRows(report: DiagnosticsReport): string[] {
  const notifications = report.notifications;
  const state = [
    notifications.running === null
      ? null
      : notifications.running
        ? "running"
        : "stopped",
    notifications.enabled === true ? "enabled" : null,
    notifications.enabled === false ? "disabled in settings" : null,
    notifications.paused === true ? "paused" : null,
    notifications.quietHoursActive === true ? "quiet hours in force" : null,
  ].filter((part): part is string => part !== null);

  const passRows = notifications.passes.flatMap((pass) => {
    const schedule = [
      pass.lastCheckAt === null ? null : `last ${pass.lastCheckAt}`,
      pass.nextCheckAt === null ? null : `next ${pass.nextCheckAt}`,
    ].filter((part): part is string => part !== null);
    // A kind that has neither run nor been scheduled is a kind that is off;
    // printing "unknown" twice for it would be three wasted lines per report.
    if (schedule.length === 0 && pass.lastPass === null) return [];
    const counters =
      pass.lastPass === null
        ? []
        : [
            `${pass.lastPass.zonesChecked ?? "?"} zones`,
            `${pass.lastPass.notificationsCreated ?? "?"} created`,
            pass.lastPass.notificationsRefreshed === null
              ? null
              : `${pass.lastPass.notificationsRefreshed} refreshed`,
            pass.lastPass.notificationsSuperseded === null
              ? null
              : `${pass.lastPass.notificationsSuperseded} superseded`,
            `${pass.lastPass.errors ?? "?"} errors`,
            pass.lastPass.durationMs === null
              ? null
              : `${pass.lastPass.durationMs}ms`,
            pass.lastPass.skipped === true ? "skipped" : null,
            pass.lastPass.backoff === true ? "asked for backoff" : null,
          ].filter((part): part is string => part !== null);
    const detail = [schedule.join(", "), counters.join(", ")]
      .filter((part) => part.length > 0)
      .join(" — ");
    const name = `${pass.kind.slice(0, 1).toUpperCase()}${pass.kind.slice(1)}`;
    return [plainRow(`${name} pass`, detail)];
  });

  return [
    ...optionalRow("Service", state.length > 0 ? state.join(", ") : null),
    ...optionalRow("Zones tracked", notifications.zonesTracked),
    ...optionalRow("Unread", notifications.unread),
    ...optionalRow("Backoff until", notifications.backoffUntil),
    ...optionalRow("Last error", notifications.lastError, true),
    ...passRows,
  ];
}

function servicesRows(report: DiagnosticsReport): string[] {
  const { mcp, assistant } = report.services;
  const mcpCatalogue = [
    mcp.toolsEnabled === null || mcp.toolsAvailable === null
      ? null
      : `${mcp.toolsEnabled} of ${mcp.toolsAvailable} tools enabled`,
    mcp.promptsAvailable === null ? null : `${mcp.promptsAvailable} prompts`,
    mcp.resourcesAvailable === null
      ? null
      : `${mcp.resourcesAvailable} resources`,
  ].filter((part): part is string => part !== null);

  const overrides = assistant.toolOverrides;
  return [
    ...optionalRow(
      "MCP server",
      mcp.running === null
        ? null
        : `${mcp.running ? "running" : "stopped"}${mcp.binding === null ? "" : `, ${mcp.binding}`}${mcp.port === null ? "" : `:${mcp.port}`}`,
    ),
    ...optionalRow(
      "MCP catalogue",
      mcpCatalogue.length > 0 ? mcpCatalogue.join(", ") : null,
    ),
    ...optionalRow("MCP last error", mcp.lastError, true),
    ...optionalRow(
      "Assistant providers",
      assistant.providersConfigured === null
        ? null
        : `${assistant.providersConfigured} configured, ${assistant.providersWithStoredKey ?? "?"} with a stored key`,
    ),
    ...optionalRow(
      "Assistant protocols",
      assistant.protocols.length > 0 ? assistant.protocols.join(", ") : null,
    ),
    ...optionalRow(
      "Assistant personas",
      assistant.personasTotal === null
        ? null
        : `${assistant.personasTotal} (${assistant.personasBuiltin ?? "?"} built in, ${assistant.personasCustom ?? "?"} custom)`,
    ),
    ...optionalRow("Assistant permission mode", assistant.permissionMode),
    ...optionalRow(
      "Assistant tool overrides",
      overrides === null
        ? null
        : `${overrides.allow} allow, ${overrides.ask} ask, ${overrides.deny} deny`,
    ),
    ...optionalRow(
      "Assistant tool availability",
      assistant.toolsRegistered === null
        ? null
        : `${assistant.toolsUsable ?? "?"} usable of ${assistant.toolsGranted ?? "?"} granted, ${assistant.toolsRegistered} registered`,
    ),
    ...optionalRow(
      "Assistant can dispatch",
      yesNo(assistant.dispatchAvailable),
    ),
  ];
}

function storageRows(report: DiagnosticsReport): string[] {
  const { recycleBin, offlineCache, auditTrail } = report.storage;
  const actors = auditTrail.byActor
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.actor} ${entry.count}`)
    .join(", ");
  const outcomes = auditTrail.byOutcome
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.outcome} ${entry.count}`)
    .join(", ");

  return [
    ...optionalRow(
      "Recycle bin",
      recycleBin.entriesHeld === null
        ? null
        : `${recycleBin.entriesHeld} held of ${recycleBin.maxEntries ?? "?"} (${recycleBin.disabled ?? "?"} disabled, ${recycleBin.binned ?? "?"} binned${(recycleBin.unknownReason ?? 0) > 0 ? `, ${recycleBin.unknownReason} unknown` : ""})`,
    ),
    ...optionalRow(
      "Recycle bin expired",
      recycleBin.expiredPendingPurge === null
        ? null
        : `${recycleBin.expiredPendingPurge} pending purge`,
    ),
    ...optionalRow(
      "Recycle bin size",
      recycleBin.bytesHeld === null
        ? null
        : `${recycleBin.bytesHeld} of ${recycleBin.maxBytes ?? "?"} bytes${recycleBin.percentOfByteCeiling === null ? "" : ` (${recycleBin.percentOfByteCeiling}%)`}`,
    ),
    ...optionalRow(
      "Offline cache",
      offlineCache.cachedZones === null
        ? null
        : `${offlineCache.cachedZones} zones, ${offlineCache.cachedZonesExpired ?? "?"} expired`,
    ),
    ...optionalRow(
      "Offline cache age",
      offlineCache.oldestCacheAgeMs === null
        ? null
        : `oldest ${describeDuration(offlineCache.oldestCacheAgeMs)}, newest ${offlineCache.newestCacheAgeMs === null ? "?" : describeDuration(offlineCache.newestCacheAgeMs)}`,
    ),
    ...optionalRow(
      "Audit trail",
      auditTrail.entries === null
        ? null
        : `${auditTrail.entries} entries of ${auditTrail.capacity ?? "?"}`,
    ),
    ...optionalRow(
      "Audit trail span",
      auditTrail.oldestAt === null
        ? null
        : `${auditTrail.oldestAt} to ${auditTrail.newestAt ?? "?"}`,
    ),
    ...optionalRow("Audit by actor", actors.length > 0 ? actors : null),
    ...optionalRow("Audit by outcome", outcomes.length > 0 ? outcomes : null),
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
    // Ordered by how often a section is the answer; see the comment on
    // `DiagnosticsReport`'s field order, which this mirrors.
    ...section("Build", buildRows(report)),
    ...section("Updates", updateRows(report)),
    ...section("Platform", platformRows(report)),
    ...section("Session", sessionRows(report)),
    ...section("Security", securityRows(report)),
    ...section("Notifications", notificationRows(report)),
    ...section("Services", servicesRows(report)),
    ...section("Storage", storageRows(report)),
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
