import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'path';
import fs from 'fs';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { openSqlite } from '../src/lib/sqlite-driver.ts';
import { createRequire } from 'module';
const requireCJS = createRequire(import.meta.url);
  const fakeSqlite3 = {
    verbose() { return fakeSqlite3; },
    Database: function(this: any, file?: string) {
      void file;
      const dbState = { credentials: [], audit_log: [], lastID: 0 } as any;
      this.run = (sql: string, params?: any[] | any, cb?: any) => {
        const s = String(sql).trim().toUpperCase();
        const p = Array.isArray(params) ? params : typeof params !== 'function' ? [params] : [];
        // CREATE TABLE -> no-op
        if (s.startsWith('CREATE TABLE')) {
          if (cb) cb.call({ lastID: 0, changes: 0 }, null);
          return;
        }
        // robust detection for INSERT INTO CREDENTIALS (including OR REPLACE and quoting)
        if (s.includes('INSERT') && s.includes('INTO') && s.includes('CREDENTIALS')) {
          // params: [id, credential_id, public_key, counter, created_at, label]
          const [id, cid, pk, counter, createdAt, label] = p;
          dbState.credentials.push({ id, credential_id: cid, credentialPublicKey: pk, counter, createdAt, label });
          dbState.lastID += 1;
          if (cb) cb.call({ lastID: dbState.lastID, changes: 1 }, null);
          return;
        }
        if (/DELETE\s+FROM\s+CREDENTIALS/i.test(sql)) {
          const [id, cid] = p;
          const before = dbState.credentials.length;
          dbState.credentials = dbState.credentials.filter((r: any) => !(r.id === id && r.credential_id === cid));
          dbState.lastID += 1;
          if (cb) cb.call({ lastID: dbState.lastID, changes: before - dbState.credentials.length }, null);
          return;
        }
        if (s.startsWith('INSERT INTO AUDIT_LOG')) {
          const [actor, operation, resource, details, timestamp] = p;
          dbState.audit_log.unshift({ id: ++dbState.lastID, actor, operation, resource, details, timestamp });
          if (cb) cb.call({ lastID: dbState.lastID, changes: 1 }, null);
          return;
        }
        // generic INSERT into arbitrary tables (e.g. t)
        if (s.startsWith('INSERT INTO') && !s.includes('CREDENTIALS') && !s.includes('AUDIT_LOG')) {
          // naive parse: INSERT INTO table(columns...) VALUES(...)
          const m = sql.match(/INSERT INTO\s+([\w.]+)\s*\(([^)]+)\)/i);
          const tbl = m ? m[1] : 'unknown';
          const cols = m ? m[2].split(',').map((c: any) => c.trim().replace(/["'`]/g, '')) : [];
          dbState.tables = dbState.tables ?? {};
          dbState.tables[tbl] = dbState.tables[tbl] ?? [];
          const obj: any = { id: ++dbState.lastID };
          for (let i = 0; i < cols.length; i++) obj[cols[i]] = p[i];
          dbState.tables[tbl].push(obj);
          if (cb) cb.call({ lastID: dbState.lastID, changes: 1 }, null);
          return;
        }

        // default fallback
        if (cb) cb.call({ lastID: dbState.lastID, changes: 0 }, null);
      };
        this.get = (sql: string, params?: any[] | any, cb?: any) => {
          const s = String(sql).trim().toUpperCase();
          const p = Array.isArray(params) ? params : [params];
          // generic SELECT id... FROM table WHERE id = ?
          const m = sql.match(/FROM\s+([\w.]+)\s+WHERE\s+id\s*=\s*\?/i);
          if (m) {
            const tbl = m[1];
            const id = p[0];
            dbState.tables = dbState.tables ?? {};
            const row = (dbState.tables[tbl] || []).find((r: any) => r.id === id);
            if (cb) cb(null, row);
            return;
          }
          if (s.startsWith('SELECT CREDENTIAL_ID') || s.includes('FROM CREDENTIALS')) {
            const id = p[0];
            const row = id ? dbState.credentials.find((r: any) => r.id === id) : dbState.credentials[0];
            if (cb) cb(null, row);
            return;
          }
        if (s.startsWith('SELECT ID, ACTOR')) {
          const row = dbState.audit_log[0];
          if (cb) cb(null, row);
          return;
        }
        if (cb) cb(null, null);
      };
        this.all = (sql: string, params?: any[] | any, cb?: any) => {
          const s = String(sql).trim().toUpperCase();
          // generic SELECT id... FROM table WHERE id = ?
          const m = sql.match(/FROM\s+([\w.]+)\s+WHERE\s+id\s*=\s*\?/i);
          if (m) {
            const tbl = m[1];
            const id = Array.isArray(params) ? params[0] : params;
            dbState.tables = dbState.tables ?? {};
            let rows: any[] = [];
            if (String(tbl).toLowerCase() === 'credentials') {
              rows = (dbState.credentials || []).filter((r: any) => r.id === id);
            } else {
              rows = (dbState.tables[tbl] || []).filter((r: any) => r.id === id);
            }
            if (cb) cb(null, rows);
            return;
          }
          if (s.startsWith('SELECT CREDENTIAL_ID') || s.includes('FROM CREDENTIALS')) {
            const id = Array.isArray(params) && params.length ? params[0] : undefined;
            const rows = id ? dbState.credentials.filter((r: any) => r.id === id) : dbState.credentials;
            if (cb) cb(null, rows);
            return;
          }
        if (s.startsWith('SELECT ID, ACTOR, OPERATION') || s.includes('FROM AUDIT_LOG')) {
          if (cb) cb(null, dbState.audit_log);
          return;
        }
        if (cb) cb(null, []);
      };
      this.close = (cb: any) => cb?.(null);
    }
  } as any;
import { SqliteCredentialStore } from '../src/lib/credential-store.ts';

test('openSqlite falls back to sqlite3 when better-sqlite3 is not available', async () => {
  const tmp = path.resolve(process.cwd(), 'data', 'test-fallback.db');
  try { fs.unlinkSync(tmp); } catch { /* ignore cleanup errors */ }
  const requireFn = (name: string) => {
     if (name === 'better-sqlite3') throw new Error('not found');
     if (name === 'sqlite3') return fakeSqlite3; 
    return requireCJS(name);
  };
  const wrapper = openSqlite(tmp, requireFn as any);
  assert.equal(wrapper.type, 'sqlite3');
  await wrapper.run('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT)');
  await wrapper.run('INSERT INTO t(name) VALUES(?)', ['x']);
  const row = await wrapper.get('SELECT id, name FROM t WHERE id = ?', [1]);
  assert.equal(row.name, 'x');
  if (wrapper.close) await wrapper.close();
  try { fs.unlinkSync(tmp); } catch { /* ignore cleanup errors */ }
});

test('openSqlite throws when no sqlite driver available', async () => {
  const requireFn = () => { throw new Error('missing'); };
  try {
    openSqlite(undefined, requireFn as any);
    assert.fail('openSqlite should throw when both drivers unavailable');
  } catch (err: any) {
    assert.ok(err.message.includes('No sqlite driver available'));
  }
});

test('SqliteCredentialStore works with injected sqlite3 wrapper', async () => {
  const tmp = path.resolve(process.cwd(), 'data', 'test-credstore.db');
  try { fs.unlinkSync(tmp); } catch { /* ignore cleanup errors */ }
  const requireFn = (name: string) => {
     if (name === 'better-sqlite3') throw new Error('not found');
     if (name === 'sqlite3') return fakeSqlite3;
    return createRequire(import.meta.url)(name);
  };
  const wrapper = openSqlite(tmp, requireFn as any);
  const store = new SqliteCredentialStore(tmp, wrapper as any);
  await store.initPromise;
  const id = 'u-test-fb';
  await store.addCredential(id, { credentialID: 'c1', credentialPublicKey: 'pk1' });
  const list = await store.getCredentials(id);
  // debug: also check raw DB wrapper for inserted rows
  const raw = await (wrapper as any).all('SELECT * FROM credentials');
  console.debug('raw rows', raw);
  assert.equal(list.length, 1);
  await store.writeAudit({ actor: 'test', operation: 'test-op', resource: 'r1', details: {} });
  const audits = await store.getAuditEntries();
  assert.ok(Array.isArray(audits) && audits.length >= 1);
  await store.deleteCredential(id, 'c1');
  const after = await store.getCredentials(id);
  assert.equal(after.length, 0);
  if ((wrapper as any).close) await (wrapper as any).close();
  try { fs.unlinkSync(tmp); } catch { /* ignore cleanup errors */ }
});
