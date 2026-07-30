import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { RequestError } from "../src/lib/api/request-error.ts";
import { ServerClient } from "../src/lib/api/server-client.ts";
import { RESOURCE_LIMITS } from "../src/lib/resource-limits.ts";
import { TauriClient } from "../src/lib/api/tauri-client.ts";

// Ensure web fetch shims are loaded if needed
import "cloudflare/shims/web";

const originalFetch = globalThis.fetch;

test("desktop adapter forwards AbortSignal and rejects stale native results promptly", async () => {
  const testWindow = window as typeof window & { __TAURI__?: unknown };
  const previousTauri = testWindow.__TAURI__;
  testWindow.__TAURI__ = {};
  let receivedSignal: AbortSignal | undefined;
  mock.method(
    TauriClient,
    "getZones",
    async (
      _apiKey: string,
      _email?: string,
      signal?: AbortSignal,
    ): Promise<never> => {
      receivedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    },
  );

  try {
    const controller = new AbortController();
    const request = new ServerClient("token").getZones(controller.signal);
    controller.abort();
    await assert.rejects(request, { name: "AbortError" });
    assert.equal(receivedSignal, controller.signal);
    assert.equal(receivedSignal?.aborted, true);
  } finally {
    mock.restoreAll();
    if (previousTauri === undefined) {
      delete testWindow.__TAURI__;
    } else {
      testWindow.__TAURI__ = previousTauri;
    }
  }
});

test("generates bearer token headers", () => {
  const client = new ServerClient("token", "http://example.com");
  const headers = (client as unknown as { headers(): HeadersInit }).headers();
  assert.deepEqual(headers, {
    authorization: "Bearer token",
    "Content-Type": "application/json",
  });
});

test("generates email and key headers", () => {
  const client = new ServerClient(
    "apiKey",
    "http://example.com",
    "user@example.com",
  );
  const headers = (client as unknown as { headers(): HeadersInit }).headers();
  assert.deepEqual(headers, {
    "x-auth-key": "apiKey",
    "x-auth-email": "user@example.com",
    "Content-Type": "application/json",
  });
});

test("constructs without a static web backend and fails before fetch", async () => {
  const previous = process.env.NEXT_PUBLIC_SERVER_API_BASE;
  delete process.env.NEXT_PUBLIC_SERVER_API_BASE;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called");
  };
  try {
    const client = new ServerClient("token");
    await assert.rejects(
      () => client.getZones(),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "configuration");
        assert.equal(error.retryable, false);
        assert.match(error.message, /NEXT_PUBLIC_SERVER_API_BASE/);
        assert.match(error.message, /will not guess a localhost proxy/i);
        return true;
      },
    );
    assert.equal(fetchCalls, 0);
    assert.throws(
      () => new ServerClient("token", "file:///unsafe"),
      /absolute HTTP\(S\) URL/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_SERVER_API_BASE;
    } else {
      process.env.NEXT_PUBLIC_SERVER_API_BASE = previous;
    }
  }
});

test("uses an explicitly configured Next public backend", async () => {
  const previous = process.env.NEXT_PUBLIC_SERVER_API_BASE;
  process.env.NEXT_PUBLIC_SERVER_API_BASE =
    "https://configured.example.test/api/";
  const restore = mockFetch({ ok: true, status: 204 });
  try {
    const client = new ServerClient("token");
    await client.verifyToken();
    assert.equal(
      restore().url,
      "https://configured.example.test/api/verify-token",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_SERVER_API_BASE;
    } else {
      process.env.NEXT_PUBLIC_SERVER_API_BASE = previous;
    }
  }
});

function mockFetch(response: {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
  text?: string;
}) {
  let called: { url: string | URL; init?: RequestInit } | undefined;
  let bodyReads = 0;
  globalThis.fetch = async (url: string | URL, init?: RequestInit) => {
    called = { url, init };
    const responseText =
      response.text ??
      (response.body === undefined ? "" : JSON.stringify(response.body));
    const bytes = new TextEncoder().encode(responseText);
    assert.ok(
      bytes.byteLength <= RESOURCE_LIMITS.responseBody.hardBytes,
      "mock response must remain within the production response-body limit",
    );
    const body =
      bytes.byteLength === 0
        ? null
        : new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(bytes);
              controller.close();
              bodyReads += 1;
            },
          });
    const actualResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText ?? "",
      headers: response.headers,
    });
    assert.equal(
      actualResponse.ok,
      response.ok,
      "mock status and expected ok value must agree",
    );
    return actualResponse;
  };
  return () => {
    globalThis.fetch = originalFetch;
    return { ...called!, bodyReads };
  };
}

