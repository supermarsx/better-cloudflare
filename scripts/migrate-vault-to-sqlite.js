#!/usr/bin/env node
/*
 * Migrate existing passkeys from vault to SQLite DB.
 */
import { vaultManager } from '../src/server/vault.js';
import Database from 'better-sqlite3';
import path from 'path';

const dbPath = process.argv[2] ?? path.resolve(process.cwd(), 'data', 'credentials.db');
const db = new Database(dbPath);
db.prepare(`CREATE TABLE IF NOT EXISTS credentials (
  id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT,
  counter INTEGER DEFAULT 0,
  created_at TEXT,
  label TEXT,
  PRIMARY KEY(id, credential_id)
)`).run();

function insert(id, cred) {
  db.prepare('INSERT OR REPLACE INTO credentials (id, credential_id, public_key, counter, created_at, label) VALUES (?, ?, ?, ?, ?, ?)').run(id, cred.credentialID || cred.id, cred.credentialPublicKey || cred.publicKey, cred.counter ?? 0, cred.createdAt ?? new Date().toISOString(), cred.label ?? null);
}

(async () => {
  // Warning: this uses the vault API, which may be keytar or memory.
  // Iterate all ids - for vault we don't have an index, so accept `ids` as argv
  const ids = process.argv.slice(3);
  if (ids.length === 0) {
    console.error('usage: migrate-vault-to-sqlite.js <dbPath?> <id> <id>...');
    process.exit(1);
  }
  for (const id of ids) {
    const s = await vaultManager.getSecret(`passkey:${id}`);
    if (!s) continue;
    try {
      const creds = JSON.parse(s);
      for (const c of creds) insert(id, c);
      console.log(`Migrated ${creds.length} credentials for ${id}`);
      // Optionally clear the vault: vaultManager.deleteSecret(`passkey:${id}`)
    } catch (e) {
      console.error('Invalid creds for', id, e);
    }
  }
  process.exit(0);
})();
