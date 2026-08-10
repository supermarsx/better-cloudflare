/**
 * Parsers for importing DNS records from common text formats.
 *
 * Exported helpers parse CSV lines, CSV tables, and simplified BIND zone
 * snippets into arrays of `Partial<DNSRecord>` that can be consumed by the
 * UI import workflow.
 */
import type { DNSRecord } from "@/types/dns";

/**
 * Parse a single CSV line into its values while handling quoted
 * values and escaped quotes.
 *
 * @param line - CSV input line to parse
 * @returns array of values parsed from the line
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
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
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
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
 *
 * The record type is upper-cased (RFC 1035 §5.1 mnemonics are
 * case-insensitive) and the TTL accepts the same grammar as the zone parser,
 * so the two import paths agree about the same record. A TTL or priority that
 * is not a number is *dropped* rather than retained as `NaN`: an absent field
 * is recoverable, a `NaN` that serialises to `null` is not.
 */
export function parseCSVRecords(text: string): Partial<DNSRecord>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
  const idx = {
    type: headers.indexOf("type"),
    name: headers.indexOf("name"),
    content: headers.indexOf("content"),
    ttl: headers.indexOf("ttl"),
    priority: headers.indexOf("priority"),
    proxied: headers.indexOf("proxied"),
  };
  const cell = (values: string[], index: number): string | undefined => {
    if (index < 0) return undefined;
    const value = values[index];
    return value ? value : undefined;
  };

  const records: Partial<DNSRecord>[] = [];
  for (const line of lines.slice(1)) {
    const values = parseCSVLine(line);
    if (!values.length) continue;
    const type = cell(values, idx.type);
    const record: Partial<DNSRecord> = {
      type: type === undefined ? undefined : type.toUpperCase(),
      name: cell(values, idx.name),
      content: cell(values, idx.content),
    };

    const ttlVal = cell(values, idx.ttl);
    if (ttlVal) {
      if (/^auto$/iu.test(ttlVal)) {
        record.ttl = "auto";
      } else {
        const seconds = parseBINDTTL(ttlVal);
        if (seconds !== null) record.ttl = seconds;
      }
    }

    const prVal = cell(values, idx.priority);
    if (prVal) {
      const preference = parsePreference(prVal);
      if (preference !== null) record.priority = preference;
    }

    const proxiedVal = cell(values, idx.proxied);
    if (proxiedVal) record.proxied = /^(true|1)$/i.test(proxiedVal);

    records.push(record);
  }

  return records;
}

/** DNS classes that may appear between the owner name and the record type. */
const BIND_CLASSES = new Set(["IN", "CH", "CS", "HS"]);

/** TTL used when a zone line omits one (the parser's documented default). */
const DEFAULT_BIND_TTL = 300;

/**
 * Widest TTL the parser will read out of a zone file. The DNS TTL field is
 * 31 bits (RFC 2181 §8) but the transport carries a `u32`, so anything that
 * still fits a `u32` is read and left for validation to reject with a precise
 * message. Anything wider is not a TTL at all.
 */
const MAX_BIND_TTL_SECONDS = 4_294_967_295;

/** Seconds per BIND duration suffix (`60m`, `1h`, `2d`, `1w`). */
const BIND_TTL_UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
};

/** A bare second count, e.g. `3600`. Zero is legal (RFC 2181 §8). */
const BIND_TTL_SECONDS_PATTERN = /^\d+$/u;

/** One or more `<count><unit>` groups, e.g. `1h`, `2d`, `1w12h`. */
const BIND_TTL_DURATION_PATTERN = /^(?:\d+[smhdwSMHDW])+$/u;

/** A record type mnemonic: alphabetic-leading, e.g. `A`, `AAAA`, `TYPE65535`. */
const BIND_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/u;

/**
 * Read a zone-file TTL.
 *
 * Accepts a bare second count (RFC 1035 §5.1) and BIND's duration suffixes,
 * including combined forms such as `1w12h`. Returns `null` when the token is
 * not a TTL at all, so the caller can fall through to the class/type fields
 * instead of inventing a value.
 *
 * A TTL of `0` is returned as `0`. RFC 2181 §8 makes zero legal and meaningful
 * ("do not cache"), and it is what `version.bind. 0 CH TXT` and a `dig` answer
 * captured at the end of its life both carry.
 */
