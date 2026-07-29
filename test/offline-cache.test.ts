import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  cacheZoneRecords,
  clearOfflineCache,
  formatCacheAge,
  getCachedZoneRecords,
  getCacheIndex,
  hasCachedRecords,
} from "../src/lib/storage/offline-cache";
import { RESOURCE_LIMITS } from "../src/lib/resource-limits";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";

const CACHE_KEY_PREFIX = "bc_offline_cache_";
const CACHE_INDEX_KEY = "bc_offline_cache_index";

function rawCacheEntry(
  zoneId: string,
  cachedAt: number,
  records: unknown[] = [],
): string {
  return JSON.stringify({
    zoneId,
    zoneName: `Zone ${zoneId}`,
    records,
    cachedAt,
  });
}

function ownedEntryKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(CACHE_KEY_PREFIX) && key !== CACHE_INDEX_KEY) {
      keys.push(key);
    }
  }
  return keys.sort();
}

function failNextSetAfterWriting(targetKey: string): () => void {
  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  let armed = true;
  storagePrototype.setItem = function setItemWithFailure(
    this: Storage,
    key: string,
    value: string,
  ): void {
    originalSetItem.call(this, key, value);
    if (armed && key === targetKey) {
      armed = false;
      throw new Error(`forced setItem failure for ${key}`);
    }
  };
  return () => {
    storagePrototype.setItem = originalSetItem;
  };
}

function failNextRemoveAfterDeleting(targetKey: string): () => void {
  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalRemoveItem = storagePrototype.removeItem;
  let armed = true;
  storagePrototype.removeItem = function removeItemWithFailure(
    this: Storage,
    key: string,
  ): void {
    originalRemoveItem.call(this, key);
    if (armed && key === targetKey) {
      armed = false;
      throw new Error(`forced removeItem failure for ${key}`);
    }
  };
  return () => {
    storagePrototype.removeItem = originalRemoveItem;
  };
}

afterEach(() => {
  clearOfflineCache();
  resetRuntimeReportingForTests();
});

test("preserves normal offline cache reads and age formatting", () => {
  cacheZoneRecords("zone-a", "Example", [{ id: "record-a" }]);

  assert.equal(hasCachedRecords("zone-a"), true);
  assert.deepEqual(getCachedZoneRecords("zone-a"), {
    zoneId: "zone-a",
    zoneName: "Example",
    records: [{ id: "record-a" }],
    cachedAt: getCachedZoneRecords("zone-a")?.cachedAt,
  });
  assert.deepEqual(getCacheIndex(), ["zone-a"]);
  assert.equal(formatCacheAge(59_000), "59s ago");
  assert.equal(formatCacheAge(60_000), "1m ago");
});

test("evicts deterministically at count limit+1 after accepting limit-1 and exact limit", () => {
  const hardLimit = RESOURCE_LIMITS.offlineCache.hardEntries;
  for (let index = 0; index < hardLimit - 1; index += 1) {
    cacheZoneRecords(`zone-${index}`, `Zone ${index}`, []);
  }
  assert.equal(getCacheIndex().length, hardLimit - 1);

  cacheZoneRecords(`zone-${hardLimit - 1}`, `Zone ${hardLimit - 1}`, []);
  assert.equal(getCacheIndex().length, hardLimit);

  // Rewriting the original oldest entry makes it the newest deterministic item.
  cacheZoneRecords("zone-0", "Zone 0 updated", []);
  cacheZoneRecords(`zone-${hardLimit}`, `Zone ${hardLimit}`, []);

  const index = getCacheIndex();
  assert.equal(index.length, hardLimit);
  assert.equal(index[0], "zone-2");
  assert.equal(index.at(-2), "zone-0");
  assert.equal(index.at(-1), `zone-${hardLimit}`);
  assert.equal(getCachedZoneRecords("zone-0")?.zoneName, "Zone 0 updated");
  assert.equal(getCachedZoneRecords("zone-1"), null);
  assert.ok(getCachedZoneRecords("zone-0"));
});

test("uses retained UTF-8 bytes to evict oldest entries deterministically", () => {
  const payloadSize = Math.ceil(RESOURCE_LIMITS.offlineCache.hardBytes / 12);
  const payload = "😀".repeat(payloadSize);
  for (let index = 0; index < 4; index += 1) {
    cacheZoneRecords(`large-${index}`, `Large ${index}`, [payload]);
  }

  assert.deepEqual(getCacheIndex(), ["large-2", "large-3"]);
  assert.equal(getCachedZoneRecords("large-0"), null);
  assert.equal(getCachedZoneRecords("large-1"), null);
  assert.ok(getCachedZoneRecords("large-2"));
  assert.ok(getCachedZoneRecords("large-3"));
});

test("rejects an oversized replacement without discarding the cached value", () => {
  cacheZoneRecords("stable", "Stable Zone", [{ id: "existing" }]);
  cacheZoneRecords("stable", "Oversized", [
    "x".repeat(RESOURCE_LIMITS.offlineCache.hardBytes),
  ]);

  assert.equal(getCachedZoneRecords("stable")?.zoneName, "Stable Zone");
  assert.deepEqual(getCacheIndex(), ["stable"]);
  assert.match(
    getRuntimeDiagnostics()[0]?.label ?? "",
    /Write DNS offline cache: resource limit reached/,
  );
});

