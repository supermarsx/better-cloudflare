/**
 * Client-side storage manager used for storing encrypted API keys and
 * session metadata. This provides convenience methods to add, remove,
 * update, and export/import encrypted data.
 */
import {
  ENCRYPTION_ALGORITHMS,
  type ApiKey,
  type EncryptionAlgorithm,
} from "../types/dns";
import { CryptoManager } from "./crypto";
import { getStorage, type StorageLike } from "./storage-util";
import { generateUUID } from "./utils";

const STORAGE_KEY = "cloudflare-dns-manager";

interface StorageData {
  apiKeys: ApiKey[];
  currentSession?: string;
  lastZone?: string;
  lastActiveTabId?: string;
  dnsTableColumns?: string[];
  zoneDnsTableColumns?: Record<string, string[]>;
  vaultEnabled?: boolean;
  autoRefreshInterval?: number;
  defaultPerPage?: number;
  zonePerPage?: Record<string, number>;
  showUnsupportedRecordTypes?: boolean;
  zoneShowUnsupportedRecordTypes?: Record<string, boolean>;
  confirmDeleteRecord?: boolean;
  zoneConfirmDeleteRecord?: Record<string, boolean>;
  reopenLastTabs?: boolean;
  reopenZoneTabs?: Record<string, boolean>;
  lastOpenTabs?: string[];
  recordTags?: Record<string, Record<string, string[]>>;
  tagCatalog?: Record<string, string[]>;
  confirmLogout?: boolean;
  idleLogoutMs?: number | null;
  confirmWindowClose?: boolean;
  loadingOverlayTimeoutMs?: number;
  topologyResolutionMaxHops?: number;
  topologyResolverMode?: "dns" | "doh";
  topologyDnsServer?: string;
  topologyCustomDnsServer?: string;
  topologyDohProvider?: "google" | "cloudflare" | "quad9" | "custom";
  topologyDohCustomUrl?: string;
  topologyExportFolderPreset?: string;
  topologyExportCustomPath?: string;
  topologyExportConfirmPath?: boolean;
  topologyDisableAnnotations?: boolean;
  topologyDisableFullWindow?: boolean;
  topologyLookupTimeoutMs?: number;
  topologyDisablePtrLookups?: boolean;
  topologyDisableServiceDiscovery?: boolean;
  topologyTcpServices?: string[];
  auditExportDefaultDocuments?: boolean;
  confirmClearAuditLogs?: boolean;
  auditExportFolderPreset?: string;
  auditExportCustomPath?: string;
  auditExportSkipDestinationConfirm?: boolean;
  domainAuditCategories?: {
    email?: boolean;
    security?: boolean;
    hygiene?: boolean;
  };
  sessionSettingsProfiles?: Record<string, SessionSettingsProfile>;
  auditOverrides?: Record<string, string[]>;
}

export interface SessionSettingsProfile {
  autoRefreshInterval?: number | null;
  defaultPerPage?: number;
  zonePerPage?: Record<string, number>;
  showUnsupportedRecordTypes?: boolean;
  zoneShowUnsupportedRecordTypes?: Record<string, boolean>;
  reopenLastTabs?: boolean;
  reopenZoneTabs?: Record<string, boolean>;
  confirmLogout?: boolean;
  idleLogoutMs?: number | null;
  confirmWindowClose?: boolean;
  loadingOverlayTimeoutMs?: number;
  topologyResolutionMaxHops?: number;
  topologyResolverMode?: "dns" | "doh";
  topologyDnsServer?: string;
  topologyCustomDnsServer?: string;
  topologyDohProvider?: "google" | "cloudflare" | "quad9" | "custom";
  topologyDohCustomUrl?: string;
  topologyExportFolderPreset?: string;
  topologyExportCustomPath?: string;
  topologyExportConfirmPath?: boolean;
  topologyDisableAnnotations?: boolean;
  topologyDisableFullWindow?: boolean;
  topologyLookupTimeoutMs?: number;
  topologyDisablePtrLookups?: boolean;
  topologyDisableServiceDiscovery?: boolean;
  topologyTcpServices?: string[];
  auditExportDefaultDocuments?: boolean;
  confirmClearAuditLogs?: boolean;
  auditExportFolderPreset?: string;
  auditExportCustomPath?: string;
  auditExportSkipDestinationConfirm?: boolean;
  domainAuditCategories?: {
    email?: boolean;
    security?: boolean;
    hygiene?: boolean;
  };
}

function parseRecordTags(
  value: unknown,
): Record<string, Record<string, string[]>> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const byZone = value as Record<string, unknown>;
  const result: Record<string, Record<string, string[]>> = {};

  for (const [zoneId, zoneValue] of Object.entries(byZone)) {
    if (!zoneValue || typeof zoneValue !== "object") continue;
    const byRecord = zoneValue as Record<string, unknown>;
    const zoneResult: Record<string, string[]> = {};

    for (const [recordId, tagsValue] of Object.entries(byRecord)) {
      if (!Array.isArray(tagsValue)) continue;
      const tags = tagsValue
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter(Boolean);
      zoneResult[recordId] = Array.from(new Set(tags)).slice(0, 32);
    }

    result[zoneId] = zoneResult;
  }

  return result;
}

