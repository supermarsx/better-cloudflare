import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dnsRecordSchema } from '../src/lib/validation';

test('NAPTR content validated as "order preference flags service regexp replacement"', () => {
  const bad = dnsRecordSchema.safeParse({ type: 'NAPTR', name: 'naptr', content: 'bad' });
  assert.equal(bad.success, false);
  const badOrder = dnsRecordSchema.safeParse({ type: 'NAPTR', name: 'naptr', content: 'x 10 A S "!" example.com' });
  assert.equal(badOrder.success, false);
  const badPref = dnsRecordSchema.safeParse({ type: 'NAPTR', name: 'naptr', content: '10 x A S "!" example.com' });
  assert.equal(badPref.success, false);
  const ok = dnsRecordSchema.safeParse({ type: 'NAPTR', name: 'naptr', content: '10 20 A S "!" example.com' });
  assert.equal(ok.success, true);
});
