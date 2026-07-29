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
const CACHE_COORDINATION_KEY = "bc_offline_cache_coordination";

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

function zoneIdFromRawEntry(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed &&
      typeof parsed === "object" &&
      "zoneId" in parsed &&
      typeof parsed.zoneId === "string"
      ? parsed.zoneId
      : undefined;
  } catch {
    return undefined;
  }
}

function entryKeyForZone(zoneId: string): string | undefined {
  return ownedEntryKeys().find((key) => {
    const raw = localStorage.getItem(key);
    return raw !== null && zoneIdFromRawEntry(raw) === zoneId;
  });
}

function ownedEntryZoneIds(): string[] {
  return ownedEntryKeys()
    .map((key) => {
      const raw = localStorage.getItem(key);
      return raw === null ? undefined : zoneIdFromRawEntry(raw);
    })
    .filter((zoneId): zoneId is string => zoneId !== undefined)
    .sort();
}

function rawIndexZoneIds(): string[] {
  const raw = localStorage.getItem(CACHE_INDEX_KEY);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as string[];
  return (parsed as { zoneIds: string[] }).zoneIds;
}

function namedStorageError(name: string, message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "name", { value: name });
  return error;
}

async function waitFor(
  predicate: () => boolean,
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached within the deterministic task budget");
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

function failNextEntrySetAfterWriting(zoneId: string): () => void {
  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  let armed = true;
  storagePrototype.setItem = function setEntryWithFailure(
    this: Storage,
    key: string,
    value: string,
  ): void {
    originalSetItem.call(this, key, value);
    if (armed && zoneIdFromRawEntry(value) === zoneId) {
      armed = false;
      throw new Error(`forced entry setItem failure for ${zoneId}`);
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

afterEach(async () => {
  clearOfflineCache();
  await waitFor(
    () =>
      ownedEntryKeys().length === 0 &&
      localStorage.getItem(CACHE_INDEX_KEY) === null,
    500,
  );
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

test("reconciles a deterministic stale-index interleaving from a second module instance", async () => {
  const secondTab = (await import(
    new URL("../src/lib/storage/offline-cache.ts?second-tab", import.meta.url)
      .href
  )) as typeof import("../src/lib/storage/offline-cache");
  assert.notEqual(secondTab.cacheZoneRecords, cacheZoneRecords);

  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  let injected = false;
  let observedStaleOverwrite = false;
  storagePrototype.setItem = function setItemWithInterleaving(
    this: Storage,
    key: string,
    value: string,
  ): void {
    originalSetItem.call(this, key, value);
    if (!injected && zoneIdFromRawEntry(value) === "tab-a") {
      injected = true;
      secondTab.cacheZoneRecords("tab-b", "Tab B", []);
      return;
    }
    if (
      injected &&
      key === CACHE_INDEX_KEY &&
      JSON.stringify(rawIndexZoneIds()) === JSON.stringify(["tab-a"])
    ) {
      observedStaleOverwrite = true;
    }
  };

  try {
    cacheZoneRecords("tab-a", "Tab A", []);
  } finally {
    storagePrototype.setItem = originalSetItem;
  }

  assert.equal(injected, true);
  assert.equal(observedStaleOverwrite, true);
  assert.deepEqual(getCacheIndex(), ["tab-a", "tab-b"]);
  assert.deepEqual(rawIndexZoneIds(), ["tab-a", "tab-b"]);
  assert.deepEqual(ownedEntryZoneIds(), ["tab-a", "tab-b"]);
});

test("immutable entry versions survive a concurrent replacement during stale eviction", async () => {
  const hardLimit = RESOURCE_LIMITS.offlineCache.hardEntries;
  for (let index = 0; index < hardLimit; index += 1) {
    cacheZoneRecords(`race-${index}`, `Original ${index}`, []);
  }
  const oldestKey = entryKeyForZone("race-0");
  assert.ok(oldestKey);

  const secondTab = (await import(
    new URL("../src/lib/storage/offline-cache.ts?eviction-tab", import.meta.url)
      .href
  )) as typeof import("../src/lib/storage/offline-cache");
  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalRemoveItem = storagePrototype.removeItem;
  let injected = false;
  storagePrototype.removeItem = function removeWithConcurrentReplacement(
    this: Storage,
    key: string,
  ): void {
    if (!injected && key === oldestKey) {
      injected = true;
      secondTab.cacheZoneRecords("race-0", "Concurrent replacement", []);
    }
    originalRemoveItem.call(this, key);
  };

  try {
    cacheZoneRecords("race-incoming", "Concurrent incoming", []);
  } finally {
    storagePrototype.removeItem = originalRemoveItem;
  }

  const index = getCacheIndex();
  assert.equal(injected, true);
  assert.equal(index.length, hardLimit);
  assert.equal(index.includes("race-0"), true);
  assert.equal(index.includes("race-incoming"), true);
  assert.equal(index.includes("race-1"), false);
  assert.equal(
    getCachedZoneRecords("race-0")?.zoneName,
    "Concurrent replacement",
  );
  assert.deepEqual(ownedEntryZoneIds(), [...index].sort());
});

test("recovery yields between bounded batches and resumes past 650 unrelated keys", async () => {
  const unrelatedKeys = Array.from(
    { length: 650 },
    (_, index) => `unrelated-${index.toString().padStart(4, "0")}`,
  );
  for (const key of unrelatedKeys) localStorage.setItem(key, "unrelated");
  localStorage.setItem(
    `${CACHE_KEY_PREFIX}after-unrelated-a`,
    rawCacheEntry("after-unrelated-a", 1),
  );
  localStorage.setItem(
    `${CACHE_KEY_PREFIX}after-unrelated-b`,
    rawCacheEntry("after-unrelated-b", 2),
  );

  try {
    assert.deepEqual(getCacheIndex(), []);
    await waitFor(
      () =>
        JSON.stringify(getCacheIndex()) ===
        JSON.stringify(["after-unrelated-a", "after-unrelated-b"]),
    );
    assert.deepEqual(rawIndexZoneIds(), [
      "after-unrelated-a",
      "after-unrelated-b",
    ]);

    clearOfflineCache();
    await waitFor(
      () =>
        ownedEntryKeys().length === 0 &&
        localStorage.getItem(CACHE_INDEX_KEY) === null,
    );

    assert.deepEqual(ownedEntryKeys(), []);
    assert.equal(localStorage.getItem(CACHE_INDEX_KEY), null);
    assert.equal(localStorage.getItem(unrelatedKeys[0]!), "unrelated");
    assert.equal(localStorage.getItem(unrelatedKeys.at(-1)!), "unrelated");
  } finally {
    for (const key of unrelatedKeys) localStorage.removeItem(key);
  }
});

test("over-cap recovery retains the newest valid timestamps from 1,000 entries", async () => {
  const entryCount = 1_000;
  const hardLimit = RESOURCE_LIMITS.offlineCache.hardEntries;
  for (let index = entryCount - 1; index >= 0; index -= 1) {
    const zoneId = `top-k-${index.toString().padStart(4, "0")}`;
    localStorage.setItem(
      `${CACHE_KEY_PREFIX}${zoneId}`,
      rawCacheEntry(zoneId, index),
    );
  }

  assert.deepEqual(getCacheIndex(), []);
  await waitFor(() => getCacheIndex().length === hardLimit);

  const expected = Array.from(
    { length: hardLimit },
    (_, index) =>
      `top-k-${(entryCount - hardLimit + index).toString().padStart(4, "0")}`,
  );
  assert.deepEqual(getCacheIndex(), expected);
  assert.deepEqual(ownedEntryZoneIds(), [...expected].sort());
});

test("takes over a stale lease and reconciles a crashed data-only write without storage events", () => {
  localStorage.setItem(
    CACHE_COORDINATION_KEY,
    JSON.stringify({
      owner: "crashed-tab",
      token: "abandoned-operation",
      expiresAt: Date.now() - 1,
    }),
  );
  localStorage.setItem(
    `${CACHE_KEY_PREFIX}crash-recovery`,
    rawCacheEntry("crash-recovery", 1),
  );

  assert.deepEqual(getCacheIndex(), ["crash-recovery"]);
  assert.deepEqual(rawIndexZoneIds(), ["crash-recovery"]);
  assert.equal(localStorage.getItem(CACHE_COORDINATION_KEY), null);
});

test("self-heals an orphan and absent index claim after repeated quota and access failures", () => {
  cacheZoneRecords("stable", "Stable", []);
  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  const originalRemoveItem = storagePrototype.removeItem;
  let quotaFailures = 3;
  let rollbackAccessFailures = 2;
  let orphanKey: string | undefined;

  storagePrototype.setItem = function setItemWithRepeatedQuotaFailure(
    this: Storage,
    key: string,
    value: string,
  ): void {
    if (zoneIdFromRawEntry(value) === "orphan") {
      orphanKey = key;
    }
    if (key === CACHE_INDEX_KEY && quotaFailures > 0) {
      quotaFailures -= 1;
      throw namedStorageError(
        "QuotaExceededError",
        "forced repeated index quota failure",
      );
    }
    originalSetItem.call(this, key, value);
  };
  storagePrototype.removeItem = function removeWithRepeatedAccessFailure(
    this: Storage,
    key: string,
  ): void {
    if (key === orphanKey && rollbackAccessFailures > 0) {
      rollbackAccessFailures -= 1;
      throw namedStorageError(
        "SecurityError",
        "forced repeated rollback access failure",
      );
    }
    originalRemoveItem.call(this, key);
  };

  try {
    cacheZoneRecords("orphan", "Recovered orphan", []);
  } finally {
    storagePrototype.setItem = originalSetItem;
    storagePrototype.removeItem = originalRemoveItem;
  }

  assert.equal(quotaFailures, 0);
  assert.ok(rollbackAccessFailures < 2);
  assert.ok(orphanKey);
  assert.ok(localStorage.getItem(orphanKey));
  const stableKey = entryKeyForZone("stable");
  assert.ok(stableKey);
  originalRemoveItem.call(localStorage, stableKey);
  assert.deepEqual(rawIndexZoneIds(), ["stable"]);

  const originalGetItem = storagePrototype.getItem;
  let readAccessFailures = 2;
  storagePrototype.getItem = function getWithRepeatedAccessFailure(
    this: Storage,
    key: string,
  ): string | null {
    if (key === CACHE_INDEX_KEY && readAccessFailures > 0) {
      readAccessFailures -= 1;
      throw namedStorageError(
        "SecurityError",
        "forced repeated recovery access failure",
      );
    }
    return originalGetItem.call(this, key);
  };
  try {
    assert.deepEqual(getCacheIndex(), []);
    assert.deepEqual(getCacheIndex(), []);
  } finally {
    storagePrototype.getItem = originalGetItem;
  }

  assert.equal(readAccessFailures, 0);
  assert.deepEqual(getCacheIndex(), ["orphan"]);
  assert.deepEqual(rawIndexZoneIds(), ["orphan"]);
  assert.deepEqual(ownedEntryZoneIds(), ["orphan"]);
  assert.equal(getCachedZoneRecords("orphan")?.zoneName, "Recovered orphan");
});

test("rolls back a replaced entry and index when the entry write mutates then fails", () => {
  cacheZoneRecords("stable", "Stable Zone", [{ id: "before" }]);
  const entryKey = entryKeyForZone("stable");
  assert.ok(entryKey);
  const previousEntry = localStorage.getItem(entryKey);
  const previousIndex = localStorage.getItem(CACHE_INDEX_KEY);
  const restoreSetItem = failNextEntrySetAfterWriting("stable");

  try {
    cacheZoneRecords("stable", "Replacement", [{ id: "after" }]);
  } finally {
    restoreSetItem();
  }

  assert.equal(localStorage.getItem(entryKey), previousEntry);
  assert.equal(localStorage.getItem(CACHE_INDEX_KEY), previousIndex);
  assert.deepEqual(ownedEntryZoneIds(), ["stable"]);
  assert.equal(getCachedZoneRecords("stable")?.zoneName, "Stable Zone");
});

test("rolls back a new entry and index before deleting old data when index write fails", () => {
  const hardLimit = RESOURCE_LIMITS.offlineCache.hardEntries;
  for (let index = 0; index < hardLimit; index += 1) {
    cacheZoneRecords(`durable-${index}`, `Durable ${index}`, []);
  }
  const previousIndex = localStorage.getItem(CACHE_INDEX_KEY);
  const oldestKey = entryKeyForZone("durable-0");
  assert.ok(oldestKey);
  const previousOldest = localStorage.getItem(oldestKey);
  const restoreSetItem = failNextSetAfterWriting(CACHE_INDEX_KEY);

  try {
    cacheZoneRecords(`durable-${hardLimit}`, "Incoming", []);
  } finally {
    restoreSetItem();
  }

  assert.equal(entryKeyForZone(`durable-${hardLimit}`), undefined);
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
  const oldestKey = entryKeyForZone("rollback-0");
  assert.ok(oldestKey);
  const previousOldest = localStorage.getItem(oldestKey);
  const restoreRemoveItem = failNextRemoveAfterDeleting(oldestKey);

  try {
    cacheZoneRecords(`rollback-${hardLimit}`, "Incoming", []);
  } finally {
    restoreRemoveItem();
  }

  assert.equal(entryKeyForZone(`rollback-${hardLimit}`), undefined);
  assert.equal(localStorage.getItem(CACHE_INDEX_KEY), previousIndex);
  assert.equal(localStorage.getItem(oldestKey), previousOldest);
  assert.equal(getCacheIndex()[0], "rollback-0");
  assert.equal(getCacheIndex().length, hardLimit);
});

test("retries an evicted durable entry restoration after the first rollback failure", (t) => {
  const hardLimit = RESOURCE_LIMITS.offlineCache.hardEntries;
  for (let index = 0; index < hardLimit; index += 1) {
    cacheZoneRecords(`retry-${index}`, `Retry ${index}`, []);
  }
  const oldestKey = entryKeyForZone("retry-0");
  assert.ok(oldestKey);
  const oldestRaw = localStorage.getItem(oldestKey);
  const previousIndex = localStorage.getItem(CACHE_INDEX_KEY);
  assert.ok(oldestRaw);
  assert.ok(previousIndex);

  t.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.now(),
  });
  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  let indexFailureArmed = true;
  let restorationFailureArmed = true;
  storagePrototype.setItem = function failIndexAndFirstRestoration(
    this: Storage,
    key: string,
    value: string,
  ): void {
    if (key === CACHE_INDEX_KEY && indexFailureArmed) {
      indexFailureArmed = false;
      originalSetItem.call(this, key, value);
      throw new Error("forced index write failure");
    }
    if (key === oldestKey && value === oldestRaw && restorationFailureArmed) {
      restorationFailureArmed = false;
      throw new Error("forced first durable restoration failure");
    }
    originalSetItem.call(this, key, value);
  };
  try {
    cacheZoneRecords(`retry-${hardLimit}`, "Incoming", []);
  } finally {
    storagePrototype.setItem = originalSetItem;
  }

  assert.equal(localStorage.getItem(CACHE_INDEX_KEY), previousIndex);
  assert.equal(rawIndexZoneIds().includes(`retry-${hardLimit}`), false);
  assert.equal(localStorage.getItem(oldestKey), null);
  t.mock.timers.tick(10);
  assert.equal(localStorage.getItem(oldestKey), oldestRaw);
  assert.equal(localStorage.getItem(CACHE_COORDINATION_KEY), null);
  assert.equal(entryKeyForZone(`retry-${hardLimit}`), undefined);
  assert.deepEqual(getCacheIndex(), rawIndexZoneIds());
  assert.equal(getCacheIndex()[0], "retry-0");
});

test("deferred rollback does not resurrect an entry deleted by a second tab", async (t) => {
  const hardLimit = RESOURCE_LIMITS.offlineCache.hardEntries;
  for (let index = 0; index < hardLimit; index += 1) {
    cacheZoneRecords(`delete-race-${index}`, `Delete race ${index}`, []);
  }
  const oldestKey = entryKeyForZone("delete-race-0");
  assert.ok(oldestKey);
  const oldestRaw = localStorage.getItem(oldestKey);
  assert.ok(oldestRaw);

  const secondTab = (await import(
    new URL("../src/lib/storage/offline-cache.ts?delete-tab", import.meta.url)
      .href
  )) as typeof import("../src/lib/storage/offline-cache");
  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  t.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.now(),
  });
  let indexFailureArmed = true;
  let restorationFailureArmed = true;
  let interleavingArmed = true;
  storagePrototype.setItem = function failWriteAndRestoration(
    this: Storage,
    key: string,
    value: string,
  ): void {
    if (key === CACHE_INDEX_KEY && indexFailureArmed) {
      indexFailureArmed = false;
      originalSetItem.call(this, key, value);
      throw new Error("forced index write failure");
    }
    if (key === oldestKey && value === oldestRaw && restorationFailureArmed) {
      restorationFailureArmed = false;
      throw new Error("forced restoration failure");
    }
    originalSetItem.call(this, key, value);
    if (key === oldestKey && value === oldestRaw && interleavingArmed) {
      interleavingArmed = false;
      localStorage.removeItem(CACHE_COORDINATION_KEY);
      secondTab.removeCachedZone("delete-race-0");
    }
  };
  try {
    cacheZoneRecords(`delete-race-${hardLimit}`, "Incoming", []);

    assert.equal(localStorage.getItem(oldestKey), null);
    t.mock.timers.tick(10);
    t.mock.timers.tick(20);
  } finally {
    storagePrototype.setItem = originalSetItem;
  }

  assert.equal(interleavingArmed, false);
  assert.equal(localStorage.getItem(oldestKey), null);
  assert.equal(getCacheIndex().includes("delete-race-0"), false);
  assert.equal(getCacheIndex().includes(`delete-race-${hardLimit}`), false);
  assert.deepEqual(ownedEntryZoneIds(), [...getCacheIndex()].sort());
});

test("multi-entry rollback cleans its first restoration when generation changes", (t) => {
  const payload = "x".repeat(
    Math.ceil(RESOURCE_LIMITS.offlineCache.hardBytes / 5),
  );
  for (let index = 0; index < 4; index += 1) {
    cacheZoneRecords(`multi-race-${index}`, `Multi race ${index}`, [payload]);
  }
  const firstKey = entryKeyForZone("multi-race-0");
  const secondKey = entryKeyForZone("multi-race-1");
  assert.ok(firstKey);
  assert.ok(secondKey);
  const firstRaw = localStorage.getItem(firstKey);
  const secondRaw = localStorage.getItem(secondKey);
  assert.ok(firstRaw);
  assert.ok(secondRaw);

  t.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.now(),
  });
  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  let indexFailureArmed = true;
  const initialRestorationFailures = new Set([firstKey, secondKey]);
  let generationChangeArmed = true;
  let secondDeferredRestorationAttempted = false;
  storagePrototype.setItem = function changeGenerationAfterFirstRestoration(
    this: Storage,
    key: string,
    value: string,
  ): void {
    if (key === CACHE_INDEX_KEY && indexFailureArmed) {
      indexFailureArmed = false;
      originalSetItem.call(this, key, value);
      throw new Error("forced multi-entry index write failure");
    }
    if (
      initialRestorationFailures.has(key) &&
      (value === firstRaw || value === secondRaw)
    ) {
      initialRestorationFailures.delete(key);
      throw new Error(`forced initial restoration failure for ${key}`);
    }
    originalSetItem.call(this, key, value);
    if (key === firstKey && value === firstRaw && generationChangeArmed) {
      generationChangeArmed = false;
      originalSetItem.call(this, CACHE_INDEX_KEY, "[]");
    } else if (key === secondKey && value === secondRaw) {
      secondDeferredRestorationAttempted = true;
    }
  };
  try {
    cacheZoneRecords("multi-race-incoming", "Incoming", [
      "y".repeat(Math.ceil(RESOURCE_LIMITS.offlineCache.hardBytes / 2)),
    ]);
    assert.equal(localStorage.getItem(firstKey), null);
    assert.equal(localStorage.getItem(secondKey), null);
    t.mock.timers.tick(10);
  } finally {
    storagePrototype.setItem = originalSetItem;
  }

  assert.equal(generationChangeArmed, false);
  assert.equal(localStorage.getItem(firstKey), null);
  assert.equal(localStorage.getItem(secondKey), null);
  assert.equal(secondDeferredRestorationAttempted, false);
});

