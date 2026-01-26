import * as React from "react";

import { cn } from "@/lib/utils";

type TooltipSide = "top" | "bottom" | "left" | "right";

export interface TooltipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tip: React.ReactNode;
  side?: TooltipSide;
}

export function Tooltip({
  tip,
  side = "top",
  className,
  children,
  ...props
}: TooltipProps) {
  const id = React.useId();

  return (
    <span className={cn("ui-tooltip-wrap", className)} {...props}>
      <span className="ui-tooltip-trigger" aria-describedby={id}>
        {children}
      </span>
      <span id={id} role="tooltip" className="ui-tooltip" data-side={side}>
        {tip}
      </span>
    </span>
  );
}
