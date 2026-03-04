/**
 * Bulk Edit/Delete bar — allows batch operations on selected DNS records.
 * Displayed as a sticky action bar when records are selected.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface BulkEditBarProps {
  selectedCount: number;
  onBulkDelete: () => Promise<void>;
  onDeselectAll: () => void;
}

export function BulkEditBar({ selectedCount, onBulkDelete, onDeselectAll }: BulkEditBarProps) {
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  return (
    <div className="sticky bottom-0 z-20 flex items-center justify-between gap-3 rounded-t-lg border-t bg-card/95 px-4 py-2 shadow-lg backdrop-blur-sm">
      <span className="text-sm font-medium">
        {selectedCount} record{selectedCount !== 1 ? "s" : ""} selected
      </span>
      <div className="flex items-center gap-2">
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
