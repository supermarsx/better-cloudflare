import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { cn } from "@/lib/utils";

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

/**
 * The tags a preset decides. Deliberately only the *policy* tags: report
 * addresses and reporting preferences describe the operator's own
 * infrastructure, so a preset must never overwrite or invent them.
 */
export type DmarcPresetValues = Pick<
  DmarcFields,
  "policy" | "subdomainPolicy" | "adkim" | "aspf" | "pct"
>;

export type DmarcPreset = {
  id: string;
  /** Names the posture, not a ranking: the list is ordered, not scored. */
  name: string;
  /** How much legitimate mail this can cost if the domain is not ready. */
  risk: string;
  severity: "high" | "medium" | "low" | "none";
  values: DmarcPresetValues;
  /** What this actually does to mail, in plain terms. */
  consequence: string;
  /** The situation in which this is the right choice. */
  suitedFor: string;
};

/**
 * Policy presets, ordered strictest first.
 *
 * The order is a spectrum of enforcement, **not** a quality ranking: the first
 * entry destroys the most legitimate mail on a domain whose senders are not yet
 * aligned, and the last is the only safe place to start from scratch. Every
 * entry therefore carries its own consequence text, shown at the point of
 * choice rather than left to documentation.
 *
 * `subdomainPolicy` is set explicitly on every preset (to `""` where the intent
 * is "inherit p=") so that choosing a preset can never leave a stale `sp=none`
 * behind quietly exempting every subdomain from the policy just picked.
 */
export const DMARC_PRESETS: readonly DmarcPreset[] = [
  {
    id: "strict",
    name: "Strict enforcement",
    risk: "Highest risk",
    severity: "high",
    values: {
      policy: "reject",
      subdomainPolicy: "reject",
      adkim: "s",
      aspf: "s",
      pct: 100,
    },
    consequence:
      "Receiving servers throw away every message that fails your checks, including legitimate mail you have not yet authorised — it bounces rather than landing in spam. Strict alignment additionally fails any sender that signs with its own domain instead of yours, which most bulk-mail, ticketing and helpdesk services do.",
    suitedFor:
      "A domain where months of aggregate reports have come back clean and every sender is known to be aligned exactly.",
  },
  {
    id: "enforce",
    name: "Enforce",
    risk: "High risk",
    severity: "high",
    values: {
      policy: "reject",
      subdomainPolicy: "",
      adkim: "r",
      aspf: "r",
      pct: 100,
    },
    consequence:
      "Receiving servers throw away every message that fails your checks. Relaxed alignment forgives senders using a subdomain of yours, so it breaks far fewer services than strict — but unauthorised legitimate mail is still destroyed rather than quarantined.",
    suitedFor:
      "A domain whose senders all pass at the organizational-domain level, after a spell at quarantine with no surprises in the reports.",
  },
  {
    id: "quarantine",
    name: "Quarantine",
    risk: "Medium risk",
    severity: "medium",
    values: {
      policy: "quarantine",
      subdomainPolicy: "",
      adkim: "r",
      aspf: "r",
      pct: 100,
    },
    consequence:
      "Failing mail is delivered to the spam or junk folder instead of being thrown away. Mistakes stay recoverable, because a recipient can still go and find the message, which is what makes this the usual first step into enforcement.",
    suitedFor:
      "A domain whose reports look clean and which is ready to act on failures without losing mail outright.",
  },
  {
    id: "rollout",
    name: "Partial rollout",
    risk: "Lower risk",
    severity: "low",
    values: {
      policy: "quarantine",
      subdomainPolicy: "",
      adkim: "r",
      aspf: "r",
      pct: 25,
    },
    consequence:
      "Roughly a quarter of failing messages are quarantined and the rest are delivered as normal, so you see what enforcement does to a sample of your mail before it applies to all of it. Receivers decide which messages fall in the sample.",
    suitedFor:
      "A first cautious step past monitoring, or a large domain rolling enforcement out gradually.",
  },
  {
    id: "monitor",
    name: "Monitor only",
    risk: "No delivery risk",
    severity: "none",
    values: {
      policy: "none",
      subdomainPolicy: "",
      adkim: "r",
      aspf: "r",
      pct: undefined,
    },
    consequence:
      "Nothing at all changes about how your mail is delivered. Receivers simply send you reports on who is sending as your domain and what passes, which is the information every stricter option depends on. Without an rua= address below it does nothing whatsoever.",
    suitedFor:
      "The correct starting point for any domain that has never published a DMARC record.",
  },
];

/**
 * The policy tags a preset writes, in the order {@link buildDMARC} emits them,
 * for display on the preset itself. Kept in step with `buildDMARC` by test.
 */
