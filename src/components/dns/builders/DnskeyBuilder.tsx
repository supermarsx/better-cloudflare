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

function parseDNSKEYContent(value: string | undefined) {
  const raw = (value ?? "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) {
    return {
      flags: undefined as number | undefined,
      protocol: undefined as number | undefined,
      algorithm: undefined as number | undefined,
      publicKey: "",
    };
  }
  const parts = raw.split(" ").filter(Boolean);
  const flags = Number.parseInt(parts[0] ?? "", 10);
  const protocol = Number.parseInt(parts[1] ?? "", 10);
  const algorithm = Number.parseInt(parts[2] ?? "", 10);
  const publicKey = parts.slice(3).join("").replace(/\s+/g, "");
  return {
    flags: Number.isNaN(flags) ? undefined : flags,
    protocol: Number.isNaN(protocol) ? undefined : protocol,
    algorithm: Number.isNaN(algorithm) ? undefined : algorithm,
    publicKey,
  };
}

function composeDNSKEY(fields: {
  flags: number | undefined;
  protocol: number | undefined;
  algorithm: number | undefined;
  publicKey: string;
}) {
  const flags = fields.flags ?? "";
  const protocol = fields.protocol ?? "";
  const algorithm = fields.algorithm ?? "";
  const publicKey = (fields.publicKey ?? "").replace(/\s+/g, "");
  return `${flags} ${protocol} ${algorithm} ${publicKey}`
    .replace(/\s+/g, " ")
    .trim();
}

export type DnskeyFields = {
  flags: number | undefined;
  protocol: number | undefined;
  algorithm: number | undefined;
  publicKey: string;
  /** `DNSKEY` or `CDNSKEY`; the two records carry the same wire format. */
  recordType?: string;
};

/** DNSKEY flag bits from RFC 4034 §2.1.1 and the REVOKE bit from RFC 5011. */
const DNSKEY_ZONE_KEY_BIT = 0x0100;
const DNSKEY_SEP_BIT = 0x0001;
const DNSKEY_REVOKE_BIT = 0x0080;

