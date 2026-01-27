import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

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
import type { SPFGraph, SPFMechanism } from "@/lib/spf";
import { composeSPF, parseSPF, validateSPF } from "@/lib/spf";
import { KNOWN_TLDS } from "@/lib/tlds";

import type { BuilderWarningsChange, RecordDraft } from "./types";

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.$/, "");
}

function looksLikeHostname(value: string) {
  const v = normalizeDnsName(value.trim());
  if (!v) return false;
  if (/\s/.test(v)) return false;
  if (v.length > 253) return false;
  if (v.includes("..")) return false;
  const labels = v.split(".");
  const isValidLabel = (label: string) => {
    if (!label) return false;
    if (label.length > 63) return false;
    if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    return true;
  };
  return labels.every(isValidLabel);
}

function isValidIPv4Cidr(value: string) {
  const [addr, prefixRaw] = value.trim().split("/");
  const parts = addr.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  if (prefixRaw === undefined) return true;
  if (!/^\d{1,2}$/.test(prefixRaw)) return false;
  const p = Number.parseInt(prefixRaw, 10);
  return p >= 0 && p <= 32;
}

function isValidIPv6Cidr(value: string) {
  const raw = value.trim().toLowerCase();
  const [addr, prefixRaw] = raw.split("/");
  if (!addr.includes(":")) return false;
  if (!/^[0-9a-f:]+$/.test(addr)) return false;
  const hasDouble = addr.includes("::");
  if (hasDouble && addr.indexOf("::") !== addr.lastIndexOf("::")) return false;
  const [leftRaw, rightRaw] = addr.split("::");
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = hasDouble && rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const toNum = (g: string) => Number.parseInt(g, 16);
  const leftNums = left.map(toNum);
  const rightNums = right.map(toNum);
  if (
    leftNums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ||
    rightNums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)
  )
    return false;
  const total = leftNums.length + rightNums.length;
  if (!hasDouble && total !== 8) return false;
  if (hasDouble && total > 8) return false;
  if (prefixRaw === undefined) return true;
  if (!/^\d{1,3}$/.test(prefixRaw)) return false;
  const p = Number.parseInt(prefixRaw, 10);
  return p >= 0 && p <= 128;
}

function tldOf(hostname: string) {
  const v = normalizeDnsName(hostname.trim()).toLowerCase();
  if (!v.includes(".")) return null;
  const tld = v.split(".").pop() ?? "";
  if (!/^[a-z0-9-]{2,63}$/.test(tld)) return null;
  return tld;
}

