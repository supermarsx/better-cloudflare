// use unknown instead of `any` in tests
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { ServerAPI } from '../src/lib/server-api.ts';
import { CloudflareAPI } from '../src/lib/cloudflare.ts';

function createReq(body: unknown, params: Record<string, string>, query?: Record<string, string>): Request {
  return {
    body,
    params,
    query,
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

test('createBulkDNSRecords dry run', async () => {
  const handler = ServerAPI.createBulkDNSRecords();
  const orig = CloudflareAPI.prototype.createDNSRecord;
  let called = 0;
  CloudflareAPI.prototype.createDNSRecord = (async (_zone: string, record: unknown) => {
    called++;
    const rec = typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {};
    return { id: `${called}`, ...rec } as unknown;
  }) as unknown as (zone: string, record: unknown) => Promise<unknown>;

  const payload = [
    { type: 'A', name: 'test1', content: '1.2.3.4' },
    { type: 'A', name: 'test2', content: '5.6.7.8' },
  ];
  const req = createReq(payload, { zone: 'zone' }, { dryrun: '1' });
  const res = createRes();
  await handler(req, res.res);
  // dry run should not invoke Cloudflare create
  assert.equal(called, 0);
  assert.ok(Array.isArray(res.data.created));
  assert.equal(res.data.created.length, 2);

  CloudflareAPI.prototype.createDNSRecord = orig;
});

test('createBulkDNSRecords creates records', async () => {
  const handler = ServerAPI.createBulkDNSRecords();
  const orig = CloudflareAPI.prototype.createDNSRecord;
  let called = 0;
  CloudflareAPI.prototype.createDNSRecord = (async (_zone: string, record: unknown) => {
    called++;
    const rec = typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {};
    return { id: `${called}`, ...rec } as unknown;
  }) as unknown as (zone: string, record: unknown) => Promise<unknown>;

  const payload = [
    { type: 'A', name: 'test1', content: '1.2.3.4' },
  ];
  const req = createReq(payload, { zone: 'zone' }, {});
  const res = createRes();
  await handler(req, res.res);
  assert.equal(called, 1);
  assert.equal(res.data.created.length, 1);
  assert.equal(res.data.skipped.length, 0);

  CloudflareAPI.prototype.createDNSRecord = orig;
});
