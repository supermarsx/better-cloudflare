/**
 * Simple audit logger used to record actions performed on sensitive objects.
 * For now this logs to console. Later it can be extended to write to a DB or
 * a rotating file.
 */
export type AuditEntry = {
  actor?: string;
  operation: string;
  resource?: string;
  details?: unknown;
  timestamp?: string;
};

const entries: AuditEntry[] = [];
import createCredentialStore, { SqliteCredentialStore } from './credential-store';
const store = createCredentialStore();

export function logAudit(entry: AuditEntry) {
  const final: AuditEntry = { ...entry, timestamp: new Date().toISOString() };
  entries.push(final);
  // Simple console log for now; in production route to structured log
  // or write to a secure audit store.
    try {
      console.info('AUDIT', JSON.stringify(final));
      // If sqlite store exists, write audit there too (fire-and-forget)
      try {
        // If the credential store is backed by sqlite, use its writeAudit method.
        if (store instanceof SqliteCredentialStore && typeof store.writeAudit === 'function') {
          try {
            store.writeAudit(final).catch?.(() => undefined);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore errors while attempting to write optional DB audit entries
      }
    } catch {
      // ignore errors during logging.
    }
}

export async function getAuditEntries(): Promise<AuditEntry[]> {
  // If DB store available return DB entries, otherwise in-memory
    if (store instanceof SqliteCredentialStore && typeof store.getAuditEntries === 'function') {
    try {
      // convert DB rows into AuditEntry[]
      const rows = await store.getAuditEntries();
      return rows.map((r) => ({
        actor: r.actor,
        operation: r.operation,
        resource: r.resource,
        details: r.details ? JSON.parse(r.details || '{}') : undefined,
        timestamp: r.timestamp,
      }));
    } catch {
      return [...entries];
    }
  }
  return [...entries];
}

export function clearAuditEntries(): void {
  entries.length = 0;
}
