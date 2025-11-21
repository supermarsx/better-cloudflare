import { promises as fs, mkdirSync } from 'fs';
import path from 'path';
import { vaultManager } from '../server/vault';
import { getEnv } from './env';
import Database from 'better-sqlite3';

export type PasskeyCredential = {
  credentialID: string;
  credentialPublicKey: string;
  counter?: number;
  createdAt?: string;
  label?: string;
};

export interface CredentialStore {
  getCredentials(id: string): Promise<PasskeyCredential[]>;
  addCredential(id: string, cred: PasskeyCredential): Promise<void>;
  deleteCredential(id: string, cid: string): Promise<void>;
}

/** File-based small credential store for demo/dev. Not recommended for prod. */
class FileCredentialStore implements CredentialStore {
  private filePath: string;
  constructor(file?: string) {
    const base = file ?? path.resolve(process.cwd(), 'data', 'credentials.json');
    this.filePath = base;
  }
  private async load(): Promise<Record<string, PasskeyCredential[]>> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }
  private async save(obj: Record<string, PasskeyCredential[]>) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(obj, null, 2), { mode: 0o600 });
  }
  async getCredentials(id: string) {
    const obj = await this.load();
    return obj[id] ?? [];
  }
  async addCredential(id: string, cred: PasskeyCredential) {
    const obj = await this.load();
    obj[id] = obj[id] ?? [];
    obj[id].push({ ...cred, createdAt: new Date().toISOString() });
    await this.save(obj);
  }
  async deleteCredential(id: string, cid: string) {
    const obj = await this.load();
    const arr = obj[id] ?? [];
    obj[id] = arr.filter((c) => c.credentialID !== cid);
    await this.save(obj);
  }
}

class VaultCredentialStore implements CredentialStore {
  async getCredentials(id: string) {
    const stored = await vaultManager.getSecret(`passkey:${id}`);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  async addCredential(id: string, cred: PasskeyCredential) {
    const stored = await vaultManager.getSecret(`passkey:${id}`);
    const parsed = stored ? JSON.parse(stored) : [];
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    arr.push({ ...cred, createdAt: new Date().toISOString() });
    await vaultManager.setSecret(`passkey:${id}`, JSON.stringify(arr));
  }
  async deleteCredential(id: string, cid: string) {
    const stored = await vaultManager.getSecret(`passkey:${id}`);
    const parsed = stored ? JSON.parse(stored) : [];
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const filtered = arr.filter((c: any) => (c.credentialID ?? c.id) !== cid);
    await vaultManager.setSecret(`passkey:${id}`, JSON.stringify(filtered));
  }
}
  class SqliteCredentialStore implements CredentialStore {
    private db: Database.Database;
    constructor(dbFile?: string) {
      const f = dbFile ?? path.resolve(process.cwd(), 'data', 'credentials.db');
      // Ensure directory exists before opening the database
      try {
        mkdirSync(path.dirname(f), { recursive: true });
      } catch (e) {
        // ignore
      }
      this.db = new Database(f);
      // Initialize schema
      this.db.prepare(`CREATE TABLE IF NOT EXISTS credentials (
        id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        public_key TEXT,
        counter INTEGER DEFAULT 0,
        created_at TEXT,
        label TEXT,
        PRIMARY KEY(id, credential_id)
      )`).run();
      this.db.prepare(`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT,
        operation TEXT,
        resource TEXT,
        details TEXT,
        timestamp TEXT
      )`).run();
    }
    async getCredentials(id: string): Promise<PasskeyCredential[]> {
      const rows = this.db.prepare('SELECT credential_id, public_key as credentialPublicKey, counter, created_at as createdAt, label FROM credentials WHERE id = ?').all(id);
      return rows.map((r: any) => ({ credentialID: r.credential_id, credentialPublicKey: r.credentialPublicKey, counter: r.counter, createdAt: r.createdAt, label: r.label }));
    }
    async addCredential(id: string, cred: PasskeyCredential) {
      this.db.prepare('INSERT OR REPLACE INTO credentials(id, credential_id, public_key, counter, created_at, label) VALUES(?, ?, ?, ?, ?, ?)').run(id, cred.credentialID, cred.credentialPublicKey, cred.counter ?? 0, cred.createdAt ?? new Date().toISOString(), cred.label ?? null);
    }
    async deleteCredential(id: string, cid: string) {
      this.db.prepare('DELETE FROM credentials WHERE id = ? AND credential_id = ?').run(id, cid);
    }
    // Simple audit log insertion (we'll use for audit write from audit module)
    writeAudit(a: any) {
      this.db.prepare('INSERT INTO audit_log(actor, operation, resource, details, timestamp) VALUES(?, ?, ?, ?, ?)').run(a.actor ?? null, a.operation, a.resource ?? null, JSON.stringify(a.details ?? {}), a.timestamp ?? new Date().toISOString());
    }
    getAuditEntries() {
      return this.db.prepare('SELECT id, actor, operation, resource, details, timestamp FROM audit_log ORDER BY id DESC').all();
    }
  }

export const createCredentialStore = () => {
  const storeType = getEnv('CREDENTIAL_STORE', 'VITE_CREDENTIAL_STORE', 'vault');
  if (storeType === 'file') return new FileCredentialStore();
    if (storeType === 'sqlite') return new SqliteCredentialStore();
  // defaults to vault
  return new VaultCredentialStore();
};

export default createCredentialStore;
