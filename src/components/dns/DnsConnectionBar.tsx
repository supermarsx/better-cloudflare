import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/hooks/use-i18n";

interface DnsConnectionBarProps {
  zoneSelector: ReactNode;
  activeContext?: string;
  activeStatus?: string;
  recordCount?: number;
  visibleCount?: number;
}

export function DnsConnectionBar({
  zoneSelector,
  activeContext,
  activeStatus,
  recordCount,
  visibleCount,
}: DnsConnectionBarProps) {
  const { t } = useI18n();
  const authenticatedSessionLabel = t(
    "Authenticated session",
    "Authenticated session",
  );
  const normalizedActiveStatus = activeStatus?.trim() ?? "";
  const showActiveStatus =
    normalizedActiveStatus.length > 0 &&
    normalizedActiveStatus.toLowerCase() !== "active";

  return (
    <div
      aria-label={t(
        "DNS session and workspace context",
        "DNS session and workspace context",
      )}
      className="mx-auto flex w-full max-w-[1600px] min-w-0 flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:px-4"
    >
      <div className="flex min-w-0 flex-col items-stretch gap-2 min-[360px]:flex-row min-[360px]:items-center sm:flex-1">
        <Tooltip
          tip={authenticatedSessionLabel}
          side="top"
          className="shrink-0 self-start"
        >
          <span
            role="status"
            tabIndex={0}
            aria-label={t(
              "Session status: Authenticated",
              "Session status: Authenticated",
            )}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-emerald-500/25 bg-emerald-500/10 text-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
          </span>
        </Tooltip>
        <div className="min-w-36 flex-1 sm:max-w-sm">{zoneSelector}</div>
      </div>

      {activeContext ? (
        <div
          aria-label={t("Active DNS context", "Active DNS context")}
          className="scrollbar-themed flex min-w-0 max-w-full items-center gap-1.5 overflow-x-auto whitespace-nowrap pb-0.5 text-[10px] text-muted-foreground sm:justify-end"
        >
          <span className="rounded-md border border-border/70 bg-card/70 px-2 py-1 text-foreground/85">
            {activeContext}
          </span>
          {showActiveStatus ? (
            <span className="rounded-md border border-border/70 bg-card/70 px-2 py-1">
              {normalizedActiveStatus}
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
  );
}
