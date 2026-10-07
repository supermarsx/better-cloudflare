import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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

/**
 * One stored entry, as `bc_storage::audit::AuditEntry` serialises it.
 *
 * Flat, and open: the backend adds detail keys per operation, and an entry from
 * a newer build has to render rather than break. The named fields are the ones
 * every entry has, plus the ones this dialog reads to say what an action did —
 * `commands::trail` is where their shapes are decided.
 */
type AuditEntry = {
  timestamp?: string;
  operation?: string;
  resource?: string;
  actor?: string;
  outcome?: string;
  /** `{ field: { from, to } }` for an action whose before-state was known. */
  changes?: unknown;
  /** A record's own fields, for a creation, a deletion, or an edit without one. */
  record?: unknown;
  [key: string]: unknown;
};

/**
 * What performed an action, matching `bc_storage::audit::AuditActor`.
 *
 * The backend writes these; the renderer only reads them, so the list is a
 * closed set and anything outside it is treated as the one value the backend
 * also falls back to.
 */
type Actor = "user" | "mcp_client" | "assistant";
type Outcome = "succeeded" | "denied" | "failed";

const ACTOR_LABELS: Record<Actor, string> = {
  user: "You",
  mcp_client: "MCP client",
  assistant: "Assistant",
};

const OUTCOME_LABELS: Record<Outcome, string> = {
  succeeded: "Succeeded",
  denied: "Denied",
  failed: "Failed",
};

const ACTORS: Actor[] = ["user", "mcp_client", "assistant"];
const OUTCOMES: Outcome[] = ["succeeded", "denied", "failed"];

/**
 * The actor an entry names, defaulting to `user`.
 *
 * Mirrors `AuditActor::of` deliberately: entries written before the trail
 * carried an actor have no field to read, and every writer that existed then
 * was a person acting in the app. An unrecognised value reads the same way
 * rather than being hidden from every filter.
 */
function actorOf(entry: AuditEntry): Actor {
  const actor = entry.actor;
  return actor === "mcp_client" || actor === "assistant" ? actor : "user";
}

function outcomeOf(entry: AuditEntry): Outcome | undefined {
  const outcome = entry.outcome;
  return outcome === "succeeded" || outcome === "denied" || outcome === "failed"
    ? outcome
    : undefined;
}

const OUTCOME_CLASSES: Record<Outcome, string> = {
  succeeded: "text-muted-foreground",
  denied: "text-destructive",
  failed: "text-destructive",
};

/** Stands in for a field that was not set on one side of a change. */
const UNSET = "—";

/**
 * One line of "what the action did".
 *
 * `before` is `null` when the entry describes a record rather than a change to
 * one — a creation, a deletion, or an edit whose before-state the caller did
 * not supply. That is a different thing from a field that *was* unset, which
 * the backend writes as a JSON null and which shows as {@link UNSET}; see
 * `commands::trail` for why absence is never used to mean "unset".
 */
