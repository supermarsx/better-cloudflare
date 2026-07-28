import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  RequestError,
  formatRequestError,
  malformedResponseError,
  normalizeRequestError,
  requestErrorFromResponse,
} from "../src/lib/api/request-error.ts";

test("normalizes network, timeout, cancellation, and unknown failures", () => {
  const network = normalizeRequestError(new TypeError("Failed to fetch"), {
    endpoint: "/zones?token=secret",
    operation: "GET",
  });
  assert.equal(
    network.message,
    "The browser could not complete the request and cannot distinguish between offline connectivity, DNS, TLS, or CORS failures. Check your connection, the server address and certificate, and browser/CORS settings, then try again. (/zones)",
  );
  assert.equal(network.kind, "network");
  assert.equal(network.source, "browser");
  assert.equal(network.endpoint, "/zones");
  assert.equal(network.operation, "GET");
  assert.equal(network.retryable, true);
  assert.equal(
    normalizeRequestError(new Error("Failed to fetch")).kind,
    "network",
  );
  assert.doesNotMatch(formatRequestError("Failed to fetch"), /Failed to fetch/);
  const timeout = normalizeRequestError(new Error("aborted"), {
    endpoint: "/zones",
    operation: "POST",
    timedOut: true,
  });
  assert.equal(
    timeout.message,
    "Request timed out. Check your connection and try again. (/zones)",
  );
  assert.equal(timeout.kind, "timeout");
  assert.equal(timeout.source, "client");
  assert.equal(timeout.operation, "POST");
  assert.equal(timeout.retryable, true);
  const aborted = normalizeRequestError(
    new DOMException("cancelled", "AbortError"),
    {
      endpoint: "/zones",
      operation: "GET",
    },
  );
  assert.equal(
    aborted.message,
    "Request was cancelled. Retry when you are ready. (/zones)",
  );
  assert.equal(aborted.kind, "aborted");
  assert.equal(aborted.source, "client");
  assert.equal(aborted.operation, "GET");
  assert.equal(aborted.retryable, false);
  assert.equal(
    normalizeRequestError(new Error("token=very-secret")).message,
    "Unexpected request error. Try again.",
  );
});

test("extracts safe Cloudflare HTTP detail and redacts secrets", () => {
  const response = new Response("", { status: 403 });
  const error = requestErrorFromResponse(
    response,
    "/verify-token?token=hidden",
    JSON.stringify({
      errors: [
        {
          code: 10000,
          message: "Authentication failed token=super-secret",
        },
        {
          code: 9109,
          message: "Invalid access token",
        },
        {
          code: "1001",
          message: "DNS record data is invalid",
        },
      ],
    }),
    "POST",
  );
  assert.equal(error.kind, "http");
  assert.equal(error.source, "cloudflare");
  assert.equal(error.status, 403);
  assert.equal(error.endpoint, "/verify-token");
  assert.equal(error.operation, "POST");
  assert.equal(error.retryable, false);
  assert.equal(error.context.status, 403);
  assert.equal(error.context.code, "10000");
  assert.deepEqual(error.providerCodes, ["10000", "9109", "1001"]);
  assert.deepEqual(error.providerMessages, [
    "Authentication failed token=[redacted]",
    "Invalid access token",
    "DNS record data is invalid",
  ]);
  assert.deepEqual(error.providerErrors, [
    {
      code: "10000",
      message: "Authentication failed token=[redacted]",
    },
    { code: "9109", message: "Invalid access token" },
    { code: "1001", message: "DNS record data is invalid" },
  ]);
  assert.equal(
    error.message,
    "Request failed (HTTP 403, code 10000) at /verify-token: 10000: Authentication failed token=[redacted]; 9109: Invalid access token; 1001: DNS record data is invalid",
  );
  assert.doesNotMatch(error.message, /super-secret|hidden/);
});

test("bounds Cloudflare provider errors while retaining all displayed codes", () => {
  const response = new Response("", { status: 429 });
  const error = requestErrorFromResponse(
    response,
    "/zones",
    JSON.stringify({
      errors: Array.from({ length: 7 }, (_, index) => ({
        code: 2000 + index,
        message: `Provider message ${index + 1}`,
      })),
    }),
  );

  assert.equal(error.retryable, true);
  assert.equal(error.providerErrors.length, 5);
  assert.deepEqual(error.providerCodes, [
    "2000",
    "2001",
    "2002",
    "2003",
    "2004",
  ]);
  assert.match(error.message, /2004: Provider message 5; and 2 more errors$/);
  assert.doesNotMatch(error.message, /Provider message 6/);
});

test("derives HTTP retryability from status", () => {
  const badRequest = requestErrorFromResponse(
    new Response("", { status: 400 }),
    "/zones",
    "",
  );
  const rateLimited = requestErrorFromResponse(
    new Response("", { status: 429 }),
    "/zones",
    "",
  );
  const unavailable = requestErrorFromResponse(
    new Response("", { status: 503 }),
    "/zones",
    "",
  );

  assert.equal(badRequest.retryable, false);
  assert.equal(rateLimited.retryable, true);
  assert.equal(unavailable.retryable, true);
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.source, "server");
});

test("supports message, error, bounded text, and malformed success bodies", () => {
  const response = new Response("", { status: 500 });
  assert.match(
    requestErrorFromResponse(
      response,
      "/zones",
      JSON.stringify({ message: "Service unavailable" }),
    ).message,
    /Service unavailable$/,
  );
  assert.match(
    requestErrorFromResponse(
      response,
      "/zones",
      JSON.stringify({ error: "Upstream failed" }),
    ).message,
    /Upstream failed$/,
  );
  assert.match(
    requestErrorFromResponse(
      response,
      "/zones",
      JSON.stringify({ detail: "Gateway unavailable" }),
    ).message,
    /Gateway unavailable$/,
  );
  assert.match(
    requestErrorFromResponse(
      response,
      "/zones",
      JSON.stringify("Maintenance in progress"),
    ).message,
    /Maintenance in progress$/,
  );
  const textError = requestErrorFromResponse(
    response,
    "/zones",
    `"access_token": "hunter2" ${"x".repeat(300)}`,
  );
  assert.doesNotMatch(textError.message, /hunter2/);
  assert.ok(textError.message.length < 240);
  const malformed = malformedResponseError("/zones", new SyntaxError(), {
    operation: "GET",
    status: 200,
  });
  assert.equal(
    malformed.message,
    "Server returned invalid JSON for a successful response. Try again; if the problem continues, contact support. (/zones)",
  );
  assert.equal(malformed.kind, "malformed-response");
  assert.equal(malformed.source, "server");
  assert.equal(malformed.endpoint, "/zones");
  assert.equal(malformed.operation, "GET");
  assert.equal(malformed.status, 200);
  assert.equal(malformed.retryable, true);
});

test("normalizes validation errors for login-facing presentation", () => {
  const result = z.object({ email: z.string().email() }).safeParse({
    email: "invalid",
  });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(
    formatRequestError(result.error),
    "Invalid input: email: Invalid email",
  );

  const requestError = new RequestError(
    "http",
    "Request failed (HTTP 401) at /verify-token: Invalid credentials",
  );
  assert.equal(formatRequestError(requestError), requestError.message);
});
