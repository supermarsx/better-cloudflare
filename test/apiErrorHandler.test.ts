import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';

import { apiRouter } from '../src/server/router.ts';
import { errorHandler } from '../src/server/errorHandler.ts';
import { asyncHandler } from '../src/lib/async-handler.ts';

import type { AddressInfo } from 'node:net';

// Ensure fetch exists for Node
import 'cloudflare/shims/web';

test('missing credentials returns 400 error', async () => {
  const app = express();
  app.use(express.json());
  app.use(apiRouter);
  app.use(errorHandler);

  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://localhost:${port}/api/zones`);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(/Missing Cloudflare credentials/.test(data.error));
  } finally {
    server.close();
  }
});

test('generic errors return 500', async () => {
  const app = express();
  app.use(
    '/api/error',
    asyncHandler(async (_req, _res) => {
      void _req;
      void _res;
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
    assert.ok(/boom/.test(data.error));
  } finally {
    server.close();
  }
});
