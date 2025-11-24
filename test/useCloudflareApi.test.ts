import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";

import { useCloudflareAPI } from "../src/hooks/use-cloudflare-api.ts";

interface FetchCallOptions {
  method?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface FetchCall {
  url: string;
  options: FetchCallOptions;
}

type HeadersLike = Record<string, string> & {
  get?: (key: string) => string | null;
};

test("verifyToken calls server endpoint", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  (
    globalThis as unknown as {
      fetch: (url: string, options: FetchCallOptions) => Promise<Response>;
    }
  ).fetch = async (url: string, options: FetchCallOptions) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  process.env.SERVER_API_BASE = "http://localhost:8787/api";

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI();
    return null;
  }
  act(() => {
    create(React.createElement(Wrapper));
  });

  const result = await api.verifyToken("token123");
  assert.equal(result, undefined);
  assert.equal(calls[0].url, "http://localhost:8787/api/verify-token");
  const headers = calls[0].options.headers as HeadersLike;
  const auth = headers.get
    ? headers.get("authorization")
    : headers.authorization;
  assert.equal(auth, "Bearer token123");

  delete process.env.SERVER_API_BASE;

  globalThis.fetch = originalFetch;
});

test("verifyToken uses email headers when provided", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  (
    globalThis as unknown as {
      fetch: (url: string, options: FetchCallOptions) => Promise<Response>;
    }
  ).fetch = async (url: string, options: FetchCallOptions) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  process.env.SERVER_API_BASE = "http://localhost:8787/api";

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI(undefined, "user@example.com");
    return null;
  }
  act(() => {
    create(React.createElement(Wrapper));
  });

  const result = await api.verifyToken("key", "user@example.com");
  assert.equal(result, undefined);
  const headers = calls[0].options.headers as HeadersLike;
  const key = headers.get ? headers.get("x-auth-key") : headers["x-auth-key"];
  const emailHeader = headers.get
    ? headers.get("x-auth-email")
    : headers["x-auth-email"];
  const bearer = headers.get
    ? headers.get("authorization")
    : headers.authorization;
  assert.equal(key, "key");
  assert.equal(emailHeader, "user@example.com");
  assert.equal(bearer, undefined);

  delete process.env.SERVER_API_BASE;
  globalThis.fetch = originalFetch;
});

test("createDNSRecord posts record for provided key", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  (
    globalThis as unknown as {
      fetch: (url: string, options: FetchCallOptions) => Promise<Response>;
    }
  ).fetch = async (url: string, options: FetchCallOptions) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: "rec" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  process.env.SERVER_API_BASE = "http://localhost:8787/api";

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI("abc");
    return null;
  }
  act(() => {
    create(React.createElement(Wrapper));
  });

  const record = await api.createDNSRecord("zone", {
    type: "A",
    name: "a",
    content: "1.2.3.4",
  });
  assert.equal(record.id, "rec");
  assert.equal(
    calls[0].url,
    "http://localhost:8787/api/zones/zone/dns_records",
  );
  assert.equal(calls[0].options.method, "POST");
  const headers2 = calls[0].options.headers as HeadersLike;
  const auth2 = headers2.get
    ? headers2.get("authorization")
    : headers2.authorization;
  assert.equal(auth2, "Bearer abc");

  delete process.env.SERVER_API_BASE;
  globalThis.fetch = originalFetch;
});

test("createDNSRecord posts record using email auth", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  (
    globalThis as unknown as {
      fetch: (url: string, options: FetchCallOptions) => Promise<Response>;
    }
  ).fetch = async (url: string, options: FetchCallOptions) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: "r2" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  process.env.SERVER_API_BASE = "http://localhost:8787/api";

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI("abc", "me@example.com");
    return null;
  }
  act(() => {
    create(React.createElement(Wrapper));
  });

  const record = await api.createDNSRecord("zone", {
    type: "A",
    name: "a",
    content: "1.2.3.4",
  });
  assert.equal(record.id, "r2");
  assert.equal(
    calls[0].url,
    "http://localhost:8787/api/zones/zone/dns_records",
  );
  const headers3 = calls[0].options.headers as HeadersLike;
  const keyHeader = headers3.get
    ? headers3.get("x-auth-key")
    : headers3["x-auth-key"];
  const emailHeader2 = headers3.get
    ? headers3.get("x-auth-email")
    : headers3["x-auth-email"];
  const bearer2 = headers3.get
    ? headers3.get("authorization")
    : headers3.authorization;
  assert.equal(keyHeader, "abc");
  assert.equal(emailHeader2, "me@example.com");
  assert.equal(bearer2, undefined);

  delete process.env.SERVER_API_BASE;
  globalThis.fetch = originalFetch;
});
