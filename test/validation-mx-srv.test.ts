import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dnsRecordSchema } from '../src/lib/validation';

test('MX records require integer priority', () => {
  const missing = dnsRecordSchema.safeParse({ type: 'MX', name: 'mail', content: 'mail.example.com', ttl: 3600 });
  assert.equal(missing.success, false);
  const ok = dnsRecordSchema.safeParse({ type: 'MX', name: 'mail', content: 'mail.example.com', ttl: 3600, priority: 10 });
  assert.equal(ok.success, true);
  const badContent = dnsRecordSchema.safeParse({ type: 'MX', name: 'mail', content: 'bad host', ttl: 3600, priority: 10 });
  assert.equal(badContent.success, false);
});

test('SRV content validated as "priority weight port target"', () => {
  const bad = dnsRecordSchema.safeParse({ type: 'SRV', name: '_sip._tcp', content: 'not-valid' });
  assert.equal(bad.success, false);
  const ok = dnsRecordSchema.safeParse({ type: 'SRV', name: '_sip._tcp', content: '10 5 8080 host.example.com' });
  assert.equal(ok.success, true);
});

test('TLSA content validation', () => {
  const bad = dnsRecordSchema.safeParse({ type: 'TLSA', name: '_443._tcp', content: 'bad' });
  assert.equal(bad.success, false);
  const ok = dnsRecordSchema.safeParse({ type: 'TLSA', name: '_443._tcp', content: '3 1 1 a1b2c3' });
  assert.equal(ok.success, true);
});

test('SSHFP content validation', () => {
  const bad = dnsRecordSchema.safeParse({ type: 'SSHFP', name: 'host', content: 'x y z' });
  assert.equal(bad.success, false);
  const ok = dnsRecordSchema.safeParse({ type: 'SSHFP', name: 'host', content: '1 1 123abc' });
  assert.equal(ok.success, true);
});

test('A/AAAA records validate IP addresses', () => {
  const aOk = dnsRecordSchema.safeParse({ type: 'A', name: 'host', content: '1.2.3.4' });
  assert.equal(aOk.success, true);
  const aBad = dnsRecordSchema.safeParse({ type: 'A', name: 'host', content: 'not-ip' });
  assert.equal(aBad.success, false);
  const aaaaOk = dnsRecordSchema.safeParse({ type: 'AAAA', name: 'host', content: '::1' });
  assert.equal(aaaaOk.success, true);
  const aaaaBad = dnsRecordSchema.safeParse({ type: 'AAAA', name: 'host', content: '1.2.3.4' });
  assert.equal(aaaaBad.success, false);
});
