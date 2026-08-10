/**
 * In-app reference for every DNS record type the app knows about.
 *
 * Thirty-six types is more than anyone scans, so the view is a search first and
 * a list second. Each entry answers the same four questions in the same order:
 * what the record is for, what goes in the content field, what a valid one
 * looks like, and where it is specified.
 *
 * None of that text lives here — it is assembled by
 * {@link buildRecordReference} from the same tables the Add Record dialog and
 * the guided builders read, so the reference cannot teach something the form
 * contradicts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ExternalLink, Info, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { openExternalUrl } from "@/lib/external-url";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";
import type { RecordType } from "@/types/dns";

import {
  AVAILABILITY_HINTS,
  AVAILABILITY_LABELS,
  availabilityOf,
  buildRecordReference,
  filterRecordReference,
  type RecordReferenceEntry,
} from "./record-reference";

export interface RecordTypeReferenceProps {
  /**
   * Type to open the reference at. The matching entry is highlighted and
   * scrolled into view; the reader keeps the full list either side of it
   * rather than landing on a filtered page they then have to clear.
   */
  initialType?: RecordType | "";
}

/** Stable DOM id for one entry, used by the deep link's scroll target. */
function entryId(type: RecordType): string {
  return `record-reference-${type}`;
}

/**
 * A labelled block of monospace content — the format string or the example.
 *
 * The app shell hides horizontal overflow, so a long RDATA example would be
 * clipped with no way to reach the rest of it. Each block scrolls on its own.
 */
function CodeBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="scrollbar-themed mt-1 overflow-x-auto rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
        <code className="whitespace-pre text-[11px] leading-relaxed text-foreground/90">
          {value}
        </code>
      </div>
    </div>
  );
}

