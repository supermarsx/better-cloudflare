/**
 * Personas: pick the one in use, and manage the custom ones.
 *
 * Builtins are immutable on the backend, so they get no edit or delete
 * affordance at all — not a disabled one. A control that exists only to be
 * refused teaches the user that the UI is decorative, and this screen already
 * has to be believed about permissions.
 *
 * Inputs are validated against the Rust bounds (see `AI_PERSONA_LIMITS`) before
 * a call is made, purely so the feedback is immediate. The backend stays the
 * authority: a value that passes here can still come back refused, and that
 * refusal is shown verbatim rather than being second-guessed.
 *
 * Deletion confirms inline rather than in a modal. The list is the context the
 * user needs in order to answer, so taking it away behind an overlay — and
 * re-implementing focus isolation to do it — would make the decision harder,
 * not safer.
 */
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useAiPersonas } from "@/hooks/ai/use-ai-settings";
import { useI18n } from "@/hooks/use-i18n";
import {
  AI_PERSONA_LIMITS,
  validatePersonaInput,
  type AiValidationIssue,
} from "@/lib/ai/permissions";
import type { AiPersona, AiPersonaInput } from "@/types/ai";

import { describeAiError } from "./ai-error";

export interface AiPersonaSettingsProps {
  personas: AiPersona[];
  loading: boolean;
  loadError: unknown;
  /** From `AgentConfig.personaId`. `null` means the preset prompt is in use. */
  selectedId: string | null;
  /** An agent-config write is in flight, so selection must not be re-entered. */
  selectionBusy: boolean;
  onSelect: (id: string | null) => void;
  onCreate: (persona: AiPersonaInput) => Promise<AiPersona | null>;
  onUpdate: (id: string, persona: AiPersonaInput) => Promise<AiPersona | null>;
  onDelete: (id: string) => Promise<void>;
  onRetry: () => void;
}

const EMPTY_DRAFT: AiPersonaInput = {
  name: "",
  description: "",
  systemPrompt: "",
};

/** `null` = the editor is closed; a string id = editing that persona. */
type EditorTarget = { kind: "create" } | { kind: "edit"; id: string } | null;

