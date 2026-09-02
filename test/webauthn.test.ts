import assert from "node:assert/strict";
import { test, after } from "node:test";

import {
  base64urlToUint8Array,
  bufferToBase64url,
  createPasskeyCredential,
  getPasskeyCredential,
  isBase64url,
  probeWebauthnClient,
  toCredentialCreationOptions,
  toCredentialRequestOptions,
  serializeAuthenticationCredential,
  serializeRegistrationCredential,
  unwrapCeremonyOptions,
  webauthnClientAvailable,
  WebauthnCeremonyTimeoutError,
} from "../src/lib/auth/webauthn";

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
  assert.ok(
    opts.challenge instanceof ArrayBuffer ||
      opts.challenge instanceof Uint8Array,
  );
  assert.ok(
    opts.user.id instanceof ArrayBuffer || opts.user.id instanceof Uint8Array,
  );
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
  assert.ok(
    opts.challenge instanceof ArrayBuffer ||
      opts.challenge instanceof Uint8Array,
  );
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

// ─── base64url round-tripping ───────────────────────────────────────────────
//
// A silent encoding mismatch across the IPC boundary is the classic way a
// WebAuthn transport fails: the ceremony completes, the relying party rejects
// the signature, and nothing says why. These tests pin the encoding as an
// exact identity rather than spot-checking a sample.

test("base64url round-trips every byte value at every length modulus", () => {
  const alphabet = /^[A-Za-z0-9_-]*$/;
  for (let length = 0; length <= 64; length++) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + length) % 256;

    const encoded = bufferToBase64url(bytes);
    assert.match(
      encoded,
      alphabet,
      `length ${length} left non-base64url chars`,
    );
    assert.deepEqual(
      Array.from(base64urlToUint8Array(encoded)),
      Array.from(bytes),
      `length ${length} did not round-trip`,
    );
  }
});

test("base64url round-trips the full byte range", () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  assert.deepEqual(
    Array.from(base64urlToUint8Array(bufferToBase64url(bytes))),
    Array.from(bytes),
  );
});

test("isBase64url rejects standard base64 and impossible lengths", () => {
  assert.equal(isBase64url(""), true);
  assert.equal(isBase64url("AAAA"), true);
  assert.equal(isBase64url("-_8"), true);
  // Standard-alphabet and padded input is not what webauthn-rs emits; treating
  // it as base64url would decode to different bytes.
  assert.equal(isBase64url("a+b/c"), false);
  assert.equal(isBase64url("AAAA="), false);
  assert.equal(isBase64url("AA\nAA"), false);
  // No byte string encodes to a length of n % 4 === 1.
  assert.equal(isBase64url("AAAAA"), false);
  assert.throws(() => base64urlToUint8Array("a+b/c"), TypeError);
});

test("options binary fields decode to their bytes rather than to their text", () => {
  const challenge = new Uint8Array([0, 127, 128, 255, 42]);
  const userId = new Uint8Array([9, 8, 7]);
  const credId = new Uint8Array([1, 1, 2, 3, 5, 8]);

  const opts = toCredentialCreationOptions({
    rp: { name: "Better Cloudflare" },
    user: {
      id: bufferToBase64url(userId),
      name: "user",
      displayName: "User",
    },
    challenge: bufferToBase64url(challenge),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    excludeCredentials: [{ id: bufferToBase64url(credId), type: "public-key" }],
  });

  const bytes = (value: BufferSource) =>
    Array.from(
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );

  assert.deepEqual(bytes(opts.challenge), Array.from(challenge));
  assert.deepEqual(bytes(opts.user.id), Array.from(userId));
  assert.deepEqual(
    bytes(opts.excludeCredentials?.[0].id as BufferSource),
    Array.from(credId),
  );

  const request = toCredentialRequestOptions({
    challenge: bufferToBase64url(challenge),
    allowCredentials: [{ id: bufferToBase64url(credId), type: "public-key" }],
  });
  assert.deepEqual(bytes(request.challenge), Array.from(challenge));
  assert.deepEqual(
    bytes(request.allowCredentials?.[0].id as BufferSource),
    Array.from(credId),
  );
});

test("a serialized credential decodes back to the bytes the authenticator produced", () => {
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: "zHOSGcDHeh-MWzSroqDKIpQP8rlUHy_LRMGzBOwXEI0",
      origin: "http://tauri.localhost",
      crossOrigin: false,
    }),
  );
  const authenticatorData = new Uint8Array(37).fill(0xa5);
  const signature = new Uint8Array(71).fill(0x30);
  const userHandle = new Uint8Array(16).fill(0x11);
  const rawId = new Uint8Array(32).fill(0x7f);

  const serialized = serializeAuthenticationCredential({
    id: bufferToBase64url(rawId),
    rawId: rawId.buffer,
    type: "public-key",
    response: {
      clientDataJSON: clientDataJSON.buffer,
      authenticatorData: authenticatorData.buffer,
      signature: signature.buffer,
      userHandle: userHandle.buffer,
    },
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential);

  assert.deepEqual(
    Array.from(base64urlToUint8Array(serialized.rawId)),
    Array.from(rawId),
  );
  assert.deepEqual(
    Array.from(base64urlToUint8Array(serialized.response.authenticatorData)),
    Array.from(authenticatorData),
  );
  assert.deepEqual(
    Array.from(base64urlToUint8Array(serialized.response.signature)),
    Array.from(signature),
  );
  assert.deepEqual(
    Array.from(base64urlToUint8Array(serialized.response.userHandle ?? "")),
    Array.from(userHandle),
  );
  // The origin the relying party checks must survive the trip verbatim, with
  // no added trailing slash.
  assert.equal(
    new TextDecoder().decode(
      base64urlToUint8Array(serialized.response.clientDataJSON),
    ),
    new TextDecoder().decode(clientDataJSON),
  );
});

