import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { BuilderWarningsChange, RecordDraft } from "./types";

function parseHinfoContent(value?: string) {
  const raw = (value ?? "").trim();
  if (!raw) return { cpu: "", os: "", extra: "", hasUnbalancedQuotes: false };

  const tokens: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const quoted = match[1];
    const bare = match[2];
    if (quoted !== undefined) {
      tokens.push(quoted.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
    } else if (bare !== undefined) {
      tokens.push(bare);
    }
  }

  const unescapedQuotes = (() => {
    let count = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '"' && raw[i - 1] !== "\\") count++;
    }
    return count;
  })();

  return {
    cpu: tokens[0] ?? "",
    os: tokens[1] ?? "",
    extra: tokens.slice(2).join(" "),
    hasUnbalancedQuotes: unescapedQuotes % 2 === 1,
  };
}

function quoteIfNeeded(value: string) {
  const v = value ?? "";
  if (!v) return '""';
  if (/\s/.test(v) || /"/.test(v)) return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return v;
}

export function HinfoBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [cpu, setCpu] = useState("");
  const [os, setOs] = useState("");

  useEffect(() => {
    if (record.type !== "HINFO") return;
    const parsed = parseHinfoContent(record.content);
    setCpu(parsed.cpu);
    setOs(parsed.os);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "HINFO") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }

    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const parsed = parseHinfoContent(record.content);

    const cpuTrim = cpu.trim();
    const osTrim = os.trim();

    if (parsed.hasUnbalancedQuotes)
      push(issues, "HINFO: content has unbalanced quotes.");

    if (!cpuTrim) push(issues, "HINFO: CPU is required (character-string).");
    if (!osTrim) push(issues, "HINFO: OS is required (character-string).");

    const isPrintable = (s: string) => !/[\u0000-\u001F\u007F]/.test(s);
    if (cpuTrim && !isPrintable(cpuTrim))
      push(issues, "HINFO: CPU contains control characters (unusual).");
    if (osTrim && !isPrintable(osTrim))
      push(issues, "HINFO: OS contains control characters (unusual).");

    // DNS <character-string> is up to 255 octets; warn if clearly beyond.
    if (cpuTrim && cpuTrim.length > 255)
      push(issues, "HINFO: CPU is longer than 255 characters (may exceed DNS character-string limit).");
    if (osTrim && osTrim.length > 255)
      push(issues, "HINFO: OS is longer than 255 characters (may exceed DNS character-string limit).");

    if (parsed.extra) push(issues, "HINFO: extra trailing tokens found in content.");

    const canonical = `${quoteIfNeeded(cpuTrim)} ${quoteIfNeeded(osTrim)}`;
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(issues, "HINFO: content differs from builder settings (Apply canonical to normalize).");
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        "HINFO: name is typically a host label (e.g., host or @).",
      );

    return { canonical, issues, nameIssues };
  }, [cpu, os, record.content, record.name, record.type]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "HINFO") {
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

  if (record.type !== "HINFO") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            HINFO builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>"CPU" "OS"</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-3">
            <Label className="text-xs">CPU</Label>
            <Input
              placeholder='e.g., "Intel" or "ARM64"'
              value={cpu}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setCpu(e.target.value);
                onRecordChange({
                  ...record,
                  content: `${quoteIfNeeded(e.target.value.trim())} ${quoteIfNeeded(os.trim())}`,
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              A short description of the host CPU (character-string).
            </div>
          </div>

          <div className="space-y-1 sm:col-span-3">
            <Label className="text-xs">OS</Label>
            <Input
              placeholder='e.g., "Linux" or "Windows"'
              value={os}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setOs(e.target.value);
                onRecordChange({
                  ...record,
                  content: `${quoteIfNeeded(cpu.trim())} ${quoteIfNeeded(e.target.value.trim())}`,
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              A short description of the operating system (character-string).
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseHinfoContent(record.content);
              setCpu(parsed.cpu);
              setOs(parsed.os);
            }}
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

        <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
          <div className="text-xs font-semibold text-muted-foreground">
            Recommendations
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
            <li>Keep values short; HINFO is rarely used today.</li>
            <li>Use quotes if values contain spaces.</li>
            <li>Consider privacy implications of publishing detailed host info.</li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">HINFO warnings</div>
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

