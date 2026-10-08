/**
 * The frontend's view of `src-tauri/src/diagnostics_commands.rs`.
 *
 * Two commands. `app_host_facts` reports what the webview cannot see for
 * itself: the release tag stamped into the binary, the target it was compiled
 * for, what the OS says about itself, the Tauri and webview versions, and
 * whether the keyring is answering. `audit_trail_summary` counts the audit
 * trail host-side so that no entry crosses the IPC boundary — the trail
 * records record content, and the report is built to be pasted in public.
 *
 * In the browser dev server there is no host to ask, and every consumer treats
 * `null` as "not a desktop build" rather than as a failure.
 */
import { isDesktop } from "@/lib/environment";

import { hostInvoke } from "./host-invoke";

/** The commands this module calls. Both registered in `main.rs`. */
export const HOST_FACTS_COMMAND = "app_host_facts";
export const AUDIT_SUMMARY_COMMAND = "audit_trail_summary";

/** Mirrors `KeyringAvailability`. */
export type KeyringAvailability = "available" | "unavailable" | "unknown";

/** Mirrors `KeyringProbe`. */
export interface KeyringProbe {
  status: KeyringAvailability;
  /** The backend's refusal text, if there was one. Free-form; scrub it. */
  detail?: string | null;
}

/**
 * Mirrors `OsRelease` — what the OS says about itself, from `os_info`.
 *
 * This is the field {@link HostFacts.os} cannot be. `os` is the compile
 * target, so it says `"windows"` and carries no release; and the webview user
 * agent is no substitute, because every Windows 11 reports `Windows NT 10.0`
 * in its UA by design. `"Windows 11 Professional 10.0.26200"` only exists
 * because the host asked the OS.
 */
export interface OsRelease {
  osType?: string | null;
  version?: string | null;
  edition?: string | null;
  codename?: string | null;
  bitness?: string | null;
  /** The machine's own architecture, which an emulated build's differs from. */
  architecture?: string | null;
}

/** Mirrors `HostFacts`. */
export interface HostFacts {
  /** The `YY.N` release tag, or `null` for an unstamped local build. */
  releaseTag?: string | null;
  /** `tauri.conf.json`'s placeholder `0.0.0`, never the release version. */
  bundleVersion?: string | null;
  appName?: string | null;
  buildProfile?: string | null;
  os?: string | null;
  arch?: string | null;
  family?: string | null;
  tauriVersion?: string | null;
  webviewVersion?: string | null;
  osRelease?: OsRelease | null;
  keyring?: KeyringProbe | null;
}

/**
 * Ask the host for its facts, or resolve `null` when there is no host.
 *
 * Never rejects. A diagnostics screen that fails to open because one of its
 * probes failed is worse than one that renders with a row missing, and the
 * missing row is itself visible in the payload as a `null`.
 */
export async function fetchHostFacts(
  signal?: AbortSignal,
): Promise<HostFacts | null> {
  if (!isDesktop()) return null;
  try {
    return await hostInvoke<HostFacts>(HOST_FACTS_COMMAND, {}, signal);
  } catch {
    // Swallowed on purpose: which probe failed is not itself a diagnostic
    // worth risking a thrown error on a diagnostics screen, and the missing
    // row is already visible in the payload as a `null`.
    return null;
  }
}

/**
 * Mirrors `AuditTrailSummary` — the audit trail reduced to counts.
 *
 * The maps are keyed by `AuditActor::as_str` and `AuditOutcome::as_str`. The
 * builder reads them through the closed vocabularies rather than iterating the
 * reply's keys, so a key a newer build invents cannot put its own text in the
 * payload.
 */
export interface AuditTrailSummary {
  entries?: number | null;
  capacity?: number | null;
  oldestAt?: string | null;
  newestAt?: string | null;
  byActor?: Record<string, number> | null;
  byOutcome?: Record<string, number> | null;
}

/**
 * Ask the host to count the audit trail.
 *
 * The counting happens on the other side of the IPC boundary and that is the
 * whole point — see the module comment in `diagnostics_commands.rs`. Never
 * rejects, for the same reason {@link fetchHostFacts} does not.
 */
export async function fetchAuditTrailSummary(
  signal?: AbortSignal,
): Promise<AuditTrailSummary | null> {
  if (!isDesktop()) return null;
  try {
    return await hostInvoke<AuditTrailSummary>(
      AUDIT_SUMMARY_COMMAND,
      {},
      signal,
    );
  } catch {
    return null;
  }
}
