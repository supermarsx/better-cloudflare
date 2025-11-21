import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dnsRecordSchema } from '../src/lib/validation';

test('NAPTR quoted regexp is accepted', () => {
  const ok = dnsRecordSchema.safeParse({ type: 'NAPTR', name: 'foo', content: '10 20 A S "!^.*$!" example.com' });
  assert.equal(ok.success, true);
});
