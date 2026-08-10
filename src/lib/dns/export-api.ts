import type { DNSRecord } from "@/types/dns";
import {
  hasUnbalancedQuotes,
  isQuotedForm,
  normalizeCharacterString,
} from "./character-string";
// date-fns not required for now; avoid dependency in build

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
  const headers = ["Type", "Name", "Content", "TTL", "Priority", "Proxied"];
  const escapeCSV = (value: unknown) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = records
    .map((r) =>
      [r.type, r.name, r.content, r.ttl, r.priority ?? "", r.proxied ?? false]
        .map(escapeCSV)
        .join(","),
    )
    .join("\n");
  return headers.map(escapeCSV).join(",") + "\n" + rows;
}

const WHOLE_CONTENT_NAME_TYPES = new Set([
  "ALIAS",
  "ANAME",
  "CNAME",
  "DNAME",
  "MX",
  "NS",
  "PTR",
]);

const CONTENT_NAME_FIELDS: Readonly<Record<string, ReadonlySet<number>>> = {
  AFSDB: new Set([1]),
  HTTPS: new Set([1]),
  NSEC: new Set([0]),
  RP: new Set([0, 1]),
  RRSIG: new Set([7]),
  SOA: new Set([0, 1]),
  SVCB: new Set([1]),
};

const SRV_CONTENT_TARGET = new Set([3]);
const SRV_CONTENT_TARGET_WITH_PRIORITY = new Set([2]);

function absoluteDNSName(value: string): string {
  const name = value.trim();
  if (!name || name === "@" || name === "." || name.endsWith(".")) {
    return name;
  }
  return `${name}.`;
}

/**
 * True when `value` holds a literal control character. One of those — a raw
 * newline above all — would split the single line a record is written on, so
 * such content is re-escaped rather than emitted as it stands.
 */
function hasRawControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

/**
 * Write a `<character-string>` payload (TXT, SPF, and the TXT-shaped DKIM and
 * DMARC records) in BIND presentation form.
 *
 * Content that already carries its own quotes — the form Cloudflare returns,
 * and the form `parseBINDZone` produces on import — is emitted verbatim.
 * Quoting it a second time would bury the value under an escaped-quote layer
 * (`"\"v=DMARC1; p=reject\""`) that the next import reads back as literal
 * quote characters, so every export/import round trip would mutate the record.
 *
 * Bare content must be quoted: an unquoted `;` starts a zone-file comment, and
 * DMARC and DKIM values are full of them.
 *
 * Content that is quoted but damaged — an unbalanced quote, or a raw control
 * character that would split the record across lines — is re-serialized from
 * its logical value by {@link normalizeCharacterString}, which is exactly how
 * the import side reads it back, so the round trip still agrees.
 */
function bindCharacterString(value: string): string {
  const trimmed = value.trim();
  if (
    isQuotedForm(trimmed) &&
    !hasUnbalancedQuotes(trimmed) &&
    !hasRawControlCharacter(trimmed)
  ) {
    return trimmed;
  }
  return normalizeCharacterString(trimmed);
}

function absoluteNameFields(
  content: string,
  nameFieldIndexes: ReadonlySet<number>,
): string {
  let fieldIndex = 0;
  return content.replace(/\S+/g, (field) => {
    const currentIndex = fieldIndex++;
    return nameFieldIndexes.has(currentIndex) ? absoluteDNSName(field) : field;
  });
}

function bindContent(record: DNSRecord): string {
  const type = record.type.toUpperCase();
  if (type === "TXT" || type === "SPF") {
    return bindCharacterString(record.content);
  }
  if (WHOLE_CONTENT_NAME_TYPES.has(type)) {
    return absoluteDNSName(record.content);
  }
  if (type === "SRV") {
    return absoluteNameFields(
      record.content,
      record.priority == null
        ? SRV_CONTENT_TARGET
        : SRV_CONTENT_TARGET_WITH_PRIORITY,
    );
  }

  const nameFields = CONTENT_NAME_FIELDS[type];
  return nameFields
    ? absoluteNameFields(record.content, nameFields)
    : record.content;
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
      const ttl = r.ttl === 1 || r.ttl === "auto" ? 300 : r.ttl;
      const priority = r.priority == null ? "" : `${r.priority} `;
      return `${absoluteDNSName(r.name)}\t${ttl}\tIN\t${r.type}\t${priority}${bindContent(r)}`;
    })
    .join("\n");
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
