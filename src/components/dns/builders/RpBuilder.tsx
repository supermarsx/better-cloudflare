import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KNOWN_TLDS } from "@/lib/tlds";

import type { BuilderWarningsChange, RecordDraft } from "./types";

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

function parseRpContent(value?: string) {
  const raw = (value ?? "").trim();
  if (!raw) return { mailbox: "", text: "", extra: "" };
  const parts = raw.split(/\s+/).filter(Boolean);
  return {
    mailbox: parts[0] ?? "",
    text: parts[1] ?? "",
    extra: parts.slice(2).join(" "),
  };
}

function composeRp(mailbox: string, text: string) {
  return `${normalizeDnsName(mailbox)} ${normalizeDnsName(text)}`.trim();
}

export function RpBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [mailbox, setMailbox] = useState("");
  const [text, setText] = useState("");

  useEffect(() => {
    if (record.type !== "RP") return;
    const parsed = parseRpContent(record.content);
    setMailbox(parsed.mailbox);
    setText(parsed.text);
  }, [record.content, record.type]);

  const diagnostics = useMemo(() => {
    if (record.type !== "RP") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }

    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const m = normalizeDnsName(mailbox);
    const t = normalizeDnsName(text);
    const parsed = parseRpContent(record.content);

    if (!m) push(issues, "RP: mailbox domain-name is required.");
    if (!t) push(issues, "RP: text domain-name is required.");

    if (m && m !== "." && !looksLikeHostname(m))
      push(issues, "RP: mailbox does not look like a hostname (or \".\").");
    if (t && t !== "." && !looksLikeHostname(t))
      push(issues, "RP: text does not look like a hostname (or \".\").");

    const checkTld = (value: string, label: string) => {
      if (!value || value === ".") return;
      const norm = normalizeDnsName(value);
      const tld = norm.split(".").pop()?.toLowerCase() ?? "";
      if (tld && norm.includes(".") && /^[a-z0-9-]{2,63}$/.test(tld)) {
        if (!KNOWN_TLDS.has(tld))
          push(issues, `RP: ${label} has unknown/invalid TLD “.${tld}”.`);
      }
    };
    if (looksLikeHostname(m)) checkTld(m, "mailbox");
    if (looksLikeHostname(t)) checkTld(t, "text");

    if (m && m !== "." && !m.includes("."))
      push(
        issues,
        "RP: mailbox is usually a DNS name representing an email address (dots replace @).",
      );

    if (parsed.extra) push(issues, "RP: extra trailing tokens found in content.");

    const canonical = composeRp(mailbox, text);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(issues, "RP: content differs from builder settings (Apply canonical to normalize).");
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        "RP: name is usually the domain name the contact info applies to (often @).",
      );

    return { canonical, issues, nameIssues };
  }, [mailbox, record.content, record.name, record.type, text]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "RP") {
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

  if (record.type !== "RP") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            RP builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>mailbox text</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-3">
            <Label className="text-xs">Mailbox</Label>
            <Input
              placeholder="e.g., hostmaster.example.com"
              value={mailbox}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setMailbox(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeRp(e.target.value, text),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              A DNS name representing an email address (dots replace <code>@</code>).
              Use <code>.</code> for “none”.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-3">
            <Label className="text-xs">Text</Label>
            <Input
              placeholder="e.g., info.example.com"
              value={text}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setText(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeRp(mailbox, e.target.value),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              A DNS name pointing to a TXT record with more info. Use <code>.</code>{" "}
              for “none”.
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseRpContent(record.content);
              setMailbox(parsed.mailbox);
              setText(parsed.text);
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

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">RP warnings</div>
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

