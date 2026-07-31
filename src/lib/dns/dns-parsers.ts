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
    if (ttlVal) record.ttl = ttlVal === "auto" ? "auto" : Number(ttlVal);

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
    if (!line || line.startsWith(";")) continue;
    const noComment = line.split(";")[0].trim();
    const parts = noComment.split(/\s+/);
    if (parts.length < 4) continue;
    const [name, ttlStr, , type, ...rest] = parts;
    const ttl = Number(ttlStr) || 300;
    let priority: number | undefined;
    let contentParts = rest;
    if (type.toUpperCase() === "MX" && rest.length >= 2) {
      priority = Number(rest[0]);
      contentParts = rest.slice(1);
    }
    const record: Partial<DNSRecord> = {
      name,
      ttl,
      type,
      content: contentParts.join(" "),
    };
    if (priority !== undefined) record.priority = priority;
    records.push(record);
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
  if (!input) return "";

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