test("verifyToken success and error", async () => {
  const client = new ServerClient("key", "http://example.com");

  let restore = mockFetch({ ok: true, status: 200 });
  await client.verifyToken();
  const called = restore();
  assert.equal(called.url, "http://example.com/verify-token");
  assert.equal(called.init?.method, "POST");

  restore = mockFetch({
    ok: false,
    status: 403,
    statusText: "Forbidden",
    headers: {
      "cf-ray": "ray-login",
      "retry-after": "30",
    },
    text: "bad token",
  });
  await assert.rejects(
    () => client.verifyToken(),
    (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.status, 403);
      assert.equal(error.statusText, "Forbidden");
      assert.equal(error.requestId, "ray-login");
      assert.equal(error.retryAfter, "30");
      assert.equal(error.requestUrl, "http://example.com/verify-token");
      assert.match(error.message, /denied this operation/i);
      assert.match(error.message, /bad token/);
      return true;
    },
  );
  restore();
});

test("getZones success and error", async () => {
  const client = new ServerClient("key", "http://example.com");
  const zones = [{ id: "1", name: "zone" }];

  let restore = mockFetch({
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    body: zones,
  });
  assert.deepEqual(await client.getZones(), zones);
  const called = restore();
  assert.equal(called.url, "http://example.com/zones");
  assert.equal(called.bodyReads, 1);

  restore = mockFetch({
    ok: false,
    status: 500,
    statusText: "Server Error",
    text: "fail",
  });
  await assert.rejects(
    () => client.getZones(),
    /backend or upstream service failed.*HTTP 500 Server Error.*fail/i,
  );
  restore();
});

test("getDNSRecords success and error", async () => {
  const client = new ServerClient("key", "http://example.com");
  const records = [{ id: "1", name: "rec" }];

  let restore = mockFetch({
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    body: records,
  });
  assert.deepEqual(await client.getDNSRecords("zone", undefined), records);
  const called = restore();
  assert.equal(called.url, "http://example.com/zones/zone/dns_records");

  restore = mockFetch({
    ok: false,
    status: 404,
    statusText: "Not Found",
    text: "no records",
  });
  await assert.rejects(
    () => client.getDNSRecords("zone", undefined),
    /backend endpoint was not found.*HTTP 404 Not Found.*no records/i,
  );
  restore();
});

test("createDNSRecord success and error", async () => {
  const client = new ServerClient("key", "http://example.com");
  const record = { id: "1", name: "a" };

  let restore = mockFetch({
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    body: record,
  });
  assert.deepEqual(
    await client.createDNSRecord("zone", record, undefined),
    record,
  );
  const called = restore();
  assert.equal(called.url, "http://example.com/zones/zone/dns_records");
  assert.equal(called.init?.method, "POST");

  restore = mockFetch({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    text: "bad",
  });
  await assert.rejects(
    () => client.createDNSRecord("zone", record, undefined),
    /Request failed \(HTTP 400 Bad Request\).*bad/,
  );
  restore();
});

test("updateDNSRecord success and error", async () => {
  const client = new ServerClient("key", "http://example.com");
  const record = { id: "1", name: "a" };

  let restore = mockFetch({
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    body: record,
  });
  assert.deepEqual(
    await client.updateDNSRecord("zone", "1", record, undefined),
    record,
  );
  const called = restore();
  assert.equal(called.url, "http://example.com/zones/zone/dns_records/1");
  assert.equal(called.init?.method, "PUT");

  restore = mockFetch({
    ok: false,
    status: 404,
    statusText: "Not Found",
    text: "missing",
  });
  await assert.rejects(
    () => client.updateDNSRecord("zone", "1", record, undefined),
    /backend endpoint was not found.*HTTP 404 Not Found.*missing/i,
  );
  restore();
});

test("deleteDNSRecord success and error", async () => {
  const client = new ServerClient("key", "http://example.com");

  let restore = mockFetch({ ok: true, status: 200 });
  await client.deleteDNSRecord("zone", "1", undefined);
  const called = restore();
  assert.equal(called.url, "http://example.com/zones/zone/dns_records/1");
  assert.equal(called.init?.method, "DELETE");

  restore = mockFetch({
    ok: false,
    status: 500,
    statusText: "Server Error",
    text: "fail",
  });
  await assert.rejects(
    () => client.deleteDNSRecord("zone", "1", undefined),
    /backend or upstream service failed.*HTTP 500 Server Error.*fail/i,
  );
  restore();
});

