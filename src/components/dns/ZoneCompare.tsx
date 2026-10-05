/**
 * Zone Comparison panel — side-by-side diff of DNS records between two zones.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { prepareCopiedDnsRecord } from "@/lib/dns/record-copy";
import type { DNSRecord, Zone } from "@/types/dns";

type DiffKind = "only-left" | "only-right" | "different" | "same";

/** One row of the comparison: a matched pair, or a record unique to one zone. */
export interface ZoneDiffEntry {
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

/**
 * Neutral zone name both sides are projected onto before they are keyed.
 *
 * Comparing two zones by fully-qualified name is meaningless: `www.a.example`
 * and `www.b.test` are the same record expressed in two namespaces. Rewriting
 * every in-zone reference to a shared placeholder makes them collide, which is
 * what the diff needs.
 *
 * The placeholder is deliberately a *third* name rather than "rewrite the left
 * zone into the right one". That keeps the comparison symmetric and avoids a
 * false match: a left-hand record that references the right zone by name is an
 * external reference from its own point of view, and must not be confused with
 * a right-hand record that references its own zone. `.invalid` is reserved by
 * RFC 2606, so it can never collide with a real zone.
 */
const COMPARISON_ZONE = "zone-compare.invalid";
const COMPARISON_SUFFIX = `.${COMPARISON_ZONE}`;

/**
 * Breathing room kept below the diff table so the card padding and page
 * bottom inset stay visible instead of being covered by the table's edge.
 */
const TABLE_BOTTOM_INSET_PX = 64;
/** Never squash the table below this even in a very short window. */
const TABLE_MIN_HEIGHT_PX = 240;

/**
 * Sizes the diff table to the space left in the scrolling workspace below its
 * own top edge, so the rows scroll inside the real remaining viewport rather
 * than a small fixed box the user has to scroll twice. The controls above the
 * table vary in height (filters, stats, copy links), so the offset is measured
 * rather than hard-coded; the measurement follows window and content resizes.
 */
function useFillRemainingHeight<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  const [maxHeight, setMaxHeight] = useState<number>();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) {
      setMaxHeight(undefined);
      return;
    }
    const scroller =
      el.closest<HTMLElement>(".app-shell-workspace-scroll") ?? null;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      let top: number;
      let available: number;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        top = rect.top - box.top + scroller.scrollTop;
        available = scroller.clientHeight;
      } else {
        top = rect.top + window.scrollY;
        available = window.innerHeight;
      }
      setMaxHeight(
        Math.max(TABLE_MIN_HEIGHT_PX, available - top - TABLE_BOTTOM_INSET_PX),
      );
    };

    measure();
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => measure())
        : null;
    if (observer) {
      if (scroller) observer.observe(scroller);
      if (el.parentElement) observer.observe(el.parentElement);
    }
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [active]);

  return { ref, maxHeight };
}

/** Characters that continue a DNS label, used for whole-label boundary tests. */
const LABEL_CHARACTER = /[\p{L}\p{N}_-]/u;

interface CanonicalRecord {
  record: DNSRecord;
  /** Uppercased record type. */
  type: string;
  /** Zone-relative owner label; `@` for the apex. */
  label: string;
  /** Record content with in-zone references projected onto the placeholder. */
  content: string;
  /**
   * True when the content still names its own zone after projection, i.e. the
   * rewriter could not confidently map it (an unparseable SPF policy, a bare
   * TXT value that happens to embed the domain, …). Such a record is never
   * reported as identical: a false "identical" would let someone skip copying a
   * record they actually needed, while a false "different" is only noise.
   */
  unresolved: boolean;
}

/** Strip the placeholder suffix, collapsing the apex to `@`. */
function zoneRelativeLabel(name: string): string {
  const bare = (name.endsWith(".") ? name.slice(0, -1) : name).toLowerCase();
  if (!bare || bare === "@" || bare === COMPARISON_ZONE) return "@";
  return bare.endsWith(COMPARISON_SUFFIX)
    ? bare.slice(0, -COMPARISON_SUFFIX.length)
    : bare;
}

