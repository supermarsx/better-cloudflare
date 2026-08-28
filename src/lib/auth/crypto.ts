/**
 * Crypto utilities and manager used to encrypt/decrypt API keys stored in
 * local storage. It wraps Web Crypto APIs to derive keys and perform
 * encryption with configured algorithms and parameters.
 */
import {
  ACTIVE_ENCRYPTION_ALGORITHMS,
  AES_256_KEY_LENGTH_BITS,
  LEGACY_ENCRYPTION_ALGORITHMS,
  MAX_CRYPTO_BASE64_CHARS,
  MAX_CRYPTO_CIPHERTEXT_BYTES,
  MAX_CRYPTO_PASSWORD_BYTES,
  MAX_CRYPTO_PLAINTEXT_BYTES,
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  type EncryptionConfig,
  type EncryptionAlgorithm,
} from "../../types/dns";

import { getStorage, type StorageLike } from "../storage/storage-util";

const CONFIG_STORAGE_KEY = "encryption-settings";

const DEFAULT_CONFIG: EncryptionConfig = {
  iterations: MIN_PBKDF2_ITERATIONS,
  keyLength: AES_256_KEY_LENGTH_BITS,
  algorithm: "AES-GCM",
};

const ENVELOPE_PREFIX = "bc1:";
const ENVELOPE_AAD = new TextEncoder().encode(
  "better-cloudflare:crypto-envelope:v1",
);
const SALT_BYTES = 16;
const GCM_IV_BYTES = 12;
const CBC_IV_BYTES = 16;
const AUTH_TAG_BYTES = 16;

interface NodeCryptoModule {
  webcrypto?: typeof globalThis.crypto;
}

type NodeCryptoRequire = (moduleName: "crypto") => NodeCryptoModule | undefined;

interface CryptoRuntimeGlobal {
  crypto?: typeof globalThis.crypto;
  require?: NodeCryptoRequire;
}

function isKnownAlgorithm(value: unknown): value is EncryptionAlgorithm {
  const knownAlgorithms: readonly string[] = [
    ...ACTIVE_ENCRYPTION_ALGORITHMS,
    ...LEGACY_ENCRYPTION_ALGORITHMS,
  ];
  return typeof value === "string" && knownAlgorithms.includes(value);
}

function validateConfig(
  config: EncryptionConfig,
  activeWrite: boolean,
): EncryptionConfig {
  const minimum = activeWrite ? MIN_PBKDF2_ITERATIONS : 1;
  if (
    !Number.isSafeInteger(config.iterations) ||
    config.iterations < minimum ||
    config.iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error(
      `PBKDF2 iterations must be an integer between ${minimum} and ${MAX_PBKDF2_ITERATIONS}`,
    );
  }
  if (config.keyLength !== AES_256_KEY_LENGTH_BITS) {
    throw new Error(
      `AES-256 key length must be exactly ${AES_256_KEY_LENGTH_BITS} bits`,
    );
  }
  if (!isKnownAlgorithm(config.algorithm)) {
    throw new Error("Encryption algorithm is not supported");
  }
  if (
    activeWrite &&
    !(ACTIVE_ENCRYPTION_ALGORITHMS as readonly string[]).includes(
      config.algorithm,
    )
  ) {
    throw new Error(
      "AES-CBC is legacy decrypt-only; new writes require AES-GCM",
    );
  }
  return { ...config };
}

