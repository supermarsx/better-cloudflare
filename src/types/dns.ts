/**
 * Representation of a DNS record returned by Cloudflare or used by the
 * application to create/update records. Fields mirror the Cloudflare
 * API shape.
 */
export interface DNSRecord {
  /** Unique identifier for the DNS record */
  id: string;
  /** Record type, e.g., A, AAAA, CNAME */
  type: string;
  /** Record name (hostname or '@' for root) */
  name: string;
  /** Record content (IP, host, text, etc.) */
  content: string;
  /** Time-to-live in seconds or 'auto' */
  ttl: number | "auto";
  /** Optional priority (used for MX records) */
  priority?: number;
  /** Whether Cloudflare proxy is enabled for the record (A/AAAA/CNAME) */
  proxied?: boolean;
  /** Cloudflare zone id associated with this record */
  zone_id: string;
  /** Zone name associated with this record */
  zone_name: string;
  /** ISO timestamp for when the record was created */
  created_on: string;
  /** ISO timestamp for the last modification */
  modified_on: string;
}

/**
 * Cloudflare Zone representation exposing id, name, and administrative
 * flags such as `paused` and `development_mode`.
 */
export interface Zone {
  /** Cloudflare zone id */
  id: string;
  /** Zone name, typically the domain */
  name: string;
  /** Zone status (active, pending, etc.) */
  status: string;
  /** Whether the zone is paused on Cloudflare */
  paused: boolean;
  /** Zone type (e.g., 'full') */
  type: string;
  /** Development mode flag (in seconds or 0) */
  development_mode: number;
}

/**
 * Supported encryption algorithms used by the CryptoManager when encrypting
 * API keys in storage. AES-GCM is preferred for authenticated encryption.
 */
export const ENCRYPTION_ALGORITHMS = ["AES-GCM", "AES-CBC"] as const;
export type EncryptionAlgorithm = (typeof ENCRYPTION_ALGORITHMS)[number];

/**
 * Stored API key metadata used by the StorageManager. The `encryptedKey`
 * is base64-encoded ciphertext; salt and iv are used for decryption and
 * the algorithm/iterations/keyLength describe the key derivation config.
 */
export interface ApiKey {
  /** Locally generated id for the stored API key */
  id: string;
  /** A friendly label for the api key */
  label: string;
  /** Base64-encoded ciphertext of the API key */
  encryptedKey: string;
  /** Base64-encoded PBKDF2 salt used for this key */
  salt: string;
  /** Base64-encoded IV used for encryption */
  iv: string;
  /** Number of PBKDF2 iterations used when the key was created */
  iterations: number;
  /** Key length in bits */
  keyLength: number;
  /** Encryption algorithm used for this key */
  algorithm: EncryptionAlgorithm;
  /** ISO timestamp when the key was created */
  createdAt: string;
  /** Optional email for global API key authentication */
  email?: string;
}

/**
 * Configuration for PBKDF2 and derived key material used for encryption
 * operations. Iterations and keyLength affect security / performance tradeoffs.
 */
export interface EncryptionConfig {
  iterations: number;
  keyLength: number;
  algorithm: EncryptionAlgorithm;
}
export const RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "TXT",
  "SRV",
  "NS",
  "PTR",
  "CAA",
  "DS",
  "DNSKEY",
  "NAPTR",
  "SSHFP",
  "TLSA",
  "HINFO",
  "LOC",
  "SPF",
  "RP",
  "DNAME",
  "CERT",
  "CDNSKEY",
  "AFSDB",
  "APL",
  "DCHID",
  "HIP",
  "IPSECKEY",
  "NSEC",
  "RRSIG",
  "SOA",
  "SVCB",
  "HTTPS",
  "URI",
  "ALIAS",
  "ANAME",
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

