import type { DNSRecord, Zone } from '@/types/dns';
import { getEnv } from './env';

const DEFAULT_BASE =
  getEnv('SERVER_API_BASE', 'VITE_SERVER_API_BASE', 'http://localhost:8787/api')!;

function authHeaders(key: string, email?: string): HeadersInit {
  if (email) {
    return {
      'x-auth-key': key,
      'x-auth-email': email,
      'Content-Type': 'application/json',
    };
  }
  return {
    authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

export class ServerClient {
  constructor(
    private apiKey: string,
    private baseUrl: string = DEFAULT_BASE,
    private email?: string,
  ) {}

  private headers(): HeadersInit {
    return authHeaders(this.apiKey, this.email);
  }

  private async request<T>(
    endpoint: string,
    {
      method = 'GET',
      body,
      signal,
    }: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Request to ${endpoint} failed with ${res.status} ${res.statusText}: ${text}`,
      );
    }
    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return res.json();
    }
    return undefined as T;
  }

  async verifyToken(signal?: AbortSignal): Promise<void> {
    await this.request('/verify-token', { method: 'POST', signal });
  }

  async getZones(signal?: AbortSignal): Promise<Zone[]> {
    return this.request('/zones', { signal });
  }

  async getDNSRecords(zoneId: string, signal?: AbortSignal): Promise<DNSRecord[]> {
    return this.request(`/zones/${zoneId}/dns_records`, { signal });
  }

  async createDNSRecord(
    zoneId: string,
    record: Partial<DNSRecord>,
    signal?: AbortSignal,
  ): Promise<DNSRecord> {
    return this.request(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: record,
      signal,
    });
  }

  async updateDNSRecord(
    zoneId: string,
    recordId: string,
    record: Partial<DNSRecord>,
    signal?: AbortSignal,
  ): Promise<DNSRecord> {
    return this.request(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      body: record,
      signal,
    });
  }

  async deleteDNSRecord(
    zoneId: string,
    recordId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE',
      signal,
    });
  }
}
