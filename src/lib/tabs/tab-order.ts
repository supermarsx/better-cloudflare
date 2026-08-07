/**
 * Pure helpers for reordering and rehydrating workspace tab order.
 *
 * Kept free of React so the reorder semantics can be unit-tested directly —
 * pointer drags are not meaningfully reproducible in jsdom.
 */

/** Anything addressable by a stable string id. */
export interface Identified {
  id: string;
}

/** Where a dragged tab should land relative to the tab it was dropped on. */
export type DropPosition = "before" | "after";

/**
 * Move `sourceId` so it sits at `targetIndex` in the returned array.
 * Out-of-range indexes clamp; unknown ids return the input untouched.
 */
export function moveItemToIndex<T extends Identified>(
  items: readonly T[],
  sourceId: string,
  targetIndex: number,
): T[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  if (sourceIndex < 0) return [...items];

  const next = [...items];
  const [moved] = next.splice(sourceIndex, 1);
  const clamped = Math.max(0, Math.min(targetIndex, next.length));
  next.splice(clamped, 0, moved);
  return next;
}

/**
 * Move `sourceId` by `delta` slots (negative moves left). The tab stops at the
 * ends rather than wrapping, so repeated key presses are predictable.
 */
export function moveItemBy<T extends Identified>(
  items: readonly T[],
  sourceId: string,
  delta: number,
): T[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  if (sourceIndex < 0 || delta === 0) return [...items];
  const targetIndex = sourceIndex + delta;
  if (targetIndex < 0 || targetIndex > items.length - 1) return [...items];
  return moveItemToIndex(items, sourceId, targetIndex);
}

/**
 * Move `sourceId` so it lands immediately before or after `targetId`. This is
 * the drop-indicator semantic: the indicator sits in a gap, and the tab lands
 * in that gap.
 */
export function moveItemRelativeTo<T extends Identified>(
  items: readonly T[],
  sourceId: string,
  targetId: string,
  position: DropPosition,
): T[] {
  if (sourceId === targetId) return [...items];
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return [...items];

  const withoutSource = items.filter((item) => item.id !== sourceId);
  const anchorIndex = withoutSource.findIndex((item) => item.id === targetId);
  const insertAt = position === "after" ? anchorIndex + 1 : anchorIndex;
  const next = [...withoutSource];
  next.splice(insertAt, 0, items[sourceIndex]);
  return next;
}

/**
 * Reorder `items` to follow `order`.
 *
 * Backward compatible by construction: ids in `order` that no longer exist are
 * ignored, and items missing from `order` (including everything, when `order`
 * is empty or was never persisted) keep their current relative position at the
 * end. An absent/garbage `order` therefore yields the input order unchanged
 * rather than an empty or randomized tab strip.
 */
export function reconcileTabOrder<T extends Identified>(
  items: readonly T[],
  order?: readonly string[] | null,
): T[] {
  if (!Array.isArray(order) || order.length === 0) return [...items];

  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const ordered: T[] = [];

  for (const id of order) {
    if (typeof id !== "string" || seen.has(id)) continue;
    const item = byId.get(id);
    if (!item) continue;
    seen.add(id);
    ordered.push(item);
  }
  for (const item of items) {
    if (!seen.has(item.id)) ordered.push(item);
  }
  return ordered;
}

/** Human-readable announcement for assistive tech after a keyboard move. */
export function describeTabMove(
  label: string,
  index: number,
  total: number,
): string {
  return `${label} moved to position ${index + 1} of ${total}`;
}
