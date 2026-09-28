/**
 * The connection bar's latency readout.
 *
 * What is pinned here is the honest part: the hook reports a number only when
 * a real round trip came back, it stays silent and calm when one does not, it
 * refuses to touch the network without a credential or while the device says
 * it is offline, and it leaves no timer or in-flight request behind.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, render, screen } from "@testing-library/react";

import {
  DnsConnectionBar,
  describeCloudflareLatency,
} from "../src/components/dns/DnsConnectionBar";
import {
  classifyCloudflareLatency,
  useCloudflareLatency,
  CLOUDFLARE_LATENCY_FAIR_MAX_MS,
  CLOUDFLARE_LATENCY_GOOD_MAX_MS,
  type CloudflareLatencyProbeInput,
  type CloudflareLatencyState,
  type UseCloudflareLatencyOptions,
} from "../src/hooks/dns/use-cloudflare-latency";
import type { RuntimeResourceHost } from "../src/lib/runtime/resource-scope";
import i18n from "../src/i18n";

async function waitForI18nInitialization(): Promise<void> {
  if (i18n.isInitialized) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      i18n.off("initialized", onInitialized);
      reject(new Error("Timed out waiting for i18n initialization"));
    }, 5_000);
    const onInitialized = () => {
      clearTimeout(timeout);
      i18n.off("initialized", onInitialized);
      resolve();
    };
    i18n.on("initialized", onInitialized);
  });
}

beforeEach(async () => {
  await waitForI18nInitialization();
  await i18n.changeLanguage("en-US");
});

afterEach(() => {
  cleanup();
  restoreNavigatorOnline();
  restoreDocumentVisibility();
});

/** Timer host in the shape `test/resource-disposal.test.tsx` already uses. */
function createFakeRuntimeHost() {
  let nextId = 1;
  const timeouts = new Map<number, () => void>();
  const host: RuntimeResourceHost = {
    setTimeout(callback) {
      const id = nextId++;
      timeouts.set(id, callback as () => void);
      return id;
    },
    clearTimeout(id) {
      if (id !== undefined) timeouts.delete(id);
    },
    requestAnimationFrame() {
      return 0;
    },
    cancelAnimationFrame() {},
  };

  return {
    host,
    timeouts,
    /** Fire the oldest pending timer, the way the browser eventually would. */
    async runOldestTimeout(): Promise<void> {
      const entry = [...timeouts.entries()][0];
      assert.ok(entry, "expected a scheduled timer");
      const [id, callback] = entry;
      timeouts.delete(id);
      await act(async () => {
        callback();
      });
    },
  };
}

