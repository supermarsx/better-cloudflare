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
import { KNOWN_TLDS } from "@/lib/tlds";

import type { BuilderWarningsChange, RecordDraft } from "./types";

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.$/, "");
}

function uniquePush(list: string[], msg: string) {
  if (!list.includes(msg)) list.push(msg);
}

function validateDMARC(value: string) {
  const problems: string[] = [];
  const content = value.trim();
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
      problems.push(`${label}= invalid email address (expected local@domain): ${a}`);
      return;
    }
    const local = a.slice(0, at);
    const domainRaw = a.slice(at + 1);
    if (local.length > 64) problems.push(`${label}= local-part is >64 chars: ${a}`);
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
      problems.push(`${label}= email domain does not look like a hostname: ${a}`);
      return;
    }
    if (labels.length < 2) {
      problems.push(`${label}= email domain should be a FQDN: ${a}`);
      return;
    }
    const tld = labels[labels.length - 1]?.toLowerCase() ?? "";
    if (tld && !KNOWN_TLDS.has(tld)) {
      problems.push(`${label}= email domain uses an unknown/invalid TLD “.${tld}”: ${a}`);
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
    if (Number.isNaN(n) || n < 0 || n > 100) problems.push("pct= should be 0–100.");
  }
  const rua = map.get("rua");
  if (rua) {
    const parts = rua.split(",").map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (!part.toLowerCase().startsWith("mailto:"))
        problems.push(`rua= should use mailto: (got ${part}).`);
      else validateEmailAddress(part.slice("mailto:".length), "rua");
    }
  }
  const ruf = map.get("ruf");
  if (ruf) {
    const parts = ruf.split(",").map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (!part.toLowerCase().startsWith("mailto:"))
        problems.push(`ruf= should use mailto: (got ${part}).`);
      else validateEmailAddress(part.slice("mailto:".length), "ruf");
    }
  }
  const fo = map.get("fo");
  if (fo) {
    const allowed = new Set(["0", "1", "d", "s"]);
    const parts = fo.split(":").map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const p of parts) if (!allowed.has(p)) problems.push(`Unknown fo= value: ${p}`);
  }
  const rf = map.get("rf");
  if (rf) {
    const allowed = new Set(["afrf", "iodef"]);
    const parts = rf.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const p of parts) if (!allowed.has(p)) problems.push(`Unknown rf= value: ${p}`);
  }
  const ri = map.get("ri");
  if (ri) {
    const n = Number.parseInt(ri, 10);
    if (Number.isNaN(n) || n < 60) problems.push("ri= should be a number of seconds (>= 60).");
  }
  return { ok: problems.length === 0, problems };
}

