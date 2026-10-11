/**
 * Select UI primitive based on Radix.Select and decorated with app styles.
 */
import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";

/*
 * The check gutter is `pl-7` with the indicator at `left-1.5`, not `pl-8` /
 * `left-2`.
 *
 * The gutter exists so a label does not shift sideways when its checkmark
 * appears, which is worth keeping. But 32px of it is conspicuous in a menu of
 * short labels — the records-per-page select reads "25", "50", "100", and the
 * numbers sat a third of an inch right of the panel edge while the trigger
 * showed them at 12px. 28px still clears the 14px indicator at `left-1.5`
 * with room to spare, so nothing overlaps and nothing shifts.
 *
 * Changed across select, dropdown-menu and context-menu together: these are
 * the same visual idiom and a gutter that differs between them is more
 * noticeable than one that is slightly wide.
 */

/**
 * A set of select components and primitives that wrap Radix UI primitives
 * providing a consistent styled select used across the app.
 */
const Select = SelectPrimitive.Root;

const SelectGroup = SelectPrimitive.Group;

const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "ui-focus glass-surface glass-sheen glass-surface-hover flex h-10 w-full items-center justify-between rounded-md bg-background/20 px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1 data-[state=hidden]:hidden",
      className,
    )}
    {...props}
  >
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1 data-[state=hidden]:hidden",
      className,
    )}
    {...props}
  >
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(
  (
    {
      className,
      children,
      position = "popper",
      sideOffset = 4,
      collisionPadding = 12,
      ...props
    },
    ref,
  ) => (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        avoidCollisions
        sticky="always"
        hideWhenDetached
        className={cn(
          "glass-surface glass-fade ui-menu-motion z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-xl bg-popover/70 text-foreground shadow-[0_18px_46px_hsl(0_0%_0%_/_0.26)]",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className,
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          data-select-scroll-region
          className={cn(
            "scrollbar-themed p-1",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  ),
);
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("py-1.5 pl-7 pr-2 text-sm font-semibold", className)}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

/**
 * A row in the list, with its tick at the **end** rather than the start.
 *
 * # Why this differs from the menu primitives
 *
 * `DropdownMenuCheckboxItem` and the context-menu items keep a leading tick and
 * a `pl-7` gutter, which is right for them: a checkbox menu shows several ticks
 * at once and the column is what makes them scannable.
 *
 * A select is not that. Exactly one row is ever ticked, and the trigger above
 * already states which — so a leading gutter buys nothing and costs alignment.
 * `SelectTrigger` is `px-3`, and the viewport is `p-1`, so a leading `pl-7` put
 * the closed value at 12px from the control's edge and the open rows at 32px: a
 * visible 20px step between the two, reported on 2026-10-11 as "this weird left
 * hand margin". It is most obvious on the topology DNS-server and GEO-provider
 * selects, which pin `SelectContent` to the trigger width, so the gutter takes
 * 13% of a 208px row full of labels like `149.112.112.112 (Quad9)`.
 *
 * With the tick at the end, a row's text starts at `.ui-entry`'s own 0.5rem,
 * which lands at 12px — the trigger's figure exactly. Text width is unchanged;
 * the gutter moved rather than shrank.
 *
 * `pe-7`/`end-1.5` are logical, so this follows `dir` without the component
 * sweep having to come back here. The 28px end gutter clears a 14px indicator
 * inset 6px from the end, matching the 28px the leading gutter was sized for.
 *
 * `.ui-entry`'s `padding` shorthand outranks a Tailwind padding utility (see
 * the note in `src/index.css`), so `pe-7` only lands because that file carries
 * a compound `.ui-entry.pe-7` override. `test/documentDirection.test.tsx`
 * derives the requirement from this file, so dropping the override fails there
 * rather than silently putting the label back under the tick.
 */
const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "ui-entry relative flex w-full cursor-default select-none items-center pe-7 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>

    <span className="absolute end-1.5 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border/60", className)}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
