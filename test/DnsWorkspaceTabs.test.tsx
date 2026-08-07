import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  DnsWorkspaceTabs,
  type DnsWorkspaceTabItem,
} from "../src/components/dns/DnsWorkspaceTabs";
import { reconcileTabOrder } from "../src/lib/tabs/tab-order";

const ITEMS: DnsWorkspaceTabItem[] = [
  { id: "a", label: "alpha.test", kind: "zone", status: "active" },
  { id: "b", label: "beta.test", kind: "zone", status: "active" },
  { id: "c", label: "gamma.test", kind: "zone", status: "active" },
];

interface Harness {
  orders: string[][];
  activated: string[];
  closed: string[];
  rerenderWithOrder: (orderedIds: string[]) => void;
}

/**
 * Render the strip with a stateful parent, mirroring how DNSManager reorders
 * its own `tabs` array in response to `onOrderChange`.
 */
function renderTabs(activeId = "a"): Harness {
  const orders: string[][] = [];
  const activated: string[] = [];
  const closed: string[] = [];
  let current = ITEMS;

  const view = render(
    <DnsWorkspaceTabs
      items={current}
      activeId={activeId}
      closeOnMiddleClick
      onActivate={(id) => activated.push(id)}
      onClose={(id) => closed.push(id)}
      onOrderChange={(orderedIds) => {
        orders.push(orderedIds);
        current = reconcileTabOrder(current, orderedIds);
        view.rerender(
          <DnsWorkspaceTabs
            items={current}
            activeId={activeId}
            closeOnMiddleClick
            onActivate={(id) => activated.push(id)}
            onClose={(id) => closed.push(id)}
            onOrderChange={() => {}}
          />,
        );
      }}
    />,
  );

  return {
    orders,
    activated,
    closed,
    rerenderWithOrder: (orderedIds) => {
      current = reconcileTabOrder(current, orderedIds);
      view.rerender(
        <DnsWorkspaceTabs
          items={current}
          activeId={activeId}
          closeOnMiddleClick
          onActivate={(id) => activated.push(id)}
          onClose={(id) => closed.push(id)}
          onOrderChange={() => {}}
        />,
      );
    },
  };
}

function renderedTabLabels(): string[] {
  return screen.getAllByRole("tab").map((tab) => tab.textContent?.trim() ?? "");
}

afterEach(() => {
  cleanup();
});

test("Ctrl+Shift+ArrowRight moves the focused tab one slot right", () => {
  const harness = renderTabs();
  const alpha = screen.getByRole("tab", { name: /alpha\.test/ });

  fireEvent.keyDown(alpha, {
    key: "ArrowRight",
    ctrlKey: true,
    shiftKey: true,
  });

  assert.deepEqual(harness.orders, [["b", "a", "c"]]);
  assert.deepEqual(renderedTabLabels(), [
    "beta.test",
    "alpha.test",
    "gamma.test",
  ]);
});

test("Ctrl+Shift+ArrowLeft moves the focused tab one slot left", () => {
  const harness = renderTabs();
  const gamma = screen.getByRole("tab", { name: /gamma\.test/ });

  fireEvent.keyDown(gamma, { key: "ArrowLeft", ctrlKey: true, shiftKey: true });

  assert.deepEqual(harness.orders, [["a", "c", "b"]]);
});

test("Meta+Shift+Home and End send a tab to either edge", () => {
  const harness = renderTabs();
  fireEvent.keyDown(screen.getByRole("tab", { name: /gamma\.test/ }), {
    key: "Home",
    metaKey: true,
    shiftKey: true,
  });
  assert.deepEqual(harness.orders.at(-1), ["c", "a", "b"]);
});

