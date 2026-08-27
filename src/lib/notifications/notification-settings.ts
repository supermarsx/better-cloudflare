/**
 * Notification settings: TS mirror of `bc_notify::settings::NotificationSettings`.
 *
 * The Rust `normalize()` is the source of truth for every limit; this file
 * mirrors it so the UI can clamp optimistically before the IPC round-trip and
 * so partial objects (older builds, hand-edited prefs) render with defaults.
 * Parity is enforced by `test/fixtures/notification-settings.json`, which both
 * `cargo test -p bc-notify` and `test/notificationSettings.test.ts` load.
 *
 * Wire shape is camelCase (Design §9 of `.orchestration/plans/t9.md`).
 */

export const NOTIFICATION_SETTINGS_VERSION = 1 as const;

export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationSeverityChoice = "auto" | NotificationSeverity;
export type ToastMinSeverity = NotificationSeverity | "never";
export type ExpirySource = "auto" | "rdap" | "registrar";
export type ZoneMonitorMode = "all" | "allowlist";
export type QuietHoursBehaviour = "silence" | "hold";
export type NotificationKindKey = "domainExpiry" | "recordChange" | "service";
export type RecordChangeKind = "added" | "changed" | "removed";
export type RecordChangeField =
  | "content"
  | "ttl"
  | "proxied"
  | "priority"
  | "comment"
  | "name"
  | "type";

export interface NotificationServiceSettings {
  /** Master switch; `false` keeps the task idle (no network). */
  enabled: boolean;
  /** Pause/resume without losing configuration. */
  paused: boolean;
  /** Run a pass immediately after start; `false` waits one interval. */
  catchUpOnLaunch: boolean;
  recordPollMinutes: number;
  expiryPollMinutes: number;
  rdapCacheHours: number;
  maxZonesPerPass: number;
  backoffMaxMinutes: number;
}

export interface NotificationKindSettings {
  enabled: boolean;
  severity: NotificationSeverityChoice;
  osNotify: boolean;
}

export interface RecordChangeKindSettings extends NotificationKindSettings {
  changes: Record<RecordChangeKind, boolean>;
  /** Which field diffs count as a change (canonical order, deduplicated). */
  fields: RecordChangeField[];
}

export interface NotificationKindsSettings {
  domainExpiry: NotificationKindSettings;
  recordChange: RecordChangeKindSettings;
  service: NotificationKindSettings;
}

export interface ExpirySettings {
  /** Days-before-expiry milestones, 1..=365 each, ≤12, deduplicated, sorted desc. */
  milestones: number[];
  notifyExpired: boolean;
  source: ExpirySource;
  severityByMilestone: { warningAtOrBelow: number; criticalAtOrBelow: number };
}

export interface ZoneOverride {
  muted: boolean;
  /** RFC 3339 instant; cleared by `normalize` once it is in the past. */
  mutedUntil?: string;
  kinds?: { domainExpiry?: boolean; recordChange?: boolean };
}

export interface ZoneSettings {
  mode: ZoneMonitorMode;
  include: string[];
  exclude: string[];
  overrides: Record<string, ZoneOverride>;
}

export interface QuietHoursSettings {
  enabled: boolean;
  /** `HH:MM`, 24-hour. */
  start: string;
  end: string;
  /** Weekdays (0 = Sunday … 6 = Saturday) the window applies to. */
  days: number[];
  /** `"local"` or an IANA zone name. */
  timezone: string;
  behaviour: QuietHoursBehaviour;
}

export interface OsNotificationSettings {
  enabled: boolean;
  minSeverity: NotificationSeverity;
}

export interface InAppSettings {
  toastMinSeverity: ToastMinSeverity;
  badge: boolean;
}

export interface RetentionSettings {
  autoArchiveReadAfterDays: number | null;
  purgeArchivedAfterDays: number | null;
  maxItems: number;
  keepSnapshots: boolean;
}

