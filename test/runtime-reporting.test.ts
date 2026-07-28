import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  formatRuntimeDiagnostic,
  getRuntimeDiagnostics,
  installGlobalRuntimeReporting,
  reportRuntimeError,
  resetRuntimeReportingForTests,
  sanitizeRuntimeText,
  subscribeRuntimeReports,
} from "../src/lib/errors/runtime-reporting";

afterEach(() => {
  resetRuntimeReportingForTests();
});

test("redacts runtime secrets from messages, stacks, and copied diagnostics", () => {
  const error = new Error(
    "Login failed authorization=Bearer top-secret password=hunter2 ?token=query-secret",
  );
  error.stack =
    "Error: token=stack-secret\n at https://example.test/?api_key=hidden";

  const { diagnostic } = reportRuntimeError(error, {
    source: "react-boundary",
    label: "auth password=label-secret",
    componentStack: "Component token=component-secret",
  });
  const formatted = formatRuntimeDiagnostic(diagnostic);

  assert.doesNotMatch(
    formatted,
    /top-secret|hunter2|query-secret|stack-secret|hidden|label-secret|component-secret/,
  );
  assert.match(formatted, /\[redacted\]/);
  assert.equal(
    sanitizeRuntimeText("access_token=abc123"),
    "access_token=[redacted]",
  );
});

test("deduplicates the same failure across global error and rejection sources", () => {
  const received: string[] = [];
  const unsubscribe = subscribeRuntimeReports((diagnostic) => {
    received.push(diagnostic.id);
  });
  const error = new Error("shared asynchronous failure");

  const first = reportRuntimeError(error, {
    source: "global-error",
    label: "window",
  });
  const second = reportRuntimeError(error, {
    source: "unhandled-rejection",
    label: "promise",
  });

  unsubscribe();
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.diagnostic.id, first.diagnostic.id);
  assert.equal(second.diagnostic.occurrences, 2);
  assert.deepEqual(received, [first.diagnostic.id]);
  assert.equal(getRuntimeDiagnostics().length, 1);
});

test("global handlers report errors and rejected promises once without loops", () => {
  const received: string[] = [];
  const unsubscribe = subscribeRuntimeReports((diagnostic) => {
    received.push(diagnostic.id);
    throw new Error("listener failures are contained");
  });
  const uninstall = installGlobalRuntimeReporting(window);
  const globalError = new Error("global failure");
  const rejectionError = new Error("rejection failure");

  window.dispatchEvent(
    new ErrorEvent("error", {
      error: globalError,
      message: globalError.message,
      filename: "app.js",
      lineno: 10,
      colno: 2,
    }),
  );
  const rejection = new window.Event("unhandledrejection");
  Object.defineProperty(rejection, "reason", {
    configurable: true,
    value: rejectionError,
  });
  window.dispatchEvent(rejection);

  uninstall();
  unsubscribe();
  assert.equal(received.length, 2);
  assert.equal(getRuntimeDiagnostics().length, 2);
});
