/**
 * Bulk Edit/Delete bar — allows batch operations on selected DNS records.
 * Displayed as a sticky action bar when records are selected.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface BulkEditBarProps {
  selectedCount: number;
  onBulkDelete: () => Promise<void>;
  onDeselectAll: () => void;
  onBulkSetTTL?: (ttl: number) => Promise<void>;
  onBulkSetProxy?: (proxied: boolean) => Promise<void>;
  onBulkExport?: () => void;
}

const TTL_OPTIONS = [
  { value: "1", label: "Auto" },
  { value: "60", label: "1 min" },
  { value: "300", label: "5 min" },
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
];

export function BulkEditBar({
  selectedCount,
  onBulkDelete,
  onDeselectAll,
  onBulkSetTTL,
  onBulkSetProxy,
  onBulkExport,
}: BulkEditBarProps) {
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [applying, setApplying] = useState(false);

  if (selectedCount === 0) return null;

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await onBulkDelete();
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleSetTTL = async (val: string) => {
    if (!onBulkSetTTL) return;
    setApplying(true);
    try {
      await onBulkSetTTL(parseInt(val, 10));
    } finally {
      setApplying(false);
    }
  };

  const handleSetProxy = async (proxied: boolean) => {
    if (!onBulkSetProxy) return;
    setApplying(true);
    try {
      await onBulkSetProxy(proxied);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="sticky bottom-0 z-20 flex items-center justify-between gap-3 rounded-t-lg border-t bg-card/95 px-4 py-2 shadow-lg backdrop-blur-sm">
      <span className="text-sm font-medium">
        {selectedCount} record{selectedCount !== 1 ? "s" : ""} selected
      </span>
      <div className="flex items-center gap-2">
        {onBulkSetTTL && (
          <Select onValueChange={handleSetTTL} disabled={applying}>
            <SelectTrigger className="h-7 w-28 text-xs">
              <SelectValue placeholder="Set TTL" />
            </SelectTrigger>
            <SelectContent>
              {TTL_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {onBulkSetProxy && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => handleSetProxy(true)}
              disabled={applying}
            >
              Proxy On
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => handleSetProxy(false)}
              disabled={applying}
            >
              Proxy Off
            </Button>
          </>
        )}
        {onBulkExport && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onBulkExport}>
            Export
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDeselectAll}>
          Deselect All
        </Button>
        <Button
          size="sm"
          variant={confirmDelete ? "destructive" : "outline"}
          onClick={handleDelete}
          disabled={deleting}
        >
          {deleting
            ? "Deleting…"
            : confirmDelete
              ? `Confirm Delete (${selectedCount})`
              : `Delete ${selectedCount}`}
        </Button>
        {confirmDelete && !deleting && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmDelete(false)}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