function createDeferredProbe() {
  const inputs: CloudflareLatencyProbeInput[] = [];
  let settle: {
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;

  const probe = (input: CloudflareLatencyProbeInput): Promise<void> => {
    inputs.push(input);
    return new Promise<void>((resolve, reject) => {
      settle = { resolve: () => resolve(), reject };
      input.signal.addEventListener(
        "abort",
        () => reject(new Error("probe aborted")),
        { once: true },
      );
    });
  };

  return {
    probe,
    inputs,
    async settleWith(outcome: "resolve" | "reject"): Promise<void> {
      const pending = settle;
      assert.ok(pending, "expected a probe to be in flight");
      settle = null;
      await act(async () => {
        if (outcome === "resolve") pending.resolve();
        else pending.reject(new Error("network unreachable"));
      });
    },
  };
}

function formatState(state: CloudflareLatencyState): string {
  return `${state.status}|${state.latencyMs ?? "none"}|${state.grade ?? "none"}`;
}

function LatencyHarness(options: UseCloudflareLatencyOptions) {
  const state = useCloudflareLatency(options);
  return <span data-testid="latency-state">{formatState(state)}</span>;
}

function readState(): string {
  return screen.getByTestId("latency-state").textContent ?? "";
}

function createStoppedClock(startMs = 0) {
  let value = startMs;
  return {
    now: () => value,
    advance(byMs: number) {
      value += byMs;
    },
  };
}

function setNavigatorOnline(online: boolean): void {
  Object.defineProperty(globalThis.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
}

function restoreNavigatorOnline(): void {
  delete (globalThis.navigator as unknown as Record<string, unknown>).onLine;
}

let documentVisibilityPatched = false;

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  documentVisibilityPatched = true;
}

function restoreDocumentVisibility(): void {
  if (!documentVisibilityPatched) return;
  delete (document as unknown as Record<string, unknown>).visibilityState;
  documentVisibilityPatched = false;
}

function captureConsoleNoise() {
  const messages: unknown[][] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    messages.push(args);
  };
  console.warn = (...args: unknown[]) => {
    messages.push(args);
  };
  return {
    messages,
    restore() {
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

test("a completed round trip is reported with its measured milliseconds", async () => {
  const fake = createFakeRuntimeHost();
  const deferred = createDeferredProbe();
  const clock = createStoppedClock();

  await act(async () => {
    render(
      <LatencyHarness
        apiKey="cf-token"
        email="owner@example.com"
        probe={deferred.probe}
        now={clock.now}
        host={fake.host}
      />,
    );
  });

  assert.equal(readState(), "measuring|none|none");
  assert.equal(deferred.inputs.length, 1);
  assert.equal(deferred.inputs[0]?.apiKey, "cf-token");
  assert.equal(deferred.inputs[0]?.email, "owner@example.com");

  clock.advance(142);
  await deferred.settleWith("resolve");

  assert.equal(readState(), "ready|142|good");
});

test("the next poll keeps the previous reading on screen until it lands", async () => {
  const fake = createFakeRuntimeHost();
  const deferred = createDeferredProbe();
  const clock = createStoppedClock();

  await act(async () => {
    render(
      <LatencyHarness
        apiKey="cf-token"
        probe={deferred.probe}
        now={clock.now}
        host={fake.host}
      />,
    );
  });
  clock.advance(120);
  await deferred.settleWith("resolve");
  assert.equal(readState(), "ready|120|good");
  assert.equal(deferred.inputs.length, 1);

  // Only the poll timer is outstanding once a probe has settled.
  await fake.runOldestTimeout();
  assert.equal(deferred.inputs.length, 2);
  assert.equal(readState(), "ready|120|good");

  clock.advance(950);
  await deferred.settleWith("resolve");
  assert.equal(readState(), "ready|950|poor");
});

test("thresholds bucket a round trip at their own boundaries", () => {
  assert.equal(classifyCloudflareLatency(0), "good");
  assert.equal(
    classifyCloudflareLatency(CLOUDFLARE_LATENCY_GOOD_MAX_MS),
    "good",
  );
  assert.equal(
    classifyCloudflareLatency(CLOUDFLARE_LATENCY_GOOD_MAX_MS + 1),
    "fair",
  );
  assert.equal(
    classifyCloudflareLatency(CLOUDFLARE_LATENCY_FAIR_MAX_MS),
    "fair",
  );
  assert.equal(
    classifyCloudflareLatency(CLOUDFLARE_LATENCY_FAIR_MAX_MS + 1),
    "poor",
  );
});

test("a failed probe reports no reading, silently", async () => {
  const fake = createFakeRuntimeHost();
  const deferred = createDeferredProbe();
  const noise = captureConsoleNoise();

  try {
    await act(async () => {
      render(
        <LatencyHarness
          apiKey="cf-token"
          probe={deferred.probe}
          host={fake.host}
        />,
      );
    });
    await deferred.settleWith("reject");

    assert.equal(readState(), "unavailable|none|none");
    assert.deepEqual(noise.messages, []);
  } finally {
    noise.restore();
  }
});

test("a probe that outruns the timeout is aborted and reported as no reading", async () => {
  const fake = createFakeRuntimeHost();
  const deferred = createDeferredProbe();

  await act(async () => {
    render(
      <LatencyHarness
        apiKey="cf-token"
        probe={deferred.probe}
        host={fake.host}
      />,
    );
  });

  // The only timer pending during a probe is its own deadline.
  assert.equal(fake.timeouts.size, 1);
  await fake.runOldestTimeout();

  assert.equal(deferred.inputs[0]?.signal.aborted, true);
  assert.equal(readState(), "unavailable|none|none");
});

test("without a credential nothing is measured and no timer is armed", async () => {
  const fake = createFakeRuntimeHost();
  const deferred = createDeferredProbe();

  await act(async () => {
    render(<LatencyHarness probe={deferred.probe} host={fake.host} />);
  });

  assert.equal(deferred.inputs.length, 0);
  assert.equal(fake.timeouts.size, 0);
  assert.equal(readState(), "disabled|none|none");
});

test("switching the hook off stops it measuring even with a credential", async () => {
  const fake = createFakeRuntimeHost();
  const deferred = createDeferredProbe();

  await act(async () => {
    render(
      <LatencyHarness
        apiKey="cf-token"
        enabled={false}
        probe={deferred.probe}
        host={fake.host}
      />,
    );
  });

  assert.equal(deferred.inputs.length, 0);
  assert.equal(fake.timeouts.size, 0);
  assert.equal(readState(), "disabled|none|none");
});

test("a device that reports itself offline is never probed", async () => {
  setNavigatorOnline(false);
  const fake = createFakeRuntimeHost();
  const deferred = createDeferredProbe();

  await act(async () => {
    render(
      <LatencyHarness
        apiKey="cf-token"
        probe={deferred.probe}
        host={fake.host}
      />,
    );
  });

  assert.equal(readState(), "offline|none|none");
  assert.equal(deferred.inputs.length, 0);

  // The fallback re-check must not turn into a probe either.
  await fake.runOldestTimeout();
  assert.equal(deferred.inputs.length, 0);
  assert.equal(readState(), "offline|none|none");
});

test("going offline aborts the probe in flight, and coming back re-measures", async () => {
  const fake = createFakeRuntimeHost();
  const deferred = createDeferredProbe();
  const clock = createStoppedClock();

  await act(async () => {
    render(
      <LatencyHarness
        apiKey="cf-token"
        probe={deferred.probe}
        now={clock.now}
        host={fake.host}
      />,
    );
  });
  assert.equal(deferred.inputs.length, 1);

  await act(async () => {
    // jsdom drops events built from Node's own global `Event` class, so the
    // connectivity events have to come from the document's own constructor.
    window.dispatchEvent(new window.Event("offline"));
  });
  assert.equal(deferred.inputs[0]?.signal.aborted, true);
  assert.equal(readState(), "offline|none|none");
  assert.equal(deferred.inputs.length, 1);

  await act(async () => {
    window.dispatchEvent(new window.Event("online"));
  });
  assert.equal(deferred.inputs.length, 2);

  clock.advance(88);
  await deferred.settleWith("resolve");
  assert.equal(readState(), "ready|88|good");
});

test("a hidden window costs nothing until it is looked at again", async () => {
  setDocumentHidden(true);
  const fake = createFakeRuntimeHost();
  const deferred = createDeferredProbe();
  const clock = createStoppedClock();

  await act(async () => {
    render(
      <LatencyHarness
        apiKey="cf-token"
        probe={deferred.probe}
        now={clock.now}
        host={fake.host}
      />,
    );
  });

  assert.equal(deferred.inputs.length, 0);
  // A hidden window still re-checks on the usual cadence, without a request.
  await fake.runOldestTimeout();
  assert.equal(deferred.inputs.length, 0);

  setDocumentHidden(false);
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  assert.equal(deferred.inputs.length, 1);

  clock.advance(410);
  await deferred.settleWith("resolve");
  assert.equal(readState(), "ready|410|fair");
});

test("unmounting aborts the request still in flight", async () => {
  const fake = createFakeRuntimeHost();
  const deferred = createDeferredProbe();

  let unmount = () => {};
  await act(async () => {
    const view = render(
      <LatencyHarness
        apiKey="cf-token"
        probe={deferred.probe}
        host={fake.host}
      />,
    );
    unmount = view.unmount;
  });

  assert.equal(deferred.inputs[0]?.signal.aborted, false);

  await act(async () => {
    unmount();
  });

  assert.equal(deferred.inputs[0]?.signal.aborted, true);
});

test("unmounting between polls leaves no timer behind", async () => {
  const fake = createFakeRuntimeHost();
  const deferred = createDeferredProbe();

  let unmount = () => {};
  await act(async () => {
    const view = render(
      <LatencyHarness
        apiKey="cf-token"
        probe={deferred.probe}
        host={fake.host}
      />,
    );
    unmount = view.unmount;
  });
  await deferred.settleWith("resolve");

  // A settled probe leaves the next poll armed: that timer is the one only
  // disposal can take back.
  assert.equal(fake.timeouts.size, 1);

  await act(async () => {
    unmount();
  });

  assert.equal(fake.timeouts.size, 0);
});

test("the connection bar shows no latency chip before it has credentials", () => {
  render(
    <DnsConnectionBar
      zoneSelector={<button type="button">Choose domain</button>}
      activeContext="example.com"
    />,
  );

  assert.ok(
    screen.getByRole("status", { name: "Session status: Authenticated" }),
  );
  // Compared as a boolean on purpose: handing a jsdom element to `assert.equal`
  // makes a failure spend minutes inspecting the DOM tree instead of reporting.
  assert.ok(
    screen.queryByTestId("cloudflare-latency") === null,
    "expected no latency chip without credentials",
  );
});

test("the connection bar stays calm when the real probe cannot even start", async () => {
  const noise = captureConsoleNoise();

  try {
    await act(async () => {
      render(
        <DnsConnectionBar
          zoneSelector={<button type="button">Choose domain</button>}
          activeContext="example.com"
          apiKey="cf-token"
        />,
      );
    });

    // No server API base is configured for the web build under test, so the
    // real probe cannot run at all. That must read as "no reading", not as an
    // error, and must not reach the console.
    const chip = screen.getByTestId("cloudflare-latency");
    assert.equal(
      chip.getAttribute("aria-label"),
      "Cloudflare API round trip: no reading",
    );
    assert.equal(chip.textContent, "—");
    assert.match(chip.className, /text-muted-foreground/);
    assert.deepEqual(noise.messages, []);
  } finally {
    noise.restore();
  }
});

test("every readout state describes itself in words, not colour", async () => {
  const t = i18n.t.bind(i18n);
  const describe = (state: CloudflareLatencyState, desktop: boolean) =>
    describeCloudflareLatency(state, t, { desktop });

  assert.equal(
    describe({ status: "disabled", latencyMs: null, grade: null }, false),
    null,
  );

  const ready = describe(
    { status: "ready", latencyMs: 142, grade: "good" },
    true,
  );
  assert.equal(ready?.value, "142 ms");
  assert.equal(ready?.ariaLabel, "Cloudflare API round trip: 142 ms (good)");
  assert.match(ready?.detail ?? "", /^Timed on one of this app's own/);
  assert.match(ready?.detail ?? "", /desktop app out to the Cloudflare API/);
  assert.match(ready?.detail ?? "", /not a network ping\.$/);
  assert.match(ready?.toneClassName ?? "", /emerald/);

  const slow = describe(
    { status: "ready", latencyMs: 950, grade: "poor" },
    false,
  );
  assert.equal(slow?.ariaLabel, "Cloudflare API round trip: 950 ms (poor)");
  assert.match(
    slow?.detail ?? "",
    /through the app's API server to Cloudflare/,
  );
  assert.match(slow?.toneClassName ?? "", /red/);

  const measuring = describe(
    { status: "measuring", latencyMs: null, grade: null },
    false,
  );
  assert.equal(measuring?.ariaLabel, "Cloudflare API round trip: measuring");
  assert.match(measuring?.detail ?? "", /^Measuring the round trip/);

  const offline = describe(
    { status: "offline", latencyMs: null, grade: null },
    false,
  );
  assert.equal(
    offline?.ariaLabel,
    "Cloudflare API round trip: this device is offline",
  );
  assert.match(offline?.detail ?? "", /reports no network connection/);
  assert.match(offline?.toneClassName ?? "", /text-muted-foreground/);

  const unavailable = describe(
    { status: "unavailable", latencyMs: null, grade: null },
    false,
  );
  assert.equal(unavailable?.ariaLabel, "Cloudflare API round trip: no reading");
  assert.match(unavailable?.detail ?? "", /^The last check did not finish/);
});