test("includes Cloudflare JSON error details", async () => {
  const client = new ServerClient("key", "http://example.com");
  const restore = mockFetch({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    headers: { "content-type": "application/json" },
    body: {
      errors: [
        { code: 1001, message: "bad request" },
        { code: 1002, message: "second provider detail" },
      ],
    },
  });
  await assert.rejects(
    () => client.getZones(),
    (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.kind, "http");
      assert.equal(error.source, "cloudflare");
      assert.equal(error.status, 400);
      assert.equal(error.endpoint, "/zones");
      assert.equal(error.operation, "GET");
      assert.equal(error.retryable, false);
      assert.deepEqual(error.providerCodes, ["1001", "1002"]);
      assert.deepEqual(error.providerMessages, [
        "bad request",
        "second provider detail",
      ]);
      assert.match(
        error.message,
        /1001: bad request; 1002: second provider detail$/,
      );
      return true;
    },
  );
  assert.equal(restore().bodyReads, 1);
});

test("aborts request after timeout", async () => {
  const client = new ServerClient("key", "http://example.com", undefined, 5);
  let aborted = false;
  globalThis.fetch = async (_url: string | URL, init?: RequestInit) =>
    new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  try {
    await assert.rejects(
      () => client.getZones(),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "timeout");
        assert.equal(error.source, "client");
        assert.equal(error.endpoint, "/zones");
        assert.equal(error.operation, "GET");
        assert.equal(error.retryable, true);
        assert.match(error.message, /Request timed out/);
        return true;
      },
    );
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps the timeout active when a caller supplies an AbortSignal", async () => {
  const client = new ServerClient("key", "http://example.com", undefined, 5);
  const caller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = async (_url: string | URL, init?: RequestInit) =>
    new Promise<never>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  try {
    await assert.rejects(
      () => client.getZones(caller.signal),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "timeout");
        assert.equal(error.retryable, true);
        assert.match(error.message, /timed out/i);
        return true;
      },
    );
    assert.equal(caller.signal.aborted, false);
    assert.equal(requestSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkDnsPropagation preserves caller cancellation when rejection follows the timeout deadline", async () => {
  const client = new ServerClient("key", "http://example.com", undefined, 5);
  const caller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  let rejectFetch: ((reason?: unknown) => void) | undefined;
  globalThis.fetch = async (_url: string | URL, init?: RequestInit) =>
    new Promise<never>((_resolve, reject) => {
      requestSignal = init?.signal;
      rejectFetch = reject;
    });

  try {
    const request = client.checkDnsPropagation(
      "example.com",
      "A",
      undefined,
      caller.signal,
    );
    assert.ok(requestSignal);
    assert.notEqual(requestSignal, caller.signal);

    caller.abort();
    assert.equal(requestSignal.aborted, true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    rejectFetch?.(new DOMException("cancelled", "AbortError"));

    await assert.rejects(
      () => request,
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "aborted");
        assert.equal(error.endpoint, "/dns/propagation");
        assert.equal(error.operation, "POST");
        assert.equal(error.retryable, false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkDnsPropagation removes caller listeners and clears its timeout after completion", async () => {
  const client = new ServerClient("key", "http://example.com", undefined, 20);
  const caller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url: string | URL, init?: RequestInit) => {
    requestSignal = init?.signal;
    return new Response(JSON.stringify({ resolvers: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await client.checkDnsPropagation(
      "example.com",
      "A",
      undefined,
      caller.signal,
    );
    assert.ok(requestSignal);
    assert.equal(requestSignal.aborted, false);

    caller.abort();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(requestSignal.aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes network failures and explicit cancellation", async () => {
  const client = new ServerClient("key", "http://example.com");
  try {
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(
      () => client.getZones(),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "network");
        assert.equal(error.source, "browser");
        assert.equal(error.operation, "GET");
        assert.equal(error.retryable, true);
        assert.match(
          error.message,
          /offline connectivity, DNS, TLS, CORS, or a stopped backend/,
        );
        return true;
      },
    );

    const controller = new AbortController();
    globalThis.fetch = async (_url: string | URL, init?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("cancelled", "AbortError"));
        });
      });
    const request = client.getZones(controller.signal);
    controller.abort();
    await assert.rejects(
      () => request,
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "aborted");
        assert.equal(error.source, "client");
        assert.equal(error.endpoint, "/zones");
        assert.equal(error.operation, "GET");
        assert.equal(error.retryable, false);
        assert.match(
          error.message,
          /Request was cancelled\. Retry when you are ready\. \(\/zones\)/,
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects successful HTML and summarizes failed HTML responses", async () => {
  const client = new ServerClient("key", "http://example.com");
  try {
    globalThis.fetch = async () =>
      new Response(
        "<!doctype html><html><head><title>Proxy login</title></head><body>password=hidden-value</body></html>",
        {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/html" },
        },
      );
    await assert.rejects(
      () => client.getZones(),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "malformed-response");
        assert.equal(error.status, 200);
        assert.match(error.message, /HTML page instead of.*JSON/i);
        assert.match(error.message, /reverse proxy route/i);
        assert.doesNotMatch(error.message, /<html|hidden-value/i);
        return true;
      },
    );

    globalThis.fetch = async () =>
      new Response(
        "<html><head><title>Bad gateway</title></head><body>Proxy unavailable api_key=hidden-value</body></html>",
        {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "content-type": "text/html" },
        },
      );
    await assert.rejects(
      () => client.getZones(),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "http");
        assert.equal(error.status, 502);
        assert.match(error.message, /HTML error page/i);
        assert.match(error.message, /Bad gateway/);
        assert.doesNotMatch(error.message, /<html|hidden-value/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects malformed JSON after reading the response body once", async () => {
  const client = new ServerClient("key", "http://example.com");
  const restore = mockFetch({
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    text: "{not-json",
  });
  await assert.rejects(
    () => client.getZones(),
    (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.kind, "malformed-response");
      assert.equal(error.source, "server");
      assert.equal(error.status, 200);
      assert.equal(error.endpoint, "/zones");
      assert.equal(error.operation, "GET");
      assert.equal(error.retryable, true);
      assert.match(
        error.message,
        /server returned invalid JSON for a successful response/i,
      );
      return true;
    },
  );
  assert.equal(restore().bodyReads, 1);
});