/** Whether `content` still contains `zoneName` as a whole-label reference. */
function referencesZone(content: string, zoneName: string): boolean {
  const zone = zoneName.trim().replace(/\.$/u, "").toLowerCase();
  if (!zone) return false;
  const haystack = content.toLowerCase();

  for (
    let index = haystack.indexOf(zone);
    index !== -1;
    index = haystack.indexOf(zone, index + 1)
  ) {
    const before = index === 0 ? "" : (haystack[index - 1] ?? "");
    const after = haystack[index + zone.length] ?? "";
    if (!LABEL_CHARACTER.test(before) && !LABEL_CHARACTER.test(after)) {
      return true;
    }
  }
  return false;
}

/**
 * Project one record out of its own zone and into {@link COMPARISON_ZONE}.
 *
 * Content rewriting is delegated wholesale to `prepareCopiedDnsRecord`, which
 * already knows which part of a CNAME/MX/NS/PTR/SRV/SVCB/NAPTR/RP/URI/SPF/DMARC
 * payload is an in-zone hostname — and, just as importantly, when to leave a
 * payload alone. Reimplementing that here would only produce a weaker second
 * copy that drifts from the paste path.
 */
function canonicalizeRecord(
  record: DNSRecord,
  zoneName: string,
): CanonicalRecord {
  const prepared = prepareCopiedDnsRecord(
    record,
    zoneName,
    COMPARISON_ZONE,
    true,
  );
  return {
    record,
    type: record.type.toUpperCase(),
    label: zoneRelativeLabel(prepared.name),
    content: prepared.content,
    unresolved: referencesZone(prepared.content, zoneName),
  };
}

/** Identity of a record: type + owner + normalized content. */
function contentKey(record: CanonicalRecord): string {
  return `${record.type}\u0000${record.label}\u0000${record.content}`;
}

/** Identity of a record *slot*: type + owner, ignoring content. */
function ownerKey(record: CanonicalRecord): string {
  return `${record.type}\u0000${record.label}`;
}

function bucketBy(
  records: readonly CanonicalRecord[],
  keyOf: (record: CanonicalRecord) => string,
): Map<string, CanonicalRecord[]> {
  const buckets = new Map<string, CanonicalRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    const existing = buckets.get(key);
    if (existing) existing.push(record);
    else buckets.set(key, [record]);
  }
  return buckets;
}

function nullish<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/**
 * Settings that are *not* part of a record's identity. Two records with the
 * same type, owner and content but a different TTL or proxy flag are one record
 * with a differing setting — exactly what a comparison tool exists to surface —
 * so these are compared rather than folded into the key.
 */
function settingsMatch(left: DNSRecord, right: DNSRecord): boolean {
  return (
    left.ttl === right.ttl &&
    nullish(left.proxied) === nullish(right.proxied) &&
    nullish(left.priority) === nullish(right.priority)
  );
}

/**
 * Diff two zones' records zone-relatively.
 *
 * Matching runs in two passes so all three classifications stay reachable:
 *
 * 1. exact — same type, same zone-relative owner, same normalized content.
 *    These are `same`, or `different` when only TTL/proxy/priority diverge.
 * 2. owner — leftovers that share a type and owner are the same record with
 *    differing content, so they pair up as `different` rather than being
 *    reported twice as "only in …".
 *
 * Whatever is still unpaired genuinely exists in one zone only.
 */
