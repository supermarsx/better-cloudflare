import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerClient } from '../src/lib/server-client.ts';

// Ensure web fetch shims are loaded if needed
import 'cloudflare/shims/web';

const originalFetch = globalThis.fetch;

test('generates bearer token headers', () => {
  const client = new ServerClient('token', 'http://example.com');
  const headers = (
    client as unknown as { headers(): HeadersInit }
  ).headers();
  assert.deepEqual(headers, {
    authorization: 'Bearer token',
    'Content-Type': 'application/json',
  });
});

test('generates email and key headers', () => {
  const client = new ServerClient(
    'apiKey',
    'http://example.com',
    'user@example.com',
  );
  const headers = (
    client as unknown as { headers(): HeadersInit }
  ).headers();
  assert.deepEqual(headers, {
    'x-auth-key': 'apiKey',
    'x-auth-email': 'user@example.com',
    'Content-Type': 'application/json',
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
  globalThis.fetch = async (url: string | URL, init?: RequestInit) => {
    called = { url, init };
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText ?? '',
      headers: new Headers(response.headers),
      json: async () => response.body,
      text: async () => response.text ?? '',
    } as Response;
  };
  return () => {
    globalThis.fetch = originalFetch;
    return called!;
  };
}

test('verifyToken success and error', async () => {
  const client = new ServerClient('key', 'http://example.com');

  let restore = mockFetch({ ok: true, status: 200 });
  await client.verifyToken();
  const called = restore();
  assert.equal(called.url, 'http://example.com/verify-token');
  assert.equal(called.init?.method, 'POST');

  restore = mockFetch({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    text: 'bad token',
  });
  await assert.rejects(() => client.verifyToken(), /bad token/);
  restore();
});

test('getZones success and error', async () => {
  const client = new ServerClient('key', 'http://example.com');
  const zones = [{ id: '1', name: 'zone' }];

  let restore = mockFetch({
    ok: true,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: zones,
  });
  assert.deepEqual(await client.getZones(), zones);
  const called = restore();
  assert.equal(called.url, 'http://example.com/zones');

  restore = mockFetch({
    ok: false,
    status: 500,
    statusText: 'Server Error',
    text: 'fail',
  });
  await assert.rejects(() => client.getZones(), /fail/);
  restore();
});

test('getDNSRecords success and error', async () => {
  const client = new ServerClient('key', 'http://example.com');
  const records = [{ id: '1', name: 'rec' }];

  let restore = mockFetch({
    ok: true,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: records,
  });
  assert.deepEqual(await client.getDNSRecords('zone', undefined), records);
  const called = restore();
  assert.equal(called.url, 'http://example.com/zones/zone/dns_records');

  restore = mockFetch({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    text: 'no records',
  });
  await assert.rejects(
    () => client.getDNSRecords('zone', undefined),
    /no records/,
  );
  restore();
});

test('createDNSRecord success and error', async () => {
  const client = new ServerClient('key', 'http://example.com');
  const record = { id: '1', name: 'a' };

  let restore = mockFetch({
    ok: true,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: record,
  });
  assert.deepEqual(
    await client.createDNSRecord('zone', record, undefined),
    record,
  );
  const called = restore();
  assert.equal(called.url, 'http://example.com/zones/zone/dns_records');
  assert.equal(called.init?.method, 'POST');

  restore = mockFetch({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: 'bad',
  });
  await assert.rejects(
    () => client.createDNSRecord('zone', record, undefined),
    /bad/,
  );
  restore();
});

test('updateDNSRecord success and error', async () => {
  const client = new ServerClient('key', 'http://example.com');
  const record = { id: '1', name: 'a' };

  let restore = mockFetch({
    ok: true,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: record,
  });
  assert.deepEqual(
    await client.updateDNSRecord('zone', '1', record, undefined),
    record,
  );
  const called = restore();
  assert.equal(
    called.url,
    'http://example.com/zones/zone/dns_records/1',
  );
  assert.equal(called.init?.method, 'PUT');

  restore = mockFetch({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    text: 'missing',
  });
  await assert.rejects(
    () => client.updateDNSRecord('zone', '1', record, undefined),
    /missing/,
  );
  restore();
});

test('deleteDNSRecord success and error', async () => {
  const client = new ServerClient('key', 'http://example.com');

  let restore = mockFetch({ ok: true, status: 200 });
  await client.deleteDNSRecord('zone', '1', undefined);
  const called = restore();
  assert.equal(
    called.url,
    'http://example.com/zones/zone/dns_records/1',
  );
  assert.equal(called.init?.method, 'DELETE');

  restore = mockFetch({
    ok: false,
    status: 500,
    statusText: 'Server Error',
    text: 'fail',
  });
  await assert.rejects(
    () => client.deleteDNSRecord('zone', '1', undefined),
    /fail/,
  );
  restore();
});
