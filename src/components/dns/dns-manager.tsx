/**
 * Top-level DNS Manager UI which composes the zone selector, the record
 * list and dialogs for creating/importing records.
 */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCloudflareAPI } from '@/hooks/use-cloudflare-api';
import type { DNSRecord, Zone, RecordType } from '@/types/dns';
import { RECORD_TYPES } from '@/types/dns';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import { storageManager } from '@/lib/storage';
import { LogOut } from 'lucide-react';
import { AddRecordDialog } from './AddRecordDialog';
import { ImportExportDialog } from './import-export-dialog';
import { RecordRow } from './RecordRow';
import { FixedSizeList as List } from 'react-window';
import { filterRecords } from './filter-records';
import { parseCSVRecords, parseBINDZone } from '@/lib/dns-parsers';

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
  const { t } = useTranslation();
  const [zones, setZones] = useState<Zone[]>([]);
  const [selectedZone, setSelectedZone] = useState<string>('');
  const [records, setRecords] = useState<DNSRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editingRecord, setEditingRecord] = useState<string | null>(null);
  const [showAddRecord, setShowAddRecord] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [newRecord, setNewRecord] = useState<Partial<DNSRecord>>({
    type: 'A',
    name: '',
    content: '',
    ttl: 300,
    proxied: false
  });
  const [importData, setImportData] = useState('');
  const [importFormat, setImportFormat] = useState<'json' | 'csv' | 'bind'>('json');
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<RecordType | ''>('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number | null>(storageManager.getAutoRefreshInterval());
  
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

  const loadZones = useCallback(async (signal?: AbortSignal) => {
    try {
      setIsLoading(true);
      const zonesData = await getZones(signal);
      setZones(zonesData);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to load zones: " + (error as Error).message,
        variant: "destructive"
      });
    } finally {
      setIsLoading(false);
    }
  }, [getZones, toast]);

  const loadRecords = useCallback(async (signal?: AbortSignal) => {
    if (!selectedZone) return;

    try {
      setIsLoading(true);
      const recordsData = await getDNSRecords(selectedZone, page, perPage, signal);
      setRecords(recordsData);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to load DNS records: " + (error as Error).message,
        variant: "destructive"
      });
    } finally {
      setIsLoading(false);
    }
  }, [getDNSRecords, selectedZone, page, perPage, toast]);

  useEffect(() => {
    const controller = new AbortController();
    loadZones(controller.signal);
    return () => controller.abort();
  }, [loadZones]);

  useEffect(() => {
    const last = storageManager.getLastZone();
    if (last) {
      setSelectedZone(last);
    }
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
      storageManager.setLastZone(selectedZone);
    }
  }, [selectedZone]);

  // Auto refresh: refresh records at the selected interval unless the user is
  // currently editing or has modal dialogs open to avoid disrupting work.
  useEffect(() => {
    storageManager.setAutoRefreshInterval(autoRefreshInterval ?? null);
    if (!autoRefreshInterval || autoRefreshInterval <= 0) return;
    const id = setInterval(async () => {
      if (editingRecord || showAddRecord || showImport) return;
      const controller = new AbortController();
      await loadRecords(controller.signal);
    }, autoRefreshInterval);
    return () => clearInterval(id);
  }, [autoRefreshInterval, editingRecord, showAddRecord, showImport, loadRecords]);

  const handleAddRecord = async () => {
    if (!selectedZone || !newRecord.type || !newRecord.name || !newRecord.content) {
      toast({
        title: "Error",
        description: "Please fill in all required fields",
        variant: "destructive"
      });
      return;
    }

    try {
      const createdRecord = await createDNSRecord(selectedZone, newRecord);
      setRecords([createdRecord, ...records]);
      setNewRecord({
        type: 'A',
        name: '',
        content: '',
        ttl: 300,
        proxied: false
      });
      setShowAddRecord(false);
      
      toast({
        title: "Success",
        description: "DNS record created successfully"
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create DNS record: " + (error as Error).message,
        variant: "destructive"
      });
    }
  };

  const handleUpdateRecord = async (record: DNSRecord) => {
    try {
      const updatedRecord = await updateDNSRecord(selectedZone, record.id, record);
      setRecords(records.map((r: DNSRecord) => r.id === record.id ? updatedRecord : r));
      setEditingRecord(null);
      
      toast({
        title: "Success",
        description: "DNS record updated successfully"
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update DNS record: " + (error as Error).message,
        variant: "destructive"
      });
    }
  };

  const handleDeleteRecord = async (recordId: string) => {
    try {
      await deleteDNSRecord(selectedZone, recordId);
      setRecords(records.filter((r: DNSRecord) => r.id !== recordId));
      
      toast({
        title: "Success",
        description: "DNS record deleted successfully"
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete DNS record: " + (error as Error).message,
        variant: "destructive"
      });
    }
  };

  const handleExport = (format: 'json' | 'csv' | 'bind') => {
    let content = '';
    let filename = '';
    let mimeType = '';

    switch (format) {
      case 'json': {
        content = JSON.stringify(records, null, 2);
        filename = `${selectedZone}-records.json`;
        mimeType = 'application/json';
        break;
      }
      case 'csv': {
        const headers = ['Type', 'Name', 'Content', 'TTL', 'Priority', 'Proxied'];
        const escapeCSV = (value: unknown) =>
          `"${String(value ?? '').replace(/"/g, '""')}"`;
        const rows = records
          .map((r: DNSRecord) =>
            [
              r.type,
              r.name,
              r.content,
              r.ttl,
              r.priority ?? '',
              r.proxied ?? false,
            ]
              .map(escapeCSV)
              .join(',')
          )
          .join('\n');
        content = headers.map(escapeCSV).join(',') + '\n' + rows;
        filename = `${selectedZone}-records.csv`;
        mimeType = 'text/csv';
        break;
      }
      case 'bind': {
        content = records
          .map((r: DNSRecord) => {
            const ttl = r.ttl || 300;
            const priority = r.priority ? `${r.priority} ` : '';
            return `${r.name}\t${ttl}\tIN\t${r.type}\t${priority}${r.content}`;
          })
          .join('\n');
        filename = `${selectedZone}.zone`;
        mimeType = 'text/plain';
        break;
      }
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    toast({
      title: "Success",
      description: `Records exported as ${format.toUpperCase()}`
    });
  };

  const handleImport = async (providedItems?: Partial<DNSRecord>[], dryRun?: boolean) => {
    try {
      let items: Partial<DNSRecord>[] | null = null;
      if (providedItems) items = providedItems as Partial<DNSRecord>[];
      else {
      switch (importFormat) {
        case 'json': {
          const imported = JSON.parse(importData);
          items = Array.isArray(imported)
            ? imported
            : Array.isArray(imported.records)
              ? imported.records
              : null;
          break;
        }
        case 'csv':
          items = parseCSVRecords(importData);
          break;
        case 'bind':
          items = parseBINDZone(importData);
          break;
      }
      }

      if (!items) {
        throw new Error('Invalid format');
      }

      const valid: DNSRecord[] = [];
      let skipped = 0;

      for (const item of items) {
        if (item && item.type && item.name && item.content) {
          const exists = records.some(
            r => r.type === item.type && r.name === item.name && r.content === item.content
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
            const result = await bulkCreateDNSRecords(selectedZone, valid, dryRun);
            // Handle created and skipped results returned by server
            const r = result as unknown as { created?: DNSRecord[] };
            const created = Array.isArray(r.created) ? r.created : valid;
            setRecords([...created, ...records]);
          } catch (err) {
            toast({
              title: 'Error',
              description: 'Failed to import records: ' + (err as Error).message,
              variant: 'destructive',
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
              // record creation failed for this item — count as skipped but ignore error details
              skipped++;
            }
          }
          setRecords([...createdRecords, ...records]);
        }
        setImportData('');
        setShowImport(false);

        toast({
          title: "Success",
          description: `Imported ${valid.length} record(s)` + (skipped ? `, skipped ${skipped}` : '')
        });
      } else {
        toast({
          title: "Error",
          description: skipped
            ? `No new records imported. Skipped ${skipped} invalid or duplicate item(s).`
            : 'No valid records found.',
          variant: 'destructive'
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to import records: " + (error as Error).message,
        variant: "destructive"
      });
    }
  };

  const handleLogout = () => {
    storageManager.clearSession();
    onLogout();
  };

  const selectedZoneData = zones.find((z: Zone) => z.id === selectedZone);
  const filteredRecords = filterRecords(records, searchTerm).filter(
    (record: DNSRecord) => (typeFilter ? record.type === typeFilter : true)
  );

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-2xl">{t('DNS Manager', 'DNS Manager')}</CardTitle>
                <p className="text-muted-foreground">{t('Manage your Cloudflare DNS records', 'Manage your Cloudflare DNS records')}</p>
              </div>
              <Button onClick={handleLogout} variant="outline">
                <LogOut className="h-4 w-4 mr-2" />
                Logout
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4 items-end">
              <div className="flex-1">
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
                <div className="flex gap-2">
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
                </div>
                )}
            </div>
          </CardContent>
        </Card>

        {/* DNS Records */}
        {selectedZone && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>DNS Records</CardTitle>
                <div className="flex gap-2 items-center">
                  <Input
                    placeholder={t('Search records', 'Search records')}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-[200px]"
                  />
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
                        const res = await exportDNSRecords(selectedZone, format, page, perPage);
                        // create a blob and download
                        const blob = new Blob([res], { type: format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${selectedZone}-records.${format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'zone'}`;
                        a.click();
                        URL.revokeObjectURL(url);
                        toast({ title: 'Success', description: `Server export ${format.toUpperCase()} completed` });
                      } catch (err) {
                        toast({ title: 'Error', description: 'Server export failed: ' + (err as Error).message, variant: 'destructive' });
                      }
                    }}
                    onExport={handleExport}
                  />
                  <Select value={String(autoRefreshInterval ?? 0)} onValueChange={(v) => setAutoRefreshInterval(v ? Number(v) : null)}>
                    <SelectTrigger className="w-32">
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
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex justify-end mb-4">
                    <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as RecordType | '')}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">{t('All types', 'All types')}</SelectItem>
                    {RECORD_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="ml-4 flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Prev</Button>
                  <div className="text-sm">Page {page}</div>
                  <Button size="sm" variant="outline" onClick={() => setPage((p) => p + 1)}>Next</Button>
                  <Select value={String(perPage)} onValueChange={(v) => setPerPage(Number(v) )}>
                    <SelectTrigger className="w-28 ml-2">
                      <SelectValue placeholder="Per page" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="25">25</SelectItem>
                      <SelectItem value="50">50</SelectItem>
                      <SelectItem value="100">100</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
                {isLoading ? (
                <div className="text-center py-8">Loading...</div>
              ) : filteredRecords.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {t('No DNS records found', 'No DNS records found')}
                </div>
              ) : (
                <div className="space-y-2">
                  <List
                    height={Math.min(600, filteredRecords.length * 72)}
                    itemCount={filteredRecords.length}
                    itemSize={72}
                    width={'100%'}
                    >{({ index, style }: { index: number; style: React.CSSProperties }) => {
                    const record = filteredRecords[index];
                    return (
                      <div style={style} key={record.id}>
                        <RecordRow
                          record={record}
                          isEditing={editingRecord === record.id}
                          onEdit={() => setEditingRecord(record.id)}
                          onSave={(updatedRecord: DNSRecord) => handleUpdateRecord(updatedRecord)}
                          onCancel={() => setEditingRecord(null)}
                          onDelete={() => handleDeleteRecord(record.id)}
                        />
                      </div>
                    );
                  }}</List>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

