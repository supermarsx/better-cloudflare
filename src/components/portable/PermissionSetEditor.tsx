/**
 * The library of saved tool selections: save one, switch to one, delete one,
 * and move the library between machines.
 *
 * Switching to a set is not a way around the permission gate, and this screen
 * has to say so out loud. `Storage.applyMcpPermissionSet` runs the set's ids
 * through `partitionMcpPermissionPolicySelection` and then
 * `stageMcpEnabledTools` -- the same two steps a click in the permissions
 * screen takes -- so a set holding a destructive tool arrives *pending
 * confirmation*, and so does an already-confirmed one, because adopting a
 * selection is its own act. The user is therefore owed a plain statement of
 * which tools are not yet enabled after a switch; that is what the
 * `high-risk-pending` line is for, and it is the one piece of feedback here
 * that must not be dropped.
 *
 * Nothing is written by this component. Saving, deleting and switching go out
 * through props that the owner wires to the storage methods, and an imported
 * library is handed over as a `PortableToolPermissionsApplication` -- the three
 * id lists `stageMcpEnabledTools` takes, in its order -- rather than being
 * staged here. Keeping the writes outside means this screen can be driven in a
 * test without a storage backend, and it means there is exactly one place that
 * decides what a write to `mcpEnabledTools` looks like.
 */
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/hooks/use-i18n";
import {
  MAX_MCP_PERMISSION_SETS,
  normalizeMcpPermissionSetName,
} from "@/lib/mcp/tool-permissions";
import {
  applyPortableToolPermissions,
  exportToolPermissions,
  parseToolPermissionsFile,
  type PortableParseWarning,
  type PortableRejection,
  type PortableToolPermissionsApplication,
} from "@/lib/portable";

import {
  describePortableHostError,
  describePortableRejection,
  PORTABLE_FILE_NAMES,
  PortableWarnings,
  serializePortableEnvelope,
  summarizePortableEnvelope,
} from "./portable-text";

/** What `Storage.applyMcpPermissionSet` reports a switch did. */
export interface PermissionSetApplication {
  enabledTools: string[];
  pendingHighRiskToolIds: string[];
  removedToolIds: string[];
}

export interface PermissionSetEditorProps {
  /** The selection a new set would capture: what is enabled right now. */
  selectedToolIds: readonly string[];
  /** The saved library, keyed by name, from `getMcpPermissionSets`. */
  sets: Readonly<Record<string, readonly string[]>>;
  /**
   * `saveMcpPermissionSet`: the name it was stored under, or `null` if the
   * name was unusable or the library is full.
   */
  onSave(name: string, toolIds: readonly string[]): string | null;
  /** `deleteMcpPermissionSet`. The list re-rendering is the confirmation. */
  onDelete(name: string): void;
  /**
   * `applyMcpPermissionSet`: what the switch did, or `null` if there is no set
   * by that name any more.
   */
  onApply(name: string): PermissionSetApplication | null;
  /**
   * What an imported file would leave this machine as. The owner stages it --
   * `enabledToolIds`, `pendingHighRiskToolIds` and `removedToolIds` are
   * exactly `stageMcpEnabledTools`'s three arguments -- and persists `sets`.
   */
  onImport(application: PortableToolPermissionsApplication): void;
  /** Stamped into an exported file, for a support conversation. */
  appVersion: string;
  onExportFile(suggestedName: string, contents: string): Promise<void>;
  onPickFile(): Promise<string | null>;
  /** Fixed in tests, so two exports of one library can be compared. */
  now?: Date;
  /** A permission write is in flight elsewhere; nothing here may be re-entered. */
  busy?: boolean;
}

/**
 * The result of the last thing the user did, as one value.
 *
 * One slot rather than six booleans, because these are mutually exclusive by
 * construction -- each action replaces whatever the previous one said -- and
 * separate flags would eventually leave a stale "switched to Read only" line
 * sitting above a fresh refusal.
 */
type EditorOutcome =
  | { kind: "saved" }
  | { kind: "applied"; name: string; warnings: PortableParseWarning[] }
  | { kind: "imported"; summary: string; warnings: PortableParseWarning[] }
  | { kind: "rejected"; rejection: PortableRejection; detail: string }
  | { kind: "save-refused"; reason: "name" | "full" }
  | { kind: "host-failed"; detail: string | null };

/**
 * Warnings for a local switch, in the vocabulary a parse uses.
 *
 * Built by hand rather than with `portableWarning`, which `@/lib/portable`
 * deliberately does not re-export: its helpers bound and strip *file*-supplied
 * strings, and these ids come from the catalogue by way of
 * `capMcpPermissionDiagnosticIds`, which has already capped them at
 * `MAX_MCP_PERMISSION_DIAGNOSTIC_IDS` and bounded each one's length. Reusing
 * the same two reasons means a tool left pending reads identically whether the
 * user got there by switching sets or by importing a file.
 */
