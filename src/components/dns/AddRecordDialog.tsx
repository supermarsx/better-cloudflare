/**
 * Dialog used to collect DNS record properties required to create a new
 * record via the API.
 */
import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { DNSRecord, RecordType, TTLValue } from "@/types/dns";
import { KNOWN_TLDS } from "@/lib/tlds";
import {
  parseTLSA,
  composeTLSA,
  parseSSHFP,
  composeSSHFP,
  parseNAPTR,
  composeNAPTR,
} from "@/lib/dns-parsers";
import { useCloudflareAPI } from "@/hooks/use-cloudflare-api";
import { useI18n } from "@/hooks/use-i18n";
import { RECORD_TYPES, getTTLPresets, getRecordTypeLabel } from "@/types/dns";
import { Plus } from "lucide-react";
import type { BuilderWarnings } from "@/components/dns/builders/types";
import { DsBuilder } from "@/components/dns/builders/DsBuilder";
import { DnskeyBuilder } from "@/components/dns/builders/DnskeyBuilder";
import { SrvBuilder } from "@/components/dns/builders/SrvBuilder";
import { CaaBuilder } from "@/components/dns/builders/CaaBuilder";
import { TxtBuilder } from "@/components/dns/builders/TxtBuilder";
import { SpfBuilder } from "@/components/dns/builders/SpfBuilder";

/**
 * Props for the AddRecordDialog component which collects fields to create a
 * new DNS record (type, name, content, ttl, etc.).
 */
export interface AddRecordDialogProps {
  /** Whether the dialog is currently open */
  open: boolean;
  /** Callback invoked when open state changes (open/close) */
  onOpenChange: (open: boolean) => void;
  /** Working DNS record object for the form */
  record: Partial<DNSRecord>;
  /** Called when fields in the form change with the updated record */
  onRecordChange: (record: Partial<DNSRecord>) => void;
  /** Called to create the new record */
  onAdd: () => void;
  /** Optional name of the zone to display in the dialog */
  zoneName?: string;
  apiKey?: string;
  email?: string;
}

/**
 * Dialog that collects fields to create a DNS record and forwards the
 * create action via `onAdd`.
 */
