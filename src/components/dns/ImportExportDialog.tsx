/**
 * UI controls to import and export DNS records for the selected zone.
 * This component exposes actions and a modal allowing the user to import
 * JSON/CSV/BIND data.
 */
import type { ChangeEvent } from "react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Upload, Download } from "lucide-react";
import { parseCSVRecords, parseBINDZone } from "@/lib/dns-parsers";
import { ImportPreviewDialog } from "./ImportPreviewDialog";
import type { DNSRecord } from "@/types/dns";

/**
 * Props for the import/export dialog used to import DNS records into
 * the current zone or export the records in a selected format.
 */
interface ImportExportDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback invoked when the dialog open state changes */
  onOpenChange: (open: boolean) => void;
  /** The raw data being imported */
  importData: string;
  /** Expected import format */
  importFormat: "json" | "csv" | "bind";
  /** Callback invoked when user edits the import data */
  onImportDataChange: (data: string) => void;
  /** Callback invoked when user selects a different import format */
  onImportFormatChange: (format: "json" | "csv" | "bind") => void;
  /** Callback invoked to perform the import */
  onImport: (items?: Partial<DNSRecord>[], dryRun?: boolean) => void;
  /** Callback to export current records using the selected format */
  onExport: (format: "json" | "csv" | "bind") => void;
  serverExport?: (format: "json" | "csv" | "bind") => Promise<void>;
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
  onExport,
  serverExport,
}: ImportExportDialogProps) {
  const [previewItems, setPreviewItems] = useState<Partial<DNSRecord>[]>([]);
  const [showPreview, setShowPreview] = useState(false);
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
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  onImportDataChange(e.target.value)
                }
                placeholder={`Paste your ${importFormat.toUpperCase()} data here...`}
              />
            </div>
            <Button
              onClick={() => {
                // Parse and show preview based on selected import format
                let items: Partial<Record<string, unknown>>[] | null = null;
                try {
                  switch (importFormat) {
                    case "json": {
                      const parsed = JSON.parse(importData);
                      items = Array.isArray(parsed)
                        ? parsed
                        : Array.isArray(parsed.records)
                          ? parsed.records
                          : null;
                      break;
                    }
                    case "csv":
                      items = parseCSVRecords
                        ? parseCSVRecords(importData)
                        : null;
                      break;
                    case "bind":
                      items = parseBINDZone ? parseBINDZone(importData) : null;
                      break;
                  }
                } catch {
                  // Parsing failed — treat as invalid input and fallback to calling onImport()
                  items = null;
                }

                if (!items) {
                  onImport();
                  return;
                }
                setPreviewItems(items as Partial<DNSRecord>[]);
                setShowPreview(true);
              }}
              className="w-full"
            >
              Import Records
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Select
        onValueChange={(format: "json" | "csv" | "bind") => onExport(format)}
      >
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

      <Select
        onValueChange={async (format: "json" | "csv" | "bind") => {
          if (serverExport) {
            try {
              await serverExport(format);
            } catch (err) {
              console.error("Server export failed", err);
            }
          }
        }}
      >
        <SelectTrigger className="w-28 ml-2">
          <SelectValue placeholder="Server Export" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="json">JSON (server)</SelectItem>
          <SelectItem value="csv">CSV (server)</SelectItem>
          <SelectItem value="bind">BIND (server)</SelectItem>
        </SelectContent>
      </Select>
      {showPreview && (
        <ImportPreviewDialog
          open={showPreview}
          onOpenChange={setShowPreview}
          items={previewItems}
          onConfirm={(items: Partial<DNSRecord>[], dryRun?: boolean) => {
            // Forward parsed items and optionally run as dry-run to the caller
            onImport(items as Partial<DNSRecord>[], dryRun);
            setShowPreview(false);
          }}
          onCancel={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}
