import { useCallback, useEffect, useState } from "react";
import {
  TauriClient,
  createPreferenceFailureReporter,
} from "@/lib/api/tauri-client";
import {
  clampPropagationSettings,
  type PropagationSettings,
} from "@/lib/dns/propagation-resolvers";
import { isDesktop } from "@/lib/environment";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import { storageManager } from "@/lib/storage/storage";

const PROPAGATION_PREF_KEYS = [
  "propagationResolvers",
  "propagationCustomResolvers",
  "propagationTimeoutMs",
  "propagationAttempts",
  "propagationConsensusPercent",
  "propagationWatchIntervalS",
  "propagationSettingsReset",
  "settingsCleared",
] as const;

const reportPreferenceFailure = createPreferenceFailureReporter((error) => {
  reportRuntimeError(error, {
    source: "runtime",
    label: "Persist desktop propagation preferences",
  });
});

/** Desktop `Preferences` (snake_case) mirror of the browser fields. */
export function toDesktopPropagationFields(
  settings: PropagationSettings,
): Record<string, unknown> {
  return {
    propagation_resolvers: settings.resolvers,
    propagation_custom_resolvers: settings.customResolvers,
    propagation_timeout_ms: settings.timeoutMs,
    propagation_attempts: settings.attempts,
    propagation_consensus_percent: settings.consensusPercent,
    propagation_watch_interval_s: settings.watchIntervalS,
  };
}

function writeToStorage(settings: PropagationSettings): void {
  storageManager.setPropagationResolvers(settings.resolvers);
  storageManager.setPropagationCustomResolvers(settings.customResolvers);
  storageManager.setPropagationTimeoutMs(settings.timeoutMs);
  storageManager.setPropagationAttempts(settings.attempts);
  storageManager.setPropagationConsensusPercent(settings.consensusPercent);
  storageManager.setPropagationWatchIntervalS(settings.watchIntervalS);
}

function persistToDesktop(fields: Record<string, unknown>): void {
  if (!isDesktop()) return;
  void TauriClient.updatePreferenceFields(fields).catch(
    reportPreferenceFailure,
  );
}

export interface UsePropagationSettingsResult {
  settings: PropagationSettings;
  /** Merge a partial update, clamp it, persist it (browser + desktop). */
  update: (partial: Partial<PropagationSettings>) => PropagationSettings;
  /** Restore every propagation preference to its default. */
  reset: () => PropagationSettings;
}

/**
 * Persisted propagation-checker settings. Reads from `storageManager`, stays
 * in sync with `preferences-changed` events (so desktop hydration in
 * DNSManager and other tabs are reflected), and writes through to the
 * desktop preference store when running under Tauri. Desktop write failures
 * are reported, never thrown into render.
 */
export function usePropagationSettings(): UsePropagationSettingsResult {
  const [settings, setSettings] = useState<PropagationSettings>(() =>
    storageManager.getPropagationSettings(),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPrefs = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        Record<string, unknown> | undefined;
      if (!detail) return;
      if (!PROPAGATION_PREF_KEYS.some((key) => key in detail)) return;
      setSettings(storageManager.getPropagationSettings());
    };
    window.addEventListener("preferences-changed", onPrefs);
    return () => window.removeEventListener("preferences-changed", onPrefs);
  }, []);

  const update = useCallback((partial: Partial<PropagationSettings>) => {
    const next = clampPropagationSettings({
      ...storageManager.getPropagationSettings(),
      ...partial,
    });
    writeToStorage(next);
    setSettings(next);
    persistToDesktop(toDesktopPropagationFields(next));
    return next;
  }, []);

  const reset = useCallback(() => {
    storageManager.resetPropagationSettings();
    const next = storageManager.getPropagationSettings();
    setSettings(next);
    persistToDesktop(toDesktopPropagationFields(next));
    return next;
  }, []);

  return { settings, update, reset };
}
