/**
 * Styled button primitive used throughout the UI. Wraps native `button`
 * elements (or another component when `asChild` is true) and provides
 * consistent variants and sizes across the app.
 */
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:translate-y-[1px]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground border border-primary/60 shadow-[0_12px_26px_hsl(0_0%_0%_/_0.2)] hover:-translate-y-0.5 hover:brightness-110 hover:shadow-[0_18px_34px_hsl(0_0%_0%_/_0.24),0_0_22px_hsl(var(--primary)_/_0.18)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[0_12px_26px_hsl(0_0%_0%_/_0.2)] hover:-translate-y-0.5 hover:bg-destructive/92 hover:shadow-[0_18px_34px_hsl(0_0%_0%_/_0.24),0_0_22px_hsl(var(--destructive)_/_0.18)]",
        outline:
          "glass-surface glass-sheen glass-surface-hover border-border/60 bg-background/10 hover:bg-accent/35 hover:text-accent-foreground hover:-translate-y-0.5",
        secondary:
          "glass-surface glass-sheen glass-surface-hover border-border/60 bg-card/35 text-foreground/85 hover:bg-accent/45 hover:text-foreground hover:-translate-y-0.5",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/**
 * Props for the design-system Button component. The component is a wrapper
 * around a native `button` element but supports `asChild` to render a
 * custom element, and exposes style variants via `class-variance-authority`.
 */
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

/**
 * Reusable Button used across the app. Supports `variant` and `size`
 * styling options and forwards native button attributes.
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
