/**
 * One row of the notifications inbox: severity dot, kind icon, title, body,
 * relative time and the per-item actions. The root is a focusable `article`
 * so keyboard users can move item by item; the action buttons follow in
 * tab order. Icon-only actions carry an `aria-label`, and their tooltip
 * shows the same text.
 */
import type { ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  ExternalLink,
  Info,
  Mail,
  MailOpen,
  Pencil,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/hooks/use-i18n";
import type { AppNotification } from "@/lib/api/tauri-client";
import {
  changedFields,
  fullTimestamp,
  isRecordChangePayload,
  isUnread,
  kindLabel,
  relativeTime,
  severityLabel,
} from "@/lib/notifications/notifications-view";
import { cn } from "@/lib/utils";

export interface NotificationItemProps {
  item: AppNotification;
  now?: Date;
  onMarkRead: (id: string, read: boolean) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDismiss: (id: string) => void;
  onOpenZone: (zoneId: string) => void;
  onRevealRecord: (zoneId: string, recordId: string) => void;
}

function KindIcon({ kind }: { kind: AppNotification["kind"] }) {
  const className = "h-4 w-4 shrink-0 text-muted-foreground";
  if (kind === "domain_expiry")
    return <CalendarClock aria-hidden="true" className={className} />;
  if (kind === "record_change")
    return <Pencil aria-hidden="true" className={className} />;
  return <Info aria-hidden="true" className={className} />;
}

function IconAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <Tooltip tip={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="ui-icon-button h-7 w-7 shrink-0"
        aria-label={label}
        onClick={onClick}
      >
        {icon}
      </Button>
    </Tooltip>
  );
}

export function NotificationItem({
  item,
  now,
  onMarkRead,
  onArchive,
  onUnarchive,
  onDismiss,
  onOpenZone,
  onRevealRecord,
}: NotificationItemProps) {
  const { t } = useI18n();
  const unread = isUnread(item);
  const archived = Boolean(item.archivedAt);
  const payload = item.payload;
  const change = isRecordChangePayload(payload) ? payload : null;
  const diffs = change ? changedFields(change.before, change.after) : [];
  const canReveal =
    change !== null && item.zoneId !== null && change.change !== "removed";

  return (
    <article
      tabIndex={0}
      data-testid="notification-item"
      data-notification-id={item.id}
      data-severity={item.severity}
      data-unread={unread ? "true" : undefined}
      aria-label={item.title}
      className={cn(
        "notification-item ui-focus grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-border/50 bg-card/40 px-3 py-2.5 text-sm",
        unread && "notification-item--unread",
      )}
    >
      <span
        className={cn(
          "notification-severity mt-1.5 h-2 w-2 rounded-full",
          `notification-severity--${item.severity}`,
        )}
        role="img"
        aria-label={severityLabel(item.severity)}
      />
      <span className="mt-0.5">
        <KindIcon kind={item.kind} />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span
            className={cn(
              "min-w-0 break-words",
              unread ? "font-semibold" : "font-medium",
            )}
          >
            {item.title}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {kindLabel(item.kind)}
          </span>
          {item.zoneName ? (
            <span className="text-xs text-muted-foreground">
              {item.zoneName}
            </span>
          ) : null}
          <time
            className="ml-auto text-xs text-muted-foreground"
            dateTime={item.createdAt}
            title={fullTimestamp(item.createdAt)}
          >
            {relativeTime(item.createdAt, now)}
          </time>
        </div>
        <p className="mt-0.5 break-words text-xs text-muted-foreground">
          {item.body}
        </p>
        {change && diffs.length > 0 ? (
          <ul
            role="list"
            className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px]"
          >
            {diffs.map((diff) => (
              <li key={diff.field} className="text-muted-foreground">
                <span className="text-foreground/70">{diff.field}:</span>{" "}
                <span className="line-through decoration-destructive/60">
                  {diff.before}
                </span>{" "}
                <span aria-hidden="true">→</span>
                <span className="sr-only">{t("to", "to")}</span>{" "}
                <span className="text-foreground">{diff.after}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {canReveal && item.zoneId ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() =>
                onRevealRecord(item.zoneId as string, change.recordId)
              }
            >
              <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Go to record", "Go to record")}
            </Button>
          ) : item.zoneId ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => onOpenZone(item.zoneId as string)}
            >
              <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Go to zone", "Go to zone")}
            </Button>
          ) : null}
          <span className="flex-1" />
          {!archived ? (
            unread ? (
              <IconAction
                label={t("Mark read", "Mark read")}
                icon={<MailOpen aria-hidden="true" className="h-3.5 w-3.5" />}
                onClick={() => onMarkRead(item.id, true)}
              />
            ) : (
              <IconAction
                label={t("Mark unread", "Mark unread")}
                icon={<Mail aria-hidden="true" className="h-3.5 w-3.5" />}
                onClick={() => onMarkRead(item.id, false)}
              />
            )
          ) : null}
          {archived ? (
            <IconAction
              label={t("Unarchive", "Unarchive")}
              icon={
                <ArchiveRestore aria-hidden="true" className="h-3.5 w-3.5" />
              }
              onClick={() => onUnarchive(item.id)}
            />
          ) : (
            <IconAction
              label={t("Archive", "Archive")}
              icon={<Archive aria-hidden="true" className="h-3.5 w-3.5" />}
              onClick={() => onArchive(item.id)}
            />
          )}
          <IconAction
            label={t("Dismiss", "Dismiss")}
            icon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
            onClick={() => onDismiss(item.id)}
          />
        </div>
      </div>
    </article>
  );
}
