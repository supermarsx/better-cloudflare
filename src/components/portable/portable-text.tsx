/**
 * Every bit of text the portable-config screens produce, in one file.
 *
 * Mostly that means the strings the twelve locale files carry, but it also
 * covers the two kinds that are deliberately *not* translated -- a host's own
 * error message, and the filename an export suggests -- so that "is this
 * translated, and why not" is a question with one place to look.
 *
 * Collected in one file for two reasons.
 *
 * The first is that `PortableRejection` and `PortableParseWarning["reason"]`
 * are deliberately tags rather than sentences -- `src/lib/portable/types.ts`
 * says the renderer picks the wording so that translators have a fixed set of
 * keys -- and a tag vocabulary is only worth having if exactly one place turns
 * it into words. Two renderers with their own phrasing for `not-our-format`
 * would be two keys for one condition, and both would be sent to eleven
 * translators. The import panel and the permission-set editor both render
 * parse warnings; they share these functions rather than each writing them.
 *
 * The second is that every user-visible string has to be a *literal* `t` call
 * with the English written out twice, as both the key and the default.
 * `scripts/i18n-coverage.mjs` scans source text for that shape, so a default
 * reached through a variable -- `t(label, label)` -- is invisible to the
 * extractor and renders in English in all twelve locales while the coverage
 * report says nothing is missing. Keeping the literals in one file makes that
 * checkable by eye.
 *
 * A comment here once quoted that call shape in full, and the extractor --
 * which read comments at the time -- catalogued the sample, putting "Text"
 * in the report as a string eleven translators were owed. It now strips
 * comments before scanning, so the hazard is closed at the source; the
 * history is kept because it is the reason `stripComments` exists.
 *
 * Placeholders are deliberately *not* named `count`. i18next treats `count` as
 * its plural selector and looks for `key_one` / `key_other` before the bare
 * key, which would make the resolution of each of these depend on eleven
 * locales each declaring the right plural forms -- six of them, for ar-SA. The
 * repo's own convention of writing "record(s)" carries plurality in the string
 * instead, so these use ordinary names and stay out of that machinery.
 */
import { useI18n } from "@/hooks/use-i18n";
import { sanitizeRuntimeText } from "@/lib/errors/runtime-reporting";
import type {
  PortableKind,
  PortableParseWarning,
  PortablePersonasEnvelope,
  PortableRejection,
  PortableSettingsEnvelope,
  PortableToolPermissionsEnvelope,
  PortableWithheldReason,
} from "@/lib/portable";

/**
 * The bound `t` from {@link useI18n}, as a parameter.
 *
 * Derived from the hook rather than written out by hand. i18next's `t` is
 * heavily overloaded, and a hand-written signature here either rejects one of
 * the two call shapes these screens use -- `t(key, default)` and
 * `t(key, { ...interpolation, defaultValue })` -- or widens to something the
 * hook's actual value does not satisfy.
 */
export type PortableTranslate = ReturnType<typeof useI18n>["t"];

/**
 * The longest a preference value gets to be on screen.
 *
 * Bounded for the same reason `portableSubject` bounds a warning subject, and
 * then some: a diff row's `incoming` value comes straight out of the file, and
 * several preferences are nested maps -- `recordTags` is zone, then record,
 * then tag list. The whole preference object is only bounded at
 * `MAX_PORTABLE_FILE_BYTES`, so an unbounded render would put two megabytes of
 * a stranger's JSON into the DOM of the one screen whose job is to be read
 * before anything is written.
 */
const MAX_PREFERENCE_VALUE_CHARACTERS = 120;

/**
 * What the host is asked to call an exported file.
 *
 * Not translated. A filename is not prose, and a localized one turns "send me
 * your export" into a support conversation about which of twelve names to look
 * for. The kind is in the name so three exports from one machine do not
 * overwrite each other.
 */
export const PORTABLE_FILE_NAMES: Record<PortableKind, string> = {
  settings: "better-cloudflare-settings.json",
  personas: "better-cloudflare-personas.json",
  "tool-permissions": "better-cloudflare-tool-permissions.json",
};

/**
 * One file's bytes, as a person will read them in an editor.
 *
 * Indented and newline-terminated: the file is something that gets opened,
 * diffed and pasted into a support thread, and all three of those go badly
 * with one very long line.
 */
export function serializePortableEnvelope(
  envelope: PortableAnyEnvelope,
): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** One string, shortened with a mark that says it was shortened. */
function boundedText(text: string): string {
  return text.length > MAX_PREFERENCE_VALUE_CHARACTERS
    ? `${text.slice(0, MAX_PREFERENCE_VALUE_CHARACTERS - 1)}…`
    : text;
}

/**
 * What to call each kind of file.
 *
 * Every arm reuses a key the catalogue already carries, so naming the three
 * kinds costs no translation at all.
 */
export function describePortableKind(
  t: PortableTranslate,
  kind: PortableKind,
): string {
  switch (kind) {
    case "settings":
      return t("Settings", "Settings");
    case "personas":
      return t("Personas", "Personas");
    case "tool-permissions":
      return t("Tool permissions", "Tool permissions");
  }
}

