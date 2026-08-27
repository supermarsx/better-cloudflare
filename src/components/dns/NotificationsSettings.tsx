/**
 * Settings view of the Notifications tab. A nested segmented control picks
 * one of six sub-sections; every write goes through
 * `useNotificationSettings().update(partial)` so the hook can clamp, persist
 * the full object and roll back on failure. The save state is announced.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useNotificationSettings } from "@/hooks/dns/use-notification-settings";
import { useI18n } from "@/hooks/use-i18n";
import type {
  NotificationCheckKind,
  NotificationServiceStatus,
} from "@/lib/api/tauri-client";

import { ConfirmDialog } from "./NotificationsSettingsControls";
import { NotificationsSettingsDelivery } from "./NotificationsSettingsDelivery";
import { NotificationsSettingsExpiry } from "./NotificationsSettingsExpiry";
import { NotificationsSettingsKinds } from "./NotificationsSettingsKinds";
import { NotificationsSettingsRetention } from "./NotificationsSettingsRetention";
import { NotificationsSettingsService } from "./NotificationsSettingsService";
import { NotificationsSettingsZones } from "./NotificationsSettingsZones";

export type NotificationsSettingsSection =
  "service" | "kinds" | "expiry" | "zones" | "delivery" | "retention";

const SECTIONS: readonly { id: NotificationsSettingsSection; label: string }[] =
  [
    { id: "service", label: "Service" },
    { id: "kinds", label: "Kinds" },
    { id: "expiry", label: "Expiry" },
    { id: "zones", label: "Zones" },
    { id: "delivery", label: "Delivery" },
    { id: "retention", label: "Retention" },
  ];

export interface NotificationsSettingsProps {
  status: NotificationServiceStatus | null;
  onCheckNow: (kind?: NotificationCheckKind) => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onOpenZone?: (zoneId: string) => void;
  initialSection?: NotificationsSettingsSection;
}

export function NotificationsSettings({
  status,
  onCheckNow,
  onPause,
  onResume,
  onOpenZone,
  initialSection = "service",
}: NotificationsSettingsProps) {
  const { t } = useI18n();
  const [section, setSection] =
    useState<NotificationsSettingsSection>(initialSection);
  const [confirmReset, setConfirmReset] = useState(false);
  const { settings, update, reset, reload, saveState, error } =
    useNotificationSettings();

  const saveText =
    saveState === "saving"
      ? t("Saving…", "Saving…")
      : saveState === "saved"
        ? t("Saved", "Saved")
        : saveState === "loading"
          ? t("Loading…", "Loading…")
          : saveState === "error"
            ? t("Could not save: {{error}}", {
                error: error ?? "",
                defaultValue: `Could not save: ${error ?? ""}`,
              })
            : "";

  return (
    <div className="space-y-4" data-testid="notifications-settings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="toolbar"
          aria-label={t(
            "Notification settings sections",
            "Notification settings sections",
          )}
          className="glass-surface glass-sheen glass-fade ui-segment-group scrollbar-themed"
        >
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="ui-segment"
              data-active={section === entry.id}
              aria-pressed={section === entry.id}
              onClick={() => setSection(entry.id)}
            >
              {t(entry.label, entry.label)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span
            role="status"
            aria-live="polite"
            data-testid="notifications-save-state"
            data-state={saveState}
            className={
              saveState === "error"
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {saveText}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => setConfirmReset(true)}
          >
            {t("Restore defaults", "Restore defaults")}
          </Button>
        </div>
      </div>

      {section === "service" ? (
        <NotificationsSettingsService
          settings={settings}
          update={update}
          status={status}
          onCheckNow={onCheckNow}
          onPause={onPause}
          onResume={onResume}
          onServiceStateChanged={reload}
        />
      ) : null}
      {section === "kinds" ? (
        <NotificationsSettingsKinds settings={settings} update={update} />
      ) : null}
      {section === "expiry" ? (
        <NotificationsSettingsExpiry settings={settings} update={update} />
      ) : null}
      {section === "zones" ? (
        <NotificationsSettingsZones
          settings={settings}
          update={update}
          onOpenZone={onOpenZone}
        />
      ) : null}
      {section === "delivery" ? (
        <NotificationsSettingsDelivery settings={settings} update={update} />
      ) : null}
      {section === "retention" ? (
        <NotificationsSettingsRetention settings={settings} update={update} />
      ) : null}

      <ConfirmDialog
        open={confirmReset}
        title={t("Restore default settings?", "Restore default settings?")}
        description={t(
          "Every notification preference — intervals, kinds, milestones, zone overrides, quiet hours and retention — goes back to its default. The inbox is kept.",
          "Every notification preference — intervals, kinds, milestones, zone overrides, quiet hours and retention — goes back to its default. The inbox is kept.",
        )}
        confirmLabel={t("Restore defaults", "Restore defaults")}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          reset();
          setConfirmReset(false);
        }}
      />
    </div>
  );
}
