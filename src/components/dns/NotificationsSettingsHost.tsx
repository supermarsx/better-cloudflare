/**
 * `NotificationsSettings`, mounted in the Session settings tab.
 *
 * The settings panel needs four things the notification *service* knows —
 * its status, and the pause / resume / check-now actions — and those come from
 * `useNotifications`, which is also the inbox's hook. The Notifications tab
 * had one already; the settings subtab is a different screen with no inbox, so
 * it needs its own, and putting that call in `DNSManager` would subscribe the
 * whole workspace to `notifications://changed` for the life of the session
 * just so a settings subtab nobody has opened could read a status line.
 *
 * So this file exists to own that one hook call, and nothing else: it mounts
 * when the subtab opens and unmounts when it closes. The panel itself is
 * re-hosted unchanged.
 *
 * The query asks for one unread item rather than the default list because the
 * items are not rendered here — only `status` and the actions are used — and
 * the hook has no mode that skips the list.
 */
import { useNotifications } from "@/hooks/dns/use-notifications";
import { useI18n } from "@/hooks/use-i18n";

import {
  NotificationsSettings,
  type NotificationsSettingsSection,
} from "./NotificationsSettings";

export interface NotificationsSettingsHostProps {
  section: NotificationsSettingsSection;
  onSectionChange: (section: NotificationsSettingsSection) => void;
  /** Opens a zone tab from the per-zone overrides list. */
  onOpenZone?: (zoneId: string) => void;
}

export function NotificationsSettingsHost({
  section,
  onSectionChange,
  onOpenZone,
}: NotificationsSettingsHostProps) {
  const { t } = useI18n();
  const notifications = useNotifications({
    query: { scope: "unread", limit: 1 },
  });

  if (!notifications.available) {
    return (
      <p className="rounded-xl border border-border/60 bg-card/60 px-4 py-6 text-sm text-muted-foreground">
        {t(
          "Notifications are only available in the desktop app.",
          "Notifications are only available in the desktop app.",
        )}
      </p>
    );
  }

  return (
    <div className="min-w-0" data-testid="notifications-settings-host">
      {notifications.error ? (
        <p
          role="alert"
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {notifications.error}
        </p>
      ) : null}
      <NotificationsSettings
        status={notifications.status}
        onCheckNow={notifications.checkNow}
        onPause={notifications.pause}
        onResume={notifications.resume}
        onOpenZone={onOpenZone}
        section={section}
        onSectionChange={onSectionChange}
      />
    </div>
  );
}
