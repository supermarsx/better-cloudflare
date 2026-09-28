import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

function section(start: string, end: string): string {
  const startIndex = css.indexOf(start);
  const endIndex = css.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing CSS section: ${start}`);
  assert.ok(endIndex > startIndex, `Missing CSS section boundary: ${end}`);
  return css.slice(startIndex, endIndex);
}

test("themed scrollbars reserve stable space and support both axes", () => {
  const scrollbarCss = section("  .scrollbar-themed {", "  .checkbox-themed {");

  assert.match(scrollbarCss, /scrollbar-width:\s*thin/);
  assert.match(scrollbarCss, /scrollbar-gutter:\s*stable/);
  assert.match(scrollbarCss, /::-webkit-scrollbar\s*\{[^}]*width:\s*8px/s);
  assert.match(scrollbarCss, /::-webkit-scrollbar\s*\{[^}]*height:\s*8px/s);
  assert.match(scrollbarCss, /::-webkit-scrollbar-corner/);
  assert.match(
    scrollbarCss,
    /\.scrollbar-themed\[data-radix-select-viewport\]\s*\{[^}]*scrollbar-width:\s*thin\s*!important/s,
  );
  assert.match(
    scrollbarCss,
    /\.scrollbar-themed\[data-radix-select-viewport\]::-webkit-scrollbar\s*\{[^}]*display:\s*block\s*!important/s,
  );
});

test("shell scrolling has no mask and respects contrast and motion preferences", () => {
  const scrollbarCss = section("  .scrollbar-themed {", "  .checkbox-themed {");

  assert.match(
    scrollbarCss,
    /\.app-shell-workspace-scroll\s*\{[^}]*-webkit-mask-image:\s*none\s*!important;[^}]*mask-image:\s*none\s*!important/s,
  );
  assert.match(scrollbarCss, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(scrollbarCss, /scrollbar-color:\s*auto/);
  assert.match(scrollbarCss, /background:\s*CanvasText/);
  assert.match(scrollbarCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(scrollbarCss, /scroll-behavior:\s*auto/);
  assert.match(scrollbarCss, /\[data-toast-viewport\]\s+\[data-state\]/);
  assert.match(scrollbarCss, /animation-duration:\s*0\.01ms\s*!important/);
});

test("the command toolbar's clip box clears what its buttons paint outside", () => {
  const toolbarCss = section(
    "  .app-command-toolbar {",
    "  .ui-segment-group {",
  );

  const padding = /padding-block:\s*([\d.]+)rem/.exec(toolbarCss);
  const margin = /margin-block:\s*-([\d.]+)rem/.exec(toolbarCss);
  assert.ok(
    padding,
    "the toolbar must pad the box `overflow-x: auto` clips to",
  );
  assert.ok(margin, "the padding must be handed back to the layout");

  // The padding exists only to move the clip edge. If the negative margin did
  // not cancel it exactly, the fix would make the whole command bar taller.
  assert.equal(
    margin[1],
    padding[1],
    "padding-block and margin-block must cancel, or the bar changes height",
  );

  // The furthest thing painted outside a button is the `.ui-focus` ring: 1px
  // wide at a 3px offset, so 0.25rem. The unread badge hangs 0.2rem up and the
  // hover lift travels 3px. Anything below 0.25rem still clips one of them.
  assert.ok(
    Number(padding[1]) >= 0.25,
    `padding-block ${padding[1]}rem is too small for the focus ring at 0.25rem`,
  );

  // With no vertical scrollbar possible, `.scrollbar-themed`'s stable gutter
  // would only steal inline room from the buttons.
  assert.match(
    toolbarCss,
    /\.app-command-toolbar\.scrollbar-themed\s*\{[^}]*scrollbar-gutter:\s*auto/s,
  );
});

test("shared glass surfaces keep their bottom edge readable", () => {
  const fadeCss = section("  .glass-fade {", "  .glass-fade-table {");

  assert.doesNotMatch(fadeCss, /transparent/);
  assert.match(fadeCss, /#000\s+calc\(100%\s*-\s*16px\)/);
  assert.match(fadeCss, /rgba\(0,\s*0,\s*0,\s*0\.92\)\s+100%/);
});
