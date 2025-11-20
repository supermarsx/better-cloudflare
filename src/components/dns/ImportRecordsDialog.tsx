/**
 * Simple import dialog to paste JSON payloads and import DNS records into the
 * current zone. This component is a light overlay that validates JSON
 * client-side and forwards the payload to the parent for processing.
 */
import { ImportExportDialog } from './import-export-dialog';

/**
 * Deprecated wrapper that forwards to ImportExportDialog with JSON format.
 * Kept for compatibility with older imports.
 */
export function ImportRecordsDialog({ open, onOpenChange, data, onDataChange, onImport }: any) {
  return (
    <ImportExportDialog
      open={open}
      onOpenChange={onOpenChange}
      importData={data}
      importFormat={'json'}
      onImportDataChange={onDataChange}
      onImportFormatChange={() => {}}
      onImport={onImport}
      onExport={() => {}}
    />
  );
}

/**
 * Props for a dialog to import JSON-formatted DNS records into the
 * application. This is a simplified dialog used in the UI to paste JSON
 * text.
 */
export interface ImportRecordsDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback invoked when the dialog open state changes */
  onOpenChange: (open: boolean) => void;
  /** The JSON data being imported */
  data: string;
  /** Callback when the import data field changes */
  onDataChange: (val: string) => void;
  /** Callback to trigger the import */
  onImport: () => void;
}

/**
 * Component rendering an Import dialog that accepts JSON payload for DNS
 * records and invokes `onImport` when the user accepts.
 */
// deprecated: handled by ImportExportDialog wrapper above
