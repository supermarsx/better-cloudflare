import { useCallback, useEffect, useRef, useState } from "react";
import {
  TauriClient,
  createPreferenceFailureReporter,
} from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import {
  clampNotificationSettings,
  createDefaultNotificationSettings,
  mergeNotificationSettings,
  settingsEqual,
  type NotificationSettings,
  type NotificationSettingsInput,
} from "@/lib/notifications/notification-settings";

export type NotificationSettingsSaveState =
  "idle" | "loading" | "saving" | "saved" | "error";

export interface UseNotificationSettingsResult {
  settings: NotificationSettings;
  /** Deep-merge `partial`, clamp, persist via `notifications_update_settings`; returns the optimistic result. */
  update: (partial: NotificationSettingsInput) => NotificationSettings;
  /** Restore every notification preference to its default. */
  reset: () => NotificationSettings;
  /** Re-read from the backend (after `notifications_reconfigure`, pause/resume, …). */
  reload: () => Promise<void>;
  saveState: NotificationSettingsSaveState;
  /** Human-readable last failure, cleared on the next successful write. */
  error: string | null;
  /** `false` on the web build — settings stay at defaults and writes are no-ops. */
  available: boolean;
}

const reportPreferenceFailure = createPreferenceFailureReporter((error) => {
  reportRuntimeError(error, {
    source: "runtime",
    label: "Persist desktop notification settings",
  });
});

/**
 * Process-wide mirror of the last settings the backend confirmed, so a
 * re-mounted panel renders the real values before its IPC read completes.
 *
 * Decision (t9-e2): the browser preference store (`storage-util.ts`
 * `BROWSER_PREFERENCE_SCHEMA`) only holds scalar / string-list leaves and its
 * `BrowserPreferenceData` type lives in `storage.ts` (outside this task's
 * lock), so no `"json"` kind was added. Rust `Preferences.notifications` is
 * the single persisted copy; this in-memory mirror is enough for instant
 * re-render within a session, and the web build never needs the settings.
 */
let lastKnownSettings: NotificationSettings | null = null;

/** Test hook: forget the in-memory mirror. */
export function resetNotificationSettingsCache(): void {
  lastKnownSettings = null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

/**
 * Persisted notification settings. Mirrors `usePropagationSettings` but the
 * source of truth is Rust: reads `notifications_get_settings`, writes the
 * full normalized object through `notifications_update_settings` (Rust
 * persists it under `Preferences.notifications` and reconfigures the
 * background service) and applies the returned normalized form. Writes are
 * serialized (last write wins); a failed write is reported through
 * `createPreferenceFailureReporter`, surfaces as `saveState === "error"`, and
 * rolls the state back to the last confirmed settings. Never throws in render.
 */
export function useNotificationSettings(): UseNotificationSettingsResult {
  const available = isDesktop();
  const [settings, setSettings] = useState<NotificationSettings>(
    () => lastKnownSettings ?? createDefaultNotificationSettings(),
  );
  const [saveState, setSaveState] =
    useState<NotificationSettingsSaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  /** Last settings the backend confirmed (rollback target). */
  const confirmedRef = useRef<NotificationSettings>(settings);
  /** Latest optimistic value; each `update` builds on this, not on stale render state. */
  const pendingRef = useRef<NotificationSettings>(settings);
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const writeSeq = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyConfirmed = useCallback((next: NotificationSettings) => {
    lastKnownSettings = next;
    confirmedRef.current = next;
    pendingRef.current = next;
    if (mountedRef.current) setSettings(next);
  }, []);

  const reload = useCallback(async () => {
    if (!available) return;
    setSaveState((state) => (state === "saving" ? state : "loading"));
    try {
      const loaded = await TauriClient.notificationsGetSettings();
      // Do not clobber a write that started while the read was in flight.
      if (pendingRef.current === confirmedRef.current) applyConfirmed(loaded);
      if (mountedRef.current) {
        setError(null);
        setSaveState((state) => (state === "loading" ? "idle" : state));
      }
    } catch (loadError) {
      reportPreferenceFailure(loadError);
      if (mountedRef.current) {
        setError(describeError(loadError));
        setSaveState("error");
      }
    }
  }, [available, applyConfirmed]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const persist = useCallback(
    (next: NotificationSettings) => {
      if (!available) return;
      const seq = ++writeSeq.current;
      setSaveState("saving");
      writeChain.current = writeChain.current
        .then(async () => {
          // A newer update superseded this one; let the latest write carry it.
          if (seq !== writeSeq.current) return;
          try {
            const confirmed =
              await TauriClient.notificationsUpdateSettings(next);
            if (seq !== writeSeq.current) return;
            applyConfirmed(confirmed);
            if (mountedRef.current) {
              setError(null);
              setSaveState("saved");
            }
          } catch (writeError) {
            reportPreferenceFailure(writeError);
            if (seq !== writeSeq.current) return;
            pendingRef.current = confirmedRef.current;
            if (mountedRef.current) {
              setSettings(confirmedRef.current);
              setError(describeError(writeError));
              setSaveState("error");
            }
          }
        })
        .catch(() => undefined);
    },
    [available, applyConfirmed],
  );

  const update = useCallback(
    (partial: NotificationSettingsInput) => {
      const next = clampNotificationSettings(
        mergeNotificationSettings(pendingRef.current, partial),
      );
      if (settingsEqual(next, pendingRef.current)) return next;
      pendingRef.current = next;
      setSettings(next);
      persist(next);
      return next;
    },
    [persist],
  );

  const reset = useCallback(() => {
    const next = createDefaultNotificationSettings();
    pendingRef.current = next;
    setSettings(next);
    persist(next);
    return next;
  }, [persist]);

  return { settings, update, reset, reload, saveState, error, available };
}
