/**
 * Crypto utilities and manager used to encrypt/decrypt API keys stored in
 * local storage. It wraps Web Crypto APIs to derive keys and perform
 * encryption with configured algorithms and parameters.
 */
import {
  ENCRYPTION_ALGORITHMS,
  type EncryptionConfig,
  type EncryptionAlgorithm,
} from '../types/dns';
import { getStorage, type StorageLike } from './storage-util';

const CONFIG_STORAGE_KEY = 'encryption-settings';

const DEFAULT_CONFIG: EncryptionConfig = {
  iterations: 100000,
  keyLength: 256,
  algorithm: 'AES-GCM'
};

/**
 * Validate whether a string is a supported encryption algorithm.
 *
 * @param alg - algorithm name to validate
 * @returns true if algorithm is supported, false otherwise
 */
function isValidAlgorithm(alg: string): alg is EncryptionAlgorithm {
  return ENCRYPTION_ALGORITHMS.includes(alg as EncryptionAlgorithm);
}

/**
 * Manager for encryption and decryption operations. The manager stores a
 * configuration (iterations, key length, algorithm) and persists it in
 * storage. The default algorithm is AES-GCM and the default PBKDF2
 * iterations are 100000.
 */
export class CryptoManager {
  private config: EncryptionConfig;
  private storage: StorageLike;

  constructor(
    config: Partial<EncryptionConfig> = {},
    storage?: StorageLike,
  ) {
    this.storage = getStorage(storage);
    const stored = this.loadFromStorage();
    this.config = { ...DEFAULT_CONFIG, ...stored, ...config };
    if (!isValidAlgorithm(this.config.algorithm)) {
      this.config.algorithm = DEFAULT_CONFIG.algorithm;
    }
  }

  /**
   * Load stored encryption configuration from storage. Returns a partial
   * config object that is merged into the default configuration.
   *
   * @returns partial EncryptionConfig read from storage, or empty object
   */
  private loadFromStorage(): Partial<EncryptionConfig> {
    try {
      const stored = this.storage.getItem(CONFIG_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      console.error('Failed to load encryption config:', error);
      return {};
    }
  }

  /**
   * Persist the active configuration into storage as JSON.
   */
  private saveToStorage(): void {
    try {
      this.storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config));
    } catch (error) {
      console.error('Failed to save encryption config:', error);
    }
  }

  /**
   * Reload configuration from storage and replace the in-memory config.
   */
  reloadConfig(): void {
    const stored = this.loadFromStorage();
    this.config = { ...DEFAULT_CONFIG, ...stored };
    if (!isValidAlgorithm(this.config.algorithm)) {
      this.config.algorithm = DEFAULT_CONFIG.algorithm;
    }
  }

  /**
   * Generate a random salt with 16 bytes.
   *
   * @returns a Uint8Array containing the salt
   */
  generateSalt(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(16));
  }

  /**
   * Generate an initialization vector (IV) suitable for AES-GCM.
   *
   * @returns a 12-byte Uint8Array iv
   */
  generateIV(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(12));
  }

  /**
   * Derive a WebCrypto `CryptoKey` from a raw password using PBKDF2.
   *
   * @param password - the passphrase to derive the key from
   * @param salt - a salt value to use with PBKDF2
   * @returns a derived CryptoKey suitable for encrypt/decrypt
   */
  async deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: this.config.iterations,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: this.config.algorithm, length: this.config.keyLength },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt a string with a password, returning a base64 encoded
   * ciphertext alongside salt and IV values used for the operation.
   *
   * @param data - the plain-text to encrypt
   * @param password - the password/passphrase to derive keys from
   * @returns an object containing base64-encoded `encrypted`, `salt`, and `iv`
   */
  async encrypt(data: string, password: string): Promise<{
    encrypted: string;
    salt: string;
    iv: string;
  }> {
    const encoder = new TextEncoder();
    const salt = this.generateSalt();
    const iv = this.generateIV();
    const key = await this.deriveKey(password, salt);

    const encrypted = await crypto.subtle.encrypt(
      { name: this.config.algorithm, iv: iv },
      key,
      encoder.encode(data)
    );

    return {
      encrypted: this.arrayBufferToBase64(encrypted),
      salt: this.arrayBufferToBase64(salt),
      iv: this.arrayBufferToBase64(iv)
    };
  }

  /**
   * Decrypt previously encrypted data with the associated password,
   * salt and iv values.
   *
   * @param encryptedData - base64 ciphertext
   * @param salt - base64-encoded salt used during encryption
   * @param iv - base64-encoded iv used during encryption
   * @param password - password to derive the decryption key
   * @returns the decrypted plain-text string
   */
  async decrypt(encryptedData: string, salt: string, iv: string, password: string): Promise<string> {
    const key = await this.deriveKey(password, this.base64ToArrayBuffer(salt));
    
    const decrypted = await crypto.subtle.decrypt(
      { name: this.config.algorithm, iv: this.base64ToArrayBuffer(iv) },
      key,
      this.base64ToArrayBuffer(encryptedData)
    );

    return new TextDecoder().decode(decrypted);
  }

  /**
   * Convert an ArrayBuffer to a base64 string.
   *
   * @param buffer - an ArrayBuffer
   * @returns base64-encoded string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert a base64 string back into a Uint8Array.
   *
   * @param base64 - base64-encoded data
   * @returns a Uint8Array containing the decoded bytes
   */
  private base64ToArrayBuffer(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Return a copy of the current encryption configuration.
   *
   * @returns encryption configuration object
   */
  getConfig(): EncryptionConfig {
    return { ...this.config };
  }

  /**
   * Update the encryption configuration and persist it to storage.
   *
   * @param newConfig - partial configuration object to merge with current
   * @throws if an invalid algorithm is supplied
   */
  updateConfig(newConfig: Partial<EncryptionConfig>): void {
    if (newConfig.algorithm && !isValidAlgorithm(newConfig.algorithm)) {
      throw new Error('Invalid algorithm');
    }
    this.config = { ...this.config, ...newConfig };
    this.saveToStorage();
  }
}
export const cryptoManager = new CryptoManager();
