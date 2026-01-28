/**
 * Small textarea component used across the application to provide a
 * consistent look-and-feel for native textarea elements.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "ui-focus flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-all placeholder:text-muted-foreground hover:-translate-y-0.5 hover:border-primary/30 hover:bg-accent/25 hover:shadow-[0_14px_28px_hsl(0_0%_0%_/_0.14),0_0_14px_hsl(var(--primary)_/_0.08)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none",
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };

