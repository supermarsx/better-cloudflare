/**
 * The renderer's half of app-wide cloud sync: one read, one write, and the
 * four actions that touch the network.
 *
 * Shaped after `useNotificationSettings` — `settings`, a write, a `reload`, a
 * `saveState` and an `error` — with two deliberate differences, both forced by
 * what is being edited:
 *
 * 1. **Writes are not optimistic.** The notification panel persists each row as
 *    it is toggled and rolls back on failure. Here a write stores a credential
 *    and a passphrase in the OS keyring, and {@link SyncSettingsInput} is a
 *    whole object with three-state secret fields, so there is no such thing as
 *    writing one row. The panel collects a draft and calls {@link
 *    UseSyncSettingsResult.configure} once.
 * 2. **A failed read is not a settings state.** `status` stays `null` when the
 *    read failed, and `error` says why. Falling back to a default object would
 *    put "no provider chosen" on screen when the truth is that the screen could
 *    not ask — and this feature's backend is `isDesktop()`-gated and newly
 *    added, so "the command is not registered in this build" is a real case
 *    rather than a hypothetical one. An `invoke` of an unregistered command
 *    rejects; that rejection has to reach the user as a problem.
 *
 * The commands are named by {@link SYNC_COMMANDS} rather than spelled here, so
 * a typo cannot survive a build. The invoke itself composes the same three
 * pieces `@/lib/diagnostics/host-invoke` does — the UI deadline, the
 * per-command budget and the error normalisation `tauri-client.ts` exports —
 * so a sync command behaves like every other command in the app without a
 * second invoke implementation to keep in step.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import {
  createPreferenceFailureReporter,
  getTauriInvokeTimeoutMs,
  normalizeTauriInvokeError,
  withTauriUiTimeout,
} from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import {
  SYNC_COMMANDS,
  type ConflictResolution,
  type SyncCommandArgs,
  type SyncOutcome,
  type SyncPreviewOutcome,
  type SyncSettingsInput,
  type SyncStatus,
} from "@/lib/sync/types";

export type SyncSaveState = "idle" | "loading" | "saving" | "saved" | "error";

export interface UseSyncSettingsResult {
  /** `false` on the web build: every sync command is `isDesktop()`-gated. */
  available: boolean;
  /** `null` until the first read lands, and after a read that failed. */
  status: SyncStatus | null;
  saveState: SyncSaveState;
  /**
   * The last read or write failure in words, cleared by the next success.
   *
   * Read together with `status`: an error with `status === null` means the
   * screen cannot see the current state at all.
   */
  error: string | null;
  /** Re-read `get_sync_status`. No network. */
  reload: () => Promise<void>;
  /**
   * Store settings and the secrets the input carries, then re-read the status.
   *
   * The command's own return value is deliberately ignored: the contract does
   * not say what `configure_sync` answers with, and a renderer that depended
   * on one shape would break the day the backend chose another. Re-reading is
   * one extra local call and makes the screen show what was actually stored —
   * which is also how a cadence the backend adjusted becomes visible.
   */
  configure: (input: SyncSettingsInput) => Promise<void>;
  /** Reach the endpoint and report whether the stored credential works. */
  testConnection: () => Promise<SyncOutcome>;
  /**
   * Open the native folder picker and answer with the chosen absolute path,
   * or `null` if the user cancelled.
   *
   * Not routed through `runAction`, and not reported as an error either. It
   * stores nothing, so there is no status to re-read, and it answers with a
   * path rather than a {@link SyncOutcome} — while a rejection here is a
   * broken host rather than a failed save, so it is rethrown for the caller
   * to put beside the control the user pressed instead of being written into
   * `saveState`, where it would read as "could not save" over a draft that
   * was never sent.
   */
  pickFolder: () => Promise<string | null>;
  push: () => Promise<SyncOutcome>;
  /**
   * Open the remote envelope and report what a pull would install. Writes
   * nothing — not the key list, not `lastSyncedAt`, not the remembered
   * manifest — which is what makes it safe to run from a preview step.
   */
  previewPull: () => Promise<SyncPreviewOutcome>;
  pull: () => Promise<SyncOutcome>;
  resolveConflict: (resolution: ConflictResolution) => Promise<SyncOutcome>;
}

const reportSyncFailure = createPreferenceFailureReporter((error) => {
  reportRuntimeError(error, {
    source: "runtime",
    label: "Cloud sync command",
  });
});

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

/**
 * One sync command, under the application's standard UI deadline.
 *
 * `Command` is keyed on {@link SyncCommandArgs}, so the argument object is
 * checked against the name: Tauri arguments are named, and a renderer sending
 * `{ config }` to a handler expecting `settings` typechecks on both sides and
 * fails only when a user reaches it. Spelling the pairing out here is what
 * makes the contract's map load-bearing rather than documentation.
 */
async function syncInvoke<Command extends keyof SyncCommandArgs, T>(
  command: Command,
  args: SyncCommandArgs[Command],
): Promise<T> {
  try {
    return await withTauriUiTimeout(
      tauriInvoke<T>(command, args),
      command,
      getTauriInvokeTimeoutMs(command),
    );
  } catch (error) {
    throw normalizeTauriInvokeError(error, command);
  }
}