function parseTagCatalog(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const byZone = value as Record<string, unknown>;
  const result: Record<string, string[]> = {};
  for (const [zoneId, tagsValue] of Object.entries(byZone)) {
    if (!Array.isArray(tagsValue)) continue;
    const tags = tagsValue
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter(Boolean);
    result[zoneId] = Array.from(new Set(tags)).slice(0, 256);
  }
  return result;
}

/**
 * Type guard to assert a value conforms to the StorageData interface.
 * Useful when parsing JSON from storage and verifying shape before
 * assigning into the in-memory representation.
 */
export function isStorageData(value: unknown): value is StorageData {
  /**
   * @param value - value to validate against the StorageData shape
   * @returns true when the value conforms to StorageData, false otherwise
   */
  if (!value || typeof value !== "object") return false;
  const obj = value as {
    apiKeys?: unknown;
    currentSession?: unknown;
    lastZone?: unknown;
    confirmLogout?: unknown;
    idleLogoutMs?: unknown;
    confirmWindowClose?: unknown;
  };
  if (!Array.isArray(obj.apiKeys)) return false;
  if (
    obj.currentSession !== undefined &&
    typeof obj.currentSession !== "string"
  ) {
    return false;
  }
  if (obj.lastZone !== undefined && typeof obj.lastZone !== "string") {
    return false;
  }
  if (obj.confirmLogout !== undefined && typeof obj.confirmLogout !== "boolean") {
    return false;
  }
  if (
    obj.idleLogoutMs !== undefined &&
    obj.idleLogoutMs !== null &&
    typeof obj.idleLogoutMs !== "number"
  ) {
    return false;
  }
  if (
    obj.confirmWindowClose !== undefined &&
    typeof obj.confirmWindowClose !== "boolean"
  ) {
    return false;
  }
  return obj.apiKeys.every((k) => {
    if (!k || typeof k !== "object") return false;
    const key = k as Record<string, unknown>;
    return (
      typeof key.id === "string" &&
      typeof key.label === "string" &&
      typeof key.encryptedKey === "string" &&
      typeof key.salt === "string" &&
      typeof key.iv === "string" &&
      typeof key.iterations === "number" &&
      typeof key.keyLength === "number" &&
      typeof key.algorithm === "string" &&
      ENCRYPTION_ALGORITHMS.includes(key.algorithm as EncryptionAlgorithm) &&
      typeof key.createdAt === "string" &&
      (key.email === undefined || typeof key.email === "string")
    );
  });
}

/**
 * Manage API keys persisted in storage. Keys are stored encrypted with a
 * password passphrase; the encryption metadata (salt, iv, algorithm)
 * is stored alongside encrypted blobs. This manager provides helpers to
 * add keys, retrieve decrypted keys, and manipulate the local session.
 */
export class StorageManager {
  private data: StorageData = { apiKeys: [] };
  private storage: StorageLike;
  private crypto: CryptoManager;

  constructor(storage?: StorageLike, crypto?: CryptoManager) {
    this.storage = getStorage(storage);
    this.crypto = crypto ?? new CryptoManager({}, this.storage);
    this.load();
  }

