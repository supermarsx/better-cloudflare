/**
 * Offline cache for DNS records.
 *
 * Caches zone and record data in localStorage so the UI can show stale
 * data when the network is unavailable. Each zone's records are stored
 * with a timestamp so we can indicate freshness.
 */

export interface CachedZoneRecords {
  zoneId: string;
  zoneName: string;
  records: unknown[];
  cachedAt: number;
}

const CACHE_KEY_PREFIX = "bc_offline_cache_";
const CACHE_INDEX_KEY = "bc_offline_cache_index";
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Save records for a zone to the offline cache.
 */
export function cacheZoneRecords(
  zoneId: string,
  zoneName: string,
  records: unknown[],
): void {
  try {
    const entry: CachedZoneRecords = {
      zoneId,
      zoneName,
      records,
      cachedAt: Date.now(),
    };
    localStorage.setItem(CACHE_KEY_PREFIX + zoneId, JSON.stringify(entry));

    // Update index
    const index = getCacheIndex();
    if (!index.includes(zoneId)) {
      index.push(zoneId);
      localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
    }
  } catch {
    // localStorage might be full — evict oldest entries and retry
    evictOldest();
    try {
      localStorage.setItem(
        CACHE_KEY_PREFIX + zoneId,
        JSON.stringify({ zoneId, zoneName, records, cachedAt: Date.now() }),
      );
    } catch {
      // Still failed, bail silently
    }
  }
}

/**
 * Retrieve cached records for a zone, or null if not cached.
 */
export function getCachedZoneRecords(zoneId: string): CachedZoneRecords | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + zoneId);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CachedZoneRecords;
    // Check freshness
    if (Date.now() - entry.cachedAt > MAX_CACHE_AGE_MS) {
      removeCachedZone(zoneId);
      return null;
    }
    return entry;
  } catch {
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
  localStorage.removeItem(CACHE_KEY_PREFIX + zoneId);
  const index = getCacheIndex().filter((id) => id !== zoneId);
  localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
}

/**
 * Clear all offline cache data.
 */
export function clearOfflineCache(): void {
  const index = getCacheIndex();
  for (const zoneId of index) {
    localStorage.removeItem(CACHE_KEY_PREFIX + zoneId);
  }
  localStorage.removeItem(CACHE_INDEX_KEY);
}

/**
 * Get list of cached zone IDs.
 */
export function getCacheIndex(): string[] {
  try {
    const raw = localStorage.getItem(CACHE_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
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
      const entry = JSON.parse(raw) as CachedZoneRecords;
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestId = zoneId;
      }
    } catch {
      // corrupted entry, remove it
      removeCachedZone(zoneId);
      return;
    }
  }

  if (oldestId) {
    removeCachedZone(oldestId);
  }
}
