import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudflareAPI } from "../src/lib/cloudflare.ts";

// Ensure web fetch shims are loaded for Cloudflare client
import "cloudflare/shims/web";

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
