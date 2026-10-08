/**
 * What a settings import would do, shown before anything is written.
 *
 * `src/lib/portable/types.ts` makes this screen part of the contract rather
 * than a courtesy: "A settings import never applies without this being shown."
 * So the only thing this component hands back is a list of rows, and the
 * owner's write is driven entirely by what the user could see here.
 *
 * The load-bearing rule is the split between the three lists.
 *
 * `changed` is ordinary preferences, and "Apply all" writes every one of them.
 *
 * `optIn` is a feature switch moving in the direction that restarts outbound
 * work someone deliberately stopped, and "Apply all" writes *none* of them: a
 * file from elsewhere turning a feature back on is the hazard
 * `BrowserPreferenceData` names in its own comment. An opt-in row is written
 * only because the user ticked that row.
 *
 * `withheld` is a change an import may not make in either direction, so it
 * gets a reason and no affordance at all -- not a disabled tick. The guard it
 * names is a password proof the settings screen collects in its own dialog,
 * and a checkbox here would offer the user a way to waive something they
 * cannot waive.
 *
 * Which lane a row is in is read off *which array it arrived in*, never
 * recomputed from `PORTABLE_FEATURE_SWITCH_POLICY[row.key]`. The lane is a
 * function of the policy *and the direction of travel*, and the two switch
 * families are mirror images: turning `registryMonitoringEnabled` on needs a
 * tick while turning it off is ordinary, and turning `passkeysEnabled` on is
 * ordinary while turning it off is withheld. A renderer that keyed off the
 * policy alone would show no affordance for a change the user is entitled to
 * make, and would be a second gate to keep in step with the first.
 *
 * Preference keys are rendered as code, not prose, and are not translated.
 * They are storage keys -- `dnsTableColumns`, `recycleBinRetentionDays` -- and
 * what the file literally carries; inventing eighty display names for them
 * would be eighty strings in eleven languages describing a thing the user can
 * match against the file in front of them.
 */
import { useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import type {
  PortableParseWarning,
  PortableSettingsDiff,
  PortableSettingsDiffRow,
} from "@/lib/portable";

import {
  describePortableWithheldReason,
  formatPortablePreferenceValue,
  PortableWarnings,
  type PortableTranslate,
} from "./portable-text";

export interface SettingsImportDiffProps {
  diff: PortableSettingsDiff;
  /**
   * The rows to write: every `changed` row, plus the `optIn` rows the user
   * ticked, and nothing else.
   *
   * Rows rather than a preference object, so the owner writes through whatever
   * setter each key belongs to instead of being handed a blob to merge. A
   * merge is how a gated key gets written by accident.
   */
  onApply(rows: readonly PortableSettingsDiffRow[]): void | Promise<void>;
  /** Offered only when given, so a screen with nowhere to go shows no exit. */
  onCancel?(): void;
  /** A write is in flight, so apply must not be re-entered. */
  busy?: boolean;
}

/**
 * What "Apply all" writes.
 *
 * Lifted out of the handler so the rule is one expression that can be read at
 * a glance: `changed` entire, and from `optIn` only what is ticked. Note what
 * is *not* here -- `diff.withheld` is read nowhere in this function, so no
 * withheld row can reach a write however the screen is driven, and an
 * untouched opt-in row cannot either.
 */
function rowsToApply(
  diff: PortableSettingsDiff,
  ticked: ReadonlySet<string>,
): PortableSettingsDiffRow[] {
  return [...diff.changed, ...diff.optIn.filter((row) => ticked.has(row.key))];
}

/**
 * A fingerprint of the opt-in proposal, used to drop stale ticks.
 *
 * Content rather than object identity, because the owner is free to compute
 * `diffPortableSettings(...)` inline: an effect keyed on the `diff` prop would
 * then fire on every render and clear the ticks before the user could press
 * anything, making the opt-in rows impossible to use.
 *
 * `String(row.incoming)` is enough here because every key
 * `PORTABLE_FEATURE_SWITCH_POLICY` governs is a boolean in the preference
 * schema, so this is a handful of names and a handful of booleans. It is not a
 * general-purpose fingerprint and is not used as one. The joiner is NUL rather
 * than a space for the reason `toolIdsKey` uses one: a separator that cannot
 * occur inside either half is the only kind that cannot make two different
 * proposals fingerprint alike.
 *
 * Two files proposing the identical switch therefore share a tick, which is
 * the one carryover this leaves: the proposal the user agreed to is literally
 * the same proposal. An owner that wants a harder reset can remount with a
 * `key` per file.
 */
function optInFingerprint(diff: PortableSettingsDiff): string {
  return diff.optIn
    .map((row) => `${row.key}=${String(row.incoming)}`)
    .join("\u0000");
}

/**
 * The two values of one row, each under its own label.
 *
 * This was one composed string with an arrow between the placeholders, and the
 * arrow was the bug. U+2192 is not in the Unicode bidi mirroring set, so under
 * `dir="rtl"` the glyph keeps pointing right while the text around it runs
 * left, and the row reads backwards in Arabic, Hebrew and Farsi. Expressing
 * the direction as layout removes the problem instead of working around it;
 * any arrow that comes back must be a JSX element outside the translated text,
 * never a character inside a string a translator is handed.
 *
 * Stacking also buys the thing a single line could not: several of these
 * values are long -- a column order, a resolver list -- and two labelled
 * blocks stay readable where `a, b, c → a, c, b` does not.
 *
 * The labels name *where* each value is, not which came first, so nothing
 * depends on reading order.
 */
function DiffRowValues({
  t,
  row,
}: {
  t: PortableTranslate;
  row: PortableSettingsDiffRow;
}) {
  return (
    <span className="block space-y-1">
      <span className="block">
        <span className="block text-muted-foreground">
          {t("On this machine", "On this machine")}
        </span>
        <span className="block break-words [overflow-wrap:anywhere]">
          {formatPortablePreferenceValue(t, row.current)}
        </span>
      </span>
      <span className="block">
        <span className="block text-muted-foreground">
          {t("In this file", "In this file")}
        </span>
        <span className="block break-words [overflow-wrap:anywhere]">
          {formatPortablePreferenceValue(t, row.incoming)}
        </span>
      </span>
    </span>
  );
}

export function SettingsImportDiff({
  diff,
  onApply,
  onCancel,
  busy = false,
}: SettingsImportDiffProps) {
  const { t } = useI18n();
  const headingId = useId();
  const optInHintId = useId();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());

  // Derived state, adjusted during render rather than in an effect, for the
  // reason `optInFingerprint` gives: an effect here would race the user.
  const fingerprint = optInFingerprint(diff);
  const [lastFingerprint, setLastFingerprint] = useState(fingerprint);
  if (lastFingerprint !== fingerprint) {
    setLastFingerprint(fingerprint);
    setTicked(new Set());
  }

  /**
   * The keys the file carried that this build did not accept.
   *
   * Reported through the same warning vocabulary a parse uses, so a downgrade
   * reads identically whether the user sees it on the import panel or here.
   */
  const droppedWarnings = useMemo<PortableParseWarning[]>(
    () =>
      diff.droppedKeys.length > 0
        ? [{ reason: "unknown-preference", subjects: diff.droppedKeys }]
        : [],
    [diff.droppedKeys],
  );

  const pending = rowsToApply(diff, ticked);
  // Withheld rows count as something proposed. A file asking to turn passkeys
  // off has very much proposed a change; saying "nothing in this file would
  // change anything here" over the top of the row refusing it would be a flat
  // contradiction.
  const nothingProposed =
    diff.changed.length === 0 &&
    diff.optIn.length === 0 &&
    diff.withheld.length === 0;

  const toggle = (key: string) => {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section
      className="min-w-0 space-y-3"
      aria-labelledby={headingId}
      data-testid="settings-import-diff"
    >
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {t("Import Preview", "Import Preview")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "The file was read. Nothing has been changed yet.",
            "The file was read. Nothing has been changed yet.",
          )}
        </p>
      </div>

      {nothingProposed ? (
        <p className="text-xs text-muted-foreground" data-testid="diff-empty">
          {t(
            "Nothing in this file would change anything here.",
            "Nothing in this file would change anything here.",
          )}
        </p>
      ) : null}

      {diff.changed.length > 0 ? (
        <ul className="min-w-0 space-y-1" data-testid="diff-changed">
          {diff.changed.map((row) => (
            <li
              key={row.key}
              data-testid="diff-row"
              data-row-kind="changed"
              data-key={row.key}
              className="min-w-0 space-y-1 rounded-md border border-border/50 bg-card/50 px-3 py-2 text-xs"
            >
              <code className="block font-medium break-words [overflow-wrap:anywhere]">
                {row.key}
              </code>
              <DiffRowValues t={t} row={row} />
            </li>
          ))}
        </ul>
      ) : null}

      {/* The opt-in group is labelled by its own explanation rather than by a
          legend. A legend would be a second name for a group the sentence
          beneath already names, and a word like "Features" costs eleven
          translations to tell the reader less than the sentence does. */}
      {diff.optIn.length > 0 ? (
        <fieldset
          className="min-w-0 space-y-2 rounded-lg border border-border/60 bg-card/30 p-3"
          data-testid="diff-opt-in"
          aria-labelledby={optInHintId}
          disabled={busy}
        >
          <p id={optInHintId} className="text-xs text-muted-foreground">
            {t(
              "Turning a feature on is your choice on this machine, so these are never part of Apply all. Tick each one you want.",
              "Turning a feature on is your choice on this machine, so these are never part of Apply all. Tick each one you want.",
            )}
          </p>
          {diff.optIn.map((row) => (
            <label
              key={row.key}
              data-testid="diff-row"
              data-row-kind="opt-in"
              data-key={row.key}
              className="flex min-w-0 items-start gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2 text-xs"
            >
              <input
                type="checkbox"
                className="checkbox-themed mt-1 shrink-0"
                checked={ticked.has(row.key)}
                disabled={busy}
                aria-describedby={optInHintId}
                onChange={() => toggle(row.key)}
              />
              <span className="min-w-0 flex-1 space-y-1">
                <code className="block font-medium break-words [overflow-wrap:anywhere]">
                  {row.key}
                </code>
                <DiffRowValues t={t} row={row} />
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {diff.withheld.length > 0 ? (
        <ul className="min-w-0 space-y-1" data-testid="diff-withheld">
          {diff.withheld.map((row) => (
            <li
              key={row.key}
              data-testid="diff-row"
              data-row-kind="withheld"
              data-key={row.key}
              data-reason={row.reason}
              className="min-w-0 space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
            >
              <code className="block font-medium break-words [overflow-wrap:anywhere]">
                {row.key}
              </code>
              <DiffRowValues t={t} row={row} />
              <p>{describePortableWithheldReason(t, row.reason)}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {diff.unchangedCount > 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="diff-unchanged"
        >
          {t("{{preferences}} preference(s) are already the same.", {
            preferences: diff.unchangedCount,
            defaultValue: `${diff.unchangedCount} preference(s) are already the same.`,
          })}
        </p>
      ) : null}

      <PortableWarnings warnings={droppedWarnings} testId="diff-dropped" />

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || pending.length === 0}
          onClick={() => void onApply(pending)}
        >
          {t("Apply all", "Apply all")}
        </Button>
        {onCancel ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onCancel}
          >
            {t("Cancel", "Cancel")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