function encodeUtf8Bounded(
  value: string,
  maxBytes: number,
  field: string,
): Uint8Array<ArrayBuffer> {
  if (value.length > maxBytes) {
    throw new Error(`${field} exceeds the ${maxBytes}-byte limit`);
  }
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength > maxBytes) {
    encoded.fill(0);
    throw new Error(`${field} exceeds the ${maxBytes}-byte limit`);
  }
  return encoded;
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

  /**
   * Construct a CryptoManager using the provided partial `config` and an
   * optional storage backend. The manager will persist its configuration
   * into storage under `CONFIG_STORAGE_KEY`.
   *
   * @param config - partial configuration to override defaults
   * @param storage - optional `StorageLike` instance (defaults to global localStorage)
   */
  constructor(config: Partial<EncryptionConfig> = {}, storage?: StorageLike) {
    this.storage = getStorage(storage);
    const stored = this.loadFromStorage();
    this.config = validateConfig(
      { ...DEFAULT_CONFIG, ...stored, ...config },
      false,
    );
  }

  /**
   * Load stored encryption configuration from storage. Returns a partial
   * config object that is merged into the default configuration.
   *
   * @returns partial EncryptionConfig read from storage, or empty object
   */
  private loadFromStorage(): EncryptionConfig | undefined {
    try {
      const stored = this.storage.getItem(CONFIG_STORAGE_KEY);
      if (!stored) return undefined;
      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Stored encryption settings must be an object");
      }
      return validateConfig(
        {
          ...DEFAULT_CONFIG,
          ...(parsed as Partial<EncryptionConfig>),
        },
        true,
      );
    } catch (error) {
      // Corrupted or hostile settings are never used for cryptographic work.
      // A safe default keeps the application recoverable without weakening
      // encryption or applying an attacker-controlled expensive setting.
      console.error(
        "Stored encryption settings were rejected; using safe defaults:",
        error instanceof Error ? error.message : "invalid settings",
      );
      return undefined;
    }
  }

  /**
   * Persist the active configuration into storage as JSON.
   */
  private saveToStorage(config: EncryptionConfig): void {
    try {
      this.storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch {
      throw new Error("Encryption settings could not be persisted");
    }
  }

  /**
   * Reload configuration from storage and replace the in-memory config.
   */
  reloadConfig(): void {
    const stored = this.loadFromStorage();
    this.config = stored ? { ...stored } : { ...DEFAULT_CONFIG };
  }

  /**
   * Generate a random salt with 16 bytes.
   *
   * @returns a Uint8Array containing the salt
   */
  // Prefer the global Web Crypto API when available; otherwise fall back to
  // Node's built-in webcrypto (require('crypto').webcrypto) when running in
  // Node.js. If neither is available, throw a helpful error when crypto is
  // actually needed.
  private getWebCrypto(): typeof globalThis.crypto | undefined {
    const runtimeGlobal: CryptoRuntimeGlobal = globalThis;

    // Use the global Web Crypto API when available (browser / modern Node.js)
    if (runtimeGlobal.crypto) return runtimeGlobal.crypto;

    // Attempt to load Node.js built-in crypto.webcrypto without eval
    try {
      const maybeRequire =
        typeof runtimeGlobal.require === "function"
          ? runtimeGlobal.require
          : undefined;
      if (maybeRequire) {
        const nodeCrypto = maybeRequire("crypto");
        return nodeCrypto?.webcrypto;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  generateSalt(): Uint8Array<ArrayBuffer> {
    const webcrypto = this.getWebCrypto();
    if (!webcrypto?.getRandomValues)
      throw new Error("Web Crypto API not available");
    return webcrypto.getRandomValues(new Uint8Array(16));
  }

  /**
   * Generate an initialization vector (IV) suitable for AES-GCM.
   *
   * @returns a 12-byte Uint8Array iv
   */
  generateIV(): Uint8Array<ArrayBuffer> {
    const webcrypto = this.getWebCrypto();
    if (!webcrypto?.getRandomValues)
      throw new Error("Web Crypto API not available");
    return webcrypto.getRandomValues(new Uint8Array(12));
  }

  /**
   * Derive a WebCrypto `CryptoKey` from a raw password using PBKDF2.
   *
   * @param password - the passphrase to derive the key from
   * @param salt - a salt value to use with PBKDF2
   * @returns a derived CryptoKey suitable for encrypt/decrypt
   */
  async deriveKey(
    password: string,
    salt: Uint8Array<ArrayBuffer>,
  ): Promise<CryptoKey> {
    validateConfig(this.config, false);
    if (password.length === 0) {
      throw new Error("Password must not be empty");
    }
    if (salt.byteLength !== SALT_BYTES) {
      throw new Error(`PBKDF2 salt must be exactly ${SALT_BYTES} bytes`);
    }
    const webcrypto = this.getWebCrypto();
    if (!webcrypto?.subtle)
      throw new Error("Web Crypto Subtle API not available");

    const passwordBytes = encodeUtf8Bounded(
      password,
      MAX_CRYPTO_PASSWORD_BYTES,
      "Password",
    );
    let keyMaterial: CryptoKey;
    try {
      keyMaterial = await webcrypto.subtle.importKey(
        "raw",
        passwordBytes,
        "PBKDF2",
        false,
        ["deriveBits", "deriveKey"],
      );
    } finally {
      passwordBytes.fill(0);
    }

    return webcrypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: this.config.iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      {
        name: this.config.algorithm,
        length: AES_256_KEY_LENGTH_BITS,
      },
      false,
      ["encrypt", "decrypt"],
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
  async encrypt(
    data: string,
    password: string,
  ): Promise<{
    encrypted: string;
    salt: string;
    iv: string;
  }> {
    validateConfig(this.config, true);
    const plaintext = encodeUtf8Bounded(
      data,
      MAX_CRYPTO_PLAINTEXT_BYTES,
      "Plaintext",
    );
    const salt = this.generateSalt();
    const iv = this.generateIV();

    try {
      const key = await this.deriveKey(password, salt);
      const webcrypto = this.getWebCrypto();
      if (!webcrypto?.subtle)
        throw new Error("Web Crypto Subtle API not available");
      const encrypted = await webcrypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: ENVELOPE_AAD,
          tagLength: 128,
        },
        key,
        plaintext,
      );
      if (encrypted.byteLength > MAX_CRYPTO_CIPHERTEXT_BYTES) {
        throw new Error(
          `Ciphertext exceeds the ${MAX_CRYPTO_CIPHERTEXT_BYTES}-byte limit`,
        );
      }

      return {
        encrypted: `${ENVELOPE_PREFIX}${this.arrayBufferToBase64(encrypted)}`,
        salt: this.arrayBufferToBase64(salt),
        iv: this.arrayBufferToBase64(iv),
      };
    } finally {
      plaintext.fill(0);
    }
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
  async decrypt(
    encryptedData: string,
    salt: string,
    iv: string,
    password: string,
  ): Promise<string> {
    validateConfig(this.config, false);
    const versioned = encryptedData.startsWith(ENVELOPE_PREFIX);
    if (versioned && this.config.algorithm !== "AES-GCM") {
      throw new Error("Versioned ciphertext requires AES-GCM");
    }
    const encodedCiphertext = versioned
      ? encryptedData.slice(ENVELOPE_PREFIX.length)
      : encryptedData;
    const saltBytes = this.base64ToArrayBuffer(
      salt,
      "Salt",
      Math.ceil(SALT_BYTES / 3) * 4,
      SALT_BYTES,
    );
    const ivBytes = this.base64ToArrayBuffer(
      iv,
      "Initialization vector",
      Math.ceil(CBC_IV_BYTES / 3) * 4,
      this.config.algorithm === "AES-CBC" ? CBC_IV_BYTES : GCM_IV_BYTES,
    );
    const ciphertext = this.base64ToArrayBuffer(
      encodedCiphertext,
      "Ciphertext",
      MAX_CRYPTO_BASE64_CHARS,
    );
    if (
      ciphertext.byteLength < AUTH_TAG_BYTES ||
      ciphertext.byteLength > MAX_CRYPTO_CIPHERTEXT_BYTES
    ) {
      throw new Error("Ciphertext length is invalid");
    }
    if (
      this.config.algorithm === "AES-CBC" &&
      ciphertext.byteLength % CBC_IV_BYTES !== 0
    ) {
      throw new Error("Legacy AES-CBC ciphertext length is invalid");
    }

    try {
      const key = await this.deriveKey(password, saltBytes);
      const webcrypto = this.getWebCrypto();
      if (!webcrypto?.subtle)
        throw new Error("Web Crypto Subtle API not available");
      const algorithm: AesGcmParams | AesCbcParams =
        this.config.algorithm === "AES-GCM"
          ? {
              name: "AES-GCM",
              iv: ivBytes,
              ...(versioned
                ? { additionalData: ENVELOPE_AAD, tagLength: 128 }
                : {}),
            }
          : { name: "AES-CBC", iv: ivBytes };
      const decrypted = await webcrypto.subtle.decrypt(
        algorithm,
        key,
        ciphertext,
      );
      if (decrypted.byteLength > MAX_CRYPTO_PLAINTEXT_BYTES) {
        throw new Error(
          `Plaintext exceeds the ${MAX_CRYPTO_PLAINTEXT_BYTES}-byte limit`,
        );
      }
      const plaintext = new Uint8Array(decrypted);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      } finally {
        plaintext.fill(0);
      }
    } finally {
      saltBytes.fill(0);
      ivBytes.fill(0);
      ciphertext.fill(0);
    }
  }

  /**
   * Convert an ArrayBuffer to a base64 string.
   *
   * @param buffer - an ArrayBuffer
   * @returns base64-encoded string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer | ArrayBufferView): string {
    const bytes = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    let binary = "";
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
  private base64ToArrayBuffer(
    base64: string,
    field: string,
    maxChars: number,
    exactBytes?: number,
  ): Uint8Array<ArrayBuffer> {
    if (
      base64.length === 0 ||
      base64.length > maxChars ||
      base64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        base64,
      )
    ) {
      throw new Error(`${field} is not valid bounded base64`);
    }
    let binary: string;
    try {
      binary = atob(base64);
    } catch {
      throw new Error(`${field} is not valid base64`);
    }
    if (exactBytes !== undefined && binary.length !== exactBytes) {
      throw new Error(`${field} must decode to exactly ${exactBytes} bytes`);
    }
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
    const next = validateConfig({ ...this.config, ...newConfig }, true);
    this.saveToStorage(next);
    this.config = next;
  }
}
/**
 * A shared singleton instance of `CryptoManager` used by the app. Tests or
 * other consumers may create their own instance to customize configuration
 * or storage.
 */
export const cryptoManager = new CryptoManager();
