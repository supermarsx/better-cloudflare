/**
 * Simple import dialog to paste JSON payloads and import DNS records into the
 * current zone. This component is a light overlay that validates JSON
 * client-side and forwards the payload to the parent for processing.
 */
import type { ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Upload } from 'lucide-react';

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
export function ImportRecordsDialog({ open, onOpenChange, data, onDataChange, onImport }: ImportRecordsDialogProps) {
  return (
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
              value={data}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onDataChange(e.target.value)}
              placeholder="Paste your JSON data here..."
            />
          </div>
          <Button onClick={onImport} className="w-full">
            Import Records
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
