import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "./testRenderer";

import { useCloudflareAPI } from "../src/hooks/dns/use-cloudflare-api.ts";
import { RequestError } from "../src/lib/api/request-error.ts";

interface FetchCallOptions {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
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

test("checkDnsPropagation forwards caller cancellation through the hook and ServerClient", async () => {
  await withConfiguredWebBackend(async () => {
    let requestSignal: AbortSignal | undefined;
    let requestUrl: string | undefined;
    let requestBody: string | undefined;
    (
      globalThis as unknown as {
        fetch: (url: string, options: FetchCallOptions) => Promise<Response>;
      }
    ).fetch = async (url: string, options: FetchCallOptions) =>
      new Promise<Response>((_resolve, reject) => {
        requestUrl = url;
        requestBody =
          typeof options.body === "string" ? options.body : undefined;
        requestSignal = options.signal;
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });

    let api: ReturnType<typeof useCloudflareAPI>;
    function Wrapper() {
      api = useCloudflareAPI("abc");
      return null;
    }
    act(() => {
      create(React.createElement(Wrapper));
    });

    const caller = new AbortController();
    const request = api.checkDnsPropagation(
      "example.com",
      "A",
      ["9.9.9.9"],
      caller.signal,
    );
    assert.ok(requestSignal);
    assert.notEqual(requestSignal, caller.signal);

    caller.abort();
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

    assert.equal(requestSignal.aborted, true);
    assert.equal(requestUrl, `${TEST_WEB_API_BASE}/dns/propagation`);
    assert.deepEqual(JSON.parse(requestBody ?? ""), {
      domain: "example.com",
      record_type: "A",
      extra_resolvers: ["9.9.9.9"],
    });
  });
});
