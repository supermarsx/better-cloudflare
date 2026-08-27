/**
 * "Kinds" sub-section: one row per notification kind with enable, severity
 * and OS-notify controls; record changes expand into sub-kind toggles and
 * the field checklist that decides what counts as a change.
 */
import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/hooks/use-i18n";
import { TauriClient } from "@/lib/api/tauri-client";
import {
  RECORD_CHANGE_FIELDS,
  type NotificationKindKey,
  type NotificationSettings,
  type NotificationSettingsInput,
  type NotificationSeverityChoice,
  type RecordChangeField,
  type RecordChangeKind,
} from "@/lib/notifications/notification-settings";

import { SettingsSection, SwitchRow } from "./NotificationsSettingsControls";

export interface NotificationsSettingsKindsProps {
  settings: NotificationSettings;
  update: (partial: NotificationSettingsInput) => NotificationSettings;
}

const KIND_ROWS: readonly {
  key: NotificationKindKey;
  label: string;
  description: string;
}[] = [
  {
    key: "domainExpiry",
    label: "Domain expiry",
    description: "Milestones before a registration lapses, and expiry itself.",
  },
  {
    key: "recordChange",
    label: "Record changes",
    description: "Records added, changed or removed outside this app.",
  },
  {
    key: "service",
    label: "Service",
    description: "Baselines taken, zones dropped, monitoring errors.",
  },
];

const SEVERITY_CHOICES: readonly {
  value: NotificationSeverityChoice;
  label: string;
}[] = [
  { value: "auto", label: "Auto" },
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "critical", label: "Critical" },
];

const CHANGE_KINDS: readonly { key: RecordChangeKind; label: string }[] = [
  { key: "added", label: "Added" },
  { key: "changed", label: "Changed" },
  { key: "removed", label: "Removed" },
];

export function NotificationsSettingsKinds({
  settings,
  update,
}: NotificationsSettingsKindsProps) {
  const { t } = useI18n();
  const [fieldNotice, setFieldNotice] = useState<string | null>(null);
  const recordChange = settings.kinds.recordChange;
  const osAvailable = TauriClient.hasOsNotifications;

  const toggleField = (field: RecordChangeField, checked: boolean) => {
    const current = new Set(recordChange.fields);
    if (checked) current.add(field);
    else current.delete(field);
    if (current.size === 0) {
      setFieldNotice(
        t(
          "At least one field must count as a change.",
          "At least one field must count as a change.",
        ),
      );
      return;
    }
    setFieldNotice(null);
    update({
      kinds: {
        recordChange: {
          fields: RECORD_CHANGE_FIELDS.filter((entry) => current.has(entry)),
        },
      },
    });
  };

  return (
    <div className="space-y-4">
      {KIND_ROWS.map((row) => {
        const kind = settings.kinds[row.key];
        const idBase = `ntf-kind-${row.key}`;
        return (
          <SettingsSection
            key={row.key}
            title={t(row.label, row.label)}
            description={t(row.description, row.description)}
            testId={`notifications-settings-kind-${row.key}`}
          >
            <SwitchRow
              id={`${idBase}-enabled`}
              label={t("Enabled", "Enabled")}
              checked={kind.enabled}
              onCheckedChange={(enabled) =>
                update({ kinds: { [row.key]: { enabled } } })
              }
            />
            <div className="flex flex-col gap-2 border-b border-border/40 py-3 sm:flex-row sm:items-center sm:justify-between">
              <label
                htmlFor={`${idBase}-severity`}
                className="text-sm font-medium"
              >
                {t("Severity", "Severity")}
              </label>
              <Select
                value={kind.severity}
                onValueChange={(value) =>
                  update({
                    kinds: {
                      [row.key]: {
                        severity: value as NotificationSeverityChoice,
                      },
                    },
                  })
                }
              >
                <SelectTrigger
                  id={`${idBase}-severity`}
                  aria-label={t("{{kind}} severity", {
                    kind: t(row.label, row.label),
                    defaultValue: `${row.label} severity`,
                  })}
                  className="h-8 w-36 text-xs"
                  disabled={!kind.enabled}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITY_CHOICES.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {t(choice.label, choice.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <SwitchRow
              id={`${idBase}-os`}
              label={t("OS notification", "OS notification")}
              description={
                osAvailable
                  ? undefined
                  : t(
                      "Not available in this build.",
                      "Not available in this build.",
                    )
              }
              checked={kind.osNotify}
              disabled={!kind.enabled || !osAvailable}
              onCheckedChange={(osNotify) =>
                update({ kinds: { [row.key]: { osNotify } } })
              }
            />
            {row.key === "recordChange" ? (
              <>
                <fieldset className="border-b border-border/40 py-3">
                  <legend className="text-sm font-medium">
                    {t("Report", "Report")}
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-4">
                    {CHANGE_KINDS.map((change) => (
                      <label
                        key={change.key}
                        className="flex items-center gap-2 text-xs"
                      >
                        <Switch
                          size="xs"
                          checked={recordChange.changes[change.key]}
                          disabled={!kind.enabled}
                          aria-label={t("Report {{kind}} records", {
                            kind: t(change.label, change.label).toLowerCase(),
                            defaultValue: `Report ${change.label.toLowerCase()} records`,
                          })}
                          onCheckedChange={(checked) =>
                            update({
                              kinds: {
                                recordChange: {
                                  changes: { [change.key]: checked },
                                },
                              },
                            })
                          }
                        />
                        {t(change.label, change.label)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="py-3">
                  <legend className="text-sm font-medium">
                    {t(
                      "Fields that count as a change",
                      "Fields that count as a change",
                    )}
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                    {RECORD_CHANGE_FIELDS.map((field) => (
                      <label
                        key={field}
                        className="flex items-center gap-1.5 font-mono text-xs"
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-primary"
                          checked={recordChange.fields.includes(field)}
                          disabled={!kind.enabled}
                          onChange={(event) =>
                            toggleField(field, event.target.checked)
                          }
                        />
                        {field}
                      </label>
                    ))}
                  </div>
                  {fieldNotice ? (
                    <p
                      role="status"
                      className="mt-2 text-[11px] text-amber-600 dark:text-amber-400"
                    >
                      {fieldNotice}
                    </p>
                  ) : null}
                </fieldset>
              </>
            ) : null}
          </SettingsSection>
        );
      })}
    </div>
  );
}
