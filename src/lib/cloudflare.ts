import type { DNSRecord, Zone } from '@/types/dns';

const DEFAULT_CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareAPI {
  private apiKey: string;
  private baseUrl: string;

  constructor(
    apiKey: string,
    baseUrl: string =
      (typeof import.meta !== 'undefined'
        ?
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (import.meta as any).env?.VITE_CLOUDFLARE_API_BASE
        : undefined) ?? DEFAULT_CLOUDFLARE_API_BASE,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl);
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const { signal, ...rest } = options;
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...rest,
      signal,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      let message = response.statusText;
      try {
        const error = await response.json();
        if (Array.isArray(error.errors) && error.errors.length) {
          message = error.errors[0].message || message;
        }
      } catch {
        // ignore JSON parse errors and use status text
      }
      throw new Error(message);
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
