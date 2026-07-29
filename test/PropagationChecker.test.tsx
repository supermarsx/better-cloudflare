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
  PropagationChecker,
} from "../src/components/dns/PropagationChecker";

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
