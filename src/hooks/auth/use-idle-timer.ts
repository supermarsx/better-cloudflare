/**
 * Idle timer hook for auto-lock / auto-logout.
 *
 * Monitors user activity (mouse, keyboard, scroll, touch) and triggers
 * a callback after a configurable period of inactivity. Commonly used
 * for session security: auto-clearing credentials after idle time.
 *
 * @example
 * ```tsx
 * useIdleTimer({
 *   timeoutMs: 5 * 60 * 1000, // 5 minutes
 *   onIdle: () => { storageManager.clearSession(); onLogout(); },
 *   enabled: idleLogoutMs != null && idleLogoutMs > 0,
 * });
 * ```
 */
import { useEffect, useRef } from "react";

export interface IdleTimerOptions {
  /** Idle timeout in milliseconds. Must be > 0. */
  timeoutMs: number;
  /** Callback invoked when the idle timeout is reached. */
  onIdle: () => void;
  /** If false, the timer is disabled and never fires. */
  enabled?: boolean;
  /** DOM events that count as "activity". Defaults to a sensible set. */
  events?: ReadonlyArray<keyof WindowEventMap>;
}

const DEFAULT_EVENTS: ReadonlyArray<keyof WindowEventMap> = [
  "pointerdown",
  "pointermove",
  "keydown",
  "scroll",
  "touchstart",
  "wheel",
];

/**
 * Hook that fires `onIdle` after `timeoutMs` of no user activity.
 * Automatically cleans up listeners when unmounted or when options change.
 */
export function useIdleTimer({
  timeoutMs,
  onIdle,
  enabled = true,
  events = DEFAULT_EVENTS,
}: IdleTimerOptions): void {
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!enabled || timeoutMs <= 0) return;
    if (typeof window === "undefined") return;

    let timeout: number | undefined;

    const reset = () => {
      if (timeout != null) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        onIdleRef.current();
      }, timeoutMs);
    };

    for (const ev of events) {
      window.addEventListener(ev, reset, { passive: true });
    }

    // Start the timer immediately
    reset();

    return () => {
      if (timeout != null) window.clearTimeout(timeout);
      for (const ev of events) {
        window.removeEventListener(ev, reset);
      }
    };
  }, [timeoutMs, enabled, events]);
}
