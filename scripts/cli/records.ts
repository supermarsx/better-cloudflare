/**
 * Format detection, loading and serialization for the DNS CLI.
 *
 * Every parser and serializer here is the one the application already ships:
 * `src/lib/dns/dns-parsers` for BIND and CSV input and `src/lib/dns/export-api`
 * for JSON, CSV and BIND output. Nothing about those formats is reimplemented,
 * so a fix landing in either module reaches the CLI with no change here.
 *
 * The one thing this module adds is *provenance*: `validate` has to say which
 * line of a zone file or which index of a JSON export a rejected record came
 * from, and neither parser reports that. Line numbers are recovered by feeding
 * the library parser one candidate line at a time and zipping the results
 * against the authoritative whole-file parse; if the two disagree in length the
 * mapping is discarded and records are reported by index alone rather than
 * attributed to the wrong line.
 */
import type { DNSRecord } from "../../src/types/dns";
import { parseBINDZone, parseCSVRecords } from "../../src/lib/dns/dns-parsers";
import {
  recordsToBIND,
  recordsToCSV,
  recordsToJSON,
} from "../../src/lib/dns/export-api";

/** The interchange formats the application supports. */
export const RECORD_FORMATS = ["json", "csv", "bind"] as const;

export type RecordFormat = (typeof RECORD_FORMATS)[number];

/** A parsed record plus where in the source file it came from. */
export interface SourceRecord {
  /** Zero-based position within the file. */
  index: number;
  /** One-based source line, or `null` when it could not be attributed. */
  line: number | null;
  /** The record as the application's own parser produced it. */
  record: Partial<DNSRecord>;
  /** Set when the entry could not be read as a record at all. */
  malformed?: string;
}

/** The outcome of reading a file. */
export interface LoadedRecords {
  format: RecordFormat;
  records: SourceRecord[];
}

/** Raised for input the CLI can describe better than a stack trace can. */
export class RecordFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordFormatError";
  }
}

const EXTENSION_FORMATS: Readonly<Record<string, RecordFormat>> = {
  ".json": "json",
  ".csv": "csv",
  ".bind": "bind",
  ".zone": "bind",
  ".db": "bind",
  ".txt": "bind",
};

/** True when `value` names one of the supported formats. */
export function isRecordFormat(value: string): value is RecordFormat {
  return (RECORD_FORMATS as readonly string[]).includes(value);
}

/**
 * Guess a format from a file name. Returns `null` when the extension carries no
 * signal, in which case the caller must require an explicit `--format`.
 */
export function inferFormat(filePath: string): RecordFormat | null {
  const match = /\.[^.\\/]+$/u.exec(filePath.toLowerCase());
  return match ? (EXTENSION_FORMATS[match[0]] ?? null) : null;
}

/** Fill the fields `DNSRecord` requires but a parsed partial may not carry. */
export function completeRecord(partial: Partial<DNSRecord>): DNSRecord {
  const record: DNSRecord = {
    id: partial.id ?? "",
    type: partial.type ?? "",
    name: partial.name ?? "",
    content: partial.content ?? "",
    ttl: partial.ttl ?? 300,
    zone_id: partial.zone_id ?? "",
    zone_name: partial.zone_name ?? "",
    created_on: partial.created_on ?? "",
    modified_on: partial.modified_on ?? "",
  };
  if (partial.comment !== undefined) record.comment = partial.comment;
  if (partial.priority !== undefined) record.priority = partial.priority;
  if (partial.proxied !== undefined) record.proxied = partial.proxied;
  return record;
}

/**
 * Strip a record down to the fields that describe it, dropping the
 * server-assigned identifiers a JSON export carries. This is what `migrate` and
 * a file-destined `export` emit, so a converted file can be fed straight back
 * into `import` without carrying another zone's ids.
 */
