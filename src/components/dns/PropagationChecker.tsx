/**
 * DNS Propagation Checker — queries multiple global resolvers to verify
 * DNS propagation status for a given record.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { useI18n } from "@/hooks/use-i18n";
import { formatRequestError } from "@/lib/api/request-error";

export interface PropagationResolverResult {
  resolver: string;
  label: string;
  records: string[];
  rcode: string;
  latency_ms: number;
  error?: string;
}

export interface PropagationResult {
  domain: string;
  record_type: string;
  resolvers: PropagationResolverResult[];
  consistent: boolean;
  timestamp: string;
  warnings: string[];
}

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"];

interface PropagationCheckerProps {
  zoneName?: string;
  checkDnsPropagation: (
    domain: string,
    recordType: string,
    extraResolvers?: string[],
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

interface PropagationRequestContext {
  domain: string;
  recordType: string;
  receivedAt?: Date;
}

class PropagationResponseError extends Error {
  readonly name = "PropagationResponseError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeRecordValues(
  value: unknown,
  resolverNumber: number,
  warnings: string[],
): string[] {
  if (value === undefined || value === null) {
    warnings.push(
      `Resolver ${resolverNumber} omitted its records array; it was treated as empty.`,
    );
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(
      `Resolver ${resolverNumber} returned a non-array records field; it was treated as empty.`,
    );
    return [];
  }

  const records = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  if (records.length !== value.length) {
    warnings.push(
      `Resolver ${resolverNumber} included invalid record values; those values were ignored.`,
    );
  }
  return records;
}

function normalizeResolverResult(
  value: unknown,
  index: number,
  warnings: string[],
): PropagationResolverResult {
  const resolverNumber = index + 1;
  if (!isRecord(value)) {
    warnings.push(
      `Resolver ${resolverNumber} returned an invalid response entry; a safe failure row is shown.`,
    );
    return {
      resolver: "unknown",
      label: `Resolver ${resolverNumber}`,
      records: [],
      rcode: "SERVFAIL",
      latency_ms: 0,
      error: "Malformed resolver response",
    };
  }

  const resolver =
    nonEmptyString(value.resolver) ?? `unknown-${resolverNumber}`;
  const label =
    nonEmptyString(value.label) ??
    nonEmptyString(value.resolver_label) ??
    resolver;
  const records = normalizeRecordValues(
    value.records ?? value.answers,
    resolverNumber,
    warnings,
  );
  const error = nonEmptyString(value.error);
  const rcode = nonEmptyString(value.rcode) ?? (error ? "SERVFAIL" : "UNKNOWN");
  const latency = finiteNonNegativeNumber(value.latency_ms);

  if (
    value.resolver === undefined ||
    (value.label === undefined && value.resolver_label === undefined) ||
    value.rcode === undefined ||
    latency === undefined
  ) {
    warnings.push(
      `Resolver ${resolverNumber} returned an incomplete response; missing fields were replaced with safe defaults.`,
    );
  }

  return {
    resolver,
    label,
    records,
    rcode,
    latency_ms: latency ?? 0,
    ...(error ? { error } : {}),
  };
}

function inferConsistency(resolvers: PropagationResolverResult[]): boolean {
  const successfulRecords = resolvers
    .filter((resolver) => !resolver.error && resolver.rcode === "NOERROR")
    .map((resolver) => [...resolver.records].sort());
  if (successfulRecords.length === 0) return false;
  const first = JSON.stringify(successfulRecords[0]);
  return successfulRecords.every(
    (records) => JSON.stringify(records) === first,
  );
}

/**
 * Normalize both the web response (`resolvers`, `label`, `records`) and the
 * native Rust response (`results`, `resolver_label`, `answers`) at one boundary.
 */