type ChangeRow = { field: string; before: string | null; after: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return UNSET;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * What the entry says the action did.
 *
 * `changes` when the before-state was known, `record` otherwise. Only one of
 * the two is ever present, and the renderer does not care which operation
 * produced it: a reader wants the fields either way.
 */
function changeRows(entry: AuditEntry): ChangeRow[] {
  if (isObject(entry.changes)) {
    return Object.entries(entry.changes).map(([field, pair]) => ({
      field,
      before: isObject(pair) ? renderValue(pair.from) : UNSET,
      after: isObject(pair) ? renderValue(pair.to) : renderValue(pair),
    }));
  }
  if (isObject(entry.record)) {
    return Object.entries(entry.record).map(([field, value]) => ({
      field,
      before: null,
      after: renderValue(value),
    }));
  }
  return [];
}

/**
 * Fields the entry could not afford to carry.
 *
 * The backend counts them rather than dropping them silently, so a reader can
 * tell a record that changed in two ways from one whose third change did not
 * fit the entry's budget.
 */
function omittedCount(entry: AuditEntry): number {
  for (const key of ["changes_omitted", "record_omitted", "rule_omitted"]) {
    const value = entry[key];
    if (typeof value === "number" && value > 0) return value;
  }
  return 0;
}

/**
 * Did the action record a change set that turned out to be empty?
 *
 * Worth saying out loud: the user saved a record and nothing about it was
 * different, which is a fact about what happened rather than a gap in the log.
 */
function changedNothing(entry: AuditEntry): boolean {
  return isObject(entry.changes) && Object.keys(entry.changes).length === 0;
}

interface AuditLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AuditLogDialog({ open, onOpenChange }: AuditLogDialogProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actorFilter, setActorFilter] = useState<Actor | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<Outcome | null>(null);
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

  // Counts come from the whole log, not from the visible slice, so a filter
  // button still says how much it would show after another filter narrowed
  // the list.
  const actorCounts = useMemo(() => {
    const counts: Record<Actor, number> = {
      user: 0,
      mcp_client: 0,
      assistant: 0,
    };
    for (const entry of entries) counts[actorOf(entry)] += 1;
    return counts;
  }, [entries]);

  const outcomeCounts = useMemo(() => {
    const counts: Record<Outcome, number> = {
      succeeded: 0,
      denied: 0,
      failed: 0,
    };
    for (const entry of entries) {
      const outcome = outcomeOf(entry);
      if (outcome) counts[outcome] += 1;
    }
    return counts;
  }, [entries]);

  const visible = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (actorFilter === null || actorOf(entry) === actorFilter) &&
          (outcomeFilter === null || outcomeOf(entry) === outcomeFilter),
      ),
    [entries, actorFilter, outcomeFilter],
  );

  const filtered = actorFilter !== null || outcomeFilter !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Audit Log</DialogTitle>
          <DialogDescription>
            What has been done through this app — your own changes, tool calls
            from MCP clients, and the assistant&apos;s, in one record.
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
            <>
              <div
                aria-label="Filter by actor"
                className="flex flex-wrap gap-2"
                role="group"
              >
                <Button
                  aria-pressed={actorFilter === null}
                  onClick={() => setActorFilter(null)}
                  size="sm"
                  variant={actorFilter === null ? "secondary" : "ghost"}
                >
                  {`Everything (${entries.length})`}
                </Button>
                {ACTORS.map((actor) => (
                  <Button
                    aria-pressed={actorFilter === actor}
                    key={actor}
                    onClick={() =>
                      setActorFilter(actorFilter === actor ? null : actor)
                    }
                    size="sm"
                    variant={actorFilter === actor ? "secondary" : "ghost"}
                  >
                    {`${ACTOR_LABELS[actor]} (${actorCounts[actor]})`}
                  </Button>
                ))}
              </div>
              <div
                aria-label="Filter by outcome"
                className="flex flex-wrap gap-2"
                role="group"
              >
                <Button
                  aria-pressed={outcomeFilter === null}
                  onClick={() => setOutcomeFilter(null)}
                  size="sm"
                  variant={outcomeFilter === null ? "secondary" : "ghost"}
                >
                  Any outcome
                </Button>
                {OUTCOMES.map((outcome) => (
                  <Button
                    aria-pressed={outcomeFilter === outcome}
                    key={outcome}
                    onClick={() =>
                      setOutcomeFilter(
                        outcomeFilter === outcome ? null : outcome,
                      )
                    }
                    size="sm"
                    variant={outcomeFilter === outcome ? "secondary" : "ghost"}
                  >
                    {`${OUTCOME_LABELS[outcome]} (${outcomeCounts[outcome]})`}
                  </Button>
                ))}
              </div>
              <div className="text-xs text-muted-foreground">
                {filtered
                  ? `Showing ${visible.length} of ${entries.length} entries. Export writes the whole log.`
                  : `${entries.length} entries.`}
              </div>
            </>
          )}
          {!loading && !error && entries.length > 0 && visible.length === 0 && (
            <div className="text-sm text-muted-foreground">
              No entries match this filter.
            </div>
          )}
          {!loading && !error && visible.length > 0 && (
            <div className="max-h-[420px] scrollbar-themed overflow-auto space-y-2">
              {visible.map((entry, index) => {
                const actor = actorOf(entry);
                const outcome = outcomeOf(entry);
                const rows = changeRows(entry);
                const omitted = omittedCount(entry);
                const subject = [
                  text(entry.record_type),
                  text(entry.record_name),
                ]
                  .filter(Boolean)
                  .join(" ");
                const reason =
                  text(entry.denied_by) ?? text(entry.failure) ?? null;
                return (
                  <div
                    className="rounded-md border p-3 text-sm"
                    key={`${entry.timestamp ?? "entry"}-${index}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="font-medium">
                        {entry.operation ?? "operation"}
                      </div>
                      <div className="text-xs text-muted-foreground shrink-0">
                        {ACTOR_LABELS[actor]}
                      </div>
                    </div>
                    <div className="text-muted-foreground">
                      {entry.timestamp ?? "unknown time"}
                      {outcome && (
                        <span
                          className={`ml-2 text-xs ${OUTCOME_CLASSES[outcome]}`}
                        >
                          {OUTCOME_LABELS[outcome]}
                        </span>
                      )}
                      {reason && (
                        <span className="ml-2 text-xs text-destructive">
                          {reason}
                        </span>
                      )}
                    </div>
                    {subject && <div className="mt-1">{subject}</div>}
                    {entry.resource && (
                      <div className="font-mono text-xs mt-1">
                        {String(entry.resource)}
                      </div>
                    )}
                    {rows.length > 0 && (
                      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
                        {rows.map((row) => (
                          <Fragment key={row.field}>
                            <dt className="text-muted-foreground">
                              {row.field}
                            </dt>
                            <dd className="font-mono break-all">
                              {row.before === null
                                ? row.after
                                : `${row.before} → ${row.after}`}
                            </dd>
                          </Fragment>
                        ))}
                      </dl>
                    )}
                    {changedNothing(entry) && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        No fields changed.
                      </div>
                    )}
                    {omitted > 0 && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {`${omitted} further ${omitted === 1 ? "field was" : "fields were"} not recorded.`}
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
                );
              })}
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
