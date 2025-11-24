/**
 * Minimal interface for storage implementations used by the app. The
 * production implementation uses `localStorage`, but unit tests or server
 * code can provide an alternative that satisfies this contract.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * In-memory storage fallback for environments without `localStorage` or
 * during tests. Implements the same `StorageLike` API.
 */
class MemoryStorage implements StorageLike {
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
}

/**
 * Return the best available storage implementation:
 * - If a `storage` parameter is provided, return it
 * - If `globalThis.localStorage` is available, return it
 * - Otherwise return an in-memory fallback
 *
 * This helper centralizes the logic for selecting a storage implementation
 * for other modules.
 */
/**
 * Select and return an appropriate StorageLike implementation for the
 * current environment.
 *
 * Preference order:
 * - A user-provided `storage` argument
 * - IndexedDB-based storage (when available)
 * - globalThis.localStorage (when available)
 * - In-memory fallback
 *
 * This helper returns an object implementing the `StorageLike` interface
 * and abstracts away the differences between a sync localStorage-like API
 * and an async IndexedDB backing store by using an in-memory cache.
 */
export function getStorage(storage?: StorageLike): StorageLike {
  /**
   * Select the storage to use.
   *
   * @param storage - optional custom StorageLike
   * @returns the chosen StorageLike implementation
   */
  if (storage) return storage;
  try {
    // Prefer IndexedDB storage when available
    if (typeof indexedDB !== 'undefined') {
      // lazily load idb and create a simple wrapper
      // We intentionally load idb dynamically inside init() so this module
      // remains synchronous to callers while still enabling an async
      // initialization path when IndexedDB is available.
      type IDBRuntime = {
        createObjectStore?: (name: string) => void;
        getAllKeys?: (store: string) => Promise<string[]>;
        get?: (store: string, key: string) => Promise<unknown>;
        put?: (store: string, value: unknown, key: string) => Promise<void>;
        delete?: (store: string, key: string) => Promise<void>;
      };

      class IndexedDBStorage implements StorageLike {
        private db: unknown;
        private store: Record<string, string> = {};
        private initialized = false;
        async init() {
          // load the idb module lazily so we don't import it at package init
          const idb = await import('idb').catch(() => null);
          if (!idb) return;
          const { openDB } = idb;
          this.db = await openDB('better-cloudflare', 1, {
            upgrade(db: { createObjectStore: (name: string) => void }) {
              db.createObjectStore('kv');
            },
          });
          try {
            // @ts-expect-error - idb runtime methods accessed via dynamic import
            const keys = await (this.db as IDBRuntime).getAllKeys?.('kv');
            for (const k of keys) {
              try {
                // @ts-expect-error runtime access
                const v = await (this.db as IDBRuntime).get?.('kv', k);
                this.store[k] = String(v);
              } catch {
                // ignore - best-effort cache population
              }
            }
          } catch {
            // ignore cache population failures
          }
          this.initialized = true;
        }
        getItem(key: string) {
          return Object.prototype.hasOwnProperty.call(this.store, key)
            ? this.store[key]
            : null;
        }
        setItem(key: string, value: string) {
          this.store[key] = String(value);
          if (this.initialized) {
            // @ts-expect-error runtime call to idb. We don't block on errors.
            (this.db as IDBRuntime).put?.('kv', value, key).catch(() => {});
          }
        }
        removeItem(key: string) {
          delete this.store[key];
          if (this.initialized) {
            // @ts-expect-error runtime call
            (this.db as IDBRuntime).delete?.('kv', key).catch(() => {});
          }
        }
      }

      const IDS = new IndexedDBStorage();
      // Note: not awaiting init here since module may run server side; try to init
      try { IDS.init(); } catch { /* ignore */ }
      // attach a helper to detect whether we've selected an IndexedDB backend
      // mark selection explicitly on the instance so callers can tell which
      // backend was chosen without unsafe casts
      (IDS as IndexedDBStorage & { __selected?: string }).__selected = 'indexeddb';
      return IDS as StorageLike;
    }
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return (globalThis as { localStorage: StorageLike }).localStorage;
    }
  } catch {
    // Ignore access errors and fall back to memory storage
  }
  return new MemoryStorage();
}

/**
 * Detect which storage backend is in use: 'indexeddb', 'localstorage', or 'memory'
 */
/**
 * Return a string representing the selected storage backend: 'indexeddb',
 * 'localstorage' or 'memory'. Useful for informing the user or changing
 * behavior depending on the environment.
 */
export function storageBackend(): 'indexeddb' | 'localstorage' | 'memory' {
  try {
    if (typeof indexedDB !== 'undefined') return 'indexeddb';
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) return 'localstorage';
  } catch {
    // ignore
  }
  return 'memory';
}
