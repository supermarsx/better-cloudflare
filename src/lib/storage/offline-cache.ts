/**
 * Offline cache for DNS records.
 *
 * Entries remain in localStorage for up to seven days. Entry keys are the
 * durable source of truth; the versioned index is only an ordering hint. Every
 * observable read reconciles both so a crashed or racing tab cannot leave a
 * permanently lost entry or an index claim for absent data.
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
  mutationToken: string;
  retainedBytes: number;
}

interface CacheIndexSnapshot {
  raw: string | null;
  zoneIds: string[];
  revision: number;
  modern: boolean;
  valid: boolean;
}

interface CacheLease {
  owner: string;
  token: string;
  expiresAt: number;
}

interface PreparedIndexWrite {
  raw: string | null;
}

interface CacheRecoveryState {
  index: CacheIndexSnapshot;
  storedKeyCount: number;
  cursor: number;
  candidates: Map<string, IndexedCacheEntry>;
  invalidEntryOperation: string;
}

interface PendingCacheRollback {
  previousIndexRaw: string | null;
  attemptedIndexRaw: string | null;
  removedEntries: IndexedCacheEntry[];
  restoredEntryKeys: Set<string>;
  incomingKey: string;
  incomingRaw: string;
  attempts: number;
  startedAt: number;
}

interface PendingCacheClear {
  cursor: number;
  discovered: number;
  pass: number;
  firstError: unknown;
}

const CACHE_KEY_PREFIX = "bc_offline_cache_";
const CACHE_INDEX_KEY = "bc_offline_cache_index";
const CACHE_COORDINATION_KEY = "bc_offline_cache_coordination";
const CACHE_ENTRY_KEY_PREFIX = `${CACHE_KEY_PREFIX}entry_v1_`;
const CACHE_INDEX_FORMAT = 1;
const CACHE_LEASE_MS = 2_000;
const ROLLBACK_RETRY_LIMIT = 8;
const ROLLBACK_RETRY_WINDOW_MS = 5_000;
const ROLLBACK_RETRY_BASE_DELAY_MS = 10;
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESERVED_CACHE_KEYS = new Set([CACHE_INDEX_KEY, CACHE_COORDINATION_KEY]);

let ownerSequence = 0;
let mutationSequence = 0;
let completedCacheState: IndexedCacheEntry[] | undefined;
let recoveryState: CacheRecoveryState | undefined;
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
let contendedReconciliationTimer: ReturnType<typeof setTimeout> | undefined;
let pendingRollback: PendingCacheRollback | undefined;
let rollbackTimer: ReturnType<typeof setTimeout> | undefined;
let pendingClear: PendingCacheClear | undefined;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function randomToken(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === "function") {
    return randomUuid.call(globalThis.crypto);
  }
  ownerSequence = (ownerSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${ownerSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 14)}`;
}

const CACHE_OWNER_ID = randomToken();

class OfflineCacheLimitError extends Error {
  readonly name = "OfflineCacheLimitError";
}

class OfflineCacheRecoveryPendingError extends Error {
  readonly name = "OfflineCacheRecoveryPendingError";
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

function mutationTokenFromCacheKey(key: string): string | undefined {
  if (!key.startsWith(CACHE_ENTRY_KEY_PREFIX)) return undefined;
  const mutationToken = key.slice(CACHE_ENTRY_KEY_PREFIX.length);
  return mutationToken.length > 0 ? mutationToken : undefined;
}

function legacyZoneIdFromCacheKey(key: string): string | undefined {
  return key.startsWith(CACHE_KEY_PREFIX) &&
    !key.startsWith(CACHE_ENTRY_KEY_PREFIX) &&
    !RESERVED_CACHE_KEYS.has(key)
    ? key.slice(CACHE_KEY_PREFIX.length)
    : undefined;
}

function isOwnedCacheEntryKey(key: string): boolean {
  return (
    key.startsWith(CACHE_ENTRY_KEY_PREFIX) ||
    legacyZoneIdFromCacheKey(key) !== undefined
  );
}

function retainedBytes(key: string, value: string): number {
  return utf8ByteLength(key) + utf8ByteLength(value);
}

function indexRetainedBytes(index: readonly string[]): number {
  return retainedBytes(
    CACHE_INDEX_KEY,
    JSON.stringify({
      format: CACHE_INDEX_FORMAT,
      revision: Number.MAX_SAFE_INTEGER,
      writer: CACHE_OWNER_ID,
      zoneIds: index,
    }),
  );
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
  const keyMutationToken = mutationTokenFromCacheKey(key);
  const legacyZoneId = legacyZoneIdFromCacheKey(key);
  if (keyMutationToken === undefined && legacyZoneId === undefined) {
    throw new SyntaxError("Invalid offline cache key");
  }
  const entryBytes = assertStoredValueWithinLimit(key, raw);
  const parsed: unknown = JSON.parse(raw);
  if (!isCachedZoneRecords(parsed)) {
    throw new SyntaxError("Invalid offline cache entry");
  }
  const parsedMutationToken =
    "__bcMutation" in parsed && typeof parsed.__bcMutation === "string"
      ? parsed.__bcMutation
      : "";
  if (
    (legacyZoneId !== undefined && parsed.zoneId !== legacyZoneId) ||
    (keyMutationToken !== undefined && parsedMutationToken !== keyMutationToken)
  ) {
    throw new SyntaxError("Offline cache entry key does not match its value");
  }
  return {
    zoneId: parsed.zoneId,
    key,
    raw,
    value: {
      zoneId: parsed.zoneId,
      zoneName: parsed.zoneName,
      records: parsed.records,
      cachedAt: parsed.cachedAt,
    },
    mutationToken: parsedMutationToken,
    retainedBytes: entryBytes,
  };
}

function validateIndexZoneIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > RESOURCE_LIMITS.offlineCache.hardEntries ||
    value.some((zoneId) => typeof zoneId !== "string") ||
    new Set(value).size !== value.length
  ) {
    throw new SyntaxError("Invalid offline cache index");
  }
  return value;
}

function parseCacheIndex(raw: string): Omit<CacheIndexSnapshot, "raw"> {
  assertStoredValueWithinLimit(CACHE_INDEX_KEY, raw);
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return {
      zoneIds: validateIndexZoneIds(parsed),
      revision: 0,
      modern: false,
      valid: true,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SyntaxError("Invalid offline cache index");
  }
  const candidate = parsed as {
    format?: unknown;
    revision?: unknown;
    writer?: unknown;
    zoneIds?: unknown;
  };
  if (
    candidate.format !== CACHE_INDEX_FORMAT ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0 ||
    typeof candidate.writer !== "string" ||
    candidate.writer.length === 0 ||
    candidate.writer.length > 128
  ) {
    throw new SyntaxError("Invalid offline cache index");
  }
  return {
    zoneIds: validateIndexZoneIds(candidate.zoneIds),
    revision: candidate.revision as number,
    modern: true,
    valid: true,
  };
}

function readCacheIndex(): CacheIndexSnapshot {
  const raw = localStorage.getItem(CACHE_INDEX_KEY);
  if (raw === null) {
    return {
      raw,
      zoneIds: [],
      revision: 0,
      modern: true,
      valid: true,
    };
  }
  try {
    return { raw, ...parseCacheIndex(raw) };
  } catch (error) {
    reportCacheFailure(
      error,
      "Recover DNS offline cache index",
      error instanceof SyntaxError,
    );
    return {
      raw,
      zoneIds: [],
      revision: 0,
      modern: false,
      valid: false,
    };
  }
}

function prepareCacheIndex(
  index: readonly string[],
  previousRevision: number,
): PreparedIndexWrite {
  if (index.length > RESOURCE_LIMITS.offlineCache.hardEntries) {
    throw new OfflineCacheLimitError(
      "DNS offline cache index exceeds the entry limit.",
    );
  }
  if (index.length === 0) {
    return { raw: null };
  }
  const revision =
    previousRevision >= Number.MAX_SAFE_INTEGER ? 1 : previousRevision + 1;
  const raw = JSON.stringify({
    format: CACHE_INDEX_FORMAT,
    revision,
    writer: CACHE_OWNER_ID,
    zoneIds: index,
  });
  assertStoredValueWithinLimit(CACHE_INDEX_KEY, raw);
  return { raw };
}

function applyPreparedIndex(write: PreparedIndexWrite): void {
  if (write.raw === null) {
    localStorage.removeItem(CACHE_INDEX_KEY);
  } else {
    localStorage.setItem(CACHE_INDEX_KEY, write.raw);
  }
}

function restoreStoredValue(key: string, previous: string | null): void {
  if (previous === null) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, previous);
  }
}

function restoreIfUnchanged(
  key: string,
  expectedCurrent: string | null,
  previous: string | null,
  operation: string,
): "restored" | "already-restored" | "changed" | "failed" {
  let expectedGenerationObserved = false;
  try {
    const current = localStorage.getItem(key);
    if (current === previous) return "already-restored";
    if (current !== expectedCurrent) return "changed";
    expectedGenerationObserved = true;
    restoreStoredValue(key, previous);
    return localStorage.getItem(key) === previous ? "restored" : "failed";
  } catch (error) {
    reportCacheFailure(error, operation);
    if (expectedGenerationObserved) {
      try {
        if (localStorage.getItem(key) === previous) return "restored";
      } catch (verificationError) {
        reportCacheFailure(verificationError, operation);
      }
    }
    return "failed";
  }
}

function cleanupRollbackRestorations(
  rollback: Pick<
    PendingCacheRollback,
    "removedEntries" | "restoredEntryKeys"
  >,
  operation: string,
): boolean {
  let cleanupComplete = true;
  for (const entry of rollback.removedEntries) {
    if (!rollback.restoredEntryKeys.has(entry.key)) continue;
    const result = restoreIfUnchanged(entry.key, entry.raw, null, operation);
    if (result === "failed") {
      cleanupComplete = false;
    } else {
      rollback.restoredEntryKeys.delete(entry.key);
    }
  }
  return cleanupComplete;
}

function rollbackGenerationIsCurrent(
  lease: CacheLease,
  expectedIndexRaw: string | null,
  operation: string,
): boolean {
  try {
    const currentLease = parseCacheLease(
      localStorage.getItem(CACHE_COORDINATION_KEY),
    );
    return (
      localStorage.getItem(CACHE_INDEX_KEY) === expectedIndexRaw &&
      currentLease?.owner === lease.owner &&
      currentLease.token === lease.token &&
      currentLease.expiresAt > Date.now()
    );
  } catch (error) {
    reportCacheFailure(error, operation);
    return false;
  }
}

function scheduleRollback(): void {
  if (rollbackTimer !== undefined || !pendingRollback) return;
  const rollback = pendingRollback;
  const terminateRollback = (): void => {
    if (pendingRollback !== rollback) return;
    pendingRollback = undefined;
    completedCacheState = undefined;
    recoveryState = undefined;
  };
  const delay = Math.min(
    ROLLBACK_RETRY_BASE_DELAY_MS * 2 ** Math.min(rollback.attempts, 6),
    1_000,
  );
  rollbackTimer = setTimeout(() => {
    rollbackTimer = undefined;
    if (pendingRollback !== rollback) {
      scheduleRollback();
      return;
    }
    rollback.attempts += 1;
    let cleanupComplete = true;
    let rollbackFinished = false;
    try {
      const lease = tryAcquireCacheLease();
      if (lease) {
        try {
          let checkedIndexRaw: string | null | undefined;
          try {
            checkedIndexRaw = localStorage.getItem(CACHE_INDEX_KEY);
          } catch (error) {
            reportCacheFailure(
              error,
              "Verify DNS offline cache rollback generation",
            );
          }
          const indexMatchesRollbackGeneration =
            checkedIndexRaw === rollback.previousIndexRaw ||
            checkedIndexRaw === rollback.attemptedIndexRaw;
          if (checkedIndexRaw !== undefined && !indexMatchesRollbackGeneration) {
            rollbackFinished = true;
            cleanupComplete = cleanupRollbackRestorations(
              rollback,
              "Remove superseded DNS offline cache rollback restoration",
            );
          }
          let generationStillCurrent = false;
          let rollbackSuperseded = false;
          let rollbackIndexRaw: string | null | undefined;
          if (indexMatchesRollbackGeneration && checkedIndexRaw !== undefined) {
            generationStillCurrent = true;
            rollbackIndexRaw = checkedIndexRaw;
            for (const entry of rollback.removedEntries) {
              const guardOperation =
                "Verify DNS offline cache rollback entry generation";
              if (
                !rollbackGenerationIsCurrent(
                  lease,
                  rollbackIndexRaw,
                  guardOperation,
                )
              ) {
                generationStillCurrent = false;
                break;
              }
              const result = restoreIfUnchanged(
                entry.key,
                null,
                entry.raw,
                "Retry removed DNS offline cache entry rollback",
              );
              if (result === "restored") {
                rollback.restoredEntryKeys.add(entry.key);
              } else if (result === "changed") {
                rollbackSuperseded = true;
                generationStillCurrent = false;
                break;
              }
              if (
                result === "failed" ||
                !rollbackGenerationIsCurrent(
                  lease,
                  rollbackIndexRaw,
                  guardOperation,
                )
              ) {
                generationStillCurrent = false;
                break;
              }
            }
          }

          if (generationStillCurrent && rollbackIndexRaw !== undefined) {
            const indexResult = restoreIfUnchanged(
              CACHE_INDEX_KEY,
              rollbackIndexRaw,
              rollback.previousIndexRaw,
              "Retry DNS offline cache index rollback",
            );
            if (indexResult === "changed") {
              rollbackSuperseded = true;
            }
            try {
              rollbackFinished =
                (indexResult === "restored" ||
                  indexResult === "already-restored") &&
                localStorage.getItem(CACHE_INDEX_KEY) ===
                  rollback.previousIndexRaw &&
                rollback.removedEntries.every(
                  (entry) => localStorage.getItem(entry.key) === entry.raw,
                );
            } catch (error) {
              reportCacheFailure(
                error,
                "Verify restored DNS offline cache rollback generation",
              );
            }
          }

          if (rollbackSuperseded) rollbackFinished = true;
          if (!rollbackFinished) {
            cleanupComplete = cleanupRollbackRestorations(
              rollback,
              "Remove stale DNS offline cache rollback restoration",
            );
          } else if (rollbackSuperseded) {
            cleanupComplete = cleanupRollbackRestorations(
              rollback,
              "Remove superseded DNS offline cache rollback restoration",
            );
          }
          if (rollbackFinished && cleanupComplete) {
            const incomingResult = restoreIfUnchanged(
              rollback.incomingKey,
              rollback.incomingRaw,
              null,
              "Retry incoming DNS offline cache entry rollback",
            );
            cleanupComplete = incomingResult !== "failed";
          }
        } finally {
          releaseCacheLease(lease);
        }
      } else {
        cleanupComplete = false;
      }
    } catch (error) {
      cleanupComplete = false;
      reportCacheFailure(error, "Retry DNS offline cache rollback");
    }

    if (pendingRollback !== rollback) {
      scheduleRollback();
      return;
    }

    if (rollbackFinished && cleanupComplete) {
      terminateRollback();
      tryReconcileAfterFailure("Reconcile retried DNS offline cache rollback");
      return;
    }
    if (
      rollback.attempts >= ROLLBACK_RETRY_LIMIT ||
      Date.now() - rollback.startedAt >= ROLLBACK_RETRY_WINDOW_MS
    ) {
      terminateRollback();
      tryReconcileAfterFailure(
        "Reconcile abandoned DNS offline cache rollback",
      );
      return;
    }
    try {
      scheduleRollback();
    } catch (error) {
      terminateRollback();
      reportCacheFailure(error, "Schedule DNS offline cache rollback retry");
    }
  }, delay);
}

function parseCacheLease(raw: string | null): CacheLease | undefined {
  if (
    raw === null ||
    raw.length > RESOURCE_LIMITS.offlineCache.coordinationValueHardCharacters
  ) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const lease = parsed as Partial<CacheLease>;
    return typeof lease.owner === "string" &&
      typeof lease.token === "string" &&
      lease.owner.length <= 128 &&
      lease.token.length <= 128 &&
      typeof lease.expiresAt === "number" &&
      Number.isFinite(lease.expiresAt)
      ? (lease as CacheLease)
      : undefined;
  } catch {
    return undefined;
  }
}

function tryAcquireCacheLease(
  throwStorageErrors = false,
): CacheLease | undefined {
  try {
    const now = Date.now();
    const current = parseCacheLease(
      localStorage.getItem(CACHE_COORDINATION_KEY),
    );
    if (
      current &&
      current.owner !== CACHE_OWNER_ID &&
      current.expiresAt > now &&
      current.expiresAt <= now + CACHE_LEASE_MS * 2
    ) {
      return undefined;
    }

    const lease: CacheLease = {
      owner: CACHE_OWNER_ID,
      token: randomToken(),
      expiresAt: now + CACHE_LEASE_MS,
    };
    const raw = JSON.stringify(lease);
    localStorage.setItem(CACHE_COORDINATION_KEY, raw);
    const confirmed = parseCacheLease(
      localStorage.getItem(CACHE_COORDINATION_KEY),
    );
    return confirmed?.owner === lease.owner && confirmed.token === lease.token
      ? lease
      : undefined;
  } catch (error) {
    if (throwStorageErrors) throw error;
    // The lease only reduces collisions. Versioned reconciliation remains the
    // correctness mechanism when quota or access policy blocks coordination.
    reportCacheFailure(error, "Coordinate DNS offline cache");
    return undefined;
  }
}

function releaseCacheLease(lease: CacheLease | undefined): void {
  if (!lease) return;
  try {
    const current = parseCacheLease(
      localStorage.getItem(CACHE_COORDINATION_KEY),
    );
    if (current?.owner === lease.owner && current.token === lease.token) {
      localStorage.removeItem(CACHE_COORDINATION_KEY);
    }
  } catch (error) {
    reportCacheFailure(error, "Release DNS offline cache coordination");
  }
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

function isNewerCacheEntry(
  candidate: IndexedCacheEntry,
  current: IndexedCacheEntry,
): boolean {
  return (
    candidate.value.cachedAt > current.value.cachedAt ||
    (candidate.value.cachedAt === current.value.cachedAt &&
      (candidate.mutationToken > current.mutationToken ||
        (candidate.mutationToken === current.mutationToken &&
          candidate.key > current.key)))
  );
}

function removeEntryIfUnchanged(entry: IndexedCacheEntry): void {
  if (localStorage.getItem(entry.key) === entry.raw) {
    localStorage.removeItem(entry.key);
  }
}

function retainRecoveryCandidate(
  state: CacheRecoveryState,
  entry: IndexedCacheEntry,
): void {
  const existing = state.candidates.get(entry.zoneId);
  if (existing) {
    if (isNewerCacheEntry(entry, existing)) {
      removeEntryIfUnchanged(existing);
      state.candidates.set(entry.zoneId, entry);
    } else {
      removeEntryIfUnchanged(entry);
    }
    return;
  }
  state.candidates.set(entry.zoneId, entry);
  if (state.candidates.size <= RESOURCE_LIMITS.offlineCache.hardEntries) return;

  let oldest: IndexedCacheEntry | undefined;
  for (const candidate of state.candidates.values()) {
    if (!oldest || isNewerCacheEntry(oldest, candidate)) oldest = candidate;
  }
  if (oldest) {
    state.candidates.delete(oldest.zoneId);
    removeEntryIfUnchanged(oldest);
  }
}

function scheduleRecovery(): void {
  if (recoveryTimer !== undefined) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = undefined;
    try {
      continueRecovery();
    } catch (error) {
      reportCacheFailure(error, "Recover DNS offline cache");
      scheduleRecovery();
    }
  }, 0);
}

function continueRecovery(): IndexedCacheEntry[] | undefined {
  const state = recoveryState;
  if (!state) return completedCacheState;
  let budget = RESOURCE_LIMITS.offlineCache.discoveryBatchKeys;
  while (state.cursor > 0 && budget > 0) {
    state.cursor -= 1;
    budget -= 1;
    const key = localStorage.key(state.cursor);
    if (!key || !isOwnedCacheEntryKey(key)) continue;
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    try {
      retainRecoveryCandidate(state, parseCacheEntry(key, raw));
    } catch (error) {
      reportCacheFailure(
        error,
        state.invalidEntryOperation,
        error instanceof SyntaxError,
      );
      if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
    }
  }
  if (state.cursor > 0) {
    scheduleRecovery();
    return undefined;
  }

  const ordered = [...state.candidates.values()]
    .filter((entry) => localStorage.getItem(entry.key) === entry.raw)
    .sort(
      (left, right) =>
        left.value.cachedAt - right.value.cachedAt ||
        left.zoneId.localeCompare(right.zoneId),
    );
  const { retained, evicted } = entriesWithinLimits(ordered);
  for (const entry of evicted) removeEntryIfUnchanged(entry);
  const indexWrite = prepareCacheIndex(
    retained.map((entry) => entry.zoneId),
    state.index.revision,
  );
  if (localStorage.getItem(CACHE_INDEX_KEY) !== state.index.raw) {
    recoveryState = undefined;
    completedCacheState = undefined;
    return undefined;
  }
  if (
    !state.index.valid ||
    !state.index.modern ||
    !sameIndex(
      state.index.zoneIds,
      retained.map((entry) => entry.zoneId),
    ) ||
    (retained.length === 0 && state.index.raw !== null)
  ) {
    applyPreparedIndex(indexWrite);
  }
  completedCacheState = retained;
  recoveryState = undefined;
  return retained;
}

function reconcileCacheState(
  invalidEntryOperation = "Inspect DNS offline cache entry",
  coordinate = true,
): IndexedCacheEntry[] {
  const lease = coordinate ? tryAcquireCacheLease() : undefined;
  try {
    if (!recoveryState) {
      recoveryState = {
        index: readCacheIndex(),
        storedKeyCount: localStorage.length,
        cursor: localStorage.length,
        candidates: new Map(),
        invalidEntryOperation,
      };
    }
    const recovered = continueRecovery();
    if (recovered) return recovered;
    throw new OfflineCacheRecoveryPendingError(
      "DNS offline cache recovery will resume in a later task.",
    );
  } finally {
    releaseCacheLease(lease);
  }
}

function nextMutationToken(cachedAt: number): string {
  mutationSequence = (mutationSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${cachedAt.toString(36).padStart(11, "0")}:${CACHE_OWNER_ID}:${mutationSequence
    .toString(36)
    .padStart(11, "0")}`;
}

function serializedCacheEntry(
  entry: CachedZoneRecords,
  mutationToken: string,
): string {
  return JSON.stringify({
    ...entry,
    __bcMutation: mutationToken,
  });
}

function tryReconcileAfterFailure(operation: string): void {
  try {
    reconcileCacheState(operation, false);
  } catch (error) {
    reportCacheFailure(error, operation);
  }
}

function scheduleContendedCacheReconciliation(): void {
  if (contendedReconciliationTimer !== undefined) return;
  contendedReconciliationTimer = setTimeout(() => {
    contendedReconciliationTimer = undefined;
    completedCacheState = undefined;
    recoveryState = undefined;
    try {
      reconcileCacheState("Reconcile contended DNS offline cache write");
    } catch (error) {
      reportCacheFailure(
        error,
        "Reconcile contended DNS offline cache write",
      );
    }
  }, CACHE_LEASE_MS);
}

function persistCacheEntry(
  entry: CachedZoneRecords,
  key: string,
  serialized: string,
): void {
  const incomingBytes = assertStoredValueWithinLimit(key, serialized);
  if (
    incomingBytes + indexRetainedBytes([entry.zoneId]) >
    RESOURCE_LIMITS.offlineCache.hardBytes
  ) {
    throw new OfflineCacheLimitError(
      `DNS offline cache entry ${entry.zoneId} exceeds the cache byte limit.`,
    );
  }

  const lease = tryAcquireCacheLease(true);
  if (!lease) {
    // Preserve this immutable version as the source of truth without racing the
    // current owner's removals or index write. The bounded deferred pass (or
    // any observable read) will reconcile the index after the lease expires.
    localStorage.setItem(key, serialized);
    completedCacheState = undefined;
    recoveryState = undefined;
    scheduleContendedCacheReconciliation();
    return;
  }
  try {
    const state = reconcileCacheState("Inspect DNS offline cache entry", false);
    const replaced = state.filter(
      (candidate) => candidate.zoneId === entry.zoneId,
    );
    const existing = state.filter(
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

    const previousIndexRaw = localStorage.getItem(CACHE_INDEX_KEY);
    const previousRevision = readCacheIndex().revision;
    const indexWrite = prepareCacheIndex(
      [...retained.map((candidate) => candidate.zoneId), entry.zoneId],
      previousRevision,
    );
    const attemptedRemovals: IndexedCacheEntry[] = [];

    try {
      localStorage.setItem(key, serialized);
      for (const removedEntry of [...replaced, ...evicted]) {
        attemptedRemovals.push(removedEntry);
        localStorage.removeItem(removedEntry.key);
      }
      applyPreparedIndex(indexWrite);
    } catch (error) {
      const indexRestored = restoreIfUnchanged(
        CACHE_INDEX_KEY,
        indexWrite.raw,
        previousIndexRaw,
        "Roll back DNS offline cache index",
      );
      const removedEntries = attemptedRemovals.slice(
        0,
        RESOURCE_LIMITS.offlineCache.hardEntries,
      );
      const restoredEntryKeys = new Set<string>();
      let entriesRestored = true;
      for (const removedEntry of removedEntries) {
        const result = restoreIfUnchanged(
          removedEntry.key,
          null,
          removedEntry.raw,
          "Roll back removed DNS offline cache entry",
        );
        if (result === "restored") restoredEntryKeys.add(removedEntry.key);
        entriesRestored &&=
          result === "restored" || result === "already-restored";
      }
      const rollbackIncomplete =
        (indexRestored !== "restored" &&
          indexRestored !== "already-restored") ||
        !entriesRestored;
      let staleRestorationsRemoved = true;
      if (rollbackIncomplete) {
        staleRestorationsRemoved = cleanupRollbackRestorations(
          { removedEntries, restoredEntryKeys },
          "Remove incomplete DNS offline cache rollback restoration",
        );
      }
      const incomingResult = restoreIfUnchanged(
        key,
        serialized,
        null,
        "Roll back DNS offline cache entry",
      );
      if (
        rollbackIncomplete ||
        !staleRestorationsRemoved ||
        incomingResult === "failed"
      ) {
        pendingRollback = {
          previousIndexRaw,
          attemptedIndexRaw: indexWrite.raw,
          removedEntries,
          restoredEntryKeys,
          incomingKey: key,
          incomingRaw: serialized,
          attempts: 0,
          startedAt: Date.now(),
        };
        scheduleRollback();
        if (!rollbackIncomplete) {
          tryReconcileAfterFailure("Reconcile failed DNS offline cache write");
        }
      } else {
        tryReconcileAfterFailure("Reconcile failed DNS offline cache write");
      }
      throw error;
    }
  } finally {
    releaseCacheLease(lease);
  }

  reconcileCacheState("Verify DNS offline cache write");
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
  const mutationToken = nextMutationToken(entry.cachedAt);
  const key = `${CACHE_ENTRY_KEY_PREFIX}${mutationToken}`;
  let serialized: string;
  try {
    serialized = serializedCacheEntry(entry, mutationToken);
  } catch (error) {
    reportCacheFailure(error, "Serialize DNS offline cache");
    return;
  }

  try {
    persistCacheEntry(entry, key, serialized);
    return;
  } catch (error) {
    reportCacheFailure(error, "Write DNS offline cache");
    if (!isQuotaError(error)) return;
  }

  // Retry one transient quota failure without deleting durable data.
  try {
    persistCacheEntry(entry, key, serialized);
  } catch (error) {
    reportCacheFailure(error, "Retry DNS offline cache write");
  }
}

/**
 * Retrieve cached records for a zone, or null if not cached.
 */
