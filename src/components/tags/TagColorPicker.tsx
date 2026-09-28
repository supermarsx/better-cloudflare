import * as React from "react";

import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";
import {
  TAG_COLOR_IDS,
  TAG_COLOR_LABELS,
  type TagColorId,
  tagSwatchStyle,
} from "@/components/tags/tag-colors";

export interface TagColorPickerProps {
  value: TagColorId;
  onChange: (next: TagColorId) => void;
  /**
   * Names the tag being recoloured, so each swatch gets an unambiguous label
   * when several pickers share a page. Omit it for the "new tag" form, where
   * there is no tag to name yet.
   */
  tagName?: string;
  className?: string;
}

/**
 * The palette swatches.
 *
 * Buttons with `aria-pressed` rather than a radio group: each swatch is
 * independently tabbable and activates on Enter or Space with no extra key
 * handling, which is the behaviour a keyboard user already expects from a row of
 * buttons. Selection is shown by an outline ring, not by colour alone, and the
 * colour's name is always in the accessible label.
 *
 * Every colour here is an inline style: this project's Tailwind build does not
 * emit the theme colour utilities (`bg-card`, `border-border`, ...) from
 * `tailwind.config.js`, so a class like `outline-foreground` would be inert.
 */
export function TagColorPicker({
  value,
  onChange,
  tagName,
  className,
}: TagColorPickerProps) {
  const { t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t("Tag color", "Tag color")}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {TAG_COLOR_IDS.map((id) => {
        const source = TAG_COLOR_LABELS[id];
        const name = t(source, source);
        const selected = value === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            aria-label={
              tagName
                ? t("Set {{tag}} color to {{color}}", {
                    tag: tagName,
                    color: name,
                    defaultValue: `Set ${tagName} color to ${name}`,
                  })
                : t("Use the {{color}} color", {
                    color: name,
                    defaultValue: `Use the ${name} color`,
                  })
            }
            title={name}
            data-tag-color-option={id}
            className="ui-focus h-6 w-6 shrink-0 rounded-full border"
            style={{
              ...tagSwatchStyle(id),
              borderColor: "hsl(var(--border))",
              outline: selected ? "2px solid hsl(var(--foreground))" : "none",
              outlineOffset: "2px",
            }}
            onClick={() => onChange(id)}
          />
        );
      })}
    </div>
  );
}
