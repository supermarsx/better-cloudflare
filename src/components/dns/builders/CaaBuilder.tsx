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
import { Switch } from "@/components/ui/switch";
import { KNOWN_TLDS } from "@/lib/tlds";

import type { BuilderWarningsChange, RecordDraft } from "./types";

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.$/, "");
}

function unescapeDnsQuotedString(value: string) {
  return value.replace(/\\\\/g, "\\").replace(/\\"/g, "\"");
}

function escapeDnsQuotedString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function parseCAAContent(value: string | undefined) {
  const raw = (value ?? "").trim();
  if (!raw) {
    return { flags: undefined as number | undefined, tag: "", value: "" };
  }
  const m = raw.match(/^\s*(\d{1,3})\s+([A-Za-z0-9-]+)\s+(.*)\s*$/);
  if (!m) {
    return { flags: undefined as number | undefined, tag: "", value: raw };
  }
  const flagsRaw = m[1] ?? "";
  const tag = (m[2] ?? "").trim().toLowerCase();
  const rest = (m[3] ?? "").trim();
  const flagsNum = Number.parseInt(flagsRaw, 10);
  let v = rest;
  if (v.startsWith("\"") && v.endsWith("\"") && v.length >= 2) {
    v = unescapeDnsQuotedString(v.slice(1, -1));
  }
  return { flags: Number.isNaN(flagsNum) ? undefined : flagsNum, tag, value: v };
}

function composeCAA(fields: { flags: number | undefined; tag: string; value: string }) {
  const flags = fields.flags ?? 0;
  const tag = (fields.tag ?? "").trim().toLowerCase();
  const v = `"${escapeDnsQuotedString((fields.value ?? "").trim())}"`;
  return `${flags} ${tag} ${v}`.replace(/\s+/g, " ").trim();
}

