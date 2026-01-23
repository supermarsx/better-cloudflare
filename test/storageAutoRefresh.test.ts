import assert from "node:assert/strict";
import { test } from "node:test";
import { StorageManager } from "../src/lib/storage";
import type { StorageLike } from "../src/lib/storage-util";

function createStorage(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key: string, value: string) {
      data[key] = String(value);
    },
    removeItem(key: string) {
      delete data[key];
    },
  };
}

test("auto refresh interval persists", () => {
  const storage = createStorage();
  const mgr = new StorageManager(storage);
  mgr.setAutoRefreshInterval(60000);
  assert.equal(mgr.getAutoRefreshInterval(), 60000);

  const mgr2 = new StorageManager(storage);
  assert.equal(mgr2.getAutoRefreshInterval(), 60000);

  mgr2.setAutoRefreshInterval(null);
  assert.equal(mgr2.getAutoRefreshInterval(), null);
});