/** Human-friendly labels for record types used in UI dropdowns */
export const RECORD_TYPE_LABELS: Record<RecordType, string> = {
  A: "A (IPv4 address)",
  AAAA: "AAAA (IPv6 address)",
  CNAME: "CNAME (alias)",
  MX: "MX (mail exchange)",
  TXT: "TXT (text)",
  SRV: "SRV (service record)",
  NS: "NS (name server)",
  PTR: "PTR (pointer)",
  CAA: "CAA (cert authority allowed)",
  DS: "DS (delegation signer)",
  DNSKEY: "DNSKEY (DNS public key)",
  NAPTR: "NAPTR (naming authority pointer)",
  SSHFP: "SSHFP (SSH fingerprint)",
  TLSA: "TLSA (TLS authentication)",
  HINFO: "HINFO (host info)",
  LOC: "LOC (location)",
  SPF: "SPF (SPF text)",
  RP: "RP (responsible person)",
  DNAME: "DNAME (delegation name)",
  CERT: "CERT (certificates)",
  CDNSKEY: "CDNSKEY (child DNSKEY)",
  AFSDB: "AFSDB (Andrew File System DB)",
  APL: "APL (address prefix list)",
  DCHID: "DCHID (DHCP identifier)",
  HIP: "HIP (Host Identity Protocol)",
  IPSECKEY: "IPSECKEY (IPsec key)",
  NSEC: "NSEC (next secure record)",
  RRSIG: "RRSIG (DNSSEC signature)",
  SOA: "SOA (start of authority)",
  SVCB: "SVCB (service binding)",
  HTTPS: "HTTPS (http service binding)",
  URI: "URI (URI record)",
  ALIAS: "ALIAS (alias)",
  ANAME: "ANAME (apex alias)",
};

export function getRecordTypeLabel(type: RecordType) {
  return RECORD_TYPE_LABELS[type] ?? (String(type) as string);
}

/**
 * Supported record types used across the UI and validation schema.
 */

/**
 * TTL presets used in the UI for quick selection (seconds or 'auto')
 */
// Default TTL presets (seconds), `auto` preserved for Cloudflare's automatic setting.
export const TTL_PRESETS = [
  "auto",
  60,
  120,
  300,
  900,
  1800,
  3600,
  14400,
  43200,
  86400,
  604800,
] as const;
export type TTLValue = number | "auto";

function parsePresets(presetsStr: string): (number | "auto")[] {
  // Accept JSON array or comma-separated list
  try {
    const parsed = JSON.parse(presetsStr);
    if (Array.isArray(parsed))
      return parsed.map((p) => (p === "auto" ? "auto" : Number(p)));
  } catch {
    // not a JSON array; try comma-separated
  }
  return presetsStr.split(",").map((p) => {
    const v = p.trim();
    if (v.toLowerCase() === "auto") return "auto";
    const n = Number(v);
    return Number.isNaN(n) ? 300 : n;
  });
}

export function getTTLPresets(): TTLValue[] {
  // Client build environment (Vite) has `import.meta.env`; server has process.env
  let envVal: string | undefined;
  // import.meta may be available when the code is bundled by Vite. Use a
  // safe typed access to avoid linting and TS errors in environments where
  // import.meta is undefined.
  if (typeof import.meta !== "undefined") {
    const meta = import.meta as { env?: Record<string, string> } | undefined;
    if (meta?.env) {
      envVal = meta.env.VITE_TTL_PRESETS;
    }
  }
  if (!envVal) envVal = process.env.TTL_PRESETS || process.env.VITE_TTL_PRESETS;
  if (!envVal) {
    // Return a properly-typed copy of the readonly TTL_PRESETS
    return TTL_PRESETS.map((v) =>
      v === "auto" ? "auto" : Number(v),
    ) as TTLValue[];
  }
  try {
    return parsePresets(envVal);
  } catch {
    return TTL_PRESETS.map((v) =>
      v === "auto" ? "auto" : Number(v),
    ) as TTLValue[];
  }
}
