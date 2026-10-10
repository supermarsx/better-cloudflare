/**
 * Debounced autosave for a panel whose persistence step writes everything at
 * once.
 *
 * `DNSManager` persists its settings from a single effect that writes every
 * preference from current state — around sixty `storageManager` keys and, on
 * desktop, one 45-field IPC round trip. That makes the write wasteful (one
 * keystroke in a free-text setting costs the whole lot) but it also makes it
 * trivially coalescable: because every run writes *everything* from the state
 * it closes over, keeping only the newest pending run loses nothing. That is
 * the one property this hook depends on, and the reason it holds a single
 * closure rather than a queue.
 *
 * ## Today's behaviour is wasteful but lossless; a naive debounce is lossy
 *
 * A write parked in a timer exists nowhere else — not in `localStorage`, not
 * on the host. Three things can end that window before the timer fires, so
 * three things flush it:
 *
 *  - **Unmount.** The cleanup below runs the pending write synchronously.
 *  - **The page being torn down.** `beforeunload` *and* `pagehide`: a webview
 *    being destroyed rather than navigated is not guaranteed to fire the
 *    former, and neither is guaranteed in a desktop shell.
 *  - **The host closing the window.** Not visible from here — Tauri's
 *    `onCloseRequested` is the hook for it, it lives in the caller's realm,
 *    and [`DebouncedAutosave.flush`] is what that listener calls.
 *
 * ## The ready gate
 *
 * `ready` is the caller's "stored preferences have been loaded" flag. Its
 * whole purpose is to stop a first render writing component defaults over what
 * is on disk, and a timer is the one way a write could cross that boundary:
 * scheduled before the load settled and fired after it, or scheduled by a
 * caller that forgot the gate. So `ready` is checked when a write is scheduled
 * **and again when it runs**, from the ref rather than the closed-over value,
 * so a flush cannot resurrect a write the gate has since closed on.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Where the panel's indicator stands.
 *
 * The same five values `SyncSettings` shows, so that two save indicators in
 * one app cannot describe the same situation with different words:
 * `loading` while stored state is still being read, `idle` with nothing
 * outstanding, `saving` while a write is in flight, `saved` once one landed
 * (sticky until the next change, which is what makes it an answer rather than
 * a flash), and `error` when one was refused.
 */
export type AutosaveState = "loading" | "idle" | "saving" | "saved" | "error";

/**
 * A pending persistence step.
 *
 * Synchronous work is allowed and a thrown error is caught — `localStorage`
 * can refuse a write when a quota is reached, and that has to reach the
 * indicator rather than escaping an effect. A returned promise is awaited, so
 * a rejected host write reports as `error` instead of resolving into silence.
 */
export type AutosaveWrite = () => void | Promise<unknown>;

/**
 * The debounce applied to a settings change before it is persisted.
 *
 * ## Why one interval and not two
 *
 * A toggle should feel instant and a text field should not write per
 * keystroke, which argues for writing toggles immediately and debouncing only
 * free text. It is not expressible here: the persistence step is all-or-nothing
 * — one effect writing every setting from current state — so at the point a
 * write is scheduled a toggle's change and a keystroke are the same event, and
 * telling them apart would mean splitting that effect per concern. That is a
 * restructure of a 17,000-line component, not part of adding a debounce.
 *
 * ## Why 400 ms
 *
 * It is the interval this app already applies to typed settings inputs
 * (`SETTINGS_INPUT_DEBOUNCE_MS` in `NotificationsSettingsControls`), so a
 * number field behaves the same whichever settings panel it is in. The two
 * constants are deliberately equal and `settingsAutosave.test.tsx` asserts it,
 * because the duplication is what keeps this module out of a component module
 * that drags in half the UI kit for one number.
 *
 * A toggle therefore persists 400 ms after it is flipped. That is not felt as
 * nothing happening, because the indicator moves the moment the change is
 * scheduled: the user watches "Not saved yet" become "Saving…" become "Saved".
 * Latency the user can see progress through is cheaper than sixty redundant
 * writes they cannot.
 */
export const SETTINGS_AUTOSAVE_DEBOUNCE_MS = 400;

export interface UseDebouncedAutosaveOptions {
  /**
   * Whether stored state has been loaded. No write is scheduled or run while
   * this is false — see "The ready gate" above.
   */
  ready: boolean;
  /** Milliseconds after the last change before the write runs. */
  delayMs?: number;
}

