/**
 * Time-to-live behaviour of the DNS offline record cache.
 *
 * The cache promises that a record set stays usable for seven days and is
 * discarded afterwards. Nothing exercised that promise: every existing suite
 * writes entries at the current instant, so an entry has never been more than
 * milliseconds old when it was read back. These tests pin the exact boundary,
 * the durable side effect of crossing it, and the age formatting the UI shows.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  cacheZoneRecords,
  clearOfflineCache,
  formatCacheAge,
  getCacheAge,
  getCachedZoneRecords,
  getCacheIndex,
  hasCachedRecords,
} from "../src/lib/storage/offline-cache";
import { resetRuntimeReportingForTests } from "../src/lib/errors/runtime-reporting";

const CACHE_KEY_PREFIX = "bc_offline_cache_";
const CACHE_INDEX_KEY = "bc_offline_cache_index";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** The contract under test, written out rather than imported from the module. */
const MAX_CACHE_AGE_MS = 7 * DAY_MS;

/** An arbitrary fixed instant, so every age below is exact rather than racy. */
const FROZEN_NOW = 1_800_000_000_000;

/**
 * Write an entry directly, at an arbitrary age, in the durable on-disk shape.
 * `cacheZoneRecords` always stamps `Date.now()`, so aged fixtures cannot be
 * produced through the public writer without also faking the clock during the
 * write, which would stop the read path from being the only thing under test.
 */
