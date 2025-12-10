import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Label } from "@/components/ui/Label";
import { Button } from "@/components/ui/Button";
import type { DNSRecord } from "@/types/dns";

interface ImportPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: Partial<DNSRecord>[];
  onConfirm: (items: Partial<DNSRecord>[], dryRun?: boolean) => void;
  onCancel: () => void;
}

export function ImportPreviewDialog({
  open,
  onOpenChange,
  items,
  onConfirm,
  onCancel,
}: ImportPreviewDialogProps) {
  const [selected, setSelected] = useState<boolean[]>([]);
  const [dryRun, setDryRun] = useState(false);

  useEffect(() => {
    setSelected(items.map(() => true));
  }, [items]);

  const toggle = (index: number) => {
    setSelected((s) => s.map((v, i) => (i === index ? !v : v)));
  };

  const validItems = items.map((it) =>
    Boolean(it && it.type && it.name && it.content),
  );
  const validCount = validItems.filter(Boolean).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import Preview</DialogTitle>
          <DialogDescription>
            Review parsed records before importing. Only selected and valid
            records will be imported.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">
            Parsed records: {items.length} — valid: {validCount}
          </div>
          <div className="max-h-64 overflow-y-auto border p-2 rounded">
            {items.map((it, idx) => (
              <div
                key={idx}
                className="flex items-center gap-2 p-2 border-b last:border-b-0"
              >
                <input
                  type="checkbox"
                  checked={!!selected[idx]}
                  onChange={() => toggle(idx)}
                  className="mr-2"
                />
                <div className="flex-1">
                  <div className="font-mono text-sm">
                    {it.type} {it.name}
                  </div>
                  <div className="text-xs text-muted-foreground break-all">
                    {it.content}
                  </div>
                </div>
                <div className="text-xs ml-4">
                  {it.ttl ?? ""} {it.priority ?? ""}{" "}
                  {it.proxied ? "proxied" : ""}
                </div>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <div className="flex items-center gap-2">
              <Label>Dry Run</Label>
              <input
                type="checkbox"
                checked={dryRun}
                onChange={() => setDryRun(!dryRun)}
              />
            </div>
            <Button
              onClick={() => {
                const toImport = items.filter(
                  (_, idx) =>
                    selected[idx] &&
                    Boolean(
                      items[idx] &&
                        items[idx].type &&
                        items[idx].name &&
                        items[idx].content,
                    ),
                );
                onConfirm(toImport, dryRun);
              }}
              className="flex-1"
            >
              Import Selected
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                onCancel();
              }}
              className="flex-1"
            >
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