export interface DebouncedAutosave {
  state: AutosaveState;
  /** The reason the last write was refused, for the indicator to quote. */
  error: string | null;
  /** A change is scheduled and has not been written yet. */
  dirty: boolean;
  /**
   * Replace the pending write and restart the timer.
   *
   * Replace, not append: the newest closure carries the newest state and each
   * one writes everything, so the earlier closures are not just redundant but
   * strictly staler.
   */
  schedule: (write: AutosaveWrite) => void;
  /** Run the pending write now, synchronously. Safe with nothing pending. */
  flush: () => void;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof (value as { then?: unknown } | null | undefined)?.then === "function"
  );
}

/**
 * One sentence naming why a write was refused.
 *
 * `Error.message` rather than the whole error: this ends up inside "Could not
 * save: {{error}}" beside the settings, where a stack is noise, and the
 * diagnostic trail already holds the full object.
 */
function failureReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = typeof error === "string" ? error : String(error ?? "");
  return text || "unknown error";
}

export function useDebouncedAutosave({
  ready,
  delayMs = SETTINGS_AUTOSAVE_DEBOUNCE_MS,
}: UseDebouncedAutosaveOptions): DebouncedAutosave {
  const [state, setState] = useState<AutosaveState>(ready ? "idle" : "loading");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const pendingRef = useRef<AutosaveWrite | null>(null);
  const timerRef = useRef<number | null>(null);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  /**
   * Which change the reported state belongs to.
   *
   * Bumped both when a change is scheduled and when a write starts, because
   * an in-flight write must stop being allowed to report the moment anything
   * newer than it exists. Otherwise a host write that was already on its way
   * lands "Saved" over a change the user has since made and nothing has
   * written yet — the one misreport that matters here, because the whole point
   * of the indicator is that it can be believed.
   */
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  // Declared before the flush effect so that its cleanup runs first: by the
  // time a flush-on-unmount runs the write, this is already false and the
  // write's own state reporting is skipped rather than aimed at a gone tree.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // `loading` holds until the caller says the stored state arrived, and only
  // `loading` is replaced: a `saved` or `error` that a later load does not
  // invalidate is still the truthful answer about the last write.
  useEffect(() => {
    setState((current) => {
      if (!ready) return "loading";
      return current === "loading" ? "idle" : current;
    });
  }, [ready]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const run = useCallback(() => {
    clearTimer();
    const write = pendingRef.current;
    pendingRef.current = null;
    if (!write || !readyRef.current) return;

    const generation = (generationRef.current += 1);
    const settle = (next: AutosaveState, reason: string | null) => {
      if (!mountedRef.current) return;
      if (generationRef.current !== generation) return;
      setError(reason);
      setState(next);
    };

    if (mountedRef.current) {
      setDirty(false);
      setError(null);
      setState("saving");
    }

    let result: void | Promise<unknown>;
    try {
      result = write();
    } catch (failure) {
      settle("error", failureReason(failure));
      return;
    }
    if (!isPromiseLike(result)) {
      settle("saved", null);
      return;
    }
    void result.then(
      () => settle("saved", null),
      (failure: unknown) => settle("error", failureReason(failure)),
    );
  }, [clearTimer]);

  const schedule = useCallback(
    (write: AutosaveWrite) => {
      if (!readyRef.current) return;
      pendingRef.current = write;
      generationRef.current += 1;
      setDirty(true);
      clearTimer();
      timerRef.current = window.setTimeout(run, delayMs);
    },
    [clearTimer, delayMs, run],
  );

  const flush = useCallback(() => {
    run();
  }, [run]);

  // Held in a ref so the teardown below can depend on nothing: an effect whose
  // cleanup is the flush itself would fire a write on every identity change of
  // whatever it depended on.
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(
    () => () => {
      flushRef.current();
    },
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onTeardown = () => flushRef.current();
    window.addEventListener("beforeunload", onTeardown);
    window.addEventListener("pagehide", onTeardown);
    return () => {
      window.removeEventListener("beforeunload", onTeardown);
      window.removeEventListener("pagehide", onTeardown);
    };
  }, []);

  return { state, error, dirty, schedule, flush };
}
