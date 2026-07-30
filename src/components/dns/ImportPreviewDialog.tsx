import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type { DNSRecord } from "@/types/dns";

interface ImportPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: Partial<DNSRecord>[];
  onConfirm: (items: Partial<DNSRecord>[], dryRun?: boolean) => void;
  onCancel: () => void;
  sourceItemCount?: number;
  rejectedItemCount?: number;
  diagnostics?: string[];
}

export const IMPORT_PREVIEW_VISIBLE_ROW_LIMIT = 200;

export function ImportPreviewDialog({
  open,
  onOpenChange,
  items,
  onConfirm,
  onCancel,
  sourceItemCount = items.length,
  rejectedItemCount = 0,
  diagnostics = [],
}: ImportPreviewDialogProps) {
  const [selected, setSelected] = useState<boolean[]>([]);
  const [dryRun, setDryRun] = useState(false);
  const [page, setPage] = useState(1);

  const validItems = useMemo(
    () => items.map((it) => Boolean(it && it.type && it.name && it.content)),
    [items],
  );

  useEffect(() => {
    setSelected(validItems);
    setPage(1);
  }, [validItems]);

  const toggle = (index: number) => {
    setSelected((s) => s.map((v, i) => (i === index ? !v : v)));
  };

  const validCount = validItems.filter(Boolean).length;
  const selectedValidCount = selected.reduce(
    (count, value, index) => count + (value && validItems[index] ? 1 : 0),
    0,
  );
  const pageCount = Math.max(
    1,
    Math.ceil(items.length / IMPORT_PREVIEW_VISIBLE_ROW_LIMIT),
  );
  const currentPage = Math.min(page, pageCount);
  const visibleStart = (currentPage - 1) * IMPORT_PREVIEW_VISIBLE_ROW_LIMIT;
  const visibleItems = items.slice(
    visibleStart,
    visibleStart + IMPORT_PREVIEW_VISIBLE_ROW_LIMIT,
  );

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
            Parsed records: {sourceItemCount} — retained: {items.length} —
            valid: {validCount} — selected: {selectedValidCount}
          </div>
          {rejectedItemCount > 0 && (
            <div
              className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-700 dark:text-yellow-300"
              data-testid="import-preview-rejection"
              role="status"
            >
              {rejectedItemCount.toLocaleString()} source records were rejected
              by safety limits and cannot be selected or imported.
            </div>
          )}
          {diagnostics.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {diagnostics.map((diagnostic) => (
                <li key={diagnostic}>{diagnostic}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setSelected(validItems)}
              >
                Select all retained valid
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setSelected(items.map(() => false))}
              >
                Clear selection
              </Button>
            </div>
            {pageCount > 1 && (
              <div className="flex items-center gap-2 text-xs">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </Button>
                <span>
                  Rows {visibleStart + 1}–
                  {Math.min(items.length, visibleStart + visibleItems.length)}{" "}
                  of {items.length}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setPage((value) => Math.min(pageCount, value + 1))
                  }
                  disabled={currentPage === pageCount}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto border p-2 rounded">
            {visibleItems.map((it, visibleIndex) => {
              const idx = visibleStart + visibleIndex;
              return (
                <div
                  key={idx}
                  data-testid="import-preview-row"
                  className="flex items-center gap-2 p-2 border-b last:border-b-0"
                >
                  <input
                    type="checkbox"
                    checked={!!selected[idx]}
                    onChange={() => toggle(idx)}
                    disabled={!validItems[idx]}
                    aria-label={`Select retained record ${idx + 1}`}
                    className="checkbox-themed mr-2"
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
              );
            })}
          </div>

          <div className="flex gap-2">
            <div className="flex items-center gap-2">
              <Label>Dry Run</Label>
              <input
                type="checkbox"
                checked={dryRun}
                onChange={() => setDryRun(!dryRun)}
                className="checkbox-themed"
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
