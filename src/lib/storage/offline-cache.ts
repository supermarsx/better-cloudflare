/**
 * Offline cache for DNS records.
 *
 * Entries remain in localStorage for up to seven days. The index is ordered
 * from oldest to newest write so count and byte eviction are deterministic.
 */

import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import { RESOURCE_LIMITS, utf8ByteLength } from "@/lib/resource-limits";

export interface CachedZoneRecords {
  zoneId: string;
  zoneName: string;
  records: unknown[];
  cachedAt: number;
}

interface IndexedCacheEntry {
  zoneId: string;
  key: string;
  raw: string;
  value: CachedZoneRecords;
  retainedBytes: number;
}

interface OwnedCacheKeyScan {
  keys: string[];
  complete: boolean;
}

const CACHE_KEY_PREFIX = "bc_offline_cache_";
const CACHE_INDEX_KEY = "bc_offline_cache_index";
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class OfflineCacheLimitError extends Error {
  readonly name = "OfflineCacheLimitError";
}

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
  if (error instanceof OfflineCacheLimitError) return "resource limit reached";
  if (name === "QuotaExceededError") return "quota exceeded";
  if (name === "SecurityError" || name === "NotAllowedError") {
    return "access denied";
  }
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

function cacheKey(zoneId: string): string {
  return CACHE_KEY_PREFIX + zoneId;
}

function zoneIdFromCacheKey(key: string): string | undefined {
  return key.startsWith(CACHE_KEY_PREFIX) && key !== CACHE_INDEX_KEY
    ? key.slice(CACHE_KEY_PREFIX.length)
    : undefined;
}

function retainedBytes(key: string, value: string): number {
  return utf8ByteLength(key) + utf8ByteLength(value);
}

function indexRetainedBytes(index: readonly string[]): number {
  return retainedBytes(CACHE_INDEX_KEY, JSON.stringify(index));
}

function assertStoredValueWithinLimit(key: string, value: string): number {
  if (value.length > RESOURCE_LIMITS.offlineCache.hardBytes) {
    throw new OfflineCacheLimitError(
      `Offline cache value ${key} exceeds the byte limit.`,
    );
  }
  const bytes = retainedBytes(key, value);
  if (bytes > RESOURCE_LIMITS.offlineCache.hardBytes) {
    throw new OfflineCacheLimitError(
      `Offline cache value ${key} exceeds the byte limit.`,
    );
  }
  return bytes;
}

function parseCacheEntry(key: string, raw: string): IndexedCacheEntry {
  const zoneId = zoneIdFromCacheKey(key);
  if (zoneId === undefined) {
    throw new SyntaxError("Invalid offline cache key");
  }
  const entryBytes = assertStoredValueWithinLimit(key, raw);
  const parsed: unknown = JSON.parse(raw);
  if (!isCachedZoneRecords(parsed) || parsed.zoneId !== zoneId) {
    throw new SyntaxError("Invalid offline cache entry");
  }
  return {
    zoneId,
    key,
    raw,
    value: parsed,
    retainedBytes: entryBytes,
  };
}

function parseCacheIndex(raw: string): string[] {
  assertStoredValueWithinLimit(CACHE_INDEX_KEY, raw);
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.length > RESOURCE_LIMITS.offlineCache.hardEntries ||
    parsed.some((zoneId) => typeof zoneId !== "string") ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new SyntaxError("Invalid offline cache index");
  }
  return parsed;
}

function writeCacheIndex(index: readonly string[]): void {
  if (index.length > RESOURCE_LIMITS.offlineCache.hardEntries) {
    throw new OfflineCacheLimitError(
      "DNS offline cache index exceeds the entry limit.",
    );
  }
  if (index.length === 0) {
    localStorage.removeItem(CACHE_INDEX_KEY);
    return;
  }
  const serialized = JSON.stringify(index);
  assertStoredValueWithinLimit(CACHE_INDEX_KEY, serialized);
  localStorage.setItem(CACHE_INDEX_KEY, serialized);
}

