import assert from 'node:assert/strict';
import { test } from 'node:test';

class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  }
  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }
  removeItem(key: string) {
    delete this.store[key];
  }
  clear() {
    this.store = {};
  }
}

interface GlobalWithLocalStorage {
  localStorage: LocalStorageMock;
}

function resetStorage() {
  (globalThis as unknown as GlobalWithLocalStorage).localStorage = new LocalStorageMock();
}

test('importData accepts valid data', async () => {
  resetStorage();
  const { StorageManager, isStorageData } = await import('../src/lib/storage.ts');
  const mgr = new StorageManager();
  const sample = {
    apiKeys: [
      {
        id: '1',
        label: 'key',
        encryptedKey: 'enc',
        salt: 'salt',
        iv: 'iv',
        iterations: 1,
        keyLength: 1,
        algorithm: 'AES',
        createdAt: new Date().toISOString(),
      },
    ],
    currentSession: '1',
  };
  assert.equal(isStorageData(sample), true);
  mgr.importData(JSON.stringify(sample));
  assert.equal(mgr.getApiKeys().length, 1);
  assert.equal(mgr.getCurrentSession(), '1');
});

test('importData throws on invalid data without modifying existing state', async () => {
  resetStorage();
  const { StorageManager, isStorageData } = await import('../src/lib/storage.ts');
  const mgr = new StorageManager();
  const bad = { apiKeys: [{ id: '1', label: 'x' }] };
  assert.equal(isStorageData(bad), false);
  assert.throws(() => mgr.importData(JSON.stringify(bad)), /Invalid data format/);
  assert.equal(mgr.getApiKeys().length, 0);
  assert.equal(mgr.getCurrentSession(), undefined);
});
