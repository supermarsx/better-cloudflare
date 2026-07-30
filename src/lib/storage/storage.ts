/**
 * Client-side storage manager used for storing encrypted API keys and
 * session metadata. This provides convenience methods to add, remove,
 * update, and export/import encrypted data.
 */
import {
  ENCRYPTION_ALGORITHMS,
  type ApiKey,
  type EncryptionAlgorithm,
} from "../../types/dns";
import { CryptoManager } from "../auth/crypto";
import {
  DEFAULT_MCP_ENABLED_TOOL_IDS,
  MCP_PERMISSION_POLICY_VERSION,
  capMcpPermissionDiagnosticIds,
  partitionMcpPermissionPolicySelection,
  planMcpPermissionChange,
  reconcileMcpEnabledToolIds,
  reconcileMcpEnabledToolIdsDetailed,
} from "../mcp/tool-permissions";
import { getStorage, type StorageLike } from "./storage-util";
import { generateUUID } from "../utils";
import { reportRuntimeError } from "../errors/runtime-reporting";

const STORAGE_KEY = "cloudflare-dns-manager";
const STORAGE_RECOVERY_KEY = `${STORAGE_KEY}:recovery`;
const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 20_000;
const MAX_OBJECT_PROPERTIES = 5_000;
const MAX_ARRAY_ITEMS = 5_000;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_PROPERTY_NAME_BYTES = 512;
const MAX_API_KEYS = 256;
const MAX_API_KEY_LABEL_BYTES = 256;
const MAX_API_KEY_EMAIL_BYTES = 320;
const MAX_API_KEY_ID_BYTES = 512;
const MAX_CRYPTO_METADATA_BYTES = 64 * 1024;
const MAX_TAG_ZONES = 256;
const MAX_TAG_RECORDS = 5_000;
const MAX_TAG_BYTES = 128;

export class StoragePersistenceError extends Error {
  readonly name = "StoragePersistenceError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class StorageRecoveryRequiredError extends Error {
  readonly name = "StorageRecoveryRequiredError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

interface StorageData {
  apiKeys: ApiKey[];
  __storageRevision?: number;
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
  closeTabOnMiddleClick?: boolean;
  mcpServerEnabled?: boolean;
  mcpServerHost?: string;
  mcpServerPort?: number;
  mcpEnabledTools?: string[];
  mcpPendingHighRiskTools?: string[];
  mcpRemovedImportedToolIds?: string[];
  mcpPermissionPolicyVersion?: number;
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
  topologyCopyActions?: string[];
  topologyExportActions?: string[];
  topologyDisableAnnotations?: boolean;
  topologyDisableFullWindow?: boolean;
  topologyLookupTimeoutMs?: number;
  topologyDisablePtrLookups?: boolean;
  topologyDisableGeoLookups?: boolean;
  topologyGeoProvider?: "auto" | "ipwhois" | "ipapi_co" | "ip_api" | "internal";
  topologyScanResolutionChain?: boolean;
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

export interface StorageRecoverySnapshot {
  capturedAt: string;
  reason: string;
  raw: string;
}

function utf8Bytes(value: string, stopAfterBytes = MAX_STORAGE_BYTES): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > stopAfterBytes) return bytes;
  }
  return bytes;
}

function boundedStorageFailureMessage(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message
      : "unknown storage failure";
  return message
    .replace(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, 512);
}

function assertStringWithin(
  value: unknown,
  maximumBytes: number,
  label: string,
): value is string {
  void label;
  return (
    typeof value === "string" &&
    utf8Bytes(value, maximumBytes) <= maximumBytes &&
    value.length <= maximumBytes
  );
}

