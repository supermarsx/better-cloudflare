import assert from "node:assert/strict";
import { test } from "node:test";
import { CryptoManager } from "../src/lib/auth/crypto.ts";
import { benchmark } from "../src/lib/auth/crypto-benchmark.ts";
import {
  AES_256_KEY_LENGTH_BITS,
  MAX_CRYPTO_BASE64_CHARS,
  MAX_CRYPTO_PASSWORD_BYTES,
  MAX_CRYPTO_PLAINTEXT_BYTES,
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
} from "../src/types/dns.ts";

class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string) {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? this.store[key]
      : null;
  }
  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }
  removeItem(key: string) {
    delete this.store[key];
  }
}

class FailingStorageMock extends LocalStorageMock {
  override setItem() {
    throw new Error("quota exceeded");
  }
}

test("encrypt followed by decrypt returns original data", async () => {
  const storage = new LocalStorageMock();
  const cryptoMgr = new CryptoManager({}, storage);
  const data = "secret message";
  const password = "pw";
  const { encrypted, salt, iv } = await cryptoMgr.encrypt(data, password);
  assert.match(encrypted, /^bc1:/);
  const decrypted = await cryptoMgr.decrypt(encrypted, salt, iv, password);
  assert.equal(decrypted, data);
});

test("updateConfig persists changes across instances", () => {
  const storage = new LocalStorageMock();
  const cryptoMgr = new CryptoManager({}, storage);
  cryptoMgr.updateConfig({ algorithm: "AES-GCM", iterations: 200000 });
  // Simulate reload by creating a new manager that reads from storage
  const reloaded = new CryptoManager({}, storage);
  const config = reloaded.getConfig();
  assert.equal(config.algorithm, "AES-GCM");
  assert.equal(config.iterations, 200000);
});

test("hostile stored settings are rejected instead of clamped", () => {
  const storage = new LocalStorageMock();
  storage.setItem(
    "encryption-settings",
    JSON.stringify({
      iterations: MAX_PBKDF2_ITERATIONS + 1,
      keyLength: Number.MAX_SAFE_INTEGER,
      algorithm: "AES-CBC",
    }),
  );
  const cryptoMgr = new CryptoManager({}, storage);
  assert.deepEqual(cryptoMgr.getConfig(), {
    iterations: MIN_PBKDF2_ITERATIONS,
    keyLength: AES_256_KEY_LENGTH_BITS,
    algorithm: "AES-GCM",
  });
});

test("configuration boundaries fail closed without mutating active settings", () => {
  const cryptoMgr = new CryptoManager();
  const original = cryptoMgr.getConfig();

  assert.throws(
    () =>
      cryptoMgr.updateConfig({
        iterations: MIN_PBKDF2_ITERATIONS - 1,
      }),
    /between/,
  );
  assert.throws(
    () =>
      cryptoMgr.updateConfig({
        iterations: MAX_PBKDF2_ITERATIONS + 1,
      }),
    /between/,
  );
  assert.throws(
    () => cryptoMgr.updateConfig({ keyLength: AES_256_KEY_LENGTH_BITS - 1 }),
    /exactly/,
  );
  assert.throws(
    () => cryptoMgr.updateConfig({ keyLength: AES_256_KEY_LENGTH_BITS + 1 }),
    /exactly/,
  );
  assert.throws(
    () => cryptoMgr.updateConfig({ algorithm: "AES-CBC" }),
    /legacy decrypt-only/,
  );
  assert.deepEqual(cryptoMgr.getConfig(), original);

  cryptoMgr.updateConfig({ iterations: MIN_PBKDF2_ITERATIONS });
  assert.equal(cryptoMgr.getConfig().iterations, MIN_PBKDF2_ITERATIONS);
  cryptoMgr.updateConfig({ iterations: MAX_PBKDF2_ITERATIONS });
  assert.equal(cryptoMgr.getConfig().iterations, MAX_PBKDF2_ITERATIONS);
});

test("configuration persistence fails before in-memory settings change", () => {
  const cryptoMgr = new CryptoManager({}, new FailingStorageMock());
  const original = cryptoMgr.getConfig();
  assert.throws(
    () =>
      cryptoMgr.updateConfig({
        iterations: MIN_PBKDF2_ITERATIONS + 10_000,
      }),
    /could not be persisted/,
  );
  assert.deepEqual(cryptoMgr.getConfig(), original);
});

