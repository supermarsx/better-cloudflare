/**
 * Small input component used across the application to provide a
 * consistent look-and-feel for native input elements.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Props for the Input component, which are identical to native
 * `input` attributes. The component adds consistent styling used across
 * the design system.
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Input component applying consistent styling and forwarding refs/props to
 * a native `input` element.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
export { Input };
