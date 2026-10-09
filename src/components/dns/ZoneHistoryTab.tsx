/**
 * Zone History — one zone's audit trail, newest first, with the undo it still
 * offers.
 *
 * # What this screen exists to make visible
 *
 * `src/lib/history/types.ts` explains the shape this UI is built around:
 * **history reaches further back than undo does.** The list comes from the
 * audit trail, which is a log — every value goes through a shortener and every
 * entry has a byte budget — while undo is applied from the retention store,
 * which expires and evicts. So an operation can be perfectly present in the
 * list and impossible to undo, and that is normal rather than a fault.
 *
 * Two consequences are load-bearing, and both are the opposite of the obvious
 * implementation:
 *
 *  1. **A row that cannot be undone keeps its place and says why, in words.**
 *     Not a greyed-out button, not a tooltip: a sentence naming the reason —
 *     "the saved copy expired on 3 March". A disabled control with no
 *     explanation is how a user concludes the feature is broken, and the reason
 *     is the only thing that tells them whether to wait, to retry, or to give
 *     up and fix it by hand.
 *  2. **`changesOmitted` is printed on the row it belongs to.** The trail
 *     dropped part of that change set to stay inside its budget, so the row is
 *     not the whole truth about what happened. A row that looks complete while
 *     hiding that is worse than one that admits it.
 *
 * # What this screen deliberately does not do
 *
 * It never applies an undo. Every undo control opens {@link UndoPreviewDialog},
 * which plans the change against what Cloudflare holds right now and
 * classifies drift first, because silently reverting someone else's later edit
 * is worse than doing nothing.
 *
 * It also never fetches the whole trail. The first paint asks for one
 * {@link ZONE_HISTORY_PAGE_SIZE} page and keeps a cursor; a zone with a long
 * history would otherwise block the subtab's first paint for no benefit.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  RotateCcw,
  Scissors,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { useI18n } from "@/hooks/use-i18n";
import { TauriClient } from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import {
  ZONE_HISTORY_PAGE_SIZE,
  type UndoAvailability,
  type UndoPlanRow,
  type UndoRefusalCode,
  type UndoResult,
  type ZoneHistoryEntry,
  type ZoneHistoryOperation,
} from "@/lib/history/types";

import { UndoPreviewDialog } from "./UndoPreviewDialog";

/** The bound `t` from {@link useI18n}, which every formatter here needs. */
type Translate = ReturnType<typeof useI18n>["t"];

/**
 * How many record rows an expanded operation shows before it offers the rest.
 *
 * A bulk edit over a few hundred records would otherwise render a few hundred
 * rows the moment it is opened, which is the same first-paint cost paging
 * exists to avoid — one level down. The remainder is one click away and the
 * count is stated, so nothing is hidden, only deferred.
 */
export const ZONE_HISTORY_ENTRY_PREVIEW_LIMIT = 5;

/** How many per-field changes one record row prints before summarising. */
export const ZONE_HISTORY_CHANGE_PREVIEW_LIMIT = 3;

/**
 * Field names as a person reads them.
 *
 * The trail records the field by its record-facts name, which is lowercase and
 * occasionally an initialism. An unmapped field is printed as it came, which
 * is wrong-looking but never misleading — the alternative, hiding a field this
 * function has not learned yet, would silently shrink the change set a row
 * claims to describe.
 *
 * Written as a `switch` of literal `t()` calls rather than as a table of
 * strings handed to `t(label, label)`, and the same goes for
 * {@link mappedOperationLabel} below. `scripts/i18n-coverage.mjs` finds keys by
 * reading literal calls out of the source: a label reached through a variable
 * is invisible to it, so it ships untranslated in all twelve locales while the
 * coverage report stays green. That has already happened twice in this repo —
 * to the settings subtab names and to the settings group names — and the zone
 * view's own `ACTION_TABS` labels are living proof it is still happening.
 */
function mappedFieldLabel(field: string, t: Translate): string | null {
  switch (field) {
    case "ttl":
      return t("TTL", "TTL");
    case "name":
      return t("Name", "Name");
    case "type":
      return t("Type", "Type");
    case "content":
      return t("Content", "Content");
    case "priority":
      return t("Priority", "Priority");
    case "proxied":
      return t("Proxied", "Proxied");
    case "comment":
      return t("Comment", "Comment");
    case "tags":
      return t("Tags", "Tags");
    default:
      return null;
  }
}

