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
import { Plus, Trash2 } from "lucide-react";

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
import type { AiProviderProfile, ConversationMeta } from "@/types/ai";

import { AI_SELECT_CONTENT_CLASS, AI_SELECT_TRIGGER_CLASS } from "./ai-select";

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
}: AiConversationListProps) {
  const { t } = useI18n();
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
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
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
                className={cn(AI_SELECT_TRIGGER_CLASS, "w-36")}
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
          <div className="space-y-1">
            <Label className="sr-only" htmlFor="ai-new-model">
              {t("Model", "Model")}
            </Label>
            <Input
              id="ai-new-model"
              value={model}
              aria-label={t("Model", "Model")}
              placeholder={t("Model", "Model")}
              className="h-8 w-48 text-xs"
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
            <li key={meta.id} className="flex items-center gap-1">
              <button
                type="button"
                className="ui-focus min-w-0 flex-1 rounded-md border border-border/60 px-2 py-1.5 text-left text-xs data-[active=true]:border-primary/60 data-[active=true]:bg-primary/10"
                data-active={meta.id === selectedId}
                aria-pressed={meta.id === selectedId}
                onClick={() => onSelect(meta.id)}
              >
                <span className="block truncate font-medium">{meta.title}</span>
                <span className="block truncate text-muted-foreground">
                  {providerLabel(meta.provider)} · {meta.model} ·{" "}
                  {t("{{count}} messages", {
                    count: meta.messageCount,
                    defaultValue: `${meta.messageCount} messages`,
                  })}
                </span>
              </button>
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
