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
import { Switch } from "@/components/ui/switch";
import {
  parseCharacterStrings,
  quoteCharacterString,
} from "@/lib/dns/character-string";
import { KNOWN_TLDS } from "@/lib/dns/tlds";

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

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.$/, "");
}

export type CaaFields = {
  flags: number | undefined;
  /** The effective property tag, already resolved from the custom input. */
  tag: string;
  value: string;
};

/** The critical bit of the CAA flags byte (RFC 8659 §4.1). */
const CAA_CRITICAL_FLAG = 128;

/** Strip a `mailto:` prefix so an iodef destination reads as prose. */
function describeIodefTarget(value: string) {
  return value.toLowerCase().startsWith("mailto:")
    ? value.slice("mailto:".length)
    : value;
}

/**
 * Plain-English description of the CAA property being assembled.
 *
 * A CA evaluates every CAA record at the relevant name as one set (RFC 8659
 * §3), so the wording never claims this single record decides issuance on its
 * own; the rest of the set is reported as an unknown instead.
 */
export function describeCAA(
  fields: CaaFields,
  options?: { recordName?: string },
): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const tag = fields.tag.trim().toLowerCase();
  const value = fields.value.trim();
  const flags = fields.flags ?? 0;
  const critical = (flags & CAA_CRITICAL_FLAG) !== 0;
  const [issuerRaw, ...parameterParts] = value.split(";");
  const issuer = (issuerRaw ?? "").trim();
  const parameters = parameterParts.join(";").trim();

  let headline: string;
  if (!tag) {
    headline =
      "Will tell certificate authorities which of them may issue certificates for this name. Choose a property tag and name the CA.";
  } else if (tag === "issue") {
    headline = issuer
      ? `Allows the certificate authority identified by ${issuer} to issue certificates for this name; any CA not named by the CAA records here must refuse. It covers wildcard certificates too, unless an issuewild record also exists at this name.`
      : "Grants no certificate authority permission to issue for this name: an issue value with no CA domain matches nobody, so unless another CAA record here names a CA, issuance is forbidden outright.";
  } else if (tag === "issuewild") {
    headline = issuer
      ? `Allows the certificate authority identified by ${issuer} to issue wildcard certificates for this name.`
      : "Forbids wildcard certificates for this name: an issuewild value with no CA domain matches nobody, so unless another issuewild record here names a CA, no CA may issue one.";
    details.push(
      "While any issuewild record exists at this name it replaces the issue records for wildcard certificates; issue still governs ordinary ones.",
    );
  } else if (tag === "iodef") {
    headline = value
      ? `Asks certificate authorities to report to ${describeIodefTarget(value)} any certificate request for this name that they refuse under its CAA policy.`
      : "Will name a destination where certificate authorities can report certificate requests they refuse under this name's CAA policy.";
    details.push(
      "Reporting is optional in RFC 8659, so a CA may use this address or ignore it; it never blocks or allows issuance by itself.",
    );
  } else {
    headline = `Publishes a CAA property tagged ${tag} for this name.`;
  }

  if (critical) {
    details.push(
      `The critical flag is set (128), so a certificate authority that does not understand the ${tag || "property"} tag must refuse to issue any certificate for this name instead of ignoring this record.`,
    );
  }
  const reservedBits = flags & ~CAA_CRITICAL_FLAG;
  if (reservedBits !== 0) {
    details.push(
      `flags=${flags} sets bits beyond the critical bit; RFC 8659 defines only bit 128 and requires the rest to be zero.`,
    );
  }

  details.push(
    "CAA is checked by the certificate authority at the moment a certificate is requested. Browsers never check it, so it has no effect on certificates that have already been issued.",
  );

  const recordName = (options?.recordName ?? "").trim();
  if (recordName && recordName !== "@") {
    details.push(
      `Published at ${recordName}, so it governs that name and anything below it; a CA only climbs to the parent domain for names that have no CAA records of their own.`,
    );
  }

  unknowns.push(
    "The other CAA records at this name are not visible here, and a certificate authority reads the whole set together, so this record alone does not settle what may be issued.",
  );
  if (parameters && (tag === "issue" || tag === "issuewild")) {
    unknowns.push(
      `The parameters after the semicolon (${parameters}) are defined by ${issuer || "the named CA"} itself, so what they restrict cannot be determined here.`,
    );
  }
  if (tag && tag !== "issue" && tag !== "issuewild" && tag !== "iodef") {
    unknowns.push(
      `${tag} is not a property tag defined by RFC 8659, so what a certificate authority does with it depends on the specification that introduced it.`,
    );
  }

  return { headline, details, unknowns };
}

