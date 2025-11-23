/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerAPI } from '../src/lib/server-api.ts';
import { isAdmin } from '../src/lib/rbac';
import createCredentialStore from '../src/lib/credential-store.ts';

function makeReq(body: any, params: any, headers?: Record<string, string>) {
  return {
    body,
    params,
    header(name: string) {
      return (headers && headers[name]) ?? undefined;
    },
  } as any;
}

function makeRes() {
  let statusCode: number | undefined;
  let jsonData: any;
  const res: any = {
    status(code: number) { statusCode = code; return this; },
    json(data: any) { jsonData = data; },
  };
  return { res, get status() { return statusCode; }, get data() { return jsonData; } } as any;
}

test('RBAC: admin token or user role is required for admin endpoints', async () => {
  process.env.CREDENTIAL_STORE = 'sqlite';
  process.env.ADMIN_TOKEN = 'adm-token';
  const store = createCredentialStore() as any;
  ServerAPI.setCredentialStore(store);

  // Create user via admin token
  const reqCreate = makeReq({ id: 'u1', email: 'admin@example.com', roles: ['admin'] }, {}, { 'x-admin-token': 'adm-token' });
  const createdRes = makeRes();
  await ServerAPI.createUser()(reqCreate as any, createdRes.res);
  assert.equal(createdRes.data.success, true);

  // Now try to access audit without credentials -> 403
  const arReq = makeReq({}, {}, {});
  const arRes = makeRes();
  try {
    await ServerAPI.getAuditEntries()(arReq as any, arRes.res);
    // Without admin token or Cloudflare creds, either 400 or 403 is acceptable
    assert.ok(arRes.status === 400 || arRes.status === 403);
  } catch (err: any) {
    assert.equal(err.status, 400);
  }

  // With the admin token it works
  const arReq2 = makeReq({}, {}, { 'x-admin-token': 'adm-token' });
  const arRes2 = makeRes();
  console.log('DEBUG adminToken env=', process.env.ADMIN_TOKEN, 'req header=', arReq2.header('x-admin-token'));
  process.env.DEBUG_SERVER_API = '1';
  await ServerAPI.getAuditEntries()(arReq2 as any, arRes2.res);
  assert.ok(Array.isArray(arRes2.data));

  // Check role-based admin via middleware: isAdmin should allow our admin user
  const mwReq = makeReq({}, {}, { 'x-auth-email': 'admin@example.com' });
  const mwRes = makeRes();
  let called = false;
  await new Promise<void>((resolve, reject) => {
    isAdmin(mwReq as any, mwRes.res, (err?: any) => {
      if (err) {
        reject(err);
      } else {
        called = true;
        resolve();
      }
    });
  });
  assert.equal(called, true);
});
