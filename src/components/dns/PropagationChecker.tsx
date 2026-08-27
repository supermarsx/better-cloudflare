/**
 * DNS Propagation Checker — queries multiple global resolvers to verify
 * DNS propagation status for a given record.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
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
import { usePropagationSettings } from "@/hooks/dns/use-propagation-settings";
import {
  isCataloguePropagationResolverId,
  isResolverIpLiteral,
  PROPAGATION_RESOLVER_CATALOGUE,
  PROPAGATION_SETTING_LIMITS,
  resolvePropagationSettings,
  type PropagationCheckOptions,
  type PropagationResolverEntry,
} from "@/lib/dns/propagation-resolvers";
import { retainUtf8 } from "./rendererSafety";

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
  /** Resolvers whose answer set matched the majority answer set. */
  agreeing: number;
  /** Threshold (50–100) the `consistent` verdict was judged against. */
  consensusPercent: number;
  timestamp: string;
  warnings: string[];
}

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"];
const WATCH_INTERVAL_OPTIONS = [5, 10, 15, 30, 60, 120, 300];
const ATTEMPT_OPTIONS = [1, 2, 3];
const CONSENSUS_OPTIONS = [100, 90, 75, 50];
export const PROPAGATION_LIMITS = Object.freeze({
  resolvers: 200,
  renderedResolvers: 100,
  answersPerResolver: 50,
  renderedAnswersPerResolver: 20,
  warnings: 32,
  stringBytes: 4 * 1024,
  identityBytes: 512,
  aggregateBytes: 512 * 1024,
  queryBytes: 512,
});

interface PropagationCheckerProps {
  zoneName?: string;
  checkDnsPropagation: (
    domain: string,
    recordType: string,
    extraResolvers?: string[],
    signal?: AbortSignal,
    options?: PropagationCheckOptions,
  ) => Promise<unknown>;
}

interface PropagationRequestContext {
  domain: string;
  recordType: string;
  receivedAt?: Date;
  /** Threshold used when the provider omits `consistent` / `agreeing`. */
  consensusPercent?: number;
}

class PropagationResponseError extends Error {
  readonly name = "PropagationResponseError";
}

type PropagationLimitStats = {
  truncatedStrings: number;
  omittedStrings: number;
};

class PropagationWarningCollector {
  readonly items: string[] = [];
  private omitted = 0;

  add(message: string): void {
    if (this.items.length < PROPAGATION_LIMITS.warnings - 1) {
      this.items.push(message);
    } else {
      this.omitted += 1;
    }
  }

  addPriority(message: string): void {
    if (this.items.includes(message)) return;
    this.items.unshift(message);
    if (this.items.length >= PROPAGATION_LIMITS.warnings) {
      this.items.pop();
      this.omitted += 1;
    }
  }