test("later rollback retry cleans an already-restored stale value exactly", (t) => {
  const payload = "x".repeat(
    Math.ceil(RESOURCE_LIMITS.offlineCache.hardBytes / 5),
  );
  for (let index = 0; index < 4; index += 1) {
    cacheZoneRecords(`retry-stale-${index}`, `Retry stale ${index}`, [payload]);
  }
  const staleKey = entryKeyForZone("retry-stale-0");
  const newerKey = entryKeyForZone("retry-stale-1");
  assert.ok(staleKey);
  assert.ok(newerKey);
  const staleRaw = localStorage.getItem(staleKey);
  const replacedRaw = localStorage.getItem(newerKey);
  assert.ok(staleRaw);
  assert.ok(replacedRaw);
  const newerRaw = JSON.stringify({
    ...(JSON.parse(replacedRaw) as Record<string, unknown>),
    zoneName: "Newer retry stale value",
  });

  t.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.now(),
  });
  const fakeSetTimeout = globalThis.setTimeout;
  const fakeClearTimeout = globalThis.clearTimeout;
  const pendingRollbackTimers = new Set<ReturnType<typeof setTimeout>>();
  globalThis.setTimeout = ((
    callback: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer = fakeSetTimeout(() => {
      pendingRollbackTimers.delete(timer);
      if (typeof callback === "function") callback(...args);
    }, delay);
    if ((delay ?? 0) > 0) pendingRollbackTimers.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    pendingRollbackTimers.delete(timer);
    fakeClearTimeout(timer);
  }) as typeof clearTimeout;

  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalGetItem = storagePrototype.getItem;
  const originalSetItem = storagePrototype.setItem;
  const originalRemoveItem = storagePrototype.removeItem;
  let indexFailureArmed = true;
  const initialRestorationFailures = new Set([staleKey, newerKey]);
  let retryPhase: "first" | "first-cleanup" | "second" | "second-restored" =
    "first";
  let staleCleanupFailures = 0;
  let staleRestorationWrites = 0;

  storagePrototype.setItem = function failInitialRollbackWrites(
    this: Storage,
    key: string,
    value: string,
  ): void {
    if (key === CACHE_INDEX_KEY && indexFailureArmed) {
      indexFailureArmed = false;
      originalSetItem.call(this, key, value);
      throw new Error("forced retry-stale index write failure");
    }
    if (
      initialRestorationFailures.has(key) &&
      (value === staleRaw || value === replacedRaw)
    ) {
      initialRestorationFailures.delete(key);
      throw new Error(
        `forced initial retry-stale restoration failure for ${key}`,
      );
    }
    originalSetItem.call(this, key, value);
    if (key === staleKey && value === staleRaw) {
      staleRestorationWrites += 1;
      if (retryPhase === "first") retryPhase = "first-cleanup";
    }
  };
  storagePrototype.getItem = function changeSecondRetryGeneration(
    this: Storage,
    key: string,
  ): string | null {
    if (key === CACHE_COORDINATION_KEY && retryPhase === "first-cleanup") {
      originalSetItem.call(
        this,
        CACHE_COORDINATION_KEY,
        JSON.stringify({
          owner: "expired-retry-stale-owner",
          token: "expired-retry-stale-token",
          expiresAt: Date.now() - 1,
        }),
      );
    }
    const value = originalGetItem.call(this, key);
    if (key === staleKey && retryPhase === "second" && value === staleRaw) {
      retryPhase = "second-restored";
    } else if (
      key === CACHE_COORDINATION_KEY &&
      retryPhase === "second-restored"
    ) {
      originalSetItem.call(this, CACHE_INDEX_KEY, "[]");
    }
    return value;
  };
  storagePrototype.removeItem = function failFirstStaleCleanup(
    this: Storage,
    key: string,
  ): void {
    if (key === staleKey && retryPhase === "first-cleanup") {
      retryPhase = "second";
      staleCleanupFailures += 1;
      throw new Error("forced first stale rollback cleanup failure");
    }
    originalRemoveItem.call(this, key);
  };

  try {
    cacheZoneRecords("retry-stale-incoming", "Incoming", [
      "y".repeat(Math.ceil(RESOURCE_LIMITS.offlineCache.hardBytes / 2)),
    ]);
    assert.equal(pendingRollbackTimers.size, 1);

    t.mock.timers.tick(10);
    assert.equal(originalGetItem.call(localStorage, staleKey), staleRaw);
    assert.equal(staleCleanupFailures, 1);
    assert.equal(staleRestorationWrites, 1);

    originalSetItem.call(localStorage, newerKey, newerRaw);
    t.mock.timers.tick(20);
    assert.equal(localStorage.getItem(staleKey), null);
    assert.equal(localStorage.getItem(newerKey), newerRaw);
    assert.equal(staleRestorationWrites, 1);

    t.mock.timers.tick(40);
    assert.equal(pendingRollbackTimers.size, 0);
    t.mock.timers.tick(10_000);
    assert.equal(pendingRollbackTimers.size, 0);
    assert.equal(localStorage.getItem(staleKey), null);
    assert.equal(localStorage.getItem(newerKey), newerRaw);
  } finally {
    globalThis.setTimeout = fakeSetTimeout;
    globalThis.clearTimeout = fakeClearTimeout;
    storagePrototype.getItem = originalGetItem;
    storagePrototype.setItem = originalSetItem;
    storagePrototype.removeItem = originalRemoveItem;
  }
});

