import type { ReactNode } from "react";
import { Activity, ShieldCheck } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import {
  useCloudflareLatency,
  type CloudflareLatencyState,
} from "@/hooks/dns/use-cloudflare-latency";
import { useI18n } from "@/hooks/use-i18n";
import { isDesktop } from "@/lib/environment";
import { cn } from "@/lib/utils";

type TranslateFunction = ReturnType<typeof useI18n>["t"];

interface DnsConnectionBarProps {
  zoneSelector: ReactNode;
  activeContext?: string;
  activeStatus?: string;
  recordCount?: number;
  visibleCount?: number;
  /**
   * Credentials the latency probe authenticates with. Without them the readout
   * stays hidden rather than showing a number it cannot stand behind.
   */
  apiKey?: string;
  email?: string;
  /**
   * Whether the round-trip probe may run. Absent means yes, so a caller that
   * has not been taught about the switch keeps today's behaviour.
   *
   * `false` reaches `useCloudflareLatency` as `enabled: false`, which is the
   * difference between a switch and a label: the effect never arms a timer and
   * never issues the authenticated read, so the chip is absent because there
   * is nothing to report rather than because it was hidden.
   */
  latencyEnabled?: boolean;
}

export interface CloudflareLatencyDescription {
  /** Compact chip text. */
  value: string;
  /** The whole meaning, for anyone who cannot see the colour. */
  ariaLabel: string;
  /** Tooltip text: what was actually timed. */
  detail: string;
  /** Tone classes for the chip. */
  toneClassName: string;
}

const LATENCY_TONE_CLASSNAMES = {
  good: "border-emerald-500/25 bg-emerald-500/10 text-emerald-500",
  fair: "border-amber-500/25 bg-amber-500/10 text-amber-500",
  poor: "border-red-500/25 bg-red-500/10 text-red-500",
  unknown: "border-border/70 bg-card/70 text-muted-foreground",
} as const;

/**
 * Turn a latency reading into the four strings the chip needs.
 *
 * Every wording here has to survive the question "is that what you measured?".
 * The app never sends an ICMP packet: it times one of its own authenticated
 * Cloudflare reads, which travels through the desktop bridge or through the
 * app's API server on its way out. The detail text says so in both modes, so
 * nobody reads the number as a raw network ping.
 *
 * Returns `null` when there is nothing to report, which keeps the bar exactly
 * as it was before the readout existed.
 */
export function describeCloudflareLatency(
  state: CloudflareLatencyState,
  t: TranslateFunction,
  { desktop }: { desktop: boolean },
): CloudflareLatencyDescription | null {
  if (state.status === "disabled") return null;

  const measuredVia = desktop
    ? t(
        "Timed on one of this app's own authenticated Cloudflare reads, from the desktop app out to the Cloudflare API and back. It is an API round trip, not a network ping.",
        "Timed on one of this app's own authenticated Cloudflare reads, from the desktop app out to the Cloudflare API and back. It is an API round trip, not a network ping.",
      )
    : t(
        "Timed on one of this app's own authenticated Cloudflare reads, from this browser through the app's API server to Cloudflare and back. It is an API round trip, not a network ping.",
        "Timed on one of this app's own authenticated Cloudflare reads, from this browser through the app's API server to Cloudflare and back. It is an API round trip, not a network ping.",
      );

  if (state.status === "ready" && state.latencyMs !== null) {
    const quality =
      state.grade === "good"
        ? t("good", "good")
        : state.grade === "fair"
          ? t("fair", "fair")
          : t("poor", "poor");
    return {
      value: t("{{latency}} ms", {
        latency: state.latencyMs,
        defaultValue: `${state.latencyMs} ms`,
      }),
      ariaLabel: t("Cloudflare API round trip: {{latency}} ms ({{quality}})", {
        latency: state.latencyMs,
        quality,
        defaultValue: `Cloudflare API round trip: ${state.latencyMs} ms (${quality})`,
      }),
      detail: measuredVia,
      toneClassName: LATENCY_TONE_CLASSNAMES[state.grade ?? "good"],
    };
  }

  if (state.status === "measuring") {
    return {
      value: "…",
      ariaLabel: t(
        "Cloudflare API round trip: measuring",
        "Cloudflare API round trip: measuring",
      ),
      detail: `${t(
        "Measuring the round trip to the Cloudflare API.",
        "Measuring the round trip to the Cloudflare API.",
      )} ${measuredVia}`,
      toneClassName: LATENCY_TONE_CLASSNAMES.unknown,
    };
  }

  if (state.status === "offline") {
    return {
      value: "—",
      ariaLabel: t(
        "Cloudflare API round trip: this device is offline",
        "Cloudflare API round trip: this device is offline",
      ),
      detail: t(
        "This device reports no network connection, so the Cloudflare API was not contacted.",
        "This device reports no network connection, so the Cloudflare API was not contacted.",
      ),
      toneClassName: LATENCY_TONE_CLASSNAMES.unknown,
    };
  }

  return {
    value: "—",
    ariaLabel: t(
      "Cloudflare API round trip: no reading",
      "Cloudflare API round trip: no reading",
    ),
    detail: `${t(
      "The last check did not finish, so there is no current reading. The next one runs shortly.",
      "The last check did not finish, so there is no current reading. The next one runs shortly.",
    )} ${measuredVia}`,
    toneClassName: LATENCY_TONE_CLASSNAMES.unknown,
  };
}

export function DnsConnectionBar({
  zoneSelector,
  activeContext,
  activeStatus,
  recordCount,
  visibleCount,
  apiKey,
  email,
  latencyEnabled = true,
}: DnsConnectionBarProps) {
  const { t } = useI18n();
  const latency = useCloudflareLatency({
    apiKey,
    email,
    enabled: latencyEnabled,
  });
  const latencyDescription = describeCloudflareLatency(latency, t, {
    desktop: isDesktop(),
  });
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
        {latencyDescription ? (
          <Tooltip
            tip={latencyDescription.detail}
            side="top"
            className="shrink-0 self-start"
          >
            <span
              role="status"
              // A new reading lands every minute. Announcing each one would
              // talk over whatever the user is actually doing, so the chip
              // stays a status they can read on focus, not a live region.
              aria-live="off"
              tabIndex={0}
              aria-label={latencyDescription.ariaLabel}
              data-testid="cloudflare-latency"
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[10px] whitespace-nowrap tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                latencyDescription.toneClassName,
              )}
            >
              <Activity aria-hidden="true" className="h-3 w-3" />
              <span aria-hidden="true">{latencyDescription.value}</span>
            </span>
          </Tooltip>
        ) : null}
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
