import { dnsRecordSchema } from '../src/lib/validation';
import { RECORD_TYPES } from '../src/types/dns';
import { test } from 'node:test';

test('debug dnsRecordSchema SPF failure', () => {
  for (const t of RECORD_TYPES) {
    const base: Record<string, unknown> = { type: t, name: 'test', content: 'x', ttl: 'auto' };
    if (t === 'A') base.content = '1.2.3.4';
    if (t === 'AAAA') base.content = '::1';
    if (t === 'MX') { base.content = 'mail.example.com'; base.priority = 10; }
    if (t === 'SRV') base.content = '10 5 8080 host.example.com';
    if (['CNAME', 'NS', 'PTR', 'ALIAS', 'ANAME', 'DS', 'DNSKEY', 'DNAME', 'CDNSKEY'].includes(t)) base.content = 'example.com';
    if (t === 'NAPTR') base.content = '10 20 A S ! example.com';
    if (t === 'SPF') base.content = 'v=spf1 ip4:1.2.3.0/24 -all';
    // safeParse expects a full typed object; cast here for the debug run
    const res = dnsRecordSchema.safeParse(base as unknown as object);
    if (!res.success) {
      console.log('FAILED TYPE', t, JSON.stringify(res.error.format(), null, 2));
    }
  }
});
