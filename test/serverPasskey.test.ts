// Prefer narrower types in tests — avoid `any` where possible.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { ServerAPI } from '../src/lib/server-api.ts';
import { getAuditEntries, clearAuditEntries } from '../src/lib/audit.ts';
import { vaultManager } from '../src/server/vault.ts';

// Monkey-patch simplewebauthn server verification functions to avoid
// needing a real WebAuthn attestation/assertion for unit tests.
import swauth from '../src/lib/simplewebauthn-wrapper';

// Typed shapes for the test stubs
type VerifyRegistrationResult = {
  verified: boolean;
  registrationInfo?: { credentialID?: string; credentialPublicKey?: string; counter?: number } | null;
  attestationType?: string;
};

type VerifyAuthenticationResult = {
  verified: boolean;
  authenticationInfo?: { newCounter?: number } | null;
};

// Store original functions to restore (use narrow unknown casts)
const origVerifyReg = (swauth as unknown as { verifyRegistrationResponse?: (opts?: unknown) => Promise<VerifyRegistrationResult> }).verifyRegistrationResponse;
const origVerifyAuth = (swauth as unknown as { verifyAuthenticationResponse?: (opts?: unknown) => Promise<VerifyAuthenticationResult> }).verifyAuthenticationResponse;

function createReq(body: unknown, params: Record<string, string>) {
  // minimal Request-like object (satisfies handlers used in tests)
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

test('createPasskeyRegistrationOptions returns options', async () => {
  const handler = ServerAPI.createPasskeyRegistrationOptions();
  const req = createReq({}, { id: 'key1' });
  const res = createRes();
  await handler(req, res.res);
  // Should return a challenge and options
  assert.ok(res.data.challenge);
  assert.ok(res.data.options);
});

test('registerPasskey verifies and stores credential', async () => {
  // Stub verification to return a successful registration result
  (swauth as unknown as { verifyRegistrationResponse: (opts?: unknown) => Promise<VerifyRegistrationResult> }).verifyRegistrationResponse = async () => ({
    verified: true,
    registrationInfo: { credentialID: 'cid', credentialPublicKey: 'pk', counter: 0 },
  });

  const handler = ServerAPI.registerPasskey();
  // First generate options to create a challenge
  const start = ServerAPI.createPasskeyRegistrationOptions();
  const reqStart = createReq({}, { id: 'key2' });
  const resStart = createRes();
  await start(reqStart, resStart.res);

  const req = createReq({ id: 'key2', response: { /* dummy attestation */ } }, { id: 'key2' });
  const res = createRes();
  await handler(req, res.res);
  assert.equal(res.data.success, true);

  const secret = await vaultManager.getSecret('passkey:key2');
  assert.ok(secret);
  const entries = await getAuditEntries();
  assert.ok(entries.some((e) => e.operation === 'passkey:register'));

  // restore
  (swauth as unknown as { verifyRegistrationResponse?: (opts?: unknown) => Promise<VerifyRegistrationResult> }).verifyRegistrationResponse = origVerifyReg;
});

test('registerPasskey supports multiple credentials', async () => {
  (swauth as unknown as { verifyRegistrationResponse: (opts?: unknown) => Promise<VerifyRegistrationResult> }).verifyRegistrationResponse = async () => ({
    verified: true,
    registrationInfo: { credentialID: `cid-${Date.now()}`, credentialPublicKey: 'pk', counter: 0 },
  });

  const handler = ServerAPI.registerPasskey();
  const id = 'multiKey';
  const start = ServerAPI.createPasskeyRegistrationOptions();
  const reqStart = createReq({}, { id });
  const resStart = createRes();
  await start(reqStart, resStart.res);

  // Register two credentials
  await handler(createReq({ id, response: {} }, { id }), createRes().res);
  // Need a new challenge for the second credential
  await start(reqStart, resStart.res);
  await handler(createReq({ id, response: {} }, { id }), createRes().res);

  const stored = await vaultManager.getSecret(`passkey:${id}`);
  assert.ok(stored);
  const arr = JSON.parse(stored as string);
  assert.ok(Array.isArray(arr) && arr.length >= 2);

  // Now fetch auth options and validate allowCredentials contains >= 2
  const authOptsHandler = ServerAPI.createPasskeyAuthOptions();
  const resAuth = createRes();
  await authOptsHandler(createReq({}, { id }), resAuth.res);
  const options = resAuth.data.options;
  assert.ok(options);
  assert.ok(options.allowCredentials && options.allowCredentials.length >= 2);

  (swauth as unknown as { verifyRegistrationResponse?: (opts?: unknown) => Promise<VerifyRegistrationResult> }).verifyRegistrationResponse = origVerifyReg;
  clearAuditEntries();
});

test('listPasskeys returns stored credentials and deletePasskey removes one', async () => {
  (swauth as unknown as { verifyRegistrationResponse: (opts?: unknown) => Promise<VerifyRegistrationResult> }).verifyRegistrationResponse = async () => ({
    verified: true,
    registrationInfo: { credentialID: `cid-${Date.now()}`, credentialPublicKey: 'pk', counter: 0 },
  });

  const id = 'listKey';
  const reg = ServerAPI.registerPasskey();
  await ServerAPI.createPasskeyRegistrationOptions()(createReq({}, { id }), createRes().res);
  await reg(createReq({ id, response: {} }, { id }), createRes().res);
  await ServerAPI.createPasskeyRegistrationOptions()(createReq({}, { id }), createRes().res);
  await reg(createReq({ id, response: {} }, { id }), createRes().res);

  const listH = ServerAPI.listPasskeys();
  const listRes = createRes();
  await listH(createReq({}, { id }), listRes.res);
  assert.ok(Array.isArray(listRes.data) && listRes.data.length >= 2);

  const toDelete: string = listRes.data[0].id;
  const delH = ServerAPI.deletePasskey();
  const delRes = createRes();
  await delH(createReq({}, { id, cid: toDelete }), delRes.res);
  assert.equal(delRes.data.success, true);

  const listRes2 = createRes();
  await listH(createReq({}, { id }), listRes2.res);
  assert.ok(listRes2.data.length === listRes.data.length - 1);
  const entries2 = await getAuditEntries();
  // ensure passkey:delete logged at least once
  assert.ok(entries2.some((e) => (e.operation === 'passkey:delete')));
  // ensure audit endpoint exposes entries when asked
  const auditH = ServerAPI.getAuditEntries();
  const ar = createRes();
  await auditH(createReq({}, { }), ar.res);
  assert.ok(Array.isArray(ar.data));

  (swauth as unknown as { verifyRegistrationResponse?: (opts?: unknown) => Promise<VerifyRegistrationResult> }).verifyRegistrationResponse = origVerifyReg;
});

test('registerPasskey rejects invalid attestation', async () => {
  (swauth as unknown as { verifyRegistrationResponse: (opts?: unknown) => Promise<VerifyRegistrationResult> }).verifyRegistrationResponse = async () => ({ verified: false, registrationInfo: null });
  const handler = ServerAPI.registerPasskey();
  const id = 'badKey';
  const start = ServerAPI.createPasskeyRegistrationOptions();
  const reqStart = createReq({}, { id });
  const resStart = createRes();
  await start(reqStart, resStart.res);
  const res = createRes();
  await handler(createReq({ id, response: {} }, { id }), res.res);
  assert.equal(res.status, 400);
  (swauth as unknown as { verifyRegistrationResponse?: (opts?: unknown) => Promise<VerifyRegistrationResult> }).verifyRegistrationResponse = origVerifyReg;
});

test('registerPasskey enforces attestation policy', async () => {
  (swauth as unknown as { verifyRegistrationResponse: (opts?: unknown) => Promise<VerifyRegistrationResult> }).verifyRegistrationResponse = async () => ({ verified: true, registrationInfo: { credentialID: 'cid', credentialPublicKey: 'pk' }, attestationType: 'direct' });
  process.env.ATTESTATION_POLICY = 'indirect';
  const handler = ServerAPI.registerPasskey();
  const id = 'policyKey';
  await ServerAPI.createPasskeyRegistrationOptions()(createReq({}, { id }), createRes().res);
  const res = createRes();
  await handler(createReq({ id, response: {} }, { id }), res.res);
  assert.equal(res.status, 400);
  delete process.env.ATTESTATION_POLICY;
  (swauth as unknown as { verifyRegistrationResponse?: (opts?: unknown) => Promise<VerifyRegistrationResult> }).verifyRegistrationResponse = origVerifyReg;
});

test('authenticatePasskey verifies assertion', async () => {
  // Stub verification to return successful authentication result
  (swauth as unknown as { verifyAuthenticationResponse: (opts?: unknown) => Promise<VerifyAuthenticationResult> }).verifyAuthenticationResponse = async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  });

  const handler = ServerAPI.authenticatePasskey();
  // store a credential in vault to simulate registered credential
  await vaultManager.setSecret('passkey:key3', JSON.stringify({ credentialID: 'cid', credentialPublicKey: 'pk', counter: 0 }));
  // create options to set a challenge
  const start = ServerAPI.createPasskeyAuthOptions();
  const reqStart = createReq({}, { id: 'key3' });
  const resStart = createRes();
  await start(reqStart, resStart.res);

  const req = createReq({ id: 'key3', response: { /* dummy assertion */ } }, { id: 'key3' });
  const res = createRes();
  await handler(req, res.res);
  assert.equal(res.data.success, true);

  const secretNew = await vaultManager.getSecret('passkey:key3');
  assert.ok(secretNew);

  // restore
  (swauth as unknown as { verifyAuthenticationResponse?: (opts?: unknown) => Promise<VerifyAuthenticationResult> }).verifyAuthenticationResponse = origVerifyAuth;
});

test('authenticatePasskey rejects failed assertion', async () => {
  (swauth as unknown as { verifyAuthenticationResponse: (opts?: unknown) => Promise<VerifyAuthenticationResult> }).verifyAuthenticationResponse = async () => ({ verified: false, authenticationInfo: null });
  const handler = ServerAPI.authenticatePasskey();
  await vaultManager.setSecret('passkey:badAuth', JSON.stringify({ credentialID: 'cid', credentialPublicKey: 'pk', counter: 0 }));
  const start = ServerAPI.createPasskeyAuthOptions();
  const reqStart = createReq({}, { id: 'badAuth' });
  await start(reqStart, createRes().res);
  const res = createRes();
  await handler(createReq({ id: 'badAuth', response: {} }, { id: 'badAuth' }), res.res);
  assert.equal(res.status, 400);
  (swauth as unknown as { verifyAuthenticationResponse?: (opts?: unknown) => Promise<VerifyAuthenticationResult> }).verifyAuthenticationResponse = origVerifyAuth;
});
