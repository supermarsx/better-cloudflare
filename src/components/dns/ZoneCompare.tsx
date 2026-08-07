/**
 * Zone Comparison panel — side-by-side diff of DNS records between two zones.
 */
import { useCallback, useMemo, useState } from "react";
import { useI18n } from "@/hooks/use-i18n";
import {
  buildGridTemplateColumns,
  resolveTableColumns,
} from "@/lib/tables/table-columns";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import type { DNSRecord, Zone } from "@/types/dns";

type DiffKind = "only-left" | "only-right" | "different" | "same";

interface DiffEntry {
  kind: DiffKind;
  key: string;
  left?: DNSRecord;
  right?: DNSRecord;
}

const columnLabels: Record<string, string> = {
  status: "Status",
  type: "Type",
  name: "Name",
  content: "Content",
  ttl: "TTL",
  proxied: "Proxy",
};

function recordKey(r: DNSRecord): string {
  return `${r.type}:${r.name}:${r.content}`;
}

function computeDiff(left: DNSRecord[], right: DNSRecord[]): DiffEntry[] {
  const leftMap = new Map<string, DNSRecord>();
  const rightMap = new Map<string, DNSRecord>();
  for (const r of left) leftMap.set(recordKey(r), r);
  for (const r of right) rightMap.set(recordKey(r), r);

  const entries: DiffEntry[] = [];
  const allKeys = new Set([...leftMap.keys(), ...rightMap.keys()]);

  for (const key of allKeys) {
    const l = leftMap.get(key);
    const r = rightMap.get(key);
    if (l && r) {
      const same =
        l.ttl === r.ttl && l.proxied === r.proxied && l.priority === r.priority;
      entries.push({
        kind: same ? "same" : "different",
        key,
        left: l,
        right: r,
      });
    } else if (l) {
      entries.push({ kind: "only-left", key, left: l });
    } else if (r) {
      entries.push({ kind: "only-right", key, right: r });
    }
  }

  // Sort: differences first, then only-left, only-right, then same
  const order: Record<DiffKind, number> = {
    different: 0,
    "only-left": 1,
    "only-right": 2,
    same: 3,
  };
  entries.sort((a, b) => order[a.kind] - order[b.kind]);
  return entries;
}

interface ZoneCompareProps {
  zones: Zone[];
  currentZoneId: string;
  getDNSRecords: (
    zoneId: string,
    page?: number,
    perPage?: number,
    signal?: AbortSignal,
  ) => Promise<DNSRecord[]>;
  /**
   * Queue records for pasting into the current zone. `source` identifies the
   * zone the records were read from, which the paste path needs to rewrite
   * domain suffixes correctly.
   */
  onCopyRecords?: (
    records: DNSRecord[],
    source: { zoneId: string; zoneName: string },
  ) => void;
  /** Visible column ids, in order. Defaults to the registry defaults. */
  columns?: readonly string[];
}

