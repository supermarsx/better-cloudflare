import assert from "node:assert/strict";
import { test } from "node:test";
import {
  StorageManager,
  StoragePersistenceError,
  isStorageData,
} from "../src/lib/storage/storage.ts";
import { CryptoManager } from "../src/lib/auth/crypto.ts";
import { createMigratingStorage } from "../src/lib/storage/storage-util.ts";

class LocalStorageMock {
  protected store: Record<string, string> = {};
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
const RECOVERY_KEY = `${STORAGE_KEY}:recovery`;

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
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}"), {
    __storageRevision: 1,
  });
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

test("load scrubs legacy credentials and retains preferences", () => {
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
    lastZone: "zone-1",
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(sample));
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  assert.equal(mgr.getApiKeys().length, 0);
  assert.equal(mgr.getCurrentSession(), undefined);
  assert.equal(mgr.getLastZone(), "zone-1");
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}"), {
    lastZone: "zone-1",
  });
});

test("load removes invalid primary and recovery data before a safe rewrite", () => {
  const storage = new LocalStorageMock();
  const corruptRaw = JSON.stringify({ apiKeys: "nope" });
  storage.setItem(STORAGE_KEY, corruptRaw);
  storage.setItem(RECOVERY_KEY, JSON.stringify({ raw: corruptRaw }));
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  assert.equal(mgr.getApiKeys().length, 0);
  assert.equal(mgr.getCurrentSession(), undefined);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(storage.getItem(RECOVERY_KEY), null);
  assert.equal(mgr.getRecoverySnapshot()?.raw, corruptRaw);
  mgr.setLastZone("recovered");
  assert.equal(mgr.getRecoverySnapshot(), null);
  assert.equal(storage.getItem(STORAGE_KEY)?.includes(corruptRaw), false);
});

test("deferred legacy hydration blocks writes and loads durable keys before use", async () => {
  const durable = new LocalStorageMock();
  let release!: (values: ReadonlyMap<string, string>) => void;
  const deferred = new Promise<ReadonlyMap<string, string>>((resolve) => {
    release = resolve;
  });
  const storage = createMigratingStorage(durable, () => deferred);
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  const sample = {
    apiKeys: [],
    currentSession: "legacy-session",
  };

  assert.throws(
    () => mgr.setCurrentSession("premature"),
    StoragePersistenceError,
  );
  assert.equal(mgr.getCurrentSession(), undefined);
  release(new Map([[STORAGE_KEY, JSON.stringify(sample)]]));
  await mgr.ready();

  assert.equal(mgr.getCurrentSession(), undefined);
  mgr.setLastZone("zone-after-ready");
  const restarted = new StorageManager(storage, new CryptoManager({}, storage));
  await restarted.ready();
  assert.equal(restarted.getCurrentSession(), undefined);
  assert.equal(restarted.getLastZone(), "zone-after-ready");
});

test("failed writes roll back the complete in-memory mutation", () => {
  class FailingStorage extends LocalStorageMock {
    fail = false;
    override setItem(key: string, value: string): void {
      if (this.fail && key === STORAGE_KEY) {
        throw new DOMException("quota full", "QuotaExceededError");
      }
      super.setItem(key, value);
    }
  }
  const storage = new FailingStorage();
  const mgr = new StorageManager(storage, new CryptoManager({}, storage));
  mgr.setCurrentSession("stable");
  const stableRaw = storage.getItem(STORAGE_KEY);
  storage.fail = true;

  assert.throws(
    () => mgr.setCurrentSession("not-durable"),
    StoragePersistenceError,
  );
  assert.equal(mgr.getCurrentSession(), "stable");
  assert.equal(storage.getItem(STORAGE_KEY), stableRaw);
});

test("failed clear restores durable and in-memory data", () => {
  class FailingDeleteStorage extends LocalStorageMock {
    fail = false;
    override removeItem(key: string): void {
      if (this.fail && key === STORAGE_KEY) {
        throw new DOMException("delete denied", "SecurityError");
      }
      super.removeItem(key);
    }
  }
  const storage = new FailingDeleteStorage();
  const mgr = new StorageManager(storage, new CryptoManager({}, storage));
  mgr.setCurrentSession("stable");
  const stableRaw = storage.getItem(STORAGE_KEY);
  storage.fail = true;

  assert.throws(() => mgr.clearAllData(), StoragePersistenceError);
  assert.equal(mgr.getCurrentSession(), "stable");
  assert.equal(storage.getItem(STORAGE_KEY), stableRaw);
});