function assertBoundedJsonValue(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      throw new RangeError("Storage data contains too many values.");
    }
    if (current.depth > MAX_JSON_DEPTH) {
      throw new RangeError("Storage data is nested too deeply.");
    }
    if (typeof current.value === "string") {
      if (!assertStringWithin(current.value, MAX_STRING_BYTES, "string")) {
        throw new RangeError("Storage data contains an oversized string.");
      }
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        throw new TypeError("Storage data contains a non-finite number.");
      }
      continue;
    }
    if (
      current.value === null ||
      typeof current.value === "boolean" ||
      current.value === undefined
    ) {
      continue;
    }
    if (typeof current.value !== "object") {
      throw new TypeError("Storage data contains an unsupported value.");
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_ARRAY_ITEMS) {
        throw new RangeError("Storage data contains an oversized array.");
      }
      for (const child of current.value) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    const entries = Object.entries(current.value);
    if (entries.length > MAX_OBJECT_PROPERTIES) {
      throw new RangeError("Storage data contains an oversized object.");
    }
    for (const [key, child] of entries) {
      if (!assertStringWithin(key, MAX_PROPERTY_NAME_BYTES, "property name")) {
        throw new RangeError(
          "Storage data contains an oversized property name.",
        );
      }
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function parseBoundedJson(raw: string): unknown {
  if (utf8Bytes(raw) > MAX_STORAGE_BYTES) {
    throw new RangeError(
      `Storage data exceeds the ${MAX_STORAGE_BYTES}-byte safety limit.`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  assertBoundedJsonValue(parsed);
  return parsed;
}

function cloneStorageData(data: StorageData): StorageData {
  return structuredClone(data);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
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
  closeTabOnMiddleClick?: boolean;
  mcpServerEnabled?: boolean;
  mcpServerHost?: string;
  mcpServerPort?: number;
  mcpEnabledTools?: string[];
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
  topologyCopyActions?: string[];
  topologyExportActions?: string[];
  topologyDisableAnnotations?: boolean;
  topologyDisableFullWindow?: boolean;
  topologyLookupTimeoutMs?: number;
  topologyDisablePtrLookups?: boolean;
  topologyDisableGeoLookups?: boolean;
  topologyGeoProvider?: "auto" | "ipwhois" | "ipapi_co" | "ip_api" | "internal";
  topologyScanResolutionChain?: boolean;
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
  const result = Object.create(null) as Record<
    string,
    Record<string, string[]>
  >;
  let recordCount = 0;

  for (const [zoneId, zoneValue] of Object.entries(byZone).slice(
    0,
    MAX_TAG_ZONES,
  )) {
    if (!assertStringWithin(zoneId, MAX_API_KEY_ID_BYTES, "zone id")) continue;
    if (!zoneValue || typeof zoneValue !== "object") continue;
    const byRecord = zoneValue as Record<string, unknown>;
    const zoneResult = Object.create(null) as Record<string, string[]>;

    for (const [recordId, tagsValue] of Object.entries(byRecord)) {
      if (recordCount >= MAX_TAG_RECORDS) break;
      if (!assertStringWithin(recordId, MAX_API_KEY_ID_BYTES, "record id")) {
        continue;
      }
      if (!Array.isArray(tagsValue)) continue;
      const tags = tagsValue
        .filter((tag): tag is string =>
          assertStringWithin(tag, MAX_TAG_BYTES, "record tag"),
        )
        .map((t) => t.trim())
        .filter(Boolean);
      zoneResult[recordId] = Array.from(new Set(tags)).slice(0, 32);
      recordCount += 1;
    }

    result[zoneId] = zoneResult;
    if (recordCount >= MAX_TAG_RECORDS) break;
  }

  return result;
}

function parseTagCatalog(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const byZone = value as Record<string, unknown>;
  const result = Object.create(null) as Record<string, string[]>;
  for (const [zoneId, tagsValue] of Object.entries(byZone).slice(
    0,
    MAX_TAG_ZONES,
  )) {
    if (!assertStringWithin(zoneId, MAX_API_KEY_ID_BYTES, "zone id")) continue;
    if (!Array.isArray(tagsValue)) continue;
    const tags = tagsValue
      .filter((tag): tag is string =>
        assertStringWithin(tag, MAX_TAG_BYTES, "catalog tag"),
      )
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
  try {
    assertBoundedJsonValue(value);
  } catch {
    return false;
  }
  const obj = value as {
    apiKeys?: unknown;
    __storageRevision?: unknown;
    currentSession?: unknown;
    lastZone?: unknown;
    confirmLogout?: unknown;
    idleLogoutMs?: unknown;
    confirmWindowClose?: unknown;
    closeTabOnMiddleClick?: unknown;
  };
  if (!Array.isArray(obj.apiKeys) || obj.apiKeys.length > MAX_API_KEYS) {
    return false;
  }
  if (
    obj.__storageRevision !== undefined &&
    (!Number.isSafeInteger(obj.__storageRevision) ||
      (obj.__storageRevision as number) < 0)
  ) {
    return false;
  }
  if (
    obj.currentSession !== undefined &&
    !assertStringWithin(
      obj.currentSession,
      MAX_API_KEY_ID_BYTES,
      "current session",
    )
  ) {
    return false;
  }
  if (
    obj.lastZone !== undefined &&
    !assertStringWithin(obj.lastZone, MAX_API_KEY_ID_BYTES, "last zone")
  ) {
    return false;
  }
  if (
    obj.confirmLogout !== undefined &&
    typeof obj.confirmLogout !== "boolean"
  ) {
    return false;
  }
  if (
    obj.idleLogoutMs !== undefined &&
    obj.idleLogoutMs !== null &&
    (typeof obj.idleLogoutMs !== "number" || !Number.isFinite(obj.idleLogoutMs))
  ) {
    return false;
  }
  if (
    obj.confirmWindowClose !== undefined &&
    typeof obj.confirmWindowClose !== "boolean"
  ) {
    return false;
  }
  if (
    obj.closeTabOnMiddleClick !== undefined &&
    typeof obj.closeTabOnMiddleClick !== "boolean"
  ) {
    return false;
  }
  return obj.apiKeys.every((k) => {
    if (!k || typeof k !== "object") return false;
    const key = k as Record<string, unknown>;
    return (
      assertStringWithin(key.id, MAX_API_KEY_ID_BYTES, "API key id") &&
      assertStringWithin(key.label, MAX_API_KEY_LABEL_BYTES, "API key label") &&
      assertStringWithin(
        key.encryptedKey,
        MAX_CRYPTO_METADATA_BYTES,
        "encrypted API key",
      ) &&
      assertStringWithin(key.salt, 1024, "API key salt") &&
      assertStringWithin(key.iv, 1024, "API key IV") &&
      Number.isSafeInteger(key.iterations) &&
      (key.iterations as number) > 0 &&
      (key.iterations as number) <= 10_000_000 &&
      Number.isSafeInteger(key.keyLength) &&
      (key.keyLength as number) > 0 &&
      (key.keyLength as number) <= 4_096 &&
      assertStringWithin(key.algorithm, 32, "encryption algorithm") &&
      ENCRYPTION_ALGORITHMS.includes(key.algorithm as EncryptionAlgorithm) &&
      assertStringWithin(key.createdAt, 64, "creation timestamp") &&
      (key.email === undefined ||
        assertStringWithin(key.email, MAX_API_KEY_EMAIL_BYTES, "API key email"))
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
  private lastPersistedData: StorageData = { apiKeys: [] };
  private storage: StorageLike;
  private crypto: CryptoManager;
  private readonly ownsCrypto: boolean;
  private readonly readiness: Promise<void>;
  private recoveryRaw: string | undefined;

  constructor(storage?: StorageLike, crypto?: CryptoManager) {
    this.storage = getStorage(storage);
    this.ownsCrypto = crypto === undefined;
    this.crypto = crypto ?? new CryptoManager({}, this.storage);
    if (this.storage.isReady?.() === false) {
      this.readiness = (this.storage.ready?.() ?? Promise.resolve()).then(
        () => {
          if (this.ownsCrypto)
            this.crypto = new CryptoManager({}, this.storage);
          this.load();
        },
      );
    } else {
      this.load();
      this.readiness = Promise.resolve();
    }
  }

  async ready(): Promise<void> {
    await this.readiness;
  }

  isReady(): boolean {
    return this.storage.isReady?.() ?? true;
  }

  private reportFailure(error: unknown, label: string): void {
    reportRuntimeError(error, { source: "runtime", label });
  }

  private preserveCorruptedData(raw: string, error: unknown): void {
    this.recoveryRaw = raw;
    if (utf8Bytes(raw) > MAX_STORAGE_BYTES) {
      this.reportFailure(error, "Preserve oversized browser storage data");
      return;
    }
    try {
      if (this.storage.getItem(STORAGE_RECOVERY_KEY) !== null) return;
      const envelope: StorageRecoverySnapshot = {
        capturedAt: new Date().toISOString(),
        reason: error instanceof Error ? error.message : String(error),
        raw,
      };
      this.storage.setItem(STORAGE_RECOVERY_KEY, JSON.stringify(envelope));
    } catch (preserveError) {
      this.reportFailure(
        preserveError,
        "Quarantine corrupted browser storage data",
      );
    }
  }

  private parseStorageData(raw: string): StorageData {
    const parsed = parseBoundedJson(raw);
    if (!isStorageData(parsed)) {
      throw new TypeError(
        "Stored browser data does not match the safe schema.",
      );
    }
    const obj = parsed as StorageData & {
      recordTags?: unknown;
      tagCatalog?: unknown;
    };
    return {
      ...obj,
      recordTags: parseRecordTags(obj.recordTags),
      tagCatalog: parseTagCatalog(obj.tagCatalog),
    };
  }

  /**
   * Load persisted storage data from the configured StorageLike instance.
   */
  private load(): void {
    try {
      const stored = this.storage.getItem(STORAGE_KEY);
      if (stored) {
        this.data = this.parseStorageData(stored);
      }
      this.lastPersistedData = cloneStorageData(this.data);
      this.recoveryRaw = undefined;
    } catch (error) {
      let stored: string | null = null;
      try {
        stored = this.storage.getItem(STORAGE_KEY);
      } catch {
        // The primary read error is already reported below.
      }
      if (stored !== null) this.preserveCorruptedData(stored, error);
      this.data = { apiKeys: [] };
      this.lastPersistedData = { apiKeys: [] };
      this.reportFailure(error, "Load browser storage data");
    }
  }

  private mergeApiKeys(
    baseline: ApiKey[],
    current: ApiKey[],
    latest: ApiKey[],
  ): ApiKey[] {
    const baselineById = new Map(baseline.map((key) => [key.id, key]));
    const currentById = new Map(current.map((key) => [key.id, key]));
    const merged = new Map(latest.map((key) => [key.id, key]));

    for (const id of baselineById.keys()) {
      if (!currentById.has(id)) merged.delete(id);
    }
    for (const key of current) {
      const baselineKey = baselineById.get(key.id);
      if (!baselineKey || !jsonEqual(key, baselineKey)) {
        merged.set(key.id, structuredClone(key));
      }
    }

    const ordered: ApiKey[] = [];
    for (const key of latest) {
      const next = merged.get(key.id);
      if (next) {
        ordered.push(next);
        merged.delete(key.id);
      }
    }
    for (const key of current) {
      const next = merged.get(key.id);
      if (next) {
        ordered.push(next);
        merged.delete(key.id);
      }
    }
    return ordered.slice(0, MAX_API_KEYS);
  }

  private mergeWithLatest(latest: StorageData): StorageData {
    const baseline = this.lastPersistedData as unknown as Record<
      string,
      unknown
    >;
    const current = this.data as unknown as Record<string, unknown>;
    const merged = cloneStorageData(latest) as unknown as Record<
      string,
      unknown
    >;
    const fields = new Set([...Object.keys(baseline), ...Object.keys(current)]);
    fields.delete("__storageRevision");

    for (const field of fields) {
      const baselineHas = Object.prototype.hasOwnProperty.call(baseline, field);
      const currentHas = Object.prototype.hasOwnProperty.call(current, field);
      const baselineValue = baseline[field];
      const currentValue = current[field];
      if (
        baselineHas === currentHas &&
        jsonEqual(baselineValue, currentValue)
      ) {
        continue;
      }
      if (!currentHas) {
        delete merged[field];
      } else if (field === "apiKeys") {
        merged.apiKeys = this.mergeApiKeys(
          this.lastPersistedData.apiKeys,
          this.data.apiKeys,
          latest.apiKeys,
        );
      } else {
        merged[field] = structuredClone(currentValue);
      }
    }
    return merged as unknown as StorageData;
  }

  /**
   * Persist the in-memory data to storage as JSON.
   */
  private save(
    _throwOnError = true,
    options: { replace?: boolean } = {},
  ): void {
    void _throwOnError;
    const rollbackData = cloneStorageData(this.lastPersistedData);
    let previousRaw: string | null | undefined;
    let attemptedRaw: string | undefined;
    try {
      if (!this.isReady()) {
        throw new StoragePersistenceError(
          "Browser storage is not ready; the change was not applied.",
        );
      }
      assertBoundedJsonValue(this.data);
      if (this.recoveryRaw !== undefined && !options.replace) {
        throw new StorageRecoveryRequiredError(
          "Stored data needs recovery before new changes can be saved.",
        );
      }

      previousRaw = this.storage.getItem(STORAGE_KEY);
      let latest: StorageData = { apiKeys: [] };
      if (previousRaw !== null) {
        try {
          latest = this.parseStorageData(previousRaw);
        } catch (error) {
          this.preserveCorruptedData(previousRaw, error);
          if (!options.replace) {
            throw new StorageRecoveryRequiredError(
              "Stored data needs recovery before new changes can be saved.",
              { cause: error },
            );
          }
        }
      }

      const next = options.replace
        ? cloneStorageData(this.data)
        : this.mergeWithLatest(latest);
      next.__storageRevision =
        Math.max(
          latest.__storageRevision ?? 0,
          this.lastPersistedData.__storageRevision ?? 0,
        ) + 1;
      assertBoundedJsonValue(next);
      attemptedRaw = JSON.stringify(next);
      if (utf8Bytes(attemptedRaw) > MAX_STORAGE_BYTES) {
        throw new RangeError(
          `Storage data exceeds the ${MAX_STORAGE_BYTES}-byte safety limit.`,
        );
      }

      this.storage.setItem(STORAGE_KEY, attemptedRaw);
      if (this.storage.getItem(STORAGE_KEY) !== attemptedRaw) {
        throw new StoragePersistenceError(
          "Browser storage changed concurrently; the write was rejected.",
        );
      }
      this.data = next;
      this.lastPersistedData = cloneStorageData(next);
      if (options.replace) this.recoveryRaw = undefined;
    } catch (error) {
      if (previousRaw !== undefined && attemptedRaw !== undefined) {
        try {
          if (this.storage.getItem(STORAGE_KEY) === attemptedRaw) {
            if (previousRaw === null) this.storage.removeItem(STORAGE_KEY);
            else this.storage.setItem(STORAGE_KEY, previousRaw);
          }
        } catch (rollbackError) {
          this.reportFailure(
            rollbackError,
            "Roll back failed browser storage write",
          );
        }
      }
      this.data = rollbackData;
      const surfaced =
        error instanceof StoragePersistenceError ||
        error instanceof StorageRecoveryRequiredError
          ? error
          : new StoragePersistenceError(
              `The browser could not persist this change: ${boundedStorageFailureMessage(
                error,
              )}. The in-memory mutation was rolled back.`,
              { cause: error },
            );
      this.reportFailure(surfaced, "Persist browser storage data");
      throw surfaced;
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
    window.dispatchEvent(
      new CustomEvent("preferences-changed", { detail: fields }),
    );
  }

  private ensureTagInCatalog(zoneId: string, tag: string): void {
    const catalog = (this.data.tagCatalog ??= {});
    const zoneTags = (catalog[zoneId] ??= []);
    if (zoneTags.includes(tag)) return;
    zoneTags.push(tag);
    zoneTags.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
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

  getZoneRecordTagMap(zoneId: string): Record<string, string[]> {
    const zone = this.data.recordTags?.[zoneId];
    if (!zone || typeof zone !== "object") return {};
    return Object.fromEntries(
      Object.entries(zone).map(([recordId, tags]) => [
        recordId,
        [...(tags ?? [])],
      ]),
    );
  }

  setRecordTags(zoneId: string, recordId: string, tags: string[]): void {
    const nextTags = Array.from(
      new Set(tags.map((t) => t.trim()).filter(Boolean)),
    ).slice(0, 32);
    for (const tag of nextTags) this.ensureTagInCatalog(zoneId, tag);
    if (nextTags.length === 0) {
      const zoneMap = this.data.recordTags?.[zoneId];
      if (zoneMap && Object.prototype.hasOwnProperty.call(zoneMap, recordId)) {
        delete zoneMap[recordId];
        if (Object.keys(zoneMap).length === 0) {
          delete this.data.recordTags?.[zoneId];
        }
      }
      this.save();
      this.dispatchRecordTagsChanged(zoneId, recordId);
      return;
    }
    const allRecordTags = (this.data.recordTags ??= {});
    const zoneMap = (allRecordTags[zoneId] ??= {});
    zoneMap[recordId] = nextTags;
    this.save();
    this.dispatchRecordTagsChanged(zoneId, recordId);
  }

  clearRecordTags(zoneId: string, recordId: string): void {
    this.setRecordTags(zoneId, recordId, []);
  }

  moveRecordTags(
    zoneId: string,
    fromRecordId: string,
    toRecordId: string,
  ): void {
    const fromId = fromRecordId.trim();
    const toId = toRecordId.trim();
    if (!fromId || !toId || fromId === toId) return;
    const prev = this.getRecordTags(zoneId, fromId);
    if (!prev.length) return;
    const target = this.getRecordTags(zoneId, toId);
    this.setRecordTags(zoneId, toId, [...target, ...prev]);
    this.clearRecordTags(zoneId, fromId);
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
    if (zone) {
      for (const [recordId, tags] of Object.entries(zone)) {
        if (!Array.isArray(tags) || !tags.includes(prev)) continue;
        zone[recordId] = Array.from(
          new Set(tags.map((t) => (t === prev ? next : t))),
        ).slice(0, 32);
      }
    }
    const catalog = this.data.tagCatalog?.[zoneId];
    if (Array.isArray(catalog)) {
      this.data.tagCatalog = {
        ...(this.data.tagCatalog ?? {}),
        [zoneId]: Array.from(
          new Set(catalog.map((t) => (t === prev ? next : t)).filter(Boolean)),
        )
          .sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "base" }),
          )
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
    if (zone) {
      for (const [recordId, tags] of Object.entries(zone)) {
        if (!Array.isArray(tags) || !tags.includes(target)) continue;
        const next = tags.filter((t) => t !== target);
        if (next.length === 0) {
          delete zone[recordId];
        } else {
          zone[recordId] = next;
        }
      }
      if (Object.keys(zone).length === 0) {
        delete this.data.recordTags?.[zoneId];
      }
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

  setZoneShowUnsupportedRecordTypes(
    zoneId: string,
    enabled: boolean | null,
  ): void {
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
    return typeof this.data.idleLogoutMs === "number"
      ? this.data.idleLogoutMs
      : null;
  }

  setConfirmWindowClose(enabled: boolean): void {
    this.data.confirmWindowClose = enabled;
    this.save();
    this.dispatchPreferencesChanged({ confirmWindowClose: enabled });
  }

  getConfirmWindowClose(): boolean {
    return this.data.confirmWindowClose !== false;
  }

  setCloseTabOnMiddleClick(enabled: boolean): void {
    this.data.closeTabOnMiddleClick = enabled;
    this.save();
    this.dispatchPreferencesChanged({ closeTabOnMiddleClick: enabled });
  }

  getCloseTabOnMiddleClick(): boolean {
    return this.data.closeTabOnMiddleClick !== false;
  }

  setMcpServerEnabled(enabled: boolean): void {
    this.data.mcpServerEnabled = enabled;
    this.save();
    this.dispatchPreferencesChanged({ mcpServerEnabled: enabled });
  }

  getMcpServerEnabled(): boolean {
    return this.data.mcpServerEnabled === true;
  }

  setMcpServerHost(host: string): void {
    this.data.mcpServerHost = String(host ?? "").trim() || "127.0.0.1";
    this.save();
    this.dispatchPreferencesChanged({ mcpServerHost: this.data.mcpServerHost });
  }

  getMcpServerHost(): string {
    return String(this.data.mcpServerHost ?? "127.0.0.1").trim() || "127.0.0.1";
  }

  setMcpServerPort(port: number): void {
    const parsed = Math.round(port);
    const next = Number.isFinite(parsed)
      ? Math.max(1, Math.min(65535, parsed))
      : 8787;
    this.data.mcpServerPort = next;
    this.save();
    this.dispatchPreferencesChanged({ mcpServerPort: next });
  }

  getMcpServerPort(): number {
    const value = this.data.mcpServerPort;
    if (typeof value !== "number" || Number.isNaN(value)) return 8787;
    return Math.max(1, Math.min(65535, Math.round(value)));
  }

  setMcpEnabledTools(tools: string[]): void {
    const previous = {
      enabledTools: this.data.mcpEnabledTools,
      pendingHighRiskTools: this.data.mcpPendingHighRiskTools,
      removedImportedToolIds: this.data.mcpRemovedImportedToolIds,
      permissionPolicyVersion: this.data.mcpPermissionPolicyVersion,
    };
    this.data.mcpEnabledTools = reconcileMcpEnabledToolIds(tools);
    delete this.data.mcpPendingHighRiskTools;
    delete this.data.mcpRemovedImportedToolIds;
    this.data.mcpPermissionPolicyVersion = MCP_PERMISSION_POLICY_VERSION;
    try {
      this.save(true);
    } catch (error) {
      this.data.mcpEnabledTools = previous.enabledTools;
      this.data.mcpPendingHighRiskTools = previous.pendingHighRiskTools;
      this.data.mcpRemovedImportedToolIds = previous.removedImportedToolIds;
      this.data.mcpPermissionPolicyVersion = previous.permissionPolicyVersion;
      throw error;
    }
    this.dispatchPreferencesChanged({
      mcpEnabledTools: this.data.mcpEnabledTools,
    });
  }

  stageMcpEnabledTools(
    tools: string[],
    pendingHighRiskToolIds: string[],
    removedToolIds: string[],
  ): void {
    const previous = {
      enabledTools: this.data.mcpEnabledTools,
      pendingHighRiskTools: this.data.mcpPendingHighRiskTools,
      removedImportedToolIds: this.data.mcpRemovedImportedToolIds,
      permissionPolicyVersion: this.data.mcpPermissionPolicyVersion,
    };
    const enabledReconciliation = reconcileMcpEnabledToolIdsDetailed(tools);
    const pendingReconciliation = reconcileMcpEnabledToolIdsDetailed(
      pendingHighRiskToolIds,
    );
    const enabledTools = enabledReconciliation.enabledToolIds;
    const pendingTools = planMcpPermissionChange(enabledTools, [
      ...enabledTools,
      ...pendingReconciliation.enabledToolIds,
    ]).newlyEnabledHighRiskToolIds;
    const removedTools = capMcpPermissionDiagnosticIds([
      ...enabledReconciliation.removedToolIds,
      ...pendingReconciliation.removedToolIds,
      ...reconcileMcpEnabledToolIdsDetailed(removedToolIds).removedToolIds,
    ]);

    this.data.mcpEnabledTools = enabledTools;
    if (pendingTools.length > 0) {
      this.data.mcpPendingHighRiskTools = pendingTools;
    } else {
      delete this.data.mcpPendingHighRiskTools;
    }
    if (removedTools.length > 0) {
      this.data.mcpRemovedImportedToolIds = removedTools;
    } else {
      delete this.data.mcpRemovedImportedToolIds;
    }
    this.data.mcpPermissionPolicyVersion = MCP_PERMISSION_POLICY_VERSION;

    try {
      this.save(true);
    } catch (error) {
      this.data.mcpEnabledTools = previous.enabledTools;
      this.data.mcpPendingHighRiskTools = previous.pendingHighRiskTools;
      this.data.mcpRemovedImportedToolIds = previous.removedImportedToolIds;
      this.data.mcpPermissionPolicyVersion = previous.permissionPolicyVersion;
      throw error;
    }
    this.dispatchPreferencesChanged({
      mcpEnabledTools: enabledTools,
      mcpPendingHighRiskTools: pendingTools,
    });
  }

  getMcpEnabledTools(): string[] {
    return this.getMcpEnabledToolsSnapshot().enabledTools;
  }

  getMcpEnabledToolsSnapshot(): {
    enabledTools: string[];
    removedToolIds: string[];
    pendingHighRiskToolIds: string[];
    configured: boolean;
    permissionPolicyVersion: number;
  } {
    this.migrateMcpPermissionPolicy();
    const storedTools = this.data.mcpEnabledTools;
    const configured = Array.isArray(storedTools);
    const reconciliation = reconcileMcpEnabledToolIdsDetailed(
      configured ? storedTools : DEFAULT_MCP_ENABLED_TOOL_IDS,
    );
    const pendingReconciliation = reconcileMcpEnabledToolIdsDetailed(
      this.data.mcpPendingHighRiskTools,
    );
    return {
      enabledTools: reconciliation.enabledToolIds,
      removedToolIds: capMcpPermissionDiagnosticIds([
        ...reconciliation.removedToolIds,
        ...pendingReconciliation.removedToolIds,
        ...(this.data.mcpRemovedImportedToolIds ?? []),
      ]),
      pendingHighRiskToolIds: pendingReconciliation.enabledToolIds,
      configured,
      permissionPolicyVersion:
        this.data.mcpPermissionPolicyVersion ?? MCP_PERMISSION_POLICY_VERSION,
    };
  }

  private migrateMcpPermissionPolicy(): void {
    if (!Array.isArray(this.data.mcpEnabledTools)) return;
    const storedVersion = this.data.mcpPermissionPolicyVersion;
    if (storedVersion === MCP_PERMISSION_POLICY_VERSION) {
      return;
    }

    const previous = {
      enabledTools: this.data.mcpEnabledTools,
      pendingHighRiskTools: this.data.mcpPendingHighRiskTools,
      removedImportedToolIds: this.data.mcpRemovedImportedToolIds,
      permissionPolicyVersion: this.data.mcpPermissionPolicyVersion,
    };
    const partition = partitionMcpPermissionPolicySelection([
      ...this.data.mcpEnabledTools,
      ...(this.data.mcpPendingHighRiskTools ?? []),
    ]);
    const removedToolIds = capMcpPermissionDiagnosticIds([
      ...partition.removedToolIds,
      ...reconcileMcpEnabledToolIdsDetailed(this.data.mcpRemovedImportedToolIds)
        .removedToolIds,
    ]);

    this.data.mcpEnabledTools = partition.enabledToolIds;
    if (partition.pendingHighRiskToolIds.length > 0) {
      this.data.mcpPendingHighRiskTools = partition.pendingHighRiskToolIds;
    } else {
      delete this.data.mcpPendingHighRiskTools;
    }
    if (removedToolIds.length > 0) {
      this.data.mcpRemovedImportedToolIds = removedToolIds;
    } else {
      delete this.data.mcpRemovedImportedToolIds;
    }
    this.data.mcpPermissionPolicyVersion = MCP_PERMISSION_POLICY_VERSION;

    try {
      this.save(true);
    } catch (error) {
      this.data.mcpEnabledTools = previous.enabledTools;
      this.data.mcpPendingHighRiskTools = previous.pendingHighRiskTools;
      this.data.mcpRemovedImportedToolIds = previous.removedImportedToolIds;
      this.data.mcpPermissionPolicyVersion = previous.permissionPolicyVersion;
      throw error;
    }
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
    this.dispatchPreferencesChanged({
      topologyDnsServer: this.data.topologyDnsServer,
    });
  }

  getTopologyDnsServer(): string {
    return String(this.data.topologyDnsServer ?? "1.1.1.1").trim() || "1.1.1.1";
  }

  setTopologyCustomDnsServer(value: string): void {
    this.data.topologyCustomDnsServer = String(value ?? "").trim();
    this.save();
    this.dispatchPreferencesChanged({
      topologyCustomDnsServer: this.data.topologyCustomDnsServer,
    });
  }

  getTopologyCustomDnsServer(): string {
    return String(this.data.topologyCustomDnsServer ?? "").trim();
  }

  setTopologyDohProvider(
    value: "google" | "cloudflare" | "quad9" | "custom",
  ): void {
    this.data.topologyDohProvider = value;
    this.save();
    this.dispatchPreferencesChanged({ topologyDohProvider: value });
  }

  getTopologyDohProvider(): "google" | "cloudflare" | "quad9" | "custom" {
    const value = this.data.topologyDohProvider;
    if (value === "cloudflare" || value === "quad9" || value === "custom")
      return value;
    return "cloudflare";
  }

  setTopologyDohCustomUrl(value: string): void {
    this.data.topologyDohCustomUrl = String(value ?? "").trim();
    this.save();
    this.dispatchPreferencesChanged({
      topologyDohCustomUrl: this.data.topologyDohCustomUrl,
    });
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
    this.dispatchPreferencesChanged({
      topologyExportCustomPath: this.data.topologyExportCustomPath,
    });
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

  setTopologyCopyActions(actions: string[]): void {
    const next = Array.from(
      new Set((actions ?? []).map((s) => String(s).trim()).filter(Boolean)),
    );
    this.data.topologyCopyActions = next.length
      ? next
      : ["mermaid", "svg", "png"];
    this.save();
    this.dispatchPreferencesChanged({
      topologyCopyActions: this.data.topologyCopyActions,
    });
  }

  getTopologyCopyActions(): string[] {
    const value = this.data.topologyCopyActions;
    if (!Array.isArray(value) || value.length === 0)
      return ["mermaid", "svg", "png"];
    return Array.from(
      new Set(value.map((v) => String(v).trim()).filter(Boolean)),
    );
  }

  setTopologyExportActions(actions: string[]): void {
    const next = Array.from(
      new Set((actions ?? []).map((s) => String(s).trim()).filter(Boolean)),
    );
    this.data.topologyExportActions = next.length
      ? next
      : ["mermaid", "svg", "png", "pdf"];
    this.save();
    this.dispatchPreferencesChanged({
      topologyExportActions: this.data.topologyExportActions,
    });
  }

  getTopologyExportActions(): string[] {
    const value = this.data.topologyExportActions;
    if (!Array.isArray(value) || value.length === 0)
      return ["mermaid", "svg", "png", "pdf"];
    return Array.from(
      new Set(value.map((v) => String(v).trim()).filter(Boolean)),
    );
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

  setTopologyDisableGeoLookups(enabled: boolean): void {
    this.data.topologyDisableGeoLookups = enabled;
    this.save();
    this.dispatchPreferencesChanged({ topologyDisableGeoLookups: enabled });
  }

  getTopologyDisableGeoLookups(): boolean {
    return this.data.topologyDisableGeoLookups === true;
  }

  setTopologyGeoProvider(
    value: "auto" | "ipwhois" | "ipapi_co" | "ip_api" | "internal",
  ): void {
    this.data.topologyGeoProvider = value;
    this.save();
    this.dispatchPreferencesChanged({ topologyGeoProvider: value });
  }

  getTopologyGeoProvider():
    | "auto"
    | "ipwhois"
    | "ipapi_co"
    | "ip_api"
    | "internal" {
    const value = this.data.topologyGeoProvider;
    if (
      value === "ipwhois" ||
      value === "ipapi_co" ||
      value === "ip_api" ||
      value === "internal"
    ) {
      return value;
    }
    return "auto";
  }

  setTopologyScanResolutionChain(enabled: boolean): void {
    this.data.topologyScanResolutionChain = enabled;
    this.save();
    this.dispatchPreferencesChanged({ topologyScanResolutionChain: enabled });
  }

  getTopologyScanResolutionChain(): boolean {
    return this.data.topologyScanResolutionChain !== false;
  }

  setTopologyDisableServiceDiscovery(enabled: boolean): void {
    this.data.topologyDisableServiceDiscovery = enabled;
    this.save();
    this.dispatchPreferencesChanged({
      topologyDisableServiceDiscovery: enabled,
    });
  }

  getTopologyDisableServiceDiscovery(): boolean {
    return this.data.topologyDisableServiceDiscovery === true;
  }

  setTopologyTcpServices(services: string[]): void {
    const next = Array.from(
      new Set((services ?? []).map((s) => String(s).trim()).filter(Boolean)),
    );
    this.data.topologyTcpServices = next;
    this.save();
    this.dispatchPreferencesChanged({ topologyTcpServices: next });
  }

  getTopologyTcpServices(): string[] {
    const value = this.data.topologyTcpServices;
    if (!Array.isArray(value)) return ["80", "443", "22"];
    return Array.from(
      new Set(value.map((v) => String(v).trim()).filter(Boolean)),
    );
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
    this.dispatchPreferencesChanged({
      auditExportCustomPath: this.data.auditExportCustomPath,
    });
  }

  getAuditExportCustomPath(): string {
    return this.data.auditExportCustomPath ?? "";
  }

  setAuditExportSkipDestinationConfirm(enabled: boolean): void {
    this.data.auditExportSkipDestinationConfirm = enabled;
    this.save();
    this.dispatchPreferencesChanged({
      auditExportSkipDestinationConfirm: enabled,
    });
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
    this.dispatchPreferencesChanged({
      domainAuditCategories: this.data.domainAuditCategories,
    });
  }

  getDomainAuditCategories(): {
    email: boolean;
    security: boolean;
    hygiene: boolean;
  } {
    const raw = this.data.domainAuditCategories ?? {};
    return {
      email: raw.email !== false,
      security: raw.security !== false,
      hygiene: raw.hygiene !== false,
    };
  }

  setSessionSettingsProfile(
    sessionId: string,
    profile: SessionSettingsProfile,
  ): void {
    const id = String(sessionId || "").trim();
    if (!id) return;
    if (!this.data.sessionSettingsProfiles)
      this.data.sessionSettingsProfiles = {};
    this.data.sessionSettingsProfiles[id] = {
      ...profile,
      ...(Array.isArray(profile.mcpEnabledTools)
        ? {
            mcpEnabledTools: reconcileMcpEnabledToolIds(
              profile.mcpEnabledTools,
            ),
          }
        : {}),
    };
    this.save();
    this.dispatchPreferencesChanged({
      sessionSettingsProfiles: this.data.sessionSettingsProfiles,
    });
  }

  getSessionSettingsProfile(
    sessionId: string,
  ): SessionSettingsProfile | undefined {
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
    delete this.data.closeTabOnMiddleClick;
    delete this.data.mcpServerEnabled;
    delete this.data.mcpServerHost;
    delete this.data.mcpServerPort;
    delete this.data.mcpEnabledTools;
    delete this.data.mcpPendingHighRiskTools;
    delete this.data.mcpRemovedImportedToolIds;
    delete this.data.mcpPermissionPolicyVersion;
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
    delete this.data.topologyCopyActions;
    delete this.data.topologyExportActions;
    delete this.data.topologyDisableAnnotations;
    delete this.data.topologyDisableFullWindow;
    delete this.data.topologyLookupTimeoutMs;
    delete this.data.topologyDisablePtrLookups;
    delete this.data.topologyDisableGeoLookups;
    delete this.data.topologyGeoProvider;
    delete this.data.topologyScanResolutionChain;
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
    if (!this.isReady()) {
      throw new StoragePersistenceError(
        "Browser storage is not ready; data was not cleared.",
      );
    }
    const previousData = cloneStorageData(this.data);
    const previousPersisted = cloneStorageData(this.lastPersistedData);
    let primaryRaw: string | null = null;
    let recoveryRaw: string | null = null;
    try {
      primaryRaw = this.storage.getItem(STORAGE_KEY);
      recoveryRaw = this.storage.getItem(STORAGE_RECOVERY_KEY);
      this.storage.removeItem(STORAGE_KEY);
      this.storage.removeItem(STORAGE_RECOVERY_KEY);
      this.data = { apiKeys: [] };
      this.lastPersistedData = { apiKeys: [] };
      this.recoveryRaw = undefined;
    } catch (error) {
      try {
        if (primaryRaw !== null) this.storage.setItem(STORAGE_KEY, primaryRaw);
        if (recoveryRaw !== null) {
          this.storage.setItem(STORAGE_RECOVERY_KEY, recoveryRaw);
        }
      } catch (rollbackError) {
        this.reportFailure(
          rollbackError,
          "Roll back failed browser storage clear",
        );
      }
      this.data = previousData;
      this.lastPersistedData = previousPersisted;
      const surfaced = new StoragePersistenceError(
        "Browser storage could not be cleared. Existing data was retained where possible.",
        { cause: error },
      );
      this.reportFailure(surfaced, "Clear browser storage data");
      throw surfaced;
    }
    this.dispatchPreferencesChanged({ allDataCleared: true });
    this.dispatchRecordTagsChanged("*");
  }

  getRecoverySnapshot(): StorageRecoverySnapshot | null {
    try {
      const rawEnvelope = this.storage.getItem(STORAGE_RECOVERY_KEY);
      if (rawEnvelope) {
        const parsed = parseBoundedJson(rawEnvelope);
        if (
          parsed &&
          typeof parsed === "object" &&
          "capturedAt" in parsed &&
          typeof parsed.capturedAt === "string" &&
          "reason" in parsed &&
          typeof parsed.reason === "string" &&
          "raw" in parsed &&
          typeof parsed.raw === "string"
        ) {
          return {
            capturedAt: parsed.capturedAt,
            reason: parsed.reason,
            raw: parsed.raw,
          };
        }
      }
    } catch (error) {
      this.reportFailure(error, "Read browser storage recovery snapshot");
    }
    return this.recoveryRaw === undefined
      ? null
      : {
          capturedAt: new Date().toISOString(),
          reason: "The primary browser storage payload is invalid.",
          raw: this.recoveryRaw,
        };
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
      imported = parseBoundedJson(jsonData);
    } catch {
      throw new Error(
        `Failed to import data: JSON must be valid and no larger than ${MAX_STORAGE_BYTES} bytes.`,
      );
    }

    if (!isStorageData(imported)) {
      throw new Error("Invalid data format");
    }

    const obj = imported as StorageData & {
      recordTags?: unknown;
      tagCatalog?: unknown;
    };
    const importedMcpSelection = Array.isArray(obj.mcpEnabledTools)
      ? reconcileMcpEnabledToolIdsDetailed(obj.mcpEnabledTools)
      : null;
    const importedHighRiskToolIds = importedMcpSelection
      ? planMcpPermissionChange([], importedMcpSelection.enabledToolIds)
          .newlyEnabledHighRiskToolIds
      : [];
    const importedHighRiskToolIdSet = new Set(importedHighRiskToolIds);
    this.data = {
      ...obj,
      __storageRevision: undefined,
      recordTags: parseRecordTags(obj.recordTags),
      tagCatalog: parseTagCatalog(obj.tagCatalog),
      ...(importedMcpSelection
        ? {
            mcpEnabledTools: importedMcpSelection.enabledToolIds.filter(
              (id) => !importedHighRiskToolIdSet.has(id),
            ),
            mcpPendingHighRiskTools: importedHighRiskToolIds,
            mcpRemovedImportedToolIds: importedMcpSelection.removedToolIds,
            mcpPermissionPolicyVersion: MCP_PERMISSION_POLICY_VERSION,
          }
        : {
            mcpEnabledTools: undefined,
            mcpPendingHighRiskTools: undefined,
            mcpRemovedImportedToolIds: undefined,
            mcpPermissionPolicyVersion: undefined,
          }),
    };
    this.save(true, { replace: true });
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
