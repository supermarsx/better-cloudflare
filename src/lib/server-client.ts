import type { DNSRecord, Zone } from '@/types/dns';

const DEFAULT_BASE =
  (typeof process !== 'undefined' && process.env.SERVER_API_BASE) ||
  (typeof import.meta !== 'undefined'
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (import.meta as any).env?.VITE_SERVER_API_BASE
    : undefined) ||
  'http://localhost:8787/api';

function authHeaders(key: string, email?: string) {
  if (email) {
    return {
      'x-auth-key': key,
      'x-auth-email': email,
      'Content-Type': 'application/json',
    } as Record<string, string>;
  }
  return {
    authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  } as Record<string, string>;
}

export class ServerClient {
  constructor(
    private apiKey: string,
    private baseUrl: string = DEFAULT_BASE,
    private email?: string,
  ) {}

  private headers() {
    return authHeaders(this.apiKey, this.email);
  }

  async verifyToken(signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl}/verify-token`, {
      method: 'POST',
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new Error(await res.text());
  }

  async getZones(signal?: AbortSignal): Promise<Zone[]> {
    const res = await fetch(`${this.baseUrl}/zones`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async getDNSRecords(zoneId: string, signal?: AbortSignal): Promise<DNSRecord[]> {
    const res = await fetch(`${this.baseUrl}/zones/${zoneId}/dns_records`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async createDNSRecord(
    zoneId: string,
    record: Partial<DNSRecord>,
    signal?: AbortSignal,
  ): Promise<DNSRecord> {
    const res = await fetch(`${this.baseUrl}/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(record),
      signal,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async updateDNSRecord(
    zoneId: string,
    recordId: string,
    record: Partial<DNSRecord>,
    signal?: AbortSignal,
  ): Promise<DNSRecord> {
    const res = await fetch(`${this.baseUrl}/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(record),
      signal,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async deleteDNSRecord(
    zoneId: string,
    recordId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE',
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new Error(await res.text());
  }
}