function restoreStoredValue(key: string, previous: string | null): void {
  if (previous === null) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, previous);
  }
}

function tryRestoreStoredValue(
  key: string,
  previous: string | null,
  operation: string,
): void {
  try {
    restoreStoredValue(key, previous);
  } catch (error) {
    reportCacheFailure(error, operation);
  }
}

function scanOwnedCacheKeys(): OwnedCacheKeyScan {
  const storedKeyCount = localStorage.length;
  const scannedKeyCount = Math.min(
    storedKeyCount,
    RESOURCE_LIMITS.offlineCache.recoveryScanHardKeys,
  );
  const keys: string[] = [];
  for (let index = 0; index < scannedKeyCount; index += 1) {
    const key = localStorage.key(index);
    if (key && zoneIdFromCacheKey(key) !== undefined) keys.push(key);
  }
  return {
    keys,
    complete: scannedKeyCount === storedKeyCount,
  };
}

function exceedsCacheLimit(entryCount: number, bytes: number): boolean {
  return (
    entryCount > RESOURCE_LIMITS.offlineCache.hardEntries ||
    bytes > RESOURCE_LIMITS.offlineCache.hardBytes
  );
}

function entriesWithinLimits(entries: readonly IndexedCacheEntry[]): {
  retained: IndexedCacheEntry[];
  evicted: IndexedCacheEntry[];
} {
  const retained = [...entries];
  const evicted: IndexedCacheEntry[] = [];
  let entryBytes = retained.reduce(
    (total, entry) => total + entry.retainedBytes,
    0,
  );
  while (
    retained.length > 0 &&
    exceedsCacheLimit(
      retained.length,
      entryBytes + indexRetainedBytes(retained.map((entry) => entry.zoneId)),
    )
  ) {
    const oldest = retained.shift();
    if (!oldest) break;
    entryBytes -= oldest.retainedBytes;
    evicted.push(oldest);
  }
  return { retained, evicted };
}

function sameIndex(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((zoneId, index) => zoneId === right[index])
  );
}

function commitRecoveredIndex(
  index: readonly string[],
  purgeKeys: readonly string[],
  previousIndexRaw: string | null,
): void {
  const uniquePurgeKeys = Array.from(new Set(purgeKeys));
  try {
    writeCacheIndex(index);
    for (const key of uniquePurgeKeys) localStorage.removeItem(key);
  } catch (error) {
    tryRestoreStoredValue(
      CACHE_INDEX_KEY,
      previousIndexRaw,
      "Roll back DNS offline cache recovery index",
    );
    throw error;
  }
}

function recoverCacheState(
  previousIndexRaw: string | null,
  invalidEntryOperation: string,
): IndexedCacheEntry[] {
  const scan = scanOwnedCacheKeys();
  if (!scan.complete) {
    for (const key of scan.keys) {
      try {
        localStorage.removeItem(key);
      } catch (error) {
        reportCacheFailure(error, "Purge DNS offline cache recovery entry");
      }
    }
    try {
      localStorage.removeItem(CACHE_INDEX_KEY);
    } catch (error) {
      reportCacheFailure(error, "Purge DNS offline cache recovery index");
    }
    throw new OfflineCacheLimitError(
      `DNS offline cache recovery exceeded the ${RESOURCE_LIMITS.offlineCache.recoveryScanHardKeys}-key scan limit.`,
    );
  }

  const validEntries: IndexedCacheEntry[] = [];
  const purgeKeys: string[] = [];
  let inspectedCharacters = 0;
  for (const key of scan.keys) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    if (
      raw.length >
      RESOURCE_LIMITS.offlineCache.hardBytes - inspectedCharacters
    ) {
      purgeKeys.push(key);
      continue;
    }
    inspectedCharacters += raw.length;
    try {
      validEntries.push(parseCacheEntry(key, raw));
    } catch (error) {
      reportCacheFailure(
        error,
        invalidEntryOperation,
        error instanceof SyntaxError,
      );
      purgeKeys.push(key);
    }
  }

  validEntries.sort(
    (left, right) =>
      left.value.cachedAt - right.value.cachedAt ||
      left.zoneId.localeCompare(right.zoneId),
  );
  const { retained, evicted } = entriesWithinLimits(validEntries);
  purgeKeys.push(...evicted.map((entry) => entry.key));
  const recoveredIndex = retained.map((entry) => entry.zoneId);

  if (
    previousIndexRaw !== null ||
    recoveredIndex.length > 0 ||
    purgeKeys.length > 0
  ) {
    commitRecoveredIndex(recoveredIndex, purgeKeys, previousIndexRaw);
  }
  return retained;
}

