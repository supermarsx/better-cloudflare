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
import { unquoteCharacterString } from "@/lib/dns/character-string";
import { KNOWN_TLDS } from "@/lib/dns/tlds";

import {
  BuilderFieldLabel,
  RecordSummary,
  useBuilderFieldIds,
} from "./BuilderField";
import {
  describeReportUris,
  humanizeSeconds,
  joinList,
} from "./describe-utils";
import type {
  BuilderSummary,
  BuilderWarningsChange,
  RecordDraft,
} from "./types";

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.$/, "");
}

type DmarcPolicy = "none" | "quarantine" | "reject";
type DmarcAlignment = "r" | "s";

function isDmarcPolicy(value: string): value is DmarcPolicy {
  return value === "none" || value === "quarantine" || value === "reject";
}

function isDmarcAlignment(value: string): value is DmarcAlignment {
  return value === "r" || value === "s";
}

function uniquePush(list: string[], msg: string) {
  if (!list.includes(msg)) list.push(msg);
}

export type DmarcFields = {
  policy: DmarcPolicy;
  subdomainPolicy: "" | DmarcPolicy;
  adkim: DmarcAlignment;
  aspf: DmarcAlignment;
  pct: number | undefined;
  rua: string;
  ruf: string;
  fo: string;
  rf: string;
  ri: number | undefined;
};

/** Human phrase for the delivery action a DMARC policy asks receivers to take. */
function dmarcActionVerb(policy: DmarcPolicy) {
  if (policy === "reject") return "reject";
  if (policy === "quarantine") return "quarantine";
  return "deliver";
}

/**
 * RFC 7489 §6.6.4: when `pct` is below 100 the remaining failing messages are
 * handled with the next lower action, not left untouched.
 */
function dmarcFallbackAction(policy: DmarcPolicy) {
  if (policy === "reject") return "quarantined";
  if (policy === "quarantine") return "delivered normally";
  return "delivered normally";
}

function describeDmarcPortion(pct: number | undefined) {
  if (pct === undefined || pct === 100) return "all";
  if (pct === 50) return "half of";
  if (pct === 0) return "none of";
  return `${pct}% of`;
}

function describeAlignment(mode: DmarcAlignment, kind: "DKIM" | "SPF") {
  const domain =
    kind === "DKIM"
      ? "the DKIM signing domain"
      : "the SPF-authenticated domain";
  return mode === "s"
    ? `${kind} alignment is strict: ${domain} must match the From: domain exactly.`
    : `${kind} alignment is relaxed: ${domain} may be any subdomain sharing the same organizational domain.`;
}

const DMARC_FO_MEANINGS: Record<string, string> = {
  "0": "report when every authentication method fails",
  "1": "report when any authentication method fails to produce an aligned pass",
  d: "report when a DKIM signature fails to verify",
  s: "report when SPF fails",
};

function reportDomainsOf(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.toLowerCase().startsWith("mailto:"))
    .map((part) => part.slice("mailto:".length).split("?")[0] ?? "")
    .map((address) => address.split("@")[1] ?? "")
    .map((domain) => normalizeDnsName(domain).toLowerCase())
    .filter(Boolean);
}

/**
 * Plain-English description of the DMARC policy the builder is assembling.
 *
 * `publishedDomain` is the domain the record will live under (without the
 * `_dmarc` label); it is used only to spot report addresses that live on a
 * different domain, which need that domain's permission to receive them.
 */