export function SpfBuilder({
  record,
  onRecordChange,
  zoneName,
  simulateSPF,
  getSPFGraph,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  zoneName?: string;
  simulateSPF?: (domain: string, ip: string) => Promise<{
    result: string;
    reasons: string[];
    lookups: number;
  }>;
  getSPFGraph?: (domain: string) => Promise<SPFGraph>;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [newQualifier, setNewQualifier] = useState<string>("");
  const [newMechanism, setNewMechanism] = useState<string>("ip4");
  const [newValue, setNewValue] = useState<string>("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [redirect, setRedirect] = useState<string>("");
  const [simIp, setSimIp] = useState<string>("");
  const [simResult, setSimResult] = useState<{
    result: string;
    reasons: string[];
    lookups: number;
  } | null>(null);
  const [graph, setGraph] = useState<SPFGraph | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);

  const parsed = useMemo(() => parseSPF(record.content), [record.content]);

  useEffect(() => {
    const nextRedirect =
      parsed?.modifiers?.find((m) => m.key === "redirect")?.value ?? "";
    setRedirect(nextRedirect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.content]);

  const diagnostics = useMemo(() => {
    const issues: string[] = [];
    const push = (msg: string) => {
      if (!issues.includes(msg)) issues.push(msg);
    };

    const spf = parsed;
    if (!spf) {
      if ((record.content ?? "").trim())
        push("SPF: missing v=spf1 prefix (or unparseable SPF).");
      return {
        canonical: (record.content ?? "").trim(),
        issues,
        lookupEstimate: 0,
        hasAll: false,
        allQualifier: "" as "" | "+" | "-" | "~" | "?",
        hasRedirect: false,
      };
    }

    const canonical = composeSPF(spf);
    const mechCounts = new Map<string, number>();
    let hasAll = false;
    let allIndex = -1;
    let allQualifier: "" | "+" | "-" | "~" | "?" = "";

    const lookupMechs = new Set(["a", "mx", "ptr", "include", "exists"]);
    let lookupEstimate = 0;

    for (let i = 0; i < spf.mechanisms.length; i++) {
      const m = spf.mechanisms[i];
      mechCounts.set(m.mechanism, (mechCounts.get(m.mechanism) ?? 0) + 1);

      if (lookupMechs.has(m.mechanism)) lookupEstimate += 1;

      if (m.mechanism === "all") {
        hasAll = true;
        allIndex = i;
        allQualifier = (m.qualifier ?? "") as "" | "+" | "-" | "~" | "?";
        if (m.value) push("SPF: all must not have a value.");
      }

      if (m.mechanism === "ip4") {
        if (!m.value) push("SPF: ip4 requires a value like 192.0.2.0/24.");
        else if (!isValidIPv4Cidr(m.value))
          push("SPF: ip4 value must be a valid IPv4 address or CIDR (e.g., 192.0.2.0/24).");
      }
      if (m.mechanism === "ip6") {
        if (!m.value) push("SPF: ip6 requires a value like 2001:db8::/32.");
        else if (!isValidIPv6Cidr(m.value))
          push("SPF: ip6 value must be a valid IPv6 address or CIDR (e.g., 2001:db8::/32).");
      }
      if (m.mechanism === "include" || m.mechanism === "exists") {
        if (!m.value) push(`SPF: ${m.mechanism} requires a domain.`);
        else if (!looksLikeHostname(m.value))
          push(`SPF: ${m.mechanism} domain does not look like a hostname.`);
        else {
          const tld = tldOf(m.value);
          if (tld && !KNOWN_TLDS.has(tld))
            push(`SPF: ${m.mechanism} domain has unknown/invalid TLD “.${tld}”.`);
        }
      }
      if (m.mechanism === "a" || m.mechanism === "mx" || m.mechanism === "ptr") {
        if (m.mechanism === "ptr") push("SPF: ptr is discouraged (can exceed lookup limits).");
        if (m.value) {
          const domainPart = m.value.split("/")[0] ?? "";
          if (!looksLikeHostname(domainPart))
            push(`SPF: ${m.mechanism} domain does not look like a hostname.`);
          else {
            const tld = tldOf(domainPart);
            if (tld && !KNOWN_TLDS.has(tld))
              push(`SPF: ${m.mechanism} domain has unknown/invalid TLD “.${tld}”.`);
          }
        }
      }
    }

    if ((mechCounts.get("all") ?? 0) > 1) push("SPF: multiple all mechanisms found.");

    const redirectValue = spf.modifiers?.find((m) => m.key === "redirect")?.value ?? "";
    const expValue = spf.modifiers?.find((m) => m.key === "exp")?.value ?? "";
    const hasRedirect = Boolean(redirectValue);
    if (redirectValue) {
      lookupEstimate += 1;
      if (!looksLikeHostname(redirectValue))
        push("SPF: redirect= domain does not look like a hostname.");
      else {
        const tld = tldOf(redirectValue);
        if (tld && !KNOWN_TLDS.has(tld))
          push(`SPF: redirect= domain has unknown/invalid TLD “.${tld}”.`);
      }
    }
    if (expValue) lookupEstimate += 1;

    if (hasAll && allIndex !== spf.mechanisms.length - 1)
      push("SPF: all should usually be the last mechanism.");
    if (!hasAll && !hasRedirect)
      push("SPF: no all mechanism or redirect= modifier (record may be incomplete).");
    if (hasRedirect && hasAll)
      push("SPF: redirect= will never be used if an all mechanism is present.");
    if (lookupEstimate > 10)
      push(`SPF: estimated DNS lookups ${lookupEstimate}/10 (may cause permerror).`);

    const v = validateSPF(record.content ?? "");
    if (!v.ok && v.problems.length)
      push(`SPF validation issues: ${v.problems.join(", ")}`);

    return { canonical, issues, lookupEstimate, hasAll, allQualifier, hasRedirect };
  }, [parsed, record.content]);

  useEffect(() => {
    if (!onWarningsChange) return;
    onWarningsChange({
      issues: diagnostics.issues,
      nameIssues: [],
      canonical: diagnostics.canonical,
    });
  }, [diagnostics.canonical, diagnostics.issues, onWarningsChange]);

  const addOrUpdateMechanism = () => {
    const mechVal = newValue.trim();
    const next: SPFMechanism = {
      qualifier: newQualifier || undefined,
      mechanism: newMechanism,
      value: mechVal || undefined,
    };
    const current =
      parseSPF(record.content) ?? ({ version: "v=spf1", mechanisms: [] } as any);
    const mechs = [...(current.mechanisms ?? [])];
    if (editingIndex !== null && editingIndex >= 0 && editingIndex < mechs.length) {
      mechs[editingIndex] = next;
      setEditingIndex(null);
    } else {
      mechs.push(next);
    }
    onRecordChange({
      ...record,
      content: composeSPF({
        version: current.version,
        mechanisms: mechs,
        modifiers: current.modifiers,
      }),
    });
    setNewValue("");
    setNewQualifier("");
    setNewMechanism("ip4");
  };

  const removeMechanism = (index: number) => {
    const current =
      parseSPF(record.content) ?? ({ version: "v=spf1", mechanisms: [] } as any);
    const mechs = [...(current.mechanisms ?? [])];
    mechs.splice(index, 1);
    onRecordChange({
      ...record,
      content: composeSPF({
        version: current.version,
        mechanisms: mechs,
        modifiers: current.modifiers,
      }),
    });
  };

  const editMechanism = (index: number) => {
    const current = parseSPF(record.content);
    const m = current?.mechanisms?.[index];
    if (!m) return;
    setNewQualifier(m.qualifier || "");
    setNewMechanism(m.mechanism || "ip4");
    setNewValue(m.value || "");
    setEditingIndex(index);
  };

  const applyRedirect = (next: string) => {
    setRedirect(next);
    const current =
      parseSPF(record.content) ?? ({ version: "v=spf1", mechanisms: [] } as any);
    const mods = (current.modifiers ?? []).filter((m: any) => m.key !== "redirect");
    if (next) mods.push({ key: "redirect", value: next });
    onRecordChange({
      ...record,
      content: composeSPF({
        version: current.version,
        mechanisms: current.mechanisms ?? [],
        modifiers: mods.length ? mods : undefined,
      }),
    });
  };

  const canSimulate = Boolean(simulateSPF && zoneName);
  const canGraph = Boolean(getSPFGraph && zoneName);
  const domainForZone = () => {
    if (!zoneName) return "";
    const name = (record.name ?? "").trim();
    if (!name || name === "@") return zoneName;
    return `${normalizeDnsName(name)}.${zoneName}`;
  };

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-muted-foreground">SPF builder</div>
        <div className="text-[11px] text-muted-foreground">
          Est. DNS lookups: {diagnostics.lookupEstimate}/10
        </div>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
        <div className="space-y-1 sm:col-span-1">
          <Label className="text-xs">Qualifier</Label>
          <Select
            value={newQualifier || "+"}
            onValueChange={(value: string) => setNewQualifier(value === "+" ? "" : value)}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="+">+ pass</SelectItem>
              <SelectItem value="-">- fail</SelectItem>
              <SelectItem value="~">~ softfail</SelectItem>
              <SelectItem value="?">? neutral</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Mechanism</Label>
          <Select value={newMechanism} onValueChange={(value: string) => setNewMechanism(value)}>
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ip4">ip4</SelectItem>
              <SelectItem value="ip6">ip6</SelectItem>
              <SelectItem value="a">a</SelectItem>
              <SelectItem value="mx">mx</SelectItem>
              <SelectItem value="include">include</SelectItem>
              <SelectItem value="exists">exists</SelectItem>
              <SelectItem value="ptr">ptr</SelectItem>
              <SelectItem value="all">all</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Value</Label>
          <Input
            className="h-8"
            value={newMechanism === "all" ? "" : newValue}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setNewValue(e.target.value)}
            disabled={newMechanism === "all"}
            placeholder={(() => {
              switch (newMechanism) {
                case "ip4":
                  return "192.0.2.0/24";
                case "ip6":
                  return "2001:db8::/32";
                case "include":
                  return "_spf.example.com";
                case "exists":
                  return "exists.example.com";
                case "a":
                case "mx":
                case "ptr":
                  return "optional: example.com/24//64";
                default:
                  return "";
              }
            })()}
          />
        </div>

        <div className="flex items-end sm:col-span-1">
          <Button size="sm" className="h-8 w-full" onClick={addOrUpdateMechanism}>
            {editingIndex !== null ? "Update" : "Add"}
          </Button>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
        <div className="text-xs font-semibold text-muted-foreground">Mechanisms</div>
        <div className="mt-2 space-y-2">
          {parsed?.mechanisms?.length ? (
            parsed.mechanisms.map((m, i) => (
              <div key={`${m.mechanism}:${i}`} className="flex flex-wrap items-center gap-2">
                <div className="text-xs text-foreground/85">
                  {`${m.qualifier ?? ""}${m.mechanism}${m.value ? `:${m.value}` : ""}`}
                  {editingIndex === i ? " (editing)" : ""}
                </div>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => editMechanism(i)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => removeMechanism(i)}>
                    Remove
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <div className="text-[11px] text-muted-foreground">
              No mechanisms yet. Add include/ip4/ip6 and end with <code>~all</code> or{" "}
              <code>-all</code>.
            </div>
          )}
        </div>

        {parsed?.mechanisms?.length ? (
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const current =
                  parseSPF(record.content) ?? ({ version: "v=spf1", mechanisms: [] } as any);
                const all = (current.mechanisms ?? []).filter((m: any) => m.mechanism === "all");
                const rest = (current.mechanisms ?? []).filter((m: any) => m.mechanism !== "all");
                onRecordChange({
                  ...record,
                  content: composeSPF({
                    version: current.version,
                    mechanisms: [...rest, ...all] as SPFMechanism[],
                    modifiers: current.modifiers,
                  }),
                });
              }}
            >
              Move all to end
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const current =
                  parseSPF(record.content) ?? ({ version: "v=spf1", mechanisms: [] } as any);
                const mechs = (current.mechanisms ?? []).filter((m: any) => m.mechanism !== "ptr");
                onRecordChange({
                  ...record,
                  content: composeSPF({
                    version: current.version,
                    mechanisms: mechs,
                    modifiers: current.modifiers,
                  }),
                });
              }}
            >
              Remove ptr
            </Button>
          </div>
        ) : null}
      </div>

      <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
        <div className="text-xs font-semibold text-muted-foreground">Redirect (optional)</div>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-5">
          <div className="sm:col-span-4">
            <Input
              className="h-8"
              value={redirect}
              onChange={(e: ChangeEvent<HTMLInputElement>) => applyRedirect(e.target.value.trim())}
              placeholder="_spf.example.com"
            />
          </div>
          <div className="sm:col-span-1">
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-full"
              onClick={() => applyRedirect("")}
              disabled={!redirect}
            >
              Clear
            </Button>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          Used only if no mechanism matches. Don’t combine with an <code>all</code> mechanism.
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-border/60 bg-background/20 p-3">
        <div className="text-xs font-semibold text-muted-foreground">Preview (canonical)</div>
        <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{diagnostics.canonical}</pre>
      </div>

      {diagnostics.issues.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <div className="text-sm font-semibold">SPF warnings</div>
          <div className="scrollbar-themed mt-2 max-h-40 overflow-auto pr-2">
            <ul className="list-disc pl-5 text-xs text-foreground/85">
              {diagnostics.issues.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {(canSimulate || canGraph) && (
        <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
          <div className="text-xs font-semibold text-muted-foreground">Test</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Input
              className="h-8 flex-1 min-w-48"
              placeholder="simulate IP e.g., 203.0.113.10"
              value={simIp}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSimIp(e.target.value)}
            />
            {canSimulate && (
              <Button
                size="sm"
                className="h-8"
                onClick={async () => {
                  if (!simulateSPF) return;
                  const domain = domainForZone();
                  if (!domain) return;
                  try {
                    const result = await simulateSPF(domain, simIp);
                    setSimResult(result);
                  } catch (err) {
                    setSimResult({
                      result: "temperror",
                      reasons: [(err as Error).message],
                      lookups: 0,
                    });
                  }
                }}
              >
                Simulate
              </Button>
            )}
            {canGraph && (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={async () => {
                  if (!getSPFGraph) return;
                  const domain = domainForZone();
                  if (!domain) return;
                  try {
                    const g = await getSPFGraph(domain);
                    setGraph(g);
                    setGraphError(null);
                  } catch (err) {
                    setGraph(null);
                    setGraphError((err as Error).message);
                  }
                }}
              >
                Graph
              </Button>
            )}
          </div>

          {simResult && (
            <div className="mt-3 text-sm">
              Result: <span className="font-semibold">{simResult.result}</span> (lookups:{" "}
              {simResult.lookups})
              <div className="mt-1 text-xs text-muted-foreground">{simResult.reasons.join(", ")}</div>
            </div>
          )}

          {graphError && (
            <div className="mt-3 text-sm text-red-600">Error building graph: {graphError}</div>
          )}
          {graph && (
            <div className="mt-3">
              <div className="text-xs font-semibold text-muted-foreground">Graph</div>
              <pre className="scrollbar-themed mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/30 p-2 text-xs">
                {JSON.stringify(graph, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

