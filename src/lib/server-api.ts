import type { DNSRecord, Zone } from '@/types/dns';
import { CloudflareAPI } from './cloudflare';

const DEBUG = Boolean(
  (typeof process !== 'undefined' ? process.env.DEBUG_SERVER_API : undefined) ||
    (typeof import.meta !== 'undefined'
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (import.meta as any).env?.VITE_DEBUG_SERVER_API
      : undefined),
);

export class ServerAPI {
  private client: CloudflareAPI;

  constructor(apiKey: string, baseUrl?: string, email?: string) {
    this.client = new CloudflareAPI(apiKey, baseUrl, email);
    if (DEBUG) {
      console.debug('ServerAPI initialized', {
        baseUrl,
        email: email ? 'provided' : 'none',
      });
    }
  }

  verifyToken(signal?: AbortSignal): Promise<void> {
    if (DEBUG) console.debug('ServerAPI.verifyToken');
    return this.client.verifyToken(signal);
  }

  getZones(signal?: AbortSignal): Promise<Zone[]> {
    if (DEBUG) console.debug('ServerAPI.getZones');
    return this.client.getZones(signal);
  }

  getDNSRecords(zoneId: string, signal?: AbortSignal): Promise<DNSRecord[]> {
    if (DEBUG) console.debug('ServerAPI.getDNSRecords', { zoneId });
    return this.client.getDNSRecords(zoneId, signal);
  }

  createDNSRecord(
    zoneId: string,
    record: Partial<DNSRecord>,
    signal?: AbortSignal,
  ): Promise<DNSRecord> {
    if (DEBUG) console.debug('ServerAPI.createDNSRecord', { zoneId, record });
    return this.client.createDNSRecord(zoneId, record, signal);
  }

  updateDNSRecord(
    zoneId: string,
    recordId: string,
    record: Partial<DNSRecord>,
    signal?: AbortSignal,
  ): Promise<DNSRecord> {
    if (DEBUG) console.debug('ServerAPI.updateDNSRecord', { zoneId, recordId, record });
    return this.client.updateDNSRecord(zoneId, recordId, record, signal);
  }

  deleteDNSRecord(zoneId: string, recordId: string, signal?: AbortSignal): Promise<void> {
    if (DEBUG) console.debug('ServerAPI.deleteDNSRecord', { zoneId, recordId });
    return this.client.deleteDNSRecord(zoneId, recordId, signal);
  }
}
