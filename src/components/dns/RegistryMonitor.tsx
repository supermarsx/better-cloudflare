/**
 * Registry monitoring panel.
 *
 * Shows all domains across configured registrar accounts with health status
 * indicators and expiry countdowns. All data comes from the backend —
 * this component only renders state managed by `useRegistrarMonitor`.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import type { UseRegistrarMonitorResult } from "@/hooks/use-registrar-monitor";
import { REGISTRAR_LABELS } from "@/types/registrar";
import type {
  DomainInfo,
  DomainHealthCheck,
  RegistrarCredential,
} from "@/types/registrar";
import { AddRegistrarDialog } from "./AddRegistrarDialog";
import {
  Globe,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Trash2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Lock,
  Unlock,
} from "lucide-react";

interface RegistryMonitorProps {
  monitor: UseRegistrarMonitorResult;
}

/** Calculate days until a date string. */
function daysUntil(dateStr: string): number | null {
  if (!dateStr) return null;
  try {
    const diff = new Date(dateStr).getTime() - Date.now();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

/** Status badge colour for domain status. */
function statusVariant(
  status: string,
): "default" | "primary" {
  switch (status) {
    case "active":
      return "primary";
    default:
      return "default";
  }
}

/** Health status icon. */
function HealthIcon({ status }: { status: "healthy" | "warning" | "critical" }) {
  switch (status) {
    case "healthy":
      return <ShieldCheck className="h-4 w-4 text-emerald-400" />;
    case "warning":
      return <ShieldAlert className="h-4 w-4 text-amber-400" />;
    case "critical":
      return <ShieldX className="h-4 w-4 text-red-400" />;
  }
}

export function RegistryMonitor({ monitor }: RegistryMonitorProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);

  // Load credentials and domains on mount
  useEffect(() => {
    void monitor.refreshCredentials();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (monitor.credentials.length > 0) {
      void monitor.refreshAllDomains();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitor.credentials.length]);

  const handleRefresh = async () => {
    try {
      await monitor.refreshAllDomains();
      await monitor.runHealthChecks();
      toast({
        title: t("Success", "Success"),
        description: t("Domains refreshed", "Domains refreshed"),
      });
    } catch {
      toast({
        title: t("Error", "Error"),
        description: monitor.error ?? t("Failed to refresh domains", "Failed to refresh domains"),
        variant: "destructive",
      });
    }
  };

  const handleDeleteCredential = async (cred: RegistrarCredential) => {
    try {
      await monitor.deleteCredential(cred.id);
      toast({
        title: t("Success", "Success"),
        description: `${cred.label} ${t("removed", "removed")}`,
      });
    } catch {
      toast({
        title: t("Error", "Error"),
        description: monitor.error ?? t("Failed to remove credential", "Failed to remove credential"),
        variant: "destructive",
      });
    }
  };

  const healthMap = new Map<string, DomainHealthCheck>();
  for (const hc of monitor.healthChecks) {
    healthMap.set(hc.domain, hc);
  }

  const filteredDomains = monitor.domains.filter((d) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      d.domain.toLowerCase().includes(term) ||
      d.registrar.toLowerCase().includes(term) ||
      d.status.toLowerCase().includes(term)
    );
  });

  // Sort: critical → warning → healthy, then by expiry
  const sortedDomains = [...filteredDomains].sort((a, b) => {
    const hcA = healthMap.get(a.domain);
    const hcB = healthMap.get(b.domain);
    const severityOrder = { critical: 0, warning: 1, healthy: 2 };
    const sa = hcA ? severityOrder[hcA.status] : 3;
    const sb = hcB ? severityOrder[hcB.status] : 3;
    if (sa !== sb) return sa - sb;
    const daysA = daysUntil(a.expires_at) ?? Infinity;
    const daysB = daysUntil(b.expires_at) ?? Infinity;
    return daysA - daysB;
  });

  return (
    <>
      <Card className="border-border/60 bg-card/70">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-lg flex items-center gap-2">
                <Globe className="h-5 w-5" />
                {t("Registry Monitoring", "Registry Monitoring")}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Monitor domains across all your registrars",
                  "Monitor domains across all your registrars",
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Tooltip tip={t("Refresh all domains", "Refresh all domains")} side="bottom">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleRefresh}
                  disabled={monitor.isLoading}
                  className="border-border/60"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${monitor.isLoading ? "animate-spin" : ""}`}
                  />
                </Button>
              </Tooltip>
              <Button
                variant="outline"
                onClick={() => setShowAddDialog(true)}
                className="border-border/60"
              >
                <Plus className="h-4 w-4 mr-1" />
                {t("Add Registrar", "Add Registrar")}
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Credential chips */}
          {monitor.credentials.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {monitor.credentials.map((cred) => (
                <div
                  key={cred.id}
                  className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-3 py-1 text-xs"
                >
                  <span className="font-medium">
                    {REGISTRAR_LABELS[cred.provider]}
                  </span>
                  <span className="text-muted-foreground">
                    {cred.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDeleteCredential(cred)}
                    className="ml-1 rounded p-0.5 text-muted-foreground hover:text-destructive transition"
                    aria-label={`Remove ${cred.label}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Search */}
          {monitor.domains.length > 0 && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={t("Search domains...", "Search domains...")}
                className="pl-9 bg-card/70 border-border"
              />
            </div>
          )}

          {/* Empty state */}
          {monitor.credentials.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Globe className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground mb-4">
                {t(
                  "No registrars configured. Add one to start monitoring your domains.",
                  "No registrars configured. Add one to start monitoring your domains.",
                )}
              </p>
              <Button
                variant="outline"
                onClick={() => setShowAddDialog(true)}
              >
                <Plus className="h-4 w-4 mr-1" />
                {t("Add Registrar", "Add Registrar")}
              </Button>
            </div>
          )}

          {/* Loading */}
          {monitor.isLoading && monitor.domains.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground mr-2" />
              <span className="text-sm text-muted-foreground">
                {t("Loading domains...", "Loading domains...")}
              </span>
            </div>
          )}

          {/* Error */}
          {monitor.error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {monitor.error}
              <button
                type="button"
                onClick={monitor.clearError}
                className="ml-2 underline"
              >
                {t("Dismiss", "Dismiss")}
              </button>
            </div>
          )}

          {/* Domain list */}
          {sortedDomains.length > 0 && (
            <div className="space-y-2">
              {/* Summary bar */}
              <div className="flex items-center gap-4 text-xs text-muted-foreground pb-1">
                <span>
                  {sortedDomains.length}{" "}
                  {sortedDomains.length === 1
                    ? t("domain", "domain")
                    : t("domains", "domains")}
                </span>
                {monitor.healthChecks.length > 0 && (
                  <>
                    <span className="flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3 text-emerald-400" />
                      {monitor.healthChecks.filter((h) => h.status === "healthy").length}
                    </span>
                    <span className="flex items-center gap-1">
                      <ShieldAlert className="h-3 w-3 text-amber-400" />
                      {monitor.healthChecks.filter((h) => h.status === "warning").length}
                    </span>
                    <span className="flex items-center gap-1">
                      <ShieldX className="h-3 w-3 text-red-400" />
                      {monitor.healthChecks.filter((h) => h.status === "critical").length}
                    </span>
                  </>
                )}
              </div>

              {sortedDomains.map((domain) => (
                <DomainRow
                  key={`${domain.registrar}:${domain.domain}`}
                  domain={domain}
                  health={healthMap.get(domain.domain)}
                  expanded={expandedDomain === domain.domain}
                  onToggle={() =>
                    setExpandedDomain(
                      expandedDomain === domain.domain ? null : domain.domain,
                    )
                  }
                  t={t}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AddRegistrarDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onAdd={monitor.addCredential}
      />
    </>
  );
}

// ─── Domain row ────────────────────────────────────────────────────────────

interface DomainRowProps {
  domain: DomainInfo;
  health?: DomainHealthCheck;
  expanded: boolean;
  onToggle: () => void;
  t: (key: string, fallback: string) => string;
}

function DomainRow({ domain, health, expanded, onToggle, t }: DomainRowProps) {
  const days = daysUntil(domain.expires_at);
  const expiryColor =
    days === null
      ? "text-muted-foreground"
      : days < 0
        ? "text-red-400"
        : days < 30
          ? "text-amber-400"
          : days < 90
            ? "text-yellow-300"
            : "text-emerald-400";

  return (
    <div className="rounded-lg border border-border/60 bg-card/50 transition hover:bg-card/70">
      {/* Main row */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {/* Health icon */}
        <div className="shrink-0">
          {health ? (
            <HealthIcon status={health.status} />
          ) : (
            <Globe className="h-4 w-4 text-muted-foreground/50" />
          )}
        </div>

        {/* Domain name */}
        <div className="flex-1 min-w-0">
          <span className="font-medium text-sm truncate block">
            {domain.domain}
          </span>
          <span className="text-xs text-muted-foreground">
            {REGISTRAR_LABELS[domain.registrar]}
          </span>
        </div>

        {/* Status tag */}
        <Tag variant={statusVariant(domain.status)} className="text-[10px] shrink-0">
          {domain.status}
        </Tag>

        {/* Expiry */}
        <div className={`text-xs shrink-0 flex items-center gap-1 ${expiryColor}`}>
          <Clock className="h-3 w-3" />
          {days !== null ? (
            days < 0 ? (
              <span>{t("Expired", "Expired")} {Math.abs(days)}d</span>
            ) : (
              <span>{days}d</span>
            )
          ) : (
            <span>—</span>
          )}
        </div>

        {/* Lock icons */}
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip tip={domain.locks.transfer_lock ? t("Transfer locked", "Transfer locked") : t("Transfer unlocked", "Transfer unlocked")} side="bottom">
            {domain.locks.transfer_lock ? (
              <Lock className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Unlock className="h-3.5 w-3.5 text-amber-400" />
            )}
          </Tooltip>
          <Tooltip tip={domain.locks.auto_renew ? t("Auto-renew on", "Auto-renew on") : t("Auto-renew off", "Auto-renew off")} side="bottom">
            <RefreshCw
              className={`h-3.5 w-3.5 ${domain.locks.auto_renew ? "text-emerald-400" : "text-amber-400"}`}
            />
          </Tooltip>
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border/40 px-4 py-3 space-y-3 text-xs fade-in-up">
          {/* Quick info grid */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 md:grid-cols-4">
            <div>
              <span className="text-muted-foreground block">
                {t("Created", "Created")}
              </span>
              <span>{domain.created_at ? new Date(domain.created_at).toLocaleDateString() : "—"}</span>
            </div>
            <div>
              <span className="text-muted-foreground block">
                {t("Expires", "Expires")}
              </span>
              <span className={expiryColor}>
                {domain.expires_at ? new Date(domain.expires_at).toLocaleDateString() : "—"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground block">DNSSEC</span>
              <span className={domain.dnssec.enabled ? "text-emerald-400" : "text-muted-foreground"}>
                {domain.dnssec.enabled ? t("Enabled", "Enabled") : t("Disabled", "Disabled")}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground block">
                {t("Privacy", "Privacy")}
              </span>
              <span className={domain.privacy.enabled ? "text-emerald-400" : "text-muted-foreground"}>
                {domain.privacy.enabled ? t("Enabled", "Enabled") : t("Disabled", "Disabled")}
              </span>
            </div>
          </div>

          {/* Nameservers */}
          {domain.nameservers.current.length > 0 && (
            <div>
              <span className="text-muted-foreground block mb-1">
                {t("Nameservers", "Nameservers")}
              </span>
              <div className="flex flex-wrap gap-1">
                {domain.nameservers.current.map((ns) => (
                  <Tag key={ns} className="text-[10px]">
                    {ns}
                  </Tag>
                ))}
              </div>
            </div>
          )}

          {/* Health checks */}
          {health && health.checks.length > 0 && (
            <div>
              <span className="text-muted-foreground block mb-1">
                {t("Health Checks", "Health Checks")}
              </span>
              <div className="space-y-1">
                {health.checks.map((check) => (
                  <div
                    key={check.name}
                    className="flex items-center gap-2 text-xs"
                  >
                    {check.passed ? (
                      <CheckCircle className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    ) : check.severity === "critical" ? (
                      <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                    )}
                    <span className="text-muted-foreground capitalize">
                      {check.name.replace(/_/g, " ")}:
                    </span>
                    <span>{check.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
