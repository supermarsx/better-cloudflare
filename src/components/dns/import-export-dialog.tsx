import type { ChangeEvent } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Upload, Download } from 'lucide-react';

/**
 * Props for the import/export dialog used to import DNS records into
 * the current zone or export the records in a selected format.
 */
interface ImportExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  importData: string;
  importFormat: 'json' | 'csv' | 'bind';
  onImportDataChange: (data: string) => void;
  onImportFormatChange: (format: 'json' | 'csv' | 'bind') => void;
  onImport: () => void;
  onExport: (format: 'json' | 'csv' | 'bind') => void;
}

/**
 * Render an Import/Export control used by the DNS Manager for importing
 * JSON/CSV/BIND formats or exporting the current records.
 */
export function ImportExportDialog({
  open,
  onOpenChange,
  importData,
  importFormat,
  onImportDataChange,
  onImportFormatChange,
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
              Import DNS records from JSON, CSV, or BIND zone formats
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Format</Label>
              <Select value={importFormat} onValueChange={onImportFormatChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select format" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="json">JSON</SelectItem>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="bind">BIND</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{importFormat.toUpperCase()} Data</Label>
              <textarea
                className="w-full h-32 p-2 border rounded-md bg-background"
                value={importData}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onImportDataChange(e.target.value)}
                placeholder={`Paste your ${importFormat.toUpperCase()} data here...`}
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
