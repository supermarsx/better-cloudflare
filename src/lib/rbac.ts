import type { Request, Response, NextFunction } from 'express';
import { getEnv } from './env';
import createCredentialStore from './credential-store';

/**
 * Simple RBAC middleware: allow when x-admin-token matches env ADMIN_TOKEN or
 * when the request contains a header `x-auth-email` that corresponds to a
 * user row with role "admin" in the sqlite user table. This is intentionally
 * lightweight - for production consider using a robust identity system.
 */
export async function isAdmin(req: Request, res: Response, next: NextFunction) {
  const adminToken = getEnv('ADMIN_TOKEN', 'VITE_ADMIN_TOKEN', undefined);
  const reqAdmin = req.header('x-admin-token');
  if (reqAdmin && adminToken && reqAdmin === adminToken) return next();

  // fallback to check email mapping in sqlite (if credential store supports DB)
  const email = req.header('x-auth-email');
  if (!email) {
    res.status(403).json({ error: 'Admin credentials required' });
    return;
  }
  const store: any = createCredentialStore();
  // if store exposes a db (sqlite store), check users table
  if (store && (store as any).db) {
    try {
      const db: any = (store as any).db;
      db.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, roles TEXT)').run();
      const row = db.prepare('SELECT roles FROM users WHERE email = ?').get(email);
      if (!row) {
        res.status(403).json({ error: 'Admin credentials required' });
        return;
      }
      const roles = JSON.parse(row.roles || '[]');
      if (Array.isArray(roles) && roles.includes('admin')) {
        return next();
      }
    } catch (e) {
      // fallback to deny
      res.status(403).json({ error: 'Admin credentials required' });
      return;
    }
  }
  res.status(403).json({ error: 'Admin credentials required' });
}

export default { isAdmin };