function parseDMARC(value: string | undefined) {
  const content = (value ?? "").trim();
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
  const policy = (["none", "quarantine", "reject"].includes(policyRaw) ? policyRaw : "none") as
    | "none"
    | "quarantine"
    | "reject";
  const spRaw = (map.get("sp") ?? "").toLowerCase();
  const subdomainPolicy = (["none", "quarantine", "reject"].includes(spRaw) ? spRaw : "") as
    | ""
    | "none"
    | "quarantine"
    | "reject";
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
  const [policy, setPolicy] = useState<"none" | "quarantine" | "reject">("none");
  const [rua, setRua] = useState<string>("");
  const [ruf, setRuf] = useState<string>("");
  const [pct, setPct] = useState<number | undefined>(undefined);
  const [adkim, setAdkim] = useState<"r" | "s">("r");
  const [aspf, setAspf] = useState<"r" | "s">("r");
  const [subdomainPolicy, setSubdomainPolicy] = useState<
    "" | "none" | "quarantine" | "reject"
  >("");
  const [fo, setFo] = useState<string>("");
  const [rf, setRf] = useState<string>("");
  const [ri, setRi] = useState<number | undefined>(undefined);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    const name = (record.name ?? "").trim();
    if (!name || name !== "_dmarc") uniquePush(nameIssues, 'DMARC: name is usually "_dmarc".');

    const content = (record.content ?? "").trim();
    if (!content) {
      uniquePush(issues, "DMARC: content is empty.");
    } else {
      const v = validateDMARC(content);
      for (const p of v.problems) uniquePush(issues, `DMARC: ${p}`);
      if (!content.endsWith(";"))
        uniquePush(issues, "DMARC: consider ending tags with ';' for readability.");
    }

    if (content && content !== canonical)
      uniquePush(
        issues,
        "DMARC: content differs from the builder settings (use Build DMARC TXT to normalize).",
      );
    if (!rua.trim())
      uniquePush(issues, "DMARC: rua= is missing (recommended to receive aggregate reports).");

    const vCanon = validateDMARC(canonical);
    for (const p of vCanon.problems) uniquePush(issues, `DMARC: ${p}`);

    return { canonical, issues, nameIssues };
  }, [adkim, aspf, fo, pct, policy, record.content, record.name, rf, ri, rua, ruf, subdomainPolicy]);

  useEffect(() => {
    if (!onWarningsChange) return;
    onWarningsChange({
      issues: diagnostics.issues,
      nameIssues: diagnostics.nameIssues,
      canonical: diagnostics.canonical,
    });
  }, [diagnostics.canonical, diagnostics.issues, diagnostics.nameIssues, onWarningsChange]);

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="text-xs font-semibold text-muted-foreground">DMARC builder</div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">p= (policy)</Label>
          <Select value={policy} onValueChange={(value: string) => setPolicy(value as any)}>
            <SelectTrigger className="h-9">
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
          <Label className="text-xs">rua= (aggregate reports)</Label>
          <Input
            value={rua}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setRua(e.target.value)}
            placeholder={`mailto:dmarc@${zoneName ?? "example.com"}`}
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">ruf= (forensic reports)</Label>
          <Input value={ruf} onChange={(e: ChangeEvent<HTMLInputElement>) => setRuf(e.target.value)} placeholder="optional" />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">adkim=</Label>
          <Select value={adkim} onValueChange={(value: string) => setAdkim(value as any)}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="r">r (relaxed)</SelectItem>
              <SelectItem value="s">s (strict)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">aspf=</Label>
          <Select value={aspf} onValueChange={(value: string) => setAspf(value as any)}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="r">r (relaxed)</SelectItem>
              <SelectItem value="s">s (strict)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">pct=</Label>
          <Input
            type="number"
            value={pct ?? ""}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const n = Number.parseInt(e.target.value, 10);
              setPct(Number.isNaN(n) ? undefined : n);
            }}
            placeholder="100"
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">sp= (subdomain policy)</Label>
          <Select
            value={subdomainPolicy || "__omit__"}
            onValueChange={(value: string) =>
              setSubdomainPolicy(value === "__omit__" ? "" : (value as any))
            }
          >
            <SelectTrigger className="h-9">
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
          <Label className="text-xs">fo= (optional)</Label>
          <Input value={fo} onChange={(e: ChangeEvent<HTMLInputElement>) => setFo(e.target.value)} placeholder="optional" />
        </div>

        <div className="space-y-1 sm:col-span-1">
          <Label className="text-xs">ri= (optional)</Label>
          <Input
            type="number"
            value={ri ?? ""}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const n = Number.parseInt(e.target.value, 10);
              setRi(Number.isNaN(n) ? undefined : n);
            }}
            placeholder="86400"
          />
        </div>

        <div className="space-y-1 sm:col-span-1">
          <Label className="text-xs">rf= (optional)</Label>
          <Select value={rf.trim().toLowerCase() || "__omit__"} onValueChange={(value: string) => setRf(value === "__omit__" ? "" : value)}>
            <SelectTrigger className="h-9">
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
        <Button size="sm" variant="outline" onClick={() => onRecordChange({ ...record, name: "_dmarc" })}>
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
        <Button size="sm" onClick={() => onRecordChange({ ...record, content: diagnostics.canonical })}>
          Build DMARC TXT
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
            Start with <code>p=none</code> while monitoring reports, then move to{" "}
            <code>quarantine</code>/<code>reject</code>.
          </li>
          <li>
            Add <code>rua=mailto:</code> so you actually receive aggregate reports.
          </li>
          <li>
            Use strict alignment (<code>adkim=s</code>, <code>aspf=s</code>) only when you’re sure all senders are aligned.
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

