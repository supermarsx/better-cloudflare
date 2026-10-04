/**
 * The permission policy, shown as the backend resolves it.
 *
 * Three properties this component is built around, in order of importance:
 *
 * 1. **It is not the enforcement.** The desktop service decides every tool
 *    call. This screen reads the decision and requests changes to it; nothing
 *    rendered here can let a denied tool run or stop an allowed one. The
 *    heading says so, because a permission screen that looks like a gate
 *    invites the belief that closing it is sufficient.
 * 2. **It never misreports.** A row shows the permission the backend reported
 *    for that tool, with one correction: the global tool switch lives in
 *    `ai_get_config`, a different command from the one that produced the
 *    catalog, so when tool use is off every row reads "refused" regardless. If
 *    the backend's reported decision and the documented rules disagree, the
 *    row says so instead of picking a winner — see `drifted` in
 *    `@/lib/ai/permissions`.
 * 3. **`readOnly` is spelled out.** It refuses writes outright rather than
 *    prompting, which is the one consequence a user will not guess, so each
 *    mode carries its consequence next to the control that selects it.
 *
 * Structure follows `McpToolPermissions` — a `fieldset` per group, a live
 * summary, rows that name the tool id verbatim — rather than inventing a second
 * idiom for the same job.
 */
import { useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { useAiPermissions } from "@/hooks/ai/use-ai-settings";
import { useI18n } from "@/hooks/use-i18n";
import {
  AI_PERMISSION_MODES,
  AI_TOOL_PERMISSIONS,
  buildAiToolPermissionRows,
  isAiToolPermission,
  summarizeAiToolPermissionRows,
  type AiPermissionReason,
  type AiToolPermissionRow,
} from "@/lib/ai/permissions";
import type {
  AiPermissionMode,
  AiPermissions,
  AiPermissionsSnapshot,
  AiToolClassification,
  AiToolPermission,
} from "@/types/ai";

import { describeAiError } from "./ai-error";

export interface AiPermissionSettingsProps {
  /** `null` until a read succeeds. Never a locally invented default. */
  snapshot: AiPermissionsSnapshot | null;
  /** From `ai_get_config`. `false` denies everything, whatever the policy says. */
  toolsEnabled: boolean;
  loading: boolean;
  saving: boolean;
  loadError: unknown;
  /** Rejects on refusal; the backend is the authority on what is storable. */
  onSave: (next: AiPermissions) => Promise<void>;
  onRetry: () => void;
}

const SELECT_CLASS =
  "ui-focus glass-surface glass-surface-hover h-8 shrink-0 rounded-md border border-border bg-background/10 px-2 text-xs focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

/** Sentinel for "no override" — an empty `<option>` value, not a permission. */
const INHERIT = "";

export function AiPermissionSettings({
  snapshot,
  toolsEnabled,
  loading,
  saving,
  loadError,
  onSave,
  onRetry,
}: AiPermissionSettingsProps) {
  const { t } = useI18n();
  const headingId = useId();
  const [search, setSearch] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const modeLabels: Record<AiPermissionMode, string> = {
    readOnly: t("Read only", "Read only"),
    ask: t("Ask before changes", "Ask before changes"),
    autonomous: t("Autonomous", "Autonomous"),
  };

  const modeConsequences: Record<AiPermissionMode, string> = {
    readOnly: t(
      "Read-only tools run. Anything that would change something is refused outright — you are not prompted, and the assistant is told it cannot do it.",
      "Read-only tools run. Anything that would change something is refused outright — you are not prompted, and the assistant is told it cannot do it.",
    ),
    ask: t(
      "Read-only tools run. Anything that would change something waits for your approval first.",
      "Read-only tools run. Anything that would change something waits for your approval first.",
    ),
    autonomous: t(
      "Every tool runs without asking, including tools that change your account.",
      "Every tool runs without asking, including tools that change your account.",
    ),
  };

  const permissionLabels: Record<AiToolPermission, string> = {
    allow: t("Runs", "Runs"),
    ask: t("Asks first", "Asks first"),
    deny: t("Refused", "Refused"),
  };

  const overrideLabels: Record<AiToolPermission, string> = {
    allow: t("Always run", "Always run"),
    ask: t("Always ask", "Always ask"),
    deny: t("Never run", "Never run"),
  };

  const classificationLabels: Record<AiToolClassification, string> = {
    read: t("Reads only", "Reads only"),
    write: t("Changes data", "Changes data"),
  };

  const groupLabels: Record<AiToolClassification, string> = {
    read: t("Read-only tools", "Read-only tools"),
    write: t("Tools that change data", "Tools that change data"),
  };

  const rows = useMemo(
    () => (snapshot ? buildAiToolPermissionRows(snapshot, toolsEnabled) : []),
    [snapshot, toolsEnabled],
  );

  const totals = useMemo(() => summarizeAiToolPermissionRows(rows), [rows]);
  const driftedCount = rows.filter((row) => row.drifted).length;

  const query = search.trim().toLocaleLowerCase();
  const visibleRows = query
    ? rows.filter((row) =>
        [
          row.tool.name,
          row.tool.description,
          classificationLabels[row.tool.classification],
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query),
      )
    : rows;

  const busy = loading || saving;

  const describeReason = (row: AiToolPermissionRow): string => {
    const reasons: Record<AiPermissionReason, string> = {
      toolsOff: t(
        "Tool use is off, so nothing runs.",
        "Tool use is off, so nothing runs.",
      ),
      override: t("Set for this tool.", "Set for this tool."),
      mode: t("From the selected mode.", "From the selected mode."),
    };
    return reasons[row.reason];
  };

  const requestSave = (next: AiPermissions) => {
    setSaveError(null);
    void onSave(next).catch((error) => {
      setSaveError(
        describeAiError(
          error,
          t(
            "The permission change could not be saved.",
            "The permission change could not be saved.",
          ),
        ).message,
      );
    });
  };

  const handleModeChange = (mode: AiPermissionMode) => {
    if (!snapshot || busy) return;
    requestSave({ mode, tools: snapshot.tools });
  };

  const handleOverrideChange = (toolName: string, value: string) => {
    if (!snapshot || busy) return;
    const tools = { ...snapshot.tools };
    if (isAiToolPermission(value)) tools[toolName] = value;
    else delete tools[toolName];
    requestSave({ mode: snapshot.mode, tools });
  };

  const handleClearOverrides = () => {
    if (!snapshot || busy) return;
    requestSave({ mode: snapshot.mode, tools: {} });
  };

  if (snapshot === null) {
    return (
      <section className="min-w-0" data-testid="ai-permissions">
        {loadError ? (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <p>
              {t(
                "The assistant's tool permissions could not be read, so none are shown.",
                "The assistant's tool permissions could not be read, so none are shown.",
              )}
            </p>
            <p>
              {
                describeAiError(
                  loadError,
                  t(
                    "The assistant's tool permissions could not be read.",
                    "The assistant's tool permissions could not be read.",
                  ),
                ).message
              }
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t("Try again", "Try again")}
            </Button>
          </div>
        ) : (
          <p
            role="status"
            aria-live="polite"
            className="text-xs text-muted-foreground"
          >
            {t(
              "Reading the assistant's tool permissions…",
              "Reading the assistant's tool permissions…",
            )}
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      className="min-w-0 space-y-4"
      aria-labelledby={headingId}
      data-testid="ai-permissions"
      data-mode={snapshot.mode}
      data-tools-enabled={toolsEnabled}
    >
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {t("Tool permissions", "Tool permissions")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "The desktop service decides every tool call, not this screen. What you see below is the decision it reports for each tool.",
            "The desktop service decides every tool call, not this screen. What you see below is the decision it reports for each tool.",
          )}
        </p>
      </div>

      {!toolsEnabled ? (
        <p
          role="note"
          data-testid="ai-permissions-tools-off"
          className="rounded-md border border-border/60 bg-card/50 px-3 py-2 text-xs"
        >
          {t(
            "Tool use is switched off for the assistant, so every tool is refused no matter what this policy says. The mode and the per-tool settings below are kept, and take effect again when tool use is switched back on.",
            "Tool use is switched off for the assistant, so every tool is refused no matter what this policy says. The mode and the per-tool settings below are kept, and take effect again when tool use is switched back on.",
          )}
        </p>
      ) : null}

      <fieldset
        className="min-w-0 space-y-2 rounded-lg border border-border/60 bg-card/30 p-3"
        disabled={busy}
      >
        <legend className="px-1 text-xs font-medium">
          {t("When no tool setting applies", "When no tool setting applies")}
        </legend>
        {AI_PERMISSION_MODES.map((mode) => (
          <label
            key={mode}
            className="flex min-w-0 items-start gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2"
            data-mode-option={mode}
          >
            <input
              type="radio"
              name="ai-permission-mode"
              className="checkbox-themed mt-1 shrink-0"
              value={mode}
              checked={snapshot.mode === mode}
              disabled={busy}
              onChange={() => handleModeChange(mode)}
            />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block text-xs font-medium">
                {modeLabels[mode]}
              </span>
              <span className="block text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
                {modeConsequences[mode]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <output
        className="block rounded-md border border-border/60 bg-card/50 px-3 py-2 text-xs"
        aria-live="polite"
        data-testid="ai-permissions-summary"
      >
        {t(
          "{{allow}} run, {{ask}} ask first, {{deny}} refused, of {{total}} tools.",
          {
            allow: totals.allow,
            ask: totals.ask,
            deny: totals.deny,
            total: rows.length,
            defaultValue: `${totals.allow} run, ${totals.ask} ask first, ${totals.deny} refused, of ${rows.length} tools.`,
          },
        )}
      </output>

      {driftedCount > 0 ? (
        <div
          role="alert"
          data-testid="ai-permissions-drift"
          className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs break-words [overflow-wrap:anywhere]"
        >
          {t(
            "The assistant reports a different decision than these rules produce for {{count}} tool(s). What it reports is what will happen; the affected rows are marked.",
            {
              count: driftedCount,
              defaultValue: `The assistant reports a different decision than these rules produce for ${driftedCount} tool(s). What it reports is what will happen; the affected rows are marked.`,
            },
          )}
        </div>
      ) : null}

      {saveError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {saveError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor="ai-tool-search" className="text-xs font-medium">
            {t("Search tools", "Search tools")}
          </label>
          <Input
            id="ai-tool-search"
            type="search"
            autoComplete="off"
            value={search}
            placeholder={t(
              "Search by tool or description",
              "Search by tool or description",
            )}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || Object.keys(snapshot.tools).length === 0}
          onClick={handleClearOverrides}
        >
          {t("Clear per-tool settings", "Clear per-tool settings")}
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border/60 bg-card/40 px-4 py-6 text-sm text-muted-foreground">
          {t(
            "The assistant reported no tools.",
            "The assistant reported no tools.",
          )}
        </p>
      ) : visibleRows.length === 0 ? (
        <p className="rounded-lg border border-border/60 bg-card/40 px-4 py-6 text-sm text-muted-foreground">
          {t("No tools match your search.", "No tools match your search.")}
        </p>
      ) : (
        <div className="space-y-4">
          {(["read", "write"] as const).map((classification) => {
            const groupRows = visibleRows.filter(
              (row) => row.tool.classification === classification,
            );
            if (groupRows.length === 0) return null;
            return (
              <fieldset
                key={classification}
                className="min-w-0 space-y-2 rounded-lg border border-border/60 bg-card/30 p-3"
                disabled={busy}
              >
                <legend className="px-1 text-xs font-medium">
                  {groupLabels[classification]}
                </legend>
                <div className="grid min-w-0 gap-2">
                  {groupRows.map((row) => {
                    const selectId = `ai-tool-permission-${row.tool.name}`;
                    return (
                      <div
                        key={row.tool.name}
                        data-testid="ai-tool-row"
                        data-tool={row.tool.name}
                        data-effective={row.effective}
                        data-reason={row.reason}
                        data-override={row.override ?? ""}
                        data-drifted={row.drifted}
                        className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <code className="text-xs font-medium break-all">
                              {row.tool.name}
                            </code>
                            <Tag>
                              {classificationLabels[row.tool.classification]}
                            </Tag>
                            <Tag
                              data-testid="ai-tool-effective"
                              className={
                                row.effective === "deny"
                                  ? "border-destructive/50 text-destructive"
                                  : undefined
                              }
                            >
                              {permissionLabels[row.effective]}
                            </Tag>
                          </div>
                          <p className="text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
                            {row.tool.description}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {describeReason(row)}
                          </p>
                          {row.drifted ? (
                            <p className="text-xs text-amber-700 dark:text-amber-200 break-words [overflow-wrap:anywhere]">
                              {t(
                                "The assistant reports “{{reported}}” for this tool, which these rules do not account for. Its answer is the one that applies.",
                                {
                                  reported: permissionLabels[row.reported],
                                  defaultValue: `The assistant reports “${permissionLabels[row.reported]}” for this tool, which these rules do not account for. Its answer is the one that applies.`,
                                },
                              )}
                            </p>
                          ) : null}
                        </div>
                        <div className="shrink-0 space-y-1">
                          <label
                            htmlFor={selectId}
                            className="block text-xs font-medium"
                          >
                            {t("This tool", "This tool")}
                          </label>
                          <select
                            id={selectId}
                            className={SELECT_CLASS}
                            value={row.override ?? INHERIT}
                            disabled={busy}
                            onChange={(event) =>
                              handleOverrideChange(
                                row.tool.name,
                                event.target.value,
                              )
                            }
                          >
                            <option value={INHERIT}>
                              {t("Use the mode", "Use the mode")}
                            </option>
                            {AI_TOOL_PERMISSIONS.map((permission) => (
                              <option key={permission} value={permission}>
                                {overrideLabels[permission]}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * The permission policy wired to the backend.
 *
 * Mounted only while its settings section is open, so `ai_get_permissions`
 * runs when the user looks at the catalog rather than whenever the assistant
 * exists. `toolsEnabled` is threaded in from the panel's `ai_get_config` read
 * because it is the one input the catalog command cannot supply.
 */
export function ConnectedAiPermissionSettings({
  toolsEnabled,
}: {
  toolsEnabled: boolean;
}) {
  const permissions = useAiPermissions();
  return (
    <AiPermissionSettings
      snapshot={permissions.snapshot}
      toolsEnabled={toolsEnabled}
      loading={permissions.loading}
      saving={permissions.saving}
      loadError={permissions.loadError}
      onSave={permissions.save}
      onRetry={() => void permissions.refresh()}
    />
  );
}
