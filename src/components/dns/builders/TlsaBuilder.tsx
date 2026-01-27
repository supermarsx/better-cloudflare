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
import { composeTLSA, parseTLSA } from "@/lib/dns-parsers";

import type { BuilderWarningsChange, RecordDraft } from "./types";

const TLSA_USAGES = [
  { value: "0", label: "0 (PKIX-TA)", desc: "CA constraint; verified via PKIX + DANE-TA." },
  { value: "1", label: "1 (PKIX-EE)", desc: "Service cert constraint; verified via PKIX." },
  { value: "2", label: "2 (DANE-TA)", desc: "Trust anchor constraint; verified via DNSSEC (no PKIX required)." },
  { value: "3", label: "3 (DANE-EE)", desc: "Service cert constraint; verified via DNSSEC (no PKIX required)." },
] as const;

const TLSA_SELECTORS = [
  { value: "0", label: "0 (Cert)", desc: "Match the full certificate." },
  { value: "1", label: "1 (SPKI)", desc: "Match the SubjectPublicKeyInfo." },
] as const;

const TLSA_MATCHING = [
  { value: "0", label: "0 (Full)", desc: "No hash; data is the selected bytes (hex)." },
  { value: "1", label: "1 (SHA-256)", desc: "32 bytes → 64 hex chars." },
  { value: "2", label: "2 (SHA-512)", desc: "64 bytes → 128 hex chars." },
] as const;

function isHex(value: string) {
  return /^[0-9a-fA-F]+$/.test(value);
}

export function TlsaBuilder({
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
  const [selectorMode, setSelectorMode] = useState<"preset" | "custom">("preset");
  const [matchingMode, setMatchingMode] = useState<"preset" | "custom">("preset");

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
    if (record.type !== "TLSA") return;
    const parsed = parseTLSA(record.content);
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
    if (record.type !== "TLSA") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }

    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const u = usage;
    const s = selector;
    const m = matchingType;
    const dRaw = data ?? "";
    const dTrim = dRaw.trim();
    const dNoSpaces = dTrim.replace(/\s+/g, "");

    if (u === undefined) push(issues, "TLSA: usage is required (usually 0–3).");
    else if (![0, 1, 2, 3].includes(Number(u)))
      push(issues, "TLSA: usage is usually 0–3.");

    if (s === undefined) push(issues, "TLSA: selector is required (usually 0–1).");
    else if (![0, 1].includes(Number(s))) push(issues, "TLSA: selector is usually 0–1.");

    if (m === undefined)
      push(issues, "TLSA: matching type is required (usually 0–2).");
    else if (![0, 1, 2].includes(Number(m)))
      push(issues, "TLSA: matching type is usually 0–2.");

    if (!dTrim) push(issues, "TLSA: data is required.");
    if (dTrim && /\s/.test(dTrim))
      push(issues, "TLSA: data contains whitespace (usually written as a single hex string).");

    if (dNoSpaces) {
      if (!isHex(dNoSpaces)) push(issues, "TLSA: data should be hex.");
      if (isHex(dNoSpaces) && dNoSpaces.length % 2 !== 0)
        push(issues, "TLSA: data hex length should be even.");

      if (m === 1 && isHex(dNoSpaces) && dNoSpaces.length !== 64)
        push(issues, "TLSA: SHA-256 data is typically 64 hex chars.");
      if (m === 2 && isHex(dNoSpaces) && dNoSpaces.length !== 128)
        push(issues, "TLSA: SHA-512 data is typically 128 hex chars.");

      if (isHex(dNoSpaces) && dNoSpaces.length > 65535)
        push(issues, "TLSA: data looks unusually long.");
    }

    const canonical = composeTLSA(u, s, m, dNoSpaces || dTrim);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(issues, "TLSA: content differs from builder settings (Apply canonical to normalize).");
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        "TLSA: name is often _port._proto (e.g., _443._tcp).",
      );

    return { canonical, issues, nameIssues };
  }, [data, matchingType, record.content, record.name, record.type, selector, usage]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "TLSA") {
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

  if (record.type !== "TLSA") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            TLSA builder
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
                  content: composeTLSA(val, selector, matchingType, data.trim().replace(/\s+/g, "")),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {TLSA_USAGES.map((u) => (
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
                    content: composeTLSA(val, selector, matchingType, data.trim().replace(/\s+/g, "")),
                  });
                }}
              />
            )}
            <div className="text-[11px] text-muted-foreground">
              {TLSA_USAGES.find((u) => Number(u.value) === usage)?.desc ??
                "Common: 3 (DANE-EE) for pinning via DNSSEC."}
            </div>
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
                  content: composeTLSA(usage, val, matchingType, data.trim().replace(/\s+/g, "")),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {TLSA_SELECTORS.map((s) => (
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
                    content: composeTLSA(usage, val, matchingType, data.trim().replace(/\s+/g, "")),
                  });
                }}
              />
            )}
            <div className="text-[11px] text-muted-foreground">
              {TLSA_SELECTORS.find((s) => Number(s.value) === selector)?.desc ??
                "Most use 1 (SPKI)."}
            </div>
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
                  content: composeTLSA(usage, selector, val, data.trim().replace(/\s+/g, "")),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {TLSA_MATCHING.map((m) => (
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
                    content: composeTLSA(usage, selector, val, data.trim().replace(/\s+/g, "")),
                  });
                }}
              />
            )}
            <div className="text-[11px] text-muted-foreground">
              {TLSA_MATCHING.find((m) => Number(m.value) === matchingType)?.desc ??
                "Common: 1 (SHA-256)."}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-6">
            <Label className="text-xs">Data</Label>
            <Input
              placeholder="hex"
              value={data}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setData(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeTLSA(
                    usage,
                    selector,
                    matchingType,
                    e.target.value.trim().replace(/\s+/g, ""),
                  ),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Paste hex; spaces are removed in the canonical preview.
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseTLSA(record.content);
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

        <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
          <div className="text-xs font-semibold text-muted-foreground">
            Recommendations
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
            <li>
              Many deployments use <code>3 1 1</code> (DANE-EE, SPKI, SHA-256).
            </li>
            <li>Ensure the record name matches the service port/proto (e.g., _443._tcp).</li>
            <li>TLSA is most meaningful with DNSSEC validation.</li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">TLSA warnings</div>
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

