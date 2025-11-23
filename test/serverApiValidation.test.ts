// prefer unknown in tests
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { ServerAPI } from '../src/lib/server-api.ts';
import { CloudflareAPI } from '../src/lib/cloudflare.ts';

function createReq(body: unknown, params: Record<string, string>): Request {
  return {
    body,
    params,
    header(name: string) {
      return name === 'authorization' ? 'Bearer token' : undefined;
    },
  } as unknown as Request;
}

function createRes() {
  let statusCode: number | undefined;
  let jsonData: unknown;
  const res: Partial<Response> = {
    status(code: number) {
      statusCode = code;
      return this as Response;
    },
    json(data: unknown) {
      jsonData = data;
    },
  };
  return { res: res as Response, get status() { return statusCode; }, get data() { return jsonData; } };
}

test('createDNSRecord validation', async () => {
  const handler = ServerAPI.createDNSRecord();
  const orig = CloudflareAPI.prototype.createDNSRecord;
  let called = false;
  CloudflareAPI.prototype.createDNSRecord = async (_zone: string, record: unknown) => {
    called = true;
    const rec = typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {};
    return { id: '1', ...rec } as unknown;
  } as unknown as (zone: string, record: unknown) => Promise<unknown>;

  // Valid payload
  const validReq = createReq(
    { type: 'A', name: 'test', content: '1.2.3.4' },
    { zone: 'zone' },
  );
  const validRes = createRes();
  await handler(validReq, validRes.res);
  assert.equal(validRes.status, undefined);
  assert.deepEqual(validRes.data, {
    id: '1',
    type: 'A',
    name: 'test',
    content: '1.2.3.4',
  });
  assert.equal(called, true);

  // Invalid payload
  called = false;
  const invalidReq = createReq({ type: 'A' }, { zone: 'zone' });
  const invalidRes = createRes();
  await handler(invalidReq, invalidRes.res);
  assert.equal(invalidRes.status, 400);
  assert.match(String(invalidRes.data.error), /name/);
  assert.equal(called, false);

  CloudflareAPI.prototype.createDNSRecord = orig;
});

test('updateDNSRecord validation', async () => {
  const handler = ServerAPI.updateDNSRecord();
  const orig = CloudflareAPI.prototype.updateDNSRecord;
  let called = false;
  CloudflareAPI.prototype.updateDNSRecord = async (
    _zone: string,
    _id: string,
    record: unknown,
  ) => {
    called = true;
    const rec = typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {};
    return { id: '1', ...rec } as unknown;
  } as unknown as (zone: string, id: string, record: unknown) => Promise<unknown>;

  // Valid payload
  const validReq = createReq(
    { type: 'A', name: 'test', content: '1.2.3.4' },
    { zone: 'zone', id: '1' },
  );
  const validRes = createRes();
  await handler(validReq, validRes.res);
  assert.equal(validRes.status, undefined);
  assert.deepEqual(validRes.data, {
    id: '1',
    type: 'A',
    name: 'test',
    content: '1.2.3.4',
  });
  assert.equal(called, true);

  // Invalid payload
  called = false;
  const invalidReq = createReq({ name: 'test' }, { zone: 'zone', id: '1' });
  const invalidRes = createRes();
  await handler(invalidReq, invalidRes.res);
  assert.equal(invalidRes.status, 400);
  assert.match(String(invalidRes.data.error), /type/);
  assert.equal(called, false);

  CloudflareAPI.prototype.updateDNSRecord = orig;
});
