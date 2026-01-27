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

import type { BuilderWarningsChange, RecordDraft } from "./types";

const SMIMEA_USAGES = [
  { value: "0", label: "0 (PKIX-TA)" },
  { value: "1", label: "1 (PKIX-EE)" },
  { value: "2", label: "2 (DANE-TA)" },
  { value: "3", label: "3 (DANE-EE)" },
] as const;

const SMIMEA_SELECTORS = [
  { value: "0", label: "0 (Cert)" },
  { value: "1", label: "1 (SPKI)" },
] as const;

const SMIMEA_MATCHING = [
  { value: "0", label: "0 (Full)" },
  { value: "1", label: "1 (SHA-256)" },
  { value: "2", label: "2 (SHA-512)" },
] as const;

function parseSmimeaContent(content?: string) {
  const raw = (content ?? "").trim();
  if (!raw)
    return {
      usage: undefined as number | undefined,
      selector: undefined as number | undefined,
      matchingType: undefined as number | undefined,
      data: "",
    };
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 4) {
    return { usage: undefined, selector: undefined, matchingType: undefined, data: raw };
  }
  const [u, s, m, ...rest] = parts;
  return {
    usage: Number(u),
    selector: Number(s),
    matchingType: Number(m),
    data: rest.join(" "),
  };
}

function composeSmimea(u?: number, s?: number, m?: number, d?: string) {
  const data = (d ?? "").trim();
  return `${u ?? 0} ${s ?? 0} ${m ?? 0} ${data}`.trim();
}

function isHex(value: string) {
  return /^[0-9a-fA-F]+$/.test(value);
}