test("deferred rollback releases its lease after a synchronous storage throw", (t) => {
  const hardLimit = RESOURCE_LIMITS.offlineCache.hardEntries;
  for (let index = 0; index < hardLimit; index += 1) {
    cacheZoneRecords(`lease-throw-${index}`, `Lease throw ${index}`, []);
  }
  const oldestKey = entryKeyForZone("lease-throw-0");
  assert.ok(oldestKey);
  const oldestRaw = localStorage.getItem(oldestKey);
  assert.ok(oldestRaw);

  t.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.now(),
  });
  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  const originalGetItem = storagePrototype.getItem;
  let indexFailureArmed = true;
  let initialRestorationFailureArmed = true;
  let throwAfterDeferredRestoration = false;
  storagePrototype.setItem = function armSynchronousReadThrow(
    this: Storage,
    key: string,
    value: string,
  ): void {
    if (key === CACHE_INDEX_KEY && indexFailureArmed) {
      indexFailureArmed = false;
      originalSetItem.call(this, key, value);
      throw new Error("forced lease-release index write failure");
    }
    if (
      key === oldestKey &&
      value === oldestRaw &&
      initialRestorationFailureArmed
    ) {
      initialRestorationFailureArmed = false;
      throw new Error("forced initial lease-release restoration failure");
    }
    originalSetItem.call(this, key, value);
    if (key === oldestKey && value === oldestRaw) {
      throwAfterDeferredRestoration = true;
    }
  };
  storagePrototype.getItem = function throwDuringPostWriteGuard(
    this: Storage,
    key: string,
  ): string | null {
    if (key === CACHE_COORDINATION_KEY && throwAfterDeferredRestoration) {
      throwAfterDeferredRestoration = false;
      throw new Error("forced synchronous rollback guard read failure");
    }
    return originalGetItem.call(this, key);
  };
  try {
    cacheZoneRecords(`lease-throw-${hardLimit}`, "Incoming", []);
    t.mock.timers.tick(10);
  } finally {
    storagePrototype.setItem = originalSetItem;
    storagePrototype.getItem = originalGetItem;
  }

  assert.equal(throwAfterDeferredRestoration, false);
  assert.equal(localStorage.getItem(CACHE_COORDINATION_KEY), null);
});

