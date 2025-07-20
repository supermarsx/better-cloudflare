import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { useCloudflareAPI } from '../src/hooks/use-cloudflare-api.ts';

interface FetchCallOptions {
  method?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface FetchCall {
  url: string;
  options: FetchCallOptions;
}

interface MockResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

test('verifyToken calls Cloudflare endpoint', async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: (url: string, options: FetchCallOptions) => Promise<MockResponse> }).fetch = async (url: string, options: FetchCallOptions) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ success: true }) } as MockResponse;
  };

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI();
    return null;
  }
  act(() => {
    create(React.createElement(Wrapper));
  });

  const result = await api.verifyToken('token123');
  assert.equal(result, true);
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/user/tokens/verify');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token123');

  globalThis.fetch = originalFetch;
});

test('verifyToken uses email headers when provided', async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: (url: string, options: FetchCallOptions) => Promise<MockResponse> }).fetch = async (url: string, options: FetchCallOptions) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ success: true }) } as MockResponse;
  };

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI(undefined, 'user@example.com');
    return null;
  }
  act(() => {
    create(React.createElement(Wrapper));
  });

  const result = await api.verifyToken('key', 'user@example.com');
  assert.equal(result, true);
  assert.equal(calls[0].options.headers['X-Auth-Key'], 'key');
  assert.equal(calls[0].options.headers['X-Auth-Email'], 'user@example.com');

  globalThis.fetch = originalFetch;
});

test('createDNSRecord posts record for provided key', async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: (url: string, options: FetchCallOptions) => Promise<MockResponse> }).fetch = async (url: string, options: FetchCallOptions) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ success: true, result: { id: 'rec' } }) } as MockResponse;
  };

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI('abc');
    return null;
  }
  act(() => {
    create(React.createElement(Wrapper));
  });

  const record = await api.createDNSRecord('zone', { type: 'A', name: 'a', content: '1.2.3.4' });
  assert.equal(record.id, 'rec');
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/zones/zone/dns_records');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer abc');

  globalThis.fetch = originalFetch;
});

test('createDNSRecord posts record using email auth', async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: (url: string, options: FetchCallOptions) => Promise<MockResponse> }).fetch = async (url: string, options: FetchCallOptions) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ success: true, result: { id: 'r2' } }) } as MockResponse;
  };

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI('abc', 'me@example.com');
    return null;
  }
  act(() => {
    create(React.createElement(Wrapper));
  });

  const record = await api.createDNSRecord('zone', { type: 'A', name: 'a', content: '1.2.3.4' });
  assert.equal(record.id, 'r2');
  assert.equal(calls[0].options.headers['X-Auth-Key'], 'abc');
  assert.equal(calls[0].options.headers['X-Auth-Email'], 'me@example.com');

  globalThis.fetch = originalFetch;
});