export function normalizePropagationResult(
  value: unknown,
  { domain, recordType, receivedAt = new Date() }: PropagationRequestContext,
): PropagationResult {
  if (!isRecord(value)) {
    throw new PropagationResponseError(
      "Propagation lookup returned no usable response. Retry the lookup; if it continues, inspect the request diagnostics.",
    );
  }

  const warnings: string[] = [];
  const resolverValue =
    value.resolvers !== undefined ? value.resolvers : value.results;
  let rawResolvers: unknown[];
  if (resolverValue === null) {
    warnings.push(
      "The provider returned a null resolver-results array; it was treated as empty.",
    );
    rawResolvers = [];
  } else if (Array.isArray(resolverValue)) {
    rawResolvers = resolverValue;
  } else {
    throw new PropagationResponseError(
      "Propagation lookup returned an invalid response: the resolver-results array is missing. Retry the lookup; if it continues, inspect the request diagnostics.",
    );
  }

  const resolvers = rawResolvers.map((resolver, index) =>
    normalizeResolverResult(resolver, index, warnings),
  );
  const timestamp = nonEmptyString(value.timestamp);
  const parsedTimestamp = timestamp ? Date.parse(timestamp) : Number.NaN;

  return {
    domain: nonEmptyString(value.domain) ?? domain,
    record_type:
      nonEmptyString(value.record_type) ??
      nonEmptyString(value.recordType) ??
      recordType,
    resolvers,
    consistent:
      typeof value.consistent === "boolean"
        ? value.consistent
        : inferConsistency(resolvers),
    timestamp: Number.isFinite(parsedTimestamp)
      ? new Date(parsedTimestamp).toISOString()
      : receivedAt.toISOString(),
    warnings: Array.from(new Set(warnings)),
  };
}

