import type { ApiKey } from '@/types/dns';
import { cryptoManager, CryptoManager } from './crypto';

const STORAGE_KEY = 'cloudflare-dns-manager';

interface StorageData {
  apiKeys: ApiKey[];
  currentSession?: string;
}

export class StorageManager {
  private data: StorageData = { apiKeys: [] };

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        this.data = JSON.parse(stored);
      }
    } catch (error) {
      console.error('Failed to load storage data:', error);
      this.data = { apiKeys: [] };
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (error) {
      console.error('Failed to save storage data:', error);
    }
  }

  async addApiKey(label: string, apiKey: string, password: string): Promise<string> {
    const { encrypted, salt, iv } = await cryptoManager.encrypt(apiKey, password);
    const config = cryptoManager.getConfig();

    const keyData: ApiKey = {
      id: crypto.randomUUID(),
      label,
      encryptedKey: encrypted,
      salt,
      iv,
      iterations: config.iterations,
      keyLength: config.keyLength,
      algorithm: config.algorithm,
      createdAt: new Date().toISOString(),
    };

    this.data.apiKeys.push(keyData);
    this.save();
    
    return keyData.id;
  }

  getApiKeys(): ApiKey[] {
    return [...this.data.apiKeys];
  }

  async getDecryptedApiKey(id: string, password: string): Promise<string | null> {
    const keyData = this.data.apiKeys.find(k => k.id === id);
    if (!keyData) return null;

    try {
      const cm = new CryptoManager({
        iterations: keyData.iterations,
        keyLength: keyData.keyLength,
        algorithm: keyData.algorithm,
      });
      return await cm.decrypt(
        keyData.encryptedKey,
        keyData.salt,
        keyData.iv,
        password
      );
    } catch {
      return null;
    }
  }

  removeApiKey(id: string): void {
    this.data.apiKeys = this.data.apiKeys.filter(k => k.id !== id);
    if (this.data.currentSession === id) {
      this.data.currentSession = undefined;
    }
    this.save();
  }

  setCurrentSession(id: string): void {
    this.data.currentSession = id;
    this.save();
  }

  getCurrentSession(): string | undefined {
    return this.data.currentSession;
  }

  clearSession(): void {
    this.data.currentSession = undefined;
    this.save();
  }

  exportData(): string {
    return JSON.stringify(this.data, null, 2);
  }

  importData(jsonData: string): void {
    try {
      const imported = JSON.parse(jsonData);
      if (imported.apiKeys && Array.isArray(imported.apiKeys)) {
        this.data = imported;
        this.save();
      } else {
        throw new Error('Invalid data format');
      }
    } catch (error) {
      throw new Error('Failed to import data: ' + (error as Error).message);
    }
  }
}
export const storageManager = new StorageManager();
