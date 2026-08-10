/**
 * Shared field-help and summary primitives for the guided record builders.
 *
 * Every builder uses the same two affordances so the second builder a user
 * meets behaves like the first:
 *
 * - {@link BuilderFieldLabel} renders a label plus a focusable help indicator.
 *   The help text is duplicated into a visually hidden element that the control
 *   references via `aria-describedby`, so the explanation is announced by a
 *   screen reader even though the tooltip itself is transient.
 * - {@link RecordSummary} renders the plain-English description of the record
 *   being assembled, always visible while building.
 */
import type { ReactNode } from "react";
import { useId } from "react";
import { CircleHelp, Info } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { getRecordFormat } from "./record-formats";
import type { BuilderSummary } from "./types";

export const RECORD_SUMMARY_TITLE = "What this record does";

/**
 * Focusable "?" affordance that reveals `help` on hover and on keyboard focus.
 *
 * The button is a real button, so it sits in the tab order and the tooltip is
 * reachable without a pointer. It is labelled rather than left to its icon so
 * screen readers announce which field it belongs to.
 */
export function BuilderFieldHelp({
  label,
  help,
}: {
  label: string;
  help: ReactNode;
}) {
  return (
    <Tooltip tip={help}>
      <button
        type="button"
        className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Help for ${label}`}
      >
        <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/**
 * Label row for a builder field: the visible label, the help indicator, and the
 * hidden description that `descriptionId` points at.
 *
 * Callers must set both `id={controlId}` and `aria-describedby={descriptionId}`
 * on the control itself; {@link useBuilderFieldIds} produces both ids.
 */
export function BuilderFieldLabel({
  controlId,
  descriptionId,
  label,
  help,
}: {
  controlId: string;
  descriptionId: string;
  label: string;
  help: string;
}) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Label htmlFor={controlId} className="text-xs">
          {label}
        </Label>
        <BuilderFieldHelp label={label} help={help} />
      </div>
      <span id={descriptionId} className="sr-only">
        {help}
      </span>
    </>
  );
}

/**
 * Generate a stable `{ fieldIds, helpIds }` pair for a builder's field keys.
 *
 * Ids are derived from a `useId()` prefix so multiple builders can be mounted
 * at once (the TXT builder nests SPF/DKIM/DMARC) without colliding.
 */
export function useBuilderFieldIds<K extends string>(keys: readonly K[]) {
  const prefix = useId();
  const fieldIds = {} as Record<K, string>;
  const helpIds = {} as Record<K, string>;
  for (const key of keys) {
    fieldIds[key] = `${prefix}-${key}`;
    helpIds[key] = `${prefix}-${key}-help`;
  }
  return { fieldIds, helpIds };
}

/**
 * Compact "what should I type here?" hint for a record type: the field order
 * followed by one worked example, both read from the shared
 * {@link getRecordFormat} table.
 *
 * The format and example are rendered as visible text rather than hidden behind
 * the tooltip, so they are available without any pointer interaction at all;
 * the indicator only carries the extra caveat. Give the content control
 * `aria-describedby={descriptionId}` so the whole hint is announced with it.
 */
export function RecordFormatHint({
  type,
  descriptionId,
  className,
}: {
  type: string | undefined;
  descriptionId: string;
  className?: string;
}) {
  const entry = getRecordFormat(type);
  if (!entry) return null;
  const label = `${type} content format`;
  return (
    <div
      id={descriptionId}
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span>
        <span className="font-semibold">Format:</span>{" "}
        <code className="break-all">{entry.format}</code>
      </span>
      <span>
        <span className="font-semibold">Example:</span>{" "}
        <code className="break-all">{entry.example}</code>
      </span>
      {entry.note ? (
        <>
          <BuilderFieldHelp label={label} help={entry.note} />
          <span className="sr-only">{entry.note}</span>
        </>
      ) : null}
    </div>
  );
}

/**
 * Always-visible plain-English description of the record being built.
 *
 * This is a labelled region rather than an ARIA live region on purpose: the
 * text changes on every keystroke, so announcing it live would talk over the
 * user. As a named region it stays reachable on demand via landmark navigation.
 */
export function RecordSummary({
  summary,
  className,
}: {
  summary: BuilderSummary;
  className?: string;
}) {
  const details = summary.details?.filter((item) => item.trim().length > 0);
  const unknowns = summary.unknowns?.filter((item) => item.trim().length > 0);
  return (
    <section
      aria-label={RECORD_SUMMARY_TITLE}
      className={cn(
        "rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
        {RECORD_SUMMARY_TITLE}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-foreground/90">
        {summary.headline}
      </p>
      {details?.length ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[11px] leading-relaxed text-muted-foreground">
          {details.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {unknowns?.length ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          {unknowns.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
