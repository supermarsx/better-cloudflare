import assert from "node:assert/strict";
import { test, afterEach } from "node:test";

import {
  normalizeTauriInvokeError,
  TauriClient,
  withTauriUiTimeout,
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

test("normalizes the exact serialized Rust AuthRequestFailed envelope", () => {
  const serialized =
    '{"code":"AUTH_REQUEST_FAILED","kind":"authentication","message":"Cloudflare rejected the supplied credentials (HTTP 403).","status":403,"source":"cloudflare","operation":"auth:verify_token","retryable":false,"retry_after":"30","details":{"provider_errors":[{"code":"9109","message":"Invalid access token token=provider-secret"},{"code":"10000","message":"Authentication error"}],"provider_codes":["9109","10000"],"provider_messages":["Invalid access token token=provider-secret","Authentication error"],"retry_after_secs":30,"remediation":"Check the API token, account email, and permissions."},"request_id":"rust-ray-123"}';
  const cause = JSON.parse(serialized) as unknown;
  assert.equal(JSON.stringify(cause), serialized);

  const error = normalizeTauriInvokeError(serialized, "verify_token");
  assert.equal(error.kind, "http");
  assert.equal(error.source, "cloudflare");
  assert.equal(error.command, "verify_token");
  assert.equal(error.operation, "auth:verify_token");
  assert.equal(error.status, 403);
  assert.equal(error.code, "AUTH_REQUEST_FAILED");
  assert.equal(error.requestId, "rust-ray-123");
  assert.equal(error.retryAfter, "30");
  assert.equal(error.retryable, false);
  assert.equal(
    error.remediation,
    "Check the API token, account email, and permissions.",
  );
  assert.deepEqual(error.providerCodes, ["9109", "10000"]);
  assert.match(error.providerMessages[0] ?? "", /\[redacted\]/);

  const formatted = formatRequestError(error);
  assert.match(formatted, /denied this operation/i);
  assert.match(formatted, /provider codes 9109, 10000/);
  assert.match(formatted, /request ID rust-ray-123/);
  assert.match(formatted, /retry after 30/);
  assert.match(formatted, /next step Check the API token/);
  assert.doesNotMatch(formatted, /provider-secret/);
});

test("preserves Rust network, timeout, and malformed response kinds", () => {
  const fixtures = [
    [
      "network",
      "network",
      "Could not reach Cloudflare to verify the credentials.",
      /could not be reached/i,
    ],
    [
      "timeout",
      "timeout",
      "Cloudflare token verification timed out.",
      /timed out/i,
    ],
    [
      "malformed_response",
      "malformed-response",
      "Cloudflare returned an unreadable token verification response.",
      /malformed response/i,
    ],
  ] as const;

  for (const [rustKind, expectedKind, message, expectedMessage] of fixtures) {
    const serialized = JSON.stringify({
      code: "AUTH_REQUEST_FAILED",
      kind: rustKind,
      message,
      source: rustKind === "malformed_response" ? "cloudflare" : "network",
      operation: "auth:verify_token",
      retryable: true,
      details: {
        provider_errors: [],
        provider_codes: [],
        provider_messages: [],
        remediation:
          "Check the internet connection, proxy, DNS, and TLS settings, then retry.",
      },
    });
    const error = normalizeTauriInvokeError(
      JSON.parse(serialized) as unknown,
      "verify_token",
    );
    assert.equal(error.kind, expectedKind);
    assert.equal(error.retryable, true);
    assert.equal(error.operation, "auth:verify_token");
    assert.match(error.message, expectedMessage);
    assert.doesNotMatch(error.message, /failed unexpectedly/i);
  }
});

test("bounds stalled auth and passkey Tauri UI operations", async () => {
  for (const command of ["verify_token", "list_passkeys"]) {
    await assert.rejects(
      () => withTauriUiTimeout(new Promise<never>(() => {}), command, 5),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "timeout");
        assert.equal(error.source, "tauri");
        assert.equal(error.command, command);
        assert.equal(error.retryable, true);
        assert.match(error.message, /native task may still finish/i);
        return true;
      },
    );
  }
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
