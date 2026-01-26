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
import { parseSPF, composeSPF, validateSPF } from "@/lib/spf";
import {
  parseSRV,
  composeSRV,
  parseTLSA,
  composeTLSA,
  parseSSHFP,
  composeSSHFP,
  parseNAPTR,
  composeNAPTR,
} from "@/lib/dns-parsers";
import type { SPFGraph, SPFMechanism } from "@/lib/spf";
import { useCloudflareAPI } from "@/hooks/use-cloudflare-api";
import { useI18n } from "@/hooks/use-i18n";
import { RECORD_TYPES, getTTLPresets, getRecordTypeLabel } from "@/types/dns";
import { Plus } from "lucide-react";

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
  const openSnapshotRef = useRef<Partial<DNSRecord> | null>(null);
  const wasOpenRef = useRef(false);

  const [srvPriority, setSrvPriority] = useState<number | undefined>(
    parseSRV(record.content).priority,
  );
  const [srvWeight, setSrvWeight] = useState<number | undefined>(
    parseSRV(record.content).weight,
  );
  const [srvPort, setSrvPort] = useState<number | undefined>(
    parseSRV(record.content).port,
  );
  const [srvTarget, setSrvTarget] = useState<string>(
    parseSRV(record.content).target ?? "",
  );
  
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

  useEffect(() => {
    if (record.type === "SRV") {
      const parsed = parseSRV(record.content);
      if (parsed.priority !== srvPriority) setSrvPriority(parsed.priority);
      if (parsed.weight !== srvWeight) setSrvWeight(parsed.weight);
      if (parsed.port !== srvPort) setSrvPort(parsed.port);
      if (parsed.target !== srvTarget) setSrvTarget(parsed.target ?? "");
    }
  }, [
    record.type,
    record.content,
    srvPriority,
    srvWeight,
    srvPort,
    srvTarget,
  ]);

  useEffect(() => {
    if (record.type !== "SOA") return;
    const parsed = parseSOAContent(record.content);
    if (parsed.mname !== soaPrimaryNs) setSoaPrimaryNs(parsed.mname);
    if (parsed.rname !== soaAdmin) setSoaAdmin(parsed.rname);
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

  // SPF state and builder
  const parsedSPF = parseSPF(record.content);
  const [newSPFQualifier, setNewSPFQualifier] = useState<string>("");
  const [newSPFMechanism, setNewSPFMechanism] = useState<string>("ip4");
  const [newSPFValue, setNewSPFValue] = useState<string>("");
  const [editingSPFIndex, setEditingSPFIndex] = useState<number | null>(null);
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
  const [dkimKeyType, setDkimKeyType] = useState<"rsa" | "ed25519">("rsa");
  const [dkimSelector, setDkimSelector] = useState<string>("");
  const [dkimPublicKey, setDkimPublicKey] = useState<string>("");

  const effectiveTxtMode = useMemo(() => {
    if (record.type !== "TXT") return "generic" as const;
    if (txtHelperMode !== "auto") return txtHelperMode;
    const content = (record.content ?? "").trim();
    if (content.toLowerCase().startsWith("v=spf1")) return "spf" as const;
    if (content.toLowerCase().startsWith("v=dmarc1")) return "dmarc" as const;
    if (content.toLowerCase().startsWith("v=dkim1")) return "dkim" as const;
    return "generic" as const;
  }, [record.type, record.content, txtHelperMode]);

  const validateDKIM = useCallback((value: string) => {
    const problems: string[] = [];
    const content = value.trim();
    if (!content) return { ok: true, problems };
    if (!/^v=DKIM1\b/i.test(content)) {
      problems.push("Missing v=DKIM1.");
      return { ok: false, problems };
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
    const p = map.get("p");
    if (p === undefined) {
      problems.push("Missing p= (public key).");
    } else {
      const pk = p.replace(/\s+/g, "");
      if (pk.length > 0 && !/^[A-Za-z0-9+/=]+$/.test(pk))
        problems.push("p= contains non-base64 characters.");
      if (pk.length === 0)
        problems.push("p= is empty (revoked key). This may be intentional.");
    }
    const k = map.get("k");
    if (k && !["rsa", "ed25519"].includes(k.toLowerCase()))
      problems.push("k= is usually rsa or ed25519.");
    return { ok: problems.length === 0, problems };
  }, []);

  const validateDMARC = useCallback((value: string) => {
    const problems: string[] = [];
    const content = value.trim();
    if (!content) return { ok: true, problems };
    if (!/^v=DMARC1\b/i.test(content)) {
      problems.push("Missing v=DMARC1.");
      return { ok: false, problems };
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
    const p = map.get("p");
    if (!p) problems.push("Missing p= (policy).");
    else if (!["none", "quarantine", "reject"].includes(p.toLowerCase()))
      problems.push("p= should be none, quarantine, or reject.");
    const rua = map.get("rua");
    if (rua) {
      const parts = rua.split(",").map((s) => s.trim());
      if (parts.some((u) => u && !u.toLowerCase().startsWith("mailto:")))
        problems.push("rua= URIs should start with mailto:.");
    }
    const ruf = map.get("ruf");
    if (ruf) {
      const parts = ruf.split(",").map((s) => s.trim());
      if (parts.some((u) => u && !u.toLowerCase().startsWith("mailto:")))
        problems.push("ruf= URIs should start with mailto:.");
    }
    const pct = map.get("pct");
    if (pct) {
      const n = Number(pct);
      if (Number.isNaN(n) || n < 0 || n > 100)
        problems.push("pct= should be 0–100.");
    }
    return { ok: problems.length === 0, problems };
  }, []);

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
      case "SOA":
        return "SOA is typically @ (zone apex).";
      case "DS":
      case "DNSKEY":
      case "CDNSKEY":
        return "DNSSEC records are typically @ (zone apex).";
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

  const validationWarnings = useMemo(() => {
    const warnings: string[] = [];
    const type = record.type;
    const name = (record.name ?? "").trim();
    const content = (record.content ?? "").trim();

    if (name && /\s/.test(name)) warnings.push("Name contains whitespace.");
    if (name && name.includes("://"))
      warnings.push("Name looks like a URL; DNS names should not include a scheme.");
    if (name && name.startsWith("."))
      warnings.push("Name starts with '.', which is unusual for DNS records.");

    if (!type) return warnings;
    if (!content && type !== "MX") return warnings;

    const looksLikeHostname = (value: string) => {
      if (!value) return false;
      if (/\s/.test(value)) return false;
      if (value.includes("://")) return false;
      if (value.includes("/")) return false;
      return true;
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

    const isHex = (value: string) =>
      value.length > 0 && /^[0-9a-fA-F]+$/.test(value);

    switch (type) {
      case "A":
        if (content && !isValidIPv4(content))
          warnings.push("A record content does not look like a valid IPv4 address.");
        break;
      case "AAAA":
        if (content && !isValidIPv6(content))
          warnings.push(
            "AAAA record content does not look like a valid IPv6 address.",
          );
        break;
      case "CNAME":
      case "NS":
      case "PTR":
        if (content && !looksLikeHostname(content))
          warnings.push(`${type} content does not look like a hostname.`);
        break;
      case "MX": {
        if (content && !looksLikeHostname(content))
          warnings.push("MX content does not look like a hostname.");
        const pr = record.priority;
        if (pr === undefined || pr === null || Number.isNaN(Number(pr))) {
          warnings.push("MX priority is missing.");
        } else if (Number(pr) < 0 || Number(pr) > 65535) {
          warnings.push("MX priority should be between 0 and 65535.");
        }
        break;
      }
      case "TXT":
        if (content.includes("\n"))
          warnings.push("TXT content contains newlines (often rejected by DNS providers).");
        if (content.length > 255)
          warnings.push(
            "TXT content is longer than 255 characters (may need quoting/splitting).",
          );
        if (effectiveTxtMode === "spf") {
          const v = validateSPF(content);
          if (!v.ok)
            warnings.push(`SPF validation issues: ${v.problems.join(", ")}`);
        } else if (effectiveTxtMode === "dkim") {
          const v = validateDKIM(content);
          if (!v.ok)
            warnings.push(`DKIM validation issues: ${v.problems.join(", ")}`);
        } else if (effectiveTxtMode === "dmarc") {
          const v = validateDMARC(content);
          if (!v.ok)
            warnings.push(`DMARC validation issues: ${v.problems.join(", ")}`);
        }
        break;
      case "SRV": {
        const parsed = parseSRV(record.content);
        if (
          parsed.priority !== undefined &&
          (parsed.priority < 0 || parsed.priority > 65535)
        )
          warnings.push("SRV priority should be between 0 and 65535.");
        if (
          parsed.weight !== undefined &&
          (parsed.weight < 0 || parsed.weight > 65535)
        )
          warnings.push("SRV weight should be between 0 and 65535.");
        if (parsed.port !== undefined && (parsed.port < 0 || parsed.port > 65535))
          warnings.push("SRV port should be between 0 and 65535.");
        if (parsed.target && !looksLikeHostname(parsed.target))
          warnings.push("SRV target does not look like a hostname.");
        if (name && !name.startsWith("_"))
          warnings.push("SRV name usually starts with _service._proto.");
        break;
      }
      case "TLSA": {
        const parsed = parseTLSA(record.content);
        if (
          parsed.usage !== undefined &&
          ![0, 1, 2, 3].includes(Number(parsed.usage))
        )
          warnings.push("TLSA usage is usually 0–3.");
        if (
          parsed.selector !== undefined &&
          ![0, 1].includes(Number(parsed.selector))
        )
          warnings.push("TLSA selector is usually 0–1.");
        if (
          parsed.matchingType !== undefined &&
          ![0, 1, 2].includes(Number(parsed.matchingType))
        )
          warnings.push("TLSA matching type is usually 0–2.");
        if (parsed.data && (!isHex(parsed.data) || parsed.data.length % 2 !== 0))
          warnings.push("TLSA data should be even-length hex.");
        break;
      }
      case "SSHFP": {
        const parsed = parseSSHFP(record.content);
        if (
          parsed.algorithm !== undefined &&
          ![1, 2, 3, 4].includes(Number(parsed.algorithm))
        )
          warnings.push("SSHFP algorithm is usually 1–4.");
        if (
          parsed.fptype !== undefined &&
          ![1, 2].includes(Number(parsed.fptype))
        )
          warnings.push("SSHFP fptype is usually 1–2.");
        if (parsed.fingerprint && !isHex(parsed.fingerprint))
          warnings.push("SSHFP fingerprint should be hex.");
        break;
      }
      case "NAPTR": {
        const parsed = parseNAPTR(record.content);
        if (
          parsed.order !== undefined &&
          (parsed.order < 0 || parsed.order > 65535)
        )
          warnings.push("NAPTR order should be between 0 and 65535.");
        if (
          parsed.preference !== undefined &&
          (parsed.preference < 0 || parsed.preference > 65535)
        )
          warnings.push("NAPTR preference should be between 0 and 65535.");
        if (parsed.replacement && !looksLikeHostname(parsed.replacement) && parsed.replacement !== ".")
          warnings.push("NAPTR replacement does not look like a hostname.");
        break;
      }
      case "SOA": {
        const parsed = parseSOAContent(record.content);
        if (parsed.fieldCount !== 7) {
          warnings.push(
            "SOA content should have 7 fields: mname rname serial refresh retry expire minimum.",
          );
        }
        if (parsed.mname && !looksLikeHostname(parsed.mname))
          warnings.push("SOA mname does not look like a hostname.");
        if (parsed.rname && !looksLikeHostname(parsed.rname))
          warnings.push(
            "SOA rname does not look like a hostname (it represents an email address).",
          );
        if (parsed.rname && parsed.rname.includes("@"))
          warnings.push("SOA rname should not contain @ (use DNS-name form).");
        if (parsed.serial === undefined) {
          warnings.push("SOA serial is missing or not a number.");
        } else {
          const s = String(parsed.serial);
          if (s.length < 8)
            warnings.push("SOA serial looks short; common format is YYYYMMDDnn.");
        }
        const positive = (label: string, n: number | undefined) => {
          if (n === undefined) return;
          if (n <= 0) warnings.push(`SOA ${label} should be > 0.`);
        };
        positive("refresh", parsed.refresh);
        positive("retry", parsed.retry);
        positive("expire", parsed.expire);
        positive("minimum", parsed.minimum);
        if (
          parsed.refresh !== undefined &&
          parsed.retry !== undefined &&
          parsed.retry >= parsed.refresh
        )
          warnings.push("SOA retry is usually less than refresh.");
        if (
          parsed.expire !== undefined &&
          parsed.refresh !== undefined &&
          parsed.expire <= parsed.refresh
        )
          warnings.push("SOA expire is usually much greater than refresh.");
        break;
      }
      case "SPF": {
        const v = validateSPF(record.content);
        if (!v.ok) warnings.push(`SPF validation issues: ${v.problems.join(", ")}`);
        break;
      }
    }

    return warnings;
  }, [
    record.type,
    record.name,
    record.content,
    record.priority,
    effectiveTxtMode,
    validateDKIM,
    validateDMARC,
  ]);

  useEffect(() => {
    setConfirmInvalid(false);
    setShowDiscardConfirm(false);
  }, [open, record.type, record.name, record.content, record.priority]);

  const handleCreateRecord = () => {
    if (validationWarnings.length === 0) {
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
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Record
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add DNS Record</DialogTitle>
          <DialogDescription>
            Create a new DNS record for {zoneName}
          </DialogDescription>
        </DialogHeader>
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
                    if (openSnapshotRef.current) {
                      onRecordChange(openSnapshotRef.current);
                    }
                    onOpenChange(false);
                  }}
                >
                  Discard changes
                </Button>
              </div>
            </div>
          </div>
        )}
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
              {record.type === "TXT" && effectiveTxtMode === "dmarc" && (
                <div className="mt-1">
                  DMARC TXT is usually named <code>_dmarc</code>.
                </div>
              )}
              {record.type === "TXT" && effectiveTxtMode === "dkim" && (
                <div className="mt-1">
                  DKIM TXT is usually named <code>&lt;selector&gt;._domainkey</code>.
                </div>
              )}
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
                          <select
                            className="ui-focus glass-surface glass-surface-hover h-9 w-full rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                            value={txtHelperMode}
                            onChange={(e) =>
                              setTxtHelperMode(
                                e.target.value as typeof txtHelperMode,
                              )
                            }
                          >
                            <option value="auto">Auto-detect</option>
                            <option value="generic">Generic</option>
                            <option value="spf">SPF</option>
                            <option value="dkim">DKIM</option>
                            <option value="dmarc">DMARC</option>
                          </select>
                        </div>
                        {effectiveTxtMode === "dkim" && (
                          <>
                            <div className="space-y-1">
                              <Label className="text-xs">Key type</Label>
                              <select
                                className="ui-focus glass-surface glass-surface-hover h-9 w-full rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                                value={dkimKeyType}
                                onChange={(e) =>
                                  setDkimKeyType(
                                    e.target.value as typeof dkimKeyType,
                                  )
                                }
                              >
                                <option value="rsa">rsa</option>
                                <option value="ed25519">ed25519</option>
                              </select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Selector (name)</Label>
                              <Input
                                value={dkimSelector}
                                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                  setDkimSelector(e.target.value)
                                }
                                placeholder="e.g., default"
                              />
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
                            </div>
                          </>
                        )}
                        {effectiveTxtMode === "dmarc" && (
                          <>
                            <div className="space-y-1">
                              <Label className="text-xs">Policy (p=)</Label>
                              <select
                                className="ui-focus glass-surface glass-surface-hover h-9 w-full rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                                value={dmarcPolicy}
                                onChange={(e) =>
                                  setDmarcPolicy(
                                    e.target.value as typeof dmarcPolicy,
                                  )
                                }
                              >
                                <option value="none">none</option>
                                <option value="quarantine">quarantine</option>
                                <option value="reject">reject</option>
                              </select>
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
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">adkim</Label>
                              <select
                                className="ui-focus glass-surface glass-surface-hover h-9 w-full rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                                value={dmarcAdkim}
                                onChange={(e) =>
                                  setDmarcAdkim(
                                    e.target.value as typeof dmarcAdkim,
                                  )
                                }
                              >
                                <option value="r">r</option>
                                <option value="s">s</option>
                              </select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">aspf</Label>
                              <select
                                className="ui-focus glass-surface glass-surface-hover h-9 w-full rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                                value={dmarcAspf}
                                onChange={(e) =>
                                  setDmarcAspf(
                                    e.target.value as typeof dmarcAspf,
                                  )
                                }
                              >
                                <option value="r">r</option>
                                <option value="s">s</option>
                              </select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">sp= (optional)</Label>
                              <select
                                className="ui-focus glass-surface glass-surface-hover h-9 w-full rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                                value={dmarcSubdomainPolicy}
                                onChange={(e) =>
                                  setDmarcSubdomainPolicy(
                                    e.target.value as typeof dmarcSubdomainPolicy,
                                  )
                                }
                              >
                                <option value="">(inherit)</option>
                                <option value="none">none</option>
                                <option value="quarantine">quarantine</option>
                                <option value="reject">reject</option>
                              </select>
                            </div>
                          </>
                        )}
                      </div>
                      {effectiveTxtMode === "spf" && (
                        <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
                          <div className="text-xs font-semibold text-muted-foreground">
                            SPF builder
                          </div>
                          <div className="flex space-x-2 mt-2">
                            <select
                              className="ui-focus glass-surface glass-surface-hover h-8 rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                              value={newSPFQualifier}
                              onChange={(e) => setNewSPFQualifier(e.target.value)}
                            >
                              <option value="">+</option>
                              <option value="-">-</option>
                              <option value="~">~</option>
                              <option value="?">?</option>
                            </select>
                            <select
                              className="ui-focus glass-surface glass-surface-hover h-8 rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                              value={newSPFMechanism}
                              onChange={(e) => setNewSPFMechanism(e.target.value)}
                            >
                              <option value="ip4">ip4</option>
                              <option value="ip6">ip6</option>
                              <option value="a">a</option>
                              <option value="mx">mx</option>
                              <option value="include">include</option>
                              <option value="all">all</option>
                            </select>
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
                          {parsedSPF?.mechanisms && parsedSPF.mechanisms.length > 0 && (
                            <div className="mt-3 space-y-2">
                              <div className="text-xs font-semibold text-muted-foreground">
                                Mechanisms
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
                          <div className="mt-2 text-xs text-muted-foreground">
                            Preview:
                          </div>
                          <pre className="mt-1 whitespace-pre-wrap text-xs">
                            {composeSPF(
                              parsedSPF ?? { version: "v=spf1", mechanisms: [] },
                            )}
                          </pre>
                          {!validateSPF(record.content).ok && (
                            <div className="mt-2 text-xs text-red-600">
                              SPF validation issues:{" "}
                              {validateSPF(record.content).problems.join(", ")}
                            </div>
                          )}
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
                        <div className="flex justify-end">
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
                            onClick={() => {
                              const p = dkimPublicKey.trim();
                              const parts = [
                                "v=DKIM1",
                                `k=${dkimKeyType}`,
                                `p=${p}`,
                              ];
                              onRecordChange({
                                ...record,
                                content: parts.join("; ") + ";",
                              });
                            }}
                          >
                            Build DKIM TXT
                          </Button>
                        </div>
                      )}
                      {effectiveTxtMode === "dmarc" && (
                        <div className="flex justify-end">
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
                            onClick={() => {
                              const parts: string[] = ["v=DMARC1", `p=${dmarcPolicy}`];
                              if (dmarcRua.trim()) parts.push(`rua=${dmarcRua.trim()}`);
                              if (dmarcRuf.trim()) parts.push(`ruf=${dmarcRuf.trim()}`);
                              if (dmarcPct !== undefined) parts.push(`pct=${dmarcPct}`);
                              if (dmarcAdkim) parts.push(`adkim=${dmarcAdkim}`);
                              if (dmarcAspf) parts.push(`aspf=${dmarcAspf}`);
                              if (dmarcSubdomainPolicy)
                                parts.push(`sp=${dmarcSubdomainPolicy}`);
                              onRecordChange({
                                ...record,
                                content: parts.join("; ") + ";",
                              });
                            }}
                          >
                            Build DMARC TXT
                          </Button>
                        </div>
                      )}
                      {record.type === "TXT" && effectiveTxtMode === "dkim" && (
                        (() => {
                          const v = validateDKIM((record.content ?? "").trim());
                          if (v.ok) return null;
                          return (
                            <div className="text-xs text-red-600">
                              DKIM validation issues: {v.problems.join(", ")}
                            </div>
                          );
                        })()
                      )}
                      {record.type === "TXT" && effectiveTxtMode === "dmarc" && (
                        (() => {
                          const v = validateDMARC((record.content ?? "").trim());
                          if (v.ok) return null;
                          return (
                            <div className="text-xs text-red-600">
                              DMARC validation issues: {v.problems.join(", ")}
                            </div>
                          );
                        })()
                      )}
                    </div>
                  );
                case "SRV":
                  return (
                    <div className="grid grid-cols-4 gap-2">
                      <Input
                        aria-label={t("SRV priority", "priority")}
                        type="number"
                        placeholder="priority"
                        value={srvPriority ?? ""}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          setSrvPriority(Number.isNaN(n) ? undefined : n);
                          onRecordChange({
                            ...record,
                            content: composeSRV(
                              Number.isNaN(n) ? undefined : n,
                              srvWeight,
                              srvPort,
                              srvTarget,
                            ),
                          });
                        }}
                      />
                      <Input
                        aria-label={t("SRV weight", "weight")}
                        type="number"
                        placeholder="weight"
                        value={srvWeight ?? ""}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          setSrvWeight(Number.isNaN(n) ? undefined : n);
                          onRecordChange({
                            ...record,
                            content: composeSRV(
                              srvPriority,
                              Number.isNaN(n) ? undefined : n,
                              srvPort,
                              srvTarget,
                            ),
                          });
                        }}
                      />
                      <Input
                        aria-label={t("SRV port", "port")}
                        type="number"
                        placeholder="port"
                        value={srvPort ?? ""}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          setSrvPort(Number.isNaN(n) ? undefined : n);
                          onRecordChange({
                            ...record,
                            content: composeSRV(
                              srvPriority,
                              srvWeight,
                              Number.isNaN(n) ? undefined : n,
                              srvTarget,
                            ),
                          });
                        }}
                      />
                        <Input
                          aria-label={t("SRV target", "target")}
                          placeholder="target e.g., sipserver.example.com"
                          value={srvTarget}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => {
                            setSrvTarget(e.target.value);
                            onRecordChange({
                            ...record,
                            content: composeSRV(
                              srvPriority,
                              srvWeight,
                              srvPort,
                              e.target.value,
                            ),
                          });
                        }}
                      />
                    </div>
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
                        <select
                          className="ui-focus glass-surface glass-surface-hover h-8 rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                          value={newSPFQualifier}
                          onChange={(e) => setNewSPFQualifier(e.target.value)}
                        >
                          <option value="">+</option>
                          <option value="-">-</option>
                          <option value="~">~</option>
                          <option value="?">?</option>
                        </select>
                        <select
                          className="ui-focus glass-surface glass-surface-hover h-8 rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                          value={newSPFMechanism}
                          onChange={(e) => setNewSPFMechanism(e.target.value)}
                        >
                          <option value="ip4">ip4</option>
                          <option value="ip6">ip6</option>
                          <option value="a">a</option>
                          <option value="mx">mx</option>
                          <option value="include">include</option>
                          <option value="all">all</option>
                        </select>
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
              <ul className="mt-1 list-disc pl-5 text-xs text-foreground/85">
                {validationWarnings.slice(0, 5).map((w) => (
                  <li key={w}>{w}</li>
                ))}
                {validationWarnings.length > 5 && (
                  <li>…and {validationWarnings.length - 5} more</li>
                )}
              </ul>
              <div className="mt-2 text-xs text-muted-foreground">
                You can still create the record, but it may be rejected or behave
                unexpectedly.
              </div>
            </div>
          )}
          <Button
            onClick={handleCreateRecord}
            className="w-full"
            variant={validationWarnings.length > 0 ? "outline" : "default"}
          >
            {validationWarnings.length > 0
              ? confirmInvalid
                ? "Create Anyway"
                : "Review Warnings"
              : "Create Record"}
          </Button>
          {validationWarnings.length > 0 && confirmInvalid && (
            <Button
              onClick={() => setConfirmInvalid(false)}
              className="w-full"
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