test("nonconflicting preferences merge while sessions remain runtime-only", () => {
  const storage = new LocalStorageMock();
  const first = new StorageManager(storage, new CryptoManager({}, storage));
  const second = new StorageManager(storage, new CryptoManager({}, storage));

  first.setCurrentSession("session-a");
  second.setLastZone("zone-b");

  const restarted = new StorageManager(storage, new CryptoManager({}, storage));
  assert.equal(first.getCurrentSession(), "session-a");
  assert.equal(restarted.getCurrentSession(), undefined);
  assert.equal(restarted.getLastZone(), "zone-b");
});

test("API keys stay in their manager and unrelated saves cannot persist them", async () => {
  const storage = new LocalStorageMock();
  const first = new StorageManager(storage, new CryptoManager({}, storage));
  const second = new StorageManager(storage, new CryptoManager({}, storage));

  const [firstId, secondId] = await Promise.all([
    first.addApiKey("first", "secret-a", "password"),
    second.addApiKey("second", "secret-b", "password"),
  ]);

  const restarted = new StorageManager(storage, new CryptoManager({}, storage));
  assert.equal(first.getApiKeys()[0]?.id, firstId);
  assert.equal(second.getApiKeys()[0]?.id, secondId);
  assert.equal(restarted.getApiKeys().length, 0);
  assert.doesNotMatch(storage.getItem(STORAGE_KEY) ?? "", /encryptedKey|email/);
});

test("import rejects oversized, deep and non-finite storage metadata", () => {
  const storage = new LocalStorageMock();
  const mgr = new StorageManager(storage, new CryptoManager({}, storage));
  const oversized = JSON.stringify({
    apiKeys: [],
    lastZone: "x".repeat(2 * 1024 * 1024),
  });
  assert.throws(() => mgr.importData(oversized), /no larger than/);

  let deep: Record<string, unknown> = { apiKeys: [] };
  for (let index = 0; index < 20; index += 1) {
    deep = { apiKeys: [], nested: deep };
  }
  assert.throws(() => mgr.importData(JSON.stringify(deep)), /no larger than/);
  assert.equal(
    isStorageData({ apiKeys: [], idleLogoutMs: Number.POSITIVE_INFINITY }),
    false,
  );
});

test("falls back to in-memory storage when localStorage is unavailable", async () => {
  const globalAsRecord = globalThis as unknown as {
    localStorage?: Storage;
  };
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  if (originalDescriptor) {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => undefined,
    });
  } else {
    delete globalAsRecord.localStorage;
  }

  const crypto = new CryptoManager();
  const mgr = new StorageManager(undefined, crypto);
  const id = await mgr.addApiKey("label", "secret", "pw");
  assert.ok(id);
  assert.equal(mgr.getApiKeys().length, 1);
  const mgr2 = new StorageManager(undefined, crypto);
  assert.equal(mgr2.getApiKeys().length, 0);

  if (originalDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalDescriptor);
  } else {
    globalAsRecord.localStorage = undefined;
  }
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
  const crypto = new CryptoManager({}, storage);
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

test("reserved dictionary-like identifiers survive import and restart as own data", () => {
  const storage = new LocalStorageMock();
  const crypto = new CryptoManager({}, storage);
  const mgr = new StorageManager(storage, crypto);
  const imported = JSON.parse(`{
    "apiKeys": [],
    "recordTags": {
      "__proto__": {
        "constructor": [" protected "]
      }
    },
    "tagCatalog": {
      "__proto__": [" protected "]
    }
  }`);

  mgr.importData(JSON.stringify(imported));
  const restarted = new StorageManager(storage, new CryptoManager({}, storage));

  assert.deepEqual(restarted.getRecordTags("__proto__", "constructor"), [
    "protected",
  ]);
  assert.deepEqual(restarted.getZoneTags("__proto__"), ["protected"]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(Object.prototype, "protected"),
    false,
  );
});
