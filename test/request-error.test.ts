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
  assert.match(
    refused.message,
    /configured web backend refused the connection/i,
  );
  assert.match(refused.message, /NEXT_PUBLIC_SERVER_API_BASE/);
  assert.doesNotMatch(refused.message, /desktop operation/i);

  const dns = normalizeRequestError({
    code: "ENOTFOUND",
    message: "getaddrinfo ENOTFOUND api.invalid",
  });
  assert.equal(dns.kind, "network");
  assert.match(
    dns.message,
    /configured web backend hostname could not be resolved/i,
  );
  assert.match(dns.message, /NEXT_PUBLIC_SERVER_API_BASE/);
  assert.doesNotMatch(dns.message, /desktop operation/i);

  const tls = normalizeRequestError(
    new Error("self-signed certificate in certificate chain"),
  );
  assert.equal(tls.kind, "network");
  assert.match(tls.message, /TLS or certificate error/i);
  assert.match(tls.message, /configured web backend/i);
  assert.match(tls.message, /NEXT_PUBLIC_SERVER_API_BASE/);
  assert.doesNotMatch(tls.message, /desktop operation/i);

  const cors = normalizeRequestError(
    "Blocked by CORS: Access-Control-Allow-Origin missing",
  );
  assert.equal(cors.kind, "network");
  assert.equal(cors.retryable, false);
  assert.match(cors.message, /CORS policy/);
});

