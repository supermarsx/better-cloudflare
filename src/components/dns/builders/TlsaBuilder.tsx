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
import { composeTLSA, parseTLSA } from "@/lib/dns/dns-parsers";

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

const TLSA_USAGES = [
  {
    value: "0",
    label: "0 (PKIX-TA)",
    desc: "CA constraint; verified via PKIX + DANE-TA.",
  },
  {
    value: "1",
    label: "1 (PKIX-EE)",
    desc: "Service cert constraint; verified via PKIX.",
  },
  {
    value: "2",
    label: "2 (DANE-TA)",
    desc: "Trust anchor constraint; verified via DNSSEC (no PKIX required).",
  },
  {
    value: "3",
    label: "3 (DANE-EE)",
    desc: "Service cert constraint; verified via DNSSEC (no PKIX required).",
  },
] as const;

const TLSA_SELECTORS = [
  { value: "0", label: "0 (Cert)", desc: "Match the full certificate." },
  { value: "1", label: "1 (SPKI)", desc: "Match the SubjectPublicKeyInfo." },
] as const;

const TLSA_MATCHING = [
  {
    value: "0",
    label: "0 (Full)",
    desc: "No hash; data is the selected bytes (hex).",
  },
  { value: "1", label: "1 (SHA-256)", desc: "32 bytes → 64 hex chars." },
  { value: "2", label: "2 (SHA-512)", desc: "64 bytes → 128 hex chars." },
] as const;

function isHex(value: string) {
  return /^[0-9a-fA-F]+$/.test(value);
}

export type TlsaFields = {
  usage: number | undefined;
  selector: number | undefined;
  matchingType: number | undefined;
  data: string;
  /** The record's owner name, conventionally `_port._proto.host`. */
  name?: string;
};

/**
 * What a validating client is asked to do, per RFC 6698 §2.1.1 and the usage
 * refinements in RFC 7671 §4.
 */
const TLSA_USAGE_ACTIONS: Record<number, string> = {
  0: "require the presented certificate to chain to the certificate authority identified by this record, on top of the normal public-CA (PKIX) validation the client already performs",
  1: "require the server to present exactly the certificate identified by this record, on top of the normal public-CA (PKIX) validation the client already performs",
  2: "trust the certificate authority identified by this record as a trust anchor for this service, accepting its certificates with no public CA involved",
  3: "accept the certificate identified by this record directly, without public-CA (PKIX) validation",
};

const TLSA_SELECTOR_PHRASES: Record<number, string> = {
  0: "the whole certificate",
  1: "the certificate's SubjectPublicKeyInfo, which is its public key",
};

const TLSA_MATCHING_PHRASES: Record<number, string> = {
  0: "the exact bytes, with no hashing",
  1: "a SHA-256 hash",
  2: "a SHA-512 hash",
};

/** Turn a `_port._proto.host` owner name into the service it designates. */
function describeTlsaTarget(name: string | undefined) {
  const raw = (name ?? "").trim().replace(/\.$/, "");
  if (!raw) return "this service";
  const match = /^_(\d{1,5})\._(tcp|udp|sctp)(?:\.(.+))?$/i.exec(raw);
  if (!match) return `the service at ${raw}`;
  const port = match[1] ?? "";
  const proto = (match[2] ?? "").toUpperCase();
  const host = match[3];
  return host
    ? `${host} on ${proto} port ${port}`
    : `this zone on ${proto} port ${port}`;
}

/**
 * Plain-English description of the DANE association the builder is assembling.
 *
 * The two `unknowns` are always present because they are the two ways a
 * syntactically perfect TLSA record still fails in production: an unsigned zone
 * makes it inert, and a stale association breaks TLS outright.
 */
