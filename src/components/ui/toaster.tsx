import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { RuntimeDiagnosticDetails } from "@/components/layout/RuntimeDiagnosticDetails";

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
        const isPersistentDiagnostic =
          Boolean(diagnostic) &&
          (persistent === true || props.variant === "destructive");
        return (
          <Toast
            key={id}
            {...props}
            duration={
              isPersistentDiagnostic ? Number.POSITIVE_INFINITY : props.duration
            }
            data-persistent-diagnostic={
              isPersistentDiagnostic ? "true" : undefined
            }
          >
            <div className="min-w-0 flex-1 grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
              {diagnostic ? (
                <RuntimeDiagnosticDetails diagnostic={diagnostic} compact />
              ) : null}
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
