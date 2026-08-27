/**
 * "Delivery" sub-section: quiet hours, OS notifications and in-app toasts /
 * badge. OS notifications render disabled with a note until the optional
 * plugin build flips `TauriClient.hasOsNotifications`.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/hooks/use-i18n";
import { TauriClient } from "@/lib/api/tauri-client";
import {
  isValidClockTime,
  NOTIFICATION_SEVERITIES,
  type NotificationSettings,
  type NotificationSettingsInput,
  type NotificationSeverity,
  type QuietHoursBehaviour,
  type ToastMinSeverity,
} from "@/lib/notifications/notification-settings";

import {
  SETTINGS_INPUT_DEBOUNCE_MS,
  SettingRow,
  SettingsSection,
  SwitchRow,
} from "./NotificationsSettingsControls";

export interface NotificationsSettingsDeliveryProps {
  settings: NotificationSettings;
  update: (partial: NotificationSettingsInput) => NotificationSettings;
}

const DAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const FALLBACK_TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Australia/Sydney",
];

function timezoneOptions(current: string): string[] {
  let list: string[] = FALLBACK_TIMEZONES;
  const intl = Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  };
  try {
    if (typeof intl.supportedValuesOf === "function") {
      const supported = intl.supportedValuesOf("timeZone");
      if (supported.length > 0) list = supported;
    }
  } catch {
    /* keep the fallback list */
  }
  return current !== "local" && !list.includes(current)
    ? [current, ...list]
    : list;
}

/** `<input type="time">` bound to a setting with the typed-input debounce. */
function TimeField({
  id,
  label,
  value,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | null>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <label className="flex items-center gap-2 text-xs">
      {label}
      <Input
        id={id}
        type="time"
        value={draft}
        disabled={disabled}
        className="h-8 w-28 text-xs"
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            if (isValidClockTime(next)) onCommit(next);
          }, SETTINGS_INPUT_DEBOUNCE_MS);
        }}
        onBlur={() => {
          if (isValidClockTime(draft) && draft !== value) onCommit(draft);
        }}
      />
    </label>
  );
}