test("registration serialization carries transports and the aliased extension key", () => {
  const serialized = serializeRegistrationCredential({
    id: "cred",
    rawId: new Uint8Array([1, 2]).buffer,
    type: "public-key",
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      attestationObject: new Uint8Array([2]).buffer,
      getTransports: () => ["internal", "hybrid"],
    },
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential);

  assert.deepEqual(serialized.response.transports, ["internal", "hybrid"]);
  assert.deepEqual(serialized.clientExtensionResults, {});
});

test("registration serialization omits transports when the browser has none", () => {
  const serialized = serializeRegistrationCredential({
    id: "cred",
    rawId: new Uint8Array([1, 2]).buffer,
    type: "public-key",
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      attestationObject: new Uint8Array([2]).buffer,
    },
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential);

  assert.equal(serialized.response.transports, undefined);
});

// ─── Options envelopes ──────────────────────────────────────────────────────

test("unwrapCeremonyOptions accepts the publicKey envelope webauthn-rs emits", () => {
  const options = { challenge: "Y2hhbGxlbmdl", timeout: 60000 };
  assert.deepEqual(unwrapCeremonyOptions({ publicKey: options }), options);
});

test("unwrapCeremonyOptions still accepts the older envelopes", () => {
  const options = { challenge: "Y2hhbGxlbmdl" };
  assert.deepEqual(unwrapCeremonyOptions({ options }), options);
  assert.deepEqual(unwrapCeremonyOptions(options), options);
});

test("unwrapCeremonyOptions merges a challenge held outside the options object", () => {
  assert.deepEqual(
    unwrapCeremonyOptions({
      challenge: "Y2hhbGxlbmdl",
      options: { timeout: 1000 },
    }),
    { timeout: 1000, challenge: "Y2hhbGxlbmdl" },
  );
});

test("unwrapCeremonyOptions prefers publicKey over a sibling options key", () => {
  assert.deepEqual(
    unwrapCeremonyOptions({
      publicKey: { challenge: "cHVibGlj" },
      options: { challenge: "b3B0aW9ucw" },
    }),
    { challenge: "cHVibGlj" },
  );
});

test("unwrapCeremonyOptions tolerates a payload that is not an object", () => {
  assert.deepEqual(unwrapCeremonyOptions(null), {});
  assert.deepEqual(unwrapCeremonyOptions("nope"), {});
  assert.deepEqual(unwrapCeremonyOptions([1, 2]), {});
});

// ─── Client capability probe ────────────────────────────────────────────────

type CredentialsStub = {
  create?: unknown;
  get?: unknown;
};

function withWebauthnClient(
  publicKeyCredential: unknown,
  credentials: CredentialsStub | undefined,
): () => void {
  // The probe reads `window.PublicKeyCredential`, and under jsdom `window` is
  // not the same object as `globalThis` — setting the global would leave the
  // probe seeing nothing and every case passing for the wrong reason.
  const target = window as unknown as Record<string, unknown>;
  const hadPkc = "PublicKeyCredential" in target;
  const previousPkc = target.PublicKeyCredential;
  const previousCredentials = Object.getOwnPropertyDescriptor(
    navigator,
    "credentials",
  );

  if (publicKeyCredential === undefined) delete target.PublicKeyCredential;
  else target.PublicKeyCredential = publicKeyCredential;

  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: credentials,
  });

  return () => {
    if (hadPkc) target.PublicKeyCredential = previousPkc;
    else delete target.PublicKeyCredential;
    if (previousCredentials) {
      Object.defineProperty(navigator, "credentials", previousCredentials);
    } else {
      delete (navigator as unknown as Record<string, unknown>).credentials;
    }
  };
}

function fakePublicKeyCredential(
  isUserVerifyingPlatformAuthenticatorAvailable: unknown,
): unknown {
  const ctor = function PublicKeyCredential() {};
  Object.assign(ctor, { isUserVerifyingPlatformAuthenticatorAvailable });
  return ctor;
}

const workingCredentials: CredentialsStub = {
  create: async () => null,
  get: async () => null,
};

test("the probe reports unsupported when the webview has no WebAuthn client", async () => {
  // This is the standing situation on macOS and Linux, where Tauri serves an
  // opaque tauri://localhost origin. jsdom has no WebAuthn either, which is
  // why every untouched test in the suite sees this branch.
  const restore = withWebauthnClient(undefined, undefined);
  try {
    assert.equal(await probeWebauthnClient(), "unsupported");
    assert.equal(await webauthnClientAvailable(), false);
  } finally {
    restore();
  }
});

