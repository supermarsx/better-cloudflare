/**
 * Tauri API client wrapper
 *
 * This file provides a unified interface for calling Tauri backend commands.
 * It replaces the HTTP-based ServerClient for desktop app usage.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isDesktop } from "@/lib/environment";
import { normalizeRequestError, RequestError } from "@/lib/api/request-error";

const TAURI_UI_TIMEOUT_MS = 15_000;
const TAURI_COMMAND_TIMEOUT_OVERRIDES_MS: Readonly<Record<string, number>> = {
  create_bulk_dns_records: 60_000,
  export_dns_records: 60_000,
  get_dns_analytics: 60_000,
  get_zone_analytics: 60_000,
  registrar_health_check_all: 60_000,
  registrar_list_all_domains: 60_000,
  records_to_bind: 60_000,
  records_to_csv: 60_000,
  records_to_json: 60_000,
  resolve_topology_batch: 120_000,
  run_domain_audit: 120_000,
  save_topology_asset: 60_000,
};

type TauriInvokeOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export function getTauriInvokeTimeoutMs(command: string): number {
  return TAURI_COMMAND_TIMEOUT_OVERRIDES_MS[command] ?? TAURI_UI_TIMEOUT_MS;
}

function tauriAbortError(command: string): RequestError {
  return new RequestError(
    "aborted",
    "The desktop operation was cancelled. Its native task may still finish in the background; wait briefly before retrying a mutating command.",
    {
      source: "tauri",
      operation: "Tauri invoke",
      command,
      retryable: false,
      remediation:
        "Wait for any native side effect to settle before retrying the operation.",
    },
  );
}

export function normalizeTauriInvokeError(
  error: unknown,
  command: string,
): RequestError {
  return normalizeRequestError(error, {
    source: "tauri",
    operation: "Tauri invoke",
    command,
  });
}

export async function withTauriUiTimeout<T>(
  operation: Promise<T>,
  command: string,
  timeoutMs = TAURI_UI_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let detachAbort: (() => void) | undefined;
  const boundedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.round(timeoutMs)
      : TAURI_UI_TIMEOUT_MS;
  if (signal?.aborted) throw tauriAbortError(command);

  try {
    const contenders: Promise<T>[] = [operation];
    contenders.push(
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new RequestError(
              "timeout",
              "The desktop operation timed out. The native task may still finish in the background; wait briefly before retrying to avoid duplicate changes.",
              {
                source: "tauri",
                operation: "Tauri invoke",
                command,
                retryable: false,
                remediation:
                  "Wait for the native side effect to settle, verify the current state, and retry only if no change occurred.",
              },
            ),
          );
        }, boundedTimeoutMs);
      }),
    );
    if (signal) {
      contenders.push(
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(tauriAbortError(command));
          signal.addEventListener("abort", abort, { once: true });
          detachAbort = () => signal.removeEventListener("abort", abort);
        }),
      );
    }
    return await Promise.race(contenders);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    detachAbort?.();
  }
}

async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
  options: TauriInvokeOptions = {},
): Promise<T> {
  try {
    if (options.signal?.aborted) throw tauriAbortError(command);
    const operation = tauriInvoke<T>(command, args);
    return await withTauriUiTimeout(
      operation,
      command,
      options.timeoutMs ?? getTauriInvokeTimeoutMs(command),
      options.signal,
    );
  } catch (error) {
    throw normalizeTauriInvokeError(error, command);
  }
}

type PreferenceFields = Record<string, unknown>;

export interface SerializedPreferenceWriter {
  update(fields: PreferenceFields): Promise<void>;
}

/**
 * Coalesces fields queued in the same turn and serializes later batches. Each
 * batch re-reads the last committed native snapshot, so a slower older write
 * cannot overwrite a newer JS-side preference change.
 */
export function createSerializedPreferenceWriter(
  read: () => Promise<unknown>,
  write: (preferences: PreferenceFields) => Promise<void>,
): SerializedPreferenceWriter {
  let pendingFields: PreferenceFields = {};
  let pendingWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  let drainPromise: Promise<void> | null = null;

  const drain = async () => {
    while (pendingWaiters.length > 0) {
      const fields = pendingFields;
      const waiters = pendingWaiters;
      pendingFields = {};
      pendingWaiters = [];
      try {
        const current = await read();
        const snapshot =
          current && typeof current === "object"
            ? (current as PreferenceFields)
            : {};
        await write({ ...snapshot, ...fields });
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of waiters) waiter.reject(error);
      }
    }
  };

  const ensureDrain = () => {
    if (drainPromise) return;
    drainPromise = Promise.resolve()
      .then(drain)
      .finally(() => {
        drainPromise = null;
        if (pendingWaiters.length > 0) ensureDrain();
      });
  };

  return {
    update(fields) {
      Object.assign(pendingFields, fields);
      const result = new Promise<void>((resolve, reject) => {
        pendingWaiters.push({ resolve, reject });
      });
      ensureDrain();
      return result;
    },
  };
}

