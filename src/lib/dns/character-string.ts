/**
 * Helpers for DNS `<character-string>` RDATA (RFC 1035 §3.3, §5.1).
 *
 * Record types whose RDATA is built from character-strings (TXT, SPF, the
 * TXT-shaped helpers such as DKIM/DMARC, HINFO, NAPTR text fields and the CAA
 * value field) are written in *presentation format*: the payload may be bare,
 * wrapped in double quotes, or expressed as several adjacent quoted strings
 * that concatenate into one logical value.
 *
 * This module is the single place that understands that syntax:
 *
 * - {@link parseCharacterStrings} tolerantly decodes any of those shapes,
 *   repairing unmatched quotes instead of rejecting the input.
 * - {@link unquoteCharacterString} collapses the result into the logical value
 *   semantic parsers (SPF mechanisms, DMARC/DKIM tags, …) should look at.
 * - {@link normalizeCharacterString} serializes a value back into a thoroughly
 *   valid quoted form, escaping what must be escaped and splitting payloads
 *   longer than 255 *bytes* into adjacent quoted strings.
 */

/** Maximum size, in bytes, of a single DNS `<character-string>`. */
export const CHARACTER_STRING_MAX_BYTES = 255;

const DECIMAL_ESCAPE = /^[0-9]{3}$/u;

const isControlCodePoint = (codePoint: number) =>
  codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);

const utf8Size = (codePoint: number) => {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
};

/**
 * Size of `value` in UTF-8 bytes, which is what the 255 byte
 * `<character-string>` limit is measured in.
 */
export function characterStringByteLength(value: string | undefined): number {
  let size = 0;
  for (const character of value ?? "") {
    size += utf8Size(character.codePointAt(0) ?? 0);
  }
  return size;
}

/** Decode a single `\X` / `\DDD` escape starting at `index`. */
function decodeEscapeAt(input: string, index: number): [string, number] {
  const decimal = input.slice(index + 1, index + 4);
  if (DECIMAL_ESCAPE.test(decimal)) {
    const octet = Number.parseInt(decimal, 10);
    if (octet <= 255) return [String.fromCharCode(octet), index + 4];
  }
  const next = input[index + 1];
  if (next === undefined) return ["\\", index + 1];
  return [next, index + 2];
}

/** Decode every escape sequence in `value`. */
function decodeEscapes(value: string): string {
  if (!value.includes("\\")) return value;
  let decoded = "";
  let index = 0;
  while (index < value.length) {
    const character = value[index] ?? "";
    if (character === "\\") {
      const [text, next] = decodeEscapeAt(value, index);
      decoded += text;
      index = next;
      continue;
    }
    decoded += character;
    index++;
  }
  return decoded;
}

function scanQuotes(value: string): { count: number; lastIndex: number } {
  let count = 0;
  let lastIndex = -1;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === '"') {
      count++;
      lastIndex = index;
    }
  }
  return { count, lastIndex };
}

/**
 * True when `raw` contains an opening quote without its closing counterpart
 * (or the other way around). Such input is repaired rather than rejected.
 */
export function hasUnbalancedQuotes(raw: string | undefined): boolean {
  const trimmed = (raw ?? "").trim();
  return scanQuotes(trimmed).count % 2 === 1;
}

/**
 * True when `raw` uses the quoted presentation form, including the damaged
 * shapes with only a leading or only a trailing quote.
 */
export function isQuotedForm(raw: string | undefined): boolean {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('"')) return true;
  const { count, lastIndex } = scanQuotes(trimmed);
  return count % 2 === 1 && lastIndex === trimmed.length - 1;
}

/** Read one quoted run starting just after its opening quote. */
function scanQuotedRun(
  input: string,
  start: number,
): { value: string; end: number; closed: boolean } {
  let value = "";
  let index = start;
  while (index < input.length) {
    const character = input[index] ?? "";
    if (character === "\\") {
      const [text, next] = decodeEscapeAt(input, index);
      value += text;
      index = next;
      continue;
    }
    if (character === '"') return { value, end: index + 1, closed: true };
    value += character;
    index++;
  }
  // Unmatched opening quote: repair by closing the string at end of input.
  return { value, end: index, closed: false };
}

/** Read one bare (unquoted) run up to the next unescaped quote. */
function scanBareRun(
  input: string,
  start: number,
  stopOnWhitespace: boolean,
): { value: string; end: number } {
  let raw = "";
  let index = start;
  while (index < input.length) {
    const character = input[index] ?? "";
    if (character === '"') break;
    if (stopOnWhitespace && /\s/u.test(character)) break;
    if (character === "\\") {
      raw += input.slice(index, index + 2);
      index += 2;
      continue;
    }
    raw += character;
    index++;
  }
  return { value: decodeEscapes(raw).trim(), end: index };
}

