import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CryptoManager } from '../src/lib/crypto.ts';

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

class MockSubtleCrypto {
  async importKey(_format: string, keyData: Uint8Array) {
    return new TextDecoder().decode(keyData);
  }
  async deriveKey(params: { salt: Uint8Array }, keyMaterial: string) {
    const salt = Array.from(params.salt).join(',');
    return `${keyMaterial}:${salt}`;
  }
  async encrypt(
    _alg: { iv: Uint8Array },
    key: string,
    data: Uint8Array,
  ) {
    const plaintext = new TextDecoder().decode(data);
    const encoded = `${key}|${plaintext}`;
    return new TextEncoder().encode(encoded);
  }
  async decrypt(
    _alg: { iv: Uint8Array },
    key: string,
    data: Uint8Array,
  ) {
    const decoded = new TextDecoder().decode(data);
    const [storedKey, text] = decoded.split('|');
    if (storedKey !== key) {
      throw new Error('OperationError');
    }
    return new TextEncoder().encode(text);
  }
}

class MockCrypto {
  subtle = new MockSubtleCrypto();
  getRandomValues(arr: Uint8Array) {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = i + 1;
    }
    return arr;
  }
}

test('encrypt followed by decrypt returns original string', async () => {
  const storage = new LocalStorageMock();
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: new MockCrypto(),
    configurable: true,
  });
  const cryptoMgr = new CryptoManager({}, storage);
  const data = 'secret message';
  const password = 'pw';
  const { encrypted, salt, iv } = await cryptoMgr.encrypt(data, password);
  const decrypted = await cryptoMgr.decrypt(encrypted, salt, iv, password);
  assert.equal(decrypted, data);
  Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
});

test('decrypt fails with incorrect password', async () => {
  const storage = new LocalStorageMock();
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: new MockCrypto(),
    configurable: true,
  });
  const cryptoMgr = new CryptoManager({}, storage);
  const { encrypted, salt, iv } = await cryptoMgr.encrypt('data', 'right');
  await assert.rejects(
    cryptoMgr.decrypt(encrypted, salt, iv, 'wrong'),
  );
  Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
});

test('updateConfig persists algorithm selection', () => {
  const storage = new LocalStorageMock();
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: new MockCrypto(), configurable: true });
  const cryptoMgr = new CryptoManager({}, storage);
  cryptoMgr.updateConfig({ algorithm: 'AES-CBC' });
  const cryptoMgr2 = new CryptoManager({}, storage);
  assert.equal(cryptoMgr2.getConfig().algorithm, 'AES-CBC');
  Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
});
