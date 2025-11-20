import type { DNSRecord } from '@/types/dns';
import { format as formatDate } from 'date-fns';

/**
 * Convert a list of DNS records to CSV text
 */
/**
 * Convert DNS records into CSV format.
 *
 * The CSV contains header fields: Type, Name, Content, TTL, Priority, Proxied
 * and returns a quoted, comma-separated representation compatible with
 * common spreadsheet imports.
 */
export function recordsToCSV(records: DNSRecord[]): string {
  const headers = ['Type', 'Name', 'Content', 'TTL', 'Priority', 'Proxied'];
  const escapeCSV = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = records
    .map((r) => [r.type, r.name, r.content, r.ttl, r.priority ?? '', r.proxied ?? false]
      .map(escapeCSV)
      .join(','))
    .join('\n');
  return headers.map(escapeCSV).join(',') + '\n' + rows;
}

/**
 * Convert a list of DNS records into a BIND-style zone file snippet.
 *
 * The function roughly maps TTL and type/priority fields into a textual
 * representation suitable for importing into BIND-derived tooling.
 */
export function recordsToBIND(records: DNSRecord[]): string {
  return records
    .map((r) => {
      const ttl = r.ttl === 1 ? 300 : r.ttl;
      const priority = r.priority ? `${r.priority} ` : '';
      return `${r.name}\t${ttl}\tIN\t${r.type}\t${priority}${r.content}`;
    })
    .join('\n');
}

/**
 * Convert DNS records into a formatted JSON string.
 *
 * Useful for producing a human-readable JSON export that includes all
 * available fields returned by the Cloudflare API.
 */
export function recordsToJSON(records: DNSRecord[]): string {
  return JSON.stringify(records, null, 2);
}
