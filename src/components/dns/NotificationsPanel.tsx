/**
 * The Notifications workspace tab. Two segmented views share the card:
 * the inbox (scope / kind / zone / search filters, items grouped by day) and
 * the settings (see `NotificationsSettings`). Desktop only — the web build
 * renders a short notice, mirroring the audit log.
 */
import { useMemo, useState } from "react";
import { CheckCheck, Archive, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNotifications } from "@/hooks/dns/use-notifications";
import { useI18n } from "@/hooks/use-i18n";
import type {
  NotificationKind,
  NotificationScope,
  NotificationServiceStatus,
} from "@/lib/api/tauri-client";
import {
  filterNotifications,
  groupByDay,
  NOTIFICATION_KINDS,
  NOTIFICATION_SCOPES,
  relativeTime,
  zoneOptions,
} from "@/lib/notifications/notifications-view";

import { NotificationItem } from "./NotificationItem";
import { NotificationsSettings } from "./NotificationsSettings";

export type NotificationsView = "inbox" | "settings";

export interface NotificationsPanelProps {
  onOpenZone: (zoneId: string) => void;
  onRevealRecord: (zoneId: string, recordId: string) => void;
  initialView?: NotificationsView;
  /** Injectable clock for deterministic relative times in tests. */
  now?: Date;
}

function minutesUntil(iso: string | null | undefined, now: Date): number {
  if (!iso) return Number.NaN;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return Number.NaN;
  return Math.max(0, Math.round((ms - now.getTime()) / 60_000));
}

/** "Last checked 3 min ago · 12 zones · Next in 12 min" and friends. */
function describeServiceStatus(
  status: NotificationServiceStatus | null,
  t: (key: string, options: Record<string, unknown>) => string,
  now: Date,
): string {
  if (!status)
    return t("Status unavailable", { defaultValue: "Status unavailable" });
  if (!status.enabled)
    return t("Monitoring disabled", { defaultValue: "Monitoring disabled" });
  if (status.paused)
    return t("Monitoring paused", { defaultValue: "Monitoring paused" });
  const parts: string[] = [];
  const last = status.lastRecordCheckAt ?? status.lastExpiryCheckAt ?? null;
  parts.push(
    last
      ? t("Last checked {{when}}", {
          when: relativeTime(last, now),
          defaultValue: `Last checked ${relativeTime(last, now)}`,
        })
      : t("Not checked yet", { defaultValue: "Not checked yet" }),
  );
  parts.push(
    t("{{count}} zones", {
      count: status.zonesTracked,
      defaultValue: `${status.zonesTracked} zones`,
    }),
  );
  const next = minutesUntil(
    status.nextRecordCheckAt ?? status.nextCheckAt,
    now,
  );
  if (Number.isFinite(next)) {
    parts.push(
      t("Next in {{count}} min", {
        count: next,
        defaultValue: `Next in ${next} min`,
      }),
    );
  }
  if (status.backoffUntil) {
    parts.push(
      t("Backing off until {{when}}", {
        when: status.backoffUntil,
        defaultValue: `Backing off until ${status.backoffUntil}`,
      }),
    );
  }
  if (status.lastError) {
    parts.push(
      t("Last error: {{error}}", {
        error: status.lastError,
        defaultValue: `Last error: ${status.lastError}`,
      }),
    );
  }
  return parts.join(" · ");
}

