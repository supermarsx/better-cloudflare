import assert from "node:assert/strict";
import { test, after } from "node:test";

import {
  base64urlToUint8Array,
  bufferToBase64url,
  toCredentialCreationOptions,
  toCredentialRequestOptions,
  serializeAuthenticationCredential,
  serializeRegistrationCredential,
} from "../src/lib/webauthn";

const originalAtob = globalThis.atob;
const originalBtoa = globalThis.btoa;

function installBase64Polyfill() {
  globalThis.atob = (input: string) =>
    Buffer.from(input, "base64").toString("binary");
  globalThis.btoa = (input: string) =>
    Buffer.from(input, "binary").toString("base64");
}

installBase64Polyfill();

after(() => {
  if (originalAtob) globalThis.atob = originalAtob;
  if (originalBtoa) globalThis.btoa = originalBtoa;
});

test("bufferToBase64url roundtrips with base64urlToUint8Array", () => {
  const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
  const encoded = bufferToBase64url(bytes);
  const decoded = base64urlToUint8Array(encoded);
  assert.deepEqual(Array.from(decoded), Array.from(bytes));
  assert.ok(!encoded.includes("="));
});

test("toCredentialCreationOptions normalizes binary fields", () => {
  const opts = toCredentialCreationOptions({
    rp: { name: "Test" },
    user: { id: "dXNlcg", name: "user", displayName: "User" },
    challenge: "Y2hhbGxlbmdl",
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    excludeCredentials: [{ id: "Y3JlZA", type: "public-key" }],
  });
  assert.ok(opts.challenge instanceof ArrayBuffer || opts.challenge instanceof Uint8Array);
  assert.ok(opts.user.id instanceof ArrayBuffer || opts.user.id instanceof Uint8Array);
  assert.ok(
    opts.excludeCredentials?.[0].id instanceof ArrayBuffer ||
      opts.excludeCredentials?.[0].id instanceof Uint8Array,
  );
});

test("toCredentialRequestOptions normalizes allowCredentials", () => {
  const opts = toCredentialRequestOptions({
    challenge: "Y2hhbGxlbmdl",
    allowCredentials: [{ id: "Y3JlZA", type: "public-key" }],
  });
  assert.ok(opts.challenge instanceof ArrayBuffer || opts.challenge instanceof Uint8Array);
  assert.ok(
    opts.allowCredentials?.[0].id instanceof ArrayBuffer ||
      opts.allowCredentials?.[0].id instanceof Uint8Array,
  );
});

test("serializeRegistrationCredential produces base64url fields", () => {
  const attestation = {
    clientDataJSON: new Uint8Array([1, 2, 3]).buffer,
    attestationObject: new Uint8Array([4, 5, 6]).buffer,
  };
  const credential = {
    id: "cred",
    rawId: new Uint8Array([7, 8]).buffer,
    type: "public-key",
    response: attestation,
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential;

  const serialized = serializeRegistrationCredential(credential);
  assert.equal(serialized.id, "cred");
  assert.match(serialized.rawId, /^[A-Za-z0-9_-]+$/);
  assert.match(serialized.response.clientDataJSON, /^[A-Za-z0-9_-]+$/);
  assert.match(serialized.response.attestationObject, /^[A-Za-z0-9_-]+$/);
});

test("serializeAuthenticationCredential includes userHandle when present", () => {
  const assertion = {
    clientDataJSON: new Uint8Array([1, 2, 3]).buffer,
    authenticatorData: new Uint8Array([4, 5, 6]).buffer,
    signature: new Uint8Array([7, 8, 9]).buffer,
    userHandle: new Uint8Array([10, 11]).buffer,
  };
  const credential = {
    id: "cred",
    rawId: new Uint8Array([7, 8]).buffer,
    type: "public-key",
    response: assertion,
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential;

  const serialized = serializeAuthenticationCredential(credential);
  assert.match(serialized.response.userHandle ?? "", /^[A-Za-z0-9_-]+$/);
  assert.match(serialized.response.signature, /^[A-Za-z0-9_-]+$/);
});

test("serializeAuthenticationCredential uses null userHandle when missing", () => {
  const assertion = {
    clientDataJSON: new Uint8Array([1, 2, 3]).buffer,
    authenticatorData: new Uint8Array([4, 5, 6]).buffer,
    signature: new Uint8Array([7, 8, 9]).buffer,
    userHandle: null,
  };
  const credential = {
    id: "cred",
    rawId: new Uint8Array([7, 8]).buffer,
    type: "public-key",
    response: assertion,
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential;

  const serialized = serializeAuthenticationCredential(credential);
  assert.equal(serialized.response.userHandle, null);
});
