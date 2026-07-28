/**
 * Offline cache for DNS records.
 *
 * Caches zone and record data in localStorage so the UI can show stale
 * data when the network is unavailable. Each zone's records are stored
 * with a timestamp so we can indicate freshness.
 */

import { reportRuntimeError } from "@/lib/errors/runtime-reporting";

export interface CachedZoneRecords {
  zoneId: string;
  zoneName: string;
  records: unknown[];
  cachedAt: number;
}

const CACHE_KEY_PREFIX = "bc_offline_cache_";
const CACHE_INDEX_KEY = "bc_offline_cache_index";
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function storageErrorName(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
    ? error.name
    : "";
}

function isQuotaError(error: unknown): boolean {
  return storageErrorName(error) === "QuotaExceededError";
}

function storageFailureCategory(error: unknown, corruption = false): string {
  const name = storageErrorName(error);
  if (corruption || error instanceof SyntaxError) return "corrupt cache data";
  if (name === "QuotaExceededError") return "quota exceeded";
  if (name === "SecurityError" || name === "NotAllowedError")
    return "access denied";
  return "operation failed";
}

function reportCacheFailure(
  error: unknown,
  operation: string,
  corruption = false,
): void {
  reportRuntimeError(error, {
    source: "runtime",
    label: `${operation}: ${storageFailureCategory(error, corruption)}`,
  });
}

function isCachedZoneRecords(value: unknown): value is CachedZoneRecords {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CachedZoneRecords>;
  return (
    typeof entry.zoneId === "string" &&
    typeof entry.zoneName === "string" &&
    Array.isArray(entry.records) &&
    typeof entry.cachedAt === "number" &&
    Number.isFinite(entry.cachedAt)
  );
}

function persistCacheEntry(entry: CachedZoneRecords): void {
  localStorage.setItem(CACHE_KEY_PREFIX + entry.zoneId, JSON.stringify(entry));
  const index = getCacheIndex();
  if (!index.includes(entry.zoneId)) {
    index.push(entry.zoneId);
    localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
  }
}

/**
 * Save records for a zone to the offline cache.
 */
export function cacheZoneRecords(
  zoneId: string,
  zoneName: string,
  records: unknown[],
): void {
  const entry: CachedZoneRecords = {
    zoneId,
    zoneName,
    records,
    cachedAt: Date.now(),
  };
  try {
    persistCacheEntry(entry);
    return;
  } catch (error) {
    reportCacheFailure(error, "Write DNS offline cache");
    if (!isQuotaError(error)) return;
  }

  // Quota failures get one bounded eviction and retry.
  try {
    evictOldest();
    persistCacheEntry(entry);
  } catch (error) {
    reportCacheFailure(error, "Retry DNS offline cache write");
  }
}

/**
 * Retrieve cached records for a zone, or null if not cached.
 */
export function getCachedZoneRecords(zoneId: string): CachedZoneRecords | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + zoneId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isCachedZoneRecords(parsed) || parsed.zoneId !== zoneId) {
      throw new SyntaxError("Invalid offline cache entry");
    }
    const entry = parsed;
    // Check freshness
    if (Date.now() - entry.cachedAt > MAX_CACHE_AGE_MS) {
      removeCachedZone(zoneId);
      return null;
    }
    return entry;
  } catch (error) {
    reportCacheFailure(
      error,
      "Read DNS offline cache",
      error instanceof SyntaxError,
    );
    try {
      localStorage.removeItem(CACHE_KEY_PREFIX + zoneId);
    } catch (removeError) {
      reportCacheFailure(removeError, "Remove corrupt DNS offline cache");
    }
    return null;
  }
}

/**
 * Check if offline cached data is available for a zone.
 */
export function hasCachedRecords(zoneId: string): boolean {
  return getCachedZoneRecords(zoneId) !== null;
}

/**
 * Get the cache age in milliseconds, or null if not cached.
 */
export function getCacheAge(zoneId: string): number | null {
  const entry = getCachedZoneRecords(zoneId);
  if (!entry) return null;
  return Date.now() - entry.cachedAt;
}

/**
 * Remove cached data for a zone.
 */
export function removeCachedZone(zoneId: string): void {
  try {
    localStorage.removeItem(CACHE_KEY_PREFIX + zoneId);
    const index = getCacheIndex().filter((id) => id !== zoneId);
    localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
  } catch (error) {
    reportCacheFailure(error, "Remove DNS offline cache");
  }
}

/**
 * Clear all offline cache data.
 */
export function clearOfflineCache(): void {
  const index = getCacheIndex();
  for (const zoneId of index) {
    try {
      localStorage.removeItem(CACHE_KEY_PREFIX + zoneId);
    } catch (error) {
      reportCacheFailure(error, "Clear DNS offline cache entry");
    }
  }
  try {
    localStorage.removeItem(CACHE_INDEX_KEY);
  } catch (error) {
    reportCacheFailure(error, "Clear DNS offline cache index");
  }
}

/**
 * Get list of cached zone IDs.
 */
export function getCacheIndex(): string[] {
  try {
    const raw = localStorage.getItem(CACHE_INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.some((zoneId) => typeof zoneId !== "string")
    ) {
      throw new SyntaxError("Invalid offline cache index");
    }
    return parsed;
  } catch (error) {
    reportCacheFailure(
      error,
      "Read DNS offline cache index",
      error instanceof SyntaxError,
    );
    try {
      localStorage.removeItem(CACHE_INDEX_KEY);
    } catch (removeError) {
      reportCacheFailure(removeError, "Remove corrupt DNS offline cache index");
    }
    return [];
  }
}

/**
 * Format a cache age in human-readable form.
 */
export function formatCacheAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Evict the oldest cached zone to free up localStorage space.
 */
function evictOldest(): void {
  const index = getCacheIndex();
  let oldestId: string | null = null;
  let oldestTime = Infinity;

  for (const zoneId of index) {
    try {
      const raw = localStorage.getItem(CACHE_KEY_PREFIX + zoneId);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      if (!isCachedZoneRecords(parsed)) {
        throw new SyntaxError("Invalid offline cache entry");
      }
      const entry = parsed;
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestId = zoneId;
      }
    } catch (error) {
      reportCacheFailure(
        error,
        "Inspect DNS offline cache for eviction",
        error instanceof SyntaxError,
      );
      removeCachedZone(zoneId);
      return;
    }
  }

  if (oldestId) {
    removeCachedZone(oldestId);
  }
}
