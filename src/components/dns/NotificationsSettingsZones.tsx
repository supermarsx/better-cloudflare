/**
 * "Zones" sub-section: monitoring mode, bulk monitor all / none and a table
 * built from `notifications_zone_summary` with per-zone switches for
 * monitoring, kinds and mute (with quick "until" picks).
 *
 * `zones.overrides` is replaced as a whole map by the settings hook, so every
 * per-zone write sends the complete map with one entry changed.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/hooks/use-i18n";
import {
  TauriClient,
  type NotificationZoneSummary,
} from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import {
  isZoneMonitored,
  type NotificationSettings,
  type NotificationSettingsInput,
  type ZoneMonitorMode,
  type ZoneOverride,
} from "@/lib/notifications/notification-settings";
import { fullTimestamp } from "@/lib/notifications/notifications-view";

import { SettingRow, SettingsSection } from "./NotificationsSettingsControls";

export interface NotificationsSettingsZonesProps {
  settings: NotificationSettings;
  update: (partial: NotificationSettingsInput) => NotificationSettings;
  onOpenZone?: (zoneId: string) => void;
  /** Injectable clock for the mute quick picks (tests). */
  now?: () => number;
}

const MUTE_QUICK_PICKS: readonly { hours: number; label: string }[] = [
  { hours: 1, label: "1 h" },
  { hours: 8, label: "8 h" },
  { hours: 24, label: "24 h" },
  { hours: 24 * 7, label: "7 d" },
];

function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function withOverride(
  overrides: Record<string, ZoneOverride>,
  zoneId: string,
  next: ZoneOverride | null,
): Record<string, ZoneOverride> {
  const out = { ...overrides };
  if (next === null) delete out[zoneId];
  else out[zoneId] = next;
  return out;
}

