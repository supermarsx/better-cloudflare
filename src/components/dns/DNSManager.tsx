
/**
 * Top-level DNS Manager UI which composes the zone selector, the record
 * list and dialogs for creating/importing records.
 */
import { useState, useEffect, useCallback, useMemo, useRef, type ChangeEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { Tag } from "@/components/ui/tag";
import { useCloudflareAPI } from "@/hooks/use-cloudflare-api";
import type { DNSRecord, Zone, ZoneSetting, RecordType } from "@/types/dns";
import { RECORD_TYPES } from "@/types/dns";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { storageManager, type SessionSettingsProfile } from "@/lib/storage";
import {
  ArrowUpDown,
  ClipboardPaste,
  Copy,
  ExternalLink,
  FileDown,
  FileUp,
  Filter,
  Plus,
  Globe,
  GripVertical,
  LogOut,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { isDesktop } from "@/lib/environment";
import { TauriClient } from "@/lib/tauri-client";
import { AddRecordDialog } from "./AddRecordDialog";
import { ImportExportDialog } from "./ImportExportDialog";
import { RecordRow } from "./RecordRow";
import { filterRecords } from "@/lib/dns-utils";
import { parseCSVRecords, parseBINDZone } from "@/lib/dns-parsers";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToastAction } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { RegistryMonitor } from "./RegistryMonitor";
import { ZoneTopologyTab } from "./ZoneTopologyTab";
import { useRegistrarMonitor } from "@/hooks/use-registrar-monitor";
import { runDomainAudit, type DomainAuditCategory } from "@/lib/domain-audit";
import type { DomainHealthCheck, DomainInfo } from "@/types/registrar";


type ActionTab =
  | "records"
  | "import"
  | "zone-settings"
  | "cache"
  | "ssl-tls"
  | "domain-audit"
  | "domain-registry"
  | "topology";
type TabKind = "zone" | "settings" | "audit" | "tags" | "registry";
type SortKey = "type" | "name" | "content" | "ttl" | "proxied";
type SortDir = "asc" | "desc" | null;
type SettingsSubtab = "general" | "topology" | "audit" | "profiles";
type ExportFolderPreset = "system" | "documents" | "downloads" | "desktop" | "custom";
type TopologyResolverMode = "dns" | "doh";
type TopologyDohProvider = "google" | "cloudflare" | "quad9" | "custom";
type TopologyGeoProvider = "auto" | "ipwhois" | "ipapi_co" | "ip_api" | "internal";
type TopologyCopyAction = "mermaid" | "svg" | "png";
type TopologyExportAction = "mermaid" | "svg" | "png" | "pdf";
type AuditFilterField = "operation" | "resource" | "timestamp" | "details";
type AuditFilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "matches"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

type AuditFilterRule = {
  id: string;
  field: AuditFilterField;
  operator: AuditFilterOperator;
  value: string;
};

const TOPOLOGY_TCP_SERVICE_OPTIONS: Array<{ port: number; label: string }> = [
  { port: 21, label: "FTP (21)" },
  { port: 22, label: "SSH (22)" },
  { port: 23, label: "Telnet (23)" },
  { port: 25, label: "SMTP (25)" },
  { port: 53, label: "DNS (53)" },
  { port: 80, label: "HTTP (80)" },
  { port: 110, label: "POP3 (110)" },
  { port: 143, label: "IMAP (143)" },
  { port: 443, label: "HTTPS (443)" },
  { port: 465, label: "SMTPS (465)" },
  { port: 587, label: "Submission (587)" },
  { port: 993, label: "IMAPS (993)" },
  { port: 995, label: "POP3S (995)" },
  { port: 3306, label: "MySQL (3306)" },
  { port: 5432, label: "PostgreSQL (5432)" },
];
const TOPOLOGY_COPY_ACTION_OPTIONS: Array<{ value: TopologyCopyAction; label: string }> = [
  { value: "mermaid", label: "Mermaid code" },
  { value: "svg", label: "SVG" },
  { value: "png", label: "PNG" },
];
const TOPOLOGY_EXPORT_ACTION_OPTIONS: Array<{ value: TopologyExportAction; label: string }> = [
  { value: "mermaid", label: "Mermaid code" },
  { value: "svg", label: "SVG" },
  { value: "png", label: "PNG" },
  { value: "pdf", label: "PDF" },
];
const TOPOLOGY_DNS_SERVER_LABELS: Record<string, string> = {
  "1.1.1.1": "1.1.1.1 (Cloudflare default)",
  "1.0.0.1": "1.0.0.1 (Cloudflare)",
  "8.8.8.8": "8.8.8.8 (Google)",
  "8.8.4.4": "8.8.4.4 (Google)",
  "9.9.9.9": "9.9.9.9 (Quad9)",
  "149.112.112.112": "149.112.112.112 (Quad9)",
  "208.67.222.222": "208.67.222.222 (OpenDNS)",
  "208.67.220.220": "208.67.220.220 (OpenDNS)",
  "94.140.14.14": "94.140.14.14 (AdGuard)",
  "76.76.2.0": "76.76.2.0 (Control D)",
  custom: "Custom",
};
const TOPOLOGY_GEO_PROVIDER_LABELS: Record<TopologyGeoProvider, string> = {
  auto: "Auto (multi-provider fallback)",
  ipwhois: "ipwho.is",
  ipapi_co: "ipapi.co",
  ip_api: "ip-api.com",
  internal: "Internal only (private/reserved IPs)",
};

type ZoneTab = {
  kind: TabKind;
  id: string;
  zoneId: string;
  zoneName: string;
  status?: string;
  records: DNSRecord[];
  isLoading: boolean;
  editingRecord: string | null;
  searchTerm: string;
  typeFilter: RecordType | "";
  page: number;
  perPage: number;
  sortKey: SortKey | null;
  sortDir: SortDir;
  selectedIds: string[];
  showAddRecord: boolean;
  showImport: boolean;
  newRecord: Partial<DNSRecord>;
  importData: string;
  importFormat: "json" | "csv" | "bind";
};

/**
 * Props for the `DNSManager` top-level component.
 */
interface DNSManagerProps {
  /** API key to be used for server requests (token or key) */
  apiKey: string;
  /** Optional email used when authenticating with a key+email pair */
  email?: string;
  /** Callback invoked when the user logs out */
  onLogout: () => void;
}

const ACTION_TABS: { id: ActionTab; label: string; hint: string }[] = [
  {
    id: "records",
    label: "Records",
    hint: "Edit, filter, and manage records in-place",
  },
  {
    id: "import",
    label: "Import/Export",
    hint: "Move records across zones and formats",
  },
  {
    id: "zone-settings",
    label: "Zone Settings",
    hint: "Override defaults for this zone",
  },
  {
    id: "cache",
    label: "Cache",
    hint: "Purge cache and tune Cloudflare caching",
  },
  {
    id: "ssl-tls",
    label: "SSL/TLS",
    hint: "Manage encryption and HTTPS behavior",
  },
  {
    id: "domain-audit",
    label: "Audits",
    hint: "Check DNS compliance and best practices",
  },
  {
    id: "domain-registry",
    label: "Registry",
    hint: "RDAP/WHOIS and registrar checks for this domain",
  },
  {
    id: "topology",
    label: "Topology",
    hint: "Visualize DNS relationships, CNAME chains, and shared services",
  },
];
const ACTION_TAB_LABELS: Record<TabKind, string> = {
  zone: "Zone",
  settings: "Settings",
  audit: "Audit",
  tags: "Tags",
  registry: "Registry",
};
const CACHE_LEVEL_DETAILS: Record<string, string> = {
  basic: "Standard caching behavior. Query strings are respected for cache variation.",
  aggressive:
    "Caches more aggressively by reducing query-string variation. Better hit rate, but ensure query params do not change content.",
  simplified:
    "Minimal query-string variation for maximum cache reuse. Use when URLs are already canonical and deterministic.",
};

const createEmptyRecord = (): Partial<DNSRecord> => ({
  type: "A",
  name: "",
  content: "",
  ttl: 300,
  proxied: false,
});

const createZoneTab = (zone: Zone, perPage: number): ZoneTab => ({
  kind: "zone",
  id: zone.id,
  zoneId: zone.id,
  zoneName: zone.name,
  status: zone.status,
  records: [],
  isLoading: false,
  editingRecord: null,
  searchTerm: "",
  typeFilter: "",
  page: 1,
  perPage,
  sortKey: null,
  sortDir: null,
  selectedIds: [],
  showAddRecord: false,
  showImport: false,
  newRecord: createEmptyRecord(),
  importData: "",
  importFormat: "json",
});
const createActionTab = (kind: Exclude<TabKind, "zone">): ZoneTab => ({
  kind,
  id: `__${kind}`,
  zoneId: "",
  zoneName: ACTION_TAB_LABELS[kind],
  status: undefined,
  records: [],
  isLoading: false,
  editingRecord: null,
  searchTerm: "",
  typeFilter: "",
  page: 1,
  perPage: 50,
  sortKey: null,
  sortDir: null,
  selectedIds: [],
  showAddRecord: false,
  showImport: false,
  newRecord: createEmptyRecord(),
  importData: "",
  importFormat: "json",
});

function parseAuditTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

function formatRelativeTime(timestampMs: number): string {
  const deltaSeconds = Math.round((timestampMs - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return rtf.format(deltaSeconds, "second");
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return rtf.format(deltaMinutes, "minute");
  const deltaHours = Math.round(deltaSeconds / 3600);
  if (Math.abs(deltaHours) < 24) return rtf.format(deltaHours, "hour");
  const deltaDays = Math.round(deltaSeconds / 86400);
  return rtf.format(deltaDays, "day");
}

function formatAuditTimestampShort(value: unknown): string {
  const parsed = parseAuditTimestamp(value);
  if (parsed === null) return "Unknown";
  const date = new Date(parsed);
  const short = date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${short} (${formatRelativeTime(parsed)})`;
}

function formatAuditTimestampFull(value: unknown): string {
  const parsed = parseAuditTimestamp(value);
  if (parsed === null) return "Unknown";
  const date = new Date(parsed);
  return `${date.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  })} | ${date.toISOString()}`;
}

function formatHumanizedDateTime(value: unknown): { short: string; full: string } {
  const parsed = parseAuditTimestamp(value);
  if (parsed === null) return { short: "—", full: "—" };
  const date = new Date(parsed);
  return {
    short: `${date.toLocaleDateString()} (${formatRelativeTime(parsed)})`,
    full: `${date.toLocaleString()} | ${date.toISOString()}`,
  };
}

function useLoadingOverlay(loading: boolean, timeoutMs: number): { visible: boolean } {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!loading) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const id = window.setTimeout(() => {
      setVisible(false);
    }, Math.max(1000, Math.min(60000, timeoutMs)));
    return () => window.clearTimeout(id);
  }, [loading, timeoutMs]);

  return { visible };
}

function SectionLoadingOverlay({ label }: { label: string }) {
  const theme =
    typeof document !== "undefined" ? document.documentElement.dataset.theme ?? "sunset" : "sunset";
  const isDarkOverlayTheme = theme === "sunset" || theme === "oled";
  const spinnerGradient =
    "conic-gradient(from 0deg, hsl(var(--primary)) 0deg, hsl(var(--primary) / 0.2) 90deg, hsl(var(--primary)) 220deg, hsl(var(--primary)) 360deg)";
  const spinnerGlowGradient =
    "conic-gradient(from 0deg, hsl(var(--primary)) 0deg, hsl(var(--primary) / 0.26) 110deg, hsl(var(--primary) / 0.95) 250deg, hsl(var(--primary)) 360deg)";
  const ringMask =
    "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px))";

  return (
    <div
      className={cn(
        "absolute inset-0 z-20 flex items-center justify-center rounded-xl backdrop-blur-2xl backdrop-saturate-150",
        isDarkOverlayTheme
          ? "bg-gradient-to-br from-black/88 via-black/82 to-primary/44"
          : "bg-gradient-to-br from-white/95 via-white/90 to-primary/12",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border border-primary/35 px-3 py-2 text-xs text-foreground shadow-[0_0_34px_hsl(var(--primary)/0.28)]",
          isDarkOverlayTheme ? "bg-card/85" : "bg-card/96",
        )}
      >
        <div className="relative h-5 w-5">
          <div
            className="absolute inset-0 rounded-full opacity-85 blur-[1px]"
            style={{ background: spinnerGlowGradient }}
          />
          <div
            className="absolute inset-0 animate-spin rounded-full"
            style={{
              background: spinnerGradient,
              WebkitMask: ringMask,
              mask: ringMask,
            }}
          />
          <div
            className={cn(
              "absolute inset-[5px] rounded-full",
              isDarkOverlayTheme ? "bg-card/85" : "bg-card/96",
            )}
          />
        </div>
        {label}
      </div>
    </div>
  );
}

function sanitizeDomainAuditCategories(
  value: Partial<Record<DomainAuditCategory, boolean>> | null | undefined,
): Record<DomainAuditCategory, boolean> {
  return {
    email: value?.email !== false,
    security: value?.security !== false,
    hygiene: value?.hygiene !== false,
  };
}

/**
 * DNS Manager component responsible for listing zones and DNS records and
 * providing UI for add/import/export/update/delete operations.
 *
 * @param apiKey - API key used to authenticate server requests
 * @param email - optional email when using key+email authentication
 * @param onLogout - callback invoked when the user logs out
 */
export function DNSManager({ apiKey, email, onLogout }: DNSManagerProps) {
  const { t } = useI18n();
  const initialZoneSelectionHandledRef = useRef(false);
  const settingsImportInputRef = useRef<HTMLInputElement | null>(null);
  const sessionProfileHydratedRef = useRef(false);
  const [zones, setZones] = useState<Zone[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState("");
  const [tabs, setTabs] = useState<ZoneTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [actionTab, setActionTab] = useState<ActionTab>("records");
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [globalPerPage, setGlobalPerPage] = useState(50);
  const [zonePerPage, setZonePerPage] = useState<Record<string, number>>({});
  const [showUnsupportedRecordTypes, setShowUnsupportedRecordTypes] = useState(
    storageManager.getShowUnsupportedRecordTypes(),
  );
  const [zoneShowUnsupportedRecordTypes, setZoneShowUnsupportedRecordTypes] =
    useState<Record<string, boolean>>(
      storageManager.getZoneShowUnsupportedRecordTypesMap(),
    );
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number | null>(
    storageManager.getAutoRefreshInterval(),
  );
  const registrarMonitor = useRegistrarMonitor(apiKey, email);
  const [auditEntries, setAuditEntries] = useState<Array<Record<string, unknown>>>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditFilters, setAuditFilters] = useState<AuditFilterRule[]>([]);
  const [auditSort, setAuditSort] = useState<{
    field: "timestamp" | "operation" | "resource";
    dir: "asc" | "desc";
  }>({ field: "timestamp", dir: "desc" });
  const [auditLimit, setAuditLimit] = useState("100");
  const [showClearAuditConfirm, setShowClearAuditConfirm] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [compactTopBar, setCompactTopBar] = useState(false);
  const [reopenLastTabs, setReopenLastTabs] = useState(false);
  const [reopenZoneTabs, setReopenZoneTabs] = useState<Record<string, boolean>>({});
  const [lastOpenTabs, setLastOpenTabs] = useState<string[]>([]);
  const [restoredTabs, setRestoredTabs] = useState(false);
  const [prefsReady, setPrefsReady] = useState(false);
  const [pendingLastActiveTab, setPendingLastActiveTab] = useState("");
  const [auditExportDefaultDocuments, setAuditExportDefaultDocuments] = useState(
    storageManager.getAuditExportDefaultDocuments(),
  );
  const [confirmClearAuditLogs, setConfirmClearAuditLogs] = useState(
    storageManager.getConfirmClearAuditLogs(),
  );
  const [auditExportFolderPreset, setAuditExportFolderPreset] = useState<ExportFolderPreset>(
    storageManager.getAuditExportFolderPreset() as ExportFolderPreset,
  );
  const [auditExportCustomPath, setAuditExportCustomPath] = useState(
    storageManager.getAuditExportCustomPath(),
  );
  const [auditExportSkipDestinationConfirm, setAuditExportSkipDestinationConfirm] =
    useState(storageManager.getAuditExportSkipDestinationConfirm());
  const [settingsSubtab, setSettingsSubtab] = useState<SettingsSubtab>("general");
  const [sessionSettingsProfiles, setSessionSettingsProfiles] = useState<
    Record<string, SessionSettingsProfile>
  >(storageManager.getSessionSettingsProfiles());
  const [cloneSourceSessionId, setCloneSourceSessionId] = useState("");
  const [copyBuffer, setCopyBuffer] = useState<{
    records: DNSRecord[];
    sourceZoneId: string;
    sourceZoneName: string;
  } | null>(null);

  const { toast } = useToast();
  const notifySaved = useCallback(
    (description: string) => {
      toast({ title: t("Saved", "Saved"), description });
    },
    [t, toast],
  );
  const [tagsZoneId, setTagsZoneId] = useState<string>("");
  const [newTag, setNewTag] = useState("");
  const [renameTagFrom, setRenameTagFrom] = useState<string | null>(null);
  const [renameTagTo, setRenameTagTo] = useState("");
  const [tagsVersion, setTagsVersion] = useState(0);
  const [tagManagerRecords, setTagManagerRecords] = useState<DNSRecord[]>([]);
  const [tagManagerRecordsLoading, setTagManagerRecordsLoading] = useState(false);
  const [tagManagerRecordsError, setTagManagerRecordsError] = useState<string | null>(null);
  const [tagAssociationSearch, setTagAssociationSearch] = useState("");
  const [tagAssociationDrafts, setTagAssociationDrafts] = useState<Record<string, string>>(
    {},
  );
  const [confirmLogout, setConfirmLogout] = useState(true);
  const [idleLogoutMs, setIdleLogoutMs] = useState<number | null>(null);
  const [confirmWindowClose, setConfirmWindowClose] = useState(true);
  const [loadingOverlayTimeoutMs, setLoadingOverlayTimeoutMs] = useState(
    storageManager.getLoadingOverlayTimeoutMs(),
  );
  const [topologyResolutionMaxHops, setTopologyResolutionMaxHops] = useState(
    storageManager.getTopologyResolutionMaxHops(),
  );
  const [topologyResolverMode, setTopologyResolverMode] = useState<TopologyResolverMode>(
    storageManager.getTopologyResolverMode(),
  );
  const [topologyDnsServer, setTopologyDnsServer] = useState(
    storageManager.getTopologyDnsServer(),
  );
  const [topologyCustomDnsServer, setTopologyCustomDnsServer] = useState(
    storageManager.getTopologyCustomDnsServer(),
  );
  const [topologyDohProvider, setTopologyDohProvider] = useState<TopologyDohProvider>(
    storageManager.getTopologyDohProvider(),
  );
  const [topologyDohCustomUrl, setTopologyDohCustomUrl] = useState(
    storageManager.getTopologyDohCustomUrl(),
  );
  const [topologyExportConfirmPath, setTopologyExportConfirmPath] = useState(
    storageManager.getTopologyExportConfirmPath(),
  );
  const [topologyExportFolderPreset, setTopologyExportFolderPreset] = useState<ExportFolderPreset>(
    storageManager.getTopologyExportFolderPreset() as ExportFolderPreset,
  );
  const [topologyExportCustomPath, setTopologyExportCustomPath] = useState(
    storageManager.getTopologyExportCustomPath(),
  );
  const [topologyCopyActions, setTopologyCopyActions] = useState<TopologyCopyAction[]>(
    storageManager.getTopologyCopyActions() as TopologyCopyAction[],
  );
  const [topologyExportActions, setTopologyExportActions] = useState<TopologyExportAction[]>(
    storageManager.getTopologyExportActions() as TopologyExportAction[],
  );
  const [topologyDisableAnnotations, setTopologyDisableAnnotations] = useState(
    storageManager.getTopologyDisableAnnotations(),
  );
  const [topologyDisableFullWindow, setTopologyDisableFullWindow] = useState(
    storageManager.getTopologyDisableFullWindow(),
  );
  const [topologyLookupTimeoutMs, setTopologyLookupTimeoutMs] = useState(
    storageManager.getTopologyLookupTimeoutMs(),
  );
  const [topologyDisablePtrLookups, setTopologyDisablePtrLookups] = useState(
    storageManager.getTopologyDisablePtrLookups(),
  );
  const [topologyDisableGeoLookups, setTopologyDisableGeoLookups] = useState(
    storageManager.getTopologyDisableGeoLookups(),
  );
  const [topologyGeoProvider, setTopologyGeoProvider] = useState<TopologyGeoProvider>(
    storageManager.getTopologyGeoProvider(),
  );
  const [topologyScanResolutionChain, setTopologyScanResolutionChain] = useState(
    storageManager.getTopologyScanResolutionChain(),
  );
  const [topologyDisableServiceDiscovery, setTopologyDisableServiceDiscovery] = useState(
    storageManager.getTopologyDisableServiceDiscovery(),
  );
  const [topologyTcpServices, setTopologyTcpServices] = useState<string[]>(
    storageManager.getTopologyTcpServices(),
  );
  const [cacheSettingsLoading, setCacheSettingsLoading] = useState(false);
  const [cacheSettingsError, setCacheSettingsError] = useState<string | null>(null);
  const [zoneDevMode, setZoneDevMode] = useState<ZoneSetting<string> | null>(null);
  const [zoneCacheLevel, setZoneCacheLevel] = useState<ZoneSetting<string> | null>(null);
  const [purgeUrlsInput, setPurgeUrlsInput] = useState("");
  const [showPurgeEverythingConfirm, setShowPurgeEverythingConfirm] = useState(false);
  const [showPurgeUrlsConfirm, setShowPurgeUrlsConfirm] = useState(false);
  const [pendingPurgeUrls, setPendingPurgeUrls] = useState<string[]>([]);
  const [pendingPurgeIssues, setPendingPurgeIssues] = useState<string[]>([]);
  const [sslSettingsLoading, setSslSettingsLoading] = useState(false);
  const [sslSettingsError, setSslSettingsError] = useState<string | null>(null);
  const [zoneSslMode, setZoneSslMode] = useState<ZoneSetting<string> | null>(null);
  const [zoneMinTlsVersion, setZoneMinTlsVersion] = useState<ZoneSetting<string> | null>(null);
  const [zoneTls13, setZoneTls13] = useState<ZoneSetting<string> | null>(null);
  const [zoneAlwaysUseHttps, setZoneAlwaysUseHttps] = useState<ZoneSetting<string> | null>(null);
  const [zoneAutoHttpsRewrites, setZoneAutoHttpsRewrites] = useState<ZoneSetting<string> | null>(null);
  const [zoneOpportunisticEncryption, setZoneOpportunisticEncryption] =
    useState<ZoneSetting<string> | null>(null);
  const [domainAuditShowPassed, setDomainAuditShowPassed] = useState(false);
  const [domainAuditCategories, setDomainAuditCategories] = useState<
    Record<DomainAuditCategory, boolean>
  >(sanitizeDomainAuditCategories(storageManager.getDomainAuditCategories()));
  const [auditOverridesByZone, setAuditOverridesByZone] = useState<Record<string, Set<string>>>({});
  const [registryLookupDomain, setRegistryLookupDomain] = useState("");
  const [registryChecksLoading, setRegistryChecksLoading] = useState(false);
  const [registryChecksError, setRegistryChecksError] = useState<string | null>(null);
  const [rdapResult, setRdapResult] = useState<Record<string, unknown> | null>(null);
  const [showRawRdap, setShowRawRdap] = useState(false);
  const [registrarDomainResult, setRegistrarDomainResult] = useState<DomainInfo | null>(null);
  const [registrarHealthResult, setRegistrarHealthResult] = useState<DomainHealthCheck | null>(null);
  const {
    getZones,
    getDNSRecords,
    createDNSRecord,
    updateDNSRecord,
    bulkCreateDNSRecords,
    deleteDNSRecord,
    exportDNSRecords,
    purgeCache,
    getZoneSetting,
    updateZoneSetting,
    registrarListAllDomains,
    registrarHealthCheckAll,
  } = useCloudflareAPI(apiKey, email);

  const availableZones = useMemo(
    () => zones.filter((zone) => zone.id),
    [zones],
  );

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const currentSessionId = useMemo(
    () => storageManager.getCurrentSession() ?? "__default",
    [],
  );
  const sessionProfileIds = useMemo(
    () => Object.keys(sessionSettingsProfiles).sort((a, b) => a.localeCompare(b)),
    [sessionSettingsProfiles],
  );

  const buildSessionSettingsProfile = useCallback((): SessionSettingsProfile => {
    return {
      autoRefreshInterval,
      defaultPerPage: globalPerPage,
      zonePerPage,
      showUnsupportedRecordTypes,
      zoneShowUnsupportedRecordTypes,
      reopenLastTabs,
      reopenZoneTabs,
      confirmLogout,
      idleLogoutMs,
      confirmWindowClose,
      loadingOverlayTimeoutMs,
      topologyResolutionMaxHops,
      topologyResolverMode,
      topologyDnsServer,
      topologyCustomDnsServer,
      topologyDohProvider,
      topologyDohCustomUrl,
      topologyExportConfirmPath,
      topologyExportFolderPreset,
      topologyExportCustomPath,
      topologyCopyActions,
      topologyExportActions,
      topologyDisableAnnotations,
      topologyDisableFullWindow,
      topologyLookupTimeoutMs,
      topologyDisablePtrLookups,
      topologyDisableGeoLookups,
      topologyGeoProvider,
      topologyScanResolutionChain,
      topologyDisableServiceDiscovery,
      topologyTcpServices,
      auditExportDefaultDocuments,
      confirmClearAuditLogs,
      auditExportFolderPreset,
      auditExportCustomPath,
      auditExportSkipDestinationConfirm,
      domainAuditCategories,
    };
  }, [
    autoRefreshInterval,
    globalPerPage,
    zonePerPage,
    showUnsupportedRecordTypes,
    zoneShowUnsupportedRecordTypes,
    reopenLastTabs,
    reopenZoneTabs,
    confirmLogout,
    idleLogoutMs,
    confirmWindowClose,
    loadingOverlayTimeoutMs,
    topologyResolutionMaxHops,
    topologyResolverMode,
    topologyDnsServer,
    topologyCustomDnsServer,
    topologyDohProvider,
    topologyDohCustomUrl,
    topologyExportConfirmPath,
    topologyExportFolderPreset,
    topologyExportCustomPath,
    topologyCopyActions,
    topologyExportActions,
    topologyDisableAnnotations,
    topologyDisableFullWindow,
    topologyLookupTimeoutMs,
    topologyDisablePtrLookups,
    topologyDisableGeoLookups,
    topologyGeoProvider,
    topologyScanResolutionChain,
    topologyDisableServiceDiscovery,
    topologyTcpServices,
    auditExportDefaultDocuments,
    confirmClearAuditLogs,
    auditExportFolderPreset,
    auditExportCustomPath,
    auditExportSkipDestinationConfirm,
    domainAuditCategories,
  ]);

  const applySessionSettingsProfile = useCallback((profile: SessionSettingsProfile) => {
    if (typeof profile.autoRefreshInterval === "number" || profile.autoRefreshInterval === null) {
      setAutoRefreshInterval(profile.autoRefreshInterval ?? null);
    }
    if (typeof profile.defaultPerPage === "number") {
      setGlobalPerPage(profile.defaultPerPage);
    }
    if (profile.zonePerPage && typeof profile.zonePerPage === "object") {
      setZonePerPage(profile.zonePerPage);
    }
    if (typeof profile.showUnsupportedRecordTypes === "boolean") {
      setShowUnsupportedRecordTypes(profile.showUnsupportedRecordTypes);
    }
    if (
      profile.zoneShowUnsupportedRecordTypes &&
      typeof profile.zoneShowUnsupportedRecordTypes === "object"
    ) {
      setZoneShowUnsupportedRecordTypes(profile.zoneShowUnsupportedRecordTypes);
    }
    if (typeof profile.reopenLastTabs === "boolean") {
      setReopenLastTabs(profile.reopenLastTabs);
    }
    if (profile.reopenZoneTabs && typeof profile.reopenZoneTabs === "object") {
      setReopenZoneTabs(profile.reopenZoneTabs);
    }
    if (typeof profile.confirmLogout === "boolean") {
      setConfirmLogout(profile.confirmLogout);
    }
    if (typeof profile.idleLogoutMs === "number" || profile.idleLogoutMs === null) {
      setIdleLogoutMs(profile.idleLogoutMs ?? null);
    }
    if (typeof profile.confirmWindowClose === "boolean") {
      setConfirmWindowClose(profile.confirmWindowClose);
    }
    if (typeof profile.loadingOverlayTimeoutMs === "number") {
      setLoadingOverlayTimeoutMs(Math.max(1000, Math.min(60000, profile.loadingOverlayTimeoutMs)));
    }
    if (typeof profile.topologyResolutionMaxHops === "number") {
      setTopologyResolutionMaxHops(Math.max(1, Math.min(15, Math.round(profile.topologyResolutionMaxHops))));
    }
    if (profile.topologyResolverMode === "dns" || profile.topologyResolverMode === "doh") {
      setTopologyResolverMode(profile.topologyResolverMode);
    }
    if (typeof profile.topologyDnsServer === "string") {
      setTopologyDnsServer(profile.topologyDnsServer || "1.1.1.1");
    }
    if (typeof profile.topologyCustomDnsServer === "string") {
      setTopologyCustomDnsServer(profile.topologyCustomDnsServer);
    }
    if (
      profile.topologyDohProvider === "google" ||
      profile.topologyDohProvider === "cloudflare" ||
      profile.topologyDohProvider === "quad9" ||
      profile.topologyDohProvider === "custom"
    ) {
      setTopologyDohProvider(profile.topologyDohProvider);
    }
    if (typeof profile.topologyDohCustomUrl === "string") {
      setTopologyDohCustomUrl(profile.topologyDohCustomUrl);
    }
    if (typeof profile.topologyExportConfirmPath === "boolean") {
      setTopologyExportConfirmPath(profile.topologyExportConfirmPath);
    }
    if (typeof profile.topologyExportFolderPreset === "string") {
      setTopologyExportFolderPreset(profile.topologyExportFolderPreset as ExportFolderPreset);
    }
    if (typeof profile.topologyExportCustomPath === "string") {
      setTopologyExportCustomPath(profile.topologyExportCustomPath);
    }
    if (Array.isArray(profile.topologyCopyActions)) {
      setTopologyCopyActions(
        Array.from(
          new Set(
            profile.topologyCopyActions
              .map((v) => String(v).trim())
              .filter((v): v is TopologyCopyAction => v === "mermaid" || v === "svg" || v === "png"),
          ),
        ),
      );
    }
    if (Array.isArray(profile.topologyExportActions)) {
      setTopologyExportActions(
        Array.from(
          new Set(
            profile.topologyExportActions
              .map((v) => String(v).trim())
              .filter((v): v is TopologyExportAction => v === "mermaid" || v === "svg" || v === "png" || v === "pdf"),
          ),
        ),
      );
    }
    if (typeof profile.topologyDisableAnnotations === "boolean") {
      setTopologyDisableAnnotations(profile.topologyDisableAnnotations);
    }
    if (typeof profile.topologyDisableFullWindow === "boolean") {
      setTopologyDisableFullWindow(profile.topologyDisableFullWindow);
    }
    if (typeof profile.topologyLookupTimeoutMs === "number") {
      setTopologyLookupTimeoutMs(Math.max(250, Math.min(10000, Math.round(profile.topologyLookupTimeoutMs))));
    }
    if (typeof profile.topologyDisablePtrLookups === "boolean") {
      setTopologyDisablePtrLookups(profile.topologyDisablePtrLookups);
    }
    if (typeof profile.topologyDisableGeoLookups === "boolean") {
      setTopologyDisableGeoLookups(profile.topologyDisableGeoLookups);
    }
    if (
      profile.topologyGeoProvider === "auto" ||
      profile.topologyGeoProvider === "ipwhois" ||
      profile.topologyGeoProvider === "ipapi_co" ||
      profile.topologyGeoProvider === "ip_api" ||
      profile.topologyGeoProvider === "internal"
    ) {
      setTopologyGeoProvider(profile.topologyGeoProvider);
    }
    if (typeof profile.topologyScanResolutionChain === "boolean") {
      setTopologyScanResolutionChain(profile.topologyScanResolutionChain);
    }
    if (typeof profile.topologyDisableServiceDiscovery === "boolean") {
      setTopologyDisableServiceDiscovery(profile.topologyDisableServiceDiscovery);
    }
    if (Array.isArray(profile.topologyTcpServices)) {
      setTopologyTcpServices(
        Array.from(new Set(profile.topologyTcpServices.map((v) => String(v).trim()).filter(Boolean))),
      );
    }
    if (typeof profile.auditExportDefaultDocuments === "boolean") {
      setAuditExportDefaultDocuments(profile.auditExportDefaultDocuments);
    }
    if (typeof profile.confirmClearAuditLogs === "boolean") {
      setConfirmClearAuditLogs(profile.confirmClearAuditLogs);
    }
    if (typeof profile.auditExportFolderPreset === "string") {
      setAuditExportFolderPreset(profile.auditExportFolderPreset as ExportFolderPreset);
    }
    if (typeof profile.auditExportCustomPath === "string") {
      setAuditExportCustomPath(profile.auditExportCustomPath);
    }
    if (typeof profile.auditExportSkipDestinationConfirm === "boolean") {
      setAuditExportSkipDestinationConfirm(profile.auditExportSkipDestinationConfirm);
    }
    if (profile.domainAuditCategories) {
      setDomainAuditCategories(sanitizeDomainAuditCategories(profile.domainAuditCategories));
    }
  }, []);

  useEffect(() => {
    if (!prefsReady) return;
    if (sessionProfileHydratedRef.current) return;
    const profile = sessionSettingsProfiles[currentSessionId];
    if (profile) {
      applySessionSettingsProfile(profile);
    }
    sessionProfileHydratedRef.current = true;
  }, [applySessionSettingsProfile, currentSessionId, prefsReady, sessionSettingsProfiles]);

  const resolvedShowUnsupportedRecordTypes = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return showUnsupportedRecordTypes;
    const zoneId = activeTab.zoneId;
    if (Object.prototype.hasOwnProperty.call(zoneShowUnsupportedRecordTypes, zoneId))
      return zoneShowUnsupportedRecordTypes[zoneId] === true;
    return showUnsupportedRecordTypes;
  }, [activeTab, showUnsupportedRecordTypes, zoneShowUnsupportedRecordTypes]);

  const domainAuditItems = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return [];
    const zone = activeTab.zoneName.trim().toLowerCase();
    const registrarExpiry =
      registrarDomainResult &&
      registrarDomainResult.domain.trim().toLowerCase() === zone
        ? registrarDomainResult.expires_at
        : null;
    const rdapEventsRaw = Array.isArray((rdapResult as Record<string, unknown> | null)?.events)
      ? ((rdapResult as Record<string, unknown>).events as Array<Record<string, unknown>>)
      : [];
    const rdapExpiryEvent =
      rdapEventsRaw
        .find((event) =>
          String(event.eventAction ?? "")
            .toLowerCase()
            .includes("expiration"),
        )
        ?.eventDate?.toString() ?? null;
    return runDomainAudit(activeTab.zoneName, activeTab.records, {
      includeCategories: domainAuditCategories,
      domainExpiresAt: registrarExpiry ?? rdapExpiryEvent,
    });
  }, [activeTab, domainAuditCategories, rdapResult, registrarDomainResult]);

  const domainAuditItemsWithOverrides = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return domainAuditItems;
    const overrides = auditOverridesByZone[activeTab.zoneId] ?? new Set();
    return domainAuditItems.map((item) => {
      if (overrides.has(item.id) && item.severity !== "pass") {
        return {
          ...item,
          severity: "pass" as const,
          title: `${item.title} (overridden)`,
          details: `Original severity: ${item.severity}\n\n${item.details}`,
        };
      }
      return item;
    });
  }, [activeTab, auditOverridesByZone, domainAuditItems]);

  const domainAuditVisibleItems = useMemo(() => {
    if (domainAuditShowPassed) return domainAuditItemsWithOverrides;
    return domainAuditItemsWithOverrides.filter((i) => i.severity !== "pass");
  }, [domainAuditItemsWithOverrides, domainAuditShowPassed]);

  const parseLastActiveTab = useCallback((value: string): { tabId: string; action?: ActionTab } | null => {
    const raw = value.trim();
    if (!raw) return null;
    if (raw.startsWith("__")) return { tabId: raw };
    if (
      raw === "records" ||
      raw === "import" ||
      raw === "zone-settings" ||
      raw === "cache" ||
      raw === "ssl-tls" ||
      raw === "domain-audit" ||
      raw === "domain-registry" ||
      raw === "topology"
    ) {
      // Legacy malformed value (action without zone id): ignore.
      return null;
    }
    const [zoneId, actionRaw] = raw.split("|", 2);
    if (!zoneId) return null;
    if (
      actionRaw === "records" ||
      actionRaw === "import" ||
      actionRaw === "zone-settings" ||
      actionRaw === "cache" ||
      actionRaw === "ssl-tls" ||
      actionRaw === "domain-audit" ||
      actionRaw === "domain-registry" ||
      actionRaw === "topology"
    ) {
      return { tabId: zoneId, action: actionRaw };
    }
    return { tabId: zoneId };
  }, [t]);

  const updateTab = useCallback(
    (tabId: string, updater: (tab: ZoneTab) => ZoneTab) => {
      setTabs((prev) =>
        prev.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
      );
    },
    [],
  );

  const openZoneTab = useCallback(
    (zoneId: string) => {
      const zone = availableZones.find((item) => item.id === zoneId);
      if (!zone) return;
      setTabs((prev) => {
        if (prev.some((tab) => tab.zoneId === zoneId)) return prev;
        const perPage = zonePerPage[zoneId] ?? globalPerPage;
        return [...prev, createZoneTab(zone, perPage)];
      });
      setActiveTabId(zoneId);
    },
    [availableZones, globalPerPage, zonePerPage],
  );

  const activateTab = useCallback(
    (tabId: string) => {
      const nextTab = tabs.find((tab) => tab.id === tabId);
      setActiveTabId(tabId);
      if (nextTab?.kind === "zone") {
        setSelectedZoneId(tabId);
        setActionTab("records");
      } else {
        setSelectedZoneId("");
      }
    },
    [tabs],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const nextTabs = prev.filter((tab) => tab.id !== tabId);
        if (activeTabId === tabId) {
          const nextActive = nextTabs[nextTabs.length - 1];
          setActiveTabId(nextActive?.id ?? null);
          if (nextActive?.kind === "zone") {
            setSelectedZoneId(nextActive.zoneId);
            setActionTab("records");
          } else {
            setSelectedZoneId("");
          }
        }
        return nextTabs;
      });
    },
    [activeTabId],
  );
  const openActionTab = useCallback(
    (kind: Exclude<TabKind, "zone">) => {
      const id = `__${kind}`;
      setTabs((prev) => {
        if (prev.some((tab) => tab.id === id)) return prev;
        return [...prev, createActionTab(kind)];
      });
      setActiveTabId(id);
      setSelectedZoneId("");
    },
    [],
  );
  const loadZones = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const zonesData = await getZones(signal);
        setZones(zonesData);
      } catch (error) {
        toast({
          title: t("Error", "Error"),
          description: t("Failed to load zones: {{error}}", {
            error: (error as Error).message,
            defaultValue: `Failed to load zones: ${(error as Error).message}`,
          }),
          variant: "destructive",
        });
      }
    },
    [getZones, toast],
  );

  const reorderTabs = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setTabs((prev) => {
      const sourceIndex = prev.findIndex((tab) => tab.id === sourceId);
      const targetIndex = prev.findIndex((tab) => tab.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  const moveTabToEnd = useCallback((sourceId: string) => {
    setTabs((prev) => {
      const sourceIndex = prev.findIndex((tab) => tab.id === sourceId);
      if (sourceIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.push(moved);
      return next;
    });
  }, []);

  const loadAuditEntries = useCallback(async () => {
    if (!isDesktop()) {
      setAuditError(
        t(
          "Audit log is only available in the desktop app.",
          "Audit log is only available in the desktop app.",
        ),
      );
      return;
    }
    setAuditLoading(true);
    setAuditError(null);
    try {
      const list = await TauriClient.getAuditEntries();
      const items = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
      setAuditEntries(items);
    } catch (err) {
      setAuditError((err as Error).message);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const loadRecords = useCallback(
    async (tab: ZoneTab, signal?: AbortSignal) => {
      if (!tab.zoneId) return;
      updateTab(tab.id, (prev) => ({ ...prev, isLoading: true }));
      try {
        if (tab.perPage === 0) {
          const pageSize = 500;
          let currentPage = 1;
          let combined: DNSRecord[] = [];
          while (true) {
            const batch = await getDNSRecords(
              tab.zoneId,
              currentPage,
              pageSize,
              signal,
            );
            combined = combined.concat(batch);
            if (batch.length < pageSize) break;
            currentPage += 1;
          }
          updateTab(tab.id, (prev) => ({ ...prev, records: combined }));
        } else {
          const recordsData = await getDNSRecords(
            tab.zoneId,
            tab.page,
            tab.perPage,
            signal,
          );
          updateTab(tab.id, (prev) => ({ ...prev, records: recordsData }));
        }
      } catch (error) {
        toast({
          title: t("Error", "Error"),
          description: t("Failed to load DNS records: {{error}}", {
            error: (error as Error).message,
            defaultValue: `Failed to load DNS records: ${(error as Error).message}`,
          }),
          variant: "destructive",
        });
      } finally {
        updateTab(tab.id, (prev) => ({ ...prev, isLoading: false }));
      }
    },
    [getDNSRecords, toast, updateTab],
  );

  const loadTagManagerRecords = useCallback(
    async (zoneId: string, signal?: AbortSignal) => {
      if (!zoneId) {
        setTagManagerRecords([]);
        setTagManagerRecordsError(null);
        return;
      }
      setTagManagerRecordsLoading(true);
      setTagManagerRecordsError(null);
      try {
        const pageSize = 500;
        let currentPage = 1;
        let combined: DNSRecord[] = [];
        while (true) {
          const batch = await getDNSRecords(zoneId, currentPage, pageSize, signal);
          combined = combined.concat(batch);
          if (batch.length < pageSize) break;
          currentPage += 1;
        }
        setTagManagerRecords(combined);
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setTagManagerRecordsError((error as Error).message);
      } finally {
        setTagManagerRecordsLoading(false);
      }
    },
    [getDNSRecords],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadZones(controller.signal);
    return () => controller.abort();
  }, [loadZones]);

  useEffect(() => {
    let rafId = 0;
    const updateCompactState = () => {
      const nextCompact = window.scrollY > 120;
      setCompactTopBar((prev) => (prev === nextCompact ? prev : nextCompact));
    };
    const onScroll = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        updateCompactState();
      });
    };
    updateCompactState();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    if (!prefsReady) return;
    if (!selectedZoneId) return;

    if (!initialZoneSelectionHandledRef.current) {
      initialZoneSelectionHandledRef.current = true;
      if (reopenLastTabs) return;
    }

    openZoneTab(selectedZoneId);
  }, [selectedZoneId, openZoneTab, prefsReady, reopenLastTabs]);

  useEffect(() => {
    if (activeTab?.kind === "zone") {
      const controller = new AbortController();
      loadRecords(activeTab, controller.signal);
      return () => controller.abort();
    }
  }, [activeTab?.zoneId, activeTab?.page, activeTab?.perPage, activeTab?.kind, loadRecords]);

  useEffect(() => {
    if (activeTab?.kind === "audit") {
      loadAuditEntries();
    }
  }, [activeTab?.kind, loadAuditEntries]);

  const refreshCacheSettings = useCallback(
    async (zoneId: string) => {
      setCacheSettingsLoading(true);
      setCacheSettingsError(null);
      setZoneDevMode(null);
      setZoneCacheLevel(null);
      try {
        const results = await Promise.allSettled([
          getZoneSetting<string>(zoneId, "development_mode"),
          getZoneSetting<string>(zoneId, "cache_level"),
        ]);
        const [dev, level] = results;
        if (dev.status === "fulfilled") setZoneDevMode(dev.value);
        if (level.status === "fulfilled") setZoneCacheLevel(level.value);
        const errors = results
          .filter((r) => r.status === "rejected")
          .map((r) => (r as PromiseRejectedResult).reason)
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .filter(Boolean);
        if (errors.length) setCacheSettingsError(errors.join(" | "));
      } catch (e) {
        setCacheSettingsError(e instanceof Error ? e.message : String(e));
      } finally {
        setCacheSettingsLoading(false);
      }
    },
    [getZoneSetting],
  );

  const refreshSslSettings = useCallback(
    async (zoneId: string) => {
      setSslSettingsLoading(true);
      setSslSettingsError(null);
      setZoneSslMode(null);
      setZoneMinTlsVersion(null);
      setZoneTls13(null);
      setZoneAlwaysUseHttps(null);
      setZoneAutoHttpsRewrites(null);
      setZoneOpportunisticEncryption(null);
      try {
        const results = await Promise.allSettled([
          getZoneSetting<string>(zoneId, "ssl"),
          getZoneSetting<string>(zoneId, "min_tls_version"),
          getZoneSetting<string>(zoneId, "tls_1_3"),
          getZoneSetting<string>(zoneId, "always_use_https"),
          getZoneSetting<string>(zoneId, "automatic_https_rewrites"),
          getZoneSetting<string>(zoneId, "opportunistic_encryption"),
        ]);
        const [ssl, minTls, tls13, alwaysHttps, rewrites, oppEnc] = results;
        if (ssl.status === "fulfilled") setZoneSslMode(ssl.value);
        if (minTls.status === "fulfilled") setZoneMinTlsVersion(minTls.value);
        if (tls13.status === "fulfilled") setZoneTls13(tls13.value);
        if (alwaysHttps.status === "fulfilled") setZoneAlwaysUseHttps(alwaysHttps.value);
        if (rewrites.status === "fulfilled") setZoneAutoHttpsRewrites(rewrites.value);
        if (oppEnc.status === "fulfilled") setZoneOpportunisticEncryption(oppEnc.value);
        const errors = results
          .filter((r) => r.status === "rejected")
          .map((r) => (r as PromiseRejectedResult).reason)
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .filter(Boolean);
        if (errors.length) setSslSettingsError(errors.join(" | "));
      } catch (e) {
        setSslSettingsError(e instanceof Error ? e.message : String(e));
      } finally {
        setSslSettingsLoading(false);
      }
    },
    [getZoneSetting],
  );

  useEffect(() => {
    if (!activeTab || activeTab.kind !== "zone") return;
    if (actionTab !== "cache") return;
    void refreshCacheSettings(activeTab.zoneId);
  }, [actionTab, activeTab?.kind, activeTab?.zoneId, refreshCacheSettings]);

  useEffect(() => {
    if (!activeTab || activeTab.kind !== "zone") return;
    if (actionTab !== "ssl-tls") return;
    void refreshSslSettings(activeTab.zoneId);
  }, [actionTab, activeTab?.kind, activeTab?.zoneId, refreshSslSettings]);

  useEffect(() => {
    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) => {
          const prefObj = prefs as {
            last_zone?: string;
            last_active_tab?: string;
            auto_refresh_interval?: number;
            default_per_page?: number;
            zone_per_page?: Record<string, number>;
            show_unsupported_record_types?: boolean;
            zone_show_unsupported_record_types?: Record<string, boolean>;
            reopen_last_tabs?: boolean;
            reopen_zone_tabs?: Record<string, boolean>;
            last_open_tabs?: string[];
            confirm_logout?: boolean;
            idle_logout_ms?: number | null;
            confirm_window_close?: boolean;
            loading_overlay_timeout_ms?: number;
            topology_resolution_max_hops?: number;
            topology_resolver_mode?: TopologyResolverMode;
            topology_dns_server?: string;
            topology_custom_dns_server?: string;
            topology_doh_provider?: TopologyDohProvider;
            topology_doh_custom_url?: string;
            topology_export_confirm_path?: boolean;
            topology_export_folder_preset?: string;
            topology_export_custom_path?: string;
            topology_copy_actions?: string[];
            topology_export_actions?: string[];
            topology_disable_annotations?: boolean;
            topology_disable_full_window?: boolean;
            topology_lookup_timeout_ms?: number;
            topology_disable_ptr_lookups?: boolean;
            topology_disable_geo_lookups?: boolean;
            topology_geo_provider?: TopologyGeoProvider;
            topology_scan_resolution_chain?: boolean;
            topology_disable_service_discovery?: boolean;
            topology_tcp_services?: string[];
            audit_export_default_documents?: boolean;
            confirm_clear_audit_logs?: boolean;
            audit_export_folder_preset?: string;
            audit_export_custom_path?: string;
            audit_export_skip_destination_confirm?: boolean;
            domain_audit_categories?: Record<DomainAuditCategory, boolean>;
            session_settings_profiles?: Record<string, SessionSettingsProfile>;
          };
          if (prefObj.last_zone) setSelectedZoneId(prefObj.last_zone);
          if (typeof prefObj.last_active_tab === "string") {
            setPendingLastActiveTab(prefObj.last_active_tab);
          }
          if (typeof prefObj.auto_refresh_interval === "number") {
            setAutoRefreshInterval(prefObj.auto_refresh_interval);
          }
          if (typeof prefObj.default_per_page === "number") {
            setGlobalPerPage(prefObj.default_per_page);
          }
          if (prefObj.zone_per_page && typeof prefObj.zone_per_page === "object") {
            setZonePerPage(prefObj.zone_per_page);
          }
          if (typeof prefObj.show_unsupported_record_types === "boolean") {
            setShowUnsupportedRecordTypes(prefObj.show_unsupported_record_types);
          }
          if (
            prefObj.zone_show_unsupported_record_types &&
            typeof prefObj.zone_show_unsupported_record_types === "object"
          ) {
            setZoneShowUnsupportedRecordTypes(prefObj.zone_show_unsupported_record_types);
          }
          if (typeof prefObj.reopen_last_tabs === "boolean") {
            setReopenLastTabs(prefObj.reopen_last_tabs);
          }
          if (prefObj.reopen_zone_tabs && typeof prefObj.reopen_zone_tabs === "object") {
            setReopenZoneTabs(prefObj.reopen_zone_tabs);
          }
          if (Array.isArray(prefObj.last_open_tabs)) {
            setLastOpenTabs(prefObj.last_open_tabs);
          }
          if (typeof prefObj.confirm_logout === "boolean") {
            setConfirmLogout(prefObj.confirm_logout);
          }
          if (
            typeof prefObj.idle_logout_ms === "number" ||
            prefObj.idle_logout_ms === null
          ) {
            setIdleLogoutMs(prefObj.idle_logout_ms ?? null);
          }
          if (typeof prefObj.confirm_window_close === "boolean") {
            setConfirmWindowClose(prefObj.confirm_window_close);
          }
          if (typeof prefObj.loading_overlay_timeout_ms === "number") {
            setLoadingOverlayTimeoutMs(
              Math.max(1000, Math.min(60000, prefObj.loading_overlay_timeout_ms)),
            );
          }
          if (typeof prefObj.topology_resolution_max_hops === "number") {
            setTopologyResolutionMaxHops(
              Math.max(1, Math.min(15, Math.round(prefObj.topology_resolution_max_hops))),
            );
          }
          if (prefObj.topology_resolver_mode === "dns" || prefObj.topology_resolver_mode === "doh") {
            setTopologyResolverMode(prefObj.topology_resolver_mode);
          }
          if (typeof prefObj.topology_dns_server === "string") {
            setTopologyDnsServer(prefObj.topology_dns_server || "1.1.1.1");
          }
          if (typeof prefObj.topology_custom_dns_server === "string") {
            setTopologyCustomDnsServer(prefObj.topology_custom_dns_server);
          }
          if (
            prefObj.topology_doh_provider === "google" ||
            prefObj.topology_doh_provider === "cloudflare" ||
            prefObj.topology_doh_provider === "quad9" ||
            prefObj.topology_doh_provider === "custom"
          ) {
            setTopologyDohProvider(prefObj.topology_doh_provider);
          }
          if (typeof prefObj.topology_doh_custom_url === "string") {
            setTopologyDohCustomUrl(prefObj.topology_doh_custom_url);
          }
          if (typeof prefObj.topology_export_confirm_path === "boolean") {
            setTopologyExportConfirmPath(prefObj.topology_export_confirm_path);
          }
          if (typeof prefObj.topology_export_folder_preset === "string") {
            setTopologyExportFolderPreset(prefObj.topology_export_folder_preset as ExportFolderPreset);
          }
          if (typeof prefObj.topology_export_custom_path === "string") {
            setTopologyExportCustomPath(prefObj.topology_export_custom_path);
          }
          if (Array.isArray(prefObj.topology_copy_actions)) {
            setTopologyCopyActions(
              Array.from(
                new Set(
                  prefObj.topology_copy_actions
                    .map((v) => String(v).trim())
                    .filter((v): v is TopologyCopyAction => v === "mermaid" || v === "svg" || v === "png"),
                ),
              ),
            );
          }
          if (Array.isArray(prefObj.topology_export_actions)) {
            setTopologyExportActions(
              Array.from(
                new Set(
                  prefObj.topology_export_actions
                    .map((v) => String(v).trim())
                    .filter((v): v is TopologyExportAction => v === "mermaid" || v === "svg" || v === "png" || v === "pdf"),
                ),
              ),
            );
          }
          if (typeof prefObj.topology_disable_annotations === "boolean") {
            setTopologyDisableAnnotations(prefObj.topology_disable_annotations);
          }
          if (typeof prefObj.topology_disable_full_window === "boolean") {
            setTopologyDisableFullWindow(prefObj.topology_disable_full_window);
          }
          if (typeof prefObj.topology_lookup_timeout_ms === "number") {
            setTopologyLookupTimeoutMs(Math.max(250, Math.min(10000, Math.round(prefObj.topology_lookup_timeout_ms))));
          }
          if (typeof prefObj.topology_disable_ptr_lookups === "boolean") {
            setTopologyDisablePtrLookups(prefObj.topology_disable_ptr_lookups);
          }
          if (typeof prefObj.topology_disable_geo_lookups === "boolean") {
            setTopologyDisableGeoLookups(prefObj.topology_disable_geo_lookups);
          }
          if (
            prefObj.topology_geo_provider === "auto" ||
            prefObj.topology_geo_provider === "ipwhois" ||
            prefObj.topology_geo_provider === "ipapi_co" ||
            prefObj.topology_geo_provider === "ip_api" ||
            prefObj.topology_geo_provider === "internal"
          ) {
            setTopologyGeoProvider(prefObj.topology_geo_provider);
          }
          if (typeof prefObj.topology_scan_resolution_chain === "boolean") {
            setTopologyScanResolutionChain(prefObj.topology_scan_resolution_chain);
          }
          if (typeof prefObj.topology_disable_service_discovery === "boolean") {
            setTopologyDisableServiceDiscovery(prefObj.topology_disable_service_discovery);
          }
          if (Array.isArray(prefObj.topology_tcp_services)) {
            setTopologyTcpServices(
              Array.from(new Set(prefObj.topology_tcp_services.map((v) => String(v).trim()).filter(Boolean))),
            );
          }
          if (typeof prefObj.audit_export_default_documents === "boolean") {
            setAuditExportDefaultDocuments(prefObj.audit_export_default_documents);
          }
          if (typeof prefObj.confirm_clear_audit_logs === "boolean") {
            setConfirmClearAuditLogs(prefObj.confirm_clear_audit_logs);
          }
          if (typeof prefObj.audit_export_folder_preset === "string") {
            setAuditExportFolderPreset(prefObj.audit_export_folder_preset as ExportFolderPreset);
          }
          if (typeof prefObj.audit_export_custom_path === "string") {
            setAuditExportCustomPath(prefObj.audit_export_custom_path);
          }
          if (typeof prefObj.audit_export_skip_destination_confirm === "boolean") {
            setAuditExportSkipDestinationConfirm(prefObj.audit_export_skip_destination_confirm);
          }
          if (prefObj.domain_audit_categories && typeof prefObj.domain_audit_categories === "object") {
            setDomainAuditCategories(sanitizeDomainAuditCategories(prefObj.domain_audit_categories));
          }
          if (
            prefObj.session_settings_profiles &&
            typeof prefObj.session_settings_profiles === "object"
          ) {
            setSessionSettingsProfiles(prefObj.session_settings_profiles);
          }
        })
        .catch(() => {})
        .finally(() => setPrefsReady(true));
      return;
    }
    const last = storageManager.getLastZone();
    if (last) setSelectedZoneId(last);
    setGlobalPerPage(storageManager.getDefaultPerPage());
    setZonePerPage(storageManager.getZonePerPageMap());
    setShowUnsupportedRecordTypes(storageManager.getShowUnsupportedRecordTypes());
    setZoneShowUnsupportedRecordTypes(
      storageManager.getZoneShowUnsupportedRecordTypesMap(),
    );
    setReopenLastTabs(storageManager.getReopenLastTabs());
    setReopenZoneTabs(storageManager.getReopenZoneTabs());
    setLastOpenTabs(storageManager.getLastOpenTabs());
    setPendingLastActiveTab(storageManager.getLastActiveTabId());
    setConfirmLogout(storageManager.getConfirmLogout());
    setIdleLogoutMs(storageManager.getIdleLogoutMs());
    setConfirmWindowClose(storageManager.getConfirmWindowClose());
    setLoadingOverlayTimeoutMs(storageManager.getLoadingOverlayTimeoutMs());
    setTopologyResolutionMaxHops(storageManager.getTopologyResolutionMaxHops());
    setTopologyResolverMode(storageManager.getTopologyResolverMode());
    setTopologyDnsServer(storageManager.getTopologyDnsServer());
    setTopologyCustomDnsServer(storageManager.getTopologyCustomDnsServer());
    setTopologyDohProvider(storageManager.getTopologyDohProvider());
    setTopologyDohCustomUrl(storageManager.getTopologyDohCustomUrl());
    setTopologyExportConfirmPath(storageManager.getTopologyExportConfirmPath());
    setTopologyExportFolderPreset(storageManager.getTopologyExportFolderPreset() as ExportFolderPreset);
    setTopologyExportCustomPath(storageManager.getTopologyExportCustomPath());
    setTopologyCopyActions(storageManager.getTopologyCopyActions() as TopologyCopyAction[]);
    setTopologyExportActions(storageManager.getTopologyExportActions() as TopologyExportAction[]);
    setTopologyDisableAnnotations(storageManager.getTopologyDisableAnnotations());
    setTopologyDisableFullWindow(storageManager.getTopologyDisableFullWindow());
    setTopologyLookupTimeoutMs(storageManager.getTopologyLookupTimeoutMs());
    setTopologyDisablePtrLookups(storageManager.getTopologyDisablePtrLookups());
    setTopologyDisableGeoLookups(storageManager.getTopologyDisableGeoLookups());
    setTopologyGeoProvider(storageManager.getTopologyGeoProvider());
    setTopologyScanResolutionChain(storageManager.getTopologyScanResolutionChain());
    setTopologyDisableServiceDiscovery(storageManager.getTopologyDisableServiceDiscovery());
    setTopologyTcpServices(storageManager.getTopologyTcpServices());
    setAuditExportDefaultDocuments(storageManager.getAuditExportDefaultDocuments());
    setConfirmClearAuditLogs(storageManager.getConfirmClearAuditLogs());
    setAuditExportFolderPreset(storageManager.getAuditExportFolderPreset() as ExportFolderPreset);
    setAuditExportCustomPath(storageManager.getAuditExportCustomPath());
    setAuditExportSkipDestinationConfirm(
      storageManager.getAuditExportSkipDestinationConfirm(),
    );
    setDomainAuditCategories(sanitizeDomainAuditCategories(storageManager.getDomainAuditCategories()));
    setSessionSettingsProfiles(storageManager.getSessionSettingsProfiles());
    setPrefsReady(true);
  }, []);

  const persistTabStateBestEffort = useCallback(() => {
    const openTabIds = tabs.map((tab) => tab.id);
    const encoded =
      activeTab && activeTab.kind === "zone"
        ? `${activeTab.zoneId}|${actionTab}`
        : activeTab?.id ?? "";

    storageManager.setLastOpenTabs(openTabIds);
    storageManager.setLastActiveTabId(encoded || null);
    if (activeTab?.kind === "zone") {
      storageManager.setLastZone(activeTab.zoneId);
    }

    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) =>
          TauriClient.updatePreferences({
            ...(prefs as Record<string, unknown>),
            last_open_tabs: openTabIds,
            last_active_tab: encoded || undefined,
            last_zone:
              activeTab?.kind === "zone" ? activeTab.zoneId : undefined,
          }),
        )
        .catch(() => {});
    }
  }, [actionTab, activeTab, tabs]);

  useEffect(() => {
    if (!activeTab?.zoneId || activeTab.kind !== "zone") return;
    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) =>
          TauriClient.updatePreferences({
            ...(prefs as Record<string, unknown>),
            last_zone: activeTab.zoneId,
          }),
        )
        .catch(() => {});
    } else {
      storageManager.setLastZone(activeTab.zoneId);
    }
  }, [activeTab?.zoneId]);

  useEffect(() => {
    if (!prefsReady) return;
    if (reopenLastTabs && !restoredTabs) return;
    if (!activeTab) return;

    const encoded =
      activeTab.kind === "zone"
        ? `${activeTab.zoneId}|${actionTab}`
        : activeTab.id;

    storageManager.setLastActiveTabId(encoded);
    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) =>
          TauriClient.updatePreferences({
            ...(prefs as Record<string, unknown>),
            last_active_tab: encoded,
          }),
        )
        .catch(() => {});
    }
  }, [actionTab, activeTab, prefsReady, reopenLastTabs, restoredTabs]);

  useEffect(() => {
    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) =>
          TauriClient.updatePreferences({
            ...(prefs as Record<string, unknown>),
            auto_refresh_interval: autoRefreshInterval ?? undefined,
          }),
        )
        .catch(() => {});
    } else {
      storageManager.setAutoRefreshInterval(autoRefreshInterval ?? null);
    }
    if (!autoRefreshInterval || autoRefreshInterval <= 0) return;
    const id = setInterval(async () => {
      if (!activeTab || activeTab.kind !== "zone") return;
      if (
        activeTab.editingRecord ||
        activeTab.showAddRecord ||
        activeTab.showImport
      ) {
        return;
      }
      const controller = new AbortController();
      await loadRecords(activeTab, controller.signal);
    }, autoRefreshInterval);
    return () => clearInterval(id);
  }, [autoRefreshInterval, activeTab, loadRecords]);

  useEffect(() => {
    if (!prefsReady) return;
    storageManager.setDefaultPerPage(globalPerPage);
    storageManager.setZonePerPageMap(zonePerPage);
    storageManager.setShowUnsupportedRecordTypes(showUnsupportedRecordTypes);
    storageManager.setZoneShowUnsupportedRecordTypesMap(zoneShowUnsupportedRecordTypes);
    storageManager.setReopenLastTabs(reopenLastTabs);
    storageManager.setReopenZoneTabs(reopenZoneTabs);
    storageManager.setLastOpenTabs(lastOpenTabs);
    storageManager.setConfirmLogout(confirmLogout);
    storageManager.setIdleLogoutMs(idleLogoutMs);
    storageManager.setConfirmWindowClose(confirmWindowClose);
    storageManager.setLoadingOverlayTimeoutMs(loadingOverlayTimeoutMs);
    storageManager.setTopologyResolutionMaxHops(topologyResolutionMaxHops);
    storageManager.setTopologyResolverMode(topologyResolverMode);
    storageManager.setTopologyDnsServer(topologyDnsServer);
    storageManager.setTopologyCustomDnsServer(topologyCustomDnsServer);
    storageManager.setTopologyDohProvider(topologyDohProvider);
    storageManager.setTopologyDohCustomUrl(topologyDohCustomUrl);
    storageManager.setTopologyExportConfirmPath(topologyExportConfirmPath);
    storageManager.setTopologyExportFolderPreset(topologyExportFolderPreset);
    storageManager.setTopologyExportCustomPath(topologyExportCustomPath);
    storageManager.setTopologyCopyActions(topologyCopyActions);
    storageManager.setTopologyExportActions(topologyExportActions);
    storageManager.setTopologyDisableAnnotations(topologyDisableAnnotations);
    storageManager.setTopologyDisableFullWindow(topologyDisableFullWindow);
    storageManager.setTopologyLookupTimeoutMs(topologyLookupTimeoutMs);
    storageManager.setTopologyDisablePtrLookups(topologyDisablePtrLookups);
    storageManager.setTopologyDisableGeoLookups(topologyDisableGeoLookups);
    storageManager.setTopologyGeoProvider(topologyGeoProvider);
    storageManager.setTopologyScanResolutionChain(topologyScanResolutionChain);
    storageManager.setTopologyDisableServiceDiscovery(topologyDisableServiceDiscovery);
    storageManager.setTopologyTcpServices(topologyTcpServices);
    storageManager.setAuditExportDefaultDocuments(auditExportDefaultDocuments);
    storageManager.setConfirmClearAuditLogs(confirmClearAuditLogs);
    storageManager.setAuditExportFolderPreset(auditExportFolderPreset);
    storageManager.setAuditExportCustomPath(auditExportCustomPath);
    storageManager.setAuditExportSkipDestinationConfirm(
      auditExportSkipDestinationConfirm,
    );
    storageManager.setDomainAuditCategories(domainAuditCategories);
    storageManager.setSessionSettingsProfile(currentSessionId, buildSessionSettingsProfile());

    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) =>
          TauriClient.updatePreferences({
            ...(prefs as Record<string, unknown>),
            default_per_page: globalPerPage,
            zone_per_page: zonePerPage,
            show_unsupported_record_types: showUnsupportedRecordTypes,
            zone_show_unsupported_record_types: zoneShowUnsupportedRecordTypes,
            reopen_last_tabs: reopenLastTabs,
            reopen_zone_tabs: reopenZoneTabs,
            last_open_tabs: lastOpenTabs,
            confirm_logout: confirmLogout,
            idle_logout_ms: idleLogoutMs,
            confirm_window_close: confirmWindowClose,
            loading_overlay_timeout_ms: loadingOverlayTimeoutMs,
            topology_resolution_max_hops: topologyResolutionMaxHops,
            topology_resolver_mode: topologyResolverMode,
            topology_dns_server: topologyDnsServer,
            topology_custom_dns_server: topologyCustomDnsServer,
            topology_doh_provider: topologyDohProvider,
            topology_doh_custom_url: topologyDohCustomUrl,
            topology_export_confirm_path: topologyExportConfirmPath,
            topology_export_folder_preset: topologyExportFolderPreset,
            topology_export_custom_path: topologyExportCustomPath,
            topology_copy_actions: topologyCopyActions,
            topology_export_actions: topologyExportActions,
            topology_disable_annotations: topologyDisableAnnotations,
            topology_disable_full_window: topologyDisableFullWindow,
            topology_lookup_timeout_ms: topologyLookupTimeoutMs,
            topology_disable_ptr_lookups: topologyDisablePtrLookups,
            topology_disable_geo_lookups: topologyDisableGeoLookups,
            topology_geo_provider: topologyGeoProvider,
            topology_scan_resolution_chain: topologyScanResolutionChain,
            topology_disable_service_discovery: topologyDisableServiceDiscovery,
            topology_tcp_services: topologyTcpServices,
            audit_export_default_documents: auditExportDefaultDocuments,
            confirm_clear_audit_logs: confirmClearAuditLogs,
            audit_export_folder_preset: auditExportFolderPreset,
            audit_export_custom_path: auditExportCustomPath,
            audit_export_skip_destination_confirm: auditExportSkipDestinationConfirm,
            domain_audit_categories: domainAuditCategories,
            session_settings_profiles: {
              ...sessionSettingsProfiles,
              [currentSessionId]: buildSessionSettingsProfile(),
            },
          }),
        )
        .catch(() => {});
    }
  }, [
    globalPerPage,
    zonePerPage,
    showUnsupportedRecordTypes,
    zoneShowUnsupportedRecordTypes,
    reopenLastTabs,
    reopenZoneTabs,
    lastOpenTabs,
    confirmLogout,
    idleLogoutMs,
    confirmWindowClose,
    loadingOverlayTimeoutMs,
    topologyResolutionMaxHops,
    topologyResolverMode,
    topologyDnsServer,
    topologyCustomDnsServer,
    topologyDohProvider,
    topologyDohCustomUrl,
    topologyExportConfirmPath,
    topologyExportFolderPreset,
    topologyExportCustomPath,
    topologyCopyActions,
    topologyExportActions,
    topologyDisableAnnotations,
    topologyDisableFullWindow,
    topologyLookupTimeoutMs,
    topologyDisablePtrLookups,
    topologyDisableGeoLookups,
    topologyGeoProvider,
    topologyScanResolutionChain,
    topologyDisableServiceDiscovery,
    topologyTcpServices,
    auditExportDefaultDocuments,
    confirmClearAuditLogs,
    auditExportFolderPreset,
    auditExportCustomPath,
    auditExportSkipDestinationConfirm,
    domainAuditCategories,
    currentSessionId,
    buildSessionSettingsProfile,
    sessionSettingsProfiles,
    prefsReady,
  ]);

  useEffect(() => {
    setSessionSettingsProfiles((prev) => ({
      ...prev,
      [currentSessionId]: buildSessionSettingsProfile(),
    }));
  }, [buildSessionSettingsProfile, currentSessionId]);

  useEffect(() => {
    if (!globalPerPage) return;
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.kind !== "zone") return tab;
        if (zonePerPage[tab.zoneId] !== undefined) return tab;
        return { ...tab, perPage: globalPerPage };
      }),
    );
  }, [globalPerPage, zonePerPage]);

  useEffect(() => {
    if (!reopenLastTabs || restoredTabs) return;
    if (!availableZones.length) return;
    if (!lastOpenTabs.length) {
      setRestoredTabs(true);
      return;
    }
    for (const tabId of lastOpenTabs) {
      if (tabId.startsWith("__")) {
        if (tabId === "__settings") openActionTab("settings");
        else if (tabId === "__audit") openActionTab("audit");
        else if (tabId === "__tags") openActionTab("tags");
        else if (tabId === "__registry") openActionTab("registry");
        continue;
      }
      if (reopenZoneTabs[tabId] === false) continue;
      openZoneTab(tabId);
    }
    setRestoredTabs(true);
  }, [
    reopenLastTabs,
    restoredTabs,
    availableZones,
    lastOpenTabs,
    reopenZoneTabs,
    openActionTab,
    openZoneTab,
  ]);

  useEffect(() => {
    if (!prefsReady) return;
    if (reopenLastTabs && !restoredTabs) return;
    if (!pendingLastActiveTab) return;
    if (!reopenLastTabs) {
      setPendingLastActiveTab("");
      return;
    }

    const parsed = parseLastActiveTab(pendingLastActiveTab);
    if (!parsed) {
      setPendingLastActiveTab("");
      return;
    }
    if (!lastOpenTabs.includes(parsed.tabId)) {
      setPendingLastActiveTab("");
      return;
    }

    if (parsed.tabId.startsWith("__")) {
      if (parsed.tabId === "__settings") openActionTab("settings");
      else if (parsed.tabId === "__audit") openActionTab("audit");
      else if (parsed.tabId === "__tags") openActionTab("tags");
      else if (parsed.tabId === "__registry") openActionTab("registry");
      setPendingLastActiveTab("");
      return;
    }

    const zoneExists = availableZones.some((z) => z.id === parsed.tabId);
    if (!zoneExists) return;
    if (parsed.action) setActionTab(parsed.action);
    setSelectedZoneId(parsed.tabId);
    openZoneTab(parsed.tabId);
    setActiveTabId(parsed.tabId);
    setPendingLastActiveTab("");
  }, [
    availableZones,
    openActionTab,
    openZoneTab,
    parseLastActiveTab,
    pendingLastActiveTab,
    lastOpenTabs,
    prefsReady,
    reopenLastTabs,
    restoredTabs,
  ]);

  useEffect(() => {
    if (!prefsReady) return;
    if (reopenLastTabs && !restoredTabs) return;
    const openTabIds = tabs.map((tab) => tab.id);
    setLastOpenTabs(openTabIds);
    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) =>
          TauriClient.updatePreferences({
            ...(prefs as Record<string, unknown>),
            last_open_tabs: openTabIds,
          }),
        )
        .catch(() => {});
      return;
    }
    storageManager.setLastOpenTabs(openTabIds);
  }, [tabs, prefsReady, reopenLastTabs, restoredTabs]);

  useEffect(() => {
    if (!idleLogoutMs || idleLogoutMs <= 0) return;
    if (typeof window === "undefined") return;

    let timeout: number | undefined;
    const reset = () => {
      if (timeout) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        storageManager.clearSession();
        onLogout();
      }, idleLogoutMs);
    };

    const events: Array<keyof WindowEventMap> = [
      "pointerdown",
      "pointermove",
      "keydown",
      "scroll",
      "touchstart",
      "wheel",
    ];

    for (const ev of events) window.addEventListener(ev, reset, { passive: true });
    reset();
    return () => {
      if (timeout) window.clearTimeout(timeout);
      for (const ev of events) window.removeEventListener(ev, reset);
    };
  }, [idleLogoutMs, onLogout]);

  useEffect(() => {
    const flush = () => persistTabStateBestEffort();
    if (typeof window === "undefined") return;
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [persistTabStateBestEffort]);

  useEffect(() => {
    const onChanged = () => setTagsVersion((v) => v + 1);
    window.addEventListener("record-tags-changed", onChanged);
    return () => window.removeEventListener("record-tags-changed", onChanged);
  }, []);

  useEffect(() => {
    if (activeTab?.kind !== "tags") return;
    if (tagsZoneId) return;
    const last = storageManager.getLastZone();
    const next = last ?? availableZones[0]?.id ?? "";
    if (next) setTagsZoneId(next);
  }, [activeTab?.kind, availableZones, tagsZoneId]);

  useEffect(() => {
    if (activeTab?.kind !== "tags" || !tagsZoneId) return;
    const controller = new AbortController();
    void loadTagManagerRecords(tagsZoneId, controller.signal);
    return () => controller.abort();
  }, [activeTab?.kind, tagsZoneId, loadTagManagerRecords]);

  useEffect(() => {
    setTagAssociationSearch("");
    setTagAssociationDrafts({});
  }, [tagsZoneId]);

  useEffect(() => {
    if (!activeTab || activeTab.kind !== "zone") return;
    const overrides = storageManager.getAuditOverrides(activeTab.zoneId);
    setAuditOverridesByZone((prev) => ({
      ...prev,
      [activeTab.zoneId]: new Set(overrides),
    }));
  }, [activeTab]);

  const handleOverrideAuditItem = useCallback(
    (auditItemId: string) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      storageManager.setAuditOverride(activeTab.zoneId, auditItemId);
      setAuditOverridesByZone((prev) => {
        const existing = prev[activeTab.zoneId] ?? new Set();
        return {
          ...prev,
          [activeTab.zoneId]: new Set([...existing, auditItemId]),
        };
      });
    },
    [activeTab],
  );

  const handleClearAuditOverride = useCallback(
    (auditItemId: string) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      storageManager.clearAuditOverride(activeTab.zoneId, auditItemId);
      setAuditOverridesByZone((prev) => {
        const existing = prev[activeTab.zoneId] ?? new Set();
        const updated = new Set(existing);
        updated.delete(auditItemId);
        return {
          ...prev,
          [activeTab.zoneId]: updated,
        };
      });
    },
    [activeTab],
  );

  const handleClearAllAuditOverrides = useCallback(() => {
    if (!activeTab || activeTab.kind !== "zone") return;
    storageManager.clearAllAuditOverrides(activeTab.zoneId);
    setAuditOverridesByZone((prev) => ({
      ...prev,
      [activeTab.zoneId]: new Set(),
    }));
  }, [activeTab]);

  useEffect(() => {
    if (!activeTab || activeTab.kind !== "zone") return;
    setRegistryLookupDomain(activeTab.zoneName);
    setRegistryChecksError(null);
    setRdapResult(null);
    setShowRawRdap(false);
    setRegistrarDomainResult(null);
    setRegistrarHealthResult(null);
  }, [activeTab?.id]);

  const runDomainRegistryChecks = useCallback(async () => {
    const domain = registryLookupDomain.trim().toLowerCase();
    if (!domain) return;
    setRegistryChecksLoading(true);
    setRegistryChecksError(null);

    const [rdap, domains, health] = await Promise.allSettled([
      fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`)
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`RDAP lookup failed (${res.status})`);
          }
          return (await res.json()) as Record<string, unknown>;
        }),
      registrarListAllDomains(),
      registrarHealthCheckAll(),
    ]);

    const errors: string[] = [];
    if (rdap.status === "fulfilled") {
      setRdapResult(rdap.value);
    } else {
      setRdapResult(null);
      errors.push(rdap.reason instanceof Error ? rdap.reason.message : String(rdap.reason));
    }

    if (domains.status === "fulfilled") {
      const list = (Array.isArray(domains.value) ? domains.value : []) as DomainInfo[];
      const match =
        list.find((d) => d.domain.toLowerCase() === domain) ??
        list.find((d) => d.domain.toLowerCase().endsWith(`.${domain}`)) ??
        null;
      setRegistrarDomainResult(match);
    } else {
      setRegistrarDomainResult(null);
      errors.push(
        domains.reason instanceof Error ? domains.reason.message : String(domains.reason),
      );
    }

    if (health.status === "fulfilled") {
      const checks = (Array.isArray(health.value) ? health.value : []) as DomainHealthCheck[];
      const match = checks.find((h) => h.domain.toLowerCase() === domain) ?? null;
      setRegistrarHealthResult(match);
    } else {
      setRegistrarHealthResult(null);
      errors.push(health.reason instanceof Error ? health.reason.message : String(health.reason));
    }

    setRegistryChecksError(errors.length ? errors.join(" | ") : null);
    setRegistryChecksLoading(false);
  }, [registrarHealthCheckAll, registrarListAllDomains, registryLookupDomain]);


  const filteredRecords = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return [];
    const query = activeTab.searchTerm.trim().toLowerCase();
    const base = activeTab.records.filter((record: DNSRecord) => {
      if (activeTab.typeFilter && record.type !== activeTab.typeFilter) return false;
      if (!query) return true;
      const matchesRecord = filterRecords([record], query).length > 0;
      if (matchesRecord) return true;
      const recordTags = storageManager.getRecordTags(activeTab.zoneId, record.id);
      return recordTags.some((tag) => tag.toLowerCase().includes(query));
    });

    if (!activeTab.sortKey || !activeTab.sortDir) return base;
    const dir = activeTab.sortDir === "asc" ? 1 : -1;
    const getTtl = (record: DNSRecord) => {
      const ttl = record.ttl;
      if (ttl === 1) return 0;
      if (typeof ttl === "number") return ttl;
      return 0;
    };

    const cmpText = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" });

    const sorted = [...base].sort((a, b) => {
      switch (activeTab.sortKey) {
        case "type":
          return dir * cmpText(a.type ?? "", b.type ?? "");
        case "name":
          return dir * cmpText(a.name ?? "", b.name ?? "");
        case "content":
          return dir * cmpText(a.content ?? "", b.content ?? "");
        case "ttl":
          return dir * (getTtl(a) - getTtl(b));
        case "proxied":
          return dir * (Number(Boolean(a.proxied)) - Number(Boolean(b.proxied)));
        default:
          return 0;
      }
    });

    return sorted;
  }, [activeTab, tagsVersion]);

  const tagCounts = useMemo(() => {
    if (!tagsZoneId) return {};
    return storageManager.getTagUsageCounts(tagsZoneId);
  }, [tagsZoneId, tagsVersion]);

  const zoneTags = useMemo(() => {
    if (!tagsZoneId) return [];
    return storageManager.getZoneTags(tagsZoneId);
  }, [tagsZoneId, tagsVersion]);

  const tagManagerRecordsByTag = useMemo(() => {
    const byTag: Record<string, DNSRecord[]> = {};
    if (!tagsZoneId) return byTag;
    for (const record of tagManagerRecords) {
      const recordTags = storageManager.getRecordTags(tagsZoneId, record.id);
      for (const tag of recordTags) {
        if (!byTag[tag]) byTag[tag] = [];
        byTag[tag].push(record);
      }
    }
    return byTag;
  }, [tagManagerRecords, tagsVersion, tagsZoneId]);

  const filteredTagManagerRecords = useMemo(() => {
    const search = tagAssociationSearch.trim().toLowerCase();
    const sorted = [...tagManagerRecords].sort((a, b) =>
      `${a.name}|${a.type}`.localeCompare(`${b.name}|${b.type}`, undefined, {
        sensitivity: "base",
      }),
    );
    if (!search || !tagsZoneId) return sorted;
    return sorted.filter((record) => {
      if (record.name.toLowerCase().includes(search)) return true;
      if (record.type.toLowerCase().includes(search)) return true;
      if (record.content.toLowerCase().includes(search)) return true;
      const tags = storageManager.getRecordTags(tagsZoneId, record.id);
      return tags.some((tag) => tag.toLowerCase().includes(search));
    });
  }, [tagAssociationSearch, tagManagerRecords, tagsVersion, tagsZoneId]);

  const visibleTagManagerRecords = useMemo(
    () => filteredTagManagerRecords.slice(0, 150),
    [filteredTagManagerRecords],
  );

  const attachTagToRecord = useCallback(
    (recordId: string, tagValue: string) => {
      if (!tagsZoneId) return;
      const tag = tagValue.trim();
      if (!tag) return;
      const current = storageManager.getRecordTags(tagsZoneId, recordId);
      if (current.includes(tag)) return;
      storageManager.setRecordTags(tagsZoneId, recordId, [...current, tag]);
    },
    [tagsZoneId],
  );

  const detachTagFromRecord = useCallback(
    (recordId: string, tagValue: string) => {
      if (!tagsZoneId) return;
      const current = storageManager.getRecordTags(tagsZoneId, recordId);
      storageManager.setRecordTags(
        tagsZoneId,
        recordId,
        current.filter((tag) => tag !== tagValue),
      );
    },
    [tagsZoneId],
  );

  const getAuditFieldValue = useCallback(
    (entry: Record<string, unknown>, field: AuditFilterField): string => {
      if (field === "details") {
        const details = { ...entry };
        delete details.timestamp;
        delete details.operation;
        delete details.resource;
        return JSON.stringify(details);
      }
      const value = entry[field];
      return typeof value === "string" ? value : "";
    },
    [],
  );

  const filteredAuditEntries = useMemo(() => {
    if (!auditEntries.length) return [];
    const search = auditSearch.trim().toLowerCase();
    const activeFilters = auditFilters
      .map((rule) => ({
        ...rule,
        value: rule.value.trim(),
      }))
      .filter((rule) => rule.value.length > 0);
    return auditEntries.filter((entry) => {
      if (search) {
        const payload = JSON.stringify(entry).toLowerCase();
        if (!payload.includes(search)) return false;
      }

      for (const rule of activeFilters) {
        const fieldValue = getAuditFieldValue(entry, rule.field);
        const haystack = fieldValue.toLowerCase();
        const needle = rule.value.toLowerCase();

        if (rule.operator === "equals" && haystack !== needle) return false;
        if (rule.operator === "not_equals" && haystack === needle) return false;
        if (rule.operator === "contains" && !haystack.includes(needle)) return false;
        if (rule.operator === "not_contains" && haystack.includes(needle)) return false;
        if (rule.operator === "starts_with" && !haystack.startsWith(needle)) return false;
        if (rule.operator === "ends_with" && !haystack.endsWith(needle)) return false;
        if (rule.operator === "matches") {
          try {
            const re = new RegExp(rule.value, "i");
            if (!re.test(fieldValue)) return false;
          } catch {
            return false;
          }
        }
        if (
          rule.operator === "gt" ||
          rule.operator === "gte" ||
          rule.operator === "lt" ||
          rule.operator === "lte"
        ) {
          const left =
            rule.field === "timestamp"
              ? Date.parse(fieldValue)
              : Number(fieldValue);
          const right =
            rule.field === "timestamp"
              ? Date.parse(rule.value)
              : Number(rule.value);
          if (Number.isNaN(left) || Number.isNaN(right)) return false;
          if (rule.operator === "gt" && !(left > right)) return false;
          if (rule.operator === "gte" && !(left >= right)) return false;
          if (rule.operator === "lt" && !(left < right)) return false;
          if (rule.operator === "lte" && !(left <= right)) return false;
        }
      }
      return true;
    });
  }, [auditEntries, auditFilters, auditSearch, getAuditFieldValue]);

  const orderedAuditEntries = useMemo(() => {
    const entries = [...filteredAuditEntries];
    const parseTime = (value: unknown) => {
      if (typeof value !== "string") return 0;
      const ts = Date.parse(value);
      return Number.isNaN(ts) ? 0 : ts;
    };
    entries.sort((a, b) => {
      if (auditSort.field === "operation") {
        const cmp = String(a.operation ?? "").localeCompare(String(b.operation ?? ""));
        return auditSort.dir === "asc" ? cmp : -cmp;
      }
      if (auditSort.field === "resource") {
        const cmp = String(a.resource ?? "").localeCompare(String(b.resource ?? ""));
        return auditSort.dir === "asc" ? cmp : -cmp;
      }
      const aTime = parseTime(a.timestamp);
      const bTime = parseTime(b.timestamp);
      return auditSort.dir === "asc" ? aTime - bTime : bTime - aTime;
    });
    return entries;
  }, [filteredAuditEntries, auditSort]);

  const limitedAuditEntries = useMemo(() => {
    if (auditLimit === "all") return orderedAuditEntries;
    const limit = Number(auditLimit);
    if (Number.isNaN(limit)) return orderedAuditEntries;
    return orderedAuditEntries.slice(0, limit);
  }, [orderedAuditEntries, auditLimit]);

  const clearAuditEntriesNow = useCallback(async () => {
    if (!isDesktop()) return;
    await TauriClient.clearAuditEntries();
    setAuditEntries([]);
  }, []);

  const createAuditFilterRule = useCallback(
    (
      field: AuditFilterField = "operation",
      operator: AuditFilterOperator = "contains",
      value = "",
    ): AuditFilterRule => ({
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`,
      field,
      operator,
      value,
    }),
    [],
  );

  const addAuditFilter = useCallback(() => {
    setAuditFilters((prev) => [...prev, createAuditFilterRule()]);
  }, [createAuditFilterRule]);

  const updateAuditFilter = useCallback(
    (id: string, patch: Partial<Omit<AuditFilterRule, "id">>) => {
      setAuditFilters((prev) =>
        prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
      );
    },
    [],
  );

  const removeAuditFilter = useCallback((id: string) => {
    setAuditFilters((prev) => prev.filter((rule) => rule.id !== id));
  }, []);

  const applyAuditPreset = useCallback(
    (
      preset:
        | "errors"
        | "auth"
        | "dns"
        | "api_keys"
        | "zone_settings"
        | "cache"
        | "last24h"
        | "last7d"
        | "today"
        | "clear",
    ) => {
      if (preset === "clear") {
        setAuditFilters([]);
        return;
      }
      const now = Date.now();
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const presetRules: AuditFilterRule[] =
        preset === "errors"
          ? [createAuditFilterRule("details", "contains", "\"success\":false")]
          : preset === "auth"
            ? [createAuditFilterRule("operation", "contains", "auth:")]
            : preset === "dns"
              ? [createAuditFilterRule("operation", "contains", "dns:")]
              : preset === "api_keys"
                ? [createAuditFilterRule("operation", "contains", "api_key:")]
                : preset === "zone_settings"
                  ? [createAuditFilterRule("operation", "contains", "zone_setting")]
                  : preset === "cache"
                    ? [createAuditFilterRule("operation", "contains", "cache")]
                    : preset === "last24h"
                      ? [
                          createAuditFilterRule(
                            "timestamp",
                            "gte",
                            new Date(now - 24 * 60 * 60 * 1000).toISOString(),
                          ),
                        ]
                      : preset === "last7d"
                        ? [
                            createAuditFilterRule(
                              "timestamp",
                              "gte",
                              new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
                            ),
                          ]
                        : [createAuditFilterRule("timestamp", "gte", startOfToday.toISOString())];

      setAuditFilters((prev) => {
        const existing = new Set(prev.map((r) => `${r.field}|${r.operator}|${r.value}`));
        const additions = presetRules.filter(
          (r) => !existing.has(`${r.field}|${r.operator}|${r.value}`),
        );
        return [...prev, ...additions];
      });
    },
    [createAuditFilterRule],
  );

  const toggleAuditSort = useCallback((field: "timestamp" | "operation" | "resource") => {
    setAuditSort((prev) => {
      if (prev.field !== field) {
        return { field, dir: field === "timestamp" ? "desc" : "asc" };
      }
      return { field, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  }, []);

  const exportSessionSettings = useCallback(() => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      sessionId: currentSessionId,
      settings: buildSessionSettingsProfile(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `session-settings-${currentSessionId}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast({
      title: t("Exported", "Exported"),
      description: t("Session settings exported.", "Session settings exported."),
    });
  }, [buildSessionSettingsProfile, currentSessionId, toast]);

  const importSessionSettings = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as
          | SessionSettingsProfile
          | { settings?: SessionSettingsProfile };
        const profile =
          parsed && typeof parsed === "object" && "settings" in parsed
            ? (parsed.settings as SessionSettingsProfile | undefined)
            : (parsed as SessionSettingsProfile);
        if (!profile || typeof profile !== "object") {
          throw new Error("Invalid settings file");
        }
        applySessionSettingsProfile(profile);
        const nextProfiles = {
          ...sessionSettingsProfiles,
          [currentSessionId]: profile,
        };
        setSessionSettingsProfiles(nextProfiles);
        storageManager.setSessionSettingsProfile(currentSessionId, profile);
        if (isDesktop()) {
          const prefs = await TauriClient.getPreferences();
          await TauriClient.updatePreferences({
            ...(prefs as Record<string, unknown>),
            session_settings_profiles: nextProfiles,
          });
        }
        toast({
          title: t("Imported", "Imported"),
          description: t("Session settings imported.", "Session settings imported."),
        });
      } catch (error) {
        toast({
          title: t("Import failed", "Import failed"),
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      } finally {
        event.target.value = "";
      }
    },
    [
      applySessionSettingsProfile,
      currentSessionId,
      sessionSettingsProfiles,
      toast,
    ],
  );

  const cloneSessionSettingsFrom = useCallback(
    async (sourceSessionId: string) => {
      if (!sourceSessionId) return;
      const profile = sessionSettingsProfiles[sourceSessionId];
      if (!profile) {
        toast({
          title: t("Clone failed", "Clone failed"),
          description: t("No saved settings found for {{session}}.", {
            session: sourceSessionId,
            defaultValue: `No saved settings found for ${sourceSessionId}.`,
          }),
          variant: "destructive",
        });
        return;
      }
      applySessionSettingsProfile(profile);
      const nextProfiles = {
        ...sessionSettingsProfiles,
        [currentSessionId]: profile,
      };
      setSessionSettingsProfiles(nextProfiles);
      storageManager.setSessionSettingsProfile(currentSessionId, profile);
      if (isDesktop()) {
        try {
          const prefs = await TauriClient.getPreferences();
          await TauriClient.updatePreferences({
            ...(prefs as Record<string, unknown>),
            session_settings_profiles: nextProfiles,
          });
        } catch {
          // best effort
        }
      }
      toast({
        title: t("Cloned", "Cloned"),
        description: t("Applied settings from {{session}}.", {
          session: sourceSessionId,
          defaultValue: `Applied settings from ${sourceSessionId}.`,
        }),
      });
    },
    [applySessionSettingsProfile, currentSessionId, sessionSettingsProfiles, toast],
  );
  const handleAddRecord = async () => {
    if (!activeTab) return;
    const draft = activeTab.newRecord;
    if (!draft.type || !draft.name || !draft.content) {
      toast({
        title: t("Error", "Error"),
        description: t("Please fill in all required fields", "Please fill in all required fields"),
        variant: "destructive",
      });
      return;
    }

    try {
      const createdRecord = await createDNSRecord(activeTab.zoneId, draft);
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: [createdRecord, ...prev.records],
        newRecord: createEmptyRecord(),
        showAddRecord: false,
      }));
      toast({
        title: t("Success", "Success"),
        description: t("DNS record created successfully", "DNS record created successfully"),
      });
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to create DNS record: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to create DNS record: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  const handleUpdateRecord = async (record: DNSRecord) => {
    if (!activeTab) return;
    try {
      const updatedRecord = await updateDNSRecord(
        activeTab.zoneId,
        record.id,
        record,
      );
      const nextRecordId = updatedRecord.id || record.id;
      if (nextRecordId !== record.id) {
        storageManager.moveRecordTags(activeTab.zoneId, record.id, nextRecordId);
      }
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.map((r) =>
          r.id === record.id ? { ...updatedRecord, id: nextRecordId } : r,
        ),
        selectedIds: Array.from(
          new Set(prev.selectedIds.map((id) => (id === record.id ? nextRecordId : id))),
        ),
        editingRecord: null,
      }));
      toast({
        title: t("Success", "Success"),
        description: t("DNS record updated successfully", "DNS record updated successfully"),
      });
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to update DNS record: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to update DNS record: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  const handleToggleProxy = async (record: DNSRecord, proxied: boolean) => {
    if (!activeTab) return;
    try {
      const updatedRecord = await updateDNSRecord(
        activeTab.zoneId,
        record.id,
        {
          ...record,
          proxied,
        },
      );
      const nextRecordId = updatedRecord.id || record.id;
      if (nextRecordId !== record.id) {
        storageManager.moveRecordTags(activeTab.zoneId, record.id, nextRecordId);
      }
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.map((r) =>
          r.id === record.id ? { ...updatedRecord, id: nextRecordId } : r,
        ),
        selectedIds: Array.from(
          new Set(prev.selectedIds.map((id) => (id === record.id ? nextRecordId : id))),
        ),
      }));
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to update proxy: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to update proxy: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  const handleDeleteRecord = async (recordId: string) => {
    if (!activeTab) return;
    try {
      await deleteDNSRecord(activeTab.zoneId, recordId);
      storageManager.clearRecordTags(activeTab.zoneId, recordId);
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.filter((r) => r.id !== recordId),
        selectedIds: prev.selectedIds.filter((id) => id !== recordId),
      }));
      toast({
        title: t("Success", "Success"),
        description: t("DNS record deleted successfully", "DNS record deleted successfully"),
      });
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to delete DNS record: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to delete DNS record: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  const handleExport = (format: "json" | "csv" | "bind") => {
    if (!activeTab) return;
    let content = "";
    let filename = "";
    let mimeType = "";

    switch (format) {
      case "json": {
        content = JSON.stringify(activeTab.records, null, 2);
        filename = `${activeTab.zoneId}-records.json`;
        mimeType = "application/json";
        break;
      }
      case "csv": {
        const headers = [
          "Type",
          "Name",
          "Content",
          "TTL",
          "Priority",
          "Proxied",
        ];
        const escapeCSV = (value: unknown) =>
          `"${String(value ?? "").replace(/"/g, '""')}"`;
        const rows = activeTab.records
          .map((r: DNSRecord) =>
            [
              r.type,
              r.name,
              r.content,
              r.ttl,
              r.priority ?? "",
              r.proxied ?? false,
            ]
              .map(escapeCSV)
              .join(","),
          )
          .join("\n");
        content = headers.map(escapeCSV).join(",") + "\n" + rows;
        filename = `${activeTab.zoneId}-records.csv`;
        mimeType = "text/csv";
        break;
      }
      case "bind": {
        content = activeTab.records
          .map((r: DNSRecord) => {
            const ttl = r.ttl || 300;
            const priority = r.priority ? `${r.priority} ` : "";
            return `${r.name}\t${ttl}\tIN\t${r.type}\t${priority}${r.content}`;
          })
          .join("\n");
        filename = `${activeTab.zoneId}.zone`;
        mimeType = "text/plain";
        break;
      }
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    toast({
      title: t("Success", "Success"),
      description: t("Records exported as {{format}}", {
        format: format.toUpperCase(),
        defaultValue: `Records exported as ${format.toUpperCase()}`,
      }),
    });
  };

  const handleImport = async (
    tab: ZoneTab,
    providedItems?: Partial<DNSRecord>[],
    dryRun?: boolean,
  ) => {
    try {
      let items: Partial<DNSRecord>[] | null = null;
      if (providedItems) items = providedItems as Partial<DNSRecord>[];
      else {
        switch (tab.importFormat) {
          case "json": {
            const imported = JSON.parse(tab.importData);
            items = Array.isArray(imported)
              ? imported
              : Array.isArray(imported.records)
                ? imported.records
                : null;
            break;
          }
          case "csv":
            items = parseCSVRecords(tab.importData);
            break;
          case "bind":
            items = parseBINDZone(tab.importData);
            break;
        }
      }

      if (!items) {
        throw new Error("Invalid format");
      }

      const valid: DNSRecord[] = [];
      let skipped = 0;

      for (const item of items) {
        if (item && item.type && item.name && item.content) {
          const exists = tab.records.some(
            (r) =>
              r.type === item.type &&
              r.name === item.name &&
              r.content === item.content,
          );
          if (!exists) {
            valid.push(item as DNSRecord);
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
      }

      if (valid.length) {
        if (bulkCreateDNSRecords) {
          try {
            const result = await bulkCreateDNSRecords(
              tab.zoneId,
              valid,
              dryRun,
            );
            const created = Array.isArray(result?.created)
              ? (result.created as DNSRecord[])
              : valid;
            if (!dryRun) {
              updateTab(tab.id, (prev) => ({
                ...prev,
                records: [...created, ...prev.records],
              }));
            }
          } catch (err) {
            toast({
              title: t("Error", "Error"),
              description: t("Failed to import records: {{error}}", {
                error: (err as Error).message,
                defaultValue: `Failed to import records: ${(err as Error).message}`,
              }),
              variant: "destructive",
            });
            return;
          }
        } else {
          const createdRecords: DNSRecord[] = [];
          for (const v of valid) {
            try {
              const r = await createDNSRecord(tab.zoneId, v);
              createdRecords.push(r);
            } catch {
              skipped++;
            }
          }
          if (!dryRun) {
            updateTab(tab.id, (prev) => ({
              ...prev,
              records: [...createdRecords, ...prev.records],
            }));
          }
        }
        if (!dryRun) {
          updateTab(tab.id, (prev) => ({
            ...prev,
            importData: "",
            showImport: false,
          }));
          toast({
            title: t("Success", "Success"),
            description: t("Imported {{imported}} record(s){{suffix}}", {
              imported: valid.length,
              suffix: skipped ? `, skipped ${skipped}` : "",
              defaultValue: `Imported ${valid.length} record(s)${skipped ? `, skipped ${skipped}` : ""}`,
            }),
          });
        } else {
          toast({
            title: t("Dry Run", "Dry Run"),
            description: t("Would import {{imported}} record(s){{suffix}}", {
              imported: valid.length,
              suffix: skipped ? `, skipped ${skipped}` : "",
              defaultValue: `Would import ${valid.length} record(s)${skipped ? `, skipped ${skipped}` : ""}`,
            }),
          });
        }
      } else {
        toast({
          title: t("Error", "Error"),
          description: skipped
            ? t("No new records imported. Skipped {{count}} invalid or duplicate item(s).", {
                count: skipped,
                defaultValue: `No new records imported. Skipped ${skipped} invalid or duplicate item(s).`,
              })
            : t("No valid records found.", "No valid records found."),
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to import records: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to import records: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  const handleCopySelected = () => {
    if (!activeTab) return;
    const selectedRecords = activeTab.records.filter((record) =>
      activeTab.selectedIds.includes(record.id),
    );
    if (!selectedRecords.length) {
      toast({
        title: t("Nothing selected", "Nothing selected"),
        description: t("Select one or more records to copy.", "Select one or more records to copy."),
      });
      return;
    }
    setCopyBuffer({
      records: selectedRecords,
      sourceZoneId: activeTab.zoneId,
      sourceZoneName: activeTab.zoneName,
    });
    toast({
      title: t("Copied", "Copied"),
      description: t("Copied {{count}} record(s) from {{zone}}", {
        count: selectedRecords.length,
        zone: activeTab.zoneName,
        defaultValue: `Copied ${selectedRecords.length} record(s) from ${activeTab.zoneName}`,
      }),
    });
  };

  const handleCopySingle = (record: DNSRecord) => {
    if (!activeTab) return;
    setCopyBuffer({
      records: [record],
      sourceZoneId: activeTab.zoneId,
      sourceZoneName: activeTab.zoneName,
    });
    toast({
      title: t("Copied", "Copied"),
      description: t("Copied {{record}} from {{zone}}", {
        record: record.name,
        zone: activeTab.zoneName,
        defaultValue: `Copied ${record.name} from ${activeTab.zoneName}`,
      }),
    });
  };

  const handlePasteRecords = async () => {
    if (!activeTab || !copyBuffer) return;
    const toCreate = copyBuffer.records.map((record) => ({
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      priority: record.priority,
      proxied: record.proxied,
    }));
    try {
      if (bulkCreateDNSRecords) {
        const result = await bulkCreateDNSRecords(
          activeTab.zoneId,
          toCreate,
          false,
        );
        const created = Array.isArray(result?.created)
          ? (result.created as DNSRecord[])
          : [];
        updateTab(activeTab.id, (prev) => ({
          ...prev,
          records: [...created, ...prev.records],
        }));
        toast({
          title: t("Pasted", "Pasted"),
          description: t("Created {{count}} record(s) in {{zone}}", {
            count: created.length,
            zone: activeTab.zoneName,
            defaultValue: `Created ${created.length} record(s) in ${activeTab.zoneName}`,
          }),
        });
        return;
      }
      const createdRecords: DNSRecord[] = [];
      for (const record of toCreate) {
        const created = await createDNSRecord(activeTab.zoneId, record);
        createdRecords.push(created);
      }
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: [...createdRecords, ...prev.records],
      }));
      toast({
        title: t("Pasted", "Pasted"),
        description: t("Created {{count}} record(s) in {{zone}}", {
          count: createdRecords.length,
          zone: activeTab.zoneName,
          defaultValue: `Created ${createdRecords.length} record(s) in ${activeTab.zoneName}`,
        }),
      });
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to paste records: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to paste records: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  const handleSetDevelopmentMode = useCallback(
    async (enabled: boolean) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      try {
        setCacheSettingsLoading(true);
        setCacheSettingsError(null);
        const next = await updateZoneSetting<string>(
          activeTab.zoneId,
          "development_mode",
          enabled ? "on" : "off",
        );
        setZoneDevMode(next);
        toast({
          title: t("Saved", "Saved"),
          description: enabled
            ? t("Development mode enabled (cache bypass).", "Development mode enabled (cache bypass).")
            : t("Development mode disabled.", "Development mode disabled."),
        });
      } catch (error) {
        toast({
          title: t("Error", "Error"),
          description: t("Failed to update development mode: {{error}}", {
            error: (error as Error).message,
            defaultValue: `Failed to update development mode: ${(error as Error).message}`,
          }),
          variant: "destructive",
        });
      } finally {
        setCacheSettingsLoading(false);
      }
    },
    [activeTab, toast, updateZoneSetting],
  );

  const handleSetCacheLevel = useCallback(
    async (level: string) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      try {
        setCacheSettingsLoading(true);
        setCacheSettingsError(null);
        const next = await updateZoneSetting<string>(
          activeTab.zoneId,
          "cache_level",
          level,
        );
        setZoneCacheLevel(next);
        toast({
          title: t("Saved", "Saved"),
          description: t("Cache level set to {{level}}.", {
            level,
            defaultValue: `Cache level set to ${level}.`,
          }),
        });
      } catch (error) {
        toast({
          title: t("Error", "Error"),
          description: t("Failed to update cache level: {{error}}", {
            error: (error as Error).message,
            defaultValue: `Failed to update cache level: ${(error as Error).message}`,
          }),
          variant: "destructive",
        });
      } finally {
        setCacheSettingsLoading(false);
      }
    },
    [activeTab, toast, updateZoneSetting],
  );

  const preparePurgeUrls = useCallback(() => {
    const urls = purgeUrlsInput
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const issues: string[] = [];

    for (const url of urls) {
      if (/\s/.test(url)) issues.push(`URL contains whitespace: ${url}`);
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          issues.push(`Unsupported URL scheme: ${url}`);
        }
      } catch {
        issues.push(`Not a valid URL: ${url}`);
      }
    }

    setPendingPurgeUrls(urls);
    setPendingPurgeIssues(issues);
    setShowPurgeUrlsConfirm(true);
  }, [purgeUrlsInput]);

  const confirmPurgeEverything = useCallback(async () => {
    if (!activeTab || activeTab.kind !== "zone") return;
    setShowPurgeEverythingConfirm(false);
    try {
      await purgeCache(activeTab.zoneId, { purge_everything: true });
      toast({
        title: t("Purged", "Purged"),
        description: t("Cache purged for {{zone}}.", {
          zone: activeTab.zoneName,
          defaultValue: `Cache purged for ${activeTab.zoneName}.`,
        }),
      });
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to purge cache: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to purge cache: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  }, [activeTab, purgeCache, toast]);

  const confirmPurgeUrls = useCallback(async () => {
    if (!activeTab || activeTab.kind !== "zone") return;
    const urls = pendingPurgeUrls;
    setShowPurgeUrlsConfirm(false);
    if (!urls.length) return;
    try {
      await purgeCache(activeTab.zoneId, { files: urls });
      toast({
        title: t("Purged", "Purged"),
        description: t("Purged {{count}} URL(s) for {{zone}}.", {
          count: urls.length,
          zone: activeTab.zoneName,
          defaultValue: `Purged ${urls.length} URL(s) for ${activeTab.zoneName}.`,
        }),
      });
      setPurgeUrlsInput("");
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to purge URLs: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to purge URLs: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  }, [activeTab, pendingPurgeUrls, purgeCache, toast]);

  const handleSetSslTlsSetting = useCallback(
    async (
      settingId:
        | "ssl"
        | "min_tls_version"
        | "tls_1_3"
        | "always_use_https"
        | "automatic_https_rewrites"
        | "opportunistic_encryption",
      value: string,
    ) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      try {
        setSslSettingsLoading(true);
        setSslSettingsError(null);
        const next = await updateZoneSetting<string>(activeTab.zoneId, settingId, value);
        switch (settingId) {
          case "ssl":
            setZoneSslMode(next);
            break;
          case "min_tls_version":
            setZoneMinTlsVersion(next);
            break;
          case "tls_1_3":
            setZoneTls13(next);
            break;
          case "always_use_https":
            setZoneAlwaysUseHttps(next);
            break;
          case "automatic_https_rewrites":
            setZoneAutoHttpsRewrites(next);
            break;
          case "opportunistic_encryption":
            setZoneOpportunisticEncryption(next);
            break;
        }
        toast({
          title: t("Saved", "Saved"),
          description: t("{{setting}} updated.", {
            setting: settingId.replace(/_/g, " "),
            defaultValue: `${settingId.replace(/_/g, " ")} updated.`,
          }),
        });
      } catch (error) {
        toast({
          title: t("Error", "Error"),
          description: t("Failed to update SSL/TLS setting: {{error}}", {
            error: (error as Error).message,
            defaultValue: `Failed to update SSL/TLS setting: ${(error as Error).message}`,
          }),
          variant: "destructive",
        });
      } finally {
        setSslSettingsLoading(false);
      }
    },
    [activeTab, toast, updateZoneSetting],
  );

  const handleLogout = () => {
    persistTabStateBestEffort();
    storageManager.clearSession();
    if (confirmLogout) {
      setShowLogoutConfirm(true);
      return;
    }
    onLogout();
  };

  const confirmAndLogout = () => {
    persistTabStateBestEffort();
    storageManager.clearSession();
    setShowLogoutConfirm(false);
    onLogout();
  };

  const selectedZoneData = activeTab
    ? availableZones.find((z) => z.id === activeTab.zoneId)
    : undefined;
  const actionHintRaw = ACTION_TABS.find((tab) => tab.id === actionTab)?.hint;
  const actionHint = actionHintRaw ? t(actionHintRaw, actionHintRaw) : "";

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      updateTab(activeTab.id, (prev) => {
        if (prev.kind !== "zone") return prev;
        if (prev.sortKey !== key) {
          return { ...prev, sortKey: key, sortDir: "asc" };
        }
        if (prev.sortDir === "asc") {
          return { ...prev, sortDir: "desc" };
        }
        if (prev.sortDir === "desc") {
          return { ...prev, sortKey: null, sortDir: null };
        }
        return { ...prev, sortDir: "asc" };
      });
    },
    [activeTab, updateTab],
  );

  const sortIndicator = useCallback(
    (key: SortKey) => {
      if (!activeTab || activeTab.kind !== "zone") return "";
      if (activeTab.sortKey !== key || !activeTab.sortDir) return "";
      return activeTab.sortDir === "asc" ? "▲" : "▼";
    },
    [activeTab],
  );

  const rdapObject = (rdapResult ?? {}) as Record<string, unknown>;
  const rdapStatuses = Array.isArray(rdapObject.status)
    ? (rdapObject.status as unknown[]).map((s) => String(s))
    : [];
  const rdapNameservers = Array.isArray(rdapObject.nameservers)
    ? (rdapObject.nameservers as Array<Record<string, unknown>>)
        .map((ns) => String(ns.ldhName ?? ns.unicodeName ?? ""))
        .filter(Boolean)
    : [];
  const rdapEvents = Array.isArray(rdapObject.events)
    ? (rdapObject.events as Array<Record<string, unknown>>).map((event) => ({
        action: String(event.eventAction ?? "unknown"),
        date: String(event.eventDate ?? ""),
      }))
    : [];
  const rdapRegistrarEntity = Array.isArray(rdapObject.entities)
    ? (rdapObject.entities as Array<Record<string, unknown>>).find((entity) =>
        Array.isArray(entity.roles)
          ? (entity.roles as unknown[])
              .map((r) => String(r).toLowerCase())
              .includes("registrar")
          : false,
      )
    : undefined;
  const cacheOverlay = useLoadingOverlay(cacheSettingsLoading, loadingOverlayTimeoutMs);
  const sslOverlay = useLoadingOverlay(sslSettingsLoading, loadingOverlayTimeoutMs);
  const auditOverlay = useLoadingOverlay(
    activeTab?.kind === "zone" && actionTab === "domain-audit" && activeTab.isLoading,
    loadingOverlayTimeoutMs,
  );
  const registryOverlay = useLoadingOverlay(registryChecksLoading, loadingOverlayTimeoutMs);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_55%),radial-gradient(circle_at_bottom,rgba(0,0,0,0.45),transparent_60%)] p-4 text-foreground">
      <div className={`fixed right-3 z-30 ${isDesktop() ? "top-12" : "top-3"}`}>
        <div className="flex items-center gap-1 rounded-full border border-transparent bg-transparent px-2 py-1 text-[10px] text-muted-foreground/35 opacity-80 backdrop-blur-sm transition hover:opacity-100">
          {isDesktop() && (
            <Tooltip tip={t("Audit log", "Audit log")} side="bottom">
              <Button
                onClick={() => openActionTab("audit")}
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-foreground/70 hover:text-foreground hover:bg-accent/50"
                aria-label={t("Audit log", "Audit log")}
              >
                <Shield className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          )}
          <Tooltip tip={t("Registry Monitoring", "Registry Monitoring")} side="bottom">
            <Button
              onClick={() => openActionTab("registry")}
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-foreground/70 hover:text-foreground hover:bg-accent/50"
              aria-label={t("Registry Monitoring", "Registry Monitoring")}
            >
              <Globe className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Tooltip tip={t("Settings", "Settings")} side="bottom">
            <Button
              onClick={() => openActionTab("settings")}
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-foreground/70 hover:text-foreground hover:bg-accent/50"
              aria-label={t("Settings", "Settings")}
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Tooltip tip={t("Tags", "Tags")} side="bottom">
            <Button
              onClick={() => openActionTab("tags")}
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-foreground/70 hover:text-foreground hover:bg-accent/50"
              aria-label={t("Tags", "Tags")}
            >
              <Tags className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Tooltip tip={t("Logout", "Logout")} side="bottom">
            <Button
              onClick={handleLogout}
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-foreground/70 hover:text-foreground hover:bg-accent/50"
              aria-label={t("Logout", "Logout")}
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
        </div>
      </div>
      <div className="max-w-6xl mx-auto space-y-6 pb-10 fade-in-up">
          <div className="sticky top-0 z-20">
            <Card
              className={cn(
                "border-border/60 backdrop-blur transition-all duration-200",
                compactTopBar
                  ? "bg-card/92 shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
                  : "bg-card/85 shadow-[0_18px_50px_rgba(0,0,0,0.25)]",
              )}
            >
            {!compactTopBar && (
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2 fade-in">
                  <CardTitle className="text-xl tracking-tight">
                    {t("DNS Manager", "DNS Manager")}
                  </CardTitle>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "Manage your Cloudflare DNS records",
                    "Manage your Cloudflare DNS records",
                  )}
                </p>
              </div>
                <div />
              </div>
            </CardHeader>
            )}
            <CardContent className={cn(compactTopBar ? "px-3 py-2" : "space-y-4")}>
              {!compactTopBar && (
              <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
                <div className="space-y-2">
                  <Label htmlFor="zone-select">{t("Domain/Zone", "Domain/Zone")}</Label>
                  <Select
                    value={selectedZoneId || undefined}
                    onValueChange={(value) => {
                      setSelectedZoneId(value);
                      openZoneTab(value);
                    }}
                  >
                    <SelectTrigger className="bg-card/70 border-border text-foreground">
                      <SelectValue placeholder={t("Select a domain", "Select a domain")} />
                    </SelectTrigger>
                    <SelectContent className="bg-popover/70 text-foreground">
                      {availableZones.map((zone: Zone) => (
                        <SelectItem
                          key={zone.id}
                          value={zone.id}
                          className="cursor-pointer"
                        >
                          {zone.name} ({zone.status})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                  {activeTab && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <div className="rounded-md border border-border bg-card/60 px-3 py-2 text-foreground/80">
                        {t("{{count}} records", {
                          count: activeTab.records.length,
                          defaultValue: `${activeTab.records.length} records`,
                        })}
                      </div>
                      <div className="rounded-md border border-border bg-card/60 px-3 py-2 text-foreground/80">
                        {t("{{count}} visible", {
                          count: filteredRecords.length,
                          defaultValue: `${filteredRecords.length} visible`,
                        })}
                      </div>
                      <div className="rounded-md border border-border bg-card/60 px-3 py-2 text-foreground/80">
                        {t("Zone: {{name}}", {
                          name: selectedZoneData?.name ?? activeTab.zoneName,
                          defaultValue: `Zone: ${selectedZoneData?.name ?? activeTab.zoneName}`,
                        })}
                      </div>
                    </div>
                  )}
              </div>
              )}
              {(tabs.length > 0 || activeTab?.kind === "settings" || activeTab?.kind === "audit" || activeTab?.kind === "registry") && (
                <div
                  className={cn(
                    "flex flex-wrap gap-2 fade-in",
                    compactTopBar && "items-center overflow-x-auto whitespace-nowrap pb-0.5",
                  )}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceId =
                      dragTabId || event.dataTransfer.getData("text/plain");
                    if (sourceId) {
                      moveTabToEnd(sourceId);
                    }
                    setDragTabId(null);
                    setDragOverId(null);
                  }}
                >
                  {tabs.map((tab) => {
                    const isActive = tab.id === activeTabId;
                    return (
                      <div
                        key={tab.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => activateTab(tab.id)}
                        onAuxClick={(event) => {
                          if (event.button !== 1) return;
                          event.preventDefault();
                          event.stopPropagation();
                          closeTab(tab.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            activateTab(tab.id);
                          }
                        }}
                        draggable
                        onDragStart={(event) => {
                          setDragTabId(tab.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", tab.id);
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          if (dragOverId !== tab.id) {
                            setDragOverId(tab.id);
                          }
                        }}
                        onDragEnd={() => {
                          setDragTabId(null);
                          setDragOverId(null);
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const sourceId =
                            dragTabId || event.dataTransfer.getData("text/plain");
                          if (sourceId) {
                            reorderTabs(sourceId, tab.id);
                          }
                          setDragTabId(null);
                          setDragOverId(null);
                        }}
                        data-active={isActive}
                        className={cn(
                          "ui-tab cursor-grab",
                          dragOverId === tab.id && "ring-1 ring-primary/30",
                        )}
                      >
                        <GripVertical className="h-3 w-3 text-muted-foreground/60" />
                        <span className="max-w-[140px] truncate">
                          {tab.kind === "zone" ? tab.zoneName : t(tab.zoneName, tab.zoneName)}
                        </span>
                        {tab.kind === "zone" && (
                          <span className="text-[10px] uppercase tracking-widest opacity-60">
                            {tab.status ?? t("zone", "zone")}
                          </span>
                        )}
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            closeTab(tab.id);
                          }}
                          className="ml-1 rounded-full p-0.5 text-muted-foreground transition hover:text-foreground"
                          aria-label={t("Close tab", "Close tab")}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        {activeTab ? (
          <Card className="min-h-[70vh] border-border/60 bg-card/70 shadow-[0_20px_40px_rgba(0,0,0,0.18)] fade-in">
            <CardHeader className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                  <CardTitle className="text-xl">
                    {activeTab.kind === "zone" ? activeTab.zoneName : t(activeTab.zoneName, activeTab.zoneName)}
                  </CardTitle>
                  {activeTab.kind === "zone" && (
                    <p className="text-xs text-muted-foreground">{actionHint}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2" />
              </div>
              {activeTab.kind === "zone" && (
                <div className="glass-surface glass-sheen glass-fade ui-segment-group fade-in">
                  {ACTION_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActionTab(tab.id)}
                      data-active={actionTab === tab.id}
                      className="ui-segment"
                    >
                      {t(tab.label, tab.label)}
                    </button>
                  ))}
                </div>
              )}
            </CardHeader>
            <CardContent>
              {activeTab.kind === "zone" && actionTab === "records" && (
                <div className="space-y-4 fade-in">
                  <div className="rounded-xl border border-border/60 bg-card/60 p-3">
                    <div className="mb-2 text-[11px] uppercase tracking-widest text-muted-foreground">
                      {t("Assigned nameservers", "Assigned nameservers")}
                    </div>
                    {selectedZoneData?.name_servers && selectedZoneData.name_servers.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {selectedZoneData.name_servers.map((ns) => (
                          <span
                            key={ns}
                            className="rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs text-foreground/90"
                          >
                            {ns}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        {t("Not available for this zone.", "Not available for this zone.")}
                      </div>
                    )}
                  </div>
                  {activeTab.isLoading && (
                    <div className="space-y-3">
                      {Array.from({ length: 6 }).map((_, idx) => (
                        <div
                          key={`skeleton-${idx}`}
                          className="rounded-xl border border-border/50 bg-muted/30 p-4"
                        >
                          <div className="flex items-center gap-3">
                            <div className="skeleton h-4 w-4 rounded-md" />
                            <div className="skeleton h-6 w-16 rounded-md" />
                            <div className="skeleton h-4 w-36 rounded-md" />
                          </div>
                          <div className="mt-3 space-y-2">
                            <div className="skeleton h-3 w-5/6 rounded-md" />
                            <div className="skeleton h-3 w-2/3 rounded-md" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="grid gap-3 md:grid-cols-[1.2fr_auto_auto_auto] md:items-center">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        placeholder={t("Search records", "Search records")}
                        value={activeTab.searchTerm}
                        onChange={(e) =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            searchTerm: e.target.value,
                          }))
                        }
                        className="pl-9"
                      />
                    </div>
                    <Select
                      value={activeTab.typeFilter || "all"}
                      onValueChange={(v) =>
                        updateTab(activeTab.id, (prev) => ({
                          ...prev,
                          typeFilter: v === "all" ? "" : (v as RecordType),
                        }))
                      }
                    >
                      <SelectTrigger className="w-[180px]">
                        <SelectValue placeholder={t("All types", "All types")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">
                          {t("All types", "All types")}
                        </SelectItem>
                        {RECORD_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={String(activeTab.perPage)}
                      onValueChange={(v) => {
                        const value = Number(v);
                        updateTab(activeTab.id, (prev) => ({
                          ...prev,
                          perPage: Number.isNaN(value) ? 50 : value,
                          page: 1,
                        }));
                        if (!Number.isNaN(value)) {
                          setZonePerPage((prev) => ({
                            ...prev,
                            [activeTab.zoneId]: value,
                          }));
                        }
                      }}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue placeholder={t("Per page", "Per page")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="25">25</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                        <SelectItem value="200">200</SelectItem>
                        <SelectItem value="500">500</SelectItem>
                        <SelectItem value="0">{t("All", "All")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-2 justify-start md:justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 px-2 text-xs"
                        onClick={() => void loadRecords(activeTab)}
                        disabled={activeTab.isLoading}
                        title={t("Force refresh from Cloudflare", "Force refresh from Cloudflare")}
                      >
                        <RefreshCw className={cn("h-3.5 w-3.5", activeTab.isLoading && "animate-spin")} />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            searchTerm: "",
                            typeFilter: "",
                            page: 1,
                          }))
                        }
                      >
                        <X className="h-3 w-3 mr-1" />
                        {t("Clear", "Clear")}
                      </Button>
                      <div className="inline-flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-xs">
                        <Filter className="h-3 w-3" />
                        {t("Page {{page}}", {
                          page: activeTab.page,
                          defaultValue: `Page ${activeTab.page}`,
                        })}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            page: Math.max(1, prev.page - 1),
                          }))
                        }
                        disabled={activeTab.page <= 1}
                      >
                        {t("Prev", "Prev")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            page: prev.page + 1,
                          }))
                        }
                      >
                        {t("Next", "Next")}
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <AddRecordDialog
                      open={activeTab.showAddRecord}
                      onOpenChange={(open) =>
                        updateTab(activeTab.id, (prev) => ({
                          ...prev,
                          showAddRecord: open,
                        }))
                      }
                      record={activeTab.newRecord}
                      onRecordChange={(record) =>
                        updateTab(activeTab.id, (prev) => ({
                          ...prev,
                          newRecord: record,
                        }))
                      }
                      onAdd={handleAddRecord}
                      zoneName={activeTab.zoneName}
                      showUnsupportedRecordTypes={resolvedShowUnsupportedRecordTypes}
                      apiKey={apiKey}
                      email={email}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleCopySelected}
                      disabled={!activeTab.selectedIds.length}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      {t("Copy selected", "Copy selected")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handlePasteRecords}
                      disabled={!copyBuffer}
                    >
                      <ClipboardPaste className="h-4 w-4 mr-2" />
                      {t("Paste", "Paste")} {copyBuffer ? `${copyBuffer.records.length}` : ""}
                    </Button>
                    {copyBuffer && (
                      <div className="text-xs text-muted-foreground">
                        {t("Buffer: {{count}} from {{zone}}", {
                          count: copyBuffer.records.length,
                          zone: copyBuffer.sourceZoneName,
                          defaultValue: `Buffer: ${copyBuffer.records.length} from ${copyBuffer.sourceZoneName}`,
                        })}
                      </div>
                    )}
                    {activeTab.selectedIds.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            selectedIds: [],
                          }))
                        }
                      >
                        {t("Clear selection", "Clear selection")}
                      </Button>
                    )}
                  </div>
                  {activeTab.isLoading ? (
                    <div className="text-center py-8">{t("Loading...", "Loading...")}</div>
                  ) : filteredRecords.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      {t("No DNS records found", "No DNS records found")}
                    </div>
                  ) : (
                    <div className="glass-surface glass-sheen glass-fade-table ui-table rounded-xl">
                      <div className="ui-table-head">
                        <span />
                        <button
                          type="button"
                          className="text-left hover:text-foreground"
                          onClick={() => toggleSort("type")}
                        >
                          {t("Type", "Type")}{" "}
                          <span className="opacity-70">{sortIndicator("type")}</span>
                        </button>
                        <button
                          type="button"
                          className="text-left hover:text-foreground"
                          onClick={() => toggleSort("name")}
                        >
                          {t("Name", "Name")}{" "}
                          <span className="opacity-70">{sortIndicator("name")}</span>
                        </button>
                        <button
                          type="button"
                          className="text-left hover:text-foreground"
                          onClick={() => toggleSort("content")}
                        >
                          {t("Content", "Content")}{" "}
                          <span className="opacity-70">{sortIndicator("content")}</span>
                        </button>
                        <button
                          type="button"
                          className="text-left hover:text-foreground"
                          onClick={() => toggleSort("ttl")}
                        >
                          {t("TTL", "TTL")}{" "}
                          <span className="opacity-70">{sortIndicator("ttl")}</span>
                        </button>
                        <button
                          type="button"
                          className="text-left hover:text-foreground"
                          onClick={() => toggleSort("proxied")}
                        >
                          {t("Proxy", "Proxy")}{" "}
                          <span className="opacity-70">{sortIndicator("proxied")}</span>
                        </button>
                        <span className="text-right">{t("Actions", "Actions")}</span>
                      </div>
                      {filteredRecords.map((record) => {
                        const isSelected = activeTab.selectedIds.includes(
                          record.id,
                        );
                        return (
                          <RecordRow
                            key={record.id}
                            zoneId={activeTab.zoneId}
                            record={record}
                            isEditing={activeTab.editingRecord === record.id}
                            isSelected={isSelected}
                            onSelectChange={(checked) =>
                              updateTab(activeTab.id, (prev) => ({
                                ...prev,
                                selectedIds: checked
                                  ? [...prev.selectedIds, record.id]
                                  : prev.selectedIds.filter(
                                      (id) => id !== record.id,
                                    ),
                              }))
                            }
                            onEdit={() =>
                              updateTab(activeTab.id, (prev) => ({
                                ...prev,
                                editingRecord: record.id,
                              }))
                            }
                            onSave={(updatedRecord: DNSRecord) =>
                              handleUpdateRecord(updatedRecord)
                            }
                            onCancel={() =>
                              updateTab(activeTab.id, (prev) => ({
                                ...prev,
                                editingRecord: null,
                              }))
                            }
                            onDelete={() => handleDeleteRecord(record.id)}
                            onToggleProxy={(next) =>
                              handleToggleProxy(record, next)
                            }
                            onCopy={() => handleCopySingle(record)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {activeTab.kind === "zone" && actionTab === "import" && (
                <div className="grid gap-4 md:grid-cols-2">
                  <Card className="border-border/60 bg-card/70">
                    <CardHeader>
                      <CardTitle className="text-lg">
                        {t("Import Records", "Import Records")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        {t(
                          "Bring in records from CSV, JSON, or BIND zone files.",
                          "Bring in records from CSV, JSON, or BIND zone files.",
                        )}
                      </p>
                      <ImportExportDialog
                        open={activeTab.showImport}
                        onOpenChange={(open) =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            showImport: open,
                          }))
                        }
                        importData={activeTab.importData}
                        importFormat={activeTab.importFormat}
                        onImportDataChange={(value) =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            importData: value,
                          }))
                        }
                        onImportFormatChange={(value) =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            importFormat: value,
                          }))
                        }
                        onImport={(items, dryRun) =>
                          handleImport(activeTab, items, dryRun)
                        }
                        serverExport={async (format) => {
                          try {
                            const res = await exportDNSRecords(
                              activeTab.zoneId,
                              format,
                              activeTab.page,
                              activeTab.perPage,
                            );
                            const blob = new Blob([res], {
                              type:
                                format === "json"
                                  ? "application/json"
                                  : format === "csv"
                                    ? "text/csv"
                                    : "text/plain",
                            });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `${activeTab.zoneId}-records.${format === "json" ? "json" : format === "csv" ? "csv" : "zone"}`;
                            a.click();
                            URL.revokeObjectURL(url);
                            toast({
                              title: t("Success", "Success"),
                              description: t("Server export {{format}} completed", {
                                format: format.toUpperCase(),
                                defaultValue: `Server export ${format.toUpperCase()} completed`,
                              }),
                            });
                          } catch (err) {
                            toast({
                              title: t("Error", "Error"),
                              description: t("Server export failed: {{error}}", {
                                error: (err as Error).message,
                                defaultValue: `Server export failed: ${(err as Error).message}`,
                              }),
                              variant: "destructive",
                            });
                          }
                        }}
                        onExport={handleExport}
                      />
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-card/70">
                    <CardHeader>
                      <CardTitle className="text-lg">
                        {t("Export Records", "Export Records")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        {t(
                          "Download zone data locally or run server-side exports.",
                          "Download zone data locally or run server-side exports.",
                        )}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          onClick={() => handleExport("json")}
                        >
                          <FileDown className="h-4 w-4 mr-2" />
                          {t("Export JSON", "Export JSON")}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => handleExport("csv")}
                        >
                          <FileDown className="h-4 w-4 mr-2" />
                          {t("Export CSV", "Export CSV")}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => handleExport("bind")}
                        >
                          <FileDown className="h-4 w-4 mr-2" />
                          {t("Export BIND", "Export BIND")}
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => setActionTab("records")}
                        >
                          <FileUp className="h-4 w-4 mr-2" />
                          {t("Back to records", "Back to records")}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
              {activeTab.kind === "zone" && actionTab === "zone-settings" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">{t("Zone settings", "Zone settings")}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">{t("Per-page override", "Per-page override")}</div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Select
                          value={
                            zonePerPage[activeTab.zoneId] === undefined
                              ? "inherit"
                              : String(zonePerPage[activeTab.zoneId])
                          }
                          onValueChange={(v) => {
                            if (v === "inherit") {
                              setZonePerPage((prev) => {
                                const next = { ...prev };
                                delete next[activeTab.zoneId];
                                return next;
                              });
                              updateTab(activeTab.id, (prev) => ({
                                ...prev,
                                perPage: globalPerPage,
                                page: 1,
                              }));
                              notifySaved(
                                t("Zone per-page set to inherit ({{count}}).", {
                                  count: globalPerPage,
                                  defaultValue: `Zone per-page set to inherit (${globalPerPage}).`,
                                }),
                              );
                              return;
                            }
                            const value = Number(v);
                            if (Number.isNaN(value)) return;
                            setZonePerPage((prev) => ({
                              ...prev,
                              [activeTab.zoneId]: value,
                            }));
                            updateTab(activeTab.id, (prev) => ({
                              ...prev,
                              perPage: value,
                              page: 1,
                            }));
                            notifySaved(
                              t("Zone per-page set to {{count}}.", {
                                count: value,
                                defaultValue: `Zone per-page set to ${value}.`,
                              }),
                            );
                          }}
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue placeholder={t("Per page", "Per page")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">
                              {t("Inherit", "Inherit")} ({globalPerPage})
                            </SelectItem>
                            <SelectItem value="25">25</SelectItem>
                            <SelectItem value="50">50</SelectItem>
                            <SelectItem value="100">100</SelectItem>
                            <SelectItem value="200">200</SelectItem>
                            <SelectItem value="500">500</SelectItem>
                            <SelectItem value="0">{t("All", "All")}</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Overrides the global default for this zone only.",
                            "Overrides the global default for this zone only.",
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t("Unsupported record types", "Unsupported record types")}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Select
                          value={
                            Object.prototype.hasOwnProperty.call(
                              zoneShowUnsupportedRecordTypes,
                              activeTab.zoneId,
                            )
                              ? zoneShowUnsupportedRecordTypes[activeTab.zoneId]
                                ? "show"
                                : "hide"
                              : "inherit"
                          }
                          onValueChange={(v) => {
                            if (v === "inherit") {
                              setZoneShowUnsupportedRecordTypes((prev) => {
                                const next = { ...prev };
                                delete next[activeTab.zoneId];
                                return next;
                              });
                              notifySaved(
                                t("Zone unsupported record types set to inherit ({{state}}).", {
                                  state: showUnsupportedRecordTypes
                                    ? t("Show", "Show").toLowerCase()
                                    : t("Hide", "Hide").toLowerCase(),
                                  defaultValue: `Zone unsupported record types set to inherit (${
                                    showUnsupportedRecordTypes ? "show" : "hide"
                                  }).`,
                                }),
                              );
                              return;
                            }
                            const enabled = v === "show";
                            setZoneShowUnsupportedRecordTypes((prev) => ({
                              ...prev,
                              [activeTab.zoneId]: enabled,
                            }));
                            notifySaved(
                              enabled
                                ? t(
                                    "Zone will show unsupported record types in Add Record.",
                                    "Zone will show unsupported record types in Add Record.",
                                  )
                                : t(
                                    "Zone will hide unsupported record types in Add Record.",
                                    "Zone will hide unsupported record types in Add Record.",
                                  ),
                            );
                          }}
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue placeholder={t("Inherit", "Inherit")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">
                              {t("Inherit", "Inherit")} (
                              {showUnsupportedRecordTypes ? t("Show", "Show") : t("Hide", "Hide")})
                            </SelectItem>
                            <SelectItem value="hide">{t("Hide", "Hide")}</SelectItem>
                            <SelectItem value="show">{t("Show", "Show")}</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Controls whether non-Cloudflare record types appear in the Type dropdown for this zone.",
                            "Controls whether non-Cloudflare record types appear in the Type dropdown for this zone.",
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">{t("Reopen on launch", "Reopen on launch")}</div>
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={reopenZoneTabs[activeTab.zoneId] !== false}
                          onCheckedChange={(checked: boolean) => {
                            setReopenZoneTabs((prev) => ({
                              ...prev,
                              [activeTab.zoneId]: checked,
                            }));
                            notifySaved(
                              checked
                                ? t("Zone will reopen on launch.", "Zone will reopen on launch.")
                                : t("Zone will not reopen on launch.", "Zone will not reopen on launch."),
                            );
                          }}
                        />
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Controls whether this zone restores when tabs reopen.",
                            "Controls whether this zone restores when tabs reopen.",
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "cache" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">{t("Cache", "Cache")}</CardTitle>
                  </CardHeader>
                  <CardContent className="relative space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm text-muted-foreground">
                        {t("Cloudflare cache controls for {{zone}}.", {
                          zone: activeTab.zoneName,
                          defaultValue: `Cloudflare cache controls for ${activeTab.zoneName}.`,
                        })}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-2 text-xs"
                          onClick={() => void refreshCacheSettings(activeTab.zoneId)}
                          disabled={cacheSettingsLoading}
                          title={t("Force refresh from Cloudflare", "Force refresh from Cloudflare")}
                        >
                          <RefreshCw
                            className={cn("h-3.5 w-3.5", cacheSettingsLoading && "animate-spin")}
                          />
                        </Button>
                        {cacheSettingsLoading && (
                          <div className="text-xs text-muted-foreground">{t("Loading…", "Loading…")}</div>
                        )}
                      </div>
                    </div>
                    {cacheSettingsError && (
                      <div className="text-xs text-destructive">{cacheSettingsError}</div>
                    )}

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">{t("Development mode", "Development mode")}</div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneDevMode ? (
                          <Switch
                            checked={zoneDevMode.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleSetDevelopmentMode(checked)
                            }
                            disabled={!apiKey || cacheSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">{t("Unavailable.", "Unavailable.")}</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Temporarily bypasses cache (Cloudflare may auto-disable after a few hours).",
                            "Temporarily bypasses cache (Cloudflare may auto-disable after a few hours).",
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">{t("Cache level", "Cache level")}</div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneCacheLevel ? (
                          <Select
                            value={zoneCacheLevel.value ?? "basic"}
                            onValueChange={(v) => handleSetCacheLevel(v)}
                            disabled={!apiKey || cacheSettingsLoading}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue placeholder={t("Cache level", "Cache level")} />
                            </SelectTrigger>
                            <SelectContent>
                              {zoneCacheLevel.value &&
                              !["basic", "aggressive", "simplified"].includes(
                                zoneCacheLevel.value,
                              ) ? (
                                <SelectItem value={zoneCacheLevel.value}>
                                  {t("{{value}} (current)", {
                                    value: zoneCacheLevel.value,
                                    defaultValue: `${zoneCacheLevel.value} (current)`,
                                  })}
                                </SelectItem>
                              ) : null}
                              <SelectItem value="basic">{t("Basic", "Basic")}</SelectItem>
                              <SelectItem value="aggressive">{t("Aggressive", "Aggressive")}</SelectItem>
                              <SelectItem value="simplified">{t("Simplified", "Simplified")}</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-xs text-muted-foreground">{t("Unavailable.", "Unavailable.")}</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Controls how aggressively Cloudflare caches your content.",
                            "Controls how aggressively Cloudflare caches your content.",
                          )}
                        </div>
                        <div className="w-full space-y-1 rounded-lg border border-border/60 bg-card/55 p-2 text-[11px] text-muted-foreground">
                          {(["basic", "aggressive", "simplified"] as const).map((level) => (
                            <div
                              key={level}
                              className={cn(
                                "rounded-md px-2 py-1",
                                zoneCacheLevel?.value === level
                                  ? "bg-primary/10 text-foreground"
                                  : "bg-transparent",
                              )}
                            >
                              <span className="font-medium capitalize">{level}</span>:{" "}
                              {t(CACHE_LEVEL_DETAILS[level], CACHE_LEVEL_DETAILS[level])}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-start">
                      <div className="font-medium text-sm">{t("Purge cache", "Purge cache")}</div>
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setShowPurgeEverythingConfirm(true)}
                            disabled={!apiKey}
                          >
                            {t("Purge everything", "Purge everything")}
                          </Button>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
                            {t("Purge URLs (one per line)", "Purge URLs (one per line)")}
                          </Label>
                          <Textarea
                            value={purgeUrlsInput}
                            onChange={(e) => setPurgeUrlsInput(e.target.value)}
                            placeholder={`https://${activeTab.zoneName}/path\nhttps://${activeTab.zoneName}/asset.js`}
                            className="min-h-24 resize-y"
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => preparePurgeUrls()}
                              disabled={!apiKey || !purgeUrlsInput.trim()}
                            >
                              {t("Purge URLs…", "Purge URLs…")}
                            </Button>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Validations warn, but you can still force purge.",
                                "Validations warn, but you can still force purge.",
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    {cacheOverlay.visible && (
                      <SectionLoadingOverlay
                        label={t("Loading cache settings...", "Loading cache settings...")}
                      />
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "ssl-tls" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">{t("SSL/TLS", "SSL/TLS")}</CardTitle>
                  </CardHeader>
                  <CardContent className="relative space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm text-muted-foreground">
                        {t("SSL/TLS controls for {{zone}}.", {
                          zone: activeTab.zoneName,
                          defaultValue: `SSL/TLS controls for ${activeTab.zoneName}.`,
                        })}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-2 text-xs"
                          onClick={() => void refreshSslSettings(activeTab.zoneId)}
                          disabled={sslSettingsLoading}
                          title={t("Force refresh from Cloudflare", "Force refresh from Cloudflare")}
                        >
                          <RefreshCw
                            className={cn("h-3.5 w-3.5", sslSettingsLoading && "animate-spin")}
                          />
                        </Button>
                        {sslSettingsLoading && (
                          <div className="text-xs text-muted-foreground">{t("Loading…", "Loading…")}</div>
                        )}
                      </div>
                    </div>
                    {sslSettingsError && (
                      <div className="text-xs text-destructive">{sslSettingsError}</div>
                    )}

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">{t("Encryption mode", "Encryption mode")}</div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneSslMode ? (
                          <Select
                            value={zoneSslMode.value ?? "off"}
                            onValueChange={(v) => handleSetSslTlsSetting("ssl", v)}
                            disabled={!apiKey || sslSettingsLoading}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue placeholder={t("SSL mode", "SSL mode")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="off">{t("Off", "Off")}</SelectItem>
                              <SelectItem value="flexible">{t("Flexible", "Flexible")}</SelectItem>
                              <SelectItem value="full">{t("Full", "Full")}</SelectItem>
                              <SelectItem value="strict">{t("Full (strict)", "Full (strict)")}</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-xs text-muted-foreground">{t("Unavailable.", "Unavailable.")}</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Controls how Cloudflare connects to your origin.",
                            "Controls how Cloudflare connects to your origin.",
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">{t("Minimum TLS version", "Minimum TLS version")}</div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneMinTlsVersion ? (
                          <Select
                            value={zoneMinTlsVersion.value ?? "1.2"}
                            onValueChange={(v) =>
                              handleSetSslTlsSetting("min_tls_version", v)
                            }
                            disabled={!apiKey || sslSettingsLoading}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue placeholder={t("Min TLS", "Min TLS")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="1.0">1.0</SelectItem>
                              <SelectItem value="1.1">1.1</SelectItem>
                              <SelectItem value="1.2">1.2</SelectItem>
                              <SelectItem value="1.3">1.3</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-xs text-muted-foreground">{t("Unavailable.", "Unavailable.")}</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Affects client connections to Cloudflare edge.",
                            "Affects client connections to Cloudflare edge.",
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">{t("TLS 1.3", "TLS 1.3")}</div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneTls13 ? (
                          <Switch
                            checked={zoneTls13.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleSetSslTlsSetting("tls_1_3", checked ? "on" : "off")
                            }
                            disabled={!apiKey || sslSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">{t("Unavailable.", "Unavailable.")}</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Enables TLS 1.3 for client connections.",
                            "Enables TLS 1.3 for client connections.",
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">{t("Always Use HTTPS", "Always Use HTTPS")}</div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneAlwaysUseHttps ? (
                          <Switch
                            checked={zoneAlwaysUseHttps.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleSetSslTlsSetting(
                                "always_use_https",
                                checked ? "on" : "off",
                              )
                            }
                            disabled={!apiKey || sslSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">{t("Unavailable.", "Unavailable.")}</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t("Redirect HTTP to HTTPS at the edge.", "Redirect HTTP to HTTPS at the edge.")}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t("Automatic HTTPS Rewrites", "Automatic HTTPS Rewrites")}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneAutoHttpsRewrites ? (
                          <Switch
                            checked={zoneAutoHttpsRewrites.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleSetSslTlsSetting(
                                "automatic_https_rewrites",
                                checked ? "on" : "off",
                              )
                            }
                            disabled={!apiKey || sslSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">{t("Unavailable.", "Unavailable.")}</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Rewrites mixed content links to HTTPS when possible.",
                            "Rewrites mixed content links to HTTPS when possible.",
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t("Opportunistic encryption", "Opportunistic encryption")}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneOpportunisticEncryption ? (
                          <Switch
                            checked={zoneOpportunisticEncryption.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleSetSslTlsSetting(
                                "opportunistic_encryption",
                                checked ? "on" : "off",
                              )
                            }
                            disabled={!apiKey || sslSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">{t("Unavailable.", "Unavailable.")}</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Enables opportunistic encryption to the edge when supported.",
                            "Enables opportunistic encryption to the edge when supported.",
                          )}
                        </div>
                      </div>
                    </div>
                    {sslOverlay.visible && (
                      <SectionLoadingOverlay
                        label={t("Loading SSL/TLS settings...", "Loading SSL/TLS settings...")}
                      />
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "domain-audit" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">{t("Domain audits", "Domain audits")}</CardTitle>
                  </CardHeader>
                  <CardContent className="relative space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-sm text-muted-foreground">
                        {t("Audits run against the records currently loaded for", "Audits run against the records currently loaded for")}{" "}
                        <span className="font-medium text-foreground/90">
                          {activeTab.zoneName}
                        </span>
                        .
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const controller = new AbortController();
                            void loadRecords(activeTab, controller.signal);
                          }}
                        >
                          {t("Refresh records", "Refresh records")}
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-card/60 p-3 text-sm">
                      <div className="font-medium">{t("Checks", "Checks")}</div>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          className="checkbox-themed"
                          checked={domainAuditCategories.email}
                          onChange={(e) =>
                            setDomainAuditCategories((prev) => ({
                              ...prev,
                              email: e.target.checked,
                            }))
                          }
                        />
                        {t("Email (SPF/DKIM/DMARC)", "Email (SPF/DKIM/DMARC)")}
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          className="checkbox-themed"
                          checked={domainAuditCategories.security}
                          onChange={(e) =>
                            setDomainAuditCategories((prev) => ({
                              ...prev,
                              security: e.target.checked,
                            }))
                          }
                        />
                        {t("Security (CAA)", "Security (CAA)")}
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          className="checkbox-themed"
                          checked={domainAuditCategories.hygiene}
                          onChange={(e) =>
                            setDomainAuditCategories((prev) => ({
                              ...prev,
                              hygiene: e.target.checked,
                            }))
                          }
                        />
                        {t("Hygiene (private IPs, deprecated)", "Hygiene (private IPs, deprecated)")}
                      </label>
                      <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                          checked={domainAuditShowPassed}
                          onCheckedChange={(checked: boolean) =>
                            setDomainAuditShowPassed(checked)
                          }
                        />
                        {t("Show passed", "Show passed")}
                      </div>
                      {auditOverridesByZone[activeTab.zoneId]?.size > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-xs"
                          onClick={handleClearAllAuditOverrides}
                        >
                          {t("Clear {{count}} override", {
                            count: auditOverridesByZone[activeTab.zoneId].size,
                            defaultValue: `Clear ${auditOverridesByZone[activeTab.zoneId].size} override`,
                          })}
                          {auditOverridesByZone[activeTab.zoneId].size !== 1 ? "s" : ""}
                        </Button>
                      )}
                    </div>

                    <div className="rounded-xl border border-border/60 bg-card/60 p-2">
                      {domainAuditVisibleItems.length === 0 ? (
                        <div className="px-3 py-6 text-sm text-muted-foreground">
                          {t(
                            "No issues detected (with current filters).",
                            "No issues detected (with current filters).",
                          )}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {domainAuditVisibleItems.map((item) => {
                            const isOverridden = auditOverridesByZone[activeTab.zoneId]?.has(
                              item.id,
                            );
                            const originalSeverity =
                              isOverridden && item.title.includes("(overridden)")
                                ? (item.details.match(/Original severity: (\w+)/)?.[1] as
                                    | "fail"
                                    | "warn"
                                    | "info"
                                    | undefined)
                                : undefined;
                            const displaySeverity = originalSeverity ?? item.severity;

                            const badge =
                              displaySeverity === "fail"
                                ? "bg-destructive/20 text-destructive border-destructive/30"
                                : displaySeverity === "warn"
                                  ? "bg-amber-500/15 text-amber-200 border-amber-500/30"
                                  : displaySeverity === "info"
                                    ? "bg-sky-500/15 text-sky-200 border-sky-500/30"
                                    : "bg-emerald-500/15 text-emerald-200 border-emerald-500/30";

                            return (
                              <div
                                key={item.id}
                                className="rounded-xl border border-border/60 bg-muted/10 p-3"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span
                                        className={cn(
                                          "rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-widest",
                                          badge,
                                          isOverridden && "opacity-60",
                                        )}
                                      >
                                        {displaySeverity}
                                      </span>
                                      {isOverridden && (
                                        <span className="rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] uppercase tracking-widest text-emerald-200">
                                          {t("overridden", "overridden")}
                                        </span>
                                      )}
                                      <div
                                        className={cn(
                                          "font-medium text-sm",
                                          isOverridden && "line-through opacity-60",
                                        )}
                                      >
                                        {item.title.replace(" (overridden)", "")}
                                      </div>
                                    </div>
                                    <div className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                                      {item.details}
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    {item.severity !== "pass" && !isOverridden && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="text-xs"
                                        onClick={() => handleOverrideAuditItem(item.id)}
                                        title={t("Mark as acknowledged/passing", "Mark as acknowledged/passing")}
                                      >
                                        {t("Override", "Override")}
                                      </Button>
                                    )}
                                    {isOverridden && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="text-xs"
                                        onClick={() => handleClearAuditOverride(item.id)}
                                        title={t("Remove override", "Remove override")}
                                      >
                                        {t("Restore", "Restore")}
                                      </Button>
                                    )}
                                    {item.suggestion && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                          updateTab(activeTab.id, (prev) => ({
                                            ...prev,
                                            showAddRecord: true,
                                            newRecord: {
                                              ...createEmptyRecord(),
                                              type: item.suggestion!.recordType,
                                              name: item.suggestion!.name,
                                              content: item.suggestion!.content,
                                              ttl: 300,
                                            },
                                          }))
                                        }
                                      >
                                        {t("Add suggested record…", "Add suggested record…")}
                                      </Button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="text-xs text-muted-foreground">
                      {t(
                        "These checks are best-practice heuristics based only on records currently present in this zone.",
                        "These checks are best-practice heuristics based only on records currently present in this zone.",
                      )}
                    </div>
                    {auditOverlay.visible && (
                      <SectionLoadingOverlay
                        label={t("Loading audit data...", "Loading audit data...")}
                      />
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "domain-registry" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      {t("Domain Registry Tools", "Domain Registry Tools")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="relative space-y-4">
                    <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
                      <Input
                        value={registryLookupDomain}
                        onChange={(e) => setRegistryLookupDomain(e.target.value)}
                        placeholder={t("example.com", "example.com")}
                      />
                      <Button
                        onClick={() => void runDomainRegistryChecks()}
                        disabled={!registryLookupDomain.trim() || registryChecksLoading}
                      >
                        {registryChecksLoading
                          ? t("Checking...", "Checking...")
                          : t("Check Everything", "Check Everything")}
                      </Button>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          window.open(
                            `https://rdap.org/domain/${encodeURIComponent(
                              registryLookupDomain.trim(),
                            )}`,
                            "_blank",
                            "noopener,noreferrer",
                          )
                        }
                        disabled={!registryLookupDomain.trim()}
                      >
                        <ExternalLink className="h-3.5 w-3.5 mr-1" />
                        {t("RDAP Tool", "RDAP Tool")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          window.open(
                            `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(
                              registryLookupDomain.trim(),
                            )}`,
                            "_blank",
                            "noopener,noreferrer",
                          )
                        }
                        disabled={!registryLookupDomain.trim()}
                      >
                        <ExternalLink className="h-3.5 w-3.5 mr-1" />
                        {t("WHOIS Tool", "WHOIS Tool")}
                      </Button>
                    </div>

                    {registryChecksError && (
                      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive-foreground">
                        {registryChecksError}
                      </div>
                    )}
                    <div className="grid gap-3 lg:grid-cols-2">
                      <div className="rounded-xl border border-border/60 bg-card/60 p-3 space-y-2">
                        <div className="text-sm font-medium">{t("Registrar API Match", "Registrar API Match")}</div>
                        {registrarDomainResult ? (
                          <div className="text-xs text-muted-foreground space-y-1">
                            <div>
                              {t("Domain:", "Domain:")}{" "}
                              <span className="text-foreground">{registrarDomainResult.domain}</span>
                            </div>
                            <div>
                              {t("Registrar:", "Registrar:")}{" "}
                              <span className="text-foreground">{registrarDomainResult.registrar}</span>
                            </div>
                            <div>
                              {t("Status:", "Status:")}{" "}
                              <span className="text-foreground">{registrarDomainResult.status}</span>
                            </div>
                            <div>
                              {t("Expires:", "Expires:")}{" "}
                              <span
                                className="text-foreground"
                                title={formatHumanizedDateTime(registrarDomainResult.expires_at).full}
                              >
                                {formatHumanizedDateTime(registrarDomainResult.expires_at).short}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "No registrar-api match found for this domain.",
                              "No registrar-api match found for this domain.",
                            )}
                          </div>
                        )}
                      </div>

                      <div className="rounded-xl border border-border/60 bg-card/60 p-3 space-y-2">
                        <div className="text-sm font-medium">{t("Health Checks", "Health Checks")}</div>
                        {registrarHealthResult ? (
                          <div className="text-xs text-muted-foreground space-y-1">
                            <div>
                              {t("Overall:", "Overall:")}{" "}
                              <span className="text-foreground">{registrarHealthResult.status}</span>
                            </div>
                            {registrarHealthResult.checks.map((check) => (
                              <div key={check.name}>
                                {check.name}:{" "}
                                <span className="text-foreground">{check.message}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "No health check data for this domain yet.",
                              "No health check data for this domain yet.",
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-border/60 bg-card/60 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium">{t("RDAP Response", "RDAP Response")}</div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              if (!rdapResult) return;
                              const summary = [
                                `Domain: ${String(rdapObject.ldhName ?? rdapObject.unicodeName ?? "—")}`,
                                `Handle: ${String(rdapObject.handle ?? "—")}`,
                                `Registrar API: ${registrarDomainResult?.registrar ?? "—"}`,
                                `Registrar Entity: ${String(rdapRegistrarEntity?.handle ?? "—")}`,
                                `Status: ${rdapStatuses.length ? rdapStatuses.join(", ") : "—"}`,
                                `Nameservers: ${rdapNameservers.length ? rdapNameservers.join(", ") : "—"}`,
                              ].join("\n");
                              const payload = showRawRdap
                                ? JSON.stringify(rdapResult, null, 2)
                                : summary;
                              void navigator.clipboard
                                .writeText(payload)
                                .then(() =>
                                  toast({
                                    title: t("Copied", "Copied"),
                                    description: t(
                                      "Registry data copied to clipboard.",
                                      "Registry data copied to clipboard.",
                                    ),
                                  }),
                                )
                                .catch((error) =>
                                  toast({
                                    title: t("Copy failed", "Copy failed"),
                                    description:
                                      error instanceof Error ? error.message : String(error),
                                    variant: "destructive",
                                  }),
                                );
                            }}
                            disabled={!rdapResult}
                          >
                            <Copy className="h-3.5 w-3.5 mr-1" />
                            {t("Copy", "Copy")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowRawRdap((prev) => !prev)}
                            disabled={!rdapResult}
                          >
                            {showRawRdap
                              ? t("Show Table", "Show Table")
                              : t("Show Raw JSON", "Show Raw JSON")}
                          </Button>
                        </div>
                      </div>
                      {rdapResult ? (
                        showRawRdap ? (
                          <pre className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/20 p-3 text-[11px]">
                            {JSON.stringify(rdapResult, null, 2)}
                          </pre>
                        ) : (
                          <div className="space-y-3">
                            <div className="overflow-auto rounded-lg border border-border/60 bg-muted/10">
                              <table className="w-full text-xs">
                                <tbody>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">{t("Domain", "Domain")}</td>
                                    <td className="px-3 py-2">{String(rdapObject.ldhName ?? rdapObject.unicodeName ?? "—")}</td>
                                  </tr>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">{t("Handle", "Handle")}</td>
                                    <td className="px-3 py-2">{String(rdapObject.handle ?? "—")}</td>
                                  </tr>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">{t("Object Class", "Object Class")}</td>
                                    <td className="px-3 py-2">{String(rdapObject.objectClassName ?? "—")}</td>
                                  </tr>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">{t("Port 43", "Port 43")}</td>
                                    <td className="px-3 py-2">{String(rdapObject.port43 ?? "—")}</td>
                                  </tr>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">{t("Registrar (API)", "Registrar (API)")}</td>
                                    <td className="px-3 py-2">
                                      {registrarDomainResult?.registrar ?? "—"}
                                    </td>
                                  </tr>
                                  <tr>
                                    <td className="px-3 py-2 font-medium text-muted-foreground">{t("Status", "Status")}</td>
                                    <td className="px-3 py-2">
                                      {rdapStatuses.length ? rdapStatuses.join(", ") : "—"}
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>

                            <div className="overflow-auto rounded-lg border border-border/60 bg-muted/10">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b border-border/40 text-muted-foreground">
                                    <th className="px-3 py-2 text-left font-medium">{t("Event", "Event")}</th>
                                    <th className="px-3 py-2 text-left font-medium">{t("Date", "Date")}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {rdapEvents.length ? (
                                    rdapEvents.map((event, idx) => (
                                      <tr key={`${event.action}-${idx}`} className="border-b border-border/30 last:border-b-0">
                                        <td className="px-3 py-2">{event.action}</td>
                                        <td className="px-3 py-2" title={formatHumanizedDateTime(event.date).full}>
                                          {formatHumanizedDateTime(event.date).short}
                                        </td>
                                      </tr>
                                    ))
                                  ) : (
                                    <tr>
                                      <td className="px-3 py-2 text-muted-foreground" colSpan={2}>{t("No events returned.", "No events returned.")}</td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                            </div>

                            <div className="overflow-auto rounded-lg border border-border/60 bg-muted/10">
                              <table className="w-full text-xs">
                                <tbody>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">{t("Registrar Entity", "Registrar Entity")}</td>
                                    <td className="px-3 py-2">{String(rdapRegistrarEntity?.handle ?? "—")}</td>
                                  </tr>
                                  <tr>
                                    <td className="px-3 py-2 font-medium text-muted-foreground">{t("Nameservers", "Nameservers")}</td>
                                    <td className="px-3 py-2">
                                      {rdapNameservers.length ? rdapNameservers.join(", ") : "—"}
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          {t("Run checks to load RDAP response.", "Run checks to load RDAP response.")}
                        </div>
                      )}
                    </div>
                    {registryOverlay.visible && (
                      <SectionLoadingOverlay
                        label={t("Loading registry data...", "Loading registry data...")}
                      />
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "topology" && (
                <ZoneTopologyTab
                  zoneName={activeTab.zoneName}
                  records={activeTab.records}
                  isLoading={activeTab.isLoading}
                  maxResolutionHops={topologyResolutionMaxHops}
                  resolverMode={topologyResolverMode}
                  dnsServer={topologyDnsServer}
                  customDnsServer={topologyCustomDnsServer}
                  dohProvider={topologyDohProvider}
                  dohCustomUrl={topologyDohCustomUrl}
                  exportConfirmPath={topologyExportConfirmPath}
                  exportFolderPreset={topologyExportFolderPreset}
                  exportCustomPath={topologyExportCustomPath}
                  copyActions={topologyCopyActions}
                  exportActions={topologyExportActions}
                  disableAnnotations={topologyDisableAnnotations}
                  disableFullWindow={topologyDisableFullWindow}
                  lookupTimeoutMs={topologyLookupTimeoutMs}
                  disablePtrLookups={topologyDisablePtrLookups}
                  disableGeoLookups={topologyDisableGeoLookups}
                  geoProvider={topologyGeoProvider}
                  scanResolutionChain={topologyScanResolutionChain}
                  disableServiceDiscovery={topologyDisableServiceDiscovery}
                  tcpServicePorts={topologyTcpServices.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)}
                  onRefresh={async () => {
                    await loadRecords(activeTab);
                  }}
                  onEditRecord={(record) => {
                    setActionTab("records");
                    updateTab(activeTab.id, (prev) => ({
                      ...prev,
                      editingRecord: record.id,
                    }));
                  }}
                />
              )}
              {activeTab.kind === "audit" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <CardTitle className="text-lg">{t("Audit log", "Audit log")}</CardTitle>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 px-2"
                          onClick={() => loadAuditEntries()}
                          title={t("Refresh", "Refresh")}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          <span className="text-xs">{t("Refresh", "Refresh")}</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 px-2"
                          onClick={() => {
                            if (confirmClearAuditLogs) {
                              setShowClearAuditConfirm(true);
                              return;
                            }
                            void clearAuditEntriesNow();
                          }}
                          disabled={!isDesktop() || auditEntries.length === 0}
                          title={t("Clear logs", "Clear logs")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span className="text-xs">{t("Clear", "Clear")}</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 px-2"
                          onClick={async () => {
                            if (!isDesktop()) return;
                            try {
                              const path = await TauriClient.saveAuditEntries(
                                "json",
                                auditExportFolderPreset,
                                auditExportCustomPath,
                                auditExportSkipDestinationConfirm,
                              );
                              toast({
                                title: t("Export complete", "Export complete"),
                                description: t("Saved to {{path}}", {
                                  path,
                                  defaultValue: `Saved to ${path}`,
                                }),
                                action: (
                                  <ToastAction
                                    altText={t("Open export folder", "Open export folder")}
                                    onClick={() => {
                                      void TauriClient.openPathInFileManager(path).catch(
                                        (error) => {
                                          toast({
                                            title: t("Open folder failed", "Open folder failed"),
                                            description:
                                              error instanceof Error
                                                ? error.message
                                                : String(error),
                                            variant: "destructive",
                                          });
                                        },
                                      );
                                    }}
                                  >
                                    {t("Open folder", "Open folder")}
                                  </ToastAction>
                                ),
                              });
                            } catch (error) {
                              const message =
                                error instanceof Error ? error.message : String(error);
                              if (message.toLowerCase().includes("cancel")) return;
                              toast({
                                title: t("Export failed", "Export failed"),
                                description: message,
                                variant: "destructive",
                              });
                            }
                          }}
                          disabled={!isDesktop() || auditEntries.length === 0}
                          title={t("Export JSON", "Export JSON")}
                        >
                          <FileDown className="h-3.5 w-3.5" />
                          <span className="text-xs">{t("JSON", "JSON")}</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 px-2"
                          onClick={async () => {
                            if (!isDesktop()) return;
                            try {
                              const path = await TauriClient.saveAuditEntries(
                                "csv",
                                auditExportFolderPreset,
                                auditExportCustomPath,
                                auditExportSkipDestinationConfirm,
                              );
                              toast({
                                title: t("Export complete", "Export complete"),
                                description: t("Saved to {{path}}", {
                                  path,
                                  defaultValue: `Saved to ${path}`,
                                }),
                                action: (
                                  <ToastAction
                                    altText={t("Open export folder", "Open export folder")}
                                    onClick={() => {
                                      void TauriClient.openPathInFileManager(path).catch(
                                        (error) => {
                                          toast({
                                            title: t("Open folder failed", "Open folder failed"),
                                            description:
                                              error instanceof Error
                                                ? error.message
                                                : String(error),
                                            variant: "destructive",
                                          });
                                        },
                                      );
                                    }}
                                  >
                                    {t("Open folder", "Open folder")}
                                  </ToastAction>
                                ),
                              });
                            } catch (error) {
                              const message =
                                error instanceof Error ? error.message : String(error);
                              if (message.toLowerCase().includes("cancel")) return;
                              toast({
                                title: t("Export failed", "Export failed"),
                                description: message,
                                variant: "destructive",
                              });
                            }
                          }}
                          disabled={!isDesktop() || auditEntries.length === 0}
                          title={t("Export CSV", "Export CSV")}
                        >
                          <FileDown className="h-3.5 w-3.5" />
                          <span className="text-xs">{t("CSV", "CSV")}</span>
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-2 md:grid-cols-[1fr_120px_auto]">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          placeholder={t("Search audit entries", "Search audit entries")}
                          value={auditSearch}
                          onChange={(e) => setAuditSearch(e.target.value)}
                          className="h-8 pl-9 text-xs"
                        />
                      </div>
                      <Select value={auditLimit} onValueChange={setAuditLimit}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder={t("Limit", "Limit")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="50">50</SelectItem>
                          <SelectItem value="100">100</SelectItem>
                          <SelectItem value="250">250</SelectItem>
                          <SelectItem value="500">500</SelectItem>
                          <SelectItem value="1000">1000</SelectItem>
                          <SelectItem value="all">{t("All", "All")}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button size="sm" variant="outline" className="h-8 gap-1 px-2" onClick={addAuditFilter}>
                        <Plus className="h-3.5 w-3.5" />
                        <span className="text-xs">{t("Add filter", "Add filter")}</span>
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("errors")}
                      >
                        {t("Errors", "Errors")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("auth")}
                      >
                        {t("Auth Ops", "Auth Ops")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("dns")}
                      >
                        {t("DNS Ops", "DNS Ops")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("api_keys")}
                      >
                        {t("API Keys", "API Keys")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("zone_settings")}
                      >
                        {t("Zone Settings", "Zone Settings")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("cache")}
                      >
                        {t("Cache Ops", "Cache Ops")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("last24h")}
                      >
                        {t("Last 24h", "Last 24h")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("last7d")}
                      >
                        {t("Last 7d", "Last 7d")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("today")}
                      >
                        {t("Today", "Today")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("clear")}
                      >
                        {t("Clear Filters", "Clear Filters")}
                      </Button>
                    </div>
                    {auditFilters.length > 0 && (
                      <div className="space-y-2 rounded-lg border border-border/60 bg-card/50 p-2">
                        {auditFilters.map((rule) => (
                          <div key={rule.id} className="grid gap-2 md:grid-cols-[140px_130px_1fr_auto]">
                            <Select
                              value={rule.field}
                              onValueChange={(v) =>
                                updateAuditFilter(rule.id, { field: v as AuditFilterField })
                              }
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue placeholder={t("Field", "Field")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="operation">{t("Operation", "Operation")}</SelectItem>
                                <SelectItem value="resource">{t("Resource", "Resource")}</SelectItem>
                                <SelectItem value="timestamp">{t("Timestamp", "Timestamp")}</SelectItem>
                                <SelectItem value="details">{t("Details", "Details")}</SelectItem>
                              </SelectContent>
                            </Select>
                            <Select
                              value={rule.operator}
                              onValueChange={(v) =>
                                updateAuditFilter(rule.id, {
                                  operator: v as AuditFilterOperator,
                                })
                              }
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue placeholder={t("Operator", "Operator")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="equals">{t("equals", "equals")}</SelectItem>
                                <SelectItem value="not_equals">{t("not equals", "not equals")}</SelectItem>
                                <SelectItem value="contains">{t("contains", "contains")}</SelectItem>
                                <SelectItem value="not_contains">{t("not contains", "not contains")}</SelectItem>
                                <SelectItem value="starts_with">{t("starts with", "starts with")}</SelectItem>
                                <SelectItem value="ends_with">{t("ends with", "ends with")}</SelectItem>
                                <SelectItem value="matches">{t("matches (regex)", "matches (regex)")}</SelectItem>
                                <SelectItem value="gt">{t("greater than (&gt;)", "greater than (&gt;)")}</SelectItem>
                                <SelectItem value="gte">{t("greater/equal (&gt;=)", "greater/equal (&gt;=)")}</SelectItem>
                                <SelectItem value="lt">{t("less than (&lt;)", "less than (&lt;)")}</SelectItem>
                                <SelectItem value="lte">{t("less/equal (&lt;=)", "less/equal (&lt;=)")}</SelectItem>
                              </SelectContent>
                            </Select>
                            <Input
                              value={rule.value}
                              onChange={(e) =>
                                updateAuditFilter(rule.id, { value: e.target.value })
                              }
                              className="h-8 text-xs"
                              placeholder={t("Value", "Value")}
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 px-2"
                              onClick={() => removeAuditFilter(rule.id)}
                              title={t("Remove filter", "Remove filter")}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                        <div className="text-[11px] text-muted-foreground">
                          {t(
                            "For timestamp comparisons, use ISO date/time values (example: {{value}}).",
                            {
                              value: "2026-02-06T12:00:00Z",
                              defaultValue:
                                "For timestamp comparisons, use ISO date/time values (example: 2026-02-06T12:00:00Z).",
                            },
                          )}
                        </div>
                      </div>
                    )}
                    {!isDesktop() && (
                      <div className="text-xs text-muted-foreground">
                        {t(
                          "Audit log is only available in the desktop app.",
                          "Audit log is only available in the desktop app.",
                        )}
                      </div>
                    )}
                    {auditLoading && (
                      <div className="text-sm text-muted-foreground">
                        {t("Loading audit entries…", "Loading audit entries…")}
                      </div>
                    )}
                    {auditError && (
                      <div className="text-sm text-destructive">{auditError}</div>
                    )}
                    {!auditLoading && !auditError && limitedAuditEntries.length === 0 && (
                      <div className="text-sm text-muted-foreground">
                        {t(
                          "No audit entries match the current filters.",
                          "No audit entries match the current filters.",
                        )}
                      </div>
                    )}
                    {!auditLoading && !auditError && limitedAuditEntries.length > 0 && (
                      <div className="overflow-auto rounded-lg border border-border/60">
                      <div className="grid grid-cols-[220px_160px_1fr_80px] gap-3 border-b border-border/60 bg-muted/50 px-4 py-2 text-[11px] uppercase tracking-widest text-muted-foreground">
                          <button
                            type="button"
                            className="flex items-center gap-1 text-left hover:text-foreground"
                            onClick={() => toggleAuditSort("timestamp")}
                          >
                            {t("Timestamp", "Timestamp")}
                            <ArrowUpDown className="h-3 w-3" />
                            <span className="text-[10px]">
                              {auditSort.field === "timestamp"
                                ? auditSort.dir === "asc"
                                  ? t("ASC", "ASC")
                                  : t("DESC", "DESC")
                                : ""}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="flex items-center gap-1 text-left hover:text-foreground"
                            onClick={() => toggleAuditSort("operation")}
                          >
                            {t("Operation", "Operation")}
                            <ArrowUpDown className="h-3 w-3" />
                            <span className="text-[10px]">
                              {auditSort.field === "operation"
                                ? auditSort.dir === "asc"
                                  ? t("ASC", "ASC")
                                  : t("DESC", "DESC")
                                : ""}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="flex items-center gap-1 text-left hover:text-foreground"
                            onClick={() => toggleAuditSort("resource")}
                          >
                            {t("Resource", "Resource")}
                            <ArrowUpDown className="h-3 w-3" />
                            <span className="text-[10px]">
                              {auditSort.field === "resource"
                                ? auditSort.dir === "asc"
                                  ? t("ASC", "ASC")
                                  : t("DESC", "DESC")
                                : ""}
                            </span>
                          </button>
                          <div>{t("Details", "Details")}</div>
                        </div>
                        <div className="divide-y divide-white/10">
                          {limitedAuditEntries.map((entry, index) => {
                            const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "unknown";
                            const operation = typeof entry.operation === "string" ? entry.operation : "operation";
                            const resource = typeof entry.resource === "string" ? entry.resource : "resource";
                            const timestampShort = formatAuditTimestampShort(entry.timestamp);
                            const timestampFull = formatAuditTimestampFull(entry.timestamp);
                            return (
                              <details key={`${timestamp}-${index}`} className="px-4 py-3 text-sm">
                                <summary className="grid grid-cols-[220px_160px_1fr_80px] gap-3 cursor-pointer list-none">
                                  <div className="text-xs text-muted-foreground" title={timestampFull}>
                                    {timestampShort}
                                  </div>
                                  <div className="font-medium">{operation}</div>
                                  <div className="truncate text-muted-foreground">
                                    {resource}
                                  </div>
                                  <div className="text-xs text-muted-foreground hover:text-foreground">
                                    {t("View", "View")}
                                  </div>
                                </summary>
                                <div className="mt-3 rounded-md border border-border/60 bg-card/60 p-3 text-xs text-muted-foreground">
                                  <div className="mb-2">
                                    <span className="font-medium text-foreground">{t("Full timestamp:", "Full timestamp:")}</span>{" "}
                                    {timestampFull}
                                  </div>
                                  <pre className="whitespace-pre-wrap">
                                    {JSON.stringify(entry, null, 2)}
                                  </pre>
                                </div>
                              </details>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "tags" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">{t("Tag manager", "Tag manager")}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-[180px_1fr] md:items-center">
                      <div className="font-medium">{t("Zone", "Zone")}</div>
                      <Select
                        value={tagsZoneId || undefined}
                        onValueChange={(value) => {
                          setTagsZoneId(value);
                          setRenameTagFrom(null);
                          setRenameTagTo("");
                        }}
                      >
                        <SelectTrigger className="w-72">
                          <SelectValue placeholder={t("Select a zone", "Select a zone")} />
                        </SelectTrigger>
                        <SelectContent className="bg-popover/70 text-foreground">
                          {availableZones.map((zone: Zone) => (
                            <SelectItem key={zone.id} value={zone.id} className="cursor-pointer">
                              {zone.name} ({zone.status})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {!tagsZoneId ? (
                      <div className="text-sm text-muted-foreground">
                        {t(
                          "Select a zone to manage its tags.",
                          "Select a zone to manage its tags.",
                        )}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            value={newTag}
                            onChange={(e) => setNewTag(e.target.value)}
                            placeholder={t("New tag", "New tag")}
                            className="h-9 w-56"
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              e.preventDefault();
                              const next = newTag.trim();
                              if (!next) return;
                              storageManager.addZoneTag(tagsZoneId, next);
                              notifySaved(
                                t("Tag added: {{tag}}", {
                                  tag: next,
                                  defaultValue: `Tag added: ${next}`,
                                }),
                              );
                              setNewTag("");
                            }}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const next = newTag.trim();
                              if (!next) return;
                              storageManager.addZoneTag(tagsZoneId, next);
                              notifySaved(
                                t("Tag added: {{tag}}", {
                                  tag: next,
                                  defaultValue: `Tag added: ${next}`,
                                }),
                              );
                              setNewTag("");
                            }}
                          >
                            {t("Add tag", "Add tag")}
                          </Button>
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "Tags are local-only and can be attached to records.",
                              "Tags are local-only and can be attached to records.",
                            )}
                          </div>
                        </div>

                        <div className="glass-surface glass-sheen glass-fade rounded-xl overflow-hidden">
                          <div className="grid grid-cols-[1fr_90px_1fr_160px] gap-2 px-3 py-2 text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border/60">
                            <div>{t("Tag", "Tag")}</div>
                            <div className="text-right">{t("Used", "Used")}</div>
                            <div>{t("Linked records", "Linked records")}</div>
                            <div className="text-right">{t("Actions", "Actions")}</div>
                          </div>
                          {zoneTags.length === 0 ? (
                            <div className="px-3 py-6 text-sm text-muted-foreground">
                              {t(
                                "No tags yet. Add one above or create tags from a record's expanded panel.",
                                "No tags yet. Add one above or create tags from a record's expanded panel.",
                              )}
                            </div>
                          ) : (
                            <div className="divide-y divide-white/10">
                              {zoneTags.map((tag) => {
                                const linkedRecords = tagManagerRecordsByTag[tag] ?? [];
                                const preview = linkedRecords.slice(0, 2);
                                const remaining = Math.max(0, linkedRecords.length - preview.length);
                                return (
                                  <div
                                    key={tag}
                                    className="grid grid-cols-[1fr_90px_1fr_160px] items-center gap-2 px-3 py-2"
                                  >
                                    <div className="min-w-0">
                                      {renameTagFrom === tag ? (
                                        <Input
                                          value={renameTagTo}
                                          onChange={(e) => setRenameTagTo(e.target.value)}
                                          className="h-8"
                                          autoFocus
                                          onKeyDown={(e) => {
                                            if (e.key !== "Enter") return;
                                            e.preventDefault();
                                            const next = renameTagTo.trim();
                                            if (!next) return;
                                            storageManager.renameTag(tagsZoneId, tag, next);
                                            notifySaved(
                                              t("Tag renamed: {{from}} -> {{to}}", {
                                                from: tag,
                                                to: next,
                                                defaultValue: `Tag renamed: ${tag} -> ${next}`,
                                              }),
                                            );
                                            setRenameTagFrom(null);
                                            setRenameTagTo("");
                                          }}
                                        />
                                      ) : (
                                        <Tag className="text-[9px] px-2 py-0.5">{tag}</Tag>
                                      )}
                                    </div>
                                    <div className="text-right text-sm text-muted-foreground">
                                      {tagCounts[tag] ?? 0}
                                    </div>
                                    <div className="min-w-0 text-xs text-muted-foreground">
                                      {preview.length ? (
                                        <>
                                          {preview.map((record) => (
                                            <span key={record.id} className="mr-2 inline-block truncate max-w-[180px]">
                                              {record.name} ({record.type})
                                            </span>
                                          ))}
                                          {remaining > 0 && (
                                            <span>
                                              +{t("{{count}} more", {
                                                count: remaining,
                                                defaultValue: `${remaining} more`,
                                              })}
                                            </span>
                                          )}
                                        </>
                                      ) : (
                                        <span>{t("Not linked", "Not linked")}</span>
                                      )}
                                    </div>
                                    <div className="flex justify-end gap-2">
                                      {renameTagFrom === tag ? (
                                        <>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-8"
                                            onClick={() => {
                                              const next = renameTagTo.trim();
                                              if (!next) return;
                                              storageManager.renameTag(tagsZoneId, tag, next);
                                              notifySaved(
                                                t("Tag renamed: {{from}} -> {{to}}", {
                                                  from: tag,
                                                  to: next,
                                                  defaultValue: `Tag renamed: ${tag} -> ${next}`,
                                                }),
                                              );
                                              setRenameTagFrom(null);
                                              setRenameTagTo("");
                                            }}
                                          >
                                            {t("Save", "Save")}
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-8"
                                            onClick={() => {
                                              setRenameTagFrom(null);
                                              setRenameTagTo("");
                                            }}
                                          >
                                            {t("Cancel", "Cancel")}
                                          </Button>
                                        </>
                                      ) : (
                                        <>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-8"
                                            onClick={() => {
                                              setRenameTagFrom(tag);
                                              setRenameTagTo(tag);
                                            }}
                                          >
                                            {t("Rename", "Rename")}
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="destructive"
                                            className="h-8"
                                            onClick={() => {
                                              storageManager.deleteTag(tagsZoneId, tag);
                                              notifySaved(
                                                t("Tag deleted: {{tag}}", {
                                                  tag,
                                                  defaultValue: `Tag deleted: ${tag}`,
                                                }),
                                              );
                                            }}
                                          >
                                            {t("Delete", "Delete")}
                                          </Button>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <div className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-medium">
                              {t("Record associations", "Record associations")}
                            </div>
                            <div className="flex items-center gap-2">
                              <Input
                                value={tagAssociationSearch}
                                onChange={(e) => setTagAssociationSearch(e.target.value)}
                                placeholder={t("Search records or tags", "Search records or tags")}
                                className="h-8 w-64"
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8"
                                onClick={() => void loadTagManagerRecords(tagsZoneId)}
                                disabled={tagManagerRecordsLoading}
                              >
                                {t("Refresh", "Refresh")}
                              </Button>
                            </div>
                          </div>
                          {tagManagerRecordsLoading ? (
                            <div className="text-sm text-muted-foreground">
                              {t("Loading records...", "Loading records...")}
                            </div>
                          ) : tagManagerRecordsError ? (
                            <div className="text-sm text-destructive">
                              {t("Failed to load records: {{error}}", {
                                error: tagManagerRecordsError,
                                defaultValue: `Failed to load records: ${tagManagerRecordsError}`,
                              })}
                            </div>
                          ) : filteredTagManagerRecords.length === 0 ? (
                            <div className="text-sm text-muted-foreground">
                              {t("No records found for this zone.", "No records found for this zone.")}
                            </div>
                          ) : (
                            <div className="divide-y divide-white/10 rounded-lg border border-border/50 bg-card/40">
                              {visibleTagManagerRecords.map((record) => {
                                const recordTags = storageManager.getRecordTags(tagsZoneId, record.id);
                                const draftTag = tagAssociationDrafts[record.id] ?? "";
                                const listId = `tag-association-options-${record.id}`;
                                return (
                                  <div
                                    key={record.id}
                                    className="grid gap-3 px-3 py-3 md:grid-cols-[1.2fr_1.6fr_1fr]"
                                  >
                                    <div className="min-w-0">
                                      <div className="truncate text-sm font-medium">{record.name}</div>
                                      <div className="truncate text-xs text-muted-foreground">
                                        {record.type} | {record.content}
                                      </div>
                                    </div>
                                    <div className="flex min-w-0 flex-wrap items-center gap-1">
                                      {recordTags.length ? (
                                        recordTags.map((tag) => (
                                          <span key={tag} className="inline-flex items-center gap-1">
                                            <Tag className="text-[9px] px-2 py-0.5">{tag}</Tag>
                                            <button
                                              type="button"
                                              className="ui-icon-button h-5 w-5"
                                              aria-label={t("Remove tag {{tag}}", {
                                                tag,
                                                defaultValue: `Remove tag ${tag}`,
                                              })}
                                              onClick={() => detachTagFromRecord(record.id, tag)}
                                            >
                                              <X className="h-3 w-3" />
                                            </button>
                                          </span>
                                        ))
                                      ) : (
                                        <span className="text-xs text-muted-foreground">
                                          {t("No tags", "No tags")}
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <Input
                                        list={listId}
                                        value={draftTag}
                                        onChange={(e) =>
                                          setTagAssociationDrafts((prev) => ({
                                            ...prev,
                                            [record.id]: e.target.value,
                                          }))
                                        }
                                        onKeyDown={(e) => {
                                          if (e.key !== "Enter") return;
                                          e.preventDefault();
                                          attachTagToRecord(record.id, draftTag);
                                          setTagAssociationDrafts((prev) => ({
                                            ...prev,
                                            [record.id]: "",
                                          }));
                                        }}
                                        placeholder={t("Attach tag", "Attach tag")}
                                        className="h-8"
                                      />
                                      <datalist id={listId}>
                                        {zoneTags.map((tag) => (
                                          <option key={tag} value={tag} />
                                        ))}
                                      </datalist>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-8"
                                        onClick={() => {
                                          attachTagToRecord(record.id, draftTag);
                                          setTagAssociationDrafts((prev) => ({
                                            ...prev,
                                            [record.id]: "",
                                          }));
                                        }}
                                      >
                                        {t("Attach", "Attach")}
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {filteredTagManagerRecords.length > visibleTagManagerRecords.length && (
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Showing first {{count}} records. Refine search to narrow the list.",
                                {
                                  count: visibleTagManagerRecords.length,
                                  defaultValue: `Showing first ${visibleTagManagerRecords.length} records. Refine search to narrow the list.`,
                                },
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "registry" && (
                <RegistryMonitor monitor={registrarMonitor} />
              )}
              {activeTab.kind === "settings" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      {t("Session settings", "Session settings")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="glass-surface glass-sheen glass-fade ui-segment-group">
                      <button
                        onClick={() => setSettingsSubtab("general")}
                        data-active={settingsSubtab === "general"}
                        className="ui-segment"
                      >
                        {t("General", "General")}
                      </button>
                      <button
                        onClick={() => setSettingsSubtab("topology")}
                        data-active={settingsSubtab === "topology"}
                        className="ui-segment"
                      >
                        {t("Topology", "Topology")}
                      </button>
                      <button
                        onClick={() => setSettingsSubtab("audit")}
                        data-active={settingsSubtab === "audit"}
                        className="ui-segment"
                      >
                        {t("Audit", "Audit")}
                      </button>
                      <button
                        onClick={() => setSettingsSubtab("profiles")}
                        data-active={settingsSubtab === "profiles"}
                        className="ui-segment"
                      >
                        {t("Profiles", "Profiles")}
                      </button>
                    </div>
                    {settingsSubtab === "general" && (
                    <div className="divide-y divide-white/10 rounded-xl border border-border/60 bg-card/60 text-sm">
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">{t("Auto refresh", "Auto refresh")}</div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Select
                            value={String(autoRefreshInterval ?? 0)}
                            onValueChange={(v) => {
                              const next = v ? Number(v) : 0;
                              setAutoRefreshInterval(next ? next : null);
                              notifySaved(
                                next
                                  ? t("Auto refresh set to {{seconds}}s.", {
                                      seconds: next / 1000,
                                      defaultValue: `Auto refresh set to ${next / 1000}s.`,
                                    })
                                  : t("Auto refresh off.", "Auto refresh off."),
                              );
                            }}
                          >
                            <SelectTrigger className="w-44">
                              <SelectValue placeholder={t("Auto-refresh", "Auto-refresh")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="0">{t("Off", "Off")}</SelectItem>
                              <SelectItem value="60000">{t("1 min", "1 min")}</SelectItem>
                              <SelectItem value="300000">{t("5 min", "5 min")}</SelectItem>
                              <SelectItem value="600000">{t("10 min", "10 min")}</SelectItem>
                              <SelectItem value="1800000">{t("30 min", "30 min")}</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "Pauses while editing records or dialogs are open.",
                              "Pauses while editing records or dialogs are open.",
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">{t("Default per-page", "Default per-page")}</div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Select
                            value={String(globalPerPage)}
                            onValueChange={(v) => {
                              const value = Number(v);
                              const next = Number.isNaN(value) ? 50 : value;
                              setGlobalPerPage(next);
                              notifySaved(
                                t("Default per-page set to {{count}}.", {
                                  count: next,
                                  defaultValue: `Default per-page set to ${next}.`,
                                }),
                              );
                            }}
                          >
                            <SelectTrigger className="w-44">
                              <SelectValue placeholder={t("Per page", "Per page")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="25">25</SelectItem>
                              <SelectItem value="50">50</SelectItem>
                              <SelectItem value="100">100</SelectItem>
                              <SelectItem value="200">200</SelectItem>
                              <SelectItem value="500">500</SelectItem>
                              <SelectItem value="0">{t("All", "All")}</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "New zone tabs inherit this value unless overridden.",
                              "New zone tabs inherit this value unless overridden.",
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">{t("Loader timeout", "Loader timeout")}</div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Select
                            value={String(Math.round(loadingOverlayTimeoutMs / 1000))}
                            onValueChange={(v) => {
                              const sec = Number(v);
                              const clampedSec = Math.max(1, Math.min(60, Number.isNaN(sec) ? 60 : sec));
                              setLoadingOverlayTimeoutMs(clampedSec * 1000);
                              notifySaved(
                                t("Loader timeout set to {{seconds}}s.", {
                                  seconds: clampedSec,
                                  defaultValue: `Loader timeout set to ${clampedSec}s.`,
                                }),
                              );
                            }}
                          >
                            <SelectTrigger className="w-44">
                              <SelectValue placeholder={t("Timeout", "Timeout")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="5">{t("5 s", "5 s")}</SelectItem>
                              <SelectItem value="10">{t("10 s", "10 s")}</SelectItem>
                              <SelectItem value="20">{t("20 s", "20 s")}</SelectItem>
                              <SelectItem value="30">{t("30 s", "30 s")}</SelectItem>
                              <SelectItem value="45">{t("45 s", "45 s")}</SelectItem>
                              <SelectItem value="60">{t("60 s", "60 s")}</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "Max 60s. Loading overlay auto-hides after timeout.",
                              "Max 60s. Loading overlay auto-hides after timeout.",
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">
                          {t("Unsupported record types", "Unsupported record types")}
                        </div>
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={showUnsupportedRecordTypes}
                            onCheckedChange={(checked: boolean) => {
                              setShowUnsupportedRecordTypes(checked);
                              notifySaved(
                                checked
                                  ? t(
                                      "Unsupported record types will show in Add Record.",
                                      "Unsupported record types will show in Add Record.",
                                    )
                                  : t(
                                      "Add Record will show Cloudflare-supported types only.",
                                      "Add Record will show Cloudflare-supported types only.",
                                    ),
                              );
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "Controls the Type dropdown default. Zones can override this.",
                              "Controls the Type dropdown default. Zones can override this.",
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">{t("Reopen last tabs", "Reopen last tabs")}</div>
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={reopenLastTabs}
                            onCheckedChange={(checked: boolean) => {
                              setReopenLastTabs(checked);
                              notifySaved(
                                checked
                                  ? t("Will reopen last tabs on launch.", "Will reopen last tabs on launch.")
                                  : t(
                                      "Will not reopen last tabs on launch.",
                                      "Will not reopen last tabs on launch.",
                                    ),
                              );
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "Restore tabs from the last session on launch.",
                              "Restore tabs from the last session on launch.",
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">{t("Confirm logout", "Confirm logout")}</div>
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={confirmLogout}
                            onCheckedChange={(checked: boolean) => {
                              setConfirmLogout(checked);
                              notifySaved(
                                checked
                                  ? t("Logout confirmation enabled.", "Logout confirmation enabled.")
                                  : t("Logout confirmation disabled.", "Logout confirmation disabled."),
                              );
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "Show a confirmation dialog when logging out.",
                              "Show a confirmation dialog when logging out.",
                            )}
                          </div>
                        </div>
                      </div>
                      {isDesktop() && (
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">{t("Confirm window close", "Confirm window close")}</div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={confirmWindowClose}
                              onCheckedChange={(checked: boolean) => {
                                setConfirmWindowClose(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Window close confirmation enabled.",
                                        "Window close confirmation enabled.",
                                      )
                                    : t(
                                        "Window close confirmation disabled.",
                                        "Window close confirmation disabled.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Show a confirmation dialog when closing the app window.",
                                "Show a confirmation dialog when closing the app window.",
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">{t("Auto logout (idle)", "Auto logout (idle)")}</div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Select
                            value={String(idleLogoutMs ?? 0)}
                            onValueChange={(v) => {
                              const next = Number(v);
                              setIdleLogoutMs(next ? next : null);
                              notifySaved(
                                next
                                  ? t("Auto logout after {{minutes}} min idle.", {
                                      minutes: Math.round(next / 60000),
                                      defaultValue: `Auto logout after ${Math.round(next / 60000)} min idle.`,
                                    })
                                  : t("Auto logout disabled.", "Auto logout disabled."),
                              );
                            }}
                          >
                            <SelectTrigger className="w-44">
                              <SelectValue placeholder={t("Idle timeout", "Idle timeout")} />
                            </SelectTrigger>
                            <SelectContent className="bg-popover/70 text-foreground">
                              <SelectItem value="0">{t("Never", "Never")}</SelectItem>
                              <SelectItem value="60000">{t("1 min", "1 min")}</SelectItem>
                              <SelectItem value="120000">{t("2 min", "2 min")}</SelectItem>
                              <SelectItem value="300000">{t("5 min", "5 min")}</SelectItem>
                              <SelectItem value="600000">{t("10 min", "10 min")}</SelectItem>
                              <SelectItem value="1800000">{t("30 min", "30 min")}</SelectItem>
                              <SelectItem value="3600000">{t("1 hour", "1 hour")}</SelectItem>
                              <SelectItem value="14400000">{t("4 hours", "4 hours")}</SelectItem>
                              <SelectItem value="86400000">{t("24 hours", "24 hours")}</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "Logs out automatically after inactivity.",
                              "Logs out automatically after inactivity.",
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    )}
                    {settingsSubtab === "topology" && (
                      <div className="divide-y divide-white/10 rounded-xl border border-border/60 bg-card/60 text-sm">
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Topology resolution hops", "Topology resolution hops")}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={String(topologyResolutionMaxHops)}
                              onValueChange={(v) => {
                                const next = Number(v);
                                const clamped = Math.max(1, Math.min(15, Number.isNaN(next) ? 15 : next));
                                setTopologyResolutionMaxHops(clamped);
                                notifySaved(
                                  t("Topology CNAME resolution hops set to {{count}}.", {
                                    count: clamped,
                                    defaultValue: `Topology CNAME resolution hops set to ${clamped}.`,
                                  }),
                                );
                              }}
                            >
                              <SelectTrigger className="w-44">
                                <SelectValue placeholder={t("Max hops", "Max hops")} />
                              </SelectTrigger>
                              <SelectContent>
                                {Array.from({ length: 15 }).map((_, idx) => {
                                  const value = idx + 1;
                                  return (
                                    <SelectItem key={value} value={String(value)}>
                                      {value}
                                    </SelectItem>
                                  );
                                })}
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Max recursive hostname resolution depth for topology (1-15).",
                                "Max recursive hostname resolution depth for topology (1-15).",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Topology request mode", "Topology request mode")}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={topologyResolverMode}
                              onValueChange={(v) => {
                                const next: TopologyResolverMode = v === "doh" ? "doh" : "dns";
                                setTopologyResolverMode(next);
                                notifySaved(
                                  next === "doh"
                                    ? t(
                                        "Topology mode set to DoH requests.",
                                        "Topology mode set to DoH requests.",
                                      )
                                    : t(
                                        "Topology mode set to standard DNS requests.",
                                        "Topology mode set to standard DNS requests.",
                                      ),
                                );
                              }}
                            >
                              <SelectTrigger className="w-44">
                                <SelectValue placeholder={t("Mode", "Mode")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="dns">{t("DNS (UDP/TCP)", "DNS (UDP/TCP)")}</SelectItem>
                                <SelectItem value="doh">
                                  {t("DNS-over-HTTPS (DoH)", "DNS-over-HTTPS (DoH)")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Choose whether topology resolves via normal DNS or DoH.",
                                "Choose whether topology resolves via normal DNS or DoH.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">{t("DNS server", "DNS server")}</div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={topologyDnsServer.trim()}
                              onValueChange={(v) => {
                                setTopologyDnsServer(v);
                                notifySaved(
                                  t("Topology DNS server set to {{server}}.", {
                                    server: v,
                                    defaultValue: `Topology DNS server set to ${v}.`,
                                  }),
                                );
                              }}
                            >
                              <SelectTrigger className="w-52">
                                <SelectValue placeholder={t("DNS server", "DNS server")}>
                                  {t(
                                    TOPOLOGY_DNS_SERVER_LABELS[topologyDnsServer.trim()] ?? topologyDnsServer.trim(),
                                    TOPOLOGY_DNS_SERVER_LABELS[topologyDnsServer.trim()] ?? topologyDnsServer.trim(),
                                  )}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent className="w-[var(--radix-select-trigger-width)]">
                                <SelectItem value="1.1.1.1">{t("1.1.1.1 (Cloudflare default)", "1.1.1.1 (Cloudflare default)")}</SelectItem>
                                <SelectItem value="1.0.0.1">{t("1.0.0.1 (Cloudflare)", "1.0.0.1 (Cloudflare)")}</SelectItem>
                                <SelectItem value="8.8.8.8">{t("8.8.8.8 (Google)", "8.8.8.8 (Google)")}</SelectItem>
                                <SelectItem value="8.8.4.4">{t("8.8.4.4 (Google)", "8.8.4.4 (Google)")}</SelectItem>
                                <SelectItem value="9.9.9.9">{t("9.9.9.9 (Quad9)", "9.9.9.9 (Quad9)")}</SelectItem>
                                <SelectItem value="149.112.112.112">{t("149.112.112.112 (Quad9)", "149.112.112.112 (Quad9)")}</SelectItem>
                                <SelectItem value="208.67.222.222">{t("208.67.222.222 (OpenDNS)", "208.67.222.222 (OpenDNS)")}</SelectItem>
                                <SelectItem value="208.67.220.220">{t("208.67.220.220 (OpenDNS)", "208.67.220.220 (OpenDNS)")}</SelectItem>
                                <SelectItem value="94.140.14.14">{t("94.140.14.14 (AdGuard)", "94.140.14.14 (AdGuard)")}</SelectItem>
                                <SelectItem value="76.76.2.0">{t("76.76.2.0 (Control D)", "76.76.2.0 (Control D)")}</SelectItem>
                                <SelectItem value="custom">{t("Custom", "Custom")}</SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Common resolvers list. Default is 1.1.1.1.",
                                "Common resolvers list. Default is 1.1.1.1.",
                              )}
                            </div>
                          </div>
                        </div>
                        {topologyDnsServer === "custom" && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">{t("Custom DNS server", "Custom DNS server")}</div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Input
                                value={topologyCustomDnsServer}
                                onChange={(event) => setTopologyCustomDnsServer(event.target.value)}
                                onBlur={() => {
                                  setTopologyCustomDnsServer((prev) => prev.trim());
                                  notifySaved(t("Custom DNS server updated.", "Custom DNS server updated."));
                                }}
                                className="min-w-[320px]"
                                placeholder={t("e.g. 192.168.1.1", "e.g. 192.168.1.1")}
                              />
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "IP address used when DNS server is set to Custom.",
                                  "IP address used when DNS server is set to Custom.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {topologyResolverMode === "doh" && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">{t("Custom DoH endpoint", "Custom DoH endpoint")}</div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Input
                                value={topologyDohCustomUrl}
                                onChange={(event) => setTopologyDohCustomUrl(event.target.value)}
                                onBlur={() => {
                                  setTopologyDohCustomUrl((prev) => prev.trim());
                                  notifySaved(t("Custom DoH endpoint updated.", "Custom DoH endpoint updated."));
                                }}
                                className="min-w-[320px]"
                                placeholder={t(
                                  "https://dns.google/resolve or https://your-doh.example/dns-query",
                                  "https://dns.google/resolve or https://your-doh.example/dns-query",
                                )}
                              />
                              <div className="text-xs text-muted-foreground">
                                {t("Optional override for DoH mode.", "Optional override for DoH mode.")}
                              </div>
                            </div>
                          </div>
                        )}
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">{t("Lookup timeout", "Lookup timeout")}</div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={String(topologyLookupTimeoutMs)}
                              onValueChange={(v) => {
                                const next = Number(v);
                                const clamped = Math.max(250, Math.min(10000, Number.isNaN(next) ? 1200 : next));
                                setTopologyLookupTimeoutMs(clamped);
                                notifySaved(
                                  t("Topology lookup timeout set to {{ms}}ms.", {
                                    ms: clamped,
                                    defaultValue: `Topology lookup timeout set to ${clamped}ms.`,
                                  }),
                                );
                              }}
                            >
                              <SelectTrigger className="w-44">
                                <SelectValue placeholder={t("Timeout", "Timeout")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="250">{t("250 ms", "250 ms")}</SelectItem>
                                <SelectItem value="500">{t("500 ms", "500 ms")}</SelectItem>
                                <SelectItem value="800">{t("800 ms", "800 ms")}</SelectItem>
                                <SelectItem value="1200">{t("1200 ms", "1200 ms")}</SelectItem>
                                <SelectItem value="2000">{t("2000 ms", "2000 ms")}</SelectItem>
                                <SelectItem value="3000">{t("3000 ms", "3000 ms")}</SelectItem>
                                <SelectItem value="5000">{t("5000 ms", "5000 ms")}</SelectItem>
                                <SelectItem value="8000">{t("8000 ms", "8000 ms")}</SelectItem>
                                <SelectItem value="10000">{t("10000 ms", "10000 ms")}</SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Per DNS/DoH lookup timeout for topology chain resolution.",
                                "Per DNS/DoH lookup timeout for topology chain resolution.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Disable end-node PTR lookups", "Disable end-node PTR lookups")}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={topologyDisablePtrLookups}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyDisablePtrLookups(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "PTR lookups disabled for topology end nodes.",
                                        "PTR lookups disabled for topology end nodes.",
                                      )
                                    : t(
                                        "PTR lookups enabled for topology end nodes.",
                                        "PTR lookups enabled for topology end nodes.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Skip reverse DNS lookups to speed up topology loading.",
                                "Skip reverse DNS lookups to speed up topology loading.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Don't scan resolution chain", "Don't scan resolution chain")}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={!topologyScanResolutionChain}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyScanResolutionChain(!checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Topology will skip recursive CNAME chain scanning.",
                                        "Topology will skip recursive CNAME chain scanning.",
                                      )
                                    : t(
                                        "Topology will scan full recursive CNAME chains.",
                                        "Topology will scan full recursive CNAME chains.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Faster lookups, but omits intermediate chain hops.",
                                "Faster lookups, but omits intermediate chain hops.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">{t("Disable GEO detection", "Disable GEO detection")}</div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={topologyDisableGeoLookups}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyDisableGeoLookups(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "IP GEO detection disabled for topology.",
                                        "IP GEO detection disabled for topology.",
                                      )
                                    : t(
                                        "IP GEO detection enabled for topology.",
                                        "IP GEO detection enabled for topology.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Turns off country enrichment for resolved IP nodes.",
                                "Turns off country enrichment for resolved IP nodes.",
                              )}
                            </div>
                          </div>
                        </div>
                        {!topologyDisableGeoLookups && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">{t("GEO lookup service", "GEO lookup service")}</div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Select
                                value={topologyGeoProvider}
                                onValueChange={(v) => {
                                  const next = (v as TopologyGeoProvider) || "auto";
                                  setTopologyGeoProvider(next);
                                  notifySaved(
                                    t("Topology GEO provider set to {{provider}}.", {
                                      provider: next,
                                      defaultValue: `Topology GEO provider set to ${next}.`,
                                    }),
                                  );
                                }}
                              >
                                <SelectTrigger className="w-56">
                                <SelectValue placeholder={t("GEO provider", "GEO provider")}>
                                    {t(
                                      TOPOLOGY_GEO_PROVIDER_LABELS[topologyGeoProvider],
                                      TOPOLOGY_GEO_PROVIDER_LABELS[topologyGeoProvider],
                                    )}
                                </SelectValue>
                                </SelectTrigger>
                                <SelectContent className="w-[var(--radix-select-trigger-width)]">
                                  <SelectItem value="auto">
                                    {t("Auto (multi-provider fallback)", "Auto (multi-provider fallback)")}
                                  </SelectItem>
                                  <SelectItem value="ipwhois">ipwho.is</SelectItem>
                                  <SelectItem value="ipapi_co">ipapi.co</SelectItem>
                                  <SelectItem value="ip_api">ip-api.com</SelectItem>
                                  <SelectItem value="internal">
                                    {t(
                                      "Internal only (private/reserved IPs)",
                                      "Internal only (private/reserved IPs)",
                                    )}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Chooses GEO source; Auto tries multiple services and falls back.",
                                  "Chooses GEO source; Auto tries multiple services and falls back.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Disable service discovery", "Disable service discovery")}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={topologyDisableServiceDiscovery}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyDisableServiceDiscovery(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Topology service discovery disabled.",
                                        "Topology service discovery disabled.",
                                      )
                                    : t(
                                        "Topology service discovery enabled.",
                                        "Topology service discovery enabled.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Disables manual service probing in topology tab.",
                                "Disables manual service probing in topology tab.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">{t("TCP services to probe", "TCP services to probe")}</div>
                          <div className="flex flex-wrap items-center gap-3">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="outline" className="h-8 px-2">
                                  {t("{{count}} selected", {
                                    count: topologyTcpServices.length,
                                    defaultValue: `${topologyTcpServices.length} selected`,
                                  })}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent className="max-h-72 w-60 overflow-auto">
                                {TOPOLOGY_TCP_SERVICE_OPTIONS.map((opt) => {
                                  const value = String(opt.port);
                                  const checked = topologyTcpServices.includes(value);
                                  return (
                                    <DropdownMenuCheckboxItem
                                      key={opt.port}
                                      className="pl-6"
                                      checked={checked}
                                      onCheckedChange={(next) => {
                                        setTopologyTcpServices((prev) => {
                                          const set = new Set(prev);
                                          if (next) set.add(value);
                                          else set.delete(value);
                                          const out = Array.from(set);
                                          return out.length ? out : ["80", "443", "22"];
                                        });
                                      }}
                                      onSelect={(event) => event.preventDefault()}
                                    >
                                      {t(opt.label, opt.label)}
                                    </DropdownMenuCheckboxItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Multi-select common TCP services for simple discovery.",
                                "Multi-select common TCP services for simple discovery.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">{t("Disable annotations", "Disable annotations")}</div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={topologyDisableAnnotations}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyDisableAnnotations(checked);
                                notifySaved(
                                  checked
                                    ? t("Topology annotations disabled.", "Topology annotations disabled.")
                                    : t("Topology annotations enabled.", "Topology annotations enabled."),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Hides annotation tools in topology view.",
                                "Hides annotation tools in topology view.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">{t("Disable full window", "Disable full window")}</div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={topologyDisableFullWindow}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyDisableFullWindow(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Full-window topology mode disabled.",
                                        "Full-window topology mode disabled.",
                                      )
                                    : t(
                                        "Full-window topology mode enabled.",
                                        "Full-window topology mode enabled.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Hides full-window graph action in topology controls.",
                                "Hides full-window graph action in topology controls.",
                              )}
                            </div>
                          </div>
                        </div>
                        {isDesktop() && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">{t("Confirm path to export", "Confirm path to export")}</div>
                            <div className="flex items-center gap-3">
                              <Switch
                                checked={topologyExportConfirmPath}
                                onCheckedChange={(checked: boolean) => {
                                  setTopologyExportConfirmPath(checked);
                                  notifySaved(
                                    checked
                                      ? t(
                                          "Topology exports will ask for destination.",
                                          "Topology exports will ask for destination.",
                                        )
                                      : t(
                                          "Topology exports will save directly to default path.",
                                          "Topology exports will save directly to default path.",
                                        ),
                                  );
                                }}
                              />
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Applies to topology code/SVG/PNG export actions.",
                                  "Applies to topology code/SVG/PNG export actions.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {isDesktop() && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">{t("Topology export path", "Topology export path")}</div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Select
                                value={topologyExportFolderPreset}
                                onValueChange={(v) => {
                                  setTopologyExportFolderPreset(v as ExportFolderPreset);
                                  notifySaved(
                                    t("Topology export preset set to {{preset}}.", {
                                      preset: v,
                                      defaultValue: `Topology export preset set to ${v}.`,
                                    }),
                                  );
                                }}
                              >
                                <SelectTrigger className="w-52">
                                  <SelectValue placeholder={t("Folder preset", "Folder preset")} />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="system">{t("System default", "System default")}</SelectItem>
                                  <SelectItem value="documents">{t("Documents", "Documents")}</SelectItem>
                                  <SelectItem value="downloads">{t("Downloads", "Downloads")}</SelectItem>
                                  <SelectItem value="desktop">{t("Desktop", "Desktop")}</SelectItem>
                                  <SelectItem value="custom">{t("Custom path", "Custom path")}</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Default export location for topology assets.",
                                  "Default export location for topology assets.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {isDesktop() && topologyExportFolderPreset === "custom" && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">{t("Custom export path", "Custom export path")}</div>
                            <Input
                              value={topologyExportCustomPath}
                              onChange={(e) => setTopologyExportCustomPath(e.target.value)}
                              placeholder={t(
                                "C:\\Users\\You\\Documents\\Topology Exports",
                                "C:\\Users\\You\\Documents\\Topology Exports",
                              )}
                            />
                          </div>
                        )}
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">{t("Copy actions", "Copy actions")}</div>
                          <div className="flex flex-wrap items-center gap-3">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="outline" className="h-8 px-2">
                                  {t("{{count}} selected", {
                                    count: topologyCopyActions.length,
                                    defaultValue: `${topologyCopyActions.length} selected`,
                                  })}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent className="max-h-72 w-60 overflow-auto">
                                {TOPOLOGY_COPY_ACTION_OPTIONS.map((opt) => {
                                  const checked = topologyCopyActions.includes(opt.value);
                                  return (
                                    <DropdownMenuCheckboxItem
                                      key={opt.value}
                                      className="pl-6"
                                      checked={checked}
                                      onCheckedChange={(next) => {
                                        setTopologyCopyActions((prev) => {
                                          const set = new Set(prev);
                                          if (next) set.add(opt.value);
                                          else if (set.size > 1) set.delete(opt.value);
                                          return Array.from(set);
                                        });
                                      }}
                                      onSelect={(event) => event.preventDefault()}
                                    >
                                      {t(opt.label, opt.label)}
                                    </DropdownMenuCheckboxItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Controls which actions appear in topology Copy menu.",
                                "Controls which actions appear in topology Copy menu.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">{t("Export actions", "Export actions")}</div>
                          <div className="flex flex-wrap items-center gap-3">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="outline" className="h-8 px-2">
                                  {t("{{count}} selected", {
                                    count: topologyExportActions.length,
                                    defaultValue: `${topologyExportActions.length} selected`,
                                  })}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent className="max-h-72 w-60 overflow-auto">
                                {TOPOLOGY_EXPORT_ACTION_OPTIONS.map((opt) => {
                                  const checked = topologyExportActions.includes(opt.value);
                                  return (
                                    <DropdownMenuCheckboxItem
                                      key={opt.value}
                                      className="pl-6"
                                      checked={checked}
                                      onCheckedChange={(next) => {
                                        setTopologyExportActions((prev) => {
                                          const set = new Set(prev);
                                          if (next) set.add(opt.value);
                                          else if (set.size > 1) set.delete(opt.value);
                                          return Array.from(set);
                                        });
                                      }}
                                      onSelect={(event) => event.preventDefault()}
                                    >
                                      {t(opt.label, opt.label)}
                                    </DropdownMenuCheckboxItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Controls which actions appear in topology Export menu.",
                                "Controls which actions appear in topology Export menu.",
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    {settingsSubtab === "audit" && (
                      <div className="divide-y divide-white/10 rounded-xl border border-border/60 bg-card/60 text-sm">
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">{t("Audit categories", "Audit categories")}</div>
                          <div className="flex flex-wrap gap-4">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                className="checkbox-themed"
                                checked={domainAuditCategories.email}
                                onChange={(e) =>
                                  setDomainAuditCategories((prev) => ({
                                    ...prev,
                                    email: e.target.checked,
                                  }))
                                }
                              />
                              {t("Email", "Email")}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                className="checkbox-themed"
                                checked={domainAuditCategories.security}
                                onChange={(e) =>
                                  setDomainAuditCategories((prev) => ({
                                    ...prev,
                                    security: e.target.checked,
                                  }))
                                }
                              />
                              {t("Security", "Security")}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                className="checkbox-themed"
                                checked={domainAuditCategories.hygiene}
                                onChange={(e) =>
                                  setDomainAuditCategories((prev) => ({
                                    ...prev,
                                    hygiene: e.target.checked,
                                  }))
                                }
                              />
                              {t("Hygiene", "Hygiene")}
                            </label>
                          </div>
                        </div>
                        {isDesktop() && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">{t("Export folder preset", "Export folder preset")}</div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Select
                                value={auditExportFolderPreset}
                                onValueChange={(v) => {
                                  setAuditExportFolderPreset(v as ExportFolderPreset);
                                  notifySaved(
                                    t("Audit export preset set to {{preset}}.", {
                                      preset: v,
                                      defaultValue: `Audit export preset set to ${v}.`,
                                    }),
                                  );
                                }}
                              >
                                <SelectTrigger className="w-52">
                                  <SelectValue placeholder={t("Folder preset", "Folder preset")} />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="system">{t("System default", "System default")}</SelectItem>
                                  <SelectItem value="documents">{t("Documents", "Documents")}</SelectItem>
                                  <SelectItem value="downloads">{t("Downloads", "Downloads")}</SelectItem>
                                  <SelectItem value="desktop">{t("Desktop", "Desktop")}</SelectItem>
                                  <SelectItem value="custom">{t("Custom path", "Custom path")}</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Choose the default start folder for audit exports.",
                                  "Choose the default start folder for audit exports.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {isDesktop() && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">{t("Don't confirm destination", "Don't confirm destination")}</div>
                            <div className="flex items-center gap-3">
                              <Switch
                                checked={auditExportSkipDestinationConfirm}
                                onCheckedChange={(checked: boolean) => {
                                  setAuditExportSkipDestinationConfirm(checked);
                                  notifySaved(
                                    checked
                                      ? t(
                                          "Audit exports will save directly without destination dialog.",
                                          "Audit exports will save directly without destination dialog.",
                                        )
                                      : t(
                                          "Audit exports will ask for destination.",
                                          "Audit exports will ask for destination.",
                                        ),
                                  );
                                }}
                              />
                              <div className="text-xs text-muted-foreground">
                                {t("Enabled by default.", "Enabled by default.")}
                              </div>
                            </div>
                          </div>
                        )}
                        {isDesktop() && auditExportFolderPreset === "custom" && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">{t("Custom export path", "Custom export path")}</div>
                            <Input
                              value={auditExportCustomPath}
                              onChange={(e) => setAuditExportCustomPath(e.target.value)}
                              placeholder={t(
                                "C:\\Users\\You\\Documents\\Audit Exports",
                                "C:\\Users\\You\\Documents\\Audit Exports",
                              )}
                            />
                          </div>
                        )}
                        {isDesktop() && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">{t("Confirm clear audit logs", "Confirm clear audit logs")}</div>
                            <div className="flex items-center gap-3">
                              <Switch
                                checked={confirmClearAuditLogs}
                                onCheckedChange={(checked: boolean) => {
                                  setConfirmClearAuditLogs(checked);
                                  notifySaved(
                                    checked
                                      ? t(
                                          "Clear-audit confirmation enabled.",
                                          "Clear-audit confirmation enabled.",
                                        )
                                      : t(
                                          "Clear-audit confirmation disabled.",
                                          "Clear-audit confirmation disabled.",
                                        ),
                                  );
                                }}
                              />
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Ask before deleting all audit entries.",
                                  "Ask before deleting all audit entries.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {settingsSubtab === "profiles" && (
                      <div className="space-y-3 rounded-xl border border-border/60 bg-card/60 p-4 text-sm">
                        <div className="text-xs text-muted-foreground">
                          {t("Current session:", "Current session:")}{" "}
                          <span className="font-medium text-foreground">{currentSessionId}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={exportSessionSettings}>
                            <FileDown className="mr-2 h-4 w-4" />
                            {t("Export settings", "Export settings")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => settingsImportInputRef.current?.click()}
                          >
                            <FileUp className="mr-2 h-4 w-4" />
                            {t("Import settings", "Import settings")}
                          </Button>
                          <input
                            ref={settingsImportInputRef}
                            type="file"
                            className="hidden"
                            accept="application/json"
                            onChange={(e) => void importSessionSettings(e)}
                          />
                        </div>
                        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                          <div className="space-y-1">
                            <Label>{t("Clone from session", "Clone from session")}</Label>
                            <Select value={cloneSourceSessionId} onValueChange={setCloneSourceSessionId}>
                              <SelectTrigger>
                                <SelectValue
                                  placeholder={t("Pick saved session profile", "Pick saved session profile")}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {sessionProfileIds
                                  .filter((id) => id !== currentSessionId)
                                  .map((id) => (
                                    <SelectItem key={id} value={id}>
                                      {id}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Button
                            size="sm"
                            disabled={!cloneSourceSessionId}
                            onClick={() => void cloneSessionSettingsFrom(cloneSourceSessionId)}
                          >
                            {t("Clone", "Clone")}
                          </Button>
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Settings className="h-4 w-4" />
                      {t(
                        "Settings can be exported/imported and cloned across sessions.",
                        "Settings can be exported/imported and cloned across sessions.",
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border/60 bg-card/60">
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              {t("Select a zone to open it in a new tab.", "Select a zone to open it in a new tab.")}
            </CardContent>
          </Card>
        )}
      </div>
      <Dialog open={showClearAuditConfirm} onOpenChange={setShowClearAuditConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Clear audit logs", "Clear audit logs")}</DialogTitle>
            <DialogDescription>
              {t(
                "This deletes all audit entries stored on this device. This cannot be undone.",
                "This deletes all audit entries stored on this device. This cannot be undone.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="checkbox-themed"
              checked={!confirmClearAuditLogs}
              onChange={(e) => {
                const disable = e.target.checked;
                setConfirmClearAuditLogs(!disable);
                notifySaved(
                  disable
                    ? t(
                        "Clear-audit confirmation disabled.",
                        "Clear-audit confirmation disabled.",
                      )
                    : t("Clear-audit confirmation enabled.", "Clear-audit confirmation enabled."),
                );
              }}
            />
            {t("Don't ask again", "Don't ask again")}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowClearAuditConfirm(false)}>
              {t("Cancel", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              className="flex-1 bg-red-500/80 text-white hover:bg-red-500 hover:text-white shadow-[0_0_18px_rgba(255,80,80,0.25)] hover:shadow-[0_0_26px_rgba(255,90,90,0.45)] transition"
              onClick={async () => {
                if (!isDesktop()) return;
                await clearAuditEntriesNow();
                setShowClearAuditConfirm(false);
              }}
            >
              {t("Clear logs", "Clear logs")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showPurgeEverythingConfirm}
        onOpenChange={setShowPurgeEverythingConfirm}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Purge entire cache?", "Purge entire cache?")}</DialogTitle>
            <DialogDescription>
              {t(
                "This purges cached content for the active zone. It can temporarily increase origin load.",
                "This purges cached content for the active zone. It can temporarily increase origin load.",
              )}
            </DialogDescription>
          </DialogHeader>
          {activeTab?.kind === "zone" ? (
            <div className="rounded-lg border border-border/60 bg-card/60 p-3 text-xs">
              <div className="font-semibold">{activeTab.zoneName}</div>
              <div className="mt-1 text-muted-foreground">
                {t("Purge: everything", "Purge: everything")}
              </div>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowPurgeEverythingConfirm(false)}
            >
              {t("Cancel", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={() => void confirmPurgeEverything()}
            >
              {t("Purge", "Purge")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={showPurgeUrlsConfirm} onOpenChange={setShowPurgeUrlsConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Purge URLs?", "Purge URLs?")}</DialogTitle>
            <DialogDescription>
              {t(
                "Cloudflare may reject invalid URLs. You can still attempt to purge anyway.",
                "Cloudflare may reject invalid URLs. You can still attempt to purge anyway.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/60 bg-card/60 p-3 text-xs">
            <div className="font-semibold">
              {t("{{count}} URL(s)", {
                count: pendingPurgeUrls.length,
                defaultValue: `${pendingPurgeUrls.length} URL(s)`,
              })}
            </div>
            {pendingPurgeIssues.length > 0 ? (
              <div className="mt-2 space-y-1">
                <div className="text-destructive font-medium">{t("Warnings", "Warnings")}</div>
                <ul className="list-disc pl-4 text-destructive/90">
                  {pendingPurgeIssues.slice(0, 8).map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
                {pendingPurgeIssues.length > 8 ? (
                  <div className="text-muted-foreground">
                    +{t("{{count}} more…", {
                      count: pendingPurgeIssues.length - 8,
                      defaultValue: `${pendingPurgeIssues.length - 8} more…`,
                    })}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-2 text-muted-foreground">
                {t("No issues detected.", "No issues detected.")}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowPurgeUrlsConfirm(false)}
            >
              {t("Cancel", "Cancel")}
            </Button>
            <Button className="flex-1" onClick={() => void confirmPurgeUrls()}>
              {t("Purge", "Purge")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={showLogoutConfirm} onOpenChange={setShowLogoutConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Log out", "Log out")}</DialogTitle>
            <DialogDescription>
              {t(
                "Are you sure you want to log out? You'll need to sign in again to manage records.",
                "Are you sure you want to log out? You'll need to sign in again to manage records.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="checkbox-themed"
              checked={!confirmLogout}
              onChange={(e) => {
                const disable = e.target.checked;
                setConfirmLogout(!disable);
                notifySaved(
                  disable
                    ? t("Logout confirmation disabled.", "Logout confirmation disabled.")
                    : t("Logout confirmation enabled.", "Logout confirmation enabled."),
                );
              }}
            />
            {t("Don't ask again", "Don't ask again")}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowLogoutConfirm(false)}
            >
              {t("Cancel", "Cancel")}
            </Button>
            <Button variant="destructive" className="flex-1" onClick={confirmAndLogout}>
              {t("Log out", "Log out")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