export function describeDMARC(
  fields: DmarcFields,
  publishedDomain?: string,
): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const portion = describeDmarcPortion(fields.pct);
  const rua = fields.rua.trim();
  const ruf = fields.ruf.trim();
  const reportClause = rua
    ? `, and to send aggregate reports to ${describeReportUris(rua)}`
    : "";

  let headline: string;
  if (fields.policy === "none") {
    headline = `Tells receiving mail servers to make no delivery change for messages claiming to be from this domain that fail authentication — monitoring only${reportClause}.`;
  } else {
    headline = `Tells receiving mail servers to ${dmarcActionVerb(
      fields.policy,
    )} ${portion} the messages claiming to be from this domain that fail authentication${reportClause}.`;
  }

  if (
    fields.policy !== "none" &&
    fields.pct !== undefined &&
    fields.pct < 100
  ) {
    details.push(
      `The remaining failing messages are ${dmarcFallbackAction(fields.policy)} instead, so this is a partial rollout.`,
    );
  }

  if (fields.subdomainPolicy) {
    const sub = fields.subdomainPolicy;
    details.push(
      sub === "none"
        ? "Subdomains are exempt: failing mail from them is delivered normally."
        : `Subdomains use their own policy: failing mail from them is ${sub === "reject" ? "rejected" : "quarantined"}.`,
    );
  } else {
    details.push(
      "Subdomains inherit this same policy, because sp= is omitted.",
    );
  }

  details.push(describeAlignment(fields.adkim, "DKIM"));
  details.push(describeAlignment(fields.aspf, "SPF"));

  if (!rua) {
    details.push(
      "No aggregate report address is set, so you will not see who is sending as this domain or whether the policy is safe to tighten.",
    );
  }

  if (ruf) {
    const foParts = fields.fo
      .split(":")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    const known = foParts
      .map((part) => DMARC_FO_MEANINGS[part])
      .filter((text): text is string => Boolean(text));
    const foClause = known.length
      ? ` Receivers are asked to ${joinList(known)}.`
      : "";
    details.push(
      `Per-message failure reports go to ${describeReportUris(ruf)}.${foClause} These reports can contain message content, and most receivers do not send them.`,
    );
  } else if (fields.fo.trim()) {
    details.push(
      "fo= only affects failure reports, and no ruf= address is set, so it has no effect.",
    );
  }

  if (fields.rf.trim()) {
    details.push(
      `Failure reports are requested in ${fields.rf.trim().toUpperCase()} format.`,
    );
  }

  if (fields.ri !== undefined) {
    details.push(
      `Aggregate reports are requested every ${humanizeSeconds(fields.ri)}; receivers commonly send them daily regardless.`,
    );
  }

  const owner = normalizeDnsName(publishedDomain ?? "").toLowerCase();
  const externalDomains = Array.from(
    new Set(
      [...reportDomainsOf(rua), ...reportDomainsOf(ruf)].filter(
        (domain) =>
          !owner || (domain !== owner && !domain.endsWith(`.${owner}`)),
      ),
    ),
  );
  if (externalDomains.length) {
    unknowns.push(
      `Reports sent to ${joinList(externalDomains)} only arrive if that domain publishes a DMARC authorization record; that cannot be checked from here.`,
    );
  }

  return { headline, details, unknowns };
}

/**
 * Validate DMARC TXT content. Quoted and multi-string content is accepted and
 * validated as its concatenated logical value.
 */
