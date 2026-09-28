import * as React from "react";

import { Tag } from "@/components/ui/tag";
import { type TagColorId, tagColorStyle } from "@/components/tags/tag-colors";

/**
 * `table` shrinks the chip to the scale the records table already uses for its
 * record-type chips (`.ui-table-row .ui-tag[data-record-type]` in
 * `src/index.css`: 8px text, 2px/4px padding), so a row's tags sit level with
 * its type chip instead of towering over it. Surfaces where a tag is read or
 * edited rather than scanned -- the Tag manager, a record's expanded panel --
 * keep `default`, the size `.ui-tag` ships.
 */
export type TagChipSize = "default" | "table";

const TABLE_METRICS: React.CSSProperties = {
  fontSize: "8px",
  padding: "2px 5px",
  gap: "0.25rem",
  letterSpacing: "0.05em",
};

export interface TagChipProps extends Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  "color"
> {
  colorId: TagColorId;
  size?: TagChipSize;
}

/**
 * A tag rendered in its configured colour.
 *
 * `data-tag-color` carries the resolved id onto the DOM: colour arrives as an
 * inline `color-mix()` expression, which jsdom's CSS parser drops, so the
 * attribute is what tests (and anyone debugging in the inspector) can read back.
 */
export function TagChip({
  colorId,
  size = "default",
  style,
  ...props
}: TagChipProps) {
  return (
    <Tag
      data-tag-color={colorId}
      data-tag-size={size}
      style={{
        ...tagColorStyle(colorId),
        ...(size === "table" ? TABLE_METRICS : null),
        ...style,
      }}
      {...props}
    />
  );
}
