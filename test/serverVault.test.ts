/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerAPI } from '../src/lib/server-api.ts';
import { vaultManager } from '../src/server/vault.ts';
import type { Request, Response } from 'express';

function createReq(body: any, params: Record<string, string>) {
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
  let jsonData: any;
  const res: Partial<Response> = {
    status(code: number) {
      statusCode = code;
      return this as Response;
    },
    json(data: any) {
      jsonData = data;
    },
  };
  return { res: res as Response, get status() { return statusCode; }, get data() { return jsonData; } };
}

test('store/get/delete vault secret', async () => {
  const storeH = ServerAPI.storeVaultSecret();
  const getH = ServerAPI.getVaultSecret();
  const delH = ServerAPI.deleteVaultSecret();

  const reqStore = createReq({ secret: 's1' }, { id: 'id1' });
  const resStore = createRes();
  await storeH(reqStore, resStore.res);
  assert.equal(resStore.data.success, true);

  const reqGet = createReq({}, { id: 'id1' });
  const resGet = createRes();
  await getH(reqGet, resGet.res);
  assert.equal(resGet.data.secret, 's1');

  const reqDel = createReq({}, { id: 'id1' });
  const resDel = createRes();
  await delH(reqDel, resDel.res);
  assert.equal(resDel.data.success, true);

  const secret = await vaultManager.getSecret('id1');
  assert.equal(secret, null);
});
