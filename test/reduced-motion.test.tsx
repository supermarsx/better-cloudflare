import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, test } from "node:test";
import { act, cleanup, render } from "@testing-library/react";

import {
  DnsWorkspaceTabs,
  type DnsWorkspaceTabItem,
} from "../src/components/dns/DnsWorkspaceTabs";
import { usePrefersReducedMotion } from "../src/hooks/use-prefers-reduced-motion";

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

const ITEMS: DnsWorkspaceTabItem[] = [
  { id: "a", label: "alpha.test", kind: "zone", status: "active" },
  { id: "b", label: "beta.test", kind: "zone", status: "active" },
  { id: "c", label: "gamma.test", kind: "zone", status: "active" },
];

type MediaListener = (event: MediaQueryListEvent) => void;

const originalMatchMedia = window.matchMedia;
const originalAnimate = (Element.prototype as { animate?: Element["animate"] })
  .animate;
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

/** Report a fixed `prefers-reduced-motion` answer to everything under test. */
function stubMatchMedia(matches: boolean): void {
  const listeners = new Set<MediaListener>();
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: MediaListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: MediaListener) => {
      listeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/**
 * jsdom lays nothing out, so every rect is zero and a FLIP would find nothing
 * to play. Hand out a moving `left` instead so the only thing that can suppress
 * the animation is the motion preference itself.
 */
function stubMovingLayout(): void {
  let left = 0;
  Element.prototype.getBoundingClientRect = function movingRect() {
    left += 40;
    return {
      left,
      top: 0,
      right: left,
      bottom: 0,
      width: 0,
      height: 0,
      x: left,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

function stubAnimate(): { calls: number } {
  const counter = { calls: 0 };
  (Element.prototype as { animate?: unknown }).animate = function animate() {
    counter.calls += 1;
    return { cancel: () => {}, finish: () => {} } as unknown as Animation;
  };
  return counter;
}

function renderTabs(items: DnsWorkspaceTabItem[]) {
  return render(
    <DnsWorkspaceTabs
      items={items}
      activeId="a"
      closeOnMiddleClick
      onActivate={() => {}}
      onClose={() => {}}
      onOrderChange={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  if (originalAnimate) {
    (Element.prototype as { animate?: unknown }).animate = originalAnimate;
  } else {
    delete (Element.prototype as { animate?: unknown }).animate;
  }
});

test("usePrefersReducedMotion reports the reduce preference", () => {
  stubMatchMedia(true);
  let reduced: boolean | null = null;
  function Probe() {
    reduced = usePrefersReducedMotion();
    return null;
  }
  render(<Probe />);
  assert.equal(reduced, true);
});

test("usePrefersReducedMotion defaults to false when the preference is unreadable", () => {
  window.matchMedia = undefined as unknown as typeof window.matchMedia;
  let reduced: boolean | null = null;
  function Probe() {
    reduced = usePrefersReducedMotion();
    return null;
  }
  render(<Probe />);
  assert.equal(reduced, false);
});

test("tab reorder skips Element.animate when the viewer asked for reduced motion", () => {
  stubMatchMedia(true);
  stubMovingLayout();
  const animate = stubAnimate();

  const view = renderTabs(ITEMS);
  act(() => {
    view.rerender(
      <DnsWorkspaceTabs
        items={[ITEMS[1]!, ITEMS[0]!, ITEMS[2]!]}
        activeId="a"
        closeOnMiddleClick
        onActivate={() => {}}
        onClose={() => {}}
        onOrderChange={() => {}}
      />,
    );
  });

  assert.equal(animate.calls, 0);
});

test("tab reorder still plays Element.animate when motion is allowed", () => {
  stubMatchMedia(false);
  stubMovingLayout();
  const animate = stubAnimate();

  const view = renderTabs(ITEMS);
  act(() => {
    view.rerender(
      <DnsWorkspaceTabs
        items={[ITEMS[1]!, ITEMS[0]!, ITEMS[2]!]}
        activeId="a"
        closeOnMiddleClick
        onActivate={() => {}}
        onClose={() => {}}
        onOrderChange={() => {}}
      />,
    );
  });

  assert.ok(
    animate.calls > 0,
    `expected the FLIP to run, got ${animate.calls} calls`,
  );
});

test("Radix enter/exit motion is hand-written CSS rather than the unloaded plugin", () => {
  for (const name of [
    "ui-overlay-motion",
    "ui-surface-motion",
    "ui-menu-motion",
    "ui-toast-motion",
  ]) {
    assert.match(
      css,
      new RegExp(`\\.${name}\\[data-state="open"\\]`),
      `missing open motion for .${name}`,
    );
    assert.match(
      css,
      new RegExp(`\\.${name}\\[data-state="closed"\\]`),
      `missing close motion for .${name}`,
    );
  }

  // Radix defers unmount until `animationend`, so an exit driven by a
  // `transition` would never be seen.
  const exits = css.match(/\[data-state="closed"\]\s*\{[^}]*\}/g) ?? [];
  assert.ok(exits.length >= 4);
  for (const exit of exits) {
    assert.match(exit, /animation:/);
  }
});

test("reduced motion gates the hand-written animations and the hover lifts", () => {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.ok(start >= 0);
  const block = css.slice(start, css.indexOf("\n  }", start));

  for (const selector of [
    ".ui-overlay-motion",
    ".ui-surface-motion",
    ".ui-menu-motion",
    ".ui-toast-motion",
    ".ui-tooltip",
    ".fade-in",
    ".fade-in-up",
    ".skeleton",
    ".glass-sheen::after",
    ".glass-surface-hover",
    ".ui-entry",
    ".ui-tag",
    ".ui-icon-button",
    ".ui-tab",
    ".ui-segment",
    ".ui-table-row",
    ".checkbox-themed",
  ]) {
    assert.ok(
      block.includes(`${selector},`) || block.includes(`${selector} {`),
      `reduced motion does not cover ${selector}`,
    );
  }

  assert.match(block, /transform:\s*none\s*!important/);
  assert.match(
    block,
    /\.animate-spin\s*\{\s*animation-duration:\s*2s\s*!important/,
  );
});

test("motion tokens are declared once and used instead of hand-typed durations", () => {
  for (const token of [
    "--motion-fast: 120ms",
    "--motion-quick: 160ms",
    "--motion-base: 180ms",
    "--motion-slow: 240ms",
    "--motion-slower: 320ms",
    "--ease-standard: cubic-bezier(0.2, 0, 0, 1)",
    "--ease-exit: cubic-bezier(0.4, 0, 1, 1)",
  ]) {
    assert.ok(css.includes(token), `missing motion token: ${token}`);
  }

  const declarations = css.slice(css.indexOf("@layer utilities"));
  const strays = declarations.match(/(?<=\s)\d+ms/g) ?? [];
  assert.deepEqual(
    strays,
    [],
    `hand-typed durations remain: ${strays.join(", ")}`,
  );
});

test("wide regions own a horizontal scroller instead of being clipped by the shell", () => {
  const segmentGroup = css.slice(
    css.indexOf("  .ui-segment-group {"),
    css.indexOf("  .ui-segment {"),
  );
  assert.match(segmentGroup, /max-width:\s*100%/);
  assert.match(segmentGroup, /overflow-x:\s*auto/);
  assert.match(segmentGroup, /white-space:\s*nowrap/);

  // A one-row strip must pin its block axis. Left at the default `visible`,
  // CSS computes it to `auto` because the inline axis scrolls, and the row's
  // fractional height then rounds into a phantom pixel of vertical overflow -
  // enough for Chromium to paint a full vertical scrollbar over the tabs.
  assert.match(segmentGroup, /overflow-y:\s*hidden/);
  // ...and with no vertical scrollbar to reserve for, `.scrollbar-themed`'s
  // stable gutter would only steal inline space from the tabs.
  assert.match(
    segmentGroup,
    /\.ui-segment-group\.scrollbar-themed\s*\{[^}]*scrollbar-gutter:\s*auto/s,
  );

  const table = css.slice(
    css.indexOf("  .ui-table {"),
    css.indexOf("  .ui-table-head {"),
  );
  assert.match(table, /overflow-x:\s*auto/);
  assert.doesNotMatch(table, /overflow:\s*hidden/);
  assert.match(
    table,
    /\.ui-table-head,\s*\.ui-table-row\s*\{[^}]*min-width:\s*min-content/s,
  );
});