export interface NotificationSettings {
  version: typeof NOTIFICATION_SETTINGS_VERSION;
  service: NotificationServiceSettings;
  kinds: NotificationKindsSettings;
  expiry: ExpirySettings;
  zones: ZoneSettings;
  quietHours: QuietHoursSettings;
  osNotifications: OsNotificationSettings;
  inApp: InAppSettings;
  retention: RetentionSettings;
}

/** Recursive partial used by `update(partial)` and `clampNotificationSettings`. */
export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type NotificationSettingsInput = DeepPartial<NotificationSettings>;

interface NumberRange {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/** Numeric limits — mirror of the clamps in Rust `normalize()`. */
export const NOTIFICATION_SETTING_LIMITS = {
  recordPollMinutes: { min: 5, max: 1440, default: 15 },
  expiryPollMinutes: { min: 60, max: 10080, default: 360 },
  rdapCacheHours: { min: 6, max: 168, default: 24 },
  maxZonesPerPass: { min: 1, max: 1000, default: 200 },
  backoffMaxMinutes: { min: 5, max: 1440, default: 120 },
  milestoneDays: { min: 1, max: 365, default: 0 },
  maxMilestones: 12,
  warningAtOrBelow: { min: 0, max: 365, default: 14 },
  criticalAtOrBelow: { min: 0, max: 365, default: 3 },
  autoArchiveReadAfterDays: { min: 1, max: 365, default: 30 },
  purgeArchivedAfterDays: { min: 1, max: 365, default: 90 },
  maxItems: { min: 100, max: 10000, default: 2000 },
} as const;

export const DEFAULT_EXPIRY_MILESTONES: readonly number[] = [
  90, 60, 30, 14, 7, 3, 1,
];

export const RECORD_CHANGE_FIELDS: readonly RecordChangeField[] = [
  "content",
  "ttl",
  "proxied",
  "priority",
  "comment",
  "name",
  "type",
];

export const NOTIFICATION_SEVERITIES: readonly NotificationSeverity[] = [
  "info",
  "warning",
  "critical",
];

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function createDefaultNotificationSettings(): NotificationSettings {
  return {
    version: NOTIFICATION_SETTINGS_VERSION,
    service: {
      enabled: true,
      paused: false,
      catchUpOnLaunch: true,
      recordPollMinutes: NOTIFICATION_SETTING_LIMITS.recordPollMinutes.default,
      expiryPollMinutes: NOTIFICATION_SETTING_LIMITS.expiryPollMinutes.default,
      rdapCacheHours: NOTIFICATION_SETTING_LIMITS.rdapCacheHours.default,
      maxZonesPerPass: NOTIFICATION_SETTING_LIMITS.maxZonesPerPass.default,
      backoffMaxMinutes: NOTIFICATION_SETTING_LIMITS.backoffMaxMinutes.default,
    },
    kinds: {
      domainExpiry: { enabled: true, severity: "auto", osNotify: true },
      recordChange: {
        enabled: true,
        severity: "auto",
        osNotify: true,
        changes: { added: true, changed: true, removed: true },
        fields: [...RECORD_CHANGE_FIELDS],
      },
      service: { enabled: true, severity: "info", osNotify: false },
    },
    expiry: {
      milestones: [...DEFAULT_EXPIRY_MILESTONES],
      notifyExpired: true,
      source: "auto",
      severityByMilestone: {
        warningAtOrBelow: NOTIFICATION_SETTING_LIMITS.warningAtOrBelow.default,
        criticalAtOrBelow:
          NOTIFICATION_SETTING_LIMITS.criticalAtOrBelow.default,
      },
    },
    zones: { mode: "all", include: [], exclude: [], overrides: {} },
    quietHours: {
      enabled: false,
      start: "22:00",
      end: "07:00",
      days: [0, 1, 2, 3, 4, 5, 6],
      timezone: "local",
      behaviour: "silence",
    },
    osNotifications: { enabled: true, minSeverity: "warning" },
    inApp: { toastMinSeverity: "critical", badge: true },
    retention: {
      autoArchiveReadAfterDays:
        NOTIFICATION_SETTING_LIMITS.autoArchiveReadAfterDays.default,
      purgeArchivedAfterDays:
        NOTIFICATION_SETTING_LIMITS.purgeArchivedAfterDays.default,
      maxItems: NOTIFICATION_SETTING_LIMITS.maxItems.default,
      keepSnapshots: true,
    },
  };
}

/** Frozen defaults; use `createDefaultNotificationSettings()` for a mutable copy. */
export const DEFAULT_NOTIFICATION_SETTINGS: Readonly<NotificationSettings> =
  Object.freeze(createDefaultNotificationSettings());

// ── primitive coercions ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integer(value: unknown, range: NumberRange): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return range.default;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function nullableInteger(value: unknown, range: NumberRange): number | null {
  if (value === null) return null;
  return integer(value, range);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/u;

export function isValidClockTime(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  if (value === "local") return true;
  try {
    // Throws RangeError for unknown IANA names.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function parseInstant(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Mirror of `bc_notify::expiry::normalize_milestones`: 1..=365, dedup, desc, ≤12 (largest kept). */
export function normalizeMilestones(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_EXPIRY_MILESTONES];
  const { min, max } = NOTIFICATION_SETTING_LIMITS.milestoneDays;
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) continue;
    const days = Math.round(entry);
    if (days < min || days > max) continue;
    seen.add(days);
  }
  return [...seen]
    .sort((a, b) => b - a)
    .slice(0, NOTIFICATION_SETTING_LIMITS.maxMilestones);
}

