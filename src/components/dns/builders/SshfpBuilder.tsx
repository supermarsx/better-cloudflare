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
import { composeSSHFP, parseSSHFP } from "@/lib/dns-parsers";

import type { BuilderWarningsChange, RecordDraft } from "./types";

const SSHFP_ALGORITHMS = [
  { value: "1", label: "1 (RSA)", desc: "RSA public key fingerprint." },
  { value: "2", label: "2 (DSA)", desc: "DSA public key fingerprint." },
  { value: "3", label: "3 (ECDSA)", desc: "ECDSA public key fingerprint." },
  { value: "4", label: "4 (Ed25519)", desc: "Ed25519 public key fingerprint." },
] as const;

const SSHFP_FPTYPES = [
  { value: "1", label: "1 (SHA-1)", desc: "20 bytes → 40 hex chars." },
  { value: "2", label: "2 (SHA-256)", desc: "32 bytes → 64 hex chars." },
] as const;

function isHex(value: string) {
  return /^[0-9a-fA-F]+$/.test(value);
}

export function SshfpBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [algorithm, setAlgorithm] = useState<number | undefined>(undefined);
  const [fptype, setFptype] = useState<number | undefined>(undefined);
  const [fingerprint, setFingerprint] = useState<string>("");

  const [algorithmMode, setAlgorithmMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [fptypeMode, setFptypeMode] = useState<"preset" | "custom">("preset");

  const algorithmSelectValue = useMemo(() => {
    const val = algorithm;
    if (algorithmMode === "custom") return "custom";
    if (val === undefined) return "";
    return ["1", "2", "3", "4"].includes(String(val)) ? String(val) : "custom";
  }, [algorithm, algorithmMode]);

  const fptypeSelectValue = useMemo(() => {
    const val = fptype;
    if (fptypeMode === "custom") return "custom";
    if (val === undefined) return "";
    return ["1", "2"].includes(String(val)) ? String(val) : "custom";
  }, [fptype, fptypeMode]);

  useEffect(() => {
    if (record.type !== "SSHFP") return;
    const parsed = parseSSHFP(record.content);
    setAlgorithm(parsed.algorithm);
    setFptype(parsed.fptype);
    setFingerprint(parsed.fingerprint ?? "");
    setAlgorithmMode(
      parsed.algorithm !== undefined &&
        ["1", "2", "3", "4"].includes(String(parsed.algorithm))
        ? "preset"
        : "custom",
    );
    setFptypeMode(
      parsed.fptype !== undefined && ["1", "2"].includes(String(parsed.fptype))
        ? "preset"
        : "custom",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "SSHFP") {
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

    const a = algorithm;
    const f = fptype;
    const fpRaw = fingerprint ?? "";
    const fpTrimmed = fpRaw.trim();
    const fpNoSpaces = fpTrimmed.replace(/\s+/g, "");

    if (a === undefined) push(issues, "SSHFP: algorithm is required (usually 1–4).");
    else if (![1, 2, 3, 4].includes(Number(a)))
      push(issues, "SSHFP: algorithm is usually 1–4.");

    if (f === undefined) push(issues, "SSHFP: fingerprint type is required (usually 1–2).");
    else if (![1, 2].includes(Number(f))) push(issues, "SSHFP: fingerprint type is usually 1–2.");

    if (!fpTrimmed) push(issues, "SSHFP: fingerprint is required.");
    if (fpTrimmed && /\s/.test(fpTrimmed))
      push(issues, "SSHFP: fingerprint contains whitespace (usually written as a single hex string).");

    if (fpNoSpaces) {
      if (!isHex(fpNoSpaces)) push(issues, "SSHFP: fingerprint should be hex.");
      if (isHex(fpNoSpaces) && fpNoSpaces.length % 2 !== 0)
        push(issues, "SSHFP: fingerprint hex length should be even.");

      if (f === 1 && isHex(fpNoSpaces) && fpNoSpaces.length !== 40)
        push(issues, "SSHFP: SHA-1 fingerprint is typically 40 hex chars.");
      if (f === 2 && isHex(fpNoSpaces) && fpNoSpaces.length !== 64)
        push(issues, "SSHFP: SHA-256 fingerprint is typically 64 hex chars.");
      if (isHex(fpNoSpaces) && fpNoSpaces.length > 4096)
        push(issues, "SSHFP: fingerprint looks unusually long.");
    }

    const canonical = composeSSHFP(a, f, fpNoSpaces || fpTrimmed);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(issues, "SSHFP: content differs from builder settings (Apply canonical to normalize).");
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        "SSHFP: name is typically the host whose SSH key you are pinning (e.g., host or @).",
      );

    return { canonical, issues, nameIssues };
  }, [algorithm, fingerprint, fptype, record.content, record.name, record.type]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "SSHFP") {
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

  if (record.type !== "SSHFP") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            SSHFP builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>algorithm fptype fingerprint</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Algorithm</Label>
            <Select
              value={algorithmSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setAlgorithmMode("custom");
                  return;
                }
                const n = Number.parseInt(value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setAlgorithm(val);
                setAlgorithmMode("preset");
                onRecordChange({
                  ...record,
                  content: composeSSHFP(val, fptype, fingerprint.trim().replace(/\s+/g, "")),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {SSHFP_ALGORITHMS.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {algorithmMode === "custom" && (
              <Input
                className="mt-2"
                type="number"
                placeholder="e.g., 1"
                value={algorithm ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  const val = Number.isNaN(n) ? undefined : n;
                  setAlgorithm(val);
                  onRecordChange({
                    ...record,
                    content: composeSSHFP(val, fptype, fingerprint.trim().replace(/\s+/g, "")),
                  });
                }}
              />
            )}
            <div className="text-[11px] text-muted-foreground">
              {SSHFP_ALGORITHMS.find((a) => Number(a.value) === algorithm)?.desc ??
                "Common: 1 RSA, 3 ECDSA, 4 Ed25519."}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Fingerprint type</Label>
            <Select
              value={fptypeSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setFptypeMode("custom");
                  return;
                }
                const n = Number.parseInt(value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setFptype(val);
                setFptypeMode("preset");
                onRecordChange({
                  ...record,
                  content: composeSSHFP(algorithm, val, fingerprint.trim().replace(/\s+/g, "")),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {SSHFP_FPTYPES.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {fptypeMode === "custom" && (
              <Input
                className="mt-2"
                type="number"
                placeholder="e.g., 2"
                value={fptype ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  const val = Number.isNaN(n) ? undefined : n;
                  setFptype(val);
                  onRecordChange({
                    ...record,
                    content: composeSSHFP(algorithm, val, fingerprint.trim().replace(/\s+/g, "")),
                  });
                }}
              />
            )}
            <div className="text-[11px] text-muted-foreground">
              {SSHFP_FPTYPES.find((f) => Number(f.value) === fptype)?.desc ??
                "Common: 1 SHA-1, 2 SHA-256."}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Fingerprint</Label>
            <Input
              placeholder="e.g., <hex>"
              value={fingerprint}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setFingerprint(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeSSHFP(
                    algorithm,
                    fptype,
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
              const parsed = parseSSHFP(record.content);
              setAlgorithm(parsed.algorithm);
              setFptype(parsed.fptype);
              setFingerprint(parsed.fingerprint ?? "");
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
              Prefer SHA-256 (<code>fptype=2</code>) unless you must support older clients.
            </li>
            <li>Make sure the fingerprint matches the key actually used by the host.</li>
            <li>
              SSHFP is most useful with DNSSEC validation; otherwise it can be spoofed.
            </li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">SSHFP warnings</div>
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

