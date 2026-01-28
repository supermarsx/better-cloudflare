
/**
 * Top-level DNS Manager UI which composes the zone selector, the record
 * list and dialogs for creating/importing records.
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import type { DragEvent } from "react";
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
import { Tag } from "@/components/ui/tag";
import { useCloudflareAPI } from "@/hooks/use-cloudflare-api";
import type { DNSRecord, Zone, ZoneSetting, RecordType } from "@/types/dns";
import { RECORD_TYPES } from "@/types/dns";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { storageManager } from "@/lib/storage";
import {
  ClipboardPaste,
  Copy,
  Columns2,
  FileDown,
  FileUp,
  Filter,
  GripVertical,
  LogOut,
  Search,
  Settings,
  Shield,
  Tags,
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
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";

type ActionTab =
  | "records"
  | "import"
  | "zone-settings"
  | "cache"
  | "ssl-tls"
  | "dns-options";
type TabKind = "zone" | "settings" | "audit" | "tags";
type SortKey = "type" | "name" | "content" | "comment" | "tags" | "ttl" | "proxied";
type SortDir = "asc" | "desc" | null;

type RecordTableColumnId =
  | "select"
  | "type"
  | "name"
  | "content"
  | "comment"
  | "tags"
  | "ttl"
  | "proxied"
  | "actions";

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
    hint: "Purge cache and toggle Cloudflare caching settings",
  },
  {
    id: "ssl-tls",
    label: "SSL/TLS",
    hint: "Manage zone SSL and TLS settings",
  },
  {
    id: "dns-options",
    label: "Options",
    hint: "DNSSEC, multi-signer DNSSEC, and related zone options",
  },
];
const ACTION_TAB_LABELS: Record<TabKind, string> = {
  zone: "Zone",
  settings: "Settings",
  audit: "Audit",
  tags: "Tags",
};

const createEmptyRecord = (): Partial<DNSRecord> => ({
  type: "A",
  name: "",
  content: "",
  comment: "",
  ttl: 300,
  proxied: false,
});

const DEFAULT_RECORD_TABLE_COLUMNS: RecordTableColumnId[] = [
  "select",
  "type",
  "name",
  "content",
  "comment",
  "tags",
  "ttl",
  "proxied",
  "actions",
];

const RECORD_TABLE_COLUMN_TEMPLATES: Record<RecordTableColumnId, string> = {
  select: "24px",
  type: "56px",
  name: "minmax(140px,1.2fr)",
  content: "minmax(180px,2fr)",
  comment: "minmax(160px,1.4fr)",
  tags: "minmax(120px,1fr)",
  ttl: "92px",
  proxied: "78px",
  actions: "92px",
};

function normalizeRecordTableColumns(
  value: unknown,
): RecordTableColumnId[] {
  const raw = Array.isArray(value) ? value : [];
  const allowed = new Set<RecordTableColumnId>([
    "select",
    "type",
    "name",
    "content",
    "comment",
    "tags",
    "ttl",
    "proxied",
    "actions",
  ]);
  const normalized = raw
    .filter((v): v is RecordTableColumnId => typeof v === "string" && allowed.has(v as RecordTableColumnId))
    .filter((v, idx, arr) => arr.indexOf(v) === idx);

  const ensure = (id: RecordTableColumnId) => {
    if (!normalized.includes(id)) normalized.push(id);
  };
  // Always keep required columns.
  ensure("select");
  ensure("type");
  ensure("name");

  // Default order when no valid saved data.
  if (normalized.length <= 4 && raw.length === 0) return [...DEFAULT_RECORD_TABLE_COLUMNS];
  return normalized;
}

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
  const [confirmDeleteRecord, setConfirmDeleteRecord] = useState(
    storageManager.getConfirmDeleteRecord(),
  );
  const [zoneConfirmDeleteRecord, setZoneConfirmDeleteRecord] = useState<
    Record<string, boolean>
  >(storageManager.getZoneConfirmDeleteRecordMap());
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number | null>(
    storageManager.getAutoRefreshInterval(),
  );
  const [auditEntries, setAuditEntries] = useState<Array<Record<string, unknown>>>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditType, setAuditType] = useState("all");
  const [auditResource, setAuditResource] = useState("all");
  const [auditOrder, setAuditOrder] = useState("newest");
  const [auditLimit, setAuditLimit] = useState("100");
  const [showClearAuditConfirm, setShowClearAuditConfirm] = useState(false);
  const [showResetSettingsConfirm, setShowResetSettingsConfirm] = useState(false);
  const [showClearSettingsConfirm, setShowClearSettingsConfirm] = useState(false);
  const [showClearAllDataConfirm, setShowClearAllDataConfirm] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showDeleteRecordConfirm, setShowDeleteRecordConfirm] = useState(false);
  const [pendingDeleteRecordId, setPendingDeleteRecordId] = useState<string | null>(null);
  const [reopenLastTabs, setReopenLastTabs] = useState(false);
  const [reopenZoneTabs, setReopenZoneTabs] = useState<Record<string, boolean>>({});
  const [lastOpenTabs, setLastOpenTabs] = useState<string[]>([]);
  const [lastActiveTabId, setLastActiveTabId] = useState<string>("");
  const [globalRecordTableColumns, setGlobalRecordTableColumns] = useState<
    RecordTableColumnId[]
  >(() => normalizeRecordTableColumns(storageManager.getDnsTableColumns()));
  const [zoneRecordTableColumns, setZoneRecordTableColumns] = useState<
    Record<string, RecordTableColumnId[]>
  >(() => {
    const raw = storageManager.getZoneDnsTableColumnsMap();
    const next: Record<string, RecordTableColumnId[]> = {};
    for (const [zoneId, cols] of Object.entries(raw)) {
      next[zoneId] = normalizeRecordTableColumns(cols);
    }
    return next;
  });
  const [dragHeaderId, setDragHeaderId] = useState<RecordTableColumnId | null>(null);
  const [dragHeaderOverId, setDragHeaderOverId] = useState<RecordTableColumnId | null>(null);
  const [restoredTabs, setRestoredTabs] = useState(false);
  const [copyBuffer, setCopyBuffer] = useState<{
    records: DNSRecord[];
    sourceZoneId: string;
    sourceZoneName: string;
  } | null>(null);

  const { toast } = useToast();
  const notifySaved = useCallback(
    (description: string) => {
      toast({ title: "Saved", description });
    },
    [toast],
  );
  const [tagsZoneId, setTagsZoneId] = useState<string>("");
  const [newTag, setNewTag] = useState("");
  const [renameTagFrom, setRenameTagFrom] = useState<string | null>(null);
  const [renameTagTo, setRenameTagTo] = useState("");
  const [tagsVersion, setTagsVersion] = useState(0);
  const [confirmLogout, setConfirmLogout] = useState(true);
  const [idleLogoutMs, setIdleLogoutMs] = useState<number | null>(null);
  const [confirmWindowClose, setConfirmWindowClose] = useState(true);
  const [cacheSettingsLoading, setCacheSettingsLoading] = useState(false);
  const [cacheSettingsError, setCacheSettingsError] = useState<string | null>(null);
  const [zoneDevMode, setZoneDevMode] = useState<ZoneSetting<string> | null>(null);
  const [zoneCacheLevel, setZoneCacheLevel] = useState<ZoneSetting<string> | null>(null);
  const [zoneAlwaysOnline, setZoneAlwaysOnline] = useState<ZoneSetting<string> | null>(null);
  const [zoneCrawlerHints, setZoneCrawlerHints] = useState<ZoneSetting<string> | null>(null);
  const [zoneBrowserCacheTtl, setZoneBrowserCacheTtl] =
    useState<ZoneSetting<number> | null>(null);
  const [purgeUrlsInput, setPurgeUrlsInput] = useState("");
  const [showPurgeEverythingConfirm, setShowPurgeEverythingConfirm] = useState(false);
  const [showPurgeUrlsConfirm, setShowPurgeUrlsConfirm] = useState(false);
  const [pendingPurgeUrls, setPendingPurgeUrls] = useState<string[]>([]);
  const [pendingPurgeIssues, setPendingPurgeIssues] = useState<string[]>([]);
  const [dnsOptionsLoading, setDnsOptionsLoading] = useState(false);
  const [dnsOptionsError, setDnsOptionsError] = useState<string | null>(null);
  const [dnssecInfo, setDnssecInfo] = useState<Record<string, unknown> | null>(null);
  const [sslSettingsLoading, setSslSettingsLoading] = useState(false);
  const [sslSettingsError, setSslSettingsError] = useState<string | null>(null);
  const [zoneSslMode, setZoneSslMode] = useState<ZoneSetting<string> | null>(null);
  const [zoneMinTlsVersion, setZoneMinTlsVersion] = useState<ZoneSetting<string> | null>(null);
  const [zoneTls13, setZoneTls13] = useState<ZoneSetting<string> | null>(null);
  const [zoneAlwaysUseHttps, setZoneAlwaysUseHttps] = useState<ZoneSetting<string> | null>(null);
  const [zoneAutoHttpsRewrites, setZoneAutoHttpsRewrites] = useState<ZoneSetting<string> | null>(null);
  const [zoneOpportunisticEncryption, setZoneOpportunisticEncryption] =
    useState<ZoneSetting<string> | null>(null);
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
    getDnssec,
    updateDnssec,
  } = useCloudflareAPI(apiKey, email);

  const availableZones = useMemo(
    () => zones.filter((zone) => zone.id),
    [zones],
  );

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );

  const pendingDeleteRecord = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return null;
    if (!pendingDeleteRecordId) return null;
    return (
      activeTab.records.find((r) => r.id === pendingDeleteRecordId) ?? null
    );
  }, [activeTab, pendingDeleteRecordId]);

  const zoneColumnsOverrideEnabled = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return false;
    return Object.prototype.hasOwnProperty.call(
      zoneRecordTableColumns,
      activeTab.zoneId,
    );
  }, [activeTab, zoneRecordTableColumns]);

  const resolvedRecordTableColumns = useMemo(() => {
    if (activeTab?.kind === "zone" && zoneColumnsOverrideEnabled) {
      return (
        zoneRecordTableColumns[activeTab.zoneId] ?? globalRecordTableColumns
      );
    }
    return globalRecordTableColumns;
  }, [
    activeTab?.kind,
    activeTab?.zoneId,
    globalRecordTableColumns,
    zoneColumnsOverrideEnabled,
    zoneRecordTableColumns,
  ]);

  const recordTableGridTemplate = useMemo(
    () =>
      resolvedRecordTableColumns
        .map((id) => RECORD_TABLE_COLUMN_TEMPLATES[id])
        .filter(Boolean)
        .join(" "),
    [resolvedRecordTableColumns],
  );

  const updateRecordTableColumns = useCallback(
    (updater: (prev: RecordTableColumnId[]) => RecordTableColumnId[]) => {
      if (activeTab?.kind === "zone" && zoneColumnsOverrideEnabled) {
        const zoneId = activeTab.zoneId;
        setZoneRecordTableColumns((prev) => {
          const current = normalizeRecordTableColumns(
            prev[zoneId] ?? globalRecordTableColumns,
          );
          const nextCols = normalizeRecordTableColumns(updater(current));
          return { ...prev, [zoneId]: nextCols };
        });
        return;
      }
      setGlobalRecordTableColumns((prev) =>
        normalizeRecordTableColumns(updater(prev)),
      );
    },
    [
      activeTab?.kind,
      activeTab?.zoneId,
      globalRecordTableColumns,
      zoneColumnsOverrideEnabled,
    ],
  );

  const setColumnEnabled = useCallback(
    (
      id: "comment" | "tags" | "content" | "ttl" | "proxied" | "actions",
      enabled: boolean,
    ) => {
      updateRecordTableColumns((prev) => {
        const has = prev.includes(id);
        if (enabled && has) return prev;
        if (!enabled && !has) return prev;

        if (!enabled) return normalizeRecordTableColumns(prev.filter((c) => c !== id));

        const next = [...prev];
        const nameIdx = next.indexOf("name");
        const contentIdx = next.indexOf("content");
        const commentIdx = next.indexOf("comment");
        const tagsIdx = next.indexOf("tags");
        const ttlIdx = next.indexOf("ttl");

        const insertAt = (() => {
          switch (id) {
            case "content":
              return nameIdx >= 0 ? nameIdx + 1 : 3;
            case "comment":
              return contentIdx >= 0
                ? contentIdx + 1
                : nameIdx >= 0
                  ? nameIdx + 1
                  : next.length - 1;
            case "tags":
              if (commentIdx >= 0) return commentIdx + 1;
              return contentIdx >= 0
                ? contentIdx + 1
                : nameIdx >= 0
                  ? nameIdx + 1
                  : next.length - 1;
            case "ttl":
              if (tagsIdx >= 0) return tagsIdx + 1;
              if (commentIdx >= 0) return commentIdx + 1;
              return contentIdx >= 0
                ? contentIdx + 1
                : nameIdx >= 0
                  ? nameIdx + 1
                  : next.length - 1;
            case "proxied":
              if (ttlIdx >= 0) return ttlIdx + 1;
              if (tagsIdx >= 0) return tagsIdx + 1;
              if (commentIdx >= 0) return commentIdx + 1;
              if (contentIdx >= 0) return contentIdx + 1;
              return next.length - 1;
            case "actions":
              return next.length;
            default:
              return next.length - 1;
          }
        })();

        next.splice(Math.min(Math.max(insertAt, 0), next.length), 0, id);
        return normalizeRecordTableColumns(next);
      });
    },
    [updateRecordTableColumns],
  );

  const reorderRecordTableColumns = useCallback((from: RecordTableColumnId, to: RecordTableColumnId) => {
    updateRecordTableColumns((prev) => {
      const fromIdx = prev.indexOf(from);
      const toIdx = prev.indexOf(to);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev;
      const next = [...prev];
      next.splice(fromIdx, 1);
      const dest = fromIdx < toIdx ? Math.max(toIdx - 1, 0) : toIdx;
      next.splice(dest, 0, from);
      return normalizeRecordTableColumns(next);
    });
  }, [updateRecordTableColumns]);

  const onHeaderDragStart = useCallback(
    (id: RecordTableColumnId) => (event: DragEvent) => {
      setDragHeaderId(id);
      setDragHeaderOverId(id);
      try {
        event.dataTransfer.setData("text/plain", id);
        event.dataTransfer.effectAllowed = "move";
      } catch {}
    },
    [],
  );

  const onHeaderDragOver = useCallback(
    (id: RecordTableColumnId) => (event: DragEvent) => {
      if (!dragHeaderId) return;
      event.preventDefault();
      setDragHeaderOverId(id);
    },
    [dragHeaderId],
  );

  const onHeaderDrop = useCallback(
    (id: RecordTableColumnId) => (event: DragEvent) => {
      event.preventDefault();
      const raw = (() => {
        try {
          return event.dataTransfer.getData("text/plain");
        } catch {
          return "";
        }
      })();
      const from = (dragHeaderId ?? (raw as RecordTableColumnId)) as RecordTableColumnId | null;
      if (from) reorderRecordTableColumns(from, id);
      setDragHeaderId(null);
      setDragHeaderOverId(null);
    },
    [dragHeaderId, reorderRecordTableColumns],
  );

  const onHeaderDragEnd = useCallback(() => {
    setDragHeaderId(null);
    setDragHeaderOverId(null);
  }, []);

  const resolvedShowUnsupportedRecordTypes = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return showUnsupportedRecordTypes;
    const zoneId = activeTab.zoneId;
    if (Object.prototype.hasOwnProperty.call(zoneShowUnsupportedRecordTypes, zoneId))
      return zoneShowUnsupportedRecordTypes[zoneId] === true;
    return showUnsupportedRecordTypes;
  }, [activeTab, showUnsupportedRecordTypes, zoneShowUnsupportedRecordTypes]);

  const resolvedConfirmDeleteRecord = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return confirmDeleteRecord;
    const zoneId = activeTab.zoneId;
    if (Object.prototype.hasOwnProperty.call(zoneConfirmDeleteRecord, zoneId))
      return zoneConfirmDeleteRecord[zoneId] !== false;
    return confirmDeleteRecord;
  }, [activeTab, confirmDeleteRecord, zoneConfirmDeleteRecord]);

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
          title: "Error",
          description: "Failed to load zones: " + (error as Error).message,
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
      setAuditError("Audit log is only available in the desktop app.");
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
          title: "Error",
          description:
            "Failed to load DNS records: " + (error as Error).message,
          variant: "destructive",
        });
      } finally {
        updateTab(tab.id, (prev) => ({ ...prev, isLoading: false }));
      }
    },
    [getDNSRecords, toast, updateTab],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadZones(controller.signal);
    return () => controller.abort();
  }, [loadZones]);

  useEffect(() => {
    if (!selectedZoneId) return;
    openZoneTab(selectedZoneId);
  }, [selectedZoneId, openZoneTab]);

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

  useEffect(() => {
    if (!activeTab || activeTab.kind !== "zone") return;
    if (actionTab !== "cache") return;
    if (!getZoneSetting) return;

    let cancelled = false;
    setCacheSettingsLoading(true);
    setCacheSettingsError(null);
    setZoneDevMode(null);
    setZoneCacheLevel(null);
    setZoneAlwaysOnline(null);
    setZoneCrawlerHints(null);
    setZoneBrowserCacheTtl(null);

    Promise.allSettled([
      getZoneSetting<string>(activeTab.zoneId, "development_mode"),
      getZoneSetting<string>(activeTab.zoneId, "cache_level"),
      getZoneSetting<string>(activeTab.zoneId, "always_online"),
      getZoneSetting<string>(activeTab.zoneId, "crawler_hints"),
      getZoneSetting<number>(activeTab.zoneId, "browser_cache_ttl"),
    ])
      .then((results) => {
        if (cancelled) return;
        const [dev, level, alwaysOnline, crawlerHints, browserTtl] = results;
        if (dev.status === "fulfilled") setZoneDevMode(dev.value);
        if (level.status === "fulfilled") setZoneCacheLevel(level.value);
        if (alwaysOnline.status === "fulfilled") setZoneAlwaysOnline(alwaysOnline.value);
        if (crawlerHints.status === "fulfilled") setZoneCrawlerHints(crawlerHints.value);
        if (browserTtl.status === "fulfilled") setZoneBrowserCacheTtl(browserTtl.value);
        const errors = results
          .filter((r) => r.status === "rejected")
          .map((r) => (r as PromiseRejectedResult).reason)
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .filter(Boolean);
        if (errors.length) setCacheSettingsError(errors.join(" | "));
      })
      .catch((e) => {
        if (cancelled) return;
        setCacheSettingsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setCacheSettingsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [actionTab, activeTab?.kind, activeTab?.zoneId, getZoneSetting]);

  useEffect(() => {
    if (!activeTab || activeTab.kind !== "zone") return;
    if (actionTab !== "ssl-tls") return;
    if (!getZoneSetting) return;

    let cancelled = false;
    setSslSettingsLoading(true);
    setSslSettingsError(null);
    setZoneSslMode(null);
    setZoneMinTlsVersion(null);
    setZoneTls13(null);
    setZoneAlwaysUseHttps(null);
    setZoneAutoHttpsRewrites(null);
    setZoneOpportunisticEncryption(null);

    Promise.allSettled([
      getZoneSetting<string>(activeTab.zoneId, "ssl"),
      getZoneSetting<string>(activeTab.zoneId, "min_tls_version"),
      getZoneSetting<string>(activeTab.zoneId, "tls_1_3"),
      getZoneSetting<string>(activeTab.zoneId, "always_use_https"),
      getZoneSetting<string>(activeTab.zoneId, "automatic_https_rewrites"),
      getZoneSetting<string>(activeTab.zoneId, "opportunistic_encryption"),
    ])
      .then((results) => {
        if (cancelled) return;
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
      })
      .catch((e) => {
        if (cancelled) return;
        setSslSettingsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setSslSettingsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [actionTab, activeTab?.kind, activeTab?.zoneId, getZoneSetting]);

  useEffect(() => {
    if (!activeTab || activeTab.kind !== "zone") return;
    if (actionTab !== "dns-options") return;
    void handleFetchDnssec();
  }, [actionTab, activeTab?.kind, activeTab?.zoneId, handleFetchDnssec]);

  useEffect(() => {
    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) => {
          const prefObj = prefs as {
            last_zone?: string;
            auto_refresh_interval?: number;
            default_per_page?: number;
            zone_per_page?: Record<string, number>;
            show_unsupported_record_types?: boolean;
            zone_show_unsupported_record_types?: Record<string, boolean>;
            confirm_delete_record?: boolean;
            zone_confirm_delete_record?: Record<string, boolean>;
            reopen_last_tabs?: boolean;
            reopen_zone_tabs?: Record<string, boolean>;
             last_open_tabs?: string[];
             last_active_tab?: string;
             dns_table_columns?: string[];
             zone_dns_table_columns?: Record<string, string[]>;
             confirm_logout?: boolean;
             idle_logout_ms?: number | null;
             confirm_window_close?: boolean;
           };
          if (prefObj.last_zone) setSelectedZoneId(prefObj.last_zone);
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
          if (typeof prefObj.confirm_delete_record === "boolean") {
            setConfirmDeleteRecord(prefObj.confirm_delete_record);
          }
          if (
            prefObj.zone_confirm_delete_record &&
            typeof prefObj.zone_confirm_delete_record === "object"
          ) {
            setZoneConfirmDeleteRecord(prefObj.zone_confirm_delete_record);
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
          if (typeof prefObj.last_active_tab === "string") {
            setLastActiveTabId(prefObj.last_active_tab);
          }
          if (Array.isArray(prefObj.dns_table_columns)) {
            setGlobalRecordTableColumns(
              normalizeRecordTableColumns(prefObj.dns_table_columns),
            );
          }
          if (
            prefObj.zone_dns_table_columns &&
            typeof prefObj.zone_dns_table_columns === "object"
          ) {
            const next: Record<string, RecordTableColumnId[]> = {};
            for (const [zoneId, cols] of Object.entries(prefObj.zone_dns_table_columns)) {
              next[zoneId] = normalizeRecordTableColumns(cols);
            }
            setZoneRecordTableColumns(next);
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
        })
        .catch(() => {});
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
    setConfirmDeleteRecord(storageManager.getConfirmDeleteRecord());
    setZoneConfirmDeleteRecord(storageManager.getZoneConfirmDeleteRecordMap());
    setReopenLastTabs(storageManager.getReopenLastTabs());
    setReopenZoneTabs(storageManager.getReopenZoneTabs());
    setLastOpenTabs(storageManager.getLastOpenTabs());
    setLastActiveTabId(storageManager.getLastActiveTabId());
    setGlobalRecordTableColumns(
      normalizeRecordTableColumns(storageManager.getDnsTableColumns()),
    );
    const rawZoneCols = storageManager.getZoneDnsTableColumnsMap();
    const zoneCols: Record<string, RecordTableColumnId[]> = {};
    for (const [zoneId, cols] of Object.entries(rawZoneCols)) {
      zoneCols[zoneId] = normalizeRecordTableColumns(cols);
    }
    setZoneRecordTableColumns(zoneCols);
    setConfirmLogout(storageManager.getConfirmLogout());
    setIdleLogoutMs(storageManager.getIdleLogoutMs());
    setConfirmWindowClose(storageManager.getConfirmWindowClose());
  }, []);

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
    storageManager.setDefaultPerPage(globalPerPage);
    storageManager.setZonePerPageMap(zonePerPage);
    storageManager.setShowUnsupportedRecordTypes(showUnsupportedRecordTypes);
    storageManager.setZoneShowUnsupportedRecordTypesMap(zoneShowUnsupportedRecordTypes);
    storageManager.setConfirmDeleteRecord(confirmDeleteRecord);
    storageManager.setZoneConfirmDeleteRecordMap(zoneConfirmDeleteRecord);
    storageManager.setReopenLastTabs(reopenLastTabs);
    storageManager.setReopenZoneTabs(reopenZoneTabs);
    storageManager.setDnsTableColumns(globalRecordTableColumns as string[]);
    storageManager.setZoneDnsTableColumnsMap(
      zoneRecordTableColumns as Record<string, string[]>,
    );
    storageManager.setConfirmLogout(confirmLogout);
    storageManager.setIdleLogoutMs(idleLogoutMs);
    storageManager.setConfirmWindowClose(confirmWindowClose);

    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) =>
          TauriClient.updatePreferences({
            ...(prefs as Record<string, unknown>),
            default_per_page: globalPerPage,
            zone_per_page: zonePerPage,
            show_unsupported_record_types: showUnsupportedRecordTypes,
            zone_show_unsupported_record_types: zoneShowUnsupportedRecordTypes,
            confirm_delete_record: confirmDeleteRecord,
            zone_confirm_delete_record: zoneConfirmDeleteRecord,
            reopen_last_tabs: reopenLastTabs,
            reopen_zone_tabs: reopenZoneTabs,
            dns_table_columns: globalRecordTableColumns,
            zone_dns_table_columns: zoneRecordTableColumns,
            confirm_logout: confirmLogout,
            idle_logout_ms: idleLogoutMs,
            confirm_window_close: confirmWindowClose,
          }),
        )
        .catch(() => {});
    }
  }, [
    globalPerPage,
    zonePerPage,
    showUnsupportedRecordTypes,
    zoneShowUnsupportedRecordTypes,
    confirmDeleteRecord,
    zoneConfirmDeleteRecord,
    reopenLastTabs,
    reopenZoneTabs,
    globalRecordTableColumns,
    zoneRecordTableColumns,
    confirmLogout,
    idleLogoutMs,
    confirmWindowClose,
  ]);

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
    if (!availableZones.length || !lastOpenTabs.length) return;
    const eligible = lastOpenTabs.filter(
      (id) => reopenZoneTabs[id] !== false,
    );
    if (!eligible.length) {
      setRestoredTabs(true);
      return;
    }
    const preferred =
      lastActiveTabId && eligible.includes(lastActiveTabId)
        ? lastActiveTabId
        : "";
    const ordered = preferred
      ? [...eligible.filter((id) => id !== preferred), preferred]
      : eligible;
    ordered.forEach((zoneId) => openZoneTab(zoneId));
    setRestoredTabs(true);
  }, [
    reopenLastTabs,
    restoredTabs,
    availableZones,
    lastOpenTabs,
    reopenZoneTabs,
    openZoneTab,
    lastActiveTabId,
  ]);

  useEffect(() => {
    if (reopenLastTabs && !restoredTabs) return;
    const openZoneIds = tabs
      .filter((tab) => tab.kind === "zone")
      .map((tab) => tab.zoneId);
    setLastOpenTabs(openZoneIds);
    if (isDesktop()) {
      TauriClient.updatePreferenceFields({ last_open_tabs: openZoneIds }).catch(
        () => {},
      );
      return;
    }
    storageManager.setLastOpenTabs(openZoneIds);
  }, [reopenLastTabs, restoredTabs, tabs]);

  useEffect(() => {
    if (reopenLastTabs && !restoredTabs) return;
    if (!activeTabId) return;
    setLastActiveTabId(activeTabId);
    if (isDesktop()) {
      TauriClient.updatePreferenceFields({ last_active_tab: activeTabId }).catch(
        () => {},
      );
      return;
    }
    storageManager.setLastActiveTabId(activeTabId);
  }, [activeTabId, reopenLastTabs, restoredTabs]);

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


  const filteredRecords = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return [];
    const base = filterRecords(activeTab.records, activeTab.searchTerm).filter(
      (record: DNSRecord) =>
        activeTab.typeFilter ? record.type === activeTab.typeFilter : true,
    );

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

    const tagKeyById: Record<string, string> | null =
      activeTab.sortKey === "tags"
        ? Object.fromEntries(
            base.map((r) => [
              r.id,
              storageManager
                .getRecordTags(activeTab.zoneId, r.id)
                .join(",")
                .toLowerCase(),
            ]),
          )
        : null;

    const sorted = [...base].sort((a, b) => {
      switch (activeTab.sortKey) {
        case "type":
          return dir * cmpText(a.type ?? "", b.type ?? "");
        case "name":
          return dir * cmpText(a.name ?? "", b.name ?? "");
        case "content":
          return dir * cmpText(a.content ?? "", b.content ?? "");
        case "comment":
          return dir * cmpText(a.comment ?? "", b.comment ?? "");
        case "tags":
          return dir * cmpText(tagKeyById?.[a.id] ?? "", tagKeyById?.[b.id] ?? "");
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

  const auditTypeOptions = useMemo(() => {
    const set = new Set<string>();
    auditEntries.forEach((entry) => {
      const op = entry.operation;
      if (typeof op === "string" && op) set.add(op);
    });
    return ["all", ...Array.from(set)];
  }, [auditEntries]);

  const auditResourceOptions = useMemo(() => {
    const set = new Set<string>();
    auditEntries.forEach((entry) => {
      const resource = entry.resource;
      if (typeof resource === "string" && resource) set.add(resource);
    });
    return ["all", ...Array.from(set)];
  }, [auditEntries]);

  const filteredAuditEntries = useMemo(() => {
    if (!auditEntries.length) return [];
    const search = auditSearch.trim().toLowerCase();
    return auditEntries.filter((entry) => {
      if (auditType !== "all" && entry.operation !== auditType) return false;
      if (auditResource !== "all" && entry.resource !== auditResource) return false;
      if (!search) return true;
      const payload = JSON.stringify(entry).toLowerCase();
      return payload.includes(search);
    });
  }, [auditEntries, auditSearch, auditType, auditResource]);

  const orderedAuditEntries = useMemo(() => {
    const entries = [...filteredAuditEntries];
    const parseTime = (value: unknown) => {
      if (typeof value !== "string") return 0;
      const ts = Date.parse(value);
      return Number.isNaN(ts) ? 0 : ts;
    };
    entries.sort((a, b) => {
      if (auditOrder === "operation") {
        return String(a.operation ?? "").localeCompare(String(b.operation ?? ""));
      }
      if (auditOrder === "resource") {
        return String(a.resource ?? "").localeCompare(String(b.resource ?? ""));
      }
      const aTime = parseTime(a.timestamp);
      const bTime = parseTime(b.timestamp);
      return auditOrder === "oldest" ? aTime - bTime : bTime - aTime;
    });
    return entries;
  }, [filteredAuditEntries, auditOrder]);

  const limitedAuditEntries = useMemo(() => {
    if (auditLimit === "all") return orderedAuditEntries;
    const limit = Number(auditLimit);
    if (Number.isNaN(limit)) return orderedAuditEntries;
    return orderedAuditEntries.slice(0, limit);
  }, [orderedAuditEntries, auditLimit]);
  const handleAddRecord = async () => {
    if (!activeTab) return;
    const draft = activeTab.newRecord;
    if (!draft.type || !draft.name || !draft.content) {
      toast({
        title: "Error",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    const inFlight = toast({
      title: "Creating record…",
      description: `${draft.type} ${draft.name}`,
    });
    try {
      const createdRecord = await createDNSRecord(activeTab.zoneId, draft);
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: [createdRecord, ...prev.records],
        newRecord: createEmptyRecord(),
        showAddRecord: false,
      }));
      inFlight.update({
        id: inFlight.id,
        title: "Record created",
        description: `${createdRecord.type} ${createdRecord.name}`,
      });
    } catch (error) {
      inFlight.update({
        id: inFlight.id,
        title: "Error",
        description: "Failed to create DNS record: " + (error as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleUpdateRecord = async (record: DNSRecord) => {
    if (!activeTab) return;
    const inFlight = toast({
      title: "Saving changes…",
      description: `${record.type} ${record.name}`,
    });
    try {
      const updatedRecord = await updateDNSRecord(
        activeTab.zoneId,
        record.id,
        record,
      );
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.map((r) =>
          r.id === record.id ? updatedRecord : r,
        ),
        editingRecord: null,
      }));
      inFlight.update({
        id: inFlight.id,
        title: "Record updated",
        description: `${updatedRecord.type} ${updatedRecord.name}`,
      });
    } catch (error) {
      inFlight.update({
        id: inFlight.id,
        title: "Error",
        description: "Failed to update DNS record: " + (error as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleToggleProxy = async (record: DNSRecord, proxied: boolean) => {
    if (!activeTab) return;
    const inFlight = toast({
      title: "Updating proxy…",
      description: `${record.type} ${record.name}`,
    });
    try {
      const updatedRecord = await updateDNSRecord(
        activeTab.zoneId,
        record.id,
        {
          ...record,
          proxied,
        },
      );
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.map((r) =>
          r.id === record.id ? updatedRecord : r,
        ),
      }));
      inFlight.update({
        id: inFlight.id,
        title: "Proxy updated",
        description: `${updatedRecord.type} ${updatedRecord.name} is now ${
          proxied ? "proxied" : "DNS-only"
        }`,
      });
    } catch (error) {
      inFlight.update({
        id: inFlight.id,
        title: "Error",
        description: "Failed to update proxy: " + (error as Error).message,
        variant: "destructive",
      });
    }
  };

  const deleteRecordNow = async (recordId: string) => {
    if (!activeTab) return;
    const deleting = activeTab.records.find((r) => r.id === recordId);
    const inFlight = toast({
      title: "Deleting record…",
      description: deleting ? `${deleting.type} ${deleting.name}` : undefined,
    });
    try {
      await deleteDNSRecord(activeTab.zoneId, recordId);
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.filter((r) => r.id !== recordId),
        selectedIds: prev.selectedIds.filter((id) => id !== recordId),
      }));
      inFlight.update({
        id: inFlight.id,
        title: "Record deleted",
        description: deleting ? `${deleting.type} ${deleting.name}` : undefined,
      });
    } catch (error) {
      inFlight.update({
        id: inFlight.id,
        title: "Error",
        description: "Failed to delete DNS record: " + (error as Error).message,
        variant: "destructive",
      });
    }
  };

  const requestDeleteRecord = async (recordId: string) => {
    if (!activeTab) return;
    if (!resolvedConfirmDeleteRecord) {
      await deleteRecordNow(recordId);
      return;
    }
    setPendingDeleteRecordId(recordId);
    setShowDeleteRecordConfirm(true);
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
      title: "Success",
      description: `Records exported as ${format.toUpperCase()}`,
    });
  };

  const confirmDeleteRecordNow = async () => {
    if (!pendingDeleteRecordId) {
      setShowDeleteRecordConfirm(false);
      return;
    }
    const id = pendingDeleteRecordId;
    setShowDeleteRecordConfirm(false);
    setPendingDeleteRecordId(null);
    await deleteRecordNow(id);
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
              title: "Error",
              description:
                "Failed to import records: " + (err as Error).message,
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
            title: "Success",
            description:
              `Imported ${valid.length} record(s)` +
              (skipped ? `, skipped ${skipped}` : ""),
          });
        } else {
          toast({
            title: "Dry Run",
            description:
              `Would import ${valid.length} record(s)` +
              (skipped ? `, skipped ${skipped}` : ""),
          });
        }
      } else {
        toast({
          title: "Error",
          description: skipped
            ? `No new records imported. Skipped ${skipped} invalid or duplicate item(s).`
            : "No valid records found.",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to import records: " + (error as Error).message,
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
        title: "Nothing selected",
        description: "Select one or more records to copy.",
      });
      return;
    }
    setCopyBuffer({
      records: selectedRecords,
      sourceZoneId: activeTab.zoneId,
      sourceZoneName: activeTab.zoneName,
    });
    toast({
      title: "Copied",
      description: `Copied ${selectedRecords.length} record(s) from ${activeTab.zoneName}`,
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
      title: "Copied",
      description: `Copied ${record.name} from ${activeTab.zoneName}`,
    });
  };

  const handlePasteRecords = async () => {
    if (!activeTab || !copyBuffer) return;
    const toCreate = copyBuffer.records.map((record) => ({
      type: record.type,
      name: record.name,
      content: record.content,
      comment: record.comment,
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
          title: "Pasted",
          description: `Created ${created.length} record(s) in ${activeTab.zoneName}`,
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
        title: "Pasted",
        description: `Created ${createdRecords.length} record(s) in ${activeTab.zoneName}`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to paste records: " + (error as Error).message,
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
          title: "Saved",
          description: enabled
            ? "Development mode enabled (cache bypass)."
            : "Development mode disabled.",
        });
      } catch (error) {
        toast({
          title: "Error",
          description:
            "Failed to update development mode: " + (error as Error).message,
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
          title: "Saved",
          description: `Cache level set to ${level}.`,
        });
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to update cache level: " + (error as Error).message,
          variant: "destructive",
        });
      } finally {
        setCacheSettingsLoading(false);
      }
    },
    [activeTab, toast, updateZoneSetting],
  );

  const handleToggleAlwaysOnline = useCallback(
    async (enabled: boolean) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      try {
        setCacheSettingsLoading(true);
        setCacheSettingsError(null);
        const next = await updateZoneSetting<string>(
          activeTab.zoneId,
          "always_online",
          enabled ? "on" : "off",
        );
        setZoneAlwaysOnline(next);
        toast({
          title: "Saved",
          description: enabled ? "Always Online enabled." : "Always Online disabled.",
        });
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to update Always Online: " + (error as Error).message,
          variant: "destructive",
        });
      } finally {
        setCacheSettingsLoading(false);
      }
    },
    [activeTab, toast, updateZoneSetting],
  );

  const handleToggleCrawlerHints = useCallback(
    async (enabled: boolean) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      try {
        setCacheSettingsLoading(true);
        setCacheSettingsError(null);
        const next = await updateZoneSetting<string>(
          activeTab.zoneId,
          "crawler_hints",
          enabled ? "on" : "off",
        );
        setZoneCrawlerHints(next);
        toast({
          title: "Saved",
          description: enabled ? "Crawler Hints enabled." : "Crawler Hints disabled.",
        });
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to update Crawler Hints: " + (error as Error).message,
          variant: "destructive",
        });
      } finally {
        setCacheSettingsLoading(false);
      }
    },
    [activeTab, toast, updateZoneSetting],
  );

  const handleSetBrowserCacheTtl = useCallback(
    async (ttl: number) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      try {
        setCacheSettingsLoading(true);
        setCacheSettingsError(null);
        const next = await updateZoneSetting<number>(
          activeTab.zoneId,
          "browser_cache_ttl",
          ttl,
        );
        setZoneBrowserCacheTtl(next);
        toast({
          title: "Saved",
          description: `Browser Cache TTL set to ${ttl}s.`,
        });
      } catch (error) {
        toast({
          title: "Error",
          description:
            "Failed to update Browser Cache TTL: " + (error as Error).message,
          variant: "destructive",
        });
      } finally {
        setCacheSettingsLoading(false);
      }
    },
    [activeTab, toast, updateZoneSetting],
  );

  const handleFetchDnssec = useCallback(async () => {
    if (!activeTab || activeTab.kind !== "zone") return;
    try {
      setDnsOptionsLoading(true);
      setDnsOptionsError(null);
      const result = await getDnssec(activeTab.zoneId);
      setDnssecInfo((result as Record<string, unknown>) ?? null);
    } catch (error) {
      setDnsOptionsError(error instanceof Error ? error.message : String(error));
    } finally {
      setDnsOptionsLoading(false);
    }
  }, [activeTab, getDnssec]);

  const handleUpdateDnssec = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      try {
        setDnsOptionsLoading(true);
        setDnsOptionsError(null);
        const result = await updateDnssec(activeTab.zoneId, payload);
        setDnssecInfo((result as Record<string, unknown>) ?? null);
        toast({ title: "Saved", description: "DNS options updated." });
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to update DNSSEC: " + (error as Error).message,
          variant: "destructive",
        });
      } finally {
        setDnsOptionsLoading(false);
      }
    },
    [activeTab, toast, updateDnssec],
  );

  const preparePurgeUrls = useCallback(() => {
    const raw = purgeUrlsInput;
    const urls = raw
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
        title: "Purged",
        description: `Cache purged for ${activeTab.zoneName}.`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to purge cache: " + (error as Error).message,
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
        title: "Purged",
        description: `Purged ${urls.length} URL(s) for ${activeTab.zoneName}.`,
      });
      setPurgeUrlsInput("");
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to purge URLs: " + (error as Error).message,
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
          title: "Saved",
          description: `${settingId.replace(/_/g, " ")} updated.`,
        });
      } catch (error) {
        toast({
          title: "Error",
          description:
            "Failed to update SSL/TLS setting: " + (error as Error).message,
          variant: "destructive",
        });
      } finally {
        setSslSettingsLoading(false);
      }
    },
    [activeTab, toast, updateZoneSetting],
  );

  const handleLogout = () => {
    storageManager.clearSession();
    if (confirmLogout) {
      setShowLogoutConfirm(true);
      return;
    }
    onLogout();
  };

  const confirmAndLogout = () => {
    storageManager.clearSession();
    setShowLogoutConfirm(false);
    onLogout();
  };

  const DEFAULT_SETTINGS = useMemo(
    () => ({
      autoRefreshInterval: null as number | null,
      globalPerPage: 50,
      zonePerPage: {} as Record<string, number>,
      showUnsupportedRecordTypes: false,
      zoneShowUnsupportedRecordTypes: {} as Record<string, boolean>,
      confirmDeleteRecord: true,
      zoneConfirmDeleteRecord: {} as Record<string, boolean>,
      reopenLastTabs: false,
      reopenZoneTabs: {} as Record<string, boolean>,
      dnsTableColumns: [...DEFAULT_RECORD_TABLE_COLUMNS] as RecordTableColumnId[],
      zoneDnsTableColumns: {} as Record<string, RecordTableColumnId[]>,
      confirmLogout: true,
      idleLogoutMs: null as number | null,
      confirmWindowClose: true,
    }),
    [],
  );

  const resetSettingsToDefaults = useCallback(() => {
    setAutoRefreshInterval(DEFAULT_SETTINGS.autoRefreshInterval);
    setGlobalPerPage(DEFAULT_SETTINGS.globalPerPage);
    setZonePerPage(DEFAULT_SETTINGS.zonePerPage);
    setShowUnsupportedRecordTypes(DEFAULT_SETTINGS.showUnsupportedRecordTypes);
    setZoneShowUnsupportedRecordTypes(DEFAULT_SETTINGS.zoneShowUnsupportedRecordTypes);
    setConfirmDeleteRecord(DEFAULT_SETTINGS.confirmDeleteRecord);
    setZoneConfirmDeleteRecord(DEFAULT_SETTINGS.zoneConfirmDeleteRecord);
    setReopenLastTabs(DEFAULT_SETTINGS.reopenLastTabs);
    setReopenZoneTabs(DEFAULT_SETTINGS.reopenZoneTabs);
    setGlobalRecordTableColumns(DEFAULT_SETTINGS.dnsTableColumns);
    setZoneRecordTableColumns(DEFAULT_SETTINGS.zoneDnsTableColumns);
    setConfirmLogout(DEFAULT_SETTINGS.confirmLogout);
    setIdleLogoutMs(DEFAULT_SETTINGS.idleLogoutMs);
    setConfirmWindowClose(DEFAULT_SETTINGS.confirmWindowClose);

    setTabs([]);
    setActiveTabId(null);
    setSelectedZoneId("");
    setLastOpenTabs([]);
    setLastActiveTabId("");
  }, [DEFAULT_SETTINGS]);

  const persistSettingsNow = useCallback(
    async (opts?: {
      includeTabs?: boolean;
      overrides?: Partial<typeof DEFAULT_SETTINGS>;
      openTabsOverride?: string[];
      activeTabIdOverride?: string | null;
    }) => {
      const includeTabs = opts?.includeTabs ?? true;
      const snapshot = {
        autoRefreshInterval,
        globalPerPage,
        zonePerPage,
        showUnsupportedRecordTypes,
        zoneShowUnsupportedRecordTypes,
        confirmDeleteRecord,
        zoneConfirmDeleteRecord,
        reopenLastTabs,
        reopenZoneTabs,
        dnsTableColumns: globalRecordTableColumns,
        zoneDnsTableColumns: zoneRecordTableColumns,
        confirmLogout,
        idleLogoutMs,
        confirmWindowClose,
        ...(opts?.overrides ?? {}),
      };

      storageManager.setAutoRefreshInterval(snapshot.autoRefreshInterval ?? null);
      storageManager.setDefaultPerPage(snapshot.globalPerPage);
      storageManager.setZonePerPageMap(snapshot.zonePerPage);
      storageManager.setShowUnsupportedRecordTypes(snapshot.showUnsupportedRecordTypes);
      storageManager.setZoneShowUnsupportedRecordTypesMap(snapshot.zoneShowUnsupportedRecordTypes);
      storageManager.setConfirmDeleteRecord(snapshot.confirmDeleteRecord);
      storageManager.setZoneConfirmDeleteRecordMap(snapshot.zoneConfirmDeleteRecord);
      storageManager.setReopenLastTabs(snapshot.reopenLastTabs);
      storageManager.setReopenZoneTabs(snapshot.reopenZoneTabs);
      storageManager.setDnsTableColumns(snapshot.dnsTableColumns as string[]);
      storageManager.setZoneDnsTableColumnsMap(
        snapshot.zoneDnsTableColumns as Record<string, string[]>,
      );
      storageManager.setConfirmLogout(snapshot.confirmLogout);
      storageManager.setIdleLogoutMs(snapshot.idleLogoutMs);
      storageManager.setConfirmWindowClose(snapshot.confirmWindowClose);

      if (includeTabs) {
        storageManager.setLastOpenTabs(opts?.openTabsOverride ?? lastOpenTabs);
        storageManager.setLastActiveTabId(
          opts?.activeTabIdOverride ?? activeTabId,
        );
      }

      if (!isDesktop()) return;
      await TauriClient.updatePreferenceFields({
        auto_refresh_interval: snapshot.autoRefreshInterval ?? undefined,
        default_per_page: snapshot.globalPerPage,
        zone_per_page: snapshot.zonePerPage,
        show_unsupported_record_types: snapshot.showUnsupportedRecordTypes,
        zone_show_unsupported_record_types: snapshot.zoneShowUnsupportedRecordTypes,
        confirm_delete_record: snapshot.confirmDeleteRecord,
        zone_confirm_delete_record: snapshot.zoneConfirmDeleteRecord,
        reopen_last_tabs: snapshot.reopenLastTabs,
        reopen_zone_tabs: snapshot.reopenZoneTabs,
        dns_table_columns: snapshot.dnsTableColumns,
        zone_dns_table_columns: snapshot.zoneDnsTableColumns,
        confirm_logout: snapshot.confirmLogout,
        idle_logout_ms: snapshot.idleLogoutMs ?? null,
        confirm_window_close: snapshot.confirmWindowClose,
        ...(includeTabs
          ? { last_open_tabs: opts?.openTabsOverride ?? lastOpenTabs }
          : {}),
      });
    },
    [
      activeTabId,
      autoRefreshInterval,
      confirmDeleteRecord,
      confirmLogout,
      confirmWindowClose,
      globalPerPage,
      idleLogoutMs,
      lastOpenTabs,
      globalRecordTableColumns,
      zoneRecordTableColumns,
      reopenLastTabs,
      reopenZoneTabs,
      showUnsupportedRecordTypes,
      zoneConfirmDeleteRecord,
      zonePerPage,
      zoneShowUnsupportedRecordTypes,
    ],
  );

  const handleResetSettings = useCallback(async () => {
    resetSettingsToDefaults();
    // Persist immediately (especially important on desktop) so state stays up-to-date.
    try {
      await persistSettingsNow({
        includeTabs: true,
        overrides: DEFAULT_SETTINGS,
        openTabsOverride: [],
        activeTabIdOverride: null,
      });
    } catch {
      // ignore
    }
    toast({ title: "Settings reset", description: "Defaults restored." });
  }, [DEFAULT_SETTINGS, persistSettingsNow, resetSettingsToDefaults, toast]);

  const handleClearSettings = useCallback(async () => {
    // Clear persisted settings first...
    if (isDesktop()) {
      try {
        await TauriClient.updatePreferences({});
      } catch {
        // ignore
      }
    } else {
      storageManager.clearSettings();
    }

    // ...then immediately resave defaults so the app has a known baseline.
    resetSettingsToDefaults();
    try {
      await persistSettingsNow({
        includeTabs: true,
        overrides: DEFAULT_SETTINGS,
        openTabsOverride: [],
        activeTabIdOverride: null,
      });
    } catch {
      // ignore
    }
    toast({ title: "Settings cleared", description: "Defaults saved." });
  }, [DEFAULT_SETTINGS, persistSettingsNow, resetSettingsToDefaults, toast]);

  const handleClearAllData = useCallback(async () => {
    if (isDesktop()) {
      try {
        const keys = await TauriClient.getApiKeys();
        const ids = Array.isArray(keys)
          ? keys
              .map((k) => (k && typeof k === "object" ? (k as { id?: unknown }).id : undefined))
              .filter((id): id is string => typeof id === "string")
          : [];
        await Promise.allSettled(ids.map((id) => TauriClient.deleteApiKey(id)));
      } catch {
        // ignore
      }
      try {
        await TauriClient.clearAuditEntries();
      } catch {
        // ignore
      }
      try {
        await TauriClient.updatePreferences({});
      } catch {
        // ignore
      }
    } else {
      storageManager.clearAllData();
    }

    setTabs([]);
    setActiveTabId(null);
    setSelectedZoneId("");
    setLastOpenTabs([]);
    setLastActiveTabId("");
    setAuditEntries([]);
    setCopyBuffer(null);
    onLogout();
  }, [onLogout]);

  const selectedZoneData = activeTab
    ? availableZones.find((z) => z.id === activeTab.zoneId)
    : undefined;
  const actionHint = ACTION_TABS.find((tab) => tab.id === actionTab)?.hint;

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

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_55%),radial-gradient(circle_at_bottom,rgba(0,0,0,0.45),transparent_60%)] p-4 text-foreground">
      <div className="max-w-6xl mx-auto space-y-6 pb-10 fade-in-up">
          <div className="sticky top-0 z-20">
            <Card className="border-border/60 bg-card/85 shadow-[0_18px_50px_rgba(0,0,0,0.25)] backdrop-blur">
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
                <div className="flex flex-wrap items-center gap-2">
                  {isDesktop() && (
                    <Tooltip tip="Audit log" side="bottom">
                      <Button
                        onClick={() => openActionTab("audit")}
                        variant="ghost"
                        size="icon"
                        className="ui-icon-button h-8 w-8"
                        aria-label="Audit log"
                      >
                        <Shield className="h-4 w-4" />
                      </Button>
                    </Tooltip>
                  )}
                  <Tooltip tip="Settings" side="bottom">
                    <Button
                      onClick={() => openActionTab("settings")}
                      variant="ghost"
                      size="icon"
                      className="ui-icon-button h-8 w-8"
                      aria-label="Settings"
                    >
                      <Settings className="h-4 w-4" />
                    </Button>
                  </Tooltip>
                  <Tooltip tip="Tags" side="bottom">
                    <Button
                      onClick={() => openActionTab("tags")}
                      variant="ghost"
                      size="icon"
                      className="ui-icon-button h-8 w-8"
                      aria-label="Tags"
                    >
                      <Tags className="h-4 w-4" />
                    </Button>
                  </Tooltip>
                  <Tooltip tip="Logout" side="bottom">
                    <Button
                      onClick={handleLogout}
                      variant="ghost"
                      size="icon"
                      className="ui-icon-button h-8 w-8"
                      aria-label="Logout"
                    >
                      <LogOut className="h-4 w-4" />
                    </Button>
                  </Tooltip>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
                <div className="space-y-2">
                  <Label htmlFor="zone-select">Domain/Zone</Label>
                  <Select
                    value={selectedZoneId || undefined}
                    onValueChange={(value) => {
                      setSelectedZoneId(value);
                      openZoneTab(value);
                    }}
                  >
                    <SelectTrigger className="bg-card/70 border-border text-foreground">
                      <SelectValue placeholder="Select a domain" />
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
                        {activeTab.records.length} records
                      </div>
                      <div className="rounded-md border border-border bg-card/60 px-3 py-2 text-foreground/80">
                        {filteredRecords.length} visible
                      </div>
                      <div className="rounded-md border border-border bg-card/60 px-3 py-2 text-foreground/80">
                        Zone: {selectedZoneData?.name ?? activeTab.zoneName}
                      </div>
                    </div>
                  )}
              </div>
              {(tabs.length > 0 || activeTab?.kind === "settings" || activeTab?.kind === "audit") && (
                <div
                  className="flex flex-wrap gap-2 fade-in"
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
                          "ui-tab cursor-pointer hover:cursor-pointer",
                          dragTabId === tab.id && "cursor-grabbing",
                          dragOverId === tab.id && "ring-1 ring-primary/30",
                        )}
                      >
                        <span className="cursor-grab active:cursor-grabbing">
                          <GripVertical className="h-3 w-3 text-muted-foreground/60" />
                        </span>
                        <span className="max-w-[140px] truncate">
                          {tab.zoneName}
                        </span>
                        {tab.kind === "zone" && (
                          <span className="text-[10px] uppercase tracking-widest opacity-60">
                            {tab.status ?? "zone"}
                          </span>
                        )}
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            closeTab(tab.id);
                          }}
                          className="ui-icon-button ml-1 h-5 w-5 p-0 text-muted-foreground/80 hover:text-foreground"
                          aria-label="Close tab"
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
                    {activeTab.zoneName}
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
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}
            </CardHeader>
            <CardContent>
              {activeTab.kind === "zone" && actionTab === "records" && (
                <div className="space-y-4 fade-in">
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
                        <SelectValue placeholder="All types" />
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
                        <SelectValue placeholder="Per page" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="25">25</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                        <SelectItem value="200">200</SelectItem>
                        <SelectItem value="500">500</SelectItem>
                        <SelectItem value="0">All</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-2 justify-start md:justify-end">
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
                        Clear
                      </Button>
                      <div className="inline-flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-xs">
                        <Filter className="h-3 w-3" />
                        Page {activeTab.page}
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
                        Prev
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
                        Next
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
                      prefillType={activeTab.typeFilter}
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
                      Copy selected
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handlePasteRecords}
                      disabled={!copyBuffer}
                    >
                      <ClipboardPaste className="h-4 w-4 mr-2" />
                      Paste {copyBuffer ? `${copyBuffer.records.length}` : ""}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="outline">
                          <Columns2 className="h-4 w-4 mr-2" />
                          Columns
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem disabled>
                          <span className="flex items-center gap-2">
                            <Columns2 className="h-4 w-4" />
                            Columns
                          </span>
                        </DropdownMenuItem>
                        {activeTab.kind === "zone" && (
                          <>
                            <DropdownMenuItem disabled>
                              Scope: {zoneColumnsOverrideEnabled ? "This zone" : "Global"}
                            </DropdownMenuItem>
                            <DropdownMenuCheckboxItem
                              checked={zoneColumnsOverrideEnabled}
                              onCheckedChange={(checked) => {
                                if (activeTab.kind !== "zone") return;
                                if (checked === true) {
                                  setZoneRecordTableColumns((prev) => ({
                                    ...prev,
                                    [activeTab.zoneId]: [...globalRecordTableColumns],
                                  }));
                                  notifySaved("Column preferences now override for this zone.");
                                  return;
                                }
                                setZoneRecordTableColumns((prev) => {
                                  const next = { ...prev };
                                  delete next[activeTab.zoneId];
                                  return next;
                                });
                                notifySaved("Zone column preferences set to inherit global.");
                              }}
                            >
                              Override for this zone
                            </DropdownMenuCheckboxItem>
                          </>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuCheckboxItem
                          checked={resolvedRecordTableColumns.includes("content")}
                          onCheckedChange={(checked) =>
                            setColumnEnabled("content", checked === true)
                          }
                        >
                          Content
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={resolvedRecordTableColumns.includes("comment")}
                          onCheckedChange={(checked) =>
                            setColumnEnabled("comment", checked === true)
                          }
                        >
                          Comment
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={resolvedRecordTableColumns.includes("tags")}
                          onCheckedChange={(checked) =>
                            setColumnEnabled("tags", checked === true)
                          }
                        >
                          Tags
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={resolvedRecordTableColumns.includes("ttl")}
                          onCheckedChange={(checked) =>
                            setColumnEnabled("ttl", checked === true)
                          }
                        >
                          TTL
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={resolvedRecordTableColumns.includes("proxied")}
                          onCheckedChange={(checked) =>
                            setColumnEnabled("proxied", checked === true)
                          }
                        >
                          Proxy
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={resolvedRecordTableColumns.includes("actions")}
                          onCheckedChange={(checked) =>
                            setColumnEnabled("actions", checked === true)
                          }
                        >
                          Actions
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {copyBuffer && (
                      <div className="text-xs text-muted-foreground">
                        Buffer: {copyBuffer.records.length} from {" "}
                        {copyBuffer.sourceZoneName}
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
                        Clear selection
                      </Button>
                    )}
                  </div>
                  {activeTab.isLoading ? (
                    <div className="text-center py-8">Loading...</div>
                  ) : filteredRecords.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      {t("No DNS records found", "No DNS records found")}
                    </div>
                  ) : (
                    <div className="glass-surface glass-sheen glass-fade-table ui-table rounded-xl">
                      <div
                        className="ui-table-head"
                        style={{ gridTemplateColumns: recordTableGridTemplate }}
                      >
                        {resolvedRecordTableColumns.map((colId) => {
                          const sortKey: SortKey | null = (() => {
                            switch (colId) {
                              case "type":
                                return "type";
                              case "name":
                                return "name";
                              case "content":
                                return "content";
                              case "comment":
                                return "comment";
                              case "tags":
                                return "tags";
                              case "ttl":
                                return "ttl";
                              case "proxied":
                                return "proxied";
                              default:
                                return null;
                            }
                          })();

                          const label = (() => {
                            switch (colId) {
                              case "select":
                                return "";
                              case "type":
                                return "Type";
                              case "name":
                                return "Name";
                              case "content":
                                return "Content";
                              case "comment":
                                return "Comment";
                              case "tags":
                                return "Tags";
                              case "ttl":
                                return "TTL";
                              case "proxied":
                                return "Proxy";
                              case "actions":
                                return "Actions";
                              default:
                                return colId;
                            }
                          })();

                          const isOver = dragHeaderOverId === colId && dragHeaderId && dragHeaderId !== colId;

                          return (
                            <div
                              key={colId}
                              className={cn(
                                "flex min-w-0 items-center gap-1",
                                colId === "actions" && "justify-end gap-2",
                                isOver &&
                                  "rounded-md bg-accent/35 shadow-[inset_0_0_0_1px_hsl(var(--primary)_/_0.16)]",
                              )}
                              onDragOver={onHeaderDragOver(colId)}
                              onDrop={onHeaderDrop(colId)}
                            >
                              {colId !== "select" && (
                                <span
                                  className={cn(
                                    "inline-flex items-center text-muted-foreground/80 hover:text-foreground",
                                    "cursor-grab active:cursor-grabbing",
                                  )}
                                  draggable
                                  onDragStart={onHeaderDragStart(colId)}
                                  onDragEnd={onHeaderDragEnd}
                                  onClick={(e) => e.preventDefault()}
                                >
                                  <GripVertical className="h-3.5 w-3.5" />
                                </span>
                              )}

                              {sortKey ? (
                                <button
                                  type="button"
                                  className={cn(
                                    "min-w-0 flex-1 text-left hover:text-foreground",
                                    colId === "actions" && "flex-initial text-right",
                                  )}
                                  onClick={() => toggleSort(sortKey)}
                                >
                                  {label}{" "}
                                  <span className="opacity-70">{sortIndicator(sortKey)}</span>
                                </button>
                              ) : (
                                <span className={cn("min-w-0", colId === "actions" && "text-right")}>
                                  {label}
                                </span>
                              )}
                            </div>
                          );
                        })}
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
                            columns={resolvedRecordTableColumns}
                            gridTemplateColumns={recordTableGridTemplate}
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
                            onDelete={() => requestDeleteRecord(record.id)}
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
                        Import Records
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Bring in records from CSV, JSON, or BIND zone files.
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
                              title: "Success",
                              description: `Server export ${format.toUpperCase()} completed`,
                            });
                          } catch (err) {
                            toast({
                              title: "Error",
                              description:
                                "Server export failed: " +
                                (err as Error).message,
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
                        Export Records
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Download zone data locally or run server-side exports.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          onClick={() => handleExport("json")}
                        >
                          <FileDown className="h-4 w-4 mr-2" />
                          Export JSON
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => handleExport("csv")}
                        >
                          <FileDown className="h-4 w-4 mr-2" />
                          Export CSV
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => handleExport("bind")}
                        >
                          <FileDown className="h-4 w-4 mr-2" />
                          Export BIND
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => setActionTab("records")}
                        >
                          <FileUp className="h-4 w-4 mr-2" />
                          Back to records
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
              {activeTab.kind === "zone" && actionTab === "zone-settings" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">Zone settings</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Per-page override</div>
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
                                `Zone per-page set to inherit (${globalPerPage}).`,
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
                            notifySaved(`Zone per-page set to ${value}.`);
                          }}
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue placeholder="Per page" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">
                              Inherit ({globalPerPage})
                            </SelectItem>
                            <SelectItem value="25">25</SelectItem>
                            <SelectItem value="50">50</SelectItem>
                            <SelectItem value="100">100</SelectItem>
                            <SelectItem value="200">200</SelectItem>
                            <SelectItem value="500">500</SelectItem>
                            <SelectItem value="0">All</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="text-xs text-muted-foreground">
                          Overrides the global default for this zone only.
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        Unsupported record types
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
                                `Zone unsupported record types set to inherit (${
                                  showUnsupportedRecordTypes ? "show" : "hide"
                                }).`,
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
                                ? "Zone will show unsupported record types in Add Record."
                                : "Zone will hide unsupported record types in Add Record.",
                            );
                          }}
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue placeholder="Inherit" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">
                              Inherit ({showUnsupportedRecordTypes ? "Show" : "Hide"})
                            </SelectItem>
                            <SelectItem value="hide">Hide</SelectItem>
                            <SelectItem value="show">Show</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="text-xs text-muted-foreground">
                          Controls whether non-Cloudflare record types appear in the Type dropdown for this zone.
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        Confirm record delete
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Select
                          value={
                            Object.prototype.hasOwnProperty.call(
                              zoneConfirmDeleteRecord,
                              activeTab.zoneId,
                            )
                              ? zoneConfirmDeleteRecord[activeTab.zoneId]
                                ? "confirm"
                                : "no-confirm"
                              : "inherit"
                          }
                          onValueChange={(v) => {
                            if (v === "inherit") {
                              setZoneConfirmDeleteRecord((prev) => {
                                const next = { ...prev };
                                delete next[activeTab.zoneId];
                                return next;
                              });
                              notifySaved(
                                `Zone delete confirmation set to inherit (${
                                  confirmDeleteRecord ? "confirm" : "no-confirm"
                                }).`,
                              );
                              return;
                            }
                            const enabled = v === "confirm";
                            setZoneConfirmDeleteRecord((prev) => ({
                              ...prev,
                              [activeTab.zoneId]: enabled,
                            }));
                            notifySaved(
                              enabled
                                ? "Zone will confirm single-record deletion."
                                : "Zone will delete single records without confirmation.",
                            );
                          }}
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue placeholder="Inherit" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">
                              Inherit ({confirmDeleteRecord ? "Confirm" : "No confirm"})
                            </SelectItem>
                            <SelectItem value="confirm">Confirm</SelectItem>
                            <SelectItem value="no-confirm">No confirm</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="text-xs text-muted-foreground">
                          Controls whether deleting a single record prompts a confirmation for this zone.
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Reopen on launch</div>
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
                                ? "Zone will reopen on launch."
                                : "Zone will not reopen on launch.",
                            );
                          }}
                        />
                        <div className="text-xs text-muted-foreground">
                          Controls whether this zone restores when tabs reopen.
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Record table columns</div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Select
                          value={zoneColumnsOverrideEnabled ? "custom" : "inherit"}
                          onValueChange={(v) => {
                            if (v === "inherit") {
                              setZoneRecordTableColumns((prev) => {
                                const next = { ...prev };
                                delete next[activeTab.zoneId];
                                return next;
                              });
                              notifySaved("Zone columns set to inherit global.");
                              return;
                            }
                            setZoneRecordTableColumns((prev) => ({
                              ...prev,
                              [activeTab.zoneId]:
                                prev[activeTab.zoneId] ?? [...globalRecordTableColumns],
                            }));
                            notifySaved("Zone columns now override global.");
                          }}
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue placeholder="Inherit" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">Inherit (global)</SelectItem>
                            <SelectItem value="custom">Custom (this zone)</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="text-xs text-muted-foreground">
                          Customize from the Records tab → Columns.
                        </div>
                      </div>
                    </div>

                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "cache" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">Cache</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm text-muted-foreground">
                        Cloudflare cache controls for {activeTab.zoneName}.
                      </div>
                      {cacheSettingsLoading && (
                        <div className="text-xs text-muted-foreground">Loading…</div>
                      )}
                    </div>
                    {cacheSettingsError && (
                      <div className="text-xs text-destructive">{cacheSettingsError}</div>
                    )}

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Development mode</div>
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
                          <div className="text-xs text-muted-foreground">Unavailable.</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Temporarily bypasses cache (Cloudflare may auto-disable after a few hours).
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Cache level</div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneCacheLevel ? (
                          <Select
                            value={zoneCacheLevel.value ?? "basic"}
                            onValueChange={(v) => handleSetCacheLevel(v)}
                            disabled={!apiKey || cacheSettingsLoading}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue placeholder="Cache level" />
                            </SelectTrigger>
                            <SelectContent>
                              {zoneCacheLevel.value &&
                              !["basic", "aggressive", "simplified"].includes(
                                zoneCacheLevel.value,
                              ) ? (
                                <SelectItem value={zoneCacheLevel.value}>
                                  {zoneCacheLevel.value} (current)
                                </SelectItem>
                              ) : null}
                              <SelectItem value="basic">Basic</SelectItem>
                              <SelectItem value="aggressive">Aggressive</SelectItem>
                              <SelectItem value="simplified">Simplified</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-xs text-muted-foreground">Unavailable.</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          <div>
                            <span className="font-medium text-foreground/80">Basic</span>: respects origin cache headers.
                          </div>
                          <div>
                            <span className="font-medium text-foreground/80">Aggressive</span>: caches more aggressively where safe.
                          </div>
                          <div>
                            <span className="font-medium text-foreground/80">Simplified</span>: reduces variation by ignoring some request headers.
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Always Online</div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneAlwaysOnline ? (
                          <Switch
                            checked={zoneAlwaysOnline.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleToggleAlwaysOnline(checked)
                            }
                            disabled={!apiKey || cacheSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">Unavailable.</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Serves limited cached pages when the origin is down (availability depends on plan/features).
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Crawler Hints</div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneCrawlerHints ? (
                          <Switch
                            checked={zoneCrawlerHints.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleToggleCrawlerHints(checked)
                            }
                            disabled={!apiKey || cacheSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">Unavailable.</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Adds headers to help search engines crawl faster and reduce server load.
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Browser Cache TTL</div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneBrowserCacheTtl ? (
                          <Select
                            value={String(zoneBrowserCacheTtl.value ?? 0)}
                            onValueChange={(v) => {
                              const n = Number(v);
                              if (Number.isNaN(n)) return;
                              void handleSetBrowserCacheTtl(n);
                            }}
                            disabled={!apiKey || cacheSettingsLoading}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue placeholder="Browser TTL" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="0">Respect existing headers</SelectItem>
                              <SelectItem value="30">30s</SelectItem>
                              <SelectItem value="60">1m</SelectItem>
                              <SelectItem value="300">5m</SelectItem>
                              <SelectItem value="1200">20m</SelectItem>
                              <SelectItem value="3600">1h</SelectItem>
                              <SelectItem value="14400">4h</SelectItem>
                              <SelectItem value="86400">1d</SelectItem>
                              <SelectItem value="604800">7d</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-xs text-muted-foreground">Unavailable.</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Overrides how long browsers cache resources (client-side TTL).
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-start">
                      <div className="font-medium text-sm">Purge cache</div>
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setShowPurgeEverythingConfirm(true)}
                            disabled={!apiKey}
                          >
                            Purge everything
                          </Button>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
                            Purge URLs (one per line)
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
                              Purge URLs…
                            </Button>
                            <div className="text-xs text-muted-foreground">
                              Validations warn, but you can still force purge.
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "ssl-tls" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">SSL/TLS</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm text-muted-foreground">
                        SSL/TLS controls for {activeTab.zoneName}.
                      </div>
                      {sslSettingsLoading && (
                        <div className="text-xs text-muted-foreground">Loading…</div>
                      )}
                    </div>
                    {sslSettingsError && (
                      <div className="text-xs text-destructive">{sslSettingsError}</div>
                    )}

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Encryption mode</div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneSslMode ? (
                          <Select
                            value={zoneSslMode.value ?? "off"}
                            onValueChange={(v) => handleSetSslTlsSetting("ssl", v)}
                            disabled={!apiKey || sslSettingsLoading}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue placeholder="SSL mode" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="off">Off</SelectItem>
                              <SelectItem value="flexible">Flexible</SelectItem>
                              <SelectItem value="full">Full</SelectItem>
                              <SelectItem value="strict">Full (strict)</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-xs text-muted-foreground">Unavailable.</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Controls how Cloudflare connects to your origin.
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Minimum TLS version</div>
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
                              <SelectValue placeholder="Min TLS" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="1.0">1.0</SelectItem>
                              <SelectItem value="1.1">1.1</SelectItem>
                              <SelectItem value="1.2">1.2</SelectItem>
                              <SelectItem value="1.3">1.3</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-xs text-muted-foreground">Unavailable.</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Affects client connections to Cloudflare edge.
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">TLS 1.3</div>
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
                          <div className="text-xs text-muted-foreground">Unavailable.</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Enables TLS 1.3 for client connections.
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Always Use HTTPS</div>
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
                          <div className="text-xs text-muted-foreground">Unavailable.</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Redirect HTTP to HTTPS at the edge.
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Automatic HTTPS Rewrites</div>
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
                          <div className="text-xs text-muted-foreground">Unavailable.</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Rewrites mixed content links to HTTPS when possible.
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">Opportunistic encryption</div>
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
                          <div className="text-xs text-muted-foreground">Unavailable.</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Enables opportunistic encryption to the edge when supported.
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "dns-options" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">DNS options</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm text-muted-foreground">
                        DNSSEC and related settings for {activeTab.zoneName}.
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleFetchDnssec()}
                          disabled={!apiKey || dnsOptionsLoading}
                        >
                          Refresh
                        </Button>
                      </div>
                    </div>

                    {dnsOptionsError && (
                      <div className="text-xs text-destructive">{dnsOptionsError}</div>
                    )}

                    <div className="rounded-xl border border-border/60 bg-card/60 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-semibold">DNSSEC</div>
                        {dnsOptionsLoading && (
                          <div className="text-xs text-muted-foreground">Loading…</div>
                        )}
                      </div>
                      {dnssecInfo ? (
                        <div className="mt-3 space-y-3">
                          <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                            <div className="font-medium text-sm">Status</div>
                            <div className="flex flex-wrap items-center gap-3">
                              <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-1 text-xs">
                                {String((dnssecInfo as { status?: unknown }).status ?? "unknown")}
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  void handleUpdateDnssec({
                                    status:
                                      (dnssecInfo as { status?: unknown }).status === "active"
                                        ? "disabled"
                                        : "active",
                                  })
                                }
                                disabled={!apiKey || dnsOptionsLoading}
                              >
                                {(dnssecInfo as { status?: unknown }).status === "active"
                                  ? "Disable"
                                  : "Enable"}
                              </Button>
                              <div className="text-xs text-muted-foreground">
                                Enabling DNSSEC publishes DS details for your registrar.
                              </div>
                            </div>
                          </div>

                          <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                            <div className="font-medium text-sm">Multi-signer DNSSEC</div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Switch
                                checked={
                                  (dnssecInfo as { dnssec_multi_signer?: unknown })
                                    .dnssec_multi_signer === true
                                }
                                onCheckedChange={(checked: boolean) =>
                                  void handleUpdateDnssec({ dnssec_multi_signer: checked })
                                }
                                disabled={!apiKey || dnsOptionsLoading}
                              />
                              <div className="text-xs text-muted-foreground">
                                Use multi-signer mode when running DNS with multiple providers.
                              </div>
                            </div>
                          </div>

                          <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                            <div className="font-medium text-sm">Presigned DNSSEC</div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Switch
                                checked={
                                  (dnssecInfo as { dnssec_presigned?: unknown })
                                    .dnssec_presigned === true
                                }
                                onCheckedChange={(checked: boolean) =>
                                  void handleUpdateDnssec({ dnssec_presigned: checked })
                                }
                                disabled={!apiKey || dnsOptionsLoading}
                              />
                              <div className="text-xs text-muted-foreground">
                                For secondary/multi-provider setups with an external signer.
                              </div>
                            </div>
                          </div>

                          <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                            <div className="font-medium text-sm">Use NSEC3</div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Switch
                                checked={
                                  (dnssecInfo as { dnssec_use_nsec3?: unknown })
                                    .dnssec_use_nsec3 === true
                                }
                                onCheckedChange={(checked: boolean) =>
                                  void handleUpdateDnssec({ dnssec_use_nsec3: checked })
                                }
                                disabled={!apiKey || dnsOptionsLoading}
                              />
                              <div className="text-xs text-muted-foreground">
                                Uses NSEC3 for authenticated denial of existence (if supported).
                              </div>
                            </div>
                          </div>

                          <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-start">
                            <div className="font-medium text-sm">DS record</div>
                            <div className="space-y-1">
                              <div className="text-xs text-muted-foreground">
                                Registrar DS values (copy/paste).
                              </div>
                              <pre className="whitespace-pre-wrap break-all rounded-lg border border-border/60 bg-muted/20 p-3 text-[11px] leading-5 text-foreground/90">
                                {String((dnssecInfo as { ds?: unknown }).ds ?? "—")}
                              </pre>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-3 text-sm text-muted-foreground">
                          DNSSEC info unavailable.
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "audit" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <CardTitle className="text-lg">Audit log</CardTitle>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          onClick={() => loadAuditEntries()}
                        >
                          Refresh
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setShowClearAuditConfirm(true)}
                          disabled={!isDesktop() || auditEntries.length === 0}
                        >
                          Clear logs
                        </Button>
                        <Button
                          variant="outline"
                          onClick={async () => {
                            if (!isDesktop()) return;
                            const data = await TauriClient.exportAuditEntries("json");
                            const blob = new Blob([data], { type: "application/json" });
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement("a");
                            link.href = url;
                            link.download = "audit-log.json";
                            link.click();
                            URL.revokeObjectURL(url);
                          }}
                          disabled={!isDesktop() || auditEntries.length === 0}
                        >
                          Export JSON
                        </Button>
                        <Button
                          variant="outline"
                          onClick={async () => {
                            if (!isDesktop()) return;
                            const data = await TauriClient.exportAuditEntries("csv");
                            const blob = new Blob([data], { type: "text/csv" });
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement("a");
                            link.href = url;
                            link.download = "audit-log.csv";
                            link.click();
                            URL.revokeObjectURL(url);
                          }}
                          disabled={!isDesktop() || auditEntries.length === 0}
                        >
                          Export CSV
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-[1fr_200px_200px]">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          placeholder="Search audit entries"
                          value={auditSearch}
                          onChange={(e) => setAuditSearch(e.target.value)}
                          className="pl-9"
                        />
                      </div>
                      <Select value={auditType} onValueChange={setAuditType}>
                        <SelectTrigger>
                          <SelectValue placeholder="Type" />
                        </SelectTrigger>
                        <SelectContent>
                          {auditTypeOptions.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option === "all" ? "All types" : option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={auditResource} onValueChange={setAuditResource}>
                        <SelectTrigger>
                          <SelectValue placeholder="Resource" />
                        </SelectTrigger>
                        <SelectContent>
                          {auditResourceOptions.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option === "all" ? "All resources" : option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[200px_200px]">
                      <Select value={auditOrder} onValueChange={setAuditOrder}>
                        <SelectTrigger>
                          <SelectValue placeholder="Order" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="newest">Newest first</SelectItem>
                          <SelectItem value="oldest">Oldest first</SelectItem>
                          <SelectItem value="operation">Operation A–Z</SelectItem>
                          <SelectItem value="resource">Resource A–Z</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select value={auditLimit} onValueChange={setAuditLimit}>
                        <SelectTrigger>
                          <SelectValue placeholder="Limit" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="50">50</SelectItem>
                          <SelectItem value="100">100</SelectItem>
                          <SelectItem value="250">250</SelectItem>
                          <SelectItem value="500">500</SelectItem>
                          <SelectItem value="1000">1000</SelectItem>
                          <SelectItem value="all">All</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {!isDesktop() && (
                      <div className="text-xs text-muted-foreground">
                        Audit log is only available in the desktop app.
                      </div>
                    )}
                    {auditLoading && (
                      <div className="text-sm text-muted-foreground">Loading audit entries…</div>
                    )}
                    {auditError && (
                      <div className="text-sm text-destructive">{auditError}</div>
                    )}
                    {!auditLoading && !auditError && limitedAuditEntries.length === 0 && (
                      <div className="text-sm text-muted-foreground">
                        No audit entries match the current filters.
                      </div>
                    )}
                    {!auditLoading && !auditError && limitedAuditEntries.length > 0 && (
                      <div className="overflow-auto rounded-lg border border-border/60">
                      <div className="grid grid-cols-[160px_160px_1fr_80px] gap-3 border-b border-border/60 bg-muted/50 px-4 py-2 text-[11px] uppercase tracking-widest text-muted-foreground">
                          <div>Timestamp</div>
                          <div>Operation</div>
                          <div>Resource</div>
                          <div>Details</div>
                        </div>
                        <div className="divide-y divide-white/10">
                          {limitedAuditEntries.map((entry, index) => {
                            const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "unknown";
                            const operation = typeof entry.operation === "string" ? entry.operation : "operation";
                            const resource = typeof entry.resource === "string" ? entry.resource : "resource";
                            return (
                              <details key={`${timestamp}-${index}`} className="px-4 py-3 text-sm">
                                <summary className="grid grid-cols-[160px_160px_1fr_80px] gap-3 cursor-pointer list-none">
                                  <div className="text-xs text-muted-foreground">
                                    {timestamp}
                                  </div>
                                  <div className="font-medium">{operation}</div>
                                  <div className="truncate text-muted-foreground">
                                    {resource}
                                  </div>
                                  <div className="text-xs text-muted-foreground hover:text-foreground">
                                    View
                                  </div>
                                </summary>
                                <div className="mt-3 rounded-md border border-border/60 bg-card/60 p-3 text-xs text-muted-foreground">
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
                    <CardTitle className="text-lg">Tag manager</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-[180px_1fr] md:items-center">
                      <div className="font-medium">Zone</div>
                      <Select
                        value={tagsZoneId || undefined}
                        onValueChange={(value) => {
                          setTagsZoneId(value);
                          setRenameTagFrom(null);
                          setRenameTagTo("");
                        }}
                      >
                        <SelectTrigger className="w-72">
                          <SelectValue placeholder="Select a zone" />
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
                        Select a zone to manage its tags.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            value={newTag}
                            onChange={(e) => setNewTag(e.target.value)}
                            placeholder="New tag"
                            className="h-9 w-56"
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              e.preventDefault();
                              const next = newTag.trim();
                              if (!next) return;
                              storageManager.addZoneTag(tagsZoneId, next);
                              notifySaved(`Tag added: ${next}`);
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
                              notifySaved(`Tag added: ${next}`);
                              setNewTag("");
                            }}
                          >
                            Add tag
                          </Button>
                          <div className="text-xs text-muted-foreground">
                            Tags are local-only and can be attached to records.
                          </div>
                        </div>

                        <div className="glass-surface glass-sheen glass-fade rounded-xl overflow-hidden">
                          <div className="grid grid-cols-[1fr_90px_160px] gap-2 px-3 py-2 text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border/60">
                            <div>Tag</div>
                            <div className="text-right">Used</div>
                            <div className="text-right">Actions</div>
                          </div>
                          {zoneTags.length === 0 ? (
                            <div className="px-3 py-6 text-sm text-muted-foreground">
                              No tags yet. Add one above or create tags from a record’s expanded panel.
                            </div>
                          ) : (
                            <div className="divide-y divide-white/10">
                              {zoneTags.map((tag) => (
                                <div
                                  key={tag}
                                  className="grid grid-cols-[1fr_90px_160px] items-center gap-2 px-3 py-2"
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
                                          notifySaved(`Tag renamed: ${tag} → ${next}`);
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
                                            notifySaved(`Tag renamed: ${tag} → ${next}`);
                                            setRenameTagFrom(null);
                                            setRenameTagTo("");
                                          }}
                                        >
                                          Save
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
                                          Cancel
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
                                          Rename
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="destructive"
                                          className="h-8"
                                          onClick={() => {
                                            storageManager.deleteTag(tagsZoneId, tag);
                                            notifySaved(`Tag deleted: ${tag}`);
                                          }}
                                        >
                                          Delete
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "settings" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      Session settings
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="divide-y divide-white/10 rounded-xl border border-border/60 bg-card/60 text-sm">
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">Auto refresh</div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Select
                            value={String(autoRefreshInterval ?? 0)}
                            onValueChange={(v) => {
                              const next = v ? Number(v) : 0;
                              setAutoRefreshInterval(next ? next : null);
                              notifySaved(
                                next
                                  ? `Auto refresh set to ${next / 1000}s.`
                                  : "Auto refresh off.",
                              );
                            }}
                          >
                            <SelectTrigger className="w-44">
                              <SelectValue placeholder="Auto-refresh" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="0">Off</SelectItem>
                              <SelectItem value="60000">1 min</SelectItem>
                              <SelectItem value="300000">5 min</SelectItem>
                              <SelectItem value="600000">10 min</SelectItem>
                              <SelectItem value="1800000">30 min</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="text-xs text-muted-foreground">
                            Pauses while editing records or dialogs are open.
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">Default per-page</div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Select
                            value={String(globalPerPage)}
                            onValueChange={(v) => {
                              const value = Number(v);
                              const next = Number.isNaN(value) ? 50 : value;
                              setGlobalPerPage(next);
                              notifySaved(`Default per-page set to ${next}.`);
                            }}
                          >
                            <SelectTrigger className="w-44">
                              <SelectValue placeholder="Per page" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="25">25</SelectItem>
                              <SelectItem value="50">50</SelectItem>
                              <SelectItem value="100">100</SelectItem>
                              <SelectItem value="200">200</SelectItem>
                              <SelectItem value="500">500</SelectItem>
                              <SelectItem value="0">All</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="text-xs text-muted-foreground">
                            New zone tabs inherit this value unless overridden.
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">Record columns</div>
                        <div className="flex flex-wrap items-center gap-3">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="sm" variant="outline">
                                <Columns2 className="h-4 w-4 mr-2" />
                                Configure…
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem disabled>
                                <span className="flex items-center gap-2">
                                  <Columns2 className="h-4 w-4" />
                                  Global columns
                                </span>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuCheckboxItem
                                checked={resolvedRecordTableColumns.includes("content")}
                                onCheckedChange={(checked) =>
                                  setColumnEnabled("content", checked === true)
                                }
                              >
                                Content
                              </DropdownMenuCheckboxItem>
                              <DropdownMenuCheckboxItem
                                checked={resolvedRecordTableColumns.includes("comment")}
                                onCheckedChange={(checked) =>
                                  setColumnEnabled("comment", checked === true)
                                }
                              >
                                Comment
                              </DropdownMenuCheckboxItem>
                              <DropdownMenuCheckboxItem
                                checked={resolvedRecordTableColumns.includes("tags")}
                                onCheckedChange={(checked) =>
                                  setColumnEnabled("tags", checked === true)
                                }
                              >
                                Tags
                              </DropdownMenuCheckboxItem>
                              <DropdownMenuCheckboxItem
                                checked={resolvedRecordTableColumns.includes("ttl")}
                                onCheckedChange={(checked) =>
                                  setColumnEnabled("ttl", checked === true)
                                }
                              >
                                TTL
                              </DropdownMenuCheckboxItem>
                              <DropdownMenuCheckboxItem
                                checked={resolvedRecordTableColumns.includes("proxied")}
                                onCheckedChange={(checked) =>
                                  setColumnEnabled("proxied", checked === true)
                                }
                              >
                                Proxy
                              </DropdownMenuCheckboxItem>
                              <DropdownMenuCheckboxItem
                                checked={resolvedRecordTableColumns.includes("actions")}
                                onCheckedChange={(checked) =>
                                  setColumnEnabled("actions", checked === true)
                                }
                              >
                                Actions
                              </DropdownMenuCheckboxItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                          <div className="text-xs text-muted-foreground">
                            Applies to all zones unless overridden in Zone Settings.
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">Unsupported record types</div>
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={showUnsupportedRecordTypes}
                            onCheckedChange={(checked: boolean) => {
                              setShowUnsupportedRecordTypes(checked);
                              notifySaved(
                                checked
                                  ? "Unsupported record types will show in Add Record."
                                  : "Add Record will show Cloudflare-supported types only.",
                              );
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            Controls the Type dropdown default. Zones can override this.
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">Confirm record delete</div>
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={confirmDeleteRecord}
                            onCheckedChange={(checked: boolean) => {
                              setConfirmDeleteRecord(checked);
                              notifySaved(
                                checked
                                  ? "Delete confirmation enabled."
                                  : "Delete confirmation disabled.",
                              );
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            Adds a confirmation dialog when deleting a single record.
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">Reopen last tabs</div>
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={reopenLastTabs}
                            onCheckedChange={(checked: boolean) => {
                              setReopenLastTabs(checked);
                              notifySaved(
                                checked
                                  ? "Will reopen last tabs on launch."
                                  : "Will not reopen last tabs on launch.",
                              );
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            Restore tabs from the last session on launch.
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">Confirm logout</div>
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={confirmLogout}
                            onCheckedChange={(checked: boolean) => {
                              setConfirmLogout(checked);
                              notifySaved(
                                checked
                                  ? "Logout confirmation enabled."
                                  : "Logout confirmation disabled.",
                              );
                            }}
                          />
                          <div className="text-xs text-muted-foreground">
                            Show a confirmation dialog when logging out.
                          </div>
                        </div>
                      </div>
                      {isDesktop() && (
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">Confirm window close</div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={confirmWindowClose}
                              onCheckedChange={(checked: boolean) => {
                                setConfirmWindowClose(checked);
                                notifySaved(
                                  checked
                                    ? "Window close confirmation enabled."
                                    : "Window close confirmation disabled.",
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              Show a confirmation dialog when closing the app window.
                            </div>
                          </div>
                        </div>
                      )}
                      <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                        <div className="font-medium">Auto logout (idle)</div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Select
                            value={String(idleLogoutMs ?? 0)}
                            onValueChange={(v) => {
                              const next = Number(v);
                              setIdleLogoutMs(next ? next : null);
                              notifySaved(
                                next
                                  ? `Auto logout after ${Math.round(next / 60000)} min idle.`
                                  : "Auto logout disabled.",
                              );
                            }}
                          >
                            <SelectTrigger className="w-44">
                              <SelectValue placeholder="Idle timeout" />
                            </SelectTrigger>
                            <SelectContent className="bg-popover/70 text-foreground">
                              <SelectItem value="0">Never</SelectItem>
                              <SelectItem value="60000">1 min</SelectItem>
                              <SelectItem value="120000">2 min</SelectItem>
                              <SelectItem value="300000">5 min</SelectItem>
                              <SelectItem value="600000">10 min</SelectItem>
                              <SelectItem value="1800000">30 min</SelectItem>
                              <SelectItem value="3600000">1 hour</SelectItem>
                              <SelectItem value="14400000">4 hours</SelectItem>
                              <SelectItem value="86400000">24 hours</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="text-xs text-muted-foreground">
                            Logs out automatically after inactivity.
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Settings className="h-4 w-4" />
                      Global settings apply to every zone unless overridden.
                    </div>
                    <div className="mt-2 rounded-xl border border-border/60 bg-card/60 p-4">
                      <div className="text-sm font-semibold">Data management</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Reset or clear local settings and data. These actions affect this device.
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setShowResetSettingsConfirm(true)}
                        >
                          Reset to defaults…
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setShowClearSettingsConfirm(true)}
                        >
                          Clear settings…
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setShowClearAllDataConfirm(true)}
                        >
                          Clear all app data…
                        </Button>
                      </div>
                      <div className="mt-2 text-[11px] text-muted-foreground">
                        “Clear settings” wipes preferences then immediately saves defaults again.
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border/60 bg-card/60">
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              Select a zone to open it in a new tab.
            </CardContent>
          </Card>
        )}
      </div>
      <Dialog open={showClearAuditConfirm} onOpenChange={setShowClearAuditConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear audit logs</DialogTitle>
            <DialogDescription>
              This deletes all audit entries stored on this device. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowClearAuditConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={async () => {
                if (!isDesktop()) return;
                await TauriClient.clearAuditEntries();
                setAuditEntries([]);
                setShowClearAuditConfirm(false);
              }}
            >
              Clear logs
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showResetSettingsConfirm}
        onOpenChange={setShowResetSettingsConfirm}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset settings to defaults?</DialogTitle>
            <DialogDescription>
              This resets session settings and clears open tabs. It does not delete API keys.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowResetSettingsConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              onClick={() => {
                setShowResetSettingsConfirm(false);
                void handleResetSettings();
              }}
            >
              Reset
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showClearSettingsConfirm}
        onOpenChange={setShowClearSettingsConfirm}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear settings?</DialogTitle>
            <DialogDescription>
              This clears saved preferences, then immediately re-saves default settings so the app starts from a clean baseline.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowClearSettingsConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={() => {
                setShowClearSettingsConfirm(false);
                void handleClearSettings();
              }}
            >
              Clear settings
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showClearAllDataConfirm}
        onOpenChange={setShowClearAllDataConfirm}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear all app data?</DialogTitle>
            <DialogDescription>
              This deletes local keys, preferences, tags, and other stored data on this device, then logs you out. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowClearAllDataConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={() => {
                setShowClearAllDataConfirm(false);
                void handleClearAllData();
              }}
            >
              Clear all data
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showDeleteRecordConfirm}
        onOpenChange={(open) => {
          setShowDeleteRecordConfirm(open);
          if (!open) setPendingDeleteRecordId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete DNS record?</DialogTitle>
            <DialogDescription>
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {pendingDeleteRecord ? (
            <div className="rounded-lg border border-border/60 bg-card/60 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{pendingDeleteRecord.type}</span>
                <span className="text-muted-foreground">•</span>
                <span className="break-all">{pendingDeleteRecord.name}</span>
              </div>
              <div className="mt-2 break-all text-muted-foreground">
                {pendingDeleteRecord.content}
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Record details unavailable.
            </div>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                setShowDeleteRecordConfirm(false);
                setPendingDeleteRecordId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={confirmDeleteRecordNow}
            >
              Delete
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
            <DialogTitle>Purge entire cache?</DialogTitle>
            <DialogDescription>
              This purges cached content for the active zone. It can temporarily increase origin load.
            </DialogDescription>
          </DialogHeader>
          {activeTab?.kind === "zone" ? (
            <div className="rounded-lg border border-border/60 bg-card/60 p-3 text-xs">
              <div className="font-semibold">{activeTab.zoneName}</div>
              <div className="mt-1 text-muted-foreground">Purge: everything</div>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowPurgeEverythingConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={() => void confirmPurgeEverything()}
            >
              Purge
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={showPurgeUrlsConfirm} onOpenChange={setShowPurgeUrlsConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Purge URLs?</DialogTitle>
            <DialogDescription>
              Cloudflare may reject invalid URLs. You can still attempt to purge anyway.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/60 bg-card/60 p-3 text-xs">
            <div className="font-semibold">
              {pendingPurgeUrls.length} URL(s)
            </div>
            {pendingPurgeIssues.length > 0 ? (
              <div className="mt-2 space-y-1">
                <div className="text-destructive font-medium">Warnings</div>
                <ul className="list-disc pl-4 text-destructive/90">
                  {pendingPurgeIssues.slice(0, 8).map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
                {pendingPurgeIssues.length > 8 ? (
                  <div className="text-muted-foreground">
                    +{pendingPurgeIssues.length - 8} more…
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-2 text-muted-foreground">No issues detected.</div>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowPurgeUrlsConfirm(false)}
            >
              Cancel
            </Button>
            <Button className="flex-1" onClick={() => void confirmPurgeUrls()}>
              Purge
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={showLogoutConfirm} onOpenChange={setShowLogoutConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log out</DialogTitle>
            <DialogDescription>
              Are you sure you want to log out? You’ll need to sign in again to manage records.
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
                    ? "Logout confirmation disabled."
                    : "Logout confirmation enabled.",
                );
              }}
            />
            Don’t ask again
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowLogoutConfirm(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" className="flex-1" onClick={confirmAndLogout}>
              Log out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

