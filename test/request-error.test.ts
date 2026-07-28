import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  backendConfigurationError,
  formatRequestError,
  malformedResponseError,
  normalizeRequestError,
  RequestError,
  requestErrorFromResponse,
} from "../src/lib/api/request-error.ts";

test("classifies browser network, refused, DNS, TLS, and CORS failures", () => {
  const generic = normalizeRequestError(new TypeError("Failed to fetch"), {
    endpoint: "/zones?token=secret",
    requestUrl: "https://api.example.test/zones?api_key=secret",
    operation: "GET",
  });
  assert.equal(generic.kind, "network");
  assert.equal(generic.source, "browser");
  assert.equal(generic.endpoint, "/zones");
  assert.equal(generic.requestUrl, "https://api.example.test/zones");
  assert.equal(generic.operation, "GET");
  assert.equal(generic.retryable, true);
  assert.match(generic.message, /offline connectivity, DNS, TLS, CORS/);
  assert.doesNotMatch(generic.message, /secret/);

  const offline = normalizeRequestError("ERR_INTERNET_DISCONNECTED");
  assert.equal(offline.kind, "network");
  assert.match(offline.message, /device appears to be offline/i);

  const refused = normalizeRequestError(
    { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:8787" },
    { endpoint: "/verify-token" },
  );
  assert.equal(refused.kind, "network");
  assert.match(refused.message, /backend refused the connection/i);

  const dns = normalizeRequestError({
    code: "ENOTFOUND",
    message: "getaddrinfo ENOTFOUND api.invalid",
  });
  assert.equal(dns.kind, "network");
  assert.match(dns.message, /hostname could not be resolved/i);

  const tls = normalizeRequestError(
    new Error("self-signed certificate in certificate chain"),
  );
  assert.equal(tls.kind, "network");
  assert.match(tls.message, /TLS or certificate error/i);

  const cors = normalizeRequestError(
    "Blocked by CORS: Access-Control-Allow-Origin missing",
  );
  assert.equal(cors.kind, "network");
  assert.equal(cors.retryable, false);
  assert.match(cors.message, /CORS policy/);
});

test("normalizes timeout and explicit cancellation", () => {
  const timeout = normalizeRequestError(new Error("aborted"), {
    endpoint: "/zones",
    operation: "POST",
    timedOut: true,
  });
  assert.equal(timeout.kind, "timeout");
  assert.equal(timeout.source, "client");
  assert.equal(timeout.operation, "POST");
  assert.equal(timeout.retryable, true);
  assert.match(timeout.message, /timed out/i);

  const aborted = normalizeRequestError(
    new DOMException("cancelled", "AbortError"),
    { endpoint: "/zones", operation: "GET" },
  );
  assert.equal(aborted.kind, "aborted");
  assert.equal(aborted.source, "client");
  assert.equal(aborted.retryable, false);
  assert.match(aborted.message, /cancelled/i);
});

test("preserves safe native and Tauri details with command metadata", () => {
  const cause = {
    error: {
      message: "Cloudflare account is unavailable",
      code: "CF_ACCOUNT",
    },
    status: 403,
    statusText: "Forbidden",
    request_id: "ray-123",
    retry_after: "30",
  };
  const error = normalizeRequestError(cause, {
    source: "tauri",
    command: "verify_token",
    operation: "Tauri invoke",
  });
  assert.equal(error.kind, "http");
  assert.equal(error.source, "tauri");
  assert.equal(error.command, "verify_token");
  assert.equal(error.operation, "Tauri invoke");
  assert.equal(error.status, 403);
  assert.equal(error.statusText, "Forbidden");
  assert.equal(error.code, "CF_ACCOUNT");
  assert.equal(error.requestId, "ray-123");
  assert.equal(error.retryAfter, "30");
  assert.equal(error.retryable, false);
  assert.equal(error.cause, cause);
  assert.match(error.message, /account is unavailable/i);

  const formatted = formatRequestError(error);
  assert.match(formatted, /source tauri/);
  assert.match(formatted, /command verify_token/);
  assert.match(formatted, /status 403 Forbidden/);
  assert.match(formatted, /code CF_ACCOUNT/);
  assert.match(formatted, /request ID ray-123/);
  assert.match(formatted, /retry after 30/);
});

test("unknown failures retain redacted detail and receive a diagnostic ID", () => {
  const cause = new Error(
    "Native bridge unavailable; Authorization: Bearer abc123 password=hunter2 cookie=session123 https://example.test/?token=query-secret",
  );
  const error = normalizeRequestError(cause, {
    source: "tauri",
    command: "verify_token",
  });
  assert.equal(error.kind, "unknown");
  assert.equal(error.source, "tauri");
  assert.equal(error.command, "verify_token");
  assert.match(error.message, /Native bridge unavailable/);
  assert.match(error.message, /Diagnostic ID: REQ-[A-Z0-9-]+/);
  assert.match(error.diagnosticId ?? "", /^REQ-[A-Z0-9-]+$/);
  assert.doesNotMatch(error.message, /abc123|hunter2|session123|query-secret/);
  assert.equal(error.cause, cause);
});

test("produces actionable HTTP messages and captures safe response metadata", () => {
  const cases = [
    [401, "Unauthorized", /Authentication was rejected/],
    [403, "Forbidden", /denied this operation/],
    [404, "Not Found", /backend endpoint was not found/],
    [429, "Too Many Requests", /rate limit was reached/],
    [503, "Service Unavailable", /backend or upstream service failed/],
  ] as const;

  for (const [status, statusText, expected] of cases) {
    const response = new Response("", {
      status,
      statusText,
      headers: {
        "cf-ray": "ray-safe",
        "retry-after": "45",
      },
    });
    const error = requestErrorFromResponse(
      response,
      "/verify-token?token=hidden",
      JSON.stringify({ message: "Provider detail" }),
      "POST",
      "https://backend.example.test/api/verify-token?api_key=hidden",
    );
    assert.equal(error.status, status);
    assert.equal(error.statusText, statusText);
    assert.equal(error.endpoint, "/verify-token");
    assert.equal(
      error.requestUrl,
      "https://backend.example.test/api/verify-token",
    );
    assert.equal(error.operation, "POST");
    assert.equal(error.requestId, "ray-safe");
    assert.equal(error.retryAfter, "45");
    assert.equal(
      error.retryable,
      status === 429 || status >= 500,
      `retryability for ${status}`,
    );
    assert.match(error.message, expected);
    assert.match(error.message, /Provider detail/);
    assert.doesNotMatch(error.message, /hidden/);
  }
});

test("extracts bounded Cloudflare errors and aggressively redacts secrets", () => {
  const response = new Response("", {
    status: 403,
    statusText: "Forbidden",
  });
  const error = requestErrorFromResponse(
    response,
    "/verify-token",
    JSON.stringify({
      errors: [
        {
          code: 10000,
          message: "Authentication failed token=super-secret",
        },
        { code: 9109, message: "Invalid access token" },
        { code: 1001, message: "DNS record data is invalid" },
        { code: 1002, message: "Fourth" },
        { code: 1003, message: "Fifth" },
        { code: 1004, message: "Must be omitted" },
      ],
    }),
  );
  assert.equal(error.source, "cloudflare");
  assert.equal(error.code, "10000");
  assert.deepEqual(error.providerCodes, [
    "10000",
    "9109",
    "1001",
    "1002",
    "1003",
  ]);
  assert.equal(error.providerErrors.length, 5);
  assert.match(error.message, /and 1 more error/);
  assert.doesNotMatch(error.message, /super-secret|Must be omitted/);
  assert.match(error.providerMessages[0] ?? "", /\[redacted\]/);
});

test("supports common server payloads and malformed success responses", () => {
  const response = new Response("", { status: 500 });
  for (const body of [
    JSON.stringify({ message: "Service unavailable" }),
    JSON.stringify({ error: "Upstream failed" }),
    JSON.stringify({ detail: "Gateway unavailable" }),
    JSON.stringify({ reason: "Maintenance" }),
    JSON.stringify("Plain server detail"),
  ]) {
    assert.match(
      requestErrorFromResponse(response, "/zones", body).message,
      /Service unavailable|Upstream failed|Gateway unavailable|Maintenance|Plain server detail/,
    );
  }

  const textError = requestErrorFromResponse(
    response,
    "/zones",
    `"access_token": "hunter2" ${"x".repeat(600)}`,
  );
  assert.doesNotMatch(textError.message, /hunter2/);
  assert.ok(textError.message.length <= 640);

  const malformed = malformedResponseError("/zones", new SyntaxError(), {
    operation: "GET",
    status: 200,
    statusText: "OK",
    requestUrl: "https://backend.example.test/api/zones",
    requestId: "request-7",
  });
  assert.equal(malformed.kind, "malformed-response");
  assert.equal(malformed.source, "server");
  assert.equal(malformed.status, 200);
  assert.equal(malformed.statusText, "OK");
  assert.equal(malformed.requestId, "request-7");
  assert.equal(malformed.retryable, true);
  assert.match(malformed.message, /invalid JSON/i);
});

test("normalizes validation and backend configuration errors", () => {
  const result = z.object({ email: z.string().email() }).safeParse({
    email: "invalid",
  });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.match(formatRequestError(result.error), /Invalid input: email:/);
  assert.match(formatRequestError(result.error), /retryable no/);

  const configuration = backendConfigurationError("No backend value present");
  assert.equal(configuration.kind, "configuration");
  assert.equal(configuration.source, "client");
  assert.equal(configuration.retryable, false);
  assert.match(configuration.message, /NEXT_PUBLIC_SERVER_API_BASE/);
  assert.match(formatRequestError(configuration), /configure backend/);

  const existing = new RequestError("http", "Existing safe message", {
    status: 400,
  });
  assert.equal(normalizeRequestError(existing), existing);
});
