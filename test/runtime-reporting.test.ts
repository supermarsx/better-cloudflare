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
import { RESOURCE_LIMITS, utf8ByteLength } from "../src/lib/resource-limits";

afterEach(() => {
  resetRuntimeReportingForTests();
});

function stableError(message: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n at stable (runtime-test.ts:1:1)`;
  return error;
}

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

test("redacts authentication query parameters consistently", () => {
  const sanitized = sanitizeRuntimeText(
    "https://example.test/callback?auth=auth-secret&authorization=authorization-secret&cookie=cookie-secret",
  );

  assert.equal(
    sanitized,
    "https://example.test/callback?auth=[redacted]&authorization=[redacted]&cookie=[redacted]",
  );
  assert.doesNotMatch(
    sanitized,
    /auth-secret|authorization-secret|cookie-secret/,
  );
});

test("truncates diagnostics by UTF-8 bytes at limit-1, exact limit, and limit+1", () => {
  const limit = RESOURCE_LIMITS.runtimeDiagnostics.messageHardBytes;
  assert.equal(
    utf8ByteLength(sanitizeRuntimeText("a".repeat(limit - 1), limit)),
    limit - 1,
  );
  assert.equal(
    utf8ByteLength(sanitizeRuntimeText("a".repeat(limit), limit)),
    limit,
  );
  assert.equal(
    utf8ByteLength(sanitizeRuntimeText("a".repeat(limit + 1), limit)),
    limit,
  );

  const unicode = sanitizeRuntimeText(`${"a".repeat(limit - 2)}😀`, limit);
  assert.equal(utf8ByteLength(unicode), limit - 2);
  assert.doesNotMatch(unicode, /\uFFFD/);
});

test("redacts complete quoted, unterminated, bearer, and object secrets before truncation", () => {
  const secret = "秘密😀-BOUNDARY-secret-suffix";
  const cases = [
    `context password="${secret}" visible-tail`,
    `context token='${secret}`,
    `context Bearer "${secret}" visible-tail`,
    `context Bearer '${secret}`,
  ];

  for (const value of cases) {
    const secretStart = value.indexOf(secret);
    const boundaryBytes =
      utf8ByteLength(value.slice(0, secretStart)) +
      utf8ByteLength(secret.slice(0, 3));
    const sanitized = sanitizeRuntimeText(value, boundaryBytes);
    assert.ok(utf8ByteLength(sanitized) <= boundaryBytes);
    assert.doesNotMatch(sanitized, /秘密|BOUNDARY|secret-suffix|\uFFFD/);
  }

  const serialized = sanitizeRuntimeText({
    password: secret,
    nested: { access_token: secret },
  });
  assert.doesNotMatch(serialized, /秘密|BOUNDARY|secret-suffix/);
  assert.match(serialized, /\[redacted\]/);
});

test("bounds serialized traces and stacks while preserving redaction", () => {
  const serialized = sanitizeRuntimeText({
    trace: `password=serialized-secret ${"😀".repeat(10_000)}`,
    nested: Array.from({ length: 1000 }, (_, index) => ({
      index,
      token: `trace-token-${index}`,
    })),
  });
  assert.ok(
    utf8ByteLength(serialized) <=
      RESOURCE_LIMITS.runtimeDiagnostics.messageHardBytes,
  );
  assert.doesNotMatch(serialized, /serialized-secret/);
  assert.match(serialized, /\[redacted\]/);
  assert.doesNotMatch(serialized, /\uFFFD/);

  const error = new Error("bounded stack");
  error.stack = `Error: bounded stack\n${"😀".repeat(10_000)}`;
  const { diagnostic } = reportRuntimeError(error, {
    componentStack: "😀".repeat(10_000),
  });
  assert.ok(
    utf8ByteLength(diagnostic.stack ?? "") <=
      RESOURCE_LIMITS.runtimeDiagnostics.stackHardBytes,
  );
  assert.ok(
    utf8ByteLength(diagnostic.componentStack ?? "") <=
      RESOURCE_LIMITS.runtimeDiagnostics.componentStackHardBytes,
  );
  assert.doesNotMatch(diagnostic.stack ?? "", /\uFFFD/);
  assert.doesNotMatch(diagnostic.componentStack ?? "", /\uFFFD/);
});

test("retains exactly 30 diagnostics, checks boundary duplicates, and unsuppresses evictions", () => {
  const retainedLimit = RESOURCE_LIMITS.runtimeDiagnostics.retainedCountHard;
  for (let index = 0; index < retainedLimit; index += 1) {
    assert.equal(
      reportRuntimeError(stableError(`unique failure ${index}`)).duplicate,
      false,
    );
  }
  assert.equal(getRuntimeDiagnostics().length, retainedLimit);
  assert.equal(
    reportRuntimeError(stableError("unique failure 0")).duplicate,
    true,
  );

  assert.equal(
    reportRuntimeError(stableError(`unique failure ${retainedLimit}`))
      .duplicate,
    false,
  );
  assert.equal(getRuntimeDiagnostics().length, retainedLimit);
  assert.equal(
    reportRuntimeError(stableError("unique failure 0")).duplicate,
    false,
  );
  assert.equal(getRuntimeDiagnostics().length, retainedLimit);
});

test("checks duplicates before fingerprint eviction at the exact 100 boundary", () => {
  const mutableLimits = RESOURCE_LIMITS.runtimeDiagnostics as {
    retainedCountHard: number;
  };
  const originalRetainedLimit = mutableLimits.retainedCountHard;
  mutableLimits.retainedCountHard =
    RESOURCE_LIMITS.runtimeDiagnostics.recentFingerprintsHard;

  try {
    const fingerprintLimit =
      RESOURCE_LIMITS.runtimeDiagnostics.recentFingerprintsHard;
    for (let index = 0; index < fingerprintLimit; index += 1) {
      assert.equal(
        reportRuntimeError(stableError(`capacity failure ${index}`)).duplicate,
        false,
      );
    }
    assert.equal(getRuntimeDiagnostics().length, fingerprintLimit);
    assert.equal(
      reportRuntimeError(stableError("capacity failure 0")).duplicate,
      true,
    );

    assert.equal(
      reportRuntimeError(stableError(`capacity failure ${fingerprintLimit}`))
        .duplicate,
      false,
    );
    assert.equal(getRuntimeDiagnostics().length, fingerprintLimit);
    assert.equal(
      reportRuntimeError(stableError("capacity failure 0")).duplicate,
      false,
    );
  } finally {
    mutableLimits.retainedCountHard = originalRetainedLimit;
  }
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
