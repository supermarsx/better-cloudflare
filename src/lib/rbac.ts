import type { Request, Response, NextFunction } from "express";
import { getEnv } from "./env";
import createCredentialStore, {
  SqliteCredentialStore,
} from "./credential-store";
import type { SqliteWrapper } from "./sqlite-driver";

/**
 * Simple RBAC middleware: allow when x-admin-token matches env ADMIN_TOKEN or
 * when the request contains a header `x-auth-email` that corresponds to a
 * user row with role "admin" in the sqlite user table. This is intentionally
 * lightweight - for production consider using a robust identity system.
 */
// DB helper types are handled via SqliteWrapper in the credential-store/sqlite-driver

export async function isAdmin(req: Request, res: Response, next: NextFunction) {
  const adminToken = getEnv("ADMIN_TOKEN", "VITE_ADMIN_TOKEN", undefined);
  const reqAdmin = req.header("x-admin-token");
  if (reqAdmin && adminToken && reqAdmin === adminToken) return next();

  // fallback to check email mapping in sqlite (if credential store supports DB)
  const email = req.header("x-auth-email");
  if (!email) {
    res.status(403).json({ error: "Admin credentials required" });
    return;
  }
  const store = createCredentialStore();
  // if store exposes a db (sqlite store), check users table
  if (store instanceof SqliteCredentialStore && store.db) {
    const db = store.db as SqliteWrapper;
    try {
      await db.run(
        "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, roles TEXT)",
      );
      const row = await db.get("SELECT roles FROM users WHERE email = ?", [
        email,
      ]);
      if (!row) {
        res.status(403).json({ error: "Admin credentials required" });
        return;
      }
      const roles = JSON.parse(((row as any).roles as string) || "[]");
      if (Array.isArray(roles) && roles.includes("admin")) {
        return next();
      }
    } catch {
      // fallback to deny
      res.status(403).json({ error: "Admin credentials required" });
      return;
    }
  }
  res.status(403).json({ error: "Admin credentials required" });
}

export default { isAdmin };
