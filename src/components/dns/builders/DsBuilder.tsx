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

function parseDSContent(value: string | undefined) {
  const raw = (value ?? "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) {
    return {
      keyTag: undefined as number | undefined,
      algorithm: undefined as number | undefined,
      digestType: undefined as number | undefined,
      digest: "",
    };
  }
  const parts = raw.split(" ").filter(Boolean);
  const keyTag = Number.parseInt(parts[0] ?? "", 10);
  const algorithm = Number.parseInt(parts[1] ?? "", 10);
  const digestType = Number.parseInt(parts[2] ?? "", 10);
  const digest = parts.slice(3).join("").replace(/\s+/g, "");
  return {
    keyTag: Number.isNaN(keyTag) ? undefined : keyTag,
    algorithm: Number.isNaN(algorithm) ? undefined : algorithm,
    digestType: Number.isNaN(digestType) ? undefined : digestType,
    digest,
  };
}

function composeDS(fields: {
  keyTag: number | undefined;
  algorithm: number | undefined;
  digestType: number | undefined;
  digest: string;
}) {
  const keyTag = fields.keyTag ?? "";
  const algorithm = fields.algorithm ?? "";
  const digestType = fields.digestType ?? "";
  const digest = (fields.digest ?? "")
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/[^0-9A-F]/g, "");
  return `${keyTag} ${algorithm} ${digestType} ${digest}`.replace(/\s+/g, " ").trim();
}

