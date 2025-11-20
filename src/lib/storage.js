/**
 * Client-side storage manager used for storing encrypted API keys and
 * session metadata. This provides convenience methods to add, remove,
 * update, and export/import encrypted data.
 */
import { ENCRYPTION_ALGORITHMS, } from '../types/dns';
import { CryptoManager } from './crypto';
import { getStorage } from './storage-util';
import { generateUUID } from './utils';
const STORAGE_KEY = 'cloudflare-dns-manager';
/**
 * Type guard to assert a value conforms to the StorageData interface.
 * Useful when parsing JSON from storage and verifying shape before
 * assigning into the in-memory representation.
 */
export function isStorageData(value) {
    /**
     * @param value - value to validate against the StorageData shape
     * @returns true when the value conforms to StorageData, false otherwise
     */
    if (!value || typeof value !== 'object')
        return false;
    const obj = value;
    if (!Array.isArray(obj.apiKeys))
        return false;
    if (obj.currentSession !== undefined &&
        typeof obj.currentSession !== 'string') {
        return false;
    }
    if (obj.lastZone !== undefined && typeof obj.lastZone !== 'string') {
        return false;
    }
    return obj.apiKeys.every(k => {
        if (!k || typeof k !== 'object')
            return false;
        const key = k;
        return (typeof key.id === 'string' &&
            typeof key.label === 'string' &&
            typeof key.encryptedKey === 'string' &&
            typeof key.salt === 'string' &&
            typeof key.iv === 'string' &&
            typeof key.iterations === 'number' &&
            typeof key.keyLength === 'number' &&
            typeof key.algorithm === 'string' &&
            ENCRYPTION_ALGORITHMS.includes(key.algorithm) &&
            typeof key.createdAt === 'string' &&
            (key.email === undefined || typeof key.email === 'string'));
    });
}
/**
 * Manage API keys persisted in storage. Keys are stored encrypted with a
 * password passphrase; the encryption metadata (salt, iv, algorithm)
 * is stored alongside encrypted blobs. This manager provides helpers to
 * add keys, retrieve decrypted keys, and manipulate the local session.
 */
