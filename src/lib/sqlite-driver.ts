import path from 'path';
import { createRequire } from 'module';
// promisify unused; intentionally omitted

type DriverType = 'better-sqlite3' | 'sqlite3';

export type SqliteWrapper = {
  type: DriverType;
  // our minimal promise-based API to run queries
  run(sql: string, params?: any[]): Promise<any>;
  all<T = any>(sql: string, params?: any[]): Promise<T[]>;
  get<T = any>(sql: string, params?: any[]): Promise<T | undefined>;
  // used by some callers to persist/inspect DB
  close?(): Promise<void>;
};

function mkSyncWrapper(db: any): SqliteWrapper {
  return {
    type: 'better-sqlite3',
    run(sql: string, params: any[] = []) {
      try {
        const res = db.prepare(sql).run(...params);
        return Promise.resolve(res);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    all(sql: string, params: any[] = []) {
      try {
        const rows = db.prepare(sql).all(...params);
        return Promise.resolve(rows);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    get(sql: string, params: any[] = []) {
      try {
        const row = db.prepare(sql).get(...params);
        return Promise.resolve(row);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    close() {
      try {
        db.close();
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    }
  };
}

function mkSqlite3Wrapper(db: any): SqliteWrapper {
  // sqlite3 callback API -> promisify
  const run = function <T = any>(sql: string, params: any[] = []): Promise<T> {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (this: any, err: any) {
        if (err) return reject(err);
        // mimic better-sqlite3 return with lastInsertRowid & changes
        return resolve({ lastInsertRowid: this.lastID, changes: this.changes } as unknown as T);
      });
    });
  };
  const all = function <T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err: any, rows: any[]) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  };
  const get = function <T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err: any, row: any) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  };
  const close = function () {
    return new Promise<void>((resolve, reject) => {
      db.close((err: any) => (err ? reject(err) : resolve()));
    });
  };
  return {
    type: 'sqlite3',
    run,
    all,
    get,
    close
  };
}

export function openSqlite(dbFile?: string): SqliteWrapper {
  const file = dbFile ?? path.resolve(process.cwd(), 'data', 'credentials.db');
  // Try better-sqlite3 first (synchronous, faster).
  try {
    // Use createRequire to allow loading CJS modules even in ESM runtime
    const requireFn = (typeof (globalThis as any).require === 'function') ? (globalThis as any).require : createRequire(import.meta.url);
    const better = requireFn('better-sqlite3');
    const db = new better(file);
    console.info('openSqlite: using better-sqlite3 driver');
    return mkSyncWrapper(db);
  } catch (e: any) {
    // ignore; fall through to sqlite3 fallback
    // console.warn('better-sqlite3 failed to load:', e?.message || e);
  }
  // Fallback to sqlite3 (async wrappers). This should be a valid Node driver
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqlite3 = require('sqlite3');
    const sqlite3verbose = sqlite3.verbose ? sqlite3.verbose() : sqlite3;
    const db = new sqlite3verbose.Database(file);
    console.info('openSqlite: using sqlite3 driver fallback');
    return mkSqlite3Wrapper(db);
  } catch (err: any) {
    // If both drivers are unavailable, raise a clear error so caller can fallback to file store
    throw new Error(`No sqlite driver available (tried better-sqlite3 and sqlite3): ${err?.message ?? err}`);
  }
}

export default openSqlite;
