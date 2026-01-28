/**
 * Dialog used to collect DNS record properties required to create a new
 * record via the API.
 */
import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { useCloudflareAPI } from "@/hooks/use-cloudflare-api";
import { useI18n } from "@/hooks/use-i18n";
import {
  CLOUDFLARE_SUPPORTED_RECORD_TYPES,
  RECORD_TYPES,
  getTTLPresets,
  getRecordTypeLabel,
} from "@/types/dns";
import { Plus } from "lucide-react";
import type { BuilderWarnings } from "@/components/dns/builders/types";
import { DsBuilder } from "@/components/dns/builders/DsBuilder";
import { DnskeyBuilder } from "@/components/dns/builders/DnskeyBuilder";
import { SrvBuilder } from "@/components/dns/builders/SrvBuilder";
import { CaaBuilder } from "@/components/dns/builders/CaaBuilder";
import { TxtBuilder } from "@/components/dns/builders/TxtBuilder";
import { SpfBuilder } from "@/components/dns/builders/SpfBuilder";
import { UriBuilder } from "@/components/dns/builders/UriBuilder";
import { SoaBuilder } from "@/components/dns/builders/SoaBuilder";
import { NaptrBuilder } from "@/components/dns/builders/NaptrBuilder";
import { SshfpBuilder } from "@/components/dns/builders/SshfpBuilder";
import { TlsaBuilder } from "@/components/dns/builders/TlsaBuilder";
import { HinfoBuilder } from "@/components/dns/builders/HinfoBuilder";
import { LocBuilder } from "@/components/dns/builders/LocBuilder";
import { RpBuilder } from "@/components/dns/builders/RpBuilder";
import { DnameBuilder } from "@/components/dns/builders/DnameBuilder";
import { CertBuilder } from "@/components/dns/builders/CertBuilder";
import { AfsdbBuilder } from "@/components/dns/builders/AfsdbBuilder";
import { AplBuilder } from "@/components/dns/builders/AplBuilder";
import { SmimeaBuilder } from "@/components/dns/builders/SmimeaBuilder";
import { OpenpgpkeyBuilder } from "@/components/dns/builders/OpenpgpkeyBuilder";
import { AnameBuilder } from "@/components/dns/builders/AnameBuilder";
import { SvcbBuilder } from "@/components/dns/builders/SvcbBuilder";

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
  /** Controls whether unsupported record types appear in the Type dropdown */
  showUnsupportedRecordTypes?: boolean;
  /** Optional record type to prefill on new draft (e.g., when list is filtered). */
  prefillType?: RecordType | "";
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
  showUnsupportedRecordTypes = false,
  prefillType = "",
  apiKey,
  email,
}: AddRecordDialogProps) {
  const { t } = useI18n();
  const { simulateSPF, getSPFGraph } = useCloudflareAPI(apiKey, email);
  const ttlValue = record.ttl === 1 ? "auto" : record.ttl;
  const isCustomTTL =
    ttlValue !== undefined && !getTTLPresets().includes(ttlValue as TTLValue);

  const formatTtlLabel = useCallback((ttl: TTLValue) => {
    if (ttl === "auto") return "Auto";
    const seconds = Number(ttl);
    if (!Number.isFinite(seconds) || seconds <= 0) return `${ttl}`;
    if (seconds < 60) return `${seconds} sec (${seconds}s)`;
    if (seconds < 3600) {
      const m = Math.round(seconds / 60);
      return `${m} min (${seconds}s)`;
    }
    if (seconds < 86400) {
      const h = Math.round(seconds / 3600);
      return `${h} hour${h === 1 ? "" : "s"} (${seconds}s)`;
    }
    const d = Math.round(seconds / 86400);
    return `${d} day${d === 1 ? "" : "s"} (${seconds}s)`;
  }, []);

  const [ttlMode, setTtlMode] = useState<"preset" | "custom">(
    isCustomTTL ? "custom" : "preset",
  );
  const [confirmInvalid, setConfirmInvalid] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [typeSelectOpen, setTypeSelectOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const typeFilterInputRef = useRef<HTMLInputElement | null>(null);
  const [activeBuilderWarnings, setActiveBuilderWarnings] = useState<BuilderWarnings>({
    issues: [],
    nameIssues: [],
  });
  const openSnapshotRef = useRef<Partial<DNSRecord> | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setTtlMode(isCustomTTL ? "custom" : "preset");
    setTypeFilter("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!typeSelectOpen) return;
    // The input lives in a portal; defer focus to the next paint.
    requestAnimationFrame(() => typeFilterInputRef.current?.focus());
  }, [typeSelectOpen]);

  useEffect(() => {
    if (!open) return;
    // If the user explicitly chose custom, keep it even if they type a preset value.
    if (ttlMode === "custom") return;
    setTtlMode(isCustomTTL ? "custom" : "preset");
  }, [isCustomTTL, open, ttlMode]);

  const recordTypeOptions = useMemo(() => {
    const base = showUnsupportedRecordTypes
      ? RECORD_TYPES
      : CLOUDFLARE_SUPPORTED_RECORD_TYPES;
    const set = new Set<RecordType>(base);
    if (record.type && !set.has(record.type as RecordType))
      set.add(record.type as RecordType);

    return Array.from(set).sort((a, b) =>
      String(a).localeCompare(String(b), undefined, { sensitivity: "base" }),
    );
  }, [record.type, showUnsupportedRecordTypes]);

  const filteredRecordTypeOptions = useMemo(() => {
    const q = typeFilter.trim().toLowerCase();
    if (!q) return recordTypeOptions;
    return recordTypeOptions.filter((type) => {
      const typeKey = String(type).toLowerCase();
      const label = getRecordTypeLabel(type).toLowerCase();
      return typeKey.includes(q) || label.includes(q);
    });
  }, [recordTypeOptions, typeFilter]);

  const ttlSuggestions = useMemo(() => {
    const type = record.type as RecordType | undefined;
    const proxied = !!record.proxied;

    const uniq = (values: TTLValue[]) =>
      Array.from(new Set(values.map((v) => String(v)))).map((v) =>
        v === "auto" ? "auto" : Number(v),
      ) as TTLValue[];

    if (!type) return uniq([300, 3600]);

    switch (type) {
      case "A":
      case "AAAA":
      case "CNAME":
        return uniq(proxied ? ["auto", 60, 120] : [60, 120, 300]);
      case "MX":
      case "NS":
        return uniq([300, 900, 1800]);
      case "TXT":
      case "SPF":
        return uniq([60, 120, 300]);
      case "SRV":
        return uniq([60, 120, 300]);
      case "CAA":
      case "DS":
      case "DNSKEY":
      case "CDNSKEY":
      case "RRSIG":
      case "NSEC":
      case "TLSA":
      case "SSHFP":
      case "SMIMEA":
      case "OPENPGPKEY":
        return uniq([300, 900, 1800]);
      case "SOA":
        return uniq([300, 900, 1800]);
      case "SVCB":
      case "HTTPS":
      case "URI":
      case "NAPTR":
        return uniq([60, 120, 300]);
      default:
        return uniq([60, 120, 300]);
    }
  }, [record.proxied, record.type]);

  function normalizeDnsName(value: string) {
    return value.trim().replace(/\.$/, "");
  }

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
      case "SMIMEA":
        return "e.g., <hash>._smimecert";
      case "OPENPGPKEY":
        return "e.g., <hash>._openpgpkey";
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
      case "SMIMEA":
        return "SMIMEA names usually include “._smimecert” and a user hash label.";
      case "OPENPGPKEY":
        return "OPENPGPKEY names usually include “._openpgpkey” and a user hash label.";
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
      case "SMIMEA":
        return "e.g., 3 1 1 <hex>";
      case "OPENPGPKEY":
        return "e.g., <base64>";
      case "NAPTR":
        return 'e.g., 100 10 "u" "E2U+sip" "!^.*$!sip:info@example.com!" .';
      default:
        return "Enter record content…";
    }
  }, [record.type]);
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
        // TLSA warnings are shown in the TLSA builder panel; keep confirmation logic separate.
        break;
      }
      case "SSHFP": {
        // SSHFP warnings are shown in the SSHFP builder panel; keep confirmation logic separate.
        break;
      }
      case "NAPTR": {
        // NAPTR warnings are shown in the NAPTR builder panel; keep confirmation logic separate.
        break;
      }
      case "SOA": {
        // SOA warnings are shown in the SOA builder panel; keep confirmation logic separate.
        break;
      }
      case "URI": {
        // URI warnings are shown in the URI builder panel; keep confirmation logic separate.
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
      comment: (draft.comment ?? "").trim(),
      ttl: draft.ttl ?? "",
      priority: draft.priority ?? "",
      proxied: draft.proxied ?? false,
    };
    return JSON.stringify(normalized);
  }, []);

  const createEmptyDraft = useCallback((): Partial<DNSRecord> => {
    return {
      type: prefillType ? (prefillType as RecordType) : "A",
      name: "",
      content: "",
      comment: "",
      ttl: 300,
      proxied: false,
      priority: undefined,
    };
  }, [prefillType]);

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
          size="sm"
          onClick={() => {
            setConfirmInvalid(false);
            setShowDiscardConfirm(false);
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
                open={typeSelectOpen}
                onOpenChange={setTypeSelectOpen}
                onValueChange={(value: string) => {
                  setTypeFilter("");
                  setTypeSelectOpen(false);
                  onRecordChange({
                    ...record,
                    type: value as RecordType,
                    priority: value === "MX" ? record.priority : undefined,
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              <SelectContent>
                  <div className="sticky top-0 z-10 rounded-lg border border-border/50 bg-popover/80 p-2 backdrop-blur-sm">
                    <Input
                      ref={typeFilterInputRef}
                      value={typeFilter}
                      onChange={(e) => setTypeFilter(e.target.value)}
                      placeholder={t("Search types…", "Search types…")}
                      className="h-8 text-xs"
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Escape") {
                          if (typeFilter.trim().length) {
                            e.preventDefault();
                            setTypeFilter("");
                            return;
                          }
                          setTypeSelectOpen(false);
                          return;
                        }
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const next = filteredRecordTypeOptions[0];
                          if (!next) return;
                          setTypeFilter("");
                          setTypeSelectOpen(false);
                          onRecordChange({
                            ...record,
                            type: next as RecordType,
                            priority:
                              next === "MX" ? record.priority : undefined,
                          });
                        }
                      }}
                    />
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {t("Match by type or label.", "Match by type or label.")}
                    </div>
                  </div>
                  {filteredRecordTypeOptions.length === 0 && (
                    <div className="px-2 py-2 text-xs text-muted-foreground">
                      {t(
                        "No matching record types.",
                        "No matching record types.",
                      )}
                    </div>
                  )}
                  {filteredRecordTypeOptions.map((type) => (
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
                  value={ttlMode === "custom" ? "custom" : String(ttlValue)}
                  onValueChange={(value: string) => {
                    if (value === "custom") {
                      setTtlMode("custom");
                      if (typeof record.ttl === "number") {
                        onRecordChange({ ...record, ttl: record.ttl });
                      } else {
                        onRecordChange({ ...record, ttl: 300 });
                      }
                    } else {
                      setTtlMode("preset");
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
                      {formatTtlLabel(ttl)}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              {record.type && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <div className="text-xs text-muted-foreground">
                    Suggested:
                  </div>
                  {ttlSuggestions.map((ttl) => (
                    <Button
                      key={String(ttl)}
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px] leading-none"
                      onClick={() => {
                        if (ttl === "auto") {
                          setTtlMode("preset");
                          onRecordChange({ ...record, ttl: "auto" });
                          return;
                        }
                        if (getTTLPresets().includes(ttl)) {
                          setTtlMode("preset");
                        } else {
                          setTtlMode("custom");
                        }
                        onRecordChange({ ...record, ttl });
                      }}
                    >
                      {formatTtlLabel(ttl)}
                    </Button>
                  ))}
                </div>
              )}
              {ttlMode === "custom" && (
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
                    <TlsaBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "SSHFP":
                  return (
                    <SshfpBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "HINFO":
                  return (
                    <HinfoBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "LOC":
                  return (
                    <LocBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "AFSDB":
                  return (
                    <AfsdbBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "APL":
                  return (
                    <AplBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "RP":
                  return (
                    <RpBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "DNAME":
                  return (
                    <DnameBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "CERT":
                  return (
                    <CertBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "SMIMEA":
                  return (
                    <SmimeaBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "OPENPGPKEY":
                  return (
                    <OpenpgpkeyBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "NAPTR":
                  return (
                    <NaptrBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "ALIAS":
                case "ANAME":
                  return (
                    <AnameBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "URI":
                  return (
                    <UriBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "SVCB":
                case "HTTPS":
                  return (
                    <SvcbBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
                  );
                case "SOA":
                  return (
                    <SoaBuilder
                      record={record}
                      onRecordChange={onRecordChange}
                      zoneName={zoneName}
                      onWarningsChange={setActiveBuilderWarnings}
                    />
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
          <div className="space-y-2">
            <Label>{t("Comment", "Comment")}</Label>
            <Textarea
              aria-label={t("Comment input", "Comment")}
              value={record.comment ?? ""}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                onRecordChange({
                  ...record,
                  comment: e.target.value,
                })
              }
              placeholder={t(
                "Optional: add a note for this record",
                "Optional: add a note for this record",
              )}
              className="min-h-16 resize-y"
            />
            <div className="text-xs text-muted-foreground">
              Visible in Cloudflare and helps document why this record exists.
            </div>
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
            variant="default"
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
