#!/usr/bin/env tsx
/*
 * Migrate existing passkeys from vault to SQLite DB.
 */
import { vaultManager } from '../src/server/vault';
import path from 'path';
import openSqlite from '../src/lib/sqlite-driver';

let args = process.argv.slice(2);
let dbPath = path.resolve(process.cwd(), 'data', 'credentials.db');
if (args.length && (args[0].includes('/') || args[0].includes('\\') || args[0].endsWith('.db'))) {
  dbPath = args[0];
  args = args.slice(1);
}
const db = openSqlite(dbPath);

async function ensureSchema() {
  await db.run(`CREATE TABLE IF NOT EXISTS credentials (
    id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    public_key TEXT,
    counter INTEGER DEFAULT 0,
    created_at TEXT,
    label TEXT,
    PRIMARY KEY(id, credential_id)
  )`);
}

interface StoredCredential {
  credentialID?: string;
  id?: string;
  credentialPublicKey?: string;
  publicKey?: string;
  counter?: number;
  createdAt?: string;
  label?: string | null;
}

function insert(id: string, cred: StoredCredential) {
  return db.run('INSERT OR REPLACE INTO credentials (id, credential_id, public_key, counter, created_at, label) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    cred.credentialID || cred.id,
    cred.credentialPublicKey || cred.publicKey,
    cred.counter ?? 0,
    cred.createdAt ?? new Date().toISOString(),
    cred.label ?? null
  ]);
}

(async () => {
  await ensureSchema();
  // Warning: this uses the vault API, which may be keytar or memory.
  // Iterate all ids - for vault we don't have an index, so accept `ids` as argv
  const ids = args;
  if (ids.length === 0) {
    console.error('usage: migrate-vault-to-sqlite.ts <id> <id>... (dbPath optional)');
    process.exit(1);
  }
  // if first arg looks like a path and exists as file, use it
  const maybePath = ids[0];
  if (maybePath.includes('/') || maybePath.includes('\\')) {
    // treat as db path
    // shift
  }
  for (const id of ids) {
    const s = await vaultManager.getSecret(`passkey:${id}`);
    if (!s) continue;
    try {
      const creds = JSON.parse(s);
      for (const c of creds) await insert(id, c);
      console.log(`Migrated ${creds.length} credentials for ${id}`);
      // Optionally clear the vault: vaultManager.deleteSecret(`passkey:${id}`)
    } catch (e) {
      console.error('Invalid creds for', id, e);
    }
  }
  process.exit(0);
})();
