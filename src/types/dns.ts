export interface DNSRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
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

export interface ApiKey {
  id: string;
  label: string;
  encryptedKey: string;
  salt: string;
  iv: string;
  iterations: number;
  keyLength: number;
  algorithm: string;
  createdAt: string;
  /** Optional email for global API key authentication */
  email?: string;
}

export interface EncryptionConfig {
  iterations: number;
  keyLength: number;
  algorithm: string;
}
export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'NS' | 'PTR' | 'CAA';