function normalizeChangeFields(value: unknown): RecordChangeField[] {
  if (!Array.isArray(value)) return [...RECORD_CHANGE_FIELDS];
  const wanted = new Set(
    value.filter((entry): entry is RecordChangeField =>
      (RECORD_CHANGE_FIELDS as readonly string[]).includes(entry as string),
    ),
  );
  const fields = RECORD_CHANGE_FIELDS.filter((field) => wanted.has(field));
  // An empty selection would make record-change detection meaningless.
  return fields.length > 0 ? fields : [...RECORD_CHANGE_FIELDS];
}

function normalizeKind(
  value: unknown,
  defaults: NotificationKindSettings,
): NotificationKindSettings {
  const input = isRecord(value) ? value : {};
  return {
    enabled: bool(input.enabled, defaults.enabled),
    severity: oneOf(
      input.severity,
      ["auto", ...NOTIFICATION_SEVERITIES],
      defaults.severity,
    ),
    osNotify: bool(input.osNotify, defaults.osNotify),
  };
}

function normalizeOverrides(
  value: unknown,
  now: number,
): Record<string, ZoneOverride> {
  if (!isRecord(value)) return {};
  const out: Record<string, ZoneOverride> = {};
  for (const [zoneId, raw] of Object.entries(value)) {
    const key = zoneId.trim();
    if (!key || !isRecord(raw)) continue;
    const override: ZoneOverride = { muted: bool(raw.muted, false) };
    const until = parseInstant(raw.mutedUntil);
    if (until !== null && until > now && typeof raw.mutedUntil === "string") {
      override.mutedUntil = raw.mutedUntil;
    }
    if (isRecord(raw.kinds)) {
      const kinds: ZoneOverride["kinds"] = {};
      if (typeof raw.kinds.domainExpiry === "boolean")
        kinds.domainExpiry = raw.kinds.domainExpiry;
      if (typeof raw.kinds.recordChange === "boolean")
        kinds.recordChange = raw.kinds.recordChange;
      if (Object.keys(kinds).length > 0) override.kinds = kinds;
    }
    // An override that changes nothing is noise; drop it.
    if (!override.muted && !override.mutedUntil && !override.kinds) continue;
    out[key] = override;
  }
  return out;
}