export function DsBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [dsKeyTag, setDsKeyTag] = useState<number | undefined>(undefined);
  const [dsAlgorithm, setDsAlgorithm] = useState<number | undefined>(13);
  const [dsDigestType, setDsDigestType] = useState<number | undefined>(2);
  const [dsDigest, setDsDigest] = useState<string>("");
  const [dsAlgorithmMode, setDsAlgorithmMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [dsDigestTypeMode, setDsDigestTypeMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [dsAlgorithmCustomValue, setDsAlgorithmCustomValue] = useState<
    number | undefined
  >(undefined);
  const [dsDigestTypeCustomValue, setDsDigestTypeCustomValue] = useState<
    number | undefined
  >(undefined);

  useEffect(() => {
    if (record.type !== "DS") return;
    const parsed = parseDSContent(record.content);
    setDsKeyTag(parsed.keyTag);
    setDsAlgorithm(parsed.algorithm);
    setDsDigestType(parsed.digestType);
    setDsDigest(parsed.digest);

    const algIsPreset =
      parsed.algorithm !== undefined && [8, 13, 14, 15, 16].includes(parsed.algorithm);
    const digestIsPreset =
      parsed.digestType !== undefined && [1, 2, 4].includes(parsed.digestType);
    if (algIsPreset) {
      setDsAlgorithmMode("preset");
    } else {
      setDsAlgorithmMode("custom");
      setDsAlgorithmCustomValue(parsed.algorithm);
    }
    if (digestIsPreset) {
      setDsDigestTypeMode("preset");
    } else {
      setDsDigestTypeMode("custom");
      setDsDigestTypeCustomValue(parsed.digestType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  const dsAlgorithmSelectValue = useMemo(() => {
    if (dsAlgorithmMode === "custom") return "custom";
    if (dsAlgorithm === undefined || dsAlgorithm === null) return "custom";
    if ([8, 13, 14, 15, 16].includes(dsAlgorithm)) return String(dsAlgorithm);
    return "custom";
  }, [dsAlgorithm, dsAlgorithmMode]);

  const dsDigestTypeSelectValue = useMemo(() => {
    if (dsDigestTypeMode === "custom") return "custom";
    if (dsDigestType === undefined || dsDigestType === null) return "custom";
    if ([1, 2, 4].includes(dsDigestType)) return String(dsDigestType);
    return "custom";
  }, [dsDigestType, dsDigestTypeMode]);

  const diagnostics = useMemo(() => {
    if (record.type !== "DS") return { canonical: "", issues: [], nameIssues: [] };
    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const keyTag = dsKeyTag;
    const alg = dsAlgorithm;
    const digestType = dsDigestType;
    const digestRaw = (dsDigest ?? "").trim();
    const digest = digestRaw.replace(/\s+/g, "").toUpperCase();

    if (keyTag === undefined) push(issues, "DS: key tag is missing.");
    else if (keyTag < 0 || keyTag > 65535) push(issues, "DS: key tag should be 0–65535.");

    const knownAlg: Record<number, string> = {
      5: "RSASHA1",
      7: "RSASHA1-NSEC3-SHA1",
      8: "RSASHA256",
      10: "RSASHA512",
      13: "ECDSAP256SHA256",
      14: "ECDSAP384SHA384",
      15: "ED25519",
      16: "ED448",
    };
    if (alg === undefined) push(issues, "DS: algorithm is missing.");
    else if (alg < 0 || alg > 255) push(issues, "DS: algorithm should be 0–255.");
    else if (!knownAlg[alg]) push(issues, `DS: algorithm ${alg} is uncommon; double-check.`);

    const knownDigest: Record<number, { name: string; hexLen: number }> = {
      1: { name: "SHA-1", hexLen: 40 },
      2: { name: "SHA-256", hexLen: 64 },
      4: { name: "SHA-384", hexLen: 96 },
    };
    if (digestType === undefined) push(issues, "DS: digest type is missing.");
    else if (digestType < 0 || digestType > 255)
      push(issues, "DS: digest type should be 0–255.");
    else if (!knownDigest[digestType])
      push(issues, `DS: digest type ${digestType} is uncommon; double-check.`);

    if (!digestRaw) push(issues, "DS: digest is missing.");
    else {
      if (!/^[0-9A-Fa-f]+$/.test(digestRaw.replace(/\s+/g, "")))
        push(issues, "DS: digest contains non-hex characters.");
      if (digest.length % 2 !== 0) push(issues, "DS: digest hex length should be even.");
      const expected = digestType !== undefined ? knownDigest[digestType]?.hexLen : undefined;
      if (expected && digest.length !== expected)
        push(
          issues,
          `DS: digest length is ${digest.length} hex chars; expected ${expected} for ${knownDigest[digestType!].name}.`,
        );
    }

    if (alg === 13 && digestType === 1)
      push(issues, "DS: SHA-1 digests are deprecated; prefer digest type 2 (SHA-256).");

    const name = (record.name ?? "").trim();
    if (!name) {
      push(
        nameIssues,
        "DS: name is the delegated child label (e.g., 'sub') in this zone; DS is normally published at the parent of the child zone.",
      );
    } else {
      if (name === "@") {
        push(
          nameIssues,
          "DS: @ is unusual; DS records are normally in the parent zone for a child delegation. Use @ only if you are delegating the zone apex from its parent.",
        );
      }
      if (name.startsWith("_"))
        push(nameIssues, "DS: names starting with '_' are unusual for delegations.");
    }

    const canonical = composeDS({
      keyTag,
      algorithm: alg,
      digestType,
      digest,
    });
    const content = (record.content ?? "").trim();
    if (content && content !== canonical) {
      push(
        issues,
        "DS: content differs from builder settings (use Apply canonical to normalize).",
      );
    }
    return { canonical, issues, nameIssues };
  }, [record.type, record.name, record.content, dsAlgorithm, dsDigest, dsDigestType, dsKeyTag]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "DS") {
      onWarningsChange({ issues: [], nameIssues: [], canonical: "" });
      return;
    }
    onWarningsChange({
      issues: diagnostics.issues,
      nameIssues: diagnostics.nameIssues,
      canonical: diagnostics.canonical,
    });
  }, [diagnostics.canonical, diagnostics.issues, diagnostics.nameIssues, onWarningsChange, record.type]);

  const digestNormalized = (dsDigest ?? "").replace(/\s+/g, "").toUpperCase();
  const expectedLen =
    dsDigestType === 1 ? 40 : dsDigestType === 2 ? 64 : dsDigestType === 4 ? 96 : undefined;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            DS builder (Delegation Signer)
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>keyTag algorithm digestType digest</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Key tag</Label>
            <Input
              type="number"
              value={dsKeyTag ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                setDsKeyTag(Number.isNaN(n) ? undefined : n);
              }}
              placeholder="e.g., 2371"
            />
            <div className="text-[11px] text-muted-foreground">
              0–65535 (from the child DNSSEC key).
            </div>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Algorithm</Label>
            <Select
              value={dsAlgorithmSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setDsAlgorithmMode("custom");
                  setDsAlgorithmCustomValue(dsAlgorithmCustomValue ?? dsAlgorithm);
                  return;
                }
                const n = Number.parseInt(value, 10);
                setDsAlgorithm(Number.isNaN(n) ? undefined : n);
                setDsAlgorithmMode("preset");
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="13">13 (ECDSAP256SHA256)</SelectItem>
                <SelectItem value="14">14 (ECDSAP384SHA384)</SelectItem>
                <SelectItem value="15">15 (ED25519)</SelectItem>
                <SelectItem value="16">16 (ED448)</SelectItem>
                <SelectItem value="8">8 (RSASHA256)</SelectItem>
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {dsAlgorithmMode === "custom" && (
              <Input
                className="mt-2"
                type="number"
                value={dsAlgorithmCustomValue ?? dsAlgorithm ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  const val = Number.isNaN(n) ? undefined : n;
                  setDsAlgorithmCustomValue(val);
                  setDsAlgorithm(val);
                }}
                placeholder="e.g., 13"
              />
            )}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Digest type</Label>
            <Select
              value={dsDigestTypeSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setDsDigestTypeMode("custom");
                  setDsDigestTypeCustomValue(dsDigestTypeCustomValue ?? dsDigestType);
                  return;
                }
                const n = Number.parseInt(value, 10);
                setDsDigestType(Number.isNaN(n) ? undefined : n);
                setDsDigestTypeMode("preset");
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="2">2 (SHA-256)</SelectItem>
                <SelectItem value="4">4 (SHA-384)</SelectItem>
                <SelectItem value="1">1 (SHA-1)</SelectItem>
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {dsDigestTypeMode === "custom" && (
              <Input
                className="mt-2"
                type="number"
                value={dsDigestTypeCustomValue ?? dsDigestType ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  const val = Number.isNaN(n) ? undefined : n;
                  setDsDigestTypeCustomValue(val);
                  setDsDigestType(val);
                }}
                placeholder="e.g., 2"
              />
            )}
          </div>
        </div>

        <div className="mt-2 space-y-1">
          <Label className="text-xs">Digest (hex)</Label>
          <textarea
            className="scrollbar-themed ui-focus w-full min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
            value={dsDigest}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDsDigest(e.target.value)}
            placeholder={expectedLen ? `${expectedLen} hex chars (no spaces)` : "hex digest"}
          />
          <div className="text-[11px] text-muted-foreground">
            {expectedLen
              ? `Expected ${expectedLen} hex characters for this digest type.`
              : "Paste the hex digest from your DNSSEC provider."}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setDsDigest(digestNormalized)}>
            Normalize digest
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseDSContent(record.content);
              setDsKeyTag(parsed.keyTag);
              setDsAlgorithm(parsed.algorithm);
              setDsDigestType(parsed.digestType);
              setDsDigest(parsed.digest);
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
          <div className="text-xs font-semibold text-muted-foreground">
            Preview (canonical)
          </div>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{diagnostics.canonical}</pre>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
          <div className="text-xs font-semibold text-muted-foreground">
            Recommendations
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
            <li>
              DS records are normally published in the <em>parent</em> zone for a
              child delegation. Only add DS here if you’re delegating a subdomain
              from this zone.
            </li>
            <li>
              Prefer digest type <code>2</code> (SHA-256). Avoid SHA-1 unless
              required.
            </li>
            <li>
              Copy values exactly from your DNSSEC provider (key tag, algorithm,
              digest type, digest).
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDsAlgorithm(13);
                setDsDigestType(2);
                setDsAlgorithmMode("preset");
                setDsDigestTypeMode("preset");
              }}
            >
              Preset: alg 13 + digest 2
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDsDigestType(2);
                setDsDigestTypeMode("preset");
              }}
            >
              Prefer SHA-256 (2)
            </Button>
          </div>
        </div>

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">DS warnings</div>
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

