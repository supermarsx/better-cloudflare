import assert from "node:assert/strict";
import { test } from "node:test";
import { StorageManager, isStorageData } from "../src/lib/storage.ts";
import { CryptoManager } from "../src/lib/crypto.ts";

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

const STORAGE_KEY = "cloudflare-dns-manager";

test("importData accepts valid data", () => {
  const storage = new LocalStorageMock();
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  const sample = {
    apiKeys: [
      {
        id: "1",
        label: "key",
        encryptedKey: "enc",
        salt: "salt",
        iv: "iv",
        iterations: 1,
        keyLength: 1,
        algorithm: "AES-GCM",
        createdAt: new Date().toISOString(),
      },
    ],
    currentSession: "1",
  };
  assert.equal(isStorageData(sample), true);
  mgr.importData(JSON.stringify(sample));
  assert.equal(mgr.getApiKeys().length, 1);
  assert.equal(mgr.getCurrentSession(), "1");
});

test("importData throws on invalid data without modifying existing state", () => {
  const storage = new LocalStorageMock();
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  const bad = { apiKeys: [{ id: "1", label: "x" }] };
  assert.equal(isStorageData(bad), false);
  assert.throws(
    () => mgr.importData(JSON.stringify(bad)),
    /Invalid data format/,
  );
  assert.equal(mgr.getApiKeys().length, 0);
  assert.equal(mgr.getCurrentSession(), undefined);
});

test("load uses valid stored data", () => {
  const storage = new LocalStorageMock();
  const sample = {
    apiKeys: [
      {
        id: "1",
        label: "key",
        encryptedKey: "enc",
        salt: "salt",
        iv: "iv",
        iterations: 1,
        keyLength: 1,
        algorithm: "AES-GCM",
        createdAt: new Date().toISOString(),
      },
    ],
    currentSession: "1",
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(sample));
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  assert.equal(mgr.getApiKeys().length, 1);
  assert.equal(mgr.getCurrentSession(), "1");
});

test("load resets state and clears invalid stored data", () => {
  const storage = new LocalStorageMock();
  storage.setItem(STORAGE_KEY, JSON.stringify({ apiKeys: "nope" }));
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  assert.equal(mgr.getApiKeys().length, 0);
  assert.equal(mgr.getCurrentSession(), undefined);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("falls back to in-memory storage when localStorage is unavailable", async () => {
  const crypto = new CryptoManager({ iterations: 1 });
  const mgr = new StorageManager(undefined, crypto);
  const id = await mgr.addApiKey("label", "secret", "pw");
  assert.ok(id);
  assert.equal(mgr.getApiKeys().length, 1);
  const mgr2 = new StorageManager(undefined, crypto);
  assert.equal(mgr2.getApiKeys().length, 0);
});

test("stores and clears last selected zone", () => {
  const storage = new LocalStorageMock();
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  mgr.setLastZone("zone-1");
  assert.equal(mgr.getLastZone(), "zone-1");
  mgr.clearSession();
  assert.equal(mgr.getLastZone(), undefined);
});

test("updateApiKey modifies metadata and re-encrypts with new password", async () => {
  const storage = new LocalStorageMock();
  const crypto = new CryptoManager({ iterations: 1 }, storage);
  const mgr = new StorageManager(storage, crypto);
  const id = await mgr.addApiKey("label", "secret", "pw", "old@example.com");
  await mgr.updateApiKey(id, { label: "new", email: "new@example.com" });
  const key = mgr.getApiKeys()[0];
  assert.equal(key.label, "new");
  assert.equal(key.email, "new@example.com");

  await mgr.updateApiKey(id, { currentPassword: "pw", newPassword: "pw2" });
  const decrypted = await mgr.getDecryptedApiKey(id, "pw2");
  assert.equal(decrypted?.key, "secret");
  const old = await mgr.getDecryptedApiKey(id, "pw");
  assert.equal(old, null);
});

test("tag catalog rename/delete works before any record association exists", () => {
  const storage = new LocalStorageMock();
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  const zoneId = "zone-1";

  mgr.addZoneTag(zoneId, "ops");
  assert.deepEqual(mgr.getZoneTags(zoneId), ["ops"]);

  mgr.renameTag(zoneId, "ops", "production");
  assert.deepEqual(mgr.getZoneTags(zoneId), ["production"]);

  mgr.deleteTag(zoneId, "production");
  assert.deepEqual(mgr.getZoneTags(zoneId), []);
});

test("record tag clear and move keep associations consistent", () => {
  const storage = new LocalStorageMock();
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  const zoneId = "zone-1";

  mgr.setRecordTags(zoneId, "from", ["one", "two"]);
  mgr.moveRecordTags(zoneId, "from", "to");
  assert.deepEqual(mgr.getRecordTags(zoneId, "from"), []);
  assert.deepEqual(mgr.getRecordTags(zoneId, "to"), ["one", "two"]);

  mgr.clearRecordTags(zoneId, "to");
  assert.deepEqual(mgr.getRecordTags(zoneId, "to"), []);
  assert.deepEqual(mgr.getTagUsageCounts(zoneId), {});
});

test("importData sanitizes record tags and tag catalog payloads", () => {
  const storage = new LocalStorageMock();
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  const imported = {
    apiKeys: [],
    recordTags: {
      "zone-1": {
        r1: [" alpha ", "", "alpha", 123],
      },
    },
    tagCatalog: {
      "zone-1": [" beta ", "beta", "", 456],
    },
  };

  mgr.importData(JSON.stringify(imported));

  assert.deepEqual(mgr.getRecordTags("zone-1", "r1"), ["alpha"]);
  assert.deepEqual(mgr.getZoneTags("zone-1"), ["beta"]);
});