/** The no-argument commands' payload, named once rather than inline. */
const NO_ARGS: Record<string, never> = {};

export function useSyncSettings(): UseSyncSettingsResult {
  const available = isDesktop();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [saveState, setSaveState] = useState<SyncSaveState>(
    available ? "loading" : "idle",
  );
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    if (!available) return;
    setSaveState((state) => (state === "saving" ? state : "loading"));
    try {
      const next = await syncInvoke<typeof SYNC_COMMANDS.status, SyncStatus>(
        SYNC_COMMANDS.status,
        NO_ARGS,
      );
      if (!mountedRef.current) return;
      setStatus(next);
      setError(null);
      setSaveState((state) => (state === "loading" ? "idle" : state));
    } catch (readError) {
      reportSyncFailure(readError);
      if (!mountedRef.current) return;
      // `status` is left as it was rather than cleared: a read that failed
      // after a good one has not made the previous answer untrue, and the
      // error line says the screen is now out of date. Only the first read
      // leaves it null, which is what "cannot see the state at all" means.
      setError(describeError(readError));
      setSaveState("error");
    }
  }, [available]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const configure = useCallback(
    async (input: SyncSettingsInput) => {
      if (!available) return;
      setSaveState("saving");
      try {
        await syncInvoke(SYNC_COMMANDS.configure, { settings: input });
        if (mountedRef.current) setError(null);
      } catch (writeError) {
        reportSyncFailure(writeError);
        if (mountedRef.current) {
          setError(describeError(writeError));
          setSaveState("error");
        }
        throw writeError;
      }
      // Outside the catch: a failed re-read after a write that landed is a
      // stale screen, not a failed save, and `reload` already reports it.
      await reload();
      if (mountedRef.current) setSaveState("saved");
    },
    [available, reload],
  );

  /**
   * Run one network action and keep the status in step with what it did.
   *
   * The outcome is returned rather than stored: a `conflict` is a question for
   * the panel to put to the user, and a `failed` carries a code the panel
   * words. What the hook owns is the side effect — an action that moved the
   * remote has also moved `lastSyncedAt` and `lastKnown`, so the status is
   * re-read, and a rejection (an unregistered command, a dead host) is
   * reported as an error and rethrown.
   */
  const runAction = useCallback(
    async <Command extends keyof SyncCommandArgs>(
      command: Command,
      args: SyncCommandArgs[Command],
    ) => {
      const outcome = await (async () => {
        try {
          const result = await syncInvoke<Command, SyncOutcome>(command, args);
          if (mountedRef.current) setError(null);
          return result;
        } catch (actionError) {
          reportSyncFailure(actionError);
          if (mountedRef.current) {
            setError(describeError(actionError));
            setSaveState("error");
          }
          throw actionError;
        }
      })();
      if (outcome.state === "ok" || outcome.state === "unchanged") {
        await reload();
      }
      return outcome;
    },
    [reload],
  );

  const testConnection = useCallback(
    () => runAction(SYNC_COMMANDS.test, NO_ARGS),
    [runAction],
  );
  /**
   * The folder picker. A cancellation is `null` and is not a failure: the
   * user opened a dialog and closed it, which is not something to report and
   * must not be mistaken for "they chose nothing", because the path they
   * already had is still the path they want.
   */
  const pickFolder = useCallback(async () => {
    try {
      return await syncInvoke<typeof SYNC_COMMANDS.pickFolder, string | null>(
        SYNC_COMMANDS.pickFolder,
        NO_ARGS,
      );
    } catch (pickError) {
      reportSyncFailure(pickError);
      throw pickError;
    }
  }, []);
  const push = useCallback(
    () => runAction(SYNC_COMMANDS.push, NO_ARGS),
    [runAction],
  );
  const pull = useCallback(
    () => runAction(SYNC_COMMANDS.pull, NO_ARGS),
    [runAction],
  );
  const resolveConflict = useCallback(
    (resolution: ConflictResolution) =>
      runAction(SYNC_COMMANDS.resolve, { resolution }),
    [runAction],
  );

  /**
   * Open the remote envelope and report what a pull would do.
   *
   * Deliberately *not* routed through `runAction`: this command writes
   * nothing, so there is no `lastSyncedAt` or remembered manifest to re-read
   * afterwards, and re-reading the status would make the preview look like it
   * had an effect. Its own outcome type also differs — `ok` carries a preview,
   * not a manifest.
   */
  const previewPull = useCallback(async () => {
    try {
      const result = await syncInvoke<
        typeof SYNC_COMMANDS.previewPull,
        SyncPreviewOutcome
      >(SYNC_COMMANDS.previewPull, NO_ARGS);
      if (mountedRef.current) setError(null);
      return result;
    } catch (previewError) {
      reportSyncFailure(previewError);
      if (mountedRef.current) {
        setError(describeError(previewError));
        setSaveState("error");
      }
      throw previewError;
    }
  }, []);

  return {
    available,
    status,
    saveState,
    error,
    reload,
    configure,
    testConnection,
    pickFolder,
    push,
    previewPull,
    pull,
    resolveConflict,
  };
}
