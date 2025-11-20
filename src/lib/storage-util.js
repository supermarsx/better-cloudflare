/**
 * In-memory storage fallback for environments without `localStorage` or
 * during tests. Implements the same `StorageLike` API.
 */
class MemoryStorage {
    store = {};
    getItem(key) {
        return Object.prototype.hasOwnProperty.call(this.store, key)
            ? this.store[key]
            : null;
    }
    setItem(key, value) {
        this.store[key] = String(value);
    }
    removeItem(key) {
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
export function getStorage(storage) {
    /**
     * Select the storage to use.
     *
     * @param storage - optional custom StorageLike
     * @returns the chosen StorageLike implementation
     */
    if (storage)
        return storage;
    try {
        if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
            return globalThis.localStorage;
        }
    }
    catch {
        // Ignore access errors and fall back to memory storage
    }
    return new MemoryStorage();
}
