/**
 * "Expiry" sub-section: editable milestone chips, expired notice, data
 * source and the severity thresholds used when the kind severity is "auto".
 */
import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";

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
import { useI18n } from "@/hooks/use-i18n";
import {
  NOTIFICATION_SETTING_LIMITS,
  type ExpirySource,
  type NotificationSettings,
  type NotificationSettingsInput,
} from "@/lib/notifications/notification-settings";

import {
  NumberField,
  SettingRow,
  SettingsSection,
  SwitchRow,
} from "./NotificationsSettingsControls";

export interface NotificationsSettingsExpiryProps {
  settings: NotificationSettings;
  update: (partial: NotificationSettingsInput) => NotificationSettings;
}

const SOURCES: readonly { value: ExpirySource; label: string }[] = [
  { value: "auto", label: "Auto (registrar, then RDAP)" },
  { value: "rdap", label: "RDAP only" },
  { value: "registrar", label: "Registrar only" },
];

export function NotificationsSettingsExpiry({
  settings,
  update,
}: NotificationsSettingsExpiryProps) {
  const { t } = useI18n();
  const L = NOTIFICATION_SETTING_LIMITS;
  const expiry = settings.expiry;
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const addMilestone = () => {
    const days = Number.parseInt(draft.trim(), 10);
    if (!Number.isFinite(days)) {
      setMessage(t("Enter a number of days.", "Enter a number of days."));
      return;
    }
    if (days < L.milestoneDays.min || days > L.milestoneDays.max) {
      setMessage(
        t("Milestones must be between {{min}} and {{max}} days.", {
          min: L.milestoneDays.min,
          max: L.milestoneDays.max,
          defaultValue: `Milestones must be between ${L.milestoneDays.min} and ${L.milestoneDays.max} days.`,
        }),
      );
      return;
    }
    if (expiry.milestones.includes(days)) {
      setMessage(
        t("{{count}} days is already in the list.", {
          count: days,
          defaultValue: `${days} days is already in the list.`,
        }),
      );
      return;
    }
    if (expiry.milestones.length >= L.maxMilestones) {
      setMessage(
        t("At most {{count}} milestones.", {
          count: L.maxMilestones,
          defaultValue: `At most ${L.maxMilestones} milestones.`,
        }),
      );
      return;
    }
    setMessage(null);
    setDraft("");
    update({
      expiry: {
        milestones: [...expiry.milestones, days].sort((a, b) => b - a),
      },
    });
  };

  const removeMilestone = (days: number) => {
    setMessage(null);
    update({
      expiry: { milestones: expiry.milestones.filter((m) => m !== days) },
    });
  };

  const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addMilestone();
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("Milestones", "Milestones")}
        description={t(
          "Days before expiry at which to notify. Only the smallest crossed milestone fires; a renewal resets them. Expiry itself (day 0) is always reported when enabled below.",
          "Days before expiry at which to notify. Only the smallest crossed milestone fires; a renewal resets them. Expiry itself (day 0) is always reported when enabled below.",
        )}
        testId="notifications-settings-milestones"
      >
        <ul
          role="list"
          aria-label={t("Expiry milestones", "Expiry milestones")}
          className="flex flex-wrap gap-2 py-3"
        >
          {expiry.milestones.map((days) => (
            <li
              key={days}
              data-testid="milestone-chip"
              className="glass-surface inline-flex items-center gap-1 rounded-full border border-border/60 py-0.5 pl-2.5 pr-1 text-xs"
            >
              {t("{{count}} d", { count: days, defaultValue: `${days} d` })}
              <button
                type="button"
                className="ui-icon-button rounded-full p-0.5 hover:bg-accent/60"
                aria-label={t("Remove {{count}}-day milestone", {
                  count: days,
                  defaultValue: `Remove ${days}-day milestone`,
                })}
                onClick={() => removeMilestone(days)}
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </li>
          ))}
          {expiry.milestones.length === 0 ? (
            <li className="text-xs text-muted-foreground">
              {t(
                "No milestones — only expiry itself is reported.",
                "No milestones — only expiry itself is reported.",
              )}
            </li>
          ) : null}
        </ul>
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <Label htmlFor="ntf-milestone-add" className="text-xs">
            {t("Add milestone (days)", "Add milestone (days)")}
          </Label>
          <Input
            id="ntf-milestone-add"
            type="number"
            inputMode="numeric"
            min={L.milestoneDays.min}
            max={L.milestoneDays.max}
            value={draft}
            aria-describedby="ntf-milestone-hint"
            aria-invalid={message ? true : undefined}
            className="h-8 w-24 text-sm"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onDraftKeyDown}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addMilestone}
          >
            {t("Add", "Add")}
          </Button>
          <span
            id="ntf-milestone-hint"
            className="text-[11px] text-muted-foreground"
          >
            {t("1–365 days, up to {{count}} entries", {
              count: L.maxMilestones,
              defaultValue: `1–365 days, up to ${L.maxMilestones} entries`,
            })}
          </span>
        </div>
        {message ? (
          <p
            role="status"
            data-testid="milestone-message"
            className="pb-2 text-[11px] text-amber-600 dark:text-amber-400"
          >
            {message}
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={t("Behaviour", "Behaviour")}
        testId="notifications-settings-expiry-behaviour"
      >
        <SwitchRow
          id="ntf-notify-expired"
          label={t("Notify when expired", "Notify when expired")}
          checked={expiry.notifyExpired}
          onCheckedChange={(notifyExpired) =>
            update({ expiry: { notifyExpired } })
          }
        />
        <SettingRow
          htmlFor="ntf-expiry-source"
          label={t("Expiry source", "Expiry source")}
          description={t(
            "Registrar data needs a configured registrar; RDAP is public but some TLDs have none.",
            "Registrar data needs a configured registrar; RDAP is public but some TLDs have none.",
          )}
        >
          <Select
            value={expiry.source}
            onValueChange={(value) =>
              update({ expiry: { source: value as ExpirySource } })
            }
          >
            <SelectTrigger
              id="ntf-expiry-source"
              aria-label={t("Expiry source", "Expiry source")}
              className="h-8 w-56 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCES.map((source) => (
                <SelectItem key={source.value} value={source.value}>
                  {t(source.label, source.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <NumberField
          id="ntf-warning-days"
          label={t("Warning at or below", "Warning at or below")}
          description={t(
            "Days left at which an auto-severity expiry notice becomes a warning.",
            "Days left at which an auto-severity expiry notice becomes a warning.",
          )}
          value={expiry.severityByMilestone.warningAtOrBelow}
          min={L.warningAtOrBelow.min}
          max={L.warningAtOrBelow.max}
          unit={t("days", "days")}
          onCommit={(warningAtOrBelow) =>
            update({ expiry: { severityByMilestone: { warningAtOrBelow } } })
          }
        />
        <NumberField
          id="ntf-critical-days"
          label={t("Critical at or below", "Critical at or below")}
          description={t(
            "Must not exceed the warning threshold; larger values are lowered to it.",
            "Must not exceed the warning threshold; larger values are lowered to it.",
          )}
          value={expiry.severityByMilestone.criticalAtOrBelow}
          min={L.criticalAtOrBelow.min}
          max={expiry.severityByMilestone.warningAtOrBelow}
          unit={t("days", "days")}
          onCommit={(criticalAtOrBelow) =>
            update({ expiry: { severityByMilestone: { criticalAtOrBelow } } })
          }
        />
      </SettingsSection>
    </div>
  );
}