export function toPortableRecord(
  partial: Partial<DNSRecord>,
): Partial<DNSRecord> {
  const record: Partial<DNSRecord> = {
    type: partial.type ?? "",
    name: partial.name ?? "",
    content: partial.content ?? "",
    ttl: partial.ttl ?? 300,
  };
  if (partial.priority !== undefined) record.priority = partial.priority;
  if (partial.proxied !== undefined) record.proxied = partial.proxied;
  if (partial.comment !== undefined) record.comment = partial.comment;
  return record;
}

const JSON_FIELDS = [
  "id",
  "type",
  "name",
  "content",
  "comment",
  "ttl",
  "priority",
  "proxied",
  "zone_id",
  "zone_name",
  "created_on",
  "modified_on",
] as const;

function readJSONEntry(entry: unknown): SourceRecord["record"] | string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return "entry is not a JSON object";
  }
  const source = entry as Record<string, unknown>;
  const record: Record<string, unknown> = {};
  for (const field of JSON_FIELDS) {
    if (source[field] !== undefined) record[field] = source[field];
  }
  return record as Partial<DNSRecord>;
}

function parseJSONRecords(text: string): SourceRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RecordFormatError(
      `The file is not valid JSON: ${(error as Error).message}`,
    );
  }

  const container =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { records?: unknown; result?: unknown })
      : null;
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(container?.records)
      ? container.records
      : Array.isArray(container?.result)
        ? container.result
        : null;

  if (!entries) {
    throw new RecordFormatError(
      "The JSON file must be an array of records, or an object with a `records` or `result` array.",
    );
  }

  return entries.map((entry, index) => {
    const read = readJSONEntry(entry);
    return typeof read === "string"
      ? { index, line: null, record: {}, malformed: read }
      : { index, line: null, record: read };
  });
}

/**
 * Attribute BIND records to source lines.
 *
 * `parseBINDZone` treats every line independently — it interprets no `$ORIGIN`,
 * no parenthesised continuations and no blank-owner inheritance — so parsing a
 * single line in isolation yields exactly the record the whole-file parse
 * yields for it.
 */
function locateBINDLines(text: string, expected: number): (number | null)[] {
  const lines = text.split(/\r?\n/u);
  const located: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (parseBINDZone(lines[index]).length === 1) located.push(index + 1);
  }
  return located.length === expected
    ? located
    : Array.from({ length: expected }, () => null);
}

/**
 * Attribute CSV records to source lines by re-parsing each data line under the
 * file's own header row. `parseCSVRecords` splits on newlines before it splits
 * on commas, so a record never spans two lines and this mapping is exact.
 */
function locateCSVLines(text: string, expected: number): (number | null)[] {
  const lines = text.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => line.trim() !== "");
  const header = headerIndex === -1 ? null : lines[headerIndex];
  const located: number[] = [];
  if (header !== null) {
    for (let index = headerIndex + 1; index < lines.length; index++) {
      if (parseCSVRecords(`${header}\n${lines[index]}`).length === 1) {
        located.push(index + 1);
      }
    }
  }
  return located.length === expected
    ? located
    : Array.from({ length: expected }, () => null);
}

/** Parse `text` in `format` into records carrying their source location. */
export function parseRecords(
  text: string,
  format: RecordFormat,
): SourceRecord[] {
  if (format === "json") return parseJSONRecords(text);

  const parsed =
    format === "bind" ? parseBINDZone(text) : parseCSVRecords(text);
  const lines =
    format === "bind"
      ? locateBINDLines(text, parsed.length)
      : locateCSVLines(text, parsed.length);

  return parsed.map((record, index) => ({
    index,
    line: lines[index] ?? null,
    record,
  }));
}

/** Serialize records using the application's own exporters. */
export function serializeRecords(
  records: Partial<DNSRecord>[],
  format: RecordFormat,
): string {
  if (format === "json") {
    return recordsToJSON(records.map(toPortableRecord) as DNSRecord[]);
  }
  const complete = records.map(completeRecord);
  return format === "csv" ? recordsToCSV(complete) : recordsToBIND(complete);
}
