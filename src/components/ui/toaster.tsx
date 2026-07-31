import * as React from "react";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import {
  resolveToastDuration,
  TOAST_DURATION_MAX_MS,
  useToast,
} from "@/hooks/use-toast";
import {
  ToastDiagnosticDialog,
  ToastDiagnosticTrigger,
} from "@/components/ui/ToastDiagnosticDialog";
import type { RuntimeDiagnostic } from "@/lib/errors/runtime-reporting";

interface TimedToastProps extends React.ComponentPropsWithoutRef<typeof Toast> {
  timeoutMs: number;
  timeoutRevision: number;
}

/**
 * Radix owns pointer/focus pause signals while this wrapper owns expiry. Keeping
 * the timer outside Radix's mount lifecycle lets duplicate reports restart the
 * bounded duration without replacing the focused toast DOM node.
 */
function TimedToast({
  timeoutMs,
  timeoutRevision,
  onBlurCapture,
  onFocusCapture,
  onOpenChange,
  onPause,
  onPointerLeave,
  onPointerMove,
  onResume,
  open,
  ...props
}: TimedToastProps) {
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const startedAtRef = React.useRef(0);
  const remainingMsRef = React.useRef(timeoutMs);
  const pausedRef = React.useRef(false);
  const openRef = React.useRef(open !== false);
  const onOpenChangeRef = React.useRef(onOpenChange);

  openRef.current = open !== false;
  onOpenChangeRef.current = onOpenChange;

  const clearTimer = React.useCallback(() => {
    if (timerRef.current === undefined) return;
    globalThis.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const startTimer = React.useCallback(() => {
    clearTimer();
    if (!openRef.current || pausedRef.current || remainingMsRef.current <= 0) {
      return;
    }

    startedAtRef.current = Date.now();
    timerRef.current = globalThis.setTimeout(() => {
      timerRef.current = undefined;
      remainingMsRef.current = 0;
      onOpenChangeRef.current?.(false);
    }, remainingMsRef.current);
  }, [clearTimer]);

  React.useEffect(() => {
    clearTimer();
    remainingMsRef.current = timeoutMs;
    if (open !== false && !pausedRef.current) startTimer();
    return clearTimer;
  }, [clearTimer, open, startTimer, timeoutMs, timeoutRevision]);

  const handlePause = React.useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    if (timerRef.current !== undefined) {
      remainingMsRef.current = Math.max(
        0,
        remainingMsRef.current - (Date.now() - startedAtRef.current),
      );
      clearTimer();
    }
    onPause?.();
  }, [clearTimer, onPause]);

  const handleResume = React.useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    startTimer();
    onResume?.();
  }, [onResume, startTimer]);

  return (
    <Toast
      {...props}
      open={open}
      onOpenChange={onOpenChange}
      duration={Number.POSITIVE_INFINITY}
      onPause={handlePause}
      onResume={handleResume}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        handlePause();
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        if (!event.currentTarget.contains(document.activeElement)) {
          handleResume();
        }
      }}
      onFocusCapture={(event) => {
        onFocusCapture?.(event);
        handlePause();
      }}
      onBlurCapture={(event) => {
        onBlurCapture?.(event);
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          handleResume();
        }
      }}
    />
  );
}

interface SelectedDiagnostic {
  diagnostic: RuntimeDiagnostic;
  toastId: string;
  trigger: HTMLButtonElement;
}

/**
 * Toaster component that renders the current list of toasts from the
 * `useToast` hook. This component should be mounted once at the root of
 * the application to ensure toast notifications appear.
 */
export function Toaster() {
  const { toasts } = useToast();
  const viewportRef = React.useRef<HTMLOListElement>(null);
  const [selectedDiagnostic, setSelectedDiagnostic] =
    React.useState<SelectedDiagnostic | null>(null);
  const currentDiagnostic = selectedDiagnostic
    ? (toasts.find((toast) => toast.id === selectedDiagnostic.toastId)
        ?.diagnostic ?? selectedDiagnostic.diagnostic)
    : null;

  const handleDiagnosticOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) return;
      const returnTarget = selectedDiagnostic?.trigger;
      setSelectedDiagnostic(null);
      queueMicrotask(() => {
        const focusTarget = returnTarget?.isConnected
          ? returnTarget
          : viewportRef.current;
        focusTarget?.focus({ preventScroll: true });
      });
    },
    [selectedDiagnostic],
  );

  return (
    <ToastProvider>
      {toasts.map(function ({
        id,
        title,
        description,
        action,
        diagnostic,
        occurrenceCount = 1,
        persistent,
        ...props
      }) {
        const duration = resolveToastDuration({
          diagnostic,
          duration: props.duration,
          persistent,
          variant: props.variant,
        });
        const toastProps = { ...props };
        delete toastProps.dedupeFingerprint;
        delete toastProps.dedupeKey;
        delete toastProps.lastOccurrenceAt;
        return (
          <TimedToast
            key={id}
            {...toastProps}
            timeoutMs={duration}
            timeoutRevision={occurrenceCount}
            data-persistent-diagnostic={persistent ? "true" : undefined}
            data-toast-duration={duration}
            data-toast-duration-bounded={
              duration <= TOAST_DURATION_MAX_MS ? "true" : undefined
            }
          >
            <div className="grid min-w-0 max-w-full flex-1 gap-0.5 overflow-hidden">
              {title ? (
                <div className="flex min-w-0 items-start gap-2">
                  <ToastTitle className="flex-1">{title}</ToastTitle>
                  {occurrenceCount > 1 ? (
                    <span
                      aria-label={`Occurred ${occurrenceCount} times`}
                      className="shrink-0 rounded-full border border-current/20 bg-background/30 px-1.5 py-0.5 text-[10px] font-semibold leading-none"
                    >
                      ×{occurrenceCount}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
              {diagnostic || action ? (
                <div className="mt-1.5 flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
                  {diagnostic ? (
                    <ToastDiagnosticTrigger
                      expanded={selectedDiagnostic?.toastId === id}
                      onClick={(event) =>
                        setSelectedDiagnostic({
                          diagnostic,
                          toastId: id,
                          trigger: event.currentTarget,
                        })
                      }
                    />
                  ) : null}
                  {action}
                </div>
              ) : null}
            </div>
            <ToastClose />
          </TimedToast>
        );
      })}
      <ToastViewport ref={viewportRef} />
      {currentDiagnostic ? (
        <ToastDiagnosticDialog
          diagnostic={currentDiagnostic}
          open
          onOpenChange={handleDiagnosticOpenChange}
        />
      ) : null}
    </ToastProvider>
  );
}