function parseBINDTTL(field: string): number | null {
  if (BIND_TTL_SECONDS_PATTERN.test(field)) {
    const seconds = Number(field);
    return seconds <= MAX_BIND_TTL_SECONDS ? seconds : null;
  }
  if (!BIND_TTL_DURATION_PATTERN.test(field)) return null;

  let total = 0;
  for (const match of field.matchAll(/(\d+)([smhdwSMHDW])/gu)) {
    total += Number(match[1]) * BIND_TTL_UNIT_SECONDS[match[2].toLowerCase()];
    if (total > MAX_BIND_TTL_SECONDS) return null;
  }
  return total;
}

/** Read a 16-bit preference/priority, or `null` when the token is not one. */
function parsePreference(field: string): number | null {
  if (!/^\d+$/u.test(field)) return null;
  const value = Number(field);
  return value <= 65_535 ? value : null;
}

/**
 * Remove a trailing BIND comment from `line`.
 *
 * `;` only starts a comment *outside* a quoted `<character-string>`: inside one
 * it is ordinary data, and it is the field separator used by DMARC and DKIM
 * TXT values. A backslash escapes the following character (including a quote),
 * so it must not flip the quote state.
 */
function stripBINDComment(line: string): string {
  let inQuotes = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (character === ";" && !inQuotes) return line.slice(0, index);
  }
  return line;
}

/** A whitespace-separated field plus the offset just past it. */
type BINDField = { value: string; end: number };

/**
 * The most leading fields any zone line needs to be understood: the owner, a
 * `[ttl] [class]` prefix in either order, the type, and one lookahead for the
 * MX preference. Everything past that is RDATA and is sliced verbatim, so it
 * is never tokenised — a 64 KiB TXT record costs no field array.
 */
const MAX_BIND_LEADING_FIELDS = 6;

/**
 * Split the leading fields of `line` on whitespace, keeping each field's end
 * offset. At most `MAX_BIND_LEADING_FIELDS` fields are produced; the parser
 * only ever looks two fields past the type, so a truncated list is never
 * distinguishable from a complete one.
 */
function splitBINDFields(line: string): BINDField[] {
  const fields: BINDField[] = [];
  const pattern = /\S+/gu;
  let match: RegExpExecArray | null;
  while (
    fields.length < MAX_BIND_LEADING_FIELDS &&
    (match = pattern.exec(line)) !== null
  ) {
    fields.push({ value: match[0], end: match.index + match[0].length });
  }
  return fields;
}

/** The net `(` depth a line adds, and whether it held any grouping paren. */
type BINDParenScan = { delta: number; saw: boolean };

/**
 * Count the RFC 1035 §5.1 grouping parentheses in `line`.
 *
 * A paren inside a quoted `<character-string>` is data, and a backslash escapes
 * the character after it, so neither flips the state.
 */
function scanBINDParens(line: string): BINDParenScan {
  let inQuotes = false;
  let delta = 0;
  let saw = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (character === "(") {
      delta++;
      saw = true;
    } else if (character === ")") {
      delta--;
      saw = true;
    }
  }
  return { delta, saw };
}

/**
 * Flatten a logical line that used grouping parentheses.
 *
 * The parens are removed and every run of whitespace *outside* a quoted
 * `<character-string>` collapses to one space, so the continuation lines of a
 * parenthesised SOA arrive as ordinary RDATA fields. Whitespace inside a quoted
 * string is significant and is preserved exactly.
 */
function flattenGroupedRDATA(line: string): string {
  let flattened = "";
  let inQuotes = false;
  let pendingSpace = false;
  const separate = () => {
    if (pendingSpace && flattened) flattened += " ";
    pendingSpace = false;
  };

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === "\\") {
      separate();
      flattened += character + (line[index + 1] ?? "");
      index++;
      continue;
    }
    if (character === '"') {
      separate();
      inQuotes = !inQuotes;
      flattened += character;
      continue;
    }
    if (
      !inQuotes &&
      (character === "(" || character === ")" || /\s/u.test(character))
    ) {
      pendingSpace = true;
      continue;
    }
    separate();
    flattened += character;
  }
  return flattened;
}

/** One RFC 1035 §5.1 "line": physical lines joined across `( ... )`. */
type BINDLogicalLine = { text: string; indented: boolean };

/**
 * Fold `text` into logical zone lines.
 *
 * Comments are stripped per physical line (they run to end of line), blank and
 * comment-only lines are dropped, `$` directives are skipped whole, and lines
 * inside an open `(` are joined onto the line that opened it.
 *
 * `indented` records whether the *first* physical line began with whitespace,
 * which RFC 1035 §5.1 defines as "the owner is the same as the previous RR".
 * The text is deliberately not trimmed as a whole, because doing so would strip
 * that indentation from the very first line and change its meaning.
 */