export function NotificationsSettingsZones({
  settings,
  update,
  onOpenZone,
  now,
}: NotificationsSettingsZonesProps) {
  const { t } = useI18n();
  const clock = now ?? (() => Date.now());
  const [rows, setRows] = useState<NotificationZoneSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (!isDesktop()) return;
    setLoading(true);
    try {
      setRows(await TauriClient.notificationsZoneSummary());
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const zones = settings.zones;
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const sorted = [...rows].sort((a, b) =>
      a.zoneName.localeCompare(b.zoneName),
    );
    return needle
      ? sorted.filter(
          (row) =>
            row.zoneName.toLowerCase().includes(needle) ||
            row.zoneId.toLowerCase().includes(needle),
        )
      : sorted;
  }, [rows, search]);

  const setMonitored = (zoneId: string, monitored: boolean) => {
    if (zones.mode === "allowlist") {
      const include = zones.include.filter((id) => id !== zoneId);
      update({
        zones: { include: monitored ? [...include, zoneId] : include },
      });
      return;
    }
    const exclude = zones.exclude.filter((id) => id !== zoneId);
    update({ zones: { exclude: monitored ? exclude : [...exclude, zoneId] } });
  };

  const setAll = (monitored: boolean) => {
    const ids = rows.map((row) => row.zoneId);
    if (zones.mode === "allowlist") {
      update({ zones: { include: monitored ? ids : [] } });
    } else {
      update({ zones: { exclude: monitored ? [] : ids } });
    }
  };

  const setKind = (
    zoneId: string,
    kind: "domainExpiry" | "recordChange",
    enabled: boolean,
  ) => {
    const current = zones.overrides[zoneId] ?? { muted: false };
    const kinds = { ...(current.kinds ?? {}) };
    if (enabled) delete kinds[kind];
    else kinds[kind] = false;
    const next: ZoneOverride = { ...current };
    if (Object.keys(kinds).length > 0) next.kinds = kinds;
    else delete next.kinds;
    update({
      zones: { overrides: withOverride(zones.overrides, zoneId, next) },
    });
  };

  const setMute = (zoneId: string, muted: boolean, until?: string) => {
    const current = zones.overrides[zoneId] ?? { muted: false };
    const next: ZoneOverride = { ...current, muted };
    if (muted && until) next.mutedUntil = until;
    else delete next.mutedUntil;
    update({
      zones: { overrides: withOverride(zones.overrides, zoneId, next) },
    });
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("Zone selection", "Zone selection")}
        testId="notifications-settings-zones"
      >
        <SettingRow
          htmlFor="ntf-zone-mode"
          label={t("Mode", "Mode")}
          description={
            zones.mode === "allowlist"
              ? t(
                  "Only zones switched on below are monitored.",
                  "Only zones switched on below are monitored.",
                )
              : t(
                  "Every zone is monitored unless switched off below.",
                  "Every zone is monitored unless switched off below.",
                )
          }
        >
          <Select
            value={zones.mode}
            onValueChange={(value) =>
              update({ zones: { mode: value as ZoneMonitorMode } })
            }
          >
            <SelectTrigger
              id="ntf-zone-mode"
              aria-label={t("Zone monitoring mode", "Zone monitoring mode")}
              className="h-8 w-44 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("All zones", "All zones")}</SelectItem>
              <SelectItem value="allowlist">
                {t("Only selected", "Only selected")}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAll(true)}
          >
            {t("Monitor all", "Monitor all")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAll(false)}
          >
            {t("Monitor none", "Monitor none")}
          </Button>
        </SettingRow>
        <div className="flex flex-wrap items-center gap-2 py-3">
          <Label htmlFor="ntf-zone-search" className="sr-only">
            {t("Search zones", "Search zones")}
          </Label>
          <Input
            id="ntf-zone-search"
            type="search"
            value={search}
            placeholder={t("Search zones…", "Search zones…")}
            className="h-8 w-64 text-xs"
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1 text-xs"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Refresh", "Refresh")}
          </Button>
          {error ? (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          ) : null}
        </div>
        <div className="scrollbar-themed overflow-x-auto pb-2">
          <table className="w-full min-w-[56rem] text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">{t("Zone", "Zone")}</th>
                <th className="py-1 pr-3 font-medium">
                  {t("Monitored", "Monitored")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("Expiry", "Expiry")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("Record changes", "Record changes")}
                </th>
                <th className="py-1 pr-3 font-medium">{t("Mute", "Mute")}</th>
                <th className="py-1 pr-3 font-medium">
                  {t("Last checked", "Last checked")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("Snapshot", "Snapshot")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("Last error", "Last error")}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="py-4 text-center text-muted-foreground"
                  >
                    {loading
                      ? t("Loading…", "Loading…")
                      : t("No zones.", "No zones.")}
                  </td>
                </tr>
              ) : null}
              {visible.map((row) => {
                const monitored = isZoneMonitored(settings, row.zoneId);
                const override = zones.overrides[row.zoneId];
                const muted = override?.muted ?? false;
                const expiryOn = override?.kinds?.domainExpiry !== false;
                const changesOn = override?.kinds?.recordChange !== false;
                const name = row.zoneName;
                return (
                  <tr
                    key={row.zoneId}
                    data-testid="notification-zone-row"
                    data-zone-id={row.zoneId}
                    className="border-t border-border/40 align-top"
                  >
                    <td className="py-2 pr-3">
                      {onOpenZone ? (
                        <button
                          type="button"
                          className="font-medium text-foreground underline-offset-2 hover:underline"
                          onClick={() => onOpenZone(row.zoneId)}
                        >
                          {name}
                        </button>
                      ) : (
                        <span className="font-medium">{name}</span>
                      )}
                      {row.expiresAt ? (
                        <div className="text-[11px] text-muted-foreground">
                          {row.daysLeft !== null && row.daysLeft !== undefined
                            ? t("Expires in {{count}} d ({{date}})", {
                                count: row.daysLeft,
                                date: row.expiresAt.slice(0, 10),
                                defaultValue: `Expires in ${row.daysLeft} d (${row.expiresAt.slice(0, 10)})`,
                              })
                            : row.expiresAt.slice(0, 10)}
                          {row.expirySource ? ` · ${row.expirySource}` : ""}
                        </div>
                      ) : (
                        <div className="text-[11px] text-muted-foreground">
                          {t("Expiry unknown", "Expiry unknown")}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Switch
                        size="xs"
                        checked={monitored}
                        aria-label={t("Monitor {{zone}}", {
                          zone: name,
                          defaultValue: `Monitor ${name}`,
                        })}
                        onCheckedChange={(checked) =>
                          setMonitored(row.zoneId, checked)
                        }
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <Switch
                        size="xs"
                        checked={expiryOn}
                        disabled={!monitored}
                        aria-label={t("Expiry notices for {{zone}}", {
                          zone: name,
                          defaultValue: `Expiry notices for ${name}`,
                        })}
                        onCheckedChange={(checked) =>
                          setKind(row.zoneId, "domainExpiry", checked)
                        }
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <Switch
                        size="xs"
                        checked={changesOn}
                        disabled={!monitored}
                        aria-label={t("Record change notices for {{zone}}", {
                          zone: name,
                          defaultValue: `Record change notices for ${name}`,
                        })}
                        onCheckedChange={(checked) =>
                          setKind(row.zoneId, "recordChange", checked)
                        }
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap items-center gap-1">
                        <Switch
                          size="xs"
                          checked={muted}
                          aria-label={t("Mute {{zone}}", {
                            zone: name,
                            defaultValue: `Mute ${name}`,
                          })}
                          onCheckedChange={(checked) =>
                            setMute(row.zoneId, checked)
                          }
                        />
                        {MUTE_QUICK_PICKS.map((pick) => (
                          <Button
                            key={pick.hours}
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-[11px]"
                            aria-label={t("Mute {{zone}} for {{duration}}", {
                              zone: name,
                              duration: pick.label,
                              defaultValue: `Mute ${name} for ${pick.label}`,
                            })}
                            onClick={() =>
                              setMute(
                                row.zoneId,
                                true,
                                new Date(
                                  clock() + pick.hours * 3_600_000,
                                ).toISOString(),
                              )
                            }
                          >
                            {pick.label}
                          </Button>
                        ))}
                      </div>
                      <div className="mt-1 flex items-center gap-1">
                        <Label
                          htmlFor={`ntf-mute-until-${row.zoneId}`}
                          className="text-[11px] text-muted-foreground"
                        >
                          {t("Until", "Until")}
                        </Label>
                        <Input
                          id={`ntf-mute-until-${row.zoneId}`}
                          type="datetime-local"
                          className="h-7 w-44 text-[11px]"
                          value={toDateTimeLocal(override?.mutedUntil)}
                          disabled={!muted}
                          onChange={(event) => {
                            const value = event.target.value;
                            const ms = value ? Date.parse(value) : Number.NaN;
                            setMute(
                              row.zoneId,
                              true,
                              Number.isFinite(ms)
                                ? new Date(ms).toISOString()
                                : undefined,
                            );
                          }}
                        />
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {row.lastCheckedAt
                        ? fullTimestamp(row.lastCheckedAt)
                        : "—"}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {row.snapshotRecords !== null &&
                      row.snapshotRecords !== undefined
                        ? t("{{count}} records", {
                            count: row.snapshotRecords,
                            defaultValue: `${row.snapshotRecords} records`,
                          })
                        : "—"}
                    </td>
                    <td className="max-w-[16rem] break-words py-2 pr-3 text-destructive">
                      {row.lastError ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SettingsSection>
    </div>
  );
}