/**
 * Why one change an import proposed will not be made at all.
 *
 * Worded per row rather than once per section. There is one reason today, so a
 * section heading would read as the general rule for a list that in practice
 * holds a single preference, and the next reason added to
 * `PortableWithheldReason` would quietly inherit the wrong heading.
 */
export function describePortableWithheldReason(
  t: PortableTranslate,
  reason: PortableWithheldReason,
): string {
  switch (reason) {
    case "needs-password-proof":
      return t(
        "An import cannot make this change. It needs the signed-in key's password, which only the settings screen can ask for.",
        "An import cannot make this change. It needs the signed-in key's password, which only the settings screen can ask for.",
      );
  }
}

/**
 * Why a file was refused outright.
 *
 * Exhaustive with no `default`, so adding a tag to `PortableRejection` fails
 * the build here rather than silently rendering an empty string -- which, on
 * the path that reports a refusal, is the failure least likely to be noticed.
 *
 * Seven tags, six sentences: `not-json` and `malformed-payload` share one.
 * They are a real distinction in the parser -- the bytes are not JSON, versus
 * the JSON is not our shape -- but not one a reader can act on differently,
 * and the parser's own `detail` is rendered beside this line and says which.
 * A second sentence saying "broken" in other words would be eleven more
 * translations for no decision the user makes differently.
 */
export function describePortableRejection(
  t: PortableTranslate,
  rejection: PortableRejection,
): string {
  switch (rejection) {
    case "not-json":
    case "malformed-payload":
      return t(
        "That file is damaged or incomplete.",
        "That file is damaged or incomplete.",
      );
    case "not-our-format":
      return t(
        "That file was not written by this app.",
        "That file was not written by this app.",
      );
    case "unsupported-version":
      return t(
        "That file was written by a newer version of this app.",
        "That file was written by a newer version of this app.",
      );
    case "wrong-kind":
      return t(
        "That file holds a different kind of configuration.",
        "That file holds a different kind of configuration.",
      );
    case "too-large":
      return t(
        "That file is too large to read.",
        "That file is too large to read.",
      );
    case "empty":
      return t("That file is empty.", "That file is empty.");
  }
}

/**
 * What a parse dropped while still succeeding.
 *
 * The subjects are joined rather than listed as separate elements because they
 * arrive already bounded -- at most `MAX_PORTABLE_WARNING_SUBJECTS` of them,
 * each at most `MAX_PORTABLE_SUBJECT_CHARACTERS` long and stripped of control
 * characters -- so the join cannot grow without bound and cannot carry a
 * character that corrupts the line it lands in.
 *
 * `too-many-sets` is the one reason whose subjects are a count rather than
 * names: a set is dropped either for a name that is unusable or for arriving
 * past the ceiling, and in the first case the name is exactly the string there
 * is no safe way to quote.
 *
 * `unknown-tool-id` and `unknown-preference` share one sentence. They are the
 * same statement about different nouns -- this build has no entry for these,
 * so they did not survive -- and the subjects are the names themselves, right
 * there in the line. Two sentences differing only in "tools" and
 * "preferences" would be eleven extra translations to tell the reader
 * something the list beside the words already tells them. The two reasons stay
 * separate in the lib, where a caller does act on them differently.
 */
export function describePortableWarning(
  t: PortableTranslate,
  warning: PortableParseWarning,
): string {
  const subjects = warning.subjects.join(", ");
  switch (warning.reason) {
    case "unknown-tool-id":
    case "unknown-preference":
      return t(
        "This version has no entry for these, so they were dropped: {{subjects}}",
        {
          subjects,
          defaultValue: `This version has no entry for these, so they were dropped: ${subjects}`,
        },
      );
    case "high-risk-pending":
      return t(
        "These tools still need confirming, so they are not enabled yet: {{subjects}}",
        {
          subjects,
          defaultValue: `These tools still need confirming, so they are not enabled yet: ${subjects}`,
        },
      );
    case "invalid-persona":
      return t(
        "These personas are not valid, so they were skipped: {{subjects}}",
        {
          subjects,
          defaultValue: `These personas are not valid, so they were skipped: ${subjects}`,
        },
      );
    case "too-many-personas":
      return t(
        "These personas were past the limit, so they were skipped: {{subjects}}",
        {
          subjects,
          defaultValue: `These personas were past the limit, so they were skipped: ${subjects}`,
        },
      );
    case "too-many-sets":
      return t("{{sets}} saved set(s) were skipped.", {
        sets: subjects,
        defaultValue: `${subjects} saved set(s) were skipped.`,
      });
    case "policy-version-differs":
      return t(
        "The file was written under permission policy {{version}}, not this version's.",
        {
          version: subjects,
          defaultValue: `The file was written under permission policy ${subjects}, not this version's.`,
        },
      );
  }
}