/**
 * Decode the CAA value field, which is a single `<character-string>`. Quoted,
 * bare and half-quoted input all decode; anything that parses as more than one
 * character-string is kept verbatim so nothing is silently merged.
 */
function parseDnsCharacterString(value: string) {
  const parts = parseCharacterStrings(value);
  return parts.length === 1 ? parts[0] : value;
}

export function parseCAAContent(value: string | undefined) {
  const raw = (value ?? "").trim();
  if (!raw) {
    return { flags: undefined as number | undefined, tag: "", value: "" };
  }
  const m = raw.match(/^(\d{1,3})[\t ]+([A-Za-z0-9-]+)[\t ]+([\s\S]+)$/u);
  if (!m) {
    return { flags: undefined as number | undefined, tag: "", value: raw };
  }
  const flagsRaw = m[1] ?? "";
  const tag = (m[2] ?? "").trim().toLowerCase();
  const rest = (m[3] ?? "").trim();
  const flagsNum = Number.parseInt(flagsRaw, 10);
  const v = parseDnsCharacterString(rest);
  return {
    flags: Number.isNaN(flagsNum) ? undefined : flagsNum,
    tag,
    value: v,
  };
}

export function composeCAA(fields: {
  flags: number | undefined;
  tag: string;
  value: string;
}) {
  const flags = fields.flags ?? 0;
  const tag = (fields.tag ?? "").trim().toLowerCase();
  const v = quoteCharacterString((fields.value ?? "").trim());
  return `${flags} ${tag} ${v}`.trim();
}