export function getCachedZoneRecords(zoneId: string): CachedZoneRecords | null {
  try {
    const cached = reconcileCacheState("Read DNS offline cache").find(
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
  const lease = tryAcquireCacheLease();
  if (!lease) {
    reportCacheFailure(
      new OfflineCacheRecoveryPendingError(
        "DNS offline cache coordination is unavailable.",
      ),
      "Remove DNS offline cache",
    );
    return;
  }
  try {
    const state = reconcileCacheState("Inspect DNS offline cache entry", false);
    const removedEntries = state.filter((entry) => entry.zoneId === zoneId);
    const previousIndexRaw = localStorage.getItem(CACHE_INDEX_KEY);
    const indexWrite = prepareCacheIndex(
      state
        .filter((entry) => entry.zoneId !== zoneId)
        .map((entry) => entry.zoneId),
      readCacheIndex().revision,
    );
    const attemptedRemovals: IndexedCacheEntry[] = [];
    try {
      for (const removedEntry of removedEntries) {
        attemptedRemovals.push(removedEntry);
        localStorage.removeItem(removedEntry.key);
      }
      applyPreparedIndex(indexWrite);
    } catch (error) {
      restoreIfUnchanged(
        CACHE_INDEX_KEY,
        indexWrite.raw,
        previousIndexRaw,
        "Roll back removed DNS offline cache index",
      );
      for (const removedEntry of attemptedRemovals) {
        restoreIfUnchanged(
          removedEntry.key,
          null,
          removedEntry.raw,
          "Roll back removed DNS offline cache entry",
        );
      }
      tryReconcileAfterFailure("Reconcile failed DNS offline cache removal");
      throw error;
    }
  } catch (error) {
    reportCacheFailure(error, "Remove DNS offline cache");
  } finally {
    releaseCacheLease(lease);
  }

  try {
    reconcileCacheState("Verify DNS offline cache removal");
  } catch (error) {
    reportCacheFailure(error, "Verify DNS offline cache removal");
  }
}

function scheduleClear(): void {
  if (clearTimer !== undefined || !pendingClear) return;
  clearTimer = setTimeout(() => {
    clearTimer = undefined;
    continueClear();
  }, 0);
}

function continueClear(): void {
  const state = pendingClear;
  if (!state) return;
  let budget = RESOURCE_LIMITS.offlineCache.discoveryBatchKeys;
  while (state.cursor > 0 && budget > 0) {
    state.cursor -= 1;
    budget -= 1;
    const key = localStorage.key(state.cursor);
    if (key && (key === CACHE_INDEX_KEY || isOwnedCacheEntryKey(key))) {
      state.discovered += 1;
      try {
        localStorage.removeItem(key);
      } catch (error) {
        state.firstError ??= error;
      }
    }
  }
  if (state.cursor > 0) {
    scheduleClear();
    return;
  }
  if (
    state.discovered > 0 &&
    state.pass + 1 < RESOURCE_LIMITS.offlineCache.reconciliationPassesHard
  ) {
    state.cursor = localStorage.length;
    state.discovered = 0;
    state.pass += 1;
    scheduleClear();
    return;
  }
  pendingClear = undefined;
  if (state.firstError !== undefined) {
    reportCacheFailure(state.firstError, "Clear DNS offline cache");
  }
}

/**
 * Clear all keys owned by the offline cache.
 */
export function clearOfflineCache(): void {
  if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
  if (contendedReconciliationTimer !== undefined) {
    clearTimeout(contendedReconciliationTimer);
  }
  if (rollbackTimer !== undefined) clearTimeout(rollbackTimer);
  if (clearTimer !== undefined) clearTimeout(clearTimer);
  recoveryTimer = undefined;
  contendedReconciliationTimer = undefined;
  rollbackTimer = undefined;
  clearTimer = undefined;
  recoveryState = undefined;
  completedCacheState = undefined;
  pendingRollback = undefined;
  pendingClear = {
    cursor: localStorage.length,
    discovered: 0,
    pass: 0,
    firstError: undefined,
  };
  continueClear();
}

/**
 * Get cached zone IDs in deterministic oldest-to-newest write order.
 */
export function getCacheIndex(): string[] {
  try {
    return reconcileCacheState().map((entry) => entry.zoneId);
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
