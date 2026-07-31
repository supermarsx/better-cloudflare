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
import { ToastDiagnosticDialog } from "@/components/ui/ToastDiagnosticDialog";

/**
 * Toaster component that renders the current list of toasts from the
 * `useToast` hook. This component should be mounted once at the root of
 * the application to ensure toast notifications appear.
 */
export function Toaster() {
  const { toasts } = useToast();

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
          <Toast
            key={`${id}-${occurrenceCount}`}
            {...toastProps}
            duration={duration}
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
                    <ToastDiagnosticDialog diagnostic={diagnostic} />
                  ) : null}
                  {action}
                </div>
              ) : null}
            </div>
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
