import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import express from 'express';

import { asyncHandler } from '../src/lib/async-handler.ts';

import type { AddressInfo } from 'node:net';

import 'cloudflare/shims/web';

// Test without custom status and debug disabled

test('default 500 status and no stack trace when debug disabled', async () => {
  delete process.env.DEBUG_SERVER_API;
  const { errorHandler } = await import('../src/server/errorHandler.ts?nodebug');

  const log = mock.method(console, 'error', () => {});

  const app = express();
  app.get(
    '/api/error',
    asyncHandler(async (_req, _res) => {
      void _req; void _res;
      throw new Error('boom');
    }),
  );
  app.use(errorHandler);

  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://localhost:${port}/api/error`);
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.deepEqual(data, { error: 'boom' });
    assert.equal(log.mock.calls.length, 0);
  } finally {
    log.mock.restore();
    server.close();
  }
});

// Test with custom status and debug enabled

test('uses custom status and logs stack trace when debug enabled', async () => {
  process.env.DEBUG_SERVER_API = '1';
  const { errorHandler } = await import('../src/server/errorHandler.ts?debug');

  const log = mock.method(console, 'error', () => {});

  const app = express();
  app.get(
    '/api/error',
    asyncHandler(async (_req, _res) => {
      void _req; void _res;
      const err = new Error('teapot') as Error & { status: number };
      err.status = 418;
      throw err;
    }),
  );
  app.use(errorHandler);

  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://localhost:${port}/api/error`);
    assert.equal(res.status, 418);
    const data = await res.json();
    assert.deepEqual(data, { error: 'teapot' });
    assert.equal(log.mock.calls.length, 1);
  } finally {
    log.mock.restore();
    server.close();
    delete process.env.DEBUG_SERVER_API;
  }
});