export function SmimeaBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [usage, setUsage] = useState<number | undefined>(undefined);
  const [selector, setSelector] = useState<number | undefined>(undefined);
  const [matchingType, setMatchingType] = useState<number | undefined>(undefined);
  const [data, setData] = useState<string>("");

  const [usageMode, setUsageMode] = useState<"preset" | "custom">("preset");
  const [selectorMode, setSelectorMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [matchingMode, setMatchingMode] = useState<"preset" | "custom">(
    "preset",
  );

  const usageSelectValue = useMemo(() => {
    if (usageMode === "custom") return "custom";
    if (usage === undefined) return "";
    return ["0", "1", "2", "3"].includes(String(usage)) ? String(usage) : "custom";
  }, [usage, usageMode]);

  const selectorSelectValue = useMemo(() => {
    if (selectorMode === "custom") return "custom";
    if (selector === undefined) return "";
    return ["0", "1"].includes(String(selector)) ? String(selector) : "custom";
  }, [selector, selectorMode]);

  const matchingSelectValue = useMemo(() => {
    if (matchingMode === "custom") return "custom";
    if (matchingType === undefined) return "";
    return ["0", "1", "2"].includes(String(matchingType))
      ? String(matchingType)
      : "custom";
  }, [matchingMode, matchingType]);

  useEffect(() => {
    if (record.type !== "SMIMEA") return;
    const parsed = parseSmimeaContent(record.content);
    setUsage(parsed.usage);
    setSelector(parsed.selector);
    setMatchingType(parsed.matchingType);
    setData(parsed.data ?? "");
    setUsageMode(
      parsed.usage !== undefined && ["0", "1", "2", "3"].includes(String(parsed.usage))
        ? "preset"
        : "custom",
    );
    setSelectorMode(
      parsed.selector !== undefined && ["0", "1"].includes(String(parsed.selector))
        ? "preset"
        : "custom",
    );
    setMatchingMode(
      parsed.matchingType !== undefined &&
        ["0", "1", "2"].includes(String(parsed.matchingType))
        ? "preset"
        : "custom",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "SMIMEA") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }

    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const parsed = parseSmimeaContent(record.content);
    const hasExtraFormatIssue =
      (record.content ?? "").trim() &&
      (parsed.usage === undefined || parsed.selector === undefined || parsed.matchingType === undefined);
    if (hasExtraFormatIssue)
      push(issues, 'SMIMEA: content should be: "usage selector matching-type data".');

    if (usage === undefined) push(issues, "SMIMEA: usage is required (usually 0–3).");
    else if (![0, 1, 2, 3].includes(Number(usage)))
      push(issues, "SMIMEA: usage is usually 0–3.");

    if (selector === undefined) push(issues, "SMIMEA: selector is required (usually 0–1).");
    else if (![0, 1].includes(Number(selector)))
      push(issues, "SMIMEA: selector is usually 0–1.");

    if (matchingType === undefined)
      push(issues, "SMIMEA: matching type is required (usually 0–2).");
    else if (![0, 1, 2].includes(Number(matchingType)))
      push(issues, "SMIMEA: matching type is usually 0–2.");

    const dTrim = (data ?? "").trim();
    const dNoSpaces = dTrim.replace(/\s+/g, "");
    if (!dTrim) push(issues, "SMIMEA: data is required.");
    if (dTrim && /\s/.test(dTrim))
      push(issues, "SMIMEA: data contains whitespace (canonical removes it).");
    if (dNoSpaces) {
      if (!isHex(dNoSpaces)) push(issues, "SMIMEA: data should be hex.");
      if (isHex(dNoSpaces) && dNoSpaces.length % 2 !== 0)
        push(issues, "SMIMEA: data hex length should be even.");
      if (matchingType === 1 && isHex(dNoSpaces) && dNoSpaces.length !== 64)
        push(issues, "SMIMEA: SHA-256 data is typically 64 hex chars.");
      if (matchingType === 2 && isHex(dNoSpaces) && dNoSpaces.length !== 128)
        push(issues, "SMIMEA: SHA-512 data is typically 128 hex chars.");
    }

    const canonical = composeSmimea(usage, selector, matchingType, dNoSpaces || dTrim);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(issues, "SMIMEA: content differs from builder settings (Apply canonical to normalize).");
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        "SMIMEA: name usually includes the user hash label and _smimecert (e.g., <hash>._smimecert).",
      );
    if (name && !name.toLowerCase().includes("._smimecert"))
      push(nameIssues, "SMIMEA: name usually includes “._smimecert”.");

    return { canonical, issues, nameIssues };
  }, [data, matchingType, record.content, record.name, record.type, selector, usage]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "SMIMEA") {
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

  if (record.type !== "SMIMEA") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            SMIMEA builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>usage selector matchingType data</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Usage</Label>
            <Select
              value={usageSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setUsageMode("custom");
                  return;
                }
                const n = Number.parseInt(value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setUsage(val);
                setUsageMode("preset");
                onRecordChange({
                  ...record,
                  content: composeSmimea(val, selector, matchingType, data.trim().replace(/\s+/g, "")),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {SMIMEA_USAGES.map((u) => (
                  <SelectItem key={u.value} value={u.value}>
                    {u.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {usageMode === "custom" && (
              <Input
                className="mt-2"
                type="number"
                placeholder="e.g., 3"
                value={usage ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  const val = Number.isNaN(n) ? undefined : n;
                  setUsage(val);
                  onRecordChange({
                    ...record,
                    content: composeSmimea(val, selector, matchingType, data.trim().replace(/\s+/g, "")),
                  });
                }}
              />
            )}
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Selector</Label>
            <Select
              value={selectorSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setSelectorMode("custom");
                  return;
                }
                const n = Number.parseInt(value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setSelector(val);
                setSelectorMode("preset");
                onRecordChange({
                  ...record,
                  content: composeSmimea(usage, val, matchingType, data.trim().replace(/\s+/g, "")),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {SMIMEA_SELECTORS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {selectorMode === "custom" && (
              <Input
                className="mt-2"
                type="number"
                placeholder="e.g., 1"
                value={selector ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  const val = Number.isNaN(n) ? undefined : n;
                  setSelector(val);
                  onRecordChange({
                    ...record,
                    content: composeSmimea(usage, val, matchingType, data.trim().replace(/\s+/g, "")),
                  });
                }}
              />
            )}
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Matching type</Label>
            <Select
              value={matchingSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setMatchingMode("custom");
                  return;
                }
                const n = Number.parseInt(value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setMatchingType(val);
                setMatchingMode("preset");
                onRecordChange({
                  ...record,
                  content: composeSmimea(usage, selector, val, data.trim().replace(/\s+/g, "")),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {SMIMEA_MATCHING.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {matchingMode === "custom" && (
              <Input
                className="mt-2"
                type="number"
                placeholder="e.g., 1"
                value={matchingType ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  const val = Number.isNaN(n) ? undefined : n;
                  setMatchingType(val);
                  onRecordChange({
                    ...record,
                    content: composeSmimea(usage, selector, val, data.trim().replace(/\s+/g, "")),
                  });
                }}
              />
            )}
          </div>

          <div className="space-y-1 sm:col-span-6">
            <Label className="text-xs">Data (hex)</Label>
            <Input
              placeholder="hex…"
              value={data}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setData(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeSmimea(
                    usage,
                    selector,
                    matchingType,
                    e.target.value.trim().replace(/\s+/g, ""),
                  ),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Paste hex; whitespace is removed in the canonical preview.
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseSmimeaContent(record.content);
              setUsage(parsed.usage);
              setSelector(parsed.selector);
              setMatchingType(parsed.matchingType);
              setData(parsed.data ?? "");
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
            <div className="text-sm font-semibold">SMIMEA warnings</div>
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

