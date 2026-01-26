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
  const tooltipRef = React.useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number }>({
    left: -9999,
    top: -9999,
  });

  const updatePosition = React.useCallback(() => {
    const el = triggerRef.current;
    const tipEl = tooltipRef.current;
    if (!el) return;
    if (!tipEl) return;
    const rect = el.getBoundingClientRect();
    const tipRect = tipEl.getBoundingClientRect();
    const gap = 10;
    const margin = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - gap - tipRect.height;

    if (side === "bottom") {
      top = rect.bottom + gap;
    } else if (side === "left") {
      left = rect.left - gap - tipRect.width;
      top = rect.top + rect.height / 2 - tipRect.height / 2;
    } else if (side === "right") {
      left = rect.right + gap;
      top = rect.top + rect.height / 2 - tipRect.height / 2;
    }

    left = Math.min(Math.max(left, margin), vw - margin - tipRect.width);
    top = Math.min(Math.max(top, margin), vh - margin - tipRect.height);

    setPos({ left, top });
  }, [side]);

  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;
    let rafId = 0;

    const tick = () => {
      if (cancelled) return;
      updatePosition();
      rafId = window.requestAnimationFrame(() => {
        if (cancelled) return;
        updatePosition();
      });
    };

    rafId = window.requestAnimationFrame(tick);

    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
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
                left: `${pos.left}px`,
                top: `${pos.top}px`,
              }}
              ref={tooltipRef}
            >
              {tip}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
