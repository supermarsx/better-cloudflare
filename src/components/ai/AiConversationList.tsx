/**
 * Conversation picker plus the new-conversation row.
 *
 * A conversation is created against a provider and a model, so the row carries
 * both. The provider is a profile id, which is why the picker shows the
 * profile's *label* and the list resolves ids back to labels: `groq-fast` is
 * not a name anyone chose to read.
 *
 * An id that no longer resolves is shown as the raw id rather than hidden or
 * guessed at. Profiles can be deleted while conversations created with them
 * survive, and claiming such a conversation belongs to some other provider
 * would be a lie about which endpoint saw the transcript.
 */
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AiProviderProfile, ConversationMeta } from "@/types/ai";

import { AI_SELECT_CONTENT_CLASS, AI_SELECT_TRIGGER_CLASS } from "./ai-select";
import { describeAiError } from "./ai-error";

export interface AiConversationListProps {
  conversations: ConversationMeta[];
  selectedId: string | null;
  loading: boolean;
  /** Provider profiles that are configured right now. */
  configuredProviders: readonly AiProviderProfile[];
  /** The selected profile id, or `null` when none is configured. */
  provider: string | null;
  model: string;
  creating: boolean;
  onProviderChange: (id: string) => void;
  onModelChange: (model: string) => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /**
   * Retitle a conversation.
   *
   * `ai_set_conversation_title` has been registered since the chat shipped and
   * nothing called it, which left every conversation stuck with the title it
   * was created with. That is what makes a list of several of them
   * unnavigable, and it is the reason this exists.
   *
   * Rejects on refusal so the row can show the backend's own message — a
   * title is bounded in UTF-8 bytes (`maxTitleBytes`), so a short-looking
   * title can still be too long.
   */
  onRename?: (id: string, title: string) => Promise<void>;
  /**
   * Stack the new-conversation row instead of pairing it, for the 22rem dock
   * and the 26rem bubble.
   *
   * The row is a 9rem select, a 12rem input and a button: about 23rem, which
   * `flex-wrap` rescues from overflowing but leaves cramped and ragged on both
   * framed surfaces. Keyed off the surface rather than a `sm:` breakpoint
   * because a docked panel can be 22rem wide on a 2560px display.
   */
  compact?: boolean;
}

