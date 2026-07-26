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
  assert.equal(
    normalizeRequestError(new TypeError("Failed to fetch"), {
      endpoint: "/zones?token=secret",
    }).message,
    "Unable to reach the server. Check your connection; you may be offline or the request may be blocked by CORS. Then try again. (/zones)",
  );
  assert.equal(
    normalizeRequestError(new Error("Failed to fetch")).kind,
    "network",
  );
  assert.doesNotMatch(formatRequestError("Failed to fetch"), /Failed to fetch/);
  assert.equal(
    normalizeRequestError(new Error("aborted"), {
      endpoint: "/zones",
      timedOut: true,
    }).message,
    "Request timed out. Check your connection and try again. (/zones)",
  );
  assert.equal(
    normalizeRequestError(new DOMException("cancelled", "AbortError"), {
      endpoint: "/zones",
    }).message,
    "Request was cancelled. Retry when you are ready. (/zones)",
  );
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
      ],
    }),
  );
  assert.equal(error.kind, "http");
  assert.equal(error.context.status, 403);
  assert.equal(error.context.code, "10000");
  assert.equal(
    error.message,
    "Request failed (HTTP 403, code 10000) at /verify-token: 10000: Authentication failed token=[redacted]",
  );
  assert.doesNotMatch(error.message, /super-secret|hidden/);
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
  assert.equal(
    malformedResponseError("/zones", new SyntaxError()).message,
    "Server returned invalid JSON for a successful response. Try again; if the problem continues, contact support. (/zones)",
  );
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
