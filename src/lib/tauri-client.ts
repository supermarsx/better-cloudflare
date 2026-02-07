/**
 * Tauri API client wrapper
 * 
 * This file provides a unified interface for calling Tauri backend commands.
 * It replaces the HTTP-based ServerClient for desktop app usage.
 */

import { invoke } from "@tauri-apps/api/core";

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
  error?: string | null;
}

export interface TopologyServiceProbeResult {
  host: string;
  https_up: boolean;
  http_up: boolean;
}

export interface TopologyBatchResult {
  resolutions: TopologyHostnameResolution[];
  probes: TopologyServiceProbeResult[];
}

export class TauriClient {
  // Check if running in Tauri environment
  static isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI__' in window;
  }

  static async restartApp(): Promise<void> {
    return invoke("restart_app");
  }

  static async openPathInFileManager(path: string): Promise<void> {
    return invoke("open_path_in_file_manager", { path });
  }

  // Authentication & Key Management
  static async verifyToken(apiKey: string, email?: string): Promise<boolean> {
    return invoke("verify_token", { apiKey, email });
  }

  static async getApiKeys(): Promise<unknown[]> {
    return invoke("get_api_keys");
  }

  static async addApiKey(
    label: string,
    apiKey: string,
    email: string | undefined,
    password: string
  ): Promise<string> {
    return invoke("add_api_key", { label, apiKey, email, password });
  }

  static async updateApiKey(
    id: string,
    label?: string,
    email?: string,
    currentPassword?: string,
    newPassword?: string
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
  static async getZones(apiKey: string, email?: string): Promise<TauriZone[]> {
    return invoke("get_zones", { apiKey, email });
  }

  static async getDNSRecords(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    _page?: number,
    _perPage?: number
  ): Promise<TauriDNSRecord[]> {
    return invoke("get_dns_records", {
      apiKey,
      email,
      zoneId,
      page: _page,
      per_page: _perPage,
    });
  }

  static async createDNSRecord(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    record: TauriDNSRecordInput
  ): Promise<TauriDNSRecord> {
    return invoke("create_dns_record", { apiKey, email, zoneId, record });
  }

  static async updateDNSRecord(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    recordId: string,
    record: TauriDNSRecordInput
  ): Promise<TauriDNSRecord> {
    return invoke("update_dns_record", {
      apiKey,
      email,
      zoneId,
      recordId,
      record,
    });
  }

  static async deleteDNSRecord(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    recordId: string
  ): Promise<void> {
    return invoke("delete_dns_record", { apiKey, email, zoneId, recordId });
  }

  static async createBulkDNSRecords(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    records: TauriDNSRecordInput[],
    _dryrun?: boolean
  ): Promise<{ created: TauriDNSRecord[]; skipped: unknown[] }> {
    return invoke("create_bulk_dns_records", {
      apiKey,
      email,
      zoneId,
      records,
      dryrun: _dryrun,
    });
  }

  static async exportDNSRecords(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    format: string,
    page?: number,
    perPage?: number
  ): Promise<string> {
    return invoke("export_dns_records", {
      apiKey,
      email,
      zoneId,
      format,
      page,
      per_page: perPage,
    });
  }

  static async purgeCache(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    purgeEverything: boolean,
    files?: string[],
  ): Promise<unknown> {
    return invoke("purge_cache", {
      apiKey,
      email,
      zoneId,
      purgeEverything,
      files,
    });
  }

  static async getZoneSetting(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    settingId: string,
  ): Promise<unknown> {
    return invoke("get_zone_setting", { apiKey, email, zoneId, settingId });
  }

  static async updateZoneSetting(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    settingId: string,
    value: unknown,
  ): Promise<unknown> {
    return invoke("update_zone_setting", {
      apiKey,
      email,
      zoneId,
      settingId,
      value,
    });
  }

  static async getDnssec(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
  ): Promise<unknown> {
    return invoke("get_dnssec", { apiKey, email, zoneId });
  }

  static async updateDnssec(
    apiKey: string,
    email: string | undefined,
    zoneId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    return invoke("update_dnssec", { apiKey, email, zoneId, payload });
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
  static async getPasskeyRegistrationOptions(id: string): Promise<unknown> {
    return invoke("get_passkey_registration_options", { id });
  }

  static async registerPasskey(
    id: string,
    attestation: unknown
  ): Promise<void> {
    return invoke("register_passkey", { id, attestation });
  }

  static async getPasskeyAuthOptions(id: string): Promise<unknown> {
    return invoke("get_passkey_auth_options", { id });
  }

  static async authenticatePasskey(
    id: string,
    assertion: unknown
  ): Promise<unknown> {
    return invoke("authenticate_passkey", { id, assertion });
  }

  static async listPasskeys(id: string): Promise<unknown[]> {
    return invoke("list_passkeys", { id });
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
        typeof obj.iterations === "number" ? obj.iterations : fallback.iterations,
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
      config.keyLength > 64 ? Math.floor(config.keyLength / 8) : config.keyLength;
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
    format: "json" | "csv" = "json"
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
    ip: string
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
  ): Promise<TopologyBatchResult> {
    return invoke("resolve_topology_batch", {
      hostnames,
      max_hops: maxHops,
      service_hosts: serviceHosts,
      doh_provider: dohProvider,
      doh_custom_url: dohCustomUrl,
      resolver_mode: resolverMode,
      dns_server: dnsServer,
      custom_dns_server: customDnsServer,
      lookup_timeout_ms: lookupTimeoutMs,
      disable_ptr_lookups: disablePtrLookups,
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

  static async updatePreferenceFields(fields: Record<string, unknown>): Promise<void> {
    const current = await this.getPreferences();
    return this.updatePreferences({ ...(current as Record<string, unknown>), ...fields });
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

  static async verifyRegistrarCredential(credentialId: string): Promise<boolean> {
    return invoke("verify_registrar_credential", { credentialId });
  }

  static async registrarListDomains(credentialId: string): Promise<unknown[]> {
    return invoke("registrar_list_domains", { credentialId });
  }

  static async registrarGetDomain(credentialId: string, domain: string): Promise<unknown> {
    return invoke("registrar_get_domain", { credentialId, domain });
  }

  static async registrarListAllDomains(): Promise<unknown[]> {
    return invoke("registrar_list_all_domains");
  }

  static async registrarHealthCheck(credentialId: string, domain: string): Promise<unknown> {
    return invoke("registrar_health_check", { credentialId, domain });
  }

  static async registrarHealthCheckAll(): Promise<unknown[]> {
    return invoke("registrar_health_check_all");
  }
}
