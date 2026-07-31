import { reportRuntimeError } from "@/lib/errors/runtime-reporting";

const LEGACY_DATABASE_NAME = "better-cloudflare";
const LEGACY_STORE_NAME = "kv";
const MIGRATION_MARKER_KEY = "better-cloudflare-storage-v2-migrated";
const LEGACY_STORAGE_KEYS = [
  "cloudflare-dns-manager",
  "encryption-settings",
] as const;
const LEGACY_MIGRATION_TIMEOUT_MS = 10_000;
const LEGACY_MIGRATION_MAX_ENTRIES = 64;
const LEGACY_MIGRATION_MAX_BYTES = 2 * 1024 * 1024 + 128 * 1024;
const BROWSER_STATE_KEY = "cloudflare-dns-manager";
const BROWSER_RECOVERY_KEY = `${BROWSER_STATE_KEY}:recovery`;
const BROWSER_STATE_MAX_BYTES = 2 * 1024 * 1024;
const BROWSER_STATE_MAX_DEPTH = 12;
const BROWSER_STATE_MAX_NODES = 20_000;
const BROWSER_STATE_MAX_PROPERTIES = 5_000;
const BROWSER_STATE_MAX_ARRAY_ITEMS = 5_000;
const BROWSER_STATE_MAX_STRING_BYTES = 64 * 1024;
const BROWSER_STATE_MAX_PROPERTY_BYTES = 512;