export function dmarcPresetTagLine(values: DmarcPresetValues) {
  const parts = [`p=${values.policy}`];
  if (values.subdomainPolicy) parts.push(`sp=${values.subdomainPolicy}`);
  parts.push(`adkim=${values.adkim}`, `aspf=${values.aspf}`);
  if (values.pct !== undefined) parts.push(`pct=${values.pct}`);
  return parts.join("; ");
}

const PRESET_SEVERITY_CLASS: Record<DmarcPreset["severity"], string> = {
  high: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  medium:
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  low: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  none: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
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

export function buildDMARC(fields: {
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

  /**
   * Apply a preset's policy tags to the form.
   *
   * Only the policy tags move: report addresses and reporting preferences are
   * the operator's own and are left exactly as they were. Every policy tag is
   * assigned unconditionally, including `subdomainPolicy`, so a preset can
   * never inherit a stale value from the posture it replaced.
   */
  const applyPreset = useCallback((values: DmarcPresetValues) => {
    setPolicy(values.policy);
    setSubdomainPolicy(values.subdomainPolicy);
    setAdkim(values.adkim);
    setAspf(values.aspf);
    setPct(values.pct);
  }, []);

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
            help="What receivers do with mail claiming to be from your domain that fails your checks. none changes nothing and only gathers reports; quarantine diverts failures to spam; reject makes receivers throw them away. Set reject before your real senders are authorised and legitimate mail is destroyed, not delayed."
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
            help="Where receivers send the daily summaries of who is sending as your domain and whether it passed. Leave it empty and you are publishing a policy blind, with no way to know whether tightening it is safe. An address on another domain only receives reports if that domain publishes a record authorising yours."
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
            help="Where receivers send reports about individual failed messages instead of a daily summary. These can include message content and recipient addresses, so treat the mailbox as sensitive; most large receivers never send them. Safe to leave empty."
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
            help="How closely the DKIM signing domain must match the From: address. Relaxed accepts any subdomain of yours, so mail signed by mail.example.com passes for example.com. Strict demands an exact match and will fail senders that sign with their own domain, as most bulk-mail providers do."
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
            help="How closely the SPF-checked envelope domain must match the From: address. Relaxed accepts any subdomain of yours; strict demands an exact match, which commonly fails because services send with their own bounce domain in the envelope."
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
            help="The share of failing messages the quarantine or reject policy is actually applied to, so you can roll enforcement out gradually. The rest get the next weaker treatment: under reject they are quarantined, under quarantine they are delivered. It does nothing when the policy is none. Empty means the default, 100."
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
            help="A separate policy for mail from your subdomains. Omit it and they inherit p=, which is usually what you want. Setting it to none exempts every subdomain, so anyone who can send as one bypasses your policy completely."
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
            help="Which failures earn a per-message report: 0 when everything fails, 1 when any check fails to pass aligned, d for a broken DKIM signature, s for an SPF failure. Combine with colons, as in 1:d. It has no effect unless ruf= is also set."
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
            help="How often you would like aggregate reports, in seconds; 86400 is one day and is what nearly everyone uses. Receivers treat it as a request rather than a rule and commonly report daily whatever you ask for."
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
            help="The file format for the per-message failure reports that ruf= asks for. AFRF is the near-universal default and IODEF is rarely supported, so leave it omitted unless a report processor asks for something specific."
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
          Policy presets
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Ordered strictest first. Strictest is not best: <code>p=reject</code>{" "}
          on a domain whose real senders are not yet aligned silently destroys
          legitimate mail rather than delaying it. Work down this list, and move
          up it only once your aggregate reports come back clean.
        </p>
        {!rua.trim() ? (
          <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-foreground/85">
            No <code>rua=</code> address is set yet. Every preset below is
            guesswork without one: aggregate reports are the only way to learn
            which of your senders would fail before you enforce anything.
          </p>
        ) : null}
        <ul className="mt-2 space-y-2">
          {DMARC_PRESETS.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                onClick={() => applyPreset(preset.values)}
                className="glass-surface w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-xs font-semibold">{preset.name}</span>
                  <span
                    className={cn(
                      "rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
                      PRESET_SEVERITY_CLASS[preset.severity],
                    )}
                  >
                    {preset.risk}
                  </span>
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                  {preset.consequence}
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                  <span className="font-semibold">Use when:</span>{" "}
                  {preset.suitedFor}
                </span>
                <code className="mt-1 block break-all text-[11px] text-foreground/80">
                  {dmarcPresetTagLine(preset.values)}
                </code>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          A preset is a starting point, not a mode: it fills in the policy tags
          above and every field stays editable afterwards. Your report addresses
          and any <code>fo=</code>, <code>rf=</code> or <code>ri=</code>{" "}
          settings are left untouched. Choose{" "}
          <span className="font-semibold">Build DMARC TXT</span> to write the
          result into the record.
        </p>
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
