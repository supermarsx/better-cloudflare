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

test("stringifies unusual values without throwing", () => {
  const values = [
    Symbol("runtime-symbol"),
    function runtimeFunction() {},
    undefined,
    {
      toJSON() {
        return undefined;
      },
    },
    {
      value: 1n,
      nested: Symbol("nested"),
    },
  ];

  for (const value of values) {
    const sanitized = sanitizeRuntimeText(value);
    assert.equal(typeof sanitized, "string");
  }
});

test("redacts URL credentials and JWT-shaped tokens", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQtdXNlciJ9.abcdefghijklmnopqrstuvwxyz";
  const sanitized = sanitizeRuntimeText(
    `https://admin:super-secret@example.test/path session payload ${jwt}`,
  );

  assert.doesNotMatch(sanitized, /admin|super-secret|eyJhbGci|c2VjcmV0/);
  assert.match(sanitized, /https:\/\/\[redacted\]@example\.test/);
  assert.match(sanitized, /\[redacted-jwt\]/);
});

test("bounds recent fingerprint history by evicting old unique failures", () => {
  const stableError = (message: string) => {
    const error = new Error(message);
    error.stack = `Error: ${message}\n at stable (runtime-test.ts:1:1)`;
    return error;
  };

  for (let index = 0; index <= 100; index += 1) {
    assert.equal(
      reportRuntimeError(stableError(`unique failure ${index}`)).duplicate,
      false,
    );
  }

  assert.equal(
    reportRuntimeError(stableError("unique failure 0")).duplicate,
    false,
  );
  assert.ok(getRuntimeDiagnostics().length <= 30);
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
