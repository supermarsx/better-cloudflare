/**
 * Parsers for importing DNS records from common text formats.
 *
 * Exported helpers parse CSV lines, CSV tables, and simplified BIND zone
 * snippets into arrays of `Partial<DNSRecord>` that can be consumed by the
 * UI import workflow.
 */
import type { DNSRecord } from '@/types/dns';

/**
 * Parse a single CSV line into its values while handling quoted
 * values and escaped quotes.
 *
 * @param line - CSV input line to parse
 * @returns array of values parsed from the line
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result.map((v) => v.trim());
}

/**
 * Parse CSV text into a list of DNS records.
 *
 * Expected header columns (case-insensitive): Type, Name, Content, TTL,
 * Priority, Proxied. Missing TTL/priority/proxied fields will be omitted
 * from the returned partial record.
 */
export function parseCSVRecords(text: string): Partial<DNSRecord>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
  const idx = {
    type: headers.indexOf('type'),
    name: headers.indexOf('name'),
    content: headers.indexOf('content'),
    ttl: headers.indexOf('ttl'),
    priority: headers.indexOf('priority'),
    proxied: headers.indexOf('proxied'),
  };

  const records: Partial<DNSRecord>[] = [];
  for (const line of lines.slice(1)) {
    const values = parseCSVLine(line);
    if (!values.length) continue;
    const record: Partial<DNSRecord> = {
      type: idx.type >= 0 ? values[idx.type] : undefined,
      name: idx.name >= 0 ? values[idx.name] : undefined,
      content: idx.content >= 0 ? values[idx.content] : undefined,
    };

    const ttlVal = idx.ttl >= 0 ? values[idx.ttl] : undefined;
    if (ttlVal) record.ttl = ttlVal === 'auto' ? 'auto' : Number(ttlVal);

    const prVal = idx.priority >= 0 ? values[idx.priority] : undefined;
    if (prVal) record.priority = Number(prVal);

    const proxiedVal = idx.proxied >= 0 ? values[idx.proxied] : undefined;
    if (proxiedVal) record.proxied = /^(true|1)$/i.test(proxiedVal);

    records.push(record);
  }

  return records;
}

/**
 * Parse a BIND zone file snippet into a list of DNS records. This parser is a
 * lightweight convenience parser that expects simplified zone lines with the
 * format: <name> <ttl> IN <type> <content>. Lines beginning with `;` or the
 * empty line are ignored.
 */
export function parseBINDZone(text: string): Partial<DNSRecord>[] {
  const lines = text.trim().split(/\r?\n/);
  const records: Partial<DNSRecord>[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const noComment = line.split(';')[0].trim();
    const parts = noComment.split(/\s+/);
    if (parts.length < 4) continue;
    const [name, ttlStr, , type, ...rest] = parts;
    const ttl = Number(ttlStr) || 300;
    let priority: number | undefined;
    let contentParts = rest;
    if (type.toUpperCase() === 'MX' && rest.length >= 2) {
      priority = Number(rest[0]);
      contentParts = rest.slice(1);
    }
    const record: Partial<DNSRecord> = {
      name,
      ttl,
      type,
      content: contentParts.join(' '),
    };
    if (priority !== undefined) record.priority = priority;
    records.push(record);
  }

  return records;
}