const DNSKEY_ALGORITHM_NAMES: Record<number, string> = {
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
const DNSKEY_DEPRECATED_ALGORITHMS = new Set([5, 7]);

/**
 * Plain-English description of the DNSSEC public key being published.
 *
 * The distinction that matters operationally is the SEP bit: a key-signing key
 * is the one the parent's DS record has to point at, while a zone-signing key is
 * only referenced from within the zone's own signatures.
 */
export function describeDNSKEY(fields: DnskeyFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const isCdnskey = (fields.recordType ?? "").toUpperCase() === "CDNSKEY";
  const flags = fields.flags;
  const zoneKey = flags !== undefined && (flags & DNSKEY_ZONE_KEY_BIT) !== 0;
  const sep = flags !== undefined && (flags & DNSKEY_SEP_BIT) !== 0;
  const revoke = flags !== undefined && (flags & DNSKEY_REVOKE_BIT) !== 0;

  let headline: string;
  if (isCdnskey) {
    headline =
      "Asks the parent zone to publish a DS record for this key, so the delegation's chain of trust can be updated without a manual change at the registrar.";
  } else if (flags === undefined) {
    headline =
      "Builds the record that publishes a zone's public DNSSEC key; set the flags to say whether it is the zone-signing key or the key-signing key the parent points at.";
  } else if (zoneKey && sep) {
    headline =
      "Publishes this zone's key-signing key: the public key validating resolvers use to check the zone's signatures, and the key the parent's DS record must point at.";
  } else if (zoneKey) {
    headline =
      "Publishes this zone's zone-signing key: the public key validating resolvers use to check the signatures covering this zone's records.";
  } else {
    headline = `Publishes a public key with flags ${flags}, which does not set the Zone Key bit, so validating resolvers will not use it to verify this zone's signatures.`;
  }

  if (flags !== undefined && !zoneKey && !isCdnskey) {
    details.push(
      "The standard values are 256 (zone-signing key) and 257 (zone-signing key plus the secure entry point bit); anything without the Zone Key bit is unusual.",
    );
  }
  if (zoneKey && sep) {
    details.push(
      "The secure entry point bit is what marks this as the key a DS record refers to; RFC 4034 treats it as a hint for tooling rather than something resolvers enforce.",
    );
  }
  if (revoke) {
    details.push(
      "The REVOKE bit is set, so resolvers that follow RFC 5011 stop trusting this key once they see it signed by itself.",
    );
  }

  if (fields.protocol === undefined) {
    details.push("Protocol is not set; RFC 4034 requires it to be 3.");
  } else if (fields.protocol !== 3) {
    details.push(
      `Protocol is ${fields.protocol}, but RFC 4034 requires 3, so resolvers treat this record as invalid.`,
    );
  }

  const algorithmName =
    fields.algorithm !== undefined
      ? DNSKEY_ALGORITHM_NAMES[fields.algorithm]
      : undefined;
  if (algorithmName) {
    details.push(
      `The key is an ${algorithmName} key (algorithm ${fields.algorithm}), and every signature made with it carries that same algorithm number.`,
    );
  } else if (fields.algorithm !== undefined) {
    unknowns.push(
      `Algorithm ${fields.algorithm} is not one this builder recognises, so whether resolvers can validate with it cannot be determined here.`,
    );
  }
  if (
    fields.algorithm !== undefined &&
    DNSKEY_DEPRECATED_ALGORITHMS.has(fields.algorithm)
  ) {
    details.push(
      "This algorithm is based on SHA-1 and is deprecated by RFC 8624; plan a rollover to algorithm 13 or 15.",
    );
  }

  if (!fields.publicKey.trim()) {
    details.push(
      "No public key is entered yet, so the record does not publish anything usable.",
    );
  }

  if (!isCdnskey) {
    details.push(
      "Publishing a key on its own changes nothing: resolvers only use it once the zone's records carry RRSIG signatures made with the matching private key.",
    );
  }

  if (isCdnskey) {
    unknowns.push(
      "Whether the parent zone or registry acts on this record depends on their support for RFC 8078 automation, which cannot be determined here.",
    );
  } else if (zoneKey && sep) {
    unknowns.push(
      "Whether the parent's DS record points at this exact key cannot be seen from this form, and a mismatch makes the whole zone fail validation.",
    );
  }
  unknowns.push(
    "Whether the zone is signed with the private half of this key cannot be checked from this form.",
  );

  return { headline, details, unknowns };
}

export function DnskeyBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [dnskeyFlags, setDnskeyFlags] = useState<number | undefined>(257);
  const [dnskeyProtocol, setDnskeyProtocol] = useState<number | undefined>(3);
  const [dnskeyAlgorithm, setDnskeyAlgorithm] = useState<number | undefined>(
    13,
  );
  const [dnskeyPublicKey, setDnskeyPublicKey] = useState<string>("");

  const [dnskeyFlagsMode, setDnskeyFlagsMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [dnskeyFlagsCustomValue, setDnskeyFlagsCustomValue] = useState<
    number | undefined
  >(undefined);
  const [dnskeyAlgorithmMode, setDnskeyAlgorithmMode] = useState<
    "preset" | "custom"
  >("preset");
  const [dnskeyAlgorithmCustomValue, setDnskeyAlgorithmCustomValue] = useState<
    number | undefined
  >(undefined);

  const { fieldIds, helpIds } = useBuilderFieldIds([
    "flags",
    "flagsCustom",
    "protocol",
    "algorithm",
    "algorithmCustom",
    "publicKey",
  ] as const);

  const summary = useMemo(
    () =>
      describeDNSKEY({
        flags: dnskeyFlags,
        protocol: dnskeyProtocol,
        algorithm: dnskeyAlgorithm,
        publicKey: dnskeyPublicKey,
        recordType: record.type,
      }),
    [
      dnskeyAlgorithm,
      dnskeyFlags,
      dnskeyProtocol,
      dnskeyPublicKey,
      record.type,
    ],
  );

  useEffect(() => {
    if (record.type !== "DNSKEY" && record.type !== "CDNSKEY") return;
    const parsed = parseDNSKEYContent(record.content);
    setDnskeyFlags(parsed.flags);
    setDnskeyProtocol(parsed.protocol);
    setDnskeyAlgorithm(parsed.algorithm);
    setDnskeyPublicKey(parsed.publicKey);

    const flagsIsPreset =
      parsed.flags !== undefined && [256, 257].includes(parsed.flags);
    if (flagsIsPreset) {
      setDnskeyFlagsMode("preset");
    } else {
      setDnskeyFlagsMode("custom");
      setDnskeyFlagsCustomValue(parsed.flags);
    }

    const algIsPreset =
      parsed.algorithm !== undefined &&
      [8, 13, 14, 15, 16].includes(parsed.algorithm);
    if (algIsPreset) {
      setDnskeyAlgorithmMode("preset");
    } else {
      setDnskeyAlgorithmMode("custom");
      setDnskeyAlgorithmCustomValue(parsed.algorithm);
    }
  }, [record.type, record.content]);

  const dnskeyFlagsSelectValue = useMemo(() => {
    if (dnskeyFlagsMode === "custom") return "custom";
    if (dnskeyFlags === undefined || dnskeyFlags === null) return "custom";
    if (dnskeyFlags === 256) return "256";
    if (dnskeyFlags === 257) return "257";
    return "custom";
  }, [dnskeyFlags, dnskeyFlagsMode]);

  const dnskeyFlagsExplainer = useMemo(() => {
    const flags = dnskeyFlags ?? 0;
    const zoneKey = (flags & 0x0100) !== 0; // 256
    const sep = (flags & 0x0001) !== 0; // 1
    const revoke = (flags & 0x0080) !== 0; // 128 (RFC 5011)
    const knownMask = 0x0100 | 0x0001 | 0x0080;
    const unknown = flags & ~knownMask;
    const unknownBits: number[] = [];
    for (let bit = 0; bit < 16; bit += 1) {
      const mask = 1 << bit;
      if ((unknown & mask) !== 0) unknownBits.push(mask);
    }
    return { flags, zoneKey, sep, revoke, unknownBits };
  }, [dnskeyFlags]);

  const dnskeyAlgorithmSelectValue = useMemo(() => {
    if (dnskeyAlgorithmMode === "custom") return "custom";
    if (dnskeyAlgorithm === undefined || dnskeyAlgorithm === null)
      return "custom";
    if ([8, 13, 14, 15, 16].includes(dnskeyAlgorithm))
      return String(dnskeyAlgorithm);
    return "custom";
  }, [dnskeyAlgorithm, dnskeyAlgorithmMode]);

  const diagnostics = useMemo(() => {
    if (record.type !== "DNSKEY" && record.type !== "CDNSKEY") {
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

    const flags = dnskeyFlags;
    const protocol = dnskeyProtocol;
    const alg = dnskeyAlgorithm;
    const pkRaw = dnskeyPublicKey ?? "";
    const pk = pkRaw.replace(/\s+/g, "");

    if (flags === undefined) push(issues, "DNSKEY: flags are missing.");
    else if (flags < 0 || flags > 65535)
      push(issues, "DNSKEY: flags should be 0–65535.");
    else if (![256, 257].includes(flags))
      push(issues, "DNSKEY: flags are usually 256 (ZSK) or 257 (KSK).");

    if (protocol === undefined)
      push(issues, "DNSKEY: protocol is missing (usually 3).");
    else if (protocol !== 3) push(issues, "DNSKEY: protocol should be 3.");

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
    if (alg === undefined) push(issues, "DNSKEY: algorithm is missing.");
    else if (alg < 0 || alg > 255)
      push(issues, "DNSKEY: algorithm should be 0–255.");
    else if (!knownAlg[alg])
      push(issues, `DNSKEY: algorithm ${alg} is uncommon; double-check.`);

    if (!pk) push(issues, "DNSKEY: public key is missing.");
    if (pkRaw && pkRaw !== pk)
      push(
        issues,
        "DNSKEY: public key contains whitespace (will be normalized).",
      );
    if (/-----BEGIN\b/i.test(pkRaw))
      push(
        issues,
        "DNSKEY: public key looks like PEM; paste base64 only (no header/footer).",
      );
    if (pk) {
      if (!/^[A-Za-z0-9+/=]+$/.test(pk))
        push(issues, "DNSKEY: public key contains non-base64 characters.");
      if (pk.length % 4 !== 0)
        push(issues, "DNSKEY: base64 length is unusual (not a multiple of 4).");
    }

    const name = (record.name ?? "").trim();
    if (!name || name !== "@") {
      push(
        nameIssues,
        `DNSKEY: name is typically "@" (zone apex) for ${record.type}.`,
      );
    }

    const canonical = composeDNSKEY({
      flags,
      protocol,
      algorithm: alg,
      publicKey: pk,
    });
    const content = (record.content ?? "").trim();
    if (content && content !== canonical) {
      push(
        issues,
        "DNSKEY: content differs from builder settings (use Apply canonical to normalize).",
      );
    }

    return { canonical, issues, nameIssues };
  }, [
    record.type,
    record.name,
    record.content,
    dnskeyAlgorithm,
    dnskeyFlags,
    dnskeyProtocol,
    dnskeyPublicKey,
  ]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "DNSKEY" && record.type !== "CDNSKEY") {
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

  const pkNormalized = (dnskeyPublicKey ?? "").replace(/\s+/g, "");

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            DNSKEY builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>flags protocol algorithm publicKey</code>
          </div>
        </div>

        <RecordSummary summary={summary} className="mt-2" />

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.flags}
              descriptionId={helpIds.flags}
              label="Flags"
              help="What role the key plays: 256 is a zone-signing key, and 257 additionally sets the secure entry point bit that marks a key-signing key, the one the parent's DS record points at. Values without the Zone Key bit, such as 0, are not used for signing a zone."
            />
            <Select
              value={dnskeyFlagsSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setDnskeyFlagsMode("custom");
                  setDnskeyFlagsCustomValue(
                    dnskeyFlagsCustomValue ?? dnskeyFlags,
                  );
                  return;
                }
                const n = Number.parseInt(value, 10);
                setDnskeyFlags(Number.isNaN(n) ? undefined : n);
                setDnskeyFlagsMode("preset");
              }}
            >
              <SelectTrigger
                id={fieldIds.flags}
                aria-describedby={helpIds.flags}
                className="h-9"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="257">257 (KSK)</SelectItem>
                <SelectItem value="256">256 (ZSK)</SelectItem>
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {dnskeyFlagsMode === "custom" && (
              <>
                <BuilderFieldLabel
                  controlId={fieldIds.flagsCustom}
                  descriptionId={helpIds.flagsCustom}
                  label="Custom flags value"
                  help="A raw 16-bit flags field, 0 to 65535. Bit 7 (128) is the RFC 5011 REVOKE bit, bit 8 (256) is the Zone Key bit and bit 15 (1) is the secure entry point bit; all other bits are reserved and must be zero."
                />
                <Input
                  id={fieldIds.flagsCustom}
                  aria-describedby={helpIds.flagsCustom}
                  className="mt-2"
                  type="number"
                  value={dnskeyFlagsCustomValue ?? dnskeyFlags ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setDnskeyFlagsCustomValue(val);
                    setDnskeyFlags(val);
                  }}
                  placeholder="e.g., 257"
                />
              </>
            )}
            <div className="text-[11px] text-muted-foreground">
              Common presets:
              <ul className="mt-1 list-disc space-y-1 pl-4">
                <li>
                  <code>256</code>: Zone Key (ZSK)
                </li>
                <li>
                  <code>257</code>: Zone Key + SEP (KSK)
                </li>
              </ul>
            </div>
            <div className="mt-2 rounded-md border border-border/50 bg-background/30 px-3 py-2 text-[11px] text-muted-foreground">
              <div className="font-semibold text-foreground/80">
                Current flags: <code>{dnskeyFlagsExplainer.flags}</code>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
                <div>
                  <code>256</code> Zone Key:{" "}
                  {dnskeyFlagsExplainer.zoneKey ? "on" : "off"}
                </div>
                <div>
                  <code>1</code> SEP: {dnskeyFlagsExplainer.sep ? "on" : "off"}
                </div>
                <div className="col-span-2">
                  <code>128</code> REVOKE:{" "}
                  {dnskeyFlagsExplainer.revoke ? "on" : "off"}
                </div>
              </div>
              {dnskeyFlagsExplainer.unknownBits.length > 0 && (
                <div className="mt-2">
                  Unknown bits set:{" "}
                  {dnskeyFlagsExplainer.unknownBits
                    .slice(0, 6)
                    .map((b) => `0x${b.toString(16)}`)
                    .join(", ")}
                  {dnskeyFlagsExplainer.unknownBits.length > 6 ? "…" : ""}
                </div>
              )}
            </div>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.protocol}
              descriptionId={helpIds.protocol}
              label="Protocol"
              help="A fixed field that RFC 4034 requires to be 3. Any other value makes the record invalid, and resolvers ignore the key, so leave this at 3."
            />
            <Input
              id={fieldIds.protocol}
              aria-describedby={helpIds.protocol}
              type="number"
              value={dnskeyProtocol ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                setDnskeyProtocol(Number.isNaN(n) ? undefined : n);
              }}
              placeholder="3"
            />
            <div className="text-[11px] text-muted-foreground">
              Must be <code>3</code> in modern DNSSEC.
            </div>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.algorithm}
              descriptionId={helpIds.algorithm}
              label="Algorithm"
              help="The public key algorithm, which must match the key material pasted below and the algorithm used to sign the zone. 13 (ECDSA P-256/SHA-256), 15 (Ed25519) and 8 (RSA/SHA-256) are current; 5 and 7 are deprecated SHA-1 algorithms."
            />
            <Select
              value={dnskeyAlgorithmSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setDnskeyAlgorithmMode("custom");
                  setDnskeyAlgorithmCustomValue(
                    dnskeyAlgorithmCustomValue ?? dnskeyAlgorithm,
                  );
                  return;
                }
                const n = Number.parseInt(value, 10);
                setDnskeyAlgorithm(Number.isNaN(n) ? undefined : n);
                setDnskeyAlgorithmMode("preset");
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
            {dnskeyAlgorithmMode === "custom" && (
              <>
                <BuilderFieldLabel
                  controlId={fieldIds.algorithmCustom}
                  descriptionId={helpIds.algorithmCustom}
                  label="Custom algorithm value"
                  help="A DNSSEC algorithm number outside the presets, from 0 to 255. A resolver that does not implement the algorithm cannot validate the zone and treats it as unsigned."
                />
                <Input
                  id={fieldIds.algorithmCustom}
                  aria-describedby={helpIds.algorithmCustom}
                  className="mt-2"
                  type="number"
                  value={dnskeyAlgorithmCustomValue ?? dnskeyAlgorithm ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setDnskeyAlgorithmCustomValue(val);
                    setDnskeyAlgorithm(val);
                  }}
                  placeholder="e.g., 13"
                />
              </>
            )}
          </div>
        </div>

        <div className="mt-2 space-y-1">
          <BuilderFieldLabel
            controlId={fieldIds.publicKey}
            descriptionId={helpIds.publicKey}
            label="Public key (base64)"
            help="The public key material in base64, exactly as your DNSSEC provider supplies it, with no PEM header or footer. Its length and encoding are determined by the algorithm above."
          />
          <Textarea
            id={fieldIds.publicKey}
            aria-describedby={helpIds.publicKey}
            className="scrollbar-themed min-h-24 resize-y"
            value={dnskeyPublicKey}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
              setDnskeyPublicKey(e.target.value)
            }
            placeholder="Paste the base64 public key (no PEM header/footer)"
          />
          <div className="text-[11px] text-muted-foreground">
            Whitespace is ignored; it will be normalized in the canonical
            preview.
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onRecordChange({ ...record, name: "@" })}
          >
            Set name to @
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDnskeyPublicKey(pkNormalized)}
          >
            Normalize key whitespace
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseDNSKEYContent(record.content);
              setDnskeyFlags(parsed.flags);
              setDnskeyProtocol(parsed.protocol);
              setDnskeyAlgorithm(parsed.algorithm);
              setDnskeyPublicKey(parsed.publicKey);
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
              DNSKEY records are published at the zone apex (<code>@</code>).
            </li>
            <li>
              Most modern zones use algorithm <code>13</code> (ECDSAP256SHA256)
              or <code>15</code> (ED25519).
            </li>
            <li>
              Keep protocol at <code>3</code>. Flags are usually{" "}
              <code>257</code> (KSK) or <code>256</code> (ZSK).
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDnskeyFlags(257);
                setDnskeyProtocol(3);
                setDnskeyAlgorithm(13);
                setDnskeyFlagsMode("preset");
                setDnskeyAlgorithmMode("preset");
              }}
            >
              Preset: KSK (257) + alg 13
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDnskeyFlags(256);
                setDnskeyProtocol(3);
                setDnskeyAlgorithm(13);
                setDnskeyFlagsMode("preset");
                setDnskeyAlgorithmMode("preset");
              }}
            >
              Preset: ZSK (256) + alg 13
            </Button>
          </div>
        </div>

        {(diagnostics.nameIssues.length > 0 ||
          diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">DNSKEY warnings</div>
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
