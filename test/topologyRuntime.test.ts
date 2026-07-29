import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  TOPOLOGY_GRAPH_DOM_EDGE_LIMIT,
  TOPOLOGY_GRAPH_DOM_NODE_LIMIT,
  TOPOLOGY_MODEL_NODE_LIMIT,
  TOPOLOGY_RESULT_PAGE_SIZE,
  ZoneTopologyTab,
} from "../src/components/dns/ZoneTopologyTab";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";
import type { DNSRecord } from "../src/types/dns";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const originalFetch = globalThis.fetch;
const {
  buildTopologyGraphModelProgressively,
  copyTopologyText,
  filterTopologyModelNodes,
  runTopologyRefresh,
  yieldTopologyConstruction,
} = ZoneTopologyTab;

afterEach(() => {
  cleanup();
  resetRuntimeReportingForTests();
  globalThis.fetch = originalFetch;
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

function topologyRecord(
  index: number,
  type: DNSRecord["type"] = "A",
): DNSRecord {
  const timestamp = new Date(index * 1000).toISOString();
  const content =
    type === "A"
      ? `192.0.2.${index % 255}`
      : type === "AAAA"
        ? `2001:db8::${index.toString(16)}`
        : "target.external.example.net";
  return {
    id: `record-${index}`,
    type,
    name: `host-${index}.example.com`,
    content,
    ttl: 300,
    proxied: false,
    zone_id: "zone-id",
    zone_name: "example.com",
    created_on: timestamp,
    modified_on: timestamp,
  };
}

function topologyRecords(
  count: number,
  lastType: DNSRecord["type"] = "A",
): DNSRecord[] {
  return Array.from({ length: count }, (_, index) =>
    topologyRecord(index, index === count - 1 ? lastType : "A"),
  );
}

function renderTopology(
  records: DNSRecord[],
  modelYieldControl?: (signal?: AbortSignal) => Promise<void>,
) {
  return render(
    React.createElement(ZoneTopologyTab, {
      zoneName: "example.com",
      records,
      disableServiceDiscovery: true,
      modelYieldControl,
      onRefresh: () => {},
    }),
  );
}

test("preserves the complete 39-record fixture in the graph model and UI", async () => {
  const records = topologyRecords(39);
  const model = await buildTopologyGraphModelProgressively(records);

  assert.equal(model.status, "ready");
  if (model.status !== "ready") return;
  assert.strictEqual(model.sourceRecords, records);
  assert.equal(model.nodes.length, 39);
  assert.deepEqual(
    model.nodes.map((node) => node.recordId),
    records.map((record) => record.id),
  );

  renderTopology(records);
  await waitFor(() =>
    assert.match(
      screen.getByTestId("topology-model-count").textContent ?? "",
      /all 39 matching nodes.*39 source records/,
    ),
  );
  assert.equal(screen.getAllByTestId("topology-graph-node").length, 39);
  assert.equal(screen.queryByTestId("topology-model-refusal"), null);
});

test("builds all 10,000 model nodes progressively and finds a node near the end", async () => {
  const records = topologyRecords(TOPOLOGY_MODEL_NODE_LIMIT, "AAAA");
  let yieldCount = 0;
  const progress: number[] = [];

  const model = await buildTopologyGraphModelProgressively(records, {
    chunkSize: 250,
    yieldControl: async () => {
      yieldCount += 1;
    },
    onProgress: (completed) => progress.push(completed),
  });

  assert.equal(model.status, "ready");
  if (model.status !== "ready") return;
  assert.strictEqual(model.sourceRecords, records);
  assert.equal(model.nodes.length, TOPOLOGY_MODEL_NODE_LIMIT);
  assert.equal(model.nodes.at(-1)?.recordId, "record-9999");
  assert.equal(progress.at(-1), TOPOLOGY_MODEL_NODE_LIMIT);
  assert.equal(progress.length, 40);
  assert.equal(yieldCount, 78);
  assert.deepEqual(
    filterTopologyModelNodes(model.nodes, "host-9999", "AAAA").map(
      (node) => node.recordId,
    ),
    ["record-9999"],
  );
  assert.equal(
    filterTopologyModelNodes(model.nodes, "", "A").length,
    TOPOLOGY_MODEL_NODE_LIMIT - 1,
  );
});

test("searches, filters, clears, keyboard-selects, and focuses any node in a 10,000-node model", async () => {
  const records = topologyRecords(TOPOLOGY_MODEL_NODE_LIMIT, "AAAA");
  renderTopology(records, async () => {});

  await waitFor(
    () =>
      assert.match(
        screen.getByTestId("topology-model-count").textContent ?? "",
        /all 10000 matching nodes/,
      ),
    { timeout: 10_000 },
  );
  assert.ok(
    screen.getAllByTestId("topology-graph-node").length <=
      TOPOLOGY_GRAPH_DOM_NODE_LIMIT,
  );
  assert.ok(
    screen.queryAllByTestId("topology-graph-edge").length <=
      TOPOLOGY_GRAPH_DOM_EDGE_LIMIT,
  );
  assert.ok(
    screen.getAllByTestId("topology-result-select").length <=
      TOPOLOGY_RESULT_PAGE_SIZE,
  );
  fireEvent.change(screen.getByLabelText("Filter topology record type"), {
    target: { value: "AAAA" },
  });
  await waitFor(() =>
    assert.match(
      screen.getByTestId("topology-result-count").textContent ?? "",
      /^1 matching node/,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await waitFor(() =>
    assert.match(
      screen.getByTestId("topology-result-count").textContent ?? "",
      /^10000 matching nodes/,
    ),
  );
  fireEvent.change(screen.getByLabelText("Search topology nodes"), {
    target: { value: "host-9999" },
  });
  await waitFor(() =>
    assert.match(
      screen.getByTestId("topology-result-count").textContent ?? "",
      /^1 matching node/,
    ),
  );
  const result = screen.getByTestId("topology-result-select");
  result.focus();
  fireEvent.keyDown(result, { key: "Enter" });

  await waitFor(() => {
    const revealed = document.getElementById("topology-model-node-9999");
    assert.ok(revealed);
    assert.equal(
      (document.activeElement as HTMLElement | null)?.id,
      "topology-model-node-9999",
    );
    assert.equal(revealed.getAttribute("aria-pressed"), "true");
  });
  assert.ok(
    screen.getAllByTestId("topology-graph-node").length <=
      TOPOLOGY_GRAPH_DOM_NODE_LIMIT,
  );
});

test("refuses more than 10,000 nodes until explicit filters narrow the source", async () => {
  const records = topologyRecords(TOPOLOGY_MODEL_NODE_LIMIT + 1);
  renderTopology(records, async () => {});

  await waitFor(() =>
    assert.match(
      screen.getByTestId("topology-model-refusal").textContent ?? "",
      /no graph nodes were constructed or silently omitted/i,
    ),
  );
  assert.equal(screen.queryAllByTestId("topology-graph-node").length, 0);

  fireEvent.change(screen.getByLabelText("Search topology nodes"), {
    target: { value: "host-10000" },
  });
  await waitFor(() =>
    assert.match(
      screen.getByTestId("topology-model-count").textContent ?? "",
      /all 1 matching nodes.*complete 10001-record source remains unchanged/,
    ),
  );
  assert.equal(screen.getAllByTestId("topology-graph-node").length, 1);

  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await waitFor(() => assert.ok(screen.getByTestId("topology-model-refusal")));
  assert.equal(screen.queryAllByTestId("topology-graph-node").length, 0);
});

test("aborts superseded progressive model work and only commits the latest model", async () => {
  const supersededRecords = topologyRecords(1_000);
  const replacementRecords = topologyRecords(39);
  let firstSignal: AbortSignal | undefined;
  let signalReady!: () => void;
  const started = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const yieldControl = (signal?: AbortSignal) => {
    if (firstSignal) return Promise.resolve();
    firstSignal = signal;
    signalReady();
    return new Promise<void>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  };

  const view = renderTopology(supersededRecords, yieldControl);
  await started;
  view.rerender(
    React.createElement(ZoneTopologyTab, {
      zoneName: "example.com",
      records: replacementRecords,
      disableServiceDiscovery: true,
      modelYieldControl: yieldControl,
      onRefresh: () => {},
    }),
  );

  await waitFor(() =>
    assert.match(
      screen.getByTestId("topology-model-count").textContent ?? "",
      /all 39 matching nodes/,
    ),
  );
  assert.equal(firstSignal?.aborted, true);
  assert.doesNotMatch(
    screen.getByTestId("topology-model-count").textContent ?? "",
    /1000/,
  );
});

test("cancels idle and timer yields without returning a partial model", async () => {
  const browserWindow = window as Window & {
    requestIdleCallback?: (callback: () => void) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  const originalRequestIdle = browserWindow.requestIdleCallback;
  const originalCancelIdle = browserWindow.cancelIdleCallback;
  let cancelledIdleId: number | undefined;
  browserWindow.requestIdleCallback = () => 73;
  browserWindow.cancelIdleCallback = (id) => {
    cancelledIdleId = id;
  };

  const idleController = new AbortController();
  const idleYield = yieldTopologyConstruction(idleController.signal);
  idleController.abort();
  await assert.rejects(
    idleYield,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(cancelledIdleId, 73);

  delete browserWindow.requestIdleCallback;
  delete browserWindow.cancelIdleCallback;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let clearedTimer: ReturnType<typeof setTimeout> | undefined;
  globalThis.setTimeout = ((callback: () => void) => {
    void callback;
    return 91 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    clearedTimer = id;
  }) as typeof clearTimeout;

  try {
    const timerController = new AbortController();
    const timerYield = yieldTopologyConstruction(timerController.signal);
    timerController.abort();
    await assert.rejects(
      timerYield,
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(clearedTimer, 91);

    const buildController = new AbortController();
    const build = buildTopologyGraphModelProgressively(topologyRecords(1_000), {
      signal: buildController.signal,
      yieldControl: async (signal) => {
        buildController.abort();
        if (signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
      },
    });
    await assert.rejects(
      build,
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    browserWindow.requestIdleCallback = originalRequestIdle;
    browserWindow.cancelIdleCallback = originalCancelIdle;
  }
});

test("cancels pending focus frames and full-window listeners on unmount", async () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalAddEventListener = window.addEventListener.bind(window);
  const originalRemoveEventListener = window.removeEventListener.bind(window);
  let cancelledFrame: number | undefined;
  const addedKeyListeners: EventListenerOrEventListenerObject[] = [];
  const removedKeyListeners: EventListenerOrEventListenerObject[] = [];

  globalThis.requestAnimationFrame = (() => 47) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    cancelledFrame = id;
  }) as typeof cancelAnimationFrame;
  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "keydown") addedKeyListeners.push(listener);
    originalAddEventListener(type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === "keydown") removedKeyListeners.push(listener);
    originalRemoveEventListener(type, listener, options);
  }) as typeof window.removeEventListener;

  try {
    const view = renderTopology(topologyRecords(39));
    await waitFor(() => assert.ok(screen.getByTitle("Expand to full window")));
    fireEvent.change(screen.getByLabelText("Search topology nodes"), {
      target: { value: "host-38" },
    });
    await waitFor(() =>
      assert.equal(screen.getAllByTestId("topology-result-select").length, 1),
    );
    fireEvent.keyDown(screen.getByTestId("topology-result-select"), {
      key: "Enter",
    });
    fireEvent.click(screen.getByTitle("Expand to full window"));
    await waitFor(() => assert.ok(addedKeyListeners.length > 0));
    view.unmount();

    assert.equal(cancelledFrame, 47);
    assert.ok(
      addedKeyListeners.some((listener) =>
        removedKeyListeners.includes(listener),
      ),
    );
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    window.addEventListener =
      originalAddEventListener as typeof window.addEventListener;
    window.removeEventListener =
      originalRemoveEventListener as typeof window.removeEventListener;
  }
});

test("aborts in-flight browser topology lookups when unmounted", async () => {
  let lookupSignal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      lookupSignal = init?.signal ?? undefined;
      if (lookupSignal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      lookupSignal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });

  const view = render(
    React.createElement(ZoneTopologyTab, {
      zoneName: "example.com",
      records: [topologyRecord(1, "CNAME")],
      resolverMode: "doh",
      disableServiceDiscovery: true,
      onRefresh: () => {},
    }),
  );
  await waitFor(() => assert.ok(lookupSignal), { timeout: 10_000 });
  view.unmount();
  assert.equal(lookupSignal?.aborted, true);
});

test("topology refresh rejection is contained and reported", async () => {
  const result = await runTopologyRefresh(async () => {
    throw new Error("refresh failed token=topology-secret");
  });

  assert.equal(result, false);
  assert.match(getRuntimeDiagnostics()[0]?.label ?? "", /Refresh DNS topology/);
  assert.doesNotMatch(
    getRuntimeDiagnostics()[0]?.message ?? "",
    /topology-secret/,
  );
});

test("clipboard rejection returns a graceful failure without escaping", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        throw new DOMException("clipboard blocked", "NotAllowedError");
      },
    },
  });

  assert.equal(
    await copyTopologyText("safe text", "Copy test topology"),
    false,
  );
  assert.match(getRuntimeDiagnostics()[0]?.label ?? "", /Copy test topology/);
});
