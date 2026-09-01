/**
 * The message composer. While a turn is streaming the send button becomes a
 * stop button, so there is exactly one primary action at any moment and the
 * user is never left without a way out of a running turn.
 */
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Send, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/hooks/use-i18n";

export interface AiComposerProps {
  /** Locked because there is no conversation, or the tool preflight is unresolved. */
  disabled: boolean;
  /** Shown in place of the hint when `disabled`. */
  disabledReason?: string | null;
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function AiComposer({
  disabled,
  disabledReason = null,
  streaming,
  onSend,
  onStop,
}: AiComposerProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");

  const canSend = !disabled && !streaming && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  // Enter sends, Shift+Enter inserts a newline — the convention for a chat
  // composer. Everything Enter can do is also reachable from the send button.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  return (
    <form
      data-testid="ai-composer"
      className="space-y-2"
      onSubmit={handleSubmit}
    >
      <Label className="sr-only" htmlFor="ai-composer-input">
        {t("Message", "Message")}
      </Label>
      <div className="flex items-end gap-2">
        <Textarea
          id="ai-composer-input"
          rows={3}
          value={text}
          disabled={disabled || streaming}
          placeholder={t("Ask the assistant…", "Ask the assistant…")}
          className="min-h-[3rem] flex-1 text-sm"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {streaming ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("Stop generating", "Stop generating")}
            onClick={onStop}
          >
            <Square aria-hidden="true" className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={!canSend}
            aria-label={t("Send message", "Send message")}
          >
            <Send aria-hidden="true" className="h-4 w-4" />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {disabled && disabledReason
          ? disabledReason
          : t(
              "Press Enter to send, Shift+Enter for a new line.",
              "Press Enter to send, Shift+Enter for a new line.",
            )}
      </p>
    </form>
  );
}
