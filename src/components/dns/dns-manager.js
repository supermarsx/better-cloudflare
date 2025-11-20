import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
 * DNS Manager component responsible for listing zones and DNS records and
 * providing UI for add/import/export/update/delete operations.
 *
 * @param apiKey - API key used to authenticate server requests
 * @param email - optional email when using key+email authentication
 * @param onLogout - callback invoked when the user logs out
 */
export function DNSManager({ apiKey, email, onLogout }) {
    const [zones, setZones] = useState([]);
    const [selectedZone, setSelectedZone] = useState('');
    const [records, setRecords] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [editingRecord, setEditingRecord] = useState(null);
    const [showAddRecord, setShowAddRecord] = useState(false);
    const [showImport, setShowImport] = useState(false);
    const [newRecord, setNewRecord] = useState({
        type: 'A',
        name: '',
        content: '',
        ttl: 300,
        proxied: false
    });
    const [importData, setImportData] = useState('');
    const [importFormat, setImportFormat] = useState('json');
    const [searchTerm, setSearchTerm] = useState('');
    const [typeFilter, setTypeFilter] = useState('');
    const { toast } = useToast();
    const { getZones, getDNSRecords, createDNSRecord, updateDNSRecord, deleteDNSRecord, } = useCloudflareAPI(apiKey, email);
    const loadZones = useCallback(async (signal) => {
        try {
            setIsLoading(true);
            const zonesData = await getZones(signal);
            setZones(zonesData);
        }
        catch (error) {
            toast({
                title: "Error",
                description: "Failed to load zones: " + error.message,
                variant: "destructive"
            });
        }
        finally {
            setIsLoading(false);
        }
    }, [getZones, toast]);
    const loadRecords = useCallback(async (signal) => {
        if (!selectedZone)
            return;
        try {
            setIsLoading(true);
            const recordsData = await getDNSRecords(selectedZone, signal);
            setRecords(recordsData);
        }
        catch (error) {
            toast({
                title: "Error",
                description: "Failed to load DNS records: " + error.message,
                variant: "destructive"
            });
        }
        finally {
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
        }
        catch (error) {
            toast({
                title: "Error",
                description: "Failed to create DNS record: " + error.message,
                variant: "destructive"
            });
        }
    };
    const handleUpdateRecord = async (record) => {
        try {
            const updatedRecord = await updateDNSRecord(selectedZone, record.id, record);
            setRecords(records.map((r) => r.id === record.id ? updatedRecord : r));
            setEditingRecord(null);
            toast({
                title: "Success",
                description: "DNS record updated successfully"
            });
        }
        catch (error) {
            toast({
                title: "Error",
                description: "Failed to update DNS record: " + error.message,
                variant: "destructive"
            });
        }
    };
    const handleDeleteRecord = async (recordId) => {
        try {
            await deleteDNSRecord(selectedZone, recordId);
            setRecords(records.filter((r) => r.id !== recordId));
            toast({
                title: "Success",
                description: "DNS record deleted successfully"
            });
        }
        catch (error) {
            toast({
                title: "Error",
                description: "Failed to delete DNS record: " + error.message,
                variant: "destructive"
            });
        }
    };
    const handleExport = (format) => {
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
                const escapeCSV = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
                const rows = records
                    .map((r) => [
                    r.type,
                    r.name,
                    r.content,
                    r.ttl,
                    r.priority ?? '',
                    r.proxied ?? false,
                ]
                    .map(escapeCSV)
                    .join(','))
                    .join('\n');
                content = headers.map(escapeCSV).join(',') + '\n' + rows;
                filename = `${selectedZone}-records.csv`;
                mimeType = 'text/csv';
                break;
            }
            case 'bind': {
                content = records
                    .map((r) => {
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
            let items = null;
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
            const valid = [];
            let skipped = 0;
            for (const item of items) {
                if (item && item.type && item.name && item.content) {
                    const exists = records.some(r => r.type === item.type && r.name === item.name && r.content === item.content);
                    if (!exists) {
                        valid.push(item);
                    }
                    else {
                        skipped++;
                    }
                }
                else {
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
            }
            else {
                toast({
                    title: "Error",
                    description: skipped
                        ? `No new records imported. Skipped ${skipped} invalid or duplicate item(s).`
                        : 'No valid records found.',
                    variant: 'destructive'
                });
            }
        }
        catch (error) {
            toast({
                title: "Error",
                description: "Failed to import records: " + error.message,
                variant: "destructive"
            });
        }
    };
    const handleLogout = () => {
        storageManager.clearSession();
        onLogout();
    };
    const selectedZoneData = zones.find((z) => z.id === selectedZone);
    const filteredRecords = filterRecords(records, searchTerm).filter((record) => (typeFilter ? record.type === typeFilter : true));
    return (_jsx("div", { className: "min-h-screen bg-background p-4", children: _jsxs("div", { className: "max-w-6xl mx-auto space-y-6", children: [_jsxs(Card, { children: [_jsx(CardHeader, { children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx(CardTitle, { className: "text-2xl", children: "DNS Manager" }), _jsx("p", { className: "text-muted-foreground", children: "Manage your Cloudflare DNS records" })] }), _jsxs(Button, { onClick: handleLogout, variant: "outline", children: [_jsx(LogOut, { className: "h-4 w-4 mr-2" }), "Logout"] })] }) }), _jsx(CardContent, { children: _jsxs("div", { className: "flex gap-4 items-end", children: [_jsxs("div", { className: "flex-1", children: [_jsx(Label, { htmlFor: "zone-select", children: "Domain/Zone" }), _jsxs(Select, { value: selectedZone, onValueChange: setSelectedZone, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Select a domain" }) }), _jsx(SelectContent, { children: zones.map((zone) => (_jsxs(SelectItem, { value: zone.id, children: [zone.name, " (", zone.status, ")"] }, zone.id))) })] })] }), selectedZone && (_jsx("div", { className: "flex gap-2", children: _jsx(AddRecordDialog, { open: showAddRecord, onOpenChange: setShowAddRecord, record: newRecord, onRecordChange: setNewRecord, onAdd: handleAddRecord, zoneName: selectedZoneData?.name }) }))] }) })] }), selectedZone && (_jsxs(Card, { children: [_jsx(CardHeader, { children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsx(CardTitle, { children: "DNS Records" }), _jsxs("div", { className: "flex gap-2 items-center", children: [_jsx(Input, { placeholder: "Search records", value: searchTerm, onChange: (e) => setSearchTerm(e.target.value), className: "w-[200px]" }), _jsx(ImportExportDialog, { open: showImport, onOpenChange: setShowImport, importData: importData, importFormat: importFormat, onImportDataChange: setImportData, onImportFormatChange: setImportFormat, onImport: handleImport, onExport: handleExport })] })] }) }), _jsxs(CardContent, { children: [_jsx("div", { className: "flex justify-end mb-4", children: _jsxs(Select, { value: typeFilter, onValueChange: setTypeFilter, children: [_jsx(SelectTrigger, { className: "w-[180px]", children: _jsx(SelectValue, { placeholder: "All types" }) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "", children: "All types" }), RECORD_TYPES.map((type) => (_jsx(SelectItem, { value: type, children: type }, type)))] })] }) }), isLoading ? (_jsx("div", { className: "text-center py-8", children: "Loading..." })) : filteredRecords.length === 0 ? (_jsx("div", { className: "text-center py-8 text-muted-foreground", children: "No DNS records found" })) : (_jsx("div", { className: "space-y-2", children: filteredRecords.map((record) => (_jsx(RecordRow, { record: record, isEditing: editingRecord === record.id, onEdit: () => setEditingRecord(record.id), onSave: (updatedRecord) => handleUpdateRecord(updatedRecord), onCancel: () => setEditingRecord(null), onDelete: () => handleDeleteRecord(record.id) }, record.id))) }))] })] }))] }) }));
}