test("a keyboard move is announced through an aria-live region", () => {
  renderTabs();
  const status = screen.getByTestId("dns-tab-reorder-status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.equal(status.textContent, "");

  fireEvent.keyDown(screen.getByRole("tab", { name: /alpha\.test/ }), {
    key: "ArrowRight",
    ctrlKey: true,
    shiftKey: true,
  });

  assert.equal(
    screen.getByTestId("dns-tab-reorder-status").textContent,
    "alpha.test moved to position 2 of 3",
  );
});

test("moving past an edge is a no-op and is not announced", () => {
  const harness = renderTabs();
  fireEvent.keyDown(screen.getByRole("tab", { name: /alpha\.test/ }), {
    key: "ArrowLeft",
    ctrlKey: true,
    shiftKey: true,
  });

  assert.deepEqual(harness.orders, []);
  assert.equal(screen.getByTestId("dns-tab-reorder-status").textContent, "");
});

test("plain arrow keys still activate rather than reorder", () => {
  const harness = renderTabs();
  fireEvent.keyDown(screen.getByRole("tab", { name: /alpha\.test/ }), {
    key: "ArrowRight",
  });

  assert.deepEqual(harness.orders, []);
  assert.deepEqual(harness.activated, ["b"]);
});

test("activation and close still work after a reorder", () => {
  const harness = renderTabs();
  fireEvent.keyDown(screen.getByRole("tab", { name: /alpha\.test/ }), {
    key: "ArrowRight",
    ctrlKey: true,
    shiftKey: true,
  });
  assert.deepEqual(renderedTabLabels(), [
    "beta.test",
    "alpha.test",
    "gamma.test",
  ]);

  fireEvent.click(screen.getByRole("tab", { name: /gamma\.test/ }));
  assert.deepEqual(harness.activated, ["c"]);

  fireEvent.click(
    screen.getByRole("button", { name: "Close tab: alpha.test" }),
  );
  assert.deepEqual(harness.closed, ["a"]);
});

test("middle-click close keeps working after a reorder", () => {
  const harness = renderTabs();
  fireEvent.keyDown(screen.getByRole("tab", { name: /alpha\.test/ }), {
    key: "ArrowRight",
    ctrlKey: true,
    shiftKey: true,
  });

  fireEvent.mouseDown(screen.getByRole("tab", { name: /beta\.test/ }), {
    button: 1,
  });
  assert.deepEqual(harness.closed, ["b"]);
});

test("a drag start marks the tab and suppresses the activation click", () => {
  const harness = renderTabs();
  const alphaTab = screen.getByRole("tab", { name: /alpha\.test/ });
  const wrapper = alphaTab.closest("[data-tab-id]") as HTMLElement;
  assert.ok(wrapper);
  assert.equal(wrapper.getAttribute("draggable"), "true");

  fireEvent.dragStart(wrapper, {
    dataTransfer: { setData: () => {}, effectAllowed: "" },
  });
  assert.equal(wrapper.getAttribute("data-dragging"), "true");

  // A click synthesized by the end of a drag must not activate the tab.
  fireEvent.click(alphaTab);
  assert.deepEqual(harness.activated, []);
});

test("the drop indicator renders between tabs while dragging over one", () => {
  renderTabs();
  const alphaWrapper = screen
    .getByRole("tab", { name: /alpha\.test/ })
    .closest("[data-tab-id]") as HTMLElement;
  const betaWrapper = screen
    .getByRole("tab", { name: /beta\.test/ })
    .closest("[data-tab-id]") as HTMLElement;

  assert.equal(screen.queryAllByTestId("dns-tab-drop-indicator").length, 0);

  fireEvent.dragStart(alphaWrapper, {
    dataTransfer: { setData: () => {}, effectAllowed: "" },
  });
  fireEvent.dragOver(betaWrapper, {
    clientX: 0,
    dataTransfer: { dropEffect: "" },
  });

  assert.equal(screen.getAllByTestId("dns-tab-drop-indicator").length, 1);
});

test("the tab renders no drag-handle icon but stays draggable by its body", () => {
  renderTabs();
  const alphaTab = screen.getByRole("tab", { name: /alpha\.test/ });

  // The whole tab is the drag affordance now; no grip glyph inside it.
  assert.equal(alphaTab.querySelectorAll("svg").length, 0);
  assert.equal(
    document.querySelectorAll('[class*="lucide-grip"]').length,
    0,
    "no lucide grip icon should render anywhere in the strip",
  );

  const wrapper = alphaTab.closest("[data-tab-id]") as HTMLElement;
  assert.equal(wrapper.getAttribute("draggable"), "true");

  fireEvent.dragStart(wrapper, {
    dataTransfer: { setData: () => {}, effectAllowed: "" },
  });
  assert.equal(wrapper.getAttribute("data-dragging"), "true");
});

test("the grabbing cursor follows real drag state, not :active", () => {
  renderTabs();
  const alphaTab = screen.getByRole("tab", { name: /alpha\.test/ });
  const wrapper = alphaTab.closest("[data-tab-id]") as HTMLElement;
  const tablist = screen.getByRole("tablist");

  // Idle: plain cursor, and no `:active`-driven grabbing variant at all.
  assert.ok(alphaTab.classList.contains("cursor-default"));
  assert.ok(!alphaTab.classList.contains("cursor-grab"));
  assert.ok(!alphaTab.classList.contains("cursor-grabbing"));
  assert.ok(!alphaTab.className.includes("active:cursor-grabbing"));
  assert.equal(tablist.getAttribute("data-dragging"), "false");

  // A plain mousedown (a click to switch tabs) must not arm the grab cursor.
  fireEvent.mouseDown(alphaTab, { button: 0 });
  assert.ok(alphaTab.classList.contains("cursor-default"));
  assert.equal(document.body.style.cursor, "");

  fireEvent.dragStart(wrapper, {
    dataTransfer: { setData: () => {}, effectAllowed: "" },
  });
  const draggingTab = screen.getByRole("tab", { name: /alpha\.test/ });
  assert.ok(draggingTab.classList.contains("cursor-grabbing"));
  assert.ok(!draggingTab.classList.contains("cursor-default"));
  assert.equal(
    screen.getByRole("tablist").getAttribute("data-dragging"),
    "true",
  );
  // Kept on <body> so the cursor holds as the pointer leaves the tab mid-drag.
  assert.equal(document.body.style.cursor, "grabbing");

  fireEvent.dragEnd(wrapper);
  const idleTab = screen.getByRole("tab", { name: /alpha\.test/ });
  assert.ok(idleTab.classList.contains("cursor-default"));
  assert.equal(document.body.style.cursor, "");
  assert.equal(
    screen.getByRole("tablist").getAttribute("data-dragging"),
    "false",
  );
});

test("an empty tab strip renders the placeholder instead of a tablist", () => {
  render(
    <DnsWorkspaceTabs
      items={[]}
      activeId={null}
      closeOnMiddleClick={false}
      onActivate={() => {}}
      onClose={() => {}}
      onOrderChange={() => {}}
    />,
  );
  assert.equal(screen.queryAllByRole("tab").length, 0);
});