function ZoneCompareInner({
  zones,
  currentZoneId,
  getDNSRecords,
  onCopyRecords,
  columns,
}: ZoneCompareProps) {
  const { t } = useI18n();
  const [compareZoneId, setCompareZoneId] = useState("");
  const [diff, setDiff] = useState<DiffEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSame, setShowSame] = useState(false);

  const otherZones = zones.filter((z) => z.id !== currentZoneId);
  const currentZone = zones.find((z) => z.id === currentZoneId);
  const compareZone = zones.find((z) => z.id === compareZoneId);

  const runComparison = useCallback(async () => {
    if (!compareZoneId) return;
    setLoading(true);
    setError(null);
    try {
      const [leftRecords, rightRecords] = await Promise.all([
        getDNSRecords(currentZoneId, 1, 5000),
        getDNSRecords(compareZoneId, 1, 5000),
      ]);
      setDiff(computeDiff(leftRecords, rightRecords));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("Comparison failed", "Comparison failed"),
      );
    } finally {
      setLoading(false);
    }
  }, [currentZoneId, compareZoneId, getDNSRecords]);

  const filteredDiff = diff?.filter((e) => showSame || e.kind !== "same") ?? [];
  const stats = diff
    ? {
        same: diff.filter((e) => e.kind === "same").length,
        different: diff.filter((e) => e.kind === "different").length,
        onlyLeft: diff.filter((e) => e.kind === "only-left").length,
        onlyRight: diff.filter((e) => e.kind === "only-right").length,
      }
    : null;

  const visibleColumns = useMemo(
    () => resolveTableColumns("zoneCompare", columns),
    [columns],
  );
  const gridTemplate = useMemo(
    () => buildGridTemplateColumns("zoneCompare", visibleColumns),
    [visibleColumns],
  );

  const kindBadge = (kind: DiffKind) => {
    const styles: Record<DiffKind, string> = {
      same: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
      different:
        "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
      "only-left":
        "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
      "only-right":
        "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
    };
    const labels: Record<DiffKind, string> = {
      same: t("Same", "Same"),
      different: t("Different", "Different"),
      "only-left": t("Only in {{name}}", {
        name: currentZone?.name ?? t("left", "left"),
        defaultValue: "Only in {{name}}",
      }),
      "only-right": t("Only in {{name}}", {
        name: compareZone?.name ?? t("right", "right"),
        defaultValue: "Only in {{name}}",
      }),
    };
    return (
      <span
        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${styles[kind]}`}
      >
        {labels[kind]}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {t("Zone Compare", "Zone Compare")}
        </h3>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label className="text-xs">
                {t("Current:", "Current:")}{" "}
                <span className="font-mono">
                  {currentZone?.name ?? currentZoneId}
                </span>
              </Label>
            </div>
            <div className="flex-1">
              <Label className="text-xs">
                {t("Compare With", "Compare With")}
              </Label>
              <Select value={compareZoneId} onValueChange={setCompareZoneId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue
                    placeholder={t("Select zone…", "Select zone…")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {otherZones.map((z) => (
                    <SelectItem key={z.id} value={z.id}>
                      {z.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              onClick={runComparison}
              disabled={loading || !compareZoneId}
            >
              {loading
                ? t("Comparing…", "Comparing…")
                : t("Compare", "Compare")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {stats && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded bg-green-100 px-2 py-1 dark:bg-green-900/30">
            {t("{{count}} identical", {
              count: stats.same,
              defaultValue: "{{count}} identical",
            })}
          </span>
          <span className="rounded bg-yellow-100 px-2 py-1 dark:bg-yellow-900/30">
            {t("{{count}} different", {
              count: stats.different,
              defaultValue: "{{count}} different",
            })}
          </span>
          <span className="rounded bg-blue-100 px-2 py-1 dark:bg-blue-900/30">
            {t("{{count}} only in {{name}}", {
              count: stats.onlyLeft,
              name: currentZone?.name ?? t("current", "current"),
              defaultValue: "{{count}} only in {{name}}",
            })}
          </span>
          <span className="rounded bg-purple-100 px-2 py-1 dark:bg-purple-900/30">
            {t("{{count}} only in {{name}}", {
              count: stats.onlyRight,
              name: compareZone?.name ?? t("compare", "compare"),
              defaultValue: "{{count}} only in {{name}}",
            })}
          </span>
          <button
            type="button"
            className="ml-auto text-xs text-primary underline"
            onClick={() => setShowSame(!showSame)}
          >
            {showSame
              ? t("Hide identical", "Hide identical")
              : t("Show identical", "Show identical")}
          </button>
          {onCopyRecords && compareZoneId && stats.onlyRight > 0 && (
            <button
              type="button"
              className="text-xs text-primary underline"
              onClick={() => {
                const missing =
                  diff
                    ?.filter((e) => e.kind === "only-right" && e.right)
                    .map((e) => e.right!) ?? [];
                onCopyRecords(missing, {
                  zoneId: compareZoneId,
                  zoneName: compareZone?.name ?? compareZoneId,
                });
              }}
            >
              {t("Copy {{count}} missing → current", {
                count: stats.onlyRight,
                defaultValue: "Copy {{count}} missing → current",
              })}
            </button>
          )}
        </div>
      )}

      {filteredDiff.length > 0 && (
        <div
          data-testid="zone-compare-table"
          className="max-h-96 overflow-auto rounded-md border"
        >
          <div
            className="grid gap-3 border-b bg-muted/40 px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {visibleColumns.map((column) => (
              <span key={column}>
                {t(columnLabels[column], columnLabels[column])}
              </span>
            ))}
          </div>
          <div className="divide-y">
            {filteredDiff.map((entry) => {
              const rec = entry.left ?? entry.right!;
              return (
                <div
                  key={entry.key}
                  className="grid items-start gap-3 px-3 py-2"
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  {visibleColumns.map((column) => {
                    switch (column) {
                      case "status":
                        return <div key={column}>{kindBadge(entry.kind)}</div>;
                      case "type":
                        return (
                          <span
                            key={column}
                            className="w-fit rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono font-semibold"
                          >
                            {rec.type}
                          </span>
                        );
                      case "name":
                        return (
                          <span
                            key={column}
                            className="truncate text-xs"
                            title={rec.name}
                          >
                            {rec.name}
                          </span>
                        );
                      case "content":
                        return (
                          <span
                            key={column}
                            className="truncate font-mono text-[11px] text-muted-foreground"
                            title={rec.content}
                          >
                            {rec.content}
                          </span>
                        );
                      case "ttl":
                        return (
                          <span
                            key={column}
                            className="text-[11px] text-muted-foreground"
                          >
                            {entry.left && entry.right
                              ? `${String(entry.left.ttl)} → ${String(entry.right.ttl)}`
                              : String(rec.ttl)}
                          </span>
                        );
                      case "proxied":
                        return (
                          <span
                            key={column}
                            className="text-[11px] text-muted-foreground"
                          >
                            {rec.proxied == null
                              ? "—"
                              : rec.proxied
                                ? t("Yes", "Yes")
                                : t("No", "No")}
                          </span>
                        );
                      default:
                        return null;
                    }
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {diff && filteredDiff.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {showSame
            ? t("No records found", "No records found")
            : t("All records are identical!", "All records are identical!")}
        </p>
      )}
    </div>
  );
}

export function ZoneCompare(props: ZoneCompareProps) {
  return (
    <ErrorBoundary label="zone-compare">
      <ZoneCompareInner {...props} />
    </ErrorBoundary>
  );
}
