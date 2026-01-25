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

export class TauriClient {
  // Check if running in Tauri environment
  static isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI__' in window;
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

  // Vault Operations
  static async storeVaultSecret(id: string, secret: string): Promise<void> {
    return invoke("store_vault_secret", { id, secret });
  }

  static async getVaultSecret(id: string): Promise<string> {
    return invoke("get_vault_secret", { id });
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
  static async getEncryptionSettings(): Promise<unknown> {
    return invoke("get_encryption_settings");
  }

  static async updateEncryptionSettings(config: unknown): Promise<void> {
    return invoke("update_encryption_settings", { config });
  }

  static async benchmarkEncryption(iterations: number): Promise<number> {
    return invoke("benchmark_encryption", { iterations });
  }

  // Audit
  static async getAuditEntries(): Promise<unknown[]> {
    return invoke("get_audit_entries");
  }
}
