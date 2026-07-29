import type { ReactNode } from "react";
import { Globe, LogOut, Settings, Shield, Tags, Wifi } from "lucide-react";

import { LanguageSelector } from "@/components/layout/LanguageSelector";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/hooks/use-i18n";

interface DnsAppCommandBarProps {
  zoneSelector: ReactNode;
  accountLabel: string;
  sessionLabel: string;
  activeContext?: string;
  activeStatus?: string;
  recordCount?: number;
  visibleCount?: number;
  showAudit: boolean;
  onOpenAudit: () => void;
  onOpenRegistry: () => void;
  onOpenSettings: () => void;
  onOpenTags: () => void;
  onLogout: () => void;
}

interface CommandActionProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}

function CommandAction({ label, icon, onClick }: CommandActionProps) {
  return (
    <Tooltip tip={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="ui-icon-button h-8 w-8 shrink-0"
        aria-label={label}
        onClick={onClick}
      >
        {icon}
      </Button>
    </Tooltip>
  );
}

export function DnsAppCommandBar({
  zoneSelector,
  accountLabel,
  sessionLabel,
  activeContext,
  activeStatus,
  recordCount,
  visibleCount,
  showAudit,
  onOpenAudit,
  onOpenRegistry,
  onOpenSettings,
  onOpenTags,
  onLogout,
}: DnsAppCommandBarProps) {
  const { t } = useI18n();

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-2 px-3 py-2 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-52 items-center gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight sm:text-base">
              {t("DNS Manager", "DNS Manager")}
            </h1>
            <p className="hidden truncate text-[11px] text-muted-foreground sm:block">
              {t(
                "Manage your Cloudflare DNS records",
                "Manage your Cloudflare DNS records",
              )}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-500">
            <Wifi aria-hidden="true" className="h-3 w-3" />
            {t("Connected", "Connected")}
          </span>
        </div>

        <div
          role="toolbar"
          aria-label={t(
            "Global application controls",
            "Global application controls",
          )}
          className="scrollbar-themed flex max-w-full items-center gap-1 overflow-x-auto"
        >
          {showAudit ? (
            <CommandAction
              label={t("Audit log", "Audit log")}
              icon={<Shield aria-hidden="true" className="h-4 w-4" />}
              onClick={onOpenAudit}
            />
          ) : null}
          <CommandAction
            label={t("Registry Monitoring", "Registry Monitoring")}
            icon={<Globe aria-hidden="true" className="h-4 w-4" />}
            onClick={onOpenRegistry}
          />
          <CommandAction
            label={t("Settings", "Settings")}
            icon={<Settings aria-hidden="true" className="h-4 w-4" />}
            onClick={onOpenSettings}
          />
          <CommandAction
            label={t("Tags", "Tags")}
            icon={<Tags aria-hidden="true" className="h-4 w-4" />}
            onClick={onOpenTags}
          />
          <span
            aria-hidden="true"
            className="mx-1 h-5 w-px shrink-0 bg-border/80"
          />
          <LanguageSelector compact />
          <ThemeToggle compact />
          <div className="ml-1 min-w-0 max-w-40 border-l border-border/70 pl-2">
            <p
              className="truncate text-[11px] font-medium text-foreground"
              title={accountLabel}
            >
              {accountLabel}
            </p>
            <p
              className="truncate text-[10px] text-muted-foreground"
              title={sessionLabel}
            >
              {sessionLabel}
            </p>
          </div>
          <CommandAction
            label={t("Logout", "Logout")}
            icon={<LogOut aria-hidden="true" className="h-4 w-4" />}
            onClick={onLogout}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1 sm:max-w-sm">{zoneSelector}</div>
        {activeContext ? (
          <div
            aria-label={t("Active DNS context", "Active DNS context")}
            className="flex max-w-full items-center gap-1.5 overflow-x-auto whitespace-nowrap text-[10px] text-muted-foreground"
          >
            <span className="rounded-md border border-border/70 bg-card/70 px-2 py-1 text-foreground/85">
              {activeContext}
            </span>
            {activeStatus ? (
              <span className="rounded-md border border-border/70 bg-card/70 px-2 py-1">
                {activeStatus}
              </span>
            ) : null}
            {typeof recordCount === "number" ? (
              <span className="rounded-md border border-border/70 bg-card/70 px-2 py-1">
                {t("{{count}} records", {
                  count: recordCount,
                  defaultValue: `${recordCount} records`,
                })}
              </span>
            ) : null}
            {typeof visibleCount === "number" ? (
              <span className="rounded-md border border-border/70 bg-card/70 px-2 py-1">
                {t("{{count}} visible", {
                  count: visibleCount,
                  defaultValue: `${visibleCount} visible`,
                })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
