/**
 * Representation of a DNS record returned by Cloudflare or used by the
 * application to create/update records. Fields mirror the Cloudflare
 * API shape.
 */
export interface DNSRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number | 'auto';
  priority?: number;
  proxied?: boolean;
  zone_id: string;
  zone_name: string;
  created_on: string;
  modified_on: string;
}

/**
 * Cloudflare Zone representation exposing id, name, and administrative
 * flags such as `paused` and `development_mode`.
 */
export interface Zone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  development_mode: number;
}

/**
 * Supported encryption algorithms used by the CryptoManager when encrypting
 * API keys in storage. AES-GCM is preferred for authenticated encryption.
 */
export const ENCRYPTION_ALGORITHMS = ['AES-GCM', 'AES-CBC'] as const;
export type EncryptionAlgorithm = typeof ENCRYPTION_ALGORITHMS[number];

/**
 * Stored API key metadata used by the StorageManager. The `encryptedKey`
 * is base64-encoded ciphertext; salt and iv are used for decryption and
 * the algorithm/iterations/keyLength describe the key derivation config.
 */
export interface ApiKey {
  id: string;
  label: string;
  encryptedKey: string;
  salt: string;
  iv: string;
  iterations: number;
  keyLength: number;
  algorithm: EncryptionAlgorithm;
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
export type RecordType =
  | 'A'
  | 'AAAA'
  | 'CNAME'
  | 'MX'
  | 'TXT'
  | 'SRV'
  | 'NS'
  | 'PTR'
  | 'CAA';

export const RECORD_TYPES: RecordType[] = [
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'TXT',
  'SRV',
  'NS',
  'PTR',
  'CAA'
];

export const TTL_PRESETS = ['auto', 300, 900, 3600, 86400] as const;
export type TTLValue = typeof TTL_PRESETS[number];
