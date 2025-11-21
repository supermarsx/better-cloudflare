import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSPF, composeSPF, validateSPF, SPFRecord, setDnsResolverForTest, ipMatchesCIDR } from '../src/lib/spf';
import { buildSPFGraphFromContent, validateSPFContentAsync, simulateSPF } from '../src/lib/spf';

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
  const mockResolver: import('../src/lib/spf').DNSResolver = {
    resolveTxt: async (_d: string) => ([['v=spf1 ip4:1.2.3.0/24 -all']]),
    resolve4: async (_d: string) => ['1.2.3.5'],
    resolve6: async (_d: string) => [],
    resolveMx: async (_d: string) => [],
    reverse: async (_ip: string) => [],
  } as any;
  setDnsResolverForTest(mockResolver);
  try {
    const res = await simulateSPF({ domain, ip: '1.2.3.5' });
    assert.equal(res.result, 'pass');
  } finally {
    setDnsResolverForTest(undefined);
  }
});

test('ipMatchesCIDR should support IPv6 CIDR matching', () => {
  assert.ok(ipMatchesCIDR('2001:db8::1', '2001:db8::/32'));
  assert.ok(!ipMatchesCIDR('2001:db9::1', '2001:db8::/32'));
});

test('composeSPF and parseSPF support add/edit/remove operations', () => {
  const base = 'v=spf1 ip4:1.2.3.0/24 -all';
  const parsed = parseSPF(base);
  assert.ok(parsed);
  // add an include
  const mechs = [...(parsed?.mechanisms ?? [])];
  mechs.push({ mechanism: 'include', value: 'inc.example' as any });
  const composed = composeSPF({ version: parsed?.version ?? 'v=spf1', mechanisms: mechs as any });
  
  const parsed2 = parseSPF(composed);
  
  assert.equal(parsed2?.mechanisms.some((m) => m.mechanism === 'include' && m.value === 'inc.example'), true);
  // edit the include to ip6 value
  const idx = parsed2?.mechanisms.findIndex((m) => m.mechanism === 'include') ?? -1;
  if (idx >= 0 && parsed2) {
    const mechs2 = [...parsed2.mechanisms];
    mechs2[idx] = { mechanism: 'ip6', value: '::1/128' } as any;
    const composed2 = composeSPF({ version: parsed2.version, mechanisms: mechs2 as any });
    const parsed3 = parseSPF(composed2);
    assert.equal(parsed3?.mechanisms.some((m) => m.mechanism === 'ip6' && m.value === '::1/128'), true);
    // remove the ip6
    const mechs3 = mechs2.filter((_, i) => i !== idx);
    const composed3 = composeSPF({ version: parsed3.version, mechanisms: mechs3 as any });
    const parsed4 = parseSPF(composed3);
    assert.equal(parsed4?.mechanisms.some((m) => m.mechanism === 'ip6' && m.value === '::1/128'), false);
  }
});

test('buildSPFGraphFromContent should build include nodes', async () => {
  const domain = 'example.org';
  const content = 'v=spf1 include:inc.example -all';
  const mockResolver: import('../src/lib/spf').DNSResolver = {
    resolveTxt: async (d: string) => (d === 'inc.example' ? [['v=spf1 ip4:1.2.3.0/24 -all']] : []),
    resolve4: async (_d: string) => [],
    resolve6: async (_d: string) => [],
    resolveMx: async (_d: string) => [],
    reverse: async (_ip: string) => [],
  } as any;
  setDnsResolverForTest(mockResolver);
  try {
    const graph = await buildSPFGraphFromContent(domain, content);
    assert.equal(graph.nodes.length >= 1, true);
    const includes = graph.edges.filter((e: any) => e.type === 'include');
    assert.equal(includes.length, 1);
  } finally {
    setDnsResolverForTest(undefined);
  }
});

test('validateSPFContentAsync should reject lookup limit', async () => {
  const domain = 'example.org';
  const content = 'v=spf1 include:one include:two include:three include:four include:five include:six include:seven include:eight include:nine include:ten include:eleven -all';
  const mockResolver: import('../src/lib/spf').DNSResolver = {
    resolveTxt: async (_d: string) => [['v=spf1 -all']],
    resolve4: async (_d: string) => [],
    resolve6: async (_d: string) => [],
    resolveMx: async (_d: string) => [],
    reverse: async (_ip: string) => [],
  } as any;
  setDnsResolverForTest(mockResolver);
  try {
    const res = await validateSPFContentAsync(content, domain, { maxLookups: 10 });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p: string) => p.indexOf('requires') !== -1 || p.indexOf('exceeds') !== -1 || p.indexOf('DNS lookups') !== -1));
  } finally {
    setDnsResolverForTest(undefined);
  }
});

test('simulateSPF should honor ptr with forward-confirmation', async () => {
  const domain = 'ptr.example';
  const mockResolver: import('../src/lib/spf').DNSResolver = {
    resolveTxt: async (_d: string) => ([['v=spf1 ptr:example.com -all']]),
    reverse: async (_ip: string) => ['example.com'],
    resolve4: async (d: string) => (d === 'example.com' ? ['1.2.3.4'] : []),
    resolve6: async (_d: string) => ([]),
    resolveMx: async (_d: string) => [],
  } as any;
  setDnsResolverForTest(mockResolver);
  try {
    const res = await simulateSPF({ domain, ip: '1.2.3.4' });
    assert.equal(res.result, 'pass');
  } finally {
    setDnsResolverForTest(undefined);
  }
});

test('simulateSPF should not match ptr without forward-confirmation', async () => {
  const domain = 'ptr.example';
  const mockResolver: import('../src/lib/spf').DNSResolver = {
    resolveTxt: async (_d: string) => ([['v=spf1 ptr:example.com -all']]),
    reverse: async (_ip: string) => ['example.com'],
    resolve4: async (_d: string) => ([]),
    resolve6: async (_d: string) => ([]),
    resolveMx: async (_d: string) => [],
  } as any;
  setDnsResolverForTest(mockResolver);
  try {
    const res = await simulateSPF({ domain, ip: '1.2.3.4' });
    assert.equal(res.result, 'fail');
  } finally {
    setDnsResolverForTest(undefined);
  }
});
