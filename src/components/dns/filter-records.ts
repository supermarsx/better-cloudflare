import type { DNSRecord } from '../../types/dns';

/**
 * Filter DNS records by a search term matching name, type, or content.
 *
 * @param records - list of DNS records
 * @param searchTerm - search query string to match
 * @returns filtered list of DNSRecord matching the query
 */
export function filterRecords(records: DNSRecord[], searchTerm: string): DNSRecord[] {
  const query = searchTerm.toLowerCase();
  return records.filter(
    (record) =>
      record.name.toLowerCase().includes(query) ||
      record.type.toLowerCase().includes(query) ||
      record.content.toLowerCase().includes(query)
  );
}
