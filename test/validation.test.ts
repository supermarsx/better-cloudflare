/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECORD_TYPES } from '../src/types/dns';
import { dnsRecordSchema } from '../src/lib/validation';

test('dnsRecordSchema accepts all known record types', () => {
  for (const t of RECORD_TYPES) {
    const base: Record<string, unknown> = { type: t, name: 'test', content: 'x', ttl: 'auto' };
    // provide sane defaults for types that require specific content
    if (t === 'A') base.content = '1.2.3.4';
    if (t === 'AAAA') base.content = '::1';
    if (t === 'MX') { base.content = 'mail.example.com'; base.priority = 10; }
    if (t === 'SRV') base.content = '10 5 8080 host.example.com';
    if (['CNAME', 'NS', 'PTR', 'ALIAS', 'ANAME', 'DS', 'DNSKEY', 'DNAME', 'CDNSKEY'].includes(t)) base.content = 'example.com';
    if (t === 'SPF') base.content = 'v=spf1 ip4:1.2.3.0/24 -all';
    if (t === 'NAPTR') base.content = '10 20 A S ! example.com';
    if (['TXT', 'CERT', 'URI', 'SVCB', 'HTTPS', 'HINFO', 'LOC', 'RP', 'CAA', 'AFSDB', 'APL', 'DCHID', 'HIP', 'IPSECKEY', 'NSEC', 'RRSIG'].includes(t)) base.content = 'x';
    if (t === 'SSHFP') base.content = '1 1 123abc';
    if (t === 'TLSA') base.content = '3 1 1 a1b2c3';
    if (t === 'SOA') base.content = 'ns.example.com hostmaster.example.com 1 7200 3600 1209600 3600';
    if (t === 'MX') {
      base.content = 'mail.example.com';
      base.priority = 10;
    }
    if (t === 'SRV') {
      base.content = '10 5 8080 host.example.com';
    }
    const res = dnsRecordSchema.safeParse(base as any);
    assert.ok(res.success, `type ${t} should be valid`);
  }
});
