/**
 * Where the topology menus are portaled, which is the whole of why they used to
 * open behind the full-window graph.
 *
 * Both the full-window lightbox and a Radix menu are portaled out of the
 * component tree. Sent to `document.body` they become siblings, and `z-index`
 * alone decides which paints on top: the lightbox is `z-[220]`, the shared menu
 * surface is `z-50`, so the menu lost and looked clipped by the canvas. The fix
 * is structural rather than numeric -- the lightbox element hosts the menus
 * opened inside it, so they sit in its stacking context instead of competing
 * with it -- and what has to hold for that to work is checked here.
 *
 * **The portal target itself is not observable in this harness.**
 * `test/node-test-env.ts` replaces `ReactDOM.createPortal` with a pass-through
 * that returns its children and drops the container, so every portal in every
 * jsdom test renders inline and all of them look "contained" by whatever
 * happens to wrap them. That stub cannot be undone from a test file either: the
 * ESM view of `react-dom` is snapshotted from the already-patched CJS exports
 * before any test code runs, so restoring the property leaves both the named
 * import and the namespace on the stub. Asserting `layer.contains(menu)` would
 * therefore pass with the fix deleted. These tests pin the three source facts
 * that carry the fix plus the one precondition it rests on; only a real browser
 * can assert the paint order.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, before, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import mermaid from "mermaid";
import { ZoneTopologyTab } from "../src/components/dns/ZoneTopologyTab";
import type { DNSRecord } from "../src/types/dns";

const topologySource = readFileSync(
  new URL("../src/components/dns/ZoneTopologyTab.tsx", import.meta.url),
  "utf8",
);
const dropdownSource = readFileSync(
  new URL("../src/components/ui/DropdownMenu.tsx", import.meta.url),
  "utf8",
);

test("the shared menu forwards a portal container to the Radix portal", () => {
  // Without the passthrough the `container` prop would land in the Content's
  // DOM props and the menu would portal to `document.body` as before.
  assert.match(
    dropdownSource,
    /<DropdownMenuPrimitive\.Portal container=\{container\}>/,
  );
  assert.match(
    dropdownSource,
    /\{\s*className,\s*sideOffset = 4,\s*collisionPadding = 12,\s*container,\s*\.\.\.props\s*\}/,
  );
});

test("every full-window topology menu is hosted by the full-window layer", () => {
  const contents =
    topologySource.match(/<DropdownMenuContent[\s\S]*?>/gu) ?? [];
  assert.equal(
    contents.length,
    2,
    "the topology tab has a Copy and an Export menu; a new one needs the same container",
  );
  for (const content of contents) {
    assert.match(
      content,
      /container=\{forLightbox \? fullWindowLayer : null\}/,
    );
  }

  // The node has to arrive through state, not a ref. A ref assignment does not
  // re-render, so the menus would still be holding `null` -- and so portaling
  // to the body -- the first time one is opened after going full window.
  assert.match(
    topologySource,
    /const \[fullWindowLayer, setFullWindowLayer\] = useState<HTMLDivElement \| null>\(/,
  );
  assert.match(topologySource, /ref=\{setFullWindowLayer\}/);
});

test("the full-window layer does not clip the menus it hosts", () => {
  // Hosting only beats `z-index` while the host paints its children. The
  // `overflow-hidden` in full-window mode belongs on the inner viewport, which
  // the controls sit outside of; moving it up to the layer would trade an
  // out-stacked menu for a clipped one.
  const layer = /ref=\{setFullWindowLayer\}[\s\S]*?className="([^"]*)"/u.exec(
    topologySource,
  );
  assert.ok(layer, "the full-window layer must carry a literal class list");
  assert.doesNotMatch(layer[1]!, /\boverflow-hidden\b/);
  assert.match(layer[1]!, /\bfixed\b/);
  assert.match(layer[1]!, /\bz-\[\d+\]/);
});

const VIEWPORT_W = 800;
const VIEWPORT_H = 560;
const GRAPH_W = 2000;
const GRAPH_H = 400;

const originalFetch = globalThis.fetch;
const originalResizeObserver = (globalThis as { ResizeObserver?: unknown })
  .ResizeObserver;
const originalGetBoundingClientRect =
  HTMLElement.prototype.getBoundingClientRect;
const originalRender = mermaid.render;
const originalInitialize = mermaid.initialize;

type ResizeCallback = (entries: { contentRect: DOMRect }[]) => void;

function rectFor(element: Element): DOMRect {
  const isViewport =
    element.getAttribute("data-testid") === "topology-viewport";
  const width = isViewport ? VIEWPORT_W : 0;
  const height = isViewport ? VIEWPORT_H : 0;
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

class FakeResizeObserver {
  constructor(private readonly callback: ResizeCallback) {}
  observe(target: Element) {
    this.callback([{ contentRect: rectFor(target) }]);
  }
  unobserve() {}
  disconnect() {}
}

before(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    FakeResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return rectFor(this);
  };
  mermaid.initialize = () => {};
  mermaid.render = async () => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRAPH_W} ${GRAPH_H}"><g class="nodes"><rect x="0" y="0" width="10" height="10"></rect></g></svg>`,
    diagramType: "flowchart-v2",
  });
  globalThis.fetch = async () => {
    throw new Error("network disabled in full window menu layer test");
  };
});

afterEach(() => {
  cleanup();
});

process.on("exit", () => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    originalResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  mermaid.render = originalRender;
  mermaid.initialize = originalInitialize;
  globalThis.fetch = originalFetch;
});

function makeRecord(
  id: string,
  type: DNSRecord["type"],
  name: string,
  content: string,
): DNSRecord {
  const timestamp = new Date(0).toISOString();
  return {
    id,
    type,
    name,
    content,
    ttl: 300,
    proxied: false,
    zone_id: "zone-id",
    zone_name: "example.com",
    created_on: timestamp,
    modified_on: timestamp,
  };
}

const RECORDS: DNSRecord[] = [
  makeRecord("www", "A", "www.example.com", "192.0.2.10"),
  makeRecord("app", "CNAME", "app.example.com", "app.example.com.cdn.test"),
];

test("the full-window controls still open their menus with a container in play", async () => {
  render(
    React.createElement(ZoneTopologyTab, {
      zoneName: "example.com",
      records: RECORDS,
      disableServiceDiscovery: true,
      onRefresh: () => {},
    }),
  );
  await screen.findByTestId("topology-viewport", {}, { timeout: 10_000 });
  await waitFor(
    () => {
      assert.ok(document.querySelector(".topology-svg-wrapper svg"));
    },
    { timeout: 10_000 },
  );

  fireEvent.click(screen.getByRole("button", { name: /^Full window$/ }));
  const layer = await screen.findByTestId(
    "topology-full-window-layer",
    {},
    { timeout: 10_000 },
  );

  // Radix opens on keydown; a jsdom `click` never reaches its pointer path.
  fireEvent.keyDown(within(layer).getByRole("button", { name: /^Copy$/ }), {
    key: "Enter",
  });
  const item = await screen.findByRole(
    "menuitem",
    { hidden: true, name: /Copy Mermaid code/ },
    { timeout: 10_000 },
  );
  assert.ok(item.closest('[role="menu"]'), "the menu must be open");
});
