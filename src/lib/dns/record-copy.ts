import type { DNSRecord } from "@/types/dns";

import { parseNAPTR } from "./dns-parsers";

export type PreparedCopiedDnsRecord = Pick<
  DNSRecord,
  "type" | "name" | "content" | "ttl"
> &
  Partial<Pick<DNSRecord, "comment" | "priority" | "proxied">>;

interface NormalizedZones {
  source: string;
  sourceLower: string;
  target: string;
}

interface TokenSpan {
  start: number;
  end: number;
  value: string;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

const WHOLE_HOSTNAME_CONTENT_TYPES = new Set([
  "CNAME",
  "MX",
  "NS",
  "PTR",
  "DNAME",
  "ALIAS",
  "ANAME",
]);

const ZONE_LABEL_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;
const DNS_LABEL_PATTERN = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?$/u;

function splitOuterWhitespace(value: string): {
  leading: string;
  core: string;
  trailing: string;
} {
  let start = 0;
  while (start < value.length && /\s/u.test(value[start] ?? "")) start++;

  let end = value.length;
  while (end > start && /\s/u.test(value[end - 1] ?? "")) end--;

  return {
    leading: value.slice(0, start),
    core: value.slice(start, end),
    trailing: value.slice(end),
  };
}

function isZoneName(value: string): boolean {
  if (!value || value.length > 253 || value.includes("..")) return false;
  const labels = value.split(".");
  return labels.every(
    (label) =>
      label.length > 0 && label.length <= 63 && ZONE_LABEL_PATTERN.test(label),
  );
}

function normalizeZone(value: string): string | null {
  const trimmed = value.trim();
  const withoutRootDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  return isZoneName(withoutRootDot) ? withoutRootDot : null;
}

function getNormalizedZones(
  sourceZoneName: string,
  targetZoneName: string,
): NormalizedZones | null {
  const source = normalizeZone(sourceZoneName);
  const target = normalizeZone(targetZoneName);
  if (!source || !target || source.toLowerCase() === target.toLowerCase()) {
    return null;
  }
  return { source, sourceLower: source.toLowerCase(), target };
}

function isDnsReference(value: string): boolean {
  if (!value || value.length > 253 || value.includes("..")) return false;
  const labels = value.split(".");
  return labels.every((label, index) => {
    if (label === "*" && index === 0) return true;
    return (
      label.length > 0 && label.length <= 63 && DNS_LABEL_PATTERN.test(label)
    );
  });
}

function rewriteSuffix(
  value: string,
  zones: NormalizedZones,
  validateDnsReference: boolean,
): string {
  const { leading, core, trailing } = splitOuterWhitespace(value);
  if (!core || core === "@" || core === "." || core.endsWith("..")) {
    return value;
  }

  const hasRootDot = core.endsWith(".");
  const bare = hasRootDot ? core.slice(0, -1) : core;
  if (validateDnsReference && !isDnsReference(bare)) return value;

  const lower = bare.toLowerCase();
  let rewritten: string;
  if (lower === zones.sourceLower) {
    rewritten = zones.target;
  } else {
    const suffix = `.${zones.sourceLower}`;
    if (!lower.endsWith(suffix)) return value;
    rewritten = `${bare.slice(0, bare.length - zones.source.length)}${zones.target}`;
  }

  return `${leading}${rewritten}${hasRootDot ? "." : ""}${trailing}`;
}

function rewriteDnsName(value: string, zones: NormalizedZones): string {
  return rewriteSuffix(value, zones, true);
}

function scanTokens(value: string): TokenSpan[] | null {
  const tokens: TokenSpan[] = [];
  let index = 0;

  while (index < value.length) {
    while (index < value.length && /\s/u.test(value[index] ?? "")) index++;
    if (index >= value.length) break;

    const start = index;
    let quoted = false;
    while (index < value.length) {
      const character = value[index] ?? "";
      if (character === "\\") {
        if (index + 1 >= value.length) return null;
        index += 2;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        index++;
        continue;
      }
      if (!quoted && /\s/u.test(character)) break;
      index++;
    }
    if (quoted) return null;
    tokens.push({ start, end: index, value: value.slice(start, index) });
  }

  return tokens;
}

function replaceSpan(
  value: string,
  span: TokenSpan,
  replacement: string,
): string {
  return `${value.slice(0, span.start)}${replacement}${value.slice(span.end)}`;
}

function applyReplacements(value: string, replacements: Replacement[]): string {
  let result = value;
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start,
  )) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