export interface BrowserSessionSettingsProfile {
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

export interface BrowserPreferenceData extends BrowserSessionSettingsProfile {
  __storageRevision?: number;
  lastZone?: string;
  lastActiveTabId?: string;
  dnsTableColumns?: string[];
  zoneDnsTableColumns?: Record<string, string[]>;
  vaultEnabled?: boolean;
  autoRefreshInterval?: number;
  confirmDeleteRecord?: boolean;
  zoneConfirmDeleteRecord?: Record<string, boolean>;
  lastOpenTabs?: string[];
  recordTags?: Record<string, Record<string, string[]>>;
  tagCatalog?: Record<string, string[]>;
  mcpPendingHighRiskTools?: string[];
  mcpRemovedImportedToolIds?: string[];
  mcpPermissionPolicyVersion?: number;
  sessionSettingsProfiles?: Record<string, BrowserSessionSettingsProfile>;
  auditOverrides?: Record<string, string[]>;
}

/**
 * Minimal synchronous storage contract used by the application. Async stores
 * must not be hidden behind this interface: callers rely on a thrown
 * setItem/removeItem error to roll back their in-memory mutation.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  ready?(): Promise<void>;
  isReady?(): boolean;
  readonly backend?: "localstorage" | "memory";
}

export class StorageNotReadyError extends Error {
  readonly name = "StorageNotReadyError";

  constructor() {
    super("Persistent browser storage is still being prepared.");
  }
}

function reportStorageFailure(error: unknown, label: string): void {
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
      ? error.name
      : "";
  const category =
    name === "QuotaExceededError"
      ? "quota exceeded"
      : name === "SecurityError" || name === "NotAllowedError"
        ? "access denied"
        : name === "DataError" || name === "UnknownError"
          ? "data unavailable"
          : "operation failed";
  reportRuntimeError(error, {
    source: "runtime",
    label: `${label}: ${category}`,
  });
}

class MemoryStorage implements StorageLike {
  readonly backend = "memory" as const;
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? this.store[key]
      : null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  isReady(): boolean {
    return true;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }
}

export type LegacyStorageLoader = () => Promise<ReadonlyMap<string, string>>;

export interface LegacyMigrationSafetyOptions {
  timeoutMs?: number;
  allowedKeys?: readonly string[];
  maxEntries?: number;
  maxBytes?: number;
}

function utf8ByteLengthUpTo(value: string, maximum: number): number {
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
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

type PreferenceKind =
  | "string"
  | "number"
  | "nullable-number"
  | "revision"
  | "boolean"
  | "strings"
  | "number-map"
  | "boolean-map"
  | "string-array-map"
  | "nested-string-array-map"
  | "categories"
  | "profiles"
  | readonly string[];

const SESSION_PROFILE_SCHEMA = {
  autoRefreshInterval: "nullable-number",
  defaultPerPage: "number",
  zonePerPage: "number-map",
  showUnsupportedRecordTypes: "boolean",
  zoneShowUnsupportedRecordTypes: "boolean-map",
  reopenLastTabs: "boolean",
  reopenZoneTabs: "boolean-map",
  confirmLogout: "boolean",
  idleLogoutMs: "nullable-number",
  confirmWindowClose: "boolean",
  closeTabOnMiddleClick: "boolean",
  mcpServerEnabled: "boolean",
  mcpServerHost: "string",
  mcpServerPort: "number",
  mcpEnabledTools: "strings",
  loadingOverlayTimeoutMs: "number",
  topologyResolutionMaxHops: "number",
  topologyResolverMode: ["dns", "doh"],
  topologyDnsServer: "string",
  topologyCustomDnsServer: "string",
  topologyDohProvider: ["google", "cloudflare", "quad9", "custom"],
  topologyDohCustomUrl: "string",
  topologyExportFolderPreset: "string",
  topologyExportCustomPath: "string",
  topologyExportConfirmPath: "boolean",
  topologyCopyActions: "strings",
  topologyExportActions: "strings",
  topologyDisableAnnotations: "boolean",
  topologyDisableFullWindow: "boolean",
  topologyLookupTimeoutMs: "number",
  topologyDisablePtrLookups: "boolean",
  topologyDisableGeoLookups: "boolean",
  topologyGeoProvider: ["auto", "ipwhois", "ipapi_co", "ip_api", "internal"],
  topologyScanResolutionChain: "boolean",
  topologyDisableServiceDiscovery: "boolean",
  topologyTcpServices: "strings",
  auditExportDefaultDocuments: "boolean",
  confirmClearAuditLogs: "boolean",
  auditExportFolderPreset: "string",
  auditExportCustomPath: "string",
  auditExportSkipDestinationConfirm: "boolean",
  domainAuditCategories: "categories",
} as const satisfies Record<
  keyof BrowserSessionSettingsProfile,
  PreferenceKind
>;

const BROWSER_PREFERENCE_SCHEMA = {
  ...SESSION_PROFILE_SCHEMA,
  __storageRevision: "revision",
  lastZone: "string",
  lastActiveTabId: "string",
  dnsTableColumns: "strings",
  zoneDnsTableColumns: "string-array-map",
  vaultEnabled: "boolean",
  autoRefreshInterval: "number",
  confirmDeleteRecord: "boolean",
  zoneConfirmDeleteRecord: "boolean-map",
  lastOpenTabs: "strings",
  recordTags: "nested-string-array-map",
  tagCatalog: "string-array-map",
  mcpPendingHighRiskTools: "strings",
  mcpRemovedImportedToolIds: "strings",
  mcpPermissionPolicyVersion: "number",
  sessionSettingsProfiles: "profiles",
  auditOverrides: "string-array-map",
} as const satisfies Record<keyof BrowserPreferenceData, PreferenceKind>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function assertBoundedStorageValue(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > BROWSER_STATE_MAX_NODES)
      throw new RangeError("Browser state contains too many values.");
    if (current.depth > BROWSER_STATE_MAX_DEPTH)
      throw new RangeError("Browser state is nested too deeply.");
    if (typeof current.value === "string") {
      if (
        utf8ByteLengthUpTo(current.value, BROWSER_STATE_MAX_STRING_BYTES) >
        BROWSER_STATE_MAX_STRING_BYTES
      )
        throw new RangeError("Browser state contains an oversized string.");
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value))
        throw new TypeError("Browser state contains a non-finite number.");
      continue;
    }
    if (
      current.value === null ||
      typeof current.value === "boolean" ||
      current.value === undefined
    )
      continue;
    if (!current.value || typeof current.value !== "object")
      throw new TypeError("Browser state contains an unsupported value.");
    if (
      Array.isArray(current.value) &&
      current.value.length > BROWSER_STATE_MAX_ARRAY_ITEMS
    )
      throw new RangeError("Browser state contains an oversized array.");
    const entries = Object.entries(current.value);
    const limit = Array.isArray(current.value)
      ? BROWSER_STATE_MAX_ARRAY_ITEMS
      : BROWSER_STATE_MAX_PROPERTIES;
    if (entries.length > limit)
      throw new RangeError("Browser state contains an oversized collection.");
    for (const [key, child] of entries) {
      if (
        utf8ByteLengthUpTo(key, BROWSER_STATE_MAX_PROPERTY_BYTES) >
        BROWSER_STATE_MAX_PROPERTY_BYTES
      )
        throw new RangeError(
          "Browser state contains an oversized property name.",
        );
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function parseStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function parseLeafMap(
  value: unknown,
  kind: "number" | "boolean" | "strings",
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, leaf] of Object.entries(value)) {
    const parsed = parsePreference(leaf, kind);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

function parseNestedStringArrayMap(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    const parsed = parseLeafMap(child, "strings");
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

function parseSchemaObject(
  value: unknown,
  schema: Readonly<Record<string, PreferenceKind>>,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, kind] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const parsed = parsePreference(value[key], kind);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

function parsePreference(value: unknown, kind: PreferenceKind): unknown {
  if (typeof kind !== "string")
    return typeof value === "string" && kind.includes(value)
      ? value
      : undefined;
  if (kind === "string") return typeof value === "string" ? value : undefined;
  if (kind === "boolean") return typeof value === "boolean" ? value : undefined;
  if (kind === "number")
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  if (kind === "nullable-number")
    return value === null ||
      (typeof value === "number" && Number.isFinite(value))
      ? value
      : undefined;
  if (kind === "revision")
    return Number.isSafeInteger(value) && (value as number) >= 0
      ? value
      : undefined;
  if (kind === "strings") return parseStringArray(value);
  if (kind === "number-map") return parseLeafMap(value, "number");
  if (kind === "boolean-map") return parseLeafMap(value, "boolean");
  if (kind === "string-array-map") return parseLeafMap(value, "strings");
  if (kind === "nested-string-array-map")
    return parseNestedStringArrayMap(value);
  if (kind === "categories")
    return parseSchemaObject(value, {
      email: "boolean",
      security: "boolean",
      hygiene: "boolean",
    });
  if (kind === "profiles") {
    if (!isRecord(value)) return undefined;
    const profiles = Object.create(null) as Record<string, unknown>;
    for (const [id, profile] of Object.entries(value)) {
      const parsed = parseSchemaObject(profile, SESSION_PROFILE_SCHEMA);
      if (parsed !== undefined) profiles[id] = parsed;
    }
    return profiles;
  }
  return undefined;
}

export function sanitizeBrowserPreferencesValue(
  value: unknown,
): BrowserPreferenceData {
  assertBoundedStorageValue(value);
  const result = parseSchemaObject(value, BROWSER_PREFERENCE_SCHEMA);
  if (!result) throw new TypeError("Browser state must be an object.");
  assertBoundedStorageValue(result);
  const raw = JSON.stringify(result);
  if (
    utf8ByteLengthUpTo(raw, BROWSER_STATE_MAX_BYTES) > BROWSER_STATE_MAX_BYTES
  )
    throw new RangeError("Browser state exceeds the byte limit.");
  return result as BrowserPreferenceData;
}

export function sanitizeBrowserPreferencesRaw(raw: string): string {
  if (
    utf8ByteLengthUpTo(raw, BROWSER_STATE_MAX_BYTES) > BROWSER_STATE_MAX_BYTES
  )
    throw new RangeError("Browser state exceeds the byte limit.");
  return JSON.stringify(sanitizeBrowserPreferencesValue(JSON.parse(raw)));
}

function boundedIntegerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const normalized =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.max(minimum, Math.min(maximum, normalized));
}

function assertLegacyValuesWithinLimits(
  values: ReadonlyMap<string, string>,
  options: LegacyMigrationSafetyOptions,
): void {
  const maxEntries = boundedIntegerOption(
    options.maxEntries,
    LEGACY_MIGRATION_MAX_ENTRIES,
    0,
    LEGACY_MIGRATION_MAX_ENTRIES,
  );
  const maxBytes = boundedIntegerOption(
    options.maxBytes,
    LEGACY_MIGRATION_MAX_BYTES,
    0,
    LEGACY_MIGRATION_MAX_BYTES,
  );
  if (values.size > maxEntries) {
    throw new RangeError(
      "Legacy storage contains too many entries to migrate.",
    );
  }

  const allowedKeys = options.allowedKeys
    ? new Set(options.allowedKeys)
    : undefined;
  let retainedBytes = 0;
  for (const [key, value] of values) {
    if (typeof key !== "string" || typeof value !== "string") {
      throw new TypeError("Legacy storage contained a non-string entry.");
    }
    if (allowedKeys && !allowedKeys.has(key)) {
      throw new TypeError(`Unexpected legacy storage key: ${key}`);
    }
    retainedBytes += utf8ByteLengthUpTo(
      key,
      Math.max(0, maxBytes - retainedBytes),
    );
    if (retainedBytes > maxBytes) {
      throw new RangeError("Legacy storage exceeds the migration byte limit.");
    }
    retainedBytes += utf8ByteLengthUpTo(
      value,
      Math.max(0, maxBytes - retainedBytes),
    );
    if (retainedBytes > maxBytes) {
      throw new RangeError("Legacy storage exceeds the migration byte limit.");
    }
  }
}

async function loadLegacyValuesWithinTimeout(
  loadLegacyValues: LegacyStorageLoader,
  timeoutMs: number,
): Promise<ReadonlyMap<string, string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadLegacyValues(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Legacy browser storage migration timed out before startup could complete safely.",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build a synchronous durable adapter behind an explicit async readiness
 * barrier. Legacy IndexedDB values are copied transactionally into the
 * synchronous store before callers may read or mutate it.
 */
export function createMigratingStorage(
  storage: StorageLike,
  loadLegacyValues: LegacyStorageLoader,
  options: LegacyMigrationSafetyOptions = {},
): StorageLike {
  let ready = false;
  let failure: unknown;
  const timeoutMs = boundedIntegerOption(
    options.timeoutMs,
    LEGACY_MIGRATION_TIMEOUT_MS,
    1,
    LEGACY_MIGRATION_TIMEOUT_MS,
  );

  const readiness = (async () => {
    const legacyValues = await loadLegacyValuesWithinTimeout(
      loadLegacyValues,
      timeoutMs,
    );
    assertLegacyValuesWithinLimits(legacyValues, options);
    const previous = new Map<string, string | null>();
    const written: string[] = [];

    try {
      for (const [key, value] of legacyValues) {
        const preparedValue =
          key === BROWSER_STATE_KEY
            ? sanitizeBrowserPreferencesRaw(value)
            : value;
        const oldValue = storage.getItem(key);
        if (oldValue === preparedValue) continue;
        previous.set(key, oldValue);
        written.push(key);
        storage.setItem(key, preparedValue);
      }
      previous.set(MIGRATION_MARKER_KEY, storage.getItem(MIGRATION_MARKER_KEY));
      written.push(MIGRATION_MARKER_KEY);
      storage.setItem(MIGRATION_MARKER_KEY, "1");
      ready = true;
    } catch (error) {
      for (const key of written.reverse()) {
        try {
          const oldValue = previous.get(key) ?? null;
          if (oldValue === null) storage.removeItem(key);
          else storage.setItem(key, oldValue);
        } catch (rollbackError) {
          reportStorageFailure(
            rollbackError,
            "Roll back browser storage migration",
          );
        }
      }
      failure = error;
      throw error;
    }
  })().catch((error) => {
    failure = error;
    reportStorageFailure(error, "Prepare browser storage");
    throw error;
  });

  const assertReady = (): void => {
    if (ready) return;
    if (failure instanceof Error) throw failure;
    throw new StorageNotReadyError();
  };

  return {
    backend: "localstorage",
    getItem(key: string): string | null {
      return storage.getItem(key);
    },
    setItem(key: string, value: string): void {
      assertReady();
      storage.setItem(key, value);
    },
    removeItem(key: string): void {
      assertReady();
      storage.removeItem(key);
    },
    isReady(): boolean {
      return ready;
    },
    ready(): Promise<void> {
      return readiness;
    },
  };
}

async function loadLegacyIndexedDbValues(): Promise<
  ReadonlyMap<string, string>
> {
  if (typeof indexedDB === "undefined") return new Map();
  const idb = await import("idb");
  const db = await idb.openDB(LEGACY_DATABASE_NAME, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        database.createObjectStore(LEGACY_STORE_NAME);
      }
    },
  });

  try {
    const values = new Map<string, string>();
    for (const key of LEGACY_STORAGE_KEYS) {
      const value: unknown = await db.get(LEGACY_STORE_NAME, key);
      if (value === undefined) continue;
      if (typeof value !== "string") {
        throw new TypeError("Legacy IndexedDB contained a non-string value.");
      }
      values.set(key, value);
    }
    return values;
  } finally {
    db.close();
  }
}

