import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CryptoManager } from '../src/lib/crypto.ts';
import { benchmark } from '../src/lib/crypto-benchmark.ts';
import type { StorageLike } from '../src/lib/storage-util.ts';

class MemoryStorage implements StorageLike {
  private store: Record<string, string> = {};
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? this.store[key]
      : null;
  }
  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }
  removeItem(key: string): void {
    delete this.store[key];
  }
}

// 1. Round-trip encrypt/decrypt using a known password

test('encrypt/decrypt round trip', async () => {
  const storage = new MemoryStorage();
  const cryptoMgr = new CryptoManager({}, storage);
  const data = 'sample text';
  const password = 'strong-password';
  const { encrypted, salt, iv } = await cryptoMgr.encrypt(data, password);
  const decrypted = await cryptoMgr.decrypt(encrypted, salt, iv, password);
  assert.equal(decrypted, data);
});

// 2. Update settings and ensure persistence

test('updated settings persist across instances', () => {
  const storage = new MemoryStorage();
  const cryptoMgr = new CryptoManager({}, storage);
  cryptoMgr.updateConfig({ iterations: 200000, keyLength: 128, algorithm: 'AES-CBC' });
  const cryptoMgr2 = new CryptoManager({}, storage);
  const config = cryptoMgr2.getConfig();
  assert.equal(config.iterations, 200000);
  assert.equal(config.keyLength, 128);
  assert.equal(config.algorithm, 'AES-CBC');
});

// 3. benchmark returns numeric duration

test('benchmark returns numeric duration', async () => {
  const duration = await benchmark(1);
  assert.equal(typeof duration, 'number');
});
