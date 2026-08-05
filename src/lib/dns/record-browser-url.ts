import type { DNSRecord } from "@/types/dns";

const BROWSABLE_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"]);
const FORBIDDEN_HOST_CHARACTERS = /[\s_*\\/?:#@]/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function trimDnsName(value: string): string {
  return value.trim().replace(/\.+$/, "");
}

function canonicalDnsHostname(value: string): string | null {
  const candidate = trimDnsName(value);
  if (
    !candidate ||
    candidate.length > 253 ||
    containsControlCharacters(candidate) ||
    FORBIDDEN_HOST_CHARACTERS.test(candidate)
  ) {
    return null;
  }

  try {
    const parsed = new URL(`https://${candidate}/`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    const labels = hostname.split(".");
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      hostname.length > 253 ||
      labels.some((label) => !HOST_LABEL.test(label))
    ) {
      return null;
    }
    return hostname;
  } catch {
    return null;
  }
}

function resolveOwnerHostname(name: string, zone: string | null): string | null {
  const owner = trimDnsName(name);
  if (!owner || owner === "@") return zone;

  const canonicalOwner = canonicalDnsHostname(owner);
  if (!canonicalOwner) return null;
  if (!zone) return canonicalOwner;
  if (canonicalOwner === zone || canonicalOwner.endsWith(`.${zone}`)) {
    return canonicalOwner;
  }
  return canonicalDnsHostname(`${canonicalOwner}.${zone}`);
}

function strictIPv4(value: string): string | null {
  const candidate = value.trim();
  const parts = candidate.split(".");
  if (parts.length !== 4) return null;
  if (
    parts.some((part) => {
      if (!/^\d{1,3}$/.test(part)) return true;
      if (part.length > 1 && part.startsWith("0")) return true;
      const octet = Number(part);
      return !Number.isInteger(octet) || octet < 0 || octet > 255;
    })
  ) {
    return null;
  }
  return parts.join(".");
}

function strictIPv6Url(value: string): string | null {
  let candidate = value.trim();
  if (candidate.startsWith("[") && candidate.endsWith("]")) {
    candidate = candidate.slice(1, -1);
  } else if (candidate.includes("[") || candidate.includes("]")) {
    return null;
  }
  if (
    !candidate.includes(":") ||
    containsControlCharacters(candidate) ||
    /[\s%/?#@]/.test(candidate)
  ) {
    return null;
  }

  try {
    const parsed = new URL(`https://[${candidate}]/`);
    return parsed.href;
  } catch {
    return null;
  }
}

function httpsHostnameUrl(hostname: string): string {
  return new URL(`https://${hostname}/`).href;
}

export function getRecordBrowserUrl(
  record: DNSRecord,
  zoneName?: string,
): string | null {
  const type = record.type.toUpperCase();
  if (!BROWSABLE_RECORD_TYPES.has(type)) return null;

  const zone =
    canonicalDnsHostname(zoneName ?? "") ??
    canonicalDnsHostname(record.zone_name ?? "");
  const owner = resolveOwnerHostname(record.name, zone);
  if (owner) return httpsHostnameUrl(owner);

  if (type === "A") {
    const address = strictIPv4(record.content);
    return address ? `https://${address}/` : null;
  }
  if (type === "AAAA") return strictIPv6Url(record.content);

  const cnameTarget = canonicalDnsHostname(record.content);
  return cnameTarget ? httpsHostnameUrl(cnameTarget) : null;
}
