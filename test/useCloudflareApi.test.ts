import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { useCloudflareAPI } from '../src/hooks/use-cloudflare-api.ts';

test('verifyToken calls Cloudflare endpoint', async () => {
  const calls: any[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, options: any) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ success: true }) } as any;
  };

  let api: any;
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

test('createDNSRecord posts record for provided key', async () => {
  const calls: any[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, options: any) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ success: true, result: { id: 'rec' } }) } as any;
  };

  let api: any;
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
