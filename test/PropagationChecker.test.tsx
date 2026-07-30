import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  normalizePropagationResult,
  PROPAGATION_LIMITS,
  PropagationChecker,
} from "../src/components/dns/PropagationChecker";
import { utf8ByteLengthUpTo } from "../src/components/dns/rendererSafety";

afterEach(() => {
  cleanup();
});

function nativeResult(domain: string, answers: string[] = ["203.0.113.10"]) {
  return {
    domain,
    record_type: "A",
    results: [
      {
        resolver: "1.1.1.1",
        resolver_label: "Cloudflare",
        answers,
        rcode: "NOERROR",
        latency_ms: 12,
        error: null,
      },
    ],
    consistent: true,
  };
}

function renderChecker(
  checkDnsPropagation: (
    domain: string,
    recordType: string,
    extraResolvers?: string[],
    signal?: AbortSignal,
  ) => Promise<unknown>,
) {
  return render(
    <PropagationChecker
      zoneName="example.com"
      checkDnsPropagation={checkDnsPropagation}
    />,
  );
}

async function clickCheck(): Promise<void> {
  const button = await screen.findByRole("button", { name: "Check" });
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
}

test("normalizes and renders the populated native propagation response", async () => {
  renderChecker(async () => nativeResult("example.com"));

  await clickCheck();

  assert.ok(await screen.findByText("203.0.113.10"));
  assert.ok(screen.getByText("Cloudflare"));
  assert.match(screen.getByText(/resolvers/).textContent ?? "", /1 resolvers/);
  assert.equal(screen.queryByRole("alert"), null);
});

test("rejects undefined and null lookup responses with actionable diagnostics", async () => {
  for (const value of [undefined, null]) {
    assert.throws(
      () =>
        normalizePropagationResult(value, {
          domain: "example.com",
          recordType: "A",
        }),
      /returned no usable response/,
    );
  }

  renderChecker(async () => undefined);
  await clickCheck();

  assert.ok(await screen.findByRole("alert"));
  assert.match(
    screen.getByRole("alert").textContent ?? "",
    /returned no usable response/,
  );
  assert.ok(screen.getByRole("button", { name: "Retry" }));
});

test("normalizes missing nested record arrays without crashing", async () => {
  renderChecker(async () => ({
    domain: "example.com",
    record_type: "A",
    results: [
      {
        resolver: "8.8.8.8",
        resolver_label: "Google",
        rcode: "NOERROR",
        latency_ms: 20,
      },
    ],
    consistent: false,
  }));

  await clickCheck();

  assert.ok(await screen.findByText("No records"));
  assert.match(
    screen.getByTestId("propagation-response-warning").textContent ?? "",
    /omitted its records array/,
  );
});

test("renders an empty successful lookup with an explicit retry affordance", async () => {
  renderChecker(async () => ({
    domain: "example.com",
    record_type: "A",
    results: [],
    consistent: false,
  }));

  await clickCheck();

  assert.ok(await screen.findByText("No resolver results were returned."));
  assert.match(screen.getByText(/resolvers/).textContent ?? "", /0 resolvers/);
  assert.ok(screen.getByRole("button", { name: "Retry" }));
});

test("preserves valid rows from a partial provider response", async () => {
  renderChecker(async () => ({
    domain: "example.com",
    record_type: "A",
    results: [
      {
        resolver: "9.9.9.9",
        resolver_label: "Quad9",
        answers: ["198.51.100.8", { invalid: true }],
        rcode: "NOERROR",
        latency_ms: 17,
      },
      null,
    ],
    consistent: false,
  }));

  await clickCheck();

  assert.ok(await screen.findByText("198.51.100.8"));
  assert.ok(screen.getByText("Malformed resolver response"));
  const warning = screen.getByTestId("propagation-response-warning");
  assert.match(warning.textContent ?? "", /invalid record values/);
  assert.match(warning.textContent ?? "", /invalid response entry/);
});

test("preserves rejected lookup diagnostics and allows an explicit retry", async () => {
  let calls = 0;
  renderChecker(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("resolver service unavailable");
    }
    return nativeResult("example.com");
  });

  await clickCheck();

  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /resolver service unavailable/);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await Promise.resolve();
  });
  assert.ok(await screen.findByText("203.0.113.10"));
  assert.equal(calls, 2);
});

