import type { EncryptionConfig } from '@/types/dns';
import { getStorage, type StorageLike } from './storage-util';

const CONFIG_STORAGE_KEY = 'encryption-settings';

const DEFAULT_CONFIG: EncryptionConfig = {
  iterations: 100000,
  keyLength: 256,
  algorithm: 'AES-GCM'
};

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
  }

  private loadFromStorage(): Partial<EncryptionConfig> {
    try {
      const stored = this.storage.getItem(CONFIG_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      console.error('Failed to load encryption config:', error);
      return {};
    }
  }

  private saveToStorage(): void {
    try {
      this.storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config));
    } catch (error) {
      console.error('Failed to save encryption config:', error);
    }
  }

  reloadConfig(): void {
    const stored = this.loadFromStorage();
    this.config = { ...DEFAULT_CONFIG, ...stored };
  }

  async generateSalt(): Promise<Uint8Array> {
    return crypto.getRandomValues(new Uint8Array(16));
  }

  async generateIV(): Promise<Uint8Array> {
    return crypto.getRandomValues(new Uint8Array(12));
  }

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

  async encrypt(data: string, password: string): Promise<{
    encrypted: string;
    salt: string;
    iv: string;
  }> {
    const encoder = new TextEncoder();
    const salt = await this.generateSalt();
    const iv = await this.generateIV();
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

  async decrypt(encryptedData: string, salt: string, iv: string, password: string): Promise<string> {
    const key = await this.deriveKey(password, this.base64ToArrayBuffer(salt));
    
    const decrypted = await crypto.subtle.decrypt(
      { name: this.config.algorithm, iv: this.base64ToArrayBuffer(iv) },
      key,
      this.base64ToArrayBuffer(encryptedData)
    );

    return new TextDecoder().decode(decrypted);
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  getConfig(): EncryptionConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<EncryptionConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.saveToStorage();
  }
}
export const cryptoManager = new CryptoManager();
