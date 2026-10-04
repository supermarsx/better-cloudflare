/**
 * The two class strips every dropdown in the assistant shares.
 *
 * The assistant is the one surface in this app that renders its settings inside
 * a `position: fixed` floating bubble, and that is the reason this file exists
 * rather than three copies of a magic number:
 *
 * **The popover has to out-stack the bubble.** `AiAssistantSurface` paints the
 * bubble at `z-[60]`, and both it and a Radix `Select` popover are portaled to
 * `document.body`, so they are siblings in the same stacking context and
 * `z-index` alone decides which is on top. The shared `SelectContent` default
 * is `z-50`, which loses — the popover would open *behind* the bubble it was
 * opened from, which looks exactly like being clipped. {@link
 * AI_SELECT_CONTENT_CLASS} raises it above both the bubble and the docked
 * sidebar (`z-40`). Being portaled is what keeps it out of the bubble's
 * `overflow-hidden` and the dock's scroll region in the first place; the
 * z-index is the other half of the same requirement.
 *
 * **The controls stay dock-sized.** These dropdowns replaced native `<select>`
 * elements that ran at `h-8`/`text-xs` so that a 22rem dock and a 26rem bubble
 * did not spend their height on form chrome. The themed trigger defaults to
 * `h-10`/`text-sm`, so {@link AI_SELECT_TRIGGER_CLASS} puts the smaller size
 * back. It is a size, not a layout: width is left to the call site, which is
 * the only thing that knows whether the control owns its row.
 */

/**
 * Raises a `SelectContent` above the floating bubble (`z-[60]`) and the docked
 * sidebar (`z-40`). Merged over the component's own `z-50` by `cn`/tailwind-
 * merge, which keeps the last class in the `z-index` group.
 */
export const AI_SELECT_CONTENT_CLASS = "z-[70]";

/** The compact trigger size the dock and the bubble are laid out for. */
export const AI_SELECT_TRIGGER_CLASS = "h-8 text-xs";
