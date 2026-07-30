import { reportRuntimeError } from "@/lib/errors/runtime-reporting";

const LEGACY_DATABASE_NAME = "better-cloudflare";
const LEGACY_STORE_NAME = "kv";
const MIGRATION_MARKER_KEY = "better-cloudflare-storage-v2-migrated";
const LEGACY_STORAGE_KEYS = [
  "cloudflare-dns-manager",
  "encryption-settings",
] as const;
const LEGACY_MIGRATION_TIMEOUT_MS = 10_000;
const LEGACY_MIGRATION_MAX_ENTRIES = 64;
const LEGACY_MIGRATION_MAX_BYTES = 2 * 1024 * 1024 + 128 * 1024;

/**
 * Minimal synchronous storage contract used by the application. Async stores
 * must not be hidden behind this interface: callers rely on a thrown
 * setItem/removeItem error to roll back their in-memory mutation.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  ready?(): Promise<void>;
  isReady?(): boolean;
  readonly backend?: "localstorage" | "memory";
}

export class StorageNotReadyError extends Error {
  readonly name = "StorageNotReadyError";

  constructor() {
    super("Persistent browser storage is still being prepared.");
  }
}

function reportStorageFailure(error: unknown, label: string): void {
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
      ? error.name
      : "";
  const category =
    name === "QuotaExceededError"
      ? "quota exceeded"
      : name === "SecurityError" || name === "NotAllowedError"
        ? "access denied"
        : name === "DataError" || name === "UnknownError"
          ? "data unavailable"
          : "operation failed";
  reportRuntimeError(error, {
    source: "runtime",
    label: `${label}: ${category}`,
  });
}

class MemoryStorage implements StorageLike {
  readonly backend = "memory" as const;
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? this.store[key]
      : null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  isReady(): boolean {
    return true;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }
}

export type LegacyStorageLoader = () => Promise<ReadonlyMap<string, string>>;

export interface LegacyMigrationSafetyOptions {
  timeoutMs?: number;
  allowedKeys?: readonly string[];
  maxEntries?: number;
  maxBytes?: number;
}

function utf8ByteLengthUpTo(value: string, maximum: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

function boundedIntegerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const normalized =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.max(minimum, Math.min(maximum, normalized));
}

function assertLegacyValuesWithinLimits(
  values: ReadonlyMap<string, string>,
  options: LegacyMigrationSafetyOptions,
): void {
  const maxEntries = boundedIntegerOption(
    options.maxEntries,
    LEGACY_MIGRATION_MAX_ENTRIES,
    0,
    LEGACY_MIGRATION_MAX_ENTRIES,
  );
  const maxBytes = boundedIntegerOption(
    options.maxBytes,
    LEGACY_MIGRATION_MAX_BYTES,
    0,
    LEGACY_MIGRATION_MAX_BYTES,
  );
  if (values.size > maxEntries) {
    throw new RangeError(
      "Legacy storage contains too many entries to migrate.",
    );
  }

  const allowedKeys = options.allowedKeys
    ? new Set(options.allowedKeys)
    : undefined;
  let retainedBytes = 0;
  for (const [key, value] of values) {
    if (typeof key !== "string" || typeof value !== "string") {
      throw new TypeError("Legacy storage contained a non-string entry.");
    }
    if (allowedKeys && !allowedKeys.has(key)) {
      throw new TypeError(`Unexpected legacy storage key: ${key}`);
    }
    retainedBytes += utf8ByteLengthUpTo(
      key,
      Math.max(0, maxBytes - retainedBytes),
    );
    if (retainedBytes > maxBytes) {
      throw new RangeError("Legacy storage exceeds the migration byte limit.");
    }
    retainedBytes += utf8ByteLengthUpTo(
      value,
      Math.max(0, maxBytes - retainedBytes),
    );
    if (retainedBytes > maxBytes) {
      throw new RangeError("Legacy storage exceeds the migration byte limit.");
    }
  }
}

async function loadLegacyValuesWithinTimeout(
  loadLegacyValues: LegacyStorageLoader,
  timeoutMs: number,
): Promise<ReadonlyMap<string, string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadLegacyValues(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Legacy browser storage migration timed out before startup could complete safely.",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build a synchronous durable adapter behind an explicit async readiness
 * barrier. Legacy IndexedDB values are copied transactionally into the
 * synchronous store before callers may read or mutate it.
 */