/**
 * Parse presentation-format content into its logical character-strings.
 *
 * Accepted shapes, all decoded to the same logical value:
 * - bare: `v=spf1 include:_spf.example.com ~all` → one string, kept verbatim
 * - quoted: `"v=spf1 include:_spf.example.com ~all"`
 * - adjacent strings: `"part one" "part two"` → two strings
 * - unmatched leading or trailing quote → repaired
 *
 * Escaped quotes (`\"`), escaped backslashes (`\\`) and decimal escapes
 * (`\010`) inside a quoted run are decoded, never treated as delimiters.
 * Whitespace inside quotes is preserved exactly.
 */
export function parseCharacterStrings(raw: string | undefined): string[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];

  if (!trimmed.startsWith('"')) {
    // Bare content is a single character-string: whitespace does not split it.
    if (isQuotedForm(trimmed)) {
      // Unmatched trailing quote: repair by treating it as a quoted run.
      return [decodeEscapes(trimmed.slice(0, -1))];
    }
    return [trimmed];
  }

  const parts: string[] = [];
  let index = 0;
  while (index < trimmed.length) {
    const character = trimmed[index] ?? "";
    if (/\s/u.test(character)) {
      index++;
      continue;
    }
    if (character === '"') {
      const run = scanQuotedRun(trimmed, index + 1);
      index = run.end;
      if (run.closed || run.value) parts.push(run.value);
      continue;
    }
    const run = scanBareRun(trimmed, index, false);
    index = run.end;
    if (run.value) parts.push(run.value);
  }
  return parts;
}

/**
 * Parse presentation-format content into whitespace separated tokens, each of
 * which is an independent `<character-string>`.
 *
 * Unlike {@link parseCharacterStrings}, bare runs are split on whitespace.
 * Use this for records whose RDATA is a fixed list of character-strings, such
 * as HINFO (`"CPU" "OS"`).
 */
export function parseCharacterStringTokens(raw: string | undefined): string[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];

  const tokens: string[] = [];
  let index = 0;
  while (index < trimmed.length) {
    const character = trimmed[index] ?? "";
    if (/\s/u.test(character)) {
      index++;
      continue;
    }
    if (character === '"') {
      const run = scanQuotedRun(trimmed, index + 1);
      index = run.end;
      if (run.closed || run.value) tokens.push(run.value);
      continue;
    }
    const run = scanBareRun(trimmed, index, true);
    index = run.end;
    if (run.value) tokens.push(run.value);
  }
  return tokens;
}

/**
 * The logical value of presentation-format content: adjacent character-strings
 * concatenate without a separator, exactly like a resolver joins TXT strings.
 *
 * Semantic parsers (SPF, DMARC, DKIM, …) should call this before inspecting
 * the payload so quoted and unquoted input behave identically.
 */
export function unquoteCharacterString(raw: string | undefined): string {
  return parseCharacterStrings(raw).join("");
}

/**
 * Escape the characters that may not appear literally inside a quoted
 * `<character-string>`: `"` and `\` are backslash escaped and control
 * characters use the `\DDD` decimal form.
 */
export function escapeCharacterString(value: string | undefined): string {
  let escaped = "";
  for (const character of value ?? "") {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += '\\"';
    else if (isControlCodePoint(codePoint))
      escaped += `\\${codePoint.toString(10).padStart(3, "0")}`;
    else escaped += character;
  }
  return escaped;
}

/** Wrap a single logical value in quotes, escaping its contents. */
export function quoteCharacterString(value: string | undefined): string {
  return `"${escapeCharacterString(value)}"`;
}

/**
 * Split a logical value into chunks of at most `maxBytes` UTF-8 bytes without
 * ever splitting a code point. Returns an empty array for an empty value.
 */
export function splitCharacterString(
  value: string | undefined,
  maxBytes: number = CHARACTER_STRING_MAX_BYTES,
): string[] {
  const input = value ?? "";
  if (!input) return [];
  const limit = Math.max(1, Math.floor(maxBytes));

  const chunks: string[] = [];
  let current = "";
  let size = 0;
  for (const character of input) {
    const characterSize = utf8Size(character.codePointAt(0) ?? 0);
    if (current && size + characterSize > limit) {
      chunks.push(current);
      current = "";
      size = 0;
    }
    current += character;
    size += characterSize;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Serialize presentation-format content into a thoroughly valid quoted form.
 *
 * Quotes are balanced (a missing opening or closing quote is added), inner
 * quotes and backslashes are escaped, significant whitespace is preserved, and
 * payloads longer than 255 bytes become adjacent quoted character-strings.
 * Empty content normalizes to `""`.
 *
 * The result is stable: normalizing an already normalized value is a no-op.
 */
export function normalizeCharacterString(
  raw: string | undefined,
  options?: { maxBytes?: number },
): string {
  const value = unquoteCharacterString(raw);
  const chunks = splitCharacterString(
    value,
    options?.maxBytes ?? CHARACTER_STRING_MAX_BYTES,
  );
  if (!chunks.length) return '""';
  return chunks.map(quoteCharacterString).join(" ");
}

/** True when `raw` already equals its normalized serialization. */
export function isNormalizedCharacterString(
  raw: string | undefined,
  options?: { maxBytes?: number },
): boolean {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return false;
  return trimmed === normalizeCharacterString(trimmed, options);
}