test("listPasskeys and deletePasskey", async () => {
  const client = new ServerClient("key", "http://example.com");
  const passkeys = [
    { id: "cid1", counter: 0 },
    { id: "cid2", counter: 2 },
  ];

  let restore = mockFetch({
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    body: passkeys,
  });
  assert.deepEqual(await client.listPasskeys("keyid"), passkeys);
  const called = restore();
  assert.equal(called.url, "http://example.com/passkeys/keyid");

  restore = mockFetch({ ok: true, status: 200 });
  await client.deletePasskey("keyid", "cid1");
  const called2 = restore();
  assert.equal(called2.url, "http://example.com/passkeys/keyid/cid1");
  assert.equal(called2.init?.method, "DELETE");
});

test("listPasskeys forwards cancellation to fetch", async () => {
  const client = new ServerClient("key", "http://example.com");
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url: string | URL, init?: RequestInit) =>
    new Promise<never>((_resolve, reject) => {
      receivedSignal = init?.signal;
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("cancelled", "AbortError"));
      });
    });

  try {
    const request = client.listPasskeys("keyid", controller.signal);
    controller.abort();
    await assert.rejects(
      () => request,
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "aborted");
        assert.equal(error.endpoint, "/passkeys/keyid");
        assert.equal(error.operation, "GET");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.ok(receivedSignal);
    assert.notEqual(receivedSignal, controller.signal);
    assert.equal(receivedSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getVaultSecret sends passkey token when provided", async () => {
  const client = new ServerClient("", "http://example.com");
  const restore = mockFetch({
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    body: { secret: "s" },
  });
  const secret = await client.getVaultSecret("id1", "ptok");
  assert.equal(secret, "s");
  const called = restore();
  const headers = called.init?.headers as Record<string, string>;
  assert.equal(headers["x-passkey-token"], "ptok");
});

test("oversized responses preserve request context, retryability, and reader cancellation", async () => {
  const client = new ServerClient("key", "http://example.com");
  let cancellations = 0;
  const oversizedResponse = (status: number, statusText: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          cancellations += 1;
        },
      }),
      {
        status,
        statusText,
        headers: {
          "content-type": "application/json",
          "content-length": String(RESOURCE_LIMITS.responseBody.hardBytes + 1),
          "x-request-id": `oversized-${status}`,
        },
      },
    );

  try {
    globalThis.fetch = async () =>
      oversizedResponse(503, "Service Unavailable");
    await assert.rejects(
      () => client.getZones(),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "malformed-response");
        assert.equal(error.code, "RESPONSE_TOO_LARGE");
        assert.equal(error.status, 503);
        assert.equal(error.statusText, "Service Unavailable");
        assert.equal(error.endpoint, "/zones");
        assert.equal(error.requestUrl, "http://example.com/zones");
        assert.equal(error.operation, "GET");
        assert.equal(error.requestId, "oversized-503");
        assert.equal(error.retryable, true);
        assert.match(error.message, /Request a smaller page/i);
        return true;
      },
    );

    globalThis.fetch = async () => oversizedResponse(200, "OK");
    await assert.rejects(
      () => client.getZones(),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.status, 200);
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(cancellations, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves caller cancellation while a bounded response body is streaming", async () => {
  const client = new ServerClient("key", "http://example.com");
  const caller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;

  try {
    globalThis.fetch = async (_url: string | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("["));
            init?.signal?.addEventListener(
              "abort",
              () =>
                controller.error(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const request = client.getZones(caller.signal);
    caller.abort();
    await assert.rejects(
      () => request,
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "aborted");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(requestSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
