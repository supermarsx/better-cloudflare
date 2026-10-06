/**
 * The conversations, as a tab strip.
 *
 * This was a vertical list of rows, each carrying a title, a provider, a model,
 * a message count and two icon buttons. Browser-tab shaped instead, because
 * that is what the thing is: one conversation is open, the others are one click
 * away, and the chrome for switching should cost one row of height rather than
 * one row *per conversation* — in a 22rem dock the list was the transcript's
 * main competitor for space.
 *
 * Five decisions worth the words:
 *
 * **It is a real tablist.** `role="tablist"` with one `role="tab"` per
 * conversation, roving `tabIndex`, and arrows/Home/End to move between them.
 * The host marks the transcript as the panel these tabs control — see
 * {@link aiConversationTabId} — so a screen reader is told that switching tabs
 * is what changes the transcript, which a list of toggle buttons never said.
 *
 * **Overflow scrolls sideways, it does not wrap or hide.** The strip reuses
 * `.ui-segment-group.scrollbar-themed`, the pair the zone action tabs already
 * use: `overflow-x: auto`, `overflow-y: hidden` so a fractional row height
 * cannot grow a phantom vertical scrollbar, and `scrollbar-gutter: auto` so the
 * themed gutter does not steal inline room from the tabs. Wrapping would let
 * the strip grow to any height, which is the cost this change exists to
 * remove, and an overflow menu would hide conversations behind a second
 * interaction and need a popover primitive. Titles truncate at 9rem so one
 * long title cannot push the rest out of reach, and the active tab is scrolled
 * into view whenever it changes.
 *
 * **Close is on every tab; rename is on the active one.** Closing any tab is
 * the convention a tab strip sets, and a `×` is small enough to afford on all
 * of them. A second icon button per tab is not affordable at 22rem, and
 * renaming the conversation you are not reading is not a thing a tab strip
 * does — so the pencil belongs to the tab you are on.
 *
 * **Renaming replaces the strip.** An input wide enough to type a title into
 * does not fit beside the tabs, and putting it on a second row would spend the
 * height this component just saved. The editor takes the strip's row and gives
 * it back when the rename resolves. `Escape` is still consumed here rather
 * than allowed to bubble — see `handleRenameKey`.
 *
 * **The provider and model pickers are collapsed.** They are creation-time
 * parameters, read once per conversation, and a 9rem dropdown plus a 12rem
 * input standing permanently above the transcript is the same tax the list
 * was. `+` creates with what is already selected — the host seeds that from
 * the configured default provider and its model — and the toggle beside it
 * reveals the pair for the case where the default is not what you want.
 *
 * A conversation is created against a provider and a model, so the picker
 * shows the profile's *label* and a tab resolves ids back to labels:
 * `groq-fast` is not a name anyone chose to read. An id that no longer
 * resolves is shown as the raw id rather than hidden or guessed at — profiles
 * can be deleted while conversations created with them survive, and claiming
 * such a conversation belongs to some other provider would be a lie about
 * which endpoint saw the transcript.
 */
import { Check, Pencil, Plus, SlidersHorizontal, X } from "lucide-react";

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
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { AiProviderProfile, ConversationMeta } from "@/types/ai";

import { AI_SELECT_CONTENT_CLASS, AI_SELECT_TRIGGER_CLASS } from "./ai-select";
import { describeAiError } from "./ai-error";

/**
 * The DOM id of one conversation's tab.
 *
 * Exported because the tab and the panel it controls live in different
 * components: this strip owns the tabs, the host owns the transcript region,
 * and `aria-labelledby` has to name the active tab from over there. One
 * formula in one place rather than the same template string in two files.
 */