function switchWarnings(
  application: PermissionSetApplication,
): PortableParseWarning[] {
  const warnings: PortableParseWarning[] = [];
  if (application.pendingHighRiskToolIds.length > 0) {
    warnings.push({
      reason: "high-risk-pending",
      subjects: [...application.pendingHighRiskToolIds],
    });
  }
  if (application.removedToolIds.length > 0) {
    warnings.push({
      reason: "unknown-tool-id",
      subjects: [...application.removedToolIds],
    });
  }
  return warnings;
}

/**
 * Whether the library already holds a set under this name.
 *
 * `hasOwnProperty` rather than `in`. `getMcpPermissionSets` returns a
 * null-prototype object where the two agree, but this prop is reachable with
 * an ordinary object literal, and `"constructor" in {}` is `true` -- which
 * would make a set named "constructor" look like an overwrite of something
 * that is not there, and so escape the full-library check below.
 */
function holdsSet(
  sets: Readonly<Record<string, readonly string[]>>,
  name: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(sets, name);
}

export function PermissionSetEditor({
  selectedToolIds,
  sets,
  onSave,
  onDelete,
  onApply,
  onImport,
  appVersion,
  onExportFile,
  onPickFile,
  now,
  busy = false,
}: PermissionSetEditorProps) {
  const { t } = useI18n();
  const headingId = useId();
  const nameId = useId();
  const [draftName, setDraftName] = useState("");
  const [outcome, setOutcome] = useState<EditorOutcome | null>(null);
  const [pending, setPending] = useState(false);

  const disabled = pending || busy;
  const entries = Object.entries(sets);

  const handleSave = () => {
    if (disabled) return;
    // Normalized here as well as in storage, because the two refusals need
    // different words and only this side can tell them apart: the storage
    // method returns `null` for both an unusable name and a full library.
    const name = normalizeMcpPermissionSetName(draftName);
    if (name === null) {
      setOutcome({ kind: "save-refused", reason: "name" });
      return;
    }
    if (!holdsSet(sets, name) && entries.length >= MAX_MCP_PERMISSION_SETS) {
      setOutcome({ kind: "save-refused", reason: "full" });
      return;
    }
    const stored = onSave(name, selectedToolIds);
    if (stored === null) {
      // The name has just been through the same normalizer storage uses, so
      // the only refusal left is the ceiling -- which means the library is
      // fuller than this render's `sets` prop knew.
      setOutcome({ kind: "save-refused", reason: "full" });
      return;
    }
    setDraftName("");
    // Confirmed explicitly, because saving over an existing set changes
    // nothing a reader can see: the row was already there, and a selection
    // saved twice has the same tool count both times.
    setOutcome({ kind: "saved" });
  };

  const handleApply = (name: string) => {
    if (disabled) return;
    const application = onApply(name);
    if (application === null) {
      // The set went away between this render and the click. The list
      // re-rendering without it is the whole story, so there is nothing to
      // say that the screen does not already show.
      setOutcome(null);
      return;
    }
    setOutcome({
      kind: "applied",
      name,
      warnings: switchWarnings(application),
    });
  };

  const handleExport = async () => {
    if (disabled) return;
    setOutcome(null);
    setPending(true);
    try {
      const envelope = exportToolPermissions(
        { enabledToolIds: selectedToolIds, sets },
        { appVersion, now: now ?? new Date() },
      );
      await onExportFile(
        PORTABLE_FILE_NAMES["tool-permissions"],
        serializePortableEnvelope(envelope),
      );
    } catch (caught) {
      setOutcome({
        kind: "host-failed",
        detail: describePortableHostError(caught),
      });
    } finally {
      setPending(false);
    }
  };

  const handleImport = async () => {
    if (disabled) return;
    setOutcome(null);
    setPending(true);
    try {
      const raw = await onPickFile();
      // A cancelled dialog is a decision, not a failure.
      if (raw === null) return;
      const parse = parseToolPermissionsFile(raw);
      if (!parse.ok) {
        setOutcome({
          kind: "rejected",
          rejection: parse.rejection,
          detail: parse.detail,
        });
        return;
      }
      // The gate, not a second copy of it: `applyPortableToolPermissions`
      // partitions the file's selection exactly as a click in the permissions
      // screen does, so a destructive tool in the file comes back *pending*
      // and an id this build has never heard of comes back dropped.
      const application = applyPortableToolPermissions(
        { enabledToolIds: selectedToolIds, sets },
        parse.value.payload,
      );
      onImport(application);
      setOutcome({
        kind: "imported",
        summary: summarizePortableEnvelope(t, parse.value),
        // The parse's warnings and the apply's are both the user's business
        // and name different things -- sets the file lost on the way in, and
        // tools the apply could not grant.
        warnings: [...parse.warnings, ...application.warnings],
      });
    } catch (caught) {
      setOutcome({
        kind: "host-failed",
        detail: describePortableHostError(caught),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      className="min-w-0 space-y-3"
      aria-labelledby={headingId}
      data-testid="permission-set-editor"
    >
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {t("Permission sets", "Permission sets")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "A saved selection you can switch to. Switching puts every tool above read-only back to pending confirmation.",
            "A saved selection you can switch to. Switching puts every tool above read-only back to pending confirmation.",
          )}
        </p>
      </div>

      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={nameId} className="text-xs">
            {t("Name", "Name")}
          </Label>
          <Input
            id={nameId}
            value={draftName}
            disabled={disabled}
            onChange={(event) => {
              setDraftName(event.target.value);
              // The refusal was about the old name.
              setOutcome(null);
            }}
          />
        </div>
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={handleSave}
        >
          {t("Save", "Save")}
        </Button>
      </div>

      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="no-sets">
          {t("No saved sets yet.", "No saved sets yet.")}
        </p>
      ) : (
        <ul className="min-w-0 space-y-2" data-testid="permission-sets">
          {entries.map(([name, toolIds]) => (
            <li
              key={name}
              data-testid="permission-set-row"
              data-set={name}
              className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-md border border-border/50 bg-card/50 px-3 py-2"
            >
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block text-xs font-medium break-words [overflow-wrap:anywhere]">
                  {name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("{{tools}} tool(s)", {
                    tools: toolIds.length,
                    defaultValue: `${toolIds.length} tool(s)`,
                  })}
                </span>
              </span>
              <span className="flex shrink-0 flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => handleApply(name)}
                >
                  {t("Apply", "Apply")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    setOutcome(null);
                    onDelete(name);
                  }}
                >
                  {t("Delete", "Delete")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => void handleExport()}
        >
          {t("Export", "Export")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => void handleImport()}
        >
          {t("Import", "Import")}
        </Button>
      </div>

      {outcome?.kind === "save-refused" ? (
        <div
          role="alert"
          data-testid="permission-set-save-error"
          data-reason={outcome.reason}
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {outcome.reason === "name"
            ? t("That name cannot be used.", "That name cannot be used.")
            : t("You already have {{limit}} saved sets. Delete one first.", {
                limit: MAX_MCP_PERMISSION_SETS,
                defaultValue: `You already have ${MAX_MCP_PERMISSION_SETS} saved sets. Delete one first.`,
              })}
        </div>
      ) : null}

      {outcome?.kind === "host-failed" ? (
        <div
          role="alert"
          data-testid="permission-set-host-error"
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>{t("Export failed", "Export failed")}</p>
          {outcome.detail ? (
            <p className="break-words [overflow-wrap:anywhere]">
              {outcome.detail}
            </p>
          ) : null}
        </div>
      ) : null}

      {outcome?.kind === "rejected" ? (
        <div
          role="alert"
          data-testid="permission-set-rejection"
          data-rejection={outcome.rejection}
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>{describePortableRejection(t, outcome.rejection)}</p>
          {/* The parser's own detail, verbatim: it names the field that was
              wrong, is already bounded and stripped of control characters
              where it quotes the file, and is written for a support thread
              rather than for translation. */}
          <p className="text-muted-foreground break-words [overflow-wrap:anywhere]">
            {outcome.detail}
          </p>
        </div>
      ) : null}

      {outcome?.kind === "saved" ||
      outcome?.kind === "applied" ||
      outcome?.kind === "imported" ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="permission-set-outcome"
          data-outcome={outcome.kind}
          className="min-w-0 space-y-2 rounded-md border border-border/60 bg-card/30 px-3 py-2 text-xs"
        >
          <p>
            {outcome.kind === "saved"
              ? t("Saved", "Saved")
              : outcome.kind === "applied"
                ? t("Switched to {{name}}.", {
                    name: outcome.name,
                    defaultValue: `Switched to ${outcome.name}.`,
                  })
                : outcome.summary}
          </p>
          {outcome.kind === "saved" ? null : (
            <PortableWarnings
              warnings={outcome.warnings}
              testId="permission-set-warnings"
            />
          )}
        </div>
      ) : null}
    </section>
  );
}
