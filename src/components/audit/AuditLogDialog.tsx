import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TauriClient } from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import { withObjectUrl } from "@/lib/runtime/resource-scope";

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
  const mountedRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const exportAudit = async (format: "json" | "csv") => {
    try {
      const data = await TauriClient.exportAuditEntries(format);
      if (!mountedRef.current) return;
      const mime = format === "json" ? "application/json" : "text/csv";
      const blob = new Blob([data], { type: mime });
      withObjectUrl(blob, (url) => {
        const link = document.createElement("a");
        link.href = url;
        link.download = `audit-log.${format}`;
        document.body.append(link);
        try {
          link.click();
        } finally {
          link.remove();
        }
      });
    } catch (exportError) {
      if (!mountedRef.current) return;
      setError(
        exportError instanceof Error
          ? exportError.message
          : "Audit export failed unexpectedly.",
      );
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    if (!open) return;
    if (!isDesktop()) {
      setError("Audit log is only available in the desktop app.");
      return;
    }
    setLoading(true);
    setError(null);
    let active = true;
    void TauriClient.getAuditEntries()
      .then((list) => {
        if (!active || loadGenerationRef.current !== generation) return;
        const items = Array.isArray(list) ? (list as AuditEntry[]) : [];
        setEntries(items);
      })
      .catch((err) => {
        if (!active || loadGenerationRef.current !== generation) return;
        setError(
          err instanceof Error
            ? err.message
            : "Audit entries could not be loaded.",
        );
      })
      .finally(() => {
        if (!active || loadGenerationRef.current !== generation) return;
        setLoading(false);
      });
    return () => {
      active = false;
    };
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
                <Button
                  variant="outline"
                  onClick={() => void exportAudit("json")}
                >
                  Export JSON
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void exportAudit("csv")}
                >
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
