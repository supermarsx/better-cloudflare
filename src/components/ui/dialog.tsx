/**
 * Styled dialog primitives built on top of Radix Dialog. Use these
 * components to assemble accessible modals (Dialog, Content, Overlay, etc.)
 * across the app.
 */
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { isDesktop } from "@/lib/environment";

import { cn } from "@/lib/utils";

type TitlebarPointerOverride = {
  count: number;
  priority: string;
  value: string;
};

const titlebarPointerOverrides = new Map<
  HTMLElement,
  TitlebarPointerOverride
>();

function allowDesktopTitlebarPointerInteraction() {
  const titlebars = document.querySelectorAll<HTMLElement>(".titlebar.fixed");

  titlebars.forEach((titlebar) => {
    const existing = titlebarPointerOverrides.get(titlebar);
    if (existing) {
      existing.count += 1;
      return;
    }

    titlebarPointerOverrides.set(titlebar, {
      count: 1,
      priority: titlebar.style.getPropertyPriority("pointer-events"),
      value: titlebar.style.getPropertyValue("pointer-events"),
    });
    titlebar.style.setProperty("pointer-events", "auto", "important");
  });

  return () => {
    titlebars.forEach((titlebar) => {
      const existing = titlebarPointerOverrides.get(titlebar);
      if (!existing) return;

      existing.count -= 1;
      if (existing.count > 0) return;

      if (existing.value) {
        titlebar.style.setProperty(
          "pointer-events",
          existing.value,
          existing.priority,
        );
      } else {
        titlebar.style.removeProperty("pointer-events");
      }
      titlebarPointerOverrides.delete(titlebar);
    });
  };
}

/**
 * Dialog primitives exposing a styled Radix dialog. The exported set of
 * components should be used together to provide consistent styling and
 * accessible markup for modal dialogs in the app.
 */
const Dialog = ({
  modal = true,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) => (
  <DialogPrimitive.Root modal={modal} {...props} />
);

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-testid="dialog-backdrop"
    className={cn(
      "absolute inset-0 bg-background/70 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(
  (
    {
      className,
      children,
      onFocusOutside,
      onInteractOutside,
      onPointerDownOutside,
      ...props
    },
    ref,
  ) => {
    const desktop = isDesktop();
    React.useEffect(() => {
      if (!desktop) return;
      return allowDesktopTitlebarPointerInteraction();
    }, [desktop]);

    const isTitlebarPointer = (originalEvent: Event) => {
      const target = originalEvent.target;
      return (
        desktop &&
        target instanceof Element &&
        target.closest(".titlebar.fixed") !== null
      );
    };

    return (
      <DialogPortal>
        {/**
         * The desktop shell keeps the native titlebar above this layer. Radix remains
         * modal so focus stays trapped in the dialog; only pointer interaction with
         * that titlebar is narrowly restored while the content is mounted.
         */}
        <div className="fixed bottom-0 left-0 right-0 top-[var(--app-top-inset)] z-50">
          <DialogOverlay />
          <div
            data-dialog-scroll-region
            className="scrollbar-themed absolute inset-0 overflow-y-auto overscroll-contain"
          >
            <div className="flex min-h-full items-center justify-center p-4 pt-4">
              <DialogPrimitive.Content
                {...props}
                ref={ref}
                className={cn(
                  "glass-surface glass-sheen glass-fade relative z-10 grid w-full max-w-lg gap-4 bg-popover/70 p-6 text-foreground duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-xl",
                  className,
                )}
                onFocusOutside={(event) => {
                  onFocusOutside?.(event);
                  if (!event.defaultPrevented && desktop) {
                    event.preventDefault();
                  }
                }}
                onPointerDownOutside={(event) => {
                  onPointerDownOutside?.(event);
                  if (
                    !event.defaultPrevented &&
                    isTitlebarPointer(event.detail.originalEvent)
                  ) {
                    event.preventDefault();
                  }
                }}
                onInteractOutside={(event) => {
                  onInteractOutside?.(event);
                  if (
                    !event.defaultPrevented &&
                    isTitlebarPointer(event.detail.originalEvent)
                  ) {
                    event.preventDefault();
                  }
                }}
              >
                {children}
                <DialogPrimitive.Close
                  type="button"
                  className="ui-focus absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
              </DialogPrimitive.Content>
            </div>
          </div>
        </div>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className,
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
