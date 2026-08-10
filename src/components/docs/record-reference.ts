/**
 * The data behind the in-app record type reference.
 *
 * Nothing here holds DNS knowledge of its own. Every entry is assembled from
 * the surfaces that already own it, so the reference cannot drift away from
 * what the Add Record dialog and the guided builders teach:
 *
 * - the type list and its labels come from `src/types/dns.ts`;
 * - the content format, worked example and caveat come from
 *   `builders/record-formats.ts` ({@link RECORD_FORMATS});
 * - the reason a type has no example comes from {@link RECORD_FORMAT_OMISSIONS};
 * - the plain-language purpose and the RFC links come from {@link RECORD_DOCS}.
 *
 * Kept free of React so the assembly and the search can be unit tested as
 * plain data.
 */
import {
  RECORD_DOCS,
  RECORD_FORMATS,
  RECORD_FORMAT_OMISSIONS,
  type RfcReference,
} from "@/components/dns/builders/record-formats";
import {
  CLOUDFLARE_SUPPORTED_RECORD_TYPES,
  RECORD_TYPES,
  getRecordTypeLabel,
  type RecordType,
} from "@/types/dns";

/** One record type, as the reference presents it. */
export interface RecordReferenceEntry {
  /** The type code, e.g. `CAA`. */
  type: RecordType;
  /** The dropdown label, e.g. `CAA (cert authority allowed)`. */
  label: string;
  /** The part of the label inside the parentheses, or the type if there is none. */
  shortLabel: string;
  /** What the record is for, in plain language. */
  purpose: string;
  /** Defining specifications; empty for provider-specific, non-IANA types. */
  rfcs: RfcReference[];
  /** Field order, when the presentation format is known. */
  format?: string;
  /** A single valid instance of that format. */
  example?: string;
  /** The caveat the Add Record dialog shows beside the content field. */
  note?: string;
  /** Why this type has no format or example, when it deliberately has none. */
  omissionReason?: string;
  /** Whether the Add Record dropdown offers this type without opting in. */
  offeredByDefault: boolean;
}

/** How a type is reached in the Add Record dialog. */
export type RecordAvailability = "default" | "opt-in";

export const AVAILABILITY_LABELS: Record<RecordAvailability, string> = {
  default: "In the type list by default",
  "opt-in": "Needs “Unsupported record types” turned on",
};

/**
 * The two-line explanation of the availability split, shown as a legend so a
 * reader never wonders why a type they just read about is not selectable.
 * The quoted phrase is the exact label of the toggle it points at.
 */
export const AVAILABILITY_HINTS: Record<RecordAvailability, string> = {
  default:
    "Cloudflare supports these through its DNS API, so the Add Record type list offers them straight away.",
  "opt-in":
    "Cloudflare does not offer these. Turn on “Unsupported record types”, in Settings or per zone in Zone Settings, to pick one — Cloudflare may still reject it on save.",
};

const CLOUDFLARE_DEFAULT_TYPES = new Set<RecordType>(
  CLOUDFLARE_SUPPORTED_RECORD_TYPES,
);

/** `CAA (cert authority allowed)` -> `cert authority allowed`. */
function extractShortLabel(type: RecordType, label: string): string {
  const match = /\(([^)]+)\)/u.exec(label);
  return match?.[1]?.trim() || type;
}

/**
 * Every supported record type, in the order `RECORD_TYPES` declares them, with
 * everything the reference needs to render one.
 */
export function buildRecordReference(): RecordReferenceEntry[] {
  return RECORD_TYPES.map((type) => {
    const format = RECORD_FORMATS[type];
    const doc = RECORD_DOCS[type];
    const label = getRecordTypeLabel(type);
    return {
      type,
      label,
      shortLabel: extractShortLabel(type, label),
      purpose: doc.purpose,
      rfcs: doc.rfcs,
      ...(format ? { format: format.format, example: format.example } : {}),
      ...(format?.note ? { note: format.note } : {}),
      ...(RECORD_FORMAT_OMISSIONS[type]
        ? { omissionReason: RECORD_FORMAT_OMISSIONS[type] }
        : {}),
      offeredByDefault: CLOUDFLARE_DEFAULT_TYPES.has(type),
    } satisfies RecordReferenceEntry;
  });
}

/** Where a type sits in the Add Record dialog's type list. */
export function availabilityOf(
  entry: RecordReferenceEntry,
): RecordAvailability {
  return entry.offeredByDefault ? "default" : "opt-in";
}

/**
 * Everything a query is matched against, lowercased once per entry.
 *
 * The example and the format are included deliberately: searching `_tcp` or
 * `v=spf1` is how people actually look for the record that carries them.
 */
function searchHaystack(entry: RecordReferenceEntry): string {
  return [
    entry.type,
    entry.label,
    entry.purpose,
    entry.format ?? "",
    entry.example ?? "",
    entry.note ?? "",
    entry.omissionReason ?? "",
    ...entry.rfcs.map((ref) => ref.label),
    // So "rfc1035" finds RFC 1035 too.
    ...entry.rfcs.map((ref) => ref.label.replace(/\s+/gu, "")),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Filter the reference by a free-text query.
 *
 * All whitespace-separated terms must match somewhere in the entry, so
 * `mail apex` narrows rather than widens. An empty query returns everything.
 */
export function filterRecordReference(
  entries: readonly RecordReferenceEntry[],
  query: string,
): RecordReferenceEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return [...entries];
  return entries.filter((entry) => {
    const haystack = searchHaystack(entry);
    return terms.every((term) => haystack.includes(term));
  });
}
