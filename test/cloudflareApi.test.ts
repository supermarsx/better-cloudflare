import assert from "node:assert/strict";
import { test } from "node:test";
import Cloudflare, { APIError } from "cloudflare";
import { CloudflareAPI } from "../src/lib/api/cloudflare.ts";

// Ensure web fetch shims are loaded for Cloudflare client

interface FetchCall {
  url: string;
  options: RequestInit & { body?: string };
}

test("createDNSRecord strips unknown fields", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
    url: string,
    options: RequestInit & { body?: string },
  ) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const api = new CloudflareAPI("token", "http://example.com");
  await api.createDNSRecord("zone", {
    id: "rec",
    zone_id: "zone",
    zone_name: "example.com",
    type: "A",
    name: "test",
    content: "1.2.3.4",
    ttl: 120,
    created_on: "now",
    modified_on: "now",
    proxied: true,
  });

  assert.equal(calls[0].url, "http://example.com/zones/zone/dns_records");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    type: "A",
    name: "test",
    content: "1.2.3.4",
    ttl: 120,
    proxied: true,
  });

  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
});

test("updateDNSRecord strips unknown fields", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
    url: string,
    options: RequestInit & { body?: string },
  ) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const api = new CloudflareAPI("token", "http://example.com");
  await api.updateDNSRecord("zone", "rec", {
    id: "rec",
    zone_id: "zone",
    zone_name: "example.com",
    type: "A",
    name: "test",
    content: "1.2.3.4",
    ttl: 120,
    created_on: "now",
    modified_on: "now",
    proxied: true,
  });

  assert.equal(calls[0].url, "http://example.com/zones/zone/dns_records/rec");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    type: "A",
    name: "test",
    content: "1.2.3.4",
    ttl: 120,
    proxied: true,
  });

  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
});

test("explicit DNS pagination returns only the requested Cloudflare page", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requestedPages: number[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? "1");
    requestedPages.push(page);
    const result =
      page === 1
        ? [
            {
              id: "one",
              type: "A",
              name: "one.example",
              content: "192.0.2.1",
            },
          ]
        : [
            {
              id: "two",
              type: "A",
              name: "two.example",
              content: "192.0.2.2",
            },
          ];
    return new Response(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result,
        result_info: {
          page,
          per_page: 1,
          count: result.length,
          total_count: 2,
          total_pages: 2,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const api = new CloudflareAPI("token", "http://example.com");
  const records = await api.getDNSRecords("zone", 1, 1);

  assert.deepEqual(
    records.map((record) => record.id),
    ["one"],
  );
  assert.deepEqual(requestedPages, [1]);
});

test("Cloudflare v7 API errors retain their status and provider details", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 1001, message: "invalid pagination request" }],
        messages: [],
        result: null,
      }),
      {
        status: 400,
        statusText: "Bad Request",
        headers: {
          "content-type": "application/json",
          "cf-ray": "review-ray",
        },
      },
    );

  const api = new CloudflareAPI("token", "http://example.com");
  await assert.rejects(api.getDNSRecords("zone", 1, 1), (error: unknown) => {
    assert.ok(error instanceof APIError);
    assert.ok(error instanceof Cloudflare.APIError);
    assert.equal(error.status, 400);
    assert.equal(error.headers?.get("cf-ray"), "review-ray");
    assert.deepEqual(error.errors, [
      { code: 1001, message: "invalid pagination request" },
    ]);
    return true;
  });
});
