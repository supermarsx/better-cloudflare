/**
 * Client-side server API wrapper
 *
 * This module implements a small helper `ServerClient` that communicates with
 * the local API proxy server and handles timeouts, request headers and
 * JSON parsing with reasonable defaults.
 */
import type { DNSRecord, Zone } from "@/types/dns";
import { getEnv } from "./env";
import { isDesktop } from "./environment";
import { TauriClient } from "./tauri-client";

const DEFAULT_BASE = getEnv(
  "SERVER_API_BASE",
  "VITE_SERVER_API_BASE",
  "http://localhost:8787/api",
)!;
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
      "x-auth-key": key,
      "x-auth-email": email,
      "Content-Type": "application/json",
    };
  }
  if (key) {
    return {
      authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
  }
  return {
    "Content-Type": "application/json",
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
      method = "GET",
      body,
      headers,
      signal,
    }: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
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
        headers: {
          ...(this.headers() as Record<string, string>),
          ...(headers ?? {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      const contentType = res.headers.get("content-type");
      if (!res.ok) {
        let detail = "";
        if (contentType && contentType.includes("application/json")) {
          try {
            const data: unknown = await res.json();
            if (
              typeof data === "object" &&
              data !== null &&
              Array.isArray((data as { errors?: unknown }).errors) &&
              (data as { errors: unknown[] }).errors.length > 0
            ) {
              detail = (
                data as {
                  errors: { code?: unknown; message?: unknown }[];
                }
              ).errors
                .map((e: { code?: unknown; message?: unknown }) => {
                  const code = e.code;
                  const message = e.message;
                  return code && message
                    ? `${code}: ${message}`
                    : typeof message === "string"
                      ? message
                      : code !== undefined
                        ? String(code)
                        : "";
                })
                .filter((s) => s)
                .join(", ");
            } else if (
              typeof (data as { message?: unknown }).message === "string"
            ) {
              detail = (data as { message: string }).message;
            } else if (
              typeof (data as { error?: unknown }).error === "string"
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
      if (contentType && contentType.includes("application/json")) {
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
    if (isDesktop()) {
      await TauriClient.verifyToken(this.apiKey, this.email);
      return;
    }
    await this.request("/verify-token", { method: "POST", signal });
  }

  /**
   * Get all zones associated with the account/token.
   *
   * @param signal - optional AbortSignal to cancel the request
   * @returns an array of Zone objects
   */
  async getZones(signal?: AbortSignal): Promise<Zone[]> {
    if (isDesktop()) {
      return TauriClient.getZones(this.apiKey, this.email) as Promise<Zone[]>;
    }
    return this.request("/zones", { signal });
  }

  /**
   * Retrieve DNS records for the provided zone id.
   *
   * @param zoneId - the id of the zone to fetch records for
   * @param signal - optional AbortSignal
   * @returns a list of DNSRecord objects
   */
  async getDNSRecords(
    zoneId: string,
    page?: number,
    perPage?: number,
    signal?: AbortSignal,
  ): Promise<DNSRecord[]> {
    if (isDesktop()) {
      return TauriClient.getDNSRecords(
        this.apiKey,
        this.email,
        zoneId,
      ) as Promise<DNSRecord[]>;
    }
    const qsParts = [] as string[];
    if (page) qsParts.push(`page=${page}`);
    if (perPage) qsParts.push(`per_page=${perPage}`);
    const query = qsParts.length ? `?${qsParts.join("&")}` : "";
    return this.request(`/zones/${zoneId}/dns_records${query}`, { signal });
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
    if (isDesktop()) {
      return TauriClient.createDNSRecord(
        this.apiKey,
        this.email,
        zoneId,
        record,
      ) as Promise<DNSRecord>;
    }
    return this.request(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: record,
      signal,
    });
  }

  /**
   * Create multiple DNS records in a single request when available.
   * @param zoneId - id of the zone
   * @param records - records to create
   */
  async bulkCreateDNSRecords(
    zoneId: string,
    records: Partial<DNSRecord>[],
    dryrun?: boolean,
    signal?: AbortSignal,
  ): Promise<{ created: DNSRecord[]; skipped: unknown[] }> {
    if (isDesktop()) {
      return TauriClient.createBulkDNSRecords(
        this.apiKey,
        this.email,
        zoneId,
        records,
      ) as Promise<{ created: DNSRecord[]; skipped: unknown[] }>;
    }
    /**
     * Create multiple DNS records in a single request when supported by the
     * server. Optionally performs a dry-run by setting `dryrun` to true.
     */
    const q = dryrun ? "?dryrun=1" : "";
    return this.request(`/zones/${zoneId}/dns_records/bulk${q}`, {
      method: "POST",
      body: records,
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
    if (isDesktop()) {
      return TauriClient.updateDNSRecord(
        this.apiKey,
        this.email,
        zoneId,
        recordId,
        record,
      ) as Promise<DNSRecord>;
    }
    return this.request(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: "PUT",
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
    if (isDesktop()) {
      return TauriClient.deleteDNSRecord(
        this.apiKey,
        this.email,
        zoneId,
        recordId,
      );
    }
    await this.request(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: "DELETE",
      signal,
    });
  }

  async storeVaultSecret(id: string, secret: string): Promise<void> {
    /**
     * Store a secret in the server-side vault. The server requires
     * valid credentials in the request headers to protect this endpoint.
     */
    if (isDesktop()) {
      await TauriClient.storeVaultSecret(id, secret);
      return;
    }
    await this.request(`/vault/${id}`, { method: "POST", body: { secret } });
  }

  async getVaultSecret(
    id: string,
    passkeyToken?: string,
  ): Promise<string | undefined> {
    if (isDesktop()) {
      return TauriClient.getVaultSecret(id);
    }
    const data = await this.request(`/vault/${id}`, {
      method: "GET",
      headers: passkeyToken ? { "x-passkey-token": passkeyToken } : undefined,
    });
    if (!data) return undefined;
    return (data as { secret?: string }).secret;
  }

  async deleteVaultSecret(id: string): Promise<void> {
    /** Delete a vault secret on the server */
    if (isDesktop()) {
      await TauriClient.deleteVaultSecret(id);
      return;
    }
    await this.request(`/vault/${id}`, { method: "DELETE" });
  }

  async getPasskeyRegistrationOptions(
    id: string,
  ): Promise<{ challenge: string }> {
    /**
     * Request passkey registration options (a challenge) from the server.
     */
    if (isDesktop()) {
      return TauriClient.getPasskeyRegistrationOptions(id);
    }
    return this.request(`/passkeys/register/options/${id}`, { method: "GET" });
  }

  async registerPasskey(id: string, attestation: unknown): Promise<void> {
    /**
     * Register a passkey attestation blob at the server. The server may
     * store and/or verify the attestation. In this project the server
     * currently stores the provided attestation and should be extended to
     * verify it against a FIDO2 library in production deployments.
     */
    if (isDesktop()) {
      await TauriClient.registerPasskey(id, attestation);
      return;
    }
    await this.request(`/passkeys/register/${id}`, {
      method: "POST",
      body: attestation,
    });
  }

  async getPasskeyAuthOptions(id: string): Promise<{ challenge: string }> {
    /**
     * Request passkey authentication options (a challenge) from the server.
     */
    if (isDesktop()) {
      return TauriClient.getPasskeyAuthOptions(id);
    }
    return this.request(`/passkeys/authenticate/options/${id}`, {
      method: "GET",
    });
  }

  async simulateSPF(
    domain: string,
    ip: string,
  ): Promise<{ result: string; reasons: string[]; lookups: number }> {
    return this.request(
      `/spf/simulate?domain=${encodeURIComponent(domain)}&ip=${encodeURIComponent(ip)}`,
      { method: "GET" },
    );
  }

  async getSPFGraph(domain: string): Promise<unknown> {
    return this.request(`/spf/graph?domain=${encodeURIComponent(domain)}`, {
      method: "GET",
    });
  }

  async authenticatePasskey(
    id: string,
    assertion: unknown,
  ): Promise<{ success: boolean; token?: string }> {
    /**
     * Submit a passkey assertion (authentication) to the server. The server
     * should verify the assertion and respond with success. This project
     * includes a stubbed verification; extend with proper use of FIDO2
     * verification before production use.
     */
    if (isDesktop()) {
      return TauriClient.authenticatePasskey(id, assertion);
    }
    return this.request(`/passkeys/authenticate/${id}`, {
      method: "POST",
      body: assertion,
    });
  }

  async listPasskeys(id: string): Promise<{ id: string; counter?: number }[]> {
    if (isDesktop()) {
      return TauriClient.listPasskeys(id) as Promise<
        { id: string; counter?: number }[]
      >;
    }
    return this.request(`/passkeys/${id}`, { method: "GET" });
  }

  async deletePasskey(id: string, cid: string): Promise<void> {
    if (isDesktop()) {
      await TauriClient.deletePasskey(id, cid);
      return;
    }
    await this.request(`/passkeys/${id}/${cid}`, { method: "DELETE" });
  }

  async exportDNSRecords(
    zoneId: string,
    format: "json" | "csv" | "bind" = "json",
    page?: number,
    perPage?: number,
  ): Promise<string> {
    /**
     * Export DNS records for a zone in a specific format. Supported formats
     * are 'json', 'csv' and 'bind'. Optional pagination parameters are
     * forwarded to the server.
     */
    if (isDesktop()) {
      return TauriClient.exportDNSRecords(
        this.apiKey,
        this.email,
        zoneId,
        format,
      );
    }
    const q: string[] = [];
    q.push(`format=${format}`);
    if (page) q.push(`page=${page}`);
    if (perPage) q.push(`per_page=${perPage}`);
    const query = q.length ? `?${q.join("&")}` : "";
    return this.request(`/zones/${zoneId}/dns_records/export${query}`);
  }
}