test("recovers a missing index, enforces the exact count limit, and purges orphans", () => {
  const hardLimit = RESOURCE_LIMITS.offlineCache.hardEntries;
  for (let index = 0; index <= hardLimit; index += 1) {
    const zoneId = `recovery-${index}`;
    localStorage.setItem(
      `${CACHE_KEY_PREFIX}${zoneId}`,
      rawCacheEntry(zoneId, index),
    );
  }

  const recovered = getCacheIndex();
  assert.equal(recovered.length, hardLimit);
  assert.equal(recovered[0], "recovery-1");
  assert.equal(recovered.at(-1), `recovery-${hardLimit}`);
  assert.equal(localStorage.getItem(`${CACHE_KEY_PREFIX}recovery-0`), null);
  assert.deepEqual(
    ownedEntryKeys(),
    recovered.map((zoneId) => `${CACHE_KEY_PREFIX}${zoneId}`).sort(),
  );
});

test("recovers a malformed index within byte limits and removes corrupt owned keys", () => {
  const payload = "😀".repeat(
    Math.ceil(RESOURCE_LIMITS.offlineCache.hardBytes / 12),
  );
  localStorage.setItem(CACHE_INDEX_KEY, "{malformed");
  for (let index = 0; index < 4; index += 1) {
    const zoneId = `byte-recovery-${index}`;
    localStorage.setItem(
      `${CACHE_KEY_PREFIX}${zoneId}`,
      rawCacheEntry(zoneId, index, [payload]),
    );
  }
  localStorage.setItem(`${CACHE_KEY_PREFIX}corrupt`, "{not-json");

  const recovered = getCacheIndex();
  assert.deepEqual(recovered, ["byte-recovery-2", "byte-recovery-3"]);
  assert.equal(localStorage.getItem(`${CACHE_KEY_PREFIX}corrupt`), null);
  assert.deepEqual(
    ownedEntryKeys(),
    recovered.map((zoneId) => `${CACHE_KEY_PREFIX}${zoneId}`).sort(),
  );
});

test("rolls back a replaced entry and index when the entry write mutates then fails", () => {
  cacheZoneRecords("stable", "Stable Zone", [{ id: "before" }]);
  const entryKey = `${CACHE_KEY_PREFIX}stable`;
  const previousEntry = localStorage.getItem(entryKey);
  const previousIndex = localStorage.getItem(CACHE_INDEX_KEY);
  const restoreSetItem = failNextSetAfterWriting(entryKey);

  try {
    cacheZoneRecords("stable", "Replacement", [{ id: "after" }]);
  } finally {
    restoreSetItem();
  }

  assert.equal(localStorage.getItem(entryKey), previousEntry);
  assert.equal(localStorage.getItem(CACHE_INDEX_KEY), previousIndex);
  assert.equal(getCachedZoneRecords("stable")?.zoneName, "Stable Zone");
});

test("rolls back a new entry and index before deleting old data when index write fails", () => {
  const hardLimit = RESOURCE_LIMITS.offlineCache.hardEntries;
  for (let index = 0; index < hardLimit; index += 1) {
    cacheZoneRecords(`durable-${index}`, `Durable ${index}`, []);
  }
  const previousIndex = localStorage.getItem(CACHE_INDEX_KEY);
  const oldestKey = `${CACHE_KEY_PREFIX}durable-0`;
  const previousOldest = localStorage.getItem(oldestKey);
  const incomingKey = `${CACHE_KEY_PREFIX}durable-${hardLimit}`;
  const restoreSetItem = failNextSetAfterWriting(CACHE_INDEX_KEY);

  try {
    cacheZoneRecords(`durable-${hardLimit}`, "Incoming", []);
  } finally {
    restoreSetItem();
  }

  assert.equal(localStorage.getItem(incomingKey), null);
  assert.equal(localStorage.getItem(CACHE_INDEX_KEY), previousIndex);
  assert.equal(localStorage.getItem(oldestKey), previousOldest);
  assert.equal(getCacheIndex()[0], "durable-0");
  assert.equal(getCacheIndex().length, hardLimit);
});

test("restores deleted entries when eviction fails after data and index writes", () => {
  const hardLimit = RESOURCE_LIMITS.offlineCache.hardEntries;
  for (let index = 0; index < hardLimit; index += 1) {
    cacheZoneRecords(`rollback-${index}`, `Rollback ${index}`, []);
  }
  const previousIndex = localStorage.getItem(CACHE_INDEX_KEY);
  const oldestKey = `${CACHE_KEY_PREFIX}rollback-0`;
  const previousOldest = localStorage.getItem(oldestKey);
  const incomingKey = `${CACHE_KEY_PREFIX}rollback-${hardLimit}`;
  const restoreRemoveItem = failNextRemoveAfterDeleting(oldestKey);

  try {
    cacheZoneRecords(`rollback-${hardLimit}`, "Incoming", []);
  } finally {
    restoreRemoveItem();
  }

  assert.equal(localStorage.getItem(incomingKey), null);
  assert.equal(localStorage.getItem(CACHE_INDEX_KEY), previousIndex);
  assert.equal(localStorage.getItem(oldestKey), previousOldest);
  assert.equal(getCacheIndex()[0], "rollback-0");
  assert.equal(getCacheIndex().length, hardLimit);
});
