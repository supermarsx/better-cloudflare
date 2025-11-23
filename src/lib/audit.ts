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
import createCredentialStore from './credential-store';
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
        // Try to call the optional writeAudit method if present on the store.
        const s = store as unknown as { writeAudit?: (entry: AuditEntry) => Promise<unknown> };
        s.writeAudit?.(final)?.catch?.(() => undefined);
      } catch {
        // ignore errors while attempting to write optional DB audit entries
      }
    } catch {
      // ignore errors during logging.
    }
}

export async function getAuditEntries(): Promise<AuditEntry[]> {
  // If DB store available return DB entries, otherwise in-memory
    const s = store as unknown as { getAuditEntries?: () => Promise<{ actor?: string; operation: string; resource?: string; details?: string | null; timestamp?: string }[]> };
    if (s.getAuditEntries) {
    try {
      // convert DB rows into AuditEntry[]
      const rows = await s.getAuditEntries();
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