function toBINDLogicalLines(text: string): BINDLogicalLine[] {
  const logical: BINDLogicalLine[] = [];
  let pending: BINDLogicalLine | null = null;
  let grouped = false;
  let depth = 0;

  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripBINDComment(raw);
    const trimmed = stripped.trim();

    if (pending === null) {
      // A directive is not a record. `$ORIGIN` and `$TTL` are short enough to
      // be dropped by any field-count rule, but `$GENERATE 1-10 host$ A ...`
      // is not, and used to be mis-parsed into a record named "$GENERATE".
      if (!trimmed || trimmed.startsWith("$")) continue;
      pending = { text: trimmed, indented: /^[ \t]/u.test(raw) };
      grouped = false;
    } else if (trimmed) {
      pending.text += ` ${trimmed}`;
    }

    const scan = scanBINDParens(stripped);
    if (scan.saw) grouped = true;
    depth += scan.delta;
    if (depth > 0) continue;
    depth = 0;

    if (grouped) pending.text = flattenGroupedRDATA(pending.text);
    logical.push(pending);
    pending = null;
  }

  // An unterminated `(` still yields the record it opened rather than nothing.
  if (pending) {
    logical.push({
      text: flattenGroupedRDATA(pending.text),
      indented: pending.indented,
    });
  }
  return logical;
}

/**
 * Parse a BIND zone file snippet into a list of DNS records.
 *
 * The accepted line is RFC 1035 §5.1's `[<owner>] [<ttl>] [<class>] <type>
 * <rdata>`: the TTL and the class are both optional and may appear in either
 * order, the TTL may use BIND's duration suffixes (`1h`, `2d`, `1w12h`), the
 * type mnemonic is case-insensitive and is normalised to upper case, and an
 * owner elided as leading whitespace is inherited from the previous record.
 * Physical lines joined by `( ... )` are folded into one logical line first.
 *
 * RDATA is sliced verbatim, so quoted `<character-string>` values (TXT, SPF,
 * DKIM, DMARC) survive with their internal semicolons, spacing and escapes
 * intact. The one exception is a line that used grouping parentheses, where the
 * parens are removed and unquoted whitespace runs collapse to a single space —
 * the continuation lines have no other meaningful spacing to preserve.
 *
 * This is still deliberately not a full RFC 1035 implementation. `$ORIGIN`,
 * `$TTL`, `$INCLUDE` and `$GENERATE` are skipped rather than interpreted, so
 * relative owner names and `@` arrive exactly as written and are not qualified
 * against an origin. A line that cannot be read as a record is dropped rather
 * than guessed at; genuinely malformed *RDATA* is still passed through whole,
 * because the write-time validator is the component that judges it.
 */
export function parseBINDZone(text: string): Partial<DNSRecord>[] {
  const records: Partial<DNSRecord>[] = [];
  let previousOwner: string | undefined;

  for (const line of toBINDLogicalLines(text)) {
    const fields = splitBINDFields(line.text);

    let name: string;
    let cursor: number;
    if (line.indented) {
      // RFC 1035 §5.1: a line beginning with a blank keeps the previous owner.
      // Without one there is nothing to inherit, so the line is dropped rather
      // than having its TTL silently promoted to an owner name.
      if (previousOwner === undefined) continue;
      name = previousOwner;
      cursor = 0;
    } else {
      if (fields.length < 2) continue;
      name = fields[0].value;
      cursor = 1;
    }

    let ttl = DEFAULT_BIND_TTL;
    let sawTTL = false;
    let sawClass = false;
    // TTL and class are both optional and may appear in either order. Only a
    // field with a successor can be one of them: the last field is the RDATA.
    while (fields[cursor + 1] !== undefined) {
      const field = fields[cursor].value;
      if (!sawTTL) {
        const seconds = parseBINDTTL(field);
        if (seconds !== null) {
          ttl = seconds;
          sawTTL = true;
          cursor++;
          continue;
        }
      }
      if (!sawClass && BIND_CLASSES.has(field.toUpperCase())) {
        sawClass = true;
        cursor++;
        continue;
      }
      break;
    }

    const typeField = fields[cursor];
    if (!typeField || !BIND_TYPE_PATTERN.test(typeField.value)) continue;
    // RFC 1035 §5.1 mnemonics are case-insensitive; BIND, NSD and PowerDNS all
    // emit them in either case, so the type is folded to the canonical form.
    const type = typeField.value.toUpperCase();

    let contentStart = cursor;
    let priority: number | undefined;
    if (type === "MX" && fields[cursor + 2] !== undefined) {
      const preference = parsePreference(fields[cursor + 1].value);
      if (preference !== null) {
        priority = preference;
        contentStart = cursor + 1;
      }
    }

    const content = line.text.slice(fields[contentStart].end).trim();
    // A record with no RDATA is not a record. `example.com. 3600 IN` reaches
    // here with "IN" read as the type, and is dropped instead of retained.
    if (!content) continue;

    const record: Partial<DNSRecord> = { name, ttl, type, content };
    if (priority !== undefined) record.priority = priority;
    records.push(record);
    previousOwner = name;
  }

  return records;
}

