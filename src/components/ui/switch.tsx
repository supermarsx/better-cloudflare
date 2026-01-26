/**
 * Toggle switch primitive used for boolean settings in the UI.
 */
import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

/**
 * Reusable Switch (toggle) control based on Radix primitives. Forwards
 * native props and provides design-system styles used throughout the app.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "switch-toggle glass-surface glass-surface-hover peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full bg-muted/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary/60 data-[state=checked]:bg-primary/15 data-[state=checked]:shadow-[0_0_14px_hsl(var(--primary)_/_0.18)]",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "switch-toggle-thumb pointer-events-none relative block h-6 w-6 rounded-full border border-border bg-background shadow-[0_10px_22px_hsl(0_0%_0%_/_0.35)] transition-transform transition-colors data-[state=unchecked]:translate-x-0.5 data-[state=checked]:translate-x-[1.45rem] data-[state=checked]:border-primary/35 data-[state=checked]:bg-background data-[state=checked]:shadow-[0_0_0_1px_hsl(var(--primary)_/_0.12),0_14px_28px_hsl(0_0%_0%_/_0.38),0_0_18px_hsl(var(--primary)_/_0.18)]",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;
export { Switch };
