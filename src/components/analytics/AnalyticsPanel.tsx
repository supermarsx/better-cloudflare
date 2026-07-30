/**
 * Zone Analytics panel — displays traffic, bandwidth, threats and
 * pageview statistics fetched from the Cloudflare Analytics API.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export const ANALYTICS_POINT_LIMIT = 5_000;
export const ANALYTICS_TABLE_ROW_LIMIT = 250;
export const ANALYTICS_NORMALIZATION_SCAN_LIMIT = 20_000;

const ANALYTICS_METRICS: Array<keyof AnalyticsDataPoint> = [
  "requests",
  "bandwidth",
  "threats",
  "pageviews",
  "uniques",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeAnalyticsMetric(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : 0;
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, numeric));
}

function normalizeAnalyticsDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

function normalizeAnalyticsPoint(value: unknown): AnalyticsTimeseries | null {
  if (!isRecord(value)) return null;
  const since = normalizeAnalyticsDate(value.since);
  const until = normalizeAnalyticsDate(value.until);
  if (!since || !until || Date.parse(until) < Date.parse(since)) return null;
  return {
    since,
    until,
    requests: normalizeAnalyticsMetric(value.requests),
    bandwidth: normalizeAnalyticsMetric(value.bandwidth),
    threats: normalizeAnalyticsMetric(value.threats),
    pageviews: normalizeAnalyticsMetric(value.pageviews),
    uniques: normalizeAnalyticsMetric(value.uniques),
  };
}

function normalizeAnalyticsPayload(value: unknown): {
  data: ZoneAnalyticsData;
  sourcePointCount: number;
} {
  const payload = isRecord(value) ? value : {};
  const rawTotals = isRecord(payload.totals) ? payload.totals : {};
  const rawTimeseries = Array.isArray(payload.timeseries)
    ? payload.timeseries
    : [];
  const normalized: AnalyticsTimeseries[] = [];
  const scanCount = Math.min(
    rawTimeseries.length,
    ANALYTICS_NORMALIZATION_SCAN_LIMIT,
  );

  for (let sample = 0; sample < scanCount; sample += 1) {
    const index =
      rawTimeseries.length <= scanCount || scanCount <= 1
        ? sample
        : Math.round(
            (sample * (rawTimeseries.length - 1)) / Math.max(1, scanCount - 1),
          );
    const point = normalizeAnalyticsPoint(rawTimeseries[index]);
    if (point) normalized.push(point);
  }

  normalized.sort(
    (left, right) => Date.parse(left.since) - Date.parse(right.since),
  );
  return {
    data: {
      totals: {
        requests: normalizeAnalyticsMetric(rawTotals.requests),
        bandwidth: normalizeAnalyticsMetric(rawTotals.bandwidth),
        threats: normalizeAnalyticsMetric(rawTotals.threats),
        pageviews: normalizeAnalyticsMetric(rawTotals.pageviews),
        uniques: normalizeAnalyticsMetric(rawTotals.uniques),
      },
      timeseries: downsampleAnalyticsTimeseries(normalized),
    },
    sourcePointCount: rawTimeseries.length,
  };
}

/**
 * Selects a deterministic bounded view while retaining the first and last
 * points plus global extrema for each metric whenever the limit permits.
 */
