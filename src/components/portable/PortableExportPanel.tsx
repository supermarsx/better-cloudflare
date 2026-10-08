/**
 * Choose what leaves the app, see what the file will hold, write it.
 *
 * The summary is built by calling the *same* exporter that writes the file,
 * and counting its payload. That is the point of the preview: the three
 * exporters each drop things -- `exportPersonas` filters builtins and caps at
 * `MAX_PORTABLE_PERSONAS`, `exportToolPermissions` reconciles every id against
 * the current catalogue, `exportSettings` passes everything through the
 * preference schema -- so a summary counted from the *inputs* would promise a
 * file this app does not write. Counting the projected payload cannot drift,
 * because there is nothing between the count and the bytes.
 *
 * No file is touched here. The host's write goes through `onExportFile`, so
 * the desktop save dialog, the browser download, and a test that just keeps
 * the string are all the same component.
 */
import { useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import {
  exportPersonas,
  exportSettings,
  exportToolPermissions,
  type PortableKind,
  type PortableToolPermissionsState,
} from "@/lib/portable";
import type { BrowserPreferenceData } from "@/lib/storage/storage-util";
import type { AiPersona } from "@/types/ai";

import {
  describePortableHostError,
  describePortableKind,
  PORTABLE_FILE_NAMES,
  serializePortableEnvelope,
  summarizePortableEnvelope,
  type PortableAnyEnvelope,
} from "./portable-text";

export interface PortableExportPanelProps {
  /** Stamped into the file as `appVersion`, for a support conversation. */
  appVersion: string;
  /** This machine's preferences. Credentials are not keys of this type. */
  preferences: BrowserPreferenceData;
  /** Every persona; `exportPersonas` keeps only the custom ones. */
  personas: readonly AiPersona[];
  /** Enabled tool ids and the saved set library. */
  toolPermissions: PortableToolPermissionsState;
  /** The host's write. Rejecting is how a cancelled save dialog reports back. */
  onExportFile(suggestedName: string, contents: string): Promise<void>;
  /**
   * The moment to stamp. Injectable because `exportedAt` is the only part of a
   * file that is not a function of its input, so a test that cannot fix it
   * cannot compare two exports.
   */
  now?: Date;
  /** The owner has a write in flight elsewhere, so this must not be re-entered. */
  busy?: boolean;
}

const EXPORT_KINDS: readonly PortableKind[] = [
  "settings",
  "personas",
  "tool-permissions",
];

/**
 * The timestamp the preview is built with.
 *
 * Fixed, and never written anywhere. The preview exists to count a payload,
 * and a payload is not a function of the moment it was stamped; using the real
 * clock here would instead re-run the exporter on every render that `useMemo`
 * is asked to reconsider. The file itself is stamped when the user actually
 * exports.
 */
const PREVIEW_TIMESTAMP = new Date(0);

interface PortableExportSources {
  preferences: BrowserPreferenceData;
  personas: readonly AiPersona[];
  toolPermissions: PortableToolPermissionsState;
}

function buildPortableExport(
  kind: PortableKind,
  sources: PortableExportSources,
  appVersion: string,
  now: Date,
): PortableAnyEnvelope {
  switch (kind) {
    case "settings":
      return exportSettings(sources.preferences, { appVersion, now });
    case "personas":
      return exportPersonas(sources.personas, { appVersion, now });
    case "tool-permissions":
      return exportToolPermissions(sources.toolPermissions, {
        appVersion,
        now,
      });
  }
}

export function PortableExportPanel({
  appVersion,
  preferences,
  personas,
  toolPermissions,
  onExportFile,
  now,
  busy = false,
}: PortableExportPanelProps) {
  const { t } = useI18n();
  const headingId = useId();
  const [kind, setKind] = useState<PortableKind>("settings");
  /**
   * Whether the last export failed, and what the host said about it.
   *
   * Two pieces of state rather than one nullable string: a host can reject
   * with something that carries no usable message, and a single
   * `string | null` would then render *nothing at all* for a write that
   * failed. The failure is the fact; the detail is optional.
   */
  const [failed, setFailed] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const clearFailure = () => {
    setFailed(false);
    setDetail(null);
  };

  const preview = useMemo(() => {
    try {
      return buildPortableExport(
        kind,
        { preferences, personas, toolPermissions },
        appVersion,
        PREVIEW_TIMESTAMP,
      );
    } catch {
      // `exportSettings` throws if the preference object fails the storage
      // layer's own ceilings, which is a state this machine could not have
      // saved. There is nothing to summarize, and the throw is reported for
      // real when the user exports -- a preview that threw here would take the
      // whole screen down instead.
      return null;
    }
  }, [appVersion, kind, personas, preferences, toolPermissions]);

  const handleExport = async () => {
    if (pending || busy) return;
    clearFailure();
    setPending(true);
    try {
      const envelope = buildPortableExport(
        kind,
        { preferences, personas, toolPermissions },
        appVersion,
        now ?? new Date(),
      );
      await onExportFile(
        PORTABLE_FILE_NAMES[kind],
        serializePortableEnvelope(envelope),
      );
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
      data-testid="portable-export"
    >
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {t("Export", "Export")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Exports carry no API keys and no session data.",
            "Exports carry no API keys and no session data.",
          )}
        </p>
      </div>

      {/* Labelled by the heading rather than by a legend of its own: the
          heading already names the group, and a second label for the same
          thing is one more string in eleven languages for no reader's
          benefit. */}
      <fieldset
        className="min-w-0 space-y-2 rounded-lg border border-border/60 bg-card/30 p-3"
        aria-labelledby={headingId}
        disabled={disabled}
      >
        {EXPORT_KINDS.map((candidate) => (
          <label
            key={candidate}
            className="flex min-w-0 items-start gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2"
          >
            <input
              type="radio"
              name="portable-export-kind"
              className="checkbox-themed mt-1 shrink-0"
              value={candidate}
              checked={kind === candidate}
              disabled={disabled}
              onChange={() => {
                setKind(candidate);
                // The old failure belonged to the old selection.
                clearFailure();
              }}
            />
            <span className="min-w-0 flex-1 text-xs font-medium">
              {describePortableKind(t, candidate)}
            </span>
          </label>
        ))}
      </fieldset>

      {preview ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="portable-export-summary"
        >
          {summarizePortableEnvelope(t, preview)}
        </p>
      ) : null}

      {failed ? (
        <div
          role="alert"
          data-testid="portable-export-error"
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>{t("Export failed", "Export failed")}</p>
          {detail ? (
            <p className="break-words [overflow-wrap:anywhere]">{detail}</p>
          ) : null}
        </div>
      ) : null}

      <Button
        type="button"
        size="sm"
        disabled={disabled}
        onClick={() => void handleExport()}
      >
        {t("Export", "Export")}
      </Button>
    </section>
  );
}
