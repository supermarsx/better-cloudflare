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
import { storageManager } from '@/lib/storage';
import { LogOut } from 'lucide-react';
import { AddRecordDialog } from './AddRecordDialog';
import { ImportExportDialog } from './import-export-dialog';
import { RecordRow } from './RecordRow';
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
  
  const { toast } = useToast();
  const {
    getZones,
    getDNSRecords,
    createDNSRecord,
    updateDNSRecord,
    deleteDNSRecord,
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
      const recordsData = await getDNSRecords(selectedZone, signal);
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
  }, [getDNSRecords, selectedZone, toast]);

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

  const handleImport = () => {
    try {
      let items: Partial<DNSRecord>[] | null = null;
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
        setRecords([...valid, ...records]);
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
                <CardTitle className="text-2xl">DNS Manager</CardTitle>
                <p className="text-muted-foreground">
                  Manage your Cloudflare DNS records
                </p>
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
                    placeholder="Search records"
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
                    onExport={handleExport}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex justify-end mb-4">
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All types</SelectItem>
                    {RECORD_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {isLoading ? (
                <div className="text-center py-8">Loading...</div>
              ) : filteredRecords.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No DNS records found
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredRecords.map((record: DNSRecord) => (
                    <RecordRow
                      key={record.id}
                      record={record}
                      isEditing={editingRecord === record.id}
                      onEdit={() => setEditingRecord(record.id)}
                      onSave={(updatedRecord: DNSRecord) => handleUpdateRecord(updatedRecord)}
                      onCancel={() => setEditingRecord(null)}
                      onDelete={() => handleDeleteRecord(record.id)}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

