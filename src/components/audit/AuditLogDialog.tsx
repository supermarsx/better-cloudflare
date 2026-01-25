import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { TauriClient } from "@/lib/tauri-client";
import { isDesktop } from "@/lib/environment";

type AuditEntry = {
  timestamp?: string;
  operation?: string;
  resource?: string;
  [key: string]: unknown;
};

interface AuditLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AuditLogDialog({ open, onOpenChange }: AuditLogDialogProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "audit-log.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportCsv = () => {
    const headers = ["timestamp", "operation", "resource", "details"];
    const rows = entries.map((entry) => {
      const details = { ...entry };
      delete details.timestamp;
      delete details.operation;
      delete details.resource;
      return [
        entry.timestamp ?? "",
        entry.operation ?? "",
        entry.resource ?? "",
        JSON.stringify(details),
      ];
    });
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const csv =
      headers.map(escape).join(",") +
      "\n" +
      rows.map((row) => row.map(escape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "audit-log.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (!open) return;
    if (!isDesktop()) {
      setError("Audit log is only available in the desktop app.");
      return;
    }
    setLoading(true);
    setError(null);
    TauriClient.getAuditEntries()
      .then((list) => {
        const items = Array.isArray(list) ? (list as AuditEntry[]) : [];
        setEntries(items);
      })
      .catch((err) => {
        setError((err as Error).message);
      })
      .finally(() => setLoading(false));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Audit Log</DialogTitle>
          <DialogDescription>
            Recent sensitive actions captured by the desktop backend.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {loading && <div className="text-sm">Loading...</div>}
          {error && <div className="text-sm text-destructive">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="text-sm text-muted-foreground">
              No audit entries recorded yet.
            </div>
          )}
          {!loading && !error && entries.length > 0 && (
            <div className="max-h-[420px] overflow-auto space-y-2">
              {entries.map((entry, index) => (
                <div
                  className="rounded-md border p-3 text-sm"
                  key={`${entry.timestamp ?? "entry"}-${index}`}
                >
                  <div className="font-medium">
                    {entry.operation ?? "operation"}
                  </div>
                  <div className="text-muted-foreground">
                    {entry.timestamp ?? "unknown time"}
                  </div>
                  {entry.resource && (
                    <div className="font-mono text-xs mt-1">
                      {String(entry.resource)}
                    </div>
                  )}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Details
                    </summary>
                    <pre className="text-xs whitespace-pre-wrap mt-2">
                      {JSON.stringify(entry, null, 2)}
                    </pre>
                  </details>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between">
            {entries.length > 0 && (
              <div className="flex gap-2">
                <Button variant="outline" onClick={exportJson}>
                  Export JSON
                </Button>
                <Button variant="outline" onClick={exportCsv}>
                  Export CSV
                </Button>
              </div>
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
