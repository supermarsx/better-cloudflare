/**
 * The one bounded `invoke` the diagnostics collector calls native commands
 * through.
 *
 * `tauri-client.ts` owns the application's command surface and its own private
 * `invoke`, but the diagnostics report needs three commands that surface does
 * not expose — `app_host_facts`, `audit_trail_summary` and
 * `list_retained_records`. Rather than a second invoke implementation, this
 * composes the pieces that file already exports: {@link withTauriUiTimeout}
 * for the deadline and abort handling, {@link getTauriInvokeTimeoutMs} for the
 * per-command budget, and {@link normalizeTauriInvokeError} for the error
 * shape. A command added here therefore behaves like every other one without
 * anything to keep in step.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import {
  getTauriInvokeTimeoutMs,
  normalizeTauriInvokeError,
  withTauriUiTimeout,
} from "@/lib/api/tauri-client";

/** Invoke a native command under the application's standard UI deadline. */
export async function hostInvoke<T>(
  command: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await withTauriUiTimeout(
      tauriInvoke<T>(command, args),
      command,
      getTauriInvokeTimeoutMs(command),
      signal,
    );
  } catch (error) {
    throw normalizeTauriInvokeError(error, command);
  }
}