function isUint16Token(value: string): boolean {
  if (!/^\d{1,5}$/u.test(value)) return false;
  return Number(value) <= 65_535;
}

function rewriteSrvContent(record: DNSRecord, zones: NormalizedZones): string {
  const tokens = scanTokens(record.content);
  if (!tokens) return record.content;

  let targetIndex: number | null = null;
  if (
    tokens.length === 4 &&
    tokens.slice(0, 3).every((token) => isUint16Token(token.value))
  ) {
    targetIndex = 3;
  } else if (
    record.priority !== undefined &&
    tokens.length === 3 &&
    tokens.slice(0, 2).every((token) => isUint16Token(token.value))
  ) {
    targetIndex = 2;
  }

  if (targetIndex === null) return record.content;
  const target = tokens[targetIndex];
  if (!target) return record.content;
  const rewritten = rewriteDnsName(target.value, zones);
  return rewritten === target.value
    ? record.content
    : replaceSpan(record.content, target, rewritten);
}

function rewriteAfsdbContent(content: string, zones: NormalizedZones): string {
  const tokens = scanTokens(content);
  if (
    !tokens ||
    tokens.length !== 2 ||
    !isUint16Token(tokens[0]?.value ?? "")
  ) {
    return content;
  }

  const target = tokens[1];
  if (!target) return content;
  const rewritten = rewriteDnsName(target.value, zones);
  return rewritten === target.value
    ? content
    : replaceSpan(content, target, rewritten);
}

function isValidSvcParam(value: string): boolean {
  const separator = value.indexOf("=");
  const key = separator === -1 ? value : value.slice(0, separator);
  return /^[A-Za-z0-9-]+$/u.test(key);
}

function rewriteSvcbContent(content: string, zones: NormalizedZones): string {
  const tokens = scanTokens(content);
  if (
    !tokens ||
    tokens.length < 2 ||
    !isUint16Token(tokens[0]?.value ?? "") ||
    !tokens.slice(2).every((token) => isValidSvcParam(token.value))
  ) {
    return content;
  }

  const target = tokens[1];
  if (!target) return content;
  const rewritten = rewriteDnsName(target.value, zones);
  return rewritten === target.value
    ? content
    : replaceSpan(content, target, rewritten);
}

function rewriteNaptrContent(content: string, zones: NormalizedZones): string {
  const parsed = parseNAPTR(content);
  const tokens = scanTokens(content);
  if (
    !tokens ||
    tokens.length !== 6 ||
    !Number.isInteger(parsed.order) ||
    !Number.isInteger(parsed.preference) ||
    (parsed.order ?? -1) < 0 ||
    (parsed.order ?? 65_536) > 65_535 ||
    (parsed.preference ?? -1) < 0 ||
    (parsed.preference ?? 65_536) > 65_535 ||
    !parsed.replacement
  ) {
    return content;
  }

  const replacementToken = tokens[5];
  if (!replacementToken) return content;
  const replacement = rewriteDnsName(replacementToken.value, zones);
  return replacement === replacementToken.value
    ? content
    : replaceSpan(content, replacementToken, replacement);
}

function isRpDomainField(value: string): boolean {
  if (value === ".") return true;
  const bare = value.endsWith(".") ? value.slice(0, -1) : value;
  return isDnsReference(bare);
}

function rewriteRpContent(content: string, zones: NormalizedZones): string {
  const tokens = scanTokens(content);
  if (
    !tokens ||
    tokens.length !== 2 ||
    !tokens.every((token) => isRpDomainField(token.value))
  ) {
    return content;
  }

  const replacements: Replacement[] = [];
  for (const token of tokens) {
    if (token.value === ".") continue;
    const rewritten = rewriteDnsName(token.value, zones);
    if (rewritten !== token.value) {
      replacements.push({
        start: token.start,
        end: token.end,
        value: rewritten,
      });
    }
  }
  return replacements.length
    ? applyReplacements(content, replacements)
    : content;
}

