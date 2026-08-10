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
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Upload, Download } from "lucide-react";
import { parseCSVRecords, parseBINDZone } from "@/lib/dns/dns-parsers";
import { isDesktop } from "@/lib/environment";
import { TauriClient } from "@/lib/api/tauri-client";
import { ImportPreviewDialog } from "./ImportPreviewDialog";
import type { DNSRecord } from "@/types/dns";
import { retainUtf8, utf8ByteLengthUpTo } from "./rendererSafety";

type ImportFormat = "json" | "csv" | "bind";

export const IMPORT_LIMITS = Object.freeze({
  inputBytes: 2 * 1024 * 1024,
  records: 10_000,
  lines: 20_000,
  fieldsPerRecord: 32,
  totalFields: 120_000,
  fieldBytes: 16 * 1024,
  retainedBytes: 2 * 1024 * 1024,
});

type BoundedImportResult = {
  items: Partial<DNSRecord>[];
  sourceCount: number;
  rejectedCount: number;
  diagnostics: string[];
};

const IMPORT_STRING_FIELDS = ["type", "name", "content", "comment"] as const;

function formatByteLimit(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MiB`;
}

/**
 * Reject unsafe raw input before JSON parsing, browser parsing, or native IPC.
 */
export function preflightImportText(
  text: string,
  format: ImportFormat,
): string | null {
  const measuredBytes = utf8ByteLengthUpTo(text, IMPORT_LIMITS.inputBytes);
  if (measuredBytes > IMPORT_LIMITS.inputBytes) {
    return `Import refused before parsing: input exceeds ${formatByteLimit(
      IMPORT_LIMITS.inputBytes,
    )}. Split the zone data into smaller files.`;
  }

  if (!text) return null;
  let lineCount = 1;
  let fieldCount = 0;
  let fieldsOnLine = 0;
  let fieldBytes = 0;
  let inCsvQuotes = false;
  let inBindComment = false;
  let inField = false;

  const finishField = () => {
    if (!inField && format === "bind") return null;
    fieldsOnLine += 1;
    fieldCount += 1;
    fieldBytes = 0;
    inField = false;
    if (fieldsOnLine > IMPORT_LIMITS.fieldsPerRecord) {
      return `Import refused before parsing: line ${lineCount} has more than ${IMPORT_LIMITS.fieldsPerRecord} fields.`;
    }
    if (fieldCount > IMPORT_LIMITS.totalFields) {
      return `Import refused before parsing: input has more than ${IMPORT_LIMITS.totalFields.toLocaleString()} fields.`;
    }
    return null;
  };

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) ?? 0xfffd;
    const char = String.fromCodePoint(codePoint);
    const charUnits = codePoint > 0xffff ? 2 : 1;
    const isNewline = char === "\n";

    if (isNewline) {
      const fieldError = finishField();
      if (fieldError) return fieldError;
      lineCount += 1;
      if (lineCount > IMPORT_LIMITS.lines) {
        return `Import refused before parsing: input has more than ${IMPORT_LIMITS.lines.toLocaleString()} lines.`;
      }
      fieldsOnLine = 0;
      inCsvQuotes = false;
      inBindComment = false;
      index += charUnits;
      continue;
    }

    if (format === "json") {
      index += charUnits;
      continue;
    }

    if (format === "bind") {
      if (inBindComment) {
        index += charUnits;
        continue;
      }
      if (char === ";") {
        const fieldError = finishField();
        if (fieldError) return fieldError;
        inBindComment = true;
        index += charUnits;
        continue;
      }
      if (/\s/.test(char)) {
        const fieldError = finishField();
        if (fieldError) return fieldError;
        index += charUnits;
        continue;
      }
    } else {
      if (char === '"') {
        if (inCsvQuotes && text[index + 1] === '"') {
          fieldBytes += 1;
          index += 2;
          continue;
        }
        inCsvQuotes = !inCsvQuotes;
        inField = true;
        index += charUnits;
        continue;
      }
      if (char === "," && !inCsvQuotes) {
        const fieldError = finishField();
        if (fieldError) return fieldError;
        index += charUnits;
        continue;
      }
    }

    inField = true;
    fieldBytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (fieldBytes > IMPORT_LIMITS.fieldBytes) {
      return `Import refused before parsing: a field on line ${lineCount} exceeds ${IMPORT_LIMITS.fieldBytes.toLocaleString()} UTF-8 bytes.`;
    }
    index += charUnits;
  }

  const fieldError = finishField();
  return fieldError;
}

/**
 * Copy only the supported DNS import shape into bounded retained state.
 * Rejected/truncated source records are counted and surfaced to the preview.
 */
export function boundParsedImportItems(value: unknown): BoundedImportResult {
  if (!Array.isArray(value)) {
    return {
      items: [],
      sourceCount: 0,
      rejectedCount: 0,
      diagnostics: [
        "Import refused: the parsed value does not contain a records array.",
      ],
    };
  }

  const sourceCount = value.length;
  const processCount = Math.min(sourceCount, IMPORT_LIMITS.records);
  const items: Partial<DNSRecord>[] = [];
  let rejectedCount = sourceCount - processCount;
  let oversizedFields = 0;
  let excessiveFieldRecords = 0;
  let invalidEntries = 0;
  let totalFields = 0;
  let retainedBytes = 0;
  let aggregateLimitReached = false;

  for (let index = 0; index < processCount; index += 1) {
    const raw = value[index];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      invalidEntries += 1;
      rejectedCount += 1;
      continue;
    }

    const record = raw as Record<string, unknown>;
    let ownFieldCount = 0;
    let unsafeField = false;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      ownFieldCount += 1;
      if (ownFieldCount > IMPORT_LIMITS.fieldsPerRecord) {
        unsafeField = true;
        break;
      }
      const fieldValue = record[key];
      if (
        typeof fieldValue === "string" &&
        utf8ByteLengthUpTo(fieldValue, IMPORT_LIMITS.fieldBytes) >
          IMPORT_LIMITS.fieldBytes
      ) {
        unsafeField = true;
        oversizedFields += 1;
        break;
      }
    }
    if (ownFieldCount > IMPORT_LIMITS.fieldsPerRecord) {
      excessiveFieldRecords += 1;
    }
    totalFields += ownFieldCount;
    if (totalFields > IMPORT_LIMITS.totalFields) {
      rejectedCount += processCount - index;
      aggregateLimitReached = true;
      break;
    }
    if (unsafeField) {
      rejectedCount += 1;
      continue;
    }

    const bounded: Partial<DNSRecord> = {};
    let recordBytes = 0;
    for (const field of IMPORT_STRING_FIELDS) {
      const fieldValue = record[field];
      if (typeof fieldValue !== "string") continue;
      const retained = retainUtf8(fieldValue, IMPORT_LIMITS.fieldBytes);
      if (retained.truncated) {
        unsafeField = true;
        oversizedFields += 1;
        break;
      }
      bounded[field] = retained.value;
      recordBytes += retained.bytes;
    }
    if (unsafeField) {
      rejectedCount += 1;
      continue;
    }

    if (
      record.ttl === "auto" ||
      (typeof record.ttl === "number" && Number.isFinite(record.ttl))
    ) {
      bounded.ttl = record.ttl;
    }
    if (
      typeof record.priority === "number" &&
      Number.isFinite(record.priority)
    ) {
      bounded.priority = record.priority;
    }
    if (typeof record.proxied === "boolean") {
      bounded.proxied = record.proxied;
    }

    if (retainedBytes + recordBytes > IMPORT_LIMITS.retainedBytes) {
      rejectedCount += processCount - index;
      aggregateLimitReached = true;
      break;
    }
    retainedBytes += recordBytes;
    items.push(bounded);
  }

  const diagnostics: string[] = [];
  if (sourceCount > IMPORT_LIMITS.records) {
    diagnostics.push(
      `${(sourceCount - IMPORT_LIMITS.records).toLocaleString()} records were rejected because the ${IMPORT_LIMITS.records.toLocaleString()}-record import limit was reached.`,
    );
  }
  if (oversizedFields > 0) {
    diagnostics.push(
      `${oversizedFields.toLocaleString()} record fields exceeded ${IMPORT_LIMITS.fieldBytes.toLocaleString()} UTF-8 bytes; their records were rejected.`,
    );
  }
  if (excessiveFieldRecords > 0) {
    diagnostics.push(
      `${excessiveFieldRecords.toLocaleString()} records exceeded ${IMPORT_LIMITS.fieldsPerRecord} fields and were rejected.`,
    );
  }
  if (invalidEntries > 0) {
    diagnostics.push(
      `${invalidEntries.toLocaleString()} non-object entries were rejected.`,
    );
  }
  if (aggregateLimitReached) {
    diagnostics.push(
      `Remaining records were rejected when the ${formatByteLimit(
        IMPORT_LIMITS.retainedBytes,
      )} retained-data budget or ${IMPORT_LIMITS.totalFields.toLocaleString()}-field budget was reached.`,
    );
  }

  return { items, sourceCount, rejectedCount, diagnostics };
}

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
  importFormat: ImportFormat;
  /** Callback invoked when user edits the import data */
  onImportDataChange: (data: string) => void;
  /** Callback invoked when user selects a different import format */
  onImportFormatChange: (format: ImportFormat) => void;
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
  const [previewSourceCount, setPreviewSourceCount] = useState(0);
  const [previewRejectedCount, setPreviewRejectedCount] = useState(0);
  const [previewDiagnostics, setPreviewDiagnostics] = useState<string[]>([]);
  const [importDiagnostic, setImportDiagnostic] = useState<string | null>(null);
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
              <Textarea
                className="w-full h-32 resize-none"
                value={importData}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
                  const nextValue = e.target.value;
                  if (
                    utf8ByteLengthUpTo(nextValue, IMPORT_LIMITS.inputBytes) >
                    IMPORT_LIMITS.inputBytes
                  ) {
                    setImportDiagnostic(
                      `Input was not retained because it exceeds ${formatByteLimit(
                        IMPORT_LIMITS.inputBytes,
                      )}. Split the zone data into smaller files.`,
                    );
                    return;
                  }
                  setImportDiagnostic(null);
                  onImportDataChange(nextValue);
                }}
                placeholder={`Paste your ${importFormat.toUpperCase()} data here...`}
              />
              {importDiagnostic && (
                <p
                  className="max-h-24 overflow-y-auto break-words [overflow-wrap:anywhere] text-sm text-destructive"
                  data-testid="import-limit-diagnostic"
                  role="alert"
                >
                  {importDiagnostic}
                </p>
              )}
            </div>
            <Button
              onClick={async () => {
                const preflightDiagnostic = preflightImportText(
                  importData,
                  importFormat,
                );
                if (preflightDiagnostic) {
                  setImportDiagnostic(preflightDiagnostic);
                  setShowPreview(false);
                  return;
                }

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
                      items = isDesktop()
                        ? ((await TauriClient.parseCsvRecords(
                            importData,
                          )) as unknown as Partial<Record<string, unknown>>[])
                        : parseCSVRecords
                          ? parseCSVRecords(importData)
                          : null;
                      break;
                    case "bind":
                      items = isDesktop()
                        ? ((await TauriClient.parseBindZone(
                            importData,
                          )) as unknown as Partial<Record<string, unknown>>[])
                        : parseBINDZone
                          ? parseBINDZone(importData)
                          : null;
                      break;
                  }
                } catch {
                  setImportDiagnostic(
                    `The ${importFormat.toUpperCase()} data could not be parsed. No records were retained or sent for import.`,
                  );
                  setShowPreview(false);
                  return;
                }

                if (!items) {
                  setImportDiagnostic(
                    `The ${importFormat.toUpperCase()} data did not contain a records array. No records were retained or sent for import.`,
                  );
                  setShowPreview(false);
                  return;
                }
                const bounded = boundParsedImportItems(items);
                if (bounded.items.length === 0) {
                  setImportDiagnostic(
                    bounded.diagnostics.join(" ") ||
                      "No bounded DNS records were available to preview.",
                  );
                  setShowPreview(false);
                  return;
                }
                setImportDiagnostic(null);
                setPreviewItems(bounded.items);
                setPreviewSourceCount(bounded.sourceCount);
                setPreviewRejectedCount(bounded.rejectedCount);
                setPreviewDiagnostics(bounded.diagnostics);
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
          sourceItemCount={previewSourceCount}
          rejectedItemCount={previewRejectedCount}
          diagnostics={previewDiagnostics}
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
