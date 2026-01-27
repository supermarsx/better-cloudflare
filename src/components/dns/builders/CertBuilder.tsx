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

const CERT_TYPE_PRESETS = [
  { value: "1", label: "1 (PKIX)", desc: "X.509 as per PKIX." },
  { value: "2", label: "2 (SPKI)", desc: "SPKI certificate." },
  { value: "3", label: "3 (PGP)", desc: "OpenPGP packet." },
  { value: "4", label: "4 (IPKIX)", desc: "X.509 for IPsec." },
  { value: "5", label: "5 (ISPKI)", desc: "SPKI for IPsec." },
  { value: "6", label: "6 (IPGP)", desc: "OpenPGP for IPsec." },
  { value: "7", label: "7 (ACPKIX)", desc: "X.509 for IKE." },
  { value: "8", label: "8 (IACPKIX)", desc: "X.509 for IKE (alt)." },
  { value: "253", label: "253 (URI)", desc: "URI private." },
  { value: "254", label: "254 (OID)", desc: "OID private." },
] as const;

const CERT_ALG_PRESETS = [
  { value: "13", label: "13 (ECDSAP256SHA256)" },
  { value: "14", label: "14 (ECDSAP384SHA384)" },
  { value: "15", label: "15 (ED25519)" },
  { value: "16", label: "16 (ED448)" },
  { value: "8", label: "8 (RSASHA256)" },
  { value: "10", label: "10 (RSASHA512)" },
] as const;

function parseCertContent(value?: string) {
  const raw = (value ?? "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) {
    return {
      certType: undefined as number | undefined,
      keyTag: undefined as number | undefined,
      algorithm: undefined as number | undefined,
      cert: "",
      extra: "",
    };
  }
  const parts = raw.split(" ").filter(Boolean);
  const certType = Number.parseInt(parts[0] ?? "", 10);
  const keyTag = Number.parseInt(parts[1] ?? "", 10);
  const algorithm = Number.parseInt(parts[2] ?? "", 10);
  const certParts = parts.slice(3);
  return {
    certType: Number.isNaN(certType) ? undefined : certType,
    keyTag: Number.isNaN(keyTag) ? undefined : keyTag,
    algorithm: Number.isNaN(algorithm) ? undefined : algorithm,
    cert: certParts.join("").replace(/\s+/g, ""),
    extra: "",
  };
}

function isBase64Like(value: string) {
  if (!value) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) return false;
  return true;
}

function composeCert(
  certType?: number,
  keyTag?: number,
  algorithm?: number,
  cert?: string,
) {
  const c = (cert ?? "").trim().replace(/\s+/g, "");
  return `${certType ?? 0} ${keyTag ?? 0} ${algorithm ?? 0} ${c}`.trim();
}