function readCacheState(
  invalidEntryOperation = "Inspect DNS offline cache entry",
): IndexedCacheEntry[] {
  const rawIndex = localStorage.getItem(CACHE_INDEX_KEY);
  if (rawIndex === null) {
    return recoverCacheState(null, invalidEntryOperation);
  }

  let index: string[];
  try {
    index = parseCacheIndex(rawIndex);
  } catch (error) {
    reportCacheFailure(
      error,
      "Recover DNS offline cache index",
      error instanceof SyntaxError,
    );
    return recoverCacheState(rawIndex, invalidEntryOperation);
  }

  const validEntries: IndexedCacheEntry[] = [];
  const purgeKeys: string[] = [];
  let inspectedCharacters = 0;
  for (const zoneId of index) {
    const key = cacheKey(zoneId);
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    if (
      raw.length >
      RESOURCE_LIMITS.offlineCache.hardBytes - inspectedCharacters
    ) {
      purgeKeys.push(key);
      continue;
    }
    inspectedCharacters += raw.length;
    try {
      validEntries.push(parseCacheEntry(key, raw));
    } catch (error) {
      reportCacheFailure(
        error,
        invalidEntryOperation,
        error instanceof SyntaxError,
      );
      purgeKeys.push(key);
    }
  }

  const { retained, evicted } = entriesWithinLimits(validEntries);
  purgeKeys.push(...evicted.map((entry) => entry.key));
  const normalizedIndex = retained.map((entry) => entry.zoneId);
  if (!sameIndex(index, normalizedIndex) || purgeKeys.length > 0) {
    commitRecoveredIndex(normalizedIndex, purgeKeys, rawIndex);
  }
  return retained;
}

