/**
 * Records that are **gone from Cloudflare** and kept by this application so
 * they can be put back.
 *
 * # Cloudflare has no disabled state
 *
 * A Cloudflare DNS record either exists or it does not. There is no flag that
 * parks one. So "disable this record" can only mean: delete it from Cloudflare,
 * keep a complete copy locally, and create it again on re-enable. A disabled
 * record does not resolve, it is absent from `dig` and from the Cloudflare
 * dashboard, its record id is gone for good, and if this application's store is
 * lost the record is lost with it. It is a backup, not a toggle, and any screen
 * that shows one has to say so.
 *
 * Nothing here is called `DisabledRecord`, because nothing is disabled
 * anywhere. A {@link RetainedRecord} is a record this application removed from a
 * provider and retained, and `removedFromProviderAt` says when it stopped
 * resolving.
 *
 * # Rust owns the store
 *
 * The entries live in the OS keyring, written by `bc_storage::retention`
 * (`src-tauri/crates/bc-storage/src/retention.rs`), which is the source of
 * truth for the bounds, the expiry rule and the eviction order. This module is
 * the typed mirror: it exists so the renderer can parse, display and bound the
 * same data without a round-trip, and `test/recordRetention.test.ts` asserts the
 * two never drift.
 *
 * The store is deliberately *not* in browser preferences. A retained TXT record
 * is unbounded user data, and preferences have one shared 2 MB ceiling
 * (`MAX_STORAGE_BYTES` in `../storage/storage.ts`); a bin that lives there can
 * grow until saving a tag or a column layout starts failing. In its own keyring
 * secret it competes only with other retained records. Browser preferences hold
 * the four settings in {@link RecycleBinSettings} and nothing else.
 */

// ── Bounds, mirrored from the Rust module ───────────────────────────────────

/**
 * The same numbers as `bc_storage::retention`. Named for the Rust constants
 * they mirror so the parity test can pair them up:
 *
 * - `retentionDays` → `MIN_RETENTION_DAYS` / `MAX_RETENTION_DAYS` /
 *   `DEFAULT_RETENTION_DAYS`
 * - `maxEntries` → `MIN_RETAINED_ENTRY_LIMIT` / `MAX_RETAINED_ENTRIES`
 * - `storeBytes` → `MAX_RETAINED_BYTES`
 * - `entryBytes` → `MAX_RETAINED_ENTRY_BYTES`
 * - `tags` → `MAX_RETAINED_TAGS`
 */
export const RETENTION_LIMITS = Object.freeze({
  retentionDays: Object.freeze({ min: 1, max: 365, default: 30 }),
  maxEntries: Object.freeze({ min: 10, max: 1000, default: 1000 }),
  storeBytes: 1_500_000,
  entryBytes: 12_288,
  tags: 32,
});

// ── Reasons ─────────────────────────────────────────────────────────────────

/** The stored spellings this build writes. */
export const RETENTION_REASON_DISABLED = "disabled";
export const RETENTION_REASON_DELETED = "deleted";

/**
 * This build's reading of an entry's `reason`.
 *
 * `"unknown"` is a first-class answer, not an error: an entry written by a
 * newer build keeps whatever reason it was given, and nothing here branches on
 * the reason except the words shown and the lifetime assigned. An unknown
 * reason is treated like a disable — indefinite, and never preferred as an
 * eviction victim — because over-retaining a record that exists nowhere else is
 * the safe direction to be wrong in.
 */
export type RetentionReasonKind = "disabled" | "deleted" | "unknown";

export function retentionReasonKind(raw: unknown): RetentionReasonKind {
  if (raw === RETENTION_REASON_DISABLED) return "disabled";
  if (raw === RETENTION_REASON_DELETED) return "deleted";
  return "unknown";
}

// ── Entries ─────────────────────────────────────────────────────────────────

/** Just enough of a DNS record to create it again. */
export interface RetainedRecordSnapshot {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  comment?: string;
}

