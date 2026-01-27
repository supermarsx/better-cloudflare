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
import { composeNAPTR, parseNAPTR } from "@/lib/dns-parsers";
import { KNOWN_TLDS } from "@/lib/tlds";

import type { BuilderWarningsChange, RecordDraft } from "./types";

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.$/, "");
}

function isValidDnsLabel(label: string) {
  if (!label) return false;
  if (label.length > 63) return false;
  if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
  if (label.startsWith("-") || label.endsWith("-")) return false;
  return true;
}

function looksLikeHostname(value: string) {
  const v = normalizeDnsName(value);
  if (!v) return false;
  if (/\s/.test(v)) return false;
  if (v.length > 253) return false;
  if (v.includes("..")) return false;
  if (v.includes("://") || v.includes("/")) return false;
  const labels = v.split(".");
  if (labels.some((l) => l.length === 0)) return false;
  return labels.every(isValidDnsLabel);
}

const NAPTR_FLAG_PRESETS: Array<{ value: string; label: string; description: string }> =
  [
    {
      value: "U",
      label: "U — URI",
      description: "Terminal rule; the regexp replacement produces a URI.",
    },
    {
      value: "S",
      label: "S — SRV",
      description: "Terminal rule; the replacement points to an SRV record.",
    },
    {
      value: "A",
      label: "A — A/AAAA",
      description: "Terminal rule; the replacement points to A/AAAA.",
    },
    {
      value: "P",
      label: "P — Protocol-specific",
      description: "Terminal rule; protocol-specific processing.",
    },
  ];

const NAPTR_SERVICE_PRESETS: Array<{ value: string; label: string; description: string }> =
  [
    { value: "E2U+sip", label: "E2U+sip", description: "SIP URI resolution." },
    { value: "E2U+sips", label: "E2U+sips", description: "Secure SIP URI resolution." },
    { value: "E2U+email", label: "E2U+email", description: "Email address resolution." },
    { value: "E2U+sms", label: "E2U+sms", description: "SMS resolution." },
    { value: "E2U+tel", label: "E2U+tel", description: "Telephone number resolution." },
    { value: "E2U+fax", label: "E2U+fax", description: "Fax resolution." },
    { value: "E2U+web:http", label: "E2U+web:http", description: "Web (HTTP) URI resolution." },
    { value: "E2U+web:https", label: "E2U+web:https", description: "Web (HTTPS) URI resolution." },
  ];

function splitByUnescapedDelimiter(value: string, delimiter: string) {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
      continue;
    }
    if (ch === delimiter) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  return { parts, tail: current };
}

