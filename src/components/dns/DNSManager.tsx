/**
 * Top-level DNS Manager UI which composes the zone selector, the record
 * list and dialogs for creating/importing records.
 */
import { useState, useEffect, useCallback } from "react";
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
import { Filter, LogOut, Search, X } from "lucide-react";
import { isDesktop } from "@/lib/environment";
import { AuditLogDialog } from "@/components/audit/AuditLogDialog";
import { TauriClient } from "@/lib/tauri-client";
import { AddRecordDialog } from "./AddRecordDialog";
import { ImportExportDialog } from "./ImportExportDialog";
import { RecordRow } from "./RecordRow";
import { FixedSizeList as List } from "react-window";

// Wrapper to avoid TS issues with react-window FixedSizeList generic types
const VirtualList = (props: any) => {
  const { children, ...rest } = props;
  return <List {...rest}>{children}</List>;
};
import { filterRecords } from "@/lib/dns-utils";
import { parseCSVRecords, parseBINDZone } from "@/lib/dns-parsers";

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
  const [selectedZone, setSelectedZone] = useState<string>("");
  const [records, setRecords] = useState<DNSRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editingRecord, setEditingRecord] = useState<string | null>(null);
  const [showAddRecord, setShowAddRecord] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [newRecord, setNewRecord] = useState<Partial<DNSRecord>>({
    type: "A",
    name: "",
    content: "",
    ttl: 300,
    proxied: false,
  });
  const [importData, setImportData] = useState("");
  const [importFormat, setImportFormat] = useState<"json" | "csv" | "bind">(
    "json",
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState<RecordType | "">("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number | null>(
    storageManager.getAutoRefreshInterval(),
  );
  const [showAuditLog, setShowAuditLog] = useState(false);

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

  const loadZones = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setIsLoading(true);
        const zonesData = await getZones(signal);
        setZones(zonesData);
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to load zones: " + (error as Error).message,
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    },
    [getZones, toast],
  );

  const loadRecords = useCallback(
    async (signal?: AbortSignal) => {
      if (!selectedZone) return;

      try {
        setIsLoading(true);
        const recordsData = await getDNSRecords(
          selectedZone,
          page,
          perPage,
          signal,
        );
        setRecords(recordsData);
      } catch (error) {
        toast({
          title: "Error",
          description:
            "Failed to load DNS records: " + (error as Error).message,
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    },
    [getDNSRecords, selectedZone, page, perPage, toast],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadZones(controller.signal);
    return () => controller.abort();
  }, [loadZones]);

  useEffect(() => {
    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) => {
          const prefObj = prefs as {
            last_zone?: string;
            auto_refresh_interval?: number;
          };
          if (prefObj.last_zone) setSelectedZone(prefObj.last_zone);
          if (typeof prefObj.auto_refresh_interval === "number") {
            setAutoRefreshInterval(prefObj.auto_refresh_interval);
          }
        })
        .catch(() => {});
      return;
    }
    const last = storageManager.getLastZone();
    if (last) setSelectedZone(last);
  }, []);

  useEffect(() => {
    if (selectedZone) {
      const controller = new AbortController();
      loadRecords(controller.signal);
      return () => controller.abort();
    }
  }, [selectedZone, loadRecords]);

  useEffect(() => {
    if (selectedZone) {
      if (isDesktop()) {
        TauriClient.getPreferences()
          .then((prefs) =>
            TauriClient.updatePreferences({
              ...(prefs as Record<string, unknown>),
              last_zone: selectedZone,
            }),
          )
          .catch(() => {});
      } else {
        storageManager.setLastZone(selectedZone);
      }
    }
  }, [selectedZone]);

  // Auto refresh: refresh records at the selected interval unless the user is
  // currently editing or has modal dialogs open to avoid disrupting work.
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
      if (editingRecord || showAddRecord || showImport) return;
      const controller = new AbortController();
      await loadRecords(controller.signal);
    }, autoRefreshInterval);
    return () => clearInterval(id);
  }, [
    autoRefreshInterval,
    editingRecord,
    showAddRecord,
    showImport,
    loadRecords,
  ]);

  const handleAddRecord = async () => {
    if (
      !selectedZone ||
      !newRecord.type ||
      !newRecord.name ||
      !newRecord.content
    ) {
      toast({
        title: "Error",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    try {
      const createdRecord = await createDNSRecord(selectedZone, newRecord);
      setRecords([createdRecord, ...records]);
      setNewRecord({
        type: "A",
        name: "",
        content: "",
        ttl: 300,
        proxied: false,
      });
      setShowAddRecord(false);

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
    try {
      const updatedRecord = await updateDNSRecord(
        selectedZone,
        record.id,
        record,
      );
      setRecords(
        records.map((r: DNSRecord) => (r.id === record.id ? updatedRecord : r)),
      );
      setEditingRecord(null);

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

  const handleDeleteRecord = async (recordId: string) => {
    try {
      await deleteDNSRecord(selectedZone, recordId);
      setRecords(records.filter((r: DNSRecord) => r.id !== recordId));

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
    let content = "";
    let filename = "";
    let mimeType = "";

    switch (format) {
      case "json": {
        content = JSON.stringify(records, null, 2);
        filename = `${selectedZone}-records.json`;
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
        const rows = records
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
        filename = `${selectedZone}-records.csv`;
        mimeType = "text/csv";
        break;
      }
      case "bind": {
        content = records
          .map((r: DNSRecord) => {
            const ttl = r.ttl || 300;
            const priority = r.priority ? `${r.priority} ` : "";
            return `${r.name}\t${ttl}\tIN\t${r.type}\t${priority}${r.content}`;
          })
          .join("\n");
        filename = `${selectedZone}.zone`;
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
    providedItems?: Partial<DNSRecord>[],
    dryRun?: boolean,
  ) => {
    try {
      let items: Partial<DNSRecord>[] | null = null;
      if (providedItems) items = providedItems as Partial<DNSRecord>[];
      else {
        switch (importFormat) {
          case "json": {
            const imported = JSON.parse(importData);
            items = Array.isArray(imported)
              ? imported
              : Array.isArray(imported.records)
                ? imported.records
                : null;
            break;
          }
          case "csv":
            items = parseCSVRecords(importData);
            break;
          case "bind":
            items = parseBINDZone(importData);
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
          const exists = records.some(
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
              selectedZone,
              valid,
              dryRun,
            );
            // Server returns { created: DNSRecord[]; skipped: unknown[] }
            const created = Array.isArray(result?.created)
              ? (result.created as DNSRecord[])
              : valid;
            if (!dryRun) {
              setRecords([...created, ...records]);
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
          // Fall back to local creation using per-record API or local state
          const createdRecords: DNSRecord[] = [];
          for (const v of valid) {
            try {
              const r = await createDNSRecord(selectedZone, v);
              createdRecords.push(r);
            } catch {
              // record creation failed for this item - count as skipped but ignore error details
              skipped++;
            }
          }
          if (!dryRun) {
            setRecords([...createdRecords, ...records]);
          }
        }
        if (!dryRun) {
          setImportData("");
          setShowImport(false);
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

  const handleLogout = () => {
    storageManager.clearSession();
    onLogout();
  };

  const selectedZoneData = zones.find((z: Zone) => z.id === selectedZone);
  const filteredRecords = filterRecords(records, searchTerm).filter(
    (record: DNSRecord) => (typeFilter ? record.type === typeFilter : true),
  );

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(255,120,40,0.08),transparent_55%),radial-gradient(circle_at_bottom,rgba(20,20,35,0.6),transparent_60%)] p-4 text-foreground">
      <div className="max-w-6xl mx-auto space-y-6 pb-10">
        {/* Header */}
        <Card className="border-white/10 bg-gradient-to-br from-slate-950/80 via-slate-900/60 to-orange-950/30 shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-2">
                <CardTitle className="text-3xl tracking-tight">
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
                {selectedZone && (
                  <AddRecordDialog
                    open={showAddRecord}
                    onOpenChange={setShowAddRecord}
                    record={newRecord}
                    onRecordChange={setNewRecord}
                    onAdd={handleAddRecord}
                    zoneName={selectedZoneData?.name}
                    apiKey={apiKey}
                    email={email}
                  />
                )}
                <ImportExportDialog
                  open={showImport}
                  onOpenChange={setShowImport}
                  importData={importData}
                  importFormat={importFormat}
                  onImportDataChange={setImportData}
                  onImportFormatChange={setImportFormat}
                  onImport={handleImport}
                  serverExport={async (format) => {
                    if (!selectedZone) return;
                    try {
                      const res = await exportDNSRecords(
                        selectedZone,
                        format,
                        page,
                        perPage,
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
                      a.download = `${selectedZone}-records.${format === "json" ? "json" : format === "csv" ? "csv" : "zone"}`;
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
                          "Server export failed: " + (err as Error).message,
                        variant: "destructive",
                      });
                    }
                  }}
                  onExport={handleExport}
                />
                {isDesktop() && (
                  <Button
                    onClick={() => setShowAuditLog(true)}
                    variant="outline"
                  >
                    Audit Log
                  </Button>
                )}
                <Button onClick={handleLogout} variant="outline">
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
              <div className="space-y-2">
                <Label htmlFor="zone-select">Domain/Zone</Label>
                <Select value={selectedZone} onValueChange={setSelectedZone}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a domain" />
                  </SelectTrigger>
                  <SelectContent>
                    {zones.map((zone: Zone) => (
                      <SelectItem key={zone.id} value={zone.id}>
                        {zone.name} ({zone.status})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedZone && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <div className="rounded-md border border-white/10 bg-black/30 px-3 py-2">
                    {records.length} records
                  </div>
                  <div className="rounded-md border border-white/10 bg-black/30 px-3 py-2">
                    {filteredRecords.length} visible
                  </div>
                  <div className="rounded-md border border-white/10 bg-black/30 px-3 py-2">
                    Zone: {selectedZoneData?.name ?? selectedZone}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* DNS Records */}
        {selectedZone && (
          <Card className="border-white/10 bg-black/30 shadow-[0_20px_40px_rgba(0,0,0,0.2)]">
            <CardHeader className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                  <CardTitle className="text-xl">DNS Records</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {t("Edit inline, filter fast, and export with one click", "Edit inline, filter fast, and export with one click")}
                  </p>
                </div>
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
              </div>
              <div className="grid gap-3 md:grid-cols-[1.2fr_auto_auto_auto] md:items-center">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={t("Search records", "Search records")}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Select
                  value={typeFilter || "all"}
                  onValueChange={(v) =>
                    setTypeFilter(v === "all" ? "" : (v as RecordType))
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
                  value={String(perPage)}
                  onValueChange={(v) => setPerPage(Number(v))}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue placeholder="Per page" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="25">25</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2 justify-start md:justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSearchTerm("");
                      setTypeFilter("");
                      setPage(1);
                    }}
                  >
                    <X className="h-3 w-3 mr-1" />
                    Clear
                  </Button>
                  <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs">
                    <Filter className="h-3 w-3" />
                    Page {page}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                  >
                    Prev
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="text-center py-8">Loading...</div>
              ) : filteredRecords.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {t("No DNS records found", "No DNS records found")}
                </div>
              ) : (
                <div className="space-y-2">
                  <VirtualList
                    height={Math.min(600, filteredRecords.length * 72)}
                    itemCount={filteredRecords.length}
                    itemSize={72}
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
                      return (
                        <div style={style} key={record.id}>
                          <RecordRow
                            record={record}
                            isEditing={editingRecord === record.id}
                            onEdit={() => setEditingRecord(record.id)}
                            onSave={(updatedRecord: DNSRecord) =>
                              handleUpdateRecord(updatedRecord)
                            }
                            onCancel={() => setEditingRecord(null)}
                            onDelete={() => handleDeleteRecord(record.id)}
                          />
                        </div>
                      );
                    }}
                  </VirtualList>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
      <AuditLogDialog open={showAuditLog} onOpenChange={setShowAuditLog} />
    </div>
  );
}