/** One record that was removed from a provider and kept here. */
export interface RetainedRecord extends RetainedRecordSnapshot {
  /**
   * How this entry is addressed. The provider's record id cannot serve: it dies
   * with the record and a restore mints a new one.
   */
  entryId: string;
  /** The raw stored reason, whatever wrote it. */
  reason: string;
  /** This build's reading of {@link reason}. */
  reasonKind: RetentionReasonKind;
  zoneId: string;
  zoneName: string;
  /**
   * The id the record had before it was removed. Dead, and **not** the id it
   * will have after a restore — it is here so the trail and the UI can say
   * which record this used to be.
   */
  originRecordId?: string;
  /** RFC 3339. When the record stopped resolving. */
  removedFromProviderAt?: string;
  /**
   * RFC 3339, or absent for "never". A disable stores no expiry, and so does an
   * entry whose stored expiry could not be read — a date this build cannot
   * parse is not a licence to delete the record.
   */
  expiresAt?: string;
  /**
   * This application's own tags for the record. They were keyed by the provider
   * id that died, so a restore re-attaches them to the new one.
   */
  localTags: string[];
  /**
   * The entry exactly as stored, unknown fields from a newer build included.
   * Carry this, not a rebuilt object, if an entry ever has to be written back.
   */
  raw: Readonly<Record<string, unknown>>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function wholeNumber(value: unknown, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.trunc(value);
  if (rounded < 0 || rounded > maximum) return undefined;
  return rounded;
}

/** A timestamp this build can read, or `undefined`. */
function timestamp(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  return Number.isNaN(Date.parse(raw)) ? undefined : raw;
}

/**
 * Read one stored entry.
 *
 * Returns `null` only for a value that is not an object — the one shape that
 * cannot be an entry. Every field is optional and has a defined meaning when
 * absent, so a half-written entry lists (and says why it cannot be restored)
 * rather than taking the whole bin down. This is the mirror of
 * `RetainedRecord::of` in Rust and has to stay as forgiving.
 */
export function parseRetainedRecord(value: unknown): RetainedRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const reason = text(raw.reason) ?? "";
  const tags = Array.isArray(raw.local_tags)
    ? raw.local_tags
        .filter((tag): tag is string => typeof tag === "string")
        .filter((tag) => tag.trim().length > 0)
        .slice(0, RETENTION_LIMITS.tags)
    : [];

  return {
    entryId: text(raw.entry_id) ?? "",
    reason,
    reasonKind: retentionReasonKind(reason),
    zoneId: text(raw.zone_id) ?? "",
    zoneName: text(raw.zone_name) ?? "",
    originRecordId: text(raw.origin_record_id),
    removedFromProviderAt: timestamp(raw.removed_from_provider_at),
    expiresAt: timestamp(raw.expires_at),
    type: text(raw.type) ?? "",
    name: text(raw.name) ?? "",
    content: typeof raw.content === "string" ? raw.content : "",
    ttl: wholeNumber(raw.ttl, 0xffffffff),
    priority: wholeNumber(raw.priority, 0xffff),
    proxied: typeof raw.proxied === "boolean" ? raw.proxied : undefined,
    comment: text(raw.comment),
    localTags: tags,
    raw: Object.freeze({ ...raw }),
  };
}

