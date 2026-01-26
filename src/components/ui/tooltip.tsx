"use client";

import * as React from "react";
import { createPortal } from "react-dom";

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
  const triggerRef = React.useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ x: number; y: number }>({
    x: -9999,
    y: -9999,
  });

  const updatePosition = React.useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 10;

    let x = rect.left + rect.width / 2;
    let y = rect.top - gap;

    if (side === "bottom") {
      y = rect.bottom + gap;
    } else if (side === "left") {
      x = rect.left - gap;
      y = rect.top + rect.height / 2;
    } else if (side === "right") {
      x = rect.right + gap;
      y = rect.top + rect.height / 2;
    }

    setPos({ x, y });
  }, [side]);

  React.useEffect(() => {
    if (!open) return;
    updatePosition();

    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, updatePosition]);

  return (
    <span className={cn("ui-tooltip-wrap", className)} {...props}>
      <span
        ref={triggerRef}
        className="ui-tooltip-trigger"
        aria-describedby={id}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {children}
      </span>
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              id={id}
              role="tooltip"
              className="ui-tooltip"
              data-side={side}
              style={{
                left: `${pos.x}px`,
                top: `${pos.y}px`,
                transform:
                  side === "top" || side === "bottom"
                    ? "translate(-50%, -100%)"
                    : "translate(0, -50%)",
              }}
            >
              {tip}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