export class StorageManager {
    data = { apiKeys: [] };
    storage;
    crypto;
    constructor(storage, crypto) {
        this.storage = getStorage(storage);
        this.crypto = crypto ?? new CryptoManager({}, this.storage);
        this.load();
    }
    /**
     * Load persisted storage data from the configured StorageLike instance.
     */
    load() {
        try {
            const stored = this.storage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (isStorageData(parsed)) {
                    this.data = parsed;
                }
                else {
                    this.data = { apiKeys: [] };
                    this.storage.removeItem(STORAGE_KEY);
                }
            }
        }
        catch (error) {
            console.error('Failed to load storage data:', error);
            // Remove corrupted data so subsequent loads start with a clean slate.
            this.storage.removeItem(STORAGE_KEY);
            this.data = { apiKeys: [] };
        }
    }
    /**
     * Persist the in-memory data to storage as JSON.
     */
    save() {
        try {
            this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data));
        }
        catch (error) {
            console.error('Failed to save storage data:', error);
        }
    }
    /**
     * Add a new API key: encrypts the provided apiKey using `password` and
     * stores the resulting metadata. Returns the locally generated id.
     *
     * @param label - a friendly label for the API key
     * @param apiKey - the raw API key/token to encrypt and store
     * @param password - passphrase used to encrypt the key
     * @param email - optional email (when using key+email auth)
     * @returns generated API key id
     */
    async addApiKey(label, apiKey, password, email) {
        const { encrypted, salt, iv } = await this.crypto.encrypt(apiKey, password);
        const config = this.crypto.getConfig();
        const keyData = {
            id: generateUUID(),
            label,
            encryptedKey: encrypted,
            salt,
            iv,
            iterations: config.iterations,
            keyLength: config.keyLength,
            algorithm: config.algorithm,
            createdAt: new Date().toISOString(),
            ...(email ? { email } : {}),
        };
        this.data.apiKeys.push(keyData);
        this.save();
        return keyData.id;
    }
    /**
     * Return a copy of all stored API keys (metadata only, encrypted key
     * content is still encrypted in the returned data).
     *
     * @returns copy of the ApiKey metadata array
     */
    getApiKeys() {
        return [...this.data.apiKeys];
    }
    /**
     * Attempt to decrypt an API key by id using `password`.
     *
     * If decryption fails (wrong password or id not found) this returns
     * `null` instead of throwing to simplify UI handling.
      *
      * @param id - the locally generated api key id
      * @param password - the password to decrypt the key with
      * @returns an object with `key` and optional `email` or null on failure
     */
    async getDecryptedApiKey(id, password) {
        const keyData = this.data.apiKeys.find(k => k.id === id);
        if (!keyData)
            return null;
        try {
            const cm = new CryptoManager({
                iterations: keyData.iterations,
                keyLength: keyData.keyLength,
                algorithm: keyData.algorithm,
            }, this.storage);
            const decrypted = await cm.decrypt(keyData.encryptedKey, keyData.salt, keyData.iv, password);
            return { key: decrypted, email: keyData.email };
        }
        catch {
            return null;
        }
    }
    /**
     * Update an API key record. Supports renaming, changing the associated
     * email, and rotating the stored password (re-encrypts the key using the
     * new password - `currentPassword` is required for rotation).
      *
      * @param id - api key id to update
      * @param updates - partial update object; supported fields: label, email,
      *  currentPassword, newPassword
     */
    async updateApiKey(id, updates) {
        const keyData = this.data.apiKeys.find(k => k.id === id);
        if (!keyData) {
            throw new Error('API key not found');
        }
        if (updates.label !== undefined) {
            keyData.label = updates.label;
        }
        if (updates.email !== undefined) {
            keyData.email = updates.email || undefined;
        }
        if (updates.newPassword) {
            if (!updates.currentPassword) {
                throw new Error('Current password required');
            }
            const cm = new CryptoManager({
                iterations: keyData.iterations,
                keyLength: keyData.keyLength,
                algorithm: keyData.algorithm,
            }, this.storage);
            const decrypted = await cm.decrypt(keyData.encryptedKey, keyData.salt, keyData.iv, updates.currentPassword);
            const { encrypted, salt, iv } = await this.crypto.encrypt(decrypted, updates.newPassword);
            const config = this.crypto.getConfig();
            keyData.encryptedKey = encrypted;
            keyData.salt = salt;
            keyData.iv = iv;
            keyData.iterations = config.iterations;
            keyData.keyLength = config.keyLength;
            keyData.algorithm = config.algorithm;
        }
        this.save();
    }
    /**
     * Remove an API key by id and clear the current session if it referenced
     * the removed key.
      *
      * @param id - id of the key to remove
     */
    removeApiKey(id) {
        this.data.apiKeys = this.data.apiKeys.filter(k => k.id !== id);
        if (this.data.currentSession === id) {
            this.data.currentSession = undefined;
        }
        this.save();
    }
    /**
     * Set the active session to the provided API key id.
     */
    setCurrentSession(id) {
        this.data.currentSession = id;
        this.save();
    }
    /**
     * Read the currently active session id.
     *
     * @returns the active session id or `undefined` when not set
     */
    getCurrentSession() {
        return this.data.currentSession;
    }
    /**
     * Clear the active session and last zone stored for the session.
     */
    clearSession() {
        this.data.currentSession = undefined;
        this.data.lastZone = undefined;
        this.save();
    }
    /**
     * Keep track of the last selected zone for UX convenience.
     */
    setLastZone(zoneId) {
        this.data.lastZone = zoneId;
        this.save();
    }
    /**
     * Get the last selected zone id if present.
     *
     * @returns the last selected zone id or `undefined` when not set
     */
    getLastZone() {
        return this.data.lastZone;
    }
    /**
     * Export the storage contents as a JSON string including the current
     * encryption configuration.
     */
    exportData() {
        /**
         * @returns JSON string representation of the storage payload including encryption metadata
         */
        return JSON.stringify({ ...this.data, encryption: this.crypto.getConfig() }, null, 2);
    }
    /**
     * Import previously exported JSON data into storage after validating
     * the expected shape. This will replace the in-memory storage contents
     * and persist them.
     *
     * @param jsonData - exported JSON string produced by `exportData()`
     */
    importData(jsonData) {
        let imported;
        try {
            imported = JSON.parse(jsonData);
        }
        catch {
            throw new Error('Failed to import data: Invalid JSON');
        }
        if (!isStorageData(imported)) {
            throw new Error('Invalid data format');
        }
        this.data = imported;
        this.save();
    }
}
/**
 * Shared singleton storage manager instance used by the UI to persist API
 * keys and session metadata. Tests may create their own manager instance.
 */
export const storageManager = new StorageManager();
