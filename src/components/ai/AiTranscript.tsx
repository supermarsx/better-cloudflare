/**
 * The conversation transcript: persisted messages, then the provisional
 * streaming bubble, then — defensively — a tool-approval card.
 *
 * The approval card is deliberately read-only. Tool dispatch is denied at a
 * crate boundary in this build, so approving a call would ask the user to
 * authorise a change that then fails with an opaque message. The only action
 * offered is to stop the run. There is no Approve button, and adding one is a
 * security decision, not a UI one.
 *
 * **Attribution.** The conversation's persona, provider and model can change
 * mid-thread, so the transcript can no longer be read as one model's answers:
 * an answer credited to the wrong model is a correctness problem, not a
 * cosmetic one. Each message carries what produced it (`ChatMessage.origin`),
 * and this renderer shows it two ways, both of them costing nothing when
 * nothing changed:
 *
 * - A divider wherever the attribution differs from the previous attributed
 *   message. Only there — a conversation that never switched gets no extra
 *   rows at all, which is what keeps this renderer usable in a 22rem dock.
 *   See `aiOriginChanges` for why the first attributed message is not a
 *   change.
 * - Every attributed message's own role line carries the full attribution as
 *   a `title` and an `aria-label`, so hover and assistive technology reach it
 *   per message without the transcript spending a line on each. The same
 *   trade `AiModeSelect` makes for its consequence text.
 *
 * The authoritative record is the export, where `origin` is on every message
 * as data. This is the readable summary of it.
 */