  /**
   * Load persisted storage data from the configured StorageLike instance.
   */
  private load(): void {
    try {
      const stored = this.storage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (isStorageData(parsed)) {
          const obj = parsed as StorageData & { recordTags?: unknown };
          this.data = {
            ...obj,
            recordTags: parseRecordTags(obj.recordTags),
            tagCatalog: parseTagCatalog((obj as { tagCatalog?: unknown }).tagCatalog),
          };
        } else {
          this.data = { apiKeys: [] };
          this.storage.removeItem(STORAGE_KEY);
        }
      }
    } catch (error) {
      console.error("Failed to load storage data:", error);
      // Remove corrupted data so subsequent loads start with a clean slate.
      this.storage.removeItem(STORAGE_KEY);
      this.data = { apiKeys: [] };
    }
  }

  /**
   * Persist the in-memory data to storage as JSON.
   */
  private save(): void {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (error) {
      console.error("Failed to save storage data:", error);
    }
  }

  private dispatchRecordTagsChanged(zoneId: string, recordId?: string): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("record-tags-changed", { detail: { zoneId, recordId } }),
    );
  }

  private dispatchPreferencesChanged(fields: Record<string, unknown>): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("preferences-changed", { detail: fields }));
  }

  private ensureTagInCatalog(zoneId: string, tag: string): void {
    const catalog = (this.data.tagCatalog ??= {});
    const zoneTags = (catalog[zoneId] ??= []);
    if (zoneTags.includes(tag)) return;
    zoneTags.push(tag);
    zoneTags.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    catalog[zoneId] = zoneTags.slice(0, 256);
  }

  getZoneTags(zoneId: string): string[] {
    const tags = this.data.tagCatalog?.[zoneId];
    return Array.isArray(tags) ? [...tags] : [];
  }

  addZoneTag(zoneId: string, tag: string): void {
    const next = tag.trim();
    if (!next) return;
    this.ensureTagInCatalog(zoneId, next);
    this.save();
    this.dispatchRecordTagsChanged(zoneId);
  }

  getRecordTags(zoneId: string, recordId: string): string[] {
    const zone = this.data.recordTags?.[zoneId];
    const tags = zone?.[recordId];
    return Array.isArray(tags) ? [...tags] : [];
  }

  setRecordTags(zoneId: string, recordId: string, tags: string[]): void {
    const nextTags = Array.from(
      new Set(tags.map((t) => t.trim()).filter(Boolean)),
    ).slice(0, 32);
    for (const tag of nextTags) this.ensureTagInCatalog(zoneId, tag);
    const recordTags = (this.data.recordTags ??= {});
    const zoneMap = (recordTags[zoneId] ??= {});
    zoneMap[recordId] = nextTags;
    this.save();
    this.dispatchRecordTagsChanged(zoneId, recordId);
  }

  getTagUsageCounts(zoneId: string): Record<string, number> {
    const counts: Record<string, number> = {};
    const zone = this.data.recordTags?.[zoneId] ?? {};
    for (const tags of Object.values(zone)) {
      for (const tag of tags ?? []) {
        counts[tag] = (counts[tag] ?? 0) + 1;
      }
    }
    return counts;
  }

  renameTag(zoneId: string, from: string, to: string): void {
    const next = to.trim();
    const prev = from.trim();
    if (!prev || !next) return;
    if (prev === next) return;
    const zone = this.data.recordTags?.[zoneId];
    if (!zone) return;

    for (const [recordId, tags] of Object.entries(zone)) {
      if (!Array.isArray(tags) || !tags.includes(prev)) continue;
      zone[recordId] = Array.from(
        new Set(tags.map((t) => (t === prev ? next : t))),
      ).slice(0, 32);
    }
    const catalog = this.data.tagCatalog?.[zoneId];
    if (Array.isArray(catalog)) {
      this.data.tagCatalog = {
        ...(this.data.tagCatalog ?? {}),
        [zoneId]: Array.from(
          new Set(catalog.map((t) => (t === prev ? next : t)).filter(Boolean)),
        )
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
          .slice(0, 256),
      };
    } else {
      this.ensureTagInCatalog(zoneId, next);
    }
    this.save();
    this.dispatchRecordTagsChanged(zoneId);
  }

  deleteTag(zoneId: string, tag: string): void {
    const target = tag.trim();
    if (!target) return;
    const zone = this.data.recordTags?.[zoneId];
    if (!zone) return;

    for (const [recordId, tags] of Object.entries(zone)) {
      if (!Array.isArray(tags) || !tags.includes(target)) continue;
      zone[recordId] = tags.filter((t) => t !== target);
    }
    const catalog = this.data.tagCatalog?.[zoneId];
    if (Array.isArray(catalog)) {
      this.data.tagCatalog = {
        ...(this.data.tagCatalog ?? {}),
        [zoneId]: catalog.filter((t) => t !== target),
      };
    }
    this.save();
    this.dispatchRecordTagsChanged(zoneId);
  }

  /**
   * Add a new API key: encrypts the provided apiKey using `password` and
   * stores the resulting metadata. Returns the locally generated id.
   *
   * @param label - a friendly label for the API key
   * @param apiKey - the raw API key/token to encrypt and store
   * @param password - passphrase used to encrypt the key
   * @param email - optional email (when using key+email auth)
   * @returns generated API key id
   */
  async addApiKey(
    label: string,
    apiKey: string,
    password: string,
    email?: string,
  ): Promise<string> {
    const { encrypted, salt, iv } = await this.crypto.encrypt(apiKey, password);
    const config = this.crypto.getConfig();

    const keyData: ApiKey = {
      id: generateUUID(),
      label,
      encryptedKey: encrypted,
      salt,
      iv,
      iterations: config.iterations,
      keyLength: config.keyLength,
      algorithm: config.algorithm,
      createdAt: new Date().toISOString(),
      ...(email ? { email } : {}),
    };

    this.data.apiKeys.push(keyData);
    this.save();

    return keyData.id;
  }

  /**
   * Return a copy of all stored API keys (metadata only, encrypted key
   * content is still encrypted in the returned data).
   *
   * @returns copy of the ApiKey metadata array
   */
  getApiKeys(): ApiKey[] {
    return [...this.data.apiKeys];
  }

  /**
   * Attempt to decrypt an API key by id using `password`.
   *
   * If decryption fails (wrong password or id not found) this returns
   * `null` instead of throwing to simplify UI handling.
   *
   * @param id - the locally generated api key id
   * @param password - the password to decrypt the key with
   * @returns an object with `key` and optional `email` or null on failure
   */
  async getDecryptedApiKey(
    id: string,
    password: string,
  ): Promise<{ key: string; email?: string } | null> {
    const keyData = this.data.apiKeys.find((k) => k.id === id);
    if (!keyData) return null;

    try {
      const cm = new CryptoManager(
        {
          iterations: keyData.iterations,
          keyLength: keyData.keyLength,
          algorithm: keyData.algorithm,
        },
        this.storage,
      );
      const decrypted = await cm.decrypt(
        keyData.encryptedKey,
        keyData.salt,
        keyData.iv,
        password,
      );
      return { key: decrypted, email: keyData.email };
    } catch {
      return null;
    }
  }

  /**
   * Update an API key record. Supports renaming, changing the associated
   * email, and rotating the stored password (re-encrypts the key using the
   * new password - `currentPassword` is required for rotation).
   *
   * @param id - api key id to update
   * @param updates - partial update object; supported fields: label, email,
   *  currentPassword, newPassword
   */
  async updateApiKey(
    id: string,
    updates: {
      label?: string;
      email?: string;
      currentPassword?: string;
      newPassword?: string;
    },
  ): Promise<void> {
    const keyData = this.data.apiKeys.find((k) => k.id === id);
    if (!keyData) {
      throw new Error("API key not found");
    }

    if (updates.label !== undefined) {
      keyData.label = updates.label;
    }

    if (updates.email !== undefined) {
      keyData.email = updates.email || undefined;
    }

    if (updates.newPassword) {
      if (!updates.currentPassword) {
        throw new Error("Current password required");
      }

      const cm = new CryptoManager(
        {
          iterations: keyData.iterations,
          keyLength: keyData.keyLength,
          algorithm: keyData.algorithm,
        },
        this.storage,
      );

      const decrypted = await cm.decrypt(
        keyData.encryptedKey,
        keyData.salt,
        keyData.iv,
        updates.currentPassword,
      );

      const { encrypted, salt, iv } = await this.crypto.encrypt(
        decrypted,
        updates.newPassword,
      );
      const config = this.crypto.getConfig();
      keyData.encryptedKey = encrypted;
      keyData.salt = salt;
      keyData.iv = iv;
      keyData.iterations = config.iterations;
      keyData.keyLength = config.keyLength;
      keyData.algorithm = config.algorithm;
    }

    this.save();
  }

  /**
   * Remove an API key by id and clear the current session if it referenced
   * the removed key.
   *
   * @param id - id of the key to remove
   */
  removeApiKey(id: string): void {
    this.data.apiKeys = this.data.apiKeys.filter((k) => k.id !== id);
    if (this.data.currentSession === id) {
      this.data.currentSession = undefined;
    }
    this.save();
  }

  /**
   * Set the active session to the provided API key id.
   */
  setCurrentSession(id: string): void {
    this.data.currentSession = id;
    this.save();
  }

  /**
   * Read the currently active session id.
   *
   * @returns the active session id or `undefined` when not set
   */
  getCurrentSession(): string | undefined {
    return this.data.currentSession;
  }

  /**
   * Clear the active session and last zone stored for the session.
   */
  clearSession(): void {
    this.data.currentSession = undefined;
    this.data.lastZone = undefined;
    this.save();
  }

  /**
   * Keep track of the last selected zone for UX convenience.
   */
  setLastZone(zoneId: string): void {
    this.data.lastZone = zoneId;
    this.save();
  }

  /**
   * Get the last selected zone id if present.
   *
   * @returns the last selected zone id or `undefined` when not set
   */
  getLastZone(): string | undefined {
    return this.data.lastZone;
  }

  setVaultEnabled(enabled: boolean): void {
    this.data.vaultEnabled = enabled;
    this.save();
  }

  getVaultEnabled(): boolean {
    return !!this.data.vaultEnabled;
  }

  setAutoRefreshInterval(interval: number | null): void {
    this.data.autoRefreshInterval = interval ?? undefined;
    this.save();
  }

  getAutoRefreshInterval(): number | null {
    return this.data.autoRefreshInterval ?? null;
  }

  setDefaultPerPage(value: number | null): void {
    this.data.defaultPerPage = value ?? undefined;
    this.save();
  }

  getDefaultPerPage(): number {
    return this.data.defaultPerPage ?? 50;
  }

  setShowUnsupportedRecordTypes(enabled: boolean): void {
    this.data.showUnsupportedRecordTypes = enabled;
    this.save();
  }

  getShowUnsupportedRecordTypes(): boolean {
    return this.data.showUnsupportedRecordTypes === true;
  }

  setZoneShowUnsupportedRecordTypes(zoneId: string, enabled: boolean | null): void {
    if (!this.data.zoneShowUnsupportedRecordTypes) {
      this.data.zoneShowUnsupportedRecordTypes = {};
    }
    if (enabled === null) {
      delete this.data.zoneShowUnsupportedRecordTypes[zoneId];
    } else {
      this.data.zoneShowUnsupportedRecordTypes[zoneId] = enabled;
    }
    this.save();
  }

  setZoneShowUnsupportedRecordTypesMap(map: Record<string, boolean>): void {
    this.data.zoneShowUnsupportedRecordTypes = { ...map };
    this.save();
  }

  getZoneShowUnsupportedRecordTypesMap(): Record<string, boolean> {
    return { ...(this.data.zoneShowUnsupportedRecordTypes ?? {}) };
  }

  setConfirmDeleteRecord(enabled: boolean): void {
    this.data.confirmDeleteRecord = enabled;
    this.save();
  }

  getConfirmDeleteRecord(): boolean {
    // Default to true (safer) unless explicitly disabled.
    return this.data.confirmDeleteRecord !== false;
  }

  setZoneConfirmDeleteRecord(zoneId: string, enabled: boolean | null): void {
    if (!this.data.zoneConfirmDeleteRecord) {
      this.data.zoneConfirmDeleteRecord = {};
    }
    if (enabled === null) {
      delete this.data.zoneConfirmDeleteRecord[zoneId];
    } else {
      this.data.zoneConfirmDeleteRecord[zoneId] = enabled;
    }
    this.save();
  }

  setZoneConfirmDeleteRecordMap(map: Record<string, boolean>): void {
    this.data.zoneConfirmDeleteRecord = { ...map };
    this.save();
  }

  getZoneConfirmDeleteRecordMap(): Record<string, boolean> {
    return { ...(this.data.zoneConfirmDeleteRecord ?? {}) };
  }

  setConfirmLogout(enabled: boolean): void {
    this.data.confirmLogout = enabled;
    this.save();
    this.dispatchPreferencesChanged({ confirmLogout: enabled });
  }

  getConfirmLogout(): boolean {
    return this.data.confirmLogout !== false;
  }

  setIdleLogoutMs(ms: number | null): void {
    this.data.idleLogoutMs = ms ?? null;
    this.save();
    this.dispatchPreferencesChanged({ idleLogoutMs: ms ?? null });
  }

  getIdleLogoutMs(): number | null {
    return typeof this.data.idleLogoutMs === "number" ? this.data.idleLogoutMs : null;
  }

  setConfirmWindowClose(enabled: boolean): void {
    this.data.confirmWindowClose = enabled;
    this.save();
    this.dispatchPreferencesChanged({ confirmWindowClose: enabled });
  }

  getConfirmWindowClose(): boolean {
    return this.data.confirmWindowClose !== false;
  }

  setLoadingOverlayTimeoutMs(ms: number): void {
    const clamped = Math.max(1000, Math.min(60000, Math.round(ms)));
    this.data.loadingOverlayTimeoutMs = clamped;
    this.save();
    this.dispatchPreferencesChanged({ loadingOverlayTimeoutMs: clamped });
  }

  getLoadingOverlayTimeoutMs(): number {
    const value = this.data.loadingOverlayTimeoutMs;
    if (typeof value !== "number" || Number.isNaN(value)) return 60000;
    return Math.max(1000, Math.min(60000, Math.round(value)));
  }

  setTopologyResolutionMaxHops(value: number): void {
    const clamped = Math.max(1, Math.min(15, Math.round(value)));
    this.data.topologyResolutionMaxHops = clamped;
    this.save();
    this.dispatchPreferencesChanged({ topologyResolutionMaxHops: clamped });
  }

  getTopologyResolutionMaxHops(): number {
    const value = this.data.topologyResolutionMaxHops;
    if (typeof value !== "number" || Number.isNaN(value)) return 15;
    return Math.max(1, Math.min(15, Math.round(value)));
  }

  setTopologyResolverMode(value: "dns" | "doh"): void {
    this.data.topologyResolverMode = value;
    this.save();
    this.dispatchPreferencesChanged({ topologyResolverMode: value });
  }

  getTopologyResolverMode(): "dns" | "doh" {
    return this.data.topologyResolverMode === "doh" ? "doh" : "dns";
  }

  setTopologyDnsServer(value: string): void {
    this.data.topologyDnsServer = String(value ?? "").trim() || "1.1.1.1";
    this.save();
    this.dispatchPreferencesChanged({ topologyDnsServer: this.data.topologyDnsServer });
  }

  getTopologyDnsServer(): string {
    return String(this.data.topologyDnsServer ?? "1.1.1.1").trim() || "1.1.1.1";
  }

  setTopologyCustomDnsServer(value: string): void {
    this.data.topologyCustomDnsServer = String(value ?? "").trim();
    this.save();
    this.dispatchPreferencesChanged({ topologyCustomDnsServer: this.data.topologyCustomDnsServer });
  }

  getTopologyCustomDnsServer(): string {
    return String(this.data.topologyCustomDnsServer ?? "").trim();
  }

  setTopologyDohProvider(value: "google" | "cloudflare" | "quad9" | "custom"): void {
    this.data.topologyDohProvider = value;
    this.save();
    this.dispatchPreferencesChanged({ topologyDohProvider: value });
  }

  getTopologyDohProvider(): "google" | "cloudflare" | "quad9" | "custom" {
    const value = this.data.topologyDohProvider;
    if (value === "cloudflare" || value === "quad9" || value === "custom") return value;
    return "cloudflare";
  }

  setTopologyDohCustomUrl(value: string): void {
    this.data.topologyDohCustomUrl = String(value ?? "").trim();
    this.save();
    this.dispatchPreferencesChanged({ topologyDohCustomUrl: this.data.topologyDohCustomUrl });
  }

  getTopologyDohCustomUrl(): string {
    return String(this.data.topologyDohCustomUrl ?? "").trim();
  }

  setTopologyExportFolderPreset(preset: string): void {
    this.data.topologyExportFolderPreset = preset;
    this.save();
    this.dispatchPreferencesChanged({ topologyExportFolderPreset: preset });
  }

  getTopologyExportFolderPreset(): string {
    return this.data.topologyExportFolderPreset ?? "documents";
  }

  setTopologyExportCustomPath(path: string): void {
    this.data.topologyExportCustomPath = String(path ?? "").trim();
    this.save();
    this.dispatchPreferencesChanged({ topologyExportCustomPath: this.data.topologyExportCustomPath });
  }

  getTopologyExportCustomPath(): string {
    return String(this.data.topologyExportCustomPath ?? "").trim();
  }

  setTopologyExportConfirmPath(enabled: boolean): void {
    this.data.topologyExportConfirmPath = enabled;
    this.save();
    this.dispatchPreferencesChanged({ topologyExportConfirmPath: enabled });
  }

  getTopologyExportConfirmPath(): boolean {
    return this.data.topologyExportConfirmPath !== false;
  }

  setTopologyDisableAnnotations(enabled: boolean): void {
    this.data.topologyDisableAnnotations = enabled;
    this.save();
    this.dispatchPreferencesChanged({ topologyDisableAnnotations: enabled });
  }

  getTopologyDisableAnnotations(): boolean {
    return this.data.topologyDisableAnnotations === true;
  }

  setTopologyDisableFullWindow(enabled: boolean): void {
    this.data.topologyDisableFullWindow = enabled;
    this.save();
    this.dispatchPreferencesChanged({ topologyDisableFullWindow: enabled });
  }

  getTopologyDisableFullWindow(): boolean {
    return this.data.topologyDisableFullWindow === true;
  }

  setTopologyLookupTimeoutMs(ms: number): void {
    const clamped = Math.max(250, Math.min(10000, Math.round(ms)));
    this.data.topologyLookupTimeoutMs = clamped;
    this.save();
    this.dispatchPreferencesChanged({ topologyLookupTimeoutMs: clamped });
  }

  getTopologyLookupTimeoutMs(): number {
    const value = this.data.topologyLookupTimeoutMs;
    if (typeof value !== "number" || Number.isNaN(value)) return 1200;
    return Math.max(250, Math.min(10000, Math.round(value)));
  }

  setTopologyDisablePtrLookups(enabled: boolean): void {
    this.data.topologyDisablePtrLookups = enabled;
    this.save();
    this.dispatchPreferencesChanged({ topologyDisablePtrLookups: enabled });
  }

  getTopologyDisablePtrLookups(): boolean {
    return this.data.topologyDisablePtrLookups === true;
  }

  setTopologyDisableServiceDiscovery(enabled: boolean): void {
    this.data.topologyDisableServiceDiscovery = enabled;
    this.save();
    this.dispatchPreferencesChanged({ topologyDisableServiceDiscovery: enabled });
  }

  getTopologyDisableServiceDiscovery(): boolean {
    return this.data.topologyDisableServiceDiscovery === true;
  }

  setTopologyTcpServices(services: string[]): void {
    const next = Array.from(new Set((services ?? []).map((s) => String(s).trim()).filter(Boolean)));
    this.data.topologyTcpServices = next;
    this.save();
    this.dispatchPreferencesChanged({ topologyTcpServices: next });
  }

  getTopologyTcpServices(): string[] {
    const value = this.data.topologyTcpServices;
    if (!Array.isArray(value)) return ["80", "443", "22"];
    return Array.from(new Set(value.map((v) => String(v).trim()).filter(Boolean)));
  }

  setAuditExportDefaultDocuments(enabled: boolean): void {
    this.data.auditExportDefaultDocuments = enabled;
    this.save();
    this.dispatchPreferencesChanged({ auditExportDefaultDocuments: enabled });
  }

  getAuditExportDefaultDocuments(): boolean {
    return this.data.auditExportDefaultDocuments !== false;
  }

  setConfirmClearAuditLogs(enabled: boolean): void {
    this.data.confirmClearAuditLogs = enabled;
    this.save();
    this.dispatchPreferencesChanged({ confirmClearAuditLogs: enabled });
  }

  getConfirmClearAuditLogs(): boolean {
    return this.data.confirmClearAuditLogs !== false;
  }

  setAuditExportFolderPreset(preset: string): void {
    this.data.auditExportFolderPreset = preset;
    this.save();
    this.dispatchPreferencesChanged({ auditExportFolderPreset: preset });
  }

  getAuditExportFolderPreset(): string {
    return this.data.auditExportFolderPreset ?? "documents";
  }

  setAuditExportCustomPath(path: string): void {
    this.data.auditExportCustomPath = path.trim();
    this.save();
    this.dispatchPreferencesChanged({ auditExportCustomPath: this.data.auditExportCustomPath });
  }

  getAuditExportCustomPath(): string {
    return this.data.auditExportCustomPath ?? "";
  }

  setAuditExportSkipDestinationConfirm(enabled: boolean): void {
    this.data.auditExportSkipDestinationConfirm = enabled;
    this.save();
    this.dispatchPreferencesChanged({ auditExportSkipDestinationConfirm: enabled });
  }

  getAuditExportSkipDestinationConfirm(): boolean {
    return this.data.auditExportSkipDestinationConfirm !== false;
  }

  setDomainAuditCategories(categories: {
    email: boolean;
    security: boolean;
    hygiene: boolean;
  }): void {
    this.data.domainAuditCategories = {
      email: categories.email,
      security: categories.security,
      hygiene: categories.hygiene,
    };
    this.save();
    this.dispatchPreferencesChanged({ domainAuditCategories: this.data.domainAuditCategories });
  }

  getDomainAuditCategories(): { email: boolean; security: boolean; hygiene: boolean } {
    const raw = this.data.domainAuditCategories ?? {};
    return {
      email: raw.email !== false,
      security: raw.security !== false,
      hygiene: raw.hygiene !== false,
    };
  }

  setSessionSettingsProfile(sessionId: string, profile: SessionSettingsProfile): void {
    const id = String(sessionId || "").trim();
    if (!id) return;
    if (!this.data.sessionSettingsProfiles) this.data.sessionSettingsProfiles = {};
    this.data.sessionSettingsProfiles[id] = { ...profile };
    this.save();
    this.dispatchPreferencesChanged({ sessionSettingsProfiles: this.data.sessionSettingsProfiles });
  }

  getSessionSettingsProfile(sessionId: string): SessionSettingsProfile | undefined {
    const id = String(sessionId || "").trim();
    if (!id) return undefined;
    const profile = this.data.sessionSettingsProfiles?.[id];
    return profile ? { ...profile } : undefined;
  }

  getSessionSettingsProfiles(): Record<string, SessionSettingsProfile> {
    return { ...(this.data.sessionSettingsProfiles ?? {}) };
  }

  setZonePerPage(zoneId: string, value: number | null): void {
    if (!this.data.zonePerPage) {
      this.data.zonePerPage = {};
    }
    if (value === null) {
      delete this.data.zonePerPage[zoneId];
    } else {
      this.data.zonePerPage[zoneId] = value;
    }
    this.save();
  }

  setZonePerPageMap(map: Record<string, number>): void {
    this.data.zonePerPage = { ...map };
    this.save();
  }

  getZonePerPageMap(): Record<string, number> {
    return { ...(this.data.zonePerPage ?? {}) };
  }

  setReopenLastTabs(enabled: boolean): void {
    this.data.reopenLastTabs = enabled;
    this.save();
  }

  getReopenLastTabs(): boolean {
    return !!this.data.reopenLastTabs;
  }

  setReopenZoneTabs(map: Record<string, boolean>): void {
    this.data.reopenZoneTabs = { ...map };
    this.save();
  }

  getReopenZoneTabs(): Record<string, boolean> {
    return { ...(this.data.reopenZoneTabs ?? {}) };
  }

  setLastOpenTabs(tabs: string[]): void {
    this.data.lastOpenTabs = [...tabs];
    this.save();
  }

  getLastOpenTabs(): string[] {
    return [...(this.data.lastOpenTabs ?? [])];
  }

  setLastActiveTabId(id: string | null): void {
    if (!id) {
      delete this.data.lastActiveTabId;
      this.save();
      return;
    }
    this.data.lastActiveTabId = id;
    this.save();
  }

  getLastActiveTabId(): string {
    return this.data.lastActiveTabId ?? "";
  }

  setDnsTableColumns(columns: string[]): void {
    this.data.dnsTableColumns = [...columns];
    this.save();
    this.dispatchPreferencesChanged({ dnsTableColumns: columns });
  }

  getDnsTableColumns(): string[] {
    return [...(this.data.dnsTableColumns ?? [])];
  }

  setZoneDnsTableColumnsMap(map: Record<string, string[]>): void {
    this.data.zoneDnsTableColumns = { ...map };
    this.save();
    this.dispatchPreferencesChanged({ zoneDnsTableColumns: map });
  }

  getZoneDnsTableColumnsMap(): Record<string, string[]> {
    return { ...(this.data.zoneDnsTableColumns ?? {}) };
  }

  clearSettings(): void {
    delete this.data.lastZone;
    delete this.data.autoRefreshInterval;
    delete this.data.defaultPerPage;
    delete this.data.zonePerPage;
    delete this.data.showUnsupportedRecordTypes;
    delete this.data.zoneShowUnsupportedRecordTypes;
    delete this.data.confirmDeleteRecord;
    delete this.data.zoneConfirmDeleteRecord;
    delete this.data.reopenLastTabs;
    delete this.data.reopenZoneTabs;
    delete this.data.lastOpenTabs;
    delete this.data.lastActiveTabId;
    delete this.data.dnsTableColumns;
    delete this.data.zoneDnsTableColumns;
    delete this.data.confirmLogout;
    delete this.data.idleLogoutMs;
    delete this.data.confirmWindowClose;
    delete this.data.loadingOverlayTimeoutMs;
    delete this.data.topologyResolutionMaxHops;
    delete this.data.topologyResolverMode;
    delete this.data.topologyDnsServer;
    delete this.data.topologyCustomDnsServer;
    delete this.data.topologyDohProvider;
    delete this.data.topologyDohCustomUrl;
    delete this.data.topologyExportFolderPreset;
    delete this.data.topologyExportCustomPath;
    delete this.data.topologyExportConfirmPath;
    delete this.data.topologyDisableAnnotations;
    delete this.data.topologyDisableFullWindow;
    delete this.data.topologyLookupTimeoutMs;
    delete this.data.topologyDisablePtrLookups;
    delete this.data.topologyDisableServiceDiscovery;
    delete this.data.topologyTcpServices;
    delete this.data.auditExportDefaultDocuments;
    delete this.data.confirmClearAuditLogs;
    delete this.data.auditExportFolderPreset;
    delete this.data.auditExportCustomPath;
    delete this.data.auditExportSkipDestinationConfirm;
    delete this.data.domainAuditCategories;
    delete this.data.sessionSettingsProfiles;
    this.save();
    this.dispatchPreferencesChanged({ settingsCleared: true });
  }

  clearAllData(): void {
    this.data = { apiKeys: [] };
    try {
      this.storage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    this.dispatchPreferencesChanged({ allDataCleared: true });
    this.dispatchRecordTagsChanged("*");
  }

  /**
   * Export the storage contents as a JSON string including the current
   * encryption configuration.
   */
  exportData(): string {
    /**
     * @returns JSON string representation of the storage payload including encryption metadata
     */
    return JSON.stringify(
      { ...this.data, encryption: this.crypto.getConfig() },
      null,
      2,
    );
  }

  /**
   * Import previously exported JSON data into storage after validating
   * the expected shape. This will replace the in-memory storage contents
   * and persist them.
   *
   * @param jsonData - exported JSON string produced by `exportData()`
   */
  importData(jsonData: string): void {
    let imported: unknown;
    try {
      imported = JSON.parse(jsonData);
    } catch {
      throw new Error("Failed to import data: Invalid JSON");
    }

    if (!isStorageData(imported)) {
      throw new Error("Invalid data format");
    }

    this.data = imported as StorageData;
    this.save();
  }

  getAuditOverrides(zoneId: string): string[] {
    if (!this.data.auditOverrides) return [];
    return this.data.auditOverrides[zoneId] ?? [];
  }

  setAuditOverride(zoneId: string, auditItemId: string): void {
    if (!this.data.auditOverrides) {
      this.data.auditOverrides = {};
    }
    if (!this.data.auditOverrides[zoneId]) {
      this.data.auditOverrides[zoneId] = [];
    }
    if (!this.data.auditOverrides[zoneId].includes(auditItemId)) {
      this.data.auditOverrides[zoneId].push(auditItemId);
      this.save();
    }
  }

  clearAuditOverride(zoneId: string, auditItemId: string): void {
    if (!this.data.auditOverrides?.[zoneId]) return;
    this.data.auditOverrides[zoneId] = this.data.auditOverrides[zoneId].filter(
      (id) => id !== auditItemId,
    );
    this.save();
  }

  clearAllAuditOverrides(zoneId: string): void {
    if (!this.data.auditOverrides) return;
    delete this.data.auditOverrides[zoneId];
    this.save();
  }
}
/**
 * Shared singleton storage manager instance used by the UI to persist API
 * keys and session metadata. Tests may create their own manager instance.
 */
export const storageManager = new StorageManager();