/**
 * Operation names as a person reads them.
 *
 * Keyed on the bare verb, after the `dns:` namespace the audit trail writes
 * and the `_dns_record` suffix the command names carry are both stripped —
 * `src/lib/history/types.ts` documents the command form (`update_dns_record`)
 * while `src-tauri` writes the namespaced form (`dns:update`), and a label map
 * that only understood one of them would print raw identifiers on screen the
 * first time the other reached it.
 */
function mappedOperationLabel(verb: string, t: Translate): string | null {
  switch (verb) {
    case "create":
      return t("Create", "Create");
    case "update":
      return t("Edit", "Edit");
    case "delete":
      return t("Delete", "Delete");
    case "bulk_create":
      return t("Bulk create", "Bulk create");
    case "bulk_update":
    case "bulk_edit":
      return t("Bulk edit", "Bulk edit");
    case "bulk_delete":
      return t("Bulk delete", "Bulk delete");
    case "disable":
      return t("Disable", "Disable");
    case "restore":
      return t("Restore", "Restore");
    case "retain":
      // Not "Park": this app already ships the sentence "a disabled
      // record is not parked at Cloudflare, it is absent from it", so
      // that label contradicted its own explanation two screens away.
      // Every translator independently refused the literal and reached
      // for the recycle bin's vocabulary instead, which is the tell.
      return t("Recycle", "Recycle");
    case "import":
      return t("Import", "Import");
    case "undo":
      return t("Undo", "Undo");
    default:
      return null;
  }
}

/** `dns:bulk_update` and `update_bulk_dns_records` both reduce to `bulk_update`. */
export function normalizeOperationName(operation: string): string {
  return operation
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:/u, "")
    .replace(/_dns_records?$/u, "")
    .replace(/^dns_/u, "");
}

/**
 * A readable name for one operation.
 *
 * An unmapped verb is humanised rather than dropped: a new write command must
 * show up in history the day it ships, and "Purge cache" read off the
 * identifier is a far smaller problem than a change nobody can see.
 */
