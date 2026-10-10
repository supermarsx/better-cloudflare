"use client";

import type { ReactNode } from "react";
import { DirectionProvider } from "@radix-ui/react-direction";

import { useDocumentDirection } from "@/hooks/use-document-direction";

/**
 * Publishes the active locale's direction, to the document and to Radix.
 *
 * Two consumers, one source. `<html dir>` is what the browser and Tailwind's
 * logical utilities read; `useDocumentDirection` sets it. Radix's primitives
 * read something else entirely: `useDirection()` in
 * `@radix-ui/react-direction` is `localDir || globalDir || "ltr"`, a React
 * context with no reference to `document.dir` anywhere in the module. So
 * `dir="rtl"` on `<html>` does not reach them at all, and without this
 * provider every Radix menu in the app keeps laying itself out for LTR even
 * when the page is RTL:
 *
 * - `@radix-ui/react-menu` (DropdownMenu, context-menu) anchors `align="end"`
 *   against the wrong edge and opens submenus on the wrong side;
 * - `@radix-ui/react-roving-focus` does not swap ArrowLeft/ArrowRight, so the
 *   arrow keys walk menus and segmented controls backwards;
 * - `@radix-ui/react-select` and `@radix-ui/react-toast` read it too.
 *
 * It wraps rather than sits beside `children` because a context provider has
 * to be an ancestor of its consumers. `children` arrives from a server
 * component as an already-rendered element, so a locale change re-renders this
 * component and React skips the subtree underneath it.
 */
export function DocumentDirection({ children }: { children?: ReactNode }) {
  const direction = useDocumentDirection();
  return <DirectionProvider dir={direction}>{children}</DirectionProvider>;
}
