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

test("shared glass surfaces keep their bottom edge readable", () => {
  const fadeCss = section("  .glass-fade {", "  .glass-fade-table {");

  assert.doesNotMatch(fadeCss, /transparent/);
  assert.match(fadeCss, /#000\s+calc\(100%\s*-\s*16px\)/);
  assert.match(fadeCss, /rgba\(0,\s*0,\s*0,\s*0\.92\)\s+100%/);
});