export function NotificationsPanel({
  onOpenZone,
  onRevealRecord,
  initialView = "inbox",
  now,
}: NotificationsPanelProps) {
  const { t } = useI18n();
  const [view, setView] = useState<NotificationsView>(initialView);
  const [scope, setScope] = useState<NotificationScope>("all");
  const [kind, setKind] = useState<NotificationKind | "all">("all");
  const [zoneId, setZoneId] = useState<string>("all");
  const [search, setSearch] = useState("");

  const inbox = useNotifications({ query: { scope } });
  const clock = now ?? new Date();

  const zones = useMemo(() => zoneOptions(inbox.items), [inbox.items]);
  const filtered = useMemo(
    () =>
      filterNotifications(inbox.items, {
        scope,
        kind,
        zoneId,
        search,
      }),
    [inbox.items, scope, kind, zoneId, search],
  );
  const groups = useMemo(
    () => groupByDay(filtered, clock),
    // The clock only matters for labels; keep groups stable between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered],
  );

  if (!inbox.available) {
    return (
      <Card className="border-border/60 bg-card/70">
        <CardHeader>
          <CardTitle className="text-lg">
            {t("Notifications", "Notifications")}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {t(
            "Notifications are only available in the desktop app.",
            "Notifications are only available in the desktop app.",
          )}
        </CardContent>
      </Card>
    );
  }

  const hasFilters = kind !== "all" || zoneId !== "all" || search.trim() !== "";
  const emptyText = hasFilters
    ? t(
        "No notifications match the current filters.",
        "No notifications match the current filters.",
      )
    : scope === "unread"
      ? t("You're all caught up.", "You're all caught up.")
      : scope === "archived"
        ? t("Nothing has been archived.", "Nothing has been archived.")
        : t(
            "No notifications yet. Domain expiry milestones and record changes made outside this app will show up here.",
            "No notifications yet. Domain expiry milestones and record changes made outside this app will show up here.",
          );

  return (
    <Card
      className="border-border/60 bg-card/70"
      data-testid="notifications-panel"
    >
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-lg">
              {t("Notifications", "Notifications")}
            </CardTitle>
            <CardDescription
              data-testid="notifications-status-line"
              className="mt-1"
            >
              {describeServiceStatus(inbox.status, t, clock)}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={inbox.loading}
              onClick={() => void inbox.checkNow("all")}
            >
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Check now", "Check now")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={inbox.unread === 0}
              onClick={() => void inbox.markAllRead()}
            >
              <CheckCheck aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Mark all read", "Mark all read")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => void inbox.archiveAllRead()}
            >
              <Archive aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Archive all read", "Archive all read")}
            </Button>
          </div>
        </div>
        <div
          role="toolbar"
          aria-label={t("Notification views", "Notification views")}
          className="glass-surface glass-sheen glass-fade ui-segment-group scrollbar-themed"
        >
          <button
            type="button"
            className="ui-segment"
            data-active={view === "inbox"}
            aria-pressed={view === "inbox"}
            onClick={() => setView("inbox")}
          >
            {t("Inbox", "Inbox")}
            {inbox.unread > 0 ? (
              <span className="ml-1 text-muted-foreground">
                ({inbox.unread})
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className="ui-segment"
            data-active={view === "settings"}
            aria-pressed={view === "settings"}
            onClick={() => setView("settings")}
          >
            {t("Settings", "Settings")}
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {inbox.error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {inbox.error}
          </p>
        ) : null}
        {view === "settings" ? (
          <NotificationsSettings
            status={inbox.status}
            onCheckNow={inbox.checkNow}
            onPause={inbox.pause}
            onResume={inbox.resume}
            onOpenZone={onOpenZone}
          />
        ) : (
          <div className="space-y-4" data-testid="notifications-inbox">
            <div className="flex flex-wrap items-center gap-2">
              <div
                role="toolbar"
                aria-label={t("Notification scope", "Notification scope")}
                className="glass-surface glass-sheen glass-fade ui-segment-group scrollbar-themed"
              >
                {NOTIFICATION_SCOPES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="ui-segment"
                    data-active={scope === option.value}
                    aria-pressed={scope === option.value}
                    onClick={() => setScope(option.value)}
                  >
                    {t(option.label, option.label)}
                  </button>
                ))}
              </div>
              <Label className="sr-only" htmlFor="notifications-kind-filter">
                {t("Filter by kind", "Filter by kind")}
              </Label>
              <Select
                value={kind}
                onValueChange={(value) =>
                  setKind(value as NotificationKind | "all")
                }
              >
                <SelectTrigger
                  id="notifications-kind-filter"
                  aria-label={t("Filter by kind", "Filter by kind")}
                  className="h-8 w-44 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t("All kinds", "All kinds")}
                  </SelectItem>
                  {NOTIFICATION_KINDS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.label, option.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label className="sr-only" htmlFor="notifications-zone-filter">
                {t("Filter by zone", "Filter by zone")}
              </Label>
              <Select value={zoneId} onValueChange={setZoneId}>
                <SelectTrigger
                  id="notifications-zone-filter"
                  aria-label={t("Filter by zone", "Filter by zone")}
                  className="h-8 w-48 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t("All zones", "All zones")}
                  </SelectItem>
                  {zones.map((zone) => (
                    <SelectItem key={zone.zoneId} value={zone.zoneId}>
                      {zone.zoneName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="relative min-w-[12rem] flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Label className="sr-only" htmlFor="notifications-search">
                  {t("Search notifications", "Search notifications")}
                </Label>
                <Input
                  id="notifications-search"
                  type="search"
                  value={search}
                  placeholder={t("Search…", "Search…")}
                  className="h-8 pl-7 text-xs"
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>

            {groups.length === 0 ? (
              <p
                data-testid="notifications-empty"
                className="rounded-md border border-dashed border-border/60 px-4 py-8 text-center text-sm text-muted-foreground"
              >
                {inbox.loading ? t("Loading…", "Loading…") : emptyText}
              </p>
            ) : (
              <div className="space-y-4">
                {groups.map((group) => (
                  <section
                    key={group.key}
                    aria-labelledby={`ntf-day-${group.key}`}
                  >
                    <h3
                      id={`ntf-day-${group.key}`}
                      className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {t(group.label, group.label)}
                    </h3>
                    <ul role="list" className="space-y-2">
                      {group.items.map((item) => (
                        <li key={item.id}>
                          <NotificationItem
                            item={item}
                            now={clock}
                            onMarkRead={(id, read) =>
                              void inbox.markRead([id], read)
                            }
                            onArchive={(id) => void inbox.archive([id])}
                            onUnarchive={(id) => void inbox.unarchive([id])}
                            onDismiss={(id) => void inbox.dismiss([id])}
                            onOpenZone={onOpenZone}
                            onRevealRecord={onRevealRecord}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            {scope === "archived" && filtered.length > 0 ? (
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground"
                  onClick={() => void inbox.clearArchived()}
                >
                  {t("Clear archived", "Clear archived")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