let preferenceWriter: SerializedPreferenceWriter | undefined;

export interface TauriZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  development_mode: number;
}

export interface TauriDNSRecord {
  id?: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  zone_id: string;
  zone_name: string;
  created_on: string;
  modified_on: string;
}

export type TauriDNSRecordInput = Partial<TauriDNSRecord>;

export interface TopologyHostnameResolution {
  name: string;
  chain: string[];
  terminal: string;
  ipv4: string[];
  ipv6: string[];
  reverse_hostnames?: Array<{ ip: string; hostnames: string[] }>;
  geo_by_ip?: Array<{ ip: string; country: string; country_code?: string }>;
  error?: string | null;
}

export interface TopologyServiceProbeResult {
  host: string;
  https_up: boolean;
  http_up: boolean;
}

export interface TopologyTcpServiceProbeResult {
  host: string;
  port: number;
  up: boolean;
}

export interface TopologyBatchResult {
  resolutions: TopologyHostnameResolution[];
  probes: TopologyServiceProbeResult[];
  tcp_probes?: TopologyTcpServiceProbeResult[];
}

export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema?: unknown;
  input_schema?: unknown;
  enabled: boolean;
}

export interface McpServerStatus {
  running: boolean;
  host: string;
  port: number;
  url: string;
  enabledTools?: string[];
  enabled_tools?: string[];
  tools: McpToolDescriptor[];
  lastError?: string | null;
  last_error?: string | null;
}

type McpStartServerInvokeArgs = {
  host?: string;
  port?: number;
  enabledTools?: string[];
};

type McpSetEnabledToolsInvokeArgs = {
  enabledTools: string[];
};

export interface PasskeyStatus {
  registrationAvailable: boolean;
  authenticationAvailable: boolean;
  legacyCredentialsRequireReregistration: boolean;
  unavailableReason: string;
}

export class TauriClient {
  // Check if running in Tauri environment
  static isTauri(): boolean {
    return isDesktop();
  }

  static async restartApp(): Promise<void> {
    return invoke("restart_app");
  }

  static async openPathInFileManager(path: string): Promise<void> {
    return invoke("open_path_in_file_manager", { path });
  }

  // Authentication & Key Management
  static async verifyToken(
    apiKey: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return invoke("verify_token", { apiKey, email }, { signal });
  }

  static async getApiKeys(): Promise<unknown[]> {
    return invoke("get_api_keys");
  }

  static async addApiKey(
    label: string,
    apiKey: string,
    email: string | undefined,
    password: string,
  ): Promise<string> {
    return invoke("add_api_key", { label, apiKey, email, password });
  }

  static async updateApiKey(
    id: string,
    label?: string,
    email?: string,
    currentPassword?: string,
    newPassword?: string,
  ): Promise<void> {
    return invoke("update_api_key", {
      id,
      label,
      email,
      currentPassword,
      newPassword,
    });
  }

  static async deleteApiKey(id: string): Promise<void> {
    return invoke("delete_api_key", { id });
  }

  static async decryptApiKey(id: string, password: string): Promise<string> {
    return invoke("decrypt_api_key", { id, password });
  }