function downsampleAnalyticsTimeseries(
  points: AnalyticsTimeseries[],
  limit = ANALYTICS_POINT_LIMIT,
): AnalyticsTimeseries[] {
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : ANALYTICS_POINT_LIMIT;
  if (points.length <= boundedLimit) return points;
  if (boundedLimit === 0) return [];
  if (boundedLimit === 1) return [points[0]];

  const selected = new Set<number>([0, points.length - 1]);
  for (const metric of ANALYTICS_METRICS) {
    let minIndex = -1;
    let maxIndex = -1;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < points.length; index += 1) {
      const value = points[index]?.[metric];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (value < min) {
        min = value;
        minIndex = index;
      }
      if (value > max) {
        max = value;
        maxIndex = index;
      }
    }
    for (const index of [minIndex, maxIndex]) {
      if (index >= 0 && selected.size < boundedLimit) selected.add(index);
    }
  }

  const evenlySpacedSlots = Math.max(1, boundedLimit - selected.size);
  for (
    let slot = 1;
    slot <= evenlySpacedSlots && selected.size < boundedLimit;
    slot += 1
  ) {
    selected.add(
      Math.round((slot * (points.length - 1)) / (evenlySpacedSlots + 1)),
    );
  }
  if (selected.size < boundedLimit) {
    const stride = Math.max(1, Math.floor(points.length / boundedLimit));
    for (
      let index = stride;
      index < points.length - 1 && selected.size < boundedLimit;
      index += stride
    ) {
      selected.add(index);
    }
  }
  if (selected.size < boundedLimit) {
    for (
      let index = 1;
      index < points.length - 1 && selected.size < boundedLimit;
      index += 1
    ) {
      selected.add(index);
    }
  }

  return Array.from(selected)
    .sort((a, b) => a - b)
    .slice(0, boundedLimit)
    .map((index) => points[index]);
}

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
  points: sourcePoints,
  metric,
  width = 280,
  height = 60,
  color = "currentColor",
}: {
  points: AnalyticsTimeseries[];
  metric: "requests" | "bandwidth";
  width?: number;
  height?: number;
  color?: string;
}) {
  if (sourcePoints.length < 2) return null;
  let max = 1;
  let min = Number.POSITIVE_INFINITY;
  for (const point of sourcePoints) {
    const value = point[metric];
    if (value > max) max = value;
    if (value < min) min = value;
  }
  if (!Number.isFinite(min)) min = 0;
  const range = max - min || 1;
  const step = width / (sourcePoints.length - 1);
  const coordinates: string[] = [];
  for (let index = 0; index < sourcePoints.length; index += 1) {
    const value = sourcePoints[index][metric];
    coordinates.push(
      `${(index * step).toFixed(1)},${(height - ((value - min) / range) * height * 0.9 - height * 0.05).toFixed(1)}`,
    );
  }
  const polylinePoints = coordinates.join(" ");
  const areaPoints = `0,${height} ${polylinePoints} ${width},${height}`;
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        points={polylinePoints}
      />
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

function AnalyticsPanelInner({
  zoneId,
  getZoneAnalytics,
}: AnalyticsPanelProps) {
  const { t } = useI18n();
  const [data, setData] = useState<ZoneAnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<TimeRange>("24h");
  const [sourcePointCount, setSourcePointCount] = useState(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const requestVersionRef = useRef(0);
  const loadFailureMessage = t(
    "Failed to load analytics",
    "Failed to load analytics",
  );

  const fetchData = useCallback(async () => {
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    const version = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const since = sinceFromRange(range);
      const result = await getZoneAnalytics(
        zoneId,
        since,
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted || requestVersionRef.current !== version) {
        return;
      }
      const normalized = normalizeAnalyticsPayload(result);
      setSourcePointCount(normalized.sourcePointCount);
      setData(normalized.data);
    } catch (err) {
      if (!controller.signal.aborted && requestVersionRef.current === version) {
        setError(err instanceof Error ? err.message : loadFailureMessage);
      }
    } finally {
      if (!controller.signal.aborted && requestVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [zoneId, range, getZoneAnalytics, loadFailureMessage]);

  useEffect(() => {
    void fetchData();
    return () => {
      requestVersionRef.current += 1;
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [fetchData]);

  const tableTimeseries = useMemo(
    () =>
      data
        ? downsampleAnalyticsTimeseries(
            data.timeseries,
            ANALYTICS_TABLE_ROW_LIMIT,
          )
        : [],
    [data],
  );

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void fetchData()}
        >
          {t("Retry", "Retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {t("Zone Analytics", "Zone Analytics")}
        </h3>
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void fetchData()}
            disabled={loading}
          >
            {loading ? t("Loading…", "Loading…") : t("Refresh", "Refresh")}
          </Button>
        </div>
      </div>

      {data && (
        <>
          {sourcePointCount > data.timeseries.length && (
            <div
              role="status"
              data-testid="analytics-sampling-notice"
              className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
            >
              {t(
                "Large result sampled to {{shown}} of {{total}} points. First, last, and metric extremes are retained.",
                {
                  shown: data.timeseries.length,
                  total: sourcePointCount,
                  defaultValue: `Large result sampled to ${data.timeseries.length} of ${sourcePointCount} points. First, last, and metric extremes are retained.`,
                },
              )}
            </div>
          )}
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {t("Requests", "Requests")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {formatNumber(data.totals.requests)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {t("Bandwidth", "Bandwidth")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {formatBytes(data.totals.bandwidth)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {t("Threats", "Threats")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {formatNumber(data.totals.threats)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {t("Page Views", "Page Views")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {formatNumber(data.totals.pageviews)}
                </p>
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
                  <Sparkline
                    points={data.timeseries}
                    metric="requests"
                    color="var(--color-primary, #3b82f6)"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-1">
                  <CardTitle className="text-xs font-medium text-muted-foreground">
                    {t("Bandwidth Over Time", "Bandwidth Over Time")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Sparkline
                    points={data.timeseries}
                    metric="bandwidth"
                    color="var(--color-primary, #10b981)"
                  />
                </CardContent>
              </Card>
            </div>
          )}

          {/* Timeseries table */}
          {data.timeseries.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  {t("Timeseries", "Timeseries")}
                </CardTitle>
                {data.timeseries.length > tableTimeseries.length && (
                  <p className="text-xs font-normal text-muted-foreground">
                    {t(
                      "Table shows a representative {{shown}} of {{total}} retained points.",
                      {
                        shown: tableTimeseries.length,
                        total: data.timeseries.length,
                        defaultValue: `Table shows a representative ${tableTimeseries.length} of ${data.timeseries.length} retained points.`,
                      },
                    )}
                  </p>
                )}
              </CardHeader>
              <CardContent>
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-1 pr-3">{t("Period", "Period")}</th>
                        <th className="pb-1 pr-3 text-right">
                          {t("Requests", "Requests")}
                        </th>
                        <th className="pb-1 pr-3 text-right">
                          {t("Bandwidth", "Bandwidth")}
                        </th>
                        <th className="pb-1 pr-3 text-right">
                          {t("Threats", "Threats")}
                        </th>
                        <th className="pb-1 text-right">
                          {t("Views", "Views")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {tableTimeseries.map((point, i) => (
                        <tr
                          key={`${point.since}:${point.until}:${i}`}
                          data-testid="analytics-timeseries-row"
                          className="border-b last:border-0"
                        >
                          <td className="py-1 pr-3 font-mono">
                            {new Date(point.since).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <td className="py-1 pr-3 text-right">
                            {formatNumber(point.requests)}
                          </td>
                          <td className="py-1 pr-3 text-right">
                            {formatBytes(point.bandwidth)}
                          </td>
                          <td className="py-1 pr-3 text-right">
                            {formatNumber(point.threats)}
                          </td>
                          <td className="py-1 text-right">
                            {formatNumber(point.pageviews)}
                          </td>
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
          <p className="text-sm text-muted-foreground">
            {t("Loading analytics…", "Loading analytics…")}
          </p>
        </div>
      )}
    </div>
  );
}

AnalyticsPanel.downsampleAnalyticsTimeseries = downsampleAnalyticsTimeseries;
AnalyticsPanel.normalizeAnalyticsPayload = normalizeAnalyticsPayload;

export function AnalyticsPanel(props: AnalyticsPanelProps) {
  return (
    <ErrorBoundary label="analytics">
      <AnalyticsPanelInner {...props} />
    </ErrorBoundary>
  );
}
