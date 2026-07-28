import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestError } from "../src/lib/api/request-error.ts";
import { ServerClient } from "../src/lib/api/server-client.ts";

// Ensure web fetch shims are loaded if needed
import "cloudflare/shims/web";

const originalFetch = globalThis.fetch;

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
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText ?? "",
      headers: new Headers(response.headers),
      text: async () => {
        bodyReads += 1;
        return (
          response.text ??
          (response.body === undefined ? "" : JSON.stringify(response.body))
        );
      },
    } as Response;
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
    text: "bad token",
  });
  await assert.rejects(
    () => client.verifyToken(),
    /Request failed \(HTTP 403\) at \/verify-token: bad token/,
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
    /Request failed \(HTTP 500\) at \/zones: fail/,
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
    /Request failed \(HTTP 404\).*no records/,
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
    /Request failed \(HTTP 400\).*bad/,
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
    /Request failed \(HTTP 404\).*missing/,
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
    /Request failed \(HTTP 500\).*fail/,
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
          /cannot distinguish between offline connectivity, DNS, TLS, or CORS failures/,
        );
        assert.match(
          error.message,
          /Check your connection, the server address and certificate, and browser\/CORS settings/,
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
        /Server returned invalid JSON for a successful response/,
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