test("permanent rollback failure stops at the retry ceiling with no timer work", (t) => {
  const hardLimit = RESOURCE_LIMITS.offlineCache.hardEntries;
  for (let index = 0; index < hardLimit; index += 1) {
    cacheZoneRecords(`retry-cap-${index}`, `Retry cap ${index}`, []);
  }
  const oldestKey = entryKeyForZone("retry-cap-0");
  assert.ok(oldestKey);
  const oldestRaw = localStorage.getItem(oldestKey);
  assert.ok(oldestRaw);

  t.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.now(),
  });
  const fakeSetTimeout = globalThis.setTimeout;
  const fakeClearTimeout = globalThis.clearTimeout;
  const pendingRollbackTimers = new Set<ReturnType<typeof setTimeout>>();
  globalThis.setTimeout = ((
    callback: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer = fakeSetTimeout(() => {
      pendingRollbackTimers.delete(timer);
      if (typeof callback === "function") callback(...args);
    }, delay);
    if ((delay ?? 0) > 0) pendingRollbackTimers.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    pendingRollbackTimers.delete(timer);
    fakeClearTimeout(timer);
  }) as typeof clearTimeout;
  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  let indexFailureArmed = true;
  let restorationAttempts = 0;
  storagePrototype.setItem = function failEveryRestoration(
    this: Storage,
    key: string,
    value: string,
  ): void {
    if (key === CACHE_INDEX_KEY && indexFailureArmed) {
      indexFailureArmed = false;
      originalSetItem.call(this, key, value);
      throw new Error("forced index write failure");
    }
    if (key === oldestKey && value === oldestRaw) {
      restorationAttempts += 1;
      throw new Error("forced permanent restoration failure");
    }
    originalSetItem.call(this, key, value);
  };
  try {
    cacheZoneRecords(`retry-cap-${hardLimit}`, "Incoming", []);
    assert.fail("cache write should have failed");
  } catch {
    // Expected forced storage failure.
  }

  const retryDelays = [10, 20, 40, 80, 160, 320, 640, 640];
  for (const delay of retryDelays) {
    assert.equal(pendingRollbackTimers.size, 1);
    t.mock.timers.tick(delay);
  }
  const terminalAttempts = restorationAttempts;
  assert.equal(pendingRollbackTimers.size, 0);
  t.mock.timers.tick(10_000);
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = fakeClearTimeout;
  storagePrototype.setItem = originalSetItem;

  assert.equal(terminalAttempts, 1 + 8);
  assert.equal(restorationAttempts, terminalAttempts);
  assert.equal(pendingRollbackTimers.size, 0);
  assert.equal(localStorage.getItem(oldestKey), null);
  assert.deepEqual(getCacheIndex(), rawIndexZoneIds());
  assert.deepEqual(ownedEntryZoneIds(), [...getCacheIndex()].sort());
});

