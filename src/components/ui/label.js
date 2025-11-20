import { jsx as _jsx } from "react/jsx-runtime";
/**
 * Styled label element and helper used for consistent text labels next to
 * form fields.
 */
import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
const labelVariants = cva("text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70");
/**
 * Styled label used with form inputs. Forwards props to the Radix Label
 * while ensuring consistent styling for the design system.
 */
const Label = React.forwardRef(({ className, ...props }, ref) => (_jsx(LabelPrimitive.Root, { ref: ref, className: cn(labelVariants(), className), ...props })));
Label.displayName = LabelPrimitive.Root.displayName;
export { Label };
