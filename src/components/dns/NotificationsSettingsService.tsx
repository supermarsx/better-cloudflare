/**
 * "Service" sub-section: master switch, pause/resume, run-now, intervals,
 * limits, a status block and the "reset monitoring state" danger rows.
 */
import { useState } from "react";
import { ChevronDown, Pause, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/hooks/use-i18n";
import {
  TauriClient,
  type NotificationCheckKind,
  type NotificationResetRequest,
  type NotificationServiceStatus,
} from "@/lib/api/tauri-client";
import {
  NOTIFICATION_SETTING_LIMITS,
  type NotificationSettings,
  type NotificationSettingsInput,
} from "@/lib/notifications/notification-settings";
import { fullTimestamp } from "@/lib/notifications/notifications-view";

import {
  ConfirmDialog,
  NumberField,
  SettingRow,
  SettingsSection,
  SwitchRow,
} from "./NotificationsSettingsControls";

export interface NotificationsSettingsServiceProps {
  settings: NotificationSettings;
  update: (partial: NotificationSettingsInput) => NotificationSettings;
  status: NotificationServiceStatus | null;
  onCheckNow: (kind?: NotificationCheckKind) => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  /** Pause/resume are persisted by Rust; re-read the settings afterwards. */
  onServiceStateChanged?: () => Promise<void>;
}

const POLL_PRESETS = [5, 10, 15, 30, 60, 180, 360, 1440] as const;

type ResetTarget = keyof NotificationResetRequest;

function fmt(value: string | null | undefined, fallback: string): string {
  return value ? fullTimestamp(value) : fallback;
}

export function NotificationsSettingsService({
  settings,
  update,
  status,
  onCheckNow,
  onPause,
  onResume,
  onServiceStateChanged,
}: NotificationsSettingsServiceProps) {
  const { t } = useI18n();
  const L = NOTIFICATION_SETTING_LIMITS;
  const service = settings.service;
  const paused = status?.paused ?? service.paused;
  const [resetTarget, setResetTarget] = useState<ResetTarget | null>(null);
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  const pollValue = service.recordPollMinutes;
  const presetValue = (POLL_PRESETS as readonly number[]).includes(pollValue)
    ? String(pollValue)
    : "custom";

  const togglePause = async () => {
    if (paused) await onResume();
    else await onPause();
    await onServiceStateChanged?.();
  };

  const runReset = async (target: ResetTarget) => {
    setResetTarget(null);
    try {
      await TauriClient.notificationsResetState({ [target]: true });
      setResetNotice(
        target === "expiryLedger"
          ? t(
              "Expiry milestone ledger cleared.",
              "Expiry milestone ledger cleared.",
            )
          : target === "snapshots"
            ? t(
                "Record snapshots deleted; the next pass takes a fresh baseline.",
                "Record snapshots deleted; the next pass takes a fresh baseline.",
              )
            : t("Inbox cleared.", "Inbox cleared."),
      );
    } catch (error) {
      setResetNotice(
        t("Reset failed: {{error}}", {
          error: error instanceof Error ? error.message : String(error),
          defaultValue: `Reset failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    }
  };

  const none = t("never", "never");
  const stateLabel = !service.enabled
    ? t("Disabled", "Disabled")
    : paused
      ? t("Paused", "Paused")
      : status?.running
        ? t("Running", "Running")
        : t("Idle", "Idle");

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("Background service", "Background service")}
        description={t(
          "Polls your zones while the app is open. Nothing runs while it is closed; a catch-up pass can run at launch.",
          "Polls your zones while the app is open. Nothing runs while it is closed; a catch-up pass can run at launch.",
        )}
        testId="notifications-settings-service"
      >
        <SwitchRow
          id="ntf-service-enabled"
          label={t("Enable monitoring", "Enable monitoring")}
          description={t(
            "Off keeps the service idle with no network traffic.",
            "Off keeps the service idle with no network traffic.",
          )}
          checked={service.enabled}
          onCheckedChange={(enabled) => update({ service: { enabled } })}
        />
        <SettingRow
          label={t("Pause", "Pause")}
          description={t(
            "Pause keeps every setting and simply stops the timers.",
            "Pause keeps every setting and simply stops the timers.",
          )}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={!service.enabled}
            onClick={() => void togglePause()}
          >
            {paused ? (
              <Play aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <Pause aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {paused ? t("Resume", "Resume") : t("Pause", "Pause")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
              >
                {t("Run now", "Run now")}
                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void onCheckNow("records")}>
                {t("Records", "Records")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void onCheckNow("expiry")}>
                {t("Expiry", "Expiry")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void onCheckNow("all")}>
                {t("Both", "Both")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingRow>
        <SwitchRow
          id="ntf-service-catchup"
          label={t("Catch up on launch", "Catch up on launch")}
          description={t(
            "Run a pass right after login instead of waiting one interval.",
            "Run a pass right after login instead of waiting one interval.",
          )}
          checked={service.catchUpOnLaunch}
          onCheckedChange={(catchUpOnLaunch) =>
            update({ service: { catchUpOnLaunch } })
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t("Intervals and limits", "Intervals and limits")}
        testId="notifications-settings-intervals"
      >
        <SettingRow
          htmlFor="ntf-poll-preset"
          label={t("Record poll interval", "Record poll interval")}
          description={t(
            "How often every monitored zone is compared with its last snapshot.",
            "How often every monitored zone is compared with its last snapshot.",
          )}
        >
          <Select
            value={presetValue}
            onValueChange={(value) => {
              if (value === "custom") return;
              update({ service: { recordPollMinutes: Number(value) } });
            }}
          >
            <SelectTrigger
              id="ntf-poll-preset"
              aria-label={t(
                "Record poll interval preset",
                "Record poll interval preset",
              )}
              className="h-8 w-36 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POLL_PRESETS.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {minutes >= 60
                    ? t("{{count}} h", {
                        count: minutes / 60,
                        defaultValue: `${minutes / 60} h`,
                      })
                    : t("{{count}} min", {
                        count: minutes,
                        defaultValue: `${minutes} min`,
                      })}
                </SelectItem>
              ))}
              {presetValue === "custom" ? (
                <SelectItem value="custom">
                  {t("Custom ({{count}} min)", {
                    count: pollValue,
                    defaultValue: `Custom (${pollValue} min)`,
                  })}
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </SettingRow>
        <NumberField
          id="ntf-poll-minutes"
          label={t(
            "Record poll interval (minutes)",
            "Record poll interval (minutes)",
          )}
          value={pollValue}
          min={L.recordPollMinutes.min}
          max={L.recordPollMinutes.max}
          unit={t("min", "min")}
          onCommit={(recordPollMinutes) =>
            update({ service: { recordPollMinutes } })
          }
        />
        <NumberField
          id="ntf-expiry-minutes"
          label={t("Expiry refresh interval", "Expiry refresh interval")}
          description={t(
            "How often registrar / RDAP expiry dates are refreshed (60 min to 7 days). Milestones are evaluated every record pass from the cached date.",
            "How often registrar / RDAP expiry dates are refreshed (60 min to 7 days). Milestones are evaluated every record pass from the cached date.",
          )}
          value={service.expiryPollMinutes}
          min={L.expiryPollMinutes.min}
          max={L.expiryPollMinutes.max}
          unit={t("min", "min")}
          onCommit={(expiryPollMinutes) =>
            update({ service: { expiryPollMinutes } })
          }
        />
        <NumberField
          id="ntf-rdap-hours"
          label={t("RDAP cache", "RDAP cache")}
          description={t(
            "Hours an RDAP answer is reused before asking again.",
            "Hours an RDAP answer is reused before asking again.",
          )}
          value={service.rdapCacheHours}
          min={L.rdapCacheHours.min}
          max={L.rdapCacheHours.max}
          unit={t("h", "h")}
          onCommit={(rdapCacheHours) => update({ service: { rdapCacheHours } })}
        />
        <NumberField
          id="ntf-max-zones"
          label={t("Max zones per pass", "Max zones per pass")}
          description={t(
            "Larger accounts are covered round-robin over consecutive passes.",
            "Larger accounts are covered round-robin over consecutive passes.",
          )}
          value={service.maxZonesPerPass}
          min={L.maxZonesPerPass.min}
          max={L.maxZonesPerPass.max}
          onCommit={(maxZonesPerPass) =>
            update({ service: { maxZonesPerPass } })
          }
        />
        <NumberField
          id="ntf-backoff"
          label={t("Max backoff", "Max backoff")}
          description={t(
            "Upper bound for the doubling delay after rate limits or server errors.",
            "Upper bound for the doubling delay after rate limits or server errors.",
          )}
          value={service.backoffMaxMinutes}
          min={L.backoffMaxMinutes.min}
          max={L.backoffMaxMinutes.max}
          unit={t("min", "min")}
          onCommit={(backoffMaxMinutes) =>
            update({ service: { backoffMaxMinutes } })
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t("Status", "Status")}
        testId="notifications-settings-status"
      >
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 py-2 text-xs sm:grid-cols-2">
          <dt className="text-muted-foreground">{t("State", "State")}</dt>
          <dd data-testid="notifications-service-state">{stateLabel}</dd>
          <dt className="text-muted-foreground">
            {t("Zones tracked", "Zones tracked")}
          </dt>
          <dd>{status?.zonesTracked ?? "—"}</dd>
          <dt className="text-muted-foreground">
            {t("Last record check", "Last record check")}
          </dt>
          <dd>{fmt(status?.lastRecordCheckAt, none)}</dd>
          <dt className="text-muted-foreground">
            {t("Next record check", "Next record check")}
          </dt>
          <dd>{fmt(status?.nextRecordCheckAt ?? status?.nextCheckAt, "—")}</dd>
          <dt className="text-muted-foreground">
            {t("Last expiry check", "Last expiry check")}
          </dt>
          <dd>{fmt(status?.lastExpiryCheckAt, none)}</dd>
          <dt className="text-muted-foreground">
            {t("Next expiry check", "Next expiry check")}
          </dt>
          <dd>{fmt(status?.nextExpiryCheckAt, "—")}</dd>
          <dt className="text-muted-foreground">
            {t("Quiet hours", "Quiet hours")}
          </dt>
          <dd>
            {status?.quietHoursActive
              ? t("Active now", "Active now")
              : t("Inactive", "Inactive")}
          </dd>
          <dt className="text-muted-foreground">{t("Backoff", "Backoff")}</dt>
          <dd>{fmt(status?.backoffUntil, t("None", "None"))}</dd>
          <dt className="text-muted-foreground">
            {t("Last pass", "Last pass")}
          </dt>
          <dd>
            {status?.lastPass
              ? t(
                  "{{kind}} · {{zones}} zones · {{created}} new · {{errors}} errors · {{ms}} ms",
                  {
                    kind: status.lastPass.kind,
                    zones: status.lastPass.zonesChecked,
                    created: status.lastPass.notificationsCreated,
                    errors: status.lastPass.errors,
                    ms: status.lastPass.durationMs,
                    defaultValue: `${status.lastPass.kind} · ${status.lastPass.zonesChecked} zones · ${status.lastPass.notificationsCreated} new · ${status.lastPass.errors} errors · ${status.lastPass.durationMs} ms`,
                  },
                )
              : "—"}
          </dd>
          <dt className="text-muted-foreground">
            {t("Last error", "Last error")}
          </dt>
          <dd className={status?.lastError ? "text-destructive" : undefined}>
            {status?.lastError ?? t("None", "None")}
          </dd>
        </dl>
      </SettingsSection>

      <SettingsSection
        title={t("Reset monitoring state", "Reset monitoring state")}
        description={t(
          "Each action asks for confirmation. None of them changes your settings.",
          "Each action asks for confirmation. None of them changes your settings.",
        )}
        testId="notifications-settings-reset"
      >
        <SettingRow
          label={t("Expiry milestone ledger", "Expiry milestone ledger")}
          description={t(
            "Forget which milestones were already announced; the next pass re-announces the current one.",
            "Forget which milestones were already announced; the next pass re-announces the current one.",
          )}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setResetTarget("expiryLedger")}
          >
            {t("Clear ledger", "Clear ledger")}
          </Button>
        </SettingRow>
        <SettingRow
          label={t("Record snapshots", "Record snapshots")}
          description={t(
            "Delete every zone snapshot. Changes made before the next baseline are not reported.",
            "Delete every zone snapshot. Changes made before the next baseline are not reported.",
          )}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setResetTarget("snapshots")}
          >
            {t("Delete snapshots", "Delete snapshots")}
          </Button>
        </SettingRow>
        <SettingRow
          label={t("Inbox", "Inbox")}
          description={t(
            "Permanently delete every notification, archived ones included.",
            "Permanently delete every notification, archived ones included.",
          )}
        >
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setResetTarget("inbox")}
          >
            {t("Clear inbox", "Clear inbox")}
          </Button>
        </SettingRow>
        {resetNotice ? (
          <p role="status" className="py-2 text-xs text-muted-foreground">
            {resetNotice}
          </p>
        ) : null}
      </SettingsSection>

      <ConfirmDialog
        open={resetTarget !== null}
        title={
          resetTarget === "inbox"
            ? t("Clear the inbox?", "Clear the inbox?")
            : resetTarget === "snapshots"
              ? t("Delete record snapshots?", "Delete record snapshots?")
              : t("Clear the expiry ledger?", "Clear the expiry ledger?")
        }
        description={t("This cannot be undone.", "This cannot be undone.")}
        confirmLabel={t("Confirm", "Confirm")}
        onCancel={() => setResetTarget(null)}
        onConfirm={() => {
          if (resetTarget) void runReset(resetTarget);
        }}
      />
    </div>
  );
}