function persistCacheEntry(entry: CachedZoneRecords, serialized: string): void {
  const key = cacheKey(entry.zoneId);
  const incomingBytes = assertStoredValueWithinLimit(key, serialized);
  if (
    incomingBytes + indexRetainedBytes([entry.zoneId]) >
    RESOURCE_LIMITS.offlineCache.hardBytes
  ) {
    throw new OfflineCacheLimitError(
      `DNS offline cache entry ${entry.zoneId} exceeds the cache byte limit.`,
    );
  }

  const existing = readCacheState().filter(
    (candidate) => candidate.zoneId !== entry.zoneId,
  );
  const retained = [...existing];
  const evicted: IndexedCacheEntry[] = [];
  let retainedEntryBytes = retained.reduce(
    (total, candidate) => total + candidate.retainedBytes,
    0,
  );
  const projectedBytes = () =>
    retainedEntryBytes +
    incomingBytes +
    indexRetainedBytes([
      ...retained.map((candidate) => candidate.zoneId),
      entry.zoneId,
    ]);

  while (
    retained.length > 0 &&
    exceedsCacheLimit(retained.length + 1, projectedBytes())
  ) {
    const oldest = retained.shift();
    if (!oldest) break;
    retainedEntryBytes -= oldest.retainedBytes;
    evicted.push(oldest);
  }
  if (exceedsCacheLimit(retained.length + 1, projectedBytes())) {
    throw new OfflineCacheLimitError(
      "DNS offline cache could not be reduced below its hard limit.",
    );
  }

  const previousEntryRaw = localStorage.getItem(key);
  const previousIndexRaw = localStorage.getItem(CACHE_INDEX_KEY);
  const attemptedEvictions: IndexedCacheEntry[] = [];
  try {
    localStorage.setItem(key, serialized);
    writeCacheIndex([
      ...retained.map((candidate) => candidate.zoneId),
      entry.zoneId,
    ]);
    for (const evictedEntry of evicted) {
      attemptedEvictions.push(evictedEntry);
      localStorage.removeItem(evictedEntry.key);
    }
  } catch (error) {
    tryRestoreStoredValue(
      key,
      previousEntryRaw,
      "Roll back DNS offline cache entry",
    );
    for (const evictedEntry of attemptedEvictions) {
      tryRestoreStoredValue(
        evictedEntry.key,
        evictedEntry.raw,
        "Roll back evicted DNS offline cache entry",
      );
    }
    tryRestoreStoredValue(
      CACHE_INDEX_KEY,
      previousIndexRaw,
      "Roll back DNS offline cache index",
    );
    throw error;
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
  let serialized: string;
  try {
    serialized = JSON.stringify(entry);
  } catch (error) {
    reportCacheFailure(error, "Serialize DNS offline cache");
    return;
  }

  try {
    persistCacheEntry(entry, serialized);
    return;
  } catch (error) {
    reportCacheFailure(error, "Write DNS offline cache");
    if (!isQuotaError(error)) return;
  }

  // Retry one transient quota failure without deleting previously durable data.
  try {
    persistCacheEntry(entry, serialized);
  } catch (error) {
    reportCacheFailure(error, "Retry DNS offline cache write");
  }
}

/**
 * Retrieve cached records for a zone, or null if not cached.
 */
export function getCachedZoneRecords(zoneId: string): CachedZoneRecords | null {
  try {
    const cached = readCacheState("Read DNS offline cache").find(
      (entry) => entry.zoneId === zoneId,
    );
    if (!cached) return null;
    if (Date.now() - cached.value.cachedAt > MAX_CACHE_AGE_MS) {
      removeCachedZone(zoneId);
      return null;
    }
    return cached.value;
  } catch (error) {
    reportCacheFailure(
      error,
      "Read DNS offline cache",
      error instanceof SyntaxError,
    );
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
  const key = cacheKey(zoneId);
  try {
    const state = readCacheState();
    const previousEntryRaw = localStorage.getItem(key);
    const previousIndexRaw = localStorage.getItem(CACHE_INDEX_KEY);
    try {
      writeCacheIndex(
        state
          .filter((entry) => entry.zoneId !== zoneId)
          .map((entry) => entry.zoneId),
      );
      localStorage.removeItem(key);
    } catch (error) {
      tryRestoreStoredValue(
        key,
        previousEntryRaw,
        "Roll back removed DNS offline cache entry",
      );
      tryRestoreStoredValue(
        CACHE_INDEX_KEY,
        previousIndexRaw,
        "Roll back removed DNS offline cache index",
      );
      throw error;
    }
  } catch (error) {
    reportCacheFailure(error, "Remove DNS offline cache");
  }
}

/**
 * Clear all keys owned by the offline cache.
 */
export function clearOfflineCache(): void {
  try {
    const scan = scanOwnedCacheKeys();
    for (const key of scan.keys) localStorage.removeItem(key);
    localStorage.removeItem(CACHE_INDEX_KEY);
    if (!scan.complete) {
      throw new OfflineCacheLimitError(
        `DNS offline cache clearing exceeded the ${RESOURCE_LIMITS.offlineCache.recoveryScanHardKeys}-key scan limit.`,
      );
    }
  } catch (error) {
    reportCacheFailure(error, "Clear DNS offline cache");
  }
}

/**
 * Get cached zone IDs in deterministic oldest-to-newest write order.
 */
export function getCacheIndex(): string[] {
  try {
    return readCacheState().map((entry) => entry.zoneId);
  } catch (error) {
    reportCacheFailure(
      error,
      "Read DNS offline cache index",
      error instanceof SyntaxError,
    );
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
