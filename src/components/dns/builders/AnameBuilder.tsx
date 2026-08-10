import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KNOWN_TLDS } from "@/lib/dns/tlds";

import {
  BuilderFieldLabel,
  RecordSummary,
  useBuilderFieldIds,
} from "./BuilderField";
import type {
  BuilderSummary,
  BuilderWarningsChange,
  RecordDraft,
} from "./types";

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
  if (v.includes("://")) return false;
  if (v.includes("/")) return false;
  const labels = v.split(".");
  if (labels.some((l) => l.length === 0)) return false;
  return labels.every(isValidDnsLabel);
}

export type AnameFields = {
  target: string;
  /** ANAME and ALIAS are the same feature under two vendor names. */
  kind: "ANAME" | "ALIAS";
};

/**
 * Plain-English description of a provider-flattened apex alias.
 *
 * ANAME/ALIAS is not an IETF record type: the provider resolves the target and
 * serves its addresses at the owner name. Everything about how often that
 * happens is provider policy, so it stays in `unknowns`.
 */
export function describeANAME(fields: AnameFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const target = normalizeDnsName(fields.target);

  const headline = target
    ? `Has the DNS provider look up ${target}'s A and AAAA records and serve those addresses at this name, giving CNAME-like aliasing at a name where a CNAME is not allowed.`
    : "Has the DNS provider look up another hostname's A and AAAA records and serve those addresses at this name, giving CNAME-like aliasing at a name where a CNAME is not allowed.";

  details.push(
    `${fields.kind} is a provider feature rather than an IETF record type: the provider resolves the target and flattens the result, so clients only ever receive ordinary A and AAAA answers.`,
  );
  details.push(
    "That flattening is what makes apex aliasing possible — a CNAME may not exist at a zone apex, which has to hold SOA and NS records.",
  );
  details.push(
    "The addresses served are whatever the provider last resolved, so a change at the target only shows up here after the provider re-resolves it.",
  );
  details.push(
    "Cloudflare has no ANAME or ALIAS type; it reaches the same result by flattening an ordinary CNAME record at the apex.",
  );

  unknowns.push(
    `Whether this zone's provider supports ${fields.kind} at all, and how often it re-resolves the target, cannot be determined here.`,
  );
  if (target) {
    unknowns.push(
      `Which addresses end up being served depends on the A and AAAA records published at ${target}, which cannot be checked from here.`,
    );
  }

  return { headline, details, unknowns };
}

export function AnameBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [target, setTarget] = useState("");
  const { fieldIds, helpIds } = useBuilderFieldIds(["target"] as const);

  const summary = useMemo(
    () =>
      describeANAME({
        target,
        kind: record.type === "ALIAS" ? "ALIAS" : "ANAME",
      }),
    [record.type, target],
  );

  useEffect(() => {
    if (record.type !== "ANAME" && record.type !== "ALIAS") return;
    setTarget(record.content ?? "");
  }, [record.content, record.type]);

  const diagnostics = useMemo(() => {
    if (record.type !== "ANAME" && record.type !== "ALIAS") {
      return {
        canonical: "",
        issues: [] as string[],
        nameIssues: [] as string[],
      };
    }

    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const t = normalizeDnsName(target);
    if (!t) push(issues, `${record.type}: target is required (hostname).`);
    if (t && !looksLikeHostname(t))
      push(issues, `${record.type}: target does not look like a hostname.`);

    if (t && looksLikeHostname(t)) {
      const norm = normalizeDnsName(t).toLowerCase();
      const tld = norm.split(".").pop() ?? "";
      if (tld && norm.includes(".") && /^[a-z0-9-]{2,63}$/.test(tld)) {
        if (!KNOWN_TLDS.has(tld))
          push(
            issues,
            `${record.type}: target has unknown/invalid TLD “.${tld}”.`,
          );
      }
    }

    push(
      issues,
      `${record.type}: note this record type is not officially supported by Cloudflare DNS; creation may fail.`,
    );

    const canonical = normalizeDnsName(target);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(
        issues,
        `${record.type}: content differs from builder settings (Apply canonical to normalize).`,
      );
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        `${record.type}: name is commonly @ (apex) when using ANAME/ALIAS for apex aliasing.`,
      );

    return { canonical, issues, nameIssues };
  }, [record.content, record.name, record.type, target]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "ANAME" && record.type !== "ALIAS") {
      onWarningsChange({ issues: [], nameIssues: [], canonical: "" });
      return;
    }
    onWarningsChange({
      issues: diagnostics.issues,
      nameIssues: diagnostics.nameIssues,
      canonical: diagnostics.canonical,
    });
  }, [
    diagnostics.canonical,
    diagnostics.issues,
    diagnostics.nameIssues,
    onWarningsChange,
    record.type,
  ]);

  if (record.type !== "ANAME" && record.type !== "ALIAS") return null;

  const title = record.type === "ALIAS" ? "ALIAS builder" : "ANAME builder";

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            {title}
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>target</code>
          </div>
        </div>

        <RecordSummary summary={summary} className="mt-2" />

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-6">
            <BuilderFieldLabel
              controlId={fieldIds.target}
              descriptionId={helpIds.target}
              label="Target"
              help="The hostname whose A and AAAA records should be served at this name, such as app.example.net. Give a hostname only — no scheme, port or path — and make sure it publishes address records of its own."
            />
            <Input
              id={fieldIds.target}
              aria-describedby={helpIds.target}
              placeholder="e.g., target.example.com"
              value={target}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setTarget(e.target.value);
                onRecordChange({
                  ...record,
                  content: normalizeDnsName(e.target.value),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Hostname target (no scheme/path). Typically used for apex
              aliasing.
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setTarget(record.content ?? "")}
          >
            Load from content
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onRecordChange({ ...record, content: diagnostics.canonical })
            }
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

        {(diagnostics.nameIssues.length > 0 ||
          diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">{record.type} warnings</div>
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
