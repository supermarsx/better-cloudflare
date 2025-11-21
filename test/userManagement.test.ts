import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerAPI } from '../src/lib/server-api.ts';
import createCredentialStore from '../src/lib/credential-store.ts';

test('admin user creation and roles update (sqlite)', async () => {
  process.env.CREDENTIAL_STORE = 'sqlite';
  process.env.ADMIN_TOKEN = 'admin-token';
  const store = createCredentialStore() as any;
  // ensure ServerAPI uses sqlite store in tests
  ServerAPI.setCredentialStore(store);
  const handlerCreate = ServerAPI.createUser();
  const req = { body: { id: 'u1', email: 'u1@example.com', roles: ['user'] }, header(name: string) { return name === 'x-admin-token' ? 'admin-token' : undefined; } } as any;
  const res = { json(data: any) { (res as any).data = data; }, status(code: number) { (res as any).status = code; return res as any; } } as any;
  await handlerCreate(req, res);
  assert.equal(res.data.success, true);

  const handlerGet = ServerAPI.getUser();
  const reqGet = { params: { id: 'u1' }, header() { return 'admin-token'; } } as any;
  const resGet = { json(data: any) { (resGet as any).data = data; }, status(code: number) { (resGet as any).status = code; return resGet as any; } } as any;
  await handlerGet(reqGet, resGet);
  assert.equal(resGet.data.id, 'u1');

  const handlerUpdate = ServerAPI.updateUserRoles();
  const reqUpdate = { params: { id: 'u1' }, body: { roles: ['admin'] }, header(name: string) { return 'admin-token'; } } as any;
  const resUpdate = { json(data: any) { (resUpdate as any).data = data; }, status(code: number) { (resUpdate as any).status = code; return resUpdate as any; } } as any;
  await handlerUpdate(reqUpdate, resUpdate);
  assert.equal(resUpdate.data.success, true);
});
