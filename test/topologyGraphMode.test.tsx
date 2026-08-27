import assert from "node:assert/strict";
import React from "react";
import { afterEach, before, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import mermaid from "mermaid";
import { ZoneTopologyTab } from "../src/components/dns/ZoneTopologyTab";
import {
  EMAIL_TOPOLOGY_EMPTY_MESSAGE,
  EMAIL_TOPOLOGY_GROUPS,
} from "../src/components/dns/topologyGraphBuilders";
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
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

const renderedCodes: string[] = [];
const clipboardWrites: string[] = [];

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
  mermaid.render = async (_id: string, code: string) => {
    renderedCodes.push(code);
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRAPH_W} ${GRAPH_H}"><g class="nodes"><rect x="0" y="0" width="10" height="10"></rect></g></svg>`,
      diagramType: "flowchart-v2",
    };
  };
  globalThis.fetch = async () => {
    throw new Error("network disabled in graph mode test");
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboardWrites.push(text);
      },
    },
  });
});

afterEach(() => {
  cleanup();
  renderedCodes.length = 0;
  clipboardWrites.length = 0;
});

process.on("exit", () => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    originalResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  mermaid.render = originalRender;
  mermaid.initialize = originalInitialize;
  globalThis.fetch = originalFetch;
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

function makeRecord(
  id: string,
  type: DNSRecord["type"],
  name: string,
  content: string,
  extra: Partial<DNSRecord> = {},
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
    ...extra,
  };
}

const EMAIL_RECORDS: DNSRecord[] = [
  makeRecord("www", "A", "www.example.com", "192.0.2.10"),
  makeRecord("mx", "MX", "example.com", "mail.example.com", { priority: 10 }),
  makeRecord("mail", "A", "mail.example.com", "192.0.2.25"),
  makeRecord(
    "spf",
    "TXT",
    "example.com",
    '"v=spf1 include:_spf.example.net -all"',
  ),
  makeRecord(
    "dmarc",
    "TXT",
    "_dmarc.example.com",
    '"v=DMARC1; p=reject; rua=mailto:dmarc@example.com"',
  ),
  makeRecord(
    "dkim",
    "CNAME",
    "s1._domainkey.example.com",
    "s1.dkim.mailrelay.test",
  ),
];

const WEB_ONLY_RECORDS: DNSRecord[] = [
  makeRecord("www", "A", "www.example.com", "192.0.2.10"),
  makeRecord("app", "CNAME", "app.example.com", "app.example.com.cdn.test"),
];

