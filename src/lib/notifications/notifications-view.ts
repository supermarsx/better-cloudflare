/**
 * Pure view helpers for the Notifications tab: grouping, filtering and
 * human-readable labels. No IPC, no React — consumed by `NotificationsPanel`
 * and unit-tested in `test/notificationsView.test.ts`.
 */

import type {
  AppNotification,
  DomainExpiryPayload,
  NotificationKind,
  NotificationScope,
  NotificationSeverityLevel,
  RecordChangePayload,
  RecordChangeSnapshot,
} from "@/lib/api/tauri-client";

export {
  clampNotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
} from "@/lib/notifications/notification-settings";

export const NOTIFICATION_KINDS: readonly {
  value: NotificationKind;
  label: string;
}[] = [
  { value: "domain_expiry", label: "Domain expiry" },
  { value: "record_change", label: "Record changes" },
  { value: "service", label: "Service" },
];

export const NOTIFICATION_SCOPES: readonly {
  value: NotificationScope;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "archived", label: "Archived" },
];

const KIND_LABELS: Record<NotificationKind, string> = {
  domain_expiry: "Domain expiry",
  record_change: "Record change",
  service: "Service",
};

const SEVERITY_LABELS: Record<NotificationSeverityLevel, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

export function kindLabel(kind: NotificationKind | string): string {
  return KIND_LABELS[kind as NotificationKind] ?? "Notification";
}

export function severityLabel(
  severity: NotificationSeverityLevel | string,
): string {
  return SEVERITY_LABELS[severity as NotificationSeverityLevel] ?? "Info";
}

export function isRecordChangePayload(
  payload: unknown,
): payload is RecordChangePayload {
  return (
    !!payload &&
    typeof payload === "object" &&
    typeof (payload as RecordChangePayload).change === "string" &&
    typeof (payload as RecordChangePayload).recordId === "string"
  );
}

export function isDomainExpiryPayload(
  payload: unknown,
): payload is DomainExpiryPayload {
  return (
    !!payload &&
    typeof payload === "object" &&
    typeof (payload as DomainExpiryPayload).domain === "string" &&
    typeof (payload as DomainExpiryPayload).daysLeft === "number"
  );
}

// ── filtering ───────────────────────────────────────────────────────────────

export interface NotificationFilter {
  scope?: NotificationScope;
  /** Kind or `"all"`/`undefined` for every kind. */
  kind?: NotificationKind | "all";
  /** Zone id or `"all"`/`undefined` for every zone. */
  zoneId?: string | "all";
  search?: string;
}

export function isUnread(item: AppNotification): boolean {
  return !item.readAt && !item.archivedAt;
}

export function matchesScope(
  item: AppNotification,
  scope: NotificationScope = "all",
): boolean {
  if (scope === "archived") return !!item.archivedAt;
  if (scope === "unread") return isUnread(item);
  return !item.archivedAt;
}

function searchableText(item: AppNotification): string {
  const parts = [
    item.title,
    item.body,
    item.zoneName ?? "",
    kindLabel(item.kind),
  ];
  const payload = item.payload;
  if (isRecordChangePayload(payload)) {
    parts.push(payload.recordName, payload.recordType, payload.recordId);
    for (const snap of [payload.before, payload.after]) {
      if (snap?.content) parts.push(snap.content);
      if (snap?.comment) parts.push(snap.comment);
    }
  } else if (isDomainExpiryPayload(payload)) {
    parts.push(payload.domain, payload.expiresAt);
  }
  return parts.join("\n").toLowerCase();
}

/** Client-side filter over an already loaded inbox (the Rust list applies scope/kind/zone too). */
export function filterNotifications(
  items: readonly AppNotification[],
  filter: NotificationFilter = {},
): AppNotification[] {
  const search = filter.search?.trim().toLowerCase() ?? "";
  return items.filter((item) => {
    if (!matchesScope(item, filter.scope)) return false;
    if (filter.kind && filter.kind !== "all" && item.kind !== filter.kind)
      return false;
    if (
      filter.zoneId &&
      filter.zoneId !== "all" &&
      item.zoneId !== filter.zoneId
    )
      return false;
    if (search && !searchableText(item).includes(search)) return false;
    return true;
  });
}

// ── grouping ────────────────────────────────────────────────────────────────

export interface NotificationDayGroup {
  /** Stable key (`YYYY-MM-DD` in local time). */
  key: string;
  label: string;
  items: AppNotification[];
}

function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function startOfLocalDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

const DAY_MS = 86_400_000;

