
/**
 * Top-level DNS Manager UI which composes the zone selector, the record
 * list and dialogs for creating/importing records.
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useCloudflareAPI } from "@/hooks/use-cloudflare-api";
import type { DNSRecord, Zone, RecordType } from "@/types/dns";
import { RECORD_TYPES } from "@/types/dns";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { storageManager } from "@/lib/storage";
import {
  ClipboardPaste,
  Copy,
  FileDown,
  FileUp,
  Filter,
  GripVertical,
  LogOut,
  Search,
  Settings,
  Shield,
  X,
} from "lucide-react";
import { isDesktop } from "@/lib/environment";
import { AuditLogDialog } from "@/components/audit/AuditLogDialog";
import { TauriClient } from "@/lib/tauri-client";
import { AddRecordDialog } from "./AddRecordDialog";
import { ImportExportDialog } from "./ImportExportDialog";
import { RecordRow } from "./RecordRow";
import { FixedSizeList as List } from "react-window";
import { filterRecords } from "@/lib/dns-utils";
import { parseCSVRecords, parseBINDZone } from "@/lib/dns-parsers";

// Wrapper to avoid TS issues with react-window FixedSizeList generic types
const VirtualList = (props: any) => {
  const { children, ...rest } = props;
  return <List {...rest}>{children}</List>;
};

type ActionTab = "records" | "import" | "zone-settings";
type TabKind = "zone" | "settings" | "audit";

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

const ACTION_TABS: { id: ActionTab | "zone-settings"; label: string; hint: string }[] = [
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
];
const ACTION_TAB_LABELS: Record<TabKind, string> = {
  zone: "Zone",
  settings: "Settings",
  audit: "Audit",
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
  const [listHeight, setListHeight] = useState(600);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [globalPerPage, setGlobalPerPage] = useState(50);
  const [zonePerPage, setZonePerPage] = useState<Record<string, number>>({});
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number | null>(
    storageManager.getAutoRefreshInterval(),
  );
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [copyBuffer, setCopyBuffer] = useState<{
    records: DNSRecord[];
    sourceZoneId: string;
    sourceZoneName: string;
  } | null>(null);

  const { toast } = useToast();
  const {
    getZones,
    getDNSRecords,
    createDNSRecord,
    updateDNSRecord,
    bulkCreateDNSRecords,
    deleteDNSRecord,
    exportDNSRecords,
  } = useCloudflareAPI(apiKey, email);

  const availableZones = useMemo(
    () => zones.filter((zone) => zone.id),
    [zones],
  );

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );

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
    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) => {
          const prefObj = prefs as {
            last_zone?: string;
            auto_refresh_interval?: number;
            default_per_page?: number;
            zone_per_page?: Record<string, number>;
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
        })
        .catch(() => {});
      return;
    }
    const last = storageManager.getLastZone();
    if (last) setSelectedZoneId(last);
    setGlobalPerPage(storageManager.getDefaultPerPage());
    setZonePerPage(storageManager.getZonePerPageMap());
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
    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) =>
          TauriClient.updatePreferences({
            ...(prefs as Record<string, unknown>),
            default_per_page: globalPerPage,
            zone_per_page: zonePerPage,
          }),
        )
        .catch(() => {});
      return;
    }
    storageManager.setDefaultPerPage(globalPerPage);
    storageManager.setZonePerPageMap(zonePerPage);
  }, [globalPerPage, zonePerPage]);

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
    const updateHeight = () => {
      if (typeof window === "undefined") return;
      const height = Math.max(420, window.innerHeight - 380);
      setListHeight(height);
    };
    updateHeight();
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  const filteredRecords = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return [];
    return filterRecords(activeTab.records, activeTab.searchTerm).filter(
      (record: DNSRecord) =>
        activeTab.typeFilter ? record.type === activeTab.typeFilter : true,
    );
  }, [activeTab]);
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

    try {
      const createdRecord = await createDNSRecord(activeTab.zoneId, draft);
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: [createdRecord, ...prev.records],
        newRecord: createEmptyRecord(),
        showAddRecord: false,
      }));
      toast({
        title: "Success",
        description: "DNS record created successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create DNS record: " + (error as Error).message,
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
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.map((r) =>
          r.id === record.id ? updatedRecord : r,
        ),
        editingRecord: null,
      }));
      toast({
        title: "Success",
        description: "DNS record updated successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update DNS record: " + (error as Error).message,
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
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.map((r) =>
          r.id === record.id ? updatedRecord : r,
        ),
      }));
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update proxy: " + (error as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleDeleteRecord = async (recordId: string) => {
    if (!activeTab) return;
    try {
      await deleteDNSRecord(activeTab.zoneId, recordId);
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.filter((r) => r.id !== recordId),
        selectedIds: prev.selectedIds.filter((id) => id !== recordId),
      }));
      toast({
        title: "Success",
        description: "DNS record deleted successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete DNS record: " + (error as Error).message,
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
      title: "Success",
      description: `Records exported as ${format.toUpperCase()}`,
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

  const handleLogout = () => {
    storageManager.clearSession();
    onLogout();
  };

  const selectedZoneData = activeTab
    ? availableZones.find((z) => z.id === activeTab.zoneId)
    : undefined;
  const actionHint = ACTION_TABS.find((tab) => tab.id === actionTab)?.hint;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(255,120,40,0.08),transparent_55%),radial-gradient(circle_at_bottom,rgba(20,20,35,0.6),transparent_60%)] p-4 text-foreground">
      <div className="max-w-6xl mx-auto space-y-6 pb-10 fade-in-up">
        <div className="sticky top-0 z-20">
          <Card className="border-white/10 bg-gradient-to-br from-slate-950/85 via-slate-900/70 to-orange-950/35 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur">
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
                  <Button
                    onClick={() => openActionTab("audit")}
                    variant="outline"
                    size="icon"
                    className="border-orange-500/20 text-orange-100/70 hover:border-orange-400/50 hover:text-orange-100 hover:shadow-[0_0_18px_rgba(255,120,70,0.25)] transition"
                    aria-label="Audit Log"
                    title="Audit Log"
                  >
                    <Shield className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  onClick={() => openActionTab("settings")}
                  variant="outline"
                  size="icon"
                  className="border-orange-500/20 text-orange-100/70 hover:border-orange-400/50 hover:text-orange-100 hover:shadow-[0_0_18px_rgba(255,120,70,0.25)] transition"
                  aria-label="Settings"
                  title="Settings"
                >
                  <Settings className="h-4 w-4" />
                </Button>
                <Button
                  onClick={handleLogout}
                  variant="outline"
                  size="icon"
                  className="border-orange-500/20 text-orange-100/70 hover:border-orange-400/50 hover:text-orange-100 hover:shadow-[0_0_18px_rgba(255,120,70,0.25)] transition"
                  aria-label="Logout"
                  title="Logout"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
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
                  <SelectTrigger className="bg-black/30 border-white/10 text-orange-50 focus:ring-orange-500/40">
                    <SelectValue placeholder="Select a domain" />
                  </SelectTrigger>
                  <SelectContent className="bg-black/90 border border-orange-500/20 text-orange-100">
                    {availableZones.map((zone: Zone) => (
                      <SelectItem
                        key={zone.id}
                        value={zone.id}
                        className="cursor-pointer focus:bg-orange-500/20 focus:text-orange-100"
                      >
                        {zone.name} ({zone.status})
                      </SelectItem>
                    ))}
                    </SelectContent>
                  </Select>
                </div>
                {activeTab && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <div className="rounded-md border border-white/10 bg-black/30 px-3 py-2">
                      {activeTab.records.length} records
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/30 px-3 py-2">
                      {filteredRecords.length} visible
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/30 px-3 py-2">
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
                        className={`group flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition cursor-grab ${
                          isActive
                            ? "border-orange-400/40 bg-orange-500/15 text-orange-100 shadow-[0_0_18px_rgba(255,120,60,0.18)]"
                            : "border-white/10 bg-black/20 text-muted-foreground hover:border-orange-400/30 hover:text-orange-100"
                        } ${dragOverId === tab.id ? "ring-1 ring-orange-400/40" : ""}`}
                      >
                        <GripVertical className="h-3 w-3 text-muted-foreground/60" />
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
                          className="ml-1 rounded-full p-0.5 text-muted-foreground transition hover:text-orange-200"
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
          <Card className="min-h-[70vh] border-white/10 bg-black/30 shadow-[0_20px_40px_rgba(0,0,0,0.2)] fade-in">
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
                <div className="flex flex-wrap items-center gap-2">
                  {activeTab.kind === "zone" && (
                    <Select
                      value={String(autoRefreshInterval ?? 0)}
                      onValueChange={(v) =>
                        setAutoRefreshInterval(v ? Number(v) : null)
                      }
                    >
                      <SelectTrigger className="w-36">
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
                  )}
                </div>
              </div>
              {activeTab.kind === "zone" && (
                <div className="flex flex-wrap gap-2 rounded-xl border border-white/10 bg-black/40 p-1 fade-in">
                  {ACTION_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActionTab(tab.id)}
                      className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-medium transition ${
                        actionTab === tab.id
                          ? "bg-orange-500/20 text-orange-100 shadow-[0_0_12px_rgba(255,80,0,0.2)]"
                          : "text-muted-foreground hover:text-orange-100"
                      }`}
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
                          className="rounded-xl border border-white/10 bg-black/20 p-4"
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
                      <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs">
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
                    <div className="space-y-2">
                      <VirtualList
                        height={Math.min(
                          listHeight,
                          filteredRecords.length * 88,
                        )}
                        itemCount={filteredRecords.length}
                        itemSize={88}
                        width={"100%"}
                      >
                        {({
                          index,
                          style,
                        }: {
                          index: number;
                          style: React.CSSProperties;
                        }) => {
                          const record = filteredRecords[index];
                          const isSelected = activeTab.selectedIds.includes(
                            record.id,
                          );
                          return (
                            <div style={style} key={record.id}>
                              <RecordRow
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
                            </div>
                          );
                        }}
                      </VirtualList>
                    </div>
                  )}
                </div>
              )}
              {activeTab.kind === "zone" && actionTab === "import" && (
                <div className="grid gap-4 md:grid-cols-2">
                  <Card className="border-white/10 bg-black/40">
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
                  <Card className="border-white/10 bg-black/40">
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
                <Card className="border-white/10 bg-black/40">
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
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "audit" && (
                <Card className="border-white/10 bg-black/40">
                  <CardHeader>
                    <CardTitle className="text-lg">Audit log</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Review sensitive actions recorded by the desktop backend.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => setShowAuditLog(true)}
                      disabled={!isDesktop()}
                    >
                      Open audit log
                    </Button>
                    {!isDesktop() && (
                      <div className="text-xs text-muted-foreground">
                        Audit log is only available in the desktop app.
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "settings" && (
                <Card className="border-white/10 bg-black/40">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      Session settings
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="divide-y divide-white/10 rounded-xl border border-white/10 bg-black/30 text-sm">
                    <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                      <div className="font-medium">Auto refresh</div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Select
                            value={String(autoRefreshInterval ?? 0)}
                            onValueChange={(v) =>
                              setAutoRefreshInterval(v ? Number(v) : null)
                            }
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
                              setGlobalPerPage(Number.isNaN(value) ? 50 : value);
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
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Settings className="h-4 w-4" />
                      Global settings apply to every zone unless overridden.
                    </div>
                  </CardContent>
                </Card>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-white/10 bg-black/30">
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              Select a zone to open it in a new tab.
            </CardContent>
          </Card>
        )}
      </div>
      <AuditLogDialog open={showAuditLog} onOpenChange={setShowAuditLog} />
    </div>
  );
}
