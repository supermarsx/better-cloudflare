/**
 * "Expiry" sub-section: editable milestone chips, expired notice, data
 * source, the severity thresholds used when the kind severity is "auto", and
 * what happens to a notice the registry has since outrun.
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
  STALE_EXPIRY_ACTIONS,
  type ExpirySource,
  type NotificationSettings,
  type NotificationSettingsInput,
  type StaleExpiryAction,
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

/**
 * Labels for `expiry.onDateChange`, keyed so the option list stays
 * {@link STALE_EXPIRY_ACTIONS} — the array the clamp validates against — and
 * a fourth action added to the mirror cannot quietly go unlabelled.
 */
const STALE_EXPIRY_ACTION_LABELS: Record<StaleExpiryAction, string> = {
  archive: "Archive it",
  resolve: "Mark it read, in the inbox",
  update: "Keep it, counting down to the new date",
};

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

      <SettingsSection
        title={t("Keeping notices current", "Keeping notices current")}
        description={t(
          "A notice says “expires in 30 days” because that was true when it was written. These decide how hard the app works to keep it true.",
          "A notice says “expires in 30 days” because that was true when it was written. These decide how hard the app works to keep it true.",
        )}
        testId="notifications-settings-expiry-refresh"
      >
        <SwitchRow
          id="ntf-refresh-countdown"
          label={t("Refresh the countdown", "Refresh the countdown")}
          description={t(
            "Re-states the days left, wording and severity from the date already held, on every pass. Costs no lookup. Off pins every open notice to the words it was written with.",
            "Re-states the days left, wording and severity from the date already held, on every pass. Costs no lookup. Off pins every open notice to the words it was written with.",
          )}
          checked={expiry.refreshCountdown}
          onCheckedChange={(refreshCountdown) =>
            update({ expiry: { refreshCountdown } })
          }
        />
        <SwitchRow
          id="ntf-recheck-date"
          label={t("Re-read the date", "Re-read the date")}
          description={t(
            "Asks the registry again for a domain whose date is already known — the half that spends a rate-limited lookup. A domain with no date yet is always looked up. How often is the expiry poll interval, declining anything younger than the RDAP cache window.",
            "Asks the registry again for a domain whose date is already known — the half that spends a rate-limited lookup. A domain with no date yet is always looked up. How often is the expiry poll interval, declining anything younger than the RDAP cache window.",
          )}
          checked={expiry.recheckDate}
          onCheckedChange={(recheckDate) => update({ expiry: { recheckDate } })}
        />
        <SettingRow
          htmlFor="ntf-on-date-change"
          label={t("When the date has changed", "When the date has changed")}
          description={
            <>
              {t(
                "An open notice the registry has outrun no longer applies. None of the three deletes anything.",
                "An open notice the registry has outrun no longer applies. None of the three deletes anything.",
              )}
              {/* The cost of `update`, stated where the choice is made. It is
                  the one option that can multiply rows, and a user who picks
                  it deliberately deserves to know that before they wonder why
                  one domain has three. */}
              {expiry.onDateChange === "update" ? (
                <span
                  data-testid="ntf-on-date-change-cost"
                  className="mt-1 block"
                >
                  {t(
                    "Keeping it costs more rows: a date that moved earlier still crosses a nearer milestone, so one domain can end up with one notice per threshold, where archiving or reading leaves one.",
                    "Keeping it costs more rows: a date that moved earlier still crosses a nearer milestone, so one domain can end up with one notice per threshold, where archiving or reading leaves one.",
                  )}
                </span>
              ) : null}
            </>
          }
        >
          <Select
            value={expiry.onDateChange}
            onValueChange={(value) =>
              update({ expiry: { onDateChange: value as StaleExpiryAction } })
            }
          >
            <SelectTrigger
              id="ntf-on-date-change"
              aria-label={t(
                "When the date has changed",
                "When the date has changed",
              )}
              className="h-8 w-64 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Radix consumes `value`, so `data-value` is what reaches the
                  DOM for a test to pick an option by. */}
              {STALE_EXPIRY_ACTIONS.map((action) => (
                <SelectItem key={action} value={action} data-value={action}>
                  {t(
                    STALE_EXPIRY_ACTION_LABELS[action],
                    STALE_EXPIRY_ACTION_LABELS[action],
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