function decodeDnsCharacterString(
  value: string,
): { value: string; quoted: boolean } | null {
  if (!value.startsWith('"')) {
    return value.includes('"') || value.includes("\\")
      ? null
      : { value, quoted: false };
  }
  if (value.length < 2 || !value.endsWith('"')) return null;

  let decoded = "";
  const inner = value.slice(1, -1);
  for (let index = 0; index < inner.length; index++) {
    const character = inner[index] ?? "";
    if (character === '"') return null;
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    const escaped = inner[index + 1];
    if (escaped !== "\\" && escaped !== '"') return null;
    decoded += escaped;
    index++;
  }
  return { value: decoded, quoted: true };
}

function encodeDnsCharacterString(value: string, quoted: boolean): string {
  if (!quoted) return value;
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function rewriteHostPort(value: string, zones: NormalizedZones): string {
  if (!value || value.startsWith("[")) return value;
  const colon = value.lastIndexOf(":");
  let host = value;
  let port = "";
  if (colon !== -1) {
    if (
      value.indexOf(":") !== colon ||
      !/^\d+$/u.test(value.slice(colon + 1))
    ) {
      return value;
    }
    host = value.slice(0, colon);
    port = value.slice(colon);
  }
  const rewritten = rewriteDnsName(host, zones);
  return rewritten === host ? value : `${rewritten}${port}`;
}

function rewriteMailbox(
  value: string,
  zones: NormalizedZones,
): { value: string; valid: boolean } {
  const { leading, core, trailing } = splitOuterWhitespace(value);
  const at = core.lastIndexOf("@");
  if (at <= 0 || at === core.length - 1) return { value, valid: false };
  const domain = core.slice(at + 1);
  if (!isDnsReference(domain.endsWith(".") ? domain.slice(0, -1) : domain)) {
    return { value, valid: false };
  }
  const rewritten = rewriteDnsName(domain, zones);
  return {
    value: `${leading}${core.slice(0, at + 1)}${rewritten}${trailing}`,
    valid: true,
  };
}

function rewriteMailtoTarget(value: string, zones: NormalizedZones): string {
  const match = /^(mailto:)([^?#]*)([?#][\s\S]*)?$/iu.exec(value);
  if (!match) return value;
  const recipients = match[2] ?? "";
  const pieces = recipients.split(/(,)/u);
  const rewritten: string[] = [];
  for (const piece of pieces) {
    if (piece === ",") {
      rewritten.push(piece);
      continue;
    }
    const mailbox = rewriteMailbox(piece, zones);
    if (!mailbox.valid) return value;
    rewritten.push(mailbox.value);
  }
  return `${match[1]}${rewritten.join("")}${match[3] ?? ""}`;
}

function rewriteSipTarget(value: string, zones: NormalizedZones): string {
  const match = /^(sips?:)([^?#]*)([?#][\s\S]*)?$/iu.exec(value);
  if (!match) return value;
  const addressAndParams = match[2] ?? "";
  const parameterStart = addressAndParams.indexOf(";");
  const address =
    parameterStart === -1
      ? addressAndParams
      : addressAndParams.slice(0, parameterStart);
  const parameters =
    parameterStart === -1 ? "" : addressAndParams.slice(parameterStart);
  const at = address.lastIndexOf("@");
  const prefix = at === -1 ? "" : address.slice(0, at + 1);
  const hostPort = at === -1 ? address : address.slice(at + 1);
  if (!hostPort) return value;
  const rewritten = rewriteHostPort(hostPort, zones);
  return `${match[1]}${prefix}${rewritten}${parameters}${match[3] ?? ""}`;
}

function rewriteUriTarget(value: string, zones: NormalizedZones): string {
  if (!value || /\s/u.test(value)) return value;

  const authorityMatch =
    /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/u.exec(value);
  if (authorityMatch) {
    const authority = authorityMatch[2] ?? "";
    const at = authority.lastIndexOf("@");
    const prefix = at === -1 ? "" : authority.slice(0, at + 1);
    const hostPort = at === -1 ? authority : authority.slice(at + 1);
    if (!hostPort) return value;
    const rewritten = rewriteHostPort(hostPort, zones);
    return `${authorityMatch[1]}${prefix}${rewritten}${authorityMatch[3] ?? ""}`;
  }

  if (/^mailto:/iu.test(value)) return rewriteMailtoTarget(value, zones);
  if (/^sips?:/iu.test(value)) return rewriteSipTarget(value, zones);
  return value;
}

function rewriteUriContent(content: string, zones: NormalizedZones): string {
  const tokens = scanTokens(content);
  if (
    !tokens ||
    tokens.length !== 3 ||
    !isUint16Token(tokens[0]?.value ?? "") ||
    !isUint16Token(tokens[1]?.value ?? "")
  ) {
    return content;
  }

  const target = tokens[2];
  if (!target) return content;
  const decoded = decodeDnsCharacterString(target.value);
  if (!decoded) return content;
  const rewritten = rewriteUriTarget(decoded.value, zones);
  if (rewritten === decoded.value) return content;
  return replaceSpan(
    content,
    target,
    encodeDnsCharacterString(rewritten, decoded.quoted),
  );
}

function hasValidSpfMacros(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "%") continue;
    const next = value[index + 1];
    if (next === "%" || next === "_" || next === "-") {
      index++;
      continue;
    }
    if (next !== "{") return false;
    const end = value.indexOf("}", index + 2);
    if (end === -1) return false;
    const body = value.slice(index + 2, end);
    if (!/^[slodipvhrtc][0-9]*r?[.\-+,/_=]*$/iu.test(body)) return false;
    index = end;
  }
  return true;
}

function isValidSpfDomainSpec(value: string): boolean {
  const bare = value.endsWith(".") ? value.slice(0, -1) : value;
  return (
    !!bare &&
    !bare.includes("..") &&
    /^[\p{L}\p{N}._%{}+,\-=]+$/u.test(bare) &&
    hasValidSpfMacros(bare)
  );
}

function rewriteSpfDomainSpec(
  value: string,
  zones: NormalizedZones,
): string | null {
  if (!isValidSpfDomainSpec(value)) return null;
  return rewriteSuffix(value, zones, false);
}

function isValidDualCidr(value: string): boolean {
  if (!value) return true;
  const match = /^(?:\/(\d{1,3}))?(?:\/\/(\d{1,3}))?$/u.exec(value);
  if (!match) return false;
  const ipv4 = match[1] === undefined ? null : Number(match[1]);
  const ipv6 = match[2] === undefined ? null : Number(match[2]);
  return (ipv4 === null || ipv4 <= 32) && (ipv6 === null || ipv6 <= 128);
}

function rewriteSpfToken(
  token: string,
  zones: NormalizedZones,
): { value: string; valid: boolean } {
  const qualifierLength = /^[+~?-]/u.test(token) ? 1 : 0;
  const body = token.slice(qualifierLength);
  const lower = body.toLowerCase();
  let start = -1;
  let end = body.length;

  for (const prefix of ["include:", "exists:", "ptr:"]) {
    if (lower.startsWith(prefix)) {
      start = prefix.length;
      break;
    }
  }
  for (const prefix of ["redirect=", "exp="]) {
    if (lower.startsWith(prefix)) {
      start = prefix.length;
      break;
    }
  }
  if (lower.startsWith("a:") || lower.startsWith("mx:")) {
    start = body.indexOf(":") + 1;
    const cidrStart = body.indexOf("/", start);
    if (cidrStart !== -1) {
      if (!isValidDualCidr(body.slice(cidrStart))) {
        return { value: token, valid: false };
      }
      end = cidrStart;
    }
  }

  if (start === -1) return { value: token, valid: true };
  const domain = body.slice(start, end);
  const rewritten = rewriteSpfDomainSpec(domain, zones);
  if (rewritten === null) return { value: token, valid: false };
  if (rewritten === domain) return { value: token, valid: true };

  return {
    value: `${token.slice(0, qualifierLength + start)}${rewritten}${token.slice(
      qualifierLength + end,
    )}`,
    valid: true,
  };
}

function rewriteSpfContent(content: string, zones: NormalizedZones): string {
  const tokens = scanTokens(content);
  if (!tokens || tokens[0]?.value.toLowerCase() !== "v=spf1") return content;

  const replacements: Replacement[] = [];
  for (const token of tokens.slice(1)) {
    const rewritten = rewriteSpfToken(token.value, zones);
    if (!rewritten.valid) return content;
    if (rewritten.value !== token.value) {
      replacements.push({
        start: token.start,
        end: token.end,
        value: rewritten.value,
      });
    }
  }
  return replacements.length
    ? applyReplacements(content, replacements)
    : content;
}

function rewriteDmarcReportUri(
  value: string,
  zones: NormalizedZones,
): { value: string; valid: boolean } {
  const { leading, core, trailing } = splitOuterWhitespace(value);
  if (!core) return { value, valid: false };
  if (!/^mailto:/iu.test(core)) {
    return {
      value,
      valid: /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(core),
    };
  }

  const addressAndSuffix = core.slice("mailto:".length);
  const at = addressAndSuffix.lastIndexOf("@");
  if (at <= 0 || at === addressAndSuffix.length - 1) {
    return { value, valid: false };
  }
  const suffixCandidates = [
    addressAndSuffix.indexOf("!", at + 1),
    addressAndSuffix.indexOf("?", at + 1),
  ].filter((index) => index !== -1);
  const domainEnd = suffixCandidates.length
    ? Math.min(...suffixCandidates)
    : addressAndSuffix.length;
  const domain = addressAndSuffix.slice(at + 1, domainEnd);
  const bareDomain = domain.endsWith(".") ? domain.slice(0, -1) : domain;
  if (!isDnsReference(bareDomain)) return { value, valid: false };

  const suffix = addressAndSuffix.slice(domainEnd);
  if (suffix.startsWith("!") && !/^!\d+[kmgt]?$/iu.test(suffix)) {
    return { value, valid: false };
  }
  const rewritten = rewriteDnsName(domain, zones);
  return {
    value: `${leading}${core.slice(0, "mailto:".length + at + 1)}${rewritten}${suffix}${trailing}`,
    valid: true,
  };
}

function rewriteDmarcContent(content: string, zones: NormalizedZones): string {
  const segments = content.split(";");
  if (!/^\s*v\s*=\s*dmarc1\s*$/iu.test(segments[0] ?? "")) return content;

  let changed = false;
  const rewrittenSegments = [...segments];
  for (let index = 1; index < segments.length; index++) {
    const segment = segments[index] ?? "";
    const separator = segment.indexOf("=");
    if (separator === -1) continue;
    const key = segment.slice(0, separator).trim().toLowerCase();
    if (key !== "rua" && key !== "ruf") continue;

    const value = segment.slice(separator + 1);
    const pieces = value.split(/(,)/u);
    const output: string[] = [];
    for (const piece of pieces) {
      if (piece === ",") {
        output.push(piece);
        continue;
      }
      const rewritten = rewriteDmarcReportUri(piece, zones);
      if (!rewritten.valid) return content;
      changed ||= rewritten.value !== piece;
      output.push(rewritten.value);
    }
    rewrittenSegments[index] =
      `${segment.slice(0, separator + 1)}${output.join("")}`;
  }

  return changed ? rewrittenSegments.join(";") : content;
}

function rewriteRecordContent(
  record: DNSRecord,
  zones: NormalizedZones,
): string {
  const type = record.type.toUpperCase();
  if (WHOLE_HOSTNAME_CONTENT_TYPES.has(type)) {
    return rewriteDnsName(record.content, zones);
  }
  switch (type) {
    case "SRV":
      return rewriteSrvContent(record, zones);
    case "AFSDB":
      return rewriteAfsdbContent(record.content, zones);
    case "HTTPS":
    case "SVCB":
      return rewriteSvcbContent(record.content, zones);
    case "NAPTR":
      return rewriteNaptrContent(record.content, zones);
    case "RP":
      return rewriteRpContent(record.content, zones);
    case "URI":
      return rewriteUriContent(record.content, zones);
    case "SPF":
      return rewriteSpfContent(record.content, zones);
    case "TXT": {
      const spf = rewriteSpfContent(record.content, zones);
      return spf !== record.content
        ? spf
        : rewriteDmarcContent(record.content, zones);
    }
    default:
      return record.content;
  }
}

export function prepareCopiedDnsRecord(
  record: DNSRecord,
  sourceZoneName: string,
  targetZoneName: string,
  rewriteDomains: boolean,
): PreparedCopiedDnsRecord {
  const zones = rewriteDomains
    ? getNormalizedZones(sourceZoneName, targetZoneName)
    : null;
  const prepared: PreparedCopiedDnsRecord = {
    type: record.type,
    name: zones ? rewriteDnsName(record.name, zones) : record.name,
    content: zones ? rewriteRecordContent(record, zones) : record.content,
    ttl: record.ttl,
  };

  if (record.comment !== undefined) prepared.comment = record.comment;
  if (record.priority !== undefined) prepared.priority = record.priority;
  if (record.proxied !== undefined) prepared.proxied = record.proxied;
  return prepared;
}
