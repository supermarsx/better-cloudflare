/**
 * Client-side server API wrapper
 *
 * This module implements a small helper `ServerClient` that communicates with
 * the local API proxy server and handles timeouts, request headers and
 * JSON parsing with reasonable defaults.
 */
import type { DNSRecord, Zone } from '@/types/dns';
import { getEnv } from './env';

const DEFAULT_BASE =
  getEnv('SERVER_API_BASE', 'VITE_SERVER_API_BASE', 'http://localhost:8787/api')!;
const DEFAULT_TIMEOUT = 10_000;

/**
 * Build headers used for authorization toward our server API.
 *
 * If an email is passed we use `x-auth-key` and `x-auth-email` custom headers
 * otherwise we use the `Authorization: Bearer <token>` pattern.
 *
 * @param key - API key or token
 * @param email - optional email in case of key+email authentication
 * @returns HeadersInit object ready to be used in fetch requests
 */
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

 
/**
 * Client for communicating with the local server API that proxies requests
 * to Cloudflare. The client handles authorization headers and JSON parsing
 * of responses and provides higher-level convenience methods.
 *
 * @param apiKey - API key or token to be used for requests
 * @param baseUrl - Base URL for the server API (includes `/api` path)
 * @param email - optional email to be used in key+email auth
 * @param timeoutMs - request timeout in milliseconds
 */
export class ServerClient {
  constructor(
    private apiKey: string,
    private baseUrl: string = DEFAULT_BASE,
    private email?: string,
    private timeoutMs: number = DEFAULT_TIMEOUT,
  ) {}

  /**
   * Build headers for requests using the instance apiKey/email.
   */
  private headers(): HeadersInit {
    return authHeaders(this.apiKey, this.email);
  }

  /**
   * Internal helper for performing HTTP requests.
   *
   * - Handles timeout via AbortController when a `signal` is not provided
   * - Parses JSON responses, otherwise returns undefined
   * - On error attempts to parse response body for additional details
   *
   * @param endpoint - API endpoint path (prefixed by baseUrl). Example: `/zones`
   * @param options - optional fetch options: method, body and signal
   * @param options.method - HTTP method (GET/POST/PUT/DELETE)
   * @param options.body - request body which will be JSON encoded
   * @param options.signal - optional AbortSignal to cancel the request
   * @returns parsed JSON payload as type T, or undefined for non-JSON responses
   */
  private async request<T>(
    endpoint: string,
    { 
      method = 'GET',
      body,
      signal,
    }: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    let controller: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (!signal) {
      controller = new AbortController();
      timeout = setTimeout(() => controller!.abort(), this.timeoutMs);
      signal = controller.signal;
    }
    try {
      const res = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      const contentType = res.headers.get('content-type');
      if (!res.ok) {
        let detail = '';
        if (contentType && contentType.includes('application/json')) {
          try {
            const data: unknown = await res.json();
            if (
              typeof data === 'object' &&
              data !== null &&
              Array.isArray((data as { errors?: unknown }).errors) &&
              (data as { errors: unknown[] }).errors.length > 0
            ) {
              detail = (data as {
                errors: { code?: unknown; message?: unknown }[];
              }).errors
                .map((e: { code?: unknown; message?: unknown }) => {
                  const code = e.code;
                  const message = e.message;
                  return code && message
                    ? `${code}: ${message}`
                    : typeof message === 'string'
                    ? message
                    : code !== undefined
                    ? String(code)
                    : '';
                })
                .filter((s) => s)
                .join(', ');
            } else if (
              typeof (data as { message?: unknown }).message === 'string'
            ) {
              detail = (data as { message: string }).message;
            } else if (
              typeof (data as { error?: unknown }).error === 'string'
            ) {
              detail = (data as { error: string }).error;
            } else {
              detail = JSON.stringify(data);
            }
          } catch {
            detail = await res.text();
          }
        } else {
          detail = await res.text();
        }
        throw new Error(
          `Request to ${endpoint} failed with ${res.status} ${res.statusText}: ${detail}`,
        );
      }
      if (contentType && contentType.includes('application/json')) {
        return res.json();
      }
      return undefined as T;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Verify credentials by calling the /verify-token endpoint.
    *
    * @param signal - optional AbortSignal to cancel the request
    * @returns Promise that resolves when verification succeeded
   */
  async verifyToken(signal?: AbortSignal): Promise<void> {
    await this.request('/verify-token', { method: 'POST', signal });
  }

  /**
   * Get all zones associated with the account/token.
    *
    * @param signal - optional AbortSignal to cancel the request
    * @returns an array of Zone objects
   */
  async getZones(signal?: AbortSignal): Promise<Zone[]> {
    return this.request('/zones', { signal });
  }

  /**
   * Retrieve DNS records for the provided zone id.
    *
    * @param zoneId - the id of the zone to fetch records for
    * @param signal - optional AbortSignal
    * @returns a list of DNSRecord objects
   */
  async getDNSRecords(zoneId: string, signal?: AbortSignal): Promise<DNSRecord[]> {
    return this.request(`/zones/${zoneId}/dns_records`, { signal });
  }

  /**
   * Create a new DNS record via the server API.
    *
    * @param zoneId - id of the zone to create the record in
    * @param record - partial DNS record data to submit
    * @param signal - optional AbortSignal
    * @returns the created DNSRecord as returned by the API
   */
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

  /**
   * Update an existing DNS record via the server API.
    *
    * @param zoneId - id of the zone containing the record
    * @param recordId - id of the record to update
    * @param record - partial record fields to update
    * @param signal - optional AbortSignal
    * @returns the updated DNSRecord
   */
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

  /**
   * Delete a DNS record via the server API.
    *
    * @param zoneId - id of the zone containing the record
    * @param recordId - id of the record to delete
    * @param signal - optional AbortSignal
    * @returns void
   */
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
