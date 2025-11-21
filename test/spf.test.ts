import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSPF, composeSPF, validateSPF, SPFRecord } from '../src/lib/spf';
import { buildSPFGraphFromContent, validateSPFContentAsync, simulateSPF } from '../src/lib/spf';
import { promises as dnsPromises } from 'node:dns';

test('parseSPF should parse mechanisms', () => {
  const input = 'v=spf1 ip4:1.2.3.0/24 include:example.com -all';
  const parsed = parseSPF(input);
  assert.ok(parsed);
  assert.equal(parsed?.version, 'v=spf1');
  assert.equal(parsed?.mechanisms.length, 3);
  assert.equal(parsed?.mechanisms[0].mechanism, 'ip4');
  assert.equal(parsed?.mechanisms[1].mechanism, 'include');
});

test('composeSPF should create spf string from record', () => {
  const rec: SPFRecord = {
    version: 'v=spf1',
    mechanisms: [
      { mechanism: 'ip4', value: '1.2.3.0/24' },
      { mechanism: 'all' }
    ]
  };
  const s = composeSPF(rec);
  assert.ok(s.startsWith('v=spf1'));
});

test('validateSPF should flag errors when missing prefix', () => {
  const res = validateSPF('ip4:1.2.3.4');
  assert.equal(res.ok, false);
});

test('validateSPF should accept valid spf', () => {
  const res = validateSPF('v=spf1 ip4:1.2.3.0/24 -all');
  assert.equal(res.ok, true);
});

test('simulateSPF should detect ip4 pass', async () => {
  const domain = 'example.local';
  // stub DNS to avoid network calls
  const originalResolveTxt = dnsPromises.resolveTxt;
  const originalResolve4 = dnsPromises.resolve4;
  try {
    // SPF record for domain contains an ip4 mechanism
    dnsPromises.resolveTxt = async (d: string) => ([['v=spf1 ip4:1.2.3.0/24 -all']]);
    // No A/AAAA records needed
    dnsPromises.resolve4 = async (d: string) => ['1.2.3.5'];
    const res = await simulateSPF({ domain, ip: '1.2.3.5' });
    assert.equal(res.result, 'pass');
  } finally {
    dnsPromises.resolveTxt = originalResolveTxt;
    dnsPromises.resolve4 = originalResolve4;
  }
});

test('buildSPFGraphFromContent should build include nodes', async () => {
  const domain = 'example.org';
  const content = 'v=spf1 include:inc.example -all';
  const originalResolveTxt = dnsPromises.resolveTxt;
  try {
    dnsPromises.resolveTxt = async (d: string) => {
      if (d === 'inc.example') return [['v=spf1 ip4:1.2.3.0/24 -all']];
      return [];
    };
    const graph = await buildSPFGraphFromContent(domain, content);
    assert.equal(graph.nodes.length >= 1, true);
    const includes = graph.edges.filter((e: any) => e.type === 'include');
    assert.equal(includes.length, 1);
  } finally {
    dnsPromises.resolveTxt = originalResolveTxt;
  }
});

test('validateSPFContentAsync should reject lookup limit', async () => {
  const domain = 'example.org';
  const content = 'v=spf1 include:one include:two include:three include:four include:five include:six include:seven include:eight include:nine include:ten include:eleven -all';
  const originalResolveTxt = dnsPromises.resolveTxt;
  try {
    dnsPromises.resolveTxt = async (d: string) => [['v=spf1 -all']];
    const res = await validateSPFContentAsync(content, domain, { maxLookups: 10 });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p: string) => p.indexOf('requires') !== -1 || p.indexOf('exceeds') !== -1 || p.indexOf('DNS lookups') !== -1));
  } finally {
    dnsPromises.resolveTxt = originalResolveTxt;
  }
});
