/**
 * Toast notification primitives built on top of Radix Toast and exposed by
 * the `useToast` hook. Use `ToastProvider` and `ToastViewport` in the app
 * root together with the provided `Toast` components.
 */
import * as React from "react";
import * as ToastPrimitives from "@radix-ui/react-toast";
import { useDirection } from "@radix-ui/react-direction";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Styled toast primitives used for in-app notifications. This file provides
 * typed exports for provider, viewport and toast elements used by the
 * global `useToast` hook.
 */
/**
 * Radix's toast provider, with the swipe-to-dismiss direction following the
 * document.
 *
 * Radix defaults `swipeDirection` to `"right"`, which is the direction of the
 * screen edge the viewport is pinned to -- but only in an LTR layout. Under
 * `dir="rtl"` the viewport sits at the left edge (see `ToastViewport`), so
 * dismissing has to be a leftward swipe; `"right"` would ask the user to swipe
 * *into* the screen. The direction comes from Radix's own context rather than
 * from i18next, so this primitive stays independent of the translation layer:
 * `DocumentDirection` in the root layout is what fills that context. A caller
 * passing `swipeDirection` explicitly still wins.
 */
const ToastProvider = ({
  swipeDirection,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitives.Provider>) => {
  const direction = useDirection();
  return (
    <ToastPrimitives.Provider
      swipeDirection={
        swipeDirection ?? (direction === "rtl" ? "left" : "right")
      }
      {...props}
    />
  );
};
ToastProvider.displayName = "ToastProvider";

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Viewport
    ref={ref}
    data-toast-viewport=""
    className={cn(
      // `start-auto`/`end-3` rather than `left-auto`/`right-3`: the viewport
      // belongs at the trailing edge, which is the left one under `dir="rtl"`.
      // The enter/exit keyframes in `src/index.css` travel along
      // `--ui-toast-enter-x`, which flips with the same attribute -- the two
      // have to move together or toasts fly in from the opposite edge.
      "fixed inset-x-0 top-0 z-[100] flex max-h-[calc(100vh-1.5rem)] w-full max-w-full flex-col-reverse gap-2 overflow-x-hidden p-3 sm:bottom-3 sm:start-auto sm:end-3 sm:top-auto sm:w-[min(380px,calc(100vw-1.5rem))] sm:flex-col sm:p-0",
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = ToastPrimitives.Viewport.displayName;

const toastVariants = cva(
  // `pe-9` is the room reserved for the close button, which `ToastClose`
  // positions at `end-2`. Both are logical, and they must stay a pair: convert
  // one without the other and the button lands on the text in RTL.
  "glass-surface glass-sheen glass-opaque ui-toast-motion group pointer-events-auto relative flex min-w-0 w-full max-w-full items-start justify-between gap-2 overflow-hidden rounded-lg border p-3.5 pe-9 shadow-[0_14px_36px_hsl(0_0%_0%_/_0.26)] transition-[translate] data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none",
  {
    variants: {
      variant: {
        default: "border-border/60 text-foreground",
        destructive: "glass-opaque-destructive text-destructive-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
    VariantProps<typeof toastVariants>
>(({ className, variant, ...props }, ref) => {
  return (
    <ToastPrimitives.Root
      ref={ref}
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  );
});
Toast.displayName = ToastPrimitives.Root.displayName;

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Action
    ref={ref}
    className={cn(
      "ui-focus inline-flex h-8 shrink-0 items-center justify-center rounded-md border bg-transparent px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-muted/40 group-[.destructive]:hover:border-destructive/30 group-[.destructive]:hover:bg-destructive group-[.destructive]:hover:text-destructive-foreground",
      className,
    )}
    {...props}
  />
));
ToastAction.displayName = ToastPrimitives.Action.displayName;

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    className={cn(
      // `end-2`, paired with the `pe-9` that reserves its room in
      // `toastVariants`.
      "ui-focus absolute end-2 top-2 rounded-md p-1 text-foreground/50 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus-visible:outline-none group-hover:opacity-100 group-[.destructive]:text-red-300 group-[.destructive]:hover:text-red-50",
      className,
    )}
    toast-close=""
    // The only content is an icon, so without this the dismiss control is an
    // unnamed button. Callers may still override it for a specific toast.
    aria-label="Dismiss notification"
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitives.Close>
));
ToastClose.displayName = ToastPrimitives.Close.displayName;

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Title
    ref={ref}
    data-toast-title=""
    className={cn(
      "min-w-0 max-w-full whitespace-pre-wrap break-words text-sm font-semibold leading-5 [overflow-wrap:anywhere]",
      className,
    )}
    {...props}
  />
));
ToastTitle.displayName = ToastPrimitives.Title.displayName;

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description
    ref={ref}
    data-toast-description=""
    className={cn(
      "min-w-0 max-w-full whitespace-pre-wrap break-words text-xs leading-4 opacity-90 [overflow-wrap:anywhere]",
      className,
    )}
    {...props}
  />
));
ToastDescription.displayName = ToastPrimitives.Description.displayName;

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>;

type ToastActionElement = React.ReactElement<typeof ToastAction>;

export {
  type ToastProps,
  type ToastActionElement,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
};