export function CertBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [certType, setCertType] = useState<number | undefined>(undefined);
  const [keyTag, setKeyTag] = useState<number | undefined>(undefined);
  const [algorithm, setAlgorithm] = useState<number | undefined>(undefined);
  const [cert, setCert] = useState<string>("");

  const [certTypeMode, setCertTypeMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [algMode, setAlgMode] = useState<"preset" | "custom">("preset");

  const certTypeSelectValue = useMemo(() => {
    if (certTypeMode === "custom") return "custom";
    if (certType === undefined) return "";
    return CERT_TYPE_PRESETS.some((p) => Number(p.value) === certType)
      ? String(certType)
      : "custom";
  }, [certType, certTypeMode]);

  const algSelectValue = useMemo(() => {
    if (algMode === "custom") return "custom";
    if (algorithm === undefined) return "";
    return CERT_ALG_PRESETS.some((p) => Number(p.value) === algorithm)
      ? String(algorithm)
      : "custom";
  }, [algMode, algorithm]);

  useEffect(() => {
    if (record.type !== "CERT") return;
    const parsed = parseCertContent(record.content);
    setCertType(parsed.certType);
    setKeyTag(parsed.keyTag);
    setAlgorithm(parsed.algorithm);
    setCert(parsed.cert ?? "");
    setCertTypeMode(
      parsed.certType !== undefined &&
        CERT_TYPE_PRESETS.some((p) => Number(p.value) === Number(parsed.certType))
        ? "preset"
        : "custom",
    );
    setAlgMode(
      parsed.algorithm !== undefined &&
        CERT_ALG_PRESETS.some((p) => Number(p.value) === Number(parsed.algorithm))
        ? "preset"
        : "custom",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "CERT") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }

    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    if (certType === undefined) push(issues, "CERT: type is required.");
    else if (certType < 0 || certType > 65535)
      push(issues, "CERT: type should be 0–65535.");

    if (keyTag === undefined) push(issues, "CERT: key tag is required.");
    else if (keyTag < 0 || keyTag > 65535)
      push(issues, "CERT: key tag should be 0–65535.");

    if (algorithm === undefined) push(issues, "CERT: algorithm is required.");
    else if (algorithm < 0 || algorithm > 255)
      push(issues, "CERT: algorithm should be 0–255.");

    const certTrim = (cert ?? "").trim();
    const certNoWs = certTrim.replace(/\s+/g, "");
    if (!certTrim) push(issues, "CERT: certificate data is required (base64).");
    if (certTrim && /\s/.test(certTrim))
      push(issues, "CERT: certificate data contains whitespace (usually base64 without spaces).");
    if (certNoWs) {
      if (!isBase64Like(certNoWs))
        push(issues, "CERT: certificate data does not look like base64.");
      if (isBase64Like(certNoWs) && certNoWs.length % 4 !== 0)
        push(issues, "CERT: base64 length is not a multiple of 4 (may still work, but is unusual).");
      if (certNoWs.length > 20000)
        push(issues, "CERT: certificate data is very large for a single DNS record.");
    }

    const canonical = composeCert(certType, keyTag, algorithm, certNoWs);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(issues, "CERT: content differs from builder settings (Apply canonical to normalize).");
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(nameIssues, "CERT: name is typically a host label (e.g., host or @).");

    return { canonical, issues, nameIssues };
  }, [algorithm, cert, certType, keyTag, record.content, record.name, record.type]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "CERT") {
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

  if (record.type !== "CERT") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            CERT builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>type keytag algorithm certificate</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Type</Label>
            <Select
              value={certTypeSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setCertTypeMode("custom");
                  return;
                }
                const n = Number.parseInt(value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setCertType(val);
                setCertTypeMode("preset");
                onRecordChange({
                  ...record,
                  content: composeCert(val, keyTag, algorithm, cert),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {CERT_TYPE_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {certTypeMode === "custom" && (
              <Input
                className="mt-2"
                type="number"
                placeholder="e.g., 1"
                value={certType ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  const val = Number.isNaN(n) ? undefined : n;
                  setCertType(val);
                  onRecordChange({
                    ...record,
                    content: composeCert(val, keyTag, algorithm, cert),
                  });
                }}
              />
            )}
            <div className="text-[11px] text-muted-foreground">
              {CERT_TYPE_PRESETS.find((p) => Number(p.value) === certType)?.desc ??
                "Certificate type as per RFC 4398."}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Key tag</Label>
            <Input
              type="number"
              placeholder="e.g., 0"
              value={keyTag ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setKeyTag(val);
                onRecordChange({
                  ...record,
                  content: composeCert(certType, val, algorithm, cert),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              0–65535. Used to help identify the referenced key.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Algorithm</Label>
            <Select
              value={algSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setAlgMode("custom");
                  return;
                }
                const n = Number.parseInt(value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setAlgorithm(val);
                setAlgMode("preset");
                onRecordChange({
                  ...record,
                  content: composeCert(certType, keyTag, val, cert),
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {CERT_ALG_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {algMode === "custom" && (
              <Input
                className="mt-2"
                type="number"
                placeholder="e.g., 13"
                value={algorithm ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  const val = Number.isNaN(n) ? undefined : n;
                  setAlgorithm(val);
                  onRecordChange({
                    ...record,
                    content: composeCert(certType, keyTag, val, cert),
                  });
                }}
              />
            )}
            <div className="text-[11px] text-muted-foreground">
              DNSSEC algorithm number; most use modern values like 13/15.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-6">
            <Label className="text-xs">Certificate (base64)</Label>
            <Input
              placeholder="base64…"
              value={cert}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setCert(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeCert(
                    certType,
                    keyTag,
                    algorithm,
                    e.target.value.trim().replace(/\s+/g, ""),
                  ),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Paste base64; spaces are removed in the canonical preview.
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseCertContent(record.content);
              setCertType(parsed.certType);
              setKeyTag(parsed.keyTag);
              setAlgorithm(parsed.algorithm);
              setCert(parsed.cert ?? "");
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
            <li>CERT is uncommon; consider modern alternatives where possible.</li>
            <li>Keep base64 compact; large RDATA may hit provider limits.</li>
            <li>Ensure the algorithm/type match what your client expects.</li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">CERT warnings</div>
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

