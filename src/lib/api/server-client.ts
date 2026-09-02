/**
 * Client-side server API wrapper
 *
 * This module implements a small helper `ServerClient` that communicates with
 * the local API proxy server and handles timeouts, request headers and
 * JSON parsing with reasonable defaults.
 */
import type { DNSRecord, Zone, ZoneSetting } from "@/types/dns";
import { isDesktop } from "../environment";
import type { PropagationCheckOptions } from "@/lib/dns/propagation-resolvers";
import {
  readBoundedResponseText,
  ResponseBodyLimitError,
} from "../resource-limits";
import { TauriClient, type EmailRoutingRuleInput } from "./tauri-client";
import type {
  BulkDnsDeleteFailure,
  BulkDnsDeleteResult,
  TauriDNSRecordInput,
} from "./tauri-client";
import {
  backendConfigurationError,
  malformedResponseError,
  normalizeRequestError,
  RequestError,
  requestErrorFromResponse,
} from "./request-error";

const DEFAULT_TIMEOUT = 10_000;
type ResponseMode = "json" | "json-or-empty" | "text";

function retryableResponseStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function formatByteLimit(bytes: number): string {
  return Number.isInteger(bytes / (1024 * 1024))
    ? `${bytes / (1024 * 1024)} MiB`
    : `${bytes} bytes`;
}

function responseBodyLimitRequestError(
  error: ResponseBodyLimitError,
  response: Response,
  endpoint: string,
  operation: string,
  requestUrl: string,
): RequestError {
  const sizeDescription =
    error.declaredBytes !== undefined
      ? `The server declared a ${error.declaredBytes}-byte response`
      : `The streamed server response exceeded ${error.limitBytes} bytes`;
  return new RequestError(
    "malformed-response",
    `${sizeDescription}, above the safe ${formatByteLimit(error.limitBytes)} limit. Request a smaller page or narrower result and try again.`,
    {
      source: "server",
      endpoint,
      requestUrl,
      operation,
      status: response.status,
      statusText: response.statusText,
      code: "RESPONSE_TOO_LARGE",
      requestId:
        response.headers.get("cf-ray") ??
        response.headers.get("x-request-id") ??
        undefined,
      retryable: retryableResponseStatus(response.status),
      remediation: "Reduce the requested page or result size before retrying.",
    },
    { cause: error },
  );
}