export function AddRecordDialog({
  open,
  onOpenChange,
  record,
  onRecordChange,
  onAdd,
  zoneName,
  apiKey,
  email,
}: AddRecordDialogProps) {
  const { t } = useI18n();
  const { simulateSPF, getSPFGraph } = useCloudflareAPI(apiKey, email);
  const ttlValue = record.ttl === 1 ? "auto" : record.ttl;
  const isCustomTTL =
    ttlValue !== undefined && !getTTLPresets().includes(ttlValue as TTLValue);

  const [confirmInvalid, setConfirmInvalid] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [activeBuilderWarnings, setActiveBuilderWarnings] = useState<BuilderWarnings>({
    issues: [],
    nameIssues: [],
  });
  const openSnapshotRef = useRef<Partial<DNSRecord> | null>(null);
  const wasOpenRef = useRef(false);
  
  const [tlsaUsage, setTlsaUsage] = useState<number | undefined>(
    parseTLSA(record.content).usage,
  );
  const [tlsaSelector, setTlsaSelector] = useState<number | undefined>(
    parseTLSA(record.content).selector,
  );
  const [tlsaMatchingType, setTlsaMatchingType] = useState<number | undefined>(
    parseTLSA(record.content).matchingType,
  );
  const [tlsaData, setTlsaData] = useState<string>(
    parseTLSA(record.content).data ?? "",
  );
  
  const [sshfpAlgorithm, setSshfpAlgorithm] = useState<number | undefined>(
    parseSSHFP(record.content).algorithm,
  );
  const [sshfpFptype, setSshfpFptype] = useState<number | undefined>(
    parseSSHFP(record.content).fptype,
  );
  const [sshfpFingerprint, setSshfpFingerprint] = useState<string>(
    parseSSHFP(record.content).fingerprint ?? "",
  );
  
  const [naptrOrder, setNaptrOrder] = useState<number | undefined>(
    parseNAPTR(record.content).order,
  );
  const [naptrPref, setNaptrPref] = useState<number | undefined>(
    parseNAPTR(record.content).preference,
  );
  const [naptrFlags, setNaptrFlags] = useState<string>(
    parseNAPTR(record.content).flags ?? "",
  );
  const [naptrService, setNaptrService] = useState<string>(
    parseNAPTR(record.content).service ?? "",
  );
  const [naptrRegexp, setNaptrRegexp] = useState<string>(
    parseNAPTR(record.content).regexp ?? "",
  );
  const [naptrReplacement, setNaptrReplacement] = useState<string>(
    parseNAPTR(record.content).replacement ?? "",
  );

  const [uriPriority, setUriPriority] = useState<number | undefined>(undefined);
  const [uriWeight, setUriWeight] = useState<number | undefined>(undefined);
  const [uriTarget, setUriTarget] = useState<string>("");
  const [uriTargetSpaceWarning, setUriTargetSpaceWarning] = useState(false);

  const [soaPrimaryNs, setSoaPrimaryNs] = useState<string>("");
  const [soaAdmin, setSoaAdmin] = useState<string>("");
  const [soaSerial, setSoaSerial] = useState<number | undefined>(undefined);
  const [soaRefresh, setSoaRefresh] = useState<number | undefined>(undefined);
  const [soaRetry, setSoaRetry] = useState<number | undefined>(undefined);
  const [soaExpire, setSoaExpire] = useState<number | undefined>(undefined);
  const [soaMinimum, setSoaMinimum] = useState<number | undefined>(undefined);

  function normalizeDnsName(value: string) {
    return value.trim().replace(/\.$/, "");
  }

  function escapeDnsQuotedString(value: string) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  function parseSOAContent(value: string | undefined) {
    const raw = (value ?? "")
      .replace(/[()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const parts = raw ? raw.split(" ").filter(Boolean) : [];
    const [mname, rname, serial, refresh, retry, expire, minimum] = parts;
    const toNum = (v: string | undefined) => {
      if (!v) return undefined;
      const n = Number.parseInt(v, 10);
      return Number.isNaN(n) ? undefined : n;
    };
    return {
      mname: mname ?? "",
      rname: rname ?? "",
      serial: toNum(serial),
      refresh: toNum(refresh),
      retry: toNum(retry),
      expire: toNum(expire),
      minimum: toNum(minimum),
      fieldCount: parts.length,
    };
  }

  function emailToRname(value: string) {
    const v = value.trim();
    if (!v) return "";
    if (v.includes("@")) {
      const [local, domain] = v.split("@");
      if (!domain) return normalizeDnsName(v.replace("@", "."));
      return normalizeDnsName(`${local}.${domain}`);
    }
    return normalizeDnsName(v);
  }

  function composeSOA(fields: {
    mname: string;
    rname: string;
    serial: number | undefined;
    refresh: number | undefined;
    retry: number | undefined;
    expire: number | undefined;
    minimum: number | undefined;
  }) {
    const parts = [
      normalizeDnsName(fields.mname),
      normalizeDnsName(fields.rname),
      fields.serial,
      fields.refresh,
      fields.retry,
      fields.expire,
      fields.minimum,
    ].map((p) => String(p ?? "").trim());

    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function parseURIContent(value: string | undefined) {
    const raw = (value ?? "").trim();
    if (!raw) return { priority: undefined, weight: undefined, target: "" };
    const parts = raw.split(/\s+/);
    const pr = Number.parseInt(parts[0] ?? "", 10);
    const wt = Number.parseInt(parts[1] ?? "", 10);
    const rest = raw.replace(/^\s*\S+\s+\S+\s+/, "");
    const trimmed = rest.trim();
    let target = trimmed;
    if (target.startsWith("\"") && target.endsWith("\"") && target.length >= 2) {
      target = target.slice(1, -1);
    }
    target = target.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
    return {
      priority: Number.isNaN(pr) ? undefined : pr,
      weight: Number.isNaN(wt) ? undefined : wt,
      target,
    };
  }

  function composeURI(fields: {
    priority: number | undefined;
    weight: number | undefined;
    target: string;
  }) {
    const pr = fields.priority ?? "";
    const wt = fields.weight ?? "";
    const target = `"${escapeDnsQuotedString(fields.target ?? "")}"`;
    return `${pr} ${wt} ${target}`.replace(/\s+/g, " ").trim();
  }

  useEffect(() => {
    if (record.type === "URI") {
      const parsed = parseURIContent(record.content);
      if (parsed.priority !== uriPriority) setUriPriority(parsed.priority);
      if (parsed.weight !== uriWeight) setUriWeight(parsed.weight);
      if (parsed.target !== uriTarget) setUriTarget(parsed.target);
    }
  }, [record.type, record.content, uriPriority, uriWeight, uriTarget]);

  useEffect(() => {
    if (record.type !== "SOA") return;
    const parsed = parseSOAContent(record.content);
    if (parsed.mname !== soaPrimaryNs) setSoaPrimaryNs(parsed.mname);
    if (!soaAdmin.includes("@") && parsed.rname !== soaAdmin)
      setSoaAdmin(parsed.rname);
    if (parsed.serial !== soaSerial) setSoaSerial(parsed.serial);
    if (parsed.refresh !== soaRefresh) setSoaRefresh(parsed.refresh);
    if (parsed.retry !== soaRetry) setSoaRetry(parsed.retry);
    if (parsed.expire !== soaExpire) setSoaExpire(parsed.expire);
    if (parsed.minimum !== soaMinimum) setSoaMinimum(parsed.minimum);
  }, [
    record.type,
    record.content,
    soaPrimaryNs,
    soaAdmin,
    soaSerial,
    soaRefresh,
    soaRetry,
    soaExpire,
    soaMinimum,
  ]);

  useEffect(() => {
    if (record.type === "TLSA") {
      const parsed = parseTLSA(record.content);
      if (parsed.usage !== tlsaUsage) setTlsaUsage(parsed.usage);
      if (parsed.selector !== tlsaSelector) setTlsaSelector(parsed.selector);
      if (parsed.matchingType !== tlsaMatchingType)
        setTlsaMatchingType(parsed.matchingType);
      if (parsed.data !== tlsaData) setTlsaData(parsed.data ?? "");
    }
    if (record.type === "SSHFP") {
      const parsed = parseSSHFP(record.content);
      if (parsed.algorithm !== sshfpAlgorithm)
        setSshfpAlgorithm(parsed.algorithm);
      if (parsed.fptype !== sshfpFptype) setSshfpFptype(parsed.fptype);
      if (parsed.fingerprint !== sshfpFingerprint)
        setSshfpFingerprint(parsed.fingerprint ?? "");
    }
    if (record.type === "NAPTR") {
      const parsed = parseNAPTR(record.content);
      if (parsed.order !== naptrOrder) setNaptrOrder(parsed.order);
      if (parsed.preference !== naptrPref) setNaptrPref(parsed.preference);
      if (parsed.flags !== naptrFlags) setNaptrFlags(parsed.flags ?? "");
      if (parsed.service !== naptrService)
        setNaptrService(parsed.service ?? "");
      if (parsed.regexp !== naptrRegexp) setNaptrRegexp(parsed.regexp ?? "");
      if (parsed.replacement !== naptrReplacement)
        setNaptrReplacement(parsed.replacement ?? "");
    }
    // SSHFP state managed similarly below
  }, [
    record.type,
    record.content,
    tlsaUsage,
    tlsaSelector,
    tlsaMatchingType,
    tlsaData,
    sshfpAlgorithm,
    sshfpFptype,
    sshfpFingerprint,
    naptrOrder,
    naptrPref,
    naptrFlags,
    naptrService,
    naptrRegexp,
    naptrReplacement,
  ]);

  useEffect(() => {
    if (record.type !== "SOA") return;
    const content = (record.content ?? "").trim();
    if (content) return;

    const zn = (zoneName ?? "").trim();
    const defaultMname = zn ? `ns1.${zn}` : "";
    const defaultRname = zn ? `hostmaster.${zn}` : "";
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const serial = Number(`${y}${m}${d}01`);

    setSoaPrimaryNs(defaultMname);
    setSoaAdmin(defaultRname);
    setSoaSerial(serial);
    setSoaRefresh(7200);
    setSoaRetry(3600);
    setSoaExpire(1209600);
    setSoaMinimum(3600);

    onRecordChange({
      ...record,
      name: record.name?.trim() ? record.name : "@",
      content: composeSOA({
        mname: defaultMname,
        rname: defaultRname,
        serial,
        refresh: 7200,
        retry: 3600,
        expire: 1209600,
        minimum: 3600,
      }),
    });
  }, [record.type, record.content, record.name, zoneName, onRecordChange]);

  /*
  // SPF/TXT helper state and builders (moved to builders/*)
  const parsedSPF = parseSPF(record.content);
  const [newSPFQualifier, setNewSPFQualifier] = useState<string>("");
  const [newSPFMechanism, setNewSPFMechanism] = useState<string>("ip4");
  const [newSPFValue, setNewSPFValue] = useState<string>("");
  const [editingSPFIndex, setEditingSPFIndex] = useState<number | null>(null);
  const [spfRedirect, setSpfRedirect] = useState<string>("");
  const [spfSimIp, setSpfSimIp] = useState<string>("");
  const [spfSimResult, setSpfSimResult] = useState<{
    result: string;
    reasons: string[];
    lookups: number;
  } | null>(null);
  const [spfGraph, setSpfGraph] = useState<SPFGraph | null>(null);
  const [spfGraphError, setSpfGraphError] = useState<string | null>(null);

  const [txtHelperMode, setTxtHelperMode] = useState<
    "auto" | "generic" | "spf" | "dkim" | "dmarc"
  >("auto");
  const [dmarcPolicy, setDmarcPolicy] = useState<
    "none" | "quarantine" | "reject"
  >("none");
  const [dmarcRua, setDmarcRua] = useState<string>("");
  const [dmarcRuf, setDmarcRuf] = useState<string>("");
  const [dmarcPct, setDmarcPct] = useState<number | undefined>(undefined);
  const [dmarcAdkim, setDmarcAdkim] = useState<"r" | "s">("r");
  const [dmarcAspf, setDmarcAspf] = useState<"r" | "s">("r");
  const [dmarcSubdomainPolicy, setDmarcSubdomainPolicy] = useState<
    "" | "none" | "quarantine" | "reject"
  >("");
  const [dmarcFo, setDmarcFo] = useState<string>("");
  const [dmarcRi, setDmarcRi] = useState<number | undefined>(undefined);
  const [dmarcRf, setDmarcRf] = useState<string>("");
  const [dkimKeyType, setDkimKeyType] = useState<"rsa" | "ed25519">("rsa");
  const [dkimSelector, setDkimSelector] = useState<string>("");
  const [dkimPublicKey, setDkimPublicKey] = useState<string>("");
  const [dkimTestMode, setDkimTestMode] = useState(false);
  const [dkimStrictMode, setDkimStrictMode] = useState(false);
  const [dkimServiceType, setDkimServiceType] = useState<string>("");
  const [dkimHashAlgs, setDkimHashAlgs] = useState<string>("");
  const [dkimGranularity, setDkimGranularity] = useState<string>("");
  const [dkimNotes, setDkimNotes] = useState<string>("");

  const dkimHashPreset = useMemo(() => {
    const normalized = dkimHashAlgs.trim().toLowerCase();
    if (!normalized) return "omit";
    if (normalized === "sha256") return "sha256";
    if (normalized === "sha1") return "sha1";
    if (normalized === "sha1:sha256") return "sha1:sha256";
    if (normalized === "sha256:sha1") return "sha256:sha1";
    return "custom";
  }, [dkimHashAlgs]);

  const effectiveTxtMode = useMemo(() => {
    if (record.type !== "TXT") return "generic" as const;
    if (txtHelperMode !== "auto") return txtHelperMode;
    const content = (record.content ?? "").trim();
    if (content.toLowerCase().startsWith("v=spf1")) return "spf" as const;
    if (content.toLowerCase().startsWith("v=dmarc1")) return "dmarc" as const;
    if (content.toLowerCase().startsWith("v=dkim1")) return "dkim" as const;
    return "generic" as const;
  }, [record.type, record.content, txtHelperMode]);

  const spfDiagnostics = useMemo(() => {
    if (record.type !== "TXT" || effectiveTxtMode !== "spf") {
      return {
        canonical: "",
        issues: [] as string[],
        lookupEstimate: 0,
        hasAll: false,
        allQualifier: "" as "" | "+" | "-" | "~" | "?",
        hasRedirect: false,
      };
    }

    const issues: string[] = [];
    const push = (msg: string) => {
      if (!issues.includes(msg)) issues.push(msg);
    };

    const spf = parseSPF(record.content);
    if (!spf) {
      push("SPF: missing v=spf1 prefix.");
      return {
        canonical: (record.content ?? "").trim(),
        issues,
        lookupEstimate: 0,
        hasAll: false,
        allQualifier: "",
        hasRedirect: false,
      };
    }

    const canonical = composeSPF(spf);

    const hasMacro = (value: string) => /%[{_%\-]/.test(value) || value.includes("%");
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
      const labels = v.split(".");
      if (labels.some((l) => l.length === 0)) return false;
      return labels.every(isValidDnsLabel);
    };
    const tldOf = (value: string) => {
      const v = normalizeDnsName(value).toLowerCase();
      if (!v.includes(".")) return null;
      const tld = v.split(".").pop();
      return tld && /^[a-z0-9-]{2,63}$/.test(tld) ? tld : null;
    };
    const validateDomainSpec = (value: string, context: string) => {
      if (!value) return;
      if (hasMacro(value)) {
        push(`SPF: ${context} contains macros; verify macro syntax.`);
        return;
      }
      if (!isValidHostname(value)) {
        push(`SPF: ${context} does not look like a valid hostname.`);
        return;
      }
      const tld = tldOf(value);
      if (tld && !KNOWN_TLDS.has(tld)) {
        push(`SPF: ${context} has unknown/invalid TLD “.${tld}”.`);
      }
    };

    const parseDomainWithCidrs = (value: string) => {
      const [domainPart, rest] = value.split("/");
      if (rest === undefined) return { domain: value, v4: undefined, v6: undefined };
      // support domain/24//64 (RFC 7208)
      const v4 = Number.parseInt(rest, 10);
      const v6Match = value.match(/\/\/(\d{1,3})$/);
      const v6 = v6Match ? Number.parseInt(v6Match[1], 10) : undefined;
      const domain = domainPart;
      return {
        domain,
        v4: Number.isNaN(v4) ? undefined : v4,
        v6: Number.isNaN(v6 ?? Number.NaN) ? undefined : v6,
      };
    };

    const parseIPv4 = (value: string) => {
      const parts = value.split(".");
      if (parts.length !== 4) return null;
      const nums = parts.map((p) => Number(p));
      if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
      return nums as [number, number, number, number];
    };

    const isValidIPv4Cidr = (value: string) => {
      const [addr, prefixRaw] = value.split("/");
      if (!parseIPv4(addr)) return false;
      if (prefixRaw === undefined) return true;
      if (!/^\d{1,2}$/.test(prefixRaw)) return false;
      const p = Number(prefixRaw);
      return p >= 0 && p <= 32;
    };

    const normalizeIPv6ForSpf = (value: string) => {
      const input = value.trim().toLowerCase();
      if (!input.includes(":")) return null;
      if (!/^[0-9a-f:]+$/.test(input)) return null;
      const double = input.includes("::");
      if (double && input.indexOf("::") !== input.lastIndexOf("::")) return null;
      const [leftRaw, rightRaw] = input.split("::");
      const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
      const right = double && rightRaw ? rightRaw.split(":").filter(Boolean) : [];
      const leftNums = left.map((g) => Number.parseInt(g, 16));
      const rightNums = right.map((g) => Number.parseInt(g, 16));
      if (
        leftNums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ||
        rightNums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)
      )
        return null;
      const total = leftNums.length + rightNums.length;
      if (!double && total !== 8) return null;
      if (double && total > 8) return null;
      const fill = double ? new Array(8 - total).fill(0) : [];
      return [...leftNums, ...fill, ...rightNums];
    };

    const isValidIPv6Cidr = (value: string) => {
      const [addr, prefixRaw] = value.split("/");
      if (!normalizeIPv6ForSpf(addr)) return false;
      if (prefixRaw === undefined) return true;
      if (!/^\d{1,3}$/.test(prefixRaw)) return false;
      const p = Number(prefixRaw);
      return p >= 0 && p <= 128;
    };

    let hasAll = false;
    let allQualifier: "" | "+" | "-" | "~" | "?" = "";
    let allIndex = -1;
    const mechCounts = new Map<string, number>();

    for (let i = 0; i < spf.mechanisms.length; i++) {
      const m = spf.mechanisms[i];
      mechCounts.set(m.mechanism, (mechCounts.get(m.mechanism) ?? 0) + 1);
      const qual = (m.qualifier ?? "+") as "+" | "-" | "~" | "?";

      if (!["all", "a", "mx", "ip4", "ip6", "include", "ptr", "exists"].includes(m.mechanism)) {
        push(`SPF: unknown mechanism "${m.mechanism}".`);
      }

      if (m.mechanism === "all") {
        hasAll = true;
        allQualifier = qual;
        allIndex = i;
        if (m.value) push("SPF: all mechanism must not have a value.");
        if (qual === "+") push("SPF: +all is extremely permissive (allows anyone).");
      }

      if (m.mechanism === "ptr") {
        push("SPF: ptr is discouraged (slow/fragile and can exceed lookup limits).");
      }

      if (m.mechanism === "ip4") {
        if (!m.value) push("SPF: ip4 requires a value like 192.0.2.0/24.");
        else if (!isValidIPv4Cidr(m.value))
          push("SPF: ip4 value must be a valid IPv4 address or CIDR (e.g., 192.0.2.0/24).");
      }

      if (m.mechanism === "ip6") {
        if (!m.value) push("SPF: ip6 requires a value like 2001:db8::/32.");
        else if (!isValidIPv6Cidr(m.value))
          push("SPF: ip6 value must be a valid IPv6 address or CIDR (e.g., 2001:db8::/32).");
      }

      if (m.mechanism === "include") {
        if (!m.value) push("SPF: include requires a domain (include:example.com).");
        else validateDomainSpec(m.value, "include domain");
      }

      if (m.mechanism === "exists") {
        if (!m.value) push("SPF: exists requires a domain (exists:example.com).");
        else validateDomainSpec(m.value, "exists domain");
      }

      if (m.mechanism === "a" || m.mechanism === "mx" || m.mechanism === "ptr") {
        if (m.value) {
          const parsedVal = parseDomainWithCidrs(m.value);
          validateDomainSpec(parsedVal.domain, `${m.mechanism} domain`);
          if (parsedVal.v4 !== undefined && (parsedVal.v4 < 0 || parsedVal.v4 > 32))
            push(`SPF: ${m.mechanism} IPv4 cidr-length must be 0–32.`);
          if (parsedVal.v6 !== undefined && (parsedVal.v6 < 0 || parsedVal.v6 > 128))
            push(`SPF: ${m.mechanism} IPv6 cidr-length must be 0–128.`);
        }
      }
    }

    if (mechCounts.get("all") && (mechCounts.get("all") ?? 0) > 1) {
      push("SPF: multiple all mechanisms found.");
    }

    const redirect = spf.modifiers?.find((m) => m.key === "redirect")?.value ?? "";
    const exp = spf.modifiers?.find((m) => m.key === "exp")?.value ?? "";
    const hasRedirect = Boolean(redirect);
    if (spf.modifiers) {
      const redirectCount = spf.modifiers.filter((m) => m.key === "redirect").length;
      if (redirectCount > 1) push("SPF: only one redirect modifier is allowed.");
    }
    if (redirect) validateDomainSpec(redirect, "redirect domain");
    if (exp) validateDomainSpec(exp, "exp domain");

    if (hasAll && allIndex !== spf.mechanisms.length - 1) {
      push("SPF: all should usually be the last mechanism.");
    }

    if (!hasAll && !hasRedirect) {
      push("SPF: no all mechanism or redirect= modifier (record may be incomplete).");
    }

    if (hasRedirect && hasAll) {
      push("SPF: redirect= will never be used if an all mechanism is present.");
    }

    // Rough DNS lookup estimate (RFC 7208 limit: 10)
    const lookupMechs = new Set(["a", "mx", "ptr", "include", "exists"]);
    const lookupEstimate =
      spf.mechanisms.filter((m) => lookupMechs.has(m.mechanism)).length +
      (redirect ? 1 : 0) +
      (exp ? 1 : 0);
    if (lookupEstimate > 10) {
      push(`SPF: estimated DNS lookups ${lookupEstimate}/10 (may cause permerror).`);
    }

    return { canonical, issues, lookupEstimate, hasAll, allQualifier, hasRedirect };
  }, [effectiveTxtMode, record.content, record.type]);

  useEffect(() => {
    if (record.type !== "TXT" || effectiveTxtMode !== "spf") return;
    const spf = parseSPF(record.content);
    const redirect = spf?.modifiers?.find((m) => m.key === "redirect")?.value ?? "";
    if (redirect !== spfRedirect) setSpfRedirect(redirect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, effectiveTxtMode, record.content]);

  useEffect(() => {
    if (record.type !== "TXT" || effectiveTxtMode !== "dkim") return;
    const parsed = parseDKIM(record.content);
    if (parsed.keyType !== dkimKeyType) setDkimKeyType(parsed.keyType);
    if (parsed.publicKey !== dkimPublicKey) setDkimPublicKey(parsed.publicKey);
    if (parsed.testMode !== dkimTestMode) setDkimTestMode(parsed.testMode);
    if (parsed.strictMode !== dkimStrictMode) setDkimStrictMode(parsed.strictMode);
    if (parsed.serviceType !== dkimServiceType) setDkimServiceType(parsed.serviceType);
    if (parsed.hashAlgs !== dkimHashAlgs) setDkimHashAlgs(parsed.hashAlgs);
    if (parsed.granularity !== dkimGranularity) setDkimGranularity(parsed.granularity);
    if (parsed.notes !== dkimNotes) setDkimNotes(parsed.notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, effectiveTxtMode, record.content]);

  useEffect(() => {
    if (record.type !== "TXT" || effectiveTxtMode !== "dkim") return;
    if (dkimSelector.trim()) return;
    const name = (record.name ?? "").trim();
    const m = /^(.+)\._domainkey$/i.exec(name);
    if (m?.[1]) setDkimSelector(m[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, effectiveTxtMode, record.name]);

  useEffect(() => {
    if (record.type !== "TXT" || effectiveTxtMode !== "dmarc") return;
    const parsed = parseDMARC(record.content);
    if (parsed.policy !== dmarcPolicy) setDmarcPolicy(parsed.policy);
    if (parsed.rua !== dmarcRua) setDmarcRua(parsed.rua);
    if (parsed.ruf !== dmarcRuf) setDmarcRuf(parsed.ruf);
    if (parsed.pct !== dmarcPct) setDmarcPct(parsed.pct);
    if (parsed.adkim !== dmarcAdkim) setDmarcAdkim(parsed.adkim);
    if (parsed.aspf !== dmarcAspf) setDmarcAspf(parsed.aspf);
    if (parsed.subdomainPolicy !== dmarcSubdomainPolicy)
      setDmarcSubdomainPolicy(parsed.subdomainPolicy);
    if (parsed.fo !== dmarcFo) setDmarcFo(parsed.fo);
    if (parsed.rf !== dmarcRf) setDmarcRf(parsed.rf);
    if (parsed.ri !== dmarcRi) setDmarcRi(parsed.ri);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, effectiveTxtMode, record.content]);

  const validateDKIM = useCallback((value: string) => {
    const problems: string[] = [];
    const content = value.trim();
    if (!content) return { ok: true, problems };
    if (!/^v=DKIM1\b/i.test(content)) {
      problems.push("Missing v=DKIM1.");
      return { ok: false, problems };
    }
    if (/-----BEGIN\b/i.test(content)) {
      problems.push("p= looks like it includes a PEM header/footer (use base64 only).");
    }
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
      if (count > 1) problems.push(`Duplicate DKIM tag: ${k}=`);
    }
    const allowedTags = new Set(["v", "k", "p", "t", "n", "s", "h", "g"]);
    for (const k of map.keys()) {
      if (!allowedTags.has(k)) problems.push(`Unknown DKIM tag: ${k}=`);
    }
    const p = map.get("p");
    if (p === undefined) {
      problems.push("Missing p= (public key).");
    } else {
      const pk = p.replace(/\s+/g, "");
      if (pk.length > 0 && !/^[A-Za-z0-9+/=]+$/.test(pk))
        problems.push("p= contains non-base64 characters.");
      if (pk.length > 0 && pk.length % 4 !== 0)
        problems.push("p= base64 length is unusual (not a multiple of 4).");
      if (pk.length === 0)
        problems.push("p= is empty (revoked key). This may be intentional.");
      if (pk.length > 255)
        problems.push(
          "p= is longer than 255 chars; some providers require splitting TXT strings.",
        );
    }
    const k = map.get("k");
    if (!k) problems.push("Missing k= (defaults to rsa, but most providers publish it).");
    else if (!["rsa", "ed25519"].includes(k.toLowerCase()))
      problems.push("k= is usually rsa or ed25519.");
    const v = map.get("v");
    if (v && v.toUpperCase() !== "DKIM1") problems.push("v= should be DKIM1.");
    const t = map.get("t");
    if (t) {
      const flags = t.split(":").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const allowed = new Set(["y", "s"]);
      for (const f of flags) if (!allowed.has(f)) problems.push(`Unknown t= flag: ${f}`);
    }
    const s = map.get("s");
    if (s && !["*", "email"].includes(s.trim().toLowerCase()))
      problems.push("s= is usually '*' or 'email'.");
    const h = map.get("h");
    if (h) {
      const parts = h.split(":").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const allowed = new Set(["sha1", "sha256"]);
      for (const alg of parts) if (!allowed.has(alg)) problems.push(`Unknown h= algorithm: ${alg}`);
    }
    const g = map.get("g");
    if (g) {
      if (/\s/.test(g)) problems.push("g= contains whitespace.");
      if (g.includes("@")) problems.push("g= should be a local-part pattern (no @domain).");
    }
    return { ok: problems.length === 0, problems };
  }, []);

  const parseDKIM = useCallback((value: string | undefined) => {
    const content = (value ?? "").trim();
    if (!content.toLowerCase().startsWith("v=dkim1")) {
      return {
        tags: new Map<string, string>(),
        keyType: "rsa" as const,
        publicKey: "",
        testMode: false,
        strictMode: false,
        serviceType: "",
        hashAlgs: "",
        granularity: "",
        notes: "",
      };
    }
    const parts = content
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const tags = new Map<string, string>();
    for (const part of parts) {
      const [kRaw, ...rest] = part.split("=");
      const k = (kRaw ?? "").trim().toLowerCase();
      if (!k) continue;
      const v = rest.join("=").trim();
      tags.set(k, v);
    }
    const keyType = (tags.get("k")?.toLowerCase() === "ed25519"
      ? "ed25519"
      : "rsa") as "rsa" | "ed25519";
    const publicKey = tags.get("p") ?? "";
    const t = tags.get("t") ?? "";
    const flags = t.split(":").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const testMode = flags.includes("y");
    const strictMode = flags.includes("s");
    const notes = tags.get("n") ?? "";
    const serviceType = tags.get("s") ?? "";
    const hashAlgs = tags.get("h") ?? "";
    const granularity = tags.get("g") ?? "";
    return {
      tags,
      keyType,
      publicKey,
      testMode,
      strictMode,
      serviceType,
      hashAlgs,
      granularity,
      notes,
    };
  }, []);

  const buildDKIM = useCallback(
    (fields: {
      keyType: "rsa" | "ed25519";
      publicKey: string;
      testMode: boolean;
      strictMode: boolean;
      serviceType: string;
      hashAlgs: string;
      granularity: string;
      notes: string;
    }) => {
      const tags: string[] = ["v=DKIM1"];
      if (fields.keyType) tags.push(`k=${fields.keyType}`);
      tags.push(`p=${fields.publicKey.trim().replace(/\s+/g, "")}`);
      const tFlags: string[] = [];
      if (fields.testMode) tFlags.push("y");
      if (fields.strictMode) tFlags.push("s");
      if (tFlags.length) tags.push(`t=${tFlags.join(":")}`);
      if (fields.serviceType.trim()) tags.push(`s=${fields.serviceType.trim()}`);
      if (fields.hashAlgs.trim()) tags.push(`h=${fields.hashAlgs.trim()}`);
      if (fields.granularity.trim()) tags.push(`g=${fields.granularity.trim()}`);
      if (fields.notes.trim()) tags.push(`n=${fields.notes.trim()}`);
      return tags.join("; ") + ";";
    },
    [],
  );

  const dkimDiagnostics = useMemo(() => {
    if (record.type !== "TXT" || effectiveTxtMode !== "dkim") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }
    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const content = (record.content ?? "").trim();
    if (!content) {
      push(issues, "DKIM: content is empty.");
    } else {
      const v = validateDKIM(content);
      for (const p of v.problems) push(issues, `DKIM: ${p}`);
      if (!content.endsWith(";"))
        push(issues, "DKIM: consider ending tags with ';' for readability.");
    }

    const selector = dkimSelector.trim();
    const name = (record.name ?? "").trim();
    if (!selector) {
      push(nameIssues, "DKIM: selector is missing.");
    } else {
      const expected = `${selector}._domainkey`;
      if (name && name !== expected) {
        push(
          nameIssues,
          `DKIM: name is usually "${expected}" for selector "${selector}".`,
        );
      }
      if (!/^[A-Za-z0-9-_]+$/.test(selector))
        push(nameIssues, "DKIM: selector contains unusual characters.");
    }

    const pk = dkimPublicKey.trim().replace(/\s+/g, "");
    if (dkimKeyType === "ed25519" && pk) {
      // 32 bytes => 44 base64 chars (incl padding) is common; warn if wildly off.
      if (pk.length < 40 || pk.length > 64) {
        push(
          issues,
          "DKIM: ed25519 p= length looks unusual (expected ~44 base64 chars).",
        );
      }
    }
    if (dkimKeyType === "rsa" && pk) {
      if (pk.length < 200) push(issues, "DKIM: rsa p= looks unusually short.");
    }

    const canonical = buildDKIM({
      keyType: dkimKeyType,
      publicKey: dkimPublicKey,
      testMode: dkimTestMode,
      strictMode: dkimStrictMode,
      serviceType: dkimServiceType,
      hashAlgs: dkimHashAlgs,
      granularity: dkimGranularity,
      notes: dkimNotes,
    });

    return { canonical, issues, nameIssues };
  }, [
    buildDKIM,
    dkimGranularity,
    dkimHashAlgs,
    dkimKeyType,
    dkimNotes,
    dkimPublicKey,
    dkimSelector,
    dkimServiceType,
    dkimStrictMode,
    dkimTestMode,
    effectiveTxtMode,
    record.content,
    record.name,
    record.type,
    validateDKIM,
  ]);

  const validateDMARC = useCallback((value: string) => {
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
    const parseMailtoList = (raw: string, label: "rua" | "ruf") => {
      const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const uriRaw of parts) {
        const uri = uriRaw.split("!")[0]?.trim() ?? "";
        if (!uri.toLowerCase().startsWith("mailto:")) {
          problems.push(`${label}= URIs should start with mailto:.`);
          continue;
        }
        const after = uri.slice("mailto:".length);
        const addr = after.split("?")[0]?.trim() ?? "";
        validateEmailAddress(addr, label);
      }
    };
    const rua = map.get("rua");
    if (rua) parseMailtoList(rua, "rua");
    const ruf = map.get("ruf");
    if (ruf) parseMailtoList(ruf, "ruf");
    const pct = map.get("pct");
    if (pct) {
      const n = Number.parseInt(pct, 10);
      if (Number.isNaN(n) || n < 0 || n > 100)
        problems.push("pct= should be 0–100.");
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
  }, []);

  const parseDMARC = useCallback((value: string | undefined) => {
    const content = (value ?? "").trim();
    if (!content.toLowerCase().startsWith("v=dmarc1")) {
      return {
        tags: new Map<string, string>(),
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
    const policy = (["none", "quarantine", "reject"].includes(policyRaw)
      ? policyRaw
      : "none") as "none" | "quarantine" | "reject";
    const spRaw = (map.get("sp") ?? "").toLowerCase();
    const subdomainPolicy = (["none", "quarantine", "reject"].includes(spRaw)
      ? spRaw
      : "") as "" | "none" | "quarantine" | "reject";
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
    return {
      tags: map,
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
    };
  }, []);

  const buildDMARC = useCallback(
    (fields: {
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
    }) => {
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
    },
    [],
  );

  const dmarcDiagnostics = useMemo(() => {
    if (record.type !== "TXT" || effectiveTxtMode !== "dmarc") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }
    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const canonical = buildDMARC({
      policy: dmarcPolicy,
      rua: dmarcRua,
      ruf: dmarcRuf,
      pct: dmarcPct,
      adkim: dmarcAdkim,
      aspf: dmarcAspf,
      subdomainPolicy: dmarcSubdomainPolicy,
      fo: dmarcFo,
      rf: dmarcRf,
      ri: dmarcRi,
    });

    const name = (record.name ?? "").trim();
    if (!name) {
      push(nameIssues, 'DMARC: name is usually "_dmarc".');
    } else if (name !== "_dmarc") {
      push(nameIssues, 'DMARC: name is usually "_dmarc".');
    }

    const content = (record.content ?? "").trim();
    if (!content) {
      push(issues, "DMARC: content is empty.");
    } else {
      const v = validateDMARC(content);
      for (const p of v.problems) push(issues, `DMARC: ${p}`);
      if (!content.endsWith(";"))
        push(issues, "DMARC: consider ending tags with ';' for readability.");
    }

    if (!content || content !== canonical) {
      const v = validateDMARC(canonical);
      for (const p of v.problems) push(issues, `DMARC: ${p}`);
    }

    if (content && content !== canonical) {
      push(
        issues,
        "DMARC: content differs from the builder settings (use Apply canonical to normalize).",
      );
    }
    if (!dmarcRua.trim()) {
      push(
        issues,
        "DMARC: rua= is missing (recommended to receive aggregate reports).",
      );
    }

    return { canonical, issues, nameIssues };
  }, [
    buildDMARC,
    dmarcAdkim,
    dmarcAspf,
    dmarcFo,
    dmarcPct,
    dmarcPolicy,
    dmarcRf,
    dmarcRi,
    dmarcRua,
    dmarcRuf,
    dmarcSubdomainPolicy,
    effectiveTxtMode,
    record.content,
    record.name,
    record.type,
    validateDMARC,
  ]);

  const addSPFMechanism = () => {
    const mechVal = newSPFValue?.trim();
    const newMech: SPFMechanism = {
      qualifier: newSPFQualifier || undefined,
      mechanism: newSPFMechanism,
      value: mechVal || undefined,
    };
    const parsed = parseSPF(record.content) ?? {
      version: "v=spf1",
      mechanisms: [],
    };
    const mechs = [...parsed.mechanisms];
    if (
      editingSPFIndex !== null &&
      editingSPFIndex >= 0 &&
      editingSPFIndex < mechs.length
    ) {
      mechs[editingSPFIndex] = newMech;
      setEditingSPFIndex(null);
    } else {
      mechs.push(newMech);
    }
    const updated = composeSPF({
      version: parsed.version,
      mechanisms: mechs as SPFMechanism[],
    });
    onRecordChange({ ...record, content: updated });
    // reset form
    setNewSPFValue("");
    setNewSPFQualifier("");
    setNewSPFMechanism("ip4");
  };

  const removeSPFMechanism = (index: number) => {
    const parsed = parseSPF(record.content) ?? {
      version: "v=spf1",
      mechanisms: [],
    };
    const mechs = [...parsed.mechanisms];
    mechs.splice(index, 1);
    const updated = composeSPF({
      version: parsed.version,
      mechanisms: mechs as SPFMechanism[],
    });
    onRecordChange({ ...record, content: updated });
  };

  const editSPFMechanism = (index: number) => {
    const parsed = parseSPF(record.content) ?? {
      version: "v=spf1",
      mechanisms: [],
    };
    const m = parsed.mechanisms[index];
    setNewSPFQualifier(m.qualifier || "");
    setNewSPFMechanism(m.mechanism || "ip4");
    setNewSPFValue(m.value || "");
    setEditingSPFIndex(index);
  };
  */

  const recordGuide = useMemo(() => {
    const type = record.type;
    if (!type) return null;
    switch (type) {
      case "A":
        return "IPv4 address (e.g., 192.0.2.10).";
      case "AAAA":
        return "IPv6 address (e.g., 2001:db8::1).";
      case "CNAME":
        return "Target hostname (no http://, no path).";
      case "MX":
        return "Mail server hostname; set Priority below (lower = higher priority).";
      case "TXT":
        return "Text value (SPF/DKIM/etc). Newlines are unusual; quotes are optional.";
      case "NS":
        return "Authoritative nameserver hostname.";
      case "PTR":
        return "Target hostname (usually for reverse DNS).";
      case "SRV":
        return "priority / weight / port / target. Name usually looks like _service._proto.";
      case "TLSA":
        return "usage / selector / matchingType / data (hex).";
      case "SSHFP":
        return "algorithm / fptype / fingerprint (hex).";
      case "NAPTR":
        return "order / preference / flags / service / regexp / replacement.";
      case "CAA":
        return "Typically: flags tag \"value\" (e.g., 0 issue \"letsencrypt.org\").";
      case "URI":
        return "Typically: priority weight \"target\" (RFC 7553).";
      case "HTTPS":
      case "SVCB":
        return "Service binding record (complex); double-check params.";
      case "SOA":
        return "Start of authority: primary NS, admin email (as DNS name), serial, refresh/retry/expire/minimum.";
      case "SPF":
        return "SPF content (v=spf1 ...). Use the helper below if needed.";
      default:
        return "Record content is not strongly validated; double-check syntax.";
    }
  }, [record.type]);

  const namePlaceholder = useMemo(() => {
    const type = record.type;
    if (!type) return "e.g., www or @ for root";
    switch (type) {
      case "A":
      case "AAAA":
      case "CNAME":
      case "TXT":
      case "MX":
      case "NS":
      case "PTR":
      case "CAA":
      case "URI":
      case "SVCB":
      case "HTTPS":
      case "ALIAS":
      case "ANAME":
        return "e.g., www or @ for root";
      case "SRV":
        return "e.g., _sip._tcp";
      case "TLSA":
        return "e.g., _443._tcp";
      case "SSHFP":
        return "e.g., host or @";
      case "HINFO":
        return "e.g., host or @";
      case "LOC":
        return "e.g., office or @";
      case "SPF":
        return "e.g., @ (apex)";
      case "DS":
      case "DNSKEY":
      case "CDNSKEY":
      case "RRSIG":
      case "NSEC":
      case "SOA":
        return "e.g., @";
      case "NAPTR":
        return "e.g., @ or _sip._udp";
      case "RP":
        return "e.g., @ or host";
      case "DNAME":
        return "e.g., alias";
      case "CERT":
        return "e.g., host";
      case "AFSDB":
        return "e.g., afs";
      case "APL":
        return "e.g., @";
      case "DCHID":
        return "e.g., @";
      case "HIP":
        return "e.g., host";
      case "IPSECKEY":
        return "e.g., host";
      default:
        return "e.g., www or @ for root";
    }
  }, [record.type]);

  const nameHint = useMemo(() => {
    const type = record.type;
    if (!type) return null;
    switch (type) {
      case "SRV":
        return "SRV names usually look like _service._proto (e.g., _sip._tcp).";
      case "TLSA":
        return "TLSA names are often _port._proto (e.g., _443._tcp).";
      case "MX":
        return "MX is commonly set at @ (apex) or a subdomain like mail.";
      case "URI":
        return "URI names are often _service._proto (e.g., _sip._tcp), depending on the application.";
      case "SOA":
        return "SOA is typically @ (zone apex).";
      case "DS":
      case "DNSKEY":
      case "CDNSKEY":
        return "DNSSEC records: DS is for delegating a child zone (name is usually the child label); DNSKEY/CDNSKEY are typically @.";
      case "CAA":
        return "CAA is commonly set at @ (apex) and/or subdomains.";
      case "SPF":
        return "SPF is typically published as a TXT record at @; SPF type exists but TXT is more common.";
      default:
        return null;
    }
  }, [record.type]);

  const contentPlaceholder = useMemo(() => {
    const type = record.type;
    if (!type) return "e.g., 192.0.2.10";
    switch (type) {
      case "A":
        return "e.g., 192.0.2.10";
      case "AAAA":
        return "e.g., 2001:db8::1";
      case "CNAME":
        return "e.g., target.example.com";
      case "MX":
        return "e.g., mail.example.com";
      case "TXT":
        return 'e.g., "v=spf1 include:_spf.example.com ~all"';
      case "NS":
        return "e.g., ns1.example.com";
      case "PTR":
        return "e.g., host.example.com";
      case "CAA":
        return 'e.g., 0 issue "letsencrypt.org"';
      case "DS":
        return "e.g., 2371 13 2 <digest>";
      case "DNSKEY":
        return "e.g., 257 3 13 <public key>";
      case "CDNSKEY":
        return "e.g., 257 3 13 <public key>";
      case "HINFO":
        return 'e.g., "CPU" "OS"';
      case "LOC":
        return 'e.g., 37 47 0.000 N 122 24 0.000 W 10m 1m 100m 10m';
      case "RP":
        return "e.g., mailbox.example.com text.example.com";
      case "DNAME":
        return "e.g., target.example.com";
      case "CERT":
        return "e.g., 1 0 0 <base64>";
      case "AFSDB":
        return "e.g., 1 afsdb.example.com";
      case "APL":
        return "e.g., 1:192.0.2.0/24";
      case "DCHID":
        return "e.g., <hex>";
      case "HIP":
        return "e.g., 2 200100107B1A74DF365639CC39F1D578 <pk> <rvs>";
      case "IPSECKEY":
        return "e.g., 10 0 2 192.0.2.1 <key>";
      case "NSEC":
        return "e.g., next.example.com A AAAA RRSIG";
      case "RRSIG":
        return "e.g., A 13 2 3600 ... <signature>";
      case "SOA":
        return "e.g., ns1.example.com hostmaster.example.com 1 7200 3600 1209600 3600";
      case "SVCB":
        return "e.g., 1 svc.example.com alpn=h2";
      case "HTTPS":
        return "e.g., 1 . alpn=h2,h3";
      case "URI":
        return 'e.g., 10 1 "https://example.com/path"';
      case "ALIAS":
      case "ANAME":
        return "e.g., target.example.com";
      case "SPF":
        return "e.g., v=spf1 include:_spf.example.com ~all";
      case "SRV":
        return "e.g., 10 5 5060 sipserver.example.com";
      case "TLSA":
        return "e.g., 3 1 1 <hex>";
      case "SSHFP":
        return "e.g., 4 2 <hex>";
      case "NAPTR":
        return 'e.g., 100 10 "u" "E2U+sip" "!^.*$!sip:info@example.com!" .';
      default:
        return "Enter record content…";
    }
  }, [record.type]);

  const soaValidation = useMemo(() => {
    if (record.type !== "SOA") {
      return {
        issues: [] as string[],
        fieldIssues: {} as Record<
          | "mname"
          | "rname"
          | "serial"
          | "refresh"
          | "retry"
          | "expire"
          | "minimum",
          string[]
        >,
      };
    }

    const pushUnique = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const fieldIssues: Record<
      "mname" | "rname" | "serial" | "refresh" | "retry" | "expire" | "minimum",
      string[]
    > = {
      mname: [],
      rname: [],
      serial: [],
      refresh: [],
      retry: [],
      expire: [],
      minimum: [],
    };

    const issues: string[] = [];
    const parsed = parseSOAContent(record.content);
    const soaName = (record.name ?? "").trim();

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
      if (v.length > 253) return false;
      if (/\s/.test(v)) return false;
      if (v.includes("://") || v.includes("/")) return false;
      const labels = v.split(".");
      if (labels.some((l) => l.length === 0)) return false;
      return labels.every(isValidDnsLabel);
    };

    if (parsed.fieldCount !== 7) {
      pushUnique(
        issues,
        "SOA content should have 7 fields: mname rname serial refresh retry expire minimum.",
      );
    }

    if (soaName && soaName !== "@") {
      pushUnique(
        issues,
        "SOA name is typically @ (zone apex); other names are unusual.",
      );
    }

    if (!parsed.mname) {
      pushUnique(fieldIssues.mname, "Primary NS (mname) is required.");
    } else {
      if (!isValidHostname(parsed.mname)) {
        pushUnique(fieldIssues.mname, "mname must be a valid hostname.");
      }
      if (!normalizeDnsName(parsed.mname).includes(".")) {
        pushUnique(
          fieldIssues.mname,
          "mname should usually be a FQDN (contain at least one dot).",
        );
      }
      if (normalizeDnsName(parsed.mname).includes("_")) {
        pushUnique(fieldIssues.mname, "mname should not contain underscores.");
      }
    }

    if (!parsed.rname) {
      pushUnique(fieldIssues.rname, "Admin (rname) is required.");
    } else {
      const r = normalizeDnsName(parsed.rname);
      if (r.includes("@")) {
        pushUnique(fieldIssues.rname, "rname must not contain @ (use DNS-name form).");
      }
      if (!isValidHostname(r)) {
        pushUnique(
          fieldIssues.rname,
          "rname must be a valid DNS name (represents an email address).",
        );
      }
      if (!r.includes(".")) {
        pushUnique(
          fieldIssues.rname,
          "rname should usually contain a dot (like hostmaster.example.com).",
        );
      }
    }

    const validateUint32 = (n: number | undefined, label: keyof typeof fieldIssues) => {
      if (n === undefined) {
        pushUnique(fieldIssues[label], `${label} is required and must be a number.`);
        return;
      }
      if (!Number.isFinite(n)) {
        pushUnique(fieldIssues[label], `${label} must be a finite number.`);
        return;
      }
      if (n < 0) pushUnique(fieldIssues[label], `${label} must be >= 0.`);
      if (n > 4294967295)
        pushUnique(fieldIssues[label], `${label} must be <= 4294967295.`);
    };

    validateUint32(parsed.serial, "serial");
    validateUint32(parsed.refresh, "refresh");
    validateUint32(parsed.retry, "retry");
    validateUint32(parsed.expire, "expire");
    validateUint32(parsed.minimum, "minimum");

    if (parsed.serial !== undefined) {
      const serialStr = String(parsed.serial);
      if (!/^\d{10}$/.test(serialStr)) {
        pushUnique(
          fieldIssues.serial,
          "Serial should commonly be YYYYMMDDnn (10 digits).",
        );
      } else {
        const year = Number(serialStr.slice(0, 4));
        const month = Number(serialStr.slice(4, 6));
        const day = Number(serialStr.slice(6, 8));
        const nn = Number(serialStr.slice(8, 10));
        const daysInMonth = (y: number, m: number) =>
          new Date(y, m, 0).getDate();
        if (year < 1970 || year > 2100)
          pushUnique(fieldIssues.serial, "Serial year looks out of range.");
        if (month < 1 || month > 12)
          pushUnique(fieldIssues.serial, "Serial month must be 01–12.");
        else {
          const maxDay = daysInMonth(year, month);
          if (day < 1 || day > maxDay)
            pushUnique(fieldIssues.serial, `Serial day must be 01–${maxDay}.`);
        }
        if (nn < 0 || nn > 99)
          pushUnique(fieldIssues.serial, "Serial nn must be 00–99.");
      }
    }

    const validateSecondsRange = (
      value: number | undefined,
      label: "refresh" | "retry" | "expire" | "minimum",
      min: number,
      max: number,
    ) => {
      if (value === undefined) return;
      if (value > 0 && (value < min || value > max)) {
        pushUnique(
          fieldIssues[label],
          `${label} is unusual; common range is ${min}–${max} seconds.`,
        );
      }
      if (value === 0) {
        pushUnique(fieldIssues[label], `${label} of 0 is unusual.`);
      }
    };

    validateSecondsRange(parsed.refresh, "refresh", 900, 86400);
    validateSecondsRange(parsed.retry, "retry", 300, 86400);
    validateSecondsRange(parsed.expire, "expire", 604800, 2419200);
    validateSecondsRange(parsed.minimum, "minimum", 60, 86400);

    if (
      parsed.refresh !== undefined &&
      parsed.retry !== undefined &&
      parsed.refresh > 0 &&
      parsed.retry > 0 &&
      parsed.retry >= parsed.refresh
    ) {
      pushUnique(fieldIssues.retry, "retry is usually less than refresh.");
    }

    if (
      parsed.expire !== undefined &&
      parsed.refresh !== undefined &&
      parsed.expire > 0 &&
      parsed.refresh > 0 &&
      parsed.expire <= parsed.refresh
    ) {
      pushUnique(fieldIssues.expire, "expire is usually much greater than refresh.");
    }

    for (const msgs of Object.values(fieldIssues)) {
      for (const msg of msgs) pushUnique(issues, `SOA: ${msg}`);
    }

    return { issues, fieldIssues };
  }, [record.type, record.content, record.name]);

  const uriValidation = useMemo(() => {
    if (record.type !== "URI") {
      return {
        issues: [] as string[],
        fieldIssues: {} as Record<"priority" | "weight" | "target", string[]>,
      };
    }

    const issues: string[] = [];
    const fieldIssues: Record<"priority" | "weight" | "target", string[]> = {
      priority: [],
      weight: [],
      target: [],
    };

    const pushUnique = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const parsed = parseURIContent(record.content);

    const validateU16 = (value: number | undefined, label: "priority" | "weight") => {
      if (value === undefined) {
        pushUnique(fieldIssues[label], `${label} is required.`);
        return;
      }
      if (!Number.isFinite(value)) {
        pushUnique(fieldIssues[label], `${label} must be a number.`);
        return;
      }
      if (value < 0 || value > 65535)
        pushUnique(fieldIssues[label], `${label} must be between 0 and 65535.`);
    };

    validateU16(parsed.priority, "priority");
    validateU16(parsed.weight, "weight");

    const target = (parsed.target ?? "").trim();
    if (!target) {
      pushUnique(fieldIssues.target, "target is required.");
    } else {
      if (uriTargetSpaceWarning)
        pushUnique(fieldIssues.target, "Spaces were converted to %20.");
      if (/\s/.test(target))
        pushUnique(fieldIssues.target, "URI should not contain spaces (use %20).");
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target))
        pushUnique(fieldIssues.target, "URI should include a scheme (e.g., https:, sip:, mailto:).");
      try {
        // URL accepts many schemes; this is a sanity check only.
        // eslint-disable-next-line no-new
        new URL(target);
      } catch {
        pushUnique(fieldIssues.target, "target does not parse as a valid URI.");
      }
      if (target.length > 2048)
        pushUnique(fieldIssues.target, "target is very long; some resolvers may reject it.");
    }

    for (const msgs of Object.values(fieldIssues)) {
      for (const msg of msgs) pushUnique(issues, `URI: ${msg}`);
    }

    return { issues, fieldIssues };
  }, [record.type, record.content, uriTargetSpaceWarning]);

  const validationWarnings = useMemo(() => {
    const warnings: string[] = [];
    const pushUnique = (msg: string) => {
      if (!warnings.includes(msg)) warnings.push(msg);
    };
    const type = record.type;
    const name = (record.name ?? "").trim();
    const content = (record.content ?? "").trim();

    if (name && /\s/.test(name)) pushUnique("Name contains whitespace.");
    if (name && name.includes("://"))
      pushUnique("Name looks like a URL; DNS names should not include a scheme.");
    if (name && name.startsWith("."))
      pushUnique("Name starts with '.', which is unusual for DNS records.");

    if (!type) return warnings;
    if (!content && type !== "MX") return warnings;

    const looksLikeHostname = (value: string) => {
      if (!value) return false;
      if (/\s/.test(value)) return false;
      if (value.includes("://")) return false;
      if (value.includes("/")) return false;
      return true;
    };

    const ipv4ToInt = (value: string) => {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return null;
      const parts = value.split(".").map((p) => Number(p));
      if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
      return (
        ((parts[0] << 24) >>> 0) |
        ((parts[1] << 16) >>> 0) |
        ((parts[2] << 8) >>> 0) |
        (parts[3] >>> 0)
      ) >>> 0;
    };

    const ipv4InCidr = (value: string, base: string, prefix: number) => {
      const v = ipv4ToInt(value);
      const b = ipv4ToInt(base);
      if (v === null || b === null) return false;
      const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1) >>> 0) >>> 0;
      return ((v & mask) >>> 0) === ((b & mask) >>> 0);
    };

    const isValidIPv4 = (value: string) => {
      const parts = value.split(".");
      if (parts.length !== 4) return false;
      return parts.every((p) => {
        if (!/^\d{1,3}$/.test(p)) return false;
        const n = Number(p);
        return n >= 0 && n <= 255;
      });
    };

    const isValidIPv6 = (value: string) => {
      if (!value.includes(":")) return false;
      if (!/^[0-9a-fA-F:]+$/.test(value)) return false;
      const double = value.includes("::");
      if (double && value.indexOf("::") !== value.lastIndexOf("::")) return false;
      const groups = value.split(":").filter((g) => g.length > 0);
      if (groups.some((g) => g.length > 4)) return false;
      return double ? groups.length <= 7 : groups.length === 8;
    };

    const normalizeIPv6 = (value: string) => {
      const input = value.trim().toLowerCase();
      if (!isValidIPv6(input)) return null;
      const hasDouble = input.includes("::");
      const parts = input.split("::");
      const left = parts[0] ? parts[0].split(":").filter(Boolean) : [];
      const right = hasDouble && parts[1] ? parts[1].split(":").filter(Boolean) : [];
      const leftNums = left.map((g) => Number.parseInt(g, 16));
      const rightNums = right.map((g) => Number.parseInt(g, 16));
      if (
        leftNums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ||
        rightNums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)
      )
        return null;
      const total = leftNums.length + rightNums.length;
      if (!hasDouble && total !== 8) return null;
      if (hasDouble && total > 8) return null;
      const fill = hasDouble ? new Array(8 - total).fill(0) : [];
      return [...leftNums, ...fill, ...rightNums];
    };

    const ipv6InPrefix = (value: string, base: string, prefix: number) => {
      const v = normalizeIPv6(value);
      const b = normalizeIPv6(base);
      if (!v || !b) return false;
      let bits = prefix;
      for (let i = 0; i < 8; i++) {
        if (bits <= 0) return true;
        const take = Math.min(16, bits);
        const mask = take === 16 ? 0xffff : ((0xffff << (16 - take)) & 0xffff);
        if ((v[i] & mask) !== (b[i] & mask)) return false;
        bits -= take;
      }
      return true;
    };

    const getHostnameTld = (value: string) => {
      const host = normalizeDnsName(value).toLowerCase();
      if (!host.includes(".")) return null;
      const tld = host.split(".").pop();
      if (!tld) return null;
      if (!/^[a-z0-9-]{2,63}$/.test(tld)) return null;
      return tld;
    };

    const warnInvalidTld = (value: string, context: string) => {
      const tld = getHostnameTld(value);
      if (!tld) return;
      if (!KNOWN_TLDS.has(tld)) {
        pushUnique(
          `${context} uses an unknown/invalid TLD “.${tld}” (not in the IANA root zone).`,
        );
      }
    };

    const isHex = (value: string) =>
      value.length > 0 && /^[0-9a-fA-F]+$/.test(value);

    switch (type) {
      case "A":
        if (content && !isValidIPv4(content))
          pushUnique("A record content does not look like a valid IPv4 address.");
        if (content && isValidIPv4(content)) {
          if (ipv4InCidr(content, "10.0.0.0", 8))
            pushUnique("IPv4 is private (RFC1918): 10.0.0.0/8.");
          else if (ipv4InCidr(content, "172.16.0.0", 12))
            pushUnique("IPv4 is private (RFC1918): 172.16.0.0/12.");
          else if (ipv4InCidr(content, "192.168.0.0", 16))
            pushUnique("IPv4 is private (RFC1918): 192.168.0.0/16.");
          else if (ipv4InCidr(content, "127.0.0.0", 8))
            pushUnique("IPv4 is loopback: 127.0.0.0/8.");
          else if (ipv4InCidr(content, "169.254.0.0", 16))
            pushUnique("IPv4 is link-local: 169.254.0.0/16.");
          else if (ipv4InCidr(content, "100.64.0.0", 10))
            pushUnique("IPv4 is CGNAT/shared address space: 100.64.0.0/10.");
          else if (ipv4InCidr(content, "192.0.2.0", 24))
            pushUnique("IPv4 is TEST-NET-1 (documentation): 192.0.2.0/24.");
          else if (ipv4InCidr(content, "198.51.100.0", 24))
            pushUnique("IPv4 is TEST-NET-2 (documentation): 198.51.100.0/24.");
          else if (ipv4InCidr(content, "203.0.113.0", 24))
            pushUnique("IPv4 is TEST-NET-3 (documentation): 203.0.113.0/24.");
          else if (ipv4InCidr(content, "224.0.0.0", 4))
            pushUnique("IPv4 is multicast: 224.0.0.0/4.");
          else if (ipv4InCidr(content, "240.0.0.0", 4))
            pushUnique("IPv4 is reserved/future use: 240.0.0.0/4.");
          else if (ipv4InCidr(content, "0.0.0.0", 8))
            pushUnique("IPv4 is 'this network' (special): 0.0.0.0/8.");
          else if (ipv4InCidr(content, "255.255.255.255", 32))
            pushUnique("IPv4 is broadcast address: 255.255.255.255.");
          else if (ipv4InCidr(content, "192.0.0.0", 24))
            pushUnique("IPv4 is IETF protocol assignments: 192.0.0.0/24.");
          else if (ipv4InCidr(content, "198.18.0.0", 15))
            pushUnique("IPv4 is benchmark testing: 198.18.0.0/15.");
        }
        break;
      case "AAAA":
        if (content && !isValidIPv6(content))
          pushUnique(
            "AAAA record content does not look like a valid IPv6 address.",
          );
        if (content && isValidIPv6(content)) {
          const c = content.trim().toLowerCase();
          if (c === "::")
            pushUnique("IPv6 is unspecified address (::).");
          else if (c === "::1")
            pushUnique("IPv6 is loopback (::1).");
          else if (ipv6InPrefix(c, "fc00::", 7))
            pushUnique("IPv6 is unique local (ULA): fc00::/7.");
          else if (ipv6InPrefix(c, "fe80::", 10))
            pushUnique("IPv6 is link-local: fe80::/10.");
          else if (ipv6InPrefix(c, "ff00::", 8))
            pushUnique("IPv6 is multicast: ff00::/8.");
          else if (ipv6InPrefix(c, "2001:db8::", 32))
            pushUnique("IPv6 is documentation: 2001:db8::/32.");
          else if (ipv6InPrefix(c, "2002::", 16))
            pushUnique("IPv6 is 6to4 transition: 2002::/16.");
          else if (ipv6InPrefix(c, "64:ff9b::", 96))
            pushUnique("IPv6 is NAT64 well-known prefix: 64:ff9b::/96.");
        }
        break;
      case "CNAME":
      case "NS":
      case "PTR":
        if (content && !looksLikeHostname(content))
          pushUnique(`${type} content does not look like a hostname.`);
        if (content && looksLikeHostname(content))
          warnInvalidTld(content, `${type} content`);
        break;
      case "MX": {
        if (content && !looksLikeHostname(content))
          pushUnique("MX content does not look like a hostname.");
        if (content && looksLikeHostname(content))
          warnInvalidTld(content, "MX content");
        const pr = record.priority;
        if (pr === undefined || pr === null || Number.isNaN(Number(pr))) {
          pushUnique("MX priority is missing.");
        } else if (Number(pr) < 0 || Number(pr) > 65535) {
          pushUnique("MX priority should be between 0 and 65535.");
        }
        break;
      }
      case "TXT":
        if (content.includes("\n"))
          pushUnique("TXT content contains newlines (often rejected by DNS providers).");
        if (content.length > 255)
          pushUnique(
            "TXT content is longer than 255 characters (may need quoting/splitting).",
          );
        break;
      case "SRV": {
        // SRV warnings are shown in the SRV builder panel; keep confirmation logic separate.
        break;
      }
      case "DS": {
        // DS warnings are shown in the DS builder panel; keep confirmation logic separate.
        break;
      }
      case "DNSKEY":
      case "CDNSKEY": {
        // DNSKEY/CDNSKEY warnings are shown in the DNSKEY builder panel; keep confirmation logic separate.
        break;
      }
      case "TLSA": {
        const parsed = parseTLSA(record.content);
        if (
          parsed.usage !== undefined &&
          ![0, 1, 2, 3].includes(Number(parsed.usage))
        )
          pushUnique("TLSA usage is usually 0–3.");
        if (
          parsed.selector !== undefined &&
          ![0, 1].includes(Number(parsed.selector))
        )
          pushUnique("TLSA selector is usually 0–1.");
        if (
          parsed.matchingType !== undefined &&
          ![0, 1, 2].includes(Number(parsed.matchingType))
        )
          pushUnique("TLSA matching type is usually 0–2.");
        if (parsed.data && (!isHex(parsed.data) || parsed.data.length % 2 !== 0))
          pushUnique("TLSA data should be even-length hex.");
        break;
      }
      case "SSHFP": {
        const parsed = parseSSHFP(record.content);
        if (
          parsed.algorithm !== undefined &&
          ![1, 2, 3, 4].includes(Number(parsed.algorithm))
        )
          pushUnique("SSHFP algorithm is usually 1–4.");
        if (
          parsed.fptype !== undefined &&
          ![1, 2].includes(Number(parsed.fptype))
        )
          pushUnique("SSHFP fptype is usually 1–2.");
        if (parsed.fingerprint && !isHex(parsed.fingerprint))
          pushUnique("SSHFP fingerprint should be hex.");
        break;
      }
      case "NAPTR": {
        const parsed = parseNAPTR(record.content);
        if (
          parsed.order !== undefined &&
          (parsed.order < 0 || parsed.order > 65535)
        )
          pushUnique("NAPTR order should be between 0 and 65535.");
        if (
          parsed.preference !== undefined &&
          (parsed.preference < 0 || parsed.preference > 65535)
        )
          pushUnique("NAPTR preference should be between 0 and 65535.");
        if (parsed.replacement && !looksLikeHostname(parsed.replacement) && parsed.replacement !== ".")
          pushUnique("NAPTR replacement does not look like a hostname.");
        break;
      }
      case "SOA": {
        for (const msg of soaValidation.issues) pushUnique(msg);
        const parsed = parseSOAContent(record.content);
        if (parsed.mname) warnInvalidTld(parsed.mname, "SOA mname");
        if (parsed.rname) warnInvalidTld(parsed.rname, "SOA rname");
        break;
      }
      case "URI": {
        for (const msg of uriValidation.issues) pushUnique(msg);
        break;
      }
      case "SPF": {
        // SPF warnings are shown in the SPF builder panel; keep confirmation logic separate.
        break;
      }
    }

    return warnings;
  }, [
    record.type,
    record.name,
    record.content,
    record.priority,
    soaValidation.issues,
    uriValidation.issues,
  ]);

  useEffect(() => {
    setConfirmInvalid(false);
    setShowDiscardConfirm(false);
    setActiveBuilderWarnings({ issues: [], nameIssues: [] });
  }, [open, record.type, record.name, record.content, record.priority]);

  const submissionWarnings = useMemo(() => {
    const combined = [...validationWarnings];
    for (const w of [
      ...activeBuilderWarnings.nameIssues,
      ...activeBuilderWarnings.issues,
    ]) {
      if (!combined.includes(w)) combined.push(w);
    }
    return combined;
  }, [
    activeBuilderWarnings.issues,
    activeBuilderWarnings.nameIssues,
    validationWarnings,
  ]);

  const handleCreateRecord = () => {
    if (submissionWarnings.length === 0) {
      onAdd();
      return;
    }
    if (!confirmInvalid) {
      setConfirmInvalid(true);
      return;
    }
    onAdd();
  };

  const serializeDraft = useCallback((draft: Partial<DNSRecord>) => {
    const normalized = {
      type: draft.type ?? "",
      name: (draft.name ?? "").trim(),
      content: (draft.content ?? "").trim(),
      ttl: draft.ttl ?? "",
      priority: draft.priority ?? "",
      proxied: draft.proxied ?? false,
    };
    return JSON.stringify(normalized);
  }, []);

  const createEmptyDraft = useCallback((): Partial<DNSRecord> => {
    return {
      type: "A",
      name: "",
      content: "",
      ttl: 300,
      proxied: false,
      priority: undefined,
    };
  }, []);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      openSnapshotRef.current = { ...record };
    }
    wasOpenRef.current = open;
  }, [open, record]);

  const isDirtySinceOpen = useMemo(() => {
    if (!open) return false;
    if (!openSnapshotRef.current) return false;
    return serializeDraft(record) !== serializeDraft(openSnapshotRef.current);
  }, [open, record, serializeDraft]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }

    if (!isDirtySinceOpen) {
      setShowDiscardConfirm(false);
      onOpenChange(false);
      return;
    }

    if (!showDiscardConfirm) setShowDiscardConfirm(true);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="border-border/60 bg-muted/30 text-muted-foreground hover:text-foreground hover:border-primary/30"
          onClick={() => {
            setConfirmInvalid(false);
            setShowDiscardConfirm(false);
            setUriTargetSpaceWarning(false);
            onRecordChange(createEmptyDraft());
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Record
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-w-3xl flex-col p-0 overflow-hidden max-h-[calc(100dvh-var(--app-top-inset)-2rem)]">
        {showDiscardConfirm && (
          <div className="absolute inset-0 z-50 grid place-items-center rounded-xl bg-background/55 backdrop-blur-sm">
            <div className="glass-surface glass-sheen w-[min(520px,calc(100%-2rem))] rounded-xl border border-border/60 bg-popover/80 p-5 shadow-[0_26px_70px_hsl(0_0%_0%_/_0.42)]">
              <div className="text-base font-semibold">Discard changes?</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Closing will lose the edits in this record draft.
              </div>
              <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  variant="ghost"
                  onClick={() => setShowDiscardConfirm(false)}
                >
                  Keep editing
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setShowDiscardConfirm(false);
                    setConfirmInvalid(false);
                    onRecordChange(createEmptyDraft());
                    onOpenChange(false);
                  }}
                >
                  Discard changes
                </Button>
              </div>
            </div>
          </div>
        )}
        <div className="p-6 pb-4 pr-12">
          <DialogHeader>
            <DialogTitle>Add DNS Record</DialogTitle>
            <DialogDescription>
              Create a new DNS record for {zoneName}
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="scrollbar-themed min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6">
          <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("Type", "Type")}</Label>
              <Select
                aria-label={t("Record Type", "Record Type")}
                value={record.type}
                onValueChange={(value: string) =>
                  onRecordChange({
                    ...record,
                    type: value as RecordType,
                    priority: value === "MX" ? record.priority : undefined,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECORD_TYPES.map((type) => (
                    <SelectItem
                      key={type}
                      value={type}
                    >
                      <Tooltip tip={getRecordTypeLabel(type)} side="right">
                        <span>{getRecordTypeLabel(type)}</span>
                      </Tooltip>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("TTL", "TTL")}</Label>
              <Select
                aria-label={t("TTL select", "TTL")}
                value={isCustomTTL ? "custom" : String(ttlValue)}
                onValueChange={(value: string) => {
                  if (value === "custom") {
                    onRecordChange({ ...record, ttl: 300 });
                  } else {
                    onRecordChange({
                      ...record,
                      ttl: value === "auto" ? "auto" : Number(value),
                    });
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {getTTLPresets().map((ttl) => (
                    <SelectItem key={ttl} value={String(ttl)}>
                      {ttl === "auto" ? "Auto" : ttl}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              {isCustomTTL && (
                <Input
                  type="number"
                  value={typeof record.ttl === "number" ? record.ttl : ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    onRecordChange({
                      ...record,
                      ttl: Number.isNaN(n) ? 300 : n,
                    });
                  }}
                />
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t("Name", "Name")}</Label>
            <Input
              aria-label={t("Name input", "Name")}
              value={record.name}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                onRecordChange({
                  ...record,
                  name: e.target.value,
                })
              }
              placeholder={namePlaceholder}
            />
            <div className="text-xs text-muted-foreground">
              Use <code>@</code> for the zone apex. Names are usually relative to{" "}
              <code>{zoneName}</code>.
              {nameHint && <div className="mt-1">{nameHint}</div>}
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t("Content", "Content")}</Label>
            {recordGuide && (
              <div className="text-xs text-muted-foreground">{recordGuide}</div>
            )}
            {(() => {
              switch (record.type) {
                case "TXT":
                  return (
                    <TxtBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      zoneName={zoneName}
                      simulateSPF={simulateSPF}
                      getSPFGraph={getSPFGraph}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                  /*
                  return (
                    <div className="space-y-2">
                      <textarea
                        aria-label={t("TXT content input", "TXT content")}
                        className="ui-focus w-full min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                        value={record.content}
                        onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                          onRecordChange({
                            ...record,
                            content: e.target.value,
                          })
                        }
                        placeholder={contentPlaceholder}
                      />
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        <div className="space-y-1">
                          <Label className="text-xs">TXT helper</Label>
                          <Select
                            value={txtHelperMode}
                            onValueChange={(value: string) =>
                              setTxtHelperMode(value as typeof txtHelperMode)
                            }
                          >
                            <SelectTrigger className="h-9">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="auto">Auto-detect</SelectItem>
                              <SelectItem value="generic">Generic</SelectItem>
                              <SelectItem value="spf">SPF</SelectItem>
                              <SelectItem value="dkim">DKIM</SelectItem>
                              <SelectItem value="dmarc">DMARC</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {effectiveTxtMode === "dkim" && (
                          <>
                            <div className="space-y-1">
                              <Label className="text-xs">Key type</Label>
                              <Select
                                value={dkimKeyType}
                                onValueChange={(value: string) =>
                                  setDkimKeyType(value as typeof dkimKeyType)
                                }
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="rsa">rsa</SelectItem>
                                  <SelectItem value="ed25519">ed25519</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-[11px] text-muted-foreground">
                                Match the key type your provider generated.
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Selector</Label>
                              <Input
                                value={dkimSelector}
                                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                  setDkimSelector(e.target.value)
                                }
                                placeholder="e.g., default"
                              />
                              <div className="text-[11px] text-muted-foreground">
                                Published at <code>&lt;selector&gt;._domainkey</code>.
                              </div>
                            </div>
                            <div className="space-y-1 sm:col-span-1">
                              <Label className="text-xs">Public key (p=)</Label>
                              <Input
                                value={dkimPublicKey}
                                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                  setDkimPublicKey(e.target.value)
                                }
                                placeholder="base64 public key"
                              />
                              <div className="text-[11px] text-muted-foreground">
                                Paste the base64 key only (no PEM header/footer).
                              </div>
                            </div>
                            <div className="space-y-1 sm:col-span-1">
                              <Label className="text-xs">Mode</Label>
                              <Select
                                value={
                                  dkimTestMode && dkimStrictMode
                                    ? "test+strict"
                                    : dkimTestMode
                                      ? "test"
                                      : dkimStrictMode
                                        ? "strict"
                                        : "prod"
                                }
                                onValueChange={(value: string) => {
                                  if (value === "prod") {
                                    setDkimTestMode(false);
                                    setDkimStrictMode(false);
                                  } else if (value === "test") {
                                    setDkimTestMode(true);
                                    setDkimStrictMode(false);
                                  } else if (value === "strict") {
                                    setDkimTestMode(false);
                                    setDkimStrictMode(true);
                                  } else {
                                    setDkimTestMode(true);
                                    setDkimStrictMode(true);
                                  }
                                }}
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="prod">Production</SelectItem>
                                  <SelectItem value="test">Test (t=y)</SelectItem>
                                  <SelectItem value="strict">Strict (t=s)</SelectItem>
                                  <SelectItem value="test+strict">
                                    Test + Strict (t=y:s)
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-[11px] text-muted-foreground">
                                Use test while rolling out; remove once verified.
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Service (s=, optional)</Label>
                              <Input
                                value={dkimServiceType}
                                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                  setDkimServiceType(e.target.value)
                                }
                                placeholder="* or email"
                              />
                              <div className="text-[11px] text-muted-foreground">
                                Most records omit this. Common values are <code>*</code>{" "}
                                or <code>email</code>.
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Hash algs (h=, optional)</Label>
                              <Select
                                value={dkimHashPreset}
                                onValueChange={(value: string) => {
                                  if (value === "omit") setDkimHashAlgs("");
                                  else if (value === "custom") {
                                    if (!dkimHashAlgs.trim()) setDkimHashAlgs("sha256");
                                  } else setDkimHashAlgs(value);
                                }}
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="omit">Omit (default)</SelectItem>
                                  <SelectItem value="sha256">sha256</SelectItem>
                                  <SelectItem value="sha1">sha1</SelectItem>
                                  <SelectItem value="sha1:sha256">sha1:sha256</SelectItem>
                                  <SelectItem value="sha256:sha1">sha256:sha1</SelectItem>
                                  <SelectItem value="custom">Custom…</SelectItem>
                                </SelectContent>
                              </Select>
                              {dkimHashPreset === "custom" && (
                                <Input
                                  className="mt-2"
                                  value={dkimHashAlgs}
                                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                    setDkimHashAlgs(e.target.value)
                                  }
                                  placeholder="e.g., sha256 or sha1:sha256"
                                />
                              )}
                              <div className="text-[11px] text-muted-foreground">
                                Rarely needed; defaults apply. Use colon-separated
                                values.
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">
                                Granularity (g=, optional)
                              </Label>
                              <Input
                                value={dkimGranularity}
                                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                  setDkimGranularity(e.target.value)
                                }
                                placeholder="*"
                              />
                              <div className="text-[11px] text-muted-foreground">
                                Local-part pattern only (no <code>@domain</code>).
                              </div>
                            </div>
                            <div className="space-y-1 sm:col-span-3">
                              <Label className="text-xs">Notes (n=, optional)</Label>
                              <Input
                                value={dkimNotes}
                                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                  setDkimNotes(e.target.value)
                                }
                                placeholder="optional comment"
                              />
                              <div className="text-[11px] text-muted-foreground">
                                Rarely needed; keep it short.
                              </div>
                            </div>
                          </>
                        )}
                        {effectiveTxtMode === "dmarc" && (
                          <>
                            <div className="space-y-1">
                              <Label className="text-xs">Policy (p=)</Label>
                              <Select
                                value={dmarcPolicy}
                                onValueChange={(value: string) =>
                                  setDmarcPolicy(value as typeof dmarcPolicy)
                                }
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">none</SelectItem>
                                  <SelectItem value="quarantine">
                                    quarantine
                                  </SelectItem>
                                  <SelectItem value="reject">reject</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">rua= (optional)</Label>
                              <Input
                                value={dmarcRua}
                                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                  setDmarcRua(e.target.value)
                                }
                                placeholder="mailto:dmarc@yourdomain.com"
                              />
                              <div className="text-[11px] text-muted-foreground">
                                Aggregate reports (recommended). Multiple: comma-separated.
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">ruf= (optional)</Label>
                              <Input
                                value={dmarcRuf}
                                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                  setDmarcRuf(e.target.value)
                                }
                                placeholder="mailto:dmarc@yourdomain.com"
                              />
                              <div className="text-[11px] text-muted-foreground">
                                Forensic reports (rare; often disabled by providers).
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">pct= (optional)</Label>
                              <Input
                                type="number"
                                value={dmarcPct ?? ""}
                                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                  const n = Number.parseInt(e.target.value, 10);
                                  setDmarcPct(
                                    Number.isNaN(n) ? undefined : n,
                                  );
                                }}
                                placeholder="100"
                              />
                              <div className="text-[11px] text-muted-foreground">
                                Apply policy to a percentage of failing mail (0–100).
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">adkim</Label>
                              <Select
                                value={dmarcAdkim}
                                onValueChange={(value: string) =>
                                  setDmarcAdkim(value as typeof dmarcAdkim)
                                }
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="r">r</SelectItem>
                                  <SelectItem value="s">s</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-[11px] text-muted-foreground">
                                DKIM alignment: <code>r</code> relaxed, <code>s</code>{" "}
                                strict.
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">aspf</Label>
                              <Select
                                value={dmarcAspf}
                                onValueChange={(value: string) =>
                                  setDmarcAspf(value as typeof dmarcAspf)
                                }
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="r">r</SelectItem>
                                  <SelectItem value="s">s</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-[11px] text-muted-foreground">
                                SPF alignment: <code>r</code> relaxed, <code>s</code>{" "}
                                strict.
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">sp= (optional)</Label>
                              <Select
                                value={dmarcSubdomainPolicy || "__inherit__"}
                                onValueChange={(value: string) =>
                                  setDmarcSubdomainPolicy(
                                    value === "__inherit__"
                                      ? ""
                                      : (value as typeof dmarcSubdomainPolicy),
                                  )
                                }
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__inherit__">
                                    (inherit)
                                  </SelectItem>
                                  <SelectItem value="none">none</SelectItem>
                                  <SelectItem value="quarantine">
                                    quarantine
                                  </SelectItem>
                                  <SelectItem value="reject">reject</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-[11px] text-muted-foreground">
                                Subdomain policy. If omitted, inherits <code>p=</code>.
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">fo= (optional)</Label>
                              <Select
                                value={dmarcFo.trim() || "__omit__"}
                                onValueChange={(value: string) =>
                                  setDmarcFo(value === "__omit__" ? "" : value)
                                }
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__omit__">
                                    Omit (default)
                                  </SelectItem>
                                  <SelectItem value="0">0 (default)</SelectItem>
                                  <SelectItem value="1">1</SelectItem>
                                  <SelectItem value="d">d</SelectItem>
                                  <SelectItem value="s">s</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-[11px] text-muted-foreground">
                                Failure reporting options. Most setups omit this.
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">ri= (optional)</Label>
                              <Input
                                type="number"
                                value={dmarcRi ?? ""}
                                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                  const n = Number.parseInt(e.target.value, 10);
                                  setDmarcRi(Number.isNaN(n) ? undefined : n);
                                }}
                                placeholder="86400"
                              />
                              <div className="text-[11px] text-muted-foreground">
                                Report interval in seconds (often 86400).
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">rf= (optional)</Label>
                              <Select
                                value={dmarcRf.trim().toLowerCase() || "__omit__"}
                                onValueChange={(value: string) =>
                                  setDmarcRf(value === "__omit__" ? "" : value)
                                }
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__omit__">
                                    Omit (default)
                                  </SelectItem>
                                  <SelectItem value="afrf">afrf</SelectItem>
                                  <SelectItem value="iodef">iodef</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-[11px] text-muted-foreground">
                                Reporting format. Usually omitted / defaults.
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                      {effectiveTxtMode === "spf" && (
                        <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-xs font-semibold text-muted-foreground">
                              SPF builder
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              Est. DNS lookups: {spfDiagnostics.lookupEstimate}/10
                            </div>
                          </div>

                          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
                            <div className="space-y-1 sm:col-span-1">
                              <Label className="text-xs">Qualifier</Label>
                              <Select
                                value={newSPFQualifier || "+"}
                                onValueChange={(value: string) =>
                                  setNewSPFQualifier(value === "+" ? "" : value)
                                }
                              >
                                <SelectTrigger className="h-8">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="+">+ pass</SelectItem>
                                  <SelectItem value="-">- fail</SelectItem>
                                  <SelectItem value="~">~ softfail</SelectItem>
                                  <SelectItem value="?">? neutral</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-[11px] text-muted-foreground">
                                Result if it matches.
                              </div>
                            </div>

                            <div className="space-y-1 sm:col-span-2">
                              <Label className="text-xs">Mechanism</Label>
                              <Select
                                value={newSPFMechanism}
                                onValueChange={(value: string) =>
                                  setNewSPFMechanism(value)
                                }
                              >
                                <SelectTrigger className="h-8">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="ip4">ip4</SelectItem>
                                  <SelectItem value="ip6">ip6</SelectItem>
                                  <SelectItem value="a">a</SelectItem>
                                  <SelectItem value="mx">mx</SelectItem>
                                  <SelectItem value="include">include</SelectItem>
                                  <SelectItem value="exists">exists</SelectItem>
                                  <SelectItem value="ptr">ptr</SelectItem>
                                  <SelectItem value="all">all</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-[11px] text-muted-foreground">
                                {(() => {
                                  switch (newSPFMechanism) {
                                    case "ip4":
                                      return "Authorize an IPv4 netblock.";
                                    case "ip6":
                                      return "Authorize an IPv6 netblock.";
                                    case "a":
                                      return "Authorize A/AAAA of a domain.";
                                    case "mx":
                                      return "Authorize MX hosts of a domain.";
                                    case "include":
                                      return "Include another domain’s SPF.";
                                    case "exists":
                                      return "Match if an A lookup succeeds.";
                                    case "ptr":
                                      return "Discouraged (reverse DNS).";
                                    case "all":
                                      return "Catch-all (usually last).";
                                    default:
                                      return "";
                                  }
                                })()}
                              </div>
                            </div>

                            <div className="space-y-1 sm:col-span-3">
                              <Label className="text-xs">Value</Label>
                              <Input
                                className="h-8"
                                placeholder={(() => {
                                  switch (newSPFMechanism) {
                                    case "ip4":
                                      return "e.g., 192.0.2.0/24";
                                    case "ip6":
                                      return "e.g., 2001:db8::/32";
                                    case "include":
                                      return "e.g., _spf.example.com";
                                    case "exists":
                                      return "e.g., exists.example.com";
                                    case "a":
                                    case "mx":
                                    case "ptr":
                                      return "optional: example.com/24//64";
                                    case "all":
                                      return "(no value)";
                                    default:
                                      return "";
                                  }
                                })()}
                                value={newSPFValue}
                                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                  setNewSPFValue(e.target.value)
                                }
                              />
                              <div className="text-[11px] text-muted-foreground">
                                {newSPFMechanism === "all"
                                  ? "Leave empty."
                                  : "Enter the mechanism parameter (if required)."}
                              </div>
                            </div>
                          </div>

                          <div className="mt-2 flex justify-end">
                            <Button onClick={addSPFMechanism}>
                              {editingSPFIndex !== null ? "Update" : "Add"}
                            </Button>
                          </div>

                          {parsedSPF?.mechanisms && parsedSPF.mechanisms.length > 0 && (
                            <div className="mt-3 space-y-2">
                              <div className="text-xs font-semibold text-muted-foreground">
                                Directives
                              </div>
                              {parsedSPF.mechanisms.map((m, i) => (
                                <div
                                  key={`${m.mechanism}:${i}`}
                                  className="flex flex-wrap items-center gap-2"
                                >
                                  <div className="text-xs">
                                    <code>
                                      {(m.qualifier ?? "") +
                                        (m.mechanism ?? "") +
                                        (m.value ? `:${m.value}` : "")}
                                    </code>
                                  </div>
                                  <div className="text-[11px] text-muted-foreground">
                                    {(() => {
                                      switch (m.mechanism) {
                                        case "ip4":
                                          return "IPv4 netblock.";
                                        case "ip6":
                                          return "IPv6 netblock.";
                                        case "a":
                                          return "A/AAAA of domain.";
                                        case "mx":
                                          return "MX of domain.";
                                        case "include":
                                          return "Include domain SPF.";
                                        case "exists":
                                          return "A lookup exists.";
                                        case "ptr":
                                          return "Reverse DNS (discouraged).";
                                        case "all":
                                          return "Catch-all.";
                                        default:
                                          return "";
                                      }
                                    })()}
                                  </div>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => editSPFMechanism(i)}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => removeSPFMechanism(i)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="mt-3 rounded-lg border border-border/60 bg-background/20 p-3">
                            <div className="text-xs font-semibold text-muted-foreground">
                              Preview (canonical)
                            </div>
                            <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
                              {spfDiagnostics.canonical ||
                                composeSPF(
                                  parsedSPF ?? { version: "v=spf1", mechanisms: [] },
                                )}
                            </pre>
                          </div>

                          <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
                            <div className="text-xs font-semibold text-muted-foreground">
                              Recommendations
                            </div>
                            <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
                              <li>
                                Keep <code>all</code> last; avoid <code>+all</code>.
                              </li>
                              <li>
                                Prefer <code>~all</code> while rolling out; move to{" "}
                                <code>-all</code> once you’re confident.
                              </li>
                              <li>
                                Avoid <code>ptr</code>; it’s discouraged and can blow
                                past lookup limits.
                              </li>
                              <li>
                                Stay at ≤10 DNS lookups (includes <code>include</code>,{" "}
                                <code>a</code>, <code>mx</code>, <code>exists</code>,{" "}
                                <code>ptr</code>, and <code>redirect</code>).
                              </li>
                              <li>
                                Use <code>redirect=</code> to centralize policy when you
                                don’t want to copy directives everywhere.
                              </li>
                            </ul>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const parsed = parseSPF(record.content) ?? {
                                    version: "v=spf1",
                                    mechanisms: [],
                                  };
                                  const mechs = [...parsed.mechanisms].filter(
                                    (m) => m.mechanism !== "all",
                                  );
                                  mechs.push({
                                    qualifier: "~",
                                    mechanism: "all",
                                  });
                                  onRecordChange({
                                    ...record,
                                    content: composeSPF({
                                      version: parsed.version,
                                      mechanisms: mechs as SPFMechanism[],
                                      modifiers: parsed.modifiers,
                                    }),
                                  });
                                }}
                              >
                                Set ~all (recommended)
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const parsed = parseSPF(record.content) ?? {
                                    version: "v=spf1",
                                    mechanisms: [],
                                  };
                                  const mechs = [...parsed.mechanisms].filter(
                                    (m) => m.mechanism !== "all",
                                  );
                                  mechs.push({
                                    qualifier: "-",
                                    mechanism: "all",
                                  });
                                  onRecordChange({
                                    ...record,
                                    content: composeSPF({
                                      version: parsed.version,
                                      mechanisms: mechs as SPFMechanism[],
                                      modifiers: parsed.modifiers,
                                    }),
                                  });
                                }}
                              >
                                Set -all (strict)
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const parsed = parseSPF(record.content) ?? {
                                    version: "v=spf1",
                                    mechanisms: [],
                                  };
                                  const mechs = [...parsed.mechanisms];
                                  const all = mechs.filter((m) => m.mechanism === "all");
                                  const rest = mechs.filter((m) => m.mechanism !== "all");
                                  onRecordChange({
                                    ...record,
                                    content: composeSPF({
                                      version: parsed.version,
                                      mechanisms: [...rest, ...all] as SPFMechanism[],
                                      modifiers: parsed.modifiers,
                                    }),
                                  });
                                }}
                              >
                                Move all to end
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const parsed = parseSPF(record.content) ?? {
                                    version: "v=spf1",
                                    mechanisms: [],
                                  };
                                  const mechs = parsed.mechanisms.filter(
                                    (m) => m.mechanism !== "ptr",
                                  );
                                  onRecordChange({
                                    ...record,
                                    content: composeSPF({
                                      version: parsed.version,
                                      mechanisms: mechs,
                                      modifiers: parsed.modifiers,
                                    }),
                                  });
                                }}
                              >
                                Remove ptr
                              </Button>
                            </div>
                          </div>

                          {spfDiagnostics.issues.length > 0 && (
                            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                              <div className="text-sm font-semibold">
                                SPF warnings
                              </div>
                              <div className="mt-2 max-h-40 overflow-auto pr-2">
                                <ul className="list-disc pl-5 text-xs text-foreground/85">
                                  {spfDiagnostics.issues.map((w) => (
                                    <li key={w}>{w}</li>
                                  ))}
                                </ul>
                              </div>
                            </div>
                          )}

                          <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
                            <div className="text-xs font-semibold text-muted-foreground">
                              Redirect (optional)
                            </div>
                            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-5">
                              <div className="sm:col-span-4">
                                <Input
                                  className="h-8"
                                  value={spfRedirect}
                                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                    const next = e.target.value.trim();
                                    setSpfRedirect(next);
                                    const parsed = parseSPF(record.content) ?? {
                                      version: "v=spf1",
                                      mechanisms: [],
                                    };
                                    const mods = (parsed.modifiers ?? []).filter(
                                      (m) => m.key !== "redirect",
                                    );
                                    if (next) mods.push({ key: "redirect", value: next });
                                    onRecordChange({
                                      ...record,
                                      content: composeSPF({
                                        version: parsed.version,
                                        mechanisms: parsed.mechanisms,
                                        modifiers: mods.length ? mods : undefined,
                                      }),
                                    });
                                  }}
                                  placeholder="e.g., _spf.example.com"
                                />
                              </div>
                              <div className="sm:col-span-1">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 w-full"
                                  onClick={() => {
                                    setSpfRedirect("");
                                    const parsed = parseSPF(record.content) ?? {
                                      version: "v=spf1",
                                      mechanisms: [],
                                    };
                                    const mods = (parsed.modifiers ?? []).filter(
                                      (m) => m.key !== "redirect",
                                    );
                                    onRecordChange({
                                      ...record,
                                      content: composeSPF({
                                        version: parsed.version,
                                        mechanisms: parsed.mechanisms,
                                        modifiers: mods.length ? mods : undefined,
                                      }),
                                    });
                                  }}
                                  disabled={!spfRedirect}
                                >
                                  Clear
                                </Button>
                              </div>
                            </div>
                            <div className="mt-2 text-[11px] text-muted-foreground">
                              Used only if no mechanism matches. Don’t combine with
                              an <code>all</code> mechanism (redirect would never run).
                            </div>
                          </div>

                          <div className="mt-2 flex justify-end">
                            <Button
                              size="sm"
                              onClick={() => {
                                onRecordChange({
                                  ...record,
                                  content: composeSPF(
                                    parsedSPF ?? {
                                      version: "v=spf1",
                                      mechanisms: [],
                                    },
                                  ),
                                });
                              }}
                            >
                              Apply to TXT
                            </Button>
                          </div>
                        </div>
                      )}
                      {effectiveTxtMode === "dkim" && (
                        <div className="space-y-2">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const selector = dkimSelector.trim();
                                if (!selector) return;
                                onRecordChange({
                                  ...record,
                                  name: `${selector}._domainkey`,
                                });
                              }}
                              disabled={!dkimSelector.trim()}
                            >
                              Use DKIM name
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const parsed = parseDKIM(record.content);
                                setDkimKeyType(parsed.keyType);
                                setDkimPublicKey(parsed.publicKey);
                                setDkimTestMode(parsed.testMode);
                                setDkimStrictMode(parsed.strictMode);
                                setDkimServiceType(parsed.serviceType);
                                setDkimHashAlgs(parsed.hashAlgs);
                                setDkimGranularity(parsed.granularity);
                                setDkimNotes(parsed.notes);
                              }}
                            >
                              Load from content
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => {
                                onRecordChange({
                                  ...record,
                                  content: buildDKIM({
                                    keyType: dkimKeyType,
                                    publicKey: dkimPublicKey,
                                    testMode: dkimTestMode,
                                    strictMode: dkimStrictMode,
                                    serviceType: dkimServiceType,
                                    hashAlgs: dkimHashAlgs,
                                    granularity: dkimGranularity,
                                    notes: dkimNotes,
                                  }),
                                });
                              }}
                            >
                              Build DKIM TXT
                            </Button>
                          </div>

                          <div className="rounded-lg border border-border/60 bg-background/20 p-3">
                            <div className="text-xs font-semibold text-muted-foreground">
                              Preview (canonical)
                            </div>
                            <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
                              {dkimDiagnostics.canonical}
                            </pre>
                          </div>

                          <div className="rounded-lg border border-border/60 bg-background/15 p-3">
                            <div className="text-xs font-semibold text-muted-foreground">
                              Recommendations
                            </div>
                            <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
                              <li>
                                Keep the name as <code>&lt;selector&gt;._domainkey</code>{" "}
                                (relative to <code>{zoneName}</code>).
                              </li>
                              <li>
                                Use <code>t=y</code> during rollout; remove once you’ve
                                confirmed mail is signing and passing.
                              </li>
                              <li>
                                Prefer <code>sha256</code>; avoid custom <code>h=</code>{" "}
                                unless your provider requires it.
                              </li>
                              <li>
                                If <code>p=</code> is very long, some providers require
                                splitting into multiple quoted TXT chunks.
                              </li>
                            </ul>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setDkimTestMode(true);
                                }}
                              >
                                Enable test (t=y)
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setDkimTestMode(false);
                                }}
                              >
                                Disable test
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setDkimPublicKey((v) => v.replace(/\s+/g, ""));
                                }}
                              >
                                Normalize p= whitespace
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  onRecordChange({
                                    ...record,
                                    content: buildDKIM({
                                      keyType: dkimKeyType,
                                      publicKey: dkimPublicKey,
                                      testMode: dkimTestMode,
                                      strictMode: dkimStrictMode,
                                      serviceType: dkimServiceType,
                                      hashAlgs: dkimHashAlgs,
                                      granularity: dkimGranularity,
                                      notes: dkimNotes,
                                    }),
                                  });
                                }}
                              >
                                Apply canonical to TXT
                              </Button>
                            </div>
                          </div>

                          {(dkimDiagnostics.nameIssues.length > 0 ||
                            dkimDiagnostics.issues.length > 0) && (
                            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                              <div className="text-sm font-semibold">
                                DKIM warnings
                              </div>
                              <div className="mt-2 max-h-40 overflow-auto pr-2">
                                <ul className="list-disc pl-5 text-xs text-foreground/85">
                                  {dkimDiagnostics.nameIssues.map((w) => (
                                    <li key={w}>{w}</li>
                                  ))}
                                  {dkimDiagnostics.issues.map((w) => (
                                    <li key={w}>{w}</li>
                                  ))}
                                </ul>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {effectiveTxtMode === "dmarc" && (
                        <div className="space-y-2">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                onRecordChange({ ...record, name: "_dmarc" });
                              }}
                            >
                              Use _dmarc name
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const parsed = parseDMARC(record.content);
                                setDmarcPolicy(parsed.policy);
                                setDmarcRua(parsed.rua);
                                setDmarcRuf(parsed.ruf);
                                setDmarcPct(parsed.pct);
                                setDmarcAdkim(parsed.adkim);
                                setDmarcAspf(parsed.aspf);
                                setDmarcSubdomainPolicy(parsed.subdomainPolicy);
                                setDmarcFo(parsed.fo);
                                setDmarcRf(parsed.rf);
                                setDmarcRi(parsed.ri);
                              }}
                            >
                              Load from content
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => {
                                onRecordChange({
                                  ...record,
                                  content: buildDMARC({
                                    policy: dmarcPolicy,
                                    rua: dmarcRua,
                                    ruf: dmarcRuf,
                                    pct: dmarcPct,
                                    adkim: dmarcAdkim,
                                    aspf: dmarcAspf,
                                    subdomainPolicy: dmarcSubdomainPolicy,
                                    fo: dmarcFo,
                                    rf: dmarcRf,
                                    ri: dmarcRi,
                                  }),
                                });
                              }}
                            >
                              Build DMARC TXT
                            </Button>
                          </div>

                          <div className="rounded-lg border border-border/60 bg-background/20 p-3">
                            <div className="text-xs font-semibold text-muted-foreground">
                              Preview (canonical)
                            </div>
                            <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
                              {dmarcDiagnostics.canonical}
                            </pre>
                          </div>

                          <div className="rounded-lg border border-border/60 bg-background/15 p-3">
                            <div className="text-xs font-semibold text-muted-foreground">
                              Recommendations
                            </div>
                            <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
                              <li>
                                Start with <code>p=none</code> while monitoring reports,
                                then move to <code>quarantine</code> / <code>reject</code>.
                              </li>
                              <li>
                                Add <code>rua=mailto:</code> so you actually receive
                                aggregate reports.
                              </li>
                              <li>
                                Use strict alignment (<code>adkim=s</code>,{" "}
                                <code>aspf=s</code>) only when you’re sure all senders are
                                aligned.
                              </li>
                              <li>
                                For subdomains, set <code>sp=</code> explicitly if you
                                want a different policy than the apex.
                              </li>
                            </ul>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setDmarcPolicy("none")}
                              >
                                Set p=none (rollout)
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setDmarcPolicy("quarantine")}
                              >
                                Set p=quarantine
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setDmarcPolicy("reject")}
                              >
                                Set p=reject (strict)
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setDmarcAdkim("s");
                                  setDmarcAspf("s");
                                }}
                              >
                                Set strict alignment
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const addr = `mailto:dmarc@${zoneName}`;
                                  setDmarcRua(addr);
                                }}
                              >
                                Suggest rua address
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  onRecordChange({
                                    ...record,
                                    content: dmarcDiagnostics.canonical,
                                  });
                                }}
                              >
                                Apply canonical to TXT
                              </Button>
                            </div>
                          </div>

                          {(dmarcDiagnostics.nameIssues.length > 0 ||
                            dmarcDiagnostics.issues.length > 0) && (
                            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                              <div className="text-sm font-semibold">
                                DMARC warnings
                              </div>
                              <div className="scrollbar-themed mt-2 max-h-40 overflow-auto pr-2">
                                <ul className="list-disc pl-5 text-xs text-foreground/85">
                                  {dmarcDiagnostics.nameIssues.map((w) => (
                                    <li key={w}>{w}</li>
                                  ))}
                                  {dmarcDiagnostics.issues.map((w) => (
                                    <li key={w}>{w}</li>
                                  ))}
                                </ul>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                  */
                case "DS":
                  return (
                    <DsBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "DNSKEY":
                case "CDNSKEY":
                  return (
                    <DnskeyBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "CAA":
                  return (
                    <CaaBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      zoneName={zoneName}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "SRV":
                  return (
                    <SrvBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "TLSA":
                  return (
                    <div className="grid grid-cols-4 gap-2">
                      <Input
                        type="number"
                        placeholder="usage"
                        value={tlsaUsage ?? ""}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setTlsaUsage(val);
                          onRecordChange({
                            ...record,
                            content: composeTLSA(
                              val,
                              tlsaSelector,
                              tlsaMatchingType,
                              tlsaData,
                            ),
                          });
                        }}
                      />
                      <Input
                        type="number"
                        placeholder="selector"
                        value={tlsaSelector ?? ""}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setTlsaSelector(val);
                          onRecordChange({
                            ...record,
                            content: composeTLSA(
                              tlsaUsage,
                              val,
                              tlsaMatchingType,
                              tlsaData,
                            ),
                          });
                        }}
                      />
                      <Input
                        type="number"
                        placeholder="matching type"
                        value={tlsaMatchingType ?? ""}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setTlsaMatchingType(val);
                          onRecordChange({
                            ...record,
                            content: composeTLSA(
                              tlsaUsage,
                              tlsaSelector,
                              val,
                              tlsaData,
                            ),
                          });
                        }}
                      />
                      <Input
                        aria-label={t("TLSA data", "data")}
                        placeholder="data (hex)"
                        value={tlsaData}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setTlsaData(e.target.value);
                          onRecordChange({
                            ...record,
                            content: composeTLSA(
                              tlsaUsage,
                              tlsaSelector,
                              tlsaMatchingType,
                              e.target.value,
                            ),
                          });
                        }}
                      />
                    </div>
                  );
                case "SSHFP":
                  return (
                    <div className="grid grid-cols-3 gap-2">
                      <Input
                        type="number"
                        placeholder="algorithm"
                        value={sshfpAlgorithm ?? ""}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setSshfpAlgorithm(val);
                          onRecordChange({
                            ...record,
                            content: composeSSHFP(
                              val,
                              sshfpFptype,
                              sshfpFingerprint,
                            ),
                          });
                        }}
                      />
                      <Input
                        type="number"
                        placeholder="fptype"
                        value={sshfpFptype ?? ""}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setSshfpFptype(val);
                          onRecordChange({
                            ...record,
                            content: composeSSHFP(
                              sshfpAlgorithm,
                              val,
                              sshfpFingerprint,
                            ),
                          });
                        }}
                      />
                      <Input
                        aria-label={t("SSHFP fingerprint", "fingerprint")}
                        placeholder="fingerprint (hex)"
                        value={sshfpFingerprint}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setSshfpFingerprint(e.target.value);
                          onRecordChange({
                            ...record,
                            content: composeSSHFP(
                              sshfpAlgorithm,
                              sshfpFptype,
                              e.target.value,
                            ),
                          });
                        }}
                      />
                    </div>
                  );
                case "NAPTR":
                  return (
                    <div className="grid grid-cols-6 gap-2">
                      <Input
                        aria-label={t("NAPTR order", "order")}
                        type="number"
                        placeholder="order"
                        value={naptrOrder ?? ""}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setNaptrOrder(val);
                          onRecordChange({
                            ...record,
                            content: composeNAPTR(
                              val,
                              naptrPref,
                              naptrFlags,
                              naptrService,
                              naptrRegexp,
                              naptrReplacement,
                            ),
                          });
                        }}
                      />
                      <Input
                        aria-label={t("NAPTR preference", "preference")}
                        type="number"
                        placeholder="preference"
                        value={naptrPref ?? ""}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setNaptrPref(val);
                          onRecordChange({
                            ...record,
                            content: composeNAPTR(
                              naptrOrder,
                              val,
                              naptrFlags,
                              naptrService,
                              naptrRegexp,
                              naptrReplacement,
                            ),
                          });
                        }}
                      />
                      <Input
                        aria-label={t("NAPTR flags", "flags")}
                        placeholder="flags"
                        value={naptrFlags}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setNaptrFlags(e.target.value);
                          onRecordChange({
                            ...record,
                            content: composeNAPTR(
                              naptrOrder,
                              naptrPref,
                              e.target.value,
                              naptrService,
                              naptrRegexp,
                              naptrReplacement,
                            ),
                          });
                        }}
                      />
                      <Input
                        aria-label={t("NAPTR service", "service")}
                        placeholder="service"
                        value={naptrService}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setNaptrService(e.target.value);
                          onRecordChange({
                            ...record,
                            content: composeNAPTR(
                              naptrOrder,
                              naptrPref,
                              naptrFlags,
                              e.target.value,
                              naptrRegexp,
                              naptrReplacement,
                            ),
                          });
                        }}
                      />
                      <Input
                        aria-label={t("NAPTR regexp", "regexp")}
                        placeholder='regexp e.g., "!^.*$!sip:info@example.com!"'
                        value={naptrRegexp}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setNaptrRegexp(e.target.value);
                          onRecordChange({
                            ...record,
                            content: composeNAPTR(
                              naptrOrder,
                              naptrPref,
                              naptrFlags,
                              naptrService,
                              e.target.value,
                              naptrReplacement,
                            ),
                          });
                        }}
                      />
                      <Input
                        aria-label={t("NAPTR replacement", "replacement")}
                        placeholder="replacement"
                        value={naptrReplacement}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setNaptrReplacement(e.target.value);
                          onRecordChange({
                            ...record,
                            content: composeNAPTR(
                              naptrOrder,
                              naptrPref,
                              naptrFlags,
                              naptrService,
                              naptrRegexp,
                              e.target.value,
                            ),
                          });
                        }}
                      />
                    </div>
                  );
                case "URI":
                  return (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="space-y-1">
                          <Label className="text-xs">Priority</Label>
                          <Input
                            type="number"
                            value={uriPriority ?? ""}
                            placeholder="10"
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              const n = Number.parseInt(e.target.value, 10);
                              const val = Number.isNaN(n) ? undefined : n;
                              setUriPriority(val);
                              onRecordChange({
                                ...record,
                                content: composeURI({
                                  priority: val,
                                  weight: uriWeight,
                                  target: uriTarget,
                                }),
                              });
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            Lower wins. Use the same value across multiple targets to
                            enable weighting.
                          </div>
                          {uriValidation.fieldIssues.priority.length > 0 && (
                            <div className="text-xs text-red-600">
                              {uriValidation.fieldIssues.priority.join(" ")}
                            </div>
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Weight</Label>
                          <Input
                            type="number"
                            value={uriWeight ?? ""}
                            placeholder="1"
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              const n = Number.parseInt(e.target.value, 10);
                              const val = Number.isNaN(n) ? undefined : n;
                              setUriWeight(val);
                              onRecordChange({
                                ...record,
                                content: composeURI({
                                  priority: uriPriority,
                                  weight: val,
                                  target: uriTarget,
                                }),
                              });
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            Used only among records with the same priority. 0 is
                            allowed.
                          </div>
                          {uriValidation.fieldIssues.weight.length > 0 && (
                            <div className="text-xs text-red-600">
                              {uriValidation.fieldIssues.weight.join(" ")}
                            </div>
                          )}
                        </div>
                        <div className="space-y-1 sm:col-span-2">
                          <Label className="text-xs">Target URI</Label>
                          <Input
                            value={uriTarget}
                            placeholder="https://example.com/path"
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              const raw = e.target.value;
                              if (/\s/.test(raw)) {
                                const converted = raw.replace(/\s/g, "%20");
                                setUriTargetSpaceWarning(true);
                                setUriTarget(converted);
                                onRecordChange({
                                  ...record,
                                  content: composeURI({
                                    priority: uriPriority,
                                    weight: uriWeight,
                                    target: converted,
                                  }),
                                });
                                return;
                              }

                              setUriTargetSpaceWarning(false);
                              setUriTarget(raw);
                              onRecordChange({
                                ...record,
                                content: composeURI({
                                  priority: uriPriority,
                                  weight: uriWeight,
                                  target: raw,
                                }),
                              });
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            Must be an absolute URI (include a scheme). Avoid spaces
                            (use %20). This field will be stored as a quoted string.
                          </div>
                          {uriValidation.fieldIssues.target.length > 0 && (
                            <div className="text-xs text-red-600">
                              {uriValidation.fieldIssues.target.join(" ")}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
                        <div className="text-xs font-semibold text-muted-foreground">
                          Preview (content)
                        </div>
                        <pre className="mt-1 whitespace-pre-wrap text-xs">
                          {composeURI({
                            priority: uriPriority,
                            weight: uriWeight,
                            target: uriTarget,
                          })}
                        </pre>
                        <div className="mt-2 flex flex-wrap justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setUriPriority(10);
                              setUriWeight(1);
                              setUriTarget("https://example.com/");
                              onRecordChange({
                                ...record,
                                content: composeURI({
                                  priority: 10,
                                  weight: 1,
                                  target: "https://example.com/",
                                }),
                              });
                            }}
                          >
                            Example https
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setUriPriority(10);
                              setUriWeight(1);
                              setUriTarget("mailto:admin@example.com");
                              onRecordChange({
                                ...record,
                                content: composeURI({
                                  priority: 10,
                                  weight: 1,
                                  target: "mailto:admin@example.com",
                                }),
                              });
                            }}
                          >
                            Example mailto
                          </Button>
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Lower priority wins; weight is used for load balancing among
                        same-priority records. Target should be an absolute URI.
                      </div>
                    </div>
                  );
                case "SOA":
                  return (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Primary NS (mname)</Label>
                          <Input
                            value={soaPrimaryNs}
                            placeholder="e.g., ns1.example.com"
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              const v = e.target.value;
                              setSoaPrimaryNs(v);
                              onRecordChange({
                                ...record,
                                content: composeSOA({
                                  mname: v,
                                  rname: emailToRname(soaAdmin),
                                  serial: soaSerial,
                                  refresh: soaRefresh,
                                  retry: soaRetry,
                                  expire: soaExpire,
                                  minimum: soaMinimum,
                                }),
                              });
                            }}
                          />
                          {soaValidation.fieldIssues.mname.length > 0 && (
                            <div className="text-xs text-red-600">
                              {soaValidation.fieldIssues.mname.join(" ")}
                            </div>
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Admin email (rname)</Label>
                          <Input
                            value={soaAdmin}
                            placeholder="e.g., hostmaster@example.com"
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              const v = e.target.value;
                              setSoaAdmin(v);
                              onRecordChange({
                                ...record,
                                content: composeSOA({
                                  mname: soaPrimaryNs,
                                  rname: emailToRname(v),
                                  serial: soaSerial,
                                  refresh: soaRefresh,
                                  retry: soaRetry,
                                  expire: soaExpire,
                                  minimum: soaMinimum,
                                }),
                              });
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            You can paste an email; it will be converted to DNS-name
                            form (replace <code>@</code> with a dot).
                          </div>
                          {soaValidation.fieldIssues.rname.length > 0 && (
                            <div className="text-xs text-red-600">
                              {soaValidation.fieldIssues.rname.join(" ")}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="space-y-1 sm:col-span-2">
                          <Label className="text-xs">Serial</Label>
                          <div className="flex gap-2">
                            <Input
                              type="number"
                              value={soaSerial ?? ""}
                              placeholder="YYYYMMDDnn (e.g., 2026012601)"
                              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                const n = Number.parseInt(e.target.value, 10);
                                const val = Number.isNaN(n) ? undefined : n;
                                setSoaSerial(val);
                                onRecordChange({
                                  ...record,
                                  content: composeSOA({
                                    mname: soaPrimaryNs,
                                    rname: emailToRname(soaAdmin),
                                    serial: val,
                                    refresh: soaRefresh,
                                    retry: soaRetry,
                                    expire: soaExpire,
                                    minimum: soaMinimum,
                                  }),
                                });
                              }}
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const now = new Date();
                                const y = now.getFullYear();
                                const m = String(now.getMonth() + 1).padStart(2, "0");
                                const d = String(now.getDate()).padStart(2, "0");
                                const val = Number(`${y}${m}${d}01`);
                                setSoaSerial(val);
                                onRecordChange({
                                  ...record,
                                  content: composeSOA({
                                    mname: soaPrimaryNs,
                                    rname: emailToRname(soaAdmin),
                                    serial: val,
                                    refresh: soaRefresh,
                                    retry: soaRetry,
                                    expire: soaExpire,
                                    minimum: soaMinimum,
                                  }),
                                });
                              }}
                            >
                              Today
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const val = (soaSerial ?? 0) + 1;
                                setSoaSerial(val);
                                onRecordChange({
                                  ...record,
                                  content: composeSOA({
                                    mname: soaPrimaryNs,
                                    rname: emailToRname(soaAdmin),
                                    serial: val,
                                    refresh: soaRefresh,
                                    retry: soaRetry,
                                    expire: soaExpire,
                                    minimum: soaMinimum,
                                  }),
                                });
                              }}
                            >
                              +1
                            </Button>
                          </div>
                          {soaValidation.fieldIssues.serial.length > 0 && (
                            <div className="mt-1 text-xs text-red-600">
                              {soaValidation.fieldIssues.serial.join(" ")}
                            </div>
                          )}
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs">Refresh</Label>
                          <Input
                            type="number"
                            value={soaRefresh ?? ""}
                            placeholder="7200"
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              const n = Number.parseInt(e.target.value, 10);
                              const val = Number.isNaN(n) ? undefined : n;
                              setSoaRefresh(val);
                              onRecordChange({
                                ...record,
                                content: composeSOA({
                                  mname: soaPrimaryNs,
                                  rname: emailToRname(soaAdmin),
                                  serial: soaSerial,
                                  refresh: val,
                                  retry: soaRetry,
                                  expire: soaExpire,
                                  minimum: soaMinimum,
                                }),
                              });
                            }}
                          />
                          <div className="text-xs text-muted-foreground">Seconds.</div>
                          {soaValidation.fieldIssues.refresh.length > 0 && (
                            <div className="text-xs text-red-600">
                              {soaValidation.fieldIssues.refresh.join(" ")}
                            </div>
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Retry</Label>
                          <Input
                            type="number"
                            value={soaRetry ?? ""}
                            placeholder="3600"
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              const n = Number.parseInt(e.target.value, 10);
                              const val = Number.isNaN(n) ? undefined : n;
                              setSoaRetry(val);
                              onRecordChange({
                                ...record,
                                content: composeSOA({
                                  mname: soaPrimaryNs,
                                  rname: emailToRname(soaAdmin),
                                  serial: soaSerial,
                                  refresh: soaRefresh,
                                  retry: val,
                                  expire: soaExpire,
                                  minimum: soaMinimum,
                                }),
                              });
                            }}
                          />
                          <div className="text-xs text-muted-foreground">Seconds.</div>
                          {soaValidation.fieldIssues.retry.length > 0 && (
                            <div className="text-xs text-red-600">
                              {soaValidation.fieldIssues.retry.join(" ")}
                            </div>
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Expire</Label>
                          <Input
                            type="number"
                            value={soaExpire ?? ""}
                            placeholder="1209600"
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              const n = Number.parseInt(e.target.value, 10);
                              const val = Number.isNaN(n) ? undefined : n;
                              setSoaExpire(val);
                              onRecordChange({
                                ...record,
                                content: composeSOA({
                                  mname: soaPrimaryNs,
                                  rname: emailToRname(soaAdmin),
                                  serial: soaSerial,
                                  refresh: soaRefresh,
                                  retry: soaRetry,
                                  expire: val,
                                  minimum: soaMinimum,
                                }),
                              });
                            }}
                          />
                          <div className="text-xs text-muted-foreground">Seconds.</div>
                          {soaValidation.fieldIssues.expire.length > 0 && (
                            <div className="text-xs text-red-600">
                              {soaValidation.fieldIssues.expire.join(" ")}
                            </div>
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Minimum</Label>
                          <Input
                            type="number"
                            value={soaMinimum ?? ""}
                            placeholder="3600"
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              const n = Number.parseInt(e.target.value, 10);
                              const val = Number.isNaN(n) ? undefined : n;
                              setSoaMinimum(val);
                              onRecordChange({
                                ...record,
                                content: composeSOA({
                                  mname: soaPrimaryNs,
                                  rname: emailToRname(soaAdmin),
                                  serial: soaSerial,
                                  refresh: soaRefresh,
                                  retry: soaRetry,
                                  expire: soaExpire,
                                  minimum: val,
                                }),
                              });
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            Seconds (negative caching TTL in modern DNS).
                          </div>
                          {soaValidation.fieldIssues.minimum.length > 0 && (
                            <div className="text-xs text-red-600">
                              {soaValidation.fieldIssues.minimum.join(" ")}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
                        <div className="text-xs font-semibold text-muted-foreground">
                          Preview (content)
                        </div>
                        <pre className="mt-1 whitespace-pre-wrap text-xs">
                          {composeSOA({
                            mname: soaPrimaryNs,
                            rname: emailToRname(soaAdmin),
                            serial: soaSerial,
                            refresh: soaRefresh,
                            retry: soaRetry,
                            expire: soaExpire,
                            minimum: soaMinimum,
                          })}
                        </pre>
                        <div className="mt-2 flex flex-wrap justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              onRecordChange({ ...record, name: "@" })
                            }
                          >
                            Use @ name
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const zn = (zoneName ?? "").trim();
                              const mname = zn ? `ns1.${zn}` : soaPrimaryNs;
                              const rname = zn ? `hostmaster.${zn}` : emailToRname(soaAdmin);
                              setSoaPrimaryNs(mname);
                              setSoaAdmin(rname);
                              setSoaRefresh(7200);
                              setSoaRetry(3600);
                              setSoaExpire(1209600);
                              setSoaMinimum(3600);
                              onRecordChange({
                                ...record,
                                content: composeSOA({
                                  mname,
                                  rname,
                                  serial: soaSerial,
                                  refresh: 7200,
                                  retry: 3600,
                                  expire: 1209600,
                                  minimum: 3600,
                                }),
                              });
                            }}
                          >
                            Common defaults
                          </Button>
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Many DNS providers manage SOA automatically; changes may be
                        ignored or rejected. This tool still lets you submit it.
                      </div>
                    </div>
                  );
                case "SPF":
                  return (
                    <SpfBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      zoneName={zoneName}
                      simulateSPF={simulateSPF}
                      getSPFGraph={getSPFGraph}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                  /*
                  return (
                    <div className="space-y-2">
                      <Input
                        aria-label={t("SPF input", "SPF")}
                        value={record.content}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          onRecordChange({
                            ...record,
                            content: e.target.value,
                          })
                        }
                        placeholder="v=spf1 ip4:... ~all"
                      />
                      <div className="flex space-x-2">
                        <Select
                          value={newSPFQualifier || "+"}
                          onValueChange={(value: string) =>
                            setNewSPFQualifier(value === "+" ? "" : value)
                          }
                        >
                          <SelectTrigger className="h-8 w-16">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="+">+</SelectItem>
                            <SelectItem value="-">-</SelectItem>
                            <SelectItem value="~">~</SelectItem>
                            <SelectItem value="?">?</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select
                          value={newSPFMechanism}
                          onValueChange={(value: string) =>
                            setNewSPFMechanism(value)
                          }
                        >
                          <SelectTrigger className="h-8 w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ip4">ip4</SelectItem>
                            <SelectItem value="ip6">ip6</SelectItem>
                            <SelectItem value="a">a</SelectItem>
                            <SelectItem value="mx">mx</SelectItem>
                            <SelectItem value="include">include</SelectItem>
                            <SelectItem value="all">all</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          placeholder="value (optional)"
                          value={newSPFValue}
                          onChange={(e: ChangeEvent<HTMLInputElement>) =>
                            setNewSPFValue(e.target.value)
                          }
                        />
                        <Button onClick={addSPFMechanism}>
                          {editingSPFIndex !== null ? "Update" : "Add"}
                        </Button>
                      </div>
                      <div className="text-sm text-muted">
                        {parsedSPF?.mechanisms &&
                          parsedSPF.mechanisms.length > 0 && (
                            <div className="space-y-1 mb-2">
                              <div className="text-xs font-semibold">
                                Mechanisms:
                              </div>
                              {parsedSPF.mechanisms.map((m, i) => (
                                <div
                                  key={`${m.mechanism}:${i}`}
                                  className="flex items-center space-x-2"
                                >
                                  <div className="text-xs">
                                    {`${m.qualifier ?? ""}${m.mechanism}${m.value ? `:${m.value}` : ""}`}
                                    {editingSPFIndex === i ? " (editing)" : ""}
                                  </div>
                                  <Button
                                    size="sm"
                                    onClick={() => editSPFMechanism(i)}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => removeSPFMechanism(i)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        <div>Preview:</div>
                        <pre className="whitespace-pre-wrap">
                          {composeSPF(
                            parsedSPF ?? { version: "v=spf1", mechanisms: [] },
                          )}
                        </pre>
                        {!validateSPF(record.content).ok && (
                          <div className="text-red-600">
                            SPF validation issues:{" "}
                            {validateSPF(record.content).problems.join(", ")}
                          </div>
                        )}
                        <div className="flex space-x-2 mt-2">
                          <Input
                            placeholder="simulate IP e.g., 1.2.3.4"
                            value={spfSimIp}
                            onChange={(e) => setSpfSimIp(e.target.value)}
                          />
                          <Button
                            onClick={async () => {
                              if (!zoneName) return;
                              const domain =
                                record.name === "@" || !record.name
                                  ? zoneName
                                  : `${record.name}.${zoneName}`;
                              try {
                                const result = await simulateSPF(
                                  domain,
                                  spfSimIp,
                                );
                                setSpfSimResult(result);
                              } catch (err) {
                                setSpfSimResult({
                                  result: "temperror",
                                  reasons: [(err as Error).message],
                                  lookups: 0,
                                });
                              }
                            }}
                          >
                            Simulate
                          </Button>
                          <Button
                            onClick={async () => {
                              if (!zoneName) return;
                              const domain =
                                record.name === "@" || !record.name
                                  ? zoneName
                                  : `${record.name}.${zoneName}`;
                              try {
                                const graph = await getSPFGraph(domain);
                                setSpfGraph(graph);
                                setSpfGraphError(null);
                              } catch (err) {
                                setSpfGraph(null);
                                setSpfGraphError((err as Error).message);
                              }
                            }}
                          >
                            Graph
                          </Button>
                        </div>
                        {spfSimResult && (
                          <div className="text-sm mt-2">
                            Result: <strong>{spfSimResult.result}</strong>{" "}
                            (lookups: {spfSimResult.lookups})
                            <div className="text-xs text-muted">
                              {spfSimResult.reasons.join(", ")}
                            </div>
                          </div>
                        )}
                        {spfGraphError && (
                          <div className="text-sm text-red-600 mt-2">
                            Error building graph: {spfGraphError}
                          </div>
                        )}
                        {spfGraph && (
                          <div className="text-sm mt-2">
                            <div>Graph:</div>
                            <pre className="whitespace-pre-wrap">
                              {JSON.stringify(spfGraph, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                  */
                default:
                  return (
                    <Input
                      aria-label={t("Default content input", "Content")}
                      value={record.content}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        onRecordChange({
                          ...record,
                          content: e.target.value,
                        })
                      }
                      placeholder={contentPlaceholder}
                    />
                  );
              }
            })()}
          </div>
          {record.type === "MX" && (
            <div className="space-y-2">
              <Label>Priority</Label>
              <Input
                type="number"
                value={record.priority || ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  onRecordChange({
                    ...record,
                    priority: Number.isNaN(n) ? undefined : n,
                  });
                }}
                placeholder="10 (common) or 0 (primary)"
              />
              <div className="text-xs text-muted-foreground">
                Lower numbers have higher priority. Typical setups use 10/20 or 0/10.
              </div>
            </div>
          )}
          {(record.type === "A" ||
            record.type === "AAAA" ||
            record.type === "CNAME") && (
            <div className="flex items-center space-x-2">
              <Switch
                checked={record.proxied || false}
                onCheckedChange={(checked: boolean) =>
                  onRecordChange({
                    ...record,
                    proxied: checked,
                  })
                }
              />
              <Label>Proxied through Cloudflare</Label>
            </div>
          )}
          {validationWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <div className="text-sm font-semibold">
                Potential validation issues
              </div>
              <div className="scrollbar-themed mt-2 max-h-44 overflow-auto pr-2">
                <ul className="list-disc pl-5 text-xs text-foreground/85">
                  {validationWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                You can still create the record, but it may be rejected or behave
                unexpectedly.
              </div>
            </div>
          )}
        </div>
        </div>
        <div className="border-t border-border/40 bg-popover/20 p-4">
          <Button
            onClick={handleCreateRecord}
            className="w-full"
            variant={submissionWarnings.length > 0 ? "outline" : "default"}
          >
            {submissionWarnings.length > 0
              ? confirmInvalid
                ? "Create Anyway"
                : "Review Warnings"
              : "Create Record"}
          </Button>
          {submissionWarnings.length > 0 && confirmInvalid && (
            <Button
              onClick={() => setConfirmInvalid(false)}
              className="mt-2 w-full"
              variant="ghost"
            >
              Go Back
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
