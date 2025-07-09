import type { DNSRecord, Zone } from '@/types/dns';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareAPI {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const { signal, ...rest } = options;
    const response = await fetch(`${CLOUDFLARE_API_BASE}${endpoint}`, {
      ...rest,
      signal,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ errors: [{ message: 'Unknown error' }] }));
      throw new Error(error.errors?.[0]?.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.errors?.[0]?.message || 'API request failed');
    }

    return data.result as T;
  }

  async getZones(signal?: AbortSignal): Promise<Zone[]> {
    return this.request<Zone[]>('/zones', { signal });
  }

  async getDNSRecords(zoneId: string, signal?: AbortSignal): Promise<DNSRecord[]> {
    return this.request<DNSRecord[]>(`/zones/${zoneId}/dns_records`, { signal });
  }

  async createDNSRecord(zoneId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> {
    return this.request<DNSRecord>(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(record),
      signal,
    });
  }

  async updateDNSRecord(zoneId: string, recordId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> {
    return this.request<DNSRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      body: JSON.stringify(record),
      signal,
    });
  }

  async deleteDNSRecord(zoneId: string, recordId: string, signal?: AbortSignal): Promise<void> {
    await this.request<void>(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE',
      signal,
    });
  }

  async verifyToken(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request<void>('/user/tokens/verify', { signal });
      return true;
    } catch {
      return false;
    }
  }
}