/**
 * Same rules as Rust `NotificationSettings::normalize()`: every field is
 * optional on input, invalid values fall back to their default, numbers are
 * rounded then clamped, enums outside their domain reset, milestones are
 * deduplicated/sorted/capped, past `mutedUntil` values are cleared, malformed
 * quiet-hours times disable the window, and `criticalAtOrBelow` can never
 * exceed `warningAtOrBelow`.
 */
export function clampNotificationSettings(
  input: unknown,
  now: number = Date.now(),
): NotificationSettings {
  const d = DEFAULT_NOTIFICATION_SETTINGS;
  const raw = isRecord(input) ? input : {};
  const service = isRecord(raw.service) ? raw.service : {};
  const kinds = isRecord(raw.kinds) ? raw.kinds : {};
  const recordChange = isRecord(kinds.recordChange) ? kinds.recordChange : {};
  const changes = isRecord(recordChange.changes) ? recordChange.changes : {};
  const expiry = isRecord(raw.expiry) ? raw.expiry : {};
  const sevBy = isRecord(expiry.severityByMilestone)
    ? expiry.severityByMilestone
    : {};
  const zones = isRecord(raw.zones) ? raw.zones : {};
  const quiet = isRecord(raw.quietHours) ? raw.quietHours : {};
  const os = isRecord(raw.osNotifications) ? raw.osNotifications : {};
  const inApp = isRecord(raw.inApp) ? raw.inApp : {};
  const retention = isRecord(raw.retention) ? raw.retention : {};
  const L = NOTIFICATION_SETTING_LIMITS;

  const warningAtOrBelow = integer(sevBy.warningAtOrBelow, L.warningAtOrBelow);
  const criticalAtOrBelow = Math.min(
    warningAtOrBelow,
    integer(sevBy.criticalAtOrBelow, L.criticalAtOrBelow),
  );

  const quietStart = quiet.start;
  const quietEnd = quiet.end;
  const quietTimesValid =
    isValidClockTime(quietStart) && isValidClockTime(quietEnd);
  const quietDayInput = Array.isArray(quiet.days)
    ? [
        ...new Set(
          quiet.days
            .filter(
              (day): day is number =>
                typeof day === "number" && Number.isInteger(day),
            )
            .filter((day) => day >= 0 && day <= 6),
        ),
      ].sort((a, b) => a - b)
    : [];
  // No days selected would never fire; treat it as "every day" like Rust does.
  const quietDays =
    quietDayInput.length > 0 ? quietDayInput : [...d.quietHours.days];

  return {
    version: NOTIFICATION_SETTINGS_VERSION,
    service: {
      enabled: bool(service.enabled, d.service.enabled),
      paused: bool(service.paused, d.service.paused),
      catchUpOnLaunch: bool(service.catchUpOnLaunch, d.service.catchUpOnLaunch),
      recordPollMinutes: integer(
        service.recordPollMinutes,
        L.recordPollMinutes,
      ),
      expiryPollMinutes: integer(
        service.expiryPollMinutes,
        L.expiryPollMinutes,
      ),
      rdapCacheHours: integer(service.rdapCacheHours, L.rdapCacheHours),
      maxZonesPerPass: integer(service.maxZonesPerPass, L.maxZonesPerPass),
      backoffMaxMinutes: integer(
        service.backoffMaxMinutes,
        L.backoffMaxMinutes,
      ),
    },
    kinds: {
      domainExpiry: normalizeKind(kinds.domainExpiry, d.kinds.domainExpiry),
      recordChange: {
        ...normalizeKind(recordChange, d.kinds.recordChange),
        changes: {
          added: bool(changes.added, true),
          changed: bool(changes.changed, true),
          removed: bool(changes.removed, true),
        },
        fields: normalizeChangeFields(recordChange.fields),
      },
      service: normalizeKind(kinds.service, d.kinds.service),
    },
    expiry: {
      milestones: normalizeMilestones(expiry.milestones),
      notifyExpired: bool(expiry.notifyExpired, d.expiry.notifyExpired),
      source: oneOf(expiry.source, ["auto", "rdap", "registrar"], "auto"),
      severityByMilestone: { warningAtOrBelow, criticalAtOrBelow },
    },
    zones: {
      mode: oneOf(zones.mode, ["all", "allowlist"], "all"),
      include: stringList(zones.include),
      exclude: stringList(zones.exclude),
      overrides: normalizeOverrides(zones.overrides, now),
    },
    quietHours: {
      enabled: quietTimesValid && bool(quiet.enabled, d.quietHours.enabled),
      start: quietTimesValid ? quietStart : d.quietHours.start,
      end: quietTimesValid ? quietEnd : d.quietHours.end,
      days: quietDays,
      timezone: isValidTimezone(quiet.timezone) ? quiet.timezone : "local",
      behaviour: oneOf(quiet.behaviour, ["silence", "hold"], "silence"),
    },
    osNotifications: {
      enabled: bool(os.enabled, d.osNotifications.enabled),
      minSeverity: oneOf(
        os.minSeverity,
        NOTIFICATION_SEVERITIES,
        d.osNotifications.minSeverity,
      ),
    },
    inApp: {
      toastMinSeverity: oneOf(
        inApp.toastMinSeverity,
        [...NOTIFICATION_SEVERITIES, "never"],
        d.inApp.toastMinSeverity,
      ),
      badge: bool(inApp.badge, d.inApp.badge),
    },
    retention: {
      autoArchiveReadAfterDays: nullableInteger(
        retention.autoArchiveReadAfterDays,
        L.autoArchiveReadAfterDays,
      ),
      purgeArchivedAfterDays: nullableInteger(
        retention.purgeArchivedAfterDays,
        L.purgeArchivedAfterDays,
      ),
      maxItems: integer(retention.maxItems, L.maxItems),
      keepSnapshots: bool(retention.keepSnapshots, d.retention.keepSnapshots),
    },
  };
}

