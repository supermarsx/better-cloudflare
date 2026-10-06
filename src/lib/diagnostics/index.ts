/**
 * The diagnostics data layer: one import site for the panel that renders it.
 *
 * - `diagnostics-report.ts` decides what reaches the payload. Pure.
 * - `collect-diagnostics.ts` gathers the inputs from the host and the browser.
 * - `diagnostics-markdown.ts` renders the text the copy button copies.
 * - `redaction.ts` scrubs the free-form strings.
 * - `host-facts.ts` is the `app_host_facts` command's frontend edge.
 */
import { copyTextToClipboard } from "@/lib/errors/runtime-reporting";

import {
  renderDiagnosticsJson,
  renderDiagnosticsMarkdown,
} from "./diagnostics-markdown";
import type { DiagnosticsReport } from "./diagnostics-report";

export {
  buildDiagnosticsReport,
  classifyMcpBinding,
  describeVersion,
  DIAGNOSTICS_SCHEMA,
} from "./diagnostics-report";
export type {
  DiagnosticsAiProvider,
  DiagnosticsBiometricStatus,
  DiagnosticsBrowserFacts,
  DiagnosticsBuildSection,
  DiagnosticsCacheEntry,
  DiagnosticsCountsSection,
  DiagnosticsDevFacts,
  DiagnosticsErrorEntry,
  DiagnosticsMcpStatus,
  DiagnosticsNotificationStatus,
  DiagnosticsOptions,
  DiagnosticsPasskeyStatus,
  DiagnosticsPlatformSection,
  DiagnosticsRecord,
  DiagnosticsReport,
  DiagnosticsSecuritySection,
  DiagnosticsServicesSection,
  DiagnosticsSnapshot,
  DiagnosticsUserDataSection,
  DiagnosticsWorkspaceCounts,
  DiagnosticsZone,
  McpBinding,
} from "./diagnostics-report";

export {
  collectBrowserFacts,
  collectDevFacts,
  collectDiagnosticsReport,
  collectDiagnosticsSnapshot,
  describeBrowserFacts,
  describeDevServer,
} from "./collect-diagnostics";
export type {
  BrowserFactsSource,
  DiagnosticsCollectionInput,
  LocationSource,
} from "./collect-diagnostics";

export {
  diagnosticsSummaryLine,
  fencedBlock,
  inlineCode,
  renderDiagnosticsJson,
  renderDiagnosticsMarkdown,
} from "./diagnostics-markdown";

export {
  buildIdentifierRedactor,
  buildZoneRedactor,
  createDiagnosticsScrubber,
  redactEmailAddresses,
  redactUserPaths,
  REDACTED_EMAIL,
  REDACTED_IDENTIFIER,
  REDACTED_USER,
  REDACTED_ZONE,
} from "./redaction";
export type {
  DiagnosticsScrubber,
  DiagnosticsScrubberOptions,
} from "./redaction";

export { fetchHostFacts, HOST_FACTS_COMMAND } from "./host-facts";
export type {
  HostFacts,
  KeyringAvailability,
  KeyringProbe,
} from "./host-facts";

/** Which rendering the copy button puts on the clipboard. */
export type DiagnosticsCopyFormat = "markdown" | "json";

/**
 * Render a report in one of the two formats.
 *
 * Markdown is the default because the destination is a GitHub issue; see the
 * module comment in `diagnostics-markdown.ts`.
 */
export function renderDiagnostics(
  report: DiagnosticsReport,
  format: DiagnosticsCopyFormat = "markdown",
): string {
  return format === "json"
    ? renderDiagnosticsJson(report)
    : renderDiagnosticsMarkdown(report);
}

/**
 * Copy a report to the clipboard.
 *
 * Uses the same clipboard path as the error dialog's copy button
 * ({@link copyTextToClipboard}), including the `execCommand` fallback for a
 * webview where `navigator.clipboard` is unavailable, so the two buttons
 * either both work or both fail for the same reason.
 */
export async function copyDiagnosticsReport(
  report: DiagnosticsReport,
  format: DiagnosticsCopyFormat = "markdown",
): Promise<boolean> {
  return copyTextToClipboard(renderDiagnostics(report, format));
}