export function dayLabel(
  date: Date,
  now: Date = new Date(),
  locale?: string,
): string {
  const diffDays = Math.round(
    (startOfLocalDay(now) - startOfLocalDay(date)) / DAY_MS,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, {
    weekday: diffDays > 0 && diffDays < 7 ? "long" : undefined,
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(date);
}

/** Newest first; items with an unparsable `createdAt` land in an "Unknown date" group last. */
export function groupByDay(
  items: readonly AppNotification[],
  now: Date = new Date(),
  locale?: string,
): NotificationDayGroup[] {
  const sorted = [...items].sort(
    (a, b) => parseTime(b.createdAt) - parseTime(a.createdAt),
  );
  const groups = new Map<string, NotificationDayGroup>();
  for (const item of sorted) {
    const ms = parseTime(item.createdAt);
    const key = Number.isFinite(ms) ? localDayKey(new Date(ms)) : "unknown";
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: Number.isFinite(ms)
          ? dayLabel(new Date(ms), now, locale)
          : "Unknown date",
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

function parseTime(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

// ── text helpers ────────────────────────────────────────────────────────────

const SNAPSHOT_FIELDS: readonly (keyof RecordChangeSnapshot)[] = [
  "content",
  "ttl",
  "proxied",
  "priority",
  "comment",
];

function formatFieldValue(
  field: keyof RecordChangeSnapshot,
  value: unknown,
): string {
  if (value === undefined || value === null || value === "") return "—";
  if (field === "proxied") return value ? "proxied" : "DNS only";
  if (field === "ttl") return value === 1 ? "auto TTL" : `TTL ${String(value)}`;
  return String(value);
}

/** Field-level differences between the two snapshots, in canonical field order. */
export function changedFields(
  before: RecordChangeSnapshot | undefined,
  after: RecordChangeSnapshot | undefined,
): { field: keyof RecordChangeSnapshot; before: string; after: string }[] {
  const out: {
    field: keyof RecordChangeSnapshot;
    before: string;
    after: string;
  }[] = [];
  for (const field of SNAPSHOT_FIELDS) {
    const prev = before?.[field];
    const next = after?.[field];
    if ((prev ?? null) === (next ?? null)) continue;
    out.push({
      field,
      before: formatFieldValue(field, prev),
      after: formatFieldValue(field, next),
    });
  }
  return out;
}

/** Short human text, e.g. `A app.example.com: 203.0.113.20 → 203.0.113.99`. */
export function describeChange(payload: unknown): string {
  if (!isRecordChangePayload(payload)) return "";
  const subject = `${payload.recordType} ${payload.recordName}`;
  if (payload.change === "added") {
    const content = payload.after?.content;
    return content ? `${subject} added: ${content}` : `${subject} added`;
  }
  if (payload.change === "removed") {
    const content = payload.before?.content;
    return content
      ? `${subject} removed (was ${content})`
      : `${subject} removed`;
  }
  const diffs = changedFields(payload.before, payload.after);
  if (diffs.length === 0) return `${subject} changed`;
  const summary = diffs
    .map((diff) =>
      diff.field === "content"
        ? `${diff.before} → ${diff.after}`
        : `${diff.field}: ${diff.before} → ${diff.after}`,
    )
    .join(", ");
  return `${subject}: ${summary}`;
}

/** e.g. `example.com expires in 7 days (2026-09-01)` / `expired 2 days ago`. */
export function describeExpiry(payload: unknown): string {
  if (!isDomainExpiryPayload(payload)) return "";
  const date = payload.expiresAt.slice(0, 10);
  const days = payload.daysLeft;
  if (days < 0) {
    const ago = Math.abs(days);
    return `${payload.domain} expired ${ago} day${ago === 1 ? "" : "s"} ago (${date})`;
  }
  if (days === 0) return `${payload.domain} expires today (${date})`;
  return `${payload.domain} expires in ${days} day${days === 1 ? "" : "s"} (${date})`;
}

/** "just now", "3 min ago", "2 h ago", "5 d ago"; falls back to the date for older items. */
export function relativeTime(
  value: string,
  now: Date = new Date(),
  locale?: string,
): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const diff = Math.max(0, now.getTime() - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year:
      new Date(ms).getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(new Date(ms));
}

/** `date.toLocaleString` guarded against unparsable input, for `title` attributes. */
export function fullTimestamp(value: string, locale?: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

export function countUnread(items: readonly AppNotification[]): number {
  return items.reduce((count, item) => count + (isUnread(item) ? 1 : 0), 0);
}

/** Distinct zones present in the inbox, for the zone `Select`. */
export function zoneOptions(
  items: readonly AppNotification[],
): { zoneId: string; zoneName: string }[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (!item.zoneId || seen.has(item.zoneId)) continue;
    seen.set(item.zoneId, item.zoneName ?? item.zoneId);
  }
  return [...seen.entries()]
    .map(([zoneId, zoneName]) => ({ zoneId, zoneName }))
    .sort((a, b) => a.zoneName.localeCompare(b.zoneName));
}
