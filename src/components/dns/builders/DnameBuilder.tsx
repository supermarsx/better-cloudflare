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
  const v = value.trim();
  if (v === ".") return ".";
  return v.replace(/\.$/, "");
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
  if (v === ".") return true;
  if (/\s/.test(v)) return false;
  if (v.length > 253) return false;
  if (v.includes("..")) return false;
  if (v.includes("://") || v.includes("/")) return false;
  const labels = v.split(".");
  if (labels.some((l) => l.length === 0)) return false;
  return labels.every(isValidDnsLabel);
}

export type DnameFields = {
  target: string;
  /** The record's own name, used only to phrase the rewrite concretely. */
  owner?: string;
};

/**
 * Plain-English description of the subtree rewrite a DNAME performs.
 *
 * RFC 6672: a DNAME redirects everything *below* its owner name and never the
 * owner name itself, which is the difference from CNAME that catches people
 * out, so the summary states it every time.
 */
export function describeDNAME(fields: DnameFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const target = normalizeDnsName(fields.target);
  const owner = normalizeDnsName(fields.owner ?? "");
  const isApex = !owner || owner === "@";
  const ownerLabel = isApex ? "this zone's apex" : owner;
  const exampleName = isApex ? "www" : `www.${owner}`;

  const headline = target
    ? `Rewrites every name below ${ownerLabel} onto the matching name under ${target}, so a lookup of ${exampleName} is answered with whatever www.${target} resolves to.`
    : `Rewrites every name below ${ownerLabel} onto the matching name under another domain, so that whole branch of the zone mirrors the target's names.`;

  details.push(
    `The owner name itself is not rewritten. Unlike a CNAME, a DNAME covers only the names below ${ownerLabel}, so ${ownerLabel} still needs records of its own if it has to resolve.`,
  );
  details.push(
    "Resolvers synthesise a CNAME next to the DNAME in the answer they return, so clients that do not understand DNAME still follow the redirection.",
  );
  details.push(
    "Any records that already exist below the owner name are occluded by the DNAME: the rewrite takes precedence and those names stop being answered from this zone.",
  );
  details.push(
    "A DNAME may share its owner name with other record types — that is how one works at a zone apex alongside SOA and NS — but it must never share it with a CNAME.",
  );

  if (target) {
    unknowns.push(
      `Whether the rewritten names actually resolve depends on what exists under ${target}, which cannot be checked from here.`,
    );
  }

  return { headline, details, unknowns };
}

export function DnameBuilder({
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
    () => describeDNAME({ target, owner: record.name }),
    [record.name, target],
  );

  useEffect(() => {
    if (record.type !== "DNAME") return;
    setTarget(record.content ?? "");
  }, [record.content, record.type]);

  const diagnostics = useMemo(() => {
    if (record.type !== "DNAME") {
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
    if (!t) push(issues, "DNAME: target is required (a hostname).");
    if (t && t !== "." && !looksLikeHostname(t))
      push(issues, "DNAME: target does not look like a hostname.");
    if (t && t !== "." && looksLikeHostname(t)) {
      const norm = normalizeDnsName(t);
      const tld = norm.split(".").pop()?.toLowerCase() ?? "";
      if (tld && norm.includes(".") && /^[a-z0-9-]{2,63}$/.test(tld)) {
        if (!KNOWN_TLDS.has(tld))
          push(issues, `DNAME: target has unknown/invalid TLD “.${tld}”.`);
      }
    }

    const canonical = normalizeDnsName(target);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(
        issues,
        "DNAME: content differs from builder settings (Apply canonical to normalize).",
      );
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        "DNAME: name is the owner of the alias subtree (often a label like alias).",
      );

    return { canonical, issues, nameIssues };
  }, [record.content, record.name, record.type, target]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "DNAME") {
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

  if (record.type !== "DNAME") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            DNAME builder
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
              help="The domain name that names below this record are rewritten onto: a lookup of x.y.owner is answered as x.y.target. Give the target's own name, not a name beneath it, and do not point it at a name below the owner or lookups will loop."
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
              DNAME aliases an entire subtree; double-check that CNAME is not
              what you want.
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
            <div className="text-sm font-semibold">DNAME warnings</div>
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