export function AiPersonaSettings({
  personas,
  loading,
  loadError,
  selectedId,
  selectionBusy,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
  onRetry,
}: AiPersonaSettingsProps) {
  const { t } = useI18n();
  const headingId = useId();
  const [editor, setEditor] = useState<EditorTarget>(null);
  const [draft, setDraft] = useState<AiPersonaInput>(EMPTY_DRAFT);
  const [issues, setIssues] = useState<AiValidationIssue[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // A persona deleted elsewhere must not leave a confirmation prompt pointing
  // at something that is already gone.
  useEffect(() => {
    setPendingDeleteId((current) =>
      current !== null && !personas.some((persona) => persona.id === current)
        ? null
        : current,
    );
  }, [personas]);

  const describeIssue = (issue: AiValidationIssue): string => {
    if (issue.code === "required") {
      return issue.field === "name"
        ? t("Enter a name.", "Enter a name.")
        : t("Enter a system prompt.", "Enter a system prompt.");
    }
    if (issue.code === "tooLong") {
      const fieldLabels = {
        name: t("Name", "Name"),
        description: t("Description", "Description"),
        systemPrompt: t("System prompt", "System prompt"),
      } as const;
      return t("{{field}} must be at most {{limit}} bytes.", {
        field: fieldLabels[issue.field],
        limit: issue.limit,
        defaultValue: `${fieldLabels[issue.field]} must be at most ${issue.limit} bytes.`,
      });
    }
    // The agent-config codes cannot reach a persona form.
    return t("That value is out of range.", "That value is out of range.");
  };

  const openCreate = () => {
    setEditor({ kind: "create" });
    setDraft(EMPTY_DRAFT);
    setIssues([]);
    setFormError(null);
    setRemediation(null);
  };

  const openEdit = (persona: AiPersona) => {
    setEditor({ kind: "edit", id: persona.id });
    setDraft({
      name: persona.name,
      description: persona.description,
      systemPrompt: persona.systemPrompt,
    });
    setIssues([]);
    setFormError(null);
    setRemediation(null);
  };

  const closeEditor = () => {
    setEditor(null);
    setDraft(EMPTY_DRAFT);
    setIssues([]);
    setFormError(null);
    setRemediation(null);
  };

  const handleSubmit = async () => {
    if (editor === null || busy) return;
    const found = validatePersonaInput(draft);
    setIssues(found);
    setFormError(null);
    setRemediation(null);
    if (found.length > 0) return;

    const trimmed: AiPersonaInput = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      systemPrompt: draft.systemPrompt.trim(),
    };

    setBusy(true);
    try {
      if (editor.kind === "create") await onCreate(trimmed);
      else await onUpdate(editor.id, trimmed);
      closeEditor();
    } catch (error) {
      const described = describeAiError(
        error,
        t("The persona could not be saved.", "The persona could not be saved."),
      );
      setFormError(described.message);
      setRemediation(described.remediation ?? null);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setFormError(null);
    setRemediation(null);
    setBusy(true);
    try {
      await onDelete(id);
      setPendingDeleteId(null);
      // An open editor for the deleted persona would submit against a missing id.
      if (editor?.kind === "edit" && editor.id === id) closeEditor();
    } catch (error) {
      const described = describeAiError(
        error,
        t(
          "The persona could not be deleted.",
          "The persona could not be deleted.",
        ),
      );
      setFormError(described.message);
      setRemediation(described.remediation ?? null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="min-w-0 space-y-4"
      aria-labelledby={headingId}
      data-testid="ai-personas"
    >
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {t("Personas", "Personas")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "A persona is the system prompt the assistant starts every conversation with. Built-in personas ship with the app and cannot be changed.",
            "A persona is the system prompt the assistant starts every conversation with. Built-in personas ship with the app and cannot be changed.",
          )}
        </p>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>
            {
              describeAiError(
                loadError,
                t(
                  "The personas could not be listed.",
                  "The personas could not be listed.",
                ),
              ).message
            }
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t("Try again", "Try again")}
          </Button>
        </div>
      ) : null}

      {formError ? (
        <div
          role="alert"
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>{formError}</p>
          {remediation ? <p>{remediation}</p> : null}
        </div>
      ) : null}

      <fieldset
        className="min-w-0 space-y-2 rounded-lg border border-border/60 bg-card/30 p-3"
        disabled={selectionBusy || busy}
      >
        <legend className="px-1 text-xs font-medium">
          {t("Active persona", "Active persona")}
        </legend>

        <label className="flex min-w-0 items-start gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2">
          <input
            type="radio"
            name="ai-persona"
            className="checkbox-themed mt-1 shrink-0"
            checked={selectedId === null}
            disabled={selectionBusy || busy}
            onChange={() => onSelect(null)}
          />
          <span className="min-w-0 flex-1 space-y-1">
            <span className="block text-xs font-medium">
              {t("No persona", "No persona")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t(
                "Use the assistant's own default prompt.",
                "Use the assistant's own default prompt.",
              )}
            </span>
          </span>
        </label>

        {loading && personas.length === 0 ? (
          <p
            role="status"
            aria-live="polite"
            className="text-xs text-muted-foreground"
          >
            {t("Loading personas…", "Loading personas…")}
          </p>
        ) : null}

        {personas.map((persona) => (
          <div
            key={persona.id}
            data-testid="ai-persona-row"
            data-persona={persona.id}
            data-builtin={persona.builtin}
            className="min-w-0 space-y-2 rounded-md border border-border/50 bg-card/50 px-3 py-2"
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <label className="flex min-w-0 flex-1 items-start gap-3">
                <input
                  type="radio"
                  name="ai-persona"
                  className="checkbox-themed mt-1 shrink-0"
                  checked={selectedId === persona.id}
                  disabled={selectionBusy || busy}
                  onChange={() => onSelect(persona.id)}
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-xs font-medium break-words [overflow-wrap:anywhere]">
                      {persona.name}
                    </span>
                    <Tag>
                      {persona.builtin
                        ? t("Built in · read only", "Built in · read only")
                        : t("Custom", "Custom")}
                    </Tag>
                  </span>
                  <span className="block text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
                    {persona.description}
                  </span>
                </span>
              </label>

              {persona.builtin ? null : (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => openEdit(persona)}
                  >
                    {t("Edit", "Edit")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setFormError(null);
                      setPendingDeleteId(persona.id);
                    }}
                  >
                    {t("Delete", "Delete")}
                  </Button>
                </div>
              )}
            </div>

            <details className="min-w-0">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("Show system prompt", "Show system prompt")}
              </summary>
              <pre className="scrollbar-themed mt-1 max-h-40 overflow-auto rounded-md border border-border/50 bg-background/40 p-2 text-[11px] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {persona.systemPrompt}
              </pre>
            </details>

            {pendingDeleteId === persona.id ? (
              <div
                role="alertdialog"
                aria-label={t("Confirm deletion", "Confirm deletion")}
                data-testid="ai-persona-delete-confirm"
                className="space-y-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs"
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  setPendingDeleteId(null);
                }}
              >
                <p className="break-words [overflow-wrap:anywhere]">
                  {t(
                    "Delete “{{name}}”? Conversations already started with it keep their prompt; new ones cannot use it again.",
                    {
                      name: persona.name,
                      defaultValue: `Delete “${persona.name}”? Conversations already started with it keep their prompt; new ones cannot use it again.`,
                    },
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setPendingDeleteId(null)}
                  >
                    {t("Cancel", "Cancel")}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleDelete(persona.id)}
                  >
                    {t("Delete persona", "Delete persona")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </fieldset>

      {editor === null ? (
        <Button type="button" size="sm" disabled={busy} onClick={openCreate}>
          {t("New persona", "New persona")}
        </Button>
      ) : (
        <form
          className="min-w-0 space-y-3 rounded-lg border border-border/60 bg-card/30 p-3"
          data-testid="ai-persona-editor"
          data-editor-kind={editor.kind}
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <h4 className="text-xs font-semibold">
            {editor.kind === "create"
              ? t("New persona", "New persona")
              : t("Edit persona", "Edit persona")}
          </h4>

          <div className="space-y-1">
            <Label htmlFor="ai-persona-name">{t("Name", "Name")}</Label>
            <Input
              id="ai-persona-name"
              value={draft.name}
              maxLength={AI_PERSONA_LIMITS.nameBytes}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, name: event.target.value }))
              }
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="ai-persona-description">
              {t("Description", "Description")}
            </Label>
            <Input
              id="ai-persona-description"
              value={draft.description}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  description: event.target.value,
                }))
              }
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="ai-persona-prompt">
              {t("System prompt", "System prompt")}
            </Label>
            <Textarea
              id="ai-persona-prompt"
              rows={6}
              value={draft.systemPrompt}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  systemPrompt: event.target.value,
                }))
              }
            />
          </div>

          {issues.length > 0 ? (
            <ul
              role="alert"
              data-testid="ai-persona-issues"
              className="list-disc space-y-1 rounded-md border border-destructive/40 bg-destructive/10 py-2 pl-7 pr-3 text-xs text-destructive"
            >
              {issues.map((issue) => (
                <li key={`${issue.field}-${issue.code}`}>
                  {describeIssue(issue)}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy
                ? t("Saving…", "Saving…")
                : editor.kind === "create"
                  ? t("Create persona", "Create persona")
                  : t("Save persona", "Save persona")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={closeEditor}
            >
              {t("Cancel", "Cancel")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * Personas wired to the backend.
 *
 * Mounted only while its settings section is open, so `ai_list_personas` runs
 * when the user looks at the list. The *selection* is not persona state at all
 * — it is `AgentConfig.personaId` — so it stays owned by the panel and arrives
 * here as a prop.
 */
export function ConnectedAiPersonaSettings({
  selectedId,
  selectionBusy,
  onSelect,
}: {
  selectedId: string | null;
  selectionBusy: boolean;
  onSelect: (id: string | null) => void;
}) {
  const personas = useAiPersonas();
  return (
    <AiPersonaSettings
      personas={personas.personas}
      loading={personas.loading}
      loadError={personas.loadError}
      selectedId={selectedId}
      selectionBusy={selectionBusy}
      onSelect={onSelect}
      onCreate={personas.create}
      onUpdate={personas.update}
      onDelete={personas.remove}
      onRetry={() => void personas.refresh()}
    />
  );
}