export function createMigratingStorage(
  storage: StorageLike,
  loadLegacyValues: LegacyStorageLoader,
  options: LegacyMigrationSafetyOptions = {},
): StorageLike {
  let ready = false;
  let failure: unknown;
  const timeoutMs = boundedIntegerOption(
    options.timeoutMs,
    LEGACY_MIGRATION_TIMEOUT_MS,
    1,
    LEGACY_MIGRATION_TIMEOUT_MS,
  );

  const readiness = (async () => {
    const legacyValues = await loadLegacyValuesWithinTimeout(
      loadLegacyValues,
      timeoutMs,
    );
    assertLegacyValuesWithinLimits(legacyValues, options);
    const previous = new Map<string, string | null>();
    const written: string[] = [];

    try {
      for (const [key, value] of legacyValues) {
        const oldValue = storage.getItem(key);
        if (oldValue === value) continue;
        previous.set(key, oldValue);
        written.push(key);
        storage.setItem(key, value);
      }
      previous.set(MIGRATION_MARKER_KEY, storage.getItem(MIGRATION_MARKER_KEY));
      written.push(MIGRATION_MARKER_KEY);
      storage.setItem(MIGRATION_MARKER_KEY, "1");
      ready = true;
    } catch (error) {
      for (const key of written.reverse()) {
        try {
          const oldValue = previous.get(key) ?? null;
          if (oldValue === null) storage.removeItem(key);
          else storage.setItem(key, oldValue);
        } catch (rollbackError) {
          reportStorageFailure(
            rollbackError,
            "Roll back browser storage migration",
          );
        }
      }
      failure = error;
      throw error;
    }
  })().catch((error) => {
    failure = error;
    reportStorageFailure(error, "Prepare browser storage");
    throw error;
  });

  const assertReady = (): void => {
    if (ready) return;
    if (failure instanceof Error) throw failure;
    throw new StorageNotReadyError();
  };

  return {
    backend: "localstorage",
    getItem(key: string): string | null {
      return storage.getItem(key);
    },
    setItem(key: string, value: string): void {
      assertReady();
      storage.setItem(key, value);
    },
    removeItem(key: string): void {
      assertReady();
      storage.removeItem(key);
    },
    isReady(): boolean {
      return ready;
    },
    ready(): Promise<void> {
      return readiness;
    },
  };
}

async function loadLegacyIndexedDbValues(): Promise<
  ReadonlyMap<string, string>
> {
  if (typeof indexedDB === "undefined") return new Map();
  const idb = await import("idb");
  const db = await idb.openDB(LEGACY_DATABASE_NAME, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        database.createObjectStore(LEGACY_STORE_NAME);
      }
    },
  });

  try {
    const values = new Map<string, string>();
    for (const key of LEGACY_STORAGE_KEYS) {
      const value: unknown = await db.get(LEGACY_STORE_NAME, key);
      if (value === undefined) continue;
      if (typeof value !== "string") {
        throw new TypeError("Legacy IndexedDB contained a non-string value.");
      }
      values.set(key, value);
    }
    return values;
  } finally {
    db.close();
  }
}

let selectedStorage: StorageLike | undefined;
let selectedBackend: "localstorage" | "memory" | undefined;

/**
 * Return one process-wide storage adapter. localStorage is the canonical
 * synchronous durable store. IndexedDB is read only during the awaited legacy
 * migration; it is never presented as a synchronous fire-and-forget facade.
 */
export function getStorage(storage?: StorageLike): StorageLike {
  if (storage) return storage;
  if (selectedStorage) return selectedStorage;

  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const maybeStorage = (globalThis as { localStorage?: Storage })
        .localStorage;
      if (
        maybeStorage &&
        typeof maybeStorage.getItem === "function" &&
        typeof maybeStorage.setItem === "function" &&
        typeof maybeStorage.removeItem === "function"
      ) {
        const syncStorage: StorageLike = {
          backend: "localstorage",
          getItem: (key) => maybeStorage.getItem(key),
          setItem: (key, value) => maybeStorage.setItem(key, value),
          removeItem: (key) => maybeStorage.removeItem(key),
          isReady: () => true,
          ready: () => Promise.resolve(),
        };
        const migrationComplete =
          maybeStorage.getItem(MIGRATION_MARKER_KEY) === "1";
        selectedStorage = migrationComplete
          ? syncStorage
          : createMigratingStorage(syncStorage, loadLegacyIndexedDbValues, {
              allowedKeys: LEGACY_STORAGE_KEYS,
            });
        selectedBackend = "localstorage";
        return selectedStorage;
      }
    }
  } catch (error) {
    reportStorageFailure(error, "Select browser storage");
  }

  reportStorageFailure(
    new Error(
      "Durable synchronous browser storage is unavailable; using an ephemeral session.",
    ),
    "Select browser storage",
  );
  selectedStorage = new MemoryStorage();
  selectedBackend = "memory";
  return selectedStorage;
}

export function storageBackend(): "indexeddb" | "localstorage" | "memory" {
  if (!selectedStorage) getStorage();
  return selectedBackend ?? "memory";
}

/** Test-only process singleton reset. */
export function resetStorageSelectionForTests(): void {
  selectedStorage = undefined;
  selectedBackend = undefined;
}
