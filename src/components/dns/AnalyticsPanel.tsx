/**
 * Zone Analytics panel — displays traffic, bandwidth, threats and
 * pageview statistics fetched from the Cloudflare Analytics API.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
          setError(err instanceof Error ? err.message : "Failed to load analytics");
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
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Zone Analytics</h3>
        <div className="flex items-center gap-2">
          <Select value={range} onValueChange={(v) => setRange(v as TimeRange)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_RANGES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => fetchData()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
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
                  Requests
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatNumber(data.totals.requests)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  Bandwidth
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatBytes(data.totals.bandwidth)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  Threats
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatNumber(data.totals.threats)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  Page Views
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatNumber(data.totals.pageviews)}</p>
              </CardContent>
            </Card>
          </div>

          {/* Timeseries table */}
          {data.timeseries.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Timeseries</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-1 pr-3">Period</th>
                        <th className="pb-1 pr-3 text-right">Requests</th>
                        <th className="pb-1 pr-3 text-right">Bandwidth</th>
                        <th className="pb-1 pr-3 text-right">Threats</th>
                        <th className="pb-1 text-right">Views</th>
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
          <p className="text-sm text-muted-foreground">Loading analytics…</p>
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