  // DNS Operations
  static async getZones(
    apiKey: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<TauriZone[]> {
    return invoke("get_zones", { apiKey, email }, { signal });
  }

  static async getDNSRecords(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    page?: number,
    perPage?: number,
    signal?: AbortSignal,
  ): Promise<TauriDNSRecord[]> {
    return invoke(
      "get_dns_records",
      {
        apiKey,
        email,
        zoneId,
        page,
        perPage,
      },
      { signal },
    );
  }

  static async createDNSRecord(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    record: TauriDNSRecordInput,
    signal?: AbortSignal,
  ): Promise<TauriDNSRecord> {
    return invoke(
      "create_dns_record",
      { apiKey, email, zoneId, record },
      { signal },
    );
  }

  static async updateDNSRecord(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    recordId: string,
    record: TauriDNSRecordInput,
    signal?: AbortSignal,
  ): Promise<TauriDNSRecord> {
    return invoke(
      "update_dns_record",
      {
        apiKey,
        email,
        zoneId,
        recordId,
        record,
      },
      { signal },
    );
  }

  static async deleteDNSRecord(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    recordId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return invoke(
      "delete_dns_record",
      { apiKey, email, zoneId, recordId },
      { signal },
    );
  }

  static async createBulkDNSRecords(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    records: TauriDNSRecordInput[],
    _dryrun?: boolean,
    signal?: AbortSignal,
  ): Promise<{ created: TauriDNSRecord[]; skipped: unknown[] }> {
    return invoke(
      "create_bulk_dns_records",
      {
        apiKey,
        email,
        zoneId,
        records,
        dryrun: _dryrun,
      },
      { signal },
    );
  }

  static async exportDNSRecords(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    format: string,
    page?: number,
    perPage?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return invoke(
      "export_dns_records",
      {
        apiKey,
        email,
        zoneId,
        format,
        page,
        perPage,
      },
      { signal },
    );
  }

  static async purgeCache(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    purgeEverything: boolean,
    files?: string[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return invoke(
      "purge_cache",
      {
        apiKey,
        email,
        zoneId,
        purgeEverything,
        files,
      },
      { signal },
    );
  }

  static async getZoneSetting(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    settingId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return invoke(
      "get_zone_setting",
      { apiKey, email, zoneId, settingId },
      { signal },
    );
  }

  static async updateZoneSetting(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    settingId: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return invoke(
      "update_zone_setting",
      {
        apiKey,
        email,
        zoneId,
        settingId,
        value,
      },
      { signal },
    );
  }

  static async getDnssec(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return invoke("get_dnssec", { apiKey, email, zoneId }, { signal });
  }

  static async updateDnssec(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return invoke(
      "update_dnssec",
      { apiKey, email, zoneId, payload },
      { signal },
    );
  }

  // Vault Operations
  static async storeVaultSecret(id: string, secret: string): Promise<void> {
    return invoke("store_vault_secret", { id, secret });
  }

  static async getVaultSecret(id: string, token?: string): Promise<string> {
    return invoke("get_vault_secret", { id, token });
  }

  static async deleteVaultSecret(id: string): Promise<void> {
    return invoke("delete_vault_secret", { id });
  }

  // Passkey Operations
  static async getPasskeyStatus(): Promise<PasskeyStatus> {
    return invoke("get_passkey_status");
  }

  static async getPasskeyRegistrationOptions(id: string): Promise<unknown> {
    return invoke("get_passkey_registration_options", { id });
  }

  static async registerPasskey(
    id: string,
    attestation: unknown,
  ): Promise<void> {
    return invoke("register_passkey", { id, attestation });
  }

  static async getPasskeyAuthOptions(id: string): Promise<unknown> {
    return invoke("get_passkey_auth_options", { id });
  }

  static async authenticatePasskey(
    id: string,
    assertion: unknown,
  ): Promise<unknown> {
    return invoke("authenticate_passkey", { id, assertion });
  }

  static async listPasskeys(
    id: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    return invoke("list_passkeys", { id }, { signal });
  }

  static async deletePasskey(id: string, credentialId: string): Promise<void> {
    return invoke("delete_passkey", { id, credentialId });
  }

  // Encryption Settings
  static async getEncryptionSettings(): Promise<{
    iterations: number;
    keyLength: number;
    algorithm: string;
  }> {
    const raw = await invoke("get_encryption_settings");
    const fallback = {
      iterations: 100000,
      keyLength: 256,
      algorithm: "AES-GCM",
    };
    if (!raw || typeof raw !== "object") {
      return fallback;
    }
    const obj = raw as {
      iterations?: number;
      keyLength?: number;
      key_length?: number;
      algorithm?: string;
    };
    const rawKeyLength =
      typeof obj.keyLength === "number"
        ? obj.keyLength
        : typeof obj.key_length === "number"
          ? obj.key_length
          : undefined;
    const normalizedKeyLength =
      typeof rawKeyLength === "number"
        ? rawKeyLength <= 64
          ? rawKeyLength * 8
          : rawKeyLength
        : fallback.keyLength;
    return {
      iterations:
        typeof obj.iterations === "number"
          ? obj.iterations
          : fallback.iterations,
      keyLength: normalizedKeyLength,
      algorithm:
        typeof obj.algorithm === "string" ? obj.algorithm : fallback.algorithm,
    };
  }

  static async updateEncryptionSettings(config: {
    iterations: number;
    keyLength: number;
    algorithm: string;
  }): Promise<void> {
    const keyLengthBytes =
      config.keyLength > 64
        ? Math.floor(config.keyLength / 8)
        : config.keyLength;
    return invoke("update_encryption_settings", {
      config: {
        iterations: config.iterations,
        key_length: keyLengthBytes,
        algorithm: config.algorithm,
      },
    });
  }

  static async benchmarkEncryption(iterations: number): Promise<number> {
    return invoke("benchmark_encryption", { iterations });
  }

  // Audit
  static async getAuditEntries(): Promise<unknown[]> {
    return invoke("get_audit_entries");
  }

  static async exportAuditEntries(
    format: "json" | "csv" = "json",
  ): Promise<string> {
    return invoke("export_audit_entries", { format });
  }

  static async saveAuditEntries(
    format: "json" | "csv" = "json",
    folderPreset = "documents",
    customPath = "",
    skipDestinationConfirm = true,
  ): Promise<string> {
    return invoke("save_audit_entries", {
      format,
      folderPreset,
      customPath,
      skipDestinationConfirm,
    });
  }

  static async clearAuditEntries(): Promise<void> {
    return invoke("clear_audit_entries");
  }

  // SPF
  static async simulateSPF(
    domain: string,
    ip: string,
  ): Promise<{ result: string; reasons: string[]; lookups: number }> {
    return invoke("simulate_spf", { domain, ip });
  }

  static async getSPFGraph(domain: string): Promise<unknown> {
    return invoke("spf_graph", { domain });
  }

  static async resolveTopologyBatch(
    hostnames: string[],
    maxHops = 15,
    serviceHosts?: string[],
    dohProvider: "google" | "cloudflare" | "quad9" | "custom" = "cloudflare",
    dohCustomUrl = "",
    resolverMode: "dns" | "doh" = "dns",
    dnsServer = "1.1.1.1",
    customDnsServer = "",
    lookupTimeoutMs = 1200,
    disablePtrLookups = false,
    tcpServicePorts?: number[],
    disableGeoLookups = false,
    geoProvider:
      | "auto"
      | "ipwhois"
      | "ipapi_co"
      | "ip_api"
      | "internal" = "auto",
    scanResolutionChain = true,
  ): Promise<TopologyBatchResult> {
    return invoke("resolve_topology_batch", {
      hostnames,
      maxHops,
      ...(serviceHosts === undefined ? {} : { serviceHosts }),
      dohProvider,
      dohCustomUrl,
      resolverMode,
      dnsServer,
      customDnsServer,
      lookupTimeoutMs,
      disablePtrLookups,
      ...(tcpServicePorts === undefined ? {} : { tcpServicePorts }),
      disableGeoLookups,
      geoProvider,
      scanResolutionChain,
    });
  }

  static async saveTopologyAsset(
    format: "mmd" | "svg" | "png",
    fileName: string,
    payload: string,
    isBase64 = false,
    folderPreset = "documents",
    customPath = "",
    confirmPath = true,
  ): Promise<string> {
    return invoke("save_topology_asset", {
      format,
      fileName,
      payload,
      isBase64,
      folderPreset,
      customPath,
      confirmPath,
    });
  }

  // Preferences
  static async getPreferences(): Promise<unknown> {
    return invoke("get_preferences");
  }

  static async updatePreferences(prefs: unknown): Promise<void> {
    return invoke("update_preferences", { prefs });
  }

  static async updatePreferenceFields(
    fields: Record<string, unknown>,
  ): Promise<void> {
    preferenceWriter ??= createSerializedPreferenceWriter(
      () => TauriClient.getPreferences(),
      (preferences) => TauriClient.updatePreferences(preferences),
    );
    return preferenceWriter.update(fields);
  }

  // MCP Server
  static async getMcpServerStatus(): Promise<McpServerStatus> {
    return invoke("mcp_get_server_status");
  }

  static async startMcpServer(
    host?: string,
    port?: number,
    enabledTools?: string[],
  ): Promise<McpServerStatus> {
    const args: McpStartServerInvokeArgs = {
      host,
      port,
      enabledTools,
    };
    return invoke("mcp_start_server", args);
  }

  static async stopMcpServer(): Promise<McpServerStatus> {
    return invoke("mcp_stop_server");
  }

  static async setMcpEnabledTools(
    enabledTools: string[],
  ): Promise<McpServerStatus> {
    const args: McpSetEnabledToolsInvokeArgs = { enabledTools };
    return invoke("mcp_set_enabled_tools", args);
  }

  // ─── Registrar Monitoring ────────────────────────────────────────────

  static async addRegistrarCredential(
    provider: string,
    label: string,
    apiKey: string,
    apiSecret?: string,
    username?: string,
    email?: string,
    extra?: Record<string, string>,
  ): Promise<string> {
    return invoke("add_registrar_credential", {
      provider,
      label,
      apiKey,
      apiSecret,
      username,
      email,
      extra,
    });
  }

  static async listRegistrarCredentials(): Promise<unknown[]> {
    return invoke("list_registrar_credentials");
  }

  static async deleteRegistrarCredential(credentialId: string): Promise<void> {
    return invoke("delete_registrar_credential", { credentialId });
  }

  static async verifyRegistrarCredential(
    credentialId: string,
  ): Promise<boolean> {
    return invoke("verify_registrar_credential", { credentialId });
  }

  static async registrarListDomains(
    credentialId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    return invoke("registrar_list_domains", { credentialId }, { signal });
  }

  static async registrarGetDomain(
    credentialId: string,
    domain: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return invoke("registrar_get_domain", { credentialId, domain }, { signal });
  }

  static async registrarListAllDomains(
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    return invoke("registrar_list_all_domains", undefined, { signal });
  }

  static async registrarHealthCheck(
    credentialId: string,
    domain: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return invoke(
      "registrar_health_check",
      { credentialId, domain },
      { signal },
    );
  }

  static async registrarHealthCheckAll(
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    return invoke("registrar_health_check_all", undefined, { signal });
  }

  // ── DNS Tools ───────────────────────────────────────────────────────────

  static async parseCsvRecords(text: string): Promise<PartialDNSRecord[]> {
    return invoke("parse_csv_records", { text });
  }

  static async parseBindZone(text: string): Promise<PartialDNSRecord[]> {
    return invoke("parse_bind_zone", { text });
  }

  static async validateDnsRecord(
    input: DNSRecordValidationInput,
  ): Promise<ValidationResult> {
    return invoke("validate_dns_record", { input });
  }

  static async parseSrv(content: string): Promise<SRVFields> {
    return invoke("parse_srv", { content });
  }

  static async composeSrv(
    priority?: number,
    weight?: number,
    port?: number,
    target?: string,
  ): Promise<string> {
    return invoke("compose_srv", {
      priority,
      weight,
      port,
      target: target ?? "",
    });
  }

  static async parseTlsa(content: string): Promise<TLSAFields> {
    return invoke("parse_tlsa", { content });
  }

  static async composeTlsa(
    usage?: number,
    selector?: number,
    matchingType?: number,
    data?: string,
  ): Promise<string> {
    return invoke("compose_tlsa", {
      usage,
      selector,
      matchingType,
      data: data ?? "",
    });
  }

  static async parseSshfp(content: string): Promise<SSHFPFields> {
    return invoke("parse_sshfp", { content });
  }

  static async composeSshfp(
    algorithm?: number,
    fptype?: number,
    fingerprint?: string,
  ): Promise<string> {
    return invoke("compose_sshfp", {
      algorithm,
      fptype,
      fingerprint: fingerprint ?? "",
    });
  }

  static async parseNaptr(content: string): Promise<NAPTRFields> {
    return invoke("parse_naptr", { content });
  }

  static async composeNaptr(
    order?: number,
    preference?: number,
    flags?: string,
    service?: string,
    regexp?: string,
    replacement?: string,
  ): Promise<string> {
    return invoke("compose_naptr", {
      order,
      preference,
      flags: flags ?? "",
      service: service ?? "",
      regexp: regexp ?? "",
      replacement: replacement ?? "",
    });
  }

  static async recordsToCsv(
    records: TauriDNSRecord[],
    signal?: AbortSignal,
  ): Promise<string> {
    return invoke("records_to_csv", { records }, { signal });
  }

  static async recordsToBind(
    records: TauriDNSRecord[],
    signal?: AbortSignal,
  ): Promise<string> {
    return invoke("records_to_bind", { records }, { signal });
  }

  static async recordsToJson(
    records: TauriDNSRecord[],
    signal?: AbortSignal,
  ): Promise<string> {
    return invoke("records_to_json", { records }, { signal });
  }

  static async parseSpf(content: string): Promise<SPFRecord | null> {
    return invoke("parse_spf", { content });
  }

  // ── Domain Audit ────────────────────────────────────────────────────────

  static async runDomainAudit(
    zoneName: string,
    records: TauriDNSRecord[],
    options: DomainAuditOptions,
  ): Promise<DomainAuditItem[]> {
    return invoke("run_domain_audit", { zoneName, records, options });
  }

  // ── Biometric Authentication ──────────────────────────────────────────────

  static async biometricStatus(): Promise<BiometricStatus> {
    return invoke("biometric_status");
  }

  static async biometricAuthenticate(reason: string): Promise<void> {
    return invoke("biometric_authenticate", { reason });
  }

  static async biometricStoreSecret(
    key: string,
    secret: string,
  ): Promise<void> {
    return invoke("biometric_store_secret", { key, secret });
  }

  static async biometricGetSecret(
    key: string,
    reason: string,
  ): Promise<string> {
    return invoke("biometric_get_secret", { key, reason });
  }

  static async biometricDeleteSecret(key: string): Promise<void> {
    return invoke("biometric_delete_secret", { key });
  }

  static async biometricHasSecret(key: string): Promise<boolean> {
    return invoke("biometric_has_secret", { key });
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  static async getZoneAnalytics(
    apiKey: string,
    zoneId: string,
    since?: string,
    until?: string,
    email?: string,
    continuous?: boolean,
    signal?: AbortSignal,
  ): Promise<ZoneAnalytics> {
    return invoke(
      "get_zone_analytics",
      {
        apiKey,
        zoneId,
        since: since ?? null,
        until: until ?? null,
        email: email ?? null,
        continuous: continuous ?? null,
      },
      { signal },
    );
  }

  static async getDnsAnalytics(
    apiKey: string,
    zoneId: string,
    since?: string,
    until?: string,
    email?: string,
    dimensions?: string[],
    metrics?: string[],
    signal?: AbortSignal,
  ): Promise<DnsAnalyticsResponse> {
    return invoke(
      "get_dns_analytics",
      {
        apiKey,
        zoneId,
        since: since ?? null,
        until: until ?? null,
        email: email ?? null,
        dimensions: dimensions ?? null,
        metrics: metrics ?? null,
      },
      { signal },
    );
  }

  // ── Firewall / WAF ───────────────────────────────────────────────────────

  static async getFirewallRules(
    apiKey: string,
    zoneId: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<FirewallRuleResponse[]> {
    return invoke("get_firewall_rules", { apiKey, zoneId, email }, { signal });
  }

  static async createFirewallRule(
    apiKey: string,
    zoneId: string,
    rule: FirewallRuleInput,
    email?: string,
    signal?: AbortSignal,
  ): Promise<FirewallRuleResponse[]> {
    return invoke(
      "create_firewall_rule",
      { apiKey, zoneId, rule, email },
      { signal },
    );
  }

  static async updateFirewallRule(
    apiKey: string,
    zoneId: string,
    ruleId: string,
    rule: FirewallRuleInput,
    email?: string,
    signal?: AbortSignal,
  ): Promise<FirewallRuleResponse> {
    return invoke(
      "update_firewall_rule",
      {
        apiKey,
        zoneId,
        ruleId,
        rule,
        email,
      },
      { signal },
    );
  }

  static async deleteFirewallRule(
    apiKey: string,
    zoneId: string,
    ruleId: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return invoke(
      "delete_firewall_rule",
      { apiKey, zoneId, ruleId, email },
      { signal },
    );
  }

  static async getIpAccessRules(
    apiKey: string,
    zoneId: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<IpAccessRuleResponse[]> {
    return invoke("get_ip_access_rules", { apiKey, zoneId, email }, { signal });
  }

  static async createIpAccessRule(
    apiKey: string,
    zoneId: string,
    mode: string,
    ip: string,
    notes?: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<IpAccessRuleResponse> {
    return invoke(
      "create_ip_access_rule",
      {
        apiKey,
        zoneId,
        mode,
        ip,
        notes,
        email,
      },
      { signal },
    );
  }

  static async deleteIpAccessRule(
    apiKey: string,
    zoneId: string,
    ruleId: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return invoke(
      "delete_ip_access_rule",
      { apiKey, zoneId, ruleId, email },
      { signal },
    );
  }

  static async getWafRulesets(
    apiKey: string,
    zoneId: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<WafRulesetResponse[]> {
    return invoke("get_waf_rulesets", { apiKey, zoneId, email }, { signal });
  }

  // ── Workers ───────────────────────────────────────────────────────────────

  static async getWorkerRoutes(
    apiKey: string,
    zoneId: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<WorkerRouteResponse[]> {
    return invoke("get_worker_routes", { apiKey, zoneId, email }, { signal });
  }

  static async createWorkerRoute(
    apiKey: string,
    zoneId: string,
    pattern: string,
    script: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<WorkerRouteResponse> {
    return invoke(
      "create_worker_route",
      {
        apiKey,
        zoneId,
        pattern,
        script,
        email,
      },
      { signal },
    );
  }

  static async deleteWorkerRoute(
    apiKey: string,
    zoneId: string,
    routeId: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return invoke(
      "delete_worker_route",
      { apiKey, zoneId, routeId, email },
      { signal },
    );
  }

  // ── Email Routing ─────────────────────────────────────────────────────────

  static async getEmailRoutingSettings(
    apiKey: string,
    zoneId: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<EmailRoutingSettingsResponse> {
    return invoke(
      "get_email_routing_settings",
      { apiKey, zoneId, email },
      { signal },
    );
  }

  static async getEmailRoutingRules(
    apiKey: string,
    zoneId: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<EmailRoutingRuleResponse[]> {
    return invoke(
      "get_email_routing_rules",
      { apiKey, zoneId, email },
      { signal },
    );
  }

  static async createEmailRoutingRule(
    apiKey: string,
    zoneId: string,
    rule: EmailRoutingRuleInput,
    email?: string,
    signal?: AbortSignal,
  ): Promise<EmailRoutingRuleResponse> {
    return invoke(
      "create_email_routing_rule",
      { apiKey, zoneId, rule, email },
      { signal },
    );
  }

  static async deleteEmailRoutingRule(
    apiKey: string,
    zoneId: string,
    ruleId: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return invoke(
      "delete_email_routing_rule",
      {
        apiKey,
        zoneId,
        ruleId,
        email,
      },
      { signal },
    );
  }

  // ── Page Rules ────────────────────────────────────────────────────────────

  static async getPageRules(
    apiKey: string,
    zoneId: string,
    email?: string,
    signal?: AbortSignal,
  ): Promise<PageRuleResponse[]> {
    return invoke("get_page_rules", { apiKey, zoneId, email }, { signal });
  }

  // ── Bulk Operations ───────────────────────────────────────────────────────

  static async deleteBulkDnsRecords(
    apiKey: string,
    zoneId: string,
    recordIds: string[],
    email?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return invoke(
      "delete_bulk_dns_records",
      {
        apiKey,
        zoneId,
        recordIds,
        email,
      },
      { signal },
    );
  }

  // ── DNS Propagation ───────────────────────────────────────────────────────

  static async checkDnsPropagation(
    domain: string,
    recordType: string,
    extraResolvers?: string[],
    signal?: AbortSignal,
  ): Promise<PropagationResult> {
    return invoke(
      "check_dns_propagation",
      {
        domain,
        recordType,
        extraResolvers,
      },
      { signal },
    );
  }
}

// ── Analytics types ───────────────────────────────────────────────────────────

export interface AnalyticsDataPoint {
  requests: number;
  bandwidth: number;
  threats: number;
  pageviews: number;
  uniques?: number;
}

export interface AnalyticsTimeseries extends AnalyticsDataPoint {
  since: string;
  until: string;
}

export interface ZoneAnalytics {
  totals: AnalyticsDataPoint;
  timeseries: AnalyticsTimeseries[];
}

export interface DnsAnalyticsRow {
  dimensions: string[];
  metrics: number[];
}

export interface DnsAnalyticsResponse {
  rows: DnsAnalyticsRow[];
  totals: Record<string, number>;
  min: Record<string, number>;
  max: Record<string, number>;
}

// ── Firewall / WAF types ──────────────────────────────────────────────────────

export interface FirewallFilterResponse {
  id: string;
  expression: string;
  paused?: boolean;
  description?: string;
}

export interface FirewallRuleResponse {
  id: string;
  paused: boolean;
  action: string;
  priority?: number;
  description?: string;
  filter: FirewallFilterResponse;
}

export interface FirewallRuleInput {
  action: string;
  description?: string;
  paused?: boolean;
  priority?: number;
  filter: { expression: string; paused?: boolean };
}

export interface IpAccessRuleResponse {
  id: string;
  mode: string;
  notes?: string;
  configuration: { target: string; value: string };
  allowed_modes: string[];
}

export interface WafRulesetResponse {
  id: string;
  name: string;
  description?: string;
  kind: string;
  phase: string;
}

// ── Worker types ──────────────────────────────────────────────────────────────

export interface WorkerRouteResponse {
  id: string;
  pattern: string;
  script: string;
}

// ── Email Routing types ───────────────────────────────────────────────────────

export interface EmailRoutingMatcherResponse {
  type: string;
  field?: string;
  value?: string;
}

export interface EmailRoutingActionResponse {
  type: string;
  value?: string[];
}

export interface EmailRoutingRuleResponse {
  id?: string;
  tag?: string;
  name?: string;
  enabled: boolean;
  matchers: EmailRoutingMatcherResponse[];
  actions: EmailRoutingActionResponse[];
  priority?: number;
}

export interface EmailRoutingRuleInput {
  name?: string;
  enabled?: boolean;
  matchers: EmailRoutingMatcherResponse[];
  actions: EmailRoutingActionResponse[];
  priority?: number;
}

export interface EmailRoutingSettingsResponse {
  enabled: boolean;
  name?: string;
  tag?: string;
  created?: string;
  modified?: string;
  skip_wizard?: boolean;
  status?: string;
}

// ── Page Rules types ──────────────────────────────────────────────────────────

export interface PageRuleTarget {
  target: string;
  constraint: { operator: string; value: string };
}

export interface PageRuleAction {
  id: string;
  value?: unknown;
}

export interface PageRuleResponse {
  id: string;
  targets: PageRuleTarget[];
  actions: PageRuleAction[];
  priority?: number;
  status: string;
  created_on?: string;
  modified_on?: string;
}

// ── DNS Propagation types ─────────────────────────────────────────────────────

export interface PropagationResolverResult {
  resolver: string;
  label: string;
  records: string[];
  rcode: string;
  latency_ms: number;
  error?: string;
}

export interface PropagationResult {
  domain: string;
  record_type: string;
  resolvers: PropagationResolverResult[];
  consistent: boolean;
  timestamp: string;
}

// ── DNS Tools types ───────────────────────────────────────────────────────────

export interface PartialDNSRecord {
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
}

export interface DNSRecordValidationInput {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  issues: string[];
}

export interface SRVFields {
  priority?: number;
  weight?: number;
  port?: number;
  target: string;
}

export interface TLSAFields {
  usage?: number;
  selector?: number;
  matching_type?: number;
  data: string;
}

export interface SSHFPFields {
  algorithm?: number;
  fptype?: number;
  fingerprint: string;
}

export interface NAPTRFields {
  order?: number;
  preference?: number;
  flags: string;
  service: string;
  regexp: string;
  replacement: string;
}

export interface SPFMechanism {
  qualifier?: string;
  mechanism: string;
  value?: string;
}

export interface SPFModifier {
  key: string;
  value: string;
}

export interface SPFRecord {
  version: string;
  mechanisms: SPFMechanism[];
  modifiers: SPFModifier[];
}

// ── Domain Audit types ────────────────────────────────────────────────────────

export type DomainAuditSeverity = "pass" | "info" | "warn" | "fail";
export type DomainAuditCategory = "email" | "security" | "hygiene";

export interface DomainAuditSuggestion {
  recordType: string;
  name: string;
  content: string;
}

export interface DomainAuditItem {
  id: string;
  category: DomainAuditCategory;
  severity: DomainAuditSeverity;
  title: string;
  details: string;
  suggestion?: DomainAuditSuggestion;
}

export interface DomainAuditOptions {
  includeCategories: {
    email: boolean;
    security: boolean;
    hygiene: boolean;
  };
  domainExpiresAt?: string | null;
}

// ── Biometric types ────────────────────────────────────────────────────────

export type BiometricType =
  | "touchId"
  | "faceId"
  | "windowsHello"
  | "fingerprint"
  | "none";

export interface BiometricStatus {
  available: boolean;
  biometricType: BiometricType;
  reason?: string;
}
