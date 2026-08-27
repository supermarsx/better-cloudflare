import assert from "node:assert/strict";
import React from "react";
import { afterEach, before, test } from "node:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import mermaid from "mermaid";
import { ZoneTopologyTab } from "../src/components/dns/ZoneTopologyTab";
import type { DNSRecord } from "../src/types/dns";

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
  // Mermaid cannot lay out in jsdom; substitute a deterministic SVG whose
  // viewBox is wider than the viewport so a real fit scale (< 1) is required.
  mermaid.initialize = () => {};
  mermaid.render = async () => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRAPH_W} ${GRAPH_H}"><g class="nodes"><rect x="0" y="0" width="10" height="10"></rect></g></svg>`,
    diagramType: "flowchart-v2",
  });
  globalThis.fetch = async () => {
    throw new Error("network disabled in viewport test");
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

function record(index: number): DNSRecord {
  const timestamp = new Date(index * 1000).toISOString();
  return {
    id: `record-${index}`,
    type: "A",
    name: `host-${index}.example.com`,
    content: `192.0.2.${index + 1}`,
    ttl: 300,
    proxied: false,
    zone_id: "zone-id",
    zone_name: "example.com",
    created_on: timestamp,
    modified_on: timestamp,
  };
}

function parseTransform(transform: string) {
  const match =
    /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\((-?[\d.]+)\)/.exec(
      transform,
    );
  assert.ok(match, `unexpected transform: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

test("panel viewport that mounts after records resolve auto-fits and centres the graph", async () => {
  render(
    React.createElement(ZoneTopologyTab, {
      zoneName: "example.com",
      records: [record(1), record(2), record(3)],
      disableServiceDiscovery: true,
      onRefresh: () => {},
    }),
  );

  // The viewport is only mounted once the topology model resolves, i.e. after
  // the component's first effects ran — the regression this test guards.
  const viewport = await screen.findByTestId(
    "topology-viewport",
    {},
    { timeout: 10_000 },
  );
  assert.ok(viewport);

  await waitFor(
    () => {
      assert.ok(document.querySelector(".topology-svg-wrapper svg"));
    },
    { timeout: 10_000 },
  );

  const svg = document.querySelector(".topology-svg-wrapper svg");
  assert.equal(svg?.getAttribute("width"), String(GRAPH_W));
  assert.equal(svg?.getAttribute("height"), String(GRAPH_H));

  const canvas = screen.getByTestId("topology-canvas") as HTMLElement;
  await waitFor(
    () => {
      assert.notEqual(
        canvas.style.transform,
        "translate3d(0px, 0px, 0) scale(1)",
      );
    },
    { timeout: 10_000 },
  );

  const { x, y, scale } = parseTransform(canvas.style.transform);
  assert.ok(scale < 1, `expected a fitted scale below 1, got ${scale}`);
  assert.ok(
    GRAPH_W * scale <= VIEWPORT_W && GRAPH_H * scale <= VIEWPORT_H,
    "fitted graph must be inside the viewport",
  );
  const centreX = x + (GRAPH_W * scale) / 2;
  const centreY = y + (GRAPH_H * scale) / 2;
  assert.ok(
    Math.abs(centreX - VIEWPORT_W / 2) <= 2,
    `graph not horizontally centred: ${centreX}`,
  );
  assert.ok(
    Math.abs(centreY - VIEWPORT_H / 2) <= 2,
    `graph not vertically centred: ${centreY}`,
  );
});