export function validateDMARC(value: string) {
  const problems: string[] = [];
  const content = unquoteCharacterString(value).trim();
  if (!content) return { ok: true, problems };
  if (!/^v=DMARC1\b/i.test(content)) {
    problems.push("Missing v=DMARC1.");
    return { ok: false, problems };
  }
  const isValidDnsLabel = (label: string) => {
    if (!label) return false;
    if (label.length > 63) return false;
    if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    return true;
  };
  const validateEmailAddress = (address: string, label: "rua" | "ruf") => {
    const a = address.trim();
    if (!a) {
      problems.push(`${label}= mailto: is missing an email address.`);
      return;
    }
    if (/\s/.test(a)) {
      problems.push(`${label}= email address contains whitespace: ${a}`);
      return;
    }
    const at = a.indexOf("@");
    if (at <= 0 || at !== a.lastIndexOf("@") || at === a.length - 1) {
      problems.push(
        `${label}= invalid email address (expected local@domain): ${a}`,
      );
      return;
    }
    const local = a.slice(0, at);
    const domainRaw = a.slice(at + 1);
    if (local.length > 64)
      problems.push(`${label}= local-part is >64 chars: ${a}`);
    if (local.startsWith(".") || local.endsWith(".") || local.includes(".."))
      problems.push(`${label}= local-part has invalid dots: ${a}`);
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local))
      problems.push(`${label}= local-part has unusual characters: ${a}`);

    const domain = normalizeDnsName(domainRaw);
    if (!domain || domain.length > 253) {
      problems.push(`${label}= email domain is invalid: ${a}`);
      return;
    }
    if (domain.includes("..")) {
      problems.push(`${label}= email domain has empty labels: ${a}`);
      return;
    }
    const labels = domain.split(".");
    if (labels.some((l) => !isValidDnsLabel(l))) {
      problems.push(
        `${label}= email domain does not look like a hostname: ${a}`,
      );
      return;
    }
    if (labels.length < 2) {
      problems.push(`${label}= email domain should be a FQDN: ${a}`);
      return;
    }
    const tld = labels[labels.length - 1]?.toLowerCase() ?? "";
    if (tld && !KNOWN_TLDS.has(tld)) {
      problems.push(
        `${label}= email domain uses an unknown/invalid TLD “.${tld}”: ${a}`,
      );
    }
  };

  const tags = content
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const map = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const tag of tags) {
    const [kRaw, ...rest] = tag.split("=");
    const k = (kRaw ?? "").trim().toLowerCase();
    if (!k) continue;
    const v = rest.join("=").trim();
    seen.set(k, (seen.get(k) ?? 0) + 1);
    map.set(k, v);
  }
  for (const [k, count] of seen) {
    if (count > 1) problems.push(`Duplicate DMARC tag: ${k}=`);
  }
  const allowedTags = new Set([
    "v",
    "p",
    "sp",
    "adkim",
    "aspf",
    "pct",
    "rua",
    "ruf",
    "fo",
    "rf",
    "ri",
  ]);
  for (const k of map.keys()) {
    if (!allowedTags.has(k)) problems.push(`Unknown DMARC tag: ${k}=`);
  }
  const p = map.get("p");
  if (!p) problems.push("Missing p= (policy).");
  else if (!["none", "quarantine", "reject"].includes(p.toLowerCase()))
    problems.push("p= should be none, quarantine, or reject.");
  const sp = map.get("sp");
  if (sp && !["none", "quarantine", "reject"].includes(sp.toLowerCase()))
    problems.push("sp= should be none, quarantine, or reject.");
  const adkim = map.get("adkim");
  if (adkim && !["r", "s"].includes(adkim.toLowerCase()))
    problems.push("adkim= should be r or s.");
  const aspf = map.get("aspf");
  if (aspf && !["r", "s"].includes(aspf.toLowerCase()))
    problems.push("aspf= should be r or s.");
  const pct = map.get("pct");
  if (pct) {
    const n = Number.parseInt(pct, 10);
    if (Number.isNaN(n) || n < 0 || n > 100)
      problems.push("pct= should be 0–100.");
  }
  const rua = map.get("rua");
  if (rua) {
    const parts = rua
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      if (!part.toLowerCase().startsWith("mailto:"))
        problems.push(`rua= should use mailto: (got ${part}).`);
      else validateEmailAddress(part.slice("mailto:".length), "rua");
    }
  }
  const ruf = map.get("ruf");
  if (ruf) {
    const parts = ruf
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      if (!part.toLowerCase().startsWith("mailto:"))
        problems.push(`ruf= should use mailto: (got ${part}).`);
      else validateEmailAddress(part.slice("mailto:".length), "ruf");
    }
  }
  const fo = map.get("fo");
  if (fo) {
    const allowed = new Set(["0", "1", "d", "s"]);
    const parts = fo
      .split(":")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    for (const p of parts)
      if (!allowed.has(p)) problems.push(`Unknown fo= value: ${p}`);
  }
  const rf = map.get("rf");
  if (rf) {
    const allowed = new Set(["afrf", "iodef"]);
    const parts = rf
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    for (const p of parts)
      if (!allowed.has(p)) problems.push(`Unknown rf= value: ${p}`);
  }
  const ri = map.get("ri");
  if (ri) {
    const n = Number.parseInt(ri, 10);
    if (Number.isNaN(n) || n < 60)
      problems.push("ri= should be a number of seconds (>= 60).");
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Parse DMARC TXT content into builder fields. Quoted and multi-string content
 * is unwrapped before the tags are read.
 */
export function parseDMARC(value: string | undefined) {
  const content = unquoteCharacterString(value).trim();
  if (!content.toLowerCase().startsWith("v=dmarc1")) {
    return {
      policy: "none" as const,
      subdomainPolicy: "" as "" | "none" | "quarantine" | "reject",
      adkim: "r" as const,
      aspf: "r" as const,
      pct: undefined as number | undefined,
      rua: "",
      ruf: "",
      fo: "",
      rf: "",
      ri: undefined as number | undefined,
    };
  }
  const tags = content
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const map = new Map<string, string>();
  for (const tag of tags) {
    const [kRaw, ...rest] = tag.split("=");
    const k = (kRaw ?? "").trim().toLowerCase();
    if (!k) continue;
    const v = rest.join("=").trim();
    map.set(k, v);
  }
  const policyRaw = (map.get("p") ?? "none").toLowerCase();
  const policy = (
    ["none", "quarantine", "reject"].includes(policyRaw) ? policyRaw : "none"
  ) as "none" | "quarantine" | "reject";
  const spRaw = (map.get("sp") ?? "").toLowerCase();
  const subdomainPolicy = (
    ["none", "quarantine", "reject"].includes(spRaw) ? spRaw : ""
  ) as "" | "none" | "quarantine" | "reject";
  const adkimRaw = (map.get("adkim") ?? "r").toLowerCase();
  const adkim = (adkimRaw === "s" ? "s" : "r") as "r" | "s";
  const aspfRaw = (map.get("aspf") ?? "r").toLowerCase();
  const aspf = (aspfRaw === "s" ? "s" : "r") as "r" | "s";
  const pctRaw = map.get("pct");
  const pct =
    pctRaw !== undefined
      ? (() => {
          const n = Number.parseInt(pctRaw, 10);
          return Number.isNaN(n) ? undefined : n;
        })()
      : undefined;
  const rua = map.get("rua") ?? "";
  const ruf = map.get("ruf") ?? "";
  const fo = map.get("fo") ?? "";
  const rf = map.get("rf") ?? "";
  const riRaw = map.get("ri");
  const ri =
    riRaw !== undefined
      ? (() => {
          const n = Number.parseInt(riRaw, 10);
          return Number.isNaN(n) ? undefined : n;
        })()
      : undefined;
  return { policy, subdomainPolicy, adkim, aspf, pct, rua, ruf, fo, rf, ri };
}

function buildDMARC(fields: {
  policy: "none" | "quarantine" | "reject";
  rua: string;
  ruf: string;
  pct: number | undefined;
  adkim: "r" | "s";
  aspf: "r" | "s";
  subdomainPolicy: "" | "none" | "quarantine" | "reject";
  fo: string;
  rf: string;
  ri: number | undefined;
}) {
  const parts: string[] = ["v=DMARC1", `p=${fields.policy}`];
  if (fields.subdomainPolicy) parts.push(`sp=${fields.subdomainPolicy}`);
  if (fields.adkim) parts.push(`adkim=${fields.adkim}`);
  if (fields.aspf) parts.push(`aspf=${fields.aspf}`);
  if (fields.pct !== undefined) parts.push(`pct=${fields.pct}`);
  if (fields.rua.trim()) parts.push(`rua=${fields.rua.trim()}`);
  if (fields.ruf.trim()) parts.push(`ruf=${fields.ruf.trim()}`);
  if (fields.fo.trim()) parts.push(`fo=${fields.fo.trim()}`);
  if (fields.rf.trim()) parts.push(`rf=${fields.rf.trim()}`);
  if (fields.ri !== undefined) parts.push(`ri=${fields.ri}`);
  return parts.join("; ") + ";";
}

export function DmarcBuilder({
  record,
  onRecordChange,
  zoneName,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  zoneName?: string;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [policy, setPolicy] = useState<DmarcPolicy>("none");
  const [rua, setRua] = useState<string>("");
  const [ruf, setRuf] = useState<string>("");
  const [pct, setPct] = useState<number | undefined>(undefined);
  const [adkim, setAdkim] = useState<DmarcAlignment>("r");
  const [aspf, setAspf] = useState<DmarcAlignment>("r");
  const [subdomainPolicy, setSubdomainPolicy] = useState<
    "" | "none" | "quarantine" | "reject"
  >("");
  const [fo, setFo] = useState<string>("");
  const [rf, setRf] = useState<string>("");
  const [ri, setRi] = useState<number | undefined>(undefined);
  const { fieldIds, helpIds } = useBuilderFieldIds([
    "policy",
    "rua",
    "ruf",
    "adkim",
    "aspf",
    "pct",
    "subdomainPolicy",
    "fo",
    "ri",
    "rf",
  ] as const);

  useEffect(() => {
    if (record.type !== "TXT") return;
    const parsed = parseDMARC(record.content);
    setPolicy(parsed.policy);
    setRua(parsed.rua);
    setRuf(parsed.ruf);
    setPct(parsed.pct);
    setAdkim(parsed.adkim);
    setAspf(parsed.aspf);
    setSubdomainPolicy(parsed.subdomainPolicy);
    setFo(parsed.fo);
    setRf(parsed.rf);
    setRi(parsed.ri);
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    const issues: string[] = [];
    const nameIssues: string[] = [];

    const canonical = buildDMARC({
      policy,
      rua,
      ruf,
      pct,
      adkim,
      aspf,
      subdomainPolicy,
      fo,
      rf,
      ri,
    });

    const name = normalizeDnsName(record.name ?? "").toLowerCase();
    const normalizedZoneName = normalizeDnsName(zoneName ?? "").toLowerCase();
    const expectedAbsoluteName = normalizedZoneName
      ? `_dmarc.${normalizedZoneName}`
      : "";
    if (!name || (name !== "_dmarc" && name !== expectedAbsoluteName))
      uniquePush(nameIssues, 'DMARC: name is usually "_dmarc".');

    const content = unquoteCharacterString(record.content).trim();
    if (!content) {
      uniquePush(issues, "DMARC: content is empty.");
    } else {
      const v = validateDMARC(content);
      for (const p of v.problems) uniquePush(issues, `DMARC: ${p}`);
      if (!content.endsWith(";"))
        uniquePush(
          issues,
          "DMARC: consider ending tags with ';' for readability.",
        );
    }

    if (content && content !== canonical)
      uniquePush(
        issues,
        "DMARC: content differs from the builder settings (use Build DMARC TXT to normalize).",
      );
    if (!rua.trim())
      uniquePush(
        issues,
        "DMARC: rua= is missing (recommended to receive aggregate reports).",
      );

    const vCanon = validateDMARC(canonical);
    for (const p of vCanon.problems) uniquePush(issues, `DMARC: ${p}`);

    return { canonical, issues, nameIssues };
  }, [
    adkim,
    aspf,
    fo,
    pct,
    policy,
    record.content,
    record.name,
    rf,
    ri,
    rua,
    ruf,
    subdomainPolicy,
    zoneName,
  ]);

  const summary = useMemo(
    () =>
      describeDMARC(
        {
          policy,
          subdomainPolicy,
          adkim,
          aspf,
          pct,
          rua,
          ruf,
          fo,
          rf,
          ri,
        },
        zoneName,
      ),
    [adkim, aspf, fo, pct, policy, rf, ri, rua, ruf, subdomainPolicy, zoneName],
  );

  useEffect(() => {
    if (!onWarningsChange) return;
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
  ]);

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="text-xs font-semibold text-muted-foreground">
        DMARC builder
      </div>

      <RecordSummary summary={summary} className="mt-2" />

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.policy}
            descriptionId={helpIds.policy}
            label="p= (policy)"
            help="Controls handling for messages that fail DMARC: monitor, quarantine, or reject."
          />
          <Select
            value={policy}
            onValueChange={(value: string) => {
              if (isDmarcPolicy(value)) setPolicy(value);
            }}
          >
            <SelectTrigger
              id={fieldIds.policy}
              aria-describedby={helpIds.policy}
              className="h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">none</SelectItem>
              <SelectItem value="quarantine">quarantine</SelectItem>
              <SelectItem value="reject">reject</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.rua}
            descriptionId={helpIds.rua}
            label="rua= (aggregate reports)"
            help="Comma-separated mailto: destinations for aggregate reports; external domains may require authorization."
          />
          <Input
            id={fieldIds.rua}
            aria-describedby={helpIds.rua}
            value={rua}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setRua(e.target.value)
            }
            placeholder={`mailto:dmarc@${zoneName ?? "example.com"}`}
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.ruf}
            descriptionId={helpIds.ruf}
            label="ruf= (forensic reports)"
            help="Optional destinations for detailed failure reports; support is limited and reports may contain sensitive data."
          />
          <Input
            id={fieldIds.ruf}
            aria-describedby={helpIds.ruf}
            value={ruf}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setRuf(e.target.value)
            }
            placeholder="optional"
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.adkim}
            descriptionId={helpIds.adkim}
            label="adkim="
            help="Relaxed aligns organizational domains; strict requires the exact DKIM signing domain."
          />
          <Select
            value={adkim}
            onValueChange={(value: string) => {
              if (isDmarcAlignment(value)) setAdkim(value);
            }}
          >
            <SelectTrigger
              id={fieldIds.adkim}
              aria-describedby={helpIds.adkim}
              className="h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="r">r (relaxed)</SelectItem>
              <SelectItem value="s">s (strict)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.aspf}
            descriptionId={helpIds.aspf}
            label="aspf="
            help="Relaxed aligns organizational domains; strict requires the exact SPF-authenticated domain."
          />
          <Select
            value={aspf}
            onValueChange={(value: string) => {
              if (isDmarcAlignment(value)) setAspf(value);
            }}
          >
            <SelectTrigger
              id={fieldIds.aspf}
              aria-describedby={helpIds.aspf}
              className="h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="r">r (relaxed)</SelectItem>
              <SelectItem value="s">s (strict)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.pct}
            descriptionId={helpIds.pct}
            label="pct="
            help="Percentage of failing messages subject to quarantine or reject, from 0 to 100; the default is 100."
          />
          <Input
            id={fieldIds.pct}
            aria-describedby={helpIds.pct}
            type="number"
            min={0}
            max={100}
            step={1}
            inputMode="numeric"
            value={pct ?? ""}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const n = Number.parseInt(e.target.value, 10);
              setPct(Number.isNaN(n) ? undefined : n);
            }}
            placeholder="100"
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.subdomainPolicy}
            descriptionId={helpIds.subdomainPolicy}
            label="sp= (subdomain policy)"
            help="Policy for subdomains. Omit it to inherit p=, or choose a separate enforcement policy."
          />
          <Select
            value={subdomainPolicy || "__omit__"}
            onValueChange={(value: string) => {
              if (value === "__omit__") setSubdomainPolicy("");
              else if (isDmarcPolicy(value)) setSubdomainPolicy(value);
            }}
          >
            <SelectTrigger
              id={fieldIds.subdomainPolicy}
              aria-describedby={helpIds.subdomainPolicy}
              className="h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__omit__">Omit</SelectItem>
              <SelectItem value="none">none</SelectItem>
              <SelectItem value="quarantine">quarantine</SelectItem>
              <SelectItem value="reject">reject</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.fo}
            descriptionId={helpIds.fo}
            label="fo= (optional)"
            help="Failure-report options are 0, 1, d, or s; combine them with colons and use them with ruf=."
          />
          <Input
            id={fieldIds.fo}
            aria-describedby={helpIds.fo}
            value={fo}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setFo(e.target.value)
            }
            placeholder="optional"
          />
        </div>

        <div className="space-y-1 sm:col-span-1">
          <BuilderFieldLabel
            controlId={fieldIds.ri}
            descriptionId={helpIds.ri}
            label="ri= (optional)"
            help="Requested aggregate-report interval in seconds; 86400 is typical and receivers may choose another interval."
          />
          <Input
            id={fieldIds.ri}
            aria-describedby={helpIds.ri}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={ri ?? ""}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const n = Number.parseInt(e.target.value, 10);
              setRi(Number.isNaN(n) ? undefined : n);
            }}
            placeholder="86400"
          />
        </div>

        <div className="space-y-1 sm:col-span-1">
          <BuilderFieldLabel
            controlId={fieldIds.rf}
            descriptionId={helpIds.rf}
            label="rf= (optional)"
            help="Failure-report format. AFRF is the common default; IODEF support varies by receiver."
          />
          <Select
            value={rf.trim().toLowerCase() || "__omit__"}
            onValueChange={(value: string) =>
              setRf(value === "__omit__" ? "" : value)
            }
          >
            <SelectTrigger
              id={fieldIds.rf}
              aria-describedby={helpIds.rf}
              className="h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__omit__">Omit (default)</SelectItem>
              <SelectItem value="afrf">afrf</SelectItem>
              <SelectItem value="iodef">iodef</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRecordChange({ ...record, name: "_dmarc" })}
        >
          Use _dmarc name
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const parsed = parseDMARC(record.content);
            setPolicy(parsed.policy);
            setRua(parsed.rua);
            setRuf(parsed.ruf);
            setPct(parsed.pct);
            setAdkim(parsed.adkim);
            setAspf(parsed.aspf);
            setSubdomainPolicy(parsed.subdomainPolicy);
            setFo(parsed.fo);
            setRf(parsed.rf);
            setRi(parsed.ri);
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
          Build DMARC TXT
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
            Start with <code>p=none</code> while monitoring reports, then move
            to <code>quarantine</code>/<code>reject</code>.
          </li>
          <li>
            Add <code>rua=mailto:</code> so you actually receive aggregate
            reports.
          </li>
          <li>
            Use strict alignment (<code>adkim=s</code>, <code>aspf=s</code>)
            only when you’re sure all senders are aligned.
          </li>
        </ul>
      </div>

      {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <div className="text-sm font-semibold">DMARC warnings</div>
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
  );
}
