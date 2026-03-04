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

interface PropagationResolverResult {
  resolver: string;
  label: string;
  records: string[];
  rcode: string;
  latency_ms: number;
  error?: string;
}

interface PropagationResult {
  domain: string;
  record_type: string;
  resolvers: PropagationResolverResult[];
  consistent: boolean;
  timestamp: string;
}

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"];

interface PropagationCheckerProps {
  zoneName?: string;
  checkDnsPropagation: (
    domain: string,
    recordType: string,
    extraResolvers?: string[],
  ) => Promise<unknown>;
}

function PropagationCheckerInner({ zoneName, checkDnsPropagation }: PropagationCheckerProps) {
  const { t } = useI18n();
  const [domain, setDomain] = useState(zoneName ?? "");
  const [recordType, setRecordType] = useState("A");
  const [result, setResult] = useState<PropagationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [watchInterval, setWatchInterval] = useState(15);
  const watchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [checkCount, setCheckCount] = useState(0);

  const check = useCallback(async () => {
    if (!domain.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = (await checkDnsPropagation(domain, recordType)) as PropagationResult;
      setResult(res);
      setCheckCount((c) => c + 1);
      // Auto-stop watch when fully propagated
      if (res.consistent && watching) {
        setWatching(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Propagation check failed", "Propagation check failed"));
    } finally {
      setLoading(false);
    }
  }, [domain, recordType, checkDnsPropagation, watching]);

  // Watch mode: poll at interval
  useEffect(() => {
    if (watching) {
      check(); // Run immediately on start
      watchRef.current = setInterval(check, watchInterval * 1000);
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
        <h3 className="text-lg font-semibold">{t("DNS Propagation Checker", "DNS Propagation Checker")}</h3>
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
                onKeyDown={(e) => e.key === "Enter" && check()}
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
              <Button size="sm" onClick={check} disabled={loading || !domain.trim()}>
                {loading ? t("Checking…", "Checking…") : t("Check", "Check")}
              </Button>
              <div className="flex items-end gap-1">
                <div className="w-16">
                  <Label className="text-[10px]">{t("Interval", "Interval")}</Label>
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

      {error && <p className="text-sm text-destructive">{error}</p>}

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
              {result.consistent ? t("Fully Propagated", "Fully Propagated") : t("Inconsistent", "Inconsistent")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("{{domain}} {{recordType}} — {{count}} resolvers", { domain: result.domain, recordType: result.record_type, count: result.resolvers.length, defaultValue: "{{domain}} {{recordType}} — {{count}} resolvers" })}
            </span>
          </div>

          {/* Resolver results */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("Resolver Results", "Resolver Results")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {result.resolvers.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-start justify-between rounded-md border px-3 py-2"
                  >
                    <div className="flex-1 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">{r.label}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {r.resolver}
                        </span>
                        <span className={`text-[10px] font-medium ${rcodeColor(r.rcode)}`}>
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
                        <p className="text-[11px] text-destructive">{r.error}</p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">{t("No records", "No records")}</p>
                      )}
                    </div>
                    <span className="ml-2 text-[10px] text-muted-foreground">
                      {r.latency_ms}ms
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <p className="text-[10px] text-muted-foreground">
            {t("Checked at {{time}}", { time: new Date(result.timestamp).toLocaleString(), defaultValue: "Checked at {{time}}" })}
            {checkCount > 1 && ` (${t("check #{{count}}", { count: checkCount, defaultValue: "check #{{count}}" })})`}
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
