/**
 * Zone Analytics panel — displays traffic, bandwidth, threats and
 * pageview statistics fetched from the Cloudflare Analytics API.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";

export interface AnalyticsDataPoint {
  requests: number;
  bandwidth: number;
  threats: number;
  pageviews: number;
  uniques?: number;
}

export interface AnalyticsTimeseries extends AnalyticsDataPoint {
  since: string;
  until: string;
}

export interface ZoneAnalyticsData {
  totals: AnalyticsDataPoint;
  timeseries: AnalyticsTimeseries[];
}

type TimeRange = "6h" | "24h" | "7d" | "30d";

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: "6h", label: "Last 6 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

function sinceFromRange(range: TimeRange): string {
  const now = new Date();
  const map: Record<TimeRange, number> = {
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  return new Date(now.getTime() - map[range]).toISOString();
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Simple SVG sparkline for timeseries data */
function Sparkline({
  data,
  width = 280,
  height = 60,
  color = "currentColor",
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height * 0.9 - height * 0.05).toFixed(1)}`)
    .join(" ");
  const areaPoints = `0,${height} ${points} ${width},${height}`;
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
      <polygon fill={color} fillOpacity="0.1" points={areaPoints} />
    </svg>
  );
}

interface AnalyticsPanelProps {
  zoneId: string;
  getZoneAnalytics: (
    zoneId: string,
    since?: string,
    until?: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

function AnalyticsPanelInner({ zoneId, getZoneAnalytics }: AnalyticsPanelProps) {
  const { t } = useI18n();
  const [data, setData] = useState<ZoneAnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<TimeRange>("24h");

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const since = sinceFromRange(range);
        const result = (await getZoneAnalytics(zoneId, since, undefined, signal)) as ZoneAnalyticsData;
        if (!signal?.aborted) setData(result);
      } catch (err) {
        if (!signal?.aborted) {
          setError(err instanceof Error ? err.message : t("Failed to load analytics", "Failed to load analytics"));
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [zoneId, range, getZoneAnalytics],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={() => fetchData()}>
          {t("Retry", "Retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{t("Zone Analytics", "Zone Analytics")}</h3>
        <div className="flex items-center gap-2">
          <Select value={range} onValueChange={(v) => setRange(v as TimeRange)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_RANGES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {t(r.label, r.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => fetchData()} disabled={loading}>
            {loading ? t("Loading…", "Loading…") : t("Refresh", "Refresh")}
          </Button>
        </div>
      </div>

      {data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {t("Requests", "Requests")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatNumber(data.totals.requests)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {t("Bandwidth", "Bandwidth")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatBytes(data.totals.bandwidth)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {t("Threats", "Threats")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatNumber(data.totals.threats)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {t("Page Views", "Page Views")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatNumber(data.totals.pageviews)}</p>
              </CardContent>
            </Card>
          </div>

          {/* Sparkline charts */}
          {data.timeseries.length >= 2 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Card>
                <CardHeader className="pb-1">
                  <CardTitle className="text-xs font-medium text-muted-foreground">
                    {t("Requests Over Time", "Requests Over Time")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Sparkline data={data.timeseries.map((p) => p.requests)} color="var(--color-primary, #3b82f6)" />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-1">
                  <CardTitle className="text-xs font-medium text-muted-foreground">
                    {t("Bandwidth Over Time", "Bandwidth Over Time")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Sparkline data={data.timeseries.map((p) => p.bandwidth)} color="var(--color-primary, #10b981)" />
                </CardContent>
              </Card>
            </div>
          )}

          {/* Timeseries table */}
          {data.timeseries.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t("Timeseries", "Timeseries")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-1 pr-3">{t("Period", "Period")}</th>
                        <th className="pb-1 pr-3 text-right">{t("Requests", "Requests")}</th>
                        <th className="pb-1 pr-3 text-right">{t("Bandwidth", "Bandwidth")}</th>
                        <th className="pb-1 pr-3 text-right">{t("Threats", "Threats")}</th>
                        <th className="pb-1 text-right">{t("Views", "Views")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.timeseries.map((point, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1 pr-3 font-mono">
                            {new Date(point.since).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <td className="py-1 pr-3 text-right">{formatNumber(point.requests)}</td>
                          <td className="py-1 pr-3 text-right">{formatBytes(point.bandwidth)}</td>
                          <td className="py-1 pr-3 text-right">{formatNumber(point.threats)}</td>
                          <td className="py-1 text-right">{formatNumber(point.pageviews)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">{t("Loading analytics…", "Loading analytics…")}</p>
        </div>
      )}
    </div>
  );
}

export function AnalyticsPanel(props: AnalyticsPanelProps) {
  return (
    <ErrorBoundary label="analytics">
      <AnalyticsPanelInner {...props} />
    </ErrorBoundary>
  );
}