import { AlertTriangle, OctagonX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import type { AiToolApproval } from "@/hooks/ai/use-ai-chat";
import {
  aiOriginChanges,
  summarizeAiOrigin,
  type AiOriginSummary,
} from "@/lib/ai/origin";
import type {
  AiPersona,
  AiProviderProfile,
  ChatMessage,
  Conversation,
  MessageOrigin,
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
  /**
   * The catalogues a recorded id is resolved against.
   *
   * Both default to empty, which is honest rather than merely convenient: an
   * id resolves to its own bare text, which is exactly what has to be shown
   * for a profile or persona that no longer exists. So a caller that has not
   * read them yet shows raw ids instead of wrong names.
   */
  configuredProviders?: readonly AiProviderProfile[];
  personas?: readonly AiPersona[];
}

/** `MessageStatus` is a union of string literals and one object variant. */
function statusError(status: MessageStatus): string | null {
  if (typeof status === "object" && status !== null && "error" in status) {
    return status.error.message;
  }
  return null;
}

/**
 * The role, translated.
 *
 * Every case passes a **literal** key, which is the only form the catalogue
 * extractor can see. This used to return the bare English word for the caller
 * to pass through `t(label, label)` — and a variable default is a string no
 * locale ever carries, so "You", "System" and "Tool" rendered in English in
 * all eleven translated locales, on every message in every transcript.
 * ("Assistant" happened to be catalogued by another call site, which is what
 * made the gap easy to miss.)
 */
function roleLabel(role: Role, t: ReturnType<typeof useI18n>["t"]): string {
  switch (role) {
    case "user":
      return t("You", "You");
    case "assistant":
      return t("Assistant", "Assistant");
    case "system":
      return t("System", "System");
    case "tool":
      return t("Tool", "Tool");
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

/**
 * One attribution, as whole sentences.
 *
 * **Every key carries every value it needs**, so the word order, the
 * separators and the punctuation all belong to the translator. This used to
 * build the line by joining translated *fragments* in JS — `"{{id}}
 * (deleted)"` spliced into a `·` list, then `" — "` and `"; "` placed around
 * `"persona {{id}} was missing"`. A translator handed a fragment cannot move
 * it relative to the text around it, and in `ar-SA` the surrounding run goes
 * right to left while those separators do not, so the result read wrongly in
 * one of the twelve locales we ship.
 *
 * The one thing still joined here is the gap *between complete sentences*,
 * which is safe for the reason it is safe in prose: each is a finished unit
 * carrying its own direction and its own terminator, so neither one's
 * translation can disturb the other.
 *
 * A bare id is still never passed off as a label — `groq-fast` is not a name
 * anyone chose to read. What changed is that the explanation is now its own
 * sentence rather than a parenthetical glued inside the list.
 */
function describeOrigin(
  summary: AiOriginSummary,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const { provider, model, persona } = summary;
  // Persona first, matching `AiTurnSetup`'s summary line: the same three
  // values in two different orders is both inconsistent to read and a
  // mistranslation trap, since the two templates would otherwise differ only
  // by the order of placeholders with identical names.
  const sentences: string[] = [
    persona === null
      ? t("No persona · {{provider}} · {{model}}.", {
          provider,
          model,
          defaultValue: `No persona · ${provider} · ${model}.`,
        })
      : t("{{persona}} · {{provider}} · {{model}}.", {
          persona,
          provider,
          model,
          defaultValue: `${persona} · ${provider} · ${model}.`,
        }),
  ];
  // Why a name in that line is an id rather than a label: the thing that
  // answered has been deleted since it did.
  if (!summary.providerResolved) {
    sentences.push(
      t("The provider profile {{provider}} no longer exists.", {
        provider,
        defaultValue: `The provider profile ${provider} no longer exists.`,
      }),
    );
  }
  if (persona !== null && !summary.personaResolved) {
    sentences.push(
      t("The persona {{persona}} no longer exists.", {
        persona,
        defaultValue: `The persona ${persona} no longer exists.`,
      }),
    );
  }
  // And what the turn asked for and could not have. Deliberately silent about
  // what ran instead: the line above already says that, and a sentence
  // claiming a replacement would be wrong in the case where the fallback was
  // gone too and nothing ran at all.
  if (summary.missingPersonaId !== null) {
    sentences.push(
      t("The persona {{requested}} was not available, so it was not used.", {
        requested: summary.missingPersonaId,
        defaultValue: `The persona ${summary.missingPersonaId} was not available, so it was not used.`,
      }),
    );
  }
  if (summary.missingProviderId !== null) {
    sentences.push(
      t(
        "The provider profile {{requested}} was not configured, so it was not used.",
        {
          requested: summary.missingProviderId,
          defaultValue: `The provider profile ${summary.missingProviderId} was not configured, so it was not used.`,
        },
      ),
    );
  }
  return sentences.join(" ");
}

/**
 * The divider's own text, as one whole template rather than a word glued onto
 * {@link describeOrigin}'s output.
 *
 * It announces what applies *from here*, so it needs its own wording and its
 * own two forms; "Switched to" prefixed onto a finished sentence in JS is the
 * same fragment problem one level up, and it would read as "Switched to
 * OpenAI · gpt-4o-mini · DNS expert." with a stray terminator. The diagnostic
 * sentences are deliberately not repeated here — they belong on the message
 * they describe, which is where a reader goes looking for them.
 */
function describeOriginSwitch(
  summary: AiOriginSummary,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const { provider, model, persona } = summary;
  return persona === null
    ? t("Switched to no persona · {{provider}} · {{model}}", {
        provider,
        model,
        defaultValue: `Switched to no persona · ${provider} · ${model}`,
      })
    : t("Switched to {{persona}} · {{provider}} · {{model}}", {
        persona,
        provider,
        model,
        defaultValue: `Switched to ${persona} · ${provider} · ${model}`,
      });
}

export function AiTranscript({
  conversation,
  streaming,
  streamText,
  incomplete,
  pendingApproval,
  onStopRun,
  reducedMotion,
  configuredProviders = [],
  personas = [],
}: AiTranscriptProps) {
  const { t } = useI18n();
  const messages = conversation?.messages ?? [];
  const hasStream = streamText.length > 0;
  const isEmpty = messages.length === 0 && !hasStream && !streaming;
  const changes = aiOriginChanges(messages);

  const summarize = (origin: MessageOrigin): AiOriginSummary =>
    summarizeAiOrigin(origin, { providers: configuredProviders, personas });

  /** The attribution for one message, or `null` when it has none. */
  const attribution = (origin: MessageOrigin | undefined): string | null =>
    origin ? describeOrigin(summarize(origin), t) : null;

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
            const label = roleLabel(entry.message.role, t);
            const detail = attribution(entry.origin);
            const change = changes.get(entry.id);
            return (
              <li
                key={entry.id}
                className="space-y-1"
                data-role={entry.message.role}
                data-switched={change === undefined ? undefined : "true"}
              >
                {/* Where the conversation changed what it was talking to.
                    Only here: nothing is rendered for a conversation whose
                    attribution never changed, so this costs no height in the
                    common case. It names what applies *from here*, because
                    that is what the messages below it ran under. */}
                {change ? (
                  <p
                    data-testid="ai-origin-switch"
                    className="flex items-center gap-2 pt-1 text-[11px] break-words text-muted-foreground [overflow-wrap:anywhere]"
                  >
                    <span
                      aria-hidden="true"
                      className="h-px flex-1 bg-border"
                    />
                    <span className="shrink-0">
                      {describeOriginSwitch(summarize(change.origin), t)}
                    </span>
                    <span
                      aria-hidden="true"
                      className="h-px flex-1 bg-border"
                    />
                  </p>
                ) : null}
                <div className="space-y-1 rounded-md border border-border/60 bg-card/40 px-3 py-2">
                  <p
                    className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    data-testid={
                      detail === null ? undefined : "ai-message-origin"
                    }
                    // Hover and the accessibility tree reach the full
                    // attribution; the transcript spends no line on it. The
                    // `aria-label` replaces the role word rather than adding
                    // to it, so a screen reader reads "Assistant · OpenAI ·
                    // gpt-4o-mini · DNS expert" as one heading.
                    title={detail ?? undefined}
                    aria-label={
                      detail === null ? undefined : `${label} · ${detail}`
                    }
                  >
                    {label}
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
                </div>
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
