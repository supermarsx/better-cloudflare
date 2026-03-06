/**
 * Firewall panel — manage firewall rules, IP access rules, and view WAF rulesets.
 */
import { useCallback, useEffect, useState } from "react";
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

interface FirewallRule {
  id: string;
  paused: boolean;
  action: string;
  priority?: number;
  description?: string;
  filter: { id: string; expression: string; paused?: boolean; description?: string };
}

interface IpAccessRule {
  id: string;
  mode: string;
  notes?: string;
  configuration: { target: string; value: string };
}

interface WafRuleset {
  id: string;
  name: string;
  description?: string;
  kind: string;
  phase: string;
}

type FirewallSubtab = "rules" | "ip-access" | "waf";

interface FirewallPanelProps {
  zoneId: string;
  getFirewallRules: (zoneId: string, signal?: AbortSignal) => Promise<unknown[]>;
  createFirewallRule: (
    zoneId: string,
    rule: { action: string; description?: string; filter: { expression: string } },
    signal?: AbortSignal,
  ) => Promise<unknown>;
  updateFirewallRule?: (
    zoneId: string,
    ruleId: string,
    rule: { action: string; description?: string; filter: { expression: string } },
    signal?: AbortSignal,
  ) => Promise<unknown>;
  deleteFirewallRule: (zoneId: string, ruleId: string, signal?: AbortSignal) => Promise<void>;
  getIpAccessRules: (zoneId: string, signal?: AbortSignal) => Promise<unknown[]>;
  createIpAccessRule: (
    zoneId: string,
    mode: string,
    ip: string,
    notes?: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  deleteIpAccessRule: (zoneId: string, ruleId: string, signal?: AbortSignal) => Promise<void>;
  getWafRulesets: (zoneId: string, signal?: AbortSignal) => Promise<unknown[]>;
}

const FIREWALL_ACTIONS = [
  { value: "block", label: "Block" },
  { value: "challenge", label: "Challenge" },
  { value: "js_challenge", label: "JS Challenge" },
  { value: "managed_challenge", label: "Managed Challenge" },
  { value: "allow", label: "Allow" },
  { value: "log", label: "Log" },
  { value: "bypass", label: "Bypass" },
];

const IP_ACCESS_MODES = [
  { value: "block", label: "Block" },
  { value: "challenge", label: "Challenge" },
  { value: "whitelist", label: "Whitelist" },
  { value: "js_challenge", label: "JS Challenge" },
  { value: "managed_challenge", label: "Managed Challenge" },
];

function FirewallPanelInner({
  zoneId,
  getFirewallRules,
  createFirewallRule,
  updateFirewallRule,
  deleteFirewallRule,
  getIpAccessRules,
  createIpAccessRule,
  deleteIpAccessRule,
  getWafRulesets,
}: FirewallPanelProps) {
  const { t } = useI18n();
  const [subtab, setSubtab] = useState<FirewallSubtab>("rules");
  const [rules, setRules] = useState<FirewallRule[]>([]);
  const [ipRules, setIpRules] = useState<IpAccessRule[]>([]);
  const [wafRulesets, setWafRulesets] = useState<WafRuleset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline editing
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editExpression, setEditExpression] = useState("");
  const [editAction, setEditAction] = useState("block");
  const [editDescription, setEditDescription] = useState("");

  // New rule form
  const [newExpression, setNewExpression] = useState("");
  const [newAction, setNewAction] = useState("block");
  const [newDescription, setNewDescription] = useState("");

  // IP access form
  const [newIp, setNewIp] = useState("");
  const [newIpMode, setNewIpMode] = useState("block");
  const [newIpNotes, setNewIpNotes] = useState("");

