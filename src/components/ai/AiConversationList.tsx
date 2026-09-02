/**
 * Conversation picker plus the new-conversation row.
 *
 * A conversation is created against a provider and a model, so the row carries
 * both. The model defaults to whatever was last configured for that provider in
 * this session — provider config is RAM-only (see `AiProviderSettings`), so
 * there is nothing more durable to read it from.
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
import type { ConversationMeta, ProviderKind } from "@/types/ai";

export interface AiConversationListProps {
  conversations: ConversationMeta[];
  selectedId: string | null;
  loading: boolean;
  /** Provider kinds that have been configured this session. */
  configuredProviders: readonly ProviderKind[];
  provider: ProviderKind | null;
  model: string;
  creating: boolean;
  onProviderChange: (kind: ProviderKind) => void;
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
              onValueChange={(value) => onProviderChange(value as ProviderKind)}
            >
              <SelectTrigger
                id="ai-new-provider"
                aria-label={t("Provider", "Provider")}
                className="h-8 w-36 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {configuredProviders.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {kind}
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
                  {meta.provider} · {meta.model} ·{" "}
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
