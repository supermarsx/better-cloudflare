import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "./testRenderer";

import { useCloudflareAPI } from "../src/hooks/dns/use-cloudflare-api.ts";

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

const TEST_WEB_API_BASE = "http://localhost:8787/api";

async function withConfiguredWebBackend(
  run: () => Promise<void>,
): Promise<void> {
  const previousApiBase = process.env.NEXT_PUBLIC_SERVER_API_BASE;
  const originalFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_SERVER_API_BASE = TEST_WEB_API_BASE;

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousApiBase === undefined) {
      delete process.env.NEXT_PUBLIC_SERVER_API_BASE;
    } else {
      process.env.NEXT_PUBLIC_SERVER_API_BASE = previousApiBase;
    }
  }
}

test("verifyToken calls server endpoint", async () => {
  await withConfiguredWebBackend(async () => {
    const calls: FetchCall[] = [];
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
    assert.equal(calls[0].url, `${TEST_WEB_API_BASE}/verify-token`);
    const headers = calls[0].options.headers as HeadersLike;
    const auth = headers.get
      ? headers.get("authorization")
      : headers.authorization;
    assert.equal(auth, "Bearer token123");
  });
});

test("verifyToken uses email headers when provided", async () => {
  await withConfiguredWebBackend(async () => {
    const calls: FetchCall[] = [];
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
  });
});

test("createDNSRecord posts record for provided key", async () => {
  await withConfiguredWebBackend(async () => {
    const calls: FetchCall[] = [];
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
    assert.equal(calls[0].url, `${TEST_WEB_API_BASE}/zones/zone/dns_records`);
    assert.equal(calls[0].options.method, "POST");
    const headers = calls[0].options.headers as HeadersLike;
    const auth = headers.get
      ? headers.get("authorization")
      : headers.authorization;
    assert.equal(auth, "Bearer abc");
  });
});

test("createDNSRecord posts record using email auth", async () => {
  await withConfiguredWebBackend(async () => {
    const calls: FetchCall[] = [];
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
    assert.equal(calls[0].url, `${TEST_WEB_API_BASE}/zones/zone/dns_records`);
    const headers = calls[0].options.headers as HeadersLike;
    const key = headers.get ? headers.get("x-auth-key") : headers["x-auth-key"];
    const email = headers.get
      ? headers.get("x-auth-email")
      : headers["x-auth-email"];
    const bearer = headers.get
      ? headers.get("authorization")
      : headers.authorization;
    assert.equal(key, "abc");
    assert.equal(email, "me@example.com");
    assert.equal(bearer, undefined);
  });
});