/** One line saying what a settings file holds. */
export function summarizePortableSettings(
  t: PortableTranslate,
  preferences: number,
): string {
  return t("{{preferences}} preference(s)", {
    preferences,
    defaultValue: `${preferences} preference(s)`,
  });
}

/** One line saying what a persona bundle holds. */
export function summarizePortablePersonas(
  t: PortableTranslate,
  personas: number,
): string {
  return t("{{personas}} custom persona(s)", {
    personas,
    defaultValue: `${personas} custom persona(s)`,
  });
}

/** One line saying what a tool-permissions file holds. */
export function summarizePortableToolPermissions(
  t: PortableTranslate,
  tools: number,
  sets: number,
): string {
  return t("{{tools}} enabled tool(s), {{sets}} saved set(s)", {
    tools,
    sets,
    defaultValue: `${tools} enabled tool(s), ${sets} saved set(s)`,
  });
}

/**
 * Any file this app writes or reads, as one type.
 *
 * Discriminated by `kind`, which `PortableEnvelope` carries as a literal, so
 * `switch (envelope.kind)` narrows the payload for free and a fourth kind
 * added to `PortableKind` fails the build in every exhaustive switch rather
 * than falling through one of them.
 */
export type PortableAnyEnvelope =
  | PortableSettingsEnvelope
  | PortablePersonasEnvelope
  | PortableToolPermissionsEnvelope;

/**
 * One line describing what a file holds.
 *
 * Shared between export and import on purpose: the summary shown before a
 * write and the summary shown after a read are answers to the same question,
 * and two functions would be two chances for them to disagree about what
 * counts -- which is exactly the confusion a round trip is meant to rule out.
 *
 * Switched on `envelope.kind` rather than on anything the caller passes
 * alongside, so the line describes the object in hand.
 */
export function summarizePortableEnvelope(
  t: PortableTranslate,
  envelope: PortableAnyEnvelope,
): string {
  switch (envelope.kind) {
    case "settings":
      return summarizePortableSettings(
        t,
        Object.keys(envelope.payload.preferences).length,
      );
    case "personas":
      return summarizePortablePersonas(t, envelope.payload.length);
    case "tool-permissions":
      return summarizePortableToolPermissions(
        t,
        envelope.payload.enabledToolIds.length,
        envelope.payload.sets.length,
      );
  }
}

/**
 * One preference value, as a person reads it.
 *
 * `undefined` is rendered as its own thing rather than as "off". Several
 * preferences in `BrowserPreferenceData` are documented "absent means on", so
 * showing an unset preference as disabled would tell the user an import leaves
 * a feature alone when it is in fact about to turn it off -- which is the
 * distinction `PortableSettingsDiffRow.current` carries a comment about.
 */
export function formatPortablePreferenceValue(
  t: PortableTranslate,
  value: unknown,
): string {
  if (value === undefined) return t("Not set", "Not set");
  if (typeof value === "boolean") {
    return value ? t("Enabled", "Enabled") : t("Disabled", "Disabled");
  }
  if (typeof value === "string" || typeof value === "number") {
    return boundedText(String(value));
  }
  try {
    return boundedText(JSON.stringify(value) ?? String(value));
  } catch {
    // Unreachable through a parse -- JSON carries no cycles -- but these
    // helpers are also reachable with a diff a caller built by hand, and a
    // throw from a formatter would take down the preview rather than one row.
    return boundedText(String(value));
  }
}

/**
 * A host failure, as text, or `null` when the host said nothing useful.
 *
 * Not a `t()` call, deliberately. The message comes from the file dialog or
 * the filesystem rather than from this app, so there is no key to translate;
 * callers pair it with a translated heading -- "Export failed" and friends --
 * so a reader is never left with an English-only line and no idea what it is
 * about. It goes through `sanitizeRuntimeText` for the reason every runtime
 * diagnostic in this app does: the text is bounded, and a path or a token
 * inside it is redacted before it reaches a screen.
 */
export function describePortableHostError(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    return sanitizeRuntimeText(error.message);
  }
  if (typeof error === "string" && error.trim()) {
    return sanitizeRuntimeText(error);
  }
  return null;
}

export interface PortableWarningsProps {
  warnings: readonly PortableParseWarning[];
  /** Distinguishes two lists on one screen; tests select on it. */
  testId?: string;
}

/**
 * The warnings a parse or an apply produced.
 *
 * Renders nothing at all when there are none, rather than an empty container
 * or a reassuring line: a parse with no warnings is the ordinary case, and a
 * screen that says so on every import trains the user to skip the place where
 * the real warnings appear.
 */
export function PortableWarnings({ warnings, testId }: PortableWarningsProps) {
  const { t } = useI18n();
  if (warnings.length === 0) return null;
  return (
    <ul
      data-testid={testId ?? "portable-warnings"}
      className="min-w-0 space-y-1"
    >
      {warnings.map((warning, index) => (
        <li
          key={`${warning.reason}-${index}`}
          data-reason={warning.reason}
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs break-words [overflow-wrap:anywhere]"
        >
          {describePortableWarning(t, warning)}
        </li>
      ))}
    </ul>
  );
}