test("aborts superseded lookups and ignores stale results", async () => {
  const calls: Array<{
    domain: string;
    signal: AbortSignal | undefined;
    resolve: (value: unknown) => void;
  }> = [];
  const checkDnsPropagation = (
    domain: string,
    _recordType: string,
    _extraResolvers?: string[],
    signal?: AbortSignal,
  ) =>
    new Promise<unknown>((resolve) => {
      calls.push({ domain, signal, resolve });
    });

  renderChecker(checkDnsPropagation);
  const domainInput = screen.getByPlaceholderText("example.com");

  await clickCheck();
  await waitFor(() => assert.equal(calls.length, 1));

  fireEvent.change(domainInput, { target: { value: "new.example.com" } });
  fireEvent.keyDown(domainInput, { key: "Enter" });
  await waitFor(() => assert.equal(calls.length, 2));
  assert.equal(calls[0]?.signal?.aborted, true);

  await act(async () => {
    calls[1]?.resolve(nativeResult("new.example.com", ["192.0.2.20"]));
  });
  assert.ok(await screen.findByText("192.0.2.20"));

  await act(async () => {
    calls[0]?.resolve(nativeResult("example.com", ["192.0.2.10"]));
  });
  assert.equal(screen.queryByText("192.0.2.10"), null);
  assert.ok(screen.getByText("192.0.2.20"));
});

test("aborts the active lookup when the checker unmounts", async () => {
  let signal: AbortSignal | undefined;
  const view = renderChecker(
    (_domain, _recordType, _extraResolvers, currentSignal?: AbortSignal) => {
      signal = currentSignal;
      return new Promise<unknown>(() => undefined);
    },
  );

  await clickCheck();
  await waitFor(() => assert.ok(signal));
  view.unmount();

  assert.equal(signal?.aborted, true);
});

test("bounds 100,000 resolver and answer entries before retention and rendering", async () => {
  const sharedAnswers = Array.from(
    { length: 100_000 },
    (_, index) => `192.0.2.${index % 255}`,
  );
  const sharedResolver = {
    resolver: "1.1.1.1",
    resolver_label: "Cloudflare",
    answers: sharedAnswers,
    rcode: "NOERROR",
    latency_ms: 12,
  };
  const raw = {
    domain: "example.com",
    record_type: "A",
    results: Array.from({ length: 100_000 }, () => sharedResolver),
    consistent: false,
  };
  const normalized = normalizePropagationResult(raw, {
    domain: "example.com",
    recordType: "A",
  });
  assert.equal(normalized.resolvers.length, PROPAGATION_LIMITS.resolvers);
  assert.ok(
    normalized.resolvers.every(
      (resolver) =>
        resolver.records.length <= PROPAGATION_LIMITS.answersPerResolver,
    ),
  );
  assert.ok(normalized.warnings.length <= PROPAGATION_LIMITS.warnings);
  assert.match(
    normalized.warnings.join(" "),
    /resolver entries were not retained/i,
  );
  assert.match(
    normalized.warnings.join(" "),
    /only the first 50 were retained/i,
  );

  renderChecker(async () => raw);
  await clickCheck();
  await waitFor(() =>
    assert.equal(
      screen.getAllByTestId("propagation-resolver-row").length,
      PROPAGATION_LIMITS.renderedResolvers,
    ),
  );
  assert.equal(
    screen.getAllByTestId("propagation-answer").length,
    PROPAGATION_LIMITS.renderedResolvers *
      PROPAGATION_LIMITS.renderedAnswersPerResolver,
  );
  assert.match(
    screen.getByTestId("propagation-render-limit").textContent ?? "",
    /Showing the first 100 of 200 retained resolver rows/i,
  );
});