/** One record type: purpose, availability, format, example, specifications. */
function ReferenceEntry({
  entry,
  highlighted,
  registerRef,
}: {
  entry: RecordReferenceEntry;
  highlighted: boolean;
  registerRef: (type: RecordType, node: HTMLElement | null) => void;
}) {
  const { t } = useI18n();
  const availability = availabilityOf(entry);
  const availabilityLabel = t(
    AVAILABILITY_LABELS[availability],
    AVAILABILITY_LABELS[availability],
  );

  return (
    <article
      id={entryId(entry.type)}
      ref={(node) => registerRef(entry.type, node)}
      data-testid="record-reference-entry"
      data-record-type={entry.type}
      data-availability={availability}
      data-highlighted={highlighted || undefined}
      aria-labelledby={`${entryId(entry.type)}-heading`}
      className={cn(
        "glass-surface rounded-xl border border-border/60 bg-card/60 p-3",
        highlighted && "border-primary/60 ring-1 ring-primary/40",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3
          id={`${entryId(entry.type)}-heading`}
          className="min-w-0 text-sm font-semibold tracking-wide"
        >
          {entry.type}
        </h3>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {entry.shortLabel}
        </span>
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-foreground/90">
        {entry.purpose}
      </p>

      <p
        data-testid="record-reference-availability"
        className={cn(
          "mt-2 inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[10px] leading-relaxed",
          availability === "default"
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        )}
      >
        {availabilityLabel}
      </p>

      {entry.format && entry.example ? (
        <div className="mt-2 space-y-2">
          <CodeBlock label={t("Format", "Format")} value={entry.format} />
          <CodeBlock label={t("Example", "Example")} value={entry.example} />
        </div>
      ) : (
        <p
          data-testid="record-reference-omission"
          className="mt-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
        >
          {t(
            "No example is shown for this type:",
            "No example is shown for this type:",
          )}{" "}
          {entry.omissionReason}
        </p>
      )}

      {entry.note ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {entry.note}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {entry.rfcs.length > 0 ? (
          entry.rfcs.map((ref) => (
            <button
              key={ref.url}
              type="button"
              onClick={() => void openExternalUrl(ref.url)}
              title={ref.note ?? undefined}
              className="ui-focus inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-[10px] text-foreground/80 hover:border-primary/40 hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              {ref.section ? `${ref.label} §${ref.section}` : ref.label}
            </button>
          ))
        ) : (
          <span className="text-[10px] text-muted-foreground">
            {t(
              "Not an IANA type — no RFC defines it.",
              "Not an IANA type — no RFC defines it.",
            )}
          </span>
        )}
      </div>
    </article>
  );
}

/**
 * The reference view: a search box, a legend for the availability split, and
 * one card per record type.
 */
export function RecordTypeReference({
  initialType = "",
}: RecordTypeReferenceProps) {
  const { t } = useI18n();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [query, setQuery] = useState("");
  const entryRefs = useRef(new Map<RecordType, HTMLElement>());

  const entries = useMemo(() => buildRecordReference(), []);
  const visible = useMemo(
    () => filterRecordReference(entries, query),
    [entries, query],
  );

  const defaultCount = useMemo(
    () => entries.filter((entry) => entry.offeredByDefault).length,
    [entries],
  );

  const registerRef = useCallback(
    (type: RecordType, node: HTMLElement | null) => {
      if (node) entryRefs.current.set(type, node);
      else entryRefs.current.delete(type);
    },
    [],
  );

  // Opening the reference "at" a type scrolls to it rather than filtering, so
  // the surrounding types stay browsable. Smooth scrolling is motion, so it is
  // gated on the viewer's stated preference.
  useEffect(() => {
    if (!initialType) return;
    const node = entryRefs.current.get(initialType);
    if (typeof node?.scrollIntoView !== "function") return;
    node.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }, [initialType, prefersReducedMotion]);

  return (
    <div className="space-y-3 fade-in">
      <div className="flex items-start gap-2">
        <BookOpen
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          {t(
            "What each record type is for, what belongs in its content field, and where it is specified.",
            "What each record type is for, what belongs in its content field, and where it is specified.",
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("Search record types", "Search record types")}
            placeholder={t(
              "Search types, purpose, or example…",
              "Search types, purpose, or example…",
            )}
            className="h-9 pl-8 text-xs"
          />
        </div>
        {query ? (
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1 px-2"
            onClick={() => setQuery("")}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="text-xs">{t("Clear", "Clear")}</span>
          </Button>
        ) : null}
      </div>

      <p
        role="status"
        data-testid="record-reference-count"
        className="text-[11px] text-muted-foreground"
      >
        {t("Showing {{shown}} of {{total}} record types.", {
          shown: visible.length,
          total: entries.length,
          defaultValue: `Showing ${visible.length} of ${entries.length} record types.`,
        })}{" "}
        {t("{{available}} are offered by default.", {
          available: defaultCount,
          defaultValue: `${defaultCount} are offered by default.`,
        })}
      </p>

      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Which types you can select", "Which types you can select")}
        </div>
        <dl className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
          <div>
            <dt className="inline font-medium text-foreground/80">
              {t(AVAILABILITY_LABELS.default, AVAILABILITY_LABELS.default)}{" "}
              —{" "}
            </dt>
            <dd className="inline">
              {t(AVAILABILITY_HINTS.default, AVAILABILITY_HINTS.default)}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground/80">
              {t(AVAILABILITY_LABELS["opt-in"], AVAILABILITY_LABELS["opt-in"])}{" "}
              —{" "}
            </dt>
            <dd className="inline">
              {t(AVAILABILITY_HINTS["opt-in"], AVAILABILITY_HINTS["opt-in"])}
            </dd>
          </div>
        </dl>
      </div>

      {visible.length === 0 ? (
        <p
          data-testid="record-reference-empty"
          className="rounded-lg border border-border/60 bg-card/50 px-3 py-6 text-center text-xs text-muted-foreground"
        >
          {t(
            "No record type matches that search.",
            "No record type matches that search.",
          )}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {visible.map((entry) => (
            <ReferenceEntry
              key={entry.type}
              entry={entry}
              highlighted={entry.type === initialType}
              registerRef={registerRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}
