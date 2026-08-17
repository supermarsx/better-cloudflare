"use client";

import * as React from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

type TooltipSide = "top" | "bottom" | "left" | "right";

export interface TooltipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tip: React.ReactNode;
  side?: TooltipSide;
}

/**
 * Best-effort check for whether `node` already carries an accessible name.
 *
 * The tooltip content is portalled and `pointer-events: none`, so on its own it
 * contributes nothing to the accessibility tree. To know whether the tooltip
 * text has to stand in as the control's name, or may be attached as a mere
 * description, we have to know whether the wrapped control names itself.
 *
 * The check mirrors the parts of the accessible-name computation that are
 * visible from React props: an explicit `aria-label`/`aria-labelledby`, a
 * `title` fallback, or text content anywhere in the subtree (`asChild`
 * wrappers such as Radix triggers are transparent, so recursing through
 * children finds the real control's props). Anything it cannot see -- a name
 * injected by a child component, for instance -- makes it answer `false`, which
 * errs towards labelling. Labelling something already named is a repetition;
 * failing to label something unnamed leaves it unreachable.
 */
export function hasAccessibleName(node: React.ReactNode): boolean {
  if (typeof node === "string") return node.trim().length > 0;
  if (typeof node === "number") return true;
  if (Array.isArray(node)) return node.some((item) => hasAccessibleName(item));
  if (!React.isValidElement(node)) return false;

  const props = node.props as Record<string, unknown>;
  const hidden = props["aria-hidden"];
  if (hidden === true || hidden === "true") return false;
  for (const key of ["aria-label", "aria-labelledby", "title"] as const) {
    const value = props[key];
    if (typeof value === "string" && value.trim().length > 0) return true;
  }
  return hasAccessibleName(props.children as React.ReactNode);
}

function joinIds(existing: unknown, id: string): string {
  return typeof existing === "string" && existing.trim().length > 0
    ? `${existing} ${id}`
    : id;
}

/**
 * Hover/focus tooltip that also carries its weight in the accessibility tree.
 *
 * The visible bubble is portalled to `document.body` and is
 * `pointer-events: none`, so it can never be the whole story: a screen reader
 * user who never hovers would get nothing from it. The tooltip therefore
 * associates its text with the control it wraps:
 *
 * - a control with no accessible name of its own is given one, via a
 *   permanently rendered `sr-only` element referenced with `aria-labelledby`
 *   (the same shape `BuilderFieldLabel` uses for form fields);
 * - a control that is already named is instead given `aria-describedby`
 *   pointing at the live bubble while it is open, so the tip supplements the
 *   name rather than replacing it -- repeating an existing name would be noise.
 *
 * Wrapping an icon-only button in a tooltip is consequently enough to make it
 * announceable; no hand-written `aria-label` echoing the tip is needed.
 */
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

  const tipId = `${id}-tip`;
  const nameId = `${id}-name`;

  // The tooltip only ever wraps a single control; anything else falls back to
  // describing the wrapper, which is all the old implementation ever did.
  const child = React.isValidElement(children)
    ? (children as React.ReactElement<Record<string, unknown>>)
    : null;
  const childIsNamed = child ? hasAccessibleName(child) : true;

  let trigger: React.ReactNode = children;
  if (child) {
    if (!childIsNamed) {
      // The control has no name of its own, so the tip becomes the name. It
      // lives in a permanently rendered visually hidden element (the same
      // shape BuilderFieldLabel uses) because the visible tooltip exists only
      // while hovered or focused, and a name has to be there the whole time.
      trigger = React.cloneElement(child, {
        "aria-labelledby": joinIds(child.props["aria-labelledby"], nameId),
      });
    } else if (open) {
      // Already named: the tip is extra detail, so attach it as a description
      // while it is on screen rather than overriding the existing name.
      trigger = React.cloneElement(child, {
        "aria-describedby": joinIds(child.props["aria-describedby"], tipId),
      });
    }
  }

  return (
    <span className={cn("ui-tooltip-wrap", className)} {...props}>
      <span
        ref={triggerRef}
        className="ui-tooltip-trigger"
        aria-describedby={!child && open ? tipId : undefined}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {trigger}
      </span>
      {childIsNamed ? null : (
        <span id={nameId} className="sr-only">
          {tip}
        </span>
      )}
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              id={tipId}
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