  finish(): string[] {
    if (this.omitted > 0) {
      this.items.push(
        `${this.omitted.toLocaleString()} additional safety warnings were omitted.`,
      );
    }
    return Array.from(new Set(this.items)).slice(
      0,
      PROPAGATION_LIMITS.warnings,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retainPropagationString(
  value: unknown,
  perStringBytes: number,
  budget: { remaining: number },
  stats: PropagationLimitStats,
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (budget.remaining <= 0) {
    stats.omittedStrings += 1;
    return undefined;
  }
  const allowedBytes = Math.min(perStringBytes, budget.remaining);
  const retained = retainUtf8(value, allowedBytes);
  if (retained.truncated) stats.truncatedStrings += 1;
  budget.remaining -= retained.bytes;
  const trimmed = retained.value.trim();
  return trimmed || undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeRecordValues(
  value: unknown,
  resolverNumber: number,
  warnings: PropagationWarningCollector,
  budget: { remaining: number },
  stats: PropagationLimitStats,
): string[] {
  if (value === undefined || value === null) {
    warnings.add(
      `Resolver ${resolverNumber} omitted its records array; it was treated as empty.`,
    );
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.add(
      `Resolver ${resolverNumber} returned a non-array records field; it was treated as empty.`,
    );
    return [];
  }

  const records: string[] = [];
  let invalidValues = 0;
  const answerCount = Math.min(
    value.length,
    PROPAGATION_LIMITS.answersPerResolver,
  );
  for (let index = 0; index < answerCount; index += 1) {
    if (typeof value[index] !== "string") {
      invalidValues += 1;
      continue;
    }
    const record = retainPropagationString(
      value[index],
      PROPAGATION_LIMITS.stringBytes,
      budget,
      stats,
    );
    if (record !== undefined) records.push(record);
  }
  if (invalidValues > 0) {
    warnings.add(
      `Resolver ${resolverNumber} included invalid record values; those values were ignored.`,
    );
  }
  if (value.length > PROPAGATION_LIMITS.answersPerResolver) {
    warnings.add(
      `Resolver ${resolverNumber} returned ${value.length.toLocaleString()} answers; only the first ${PROPAGATION_LIMITS.answersPerResolver} were retained.`,
    );
  }
  return records;
}

function normalizeResolverResult(
  value: unknown,
  index: number,
  warnings: PropagationWarningCollector,
  budget: { remaining: number },
  stats: PropagationLimitStats,
): PropagationResolverResult {
  const resolverNumber = index + 1;
  if (!isRecord(value)) {
    warnings.add(
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
    retainPropagationString(
      value.resolver,
      PROPAGATION_LIMITS.identityBytes,
      budget,
      stats,
    ) ?? `unknown-${resolverNumber}`;
  const label =
    retainPropagationString(
      value.label,
      PROPAGATION_LIMITS.identityBytes,
      budget,
      stats,
    ) ??
    retainPropagationString(
      value.resolver_label,
      PROPAGATION_LIMITS.identityBytes,
      budget,
      stats,
    ) ??
    resolver;
  const records = normalizeRecordValues(
    value.records ?? value.answers,
    resolverNumber,
    warnings,
    budget,
    stats,
  );
  const error = retainPropagationString(
    value.error,
    PROPAGATION_LIMITS.stringBytes,
    budget,
    stats,
  );
  const rcode =
    retainPropagationString(
      value.rcode,
      PROPAGATION_LIMITS.identityBytes,
      budget,
      stats,
    ) ?? (error ? "SERVFAIL" : "UNKNOWN");
  const latency = finiteNonNegativeNumber(value.latency_ms);

  if (
    value.resolver === undefined ||
    (value.label === undefined && value.resolver_label === undefined) ||
    value.rcode === undefined ||
    latency === undefined
  ) {
    warnings.add(
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

function boundedTopLevelString(
  value: unknown,
  fallback: string,
  maxBytes: number,
  budget: { remaining: number },
  stats: PropagationLimitStats,
): string {
  return (
    retainPropagationString(value, maxBytes, budget, stats) ??
    retainUtf8(fallback, maxBytes).value
  );
}

/**
 * Mirror of the Rust `compute_consensus`: among resolvers that answered
 * NOERROR without error, find the most common sorted answer set; the check is
 * consistent when that set covers at least `percent` of the successful
 * resolvers. At 100 % this is "every successful resolver agrees".
 */
/** A resolver counts toward the consensus threshold only when it answered NOERROR without error. */
function isAnsweringResolver(resolver: PropagationResolverResult): boolean {
  return !resolver.error && resolver.rcode === "NOERROR";
}

function countAnsweringResolvers(
  resolvers: PropagationResolverResult[],
): number {
  return resolvers.filter(isAnsweringResolver).length;
}

function inferConsistency(
  resolvers: PropagationResolverResult[],
  percent: number = PROPAGATION_SETTING_LIMITS.consensusPercent.default,
): { consistent: boolean; agreeing: number } {
  const counts = new Map<string, number>();
  let successful = 0;
  for (const resolver of resolvers) {
    if (!isAnsweringResolver(resolver)) continue;
    successful += 1;
    const key = JSON.stringify([...resolver.records].sort());
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let agreeing = 0;
  for (const count of counts.values()) {
    if (count > agreeing) agreeing = count;
  }
  if (successful === 0) return { consistent: false, agreeing: 0 };
  return { consistent: (agreeing / successful) * 100 >= percent, agreeing };
}

/**
 * Normalize both the web response (`resolvers`, `label`, `records`) and the
 * native Rust response (`results`, `resolver_label`, `answers`) at one boundary.
 */
export function normalizePropagationResult(
  value: unknown,
  {
    domain,
    recordType,
    receivedAt = new Date(),
    consensusPercent: requestedConsensus,
  }: PropagationRequestContext,
): PropagationResult {
  if (!isRecord(value)) {
    throw new PropagationResponseError(
      "Propagation lookup returned no usable response. Retry the lookup; if it continues, inspect the request diagnostics.",
    );
  }

  const warnings = new PropagationWarningCollector();
  const stats: PropagationLimitStats = {
    truncatedStrings: 0,
    omittedStrings: 0,
  };
  const budget = { remaining: PROPAGATION_LIMITS.aggregateBytes };
  const resolverValue =
    value.resolvers !== undefined ? value.resolvers : value.results;
  let rawResolvers: unknown[];
  if (resolverValue === null) {
    warnings.add(
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

  const retainedResolverCount = Math.min(
    rawResolvers.length,
    PROPAGATION_LIMITS.resolvers,
  );
  const resolvers = new Array<PropagationResolverResult>(retainedResolverCount);
  for (let index = 0; index < retainedResolverCount; index += 1) {
    resolvers[index] = normalizeResolverResult(
      rawResolvers[index],
      index,
      warnings,
      budget,
      stats,
    );
  }
  if (rawResolvers.length > PROPAGATION_LIMITS.resolvers) {
    warnings.addPriority(
      `${(
        rawResolvers.length - PROPAGATION_LIMITS.resolvers
      ).toLocaleString()} resolver entries were not retained because the ${PROPAGATION_LIMITS.resolvers}-resolver limit was reached.`,
    );
  }
  const timestamp = retainPropagationString(
    value.timestamp,
    PROPAGATION_LIMITS.identityBytes,
    budget,
    stats,
  );
  const parsedTimestamp = timestamp ? Date.parse(timestamp) : Number.NaN;
  const normalizedDomain = boundedTopLevelString(
    value.domain,
    domain,
    PROPAGATION_LIMITS.identityBytes,
    budget,
    stats,
  );
  const normalizedRecordType =
    retainPropagationString(
      value.record_type,
      PROPAGATION_LIMITS.identityBytes,
      budget,
      stats,
    ) ??
    boundedTopLevelString(
      value.recordType,
      recordType,
      PROPAGATION_LIMITS.identityBytes,
      budget,
      stats,
    );
  if (stats.truncatedStrings > 0) {
    warnings.addPriority(
      `${stats.truncatedStrings.toLocaleString()} oversized propagation strings were truncated to the per-string or aggregate UTF-8 byte limit.`,
    );
  }
  if (stats.omittedStrings > 0 || budget.remaining === 0) {
    warnings.addPriority(
      `${stats.omittedStrings.toLocaleString()} propagation strings were omitted after the ${PROPAGATION_LIMITS.aggregateBytes.toLocaleString()}-byte retained-payload budget was exhausted.`,
    );
  }

  const consensusPercent = Math.round(
    finiteNonNegativeNumber(value.consensus_percent) ??
      requestedConsensus ??
      PROPAGATION_SETTING_LIMITS.consensusPercent.default,
  );
  const inferred = inferConsistency(resolvers, consensusPercent);
  const agreeing = finiteNonNegativeNumber(value.agreeing);

  return {
    domain: normalizedDomain,
    record_type: normalizedRecordType,
    resolvers,
    consistent:
      typeof value.consistent === "boolean"
        ? value.consistent
        : inferred.consistent,
    agreeing:
      agreeing !== undefined
        ? Math.min(Math.round(agreeing), resolvers.length)
        : inferred.agreeing,
    consensusPercent,
    timestamp: Number.isFinite(parsedTimestamp)
      ? new Date(parsedTimestamp).toISOString()
      : receivedAt.toISOString(),
    warnings: warnings.finish(),
  };
}

interface PropagationSettingsPanelProps {
  settings: ReturnType<typeof usePropagationSettings>["settings"];
  disabled: boolean;
  onUpdate: ReturnType<typeof usePropagationSettings>["update"];
  onReset: ReturnType<typeof usePropagationSettings>["reset"];
}

/** Catalogue rows grouped by provider, keeping catalogue order. */
const CATALOGUE_BY_PROVIDER: ReadonlyArray<
  readonly [string, readonly PropagationResolverEntry[]]
> = (() => {
  const groups = new Map<string, PropagationResolverEntry[]>();
  for (const entry of PROPAGATION_RESOLVER_CATALOGUE) {
    const list = groups.get(entry.provider);
    if (list) list.push(entry);
    else groups.set(entry.provider, [entry]);
  }
  return Array.from(groups.entries());
})();

function PropagationSettingsPanel({
  settings,
  disabled,
  onUpdate,
  onReset,
}: PropagationSettingsPanelProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const [timeoutDraft, setTimeoutDraft] = useState(String(settings.timeoutMs));
  useEffect(() => {
    setTimeoutDraft(String(settings.timeoutMs));
  }, [settings.timeoutMs]);

  const enabled = new Set(settings.resolvers);
  const catalogueTotal = PROPAGATION_RESOLVER_CATALOGUE.length;
  const limits = PROPAGATION_SETTING_LIMITS;
  const customCapReached =
    settings.customResolvers.length >= limits.maxCustomResolvers;

  const toggleResolver = (id: string, checked: boolean) => {
    const next = new Set(settings.resolvers);
    if (checked) next.add(id);
    else next.delete(id);
    onUpdate({ resolvers: Array.from(next) });
  };

  const addCustomResolver = () => {
    const ip = customDraft.trim();
    if (!ip) return;
    if (!isResolverIpLiteral(ip)) {
      setCustomError(
        t(
          "Enter a bare IPv4 or IPv6 address (no port, brackets or zone id).",
          "Enter a bare IPv4 or IPv6 address (no port, brackets or zone id).",
        ),
      );
      return;
    }
    if (isCataloguePropagationResolverId(ip)) {
      setCustomError(
        t(
          "That address is already in the catalogue — enable it above instead.",
          "That address is already in the catalogue — enable it above instead.",
        ),
      );
      return;
    }
    if (settings.customResolvers.includes(ip)) {
      setCustomError(
        t("That address is already listed.", "That address is already listed."),
      );
      return;
    }
    if (customCapReached) {
      setCustomError(
        t("Up to {{max}} custom resolvers can be added.", {
          max: limits.maxCustomResolvers,
          defaultValue: "Up to {{max}} custom resolvers can be added.",
        }),
      );
      return;
    }
    onUpdate({ customResolvers: [...settings.customResolvers, ip] });
    setCustomDraft("");
    setCustomError(null);
  };

  const commitTimeout = () => {
    const parsed = Number.parseInt(timeoutDraft, 10);
    if (!Number.isFinite(parsed)) {
      setTimeoutDraft(String(settings.timeoutMs));
      return;
    }
    const next = onUpdate({ timeoutMs: parsed });
    setTimeoutDraft(String(next.timeoutMs));
  };

  const segmentGroupClass =
    "glass-surface glass-sheen glass-fade ui-segment-group scrollbar-themed";

  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="propagation-settings-body"
          data-testid="propagation-settings-toggle"
        >
          <span className="min-w-0">
            <CardTitle className="text-sm">
              {t("Resolver options", "Resolver options")}
            </CardTitle>
            <span
              className="block text-[11px] text-muted-foreground"
              data-testid="propagation-settings-summary"
            >
              {t(
                "{{enabled}} of {{total}} catalogue entries enabled · {{custom}} custom · {{timeout}} ms · {{attempts}}× · {{percent}}% consensus",
                {
                  enabled: settings.resolvers.length,
                  total: catalogueTotal,
                  custom: settings.customResolvers.length,
                  timeout: settings.timeoutMs,
                  attempts: settings.attempts,
                  percent: settings.consensusPercent,
                  defaultValue:
                    "{{enabled}} of {{total}} catalogue entries enabled · {{custom}} custom · {{timeout}} ms · {{attempts}}× · {{percent}}% consensus",
                },
              )}
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      </CardHeader>
      {open && (
        <CardContent
          id="propagation-settings-body"
          className="space-y-4"
          data-testid="propagation-settings-body"
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs">
                {t("Public resolvers", "Public resolvers")}
              </Label>
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={disabled}
                  onClick={() => onReset()}
                >
                  {t("Defaults", "Defaults")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={disabled}
                  onClick={() =>
                    onUpdate({
                      resolvers: PROPAGATION_RESOLVER_CATALOGUE.map(
                        (r) => r.id,
                      ),
                    })
                  }
                >
                  {t("All", "All")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={disabled}
                  onClick={() => onUpdate({ resolvers: [] })}
                >
                  {t("None", "None")}
                </Button>
              </div>
            </div>
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
              {CATALOGUE_BY_PROVIDER.map(([provider, entries]) => (
                <fieldset
                  key={provider}
                  className="min-w-0 rounded-md border px-3 py-2"
                >
                  <legend className="px-1 text-[11px] font-medium">
                    {provider}
                  </legend>
                  <div className="space-y-1">
                    {entries.map((entry) => (
                      <label
                        key={entry.id}
                        className="flex min-w-0 cursor-pointer items-center gap-2 text-xs"
                      >
                        <input
                          type="checkbox"
                          className="checkbox-themed"
                          checked={enabled.has(entry.id)}
                          disabled={disabled}
                          onChange={(e) =>
                            toggleResolver(entry.id, e.target.checked)
                          }
                          data-testid={`propagation-resolver-option-${entry.id}`}
                        />
                        <span className="min-w-0 truncate">{entry.label}</span>
                        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                          {entry.ip}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                          {entry.region}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs" htmlFor="propagation-custom-resolver">
              {t("Custom resolvers", "Custom resolvers")}
            </Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="propagation-custom-resolver"
                value={customDraft}
                disabled={disabled || customCapReached}
                onChange={(e) => {
                  setCustomDraft(e.target.value.slice(0, 64));
                  if (customError) setCustomError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomResolver();
                  }
                }}
                placeholder="203.0.113.53"
                className="h-8 w-56 font-mono text-xs"
                aria-invalid={customError ? true : undefined}
                aria-describedby={
                  customError ? "propagation-custom-resolver-error" : undefined
                }
                data-testid="propagation-custom-resolver-input"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8"
                disabled={disabled || customCapReached || !customDraft.trim()}
                onClick={addCustomResolver}
              >
                <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {t("Add", "Add")}
              </Button>
            </div>
            {customError && (
              <p
                id="propagation-custom-resolver-error"
                className="text-[11px] text-destructive"
                role="alert"
                data-testid="propagation-custom-resolver-error"
              >
                {customError}
              </p>
            )}
            {settings.customResolvers.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {settings.customResolvers.map((ip) => (
                  <span
                    key={ip}
                    className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 font-mono text-[10px]"
                    data-testid="propagation-custom-resolver-chip"
                  >
                    {ip}
                    <button
                      type="button"
                      className="rounded-full text-muted-foreground hover:text-foreground disabled:opacity-50"
                      disabled={disabled}
                      aria-label={t("Remove custom resolver {{ip}}", {
                        ip,
                        defaultValue: "Remove custom resolver {{ip}}",
                      })}
                      onClick={() =>
                        onUpdate({
                          customResolvers: settings.customResolvers.filter(
                            (v) => v !== ip,
                          ),
                        })
                      }
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">
              {t(
                "Every enabled resolver, including custom ones, receives the queried hostname.",
                "Every enabled resolver, including custom ones, receives the queried hostname.",
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="w-28">
              <Label className="text-xs" htmlFor="propagation-timeout">
                {t("Timeout (ms)", "Timeout (ms)")}
              </Label>
              <Input
                id="propagation-timeout"
                type="number"
                inputMode="numeric"
                min={limits.timeoutMs.min}
                max={limits.timeoutMs.max}
                step={100}
                value={timeoutDraft}
                disabled={disabled}
                onChange={(e) => setTimeoutDraft(e.target.value)}
                onBlur={commitTimeout}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitTimeout();
                  }
                }}
                className="h-8 text-xs"
                data-testid="propagation-timeout-input"
              />
            </div>
            <div>
              <Label className="text-xs" id="propagation-attempts-label">
                {t("Attempts", "Attempts")}
              </Label>
              <div
                role="group"
                aria-labelledby="propagation-attempts-label"
                className={segmentGroupClass}
              >
                {ATTEMPT_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="ui-segment"
                    data-active={settings.attempts === n}
                    aria-pressed={settings.attempts === n}
                    disabled={disabled}
                    onClick={() => onUpdate({ attempts: n })}
                    data-testid={`propagation-attempts-${n}`}
                  >
                    {n}×
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs" id="propagation-consensus-label">
                {t("Consensus", "Consensus")}
              </Label>
              <div
                role="group"
                aria-labelledby="propagation-consensus-label"
                className={segmentGroupClass}
              >
                {CONSENSUS_OPTIONS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="ui-segment"
                    data-active={settings.consensusPercent === p}
                    aria-pressed={settings.consensusPercent === p}
                    disabled={disabled}
                    onClick={() => onUpdate({ consensusPercent: p })}
                    data-testid={`propagation-consensus-${p}`}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            {t(
              "Consensus is the share of answering resolvers that must return the same record set for the check to count as propagated. Timeout and attempts apply per resolver.",
              "Consensus is the share of answering resolvers that must return the same record set for the check to count as propagated. Timeout and attempts apply per resolver.",
            )}
          </p>
        </CardContent>
      )}
    </Card>
  );
}

function PropagationCheckerInner({
  zoneName,
  checkDnsPropagation,
}: PropagationCheckerProps) {
  const { t } = useI18n();
  const initialDomain = retainUtf8(
    zoneName ?? "",
    PROPAGATION_LIMITS.queryBytes,
  );
  const [domain, setDomain] = useState(initialDomain.value);
  const [recordType, setRecordType] = useState("A");
  const [result, setResult] = useState<PropagationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queryDiagnostic, setQueryDiagnostic] = useState<string | null>(
    initialDomain.truncated
      ? `Domain input was truncated to ${PROPAGATION_LIMITS.queryBytes} UTF-8 bytes.`
      : null,
  );
  const [watching, setWatching] = useState(false);
  const {
    settings,
    update: updateSettings,
    reset: resetSettings,
  } = usePropagationSettings();
  const watchInterval = settings.watchIntervalS;
  const resolved = useMemo(
    () => resolvePropagationSettings(settings),
    [settings],
  );
  const hasResolvers =
    resolved.resolverIds.length + resolved.customResolvers.length > 0;
  const watchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const requestRef = useRef<{
    id: number;
    controller: AbortController;
    watchGeneration?: number;
  } | null>(null);
  const nextRequestIdRef = useRef(0);
  const [checkCount, setCheckCount] = useState(0);

  const check = useCallback(
    async (watchGeneration?: number) => {
      const requestedDomain = domain.trim();
      if (!requestedDomain || !hasResolvers) return;
      if (
        watchGeneration !== undefined &&
        watchGenerationRef.current !== watchGeneration
      ) {
        return;
      }

      requestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestId = ++nextRequestIdRef.current;
      requestRef.current = { id: requestId, controller, watchGeneration };
      const isCurrentRequest = () =>
        mountedRef.current &&
        !controller.signal.aborted &&
        requestRef.current?.id === requestId &&
        (watchGeneration === undefined ||
          watchGenerationRef.current === watchGeneration);
      setLoading(true);
      setError(null);
      try {
        const rawResult = await checkDnsPropagation(
          requestedDomain,
          recordType,
          resolved.customResolvers.length > 0
            ? resolved.customResolvers
            : undefined,
          controller.signal,
          resolved.options,
        );
        if (!isCurrentRequest()) return;
        const res = normalizePropagationResult(rawResult, {
          domain: requestedDomain,
          recordType,
          consensusPercent: resolved.options.consensusPercent,
        });
        setResult(res);
        setCheckCount((c) => c + 1);
        // Auto-stop watch when fully propagated
        if (res.consistent && watchGeneration !== undefined) {
          watchGenerationRef.current += 1;
          if (watchTimerRef.current) {
            clearTimeout(watchTimerRef.current);
            watchTimerRef.current = null;
          }
          setWatching(false);
        }
      } catch (err) {
        if (!isCurrentRequest()) return;
        setResult(null);
        const message =
          err instanceof PropagationResponseError
            ? err.message
            : formatRequestError(err);
        const boundedMessage = retainUtf8(
          message,
          PROPAGATION_LIMITS.stringBytes,
        );
        setError(
          boundedMessage.truncated
            ? `${
                retainUtf8(
                  boundedMessage.value,
                  PROPAGATION_LIMITS.stringBytes - 18,
                ).value
              }… [truncated]`
            : boundedMessage.value,
        );
      } finally {
        if (mountedRef.current && requestRef.current?.id === requestId) {
          requestRef.current = null;
          setLoading(false);
        }
      }
    },
    [domain, recordType, checkDnsPropagation, resolved, hasResolvers],
  );
  const latestCheckRef = useRef(check);
  const latestWatchIntervalRef = useRef(watchInterval);
  useEffect(() => {
    latestCheckRef.current = check;
  }, [check]);
  useEffect(() => {
    latestWatchIntervalRef.current = watchInterval;
  }, [watchInterval]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      watchGenerationRef.current += 1;
      if (watchTimerRef.current) {
        clearTimeout(watchTimerRef.current);
        watchTimerRef.current = null;
      }
      requestRef.current?.controller.abort();
      requestRef.current = null;
    };
  }, []);

  // Watch mode is completion-scheduled: a new request is queued only after the
  // previous request has settled, so an unresolved provider cannot overlap.
  useEffect(() => {
    if (!watching) return;
    const generation = ++watchGenerationRef.current;
    let disposed = false;
    const cycle = async () => {
      await latestCheckRef.current(generation);
      if (
        disposed ||
        !mountedRef.current ||
        watchGenerationRef.current !== generation
      ) {
        return;
      }
      watchTimerRef.current = setTimeout(
        () => void cycle(),
        latestWatchIntervalRef.current * 1000,
      );
    };
    void cycle();
    return () => {
      disposed = true;
      if (watchGenerationRef.current === generation) {
        watchGenerationRef.current += 1;
      }
      if (watchTimerRef.current) {
        clearTimeout(watchTimerRef.current);
        watchTimerRef.current = null;
      }
      if (requestRef.current?.watchGeneration === generation) {
        requestRef.current.controller.abort();
      }
    };
  }, [watching]);

  const toggleWatch = () => {
    if (watching) {
      watchGenerationRef.current += 1;
      if (watchTimerRef.current) {
        clearTimeout(watchTimerRef.current);
        watchTimerRef.current = null;
      }
      const activeRequest = requestRef.current;
      if (activeRequest?.watchGeneration !== undefined) {
        activeRequest.controller.abort();
        requestRef.current = null;
        setLoading(false);
      }
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
  const visibleResolvers =
    result?.resolvers.slice(0, PROPAGATION_LIMITS.renderedResolvers) ?? [];
  const watchIntervalOptions = WATCH_INTERVAL_OPTIONS.includes(watchInterval)
    ? WATCH_INTERVAL_OPTIONS
    : [...WATCH_INTERVAL_OPTIONS, watchInterval].sort((a, b) => a - b);
  const canCheck = !watching && !loading && !!domain.trim() && hasResolvers;

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
                disabled={watching}
                onChange={(e) => {
                  const bounded = retainUtf8(
                    e.target.value,
                    PROPAGATION_LIMITS.queryBytes,
                  );
                  setDomain(bounded.value);
                  setQueryDiagnostic(
                    bounded.truncated
                      ? `Domain input was truncated to ${PROPAGATION_LIMITS.queryBytes} UTF-8 bytes.`
                      : null,
                  );
                }}
                placeholder={t("example.com", "example.com")}
                className="h-8 text-xs font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void check();
                }}
              />
              {queryDiagnostic && (
                <p
                  className="mt-1 text-[11px] text-yellow-700 dark:text-yellow-300"
                  data-testid="propagation-query-diagnostic"
                  role="status"
                >
                  {queryDiagnostic}
                </p>
              )}
            </div>
            <div className="w-28">
              <Label className="text-xs">{t("Type", "Type")}</Label>
              <Select
                value={recordType}
                onValueChange={setRecordType}
                disabled={watching}
              >
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
                disabled={!canCheck}
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
                    onValueChange={(v) =>
                      updateSettings({ watchIntervalS: parseInt(v, 10) })
                    }
                    disabled={watching}
                  >
                    <SelectTrigger
                      className="h-8 text-xs"
                      aria-label={t("Watch interval", "Watch interval")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {watchIntervalOptions.map((s) => (
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
                  disabled={!domain.trim() || (!watching && !hasResolvers)}
                >
                  {watching ? t("Stop", "Stop") : t("Watch", "Watch")}
                </Button>
              </div>
            </div>
          </div>
          {!hasResolvers && (
            <p
              className="mt-2 text-[11px] text-yellow-700 dark:text-yellow-300"
              data-testid="propagation-no-resolvers"
              role="status"
            >
              {t(
                "Enable at least one resolver or add a custom one before checking.",
                "Enable at least one resolver or add a custom one before checking.",
              )}
            </p>
          )}
        </CardContent>
      </Card>

      <PropagationSettingsPanel
        settings={settings}
        disabled={watching}
        onUpdate={updateSettings}
        onReset={resetSettings}
      />

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
            disabled={!canCheck}
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
                ? result.consensusPercent >= 100
                  ? t("Fully Propagated", "Fully Propagated")
                  : t("Propagated (≥ {{percent}}%)", {
                      percent: result.consensusPercent,
                      defaultValue: "Propagated (≥ {{percent}}%)",
                    })
                : t("Inconsistent", "Inconsistent")}
            </span>
            <span
              className="text-xs text-muted-foreground"
              data-testid="propagation-summary"
            >
              {t(
                "{{domain}} {{recordType}} — {{agree}}/{{answered}} answering resolvers agree ({{percent}}% needed) · {{answered}}/{{count}} answered",
                {
                  domain: result.domain,
                  recordType: result.record_type,
                  agree: result.agreeing,
                  answered: countAnsweringResolvers(result.resolvers),
                  count: result.resolvers.length,
                  percent: result.consensusPercent,
                  defaultValue:
                    "{{domain}} {{recordType}} — {{agree}}/{{answered}} answering resolvers agree ({{percent}}% needed) · {{answered}}/{{count}} answered",
                },
              )}
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
                    disabled={!canCheck}
                  >
                    {t("Retry", "Retry")}
                  </Button>
                </div>
              ) : (
                <div className="space-y-1">
                  {result.resolvers.length >
                    PROPAGATION_LIMITS.renderedResolvers && (
                    <p
                      className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-700 dark:text-yellow-300"
                      data-testid="propagation-render-limit"
                      role="status"
                    >
                      Showing the first{" "}
                      {PROPAGATION_LIMITS.renderedResolvers.toLocaleString()} of{" "}
                      {result.resolvers.length.toLocaleString()} retained
                      resolver rows.
                    </p>
                  )}
                  {visibleResolvers.map((r, i) => (
                    <div
                      key={`${r.resolver}-${i}`}
                      data-testid="propagation-resolver-row"
                      className="flex items-start justify-between rounded-md border px-3 py-2"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="min-w-0 truncate text-xs font-medium">
                            {r.label}
                          </span>
                          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
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
                            {r.records
                              .slice(
                                0,
                                PROPAGATION_LIMITS.renderedAnswersPerResolver,
                              )
                              .map((rec, j) => (
                                <span
                                  key={j}
                                  data-testid="propagation-answer"
                                  className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                                >
                                  {rec}
                                </span>
                              ))}
                            {r.records.length >
                              PROPAGATION_LIMITS.renderedAnswersPerResolver && (
                              <span className="text-[10px] text-muted-foreground">
                                +
                                {r.records.length -
                                  PROPAGATION_LIMITS.renderedAnswersPerResolver}{" "}
                                retained answers not shown
                              </span>
                            )}
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
                      <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
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
