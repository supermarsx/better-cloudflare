import { promises as fs, mkdirSync } from "fs";
import path from "path";
import { vaultManager } from "./vault-manager";
import { getEnv } from "./env";
import openSqlite from "./sqlite-driver";
import type { SqliteWrapper } from "./sqlite-driver";
import type { AuditEntry } from "./audit";

export type PasskeyCredential = {
  credentialID: string;
  id?: string;
  credentialPublicKey?: string;
  publicKey?: string;
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
    const base =
      file ?? path.resolve(process.cwd(), "data", "credentials.json");
    this.filePath = base;
  }
  private async load(): Promise<Record<string, PasskeyCredential[]>> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }
  private async save(obj: Record<string, PasskeyCredential[]>) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(obj, null, 2), {
      mode: 0o600,
    });
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
    obj[id] = arr.filter((c) => (c.credentialID ?? c.id) !== cid);
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
    const arrTyped = arr as Array<{ credentialID?: string; id?: string }>;
    const filtered = arrTyped.filter((c) => (c.credentialID ?? c.id) !== cid);
    await vaultManager.setSecret(`passkey:${id}`, JSON.stringify(filtered));
  }
}
/** Very small in-memory credential store used for testing and lightweight runs */
class MemoryCredentialStore implements CredentialStore {
  private map: Map<string, PasskeyCredential[]> = new Map();
  async getCredentials(id: string) {
    return (this.map.get(id) ?? []).slice();
  }
  async addCredential(id: string, cred: PasskeyCredential) {
    const arr = this.map.get(id) ?? [];
    arr.push({ ...cred, createdAt: new Date().toISOString() });
    this.map.set(id, arr);
  }
  async deleteCredential(id: string, cid: string) {
    const arr = this.map.get(id) ?? [];
    this.map.set(
      id,
      arr.filter((c) => (c.credentialID ?? c.id) !== cid),
    );
  }
}
export class SqliteCredentialStore implements CredentialStore {
  public db!: SqliteWrapper;
  private initPromise: Promise<void> | null = null;
  constructor(dbFile?: string, dbWrapper?: SqliteWrapper) {
    const f = dbFile ?? path.resolve(process.cwd(), "data", "credentials.db");
    // Ensure directory exists before opening the database
    try {
      mkdirSync(path.dirname(f), { recursive: true });
    } catch {
      // ignore
    }
    this.db = dbWrapper ?? openSqlite(f);
    // Initialize schema (use promise API of wrapper)
    this.initPromise = (async () => {
      await this.db.run(`CREATE TABLE IF NOT EXISTS credentials (
        id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        public_key TEXT,
        counter INTEGER DEFAULT 0,
        created_at TEXT,
        label TEXT,
        PRIMARY KEY(id, credential_id)
        )`);
      await this.db.run(`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT,
        operation TEXT,
        resource TEXT,
        details TEXT,
        timestamp TEXT
        )`);
    })();
  }
  async getCredentials(id: string): Promise<PasskeyCredential[]> {
    await this.initPromise;
    const rows = await this.db.all(
      "SELECT credential_id, public_key as credentialPublicKey, counter, created_at as createdAt, label FROM credentials WHERE id = ?",
      [id],
    );
    const typed = rows as Array<{
      credential_id: string;
      credentialPublicKey?: string;
      counter?: number;
      createdAt?: string;
      label?: string;
    }>;
    return typed.map((r) => ({
      credentialID: r.credential_id,
      id: r.credential_id,
      credentialPublicKey: r.credentialPublicKey,
      publicKey: r.credentialPublicKey,
      counter: r.counter,
      createdAt: r.createdAt,
      label: r.label,
    }));
  }
  async addCredential(id: string, cred: PasskeyCredential) {
    await this.initPromise;
    await this.db.run(
      "INSERT OR REPLACE INTO credentials(id, credential_id, public_key, counter, created_at, label) VALUES(?, ?, ?, ?, ?, ?)",
      [
        id,
        cred.credentialID,
        cred.credentialPublicKey,
        cred.counter ?? 0,
        cred.createdAt ?? new Date().toISOString(),
        cred.label ?? null,
      ],
    );
  }
  async deleteCredential(id: string, cid: string) {
    await this.initPromise;
    await this.db.run(
      "DELETE FROM credentials WHERE id = ? AND credential_id = ?",
      [id, cid],
    );
  }
  // Simple audit log insertion (we'll use for audit write from audit module)
  async writeAudit(a: AuditEntry) {
    await this.initPromise;
    await this.db.run(
      "INSERT INTO audit_log(actor, operation, resource, details, timestamp) VALUES(?, ?, ?, ?, ?)",
      [
        a.actor ?? null,
        a.operation,
        a.resource ?? null,
        JSON.stringify(a.details ?? {}),
        a.timestamp ?? new Date().toISOString(),
      ],
    );
  }
  async getAuditEntries() {
    await this.initPromise;
    return await this.db.all(
      "SELECT id, actor, operation, resource, details, timestamp FROM audit_log ORDER BY id DESC",
    );
  }
}

export const createCredentialStore = () => {
  const storeType = getEnv(
    "CREDENTIAL_STORE",
    "VITE_CREDENTIAL_STORE",
    "vault",
  );
  if (storeType === "file") return new FileCredentialStore();
  if (storeType === "memory") return new MemoryCredentialStore();
  if (storeType === "sqlite") {
    try {
      return new SqliteCredentialStore();
    } catch (err) {
      // If opening the sqlite driver fails (native dependency missing),
      // try creating a sqlite-backed store that uses the in-memory wrapper
      // implemented in openSqlite (so it behaves like a sqlite DB to the
      // higher-level code). This keeps APIs (db.run/get/all) available.
      console.warn(
        "Sqlite not available; attempting in-memory sqlite fallback:",
        (err as any)?.message ?? err,
      );
      try {
        const inMem = openSqlite(undefined);
        return new SqliteCredentialStore(undefined, inMem);
      } catch {
        console.warn(
          "In-memory sqlite fallback failed, using memory-only store",
        );
        return new MemoryCredentialStore();
      }
    }
  }
  // defaults to vault
  return new VaultCredentialStore();
};

export default createCredentialStore;
