/**
 * The conversation transcript: persisted messages, then the provisional
 * streaming bubble, then — defensively — a tool-approval card.
 *
 * The approval card is deliberately read-only. Tool dispatch is denied at a
 * crate boundary in this build, so approving a call would ask the user to
 * authorise a change that then fails with an opaque message. The only action
 * offered is to stop the run. There is no Approve button, and adding one is a
 * security decision, not a UI one.
 */
import { AlertTriangle, OctagonX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import type { AiToolApproval } from "@/hooks/ai/use-ai-chat";
import type {
  ChatMessage,
  Conversation,
  MessageStatus,
  Role,
  ToolCall,
} from "@/types/ai";

export interface AiTranscriptProps {
  conversation: Conversation | null;
  streaming: boolean;
  streamText: string;
  /** A run ended early (error, cancel, or stall) while text was on screen. */
  incomplete: boolean;
  pendingApproval: AiToolApproval | null;
  onStopRun: () => void;
  /** Suppresses the streaming caret animation. */
  reducedMotion: boolean;
}

/** `MessageStatus` is a union of string literals and one object variant. */
function statusError(status: MessageStatus): string | null {
  if (typeof status === "object" && status !== null && "error" in status) {
    return status.error.message;
  }
  return null;
}

/** English label for a role; the caller passes it through `t` as its own key. */
function roleLabel(role: Role): string {
  switch (role) {
    case "user":
      return "You";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "tool":
      return "Tool";
  }
}

/**
 * Arguments are always shown in full. A summary of a mutation is exactly the
 * thing a reader cannot verify, so there is no summarised form anywhere here.
 */
function formatArguments(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function ToolCallBlock({ call }: { call: ToolCall }) {
  const { t } = useI18n();
  return (
    <div className="space-y-1 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
      <p className="text-xs font-medium">
        {t("Tool call", "Tool call")}: {call.name}
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {formatArguments(call.arguments)}
      </pre>
    </div>
  );
}

function MessageBody({ entry }: { entry: ChatMessage }) {
  const { t } = useI18n();
  const content = entry.message.content;

  if (content.type === "text") {
    return (
      <p className="whitespace-pre-wrap break-words text-sm">{content.text}</p>
    );
  }

  if (content.type === "toolUse") {
    return (
      <div className="space-y-2">
        {content.toolCalls.map((call) => (
          <ToolCallBlock key={call.id} call={call} />
        ))}
      </div>
    );
  }

  // A tool result that failed is a chip, not a crash — in this build every
  // tool result is a failure, because dispatch is denied.
  return content.isError ? (
    <p
      className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
      data-testid="ai-tool-result-error"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5" />
      <span className="whitespace-pre-wrap break-words">
        {t("Tool failed", "Tool failed")}: {content.content}
      </span>
    </p>
  ) : (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-xs">
      {content.content}
    </pre>
  );
}

export function AiTranscript({
  conversation,
  streaming,
  streamText,
  incomplete,
  pendingApproval,
  onStopRun,
  reducedMotion,
}: AiTranscriptProps) {
  const { t } = useI18n();
  const messages = conversation?.messages ?? [];
  const hasStream = streamText.length > 0;
  const isEmpty = messages.length === 0 && !hasStream && !streaming;

  return (
    <div data-testid="ai-transcript" className="space-y-3">
      {isEmpty ? (
        <p
          data-testid="ai-empty"
          className="rounded-md border border-dashed border-border/60 px-4 py-8 text-center text-sm text-muted-foreground"
        >
          {conversation
            ? t(
                "No messages yet. Ask the assistant a question to get started.",
                "No messages yet. Ask the assistant a question to get started.",
              )
            : t(
                "Select a conversation, or start a new one.",
                "Select a conversation, or start a new one.",
              )}
        </p>
      ) : (
        <ol role="list" className="space-y-3">
          {messages.map((entry) => {
            const failure = statusError(entry.status);
            const label = roleLabel(entry.message.role);
            return (
              <li
                key={entry.id}
                className="space-y-1 rounded-md border border-border/60 bg-card/40 px-3 py-2"
                data-role={entry.message.role}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(label, label)}
                </p>
                <MessageBody entry={entry} />
                {failure ? (
                  <p className="text-xs text-destructive">{failure}</p>
                ) : null}
                {entry.status === "cancelled" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("Cancelled", "Cancelled")}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {hasStream || streaming ? (
        <div
          data-testid="ai-stream"
          role="status"
          aria-live="polite"
          className="space-y-1 rounded-md border border-border/60 bg-card/40 px-3 py-2"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("Assistant", "Assistant")}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">
            {streamText}
            {streaming ? (
              <span
                aria-hidden="true"
                className={
                  reducedMotion
                    ? "ml-0.5 inline-block"
                    : "ml-0.5 inline-block animate-pulse"
                }
              >
                ▍
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {streaming
              ? t("Responding…", "Responding…")
              : incomplete
                ? t(
                    "This response is incomplete — the run ended early.",
                    "This response is incomplete — the run ended early.",
                  )
                : null}
          </p>
        </div>
      ) : null}

      {pendingApproval ? (
        <div
          data-testid="ai-approval"
          role="alert"
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p className="font-semibold">
            {t("Tool approval requested", "Tool approval requested")}:{" "}
            {pendingApproval.toolName}
          </p>
          <p>{pendingApproval.reason}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-background/40 px-2 py-1.5">
            {formatArguments(pendingApproval.arguments)}
          </pre>
          <p>
            {t(
              "This build cannot run tools, so this call cannot be approved. Stop the run to clear it.",
              "This build cannot run tools, so this call cannot be approved. Stop the run to clear it.",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={onStopRun}
          >
            <OctagonX aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Stop this run", "Stop this run")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