export function CaaBuilder({
  record,
  onRecordChange,
  zoneName,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  zoneName?: string;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [caaFlags, setCaaFlags] = useState<number | undefined>(undefined);
  const [caaTag, setCaaTag] = useState<"issue" | "issuewild" | "iodef" | "custom">(
    "issue",
  );
  const [caaTagCustom, setCaaTagCustom] = useState<string>("");
  const [caaValue, setCaaValue] = useState<string>("");

  useEffect(() => {
    if (record.type !== "CAA") return;
    const parsed = parseCAAContent(record.content);
    setCaaFlags(parsed.flags);
    if (parsed.tag) {
      const tag = parsed.tag.toLowerCase();
      if (tag === "issue" || tag === "issuewild" || tag === "iodef") {
        setCaaTag(tag);
        setCaaTagCustom("");
      } else {
        setCaaTag("custom");
        setCaaTagCustom(tag);
      }
    }
    setCaaValue(parsed.value ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "CAA") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }
    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const isValidDnsLabel = (label: string) => {
      if (!label) return false;
      if (label.length > 63) return false;
      if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
      if (label.startsWith("-") || label.endsWith("-")) return false;
      return true;
    };
    const isValidHostname = (value: string) => {
      const v = normalizeDnsName(value);
      if (!v) return false;
      if (/\s/.test(v)) return false;
      if (v.length > 253) return false;
      if (v.includes("..")) return false;
      const labels = v.split(".");
      if (labels.some((l) => l.length === 0)) return false;
      return labels.every(isValidDnsLabel);
    };
    const validateEmailAddress = (address: string) => {
      const a = address.trim();
      if (!a) return "missing an email address.";
      if (/\s/.test(a)) return "email address contains whitespace.";
      const at = a.indexOf("@");
      if (at <= 0 || at !== a.lastIndexOf("@") || at === a.length - 1)
        return "invalid email (expected local@domain).";
      const domain = normalizeDnsName(a.slice(at + 1));
      if (!isValidHostname(domain)) return "email domain does not look like a hostname.";
      const labels = domain.split(".");
      if (labels.length < 2) return "email domain should be a FQDN.";
      const tld = labels[labels.length - 1]?.toLowerCase() ?? "";
      if (tld && !KNOWN_TLDS.has(tld))
        return `email domain uses an unknown/invalid TLD “.${tld}”.`;
      return null;
    };

    const effectiveTag =
      caaTag === "custom" ? caaTagCustom.trim().toLowerCase() : (caaTag as string);
    const flags = caaFlags ?? 0;
    const critical = (flags & 128) !== 0;
    const value = (caaValue ?? "").trim();

    if (caaFlags !== undefined) {
      if (caaFlags < 0 || caaFlags > 255) push(issues, "CAA: flags must be 0–255.");
      if (critical) {
        push(
          issues,
          "CAA: critical flag is set (128). Clients that don't understand the tag may reject issuance.",
        );
      }
    } else {
      push(issues, "CAA: flags are missing (usually 0).");
    }

    if (!effectiveTag) {
      push(issues, "CAA: tag is missing (issue, issuewild, iodef, or custom).");
    } else {
      if (!/^[a-z0-9-]+$/.test(effectiveTag))
        push(issues, "CAA: tag contains unusual characters.");
      if (effectiveTag.length > 15)
        push(issues, "CAA: tag is unusually long (common tags are short).");
      const known = new Set(["issue", "issuewild", "iodef"]);
      if (!known.has(effectiveTag) && !caaTagCustom.trim())
        push(issues, "CAA: custom tag is empty.");
      if (!known.has(effectiveTag) && critical)
        push(issues, "CAA: critical + unknown tag may break issuance for some clients.");
    }

    if (!value) {
      push(issues, "CAA: value is empty.");
    } else if (effectiveTag === "issue" || effectiveTag === "issuewild") {
      const beforeParams = value.split(";")[0]?.trim() ?? "";
      if (!beforeParams) {
        push(
          issues,
          `CAA: ${effectiveTag} value has no CA domain (this may intentionally forbid issuance).`,
        );
      } else {
        if (!isValidHostname(beforeParams))
          push(issues, `CAA: ${effectiveTag} CA domain does not look like a hostname.`);
        const tld = normalizeDnsName(beforeParams).split(".").pop()?.toLowerCase() ?? "";
        if (tld && beforeParams.includes(".") && !KNOWN_TLDS.has(tld))
          push(issues, `CAA: ${effectiveTag} CA domain has unknown/invalid TLD “.${tld}”.`);
      }
      if (value.includes("://"))
        push(issues, `CAA: ${effectiveTag} value looks like a URL; expected CA domain.`);
    } else if (effectiveTag === "iodef") {
      const v = value;
      if (v.toLowerCase().startsWith("mailto:")) {
        const addr = v.slice("mailto:".length).split("?")[0]?.trim() ?? "";
        const emailProblem = validateEmailAddress(addr);
        if (emailProblem) push(issues, `CAA: iodef mailto ${emailProblem}`);
      } else {
        try {
          // eslint-disable-next-line no-new
          const u = new URL(v);
          if (u.protocol !== "http:" && u.protocol !== "https:")
            push(issues, "CAA: iodef should be mailto:, http:, or https:.");
        } catch {
          push(issues, "CAA: iodef value does not parse as a valid URL or mailto:.");
        }
      }
    }

    const canonical = composeCAA({
      flags,
      tag: effectiveTag || "issue",
      value,
    });
    const content = (record.content ?? "").trim();
    if (content && content !== canonical) {
      push(
        issues,
        "CAA: content differs from builder settings (use Apply canonical to normalize).",
      );
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        'CAA: name is often "@" (zone apex) unless you need subdomain-specific policy.',
      );

    return { canonical, issues, nameIssues };
  }, [record.type, record.content, record.name, caaFlags, caaTag, caaTagCustom, caaValue]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "CAA") {
      onWarningsChange({ issues: [], nameIssues: [], canonical: "" });
      return;
    }
    onWarningsChange({
      issues: diagnostics.issues,
      nameIssues: diagnostics.nameIssues,
      canonical: diagnostics.canonical,
    });
  }, [diagnostics.canonical, diagnostics.issues, diagnostics.nameIssues, onWarningsChange, record.type]);

  const effectiveTag =
    caaTag === "custom" ? caaTagCustom.trim().toLowerCase() : (caaTag as string);
  const critical = ((caaFlags ?? 0) & 128) !== 0;
  const valuePlaceholder =
    effectiveTag === "iodef"
      ? `mailto:security@${zoneName ?? "example.com"}`
      : effectiveTag === "issuewild"
        ? "letsencrypt.org (for wildcard certs)"
        : "letsencrypt.org";

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">CAA builder</div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>flags tag "value"</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Tag</Label>
            <Select
              value={caaTag}
              onValueChange={(v: string) => setCaaTag(v as typeof caaTag)}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="issue">issue</SelectItem>
                <SelectItem value="issuewild">issuewild</SelectItem>
                <SelectItem value="iodef">iodef</SelectItem>
                <SelectItem value="custom">custom…</SelectItem>
              </SelectContent>
            </Select>
            {caaTag === "custom" && (
              <Input
                className="mt-2"
                value={caaTagCustom}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setCaaTagCustom(e.target.value)}
                placeholder="e.g., issue"
              />
            )}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Flags</Label>
            <Input
              type="number"
              value={caaFlags ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                setCaaFlags(Number.isNaN(n) ? undefined : n);
              }}
              placeholder="0"
            />
            <div className="text-[11px] text-muted-foreground">
              Usually <code>0</code>. <code>128</code> sets critical.
            </div>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Critical</Label>
            <div className="flex h-9 items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3">
              <Switch
                checked={critical}
                onCheckedChange={(checked: boolean) => {
                  const base = caaFlags ?? 0;
                  const next = checked ? base | 128 : base & ~128;
                  setCaaFlags(next);
                }}
              />
              <span className="text-xs text-muted-foreground">
                {critical ? "On (128)" : "Off"}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Use sparingly; unknown tags may break issuance.
            </div>
          </div>
        </div>

        <div className="mt-2 space-y-1">
          <Label className="text-xs">Value</Label>
          <Input
            value={caaValue}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setCaaValue(e.target.value)}
            placeholder={valuePlaceholder}
          />
          <div className="text-[11px] text-muted-foreground">
            {effectiveTag === "iodef"
              ? "Where to send policy violation reports (mailto: or https://)."
              : "CA domain (optional parameters after ';')."}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => onRecordChange({ ...record, name: "@" })}>
            Set name to @
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseCAAContent(record.content);
              setCaaFlags(parsed.flags);
              const tag = (parsed.tag ?? "").toLowerCase();
              if (tag === "issue" || tag === "issuewild" || tag === "iodef") {
                setCaaTag(tag);
                setCaaTagCustom("");
              } else {
                setCaaTag("custom");
                setCaaTagCustom(tag);
              }
              setCaaValue(parsed.value ?? "");
            }}
          >
            Load from content
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onRecordChange({ ...record, content: diagnostics.canonical });
            }}
          >
            Apply canonical to content
          </Button>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/20 p-3">
          <div className="text-xs font-semibold text-muted-foreground">Preview (canonical)</div>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{diagnostics.canonical}</pre>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
          <div className="text-xs font-semibold text-muted-foreground">Recommendations</div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
            <li>
              Add one <code>issue</code> record per allowed CA (multiple CAA records are
              normal).
            </li>
            <li>
              Use <code>issuewild</code> only if you plan to issue wildcard certificates.
            </li>
            <li>
              Keep flags at <code>0</code> unless you know you need critical behavior.
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCaaTag("issue");
                setCaaValue("letsencrypt.org");
                setCaaFlags(0);
              }}
            >
              Preset: Let&apos;s Encrypt (issue)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCaaTag("issuewild");
                setCaaValue("letsencrypt.org");
                setCaaFlags(0);
              }}
            >
              Preset: Let&apos;s Encrypt (issuewild)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCaaTag("iodef");
                setCaaValue(`mailto:security@${zoneName ?? "example.com"}`);
                setCaaFlags(0);
              }}
            >
              Preset: iodef mailto
            </Button>
          </div>
        </div>

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">CAA warnings</div>
            <div className="scrollbar-themed mt-2 max-h-40 overflow-auto pr-2">
              <ul className="list-disc pl-5 text-xs text-foreground/85">
                {diagnostics.nameIssues.map((w) => (
                  <li key={w}>{w}</li>
                ))}
                {diagnostics.issues.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

