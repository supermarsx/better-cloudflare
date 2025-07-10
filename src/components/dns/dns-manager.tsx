import { useState, useEffect, useCallback, type ChangeEvent } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useCloudflareAPI } from '@/hooks/use-cloudflare-api';
import type { DNSRecord, Zone, RecordType } from '@/types/dns';
import { useToast } from '@/hooks/use-toast';
import { storageManager } from '@/lib/storage';
import { Plus, Download, Upload, LogOut, Edit2, Trash2, Save, X } from 'lucide-react';

interface DNSManagerProps {
  apiKey: string;
  onLogout: () => void;
}

const RECORD_TYPES: RecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'PTR', 'CAA'];

export function DNSManager({ apiKey, onLogout }: DNSManagerProps) {
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
  
  const { toast } = useToast();
  const {
    getZones,
    getDNSRecords,
    createDNSRecord,
    updateDNSRecord,
    deleteDNSRecord,
  } = useCloudflareAPI(apiKey);

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
    if (selectedZone) {
      const controller = new AbortController();
      loadRecords(controller.signal);
      return () => controller.abort();
    }
  }, [selectedZone, loadRecords]);

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
        const headers = 'Type,Name,Content,TTL,Priority,Proxied\n';
        const rows = records
          .map(
            (r: DNSRecord) =>
              `${r.type},${r.name},${r.content},${r.ttl},${r.priority || ''},${r.proxied || false}`
          )
          .join('\n');
        content = headers + rows;
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
      const imported = JSON.parse(importData);
      const items = Array.isArray(imported)
        ? imported
        : Array.isArray(imported.records)
          ? imported.records
          : null;

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
                  <Dialog open={showAddRecord} onOpenChange={setShowAddRecord}>
                    <DialogTrigger asChild>
                      <Button>
                        <Plus className="h-4 w-4 mr-2" />
                        Add Record
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Add DNS Record</DialogTitle>
                        <DialogDescription>
                          Create a new DNS record for {selectedZoneData?.name}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Type</Label>
                            <Select
                              value={newRecord.type}
                              onValueChange={(value: string) =>
                                setNewRecord(prev => ({
                                  ...prev,
                                  type: value as RecordType,
                                  priority:
                                    value === 'MX' ? prev.priority : undefined
                                }))
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {RECORD_TYPES.map((type: RecordType) => (
                                  <SelectItem key={type} value={type}>
                                    {type}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label>TTL</Label>
                            <Input
                              type="number"
                              value={newRecord.ttl}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setNewRecord({
                                ...newRecord,
                                ttl: parseInt(e.target.value) || 300
                              })}
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>Name</Label>
                          <Input
                            value={newRecord.name}
                            onChange={(e: ChangeEvent<HTMLInputElement>) => setNewRecord({
                              ...newRecord,
                              name: e.target.value
                            })}
                            placeholder="e.g., www or @ for root"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Content</Label>
                          <Input
                            value={newRecord.content}
                            onChange={(e: ChangeEvent<HTMLInputElement>) => setNewRecord({
                              ...newRecord,
                              content: e.target.value
                            })}
                            placeholder="e.g., 192.168.1.1"
                          />
                        </div>
                        {newRecord.type === 'MX' && (
                          <div className="space-y-2">
                            <Label>Priority</Label>
                            <Input
                              type="number"
                              value={newRecord.priority || ''}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setNewRecord({
                                ...newRecord,
                                priority: parseInt(e.target.value) || undefined
                              })}
                            />
                          </div>
                        )}
                        {(newRecord.type === 'A' || newRecord.type === 'AAAA' || newRecord.type === 'CNAME') && (
                          <div className="flex items-center space-x-2">
                            <Switch
                              checked={newRecord.proxied || false}
                              onCheckedChange={(checked: boolean) => setNewRecord({
                                ...newRecord,
                                proxied: checked
                              })}
                            />
                            <Label>Proxied through Cloudflare</Label>
                          </div>
                        )}
                        <Button onClick={handleAddRecord} className="w-full">
                          Create Record
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
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
                <div className="flex gap-2">
                  <Dialog open={showImport} onOpenChange={setShowImport}>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm">
                        <Upload className="h-4 w-4 mr-2" />
                        Import
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Import DNS Records</DialogTitle>
                        <DialogDescription>
                          Import DNS records from JSON format
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label>JSON Data</Label>
                          <textarea
                            className="w-full h-32 p-2 border rounded-md bg-background"
                            value={importData}
                            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setImportData(e.target.value)}
                            placeholder="Paste your JSON data here..."
                          />
                        </div>
                        <Button onClick={handleImport} className="w-full">
                          Import Records
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                  
                  <Select onValueChange={(format: 'json' | 'csv' | 'bind') => handleExport(format)}>
                    <SelectTrigger className="w-32">
                      <Download className="h-4 w-4 mr-2" />
                      <SelectValue placeholder="Export" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="json">JSON</SelectItem>
                      <SelectItem value="csv">CSV</SelectItem>
                      <SelectItem value="bind">BIND</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="text-center py-8">Loading...</div>
              ) : records.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No DNS records found
                </div>
              ) : (
                <div className="space-y-2">
                  {records.map((record: DNSRecord) => (
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

interface RecordRowProps {
  record: DNSRecord;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (record: DNSRecord) => void;
  onCancel: () => void;
  onDelete: () => void;
}

function RecordRow({ record, isEditing, onEdit, onSave, onCancel, onDelete }: RecordRowProps) {
  const [editedRecord, setEditedRecord] = useState(record);

  useEffect(() => {
    setEditedRecord(record);
  }, [record]);

  if (isEditing) {
    return (
      <div className="p-4 border rounded-lg bg-muted/50">
        <div className="grid grid-cols-12 gap-4 items-center">
          <div className="col-span-2">
            <Select
              value={editedRecord.type}
              onValueChange={(value: RecordType) => setEditedRecord({
                ...editedRecord,
                type: value
              })}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECORD_TYPES.map((type: RecordType) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-3">
            <Input
              value={editedRecord.name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEditedRecord({
                ...editedRecord,
                name: e.target.value
              })}
              className="h-8"
            />
          </div>
          <div className="col-span-4">
            <Input
              value={editedRecord.content}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEditedRecord({
                ...editedRecord,
                content: e.target.value
              })}
              className="h-8"
            />
          </div>
          <div className="col-span-1 space-y-1">
            <Input
              type="number"
              value={editedRecord.ttl}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setEditedRecord({
                  ...editedRecord,
                  ttl: parseInt(e.target.value) || 300,
                })
              }
              className="h-8"
            />
            {editedRecord.type === 'MX' && (
              <Input
                type="number"
                value={editedRecord.priority ?? ''}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setEditedRecord({
                    ...editedRecord,
                    priority: e.target.value
                      ? parseInt(e.target.value)
                      : undefined,
                  })
                }
                className="h-8"
              />
            )}
          </div>
          <div className="col-span-1">
            {(editedRecord.type === 'A' || editedRecord.type === 'AAAA' || editedRecord.type === 'CNAME') && (
              <Switch
                checked={editedRecord.proxied || false}
                onCheckedChange={(checked: boolean) => setEditedRecord({
                  ...editedRecord,
                  proxied: checked
                })}
              />
            )}
          </div>
          <div className="col-span-1 flex gap-1">
            <Button
              size="sm"
              onClick={() => onSave(editedRecord)}
              className="h-8 w-8 p-0"
            >
              <Save className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onCancel}
              className="h-8 w-8 p-0"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 border rounded-lg hover:bg-muted/50 transition-colors">
      <div className="grid grid-cols-12 gap-4 items-center">
        <div className="col-span-2">
          <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-primary/10 text-primary">
            {record.type}
          </span>
        </div>
        <div className="col-span-3">
          <span className="font-mono text-sm">{record.name}</span>
        </div>
        <div className="col-span-4">
          <span className="font-mono text-sm break-all">{record.content}</span>
        </div>
        <div className="col-span-1">
          <span className="text-sm text-muted-foreground">{record.ttl}</span>
        </div>
        <div className="col-span-1">
          {record.proxied && (
            <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
              Proxied
            </span>
          )}
        </div>
        <div className="col-span-1 flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={onEdit}
            className="h-8 w-8 p-0"
          >
            <Edit2 className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );}