test("plaintext, password, and ciphertext limits reject limit plus one", async () => {
  const cryptoMgr = new CryptoManager();
  const exactPlaintext = "a".repeat(MAX_CRYPTO_PLAINTEXT_BYTES);
  const encrypted = await cryptoMgr.encrypt(exactPlaintext, "password");
  assert.ok(
    encrypted.encrypted.length <= MAX_CRYPTO_BASE64_CHARS + "bc1:".length,
  );
  assert.equal(
    await cryptoMgr.decrypt(
      encrypted.encrypted,
      encrypted.salt,
      encrypted.iv,
      "password",
    ),
    exactPlaintext,
  );

  await assert.rejects(
    () =>
      cryptoMgr.encrypt("a".repeat(MAX_CRYPTO_PLAINTEXT_BYTES + 1), "password"),
    /Plaintext exceeds/,
  );
  await cryptoMgr.encrypt("secret", "p".repeat(MAX_CRYPTO_PASSWORD_BYTES));
  await assert.rejects(
    () =>
      cryptoMgr.encrypt("secret", "p".repeat(MAX_CRYPTO_PASSWORD_BYTES + 1)),
    /Password exceeds/,
  );
  await assert.rejects(
    () => cryptoMgr.encrypt("secret", ""),
    /must not be empty/,
  );
  await assert.rejects(
    () =>
      cryptoMgr.decrypt(
        "A".repeat(MAX_CRYPTO_BASE64_CHARS + 4),
        encrypted.salt,
        encrypted.iv,
        "password",
      ),
    /bounded base64/,
  );
});

test("malformed base64 and malformed fixed-width fields are rejected", async () => {
  const cryptoMgr = new CryptoManager();
  const encrypted = await cryptoMgr.encrypt("secret", "password");

  await assert.rejects(
    () => cryptoMgr.decrypt("***=", encrypted.salt, encrypted.iv, "password"),
    /bounded base64/,
  );
  await assert.rejects(
    () =>
      cryptoMgr.decrypt(encrypted.encrypted, "AAAA", encrypted.iv, "password"),
    /exactly 16 bytes/,
  );
});

test("legacy unprefixed GCM and AES-CBC ciphertext remain decryptable", async () => {
  const gcm = new CryptoManager();
  const current = await gcm.encrypt("versioned-gcm", "password");
  await assert.rejects(
    () =>
      gcm.decrypt(
        current.encrypted.slice("bc1:".length),
        current.salt,
        current.iv,
        "password",
      ),
    /operation|decrypt/i,
  );

  const legacySalt = gcm.generateSalt();
  const legacyIv = gcm.generateIV();
  const legacyKey = await gcm.deriveKey("password", legacySalt);
  const legacyCiphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: legacyIv },
    legacyKey,
    new TextEncoder().encode("legacy-gcm"),
  );
  const toBase64 = (value: ArrayBuffer | Uint8Array) =>
    Buffer.from(
      value instanceof Uint8Array ? value : new Uint8Array(value),
    ).toString("base64");
  assert.equal(
    await gcm.decrypt(
      toBase64(legacyCiphertext),
      toBase64(legacySalt),
      toBase64(legacyIv),
      "password",
    ),
    "legacy-gcm",
  );

  const legacy = new CryptoManager({
    iterations: MIN_PBKDF2_ITERATIONS,
    keyLength: AES_256_KEY_LENGTH_BITS,
    algorithm: "AES-CBC",
  });
  const salt = legacy.generateSalt();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await legacy.deriveKey("password", salt);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    key,
    new TextEncoder().encode("legacy-cbc"),
  );
  assert.equal(
    await legacy.decrypt(
      toBase64(ciphertext),
      toBase64(salt),
      toBase64(iv),
      "password",
    ),
    "legacy-cbc",
  );
  await assert.rejects(
    () => legacy.encrypt("new-secret", "password"),
    /legacy decrypt-only/,
  );
});

test("benchmark returns numeric duration", async () => {
  const result = await benchmark(MIN_PBKDF2_ITERATIONS);
  assert.equal(typeof result, "number");
});
