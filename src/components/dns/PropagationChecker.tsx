/**
 * DNS Propagation Checker — queries multiple global resolvers to verify
 * DNS propagation status for a given record.
 */
import { useCallback, useState } from "react";
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
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

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
  const [domain, setDomain] = useState(zoneName ?? "");
  const [recordType, setRecordType] = useState("A");
  const [result, setResult] = useState<PropagationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!domain.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = (await checkDnsPropagation(domain, recordType)) as PropagationResult;
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Propagation check failed");
    } finally {
      setLoading(false);
    }
  }, [domain, recordType, checkDnsPropagation]);

  const rcodeColor = (rcode: string) => {
    if (rcode === "NOERROR") return "text-green-600 dark:text-green-400";
    if (rcode === "NXDOMAIN") return "text-yellow-600 dark:text-yellow-400";
    return "text-red-600 dark:text-red-400";
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">DNS Propagation Checker</h3>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-2">
            <div className="flex-1 min-w-[200px]">
              <Label className="text-xs">Domain</Label>
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
                className="h-8 text-xs font-mono"
                onKeyDown={(e) => e.key === "Enter" && check()}
              />
            </div>
            <div className="w-28">
              <Label className="text-xs">Type</Label>
              <Select value={recordType} onValueChange={setRecordType}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECORD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button size="sm" onClick={check} disabled={loading || !domain.trim()}>
                {loading ? "Checking…" : "Check"}
              </Button>
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
              {result.consistent ? "Fully Propagated" : "Inconsistent"}
            </span>
            <span className="text-xs text-muted-foreground">
              {result.domain} {result.record_type} — {result.resolvers.length} resolvers
            </span>
          </div>

          {/* Resolver results */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Resolver Results</CardTitle>
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
                        <p className="text-[11px] text-muted-foreground">No records</p>
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
            Checked at {new Date(result.timestamp).toLocaleString()}
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
