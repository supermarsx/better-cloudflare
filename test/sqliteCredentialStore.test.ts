import assert from 'node:assert/strict';
import { test } from 'node:test';
import createCredentialStore from '../src/lib/credential-store.ts';
import { unlinkSync } from 'fs';
import path from 'path';

test('sqlite credential store add/get/delete', async () => {
  process.env.CREDENTIAL_STORE = 'sqlite';
  const store = createCredentialStore();
  const id = 'test-sqlite-1';
  const cred = { credentialID: 'cid-1', credentialPublicKey: 'pk-1', counter: 0 };
  await store.addCredential(id, cred);
  let got = await store.getCredentials(id);
  assert.ok(Array.isArray(got));
  assert.equal(got.length, 1);
  assert.equal(got[0].credentialID, 'cid-1');
  await store.deleteCredential(id, 'cid-1');
  got = await store.getCredentials(id);
  assert.equal(got.length, 0);
  // cleanup DB file created
  try { unlinkSync(path.resolve(process.cwd(), 'data', 'credentials.db')); } catch { /* ignore cleanup errors */ }
});