function readSanitizedBrowserState(storage: Storage): string | null {
  const raw = storage.getItem(BROWSER_STATE_KEY);
  if (raw === null) return null;
  try {
    const safe = sanitizeBrowserPreferencesRaw(raw);
    if (safe !== raw) storage.setItem(BROWSER_STATE_KEY, safe);
    return safe;
  } catch (error) {
    storage.removeItem(BROWSER_STATE_KEY);
    reportStorageFailure(error, "Drop unsafe browser storage data");
    return null;
  }
}

function createBrowserStorageAdapter(storage: Storage): StorageLike {
  storage.removeItem(BROWSER_RECOVERY_KEY);
  readSanitizedBrowserState(storage);
  const transient = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  transient?.removeItem(BROWSER_STATE_KEY);
  transient?.removeItem(BROWSER_RECOVERY_KEY);
  return {
    backend: "localstorage",
    getItem: (key) => {
      if (key === BROWSER_STATE_KEY) return readSanitizedBrowserState(storage);
      if (key === BROWSER_RECOVERY_KEY) {
        storage.removeItem(key);
        return null;
      }
      return storage.getItem(key);
    },
    setItem: (key, value) => {
      if (key === BROWSER_STATE_KEY) {
        storage.setItem(key, sanitizeBrowserPreferencesRaw(value));
      } else if (key === BROWSER_RECOVERY_KEY) {
        storage.removeItem(key);
      } else {
        storage.setItem(key, value);
      }
    },
    removeItem: (key) => storage.removeItem(key),
    isReady: () => true,
    ready: () => Promise.resolve(),
  };
}

