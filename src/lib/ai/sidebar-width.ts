/**
 * How wide the docked assistant is, and the bounds a user can drag it between.
 *
 * # Why this is a module rather than two numbers in the component
 *
 * Three places need the same bounds and they must not disagree:
 *
 * - the drag handle, which clamps while the pointer moves;
 * - `StorageManager`, which clamps again on the way in, because a stored width
 *   can arrive from a settings profile or a hand-edited `localStorage`;
 * - the `aria-valuemin`/`aria-valuemax` the handle reports, which is what a
 *   screen-reader user is told the range is.
 *
 * If the UI clamped to one range and storage to another, a width would be
 * accepted on release and silently changed on the next launch — the kind of
 * defect that looks like the setting "not saving". Same reasoning as the RTL
 * boot script sharing its tables with the module it mirrors.
 */

/** The width the dock has always had: `lg:w-[22rem]`. */
export const DEFAULT_AI_SIDEBAR_WIDTH = 352;

/**
 * Narrower than this and the transcript stops being readable — a wrapped tool
 * notice and a code block both need roughly this much to avoid one word per
 * line.
 */
export const MIN_AI_SIDEBAR_WIDTH = 288;

/**
 * Wider than this and the dock stops sharing the window. On a 1280px display
 * this still leaves 640px of workspace, which is enough for the DNS table's
 * name and content columns — the thing a user docked the assistant *beside*.
 */
export const MAX_AI_SIDEBAR_WIDTH = 640;

/**
 * A usable pixel width, or `null` when the value cannot be one.
 *
 * `null` rather than the default, so a caller can tell "never set" from "set to
 * the default" — `StorageManager` relies on that distinction to avoid writing a
 * width over one stored on a previous launch, exactly as it does for the
 * bubble's position.
 *
 * A finite number outside the bounds is clamped rather than rejected. It is a
 * real preference expressed against a window that may have been a different
 * size, so the nearest width the user can actually use is a better answer than
 * discarding it.
 */
export function clampAiSidebarWidth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < MIN_AI_SIDEBAR_WIDTH) return MIN_AI_SIDEBAR_WIDTH;
  if (rounded > MAX_AI_SIDEBAR_WIDTH) return MAX_AI_SIDEBAR_WIDTH;
  return rounded;
}

/** How far one arrow-key press moves the edge. */
export const AI_SIDEBAR_WIDTH_STEP = 16;

/** How far `Shift` plus an arrow moves it, for crossing the range quickly. */
export const AI_SIDEBAR_WIDTH_COARSE_STEP = 64;
