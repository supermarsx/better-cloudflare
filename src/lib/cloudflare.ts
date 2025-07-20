import 'cloudflare/shims/web';
import Cloudflare from 'cloudflare';
import type { DNSRecord, Zone } from '@/types/dns';

const DEFAULT_CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
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
      (typeof process !== 'undefined'
        ? process.env.CLOUDFLARE_API_BASE
        : undefined) ??
      (typeof import.meta !== 'undefined'
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (import.meta as any).env?.VITE_CLOUDFLARE_API_BASE
        : undefined) ??
      DEFAULT_CLOUDFLARE_API_BASE,
    email?: string,
  ) {
    this.client = new Cloudflare({
      apiToken: email ? null : apiKey,
      apiKey: email ? apiKey : null,
      apiEmail: email ?? null,
      baseURL: String(baseUrl),
      fetch: fetch,
    });
    if (DEBUG) {
      console.debug('Initialized CloudflareAPI', {
        baseUrl: this.client.baseURL,
        email: email ? 'provided' : 'none',
      });
    }
  }

  private debugRequest(path: string, options?: { method?: string; body?: unknown }) {
    if (!DEBUG) return;
    console.debug('CF API request:', {
      url: `${this.client.baseURL}${path}`,
      method: options?.method ?? 'GET',
      body: options?.body,
    });
  }

  private debugResponse(data: unknown) {
    if (!DEBUG) return;
    console.debug('CF API response:', data);
  }

  async getZones(signal?: AbortSignal): Promise<Zone[]> {
    if (DEBUG) console.debug('getZones');
    this.debugRequest('/zones');
    const zones: Zone[] = [];
    for await (const zone of this.client.zones.list({}, { signal })) {
      zones.push(zone as Zone);
    }
    this.debugResponse(zones);
    return zones;
  }

  async getDNSRecords(zoneId: string, signal?: AbortSignal): Promise<DNSRecord[]> {
    if (DEBUG) console.debug('getDNSRecords', { zoneId });
    this.debugRequest(`/zones/${zoneId}/dns_records`);
    const records: DNSRecord[] = [];
    for await (const record of this.client.dns.records.list({ zone_id: zoneId }, { signal })) {
      records.push(record as DNSRecord);
    }
    this.debugResponse(records);
    return records;
  }

  async createDNSRecord(zoneId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> {
    if (DEBUG) console.debug('createDNSRecord', { zoneId, record });
    this.debugRequest(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: record,
    });
    const params: Record<string, unknown> = {
      zone_id: zoneId,
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      priority: record.priority,
      proxied: record.proxied,
    };
    for (const key of Object.keys(params)) {
      if (params[key] === undefined) delete params[key];
    }
    const result = (await this.client.dns.records.create(params as any, { signal })) as DNSRecord;
    this.debugResponse(result);
    return result;
  }

  async updateDNSRecord(zoneId: string, recordId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> {
    if (DEBUG) console.debug('updateDNSRecord', { zoneId, recordId, record });
    this.debugRequest(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      body: record,
    });
    const params: Record<string, unknown> = {
      zone_id: zoneId,
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      priority: record.priority,
      proxied: record.proxied,
    };
    for (const key of Object.keys(params)) {
      if (params[key] === undefined) delete params[key];
    }
    const result = (await this.client.dns.records.update(recordId, params as any, { signal })) as DNSRecord;
    this.debugResponse(result);
    return result;
  }

  async deleteDNSRecord(zoneId: string, recordId: string, signal?: AbortSignal): Promise<void> {
    if (DEBUG) console.debug('deleteDNSRecord', { zoneId, recordId });
    this.debugRequest(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
    await this.client.dns.records.delete(recordId, { zone_id: zoneId }, { signal });
    this.debugResponse({ deleted: recordId });
  }

  async verifyToken(signal?: AbortSignal): Promise<void> {
    if (DEBUG) console.debug('verifyToken');
    this.debugRequest('/user/tokens/verify');
    await this.client.user.tokens.verify({ signal });
    this.debugResponse({ verified: true });
  }
}