export function describeTLSA(fields: TlsaFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const target = describeTlsaTarget(fields.name);
  const action =
    fields.usage !== undefined ? TLSA_USAGE_ACTIONS[fields.usage] : undefined;

  const headline = action
    ? `Tells DANE-aware clients connecting to ${target} to ${action}.`
    : `Builds a DANE record naming the certificate ${target} is allowed to present; choose a usage to say how strictly clients should enforce it.`;

  if (fields.usage !== undefined && !action) {
    unknowns.push(
      `Usage ${fields.usage} is not one of the values defined by RFC 6698 (0–3), so what a client will do with this record cannot be determined here.`,
    );
  }

  const selectorPhrase =
    fields.selector !== undefined
      ? TLSA_SELECTOR_PHRASES[fields.selector]
      : undefined;
  const matchingPhrase =
    fields.matchingType !== undefined
      ? TLSA_MATCHING_PHRASES[fields.matchingType]
      : undefined;

  if (selectorPhrase && matchingPhrase) {
    details.push(
      `The certificate is identified by ${selectorPhrase}, compared as ${matchingPhrase}.`,
    );
  }
  if (fields.selector === 1) {
    details.push(
      "Because only the public key is matched, the record stays correct when the certificate is renewed with the same key.",
    );
  } else if (fields.selector === 0) {
    details.push(
      "Because the whole certificate is matched, the record must be replaced every time the certificate is renewed.",
    );
  } else if (fields.selector !== undefined && !selectorPhrase) {
    unknowns.push(
      `Selector ${fields.selector} is not defined by RFC 6698 (0 or 1), so which part of the certificate is matched cannot be determined here.`,
    );
  }

  if (fields.matchingType === 0) {
    details.push(
      "No hash is used, so the data must be the full selected bytes in hex, which makes the record large.",
    );
  } else if (fields.matchingType !== undefined && !matchingPhrase) {
    unknowns.push(
      `Matching type ${fields.matchingType} is not defined by RFC 6698 (0–2), so how the data is compared cannot be determined here.`,
    );
  }

  if (fields.usage === 3) {
    details.push(
      "Most implementations skip expiry and hostname checks for usage 3, so this record alone decides which certificate is accepted.",
    );
  } else if (fields.usage === 0 || fields.usage === 1) {
    details.push(
      "Public-CA validation still applies, so a certificate that fails normal chain validation is rejected even when it matches this record.",
    );
  } else if (fields.usage === 2) {
    details.push(
      "The named authority is trusted only for this service, and the server must still send the chain up to it.",
    );
  }

  if (!fields.data.trim()) {
    details.push(
      "No association data is entered yet, so the record does not identify a certificate.",
    );
  }

  unknowns.push(
    "TLSA is only honoured by clients that validate DNSSEC; in an unsigned zone the record is ignored entirely.",
  );
  unknowns.push(
    "Whether this association matches the certificate the service actually presents cannot be checked from this form, and a mismatch silently breaks TLS for validating clients.",
  );

  return { headline, details, unknowns };
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
  const [matchingType, setMatchingType] = useState<number | undefined>(
    undefined,
  );
  const [data, setData] = useState<string>("");

  const [usageMode, setUsageMode] = useState<"preset" | "custom">("preset");
  const [selectorMode, setSelectorMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [matchingMode, setMatchingMode] = useState<"preset" | "custom">(
    "preset",
  );

  const { fieldIds, helpIds } = useBuilderFieldIds([
    "usage",
    "usageCustom",
    "selector",
    "selectorCustom",
    "matchingType",
    "matchingTypeCustom",
    "data",
  ] as const);

  const summary = useMemo(
    () =>
      describeTLSA({
        usage,
        selector,
        matchingType,
        data,
        name: record.name,
      }),
    [data, matchingType, record.name, selector, usage],
  );

  const usageSelectValue = useMemo(() => {
    if (usageMode === "custom") return "custom";
    if (usage === undefined) return "";
    return ["0", "1", "2", "3"].includes(String(usage))
      ? String(usage)
      : "custom";
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
      parsed.usage !== undefined &&
        ["0", "1", "2", "3"].includes(String(parsed.usage))
        ? "preset"
        : "custom",
    );
    setSelectorMode(
      parsed.selector !== undefined &&
        ["0", "1"].includes(String(parsed.selector))
        ? "preset"
        : "custom",
    );
    setMatchingMode(
      parsed.matchingType !== undefined &&
        ["0", "1", "2"].includes(String(parsed.matchingType))
        ? "preset"
        : "custom",
    );
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "TLSA") {
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

    const u = usage;
    const s = selector;
    const m = matchingType;
    const dRaw = data ?? "";
    const dTrim = dRaw.trim();
    const dNoSpaces = dTrim.replace(/\s+/g, "");

    if (u === undefined) push(issues, "TLSA: usage is required (usually 0–3).");
    else if (![0, 1, 2, 3].includes(Number(u)))
      push(issues, "TLSA: usage is usually 0–3.");

    if (s === undefined)
      push(issues, "TLSA: selector is required (usually 0–1).");
    else if (![0, 1].includes(Number(s)))
      push(issues, "TLSA: selector is usually 0–1.");

    if (m === undefined)
      push(issues, "TLSA: matching type is required (usually 0–2).");
    else if (![0, 1, 2].includes(Number(m)))
      push(issues, "TLSA: matching type is usually 0–2.");

    if (!dTrim) push(issues, "TLSA: data is required.");
    if (dTrim && /\s/.test(dTrim))
      push(
        issues,
        "TLSA: data contains whitespace (usually written as a single hex string).",
      );

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
      push(
        issues,
        "TLSA: content differs from builder settings (Apply canonical to normalize).",
      );
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(nameIssues, "TLSA: name is often _port._proto (e.g., _443._tcp).");

    return { canonical, issues, nameIssues };
  }, [
    data,
    matchingType,
    record.content,
    record.name,
    record.type,
    selector,
    usage,
  ]);

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

        <RecordSummary summary={summary} className="mt-2" />

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.usage}
              descriptionId={helpIds.usage}
              label="Usage"
              help="How strictly clients enforce this association: 0 (PKIX-TA) and 1 (PKIX-EE) add a constraint on top of normal public-CA validation, while 2 (DANE-TA) and 3 (DANE-EE) replace it with DNSSEC-based trust. 3 is the usual choice for mail servers."
            />
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
                  content: composeTLSA(
                    val,
                    selector,
                    matchingType,
                    data.trim().replace(/\s+/g, ""),
                  ),
                });
              }}
            >
              <SelectTrigger
                id={fieldIds.usage}
                aria-describedby={helpIds.usage}
                className="h-9"
              >
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
              <>
                <BuilderFieldLabel
                  controlId={fieldIds.usageCustom}
                  descriptionId={helpIds.usageCustom}
                  label="Custom usage value"
                  help="A usage number outside 0–3. RFC 6698 defines only 0–3, and clients ignore associations whose usage they do not recognise."
                />
                <Input
                  id={fieldIds.usageCustom}
                  aria-describedby={helpIds.usageCustom}
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
                      content: composeTLSA(
                        val,
                        selector,
                        matchingType,
                        data.trim().replace(/\s+/g, ""),
                      ),
                    });
                  }}
                />
              </>
            )}
            <div className="text-[11px] text-muted-foreground">
              {TLSA_USAGES.find((u) => Number(u.value) === usage)?.desc ??
                "Common: 3 (DANE-EE) for pinning via DNSSEC."}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.selector}
              descriptionId={helpIds.selector}
              label="Selector"
              help="Which part of the certificate the association covers: 0 matches the full certificate, 1 matches only its SubjectPublicKeyInfo. 1 is usually preferred because the record survives a certificate renewal that reuses the same key."
            />
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
                  content: composeTLSA(
                    usage,
                    val,
                    matchingType,
                    data.trim().replace(/\s+/g, ""),
                  ),
                });
              }}
            >
              <SelectTrigger
                id={fieldIds.selector}
                aria-describedby={helpIds.selector}
                className="h-9"
              >
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
              <>
                <BuilderFieldLabel
                  controlId={fieldIds.selectorCustom}
                  descriptionId={helpIds.selectorCustom}
                  label="Custom selector value"
                  help="A selector number outside 0–1. RFC 6698 defines only 0 (full certificate) and 1 (SubjectPublicKeyInfo); clients ignore selectors they do not recognise."
                />
                <Input
                  id={fieldIds.selectorCustom}
                  aria-describedby={helpIds.selectorCustom}
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
                      content: composeTLSA(
                        usage,
                        val,
                        matchingType,
                        data.trim().replace(/\s+/g, ""),
                      ),
                    });
                  }}
                />
              </>
            )}
            <div className="text-[11px] text-muted-foreground">
              {TLSA_SELECTORS.find((s) => Number(s.value) === selector)?.desc ??
                "Most use 1 (SPKI)."}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.matchingType}
              descriptionId={helpIds.matchingType}
              label="Matching type"
              help="How the selected certificate data is compared: 0 stores the exact bytes, 1 stores a SHA-256 hash, 2 stores a SHA-512 hash. 1 is the standard choice and keeps the record small."
            />
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
                  content: composeTLSA(
                    usage,
                    selector,
                    val,
                    data.trim().replace(/\s+/g, ""),
                  ),
                });
              }}
            >
              <SelectTrigger
                id={fieldIds.matchingType}
                aria-describedby={helpIds.matchingType}
                className="h-9"
              >
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
              <>
                <BuilderFieldLabel
                  controlId={fieldIds.matchingTypeCustom}
                  descriptionId={helpIds.matchingTypeCustom}
                  label="Custom matching type value"
                  help="A matching type outside 0–2. RFC 6698 defines only 0 (exact data), 1 (SHA-256) and 2 (SHA-512); clients ignore matching types they do not recognise."
                />
                <Input
                  id={fieldIds.matchingTypeCustom}
                  aria-describedby={helpIds.matchingTypeCustom}
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
                      content: composeTLSA(
                        usage,
                        selector,
                        val,
                        data.trim().replace(/\s+/g, ""),
                      ),
                    });
                  }}
                />
              </>
            )}
            <div className="text-[11px] text-muted-foreground">
              {TLSA_MATCHING.find((m) => Number(m.value) === matchingType)
                ?.desc ?? "Common: 1 (SHA-256)."}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-6">
            <BuilderFieldLabel
              controlId={fieldIds.data}
              descriptionId={helpIds.data}
              label="Data"
              help="The certificate association itself, written as hex. With matching type 1 that is 64 hex characters (SHA-256) and with type 2 it is 128 (SHA-512); with type 0 it is the full DER bytes of the selected data."
            />
            <Input
              id={fieldIds.data}
              aria-describedby={helpIds.data}
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
              Many deployments use <code>3 1 1</code> (DANE-EE, SPKI, SHA-256).
            </li>
            <li>
              Ensure the record name matches the service port/proto (e.g.,
              _443._tcp).
            </li>
            <li>TLSA is most meaningful with DNSSEC validation.</li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 ||
          diagnostics.issues.length > 0) && (
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
