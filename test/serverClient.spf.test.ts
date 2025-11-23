/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerClient } from '../src/lib/server-client';

test('ServerClient simulateSPF and getSPFGraph', async () => {
  const sc = new ServerClient('', 'http://localhost:8787/api', undefined, 5000);
  const originalFetch = (global as any).fetch;
  const fakeFetch: any = async (url: string) => {
    if (url.includes('/api/spf/simulate')) {
      return new Response(JSON.stringify({ result: 'pass', reasons: ['matched ip4'], lookups: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/api/spf/graph')) {
      return new Response(JSON.stringify({ nodes: [{ domain: 'example.com' }], edges: [], lookups: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(null, { status: 404 });
  };
  (global as any).fetch = fakeFetch;
  try {
    const sim = await sc.simulateSPF('example.com', '1.2.3.4');
    assert.equal(sim.result, 'pass');
    const graph = await sc.getSPFGraph('example.com');
    assert.ok((graph as any).nodes && (graph as any).nodes.length === 1);
  } finally {
    (global as any).fetch = originalFetch;
  }
});
