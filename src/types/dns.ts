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

export interface Zone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  development_mode: number;
}

export const ENCRYPTION_ALGORITHMS = ['AES-GCM', 'AES-CBC'] as const;
export type EncryptionAlgorithm = typeof ENCRYPTION_ALGORITHMS[number];

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