// ── deep merge / equality ───────────────────────────────────────────────────

/**
 * Deep-merge `partial` over `base`. Objects merge key-by-key; arrays and
 * `zones.overrides` entries are replaced whole (an override is an atomic unit
 * — merging `{ muted: false }` over `{ muted: true, mutedUntil }` must clear
 * the deadline too). `undefined` leaves the base value untouched; `null` is a
 * value (retention "never").
 */
export function mergeNotificationSettings(
  base: NotificationSettings,
  partial: NotificationSettingsInput,
): NotificationSettings {
  return deepMerge(base, partial, "") as NotificationSettings;
}

const REPLACE_WHOLE_PATHS = new Set(["zones.overrides"]);

function deepMerge(base: unknown, partial: unknown, path: string): unknown {
  if (partial === undefined) return base;
  if (!isRecord(base) || !isRecord(partial) || REPLACE_WHOLE_PATHS.has(path)) {
    return partial;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) continue;
    const childPath = path ? `${path}.${key}` : key;
    out[key] = deepMerge(base[key], value, childPath);
  }
  return out;
}

/** Structural equality on normalized settings (key order independent). */
export function settingsEqual(
  a: NotificationSettings,
  b: NotificationSettings,
): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (isRecord(entry)) {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, entry[key]]),
      );
    }
    return entry;
  });
}

// ── behaviour helpers (mirrors of the Rust methods) ─────────────────────────

/** `zones.*` gate only (mute is a delivery concern — see `isZoneMuted`). */
export function isZoneMonitored(
  settings: NotificationSettings,
  zoneId: string,
): boolean {
  const { zones } = settings;
  if (zones.mode === "allowlist") return zones.include.includes(zoneId);
  return !zones.exclude.includes(zoneId);
}

export function isZoneMuted(
  settings: NotificationSettings,
  zoneId: string,
  now: number = Date.now(),
): boolean {
  const override = settings.zones.overrides[zoneId];
  if (!override?.muted) return false;
  if (!override.mutedUntil) return true;
  const until = parseInstant(override.mutedUntil);
  return until === null ? true : until > now;
}