export function NotificationsSettingsDelivery({
  settings,
  update,
}: NotificationsSettingsDeliveryProps) {
  const { t } = useI18n();
  const quiet = settings.quietHours;
  const osAvailable = TauriClient.hasOsNotifications;
  const timezones = useMemo(
    () => timezoneOptions(quiet.timezone),
    [quiet.timezone],
  );

  const toggleDay = (day: number) => {
    const days = quiet.days.includes(day)
      ? quiet.days.filter((entry) => entry !== day)
      : [...quiet.days, day].sort((a, b) => a - b);
    update({ quietHours: { days } });
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("Quiet hours", "Quiet hours")}
        description={t(
          'During the window nothing pops up. "Silence" still files items in the inbox; "Hold" delivers them when the window ends.',
          'During the window nothing pops up. "Silence" still files items in the inbox; "Hold" delivers them when the window ends.',
        )}
        testId="notifications-settings-quiet-hours"
      >
        <SwitchRow
          id="ntf-quiet-enabled"
          label={t("Enable quiet hours", "Enable quiet hours")}
          checked={quiet.enabled}
          onCheckedChange={(enabled) => update({ quietHours: { enabled } })}
        />
        <SettingRow label={t("Window", "Window")}>
          <TimeField
            id="ntf-quiet-start"
            label={t("From", "From")}
            value={quiet.start}
            disabled={!quiet.enabled}
            onCommit={(start) => update({ quietHours: { start } })}
          />
          <TimeField
            id="ntf-quiet-end"
            label={t("To", "To")}
            value={quiet.end}
            disabled={!quiet.enabled}
            onCommit={(end) => update({ quietHours: { end } })}
          />
        </SettingRow>
        <SettingRow label={t("Days", "Days")}>
          <div
            role="group"
            aria-label={t("Quiet hours days", "Quiet hours days")}
            className="flex flex-wrap gap-1"
          >
            {DAY_LABELS.map((label, day) => {
              const active = quiet.days.includes(day);
              return (
                <button
                  key={label}
                  type="button"
                  className="ui-segment glass-surface"
                  data-active={active}
                  aria-pressed={active}
                  aria-label={t(label, label)}
                  disabled={!quiet.enabled}
                  onClick={() => toggleDay(day)}
                >
                  {t(label, label).slice(0, 3)}
                </button>
              );
            })}
          </div>
        </SettingRow>
        <SettingRow
          htmlFor="ntf-quiet-timezone"
          label={t("Time zone", "Time zone")}
        >
          <Select
            value={quiet.timezone}
            onValueChange={(timezone) => update({ quietHours: { timezone } })}
          >
            <SelectTrigger
              id="ntf-quiet-timezone"
              aria-label={t("Quiet hours time zone", "Quiet hours time zone")}
              className="h-8 w-60 text-xs"
              disabled={!quiet.enabled}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value="local">
                {t("Local time", "Local time")}
              </SelectItem>
              {timezones.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          htmlFor="ntf-quiet-behaviour"
          label={t("Behaviour", "Behaviour")}
        >
          <Select
            value={quiet.behaviour}
            onValueChange={(value) =>
              update({
                quietHours: { behaviour: value as QuietHoursBehaviour },
              })
            }
          >
            <SelectTrigger
              id="ntf-quiet-behaviour"
              aria-label={t("Quiet hours behaviour", "Quiet hours behaviour")}
              className="h-8 w-40 text-xs"
              disabled={!quiet.enabled}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="silence">{t("Silence", "Silence")}</SelectItem>
              <SelectItem value="hold">{t("Hold", "Hold")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t("OS notifications", "OS notifications")}
        description={
          osAvailable
            ? undefined
            : t("Not available in this build.", "Not available in this build.")
        }
        testId="notifications-settings-os"
      >
        <SwitchRow
          id="ntf-os-enabled"
          label={t("Show system notifications", "Show system notifications")}
          checked={settings.osNotifications.enabled}
          disabled={!osAvailable}
          onCheckedChange={(enabled) =>
            update({ osNotifications: { enabled } })
          }
        />
        <SettingRow
          htmlFor="ntf-os-min-severity"
          label={t("Minimum severity", "Minimum severity")}
        >
          <Select
            value={settings.osNotifications.minSeverity}
            onValueChange={(value) =>
              update({
                osNotifications: { minSeverity: value as NotificationSeverity },
              })
            }
          >
            <SelectTrigger
              id="ntf-os-min-severity"
              aria-label={t(
                "OS notification minimum severity",
                "OS notification minimum severity",
              )}
              className="h-8 w-36 text-xs"
              disabled={!osAvailable || !settings.osNotifications.enabled}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NOTIFICATION_SEVERITIES.map((severity) => (
                <SelectItem key={severity} value={severity}>
                  {t(severity, severity)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t("In-app", "In-app")}
        testId="notifications-settings-in-app"
      >
        <SettingRow
          htmlFor="ntf-toast-min-severity"
          label={t("Toast for", "Toast for")}
          description={t(
            "Show a toast while the app is focused for items at or above this severity.",
            "Show a toast while the app is focused for items at or above this severity.",
          )}
        >
          <Select
            value={settings.inApp.toastMinSeverity}
            onValueChange={(value) =>
              update({ inApp: { toastMinSeverity: value as ToastMinSeverity } })
            }
          >
            <SelectTrigger
              id="ntf-toast-min-severity"
              aria-label={t("Toast minimum severity", "Toast minimum severity")}
              className="h-8 w-36 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="never">{t("Never", "Never")}</SelectItem>
              <SelectItem value="critical">
                {t("Critical", "Critical")}
              </SelectItem>
              <SelectItem value="warning">{t("Warning", "Warning")}</SelectItem>
              <SelectItem value="info">{t("Info", "Info")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SwitchRow
          id="ntf-badge"
          label={t("Unread badge on the bell", "Unread badge on the bell")}
          checked={settings.inApp.badge}
          onCheckedChange={(badge) => update({ inApp: { badge } })}
        />
      </SettingsSection>
    </div>
  );
}
