import assert from "node:assert/strict";
import { test, afterEach } from "node:test";

import {
  normalizeTauriInvokeError,
  TauriClient,
} from "../src/lib/api/tauri-client";
import { formatRequestError, RequestError } from "../src/lib/api/request-error";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;

afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

test("isTauri returns true when window.__TAURI__ is present", () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  assert.equal(TauriClient.isTauri(), true);
});

test("isTauri returns false when window is missing", () => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
  assert.equal(TauriClient.isTauri(), false);
});

test("normalizes Tauri string failures without discarding native detail", () => {
  const error = normalizeTauriInvokeError(
    "HTTP error: connection refused password=secret-value",
    "verify_token",
  );
  assert.ok(error instanceof RequestError);
  assert.equal(error.kind, "network");
  assert.equal(error.source, "tauri");
  assert.equal(error.command, "verify_token");
  assert.equal(error.operation, "Tauri invoke");
  assert.equal(error.retryable, true);
  assert.match(error.message, /backend refused the connection/i);
  assert.doesNotMatch(error.message, /secret-value/);
  assert.match(formatRequestError(error), /command verify_token/);
});

test("normalizes structured Tauri failures with safe diagnostics", () => {
  const cause = {
    message: "Authentication failed for api_key=top-secret",
    status: 401,
    statusText: "Unauthorized",
    code: 10000,
    request_id: "cf-ray-7",
  };
  const error = normalizeTauriInvokeError(cause, "verify_token");
  assert.equal(error.kind, "http");
  assert.equal(error.status, 401);
  assert.equal(error.statusText, "Unauthorized");
  assert.equal(error.code, "10000");
  assert.equal(error.requestId, "cf-ray-7");
  assert.equal(error.cause, cause);
  assert.match(error.message, /Authentication was rejected/);
  assert.doesNotMatch(error.message, /top-secret/);
  const formatted = formatRequestError(error);
  assert.match(formatted, /source tauri/);
  assert.match(formatted, /status 401 Unauthorized/);
  assert.match(formatted, /code 10000/);
  assert.match(formatted, /request ID cf-ray-7/);
});

test("gives unknown native failures a diagnostic ID", () => {
  const error = normalizeTauriInvokeError(
    { reason: "Desktop bridge returned an undocumented state" },
    "get_preferences",
  );
  assert.equal(error.kind, "unknown");
  assert.match(error.message, /undocumented state/);
  assert.match(error.diagnosticId ?? "", /^REQ-[A-Z0-9-]+$/);
});