export const parseSRV = (content?: string) => {
  if (!content)
    return {
      priority: undefined,
      weight: undefined,
      port: undefined,
      target: "",
    };
  const parts = String(content).trim().split(/\s+/);
  if (parts.length < 4)
    return {
      priority: undefined,
      weight: undefined,
      port: undefined,
      target: content,
    };
  const [priority, weight, port, ...rest] = parts;
  return {
    priority: Number(priority),
    weight: Number(weight),
    port: Number(port),
    target: rest.join(" "),
  };
};

export const composeSRV = (p?: number, w?: number, prt?: number, t?: string) =>
  `${p ?? 0} ${w ?? 0} ${prt ?? 0} ${t ?? ""}`;

export const parseTLSA = (content?: string) => {
  if (!content)
    return {
      usage: undefined,
      selector: undefined,
      matchingType: undefined,
      data: "",
    };
  const parts = String(content).trim().split(/\s+/);
  if (parts.length < 4)
    return {
      usage: undefined,
      selector: undefined,
      matchingType: undefined,
      data: content,
    };
  const [usage, selector, matchingType, ...rest] = parts;
  return {
    usage: Number(usage),
    selector: Number(selector),
    matchingType: Number(matchingType),
    data: rest.join(" "),
  };
};

export const composeTLSA = (u?: number, s?: number, m?: number, d?: string) =>
  `${u ?? 0} ${s ?? 0} ${m ?? 0} ${d ?? ""}`;

export const parseSSHFP = (content?: string) => {
  if (!content)
    return { algorithm: undefined, fptype: undefined, fingerprint: "" };
  const parts = String(content).trim().split(/\s+/);
  if (parts.length < 3)
    return { algorithm: undefined, fptype: undefined, fingerprint: content };
  const [algorithm, fptype, ...rest] = parts;
  return {
    algorithm: Number(algorithm),
    fptype: Number(fptype),
    fingerprint: rest.join(" "),
  };
};

export const composeSSHFP = (a?: number, f?: number, fp?: string) =>
  `${a ?? 0} ${f ?? 0} ${fp ?? ""}`;

const MAX_NAPTR_INPUT_LENGTH = 16_384;
const MAX_NAPTR_TOKEN_LENGTH = 4_096;
const NAPTR_FIELD_COUNT = 6;

const emptyNAPTR = () => ({
  order: undefined,
  preference: undefined,
  flags: "",
  service: "",
  regexp: "",
  replacement: "",
});

const isUnsafeRawControl = (character: string) => {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
};

const splitNaptrTokens = (input: string): string[] | null => {
  if (input.length > MAX_NAPTR_INPUT_LENGTH) return null;

  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let tokenStarted = false;

  const append = (value: string) => {
    current += value;
    return current.length <= MAX_NAPTR_TOKEN_LENGTH;
  };

  const finishToken = () => {
    if (!tokenStarted) return true;
    if (tokens.length >= NAPTR_FIELD_COUNT) return false;
    tokens.push(current);
    current = "";
    tokenStarted = false;
    return true;
  };

  for (let index = 0; index < input.length; index++) {
    const character = input[index] ?? "";
    if (!inQuote && /\s/u.test(character)) {
      if (!finishToken()) return null;
      continue;
    }
    if (character === '"') {
      inQuote = !inQuote;
      tokenStarted = true;
      continue;
    }

    if (character === "\\") {
      if (index + 1 >= input.length) return null;
      const decimalEscape = input.slice(index + 1, index + 4);
      if (/^[0-9]{3}$/u.test(decimalEscape)) {
        const octet = Number.parseInt(decimalEscape, 10);
        if (octet > 255) return null;
        const escapedValue =
          tokens.length === NAPTR_FIELD_COUNT - 1
            ? `\\${decimalEscape}`
            : String.fromCharCode(octet);
        if (!append(escapedValue)) return null;
        tokenStarted = true;
        index += 3;
        continue;
      }

      index++;
      const escapedCharacter = input[index] ?? "";
      if (
        !append(
          tokens.length === NAPTR_FIELD_COUNT - 1
            ? `\\${escapedCharacter}`
            : escapedCharacter,
        )
      ) {
        return null;
      }
      tokenStarted = true;
      continue;
    }

    if (
      isUnsafeRawControl(character) ||
      (inQuote && (character === "\u2028" || character === "\u2029"))
    ) {
      return null;
    }
    if (!append(character)) return null;
    tokenStarted = true;
  }

  if (inQuote || !finishToken()) return null;
  return tokens;
};

