import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ErrorBoundary } from "../src/components/layout/ErrorBoundary";
import { RuntimeRootBoundary } from "../src/components/layout/RuntimeRootBoundary";
import { resetRuntimeReportingForTests } from "../src/lib/errors/runtime-reporting";

afterEach(() => {
  cleanup();
  mock.restoreAll();
  resetRuntimeReportingForTests();
});

test("section boundary contains a render crash, redacts it, and remounts on retry", async () => {
  mock.method(console, "error", () => {});
  let shouldThrow = true;
  let mounts = 0;

  function FragileSection() {
    mounts += 1;
    if (shouldThrow) {
      throw new Error("Section failed password=hunter2");
    }
    return <div>Section recovered</div>;
  }

  render(
    <ErrorBoundary label="fragile-section">
      <FragileSection />
    </ErrorBoundary>,
  );

  assert.ok(screen.getByRole("alert"));
  assert.ok(screen.getByText("This section stopped unexpectedly"));
  assert.doesNotMatch(document.body.textContent ?? "", /hunter2/);
  assert.match(document.body.textContent ?? "", /\[redacted\]/);

  shouldThrow = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry section" }));

  await waitFor(() => assert.ok(screen.getByText("Section recovered")));
  assert.ok(mounts >= 2);
});

test("root boundary keeps a recovery surface and returns to a fresh child tree", async () => {
  mock.method(console, "error", () => {});
  let shouldThrow = true;

  function Workspace() {
    if (shouldThrow) throw new Error("workspace render failed");
    return <div>Fresh login tree</div>;
  }

  render(
    <RuntimeRootBoundary>
      <Workspace />
    </RuntimeRootBoundary>,
  );

  assert.ok(screen.getByTestId("runtime-crash-recovery"));
  assert.ok(screen.getByRole("button", { name: "Return to login" }));

  shouldThrow = false;
  fireEvent.click(screen.getByRole("button", { name: "Return to login" }));
  await waitFor(() => assert.ok(screen.getByText("Fresh login tree")));
});

test("a failing custom fallback and error callback cannot take down the boundary", () => {
  mock.method(console, "error", () => {});

  function Broken() {
    throw new Error("primary failure");
  }

  render(
    <ErrorBoundary
      label="resilient-fallback"
      onError={() => {
        throw new Error("reporting callback failed token=hidden");
      }}
      fallback={() => {
        throw new Error("custom fallback failed password=hidden");
      }}
    >
      <Broken />
    </ErrorBoundary>,
  );

  assert.ok(screen.getByRole("alert"));
  assert.ok(screen.getByText("This section stopped unexpectedly"));
  assert.doesNotMatch(document.body.textContent ?? "", /hidden/);
});
