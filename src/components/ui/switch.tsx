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
      "switch-toggle peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-border bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary/70 data-[state=checked]:bg-primary data-[state=checked]:shadow-[0_0_6px_rgba(255,120,80,0.25)]",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "switch-toggle-thumb pointer-events-none block h-5 w-5 rounded-full border-2 border-border bg-background shadow-[0_2px_6px_rgba(0,0,0,0.35)] transition-transform transition-colors data-[state=unchecked]:translate-x-0 data-[state=checked]:translate-x-5 data-[state=checked]:border-primary-foreground data-[state=checked]:bg-primary-foreground data-[state=checked]:shadow-[0_0_6px_rgba(255,160,120,0.25)]",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;
export { Switch };