export function formatOperationLabel(operation: string, t: Translate): string {
  const key = normalizeOperationName(operation);
  const mapped = mappedOperationLabel(key, t);
  if (mapped !== null) return mapped;
  const humanized = key.replace(/[_-]+/gu, " ").trim();
  if (!humanized) return t("Change", "Change");
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

function formatFieldLabel(field: string, t: Translate): string {
  return mappedFieldLabel(field.trim().toLowerCase(), t) ?? field;
}

/** An empty `from`/`to` is a field that was unset, which has to read as one. */
function formatFieldValue(value: string | null, t: Translate): string {
  if (value === null || value === "") return t("unset", "unset");
  return value;
}

/**
 * The one change every row of an operation made, when there is exactly one.
 *
 * This is what turns thirty-seven rows into "TTL → 300" on the operation line.
 * It is deliberately strict: every entry must have changed the same single
 * field to the same single value. A looser rule — "most rows" or "the first
 * row" — would put a headline on the operation that some of its rows
 * contradict, which is the one thing a summary must never do.
 */
export function findCommonChange(
  entries: readonly ZoneHistoryEntry[],
): { field: string; to: string | null } | null {
  if (entries.length === 0) return null;
  let common: { field: string; to: string | null } | null = null;
  for (const entry of entries) {
    if (entry.changes.length !== 1) return null;
    const [change] = entry.changes;
    if (!change) return null;
    if (common === null) {
      common = { field: change.field, to: change.to };
      continue;
    }
    if (common.field !== change.field || common.to !== change.to) return null;
  }
  return common;
}

/** Time of day for the operation line, with the full stamp kept for `title`. */
export function formatOperationTime(at: string): {
  short: string;
  full: string;
} {
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return { short: at, full: at };
  const date = new Date(parsed);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  // Only today's operations get the bare clock time the design asks for.
  // Yesterday's "14:02" sitting above today's is a date error waiting to be
  // made, so anything older carries its day.
  const short = sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
  return { short, full: `${date.toLocaleString()} | ${date.toISOString()}` };
}

/**
 * "3 March" — the date in an expiry sentence, not a timestamp.
 *
 * `null` when the value will not parse, rather than a stand-in phrase. A
 * caller that has to branch cannot accidentally drop "an unknown date" into a
 * prepositional frame, which is grammatical in English and broken in any
 * language whose preposition carries an article or a case.
 */
function formatExpiryDate(value: string, t: Translate): string | null {
  void t;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

/**
 * The one sentence for a state or code this build has never heard of.
 *
 * Both switches below are exhaustive over their unions, so neither default is
 * reachable from well-typed data — but this data arrives over IPC from a
 * backend that can be a version ahead, so both need a branch. Sharing one
 * sentence rather than writing one each keeps a near-duplicate pair out of
 * twelve translators' queues.
 */
function unrecognisedUndoReason(t: Translate): string {
  return t(
    "This cannot be undone, and this version does not recognise the reason given.",
    "This cannot be undone, and this version does not recognise the reason given.",
  );
}

/**
 * One refusal code, as the sentence a person reads.
 *
 * `src/lib/history/types.ts` sets the rule this implements: a reason **this
 * application** decides travels as a {@link UndoRefusalCode} and becomes a
 * literal `t()` call here. Interpolating the code into a frame —
 * `"…nothing to undo: {{reason}}"` — is what this replaces, and it put
 * `cache-purge` on screen in every locale including English while the
 * coverage report stayed green, because a scanner that reads literal calls
 * cannot see a value that arrives in a variable.
 *
 * Shared by the history list and by the apply path: `DNSManager` turns a
 * planner refusal into prose with this before it reaches the dialog, so there
 * is one wording per code rather than one per caller.
 */
export function describeUndoRefusal(
  code: UndoRefusalCode,
  t: Translate,
): string {
  switch (code) {
    case "stale-record-list":
      return t(
        "This zone's record list is out of date, so there is no record to write to. Refresh the Records tab and undo again.",
        "This zone's record list is out of date, so there is no record to write to. Refresh the Records tab and undo again.",
      );
    case "zone-setting":
      return t(
        "This changed a zone setting rather than a record, so there is nothing to put back.",
        "This changed a zone setting rather than a record, so there is nothing to put back.",
      );
    case "cache-purge":
      return t(
        "This purged the cache rather than changing a record, so there is nothing to put back.",
        "This purged the cache rather than changing a record, so there is nothing to put back.",
      );
    case "dnssec":
      return t(
        "This changed DNSSEC rather than a record, which this feature cannot reverse.",
        "This changed DNSSEC rather than a record, which this feature cannot reverse.",
      );
    case "manifest-truncated":
      return t(
        "Some of the records this created could not be identified, so removing only the rest would be worse than doing nothing.",
        "Some of the records this created could not be identified, so removing only the rest would be worse than doing nothing.",
      );
    case "summary-entry-only":
      return t(
        "The trail recorded this as one summary with no record ids, so there is nothing to undo record by record.",
        "The trail recorded this as one summary with no record ids, so there is nothing to undo record by record.",
      );
    default:
      return unrecognisedUndoReason(t);
  }
}

/**
 * Why this cannot be undone, as a sentence, or `null` when it can.
 *
 * Every branch names the cause and, where there is one, the date. That is the
 * whole point of the function: the user needs to know whether the copy is gone
 * for good, whether their own later delete is in the way, or whether this was
 * never a record change at all — three situations with three different next
 * steps that a single disabled button collapses into "broken".
 */
export function describeUndoAvailability(
  undo: UndoAvailability,
  t: Translate,
): string | null {
  switch (undo.state) {
    case "available":
      return null;
    case "expired": {
      // Two sentences rather than one with a fallback noun phrase. The date is
      // interpolated only when it parses; when it does not, a sentence that
      // never mentions a date is used instead. Substituting "an unknown date"
      // into "expired on {{expiredOn}}" reads in English and breaks in any
      // language whose preposition carries an article or a case — German needs
      // "am" (an dem), and "am ein unbekanntes Datum" is not a sentence.
      // Reported by the agent translating de-DE, which is the only place this
      // was visible.
      const expiredOn = formatExpiryDate(undo.expiredAt, t);
      if (expiredOn === null) {
        return t(
          "The saved copy expired, so this can no longer be undone.",
          "The saved copy expired, so this can no longer be undone.",
        );
      }
      return t(
        "The saved copy expired on {{expiredOn}}, so this can no longer be undone.",
        { expiredOn },
      );
    }
    case "evicted":
      return t(
        "The saved copy was dropped to keep the retention store inside its size limit, so this can no longer be undone.",
        "The saved copy was dropped to keep the retention store inside its size limit, so this can no longer be undone.",
      );
    case "no-snapshot":
      return t(
        "This change was recorded before undo kept copies of records, so there is nothing to restore it from.",
        "This change was recorded before undo kept copies of records, so there is nothing to restore it from.",
      );
    case "superseded-by-delete":
      return t(
        "Undoing this would bring back a record you have since deleted again.",
        "Undoing this would bring back a record you have since deleted again.",
      );
    case "not-undoable":
      return describeUndoRefusal(undo.reason, t);
    default:
      return unrecognisedUndoReason(t);
  }
}

/**
 * "Bulk edit at 14:02" — the fragment the undo dialog puts in its header.
 *
 * Built here rather than in the dialog because the operation is in hand here
 * and because it must already be localised when it crosses the boundary: the
 * dialog renders it verbatim, so a raw `dns:bulk_update` passed across would
 * appear on screen in all twelve locales.
 */
export function describeOperationForDialog(
  operation: ZoneHistoryOperation,
  t: Translate,
): string {
  return t("{{label}} at {{time}}", {
    label: formatOperationLabel(operation.operation, t),
    time: formatOperationTime(operation.at).short,
  });
}

/** The entry ids an undo of this operation would actually be able to write. */
export function undoableEntryIds(
  operation: ZoneHistoryOperation,
): readonly string[] {
  return operation.entries
    .filter((entry) => entry.undo.state === "available")
    .map((entry) => entry.id);
}

/**
 * "Restore" when the change being reversed was a deletion, "Undo" otherwise.
 *
 * Two words for one action, because they describe different things to the
 * person reading them: undoing a delete puts a record back, and calling that
 * "undo" asks the user to work out which direction it goes in.
 */
function undoActionLabel(
  entries: readonly ZoneHistoryEntry[],
  scope: "operation" | "entry",
  t: Translate,
): string {
  const restoring =
    entries.length > 0 && entries.every((entry) => entry.kind === "deleted");
  if (scope === "entry") {
    return restoring ? t("Restore", "Restore") : t("Undo", "Undo");
  }
  if (entries.length <= 1) {
    return restoring ? t("Restore", "Restore") : t("Undo", "Undo");
  }
  return restoring
    ? t("Restore all", "Restore all")
    : t("Undo all", "Undo all");
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/** What the undo dialog is currently being asked about. */
interface UndoTarget {
  operationId: string;
  /** Absent means the whole operation; present scopes it to these rows. */
  entryIds?: readonly string[];
  /** Localised here, where the operation is in hand, not inside the dialog. */
  operationLabel: string;
}

/**
 * The props this tab hands the undo dialog.
 *
 * Declared here rather than imported so that the contract between the two
 * components is checked in one place: `UNDO_PREVIEW_DIALOG` below assigns the
 * real dialog to this type, so a dialog whose props drift from what this tab
 * passes fails `npm run typecheck` instead of failing at the click.
 *
 * `entryIds` is the prop that is easy to leave out and must not be. A row's
 * own undo button has to plan *that row*; without a scope, a single [Undo] on
 * one record of a thirty-seven record bulk edit would preview and apply all
 * thirty-seven. `undefined` means the whole operation, which is what the
 * operation-level button wants.
 */
export interface ZoneHistoryUndoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zoneId: string;
  operationId: string;
  entryIds?: readonly string[];
  /** The preview command is authenticated; the tab forwards what it was given. */
  apiKey: string;
  email?: string;
  /** Already-localised fragment naming the operation, for the dialog's header. */
  operationLabel?: string;
  /**
   * Write the rows the user confirmed, and report what happened per row.
   *
   * The dialog plans and never writes. The write goes through this screen's one
   * applier — the `DNSOp` engine `useUndoRedo` already drives — so the undo
   * lands on the in-memory stack and is immediately redoable, and so there is
   * no second applier to keep in step with the first.
   */
  onConfirm: (rows: readonly UndoPlanRow[]) => Promise<UndoResult>;
  onApplied?: (result: UndoResult) => void;
}

export type ZoneHistoryUndoDialog = ComponentType<ZoneHistoryUndoDialogProps>;

/** The real dialog, type-checked against the contract above. */
const UNDO_PREVIEW_DIALOG: ZoneHistoryUndoDialog = UndoPreviewDialog;

export interface ZoneHistoryTabProps {
  zoneId: string;
  zoneName: string;
  /** Forwarded to the undo dialog, which is where the authenticated preview is. */
  apiKey: string;
  email?: string;
  /**
   * Write a confirmed undo. Supplied by `DNSManager`, which owns the one
   * `DNSOp` applier; the zone is passed explicitly so this function is not
   * bound to whichever zone happens to be open.
   */
  applyUndoRows: (
    zoneId: string,
    rows: readonly UndoPlanRow[],
  ) => Promise<UndoResult>;
  /**
   * Overrides the undo dialog. Only tests pass this: it is how the props the
   * tab sends are asserted without standing up a dialog that reads Cloudflare.
   */
  undoDialog?: ZoneHistoryUndoDialog;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * A chip. Used for the three things that qualify a row rather than describe it
 * — who made the change, whether it all landed, and what the trail dropped —
 * so that none of them can be mistaken for part of the change itself.
 */
function HistoryChip({
  tone,
  icon,
  children,
  testId,
}: {
  tone: "neutral" | "warn";
  icon?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  const palette =
    tone === "warn"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100"
      : "border-border/70 bg-muted/40 text-foreground/80";
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${palette}`}
    >
      {icon}
      {children}
    </span>
  );
}

/** One record's row inside an expanded operation. */
function HistoryEntryRow({
  entry,
  t,
  onUndo,
}: {
  entry: ZoneHistoryEntry;
  t: Translate;
  onUndo: (entry: ZoneHistoryEntry) => void;
}) {
  const reason = describeUndoAvailability(entry.undo, t);
  const shownChanges = entry.changes.slice(
    0,
    ZONE_HISTORY_CHANGE_PREVIEW_LIMIT,
  );
  const hiddenChanges = entry.changes.length - shownChanges.length;

  return (
    <li
      data-testid={`zone-history-entry-${entry.id}`}
      className="flex flex-wrap items-start justify-between gap-2 border-t border-border/40 px-3 py-2 first:border-t-0"
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-xs text-foreground">
            {entry.recordName}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {entry.recordType}
          </span>
          {shownChanges.map((change) => (
            <span key={change.field} className="text-xs text-muted-foreground">
              {formatFieldLabel(change.field, t)}{" "}
              {formatFieldValue(change.from, t)} →{" "}
              {formatFieldValue(change.to, t)}
            </span>
          ))}
          {hiddenChanges > 0 && (
            <span className="text-xs text-muted-foreground">
              {t("and {{hidden}} more fields", { hidden: hiddenChanges })}
            </span>
          )}
        </div>
        {entry.changesOmitted && (
          <HistoryChip
            tone="warn"
            testId={`zone-history-entry-omitted-${entry.id}`}
            icon={<Scissors className="h-3 w-3" aria-hidden="true" />}
          >
            {t(
              "Part of this change was too large for the trail and was not recorded, so this row is not the whole change.",
              "Part of this change was too large for the trail and was not recorded, so this row is not the whole change.",
            )}
          </HistoryChip>
        )}
        {reason !== null && (
          <p
            data-testid={`zone-history-entry-reason-${entry.id}`}
            className="max-w-prose text-xs text-muted-foreground"
          >
            {reason}
          </p>
        )}
      </div>
      {reason === null && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          data-testid={`zone-history-entry-undo-${entry.id}`}
          onClick={() => onUndo(entry)}
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          {undoActionLabel([entry], "entry", t)}
        </Button>
      )}
    </li>
  );
}

/** One user action, collapsed to a line and expandable to its record rows. */
function HistoryOperationRow({
  operation,
  expanded,
  onToggle,
  t,
  onUndoOperation,
  onUndoEntry,
}: {
  operation: ZoneHistoryOperation;
  expanded: boolean;
  onToggle: (operationId: string) => void;
  t: Translate;
  onUndoOperation: (operation: ZoneHistoryOperation) => void;
  onUndoEntry: (
    operation: ZoneHistoryOperation,
    entry: ZoneHistoryEntry,
  ) => void;
}) {
  const [showAllEntries, setShowAllEntries] = useState(false);
  const time = formatOperationTime(operation.at);
  const label = formatOperationLabel(operation.operation, t);
  const entries = operation.entries;
  const common = useMemo(() => findCommonChange(entries), [entries]);
  const undoable = useMemo(() => undoableEntryIds(operation), [operation]);
  const blocked = entries.length - undoable.length;
  const panelId = `zone-history-entries-${operation.operationId}`;

  /**
   * The reason, when it is the same reason for every row.
   *
   * One sentence is what the user needs for an operation whose snapshots all
   * aged out together, which is the common case. When the rows disagree the
   * operation line says only that some are blocked and the rows carry their
   * own reasons, because a single sentence that is true of only half of them
   * would be a worse answer than no sentence.
   */
  const sharedReason = useMemo(() => {
    if (entries.length === 0 || undoable.length > 0) return null;
    const reasons = new Set(
      entries.map((entry) => describeUndoAvailability(entry.undo, t)),
    );
    if (reasons.size !== 1) return null;
    return [...reasons][0] ?? null;
  }, [entries, undoable.length, t]);

  const shownEntries = showAllEntries
    ? entries
    : entries.slice(0, ZONE_HISTORY_ENTRY_PREVIEW_LIMIT);
  const hiddenEntries = entries.length - shownEntries.length;

  return (
    <li
      data-testid={`zone-history-operation-${operation.operationId}`}
      className="rounded-xl border border-border/60 bg-card/60"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="flex min-w-0 items-start gap-2">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            data-testid={`zone-history-toggle-${operation.operationId}`}
            onClick={() => onToggle(operation.operationId)}
            className="ui-focus mt-0.5 shrink-0 rounded text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            )}
            <span className="sr-only">
              {expanded
                ? t(
                    "Hide the records this change touched",
                    "Hide the records this change touched",
                  )
                : t(
                    "Show the records this change touched",
                    "Show the records this change touched",
                  )}
            </span>
          </button>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span
                className="font-mono text-xs text-muted-foreground"
                title={time.full}
              >
                {time.short}
              </span>
              <span className="text-sm font-medium text-foreground">
                {label}
              </span>
              <span className="text-xs text-muted-foreground">
                {entries.length === 1 && entries[0]
                  ? entries[0].recordName
                  : t("{{records}} records", { records: entries.length })}
              </span>
              {common !== null && (
                <span className="text-xs text-muted-foreground">
                  {formatFieldLabel(common.field, t)} →{" "}
                  {formatFieldValue(common.to, t)}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {operation.actor !== "user" && (
                <HistoryChip tone="neutral">
                  {operation.actor === "assistant"
                    ? t("Made by the assistant", "Made by the assistant")
                    : t("Made over MCP", "Made over MCP")}
                </HistoryChip>
              )}
              {operation.outcome !== "ok" && (
                <HistoryChip
                  tone="warn"
                  icon={
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  }
                >
                  {operation.outcome === "partial"
                    ? t(
                        "Only part of this change landed",
                        "Only part of this change landed",
                      )
                    : t("This change failed", "This change failed")}
                </HistoryChip>
              )}
              {operation.truncated && (
                <HistoryChip
                  tone="warn"
                  testId={`zone-history-truncated-${operation.operationId}`}
                  icon={<Scissors className="h-3 w-3" aria-hidden="true" />}
                >
                  {t(
                    "Some records from this change have been dropped from the trail and are not listed.",
                    "Some records from this change have been dropped from the trail and are not listed.",
                  )}
                </HistoryChip>
              )}
            </div>
            {sharedReason !== null && (
              <p
                data-testid={`zone-history-operation-reason-${operation.operationId}`}
                className="max-w-prose text-xs text-muted-foreground"
              >
                {sharedReason}
              </p>
            )}
            {sharedReason === null &&
              undoable.length === 0 &&
              entries.length > 0 && (
                <p
                  data-testid={`zone-history-operation-reason-${operation.operationId}`}
                  className="max-w-prose text-xs text-muted-foreground"
                >
                  {t(
                    "None of this change can be undone any more. Open it to see why, row by row.",
                    "None of this change can be undone any more. Open it to see why, row by row.",
                  )}
                </p>
              )}
            {undoable.length > 0 && blocked > 0 && (
              <p
                data-testid={`zone-history-operation-partial-${operation.operationId}`}
                className="max-w-prose text-xs text-muted-foreground"
              >
                {t(
                  "{{blocked}} of {{total}} records can no longer be undone. Open it to see why.",
                  { blocked, total: entries.length },
                )}
              </p>
            )}
          </div>
        </div>
        {undoable.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 gap-1 px-2 text-xs"
            data-testid={`zone-history-undo-${operation.operationId}`}
            onClick={() => onUndoOperation(operation)}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {undoActionLabel(entries, "operation", t)}
          </Button>
        )}
      </div>
      {expanded && (
        <div id={panelId}>
          {entries.length === 0 ? (
            <p className="border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">
              {t(
                "The trail no longer holds any of the records this change touched.",
                "The trail no longer holds any of the records this change touched.",
              )}
            </p>
          ) : (
            <ul className="border-t border-border/40">
              {shownEntries.map((entry) => (
                <HistoryEntryRow
                  key={entry.id}
                  entry={entry}
                  t={t}
                  onUndo={(target) => onUndoEntry(operation, target)}
                />
              ))}
              {hiddenEntries > 0 && (
                <li className="border-t border-border/40 px-3 py-2">
                  <button
                    type="button"
                    data-testid={`zone-history-more-${operation.operationId}`}
                    onClick={() => setShowAllEntries(true)}
                    className="ui-focus rounded text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t("… {{hidden}} more", { hidden: hiddenEntries })}
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The History subtab for one zone.
 *
 * The cursor is the `at` of the oldest operation loaded so far, which is what
 * `list_zone_history` pages on. It is held in state next to the rows it
 * belongs to so that a zone switch or a refresh cannot page the new list from
 * the old list's cursor — the bug that would silently skip a zone's most
 * recent changes.
 */
function ZoneHistoryTabInner({
  zoneId,
  zoneName,
  apiKey,
  email,
  applyUndoRows,
  undoDialog,
}: ZoneHistoryTabProps) {
  const { t } = useI18n();
  const UndoDialog = undoDialog ?? UNDO_PREVIEW_DIALOG;
  const [operations, setOperations] = useState<ZoneHistoryOperation[]>([]);
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [undoTarget, setUndoTarget] = useState<UndoTarget | null>(null);
  const [lastUndo, setLastUndo] = useState<UndoResult | null>(null);

  /**
   * Which load is allowed to write to state.
   *
   * A zone switch while a page is in flight otherwise lands the old zone's
   * operations under the new zone's name, which is a wrong answer rather than
   * a slow one.
   */
  const requestToken = useRef(0);

  const loadFirstPage = useCallback(async () => {
    const token = ++requestToken.current;
    setState({ kind: "loading" });
    // Deliberately does not clear `lastUndo`: an applied undo refreshes the
    // list, so clearing here would wipe the result line the refresh exists to
    // report. The two places a stale result must go are the explicit Refresh
    // button and a zone change, and both clear it themselves.
    try {
      const page = await TauriClient.listZoneHistory(zoneId, {
        limit: ZONE_HISTORY_PAGE_SIZE,
      });
      if (requestToken.current !== token) return;
      setOperations(page);
      setHasMore(page.length >= ZONE_HISTORY_PAGE_SIZE);
      setExpanded(new Set());
      setState({ kind: "ready" });
    } catch (error) {
      if (requestToken.current !== token) return;
      setOperations([]);
      setHasMore(false);
      setState({ kind: "error", message: errorMessage(error) });
    }
  }, [zoneId]);

  const loadNextPage = useCallback(async () => {
    const oldest = operations[operations.length - 1];
    if (!oldest) return;
    const token = requestToken.current;
    setLoadingMore(true);
    try {
      const page = await TauriClient.listZoneHistory(zoneId, {
        before: oldest.at,
        limit: ZONE_HISTORY_PAGE_SIZE,
      });
      if (requestToken.current !== token) return;
      setOperations((previous) => {
        const seen = new Set(previous.map((item) => item.operationId));
        return [
          ...previous,
          ...page.filter((item) => !seen.has(item.operationId)),
        ];
      });
      setHasMore(page.length >= ZONE_HISTORY_PAGE_SIZE);
    } catch (error) {
      if (requestToken.current !== token) return;
      setState({ kind: "error", message: errorMessage(error) });
    } finally {
      if (requestToken.current === token) setLoadingMore(false);
    }
  }, [operations, zoneId]);

  // `loadFirstPage` is memoized on the zone, so this fires on mount and on a
  // zone change — the two moments at which a previous undo's result belongs to
  // a list that is no longer on screen.
  useEffect(() => {
    if (!isDesktop()) return;
    setLastUndo(null);
    void loadFirstPage();
  }, [loadFirstPage]);

  const toggleOperation = useCallback((operationId: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(operationId)) next.delete(operationId);
      else next.add(operationId);
      return next;
    });
  }, []);

  /**
   * Write the undo, then re-read the list whatever happened.
   *
   * The refresh is in a `finally` rather than on the success path: a rejected
   * apply can still have written some of its rows before it gave up, and an
   * undo is itself a logged operation, so the only honest thing to show is
   * what the trail now says rather than what this screen assumed.
   */
  const handleUndoConfirm = useCallback(
    async (rows: readonly UndoPlanRow[]): Promise<UndoResult> => {
      try {
        return await applyUndoRows(zoneId, rows);
      } finally {
        void loadFirstPage();
      }
    },
    [applyUndoRows, loadFirstPage, zoneId],
  );

  /**
   * Report the counts, and close only when there is nothing left to read.
   *
   * A partial result keeps the dialog open on purpose. `UndoResult.failed`
   * carries a `recordName` and a `message` per row, and the dialog is the only
   * place those are shown; closing it would leave someone told "1 failed" on a
   * thirty-seven record undo, believing they had reverted a record that is
   * still sitting in its post-change state, with no way to find out which one.
   * The counts line below survives the close, so a clean apply loses nothing.
   */
  const handleUndoApplied = useCallback((result: UndoResult) => {
    setLastUndo(result);
    if (result.failed.length === 0) setUndoTarget(null);
  }, []);

  if (!isDesktop()) {
    return (
      <Card
        className="border-border/60 bg-card/70"
        data-testid="zone-history-panel"
      >
        <CardHeader>
          <CardTitle className="text-lg">{t("History", "History")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {t(
            "Change history is only available in the desktop app.",
            "Change history is only available in the desktop app.",
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className="border-border/60 bg-card/70"
      data-testid="zone-history-panel"
    >
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="text-lg">{t("History", "History")}</CardTitle>
          <p className="max-w-prose text-xs text-muted-foreground">
            {t(
              "Every change recorded for this zone, newest first. History reaches further back than undo does, so a change can be listed here and no longer be undoable.",
              "Every change recorded for this zone, newest first. History reaches further back than undo does, so a change can be listed here and no longer be undoable.",
            )}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-1 px-2 text-xs"
          data-testid="zone-history-refresh"
          onClick={() => {
            setLastUndo(null);
            void loadFirstPage();
          }}
          disabled={state.kind === "loading"}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Refresh", "Refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {lastUndo !== null && (
          <p
            role="status"
            data-testid="zone-history-undo-result"
            className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-foreground/90"
          >
            {t(
              "Undo applied: {{applied}} records written, {{skipped}} skipped, {{failed}} failed.",
              {
                applied: lastUndo.applied,
                skipped: lastUndo.skipped,
                failed: lastUndo.failed.length,
              },
            )}
          </p>
        )}

        {state.kind === "loading" && (
          <p
            data-testid="zone-history-loading"
            className="text-xs text-muted-foreground"
          >
            {t("Loading change history…", "Loading change history…")}
          </p>
        )}

        {state.kind === "error" && (
          <div
            role="alert"
            data-testid="zone-history-error"
            className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <p>
              {t("The change history could not be loaded: {{message}}", {
                message: state.message,
              })}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => void loadFirstPage()}
            >
              {t("Try again", "Try again")}
            </Button>
          </div>
        )}

        {state.kind === "ready" && operations.length === 0 && (
          <p
            data-testid="zone-history-empty"
            className="text-xs text-muted-foreground"
          >
            {t("No changes have been recorded for {{zone}} yet.", {
              zone: zoneName,
            })}
          </p>
        )}

        {operations.length > 0 && (
          <ul data-testid="zone-history-list" className="space-y-2">
            {operations.map((operation) => (
              <HistoryOperationRow
                key={operation.operationId}
                operation={operation}
                expanded={expanded.has(operation.operationId)}
                onToggle={toggleOperation}
                t={t}
                onUndoOperation={(target) =>
                  setUndoTarget({
                    operationId: target.operationId,
                    operationLabel: describeOperationForDialog(target, t),
                  })
                }
                onUndoEntry={(target, entry) =>
                  setUndoTarget({
                    operationId: target.operationId,
                    entryIds: [entry.id],
                    operationLabel: describeOperationForDialog(target, t),
                  })
                }
              />
            ))}
          </ul>
        )}

        {hasMore && operations.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1 px-2 text-xs"
            data-testid="zone-history-load-more"
            onClick={() => void loadNextPage()}
            disabled={loadingMore}
          >
            {loadingMore
              ? t("Loading…", "Loading…")
              : t("Load older changes", "Load older changes")}
          </Button>
        )}
      </CardContent>

      {undoTarget !== null && (
        <UndoDialog
          open
          onOpenChange={(open) => {
            if (!open) setUndoTarget(null);
          }}
          zoneId={zoneId}
          operationId={undoTarget.operationId}
          entryIds={undoTarget.entryIds}
          apiKey={apiKey}
          email={email}
          operationLabel={undoTarget.operationLabel}
          onConfirm={handleUndoConfirm}
          onApplied={handleUndoApplied}
        />
      )}
    </Card>
  );
}

/**
 * The subtab as the zone view mounts it.
 *
 * Wrapped the way the other zone panels are: a thrown render in one subtab
 * must not take the zone's tablist with it, because the way out of a broken
 * panel is the tab next to it.
 */
export function ZoneHistoryTab(props: ZoneHistoryTabProps) {
  return (
    <ErrorBoundary label="zone-history">
      <ZoneHistoryTabInner {...props} />
    </ErrorBoundary>
  );
}