export function AiConversationList({
  conversations,
  selectedId,
  loading,
  configuredProviders,
  provider,
  model,
  creating,
  onProviderChange,
  onModelChange,
  onCreate,
  onSelect,
  onDelete,
  onRename,
  compact = false,
}: AiConversationListProps) {
  const { t } = useI18n();
  /** The conversation being retitled, and the draft title, or `null`. */
  const [renaming, setRenaming] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  const commitRename = () => {
    if (!renaming || !onRename) return;
    const title = renaming.title.trim();
    // Refused locally only for blank, which the backend also refuses: every
    // other rule is the backend's, and its message is better than a guess.
    if (title.length === 0) {
      setRenameError(
        t("A conversation needs a title.", "A conversation needs a title."),
      );
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    void onRename(renaming.id, title)
      .then(() => setRenaming(null))
      .catch((error: unknown) => {
        setRenameError(
          describeAiError(
            error,
            t(
              "The conversation could not be renamed.",
              "The conversation could not be renamed.",
            ),
          ).message,
        );
      })
      .finally(() => setRenameBusy(false));
  };

  const handleRenameKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
      return;
    }
    if (event.key === "Escape") {
      // Stopped here so the key does not also dismiss the bubble the row is
      // rendered inside: cancelling an edit is not dismissing the assistant.
      event.preventDefault();
      event.stopPropagation();
      setRenaming(null);
      setRenameError(null);
    }
  };
  const canCreate =
    !creating && provider !== null && model.trim().length > 0 && !loading;

  /** The profile's label, or the bare id when it no longer resolves. */
  const providerLabel = (id: string): string =>
    configuredProviders.find((entry) => entry.id === id)?.label ?? id;

  return (
    <div className="space-y-3" data-testid="ai-conversations">
      {configuredProviders.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
          {t(
            "Configure a provider in Settings to start a conversation.",
            "Configure a provider in Settings to start a conversation.",
          )}
        </p>
      ) : (
        <div
          className={cn(
            "min-w-0 gap-2",
            compact
              ? "grid grid-cols-[1fr_auto] items-end"
              : "flex flex-wrap items-end",
          )}
        >
          <div className={cn("space-y-1", compact && "col-span-2 min-w-0")}>
            <Label className="sr-only" htmlFor="ai-new-provider">
              {t("Provider", "Provider")}
            </Label>
            <Select
              value={provider ?? undefined}
              onValueChange={(value) => onProviderChange(value)}
            >
              <SelectTrigger
                id="ai-new-provider"
                aria-label={t("Provider", "Provider")}
                className={cn(
                  AI_SELECT_TRIGGER_CLASS,
                  compact ? "w-full" : "w-36",
                )}
              >
                <SelectValue />
              </SelectTrigger>
              {/* Raised for the same reason the settings dropdowns are: this
                  picker is rendered inside the floating bubble too, and the
                  shared `z-50` default loses to the bubble's `z-[60]`. */}
              <SelectContent className={AI_SELECT_CONTENT_CLASS}>
                {configuredProviders.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className={cn("space-y-1", compact && "min-w-0")}>
            <Label className="sr-only" htmlFor="ai-new-model">
              {t("Model", "Model")}
            </Label>
            <Input
              id="ai-new-model"
              value={model}
              aria-label={t("Model", "Model")}
              placeholder={t("Model", "Model")}
              className={cn("h-8 text-xs", compact ? "w-full" : "w-48")}
              onChange={(event) => onModelChange(event.target.value)}
            />
          </div>
          <Button
            type="button"
            size="icon"
            className="h-8 w-8"
            disabled={!canCreate}
            aria-label={t("New conversation", "New conversation")}
            onClick={onCreate}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      )}

      {conversations.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {loading
            ? t("Loading…", "Loading…")
            : t("No conversations yet.", "No conversations yet.")}
        </p>
      ) : (
        <ul role="list" className="space-y-1">
          {conversations.map((meta) => (
            <li
              key={meta.id}
              className="min-w-0"
              data-testid="ai-conversation-row"
              data-conversation-id={meta.id}
              data-active={meta.id === selectedId}
            >
              {renaming?.id === meta.id ? (
                <div className="min-w-0 space-y-1">
                  <Label className="sr-only" htmlFor={`ai-rename-${meta.id}`}>
                    {t("Conversation title", "Conversation title")}
                  </Label>
                  <div className="flex min-w-0 items-center gap-1">
                    <Input
                      id={`ai-rename-${meta.id}`}
                      autoFocus
                      value={renaming.title}
                      disabled={renameBusy}
                      aria-label={t("Rename conversation: {{title}}", {
                        title: meta.title,
                        defaultValue: `Rename conversation: ${meta.title}`,
                      })}
                      className="h-8 min-w-0 flex-1 text-xs"
                      onChange={(event) =>
                        setRenaming({ id: meta.id, title: event.target.value })
                      }
                      onKeyDown={handleRenameKey}
                    />
                    <Button
                      type="button"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={renameBusy}
                      data-testid="ai-conversation-rename-save"
                      aria-label={t("Save the title for {{title}}", {
                        title: meta.title,
                        defaultValue: `Save the title for ${meta.title}`,
                      })}
                      onClick={commitRename}
                    >
                      <Check aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={renameBusy}
                      aria-label={t("Stop renaming {{title}}", {
                        title: meta.title,
                        defaultValue: `Stop renaming ${meta.title}`,
                      })}
                      onClick={() => {
                        setRenaming(null);
                        setRenameError(null);
                      }}
                    >
                      <X aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {renameError ? (
                    <p
                      role="alert"
                      data-testid="ai-conversation-rename-error"
                      className="text-[11px] break-words text-destructive [overflow-wrap:anywhere]"
                    >
                      {renameError}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    className="ui-focus min-w-0 flex-1 rounded-md border border-border/60 px-2 py-1.5 text-left text-xs data-[active=true]:border-primary/60 data-[active=true]:bg-primary/10"
                    data-active={meta.id === selectedId}
                    aria-pressed={meta.id === selectedId}
                    onClick={() => onSelect(meta.id)}
                  >
                    <span className="block truncate font-medium">
                      {meta.title}
                    </span>
                    <span className="block truncate text-muted-foreground">
                      {providerLabel(meta.provider)} · {meta.model} ·{" "}
                      {t("{{count}} messages", {
                        count: meta.messageCount,
                        defaultValue: `${meta.messageCount} messages`,
                      })}
                    </span>
                  </button>
                  {onRename ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      data-testid="ai-conversation-rename"
                      aria-label={t("Rename conversation: {{title}}", {
                        title: meta.title,
                        defaultValue: `Rename conversation: ${meta.title}`,
                      })}
                      onClick={() => {
                        setRenaming({ id: meta.id, title: meta.title });
                        setRenameError(null);
                      }}
                    >
                      <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label={t("Delete conversation: {{title}}", {
                      title: meta.title,
                      defaultValue: `Delete conversation: ${meta.title}`,
                    })}
                    onClick={() => onDelete(meta.id)}
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