function parseTransform(transform: string) {
  const match =
    /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\((-?[\d.]+)\)/.exec(
      transform,
    );
  assert.ok(match, `unexpected transform: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

function renderTab(records: DNSRecord[]) {
  return render(
    React.createElement(ZoneTopologyTab, {
      zoneName: "example.com",
      records,
      disableServiceDiscovery: true,
      onRefresh: () => {},
    }),
  );
}

async function waitForSvg() {
  await waitFor(
    () => {
      assert.ok(document.querySelector(".topology-svg-wrapper svg"));
    },
    { timeout: 10_000 },
  );
}

async function waitForFittedTransform(canvas: HTMLElement) {
  await waitFor(
    () => {
      assert.notEqual(
        canvas.style.transform,
        "translate3d(0px, 0px, 0) scale(1)",
      );
    },
    { timeout: 10_000 },
  );
  return canvas.style.transform;
}

async function copyMermaidViaMenu(): Promise<string> {
  const before = clipboardWrites.length;
  fireEvent.keyDown(screen.getByRole("button", { name: /^Copy$/ }), {
    key: "Enter",
  });
  const item = await screen.findByRole("menuitem", {
    hidden: true,
    name: /Copy Mermaid code/,
  });
  fireEvent.click(item);
  await waitFor(() => assert.ok(clipboardWrites.length > before), {
    timeout: 10_000,
  });
  return clipboardWrites[clipboardWrites.length - 1] ?? "";
}

test("renders Full / Email / Services graph tabs with Full selected", async () => {
  renderTab(EMAIL_RECORDS);
  await screen.findByTestId("topology-viewport", {}, { timeout: 10_000 });

  const tablist = screen.getByRole("tablist", { name: "Topology graphs" });
  assert.equal(tablist.getAttribute("data-testid"), "topology-graph-mode");
  const tabs = ["full", "email", "services"].map((mode) =>
    screen.getByTestId(`topology-graph-mode-${mode}`),
  );
  assert.deepEqual(
    tabs.map((tab) => tab.textContent),
    ["Full", "Email", "Services"],
  );
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute("aria-selected")),
    ["true", "false", "false"],
  );
  assert.equal(
    screen.getByTestId("topology-graph-title").textContent,
    "Full DNS graph",
  );

  // Arrow keys move the selection like the zone action tabs.
  fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
  await waitFor(() =>
    assert.equal(tabs[1]!.getAttribute("aria-selected"), "true"),
  );
  fireEvent.keyDown(tabs[1]!, { key: "End" });
  await waitFor(() =>
    assert.equal(tabs[2]!.getAttribute("aria-selected"), "true"),
  );
  assert.equal(
    screen.getByTestId("topology-graph-title").textContent,
    "Services graph",
  );
});

test("switching to Email changes the generated Mermaid code (Copy Mermaid)", async () => {
  renderTab(EMAIL_RECORDS);
  await screen.findByTestId("topology-viewport", {}, { timeout: 10_000 });
  await waitForSvg();

  const fullCode = await copyMermaidViaMenu();
  assert.match(fullCode, /^flowchart LR/);
  assert.match(fullCode, /subgraph area_/);

  fireEvent.click(screen.getByTestId("topology-graph-mode-email"));
  await waitFor(
    () => {
      const last = renderedCodes[renderedCodes.length - 1] ?? "";
      assert.match(last, /subgraph inbound\[/);
    },
    { timeout: 10_000 },
  );

  const emailCode = await copyMermaidViaMenu();
  assert.notEqual(emailCode, fullCode);
  assert.match(emailCode, /^flowchart LR/);
  assert.match(
    emailCode,
    new RegExp(`subgraph inbound\\["${EMAIL_TOPOLOGY_GROUPS.inbound}`),
  );
  assert.match(emailCode, /mail\.example\.com/);
  assert.doesNotMatch(emailCode, /subgraph area_/);
  assert.doesNotMatch(emailCode, /www\.example\.com/);
  assert.equal(
    screen.getByTestId("topology-graph-title").textContent,
    "Email graph",
  );
});

test("Email mode shows the empty state for a zone without email records", async () => {
  renderTab(WEB_ONLY_RECORDS);
  await screen.findByTestId("topology-viewport", {}, { timeout: 10_000 });
  await waitForSvg();

  fireEvent.click(screen.getByTestId("topology-graph-mode-email"));
  const empty = await screen.findByTestId(
    "topology-graph-empty",
    {},
    { timeout: 10_000 },
  );
  assert.equal(empty.textContent, EMAIL_TOPOLOGY_EMPTY_MESSAGE);
  assert.equal(document.querySelector(".topology-svg-wrapper svg"), null);

  fireEvent.click(screen.getByTestId("topology-graph-mode-services"));
  await waitForSvg();
  assert.equal(screen.queryByTestId("topology-graph-empty"), null);
});

test("changing the graph mode resets the view to the fitted transform", async () => {
  renderTab(EMAIL_RECORDS);
  await screen.findByTestId("topology-viewport", {}, { timeout: 10_000 });
  await waitForSvg();

  const canvas = screen.getByTestId("topology-canvas") as HTMLElement;
  const fitted = await waitForFittedTransform(canvas);
  const fittedScale = parseTransform(fitted).scale;
  assert.ok(fittedScale < 1);

  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await waitFor(() => assert.notEqual(canvas.style.transform, fitted), {
    timeout: 10_000,
  });
  assert.ok(parseTransform(canvas.style.transform).scale > fittedScale);

  fireEvent.click(screen.getByTestId("topology-graph-mode-email"));
  await waitFor(() => assert.equal(canvas.style.transform, fitted), {
    timeout: 10_000,
  });
});
