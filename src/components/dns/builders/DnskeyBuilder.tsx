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
import { Textarea } from "@/components/ui/textarea";

import type { BuilderWarningsChange, RecordDraft } from "./types";

function parseDNSKEYContent(value: string | undefined) {
  const raw = (value ?? "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  return `${flags} ${protocol} ${algorithm} ${publicKey}`.replace(/\s+/g, " ").trim();
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
  const [dnskeyAlgorithm, setDnskeyAlgorithm] = useState<number | undefined>(13);
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

  useEffect(() => {
    if (record.type !== "DNSKEY" && record.type !== "CDNSKEY") return;
    const parsed = parseDNSKEYContent(record.content);
    setDnskeyFlags(parsed.flags);
    setDnskeyProtocol(parsed.protocol);
    setDnskeyAlgorithm(parsed.algorithm);
    setDnskeyPublicKey(parsed.publicKey);

    const flagsIsPreset = parsed.flags !== undefined && [256, 257].includes(parsed.flags);
    if (flagsIsPreset) {
      setDnskeyFlagsMode("preset");
    } else {
      setDnskeyFlagsMode("custom");
      setDnskeyFlagsCustomValue(parsed.flags);
    }

    const algIsPreset =
      parsed.algorithm !== undefined && [8, 13, 14, 15, 16].includes(parsed.algorithm);
    if (algIsPreset) {
      setDnskeyAlgorithmMode("preset");
    } else {
      setDnskeyAlgorithmMode("custom");
      setDnskeyAlgorithmCustomValue(parsed.algorithm);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (dnskeyAlgorithm === undefined || dnskeyAlgorithm === null) return "custom";
    if ([8, 13, 14, 15, 16].includes(dnskeyAlgorithm)) return String(dnskeyAlgorithm);
    return "custom";
  }, [dnskeyAlgorithm, dnskeyAlgorithmMode]);

  const diagnostics = useMemo(() => {
    if (record.type !== "DNSKEY" && record.type !== "CDNSKEY") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
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
    else if (flags < 0 || flags > 65535) push(issues, "DNSKEY: flags should be 0–65535.");
    else if (![256, 257].includes(flags))
      push(issues, "DNSKEY: flags are usually 256 (ZSK) or 257 (KSK).");

    if (protocol === undefined) push(issues, "DNSKEY: protocol is missing (usually 3).");
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
    else if (alg < 0 || alg > 255) push(issues, "DNSKEY: algorithm should be 0–255.");
    else if (!knownAlg[alg]) push(issues, `DNSKEY: algorithm ${alg} is uncommon; double-check.`);

    if (!pk) push(issues, "DNSKEY: public key is missing.");
    if (pkRaw && pkRaw !== pk)
      push(issues, "DNSKEY: public key contains whitespace (will be normalized).");
    if (/-----BEGIN\b/i.test(pkRaw))
      push(issues, "DNSKEY: public key looks like PEM; paste base64 only (no header/footer).");
    if (pk) {
      if (!/^[A-Za-z0-9+/=]+$/.test(pk))
        push(issues, "DNSKEY: public key contains non-base64 characters.");
      if (pk.length % 4 !== 0)
        push(issues, "DNSKEY: base64 length is unusual (not a multiple of 4).");
    }

    const name = (record.name ?? "").trim();
    if (!name || name !== "@") {
      push(nameIssues, `DNSKEY: name is typically "@" (zone apex) for ${record.type}.`);
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
  }, [record.type, record.name, record.content, dnskeyAlgorithm, dnskeyFlags, dnskeyProtocol, dnskeyPublicKey]);

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
  }, [diagnostics.canonical, diagnostics.issues, diagnostics.nameIssues, onWarningsChange, record.type]);

  const pkNormalized = (dnskeyPublicKey ?? "").replace(/\s+/g, "");

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">DNSKEY builder</div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>flags protocol algorithm publicKey</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Flags</Label>
            <Select
              value={dnskeyFlagsSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setDnskeyFlagsMode("custom");
                  setDnskeyFlagsCustomValue(dnskeyFlagsCustomValue ?? dnskeyFlags);
                  return;
                }
                const n = Number.parseInt(value, 10);
                setDnskeyFlags(Number.isNaN(n) ? undefined : n);
                setDnskeyFlagsMode("preset");
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="257">257 (KSK)</SelectItem>
                <SelectItem value="256">256 (ZSK)</SelectItem>
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {dnskeyFlagsMode === "custom" && (
              <Input
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
                  <code>256</code> Zone Key: {dnskeyFlagsExplainer.zoneKey ? "on" : "off"}
                </div>
                <div>
                  <code>1</code> SEP: {dnskeyFlagsExplainer.sep ? "on" : "off"}
                </div>
                <div className="col-span-2">
                  <code>128</code> REVOKE: {dnskeyFlagsExplainer.revoke ? "on" : "off"}
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
            <Label className="text-xs">Protocol</Label>
            <Input
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
            <Label className="text-xs">Algorithm</Label>
            <Select
              value={dnskeyAlgorithmSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setDnskeyAlgorithmMode("custom");
                  setDnskeyAlgorithmCustomValue(dnskeyAlgorithmCustomValue ?? dnskeyAlgorithm);
                  return;
                }
                const n = Number.parseInt(value, 10);
                setDnskeyAlgorithm(Number.isNaN(n) ? undefined : n);
                setDnskeyAlgorithmMode("preset");
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
            {dnskeyAlgorithmMode === "custom" && (
              <Input
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
            )}
          </div>
        </div>

        <div className="mt-2 space-y-1">
          <Label className="text-xs">Public key (base64)</Label>
          <Textarea
            className="scrollbar-themed min-h-24 resize-y"
            value={dnskeyPublicKey}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDnskeyPublicKey(e.target.value)}
            placeholder="Paste the base64 public key (no PEM header/footer)"
          />
          <div className="text-[11px] text-muted-foreground">
            Whitespace is ignored; it will be normalized in the canonical preview.
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => onRecordChange({ ...record, name: "@" })}>
            Set name to @
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDnskeyPublicKey(pkNormalized)}>
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
          <div className="text-xs font-semibold text-muted-foreground">Preview (canonical)</div>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{diagnostics.canonical}</pre>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
          <div className="text-xs font-semibold text-muted-foreground">Recommendations</div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
            <li>
              DNSKEY records are published at the zone apex (<code>@</code>).
            </li>
            <li>
              Most modern zones use algorithm <code>13</code> (ECDSAP256SHA256) or{" "}
              <code>15</code> (ED25519).
            </li>
            <li>
              Keep protocol at <code>3</code>. Flags are usually <code>257</code> (KSK)
              or <code>256</code> (ZSK).
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

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
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