function seedAgedEntry(zoneId: string, cachedAt: number): void {
  localStorage.setItem(
    `${CACHE_KEY_PREFIX}${zoneId}`,
    JSON.stringify({
      zoneId,
      zoneName: `Zone ${zoneId}`,
      records: [{ id: `${zoneId}-record`, type: "A", content: "192.0.2.10" }],
      cachedAt,
    }),
  );
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

/** Run `body` with `Date.now` pinned to `FROZEN_NOW`. */
function atFrozenNow<T>(body: () => T): T {
  const realNow = Date.now;
  Date.now = () => FROZEN_NOW;
  try {
    return body();
  } finally {
    Date.now = realNow;
  }
}

async function waitFor(
  predicate: () => boolean,
  attempts = 500,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached within the deterministic task budget");
}

afterEach(async () => {
  clearOfflineCache();
  await waitFor(
    () =>
      ownedEntryKeys().length === 0 &&
      localStorage.getItem(CACHE_INDEX_KEY) === null,
  );
  localStorage.clear();
  resetRuntimeReportingForTests();
});

test("serves an entry at exactly the seven-day limit and drops it one millisecond later", () => {
  for (const age of [MAX_CACHE_AGE_MS - 1, MAX_CACHE_AGE_MS]) {
    localStorage.clear();
    clearOfflineCache();
    seedAgedEntry("zone-boundary", FROZEN_NOW - age);

    const cached = atFrozenNow(() => getCachedZoneRecords("zone-boundary"));
    assert.ok(cached, `entry aged ${age}ms must still be served`);
    assert.equal(cached.zoneName, "Zone zone-boundary");
    assert.equal(cached.records.length, 1);
    assert.deepEqual(ownedEntryKeys(), [`${CACHE_KEY_PREFIX}zone-boundary`]);
  }

  localStorage.clear();
  clearOfflineCache();
  seedAgedEntry("zone-boundary", FROZEN_NOW - (MAX_CACHE_AGE_MS + 1));

  assert.equal(
    atFrozenNow(() => getCachedZoneRecords("zone-boundary")),
    null,
    "an entry one millisecond past the limit must not be served",
  );
  assert.deepEqual(
    ownedEntryKeys(),
    [],
    "expiry must delete the stored record set, not merely hide it",
  );
  assert.deepEqual(
    atFrozenNow(() => getCacheIndex()),
    [],
  );
});

test("expiring one zone leaves every other cached zone intact", () => {
  seedAgedEntry("zone-stale", FROZEN_NOW - (MAX_CACHE_AGE_MS + MINUTE_MS));
  seedAgedEntry("zone-live", FROZEN_NOW - (MAX_CACHE_AGE_MS - HOUR_MS));

  atFrozenNow(() => {
    assert.equal(getCachedZoneRecords("zone-stale"), null);
    assert.equal(hasCachedRecords("zone-stale"), false);

    const live = getCachedZoneRecords("zone-live");
    assert.ok(live, "a zone one hour inside the limit must survive the purge");
    assert.equal(live.zoneId, "zone-live");
    assert.equal(hasCachedRecords("zone-live"), true);

    assert.deepEqual(
      getCacheIndex(),
      ["zone-live"],
      "the index must stop claiming a zone whose entry expiry deleted",
    );
    assert.deepEqual(ownedEntryKeys(), [`${CACHE_KEY_PREFIX}zone-live`]);
  });
});

test("re-caching an expired zone restores it instead of leaving it purged", () => {
  seedAgedEntry("zone-refresh", FROZEN_NOW - (MAX_CACHE_AGE_MS + DAY_MS));
  assert.equal(
    atFrozenNow(() => getCachedZoneRecords("zone-refresh")),
    null,
  );

  cacheZoneRecords("zone-refresh", "example.com", [
    { id: "fresh", type: "AAAA", content: "2001:db8::1" },
  ]);

  const cached = getCachedZoneRecords("zone-refresh");
  assert.ok(cached, "a fresh write must resurrect a previously expired zone");
  assert.equal(cached.zoneName, "example.com");
  assert.equal(cached.records.length, 1);
  assert.deepEqual(getCacheIndex(), ["zone-refresh"]);
});

test("getCacheAge tracks the stored instant and reports null once expired", () => {
  seedAgedEntry("zone-aged", FROZEN_NOW - (3 * DAY_MS + 4 * HOUR_MS));
  seedAgedEntry("zone-gone", FROZEN_NOW - (MAX_CACHE_AGE_MS + SECOND_MS));

  atFrozenNow(() => {
    assert.equal(getCacheAge("zone-aged"), 3 * DAY_MS + 4 * HOUR_MS);
    assert.equal(formatCacheAge(getCacheAge("zone-aged")!), "3d ago");
    assert.equal(getCacheAge("zone-gone"), null);
    assert.equal(getCacheAge("zone-never-cached"), null);
  });
});

test("an entry stamped in the future is kept rather than discarded as unreadable", () => {
  // A machine whose clock jumped backwards leaves entries with a `cachedAt`
  // ahead of `Date.now()`. Treating that as corruption would silently delete a
  // user's only offline copy, so the cache must keep serving it.
  seedAgedEntry("zone-skewed", FROZEN_NOW + DAY_MS);

  atFrozenNow(() => {
    const cached = getCachedZoneRecords("zone-skewed");
    assert.ok(cached, "a future-stamped entry must not be treated as expired");
    assert.equal(getCacheAge("zone-skewed"), -DAY_MS);
    assert.deepEqual(ownedEntryKeys(), [`${CACHE_KEY_PREFIX}zone-skewed`]);
  });
});

test("formatCacheAge switches unit exactly on each boundary", () => {
  const cases: ReadonlyArray<readonly [number, string]> = [
    [0, "0s ago"],
    [SECOND_MS - 1, "0s ago"],
    [SECOND_MS, "1s ago"],
    [MINUTE_MS - 1, "59s ago"],
    [MINUTE_MS, "1m ago"],
    [HOUR_MS - 1, "59m ago"],
    [HOUR_MS, "1h ago"],
    [DAY_MS - 1, "23h ago"],
    [DAY_MS, "1d ago"],
    [MAX_CACHE_AGE_MS, "7d ago"],
  ];
  for (const [ms, expected] of cases) {
    assert.equal(formatCacheAge(ms), expected, `formatCacheAge(${ms})`);
  }
});