function validateNaptrRegexp(value: string): string[] {
  const issues: string[] = [];
  const push = (msg: string) => {
    if (!issues.includes(msg)) issues.push(msg);
  };

  const v = value.trim();
  if (!v) return issues;

  const delimiter = v[0];
  if (/^[A-Za-z0-9]$/.test(delimiter)) {
    push("NAPTR: regexp should start with a non-alphanumeric delimiter (e.g., !).");
    return issues;
  }

  const rest = v.slice(1);
  const { parts, tail } = splitByUnescapedDelimiter(rest, delimiter);
  if (parts.length < 2) {
    push("NAPTR: regexp should contain at least 2 delimiters: <delim>pattern<delim>replacement<delim>flags?.");
    return issues;
  }

  const pattern = parts[0];
  const replacement = parts[1];
  const flags = parts.length >= 3 ? parts[2] : tail;

  if (!pattern) push("NAPTR: regexp pattern is empty.");
  if (!replacement) push("NAPTR: regexp replacement is empty.");

  if (parts.length >= 3 && tail) {
    push("NAPTR: regexp has extra trailing text after the last delimiter.");
  }
  if (parts.length > 3) {
    push("NAPTR: regexp contains more delimiters than expected; ensure delimiters inside the pattern are escaped.");
  }

  if (pattern) {
    try {
      // Note: NAPTR uses a substitution expression; regex dialect may differ by implementation.
      // Still validate the pattern for common mistakes.
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch {
      push("NAPTR: regexp pattern does not look like a valid regular expression.");
    }
  }

  if (flags && /\s/.test(flags)) push("NAPTR: regexp flags contain whitespace.");
  return issues;
}

export function NaptrBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [order, setOrder] = useState<number | undefined>(undefined);
  const [preference, setPreference] = useState<number | undefined>(undefined);
  const [flags, setFlags] = useState<string>("");
  const [service, setService] = useState<string>("");
  const [regexp, setRegexp] = useState<string>("");
  const [replacement, setReplacement] = useState<string>("");

  const flagsSelectValue = useMemo(() => {
    const v = (flags ?? "").trim();
    if (!v) return "custom";
    const match = NAPTR_FLAG_PRESETS.find(
      (p) => p.value.toLowerCase() === v.toLowerCase(),
    );
    return match ? match.value : "custom";
  }, [flags]);

  const flagsDescriptor = useMemo(() => {
    const v = (flags ?? "").trim();
    if (!v) return null;
    return (
      NAPTR_FLAG_PRESETS.find((p) => p.value.toLowerCase() === v.toLowerCase())
        ?.description ?? null
    );
  }, [flags]);

  const serviceSelectValue = useMemo(() => {
    const v = (service ?? "").trim();
    if (!v) return "custom";
    const match = NAPTR_SERVICE_PRESETS.find(
      (p) => p.value.toLowerCase() === v.toLowerCase(),
    );
    return match ? match.value : "custom";
  }, [service]);

  const serviceDescriptor = useMemo(() => {
    const v = (service ?? "").trim();
    if (!v) return null;
    return (
      NAPTR_SERVICE_PRESETS.find((p) => p.value.toLowerCase() === v.toLowerCase())
        ?.description ?? null
    );
  }, [service]);

  useEffect(() => {
    if (record.type !== "NAPTR") return;
    const parsed = parseNAPTR(record.content);
    setOrder(parsed.order);
    setPreference(parsed.preference);
    setFlags(parsed.flags ?? "");
    setService(parsed.service ?? "");
    setRegexp(parsed.regexp ?? "");
    setReplacement(parsed.replacement ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "NAPTR") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }
    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const o = order;
    const p = preference;
    const f = (flags ?? "").trim();
    const s = (service ?? "").trim();
    const r = (regexp ?? "").trim();
    const rep = (replacement ?? "").trim();

    if (o === undefined) push(issues, "NAPTR: order is required.");
    else if (o < 0 || o > 65535) push(issues, "NAPTR: order should be 0–65535.");
    if (p === undefined) push(issues, "NAPTR: preference is required.");
    else if (p < 0 || p > 65535) push(issues, "NAPTR: preference should be 0–65535.");

    if (!f) push(issues, "NAPTR: flags are empty (often U, S, P, or A).");
    if (f && /\s/.test(f)) push(issues, "NAPTR: flags contain whitespace.");
    if (f && f.length > 20) push(issues, "NAPTR: flags look unusually long.");

    if (!s) push(issues, "NAPTR: service is empty (e.g., E2U+sip).");
    if (s && /\s/.test(s)) push(issues, "NAPTR: service contains whitespace.");

    if (!r) push(issues, "NAPTR: regexp is empty (use \"\" if unused).");
    if (r && r.length > 1024) push(issues, "NAPTR: regexp is very long.");
    if (r) {
      for (const w of validateNaptrRegexp(r)) push(issues, w);
    }

    if (!rep) push(issues, "NAPTR: replacement is empty (use \".\" if unused).");
    if (rep && rep !== "." && !looksLikeHostname(rep))
      push(issues, "NAPTR: replacement does not look like a hostname (or \".\").");
    if (rep && rep !== "." && looksLikeHostname(rep)) {
      const tld = normalizeDnsName(rep).split(".").pop()?.toLowerCase() ?? "";
      if (tld && normalizeDnsName(rep).includes(".") && /^[a-z0-9-]{2,63}$/.test(tld)) {
        if (!KNOWN_TLDS.has(tld))
          push(issues, `NAPTR: replacement has unknown/invalid TLD “.${tld}”.`);
      }
    }

    const canonical = composeNAPTR(o, p, f, s, r, rep);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(issues, "NAPTR: content differs from builder settings (Apply canonical to normalize).");
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        "NAPTR: name is typically the domain being rewritten (often @).",
      );

    return { canonical, issues, nameIssues };
  }, [flags, order, preference, record.content, record.name, record.type, regexp, replacement, service]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "NAPTR") {
      onWarningsChange({ issues: [], nameIssues: [], canonical: "" });
      return;
    }
    onWarningsChange({
      issues: diagnostics.issues,
      nameIssues: diagnostics.nameIssues,
      canonical: diagnostics.canonical,
    });
  }, [diagnostics.canonical, diagnostics.issues, diagnostics.nameIssues, onWarningsChange, record.type]);

  if (record.type !== "NAPTR") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            NAPTR builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>order preference flags service regexp replacement</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">Order</Label>
            <Input
              type="number"
              placeholder="100"
              value={order ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setOrder(val);
                onRecordChange({
                  ...record,
                  content: composeNAPTR(val, preference, flags, service, regexp, replacement),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Lower order processed first.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">Preference</Label>
            <Input
              type="number"
              placeholder="10"
              value={preference ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setPreference(val);
                onRecordChange({
                  ...record,
                  content: composeNAPTR(order, val, flags, service, regexp, replacement),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Lower preferred within same order.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">Flags</Label>
            <Select
              value={flagsSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") return;
                setFlags(value);
                onRecordChange({
                  ...record,
                  content: composeNAPTR(order, preference, value, service, regexp, replacement),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Custom…" />
              </SelectTrigger>
              <SelectContent>
                {NAPTR_FLAG_PRESETS.map((preset) => (
                  <SelectItem key={preset.value} value={preset.value}>
                    {preset.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="mt-2"
              placeholder='e.g., U (or custom flags)'
              value={flags}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setFlags(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeNAPTR(order, preference, e.target.value, service, regexp, replacement),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              {flagsDescriptor ?? "Common: U/S/P/A (depends on use case)."}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Service</Label>
            <Select
              value={serviceSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") return;
                setService(value);
                onRecordChange({
                  ...record,
                  content: composeNAPTR(order, preference, flags, value, regexp, replacement),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Custom…" />
              </SelectTrigger>
              <SelectContent>
                {NAPTR_SERVICE_PRESETS.map((preset) => (
                  <SelectItem key={preset.value} value={preset.value}>
                    {preset.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="mt-2"
              placeholder="e.g., E2U+sip"
              value={service}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setService(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeNAPTR(order, preference, flags, e.target.value, regexp, replacement),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              {serviceDescriptor ?? (
                <>
                  Service parameters, often like <code>E2U+sip</code>.
                </>
              )}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-3">
            <Label className="text-xs">Regexp</Label>
            <Input
              placeholder='e.g., "!^.*$!sip:info@example.com!"'
              value={regexp}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setRegexp(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeNAPTR(order, preference, flags, service, e.target.value, replacement),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Quoted automatically if it contains spaces/quotes.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-3">
            <Label className="text-xs">Replacement</Label>
            <Input
              placeholder="e.g., . or target.example.com"
              value={replacement}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setReplacement(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeNAPTR(order, preference, flags, service, regexp, e.target.value),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Use <code>.</code> when the regexp field is used.
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseNAPTR(record.content);
              setOrder(parsed.order);
              setPreference(parsed.preference);
              setFlags(parsed.flags ?? "");
              setService(parsed.service ?? "");
              setRegexp(parsed.regexp ?? "");
              setReplacement(parsed.replacement ?? "");
            }}
          >
            Load from content
          </Button>
          <Button
            size="sm"
            onClick={() => onRecordChange({ ...record, content: diagnostics.canonical })}
          >
            Apply canonical to content
          </Button>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/20 p-3">
          <div className="text-xs font-semibold text-muted-foreground">
            Preview (canonical)
          </div>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
            {diagnostics.canonical}
          </pre>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
          <div className="text-xs font-semibold text-muted-foreground">
            Recommendations
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
            <li>
              Prefer explicit and consistent <code>order</code>/<code>preference</code> values.
            </li>
            <li>
              Use <code>.</code> as replacement when you rely on <code>regexp</code>.
            </li>
            <li>NAPTR is complex—double-check your target protocol requirements.</li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">NAPTR warnings</div>
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
