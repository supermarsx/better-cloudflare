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
import { KNOWN_TLDS } from "@/lib/dns/tlds";

import {
  BuilderFieldLabel,
  RecordSummary,
  useBuilderFieldIds,
} from "./BuilderField";
import { orPlaceholder } from "./describe-utils";
import type {
  BuilderSummary,
  BuilderWarningsChange,
  RecordDraft,
} from "./types";

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.$/, "");
}

function isValidDnsLabel(label: string) {
  if (!label) return false;
  if (label.length > 63) return false;
  if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
  if (label.startsWith("-") || label.endsWith("-")) return false;
  return true;
}

function looksLikeHostname(value: string) {
  const v = normalizeDnsName(value);
  if (!v) return false;
  if (/\s/.test(v)) return false;
  if (v.length > 253) return false;
  if (v.includes("..")) return false;
  if (v.includes("://") || v.includes("/")) return false;
  const labels = v.split(".");
  if (labels.some((l) => l.length === 0)) return false;
  return labels.every(isValidDnsLabel);
}

const AFSDB_SUBTYPE_PRESETS = [
  { value: "1", label: "1 (AFS)", desc: "AFS cell database server." },
  { value: "2", label: "2 (DCE)", desc: "DCE/NCS cell database server." },
] as const;

function parseAfsdbContent(value?: string) {
  const raw = (value ?? "").trim();
  if (!raw)
    return { subtype: undefined as number | undefined, host: "", extra: "" };
  const parts = raw.split(/\s+/).filter(Boolean);
  const subtype = Number.parseInt(parts[0] ?? "", 10);
  return {
    subtype: Number.isNaN(subtype) ? undefined : subtype,
    host: parts[1] ?? "",
    extra: parts.slice(2).join(" "),
  };
}

function composeAfsdb(subtype?: number, host?: string) {
  const h = normalizeDnsName(host ?? "");
  return `${subtype ?? 0} ${h}`.trim();
}

export type AfsdbFields = {
  subtype: number | undefined;
  host: string;
};

/**
 * Plain-English description of the AFSDB record the builder is assembling.
 *
 * RFC 1183 §1 defines exactly two subtypes: 1 names a host running an AFS
 * volume location server for the cell named by the owner name, and 2 names an
 * authenticated name server holding that cell's root directory node. Nothing
 * else is defined, so any other subtype goes in `unknowns`.
 */
export function describeAFSDB(fields: AfsdbFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const host = normalizeDnsName(fields.host ?? "");
  const hostText = orPlaceholder(host, "the named host");

  let headline: string;
  if (fields.subtype === 1) {
    headline = `Tells AFS clients that ${hostText} runs a volume location server for the AFS cell named by this record's owner name.`;
  } else if (fields.subtype === 2) {
    headline = `Tells DCE/NCA clients that ${hostText} runs an authenticated name server holding the root directory node of the cell named by this record's owner name.`;
  } else if (fields.subtype === undefined) {
    headline =
      "Points clients of an AFS or DCE/NCA cell at the server that holds the cell's directory information.";
  } else {
    headline = `Publishes ${hostText} as a subtype ${fields.subtype} server for the cell named by this record's owner name.`;
  }

  if (!host) {
    details.push(
      "No hostname has been entered yet, so the record does not point anywhere.",
    );
  } else {
    details.push(
      "The hostname should be a host with its own A or AAAA records; like an MX or NS target, it must not be an alias.",
    );
  }

  details.push(
    "AFSDB is a legacy record type from RFC 1183. AFS and DCE/NCA deployments are rare today, and RFC 5864 replaced AFSDB for AFS with _afs3-vlserver SRV records.",
  );
  details.push(
    "Only AFS or DCE/NCA client software reads this record; it has no effect on web, mail or any other ordinary traffic.",
  );

  if (fields.subtype !== undefined && ![1, 2].includes(fields.subtype)) {
    unknowns.push(
      `Subtype ${fields.subtype} is not defined in RFC 1183, so what a client would do with this record cannot be determined here.`,
    );
  }
  if (host) {
    unknowns.push(
      `Whether ${hostText} actually runs that service, and whether it has address records of its own, cannot be checked from this form.`,
    );
  }
  unknowns.push(
    "Whether anything in this environment still consults AFSDB cannot be determined here.",
  );

  return { headline, details, unknowns };
}