/** Read a whole stored list, dropping only values that cannot be entries. */
export function parseRetainedRecords(
  values: readonly unknown[] | null | undefined,
): RetainedRecord[] {
  if (!Array.isArray(values)) return [];
  const entries: RetainedRecord[] = [];
  for (const value of values) {
    const entry = parseRetainedRecord(value);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Whether an entry carries everything a restore needs.
 *
 * Content may legitimately be empty for some record types; the provider is the
 * authority on that, and the native command validates before it calls out.
 */
export function isRetainedRecordRestorable(entry: RetainedRecord): boolean {
  return (
    entry.entryId.length > 0 &&
    entry.zoneId.length > 0 &&
    entry.type.length > 0 &&
    entry.name.length > 0
  );
}

/**
 * Whether the entry's expiry has passed.
 *
 * `nowMs` is a parameter, never `Date.now()` read inside, so a thirty-day
 * window is testable in a millisecond — and so a list and a purge decided by
 * the same instant can never disagree about what is still restorable.
 */
export function isRetainedRecordExpired(
  entry: RetainedRecord,
  nowMs: number,
): boolean {
  if (entry.expiresAt === undefined) return false;
  const expiresAtMs = Date.parse(entry.expiresAt);
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs <= nowMs;
}

/**
 * Whole days left before the entry expires, or `null` when it never does.
 *
 * Rounded up, so an entry with four hours left reads as "1 day" rather than as
 * "0" — a countdown that says zero while the thing is still restorable invites
 * exactly the wrong conclusion. `0` therefore means it has expired.
 */
export function retainedRecordDaysLeft(
  entry: RetainedRecord,
  nowMs: number,
): number | null {
  if (entry.expiresAt === undefined) return null;
  const expiresAtMs = Date.parse(entry.expiresAt);
  if (Number.isNaN(expiresAtMs)) return null;
  if (expiresAtMs <= nowMs) return 0;
  return Math.ceil((expiresAtMs - nowMs) / 86_400_000);
}

/** Only the entries that could still be restored at `nowMs`. */
export function restorableRetainedRecords(
  entries: readonly RetainedRecord[],
  nowMs: number,
): RetainedRecord[] {
  return entries.filter((entry) => !isRetainedRecordExpired(entry, nowMs));
}

/**
 * The record input that would re-create this entry.
 *
 * Field for field what the create path accepts, and no more: anything
 * Cloudflare holds that this application never modelled — record `tags` and the
 * per-record `settings` object — was never retained and cannot be put back. See
 * the note on {@link RETAINED_FIELD_LOSSES}.
 */
export function retainedRecordInput(
  entry: RetainedRecord,
): RetainedRecordSnapshot {
  const input: RetainedRecordSnapshot = {
    type: entry.type,
    name: entry.name,
    content: entry.content,
  };
  if (entry.ttl !== undefined) input.ttl = entry.ttl;
  if (entry.priority !== undefined) input.priority = entry.priority;
  if (entry.proxied !== undefined) input.proxied = entry.proxied;
  if (entry.comment !== undefined) input.comment = entry.comment;
  return input;
}

/**
 * What a disable-and-restore round trip cannot preserve, for the UI to warn
 * about honestly.
 *
 * Each entry is a thing Cloudflare holds that this application's create path
 * never sends, so it is not retained and is not restored. Nothing here is a bug
 * in the bin; it is the consequence of restoring through the same API the rest
 * of the app writes through.
 */
export const RETAINED_FIELD_LOSSES: readonly string[] = Object.freeze([
  // `DNSRecordInput` in `bc-cloudflare-api` models seven fields; these are the
  // record attributes outside it.
  "the record id (a restore always mints a new one)",
  "Cloudflare record tags",
  "per-record settings (flatten_cname, ipv4_only, ipv6_only)",
  "created_on and modified_on (the restored record is newly created)",
]);

/** Oldest removal first; entries with no removal date sort last, stably. */
export function sortRetainedRecords(
  entries: readonly RetainedRecord[],
): RetainedRecord[] {
  return [...entries].sort((left, right) => {
    const leftMs = left.removedFromProviderAt
      ? Date.parse(left.removedFromProviderAt)
      : Number.POSITIVE_INFINITY;
    const rightMs = right.removedFromProviderAt
      ? Date.parse(right.removedFromProviderAt)
      : Number.POSITIVE_INFINITY;
    if (leftMs === rightMs) return 0;
    return leftMs < rightMs ? -1 : 1;
  });
}

// ── Settings ────────────────────────────────────────────────────────────────

/**
 * The four values the user controls. Everything else about the store — the byte
 * ceiling, the per-entry ceiling, the eviction order — is a hard bound, not a
 * preference, because getting any of them wrong breaks saving a record.
 */
export interface RecycleBinSettings {
  /** Whether a deletion goes to the bin at all. */
  enabled: boolean;
  /** Days a binned deletion is kept. */
  retentionDays: number;
  /** Entries the bin holds before it gives up its oldest. */
  maxEntries: number;
  /** Whether expired entries are swept without being asked. */
  autoPurge: boolean;
}

export function clampRetentionDays(value: unknown): number {
  const { min, max, default: fallback } = RETENTION_LIMITS.retentionDays;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function clampRetainedEntryLimit(value: unknown): number {
  const { min, max, default: fallback } = RETENTION_LIMITS.maxEntries;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * The retention window to stamp on a new entry, or `null` for no expiry.
 *
 * A disable is indefinite whatever the bin is set to: a disable that expired
 * would be a disable that deleted the user's record while they were not
 * looking. Only a deletion gets a deadline. The native command applies the same
 * rule, so a caller that gets this wrong cannot produce an expiring disable —
 * this function exists so the UI does not have to encode the rule twice.
 */
export function retentionDaysForReason(
  reason: string,
  settings: Pick<RecycleBinSettings, "retentionDays">,
): number | null {
  return retentionReasonKind(reason) === "deleted"
    ? clampRetentionDays(settings.retentionDays)
    : null;
}

/** Whether a deletion should be retained rather than simply carried out. */
export function shouldRetainDeletion(
  settings: Pick<RecycleBinSettings, "enabled">,
): boolean {
  return settings.enabled;
}

// ── Native command surface ──────────────────────────────────────────────────

/** The native commands this feature needs. Mirrors `commands::retention`. */
export const RETENTION_COMMANDS = Object.freeze({
  retain: "retain_dns_record",
  list: "list_retained_records",
  restore: "restore_retained_record",
  purge: "purge_retained_records",
  forget: "forget_retained_record",
  clear: "clear_retained_records",
} as const);

/**
 * What `retain_dns_record` decided.
 *
 * The two cases are not degrees of the same thing: in one the record is gone
 * from Cloudflare, and in the other it is still there and the user has to make
 * room before it can be touched. Switch on `status`.
 */
export type RetainDecision =
  | {
      status: "retained";
      entryId: string;
      expiresAt: string | null;
      purged: number;
      /**
       * Recycle-bin entries given up to make room. Non-zero means something
       * restorable was forgotten; the audit trail names each one. A `disabled`
       * entry is never among them.
       */
      evicted: number;
    }
  | {
      status: "store_full";
      /** Nothing happened. The record is still live at Cloudflare. */
      held: number;
      /** How many held entries may never be given up. */
      protected: number;
      bytesHeld: number;
      maxBytes: number;
      maxEntries: number;
      purged: number;
    };

/** What `list_retained_records` reports. Entries are raw; parse them. */
export interface RetainedStoreView {
  entries: unknown[];
  /** Past their expiry and not yet swept — the cue to call the purge command. */
  expiredPendingPurge: number;
  totalHeld: number;
  bytesHeld: number;
  maxBytes: number;
  maxEntries: number;
}

export interface PurgeReport {
  purged: number;
  remaining: number;
}

/** A record found in the zone while checking whether a restore can proceed. */
export interface ExistingRecordView {
  recordId: string | null;
  type: string;
  name: string;
  content: string;
}

/** The record shape the native layer returns for a restored record. */
export interface RestoredRecord {
  id?: string;
  type: string;
  name: string;
  content: string;
  comment?: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  zone_id: string;
  zone_name: string;
  created_on: string;
  modified_on: string;
}

/**
 * How a restore ended.
 *
 * A discriminated union rather than a thrown string, because most of these are
 * not failures of this application and each is a different sentence for the
 * user. The command only rejects when the store itself cannot be read.
 */
export type RestoreOutcome =
  | {
      status: "restored";
      entryId: string;
      /** The **new** record. `id` is not the id it had before. */
      record: RestoredRecord;
      /** Re-attach these to `record.id`; they were keyed by the dead id. */
      localTags: string[];
      /** What it was restored alongside at the same name, if anything. */
      sharesNameWith: ExistingRecordView[];
      /** The zone was too large to scan; Cloudflare was left to judge. */
      destinationUnverified: boolean;
      /** `false`: created, but the stale entry is still in the store. */
      entryCleared: boolean;
    }
  | { status: "not_found"; entryId: string }
  | { status: "expired"; entryId: string; expiresAt: string | null }
  | { status: "incomplete"; entryId: string; missing: string[] }
  | { status: "invalid"; entryId: string; issues: string[] }
  | {
      status: "blocked";
      entryId: string;
      obstacle: "already_present" | "cname_collision" | string;
      existing: ExistingRecordView;
    }
  | {
      status: "zone_unavailable";
      entryId: string;
      zoneId: string;
      message: string;
    }
  | { status: "provider_refused"; entryId: string; message: string };

/** The `invoke` shape this module needs, so it does not depend on the client. */
export type RetentionInvoke = <T>(
  command: string,
  args: Record<string, unknown>,
) => Promise<T>;

export interface RetainDnsRecordArgs {
  apiKey: string;
  email?: string;
  zoneId: string;
  zoneName?: string;
  /** The id the record has **now**, which this call is about to end. */
  recordId: string;
  record: RetainedRecordSnapshot;
  /** `"disabled"` or `"deleted"`. */
  reason: string;
  /** From {@link retentionDaysForReason}; `null` for an indefinite disable. */
  retentionDays: number | null;
  /** This application's tags for the record, read before the id dies. */
  localTags?: string[];
  /** The configured entry cap; omitted means the native hard ceiling. */
  maxEntries?: number;
  /**
   * Groups every retain in one user action, so a 37-record selection undoes as
   * one operation rather than 37. A UUID v4; omitted means this retain is its
   * own operation of one. The command validates it and mints a replacement for
   * anything malformed, so a bad id costs the grouping and never the write.
   */
  operationId?: string;
}

/**
 * A typed wrapper over the native commands.
 *
 * Takes the `invoke` function rather than importing the client, so this module
 * stays independent of it and a test can drive the whole surface without Tauri.
 * Its only real job is to own the argument names in one place: a mistyped
 * `zoneId` here is a silently missing zone in a retained entry.
 */
export function createRecordRetentionClient(invoke: RetentionInvoke) {
  return {
    /**
     * Remove a record from Cloudflare and keep a complete copy. The one
     * primitive behind both disable and delete-to-bin; `reason` decides which.
     */
    retain(args: RetainDnsRecordArgs): Promise<RetainDecision> {
      return invoke<RetainDecision>(RETENTION_COMMANDS.retain, {
        apiKey: args.apiKey,
        email: args.email,
        zoneId: args.zoneId,
        zoneName: args.zoneName,
        recordId: args.recordId,
        record: args.record,
        reason: args.reason,
        retentionDays: args.retentionDays ?? undefined,
        localTags: args.localTags ?? [],
        maxEntries: args.maxEntries ?? undefined,
        operationId: args.operationId ?? undefined,
      });
    },

    /** Everything still restorable, plus what the store is spending. */
    list(maxEntries?: number): Promise<RetainedStoreView> {
      return invoke<RetainedStoreView>(RETENTION_COMMANDS.list, {
        maxEntries: maxEntries ?? undefined,
      });
    },

    /** Create a retained record again. Serves re-enable and restore alike. */
    restore(args: {
      apiKey: string;
      email?: string;
      entryId: string;
    }): Promise<RestoreOutcome> {
      return invoke<RestoreOutcome>(RETENTION_COMMANDS.restore, {
        apiKey: args.apiKey,
        email: args.email,
        entryId: args.entryId,
      });
    },

    /** Drop every entry whose expiry has passed. Idempotent. */
    purge(): Promise<PurgeReport> {
      return invoke<PurgeReport>(RETENTION_COMMANDS.purge, {});
    },

    /**
     * Discard one entry without restoring it. The record is then gone for
     * good. `false` means there was no such entry, which is not an error.
     */
    forget(entryId: string): Promise<boolean> {
      return invoke<boolean>(RETENTION_COMMANDS.forget, { entryId });
    },

    /** Empty the store. Every entry it drops exists nowhere else. */
    clear(): Promise<PurgeReport> {
      return invoke<PurgeReport>(RETENTION_COMMANDS.clear, {});
    },
  };
}

export type RecordRetentionClient = ReturnType<
  typeof createRecordRetentionClient
>;
