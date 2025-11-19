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
   * @param endpoint - API endpoint path (prefixed by baseUrl)
   * @param options - optional fetch options: method, body, signal
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
   */
  async verifyToken(signal?: AbortSignal): Promise<void> {
    await this.request('/verify-token', { method: 'POST', signal });
  }

  /**
   * Get all zones associated with the account/token.
   */
  async getZones(signal?: AbortSignal): Promise<Zone[]> {
    return this.request('/zones', { signal });
  }

  /**
   * Retrieve DNS records for the provided zone id.
   */
  async getDNSRecords(zoneId: string, signal?: AbortSignal): Promise<DNSRecord[]> {
    return this.request(`/zones/${zoneId}/dns_records`, { signal });
  }

  /**
   * Create a new DNS record via the server API.
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