export function aiConversationTabId(
  idPrefix: string,
  conversationId: string,
): string {
  return `${idPrefix}-tab-${conversationId}`;
}

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
   * was created with. That is what makes a set of several of them unnavigable,
   * and it is the reason this exists.
   *
   * Rejects on refusal so the editor can show the backend's own message — a
   * title is bounded in UTF-8 bytes (`maxTitleBytes`), so a short-looking
   * title can still be too long.
   */
  onRename?: (id: string, title: string) => Promise<void>;
  /** Scopes the tab ids, so two mounted instances cannot collide. */
  idPrefix: string;
  /** The id of the region these tabs control — the host's transcript. */
  panelId: string;
  /**
   * Stack the revealed provider/model row instead of pairing it, for the 22rem
   * dock and the 26rem bubble.
   *
   * The pair is a 9rem select and a 12rem input: about 21rem before the
   * buttons, which `flex-wrap` rescues from overflowing but leaves cramped and
   * ragged on both framed surfaces. Keyed off the surface rather than a `sm:`
   * breakpoint because a docked panel can be 22rem wide on a 2560px display.
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
  idPrefix,
  panelId,
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
  /** Closed by default: see the file comment on why these are not standing. */
  const [pickersOpen, setPickersOpen] = useState(false);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  // A strip that scrolls sideways can hold the active conversation off its own
  // edge after a create or a switch, which looks exactly like having lost it.
  useEffect(() => {
    if (selectedId === null) return;
    tabRefs.current.get(selectedId)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [conversations.length, selectedId]);

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
      // Stopped here so the key does not also dismiss the bubble the editor is
      // rendered inside: cancelling an edit is not dismissing the assistant.
      event.preventDefault();
      event.stopPropagation();
      setRenaming(null);
      setRenameError(null);
    }
  };

  /**
   * Move along the strip.
   *
   * Selection follows focus, which is the right pattern here: switching tabs
   * costs one conversation read and shows the thing the user is looking for,
   * so making them confirm with Enter would just add a keystroke. Wraps at
   * both ends, like every other tablist in this app.
   */
  const handleTabKey = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const last = conversations.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    const target = conversations[next];
    if (!target) return;
    event.preventDefault();
    onSelect(target.id);
    tabRefs.current.get(target.id)?.focus();
  };

  const canCreate =
    !creating && provider !== null && model.trim().length > 0 && !loading;

  /** The profile's label, or the bare id when it no longer resolves. */
  const providerLabel = (id: string): string =>
    configuredProviders.find((entry) => entry.id === id)?.label ?? id;

  /** What a tab's hover text says, since the strip only has room for a title. */
  const tabDetail = (meta: ConversationMeta): string =>
    `${providerLabel(meta.provider)} · ${meta.model} · ${t(
      "{{count}} messages",
      {
        count: meta.messageCount,
        defaultValue: `${meta.messageCount} messages`,
      },
    )}`;

  const activeMeta =
    conversations.find((entry) => entry.id === selectedId) ?? null;

  return (
    <div className="min-w-0 space-y-2" data-testid="ai-conversations">
      {renaming === null ? (
        <div className="flex min-w-0 items-center gap-1">
          {conversations.length === 0 ? (
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {loading
                ? t("Loading…", "Loading…")
                : t("No conversations yet.", "No conversations yet.")}
            </p>
          ) : (
            <div
              role="tablist"
              aria-label={t("Conversations", "Conversations")}
              aria-orientation="horizontal"
              data-testid="ai-conversation-tabs"
              className="glass-surface glass-sheen glass-fade ui-segment-group scrollbar-themed min-w-0 flex-1"
            >
              {conversations.map((meta, index) => {
                const active = meta.id === selectedId;
                return (
                  // Presentational on purpose: the tablist's owned elements
                  // have to be the tabs themselves, and a wrapper with no role
                  // and no ARIA of its own hands its children straight up to
                  // it. It carries the pill styling so the close control sits
                  // inside the tab rather than beside it.
                  <div
                    key={meta.id}
                    role="presentation"
                    className="ui-segment flex items-center gap-1 px-1.5"
                    data-testid="ai-conversation-tab"
                    data-conversation-id={meta.id}
                    data-active={active}
                  >
                    <button
                      ref={(node) => {
                        if (node) tabRefs.current.set(meta.id, node);
                        else tabRefs.current.delete(meta.id);
                      }}
                      id={aiConversationTabId(idPrefix, meta.id)}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-controls={panelId}
                      // Roving: one tab stop for the whole strip, with the
                      // arrows moving inside it.
                      tabIndex={active ? 0 : -1}
                      title={`${meta.title} — ${tabDetail(meta)}`}
                      className="ui-focus max-w-[9rem] truncate rounded"
                      onClick={() => onSelect(meta.id)}
                      onKeyDown={(event) => handleTabKey(event, index)}
                    >
                      {meta.title}
                    </button>
                    <button
                      type="button"
                      tabIndex={active ? 0 : -1}
                      aria-label={t("Delete conversation: {{title}}", {
                        title: meta.title,
                        defaultValue: `Delete conversation: ${meta.title}`,
                      })}
                      className="ui-focus shrink-0 rounded text-muted-foreground hover:text-foreground"
                      onClick={() => onDelete(meta.id)}
                    >
                      <X aria-hidden="true" className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {activeMeta && onRename ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              data-testid="ai-conversation-rename"
              aria-label={t("Rename conversation: {{title}}", {
                title: activeMeta.title,
                defaultValue: `Rename conversation: ${activeMeta.title}`,
              })}
              onClick={() => {
                setRenaming({ id: activeMeta.id, title: activeMeta.title });
                setRenameError(null);
              }}
            >
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          ) : null}

          {configuredProviders.length > 0 ? (
            <>
              <Button
                type="button"
                size="icon"
                className="h-8 w-8 shrink-0"
                disabled={!canCreate}
                aria-label={t("New conversation", "New conversation")}
                title={t(
                  "New conversation with the selected provider and model",
                  "New conversation with the selected provider and model",
                )}
                onClick={onCreate}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                data-testid="ai-conversation-pickers-toggle"
                aria-expanded={pickersOpen}
                aria-label={t(
                  "Choose provider and model",
                  "Choose provider and model",
                )}
                onClick={() => setPickersOpen((open) => !open)}
              >
                <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : null}
        </div>
      ) : (
        <div
          className="min-w-0 space-y-1"
          data-testid="ai-conversation-rename-editor"
        >
          <div className="flex min-w-0 items-center gap-1">
            <Label className="sr-only" htmlFor={`ai-rename-${renaming.id}`}>
              {t("Conversation title", "Conversation title")}
            </Label>
            <Input
              id={`ai-rename-${renaming.id}`}
              autoFocus
              value={renaming.title}
              disabled={renameBusy}
              aria-label={t("Rename conversation: {{title}}", {
                title:
                  conversations.find((entry) => entry.id === renaming.id)
                    ?.title ?? renaming.title,
                defaultValue: `Rename conversation: ${
                  conversations.find((entry) => entry.id === renaming.id)
                    ?.title ?? renaming.title
                }`,
              })}
              className="h-8 min-w-0 flex-1 text-xs"
              onChange={(event) =>
                setRenaming({ id: renaming.id, title: event.target.value })
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
                title:
                  conversations.find((entry) => entry.id === renaming.id)
                    ?.title ?? renaming.title,
                defaultValue: `Save the title for ${
                  conversations.find((entry) => entry.id === renaming.id)
                    ?.title ?? renaming.title
                }`,
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
                title:
                  conversations.find((entry) => entry.id === renaming.id)
                    ?.title ?? renaming.title,
                defaultValue: `Stop renaming ${
                  conversations.find((entry) => entry.id === renaming.id)
                    ?.title ?? renaming.title
                }`,
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
      )}

      {configuredProviders.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
          {t(
            "Configure a provider in Settings to start a conversation.",
            "Configure a provider in Settings to start a conversation.",
          )}
        </p>
      ) : null}

      {pickersOpen && renaming === null && configuredProviders.length > 0 ? (
        <div
          data-testid="ai-conversation-pickers"
          className={cn(
            "min-w-0 gap-2",
            compact ? "grid grid-cols-1 items-end" : "flex flex-wrap items-end",
          )}
        >
          <div className={cn("space-y-1", compact && "min-w-0")}>
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
        </div>
      ) : null}
    </div>
  );
}