function PropagationCheckerInner({
  zoneName,
  checkDnsPropagation,
}: PropagationCheckerProps) {
  const { t } = useI18n();
  const [domain, setDomain] = useState(zoneName ?? "");
  const [recordType, setRecordType] = useState("A");
  const [result, setResult] = useState<PropagationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [watchInterval, setWatchInterval] = useState(15);
  const watchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestRef = useRef<{
    id: number;
    controller: AbortController;
  } | null>(null);
  const nextRequestIdRef = useRef(0);
  const [checkCount, setCheckCount] = useState(0);

  const check = useCallback(async () => {
    const requestedDomain = domain.trim();
    if (!requestedDomain) return;

    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const requestId = ++nextRequestIdRef.current;
    requestRef.current = { id: requestId, controller };
    setLoading(true);
    setError(null);
    try {
      const rawResult = await checkDnsPropagation(
        requestedDomain,
        recordType,
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted || requestRef.current?.id !== requestId) {
        return;
      }
      const res = normalizePropagationResult(rawResult, {
        domain: requestedDomain,
        recordType,
      });
      setResult(res);
      setCheckCount((c) => c + 1);
      // Auto-stop watch when fully propagated
      if (res.consistent && watching) {
        setWatching(false);
      }
    } catch (err) {
      if (controller.signal.aborted || requestRef.current?.id !== requestId) {
        return;
      }
      setResult(null);
      setError(
        err instanceof PropagationResponseError
          ? err.message
          : formatRequestError(err),
      );
    } finally {
      if (requestRef.current?.id === requestId) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [domain, recordType, checkDnsPropagation, watching]);

  useEffect(
    () => () => {
      requestRef.current?.controller.abort();
      requestRef.current = null;
    },
    [],
  );

  // Watch mode: poll at interval
  useEffect(() => {
    if (watching) {
      void check(); // Run immediately on start
      watchRef.current = setInterval(() => {
        void check();
      }, watchInterval * 1000);
    } else if (watchRef.current) {
      clearInterval(watchRef.current);
      watchRef.current = null;
    }
    return () => {
      if (watchRef.current) {
        clearInterval(watchRef.current);
        watchRef.current = null;
      }
    };
  }, [watching, watchInterval, check]);

  const toggleWatch = () => {
    if (watching) {
      requestRef.current?.controller.abort();
      requestRef.current = null;
      setLoading(false);
      setWatching(false);
    } else {
      setCheckCount(0);
      setWatching(true);
    }
  };

  const rcodeColor = (rcode: string) => {
    if (rcode === "NOERROR") return "text-green-600 dark:text-green-400";
    if (rcode === "NXDOMAIN") return "text-yellow-600 dark:text-yellow-400";
    return "text-red-600 dark:text-red-400";
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {t("DNS Propagation Checker", "DNS Propagation Checker")}
        </h3>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-2">
            <div className="flex-1 min-w-[200px]">
              <Label className="text-xs">{t("Domain", "Domain")}</Label>
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder={t("example.com", "example.com")}
                className="h-8 text-xs font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void check();
                }}
              />
            </div>
            <div className="w-28">
              <Label className="text-xs">{t("Type", "Type")}</Label>
              <Select value={recordType} onValueChange={setRecordType}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECORD_TYPES.map((rt) => (
                    <SelectItem key={rt} value={rt}>
                      {rt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-1">
              <Button
                size="sm"
                onClick={() => void check()}
                disabled={loading || !domain.trim()}
              >
                {loading ? t("Checking…", "Checking…") : t("Check", "Check")}
              </Button>
              <div className="flex items-end gap-1">
                <div className="w-16">
                  <Label className="text-[10px]">
                    {t("Interval", "Interval")}
                  </Label>
                  <Select
                    value={String(watchInterval)}
                    onValueChange={(v) => setWatchInterval(parseInt(v, 10))}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[10, 15, 30, 60].map((s) => (
                        <SelectItem key={s} value={String(s)}>
                          {s}s
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="sm"
                  variant={watching ? "destructive" : "outline"}
                  onClick={toggleWatch}
                  disabled={!domain.trim()}
                >
                  {watching ? t("Stop", "Stop") : t("Watch", "Watch")}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div
          className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          role="alert"
        >
          <p className="min-w-0 flex-1 break-words text-sm text-destructive">
            {error}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void check()}
            disabled={loading || !domain.trim()}
          >
            {t("Retry", "Retry")}
          </Button>
        </div>
      )}

      {result && (
        <div className="space-y-3">
          {/* Consistency badge */}
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                result.consistent
                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                  : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${result.consistent ? "bg-green-500" : "bg-yellow-500"}`}
              />
              {result.consistent
                ? t("Fully Propagated", "Fully Propagated")
                : t("Inconsistent", "Inconsistent")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("{{domain}} {{recordType}} — {{count}} resolvers", {
                domain: result.domain,
                recordType: result.record_type,
                count: result.resolvers.length,
                defaultValue: "{{domain}} {{recordType}} — {{count}} resolvers",
              })}
            </span>
          </div>

          {result.warnings.length > 0 && (
            <div
              className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-3 text-xs text-yellow-700 dark:text-yellow-300"
              data-testid="propagation-response-warning"
              role="status"
            >
              <p className="font-medium">
                {t(
                  "Some resolver responses were incomplete.",
                  "Some resolver responses were incomplete.",
                )}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Resolver results */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                {t("Resolver Results", "Resolver Results")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {result.resolvers.length === 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-3">
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "No resolver results were returned.",
                      "No resolver results were returned.",
                    )}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void check()}
                    disabled={loading || !domain.trim()}
                  >
                    {t("Retry", "Retry")}
                  </Button>
                </div>
              ) : (
                <div className="space-y-1">
                  {result.resolvers.map((r, i) => (
                    <div
                      key={`${r.resolver}-${i}`}
                      className="flex items-start justify-between rounded-md border px-3 py-2"
                    >
                      <div className="flex-1 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">{r.label}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {r.resolver}
                          </span>
                          <span
                            className={`text-[10px] font-medium ${rcodeColor(r.rcode)}`}
                          >
                            {r.rcode}
                          </span>
                        </div>
                        {r.records.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {r.records.map((rec, j) => (
                              <span
                                key={j}
                                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                              >
                                {rec}
                              </span>
                            ))}
                          </div>
                        ) : r.error ? (
                          <p className="text-[11px] text-destructive">
                            {r.error}
                          </p>
                        ) : (
                          <p className="text-[11px] text-muted-foreground">
                            {t("No records", "No records")}
                          </p>
                        )}
                      </div>
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        {r.latency_ms}ms
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <p className="text-[10px] text-muted-foreground">
            {t("Checked at {{time}}", {
              time: new Date(result.timestamp).toLocaleString(),
              defaultValue: "Checked at {{time}}",
            })}
            {checkCount > 1 &&
              ` (${t("check #{{count}}", { count: checkCount, defaultValue: "check #{{count}}" })})`}
            {watching && " — " + t("watching…", "watching…")}
          </p>
        </div>
      )}
    </div>
  );
}

export function PropagationChecker(props: PropagationCheckerProps) {
  return (
    <ErrorBoundary label="propagation">
      <PropagationCheckerInner {...props} />
    </ErrorBoundary>
  );
}
