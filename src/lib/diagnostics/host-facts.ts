/**
 * The frontend's view of `app_host_facts` (`src-tauri/src/diagnostics_commands.rs`).
 *
 * These are the facts the webview cannot see for itself: the release tag
 * stamped into the binary, the target it was compiled for, the Tauri and
 * webview versions, and whether the OS keyring is answering. In the browser
 * dev server there is no host to ask, and every consumer treats `null` as
 * "not a desktop build" rather than as a failure.
 *
 * The invoke is built from `tauri-client.ts`'s own exported pieces —
 * {@link withTauriUiTimeout}, {@link getTauriInvokeTimeoutMs} and
 * {@link normalizeTauriInvokeError} — so this command gets the same deadline,
 * the same abort handling and the same error normalisation as every other
 * command, without a second invoke implementation to keep in step.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import {
  getTauriInvokeTimeoutMs,
  normalizeTauriInvokeError,
  withTauriUiTimeout,
} from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";

/** The command this module calls. Registered in `main.rs` by the app shell. */
export const HOST_FACTS_COMMAND = "app_host_facts";

/** Mirrors `KeyringAvailability`. */
export type KeyringAvailability = "available" | "unavailable" | "unknown";

/** Mirrors `KeyringProbe`. */
export interface KeyringProbe {
  status: KeyringAvailability;
  /** The backend's refusal text, if there was one. Free-form; scrub it. */
  detail?: string | null;
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
    return await withTauriUiTimeout(
      tauriInvoke<HostFacts>(HOST_FACTS_COMMAND),
      HOST_FACTS_COMMAND,
      getTauriInvokeTimeoutMs(HOST_FACTS_COMMAND),
      signal,
    );
  } catch (error) {
    // Normalised for its side effect of classifying the failure; the value is
    // deliberately dropped, because which probe failed is not itself a
    // diagnostic worth risking a thrown error on a diagnostics screen.
    void normalizeTauriInvokeError(error, HOST_FACTS_COMMAND);
    return null;
  }
}
