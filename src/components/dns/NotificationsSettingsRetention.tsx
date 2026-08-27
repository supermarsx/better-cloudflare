/**
 * "Retention" sub-section: auto-archive, purge, inbox cap and snapshots.
 */
import { useI18n } from "@/hooks/use-i18n";
import {
  NOTIFICATION_SETTING_LIMITS,
  type NotificationSettings,
  type NotificationSettingsInput,
} from "@/lib/notifications/notification-settings";

import {
  NumberField,
  SettingsSection,
  SwitchRow,
} from "./NotificationsSettingsControls";

export interface NotificationsSettingsRetentionProps {
  settings: NotificationSettings;
  update: (partial: NotificationSettingsInput) => NotificationSettings;
}

export function NotificationsSettingsRetention({
  settings,
  update,
}: NotificationsSettingsRetentionProps) {
  const { t } = useI18n();
  const L = NOTIFICATION_SETTING_LIMITS;
  const retention = settings.retention;
  const never = t("Never", "Never");

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("Inbox retention", "Inbox retention")}
        testId="notifications-settings-retention"
      >
        <NumberField
          id="ntf-auto-archive"
          label={t(
            "Auto-archive read items after",
            "Auto-archive read items after",
          )}
          value={retention.autoArchiveReadAfterDays}
          min={L.autoArchiveReadAfterDays.min}
          max={L.autoArchiveReadAfterDays.max}
          unit={t("days", "days")}
          onCommit={(autoArchiveReadAfterDays) =>
            update({ retention: { autoArchiveReadAfterDays } })
          }
          never={{
            label: never,
            restoreValue: L.autoArchiveReadAfterDays.default,
            onChange: (isNever) =>
              update({
                retention: {
                  autoArchiveReadAfterDays: isNever
                    ? null
                    : L.autoArchiveReadAfterDays.default,
                },
              }),
          }}
        />
        <NumberField
          id="ntf-purge-archived"
          label={t(
            "Delete archived items after",
            "Delete archived items after",
          )}
          value={retention.purgeArchivedAfterDays}
          min={L.purgeArchivedAfterDays.min}
          max={L.purgeArchivedAfterDays.max}
          unit={t("days", "days")}
          onCommit={(purgeArchivedAfterDays) =>
            update({ retention: { purgeArchivedAfterDays } })
          }
          never={{
            label: never,
            restoreValue: L.purgeArchivedAfterDays.default,
            onChange: (isNever) =>
              update({
                retention: {
                  purgeArchivedAfterDays: isNever
                    ? null
                    : L.purgeArchivedAfterDays.default,
                },
              }),
          }}
        />
        <NumberField
          id="ntf-max-items"
          label={t("Maximum items", "Maximum items")}
          description={t(
            "Beyond this the oldest archived, then read, then unread items are pruned.",
            "Beyond this the oldest archived, then read, then unread items are pruned.",
          )}
          value={retention.maxItems}
          min={L.maxItems.min}
          max={L.maxItems.max}
          onCommit={(maxItems) => update({ retention: { maxItems } })}
        />
      </SettingsSection>
      <SettingsSection
        title={t("Snapshots", "Snapshots")}
        testId="notifications-settings-snapshots"
      >
        <SwitchRow
          id="ntf-keep-snapshots"
          label={t("Keep record snapshots", "Keep record snapshots")}
          description={
            retention.keepSnapshots
              ? t(
                  "One JSON file per zone in the app data folder; needed to detect record changes.",
                  "One JSON file per zone in the app data folder; needed to detect record changes.",
                )
              : t(
                  "Record-change detection is off while snapshots are not kept; existing snapshots are deleted.",
                  "Record-change detection is off while snapshots are not kept; existing snapshots are deleted.",
                )
          }
          checked={retention.keepSnapshots}
          onCheckedChange={(keepSnapshots) =>
            update({ retention: { keepSnapshots } })
          }
        />
      </SettingsSection>
    </div>
  );
}