test("the probe reports unsupported when the credential methods are missing", async () => {
  const restore = withWebauthnClient(
    fakePublicKeyCredential(async () => true),
    { get: async () => null },
  );
  try {
    assert.equal(await probeWebauthnClient(), "unsupported");
  } finally {
    restore();
  }
});

test("the probe separates an unenrolled device from an unsupported webview", async () => {
  // Measured behaviour on a Windows host with no platform authenticator:
  // the API is complete and isUserVerifyingPlatformAuthenticatorAvailable()
  // resolves false. Enrolling Windows Hello fixes it, so it must not be
  // reported as "this platform cannot do WebAuthn".
  const restore = withWebauthnClient(
    fakePublicKeyCredential(async () => false),
    workingCredentials,
  );
  try {
    assert.equal(await probeWebauthnClient(), "no-authenticator");
    assert.equal(await webauthnClientAvailable(), false);
  } finally {
    restore();
  }
});

test("the probe reports available when an authenticator is enrolled", async () => {
  const restore = withWebauthnClient(
    fakePublicKeyCredential(async () => true),
    workingCredentials,
  );
  try {
    assert.equal(await probeWebauthnClient(), "available");
    assert.equal(await webauthnClientAvailable(), true);
  } finally {
    restore();
  }
});

test("a probe that throws fails closed rather than enabling the buttons", async () => {
  const restore = withWebauthnClient(
    fakePublicKeyCredential(() => {
      throw new Error("probe exploded");
    }),
    workingCredentials,
  );
  try {
    assert.equal(await probeWebauthnClient(), "unsupported");
  } finally {
    restore();
  }
});

// ─── Ceremonies run on our own timer ────────────────────────────────────────
//
// navigator.credentials.create() with authenticatorAttachment: "platform"
// hangs indefinitely and ignores its own `timeout` field on Chromium 146 —
// measured in production WebView2 and reproduced in stock Edge. The WebAuthn
// `timeout` field is therefore advisory, and every call runs under an
// AbortSignal this module drives.

test("create passes an AbortSignal and gives up on its own deadline", async () => {
  let seenSignal: AbortSignal | undefined;
  const restore = withWebauthnClient(
    fakePublicKeyCredential(async () => true),
    {
      create: (options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          seenSignal = options.signal;
          options.signal?.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("The operation was aborted."), {
                name: "AbortError",
              }),
            );
          });
        }),
      get: async () => null,
    },
  );

  try {
    await assert.rejects(
      createPasskeyCredential(
        {
          challenge: new Uint8Array([1]),
        } as PublicKeyCredentialCreationOptions,
        20,
      ),
      (error: unknown) => {
        assert.ok(error instanceof WebauthnCeremonyTimeoutError);
        assert.equal(error.ceremony, "create");
        assert.match(error.message, /timed out/i);
        return true;
      },
    );
    assert.ok(seenSignal, "create() was called without an AbortSignal");
    assert.equal(seenSignal?.aborted, true);
  } finally {
    restore();
  }
});

test("a ceremony that ignores the abort signal still settles", async () => {
  // The one outcome with no way out is a login screen that spins forever, so
  // the deadline settles this call whether or not the platform honours abort.
  const restore = withWebauthnClient(
    fakePublicKeyCredential(async () => true),
    {
      create: async () => null,
      get: () => new Promise(() => {}),
    },
  );

  try {
    await assert.rejects(
      getPasskeyCredential(
        { challenge: new Uint8Array([1]) } as PublicKeyCredentialRequestOptions,
        20,
      ),
      (error: unknown) => {
        assert.ok(error instanceof WebauthnCeremonyTimeoutError);
        assert.equal(error.ceremony, "get");
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("a ceremony that resolves in time returns its credential unchanged", async () => {
  const credential = { id: "cred" } as unknown as PublicKeyCredential;
  const restore = withWebauthnClient(
    fakePublicKeyCredential(async () => true),
    {
      create: async () => credential,
      get: async () => credential,
    },
  );

  try {
    assert.equal(
      await createPasskeyCredential(
        {} as PublicKeyCredentialCreationOptions,
        5_000,
      ),
      credential,
    );
    assert.equal(
      await getPasskeyCredential(
        {} as PublicKeyCredentialRequestOptions,
        5_000,
      ),
      credential,
    );
  } finally {
    restore();
  }
});

test("a real ceremony failure is reported as itself, not as a timeout", async () => {
  const notAllowed = Object.assign(new Error("The operation is not allowed."), {
    name: "NotAllowedError",
  });
  const restore = withWebauthnClient(
    fakePublicKeyCredential(async () => true),
    {
      create: async () => {
        throw notAllowed;
      },
      get: async () => null,
    },
  );

  try {
    await assert.rejects(
      createPasskeyCredential({} as PublicKeyCredentialCreationOptions, 5_000),
      (error: unknown) => error === notAllowed,
    );
  } finally {
    restore();
  }
});