test("bounds multi-megabyte propagation strings and renders hostile markup as text", async () => {
  const hugeHostile =
    `<script>alert(1)</script><img src=x onerror=alert(2)>` +
    "😀".repeat(1_000_000);
  const raw = {
    domain: hugeHostile,
    record_type: hugeHostile,
    results: [
      {
        resolver: hugeHostile,
        resolver_label: hugeHostile,
        answers: [hugeHostile],
        rcode: hugeHostile,
        latency_ms: 1,
        error: hugeHostile,
      },
    ],
    consistent: false,
    timestamp: hugeHostile,
  };
  const normalized = normalizePropagationResult(raw, {
    domain: "example.com",
    recordType: "A",
  });
  const resolver = normalized.resolvers[0];
  assert.ok(
    utf8ByteLengthUpTo(normalized.domain) <= PROPAGATION_LIMITS.identityBytes,
  );
  assert.ok(
    utf8ByteLengthUpTo(resolver.label) <= PROPAGATION_LIMITS.identityBytes,
  );
  assert.ok(
    utf8ByteLengthUpTo(resolver.records[0]) <= PROPAGATION_LIMITS.stringBytes,
  );
  assert.ok(
    utf8ByteLengthUpTo(resolver.error ?? "") <= PROPAGATION_LIMITS.stringBytes,
  );
  assert.match(normalized.warnings.join(" "), /oversized.*truncated/i);

  const aggregateAnswer = "x".repeat(PROPAGATION_LIMITS.stringBytes);
  const aggregateBounded = normalizePropagationResult(
    {
      results: Array.from({ length: PROPAGATION_LIMITS.resolvers }, () => ({
        resolver: "resolver",
        resolver_label: "label",
        answers: Array.from(
          { length: PROPAGATION_LIMITS.answersPerResolver },
          () => aggregateAnswer,
        ),
        rcode: "NOERROR",
        latency_ms: 1,
      })),
      consistent: false,
    },
    { domain: "example.com", recordType: "A" },
  );
  const retainedAnswerBytes = aggregateBounded.resolvers.reduce(
    (total, current) =>
      total +
      current.records.reduce(
        (recordTotal, answer) => recordTotal + utf8ByteLengthUpTo(answer),
        0,
      ),
    0,
  );
  assert.ok(retainedAnswerBytes <= PROPAGATION_LIMITS.aggregateBytes);
  assert.match(
    aggregateBounded.warnings.join(" "),
    /retained-payload budget was exhausted/i,
  );

  renderChecker(async () => raw);
  await clickCheck();
  await waitFor(() =>
    assert.equal(screen.getAllByTestId("propagation-resolver-row").length, 1),
  );
  assert.equal(document.querySelector("script"), null);
  assert.equal(document.querySelector("img"), null);
  assert.equal(document.querySelector("[onerror]"), null);
});

test("watch polling is single-flight and stop prevents timers and stale writes", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const scheduledWatchTimeouts: Array<() => void> = [];
  const scheduledWatchIntervals: Array<() => void> = [];
  globalThis.setTimeout = ((
    callback: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    if ((delay ?? 0) >= 10_000) {
      scheduledWatchTimeouts.push(callback as () => void);
      return 701 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(() => {
      if (typeof callback === "function") callback(...args);
    }, delay);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    if (id !== (701 as unknown as ReturnType<typeof setTimeout>)) {
      originalClearTimeout(id);
    }
  }) as typeof clearTimeout;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    if ((delay ?? 0) >= 10_000) {
      scheduledWatchIntervals.push(callback as () => void);
    }
    return 702 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;

  let calls = 0;
  let signal: AbortSignal | undefined;
  let resolveLookup!: (value: unknown) => void;
  const view = renderChecker(
    (_domain, _recordType, _extraResolvers, currentSignal?: AbortSignal) => {
      calls += 1;
      signal = currentSignal;
      return new Promise<unknown>((resolve) => {
        resolveLookup = resolve;
      });
    },
  );

  try {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Watch" }));
      await Promise.resolve();
    });
    assert.equal(calls, 1);
    assert.equal(scheduledWatchTimeouts.length, 0);
    assert.equal(scheduledWatchIntervals.length, 0);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await Promise.resolve();
    });
    assert.equal(signal?.aborted, true);
    await act(async () => {
      resolveLookup(nativeResult("example.com", ["192.0.2.99"]));
      await Promise.resolve();
    });

    assert.equal(calls, 1);
    assert.equal(scheduledWatchTimeouts.length, 0);
    assert.equal(screen.queryByText("192.0.2.99"), null);

    view.unmount();
    let unmountSignal: AbortSignal | undefined;
    let resolveAfterUnmount!: (value: unknown) => void;
    const unmountView = renderChecker(
      (_domain, _recordType, _extraResolvers, currentSignal?: AbortSignal) => {
        unmountSignal = currentSignal;
        return new Promise<unknown>((resolve) => {
          resolveAfterUnmount = resolve;
        });
      },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Watch" }));
      await Promise.resolve();
    });
    unmountView.unmount();
    assert.equal(unmountSignal?.aborted, true);
    await act(async () => {
      resolveAfterUnmount(nativeResult("example.com", ["192.0.2.100"]));
      await Promise.resolve();
    });
    assert.equal(scheduledWatchTimeouts.length, 0);
  } finally {
    view.unmount();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
