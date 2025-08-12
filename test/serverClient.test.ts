import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerClient } from '../src/lib/server-client.ts';

// Ensure web fetch shims are loaded if needed
import 'cloudflare/shims/web';

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
