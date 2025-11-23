import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerClient } from '../src/lib/server-client';

test('ServerClient simulateSPF and getSPFGraph', async () => {
  const sc = new ServerClient('', 'http://localhost:8787/api', undefined, 5000);
  const originalFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  const fakeFetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (url: string) => {
    if (url.includes('/api/spf/simulate')) {
      return new Response(JSON.stringify({ result: 'pass', reasons: ['matched ip4'], lookups: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/api/spf/graph')) {
      return new Response(JSON.stringify({ nodes: [{ domain: 'example.com' }], edges: [], lookups: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(null, { status: 404 });
  };
  (globalThis as unknown as { fetch?: typeof fetch }).fetch = fakeFetch;
  try {
    const sim = await sc.simulateSPF('example.com', '1.2.3.4');
    assert.equal(sim.result, 'pass');
    const graph = await sc.getSPFGraph('example.com');
    const g = graph as { nodes?: unknown[] };
    assert.ok(Array.isArray(g.nodes) && g.nodes.length === 1);
  } finally {
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = originalFetch;
  }
});