export function AfsdbBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [subtype, setSubtype] = useState<number | undefined>(undefined);
  const [host, setHost] = useState<string>("");
  const [subtypeMode, setSubtypeMode] = useState<"preset" | "custom">("preset");
  const { fieldIds, helpIds } = useBuilderFieldIds([
    "subtype",
    "subtypeCustom",
    "host",
  ] as const);

  const summary = useMemo(
    () => describeAFSDB({ subtype, host }),
    [host, subtype],
  );

  const subtypeSelectValue = useMemo(() => {
    if (subtypeMode === "custom") return "custom";
    if (subtype === undefined) return "";
    return AFSDB_SUBTYPE_PRESETS.some((p) => Number(p.value) === subtype)
      ? String(subtype)
      : "custom";
  }, [subtype, subtypeMode]);

  useEffect(() => {
    if (record.type !== "AFSDB") return;
    const parsed = parseAfsdbContent(record.content);
    setSubtype(parsed.subtype);
    setHost(parsed.host ?? "");
    setSubtypeMode(
      parsed.subtype !== undefined &&
        AFSDB_SUBTYPE_PRESETS.some((p) => Number(p.value) === parsed.subtype)
        ? "preset"
        : "custom",
    );
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "AFSDB") {
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

    const parsed = parseAfsdbContent(record.content);
    if (parsed.extra)
      push(issues, "AFSDB: extra trailing tokens found in content.");

    if (subtype === undefined)
      push(issues, "AFSDB: subtype is required (usually 1 or 2).");
    else if (subtype < 0 || subtype > 65535)
      push(issues, "AFSDB: subtype should be 0–65535.");
    else if (![1, 2].includes(Number(subtype)))
      push(issues, "AFSDB: subtype is usually 1 (AFS) or 2 (DCE).");

    const h = normalizeDnsName(host);
    if (!h) push(issues, "AFSDB: hostname is required.");
    if (h && !looksLikeHostname(h))
      push(issues, "AFSDB: hostname does not look like a valid DNS name.");
    if (h && looksLikeHostname(h)) {
      const tld = h.split(".").pop()?.toLowerCase() ?? "";
      if (tld && h.includes(".") && /^[a-z0-9-]{2,63}$/.test(tld)) {
        if (!KNOWN_TLDS.has(tld))
          push(issues, `AFSDB: hostname has unknown/invalid TLD “.${tld}”.`);
      }
    }

    const canonical = composeAfsdb(subtype, host);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(
        issues,
        "AFSDB: content differs from builder settings (Apply canonical to normalize).",
      );
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(nameIssues, "AFSDB: name is usually the AFS cell/domain (often @).");

    return { canonical, issues, nameIssues };
  }, [host, record.content, record.name, record.type, subtype]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "AFSDB") {
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

  if (record.type !== "AFSDB") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            AFSDB builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>subtype hostname</code>
          </div>
        </div>

        <RecordSummary summary={summary} className="mt-2" />

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.subtype}
              descriptionId={helpIds.subtype}
              label="Subtype"
              help="Which cell service the host provides: 1 is an AFS volume location server for this cell, 2 is a DCE/NCA authenticated name server. RFC 1183 defines no other values, and 1 is the usual choice."
            />
            <Select
              value={subtypeSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setSubtypeMode("custom");
                  return;
                }
                const n = Number.parseInt(value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setSubtype(val);
                setSubtypeMode("preset");
                onRecordChange({
                  ...record,
                  content: composeAfsdb(val, host),
                });
              }}
            >
              <SelectTrigger
                id={fieldIds.subtype}
                aria-describedby={helpIds.subtype}
                className="h-9"
              >
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {AFSDB_SUBTYPE_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {subtypeMode === "custom" && (
              <div className="space-y-1 pt-2">
                <BuilderFieldLabel
                  controlId={fieldIds.subtypeCustom}
                  descriptionId={helpIds.subtypeCustom}
                  label="Custom subtype"
                  help="A numeric subtype from 0 to 65535 for a value outside the list. Only 1 and 2 have a defined meaning, so clients are unlikely to act on anything else."
                />
                <Input
                  id={fieldIds.subtypeCustom}
                  aria-describedby={helpIds.subtypeCustom}
                  type="number"
                  placeholder="e.g., 1"
                  value={subtype ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setSubtype(val);
                    onRecordChange({
                      ...record,
                      content: composeAfsdb(val, host),
                    });
                  }}
                />
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              {AFSDB_SUBTYPE_PRESETS.find((p) => Number(p.value) === subtype)
                ?.desc ?? "Subtype is usually 1 (AFS) or 2 (DCE)."}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-4">
            <BuilderFieldLabel
              controlId={fieldIds.host}
              descriptionId={helpIds.host}
              label="Hostname"
              help="The server that provides this service for the cell, as a fully qualified name such as afsdb.example.com. It should have its own A or AAAA records rather than being an alias."
            />
            <Input
              id={fieldIds.host}
              aria-describedby={helpIds.host}
              placeholder="e.g., afsdb.example.com"
              value={host}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setHost(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeAfsdb(subtype, e.target.value),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              The server providing AFS/DCE cell database information.
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseAfsdbContent(record.content);
              setSubtype(parsed.subtype);
              setHost(parsed.host ?? "");
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

        {(diagnostics.nameIssues.length > 0 ||
          diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">AFSDB warnings</div>
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
