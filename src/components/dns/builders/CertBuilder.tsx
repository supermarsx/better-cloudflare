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

/** Certificate type values and their meanings, from the RFC 4398 §2.1 table. */
const CERT_TYPE_PRESETS = [
  { value: "1", label: "1 (PKIX)", desc: "X.509 certificate as per PKIX." },
  { value: "2", label: "2 (SPKI)", desc: "SPKI certificate." },
  { value: "3", label: "3 (PGP)", desc: "OpenPGP packet." },
  { value: "4", label: "4 (IPKIX)", desc: "URL of an X.509 data object." },
  { value: "5", label: "5 (ISPKI)", desc: "URL of an SPKI certificate." },
  {
    value: "6",
    label: "6 (IPGP)",
    desc: "Fingerprint and URL of an OpenPGP packet.",
  },
  { value: "7", label: "7 (ACPKIX)", desc: "X.509 attribute certificate." },
  {
    value: "8",
    label: "8 (IACPKIX)",
    desc: "URL of an X.509 attribute certificate.",
  },
  { value: "253", label: "253 (URI)", desc: "Private format named by a URI." },
  { value: "254", label: "254 (OID)", desc: "Private format named by an OID." },
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
  const raw = (value ?? "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
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

/** Decoded size of a base64 string, used only for rough "how big is this" prose. */
function approximateDecodedBytes(base64: string) {
  const padding = /=*$/.exec(base64)?.[0].length ?? 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export type CertFields = {
  certType: number | undefined;
  keyTag: number | undefined;
  algorithm: number | undefined;
  cert: string;
};

/**
 * What the RDATA payload holds for each RFC 4398 §2.1 certificate type.
 *
 * The "I" types are indirect: the payload is the URL of the object, not the
 * object, so the headline has to be keyed off this rather than off the label.
 */
const CERT_TYPE_HEADLINES: Record<number, string> = {
  1: "Publishes an X.509 certificate in DNS under this name, for applications that know to look it up here.",
  2: "Publishes an SPKI certificate in DNS under this name, for applications that know to look it up here.",
  3: "Publishes an OpenPGP packet in DNS under this name, for applications that know to look it up here.",
  4: "Publishes the URL where an X.509 data object can be fetched, rather than the certificate itself: the record data is that URL, not certificate material.",
  5: "Publishes the URL where an SPKI certificate can be fetched, rather than the certificate itself: the record data is that URL, not certificate material.",
  6: "Publishes the fingerprint of an OpenPGP packet together with the URL where it can be fetched, rather than the key itself.",
  7: "Publishes an X.509 attribute certificate in DNS under this name, for applications that know to look it up here.",
  8: "Publishes the URL where an X.509 attribute certificate can be fetched, rather than the certificate itself: the record data is that URL, not certificate material.",
  253: "Publishes a certificate in a private format, named by a URI at the start of the record data.",
  254: "Publishes a certificate in a private format, named by an ISO OID at the start of the record data.",
};

/** Types whose payload is a URL pointing at the object rather than the object. */
const CERT_INDIRECT_TYPES = new Set([4, 5, 6, 8]);
/** Types whose payload starts with a private-format identifier. */
const CERT_PRIVATE_TYPES = new Set([253, 254]);

/**
 * Plain-English description of the CERT record the builder is assembling.
 *
 * Per RFC 4398 §2.2–2.3 the key tag is an efficiency hint computed the RFC 4034
 * way (0 when no key tag applies) and the algorithm is a DNSSEC algorithm
 * number (0 when the key is not one DNSSEC can describe, in which case the key
 * tag is meaningless and should also be zero).
 */
export function describeCERT(fields: CertFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const cert = (fields.cert ?? "").trim().replace(/\s+/g, "");
  const typeHeadline =
    fields.certType === undefined
      ? undefined
      : CERT_TYPE_HEADLINES[fields.certType];

  let headline: string;
  if (typeHeadline) {
    headline = typeHeadline;
  } else if (fields.certType === undefined) {
    headline =
      "Publishes a certificate, or a pointer to one, in DNS under this name for applications that know to look it up here.";
  } else {
    headline = `Publishes certificate type ${fields.certType} data in DNS under this name.`;
  }

  if (fields.keyTag === 0) {
    details.push(
      "The key tag is 0, so no particular key is identified and a client has to read the certificate itself to decide whether this is the one it wants.",
    );
  } else if (fields.keyTag !== undefined) {
    details.push(
      `The key tag is ${fields.keyTag}, which lets a client narrow down which certificate to fetch without parsing every one; key tags are not unique, so it narrows the search rather than settling it.`,
    );
  }

  if (fields.algorithm === 0) {
    details.push(
      "The algorithm is 0, meaning no DNSSEC algorithm applies to the key in this certificate; the key tag is then meaningless and should also be 0.",
    );
    if (fields.keyTag !== undefined && fields.keyTag !== 0) {
      details.push(
        "Algorithm 0 with a non-zero key tag is inconsistent: RFC 4398 says the key tag should be zero when the algorithm is zero.",
      );
    }
  } else if (fields.algorithm !== undefined) {
    const label = CERT_ALG_PRESETS.find(
      (p) => Number(p.value) === fields.algorithm,
    )?.label;
    details.push(
      `The algorithm is ${label ?? fields.algorithm}, the DNSSEC algorithm number of the key in this certificate.`,
    );
  }

  if (!cert) {
    details.push(
      "No certificate data has been entered yet, so the record is incomplete.",
    );
  } else {
    const bytes = approximateDecodedBytes(cert);
    if (bytes > 1000) {
      details.push(
        `The data decodes to roughly ${bytes} bytes, which is larger than a typical UDP DNS answer, so resolvers may need EDNS or a TCP retry to fetch it.`,
      );
    }
  }

  details.push(
    "CERT is rarely deployed: nothing looks it up on its own, so an application has to be configured to fetch certificates from DNS for this record to have any effect.",
  );

  if (fields.certType !== undefined && !typeHeadline) {
    unknowns.push(
      `Certificate type ${fields.certType} is not one of the types defined in RFC 4398, so how a client would interpret the record data cannot be determined here.`,
    );
  }
  if (
    fields.certType !== undefined &&
    CERT_INDIRECT_TYPES.has(fields.certType)
  ) {
    unknowns.push(
      "The URL in the record data is opaque in this form, so whether it points at a usable certificate cannot be checked from here.",
    );
  }
  if (
    fields.certType !== undefined &&
    CERT_PRIVATE_TYPES.has(fields.certType)
  ) {
    unknowns.push(
      "The private format named at the start of the data determines how the rest of it is read, and that cannot be determined here.",
    );
  }
  unknowns.push(
    "Whether anything in this environment looks up CERT records for this name cannot be determined here.",
  );

  return { headline, details, unknowns };
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
  const { fieldIds, helpIds } = useBuilderFieldIds([
    "certType",
    "certTypeCustom",
    "keyTag",
    "algorithm",
    "algorithmCustom",
    "cert",
  ] as const);

  const summary = useMemo(
    () => describeCERT({ certType, keyTag, algorithm, cert }),
    [algorithm, cert, certType, keyTag],
  );

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
        CERT_TYPE_PRESETS.some(
          (p) => Number(p.value) === Number(parsed.certType),
        )
        ? "preset"
        : "custom",
    );
    setAlgMode(
      parsed.algorithm !== undefined &&
        CERT_ALG_PRESETS.some(
          (p) => Number(p.value) === Number(parsed.algorithm),
        )
        ? "preset"
        : "custom",
    );
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "CERT") {
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
      push(
        issues,
        "CERT: certificate data contains whitespace (usually base64 without spaces).",
      );
    if (certNoWs) {
      if (!isBase64Like(certNoWs))
        push(issues, "CERT: certificate data does not look like base64.");
      if (isBase64Like(certNoWs) && certNoWs.length % 4 !== 0)
        push(
          issues,
          "CERT: base64 length is not a multiple of 4 (may still work, but is unusual).",
        );
      if (certNoWs.length > 20000)
        push(
          issues,
          "CERT: certificate data is very large for a single DNS record.",
        );
    }

    const canonical = composeCert(certType, keyTag, algorithm, certNoWs);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(
        issues,
        "CERT: content differs from builder settings (Apply canonical to normalize).",
      );
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        "CERT: name is typically a host label (e.g., host or @).",
      );

    return { canonical, issues, nameIssues };
  }, [
    algorithm,
    cert,
    certType,
    keyTag,
    record.content,
    record.name,
    record.type,
  ]);

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

        <RecordSummary summary={summary} className="mt-2" />

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.certType}
              descriptionId={helpIds.certType}
              label="Type"
              help="What the record data holds, from the RFC 4398 list. Types 1, 2, 3 and 7 carry the certificate itself; the indirect types 4, 5, 6 and 8 carry a URL pointing at it instead. 1 (PKIX) is the usual choice for an X.509 certificate."
            />
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
              <SelectTrigger
                id={fieldIds.certType}
                aria-describedby={helpIds.certType}
                className="h-9"
              >
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
              <div className="space-y-1 pt-2">
                <BuilderFieldLabel
                  controlId={fieldIds.certTypeCustom}
                  descriptionId={helpIds.certTypeCustom}
                  label="Custom type"
                  help="A numeric certificate type from 0 to 65535 for a value outside the list. Only the values in the RFC 4398 registry have a defined meaning."
                />
                <Input
                  id={fieldIds.certTypeCustom}
                  aria-describedby={helpIds.certTypeCustom}
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
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              {CERT_TYPE_PRESETS.find((p) => Number(p.value) === certType)
                ?.desc ?? "Certificate type as per RFC 4398."}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.keyTag}
              descriptionId={helpIds.keyTag}
              label="Key tag"
              help="The RFC 4034 key tag of the key in the certificate, from 0 to 65535, used to narrow down which certificate to fetch. Use 0 when no key tag applies, which is the safe default."
            />
            <Input
              id={fieldIds.keyTag}
              aria-describedby={helpIds.keyTag}
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
            <BuilderFieldLabel
              controlId={fieldIds.algorithm}
              descriptionId={helpIds.algorithm}
              label="Algorithm"
              help="The DNSSEC algorithm number of the key in the certificate, from 0 to 255. Use 0 when no DNSSEC algorithm applies to the key, in which case the key tag should be 0 as well."
            />
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
              <SelectTrigger
                id={fieldIds.algorithm}
                aria-describedby={helpIds.algorithm}
                className="h-9"
              >
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
              <div className="space-y-1 pt-2">
                <BuilderFieldLabel
                  controlId={fieldIds.algorithmCustom}
                  descriptionId={helpIds.algorithmCustom}
                  label="Custom algorithm"
                  help="A DNSSEC algorithm number from 0 to 255 for a value outside the list. Use 0 when no DNSSEC algorithm applies to the key."
                />
                <Input
                  id={fieldIds.algorithmCustom}
                  aria-describedby={helpIds.algorithmCustom}
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
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              DNSSEC algorithm number; most use modern values like 13/15.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-6">
            <BuilderFieldLabel
              controlId={fieldIds.cert}
              descriptionId={helpIds.cert}
              label="Certificate (base64)"
              help="The payload for the selected type, base64-encoded. For types 1, 2, 3 and 7 this is the certificate or key itself; for the indirect types 4, 5, 6 and 8 it is the URL of the object instead; for 253 and 254 it begins with the URI or OID naming the private format."
            />
            <Input
              id={fieldIds.cert}
              aria-describedby={helpIds.cert}
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
            <li>
              CERT is uncommon; consider modern alternatives where possible.
            </li>
            <li>Keep base64 compact; large RDATA may hit provider limits.</li>
            <li>Ensure the algorithm/type match what your client expects.</li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 ||
          diagnostics.issues.length > 0) && (
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