function configuredServerApiBase(): string | undefined {
  const nextPublic =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_SERVER_API_BASE
      : undefined;
  const viteLegacy =
    typeof import.meta !== "undefined"
      ? import.meta.env?.VITE_SERVER_API_BASE
      : undefined;
  const nodeLegacy =
    typeof window === "undefined" && typeof process !== "undefined"
      ? process.env.SERVER_API_BASE
      : undefined;
  return [nextPublic, viteLegacy, nodeLegacy].find(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function normalizeServerApiBase(value: string | undefined): string {
  const base = value?.trim();
  if (!base) {
    throw backendConfigurationError(
      "No public server API base was supplied; the app will not guess a localhost proxy.",
    );
  }
  if (base.startsWith("/")) {
    return base.replace(/\/+$/, "");
  }
  try {
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("unsupported protocol");
    }
    if (url.username || url.password) {
      throw new Error("credentials are not allowed in the URL");
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw backendConfigurationError(
      "NEXT_PUBLIC_SERVER_API_BASE must be an absolute HTTP(S) URL or an explicitly configured same-origin path.",
    );
  }
}

function joinRequestUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function normalizeTauriRecordInput(
  record: Partial<DNSRecord>,
): TauriDNSRecordInput {
  if (typeof record.type !== "string" || !record.type.trim()) {
    throw new TypeError("DNS record type is required");
  }
  if (typeof record.name !== "string" || !record.name.trim()) {
    throw new TypeError("DNS record name is required");
  }
  if (typeof record.content !== "string") {
    throw new TypeError("DNS record content is required");
  }

  const normalized: TauriDNSRecordInput = {
    type: record.type,
    name: record.name,
    content: record.content,
  };
  if (typeof record.comment === "string") normalized.comment = record.comment;
  const normalizedTtl = record.ttl === "auto" ? 1 : record.ttl;
  if (typeof normalizedTtl === "number") normalized.ttl = normalizedTtl;
  if (typeof record.priority === "number")
    normalized.priority = record.priority;
  if (typeof record.proxied === "boolean") normalized.proxied = record.proxied;
  return normalized;
}

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
 * One entry from `list_passkeys`.
 *
 * The desktop backend returns a union of three record kinds — verified
 * credentials, verified-store records it could not read, and legacy records —
 * and only the first carries a label or timestamps. `requiresReregistration`
 * is the field that separates a passkey that can sign in from one the user has
 * to replace.
 */
export interface PasskeyListEntry {
  id: string;
  counter?: number;
  label?: string;
  createdAt?: string;
  lastUsedAt?: string;
  requiresReregistration?: boolean;
}

/** The result of submitting an assertion to the relying party. */
export interface PasskeyAuthenticationResult {
  success: boolean;
  /**
   * Single-use unlock token, minted only on the success path of a verified
   * assertion. Present only when `success` is true; never persist or log it.
   */
  token?: string;
  /** Credential that produced the assertion. Not secret. */
  credentialId?: string;
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
  private readonly baseUrl?: string;

  constructor(
    private apiKey: string,
    baseUrl?: string,
    private email?: string,
    private timeoutMs: number = DEFAULT_TIMEOUT,
  ) {
    const configuredBase =
      baseUrl === undefined ? configuredServerApiBase() : baseUrl;
    this.baseUrl =
      baseUrl === undefined && isDesktop()
        ? undefined
        : configuredBase === undefined
          ? undefined
          : normalizeServerApiBase(configuredBase);
  }

  /**
   * Build headers for requests using the instance apiKey/email.
   */
  private headers(): HeadersInit {
    return authHeaders(this.apiKey, this.email);
  }

  /**
   * Internal helper for performing HTTP requests.
   *
   * - Composes caller cancellation with an independent request timeout
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
      responseMode = "json",
    }: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      responseMode?: ResponseMode;
    } = {},
  ): Promise<T> {
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      throw backendConfigurationError(
        "No public server API base was supplied; the app will not guess a localhost proxy.",
      );
    }
    const callerSignal = signal;
    const controller = new AbortController();
    let detachCallerSignal: (() => void) | undefined;
    let timedOut = false;
    if (callerSignal) {
      const abortFromCaller = () => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      };
      if (callerSignal.aborted) {
        abortFromCaller();
      } else {
        callerSignal.addEventListener("abort", abortFromCaller, { once: true });
        detachCallerSignal = () =>
          callerSignal.removeEventListener("abort", abortFromCaller);
      }
    }
    const timeout = controller.signal.aborted
      ? undefined
      : setTimeout(() => {
          if (controller.signal.aborted) return;
          timedOut = true;
          controller.abort();
        }, this.timeoutMs);
    try {
      const requestUrl = joinRequestUrl(baseUrl, endpoint);
      const res = await fetch(requestUrl, {
        method,
        headers: {
          ...(this.headers() as Record<string, string>),
          ...(headers ?? {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const contentType = res.headers.get("content-type");
      let bodyText: string;
      try {
        bodyText = await readBoundedResponseText(res);
      } catch (error) {
        if (error instanceof ResponseBodyLimitError) {
          throw responseBodyLimitRequestError(
            error,
            res,
            endpoint,
            method,
            requestUrl,
          );
        }
        throw error;
      }
      if (!res.ok) {
        throw requestErrorFromResponse(
          res,
          endpoint,
          bodyText,
          method,
          requestUrl,
        );
      }
      const responseContext = {
        operation: method,
        status: res.status,
        statusText: res.statusText,
        requestUrl,
        requestId:
          res.headers.get("cf-ray") ??
          res.headers.get("x-request-id") ??
          undefined,
        contentType: contentType ?? undefined,
      };
      const firstContentIndex = bodyText.search(/\S/);
      if (firstContentIndex < 0) {
        if (responseMode !== "json") return undefined as T;
        throw malformedResponseError(endpoint, new SyntaxError("Empty body"), {
          ...responseContext,
          responseKind: "unexpected-content",
        });
      }
      const isHtml =
        contentType?.toLowerCase().includes("text/html") === true ||
        /^(?:<!doctype\s+html|<html\b)/i.test(
          bodyText.slice(firstContentIndex, firstContentIndex + 64),
        );
      if (isHtml) {
        throw malformedResponseError(endpoint, new SyntaxError("HTML body"), {
          ...responseContext,
          responseKind: "unexpected-html",
        });
      }
      if (responseMode === "text") return bodyText as T;
      try {
        return JSON.parse(bodyText) as T;
      } catch (error) {
        throw malformedResponseError(endpoint, error, {
          ...responseContext,
          responseKind:
            contentType?.toLowerCase().includes("json") === true
              ? "invalid-json"
              : "unexpected-content",
        });
      }
    } catch (error) {
      throw normalizeRequestError(error, {
        endpoint,
        requestUrl: joinRequestUrl(baseUrl, endpoint),
        operation: method,
        timedOut,
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      detachCallerSignal?.();
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
      const ok = await TauriClient.verifyToken(this.apiKey, this.email, signal);
      if (!ok) {
        throw new Error("Token verification failed");
      }
      return;
    }
    await this.request("/verify-token", {
      method: "POST",
      signal,
      responseMode: "json-or-empty",
    });
  }

  /**
   * Get all zones associated with the account/token.
   *
   * @param signal - optional AbortSignal to cancel the request
   * @returns an array of Zone objects
   */
  async getZones(signal?: AbortSignal): Promise<Zone[]> {
    if (isDesktop()) {
      if (signal === undefined) {
        return TauriClient.getZones(this.apiKey, this.email) as Promise<Zone[]>;
      }
      return TauriClient.getZones(this.apiKey, this.email, signal) as Promise<
        Zone[]
      >;
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
        page,
        perPage,
        signal,
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
    const normalizedRecord = normalizeTauriRecordInput(record);
    if (isDesktop()) {
      return TauriClient.createDNSRecord(
        this.apiKey,
        this.email,
        zoneId,
        normalizedRecord,
        signal,
      ) as Promise<DNSRecord>;
    }
    return this.request(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: normalizedRecord,
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
    const normalizedRecords = records.map((record) =>
      normalizeTauriRecordInput(record),
    );
    if (isDesktop()) {
      return TauriClient.createBulkDNSRecords(
        this.apiKey,
        this.email,
        zoneId,
        normalizedRecords,
        dryrun,
        signal,
      ) as Promise<{ created: DNSRecord[]; skipped: unknown[] }>;
    }
    /**
     * Create multiple DNS records in a single request when supported by the
     * server. Optionally performs a dry-run by setting `dryrun` to true.
     */
    const q = dryrun ? "?dryrun=1" : "";
    return this.request(`/zones/${zoneId}/dns_records/bulk${q}`, {
      method: "POST",
      body: normalizedRecords,
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
    const normalizedRecord = normalizeTauriRecordInput(record);
    if (isDesktop()) {
      return TauriClient.updateDNSRecord(
        this.apiKey,
        this.email,
        zoneId,
        recordId,
        normalizedRecord,
        signal,
      ) as Promise<DNSRecord>;
    }
    // PATCH, not PUT: Cloudflare's `PUT /dns_records/{id}` is documented as
    // "Overwrite an existing DNS record", so attributes missing from the body
    // revert to their defaults. `normalizeTauriRecordInput` only ever emits
    // type/name/content/comment/ttl/priority/proxied, so a PUT would silently
    // discard the record attributes this app never reads — `tags` and
    // `settings` — on every proxy toggle and bulk TTL change. PATCH updates
    // only the fields present in the body. This mirrors the desktop path in
    // `bc-cloudflare-api::update_dns_record`; see the note there for why this
    // is safe for the fields we do model.
    return this.request(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: "PATCH",
      body: normalizedRecord,
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
        signal,
      );
    }
    await this.request(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: "DELETE",
      signal,
      responseMode: "json-or-empty",
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
    await this.request(`/vault/${id}`, {
      method: "POST",
      body: { secret },
      responseMode: "json-or-empty",
    });
  }

  async getVaultSecret(
    id: string,
    passkeyToken?: string,
  ): Promise<string | undefined> {
    if (isDesktop()) {
      return TauriClient.getVaultSecret(id, passkeyToken);
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
    await this.request(`/vault/${id}`, {
      method: "DELETE",
      responseMode: "json-or-empty",
    });
  }

  async getPasskeyRegistrationOptions(id: string): Promise<unknown> {
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
      responseMode: "json-or-empty",
    });
  }

  async getPasskeyAuthOptions(id: string): Promise<unknown> {
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
    if (isDesktop()) {
      return TauriClient.simulateSPF(domain, ip);
    }
    return this.request(
      `/spf/simulate?domain=${encodeURIComponent(domain)}&ip=${encodeURIComponent(ip)}`,
      { method: "GET" },
    );
  }

  async getSPFGraph(domain: string): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.getSPFGraph(domain);
    }
    return this.request(`/spf/graph?domain=${encodeURIComponent(domain)}`, {
      method: "GET",
    });
  }

  async authenticatePasskey(
    id: string,
    assertion: unknown,
  ): Promise<PasskeyAuthenticationResult> {
    /**
     * Submit a passkey assertion (authentication) to the server. The server
     * should verify the assertion and respond with success. This project
     * includes a stubbed verification; extend with proper use of FIDO2
     * verification before production use.
     */
    if (isDesktop()) {
      return (await TauriClient.authenticatePasskey(
        id,
        assertion,
      )) as PasskeyAuthenticationResult;
    }
    return this.request(`/passkeys/authenticate/${id}`, {
      method: "POST",
      body: assertion,
    });
  }

  async listPasskeys(
    id: string,
    signal?: AbortSignal,
  ): Promise<PasskeyListEntry[]> {
    if (isDesktop()) {
      if (signal === undefined) {
        return TauriClient.listPasskeys(id) as Promise<PasskeyListEntry[]>;
      }
      return TauriClient.listPasskeys(id, signal) as Promise<
        PasskeyListEntry[]
      >;
    }
    return this.request(`/passkeys/${id}`, { method: "GET", signal });
  }

  async deletePasskey(id: string, cid: string): Promise<void> {
    if (isDesktop()) {
      await TauriClient.deletePasskey(id, cid);
      return;
    }
    await this.request(`/passkeys/${id}/${cid}`, {
      method: "DELETE",
      responseMode: "json-or-empty",
    });
  }

  async exportDNSRecords(
    zoneId: string,
    format: "json" | "csv" | "bind" = "json",
    page?: number,
    perPage?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    /**
     * Export DNS records for a zone in a specific format. Supported formats
     * are 'json', 'csv' and 'bind'. Optional pagination parameters are
     * forwarded to the server.
     */
    if (isDesktop()) {
      return signal
        ? TauriClient.exportDNSRecords(
            this.apiKey,
            this.email,
            zoneId,
            format,
            page,
            perPage,
            signal,
          )
        : TauriClient.exportDNSRecords(
            this.apiKey,
            this.email,
            zoneId,
            format,
            page,
            perPage,
          );
    }
    const q: string[] = [];
    q.push(`format=${format}`);
    if (page) q.push(`page=${page}`);
    if (perPage) q.push(`per_page=${perPage}`);
    const query = q.length ? `?${q.join("&")}` : "";
    return this.request(`/zones/${zoneId}/dns_records/export${query}`, {
      responseMode: "text",
      signal,
    });
  }

  async purgeCache(
    zoneId: string,
    payload: { purge_everything?: boolean; files?: string[] },
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.purgeCache(
        this.apiKey,
        this.email,
        zoneId,
        payload.purge_everything === true,
        payload.files,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/purge_cache`, {
      method: "POST",
      body: payload,
      signal,
    });
  }

  async getZoneSetting<T = unknown>(
    zoneId: string,
    settingId: string,
    signal?: AbortSignal,
  ): Promise<ZoneSetting<T>> {
    if (isDesktop()) {
      return TauriClient.getZoneSetting(
        this.apiKey,
        this.email,
        zoneId,
        settingId,
        signal,
      ) as Promise<ZoneSetting<T>>;
    }
    return this.request(`/zones/${zoneId}/settings/${settingId}`, { signal });
  }

  async updateZoneSetting<T = unknown>(
    zoneId: string,
    settingId: string,
    value: T,
    signal?: AbortSignal,
  ): Promise<ZoneSetting<T>> {
    if (isDesktop()) {
      return TauriClient.updateZoneSetting(
        this.apiKey,
        this.email,
        zoneId,
        settingId,
        value,
        signal,
      ) as Promise<ZoneSetting<T>>;
    }
    return this.request(`/zones/${zoneId}/settings/${settingId}`, {
      method: "PATCH",
      body: { value },
      signal,
    });
  }

  async getDnssec(zoneId: string, signal?: AbortSignal): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.getDnssec(this.apiKey, this.email, zoneId, signal);
    }
    return this.request(`/zones/${zoneId}/dnssec`, { signal });
  }

  async updateDnssec(
    zoneId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.updateDnssec(
        this.apiKey,
        this.email,
        zoneId,
        payload,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/dnssec`, {
      method: "PATCH",
      body: payload,
      signal,
    });
  }

  // ─── Registrar Monitoring ────────────────────────────────────────────
  // All registrar operations are backend-only; these methods delegate to
  // Tauri commands (desktop) or the server API proxy (web).

  async addRegistrarCredential(
    provider: string,
    label: string,
    apiKey: string,
    apiSecret?: string,
    username?: string,
    email?: string,
    extra?: Record<string, string>,
  ): Promise<string> {
    if (isDesktop()) {
      return TauriClient.addRegistrarCredential(
        provider,
        label,
        apiKey,
        apiSecret,
        username,
        email,
        extra,
      );
    }
    return this.request("/registrar/credentials", {
      method: "POST",
      body: { provider, label, apiKey, apiSecret, username, email, extra },
    });
  }

  async listRegistrarCredentials(): Promise<unknown[]> {
    if (isDesktop()) {
      return TauriClient.listRegistrarCredentials();
    }
    return this.request("/registrar/credentials");
  }

  async deleteRegistrarCredential(credentialId: string): Promise<void> {
    if (isDesktop()) {
      return TauriClient.deleteRegistrarCredential(credentialId);
    }
    await this.request(`/registrar/credentials/${credentialId}`, {
      method: "DELETE",
      responseMode: "json-or-empty",
    });
  }

  async verifyRegistrarCredential(credentialId: string): Promise<boolean> {
    if (isDesktop()) {
      return TauriClient.verifyRegistrarCredential(credentialId);
    }
    return this.request(`/registrar/credentials/${credentialId}/verify`, {
      method: "POST",
    });
  }

  async registrarListDomains(
    credentialId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    if (isDesktop()) {
      return TauriClient.registrarListDomains(credentialId, signal);
    }
    return this.request(`/registrar/credentials/${credentialId}/domains`, {
      signal,
    });
  }

  async registrarGetDomain(
    credentialId: string,
    domain: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.registrarGetDomain(credentialId, domain, signal);
    }
    return this.request(
      `/registrar/credentials/${credentialId}/domains/${encodeURIComponent(domain)}`,
      { signal },
    );
  }

  async registrarListAllDomains(signal?: AbortSignal): Promise<unknown[]> {
    if (isDesktop()) {
      return TauriClient.registrarListAllDomains(signal);
    }
    return this.request("/registrar/domains", { signal });
  }

  async registrarHealthCheck(
    credentialId: string,
    domain: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.registrarHealthCheck(credentialId, domain, signal);
    }
    return this.request(
      `/registrar/credentials/${credentialId}/domains/${encodeURIComponent(domain)}/health`,
      { signal },
    );
  }

  async registrarHealthCheckAll(signal?: AbortSignal): Promise<unknown[]> {
    if (isDesktop()) {
      return TauriClient.registrarHealthCheckAll(signal);
    }
    return this.request("/registrar/health", { signal });
  }

  // ── Biometric Authentication ──────────────────────────────────────────────

  /**
   * Check biometric availability on the current device.
   * Only available on desktop (Touch ID on macOS, Windows Hello).
   */
  static async biometricStatus(): Promise<{
    available: boolean;
    biometricType: string;
    reason?: string;
  }> {
    if (isDesktop()) {
      return TauriClient.biometricStatus();
    }
    return { available: false, biometricType: "none", reason: "Web mode" };
  }

  /** Prompt for biometric authentication (Touch ID / Windows Hello). */
  static async biometricAuthenticate(reason: string): Promise<void> {
    if (!isDesktop()) throw new Error("Biometrics only available on desktop");
    return TauriClient.biometricAuthenticate(reason);
  }

  /** Store an API key protected by biometrics in the OS keychain. */
  static async biometricStoreSecret(
    key: string,
    secret: string,
  ): Promise<void> {
    if (!isDesktop()) throw new Error("Biometrics only available on desktop");
    return TauriClient.biometricStoreSecret(key, secret);
  }

  /** Retrieve a biometric-protected API key (triggers Touch ID). */
  static async biometricGetSecret(
    key: string,
    reason: string,
  ): Promise<string> {
    if (!isDesktop()) throw new Error("Biometrics only available on desktop");
    return TauriClient.biometricGetSecret(key, reason);
  }

  /** Delete a biometric-protected secret. */
  static async biometricDeleteSecret(key: string): Promise<void> {
    if (!isDesktop()) throw new Error("Biometrics only available on desktop");
    return TauriClient.biometricDeleteSecret(key);
  }

  /** Check if a biometric-protected secret exists for a key without triggering auth. */
  static async biometricHasSecret(key: string): Promise<boolean> {
    if (isDesktop()) {
      return TauriClient.biometricHasSecret(key);
    }
    return false;
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async getZoneAnalytics(
    zoneId: string,
    since?: string,
    until?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.getZoneAnalytics(
        this.apiKey,
        zoneId,
        since,
        until,
        this.email,
        undefined,
        signal,
      );
    }
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    const qs = params.toString();
    return this.request(
      `/zones/${zoneId}/analytics/dashboard${qs ? `?${qs}` : ""}`,
      { signal },
    );
  }

  async getDnsAnalytics(
    zoneId: string,
    since?: string,
    until?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.getDnsAnalytics(
        this.apiKey,
        zoneId,
        since,
        until,
        this.email,
        undefined,
        undefined,
        signal,
      );
    }
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    const qs = params.toString();
    return this.request(
      `/zones/${zoneId}/dns_analytics/report${qs ? `?${qs}` : ""}`,
      { signal },
    );
  }

  // ── Firewall / WAF ───────────────────────────────────────────────────────

  async getFirewallRules(
    zoneId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    if (isDesktop()) {
      return TauriClient.getFirewallRules(
        this.apiKey,
        zoneId,
        this.email,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/firewall/rules`, { signal });
  }

  async createFirewallRule(
    zoneId: string,
    rule: {
      action: string;
      description?: string;
      filter: { expression: string };
    },
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    if (isDesktop()) {
      return TauriClient.createFirewallRule(
        this.apiKey,
        zoneId,
        rule,
        this.email,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/firewall/rules`, {
      method: "POST",
      body: [rule],
      signal,
    });
  }

  async updateFirewallRule(
    zoneId: string,
    ruleId: string,
    rule: {
      action: string;
      description?: string;
      filter: { expression: string };
    },
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.updateFirewallRule(
        this.apiKey,
        zoneId,
        ruleId,
        rule,
        this.email,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/firewall/rules/${ruleId}`, {
      method: "PUT",
      body: rule,
      signal,
    });
  }

  async deleteFirewallRule(
    zoneId: string,
    ruleId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (isDesktop()) {
      return TauriClient.deleteFirewallRule(
        this.apiKey,
        zoneId,
        ruleId,
        this.email,
        signal,
      );
    }
    await this.request(`/zones/${zoneId}/firewall/rules/${ruleId}`, {
      method: "DELETE",
      signal,
      responseMode: "json-or-empty",
    });
  }

  async getIpAccessRules(
    zoneId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    if (isDesktop()) {
      return TauriClient.getIpAccessRules(
        this.apiKey,
        zoneId,
        this.email,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/firewall/access_rules/rules`, {
      signal,
    });
  }

  async createIpAccessRule(
    zoneId: string,
    mode: string,
    ip: string,
    notes?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.createIpAccessRule(
        this.apiKey,
        zoneId,
        mode,
        ip,
        notes,
        this.email,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/firewall/access_rules/rules`, {
      method: "POST",
      body: { mode, configuration: { target: "ip", value: ip }, notes },
      signal,
    });
  }

  async deleteIpAccessRule(
    zoneId: string,
    ruleId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (isDesktop()) {
      return TauriClient.deleteIpAccessRule(
        this.apiKey,
        zoneId,
        ruleId,
        this.email,
        signal,
      );
    }
    await this.request(
      `/zones/${zoneId}/firewall/access_rules/rules/${ruleId}`,
      {
        method: "DELETE",
        signal,
        responseMode: "json-or-empty",
      },
    );
  }

  async getWafRulesets(
    zoneId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    if (isDesktop()) {
      return TauriClient.getWafRulesets(
        this.apiKey,
        zoneId,
        this.email,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/rulesets`, { signal });
  }

  // ── Workers ───────────────────────────────────────────────────────────────

  async getWorkerRoutes(
    zoneId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    if (isDesktop()) {
      return TauriClient.getWorkerRoutes(
        this.apiKey,
        zoneId,
        this.email,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/workers/routes`, { signal });
  }

  async createWorkerRoute(
    zoneId: string,
    pattern: string,
    script: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.createWorkerRoute(
        this.apiKey,
        zoneId,
        pattern,
        script,
        this.email,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/workers/routes`, {
      method: "POST",
      body: { pattern, script },
      signal,
    });
  }

  async deleteWorkerRoute(
    zoneId: string,
    routeId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (isDesktop()) {
      return TauriClient.deleteWorkerRoute(
        this.apiKey,
        zoneId,
        routeId,
        this.email,
        signal,
      );
    }
    await this.request(`/zones/${zoneId}/workers/routes/${routeId}`, {
      method: "DELETE",
      signal,
      responseMode: "json-or-empty",
    });
  }

  // ── Email Routing ─────────────────────────────────────────────────────────

  async getEmailRoutingSettings(
    zoneId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.getEmailRoutingSettings(
        this.apiKey,
        zoneId,
        this.email,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/email/routing`, { signal });
  }

  async getEmailRoutingRules(
    zoneId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    if (isDesktop()) {
      return TauriClient.getEmailRoutingRules(
        this.apiKey,
        zoneId,
        this.email,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/email/routing/rules`, { signal });
  }

  async createEmailRoutingRule(
    zoneId: string,
    rule: EmailRoutingRuleInput,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.createEmailRoutingRule(
        this.apiKey,
        zoneId,
        rule,
        this.email,
        signal,
      );
    }
    return this.request(`/zones/${zoneId}/email/routing/rules`, {
      method: "POST",
      body: rule,
      signal,
    });
  }

  async deleteEmailRoutingRule(
    zoneId: string,
    ruleId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (isDesktop()) {
      return TauriClient.deleteEmailRoutingRule(
        this.apiKey,
        zoneId,
        ruleId,
        this.email,
        signal,
      );
    }
    await this.request(`/zones/${zoneId}/email/routing/rules/${ruleId}`, {
      method: "DELETE",
      signal,
      responseMode: "json-or-empty",
    });
  }

  // ── Page Rules ────────────────────────────────────────────────────────────

  async getPageRules(zoneId: string, signal?: AbortSignal): Promise<unknown[]> {
    if (isDesktop()) {
      return TauriClient.getPageRules(this.apiKey, zoneId, this.email, signal);
    }
    return this.request(`/zones/${zoneId}/pagerules`, { signal });
  }

  // ── Bulk Operations ───────────────────────────────────────────────────────

  async deleteBulkDnsRecords(
    zoneId: string,
    recordIds: string[],
    signal?: AbortSignal,
  ): Promise<BulkDnsDeleteResult> {
    if (isDesktop()) {
      return TauriClient.deleteBulkDnsRecords(
        this.apiKey,
        zoneId,
        recordIds,
        this.email,
        signal,
      );
    }
    // Web mode: delete one-by-one. A record Cloudflare refuses is recorded and
    // the loop continues, so the caller learns exactly which ids are still live
    // instead of losing that answer to the first rejection.
    const deleted: string[] = [];
    const failed: BulkDnsDeleteFailure[] = [];
    for (const id of recordIds) {
      try {
        await this.request(`/zones/${zoneId}/dns_records/${id}`, {
          method: "DELETE",
          signal,
          responseMode: "json-or-empty",
        });
        deleted.push(id);
      } catch (error) {
        // A cancelled batch is not a per-record failure — surface the abort.
        if (signal?.aborted) throw error;
        failed.push({
          id,
          error:
            error instanceof Error && error.message
              ? error.message
              : String(error),
        });
      }
    }
    return { deleted, failed };
  }

  // ── DNS Propagation ───────────────────────────────────────────────────────

  async checkDnsPropagation(
    domain: string,
    recordType: string,
    extraResolvers?: string[],
    signal?: AbortSignal,
    options?: PropagationCheckOptions,
  ): Promise<unknown> {
    if (isDesktop()) {
      return TauriClient.checkDnsPropagation(
        domain,
        recordType,
        extraResolvers,
        signal,
        options,
      );
    }
    // Web mode: hit our server API
    return this.request("/dns/propagation", {
      method: "POST",
      body: {
        domain,
        record_type: recordType,
        extra_resolvers: extraResolvers,
        options,
      },
      signal,
    });
  }
}
