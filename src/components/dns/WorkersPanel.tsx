/**
 * Worker Routes panel — view, create and delete Cloudflare Worker routes
 * bound to the current zone.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

interface WorkerRoute {
  id: string;
  pattern: string;
  script: string;
}

interface WorkersPanelProps {
  zoneId: string;
  getWorkerRoutes: (zoneId: string, signal?: AbortSignal) => Promise<unknown[]>;
  createWorkerRoute: (
    zoneId: string,
    pattern: string,
    script: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  deleteWorkerRoute: (zoneId: string, routeId: string, signal?: AbortSignal) => Promise<void>;
}

function WorkersPanelInner({
  zoneId,
  getWorkerRoutes,
  createWorkerRoute,
  deleteWorkerRoute,
}: WorkersPanelProps) {
  const [routes, setRoutes] = useState<WorkerRoute[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newPattern, setNewPattern] = useState("");
  const [newScript, setNewScript] = useState("");

  const fetchRoutes = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const result = (await getWorkerRoutes(zoneId, signal)) as WorkerRoute[];
        if (!signal?.aborted) setRoutes(result);
      } catch (err) {
        if (!signal?.aborted) {
          setError(err instanceof Error ? err.message : "Failed to load worker routes");
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [zoneId, getWorkerRoutes],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchRoutes(controller.signal);
    return () => controller.abort();
  }, [fetchRoutes]);

  const handleCreate = async () => {
    if (!newPattern.trim() || !newScript.trim()) return;
    try {
      await createWorkerRoute(zoneId, newPattern, newScript);
      setNewPattern("");
      setNewScript("");
      fetchRoutes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create route");
    }
  };

  const handleDelete = async (routeId: string) => {
    try {
      await deleteWorkerRoute(zoneId, routeId);
      setRoutes((prev) => prev.filter((r) => r.id !== routeId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete route");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Worker Routes</h3>
        <Button size="sm" variant="outline" onClick={() => fetchRoutes()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">New Route</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <div className="flex-1">
              <Label className="text-xs">Pattern</Label>
              <Input
                value={newPattern}
                onChange={(e) => setNewPattern(e.target.value)}
                placeholder="example.com/api/*"
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="flex-1">
              <Label className="text-xs">Script Name</Label>
              <Input
                value={newScript}
                onChange={(e) => setNewScript(e.target.value)}
                placeholder="my-worker"
                className="h-8 text-xs"
              />
            </div>
          </div>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!newPattern.trim() || !newScript.trim()}
          >
            Create Route
          </Button>
        </CardContent>
      </Card>

      {routes.length > 0 ? (
        <div className="space-y-1">
          {routes.map((route) => (
            <div
              key={route.id}
              className="flex items-center justify-between rounded-md border px-3 py-2"
            >
              <div className="space-y-0.5">
                <p className="font-mono text-xs">{route.pattern}</p>
                <p className="text-[11px] text-muted-foreground">→ {route.script}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => handleDelete(route.id)}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      ) : (
        !loading && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No worker routes configured
          </p>
        )
      )}

      {loading && routes.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">Loading worker routes…</p>
        </div>
      )}
    </div>
  );
}

export function WorkersPanel(props: WorkersPanelProps) {
  return (
    <ErrorBoundary label="workers">
      <WorkersPanelInner {...props} />
    </ErrorBoundary>
  );
}