export const parseNAPTR = (content?: string) => {
  if (!content) return emptyNAPTR();
  const input = String(content);
  if (input.length > MAX_NAPTR_INPUT_LENGTH) return emptyNAPTR();
  const tokens = splitNaptrTokens(input);
  if (!tokens || tokens.length !== NAPTR_FIELD_COUNT) return emptyNAPTR();
  const [order, preference, flags, service, regexp, replacement] = tokens;
  if (serializeNaptrReplacement(replacement) === null) return emptyNAPTR();
  return {
    order: Number(order),
    preference: Number(preference),
    flags,
    service,
    regexp,
    replacement,
  };
};

const serializeNaptrCharacterString = (value?: string): string | null => {
  const input = value ?? "";
  if (input.length > MAX_NAPTR_TOKEN_LENGTH) return null;
  // An empty <character-string> must still occupy its field as `""`, otherwise
  // the record collapses to five tokens and stops parsing.
  if (!input) return '""';

  let serialized = "";
  let needsQuotes = false;
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\\") {
      serialized += "\\\\";
      needsQuotes = true;
    } else if (character === '"') {
      serialized += '\\"';
      needsQuotes = true;
    } else if (isUnsafeRawControl(character)) {
      serialized += `\\${codePoint.toString(10).padStart(3, "0")}`;
      needsQuotes = true;
    } else if (/\s/u.test(character)) {
      if (character !== " ") {
        if (codePoint > 255) return null;
        serialized += `\\${codePoint.toString(10).padStart(3, "0")}`;
      } else {
        serialized += character;
      }
      needsQuotes = true;
    } else {
      serialized += character;
    }
  }
  return needsQuotes ? `"${serialized}"` : serialized;
};

function serializeNaptrReplacement(value?: string): string | null {
  const replacement = value ?? "";
  if (replacement.length > MAX_NAPTR_TOKEN_LENGTH) return null;
  let serialized = "";
  for (let index = 0; index < replacement.length; index++) {
    const character = replacement[index] ?? "";
    if (character === "\\") {
      if (index + 1 >= replacement.length) return null;
      const decimalEscape = replacement.slice(index + 1, index + 4);
      if (/^[0-9]{3}$/u.test(decimalEscape)) {
        if (Number.parseInt(decimalEscape, 10) > 255) return null;
        serialized += `\\${decimalEscape}`;
        index += 3;
        continue;
      }

      const escapedCharacter = replacement[index + 1] ?? "";
      if (
        /^[0-9]$/u.test(escapedCharacter) ||
        isUnsafeRawControl(escapedCharacter) ||
        escapedCharacter === "\u2028" ||
        escapedCharacter === "\u2029"
      ) {
        return null;
      }
      serialized += `\\${escapedCharacter}`;
      index++;
      continue;
    }
    if (
      /\s/u.test(character) ||
      isUnsafeRawControl(character) ||
      character === '"'
    ) {
      return null;
    }
    serialized += character;
  }
  return serialized;
}

export const composeNAPTR = (
  o?: number,
  p?: number,
  f?: string,
  s?: string,
  r?: string,
  rep?: string,
) => {
  const flags = serializeNaptrCharacterString(f);
  const service = serializeNaptrCharacterString(s);
  const regexp = serializeNaptrCharacterString(r);
  const replacement = serializeNaptrReplacement(rep);
  if (
    flags === null ||
    service === null ||
    regexp === null ||
    replacement === null
  ) {
    return "";
  }
  return `${o ?? 0} ${p ?? 0} ${flags} ${service} ${regexp} ${replacement}`;
};