let selectedStorage: StorageLike | undefined;
let selectedBackend: "localstorage" | "memory" | undefined;

/**
 * Return one process-wide storage adapter. localStorage is the canonical
 * synchronous durable store. IndexedDB is read only during the awaited legacy
 * migration; it is never presented as a synchronous fire-and-forget facade.
 */
export function getStorage(storage?: StorageLike): StorageLike {
  if (storage) return storage;
  if (selectedStorage) return selectedStorage;

  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const maybeStorage = (globalThis as { localStorage?: Storage })
        .localStorage;
      if (
        maybeStorage &&
        typeof maybeStorage.getItem === "function" &&
        typeof maybeStorage.setItem === "function" &&
        typeof maybeStorage.removeItem === "function"
      ) {
        const syncStorage = createBrowserStorageAdapter(maybeStorage);
        const migrationComplete =
          maybeStorage.getItem(MIGRATION_MARKER_KEY) === "1";
        selectedStorage = migrationComplete
          ? syncStorage
          : createMigratingStorage(syncStorage, loadLegacyIndexedDbValues, {
              allowedKeys: LEGACY_STORAGE_KEYS,
            });
        selectedBackend = "localstorage";
        return selectedStorage;
      }
    }
  } catch (error) {
    reportStorageFailure(error, "Select browser storage");
  }

  reportStorageFailure(
    new Error(
      "Durable synchronous browser storage is unavailable; using an ephemeral session.",
    ),
    "Select browser storage",
  );
  selectedStorage = new MemoryStorage();
  selectedBackend = "memory";
  return selectedStorage;
}

export function storageBackend(): "indexeddb" | "localstorage" | "memory" {
  if (!selectedStorage) getStorage();
  return selectedBackend ?? "memory";
}

/** Test-only process singleton reset. */
export function resetStorageSelectionForTests(): void {
  selectedStorage = undefined;
  selectedBackend = undefined;
}
