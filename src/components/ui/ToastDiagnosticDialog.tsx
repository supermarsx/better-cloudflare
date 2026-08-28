"use client";

import * as React from "react";
import { RuntimeDiagnosticDetails } from "@/components/layout/RuntimeDiagnosticDetails";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { RuntimeDiagnostic } from "@/lib/errors/runtime-reporting";

interface ToastDiagnosticDialogProps {
  diagnostic: RuntimeDiagnostic;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ToastDiagnosticDialog({
  diagnostic,
  open,
  onOpenChange,
}: ToastDiagnosticDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        role="dialog"
        aria-modal="true"
        className="max-h-[calc(100dvh-var(--app-top-inset)-2rem)] min-w-0 max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
        data-testid="toast-diagnostic-dialog"
      >
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="break-words [overflow-wrap:anywhere]">
            Error details
          </DialogTitle>
          <DialogDescription className="break-words [overflow-wrap:anywhere]">
            Sanitized technical information for diagnostic{" "}
            <span className="font-mono">{diagnostic.id}</span>.
          </DialogDescription>
        </DialogHeader>
        <RuntimeDiagnosticDetails diagnostic={diagnostic} expanded />
        <DialogFooter>
          <button
            type="button"
            aria-label="Close error details"
            onClick={() => onOpenChange(false)}
            className="ui-focus inline-flex h-9 items-center justify-center rounded-md border border-border/60 bg-background/40 px-4 text-sm font-medium hover:bg-accent/50 focus-visible:outline-none"
          >
            Close
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ToastDiagnosticTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  expanded: boolean;
}

export const ToastDiagnosticTrigger = React.forwardRef<
  HTMLButtonElement,
  ToastDiagnosticTriggerProps
>(({ expanded, ...props }, ref) => (
  <button
    {...props}
    ref={ref}
    type="button"
    aria-haspopup="dialog"
    aria-expanded={expanded}
    className="ui-focus inline-flex min-h-8 max-w-full items-center justify-center rounded-md border border-current/25 bg-background/30 px-3 py-1.5 text-xs font-medium [overflow-wrap:anywhere] hover:bg-background/50 focus-visible:outline-none"
  >
    More info
  </button>
));
ToastDiagnosticTrigger.displayName = "ToastDiagnosticTrigger";