test("clear yields with a hard per-turn inspection bound across 20,000 unrelated keys", () => {
  class ConstantTimeStorage implements Storage {
    readonly #values = new Map<string, string>();
    readonly #keys: string[] = [];
    readonly #indexes = new Map<string, number>();

    get length(): number {
      return this.#keys.length;
    }

    clear(): void {
      this.#values.clear();
      this.#keys.length = 0;
      this.#indexes.clear();
    }

    getItem(key: string): string | null {
      return this.#values.get(String(key)) ?? null;
    }

    key(index: number): string | null {
      return this.#keys[index] ?? null;
    }

    removeItem(key: string): void {
      const normalized = String(key);
      const index = this.#indexes.get(normalized);
      if (index === undefined) return;
      const lastIndex = this.#keys.length - 1;
      const lastKey = this.#keys[lastIndex]!;
      if (index !== lastIndex) {
        this.#keys[index] = lastKey;
        this.#indexes.set(lastKey, index);
      }
      this.#keys.pop();
      this.#indexes.delete(normalized);
      this.#values.delete(normalized);
    }

    setItem(key: string, value: string): void {
      const normalized = String(key);
      if (!this.#values.has(normalized)) {
        this.#indexes.set(normalized, this.#keys.length);
        this.#keys.push(normalized);
      }
      this.#values.set(normalized, String(value));
    }
  }

  const unrelatedCount = 20_000;
  const ownedZoneIds: string[] = [];
  const originalStorage = globalThis.localStorage;
  const originalSetTimeout = globalThis.setTimeout;
  const testStorage = new ConstantTimeStorage();
  const scheduledTurns: Array<() => void> = [];
  let inspectionsThisTurn = 0;
  let maximumInspections = 0;
  let yieldedTurns = 0;
  testStorage.key = ((index: number): string | null => {
    inspectionsThisTurn += 1;
    maximumInspections = Math.max(maximumInspections, inspectionsThisTurn);
    return ConstantTimeStorage.prototype.key.call(testStorage, index);
  }) as Storage["key"];
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: testStorage,
  });
  globalThis.setTimeout = ((
    callback: TimerHandler,
    _delay?: number,
    ...args: unknown[]
  ) => {
    scheduledTurns.push(() => {
      yieldedTurns += 1;
      inspectionsThisTurn = 0;
      if (typeof callback === "function") callback(...args);
    });
    return scheduledTurns.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  for (let index = 0; index < unrelatedCount; index += 1) {
    localStorage.setItem(`huge-origin-${index}`, "unrelated");
    if (index % 4_000 === 0) {
      const zoneId = `clear-owned-${index}`;
      ownedZoneIds.push(zoneId);
      localStorage.setItem(
        `${CACHE_KEY_PREFIX}${zoneId}`,
        rawCacheEntry(zoneId, index),
      );
    }
  }
  localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(ownedZoneIds));

  try {
    clearOfflineCache();
    assert.ok(localStorage.length > unrelatedCount);
    assert.equal(scheduledTurns.length, 1);
    const maximumExpectedTurns =
      2 *
        Math.ceil(
          (unrelatedCount + ownedZoneIds.length + 1) /
            RESOURCE_LIMITS.offlineCache.discoveryBatchKeys,
        ) +
      1;
    while (scheduledTurns.length > 0) {
      assert.ok(yieldedTurns < maximumExpectedTurns);
      const turn = scheduledTurns.shift();
      assert.ok(turn);
      turn();
      assert.ok(
        inspectionsThisTurn <= RESOURCE_LIMITS.offlineCache.discoveryBatchKeys,
      );
    }
    assert.ok(yieldedTurns > 1);
    assert.ok(
      maximumInspections <= RESOURCE_LIMITS.offlineCache.discoveryBatchKeys,
    );
    assert.equal(localStorage.getItem(CACHE_INDEX_KEY), null);
    for (const zoneId of ownedZoneIds) {
      assert.equal(localStorage.getItem(`${CACHE_KEY_PREFIX}${zoneId}`), null);
    }
    assert.equal(localStorage.length, unrelatedCount);
    assert.equal(localStorage.getItem("huge-origin-0"), "unrelated");
    assert.equal(
      localStorage.getItem(`huge-origin-${unrelatedCount - 1}`),
      "unrelated",
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalStorage,
    });
  }
});
