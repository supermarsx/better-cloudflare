import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

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

function parseDSContent(value: string | undefined) {
  const raw = (value ?? "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
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
  return `${keyTag} ${algorithm} ${digestType} ${digest}`
    .replace(/\s+/g, " ")
    .trim();
}

export type DsFields = {
  keyTag: number | undefined;
  algorithm: number | undefined;
  digestType: number | undefined;
  digest: string;
  /** The record's owner name: the delegated child label in this zone. */
  name?: string;
};

/** DNSSEC signing algorithms, mirroring the table used by the validator below. */
const DS_ALGORITHM_NAMES: Record<number, string> = {
  5: "RSA/SHA-1",
  7: "RSA/SHA-1 with NSEC3",
  8: "RSA/SHA-256",
  10: "RSA/SHA-512",
  13: "ECDSA P-256/SHA-256",
  14: "ECDSA P-384/SHA-384",
  15: "Ed25519",
  16: "Ed448",
};

/** Algorithms retired by RFC 8624 that validators are dropping support for. */
const DS_DEPRECATED_ALGORITHMS = new Set([5, 7]);

const DS_DIGEST_NAMES: Record<number, string> = {
  1: "SHA-1",
  2: "SHA-256",
  4: "SHA-384",
};

function describeDelegatedChild(name: string | undefined) {
  const raw = (name ?? "").trim().replace(/\.$/, "");
  if (!raw) return "the delegated child zone";
  if (raw === "@") return "this zone itself";
  return raw;
}

/**
 * Plain-English description of the delegation being signed.
 *
 * A DS record is the one place in DNS where a typo takes a whole zone offline
 * for validating resolvers, so the summary leads with where the record lives and
 * what happens when the digest is wrong.
 */
export function describeDS(fields: DsFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const child = describeDelegatedChild(fields.name);

  const headline =
    fields.keyTag !== undefined
      ? `Tells validating resolvers that ${child} is signed and that its DNSKEY with key tag ${fields.keyTag} is the key they should trust, completing the DNSSEC chain of trust across this delegation.`
      : `Builds the record that links a delegated child zone into the DNSSEC chain of trust; enter the child's key tag, algorithm and digest to say which DNSKEY resolvers should trust.`;

  if (fields.keyTag !== undefined) {
    details.push(
      "The key tag is a 16-bit checksum, not a unique identifier: two DNSKEYs in one zone may legally share a tag, so the algorithm and digest are what actually pick the key out.",
    );
  }

  const algorithmName =
    fields.algorithm !== undefined
      ? DS_ALGORITHM_NAMES[fields.algorithm]
      : undefined;
  if (algorithmName) {
    details.push(
      `The referenced key signs with algorithm ${fields.algorithm} (${algorithmName}), which must match the algorithm of the DNSKEY in the child zone.`,
    );
  } else if (fields.algorithm !== undefined) {
    unknowns.push(
      `Algorithm ${fields.algorithm} is not one this builder recognises, so whether resolvers can validate with it cannot be determined here.`,
    );
  }
  if (
    fields.algorithm !== undefined &&
    DS_DEPRECATED_ALGORITHMS.has(fields.algorithm)
  ) {
    details.push(
      "This algorithm is based on SHA-1 and is deprecated by RFC 8624; validators are dropping support for it, so plan a rollover to algorithm 13 or 15.",
    );
  }

  const digestName =
    fields.digestType !== undefined
      ? DS_DIGEST_NAMES[fields.digestType]
      : undefined;
  if (digestName) {
    details.push(`The digest below is a ${digestName} hash of that DNSKEY.`);
  } else if (fields.digestType !== undefined) {
    unknowns.push(
      `Digest type ${fields.digestType} is not one of the defined types (1 SHA-1, 2 SHA-256, 4 SHA-384), so how the digest is computed cannot be determined here.`,
    );
  }
  if (fields.digestType === 1) {
    details.push(
      "SHA-1 digests are deprecated; digest type 2 (SHA-256) is the required baseline that every validator supports.",
    );
  }

  details.push(
    "A DS record lives in the parent zone, at the label of the delegated child, so it only takes effect if this zone is that child's parent.",
  );
  details.push(
    "If the digest does not match a DNSKEY the child publishes, validating resolvers answer SERVFAIL for the whole child zone rather than falling back to unsigned answers.",
  );

  if (!fields.digest.trim()) {
    details.push(
      "No digest is entered yet, so the record does not identify a key.",
    );
  }

  unknowns.push(
    "Whether this digest matches the DNSKEY currently published in the child zone cannot be verified here.",
  );

  return { headline, details, unknowns };
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

  const { fieldIds, helpIds } = useBuilderFieldIds([
    "keyTag",
    "algorithm",
    "algorithmCustom",
    "digestType",
    "digestTypeCustom",
    "digest",
  ] as const);

  const summary = useMemo(
    () =>
      describeDS({
        keyTag: dsKeyTag,
        algorithm: dsAlgorithm,
        digestType: dsDigestType,
        digest: dsDigest,
        name: record.name,
      }),
    [dsAlgorithm, dsDigest, dsDigestType, dsKeyTag, record.name],
  );

  useEffect(() => {
    if (record.type !== "DS") return;
    const parsed = parseDSContent(record.content);
    setDsKeyTag(parsed.keyTag);
    setDsAlgorithm(parsed.algorithm);
    setDsDigestType(parsed.digestType);
    setDsDigest(parsed.digest);

    const algIsPreset =
      parsed.algorithm !== undefined &&
      [8, 13, 14, 15, 16].includes(parsed.algorithm);
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
    if (record.type !== "DS")
      return { canonical: "", issues: [], nameIssues: [] };
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
    else if (keyTag < 0 || keyTag > 65535)
      push(issues, "DS: key tag should be 0–65535.");

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
    else if (alg < 0 || alg > 255)
      push(issues, "DS: algorithm should be 0–255.");
    else if (!knownAlg[alg])
      push(issues, `DS: algorithm ${alg} is uncommon; double-check.`);

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
      if (digest.length % 2 !== 0)
        push(issues, "DS: digest hex length should be even.");
      const expected =
        digestType !== undefined ? knownDigest[digestType]?.hexLen : undefined;
      if (expected && digest.length !== expected)
        push(
          issues,
          `DS: digest length is ${digest.length} hex chars; expected ${expected} for ${knownDigest[digestType!].name}.`,
        );
    }

    if (alg === 13 && digestType === 1)
      push(
        issues,
        "DS: SHA-1 digests are deprecated; prefer digest type 2 (SHA-256).",
      );

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
        push(
          nameIssues,
          "DS: names starting with '_' are unusual for delegations.",
        );
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
  }, [
    record.type,
    record.name,
    record.content,
    dsAlgorithm,
    dsDigest,
    dsDigestType,
    dsKeyTag,
  ]);

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
  }, [
    diagnostics.canonical,
    diagnostics.issues,
    diagnostics.nameIssues,
    onWarningsChange,
    record.type,
  ]);

  const digestNormalized = (dsDigest ?? "").replace(/\s+/g, "").toUpperCase();
  const expectedLen =
    dsDigestType === 1
      ? 40
      : dsDigestType === 2
        ? 64
        : dsDigestType === 4
          ? 96
          : undefined;

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

        <RecordSummary summary={summary} className="mt-2" />

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.keyTag}
              descriptionId={helpIds.keyTag}
              label="Key tag"
              help="A 16-bit checksum (0–65535) that points at the child zone's DNSKEY. It is not unique — two keys may legally share a tag — so copy it exactly from the child's DNSSEC provider rather than deriving it."
            />
            <Input
              id={fieldIds.keyTag}
              aria-describedby={helpIds.keyTag}
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
            <BuilderFieldLabel
              controlId={fieldIds.algorithm}
              descriptionId={helpIds.algorithm}
              label="Algorithm"
              help="The signing algorithm of the DNSKEY this record refers to, and it must match that key exactly. 13 (ECDSA P-256/SHA-256), 15 (Ed25519) and 8 (RSA/SHA-256) are current; 5 and 7 are deprecated SHA-1 algorithms."
            />
            <Select
              value={dsAlgorithmSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setDsAlgorithmMode("custom");
                  setDsAlgorithmCustomValue(
                    dsAlgorithmCustomValue ?? dsAlgorithm,
                  );
                  return;
                }
                const n = Number.parseInt(value, 10);
                setDsAlgorithm(Number.isNaN(n) ? undefined : n);
                setDsAlgorithmMode("preset");
              }}
            >
              <SelectTrigger
                id={fieldIds.algorithm}
                aria-describedby={helpIds.algorithm}
                className="h-9"
              >
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
              <>
                <BuilderFieldLabel
                  controlId={fieldIds.algorithmCustom}
                  descriptionId={helpIds.algorithmCustom}
                  label="Custom algorithm value"
                  help="A DNSSEC algorithm number outside the presets, from 0 to 255. Only use one that the child zone's DNSKEY actually uses; resolvers treat an unsupported algorithm as an unsigned delegation."
                />
                <Input
                  id={fieldIds.algorithmCustom}
                  aria-describedby={helpIds.algorithmCustom}
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
              </>
            )}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.digestType}
              descriptionId={helpIds.digestType}
              label="Digest type"
              help="Which hash of the child's DNSKEY the digest holds: 1 is SHA-1, 2 is SHA-256 and 4 is SHA-384. Use 2 — it is the mandatory baseline every validator supports, while SHA-1 is deprecated."
            />
            <Select
              value={dsDigestTypeSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setDsDigestTypeMode("custom");
                  setDsDigestTypeCustomValue(
                    dsDigestTypeCustomValue ?? dsDigestType,
                  );
                  return;
                }
                const n = Number.parseInt(value, 10);
                setDsDigestType(Number.isNaN(n) ? undefined : n);
                setDsDigestTypeMode("preset");
              }}
            >
              <SelectTrigger
                id={fieldIds.digestType}
                aria-describedby={helpIds.digestType}
                className="h-9"
              >
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
              <>
                <BuilderFieldLabel
                  controlId={fieldIds.digestTypeCustom}
                  descriptionId={helpIds.digestTypeCustom}
                  label="Custom digest type value"
                  help="A digest type outside the presets, from 0 to 255. Only 1, 2 and 4 are assigned; a resolver that does not know the digest type treats the delegation as unsigned."
                />
                <Input
                  id={fieldIds.digestTypeCustom}
                  aria-describedby={helpIds.digestTypeCustom}
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
              </>
            )}
          </div>
        </div>

        <div className="mt-2 space-y-1">
          <BuilderFieldLabel
            controlId={fieldIds.digest}
            descriptionId={helpIds.digest}
            label="Digest (hex)"
            help="The hex hash of the child zone's DNSKEY record, taken verbatim from the child's DNSSEC provider. SHA-256 digests are 64 hex characters, SHA-384 are 96 and SHA-1 are 40."
          />
          <Textarea
            id={fieldIds.digest}
            aria-describedby={helpIds.digest}
            className="scrollbar-themed min-h-20 resize-y"
            value={dsDigest}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
              setDsDigest(e.target.value)
            }
            placeholder={
              expectedLen
                ? `${expectedLen} hex chars (no spaces)`
                : "hex digest"
            }
          />
          <div className="text-[11px] text-muted-foreground">
            {expectedLen
              ? `Expected ${expectedLen} hex characters for this digest type.`
              : "Paste the hex digest from your DNSSEC provider."}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDsDigest(digestNormalized)}
          >
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
              DS records are normally published in the <em>parent</em> zone for
              a child delegation. Only add DS here if you’re delegating a
              subdomain from this zone.
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

        {(diagnostics.nameIssues.length > 0 ||
          diagnostics.issues.length > 0) && (
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