test("uses native service guidance for Tauri connection, DNS, and TLS heuristics", () => {
  const cases = [
    {
      error: {
        code: "ECONNREFUSED",
        message: "connect ECONNREFUSED token=refused-secret",
      },
      message:
        /desktop operation could not connect to a required service or Cloudflare upstream/i,
    },
    {
      error: {
        code: "ENOTFOUND",
        message: "getaddrinfo ENOTFOUND api.cloudflare.com token=dns-secret",
      },
      message:
        /desktop operation could not resolve a required service or Cloudflare upstream hostname/i,
    },
    {
      error: new Error(
        "self-signed certificate blocked the secure connection token=tls-secret",
      ),
      message:
        /TLS or certificate error prevented the desktop operation from reaching a required service or Cloudflare upstream/i,
    },
  ];

  for (const fixture of cases) {
    const normalized = normalizeRequestError(fixture.error, {
      source: "tauri",
      operation: "Tauri invoke",
      command: "get_dns_records",
    });
    const formatted = formatRequestError(normalized);

    assert.equal(normalized.kind, "network");
    assert.equal(normalized.source, "tauri");
    assert.equal(normalized.operation, "Tauri invoke");
    assert.equal(normalized.command, "get_dns_records");
    assert.equal(normalized.retryable, true);
    assert.match(normalized.message, fixture.message);
    assert.match(normalized.remediation ?? "", /system DNS|system clock/i);
    assert.match(normalized.remediation ?? "", /proxy or VPN/i);
    assert.match(normalized.remediation ?? "", /firewall/i);
    assert.match(normalized.message, /Next step:/i);
    assert.doesNotMatch(
      normalized.message,
      /configured (?:server|web backend)|NEXT_PUBLIC_SERVER_API_BASE|secret/i,
    );
    assert.match(formatted, /source tauri/i);
    assert.match(formatted, /command get_dns_records/i);
    assert.doesNotMatch(formatted, /secret/i);
  }

  const intactDns = normalizeRequestError(
    {
      code: "AUTH_REQUEST_FAILED",
      kind: "network",
      source: "network",
      operation: "dns:list",
      retryable: true,
      message: "DNS lookup failed token=intact-dns-secret",
    },
    { source: "tauri", command: "get_dns_records" },
  );
  assert.equal(intactDns.kind, "network");
  assert.equal(intactDns.operation, "dns:list");
  assert.equal(intactDns.retryable, true);
  assert.doesNotMatch(
    intactDns.message,
    /credential verification|supplied credentials|intact-dns-secret/i,
  );

  const legacyDnsProvider = normalizeRequestError(
    {
      code: "AUTH_REQUEST_FAILED",
      kind: "provider",
      source: "cloudflare",
      operation: "dns:list",
      retryable: false,
      message: "authentication failed token=legacy-provider-secret",
    },
    { source: "tauri", command: "get_dns_records" },
  );
  assert.equal(legacyDnsProvider.kind, "http");
  assert.equal(legacyDnsProvider.operation, "dns:list");
  assert.equal(legacyDnsProvider.retryable, false);
  assert.match(
    legacyDnsProvider.message,
    /Cloudflare could not complete the requested operation/i,
  );
  assert.doesNotMatch(
    legacyDnsProvider.message,
    /credential verification|supplied credentials|legacy-provider-secret/i,
  );

  const incompleteDns = normalizeRequestError(
    {
      code: "AUTH_REQUEST_FAILED",
      operation: "dns:list",
      message: "authentication failed token=incomplete-dns-secret",
    },
    { source: "tauri", command: "get_dns_records" },
  );
  assert.equal(incompleteDns.operation, "dns:list");
  assert.doesNotMatch(
    incompleteDns.message,
    /credential verification|supplied credentials|incomplete-dns-secret/i,
  );

  const authOperation = normalizeRequestError(
    {
      code: "AUTH_REQUEST_FAILED",
      kind: "authentication",
      source: "cloudflare",
      operation: "auth:verify_token",
      message: "authentication failed token=auth-operation-secret",
    },
    { source: "tauri", command: "verify_token" },
  );
  assert.equal(authOperation.kind, "http");
  assert.equal(authOperation.retryable, false);
  assert.match(authOperation.message, /rejected the supplied credentials/i);
  assert.doesNotMatch(authOperation.message, /auth-operation-secret/i);

  const forbiddenStatus = normalizeRequestError(
    {
      code: "AUTH_REQUEST_FAILED",
      kind: "provider",
      status: 403,
      source: "cloudflare",
      operation: "dns:list",
      message: "forbidden token=status-secret",
    },
    { source: "tauri", command: "get_dns_records" },
  );
  assert.equal(forbiddenStatus.status, 403);
  assert.equal(forbiddenStatus.retryable, false);
  assert.match(forbiddenStatus.message, /credentials|permission/i);
  assert.doesNotMatch(forbiddenStatus.message, /status-secret/i);

  const malformedDns = normalizeRequestError(
    {
      code: "REQUEST_FAILED",
      kind: "malformed_response",
      status: 200,
      source: "cloudflare",
      operation: "dns:list",
      retryable: false,
      request_id: "dns-ray-safe-123",
      message: "Malformed DNS payload token=malformed-dns-secret",
      remediation: "Retry the DNS list token=malformed-remediation-secret",
    },
    { source: "tauri", command: "get_dns_records" },
  );
  const formattedMalformedDns = formatRequestError(malformedDns);
  assert.equal(malformedDns.kind, "malformed-response");
  assert.equal(malformedDns.status, 200);
  assert.equal(malformedDns.operation, "dns:list");
  assert.equal(malformedDns.command, "get_dns_records");
  assert.equal(malformedDns.requestId, "dns-ray-safe-123");
  assert.equal(malformedDns.retryable, false);
  assert.match(
    malformedDns.message,
    /Cloudflare returned a malformed response while listing DNS records/i,
  );
  assert.doesNotMatch(
    malformedDns.message,
    /authentication service|malformed-dns-secret|malformed-remediation-secret/i,
  );
  assert.match(formattedMalformedDns, /request ID dns-ray-safe-123/i);
  assert.doesNotMatch(
    formattedMalformedDns,
    /malformed-dns-secret|malformed-remediation-secret/i,
  );

  const malformedAuthentication = normalizeRequestError(
    {
      code: "AUTH_REQUEST_FAILED",
      kind: "malformed_response",
      status: 200,
      source: "cloudflare",
      operation: "auth:verify_token",
      retryable: false,
      request_id: "auth-ray-safe-456",
      message: "Malformed verification payload token=malformed-auth-secret",
    },
    { source: "tauri", command: "verify_token" },
  );
  assert.equal(malformedAuthentication.kind, "malformed-response");
  assert.equal(malformedAuthentication.status, 200);
  assert.equal(malformedAuthentication.operation, "auth:verify_token");
  assert.equal(malformedAuthentication.requestId, "auth-ray-safe-456");
  assert.equal(malformedAuthentication.retryable, false);
  assert.match(
    malformedAuthentication.message,
    /authentication service returned a malformed response/i,
  );
  assert.doesNotMatch(
    malformedAuthentication.message,
    /listing DNS records|malformed-auth-secret/i,
  );

  const malformedCloudflareOperation = normalizeRequestError(
    {
      code: "REQUEST_FAILED",
      kind: "malformed_response",
      status: 200,
      source: "cloudflare",
      operation: "zones:list",
      retryable: false,
      request_id: "zones-ray-safe-789",
      message: "Malformed zones payload token=malformed-zones-secret",
    },
    { source: "tauri", command: "get_zones" },
  );
  assert.equal(malformedCloudflareOperation.kind, "malformed-response");
  assert.equal(malformedCloudflareOperation.status, 200);
  assert.equal(malformedCloudflareOperation.operation, "zones:list");
  assert.equal(malformedCloudflareOperation.requestId, "zones-ray-safe-789");
  assert.equal(malformedCloudflareOperation.retryable, false);
  assert.match(
    malformedCloudflareOperation.message,
    /Cloudflare returned a malformed response for the requested operation/i,
  );
  assert.doesNotMatch(
    malformedCloudflareOperation.message,
    /authentication service|listing DNS records|malformed-zones-secret/i,
  );
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

test("summarizes HTML failures without exposing markup or secrets", () => {
  const response = new Response("", {
    status: 502,
    statusText: "Bad Gateway",
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const error = requestErrorFromResponse(
    response,
    "/verify-token",
    "<!doctype html><html><head><title>Proxy login</title></head><body><script>token=script-secret</script><h1>Gateway unavailable</h1><p>password=body-secret</p></body></html>",
    "POST",
    "https://backend.example.test/api/verify-token",
  );
  assert.equal(error.kind, "http");
  assert.equal(error.status, 502);
  assert.match(error.message, /HTML error page/i);
  assert.match(error.message, /Proxy login/);
  assert.match(error.message, /Gateway unavailable/);
  assert.doesNotMatch(
    error.message,
    /<html|<script|script-secret|body-secret/i,
  );

  const malformedHtml = malformedResponseError(
    "/verify-token",
    new SyntaxError("HTML body"),
    {
      operation: "POST",
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      responseKind: "unexpected-html",
    },
  );
  assert.match(malformedHtml.message, /HTML page instead of.*JSON/i);
  assert.match(malformedHtml.message, /reverse proxy route/i);
  assert.doesNotMatch(malformedHtml.message, /<html/i);
});

test("decodes HTML diagnostic entities exactly once without losing metadata", () => {
  const response = new Response("", {
    status: 502,
    statusText: "Bad Gateway",
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cf-ray": "ray-html-safe",
      "retry-after": "30",
    },
  });
  const error = requestErrorFromResponse(
    response,
    "/verify-token?token=hidden",
    [
      "<!doctype html><html><head><title>Proxy timeout</title></head><body>",
      "<p>Upstream &lt;edge&gt; says &quot;retry&quot; &amp; wait.</p>",
      "<p>Encoded marker: &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;</p>",
      "<p>Encoded terminal marker: &#27;[31m password=body-secret</p>",
      "</body></html>",
    ].join(""),
    "POST",
    "https://backend.example.test/api/verify-token?api_key=hidden",
  );

  assert.equal(error.kind, "http");
  assert.equal(error.source, "server");
  assert.equal(error.status, 502);
  assert.equal(error.statusText, "Bad Gateway");
  assert.equal(error.endpoint, "/verify-token");
  assert.equal(
    error.requestUrl,
    "https://backend.example.test/api/verify-token",
  );
  assert.equal(error.operation, "POST");
  assert.equal(error.requestId, "ray-html-safe");
  assert.equal(error.retryAfter, "30");
  assert.equal(error.retryable, true);
  assert.match(error.message, /HTML error page/i);
  assert.match(error.message, /Upstream <edge> says "retry" & wait\./);
  assert.match(
    error.message,
    /Encoded marker: &lt;script&gt;alert\(1\)&lt;\/script&gt;/,
  );
  assert.doesNotMatch(error.message, /Encoded marker: <script>/i);
  assert.match(error.message, /Encoded terminal marker: &#27;\[31m/);
  assert.equal(error.message.includes(`${String.fromCharCode(27)}[31m`), false);
  assert.doesNotMatch(error.message, /body-secret|hidden/);

  const formatted = formatRequestError(error);
  assert.match(formatted, /status 502 Bad Gateway/);
  assert.match(formatted, /request ID ray-html-safe/);
  assert.match(formatted, /retry after 30/);
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
