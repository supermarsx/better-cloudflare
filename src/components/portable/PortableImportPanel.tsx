/**
 * Read a file, say what it is, and hand the parse on. Write nothing.
 *
 * The kind is chosen by the user rather than sniffed from the file. That is
 * not laziness: `parseEnvelope` checks the marker before the kind precisely so
 * that an unrelated JSON file is refused as "not ours" and one of *our* files
 * opened on the wrong screen is refused as "the wrong kind", and sniffing
 * would throw away the second message. "You asked to import settings and this
 * is a persona bundle" is a better answer than silently importing personas.
 *
 * Nothing here applies anything. A successful parse goes to `onParsed`, and
 * what happens next -- the diff a settings import must show first, the create
 * calls a persona bundle needs, the gated apply a permissions file gets -- is
 * the owner's. That split is what lets this panel be the one place that turns
 * a `PortableRejection` into a sentence.
 */
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import {
  parsePersonasFile,
  parseSettingsFile,
  parseToolPermissionsFile,
  type PortableKind,
  type PortableParse,
  type PortableParseWarning,
  type PortableRejection,
} from "@/lib/portable";

import {
  describePortableHostError,
  describePortableKind,
  describePortableRejection,
  PortableWarnings,
  summarizePortableEnvelope,
  type PortableAnyEnvelope,
} from "./portable-text";

export interface PortableImportPanelProps {
  /**
   * The host's read: the file's text, or `null` if the user cancelled the
   * dialog. Cancelling is a decision, not a failure, so `null` leaves the
   * screen exactly as it was.
   */
  onPickFile(): Promise<string | null>;
  /**
   * Handed every parse that succeeded, warnings and all.
   *
   * Called as soon as the parse lands, because the owner's next step -- a diff
   * for settings, a confirmation for permissions -- is itself a preview rather
   * than a write. A panel that waited for a second click here would put a
   * button in front of the preview whose job is to earn the user's click.
   */
  onParsed(envelope: PortableAnyEnvelope): void;
  /** Kinds this screen offers. Defaults to all three. */
  kinds?: readonly PortableKind[];
  /** The owner is mid-apply, so a second file must not be read over the top. */
  busy?: boolean;
}

const IMPORT_KINDS: readonly PortableKind[] = [
  "settings",
  "personas",
  "tool-permissions",
];

/**
 * The parser that owns the shape of the chosen kind.
 *
 * One switch, so there is no way to run the settings parser on a file the user
 * said was personas. Each arm returns the kind's own parse, widened to the
 * union by the return type -- `PortableParse` is covariant in its value, so
 * nothing is cast here.
 */
function parsePortableFile(
  kind: PortableKind,
  raw: string,
): PortableParse<PortableAnyEnvelope> {
  switch (kind) {
    case "settings":
      return parseSettingsFile(raw);
    case "personas":
      return parsePersonasFile(raw);
    case "tool-permissions":
      return parseToolPermissionsFile(raw);
  }
}

type ImportOutcome =
  | {
      ok: true;
      envelope: PortableAnyEnvelope;
      warnings: PortableParseWarning[];
    }
  | { ok: false; rejection: PortableRejection; detail: string };

export function PortableImportPanel({
  onPickFile,
  onParsed,
  kinds = IMPORT_KINDS,
  busy = false,
}: PortableImportPanelProps) {
  const { t } = useI18n();
  const headingId = useId();
  const [kind, setKind] = useState<PortableKind>(kinds[0] ?? "settings");
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  /**
   * Whether the *host* failed, separately from its message.
   *
   * A dialog can reject with something that carries no usable text, and a
   * single nullable string would then render nothing at all for a read that
   * failed. This is also kept apart from `outcome`: a host failure means no
   * file arrived, which is a different thing from a file that arrived and was
   * refused, and conflating them would make "the dialog crashed" look like
   * "your file is malformed".
   */
  const [failed, setFailed] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reset = () => {
    setOutcome(null);
    setFailed(false);
    setDetail(null);
  };

  const handlePick = async () => {
    if (pending || busy) return;
    reset();
    setPending(true);
    try {
      const raw = await onPickFile();
      if (raw === null) return;
      const parse = parsePortableFile(kind, raw);
      if (!parse.ok) {
        setOutcome({
          ok: false,
          rejection: parse.rejection,
          detail: parse.detail,
        });
        return;
      }
      setOutcome({
        ok: true,
        envelope: parse.value,
        warnings: parse.warnings,
      });
      onParsed(parse.value);
    } catch (caught) {
      setFailed(true);
      setDetail(describePortableHostError(caught));
    } finally {
      setPending(false);
    }
  };

  const disabled = pending || busy;

  return (
    <section
      className="min-w-0 space-y-3"
      aria-labelledby={headingId}
      data-testid="portable-import"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {t("Import", "Import")}
      </h3>

      <fieldset
        className="min-w-0 space-y-2 rounded-lg border border-border/60 bg-card/30 p-3"
        aria-labelledby={headingId}
        disabled={disabled}
      >
        {kinds.map((candidate) => (
          <label
            key={candidate}
            className="flex min-w-0 items-start gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2"
          >
            <input
              type="radio"
              name="portable-import-kind"
              className="checkbox-themed mt-1 shrink-0"
              value={candidate}
              checked={kind === candidate}
              disabled={disabled}
              onChange={() => {
                setKind(candidate);
                // The previous outcome described a file read as a different
                // kind. Keeping it on screen next to the new selection would
                // invite the user to act on a parse that no longer applies.
                reset();
              }}
            />
            <span className="min-w-0 flex-1 text-xs font-medium">
              {describePortableKind(t, candidate)}
            </span>
          </label>
        ))}
      </fieldset>

      <Button
        type="button"
        size="sm"
        disabled={disabled}
        onClick={() => void handlePick()}
      >
        {t("Choose a file", "Choose a file")}
      </Button>

      {failed ? (
        <div
          role="alert"
          data-testid="portable-import-host-error"
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>{t("Import failed", "Import failed")}</p>
          {detail ? (
            <p className="break-words [overflow-wrap:anywhere]">{detail}</p>
          ) : null}
        </div>
      ) : null}

      {outcome && !outcome.ok ? (
        <div
          role="alert"
          data-testid="portable-import-rejection"
          data-rejection={outcome.rejection}
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>{describePortableRejection(t, outcome.rejection)}</p>
          {/* The parser's own `detail`, verbatim and untranslated: it names
              the field or the ceiling that was wrong, is written for a support
              thread rather than for every reader, and is already bounded and
              stripped of control characters by `portableSubject` wherever it
              quotes the file. Translating it would mean eleven translations of
              a byte count. */}
          <p className="text-muted-foreground break-words [overflow-wrap:anywhere]">
            {outcome.detail}
          </p>
        </div>
      ) : null}

      {outcome?.ok ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="portable-import-outcome"
          data-kind={outcome.envelope.kind}
          className="min-w-0 space-y-2 rounded-md border border-border/60 bg-card/30 px-3 py-2 text-xs"
        >
          <p data-testid="portable-import-summary">
            {summarizePortableEnvelope(t, outcome.envelope)}
          </p>
          <p className="text-muted-foreground">
            {t(
              "The file was read. Nothing has been changed yet.",
              "The file was read. Nothing has been changed yet.",
            )}
          </p>
          <PortableWarnings
            warnings={outcome.warnings}
            testId="portable-import-warnings"
          />
        </div>
      ) : null}
    </section>
  );
}
