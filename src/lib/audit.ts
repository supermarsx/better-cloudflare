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
    // If sqlite store exists, write audit there too
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store as any).writeAudit(final);
    } catch (_e) {
      // ignore
    }
  } catch (e) {
    // ignore errors during logging.
  }
}

export function getAuditEntries(): AuditEntry[] {
  // If DB store available return DB entries, otherwise in-memory
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((store as any).getAuditEntries) {
    try {
      // convert DB rows into AuditEntry[]
      const rows = (store as any).getAuditEntries();
      return rows.map((r: any) => ({ actor: r.actor, operation: r.operation, resource: r.resource, details: JSON.parse(r.details || '{}'), timestamp: r.timestamp }));
    } catch (_e) {
      return [...entries];
    }
  }
  return [...entries];
}

export function clearAuditEntries(): void {
  entries.length = 0;
}
