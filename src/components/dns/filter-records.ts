import type { DNSRecord } from '../../types/dns';

export function filterRecords(records: DNSRecord[], searchTerm: string): DNSRecord[] {
  const query = searchTerm.toLowerCase();
  return records.filter(
    (record) =>
      record.name.toLowerCase().includes(query) ||
      record.type.toLowerCase().includes(query) ||
      record.content.toLowerCase().includes(query)
  );
}
