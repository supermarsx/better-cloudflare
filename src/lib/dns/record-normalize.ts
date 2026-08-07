/**
 * Save-time `<character-string>` normalization for DNS record content.
 *
 * {@link ./character-string} understands the presentation syntax; this module
 * decides *which* record types are made of character-strings and how each one
 * is put back together, so every write path (add dialog, inline row edit,
 * paste, import) can normalize with a single call right before it hands the
 * record to Cloudflare.
 *
 * Types whose RDATA is not a character-string — A, AAAA, CNAME, MX, NS, SRV,
 * PTR and friends — are returned untouched: quoting those would invalidate
 * them.
 */
import {
  normalizeCharacterString,
  parseCharacterStringTokens,
  quoteCharacterString,
} from "./character-string";

/**
 * Record types whose content this module rewrites.
 *
 * - `TXT` / `SPF`: the whole payload is one logical character-string, split
 *   into adjacent strings when it exceeds 255 bytes.
 * - `HINFO`: a fixed list of character-strings (`"CPU" "OS"`), each quoted
 *   independently.
 * - `CAA`: only the trailing value field is a character-string; the numeric
 *   flags and the tag must stay bare.
 */
export const CHARACTER_STRING_RECORD_TYPES = [
  "TXT",
  "SPF",
  "HINFO",
  "CAA",
] as const;

const CHARACTER_STRING_TYPE_SET = new Set<string>(
  CHARACTER_STRING_RECORD_TYPES,
);

/** `<flags> <tag> <value>` — the value is the only character-string field. */
const CAA_CONTENT_PATTERN =
  /^(\d{1,3})([\t ]+)([A-Za-z0-9-]+)([\t ]+)([\s\S]+)$/u;

/** True when `type` carries `<character-string>` RDATA this module rewrites. */
export function isCharacterStringRecordType(type: string | undefined): boolean {
  return CHARACTER_STRING_TYPE_SET.has((type ?? "").toUpperCase());
}

function normalizeHinfoContent(content: string): string {
  const tokens = parseCharacterStringTokens(content);
  if (!tokens.length) return normalizeCharacterString(content);
  return tokens.map(quoteCharacterString).join(" ");
}

function normalizeCaaContent(content: string): string {
  const match = CAA_CONTENT_PATTERN.exec(content.trim());
  // Unparseable CAA content is left verbatim rather than mangled: the record
  // is already invalid and rewriting it would hide that from the user.
  if (!match) return content;
  const [, flags, flagsGap, tag, tagGap, value] = match;
  return `${flags}${flagsGap}${tag}${tagGap}${normalizeCharacterString(value)}`;
}

/**
 * Normalize the presentation form of `content` for `type`.
 *
 * Returns `content` unchanged for every type that is not built from
 * character-strings, and for empty content. The result is stable: normalizing
 * an already normalized value is a no-op.
 */
export function normalizeRecordContent(
  type: string | undefined,
  content: string | undefined,
): string {
  const raw = content ?? "";
  if (!raw.trim() || !isCharacterStringRecordType(type)) return raw;

  switch ((type ?? "").toUpperCase()) {
    case "HINFO":
      return normalizeHinfoContent(raw);
    case "CAA":
      return normalizeCaaContent(raw);
    default:
      return normalizeCharacterString(raw);
  }
}

/**
 * Return `record` with its content normalized for its type.
 *
 * The same object is returned when nothing changed, so callers can pass
 * records through unconditionally without churning React state.
 */
export function normalizeRecordCharacterStrings<
  T extends { type?: string; content?: string },
>(record: T): T {
  if (!record) return record;
  const normalized = normalizeRecordContent(record.type, record.content);
  if (normalized === record.content) return record;
  return { ...record, content: normalized };
}

/** Normalize a list of records, preserving order. */
export function normalizeRecordListCharacterStrings<
  T extends { type?: string; content?: string },
>(records: readonly T[]): T[] {
  return records.map((record) => normalizeRecordCharacterStrings(record));
}
