import 'cloudflare/shims/web';
import Cloudflare from 'cloudflare';
import type { DNSRecord, Zone } from '@/types/dns';

const DEFAULT_CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_PROXY_BASE = 'http://localhost:8787';
const DEBUG = Boolean(
  (typeof process !== 'undefined' ? process.env.DEBUG_CF_API : undefined) ||
    (typeof import.meta !== 'undefined'
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (import.meta as any).env?.VITE_DEBUG_CF_API
      : undefined)
);

export class CloudflareAPI {
  private client: Cloudflare;

  constructor(
    apiKey: string,
    baseUrl: string =
      (typeof import.meta !== 'undefined'
        ?
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (import.meta as any).env?.VITE_CLOUDFLARE_API_BASE
        : undefined) ??
      (((typeof import.meta !== 'undefined'
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (import.meta as any).env?.DEV
        : undefined) ||
        (typeof process !== 'undefined' && process.env.NODE_ENV === 'development')
      ? DEFAULT_PROXY_BASE
      : DEFAULT_CLOUDFLARE_API_BASE)),
    email?: string,
  ) {
    this.client = new Cloudflare({
      apiToken: email ? null : apiKey,
      apiKey: email ? apiKey : null,
      apiEmail: email ?? null,
      baseURL: String(baseUrl),
      fetch: fetch,
    });
  }

  private debugRequest(path: string, options?: { method?: string; body?: unknown }) {
    if (!DEBUG) return;
    console.debug('CF API request:', {
      url: `${this.client.baseURL}${path}`,
      method: options?.method ?? 'GET',
      body: options?.body,
    });
  }

  async getZones(signal?: AbortSignal): Promise<Zone[]> {
    const zones: Zone[] = [];
    for await (const zone of this.client.zones.list({}, { signal })) {
      zones.push(zone as Zone);
    }
    return zones;
  }

  async getDNSRecords(zoneId: string, signal?: AbortSignal): Promise<DNSRecord[]> {
    const records: DNSRecord[] = [];
    for await (const record of this.client.dns.records.list({ zone_id: zoneId }, { signal })) {
      records.push(record as DNSRecord);
    }
    return records;
  }

  async createDNSRecord(zoneId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> {
    this.debugRequest(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: record,
    });
    return (await this.client.dns.records.create({ zone_id: zoneId, ...(record as any) }, { signal })) as DNSRecord;
  }

  async updateDNSRecord(zoneId: string, recordId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> {
    this.debugRequest(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      body: record,
    });
    return (await this.client.dns.records.update(recordId, { zone_id: zoneId, ...(record as any) }, { signal })) as DNSRecord;
  }

  async deleteDNSRecord(zoneId: string, recordId: string, signal?: AbortSignal): Promise<void> {
    this.debugRequest(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
    await this.client.dns.records.delete(recordId, { zone_id: zoneId }, { signal });
  }

  async verifyToken(signal?: AbortSignal): Promise<void> {
    this.debugRequest('/user/tokens/verify');
    await this.client.user.tokens.verify({ signal });
  }
}
