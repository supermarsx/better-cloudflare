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
