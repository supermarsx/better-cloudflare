import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
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
        persistent,
        ...props
      }) {
        const isPersistent =
          persistent === true ||
          (Boolean(diagnostic) && props.variant === "destructive");
        return (
          <Toast
            key={id}
            {...props}
            duration={isPersistent ? Number.POSITIVE_INFINITY : props.duration}
            data-persistent-diagnostic={isPersistent ? "true" : undefined}
          >
            <div className="grid min-w-0 max-w-full flex-1 gap-1 overflow-hidden">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
              {diagnostic || action ? (
                <div className="mt-2 flex min-w-0 max-w-full flex-wrap items-center gap-2">
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