/** Kind enabled globally and not switched off for this zone. */
export function zoneKindEnabled(
  settings: NotificationSettings,
  zoneId: string | null | undefined,
  kind: NotificationKindKey,
): boolean {
  if (!settings.kinds[kind].enabled) return false;
  if (!zoneId) return true;
  if (!isZoneMonitored(settings, zoneId)) return false;
  const override = settings.zones.overrides[zoneId]?.kinds;
  if (kind === "domainExpiry" && override?.domainExpiry === false) return false;
  if (kind === "recordChange" && override?.recordChange === false) return false;
  return true;
}

function minutesOfDay(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** Local wall-clock components of `now` in the configured timezone. */
function localClock(
  now: Date,
  timezone: string,
): { day: number; minutes: number } {
  if (timezone === "local") {
    return {
      day: now.getDay(),
      minutes: now.getHours() * 60 + now.getMinutes(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    day: Math.max(0, days.indexOf(get("weekday"))),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * Whether the quiet-hours window covers `now`. A window that crosses midnight
 * (22:00–07:00) belongs to the day it starts on; `start === end` is a
 * 24-hour window. Mirrors `NotificationSettings::quiet_hours_active`.
 */
export function quietHoursActive(
  settings: NotificationSettings,
  now: Date = new Date(),
): boolean {
  const q = settings.quietHours;
  if (!q.enabled) return false;
  const { day, minutes } = localClock(now, q.timezone);
  const start = minutesOfDay(q.start);
  const end = minutesOfDay(q.end);
  const previousDay = (day + 6) % 7;
  if (start === end) return q.days.includes(day);
  if (start < end) {
    return q.days.includes(day) && minutes >= start && minutes < end;
  }
  // Crosses midnight: tonight's leg belongs to today, this morning's leg to yesterday.
  if (minutes >= start) return q.days.includes(day);
  if (minutes < end) return q.days.includes(previousDay);
  return false;
}

export function severityAtLeast(
  severity: NotificationSeverity,
  min: NotificationSeverity,
): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

/** Severity for a domain-expiry notice at `daysLeft` (negative = expired). */
export function severityForExpiry(
  settings: NotificationSettings,
  daysLeft: number,
): NotificationSeverity {
  const fixed = settings.kinds.domainExpiry.severity;
  if (fixed !== "auto") return fixed;
  const { warningAtOrBelow, criticalAtOrBelow } =
    settings.expiry.severityByMilestone;
  if (daysLeft <= criticalAtOrBelow) return "critical";
  if (daysLeft <= warningAtOrBelow) return "warning";
  return "info";
}

export function severityForChange(
  settings: NotificationSettings,
  change: RecordChangeKind,
): NotificationSeverity {
  const fixed = settings.kinds.recordChange.severity;
  if (fixed !== "auto") return fixed;
  return change === "removed" ? "critical" : "warning";
}

/** Whether a toast should be shown in-app for this severity right now. */
export function toastAllowed(
  settings: NotificationSettings,
  severity: NotificationSeverity,
  now: Date = new Date(),
): boolean {
  const min = settings.inApp.toastMinSeverity;
  if (min === "never") return false;
  if (!severityAtLeast(severity, min)) return false;
  return !quietHoursActive(settings, now);
}

/** Mirror of `os_notify_allowed`: kind toggle, global switch, min severity, quiet hours, zone mute. */
export function osNotifyAllowed(
  settings: NotificationSettings,
  kind: NotificationKindKey,
  severity: NotificationSeverity,
  zoneId: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!settings.osNotifications.enabled) return false;
  if (!settings.kinds[kind].osNotify) return false;
  if (!severityAtLeast(severity, settings.osNotifications.minSeverity))
    return false;
  if (quietHoursActive(settings, now)) return false;
  if (zoneId && isZoneMuted(settings, zoneId, now.getTime())) return false;
  return true;
}
