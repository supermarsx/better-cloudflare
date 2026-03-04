/**
 * Email Routing panel — view settings and manage email routing rules.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import type { EmailRoutingRuleInput } from "@/lib/tauri-client";

interface EmailRoutingSettings {
  enabled: boolean;
  name?: string;
  status?: string;
  created?: string;
  modified?: string;
}

interface EmailRoutingMatcher {
  type: string;
  field?: string;
  value?: string;
}

interface EmailRoutingAction {
  type: string;
  value?: string[];
}

interface EmailRoutingRule {
  id?: string;
  tag?: string;
  name?: string;
  enabled: boolean;
  matchers: EmailRoutingMatcher[];
  actions: EmailRoutingAction[];
  priority?: number;
}

interface EmailRoutingPanelProps {
  zoneId: string;
  getEmailRoutingSettings: (zoneId: string, signal?: AbortSignal) => Promise<unknown>;
  getEmailRoutingRules: (zoneId: string, signal?: AbortSignal) => Promise<unknown[]>;
  createEmailRoutingRule: (
    zoneId: string,
    rule: EmailRoutingRuleInput,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  deleteEmailRoutingRule: (zoneId: string, ruleId: string, signal?: AbortSignal) => Promise<void>;
}

function EmailRoutingPanelInner({
  zoneId,
  getEmailRoutingSettings,
  getEmailRoutingRules,
  createEmailRoutingRule,
  deleteEmailRoutingRule,
}: EmailRoutingPanelProps) {
  const [settings, setSettings] = useState<EmailRoutingSettings | null>(null);
  const [rules, setRules] = useState<EmailRoutingRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New rule form
  const [newName, setNewName] = useState("");
  const [newMatchAddress, setNewMatchAddress] = useState("");
  const [newForwardTo, setNewForwardTo] = useState("");
  const [newEnabled, setNewEnabled] = useState(true);

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [settingsResult, rulesResult] = await Promise.all([
          getEmailRoutingSettings(zoneId, signal),
          getEmailRoutingRules(zoneId, signal),
        ]);
        if (!signal?.aborted) {
          setSettings(settingsResult as EmailRoutingSettings);
          setRules(rulesResult as EmailRoutingRule[]);
        }
      } catch (err) {
        if (!signal?.aborted) {
          setError(err instanceof Error ? err.message : "Failed to load email routing");
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [zoneId, getEmailRoutingSettings, getEmailRoutingRules],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const handleCreateRule = async () => {
    if (!newMatchAddress.trim() || !newForwardTo.trim()) return;
    try {
      await createEmailRoutingRule(zoneId, {
        name: newName || undefined,
        enabled: newEnabled,
        matchers: [{ type: "literal", field: "to", value: newMatchAddress }],
        actions: [{ type: "forward", value: [newForwardTo] }],
      });
      setNewName("");
      setNewMatchAddress("");
      setNewForwardTo("");
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create rule");
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      await deleteEmailRoutingRule(zoneId, ruleId);
      setRules((prev) => prev.filter((r) => (r.id ?? r.tag) !== ruleId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete rule");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Email Routing</h3>
        <Button size="sm" variant="outline" onClick={() => fetchData()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Settings summary */}
      {settings && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Settings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4 text-sm">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                  settings.enabled
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${settings.enabled ? "bg-green-500" : "bg-muted-foreground"}`}
                />
                {settings.enabled ? "Enabled" : "Disabled"}
              </span>
              {settings.status && (
                <span className="text-xs text-muted-foreground">Status: {settings.status}</span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* New rule form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">New Routing Rule</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div>
            <Label className="text-xs">Rule Name</Label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Optional name"
              className="h-8 text-xs"
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <Label className="text-xs">Match Address (To)</Label>
              <Input
                value={newMatchAddress}
                onChange={(e) => setNewMatchAddress(e.target.value)}
                placeholder="hello@example.com"
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="flex-1">
              <Label className="text-xs">Forward To</Label>
              <Input
                value={newForwardTo}
                onChange={(e) => setNewForwardTo(e.target.value)}
                placeholder="user@gmail.com"
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={newEnabled} onCheckedChange={setNewEnabled} />
            <Label className="text-xs">Enabled</Label>
          </div>
          <Button
            size="sm"
            onClick={handleCreateRule}
            disabled={!newMatchAddress.trim() || !newForwardTo.trim()}
          >
            Create Rule
          </Button>
        </CardContent>
      </Card>

      {/* Rules list */}
      {rules.length > 0 ? (
        <div className="space-y-1">
          {rules.map((rule) => {
            const ruleId = rule.id ?? rule.tag ?? "";
            return (
              <div
                key={ruleId}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    {rule.name && <span className="text-xs font-medium">{rule.name}</span>}
                    <span
                      className={`text-[10px] ${rule.enabled ? "text-green-600" : "text-muted-foreground"}`}
                    >
                      {rule.enabled ? "Active" : "Disabled"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    {rule.matchers.map((m, i) => (
                      <span key={i} className="font-mono">
                        {m.value || m.field || m.type}
                      </span>
                    ))}
                    <span>→</span>
                    {rule.actions.map((a, i) => (
                      <span key={i} className="font-mono">
                        {a.value?.join(", ") || a.type}
                      </span>
                    ))}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleDeleteRule(ruleId)}
                >
                  Delete
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        !loading &&
        settings && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No email routing rules configured
          </p>
        )
      )}

      {loading && !settings && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">Loading email routing…</p>
        </div>
      )}
    </div>
  );
}

export function EmailRoutingPanel(props: EmailRoutingPanelProps) {
  return (
    <ErrorBoundary label="email-routing">
      <EmailRoutingPanelInner {...props} />
    </ErrorBoundary>
  );
}
