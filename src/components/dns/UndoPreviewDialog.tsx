/**
 * Preview an undo, then apply the rows the user confirmed.
 *
 * The dialog exists because of drift. `src/lib/history/types.ts` sets out the
 * problem: between a change and its undo the record may have moved again — in
 * this app, in another window, or in the Cloudflare dashboard — so the plan is
 * fetched, each row is classified, and a row that moved is left unchecked
 * until the user says otherwise. Reverting someone else's later edit without
 * asking is worse than doing nothing, so the opt-in is per row and the words
 * differ per drift state: a changed record shows what it holds now, an absent
 * one says the undo becomes a re-create, and a conflict says plainly that the
 * name and type now belong to a record this undo did not create.
 *
 * Every rule the dialog applies lives in `@/lib/history/undo` as a function
 * over the contract types, so the selection, the count on the apply button and
 * the reading of a partial result are all tested without a DOM. What is left
 * here is markup, the words, and one read.
 *
 * # It previews; it does not write
 *
 * The only backend call this component makes is `preview_undo_operation`,
 * which writes nothing. Applying is somebody else's job on purpose: this app
 * already has an applier in `useUndoRedo` and the `DNSOp` union
 * (`DNSManager.tsx`), and that engine has considered answers this dialog would
 * have to reinvent badly — a binned deletion reverses through `retain` and
 * `restore` rather than `delete` and `create`, so that replaying history can
 * never destroy a record with no copy, and `repointPairedDnsOp` re-points an
 * operation when a record id dies under it. A second applier beside that one
 * would be a second set of those decisions.
 *
 * So the confirmed rows leave through `onConfirm`, which resolves with the
 * {@link UndoResult} the engine produced, and the dialog's remaining job is to
 * report it honestly — including per row, because a batch where 36 of 37
 * landed is a success with a footnote and `failed[].message` is the only place
 * that says which one did not and why.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import { TauriClient } from "@/lib/api/tauri-client";
// A guarded `toLocaleString`, already used for the inbox's timestamps and
// tested there. Imported rather than reimplemented: a fourth hand-rolled
// `Date.parse` guard is how two of them come to disagree.
import { fullTimestamp } from "@/lib/notifications/notifications-view";
import type {
  OperationId,
  UndoAvailability,
  UndoPlanRow,
  UndoPreview,
  UndoRefusalCode,
  UndoResult,
} from "@/lib/history/types";
import {
  classifyUndoResult,
  initialUndoSelection,
  isUndoRowSelectable,
  selectedUndoRows,
  toggleUndoSelection,
  undoApplyCount,
  undoDriftFields,
  undoFailuresByEntryId,
  undoRecordCount,
  undoRowDisplay,
  undoRowIntent,
  undoRowNeedsConfirmation,
  undoTargetFields,
  undoWouldDropTags,
  unlistedUndoFailures,
  UNDO_PREVIEW_CLEAN_ROW_LIMIT,
  type SnapshotFieldId,
  type SnapshotFieldValue,
} from "@/lib/history/undo";

type PreviewUndo = (
  zoneId: string,
  operationId: OperationId,
  apiKey: string,
  email?: string,
  entryIds?: readonly string[],
) => Promise<UndoPreview>;

// Module-level rather than defaulted inline: an arrow created in the parameter
// list is a new function on every render, and the preview effect lists its
// dependency, so an inline default would re-fetch the plan forever.
const defaultPreviewUndo: PreviewUndo = (
  zoneId,
  operationId,
  apiKey,
  email,
  entryIds,
) =>
  TauriClient.previewUndoOperation(
    zoneId,
    operationId,
    apiKey,
    email,
    entryIds,
  );

export interface UndoPreviewDialogProps {
  /** Mount the dialog always; this drives visibility. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zoneId: string;
  operationId: OperationId;
  /**
   * Scope the plan to these entries. `undefined` means the whole operation,
   * which is what an operation-level "undo all" wants; a single row's undo
   * button must pass its own entry id, or a click on one record of a
   * thirty-seven record bulk edit would plan and apply all thirty-seven.
   */
  entryIds?: readonly string[];
  /**
   * Credentials for `preview_undo_operation`, forwarded from `DNSManager`.
   *
   * Required rather than optional, as `AddRecordDialog` has it: a preview
   * without a key cannot run, and an optional prop turns a wiring mistake into
   * a user pressing Apply and watching nothing happen.
   */
  apiKey: string;
  email?: string;
  /**
   * Already-localised subtitle fragment naming the operation, such as
   * "bulk edit at 14:02". Rendered verbatim; omit it and the header reports
   * only how many records the operation touched.
   */
  operationLabel?: string;
  /**
   * Apply the rows the user confirmed, and report what happened per row.
   *
   * This dialog writes nothing itself — see the module header. The rows arrive
   * in the plan's order, carry the exact `RetainedRecordSnapshot` to put back
   * in `target`, and never include a row with nothing to write. Resolve with the
   * {@link UndoResult} the applier produced and the dialog reports it, marking
   * each `failed[].entryId` on its own row; reject and it says the undo could
   * not be applied and claims nothing.
   */
  onConfirm: (rows: readonly UndoPlanRow[]) => Promise<UndoResult>;
  /**
   * Optional notification once a result is on screen.
   *
   * Rarely needed: `onConfirm` already hands the host the same result, and
   * doing the follow-up work there avoids the question of whether this fires
   * before or after the user has read the outcome. Kept because a host that
   * separates "apply" from "the list is now stale" may prefer two hooks.
   */
  onApplied?: (result: UndoResult) => void;
  /** Test seam. Defaults to `TauriClient.previewUndoOperation`. */
  previewUndo?: PreviewUndo;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function UndoPreviewDialog({
  open,
  onOpenChange,
  zoneId,
  operationId,
  entryIds,
  apiKey,
  email,
  operationLabel,
  onConfirm,
  onApplied,
  previewUndo = defaultPreviewUndo,
}: UndoPreviewDialogProps) {
  const { t, language } = useI18n();
  const [plan, setPlan] = useState<UndoPreview | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [showAllClean, setShowAllClean] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [result, setResult] = useState<UndoResult | null>(null);
  const [requested, setRequested] = useState(0);
  // Bumped by the retry control to re-run the preview effect without
  // duplicating its body in a callback.
  const [planAttempt, setPlanAttempt] = useState(0);

  // Keyed by the ids themselves rather than by the array's identity: a host
  // that rebuilds `entryIds` on every render must not re-plan the undo on
  // every render, and a host that changes which rows are scoped must.
  // Round-tripped through JSON rather than joined on a separator so that an
  // empty scope stays an empty scope: `[].join()` and `[""].join()` are the
  // same string, and the difference between "plan nothing" and "plan one row
  // whose id is empty" is not one to lose in a cache key.
  const entryIdsKey =
    entryIds === undefined ? null : JSON.stringify([...entryIds]);
  const scopedEntryIds = useMemo(
    () =>
      entryIdsKey === null
        ? undefined
        : (JSON.parse(entryIdsKey) as readonly string[]),
    [entryIdsKey],
  );

  useEffect(() => {
    if (!open) {
      setPlan(null);
      // Closing mid-plan must not leave the spinner behind for the next open.
      setPlanning(false);
      setPlanError(null);
      setSelected(new Set<string>());
      setShowAllClean(false);
      setApplyError(null);
      setResult(null);
      setRequested(0);
      return;
    }
    let cancelled = false;
    setPlanning(true);
    setPlanError(null);
    setResult(null);
    setApplyError(null);
    setShowAllClean(false);
    void (async () => {
      try {
        const next = await previewUndo(
          zoneId,
          operationId,
          apiKey,
          email,
          scopedEntryIds,
        );
        if (cancelled) return;
        setPlan(next);
        setSelected(initialUndoSelection(next));
      } catch (error) {
        if (cancelled) return;
        setPlan(null);
        setSelected(new Set<string>());
        setPlanError(errorMessage(error));
      } finally {
        if (!cancelled) setPlanning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    zoneId,
    operationId,
    scopedEntryIds,
    apiKey,
    email,
    previewUndo,
    planAttempt,
  ]);

  const applyCount = useMemo(
    () => (plan ? undoApplyCount(plan, selected) : 0),
    [plan, selected],
  );
  // Scoped to what is selected, so unchecking the tagged row removes the
  // warning instead of leaving a caveat that no longer applies.
  const willDropTags = useMemo(
    () => (plan ? undoWouldDropTags(selectedUndoRows(plan, selected)) : false),
    [plan, selected],
  );
  const failures = useMemo(
    () => (result ? undoFailuresByEntryId(result) : new Map<string, string>()),
    [result],
  );
  const failedEntryIds = useMemo(() => new Set(failures.keys()), [failures]);
  // Nothing a well-behaved applier produces, and reported anyway rather than
  // dropped: a failure with no row to sit on would otherwise vanish.
  const unlistedFailures = useMemo(
    () => (plan && result ? unlistedUndoFailures(plan, result) : []),
    [plan, result],
  );
  const display = useMemo(
    () =>
      undoRowDisplay(
        plan?.rows ?? [],
        showAllClean ? Number.POSITIVE_INFINITY : UNDO_PREVIEW_CLEAN_ROW_LIMIT,
        // A row the apply could not write is pinned open: its message is the
        // only place that says which record is still in its post-change
        // state, and a clean row that failed would otherwise collapse in with
        // the clean rows that succeeded.
        failedEntryIds,
      ),
    [plan, showAllClean, failedEntryIds],
  );

  const toggleRow = useCallback((entryId: string) => {
    setSelected((current) => toggleUndoSelection(current, entryId));
  }, []);

  const handleApply = useCallback(async () => {
    if (!plan) return;
    const rows = selectedUndoRows(plan, selected);
    if (rows.length === 0) return;
    setApplying(true);
    setApplyError(null);
    setRequested(rows.length);
    let outcome: UndoResult;
    try {
      outcome = await onConfirm(rows);
    } catch (error) {
      setApplyError(errorMessage(error));
      setApplying(false);
      return;
    }
    setApplying(false);
    setResult(outcome);
    // Outside the catch on purpose: a host callback that throws is a bug in
    // the host, not a failed undo, and must not be reported as one.
    onApplied?.(outcome);
  }, [plan, selected, onConfirm, onApplied]);

  const fieldLabel = useCallback(
    (field: SnapshotFieldId): string => {
      switch (field) {
        case "recordType":
          return t("Type");
        case "name":
          return t("Name");
        case "content":
          return t("Content");
        case "ttl":
          return t("TTL");
        case "priority":
          return t("Priority");
        case "proxied":
          return t("Proxied");
        case "comment":
          return t("Comment");
        case "tags":
          return t("Tags");
      }
    },
    [t],
  );

  const fieldValue = useCallback(
    (value: SnapshotFieldValue): string => {
      if (value === null) return t("None");
      if (Array.isArray(value)) return value.join(", ");
      if (typeof value === "boolean") {
        return value ? t("Enabled") : t("Disabled");
      }
      return String(value);
    },
    [t],
  );

  /** The fields a restore would put back, as one readable line. */
  const targetSummary = useCallback(
    (row: UndoPlanRow): string =>
      row.target === null
        ? ""
        : undoTargetFields(row.target)
            .map(
              (entry) =>
                `${fieldLabel(entry.field)} ${fieldValue(entry.value)}`,
            )
            .join(" · "),
    [fieldLabel, fieldValue],
  );

  /** What applying this row would do, in one phrase. */
  const intentText = useCallback(
    (row: UndoPlanRow): string => {
      switch (undoRowIntent(row)) {
        case "restore": {
          const fields = targetSummary(row);
          if (fields === "") return "";
          return t("Puts back {{fields}}", {
            fields,
            defaultValue: `Puts back ${fields}`,
          });
        }
        case "recreate": {
          const fields = targetSummary(row);
          if (fields === "") return t("Re-creates this record");
          return t("Re-creates this record with {{fields}}", {
            fields,
            defaultValue: `Re-creates this record with ${fields}`,
          });
        }
        case "delete":
          return t("Deletes the record this change created");
        case "noop":
          return "";
      }
    },
    [t, targetSummary],
  );

  /** The drift sentence for one row, in that drift state's own words. */
  const driftText = useCallback(
    (row: UndoPlanRow): string => {
      if (undoRowIntent(row) === "noop") {
        return t("Already deleted, so there is nothing to put back");
      }
      switch (row.drift.state) {
        case "unchanged":
          return t("Unchanged since this operation");
        case "changed": {
          const now = undoDriftFields(row)
            .map(
              (field) =>
                `${fieldLabel(field.field)} ${fieldValue(field.current)}`,
            )
            .join(" · ");
          return t("Changed since this operation: it now holds {{current}}", {
            current: now,
            defaultValue: `Changed since this operation: it now holds ${now}`,
          });
        }
        case "absent":
          return t("Gone from Cloudflare, so undoing re-creates it");
        case "conflict":
          return t(
            "Another record ({{recordId}}) now holds this name and type. This undo did not create it, and applying would overwrite it.",
            {
              recordId: row.drift.conflictingRecordId,
              defaultValue: `Another record (${row.drift.conflictingRecordId}) now holds this name and type. This undo did not create it, and applying would overwrite it.`,
            },
          );
      }
    },
    [fieldLabel, fieldValue, t],
  );

  /** The checkbox's accessible name: what checking this row would do. */
  const rowControlLabel = useCallback(
    (row: UndoPlanRow): string => {
      const name = row.recordName;
      if (row.drift.state === "conflict") {
        return t("Overwrite the record that now holds {{name}}", {
          name,
          defaultValue: `Overwrite the record that now holds ${name}`,
        });
      }
      if (row.drift.state === "changed") {
        return t("Overwrite the later change to {{name}}", {
          name,
          defaultValue: `Overwrite the later change to ${name}`,
        });
      }
      switch (undoRowIntent(row)) {
        case "recreate":
          return t("Re-create {{name}}", {
            name,
            defaultValue: `Re-create ${name}`,
          });
        case "delete":
          // Not "again". `undoRowIntent` returns `delete` when the row's
          // `target` is null *and* the record is still present — the change
          // created it and this undo removes it for the first time. The
          // already-deleted case is the separate `noop` branch with its own
          // string. "again" was only true for an undo of an undo of a delete,
          // which is not the case this label describes. Reported by the agent
          // translating id-ID, which had to decide whether to render a claim
          // the code does not support.
          return t("Delete {{name}}", {
            name,
            defaultValue: `Delete ${name}`,
          });
        case "noop":
          return t("{{name}} is already deleted", {
            name,
            defaultValue: `${name} is already deleted`,
          });
        case "restore":
          return t("Put back {{name}}", {
            name,
            defaultValue: `Put back ${name}`,
          });
      }
    },
    [t],
  );

  /**
   * Why a refused entry was refused, in words rather than in its code.
   *
   * `UndoAvailability.not-undoable.reason` is a {@link UndoRefusalCode}, not
   * prose, so interpolating it would put `stale-record-list` on screen — a
   * machine token, in English, in all twelve locales. The switch is
   * exhaustive and has no `default` on purpose: a seventh code must fail the
   * build here rather than reach a user as a hyphenated identifier.
   *
   * Three of the six are also not "not a record change", whatever the state's
   * name suggests. A stale record list, a truncated manifest and a
   * summary-only trail entry are all real record changes that this feature
   * cannot reverse for three different reasons, and only one of them is
   * something the user can do anything about.
   */
  const refusalText = useCallback(
    (reason: UndoRefusalCode): string => {
      switch (reason) {
        case "stale-record-list":
          return t(
            "The record list this zone has loaded is out of date. Refresh the Records tab, then undo again.",
          );
        case "zone-setting":
          return t("This changed a zone setting, not a record.");
        case "cache-purge":
          return t("This was a cache purge, so there is nothing to put back.");
        case "dnssec":
          return t("This was a DNSSEC change, not a record.");
        case "manifest-truncated":
          return t(
            "The list of records this created was too long to keep in full, so some of them cannot be identified. Undoing only part of it would be worse than leaving it.",
          );
        case "summary-entry-only":
          return t(
            "The trail kept this as one summary without the individual records, so there is nothing to put back.",
          );
      }
    },
    [t],
  );

  const availabilityText = useCallback(
    (undo: UndoAvailability): string => {
      switch (undo.state) {
        case "expired": {
          // `expiredAt` is ISO 8601 off the wire. Shown raw it reads as a
          // machine timestamp in a sentence addressed to a person, and in the
          // wrong calendar for most of the twelve locales. `fullTimestamp`
          // falls back to the raw value when it cannot be parsed, which is the
          // right failure: a date this app cannot read is still better shown
          // than swallowed.
          const at = fullTimestamp(undo.expiredAt, language);
          return t("The saved copy expired on {{at}}", {
            at,
            defaultValue: `The saved copy expired on ${at}`,
          });
        }
        case "evicted":
          return t("The saved copy was dropped to stay inside the size limit");
        case "no-snapshot":
          return t("Recorded before this app kept copies, so none was taken");
        case "superseded-by-delete":
          return t("The record has since been deleted again");
        case "not-undoable":
          return refusalText(undo.reason);
        // Unreachable if the backend keeps its own contract: a row listed as
        // unavailable does not carry `available`. It still needs words, and
        // "Available" inside a list headed "cannot be undone" would be a
        // contradiction on screen rather than an explanation.
        case "available":
          return t("No reason given");
      }
    },
    [language, refusalText, t],
  );

  const headline = operationLabel
    ? t("{{label}} · {{count}} record(s) in this operation", {
        label: operationLabel,
        count: plan ? undoRecordCount(plan) : 0,
        defaultValue: `${operationLabel} · ${plan ? undoRecordCount(plan) : 0} record(s) in this operation`,
      })
    : t("{{count}} record(s) in this operation", {
        count: plan ? undoRecordCount(plan) : 0,
        defaultValue: `${plan ? undoRecordCount(plan) : 0} record(s) in this operation`,
      });

  const outcome = result ? classifyUndoResult(result) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Undo this change")}</DialogTitle>
          <DialogDescription>{headline}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {planning && (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="undo-preview-planning"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t("Checking what each record holds now")}
            </div>
          )}

          {planError !== null && (
            <div
              className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
              data-testid="undo-preview-plan-error"
              role="alert"
            >
              <div>
                {t("This undo could not be planned: {{message}}", {
                  message: planError,
                  defaultValue: `This undo could not be planned: ${planError}`,
                })}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPlanAttempt((attempt) => attempt + 1)}
              >
                {t("Try again")}
              </Button>
            </div>
          )}

          {plan !== null && plan.rows.length === 0 && (
            <div
              className="text-sm text-muted-foreground"
              data-testid="undo-preview-empty"
            >
              {t("No record in this operation can be put back.")}
            </div>
          )}

          {display.visible.length > 0 && (
            <ul className="max-h-72 scrollbar-themed divide-y overflow-y-auto rounded border">
              {display.visible.map((row) => {
                const selectable = isUndoRowSelectable(row);
                const checked = selected.has(row.entryId);
                const failure = failures.get(row.entryId);
                const needsConfirmation = undoRowNeedsConfirmation(row);
                return (
                  <li
                    key={row.entryId}
                    className="flex items-start gap-3 p-2"
                    data-testid="undo-preview-row"
                    data-entry-id={row.entryId}
                  >
                    <input
                      type="checkbox"
                      className="checkbox-themed mt-1"
                      checked={checked}
                      disabled={!selectable || applying || result !== null}
                      aria-label={rowControlLabel(row)}
                      onChange={() => toggleRow(row.entryId)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm break-all">
                        {row.recordType} {row.recordName}
                      </div>
                      {intentText(row) !== "" && (
                        <div className="text-xs text-muted-foreground break-all">
                          {intentText(row)}
                        </div>
                      )}
                      <div
                        className={
                          needsConfirmation
                            ? "mt-1 flex items-start gap-1 text-xs text-yellow-700 dark:text-yellow-300"
                            : "mt-1 flex items-start gap-1 text-xs text-muted-foreground"
                        }
                      >
                        {needsConfirmation ? (
                          <AlertTriangle
                            className="mt-0.5 h-3 w-3 shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <CheckCircle2
                            className="mt-0.5 h-3 w-3 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        <span className="break-all">{driftText(row)}</span>
                      </div>
                      {/* No `role="alert"` here on purpose: a batch of
                          thirty-seven would announce thirty-seven alerts. The
                          outcome summary below is the one announcement, and it
                          says how many rows are marked. */}
                      {failure !== undefined && (
                        <div
                          className="mt-1 flex items-start gap-1 text-xs text-destructive"
                          data-testid="undo-preview-row-failure"
                        >
                          <XCircle
                            className="mt-0.5 h-3 w-3 shrink-0"
                            aria-hidden="true"
                          />
                          <span className="break-all">
                            {t("Not written: {{message}}", {
                              message: failure,
                              defaultValue: `Not written: ${failure}`,
                            })}
                          </span>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {display.collapsedCleanCount > 0 && (
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="undo-preview-collapsed"
            >
              <span>
                {t("{{count}} more unchanged", {
                  count: display.collapsedCleanCount,
                  defaultValue: `${display.collapsedCleanCount} more unchanged`,
                })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setShowAllClean(true)}
              >
                {t("Show all")}
              </Button>
            </div>
          )}

          {showAllClean && (plan?.rows.length ?? 0) > 0 && (
            <div className="text-xs">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setShowAllClean(false)}
              >
                {t("Show fewer")}
              </Button>
            </div>
          )}

          {plan !== null && plan.unavailable.length > 0 && (
            <div
              className="space-y-1 rounded-md border border-border/60 p-2 text-xs"
              data-testid="undo-preview-unavailable"
            >
              <div className="font-medium">
                {t("{{count}} record(s) in this operation cannot be undone", {
                  count: plan.unavailable.length,
                  defaultValue: `${plan.unavailable.length} record(s) in this operation cannot be undone`,
                })}
              </div>
              <ul className="space-y-1 text-muted-foreground">
                {plan.unavailable.map((entry) => (
                  <li key={entry.entryId} className="break-all">
                    <span className="font-mono">{entry.recordName}</span>
                    {" — "}
                    {availabilityText(entry.undo)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {willDropTags && result === null && (
            <div
              className="flex items-start gap-1 text-xs text-muted-foreground"
              data-testid="undo-preview-tags-note"
            >
              <AlertTriangle
                className="mt-0.5 h-3 w-3 shrink-0"
                aria-hidden="true"
              />
              <span>
                {t(
                  "Tags are not put back. This app keeps record tags locally, and an undo writes only DNS fields.",
                )}
              </span>
            </div>
          )}

          {applying && (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="undo-preview-applying"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t("Writing the records you confirmed")}
            </div>
          )}

          {applyError !== null && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
              data-testid="undo-preview-apply-error"
              role="alert"
            >
              {t("This undo could not be applied: {{message}}", {
                message: applyError,
                defaultValue: `This undo could not be applied: ${applyError}`,
              })}
            </div>
          )}

          {result !== null && outcome !== null && (
            <div
              className="space-y-1 rounded-md border border-border/60 p-2 text-sm"
              data-testid="undo-preview-outcome"
              role="status"
            >
              <div>
                {outcome === "applied" &&
                  t("Put back {{count}} record(s).", {
                    count: result.applied,
                    defaultValue: `Put back ${result.applied} record(s).`,
                  })}
                {outcome === "partial" &&
                  t(
                    "Put back {{applied}} of {{requested}} record(s). {{failed}} could not be written, and are marked above.",
                    {
                      applied: result.applied,
                      requested,
                      failed: result.failed.length,
                      defaultValue: `Put back ${result.applied} of ${requested} record(s). ${result.failed.length} could not be written, and are marked above.`,
                    },
                  )}
                {outcome === "failed" &&
                  t(
                    "No record was written. All {{count}} failed, and each says why above.",
                    {
                      count: result.failed.length,
                      defaultValue: `No record was written. All ${result.failed.length} failed, and each says why above.`,
                    },
                  )}
                {outcome === "nothing" && t("No record was written.")}
              </div>
              {result.skipped > 0 && (
                <div className="text-xs text-muted-foreground">
                  {t("{{count}} record(s) were skipped.", {
                    count: result.skipped,
                    defaultValue: `${result.skipped} record(s) were skipped.`,
                  })}
                </div>
              )}
              {unlistedFailures.length > 0 && (
                <ul
                  className="space-y-1 text-xs text-destructive"
                  data-testid="undo-preview-unlisted-failures"
                >
                  {unlistedFailures.map((failure) => (
                    <li key={failure.entryId} className="break-all">
                      <span className="font-mono">{failure.recordName}</span>
                      {" — "}
                      {failure.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {result === null ? t("Cancel") : t("Close")}
          </Button>
          {result === null && (
            <Button
              type="button"
              disabled={applyCount === 0 || applying || planning}
              onClick={() => {
                void handleApply();
              }}
            >
              {t("Apply {{count}}", {
                count: applyCount,
                defaultValue: `Apply ${applyCount}`,
              })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
