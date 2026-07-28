/**
 * Tests for the offline-cache module.
 */
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";

// Mock localStorage
class LocalStorageMock {
  private store: Record<string, string> = {};
  failNextSet: Error | null = null;
  getItem(key: string) {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? this.store[key]
      : null;
  }
  setItem(key: string, value: string) {
    if (this.failNextSet) {
      const error = this.failNextSet;
      this.failNextSet = null;
      throw error;
    }
    this.store[key] = String(value);
  }
  removeItem(key: string) {
    delete this.store[key];
  }
  clear() {
    this.store = {};
  }
  get length() {
    return Object.keys(this.store).length;
  }
  key(index: number): string | null {
    return Object.keys(this.store)[index] ?? null;
  }
  setRaw(key: string, value: string) {
    this.store[key] = value;
  }
}

const storage = new LocalStorageMock();
Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  writable: true,
});

// Now import after mocking
const {
  cacheZoneRecords,
  getCachedZoneRecords,
  hasCachedRecords,
  removeCachedZone,
  getCacheIndex,
} = await import("../src/lib/storage/offline-cache");

beforeEach(() => {
  storage.clear();
  storage.failNextSet = null;
  resetRuntimeReportingForTests();
});

test("cacheZoneRecords stores and retrieves records", () => {
  const records = [
    { id: "r1", type: "A", name: "www", content: "1.2.3.4" },
    { id: "r2", type: "CNAME", name: "mail", content: "mx.example.com" },
  ];
  cacheZoneRecords("zone1", "example.com", records);

  const cached = getCachedZoneRecords("zone1");
  assert.ok(cached, "Should return cached data");
  assert.equal(cached!.zoneId, "zone1");
  assert.equal(cached!.zoneName, "example.com");
  assert.equal(cached!.records.length, 2);
  assert.ok(cached!.cachedAt > 0);
});

test("getCachedZoneRecords returns null for uncached zone", () => {
  const result = getCachedZoneRecords("nonexistent");
  assert.equal(result, null);
});

test("hasCachedRecords returns correct boolean", () => {
  assert.equal(hasCachedRecords("zone1"), false);
  cacheZoneRecords("zone1", "example.com", []);
  assert.equal(hasCachedRecords("zone1"), true);
});

test("removeCachedZone removes the zone", () => {
  cacheZoneRecords("zone1", "example.com", [{ id: "r1" }]);
  assert.equal(hasCachedRecords("zone1"), true);
  removeCachedZone("zone1");
  assert.equal(hasCachedRecords("zone1"), false);
  assert.equal(getCachedZoneRecords("zone1"), null);
});

test("getCacheIndex returns all cached zone IDs", () => {
  cacheZoneRecords("zone1", "one.com", []);
  cacheZoneRecords("zone2", "two.com", []);
  const zones = getCacheIndex();
  assert.ok(zones.includes("zone1"));
  assert.ok(zones.includes("zone2"));
});

test("cacheZoneRecords overwrites existing cache", () => {
  cacheZoneRecords("zone1", "example.com", [{ id: "old" }]);
  cacheZoneRecords("zone1", "example.com", [{ id: "new1" }, { id: "new2" }]);

  const cached = getCachedZoneRecords("zone1");
  assert.ok(cached);
  assert.equal(cached!.records.length, 2);
});

test("caching empty records array works", () => {
  cacheZoneRecords("zone1", "example.com", []);
  const cached = getCachedZoneRecords("zone1");
  assert.ok(cached);
  assert.equal(cached!.records.length, 0);
});

test("corrupt cache entries are removed and reported", () => {
  storage.setRaw("bc_offline_cache_zone1", "{not valid json");

  assert.equal(getCachedZoneRecords("zone1"), null);
  assert.equal(storage.getItem("bc_offline_cache_zone1"), null);
  assert.match(
    getRuntimeDiagnostics()[0]?.label ?? "",
    /Read DNS offline cache: corrupt cache data/,
  );
});

test("quota failures evict once, retry, and remain usable", () => {
  const quotaError = new DOMException("storage full", "QuotaExceededError");
  storage.failNextSet = quotaError;

  cacheZoneRecords("zone1", "example.com", [{ id: "r1" }]);

  assert.ok(getCachedZoneRecords("zone1"));
  assert.match(
    getRuntimeDiagnostics()[0]?.label ?? "",
    /Write DNS offline cache: quota exceeded/,
  );
});