export function computeZoneDiff(
  left: readonly DNSRecord[],
  right: readonly DNSRecord[],
  leftZoneName: string,
  rightZoneName: string,
): ZoneDiffEntry[] {
  const leftRecords = left.map((r) => canonicalizeRecord(r, leftZoneName));
  const rightRecords = right.map((r) => canonicalizeRecord(r, rightZoneName));

  const entries: ZoneDiffEntry[] = [];
  let sequence = 0;
  const nextKey = (base: string) => `${base}#${sequence++}`;

  const leftByContent = bucketBy(leftRecords, contentKey);
  const rightByContent = bucketBy(rightRecords, contentKey);
  const pendingLeft: CanonicalRecord[] = [];
  const pendingRight: CanonicalRecord[] = [];

  for (const [key, records] of leftByContent) {
    const counterparts = rightByContent.get(key) ?? [];
    const paired = Math.min(records.length, counterparts.length);
    for (let index = 0; index < paired; index++) {
      const l = records[index]!;
      const r = counterparts[index]!;
      const identical =
        !l.unresolved && !r.unresolved && settingsMatch(l.record, r.record);
      entries.push({
        kind: identical ? "same" : "different",
        key: nextKey(key),
        left: l.record,
        right: r.record,
      });
    }
    pendingLeft.push(...records.slice(paired));
  }

  for (const [key, records] of rightByContent) {
    const paired = Math.min(
      records.length,
      leftByContent.get(key)?.length ?? 0,
    );
    pendingRight.push(...records.slice(paired));
  }

  const pendingRightByOwner = bucketBy(pendingRight, ownerKey);
  const consumed = new Set<CanonicalRecord>();
  for (const l of pendingLeft) {
    const counterpart = pendingRightByOwner.get(ownerKey(l))?.shift();
    if (counterpart) {
      consumed.add(counterpart);
      entries.push({
        kind: "different",
        key: nextKey(contentKey(l)),
        left: l.record,
        right: counterpart.record,
      });
    } else {
      entries.push({
        kind: "only-left",
        key: nextKey(contentKey(l)),
        left: l.record,
      });
    }
  }
  for (const r of pendingRight) {
    if (consumed.has(r)) continue;
    entries.push({
      kind: "only-right",
      key: nextKey(contentKey(r)),
      right: r.record,
    });
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
  /**
   * Preselects the zone to compare against. The picker owns the value from
   * then on; this only seeds it.
   */
  defaultCompareZoneId?: string;
}

function ZoneCompareInner({
  zones,
  currentZoneId,
  getDNSRecords,
  onCopyRecords,
  columns,
  defaultCompareZoneId = "",
}: ZoneCompareProps) {
  const { t } = useI18n();
  const [compareZoneId, setCompareZoneId] = useState(defaultCompareZoneId);
  const [diff, setDiff] = useState<ZoneDiffEntry[] | null>(null);
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
      // The zone list is authoritative, but records carry `zone_name` too, so
      // a comparison still normalizes correctly if the zone is not in `zones`.
      const zoneName = (id: string, records: readonly DNSRecord[]) =>
        zones.find((z) => z.id === id)?.name ?? records[0]?.zone_name ?? "";
      setDiff(
        computeZoneDiff(
          leftRecords,
          rightRecords,
          zoneName(currentZoneId, leftRecords),
          zoneName(compareZoneId, rightRecords),
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("Comparison failed", "Comparison failed"),
      );
    } finally {
      setLoading(false);
    }
  }, [currentZoneId, compareZoneId, getDNSRecords, zones, t]);

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

  const { ref: tableRef, maxHeight: tableMaxHeight } =
    useFillRemainingHeight<HTMLDivElement>(filteredDiff.length > 0);

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
          ref={tableRef}
          data-testid="zone-compare-table"
          className="scrollbar-themed overflow-auto [scrollbar-gutter:auto] rounded-md border"
          style={
            tableMaxHeight === undefined
              ? undefined
              : { maxHeight: `${tableMaxHeight}px` }
          }
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
              // A matched pair can differ on any of these; show both sides so
              // "different" says *what* is different.
              const sideBySide = (left: string, right: string) =>
                left === right ? left : `${left} → ${right}`;
              return (
                <div
                  key={entry.key}
                  data-diff-row={entry.kind}
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
                      case "content": {
                        const content =
                          entry.left && entry.right
                            ? sideBySide(
                                entry.left.content,
                                entry.right.content,
                              )
                            : rec.content;
                        return (
                          <span
                            key={column}
                            className="truncate font-mono text-[11px] text-muted-foreground"
                            title={content}
                          >
                            {content}
                          </span>
                        );
                      }
                      case "ttl":
                        return (
                          <span
                            key={column}
                            className="text-[11px] text-muted-foreground"
                          >
                            {entry.left && entry.right
                              ? sideBySide(
                                  String(entry.left.ttl),
                                  String(entry.right.ttl),
                                )
                              : String(rec.ttl)}
                          </span>
                        );
                      case "proxied": {
                        const proxyLabel = (value?: boolean | null) =>
                          value == null
                            ? "—"
                            : value
                              ? t("Yes", "Yes")
                              : t("No", "No");
                        return (
                          <span
                            key={column}
                            className="text-[11px] text-muted-foreground"
                          >
                            {entry.left && entry.right
                              ? sideBySide(
                                  proxyLabel(entry.left.proxied),
                                  proxyLabel(entry.right.proxied),
                                )
                              : proxyLabel(rec.proxied)}
                          </span>
                        );
                      }
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