export function CaaBuilder({
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
  const [caaFlags, setCaaFlags] = useState<number | undefined>(undefined);
  const [caaTag, setCaaTag] = useState<
    "issue" | "issuewild" | "iodef" | "custom"
  >("issue");
  const [caaTagCustom, setCaaTagCustom] = useState<string>("");
  const [caaValue, setCaaValue] = useState<string>("");
  const { fieldIds, helpIds } = useBuilderFieldIds([
    "tag",
    "tagCustom",
    "flags",
    "critical",
    "value",
  ] as const);

  useEffect(() => {
    if (record.type !== "CAA") return;
    const parsed = parseCAAContent(record.content);
    setCaaFlags(parsed.flags);
    if (parsed.tag) {
      const tag = parsed.tag.toLowerCase();
      if (tag === "issue" || tag === "issuewild" || tag === "iodef") {
        setCaaTag(tag);
        setCaaTagCustom("");
      } else {
        setCaaTag("custom");
        setCaaTagCustom(tag);
      }
    }
    setCaaValue(parsed.value ?? "");
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "CAA") {
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

    const isValidDnsLabel = (label: string) => {
      if (!label) return false;
      if (label.length > 63) return false;
      if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
      if (label.startsWith("-") || label.endsWith("-")) return false;
      return true;
    };
    const isValidHostname = (value: string) => {
      const v = normalizeDnsName(value);
      if (!v) return false;
      if (/\s/.test(v)) return false;
      if (v.length > 253) return false;
      if (v.includes("..")) return false;
      const labels = v.split(".");
      if (labels.some((l) => l.length === 0)) return false;
      return labels.every(isValidDnsLabel);
    };
    const validateEmailAddress = (address: string) => {
      const a = address.trim();
      if (!a) return "missing an email address.";
      if (/\s/.test(a)) return "email address contains whitespace.";
      const at = a.indexOf("@");
      if (at <= 0 || at !== a.lastIndexOf("@") || at === a.length - 1)
        return "invalid email (expected local@domain).";
      const domain = normalizeDnsName(a.slice(at + 1));
      if (!isValidHostname(domain))
        return "email domain does not look like a hostname.";
      const labels = domain.split(".");
      if (labels.length < 2) return "email domain should be a FQDN.";
      const tld = labels[labels.length - 1]?.toLowerCase() ?? "";
      if (tld && !KNOWN_TLDS.has(tld))
        return `email domain uses an unknown/invalid TLD “.${tld}”.`;
      return null;
    };

    const effectiveTag =
      caaTag === "custom"
        ? caaTagCustom.trim().toLowerCase()
        : (caaTag as string);
    const flags = caaFlags ?? 0;
    const critical = (flags & CAA_CRITICAL_FLAG) !== 0;
    const value = (caaValue ?? "").trim();

    if (caaFlags !== undefined) {
      if (caaFlags < 0 || caaFlags > 255)
        push(issues, "CAA: flags must be 0–255.");
      if (critical) {
        push(
          issues,
          "CAA: critical flag is set (128). Clients that don't understand the tag may reject issuance.",
        );
      }
    } else {
      push(issues, "CAA: flags are missing (usually 0).");
    }

    if (!effectiveTag) {
      push(issues, "CAA: tag is missing (issue, issuewild, iodef, or custom).");
    } else {
      if (!/^[a-z0-9-]+$/.test(effectiveTag))
        push(issues, "CAA: tag contains unusual characters.");
      if (effectiveTag.length > 15)
        push(issues, "CAA: tag is unusually long (common tags are short).");
      const known = new Set(["issue", "issuewild", "iodef"]);
      if (!known.has(effectiveTag) && !caaTagCustom.trim())
        push(issues, "CAA: custom tag is empty.");
      if (!known.has(effectiveTag) && critical)
        push(
          issues,
          "CAA: critical + unknown tag may break issuance for some clients.",
        );
    }

    if (!value) {
      push(issues, "CAA: value is empty.");
    } else if (effectiveTag === "issue" || effectiveTag === "issuewild") {
      const beforeParams = value.split(";")[0]?.trim() ?? "";
      if (!beforeParams) {
        push(
          issues,
          `CAA: ${effectiveTag} value has no CA domain (this may intentionally forbid issuance).`,
        );
      } else {
        if (!isValidHostname(beforeParams))
          push(
            issues,
            `CAA: ${effectiveTag} CA domain does not look like a hostname.`,
          );
        const tld =
          normalizeDnsName(beforeParams).split(".").pop()?.toLowerCase() ?? "";
        if (tld && beforeParams.includes(".") && !KNOWN_TLDS.has(tld))
          push(
            issues,
            `CAA: ${effectiveTag} CA domain has unknown/invalid TLD “.${tld}”.`,
          );
      }
      if (value.includes("://"))
        push(
          issues,
          `CAA: ${effectiveTag} value looks like a URL; expected CA domain.`,
        );
    } else if (effectiveTag === "iodef") {
      const v = value;
      if (v.toLowerCase().startsWith("mailto:")) {
        const addr = v.slice("mailto:".length).split("?")[0]?.trim() ?? "";
        const emailProblem = validateEmailAddress(addr);
        if (emailProblem) push(issues, `CAA: iodef mailto ${emailProblem}`);
      } else {
        try {
          const u = new URL(v);
          if (u.protocol !== "http:" && u.protocol !== "https:")
            push(issues, "CAA: iodef should be mailto:, http:, or https:.");
        } catch {
          push(
            issues,
            "CAA: iodef value does not parse as a valid URL or mailto:.",
          );
        }
      }
    }

    const canonical = composeCAA({
      flags,
      tag: effectiveTag || "issue",
      value,
    });
    const content = (record.content ?? "").trim();
    if (content && content !== canonical) {
      push(
        issues,
        "CAA: content differs from builder settings (use Apply canonical to normalize).",
      );
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        'CAA: name is often "@" (zone apex) unless you need subdomain-specific policy.',
      );

    return { canonical, issues, nameIssues };
  }, [
    record.type,
    record.content,
    record.name,
    caaFlags,
    caaTag,
    caaTagCustom,
    caaValue,
  ]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "CAA") {
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

  const effectiveTag =
    caaTag === "custom"
      ? caaTagCustom.trim().toLowerCase()
      : (caaTag as string);
  const critical = ((caaFlags ?? 0) & CAA_CRITICAL_FLAG) !== 0;
  const summary = useMemo(
    () =>
      describeCAA(
        { flags: caaFlags, tag: effectiveTag, value: caaValue },
        { recordName: record.name },
      ),
    [caaFlags, caaValue, effectiveTag, record.name],
  );
  const valuePlaceholder =
    effectiveTag === "iodef"
      ? `mailto:security@${zoneName ?? "example.com"}`
      : effectiveTag === "issuewild"
        ? "letsencrypt.org (for wildcard certs)"
        : "letsencrypt.org";
  const valueHelp =
    effectiveTag === "iodef"
      ? "Where a certificate authority should report a request it refuses under this policy: a mailto: address or an http(s) URL. Reporting is optional, so treat it as a courtesy channel."
      : effectiveTag === "issuewild"
        ? "The CAA identifier domain of the CA allowed to issue wildcard certificates, such as letsencrypt.org, optionally followed by ';' and CA-specific parameters. Leaving it empty names no CA and so forbids wildcard issuance."
        : "The CAA identifier domain of the CA allowed to issue certificates, such as letsencrypt.org, optionally followed by ';' and CA-specific parameters. Leaving it empty names no CA and so forbids issuance.";

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            CAA builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>flags tag "value"</code>
          </div>
        </div>

        <RecordSummary summary={summary} className="mt-2" />

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.tag}
              descriptionId={helpIds.tag}
              label="Tag"
              help="Which property this record carries. issue names a CA allowed to issue certificates for this name, issuewild does the same for wildcard certificates only, and iodef gives CAs an address for reporting refused requests."
            />
            <Select
              value={caaTag}
              onValueChange={(v: string) => setCaaTag(v as typeof caaTag)}
            >
              <SelectTrigger
                id={fieldIds.tag}
                aria-describedby={helpIds.tag}
                className="h-9"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="issue">issue</SelectItem>
                <SelectItem value="issuewild">issuewild</SelectItem>
                <SelectItem value="iodef">iodef</SelectItem>
                <SelectItem value="custom">custom…</SelectItem>
              </SelectContent>
            </Select>
            {caaTag === "custom" && (
              <div className="mt-2 space-y-1">
                <BuilderFieldLabel
                  controlId={fieldIds.tagCustom}
                  descriptionId={helpIds.tagCustom}
                  label="Custom tag"
                  help="A property tag other than issue, issuewild or iodef, written in lowercase letters, digits and hyphens. Only use one a certificate authority documents, because a tag nobody recognizes is either ignored or, with the critical flag set, blocks issuance."
                />
                <Input
                  id={fieldIds.tagCustom}
                  aria-describedby={helpIds.tagCustom}
                  value={caaTagCustom}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setCaaTagCustom(e.target.value)
                  }
                  placeholder="e.g., issue"
                />
              </div>
            )}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.flags}
              descriptionId={helpIds.flags}
              label="Flags"
              help="The CAA flags byte, from 0 to 255. Only bit 128 (critical) is defined; every other bit is reserved and should stay 0, so 0 is the usual value."
            />
            <Input
              id={fieldIds.flags}
              aria-describedby={helpIds.flags}
              type="number"
              value={caaFlags ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                setCaaFlags(Number.isNaN(n) ? undefined : n);
              }}
              placeholder="0"
            />
            <div className="text-[11px] text-muted-foreground">
              Usually <code>0</code>. <code>128</code> sets critical.
            </div>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.critical}
              descriptionId={helpIds.critical}
              label="Critical"
              help="Sets flag bit 128. A certificate authority that does not understand this record's tag must then refuse to issue any certificate for this name, rather than ignoring the record."
            />
            <div className="flex h-9 items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3">
              <Switch
                id={fieldIds.critical}
                aria-describedby={helpIds.critical}
                checked={critical}
                onCheckedChange={(checked: boolean) => {
                  const base = caaFlags ?? 0;
                  const next = checked
                    ? base | CAA_CRITICAL_FLAG
                    : base & ~CAA_CRITICAL_FLAG;
                  setCaaFlags(next);
                }}
              />
              <span className="text-xs text-muted-foreground">
                {critical ? "On (128)" : "Off"}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Use sparingly; unknown tags may break issuance.
            </div>
          </div>
        </div>

        <div className="mt-2 space-y-1">
          <BuilderFieldLabel
            controlId={fieldIds.value}
            descriptionId={helpIds.value}
            label="Value"
            help={valueHelp}
          />
          <Input
            id={fieldIds.value}
            aria-describedby={helpIds.value}
            value={caaValue}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setCaaValue(e.target.value)
            }
            placeholder={valuePlaceholder}
          />
          <div className="text-[11px] text-muted-foreground">
            {effectiveTag === "iodef"
              ? "Where to send policy violation reports (mailto: or https://)."
              : "CA domain (optional parameters after ';')."}
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
            onClick={() => {
              const parsed = parseCAAContent(record.content);
              setCaaFlags(parsed.flags);
              const tag = (parsed.tag ?? "").toLowerCase();
              if (tag === "issue" || tag === "issuewild" || tag === "iodef") {
                setCaaTag(tag);
                setCaaTagCustom("");
              } else {
                setCaaTag("custom");
                setCaaTagCustom(tag);
              }
              setCaaValue(parsed.value ?? "");
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
              Add one <code>issue</code> record per allowed CA (multiple CAA
              records are normal).
            </li>
            <li>
              Use <code>issuewild</code> only if you plan to issue wildcard
              certificates.
            </li>
            <li>
              Keep flags at <code>0</code> unless you know you need critical
              behavior.
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCaaTag("issue");
                setCaaValue("letsencrypt.org");
                setCaaFlags(0);
              }}
            >
              Preset: Let&apos;s Encrypt (issue)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCaaTag("issuewild");
                setCaaValue("letsencrypt.org");
                setCaaFlags(0);
              }}
            >
              Preset: Let&apos;s Encrypt (issuewild)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCaaTag("iodef");
                setCaaValue(`mailto:security@${zoneName ?? "example.com"}`);
                setCaaFlags(0);
              }}
            >
              Preset: iodef mailto
            </Button>
          </div>
        </div>

        {(diagnostics.nameIssues.length > 0 ||
          diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">CAA warnings</div>
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
