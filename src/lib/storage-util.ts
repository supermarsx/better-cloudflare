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
export function getStorage(storage?: StorageLike): StorageLike {
  if (storage) return storage;
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return (globalThis as { localStorage: StorageLike }).localStorage;
    }
  } catch {
    // Ignore access errors and fall back to memory storage
  }
  return new MemoryStorage();
}
