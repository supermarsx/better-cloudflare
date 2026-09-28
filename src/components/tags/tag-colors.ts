import type { CSSProperties } from "react";

/**
 * Tag colours are a fixed palette, not a free colour picker.
 *
 * The app ships four themes -- one light (`light`) and three dark (`sunset`,
 * `oled`, `void`) -- and a hex the user typed can only be legible against one
 * of them. Each entry below is therefore a single vivid *seed* colour; the
 * chip's ink, tint and border are all derived from that seed by mixing it with
 * the theme's own `--foreground` / `--card` tokens. A chip re-derives itself
 * when the theme changes, so one stored id covers every theme instead of
 * needing a light and a dark variant per colour.
 *
 * The seeds and the three mix ratios below were chosen so the ink keeps at
 * least 4.69:1 against the chip's own background in all four themes (WCAG AA
 * for normal text), measured with the `.ui-tag::before` white highlight at its
 * brightest point. Changing a seed or a ratio changes those ratios -- re-check
 * the worst case before you do.
 */
const TAG_COLOR_SEEDS = {
  slate: "215 15% 50%",
  red: "0 70% 50%",
  orange: "26 80% 45%",
  amber: "44 78% 40%",
  green: "145 58% 40%",
  teal: "182 58% 37%",
  blue: "214 78% 52%",
  violet: "262 65% 57%",
  pink: "330 68% 52%",
} as const;

export type TagColorId = keyof typeof TAG_COLOR_SEEDS;

/**
 * Tags saved before colours existed have no stored id, and neutral grey is what
 * they already looked like -- so "no colour chosen" and `slate` render alike.
 */
export const DEFAULT_TAG_COLOR_ID: TagColorId = "slate";

export const TAG_COLOR_IDS = Object.keys(TAG_COLOR_SEEDS) as TagColorId[];

/** English source strings; callers pass these through `t()`. */
export const TAG_COLOR_LABELS: Record<TagColorId, string> = {
  slate: "Slate",
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  violet: "Violet",
  pink: "Pink",
};

/**
 * Resolve a stored colour id. Storage keeps the id as an opaque string so that
 * a palette entry can be added or renamed without a data migration, which means
 * anything unrecognised -- a hand-edited value, a colour this build no longer
 * ships -- has to land on the default rather than throw or render blank.
 */
export function resolveTagColorId(value: unknown): TagColorId {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(TAG_COLOR_SEEDS, value)
    ? (value as TagColorId)
    : DEFAULT_TAG_COLOR_ID;
}

/** Seed share of the chip background; the rest is the theme's `--card`. */
const TINT_SHARE = "20%";
/** Seed share of the chip text; the rest is the theme's `--foreground`. */
const INK_SHARE = "55%";
/** Seed share of the chip border; the rest is transparent. */
const BORDER_SHARE = "55%";

/**
 * Colour a tag chip.
 *
 * These land as inline styles rather than utility classes on purpose: `.ui-tag`
 * is emitted after Tailwind's own utilities inside the same `utilities` cascade
 * layer, so a same-specificity class (`text-[8px]`, `bg-…`) loses to it. Inline
 * styles are the one place that reliably wins without an `!important` rule in
 * `src/index.css`.
 */
export function tagColorStyle(colorId: TagColorId): CSSProperties {
  const seed = `hsl(${TAG_COLOR_SEEDS[colorId]})`;
  return {
    color: `color-mix(in srgb, ${seed} ${INK_SHARE}, hsl(var(--foreground)))`,
    background: `color-mix(in srgb, ${seed} ${TINT_SHARE}, hsl(var(--card)))`,
    borderColor: `color-mix(in srgb, ${seed} ${BORDER_SHARE}, transparent)`,
  };
}

/** The palette swatch in the picker: the seed itself, at full strength. */
export function tagSwatchStyle(colorId: TagColorId): CSSProperties {
  return { background: `hsl(${TAG_COLOR_SEEDS[colorId]})` };
}
