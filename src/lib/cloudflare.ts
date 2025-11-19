/**
 * Cloudflare API wrapper
 *
 * This module provides a minimal wrapper around the Cloudflare SDK that
 * exposes the operations required by the application: listing zones and DNS
 * records, and creating/updating/deleting DNS records.
 *
 * It consolidates debug logging and request/response inspection behind a
 * DEBUG flag and re-exports a typed `CloudflareAPI` class with convenience
 * helper methods.
 */
import 'cloudflare/shims/web';
import Cloudflare from 'cloudflare';
import type { DNSRecord, Zone } from '@/types/dns';
import { getEnv, getEnvBool } from './env';

const DEFAULT_CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEBUG = getEnvBool('DEBUG_CF_API', 'VITE_DEBUG_CF_API');

/**
 * Client to interact with the Cloudflare REST API.
 *
 * The class wraps the official `cloudflare` library instance and exposes a
 * small, typed surface used by the app. Each method returns typed records or
 * throws on error.
 */
export class CloudflareAPI {
  private client: Cloudflare;

  /**
   * Create a Cloudflare API client for the given credentials.
   *
   * @param apiKey - API token or global API key
   * @param baseUrl - Optional Cloudflare API base (defaults to CLOUDFLARE_API_BASE)
   * @param email - Optional email for API key authentication (used with apiKey)
   */
  constructor(
    apiKey: string,
    baseUrl: string = getEnv(
      'CLOUDFLARE_API_BASE',
      'VITE_CLOUDFLARE_API_BASE',
      DEFAULT_CLOUDFLARE_API_BASE,
    )!,
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



  /**
   * Log the outgoing request when DEBUG is enabled.
   *
   * @param path - relative path of the request
   * @param options - optional request metadata such as method and body
   */
  private debugRequest(path: string, options?: { method?: string; body?: unknown }) {
    if (!DEBUG) return;
    console.debug('CF API request:', {
      url: `${this.client.baseURL}${path}`,
      method: options?.method ?? 'GET',
      body: options?.body,
    });
  }

  /**
   * Log the response payload when DEBUG is enabled.
   *
   * @param data - the response data to log
   */
  private debugResponse(data: unknown) {
    if (!DEBUG) return;
    console.debug('CF API response:', data);
  }

  /**
   * Build a Cloudflare-compatible parameter object for record creation and
   * update endpoints. Fields with `undefined` values are omitted.
   *
   * @param zoneId - Cloudflare zone identifier
   * @param record - partial DNSRecord with fields to send
   * @returns the params object suitable for the Cloudflare SDK
   */
  private buildRecordParams(zoneId: string, record: Partial<DNSRecord>) {
    const params: Record<string, unknown> = {
      zone_id: zoneId,
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl === 'auto' ? 1 : record.ttl,
      priority: record.priority,
      proxied: record.proxied,
    };
    for (const key of Object.keys(params)) {
      if (params[key] === undefined) delete params[key];
    }
    return params;
  }

  /**
   * List all zones available to the configured account/token.
   *
   * @param signal - optional AbortSignal to cancel the request
   * @returns an array of Zone objects
   */
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

  /**
   * List DNS records for a specific zone.
   *
   * @param zoneId - the id of the zone to list records for
   * @param signal - optional AbortSignal to cancel the request
   * @returns a list of DNSRecord objects
   */
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

  /**
   * Create a new DNS record in the specified zone.
   *
   * @param zoneId - the Cloudflare zone id
   * @param record - partial DNS record object with required fields
   * @param signal - optional AbortSignal to cancel the request
   * @returns the created DNSRecord
   */
  async createDNSRecord(zoneId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> {
    if (DEBUG) console.debug('createDNSRecord', { zoneId, record });
    this.debugRequest(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: record,
    });
    const params = this.buildRecordParams(zoneId, record);
    const result = (await this.client.dns.records.create(params as Record<string, unknown>, { signal })) as DNSRecord;
    this.debugResponse(result);
    return result;
  }

  /**
   * Update an existing DNS record.
   *
   * @param zoneId - zone containing the record
   * @param recordId - the id of the DNS record to update
   * @param record - fields to update
   * @param signal - optional AbortSignal
   * @returns the updated DNSRecord
   */
  async updateDNSRecord(zoneId: string, recordId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> {
    if (DEBUG) console.debug('updateDNSRecord', { zoneId, recordId, record });
    this.debugRequest(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      body: record,
    });
    const params = this.buildRecordParams(zoneId, record);
    const result = (await this.client.dns.records.update(recordId, params as Record<string, unknown>, { signal })) as DNSRecord;
    this.debugResponse(result);
    return result;
  }

  /**
   * Delete a DNS record.
   *
   * @param zoneId - zone containing the record
   * @param recordId - the id of the DNS record to delete
   * @param signal - optional AbortSignal
   */
  async deleteDNSRecord(zoneId: string, recordId: string, signal?: AbortSignal): Promise<void> {
    if (DEBUG) console.debug('deleteDNSRecord', { zoneId, recordId });
    this.debugRequest(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
    await this.client.dns.records.delete(recordId, { zone_id: zoneId }, { signal });
    this.debugResponse({ deleted: recordId });
  }

  /**
   * Verify a provided token or key by calling the token verification endpoint.
   *
   * This method can be used to check whether the provided credentials are
   * valid for subsequent requests.
   *
   * @param signal - optional AbortSignal
   */
  async verifyToken(signal?: AbortSignal): Promise<void> {
    if (DEBUG) console.debug('verifyToken');
    this.debugRequest('/user/tokens/verify');
    await this.client.user.tokens.verify({ signal });
    this.debugResponse({ verified: true });
  }
}
