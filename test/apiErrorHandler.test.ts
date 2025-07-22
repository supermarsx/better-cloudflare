import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';

import { apiRouter } from '../src/server/router.ts';

// Ensure fetch exists for Node
import 'cloudflare/shims/web';

test('missing credentials returns 400 error', async () => {
  const app = express();
  app.use(express.json());
  app.use(apiRouter);

  const server = app.listen(0);
  const { port } = server.address() as any;
  try {
    const res = await fetch(`http://localhost:${port}/api/zones`);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(/Missing Cloudflare credentials/.test(data.error));
  } finally {
    server.close();
  }
});
