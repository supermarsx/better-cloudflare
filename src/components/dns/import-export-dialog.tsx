import type { ChangeEvent } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { DNSRecord } from '@/types/dns';
import { Upload, Download } from 'lucide-react';

interface ImportExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  importData: string;
  onImportDataChange: (data: string) => void;
  onImport: () => void;
  onExport: (format: 'json' | 'csv' | 'bind') => void;
}

export function ImportExportDialog({
  open,
  onOpenChange,
  importData,
  onImportDataChange,
  onImport,
  onExport
}: ImportExportDialogProps) {
  return (
    <div className="flex gap-2">
      <Dialog open={open} onOpenChange={onOpenChange}>
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
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onImportDataChange(e.target.value)}
                placeholder="Paste your JSON data here..."
              />
            </div>
            <Button onClick={onImport} className="w-full">
              Import Records
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Select onValueChange={(format: 'json' | 'csv' | 'bind') => onExport(format)}>
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
  );
}