  const fetchRules = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [fwRules, ipAccess, waf] = await Promise.all([
          getFirewallRules(zoneId, signal),
          getIpAccessRules(zoneId, signal),
          getWafRulesets(zoneId, signal),
        ]);
        if (!signal?.aborted) {
          setRules(fwRules as FirewallRule[]);
          setIpRules(ipAccess as IpAccessRule[]);
          setWafRulesets(waf as WafRuleset[]);
        }
      } catch (err) {
        if (!signal?.aborted) {
          setError(err instanceof Error ? err.message : t("Failed to load firewall data", "Failed to load firewall data"));
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [zoneId, getFirewallRules, getIpAccessRules, getWafRulesets],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchRules(controller.signal);
    return () => controller.abort();
  }, [fetchRules]);

  const handleCreateRule = async () => {
    if (!newExpression.trim()) return;
    try {
      await createFirewallRule(zoneId, {
        action: newAction,
        description: newDescription || undefined,
        filter: { expression: newExpression },
      });
      setNewExpression("");
      setNewDescription("");
      fetchRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Failed to create rule", "Failed to create rule"));
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      await deleteFirewallRule(zoneId, ruleId);
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Failed to delete rule", "Failed to delete rule"));
    }
  };

  const startEditRule = (rule: FirewallRule) => {
    setEditingRuleId(rule.id);
    setEditExpression(rule.filter.expression);
    setEditAction(rule.action);
    setEditDescription(rule.description ?? "");
  };

  const handleSaveEdit = async () => {
    if (!editingRuleId || !updateFirewallRule) return;
    try {
      await updateFirewallRule(zoneId, editingRuleId, {
        action: editAction,
        description: editDescription || undefined,
        filter: { expression: editExpression },
      });
      setEditingRuleId(null);
      fetchRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Failed to update rule", "Failed to update rule"));
    }
  };

  const handleCreateIpRule = async () => {
    if (!newIp.trim()) return;
    try {
      await createIpAccessRule(zoneId, newIpMode, newIp, newIpNotes || undefined);
      setNewIp("");
      setNewIpNotes("");
      fetchRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Failed to create IP rule", "Failed to create IP rule"));
    }
  };

  const handleDeleteIpRule = async (ruleId: string) => {
    try {
      await deleteIpAccessRule(zoneId, ruleId);
      setIpRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Failed to delete IP rule", "Failed to delete IP rule"));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{t("Firewall & WAF", "Firewall & WAF")}</h3>
        <Button size="sm" variant="outline" onClick={() => fetchRules()} disabled={loading}>
          {loading ? t("Loading…", "Loading…") : t("Refresh", "Refresh")}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Subtab selector */}
      <div className="flex gap-1 rounded-lg border p-0.5">
        {(
          [
            { id: "rules", label: t("Rules ({{count}})", { count: rules.length, defaultValue: "Rules ({{count}})" }) },
            { id: "ip-access", label: t("IP Access ({{count}})", { count: ipRules.length, defaultValue: "IP Access ({{count}})" }) },
            { id: "waf", label: t("WAF ({{count}})", { count: wafRulesets.length, defaultValue: "WAF ({{count}})" }) },
          ] as { id: FirewallSubtab; label: string }[]
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              subtab === tab.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
            onClick={() => setSubtab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Firewall Rules tab */}
      {subtab === "rules" && (
        <div className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("Add Firewall Rule", "Add Firewall Rule")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div>
                <Label className="text-xs">{t("Filter Expression", "Filter Expression")}</Label>
                <Input
                  value={newExpression}
                  onChange={(e) => setNewExpression(e.target.value)}
                  placeholder='(ip.src eq 1.2.3.4) or (ip.src in {10.0.0.0/8})'
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Label className="text-xs">{t("Action", "Action")}</Label>
                  <Select value={newAction} onValueChange={setNewAction}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIREWALL_ACTIONS.map((a) => (
                        <SelectItem key={a.value} value={a.value}>
                        {t(a.label, a.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                </div>
                <div className="flex-1">
                  <Label className="text-xs">{t("Description", "Description")}</Label>
                  <Input
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    placeholder={t("Optional description", "Optional description")}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <Button size="sm" onClick={handleCreateRule} disabled={!newExpression.trim()}>
                {t("Create Rule", "Create Rule")}
              </Button>
            </CardContent>
          </Card>

          {rules.length > 0 && (
            <div className="space-y-1">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="rounded-md border px-3 py-2"
                >
                  {editingRuleId === rule.id ? (
                    <div className="space-y-2">
                      <Input
                        value={editExpression}
                        onChange={(e) => setEditExpression(e.target.value)}
                        className="font-mono text-xs"
                      />
                      <div className="flex gap-2">
                        <Select value={editAction} onValueChange={setEditAction}>
                          <SelectTrigger className="h-8 w-40 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FIREWALL_ACTIONS.map((a) => (
                              <SelectItem key={a.value} value={a.value}>
                                {t(a.label, a.label)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                          placeholder={t("Description", "Description")}
                          className="h-8 flex-1 text-xs"
                        />
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" onClick={handleSaveEdit} disabled={!editExpression.trim()}>
                          {t("Save", "Save")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingRuleId(null)}>
                          {t("Cancel", "Cancel")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex-1 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                              rule.action === "block"
                                ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                                : rule.action === "allow"
                                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                                  : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                            }`}
                          >
                            {rule.action}
                          </span>
                          {rule.description && (
                            <span className="text-xs text-muted-foreground">{rule.description}</span>
                          )}
                          {rule.paused && (
                            <span className="text-[10px] text-muted-foreground italic">{t("paused", "paused")}</span>
                          )}
                        </div>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {rule.filter.expression}
                        </p>
                      </div>
                      <div className="flex gap-1">
                        {updateFirewallRule && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => startEditRule(rule)}
                          >
                            {t("Edit", "Edit")}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleDeleteRule(rule.id)}
                        >
                          {t("Delete", "Delete")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* IP Access Rules tab */}
      {subtab === "ip-access" && (
        <div className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("Add IP Access Rule", "Add IP Access Rule")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex gap-2">
                <div className="flex-1">
                  <Label className="text-xs">{t("IP Address / Range", "IP Address / Range")}</Label>
                  <Input
                    value={newIp}
                    onChange={(e) => setNewIp(e.target.value)}
                    placeholder="192.168.1.0/24"
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div>
                  <Label className="text-xs">{t("Mode", "Mode")}</Label>
                  <Select value={newIpMode} onValueChange={setNewIpMode}>
                    <SelectTrigger className="h-8 w-36 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {IP_ACCESS_MODES.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {t(m.label, m.label)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs">{t("Notes", "Notes")}</Label>
                <Input
                  value={newIpNotes}
                  onChange={(e) => setNewIpNotes(e.target.value)}
                  placeholder={t("Optional notes", "Optional notes")}
                  className="h-8 text-xs"
                />
              </div>
              <Button size="sm" onClick={handleCreateIpRule} disabled={!newIp.trim()}>
                {t("Add Rule", "Add Rule")}
              </Button>
            </CardContent>
          </Card>

          {ipRules.length > 0 && (
            <div className="space-y-1">
              {ipRules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{rule.configuration.value}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase">
                        {rule.mode}
                      </span>
                    </div>
                    {rule.notes && (
                      <p className="text-[11px] text-muted-foreground">{rule.notes}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleDeleteIpRule(rule.id)}
                  >
                    {t("Delete", "Delete")}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {ipRules.length === 0 && !loading && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("No IP access rules", "No IP access rules")}</p>
          )}
        </div>
      )}

      {/* WAF Rulesets tab */}
      {subtab === "waf" && (
        <div className="space-y-2">
          {wafRulesets.length > 0 ? (
            wafRulesets.map((rs) => (
              <div key={rs.id} className="rounded-md border px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{rs.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                    {rs.kind}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{rs.phase}</span>
                </div>
                {rs.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{rs.description}</p>
                )}
              </div>
            ))
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("No WAF rulesets", "No WAF rulesets")}</p>
          )}
        </div>
      )}

      {loading && !rules.length && !ipRules.length && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">{t("Loading firewall data…", "Loading firewall data…")}</p>
        </div>
      )}
    </div>
  );
}

export function FirewallPanel(props: FirewallPanelProps) {
  return (
    <ErrorBoundary label="firewall">
      <FirewallPanelInner {...props} />
    </ErrorBoundary>
  );
}
