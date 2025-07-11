import { ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Upload } from 'lucide-react';

export interface ImportRecordsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: string;
  onDataChange: (val: string) => void;
  onImport: () => void;
}

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
