/**
 * Who answers the next message: the persona, the provider profile and the
 * model, changeable from inside the conversation.
 *
 * **Why it is here and not in settings.** The persona was a single global
 * setting, so "talk to me as a security auditor for this one thread" meant
 * changing it for every thread, and the provider and model could not be
 * changed at all once a conversation existed. Both choices are about the
 * message being typed, so they belong beside it — the same argument that put
 * {@link AiModeSelect} in this dock.
 *
 * **Why it is collapsed, and when it is not.** The dock was recently trimmed
 * because it had grown to about eight lines of standing text above the input,
 * which in a 22rem sidebar is height the transcript needs more. So this
 * spends *one* line: a summary of what is in force, which doubles as the
 * disclosure. It starts open only while the conversation has no messages —
 * which is exactly "pick a persona on the first message", the moment the
 * choice is being made and the moment there is no transcript to crowd — and
 * closes itself as soon as there is a transcript, unless the user opened it
 * deliberately. Opening it costs one row in the workspace tab and three
 * stacked rows in the two framed chromes, and only for as long as it is open.
 * There is no separate "Done" control for the same reason: the summary line
 * closes the editor, and a second affordance doing that would spend a fourth
 * stacked row in exactly the chrome where rows are expensive.
 *
 * **Why the summary line stays visible while the editor is open.** It is the
 * *committed* state, and the controls below are the in-progress one. That
 * distinction is load-bearing for the model field, which is free text: the
 * summary is how you see that what you typed was actually stored.
 *
 * **Three controls, not one.** The permission mode, the persona and the
 * provider decide different things — what the assistant may do, how it
 * speaks, and which endpoint answers — and a single dropdown mixing them
 * would make every one of them harder to reason about. The mode stays its own
 * control, directly above the input it governs.
 *
 * **Nothing here writes global configuration.** A conversation that has never
 * chosen a persona is left alone rather than written to on open: absent means
 * "use the configured persona", which is what every conversation did before
 * this control existed, and the summary line says which persona that is so
 * the inherited choice is visible rather than merely implied.
 *
 * An id that no longer resolves is named, never hidden and never swapped for
 * another profile's label — see `@/lib/ai/origin`. Such an entry is rendered
 * and disabled: the value has to exist for the dropdown to show it, and the
 * backend refuses to re-select something that is gone.
 */
import { useEffect, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

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
import { aiPersonaLabel, aiProviderLabel } from "@/lib/ai/origin";
import { cn } from "@/lib/utils";
import type { AiPersona, AiProviderProfile, Conversation } from "@/types/ai";

import { AI_SELECT_CONTENT_CLASS, AI_SELECT_TRIGGER_CLASS } from "./ai-select";

/**
 * The dropdown value standing for "use the configured persona".
 *
 * A Radix `SelectItem` cannot carry an empty value, so absence needs a
 * sentinel — and this one cannot collide with a real persona id by
 * construction, not by luck: the backend's shared id rule
 * (`bc_ai_chat::limits::is_well_formed_persona_id`) permits only ASCII
 * alphanumerics, `-` and `_`, so no persona can ever be called `~configured`.
 */
export const AI_CONFIGURED_PERSONA_VALUE = "~configured";

export interface AiTurnSetupProps {
  /**
   * The conversation being governed. Renders nothing until it is read: a
   * control defaulted to the global persona would be a claim about what the
   * next turn will do, which is the mistake {@link AiModeSelect} is careful
   * to avoid for the mode.
   */
  conversation: Conversation | null;
  /** Provider profiles that are configured right now. */
  configuredProviders: readonly AiProviderProfile[];
  /** Every persona, builtin and custom. */
  personas: readonly AiPersona[];
  /**
   * The persona a conversation with no choice of its own runs under, from
   * `AgentConfig.personaId`. `null` while the config has not been read.
   */
  configuredPersonaId: string | null;
  /**
   * A turn is streaming.
   *
   * The controls are disabled rather than queueing the change. The backend
   * refuses a mid-turn switch outright — the running turn has already resolved
   * what it runs under — so a queued choice would show a value that is not in
   * force, and the way through is the one the conversation already offers:
   * wait, or stop the run.
   */
  streaming: boolean;
  /** A switch is in flight. */
  saving: boolean;
  /** `null` means "use the configured persona". */
  onPersonaChange: (personaId: string | null) => void;
  /**
   * Provider and model together, because a model name only means anything to
   * the endpoint that serves it.
   */
  onProviderChange: (provider: string, model: string) => void;
  /** A DOM id prefix, so several mounted instances cannot collide. */
  idPrefix: string;
  /**
   * Stack the editor instead of pairing it, for the 22rem dock and the 26rem
   * bubble. Keyed off the surface rather than a `sm:` breakpoint because a
   * docked panel can be 22rem wide on a 2560px display.
   */
  compact?: boolean;
}

export function AiTurnSetup({
  conversation,
  configuredProviders,
  personas,
  configuredPersonaId,
  streaming,
  saving,
  onPersonaChange,
  onProviderChange,
  idPrefix,
  compact = false,
}: AiTurnSetupProps) {
  const { t } = useI18n();
  /**
   * `null` until the user decides, so the default can depend on whether the
   * conversation has a transcript yet — see the file comment. Reset per
   * conversation: a deliberate choice about one thread is not a choice about
   * the next.
   */
  const [explicitOpen, setExplicitOpen] = useState<boolean | null>(null);
  const [modelDraft, setModelDraft] = useState("");

  const conversationId = conversation?.id ?? null;
  const committedModel = conversation?.model ?? "";

  useEffect(() => {
    setExplicitOpen(null);
  }, [conversationId]);

  // Follows the committed value, so a switch made anywhere else — or one this
  // control made and the backend normalized — is what the field shows.
  useEffect(() => {
    setModelDraft(committedModel);
  }, [conversationId, committedModel]);

  if (conversation === null) return null;

  const open = explicitOpen ?? conversation.messages.length === 0;
  const disabled = streaming || saving;

  const storedPersonaId = conversation.personaId ?? null;
  const personaMissing =
    storedPersonaId !== null &&
    !personas.some((entry) => entry.id === storedPersonaId);
  const providerMissing = !configuredProviders.some(
    (entry) => entry.id === conversation.provider,
  );
  /**
   * A conversation carrying its own system prompt ignores personas outright —
   * that prompt is the literal replacement channel and outranks them, a
   * precedence that predates per-conversation personas. Offering the choice
   * anyway would imply it decided something.
   */
  const personaOverridden = (conversation.systemPrompt ?? "").length > 0;

  /** What the summary line says the persona is. */
  const personaSummary = personaOverridden
    ? t("Own system prompt", "Own system prompt")
    : storedPersonaId === null
      ? configuredPersonaId === null
        ? t("Configured persona", "Configured persona")
        : t("{{name}} (configured)", {
            name: aiPersonaLabel(configuredPersonaId, personas),
            defaultValue: `${aiPersonaLabel(configuredPersonaId, personas)} (configured)`,
          })
      : personaMissing
        ? t("Missing persona", "Missing persona")
        : aiPersonaLabel(storedPersonaId, personas);

  const providerSummary = providerMissing
    ? t("Missing provider", "Missing provider")
    : aiProviderLabel(conversation.provider, configuredProviders);

  const setupId = `${idPrefix}-turn-setup`;
  const personaId = `${setupId}-persona`;
  const providerId = `${setupId}-provider`;
  const modelId = `${setupId}-model`;
  const noticeId = `${setupId}-notice`;

  const commitModel = () => {
    const model = modelDraft.trim();
    if (disabled || providerMissing) return;
    if (model.length === 0 || model === committedModel) {
      setModelDraft(committedModel);
      return;
    }
    onProviderChange(conversation.provider, model);
  };

  const handleModelKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitModel();
      return;
    }
    if (event.key === "Escape") {
      // Stopped here so the key does not also dismiss the bubble this is
      // rendered inside: abandoning an edit is not dismissing the assistant.
      event.preventDefault();
      event.stopPropagation();
      setModelDraft(committedModel);
    }
  };

  /**
   * What the next turn will do about a choice that cannot be honoured.
   *
   * Reported before the send rather than only afterwards in the transcript:
   * the fix — pick something that exists — is one control away, and a user who
   * only finds out from the reply's attribution has already spent a turn.
   */
  const notices: string[] = [];
  if (personaMissing && !personaOverridden) {
    notices.push(
      t(
        "The persona this conversation used no longer exists, so the next reply will use the configured one.",
        "The persona this conversation used no longer exists, so the next reply will use the configured one.",
      ),
    );
  }
  if (providerMissing) {
    notices.push(
      t(
        "The provider this conversation used is no longer configured. Choose one below before sending.",
        "The provider this conversation used is no longer configured. Choose one below before sending.",
      ),
    );
  }
  if (personaOverridden) {
    notices.push(
      t(
        "This conversation has its own system prompt, which replaces any persona.",
        "This conversation has its own system prompt, which replaces any persona.",
      ),
    );
  }

  return (
    <section
      className="min-w-0 space-y-1"
      data-testid="ai-turn-setup"
      data-open={open}
      data-persona-missing={personaMissing}
      data-provider-missing={providerMissing}
    >
      {/* The committed state, and the disclosure. One line, whatever the
          chrome: a summary rather than three standing controls is the whole
          reason this fits in a 22rem dock. */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? `${setupId}-editor` : undefined}
        aria-describedby={notices.length > 0 ? noticeId : undefined}
        data-testid="ai-turn-setup-toggle"
        title={t("Choose the persona, provider and model", {
          defaultValue: "Choose the persona, provider and model",
        })}
        className="ui-focus flex w-full min-w-0 items-center gap-1 rounded text-left text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setExplicitOpen(!open)}
      >
        <span className="min-w-0 flex-1 truncate">
          {t("{{persona}} · {{provider}} · {{model}}", {
            persona: personaSummary,
            provider: providerSummary,
            model: conversation.model,
            defaultValue: `${personaSummary} · ${providerSummary} · ${conversation.model}`,
          })}
        </span>
        {open ? (
          <ChevronUp aria-hidden="true" className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0" />
        )}
      </button>

      {notices.length > 0 ? (
        <div
          id={noticeId}
          role="status"
          data-testid="ai-turn-setup-notice"
          className="space-y-1 text-[11px] break-words text-muted-foreground [overflow-wrap:anywhere]"
        >
          {notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      ) : null}

      {open ? (
        <div
          id={`${setupId}-editor`}
          data-testid="ai-turn-setup-editor"
          className={cn(
            "min-w-0 gap-2",
            compact ? "grid grid-cols-1" : "flex flex-wrap items-end",
          )}
        >
          <div className={cn("space-y-1", compact && "min-w-0")}>
            <Label className="sr-only" htmlFor={personaId}>
              {t("Persona", "Persona")}
            </Label>
            <Select
              value={storedPersonaId ?? AI_CONFIGURED_PERSONA_VALUE}
              disabled={disabled || personaOverridden}
              onValueChange={(value) => {
                const next =
                  value === AI_CONFIGURED_PERSONA_VALUE ? null : value;
                if (next === storedPersonaId) return;
                onPersonaChange(next);
              }}
            >
              <SelectTrigger
                id={personaId}
                aria-label={t("How the assistant speaks", {
                  defaultValue: "How the assistant speaks",
                })}
                className={cn(
                  AI_SELECT_TRIGGER_CLASS,
                  compact ? "w-full" : "w-40",
                )}
              >
                <SelectValue />
              </SelectTrigger>
              {/* Raised for the same reason every other dropdown in the
                  assistant is: this one renders inside the floating bubble
                  too, and the shared `z-50` default loses to the bubble's
                  `z-[60]`. */}
              <SelectContent className={AI_SELECT_CONTENT_CLASS}>
                <SelectItem
                  value={AI_CONFIGURED_PERSONA_VALUE}
                  data-value={AI_CONFIGURED_PERSONA_VALUE}
                >
                  {configuredPersonaId === null
                    ? t("Configured persona", "Configured persona")
                    : t("{{name}} (configured)", {
                        name: aiPersonaLabel(configuredPersonaId, personas),
                        defaultValue: `${aiPersonaLabel(configuredPersonaId, personas)} (configured)`,
                      })}
                </SelectItem>
                {personas.map((persona) => (
                  <SelectItem
                    key={persona.id}
                    value={persona.id}
                    data-value={persona.id}
                    title={persona.description}
                  >
                    {persona.name}
                  </SelectItem>
                ))}
                {/* The stored value has to exist as an option or the trigger
                    paints nothing, and it is disabled because the backend
                    refuses to re-select a persona that is gone. */}
                {personaMissing && storedPersonaId !== null ? (
                  <SelectItem
                    value={storedPersonaId}
                    data-value={storedPersonaId}
                    data-missing="true"
                    disabled
                  >
                    {t("Missing persona ({{id}})", {
                      id: storedPersonaId,
                      defaultValue: `Missing persona (${storedPersonaId})`,
                    })}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>

          <div className={cn("space-y-1", compact && "min-w-0")}>
            <Label className="sr-only" htmlFor={providerId}>
              {t("Provider", "Provider")}
            </Label>
            <Select
              value={conversation.provider}
              disabled={disabled || configuredProviders.length === 0}
              onValueChange={(value) => {
                if (value === conversation.provider) return;
                // The chosen profile's own model, because that is the one
                // model this endpoint is known to serve: carrying the old
                // provider's model across would hand the new connection a
                // name chosen for the old one. Refining it is the next,
                // optional step in the field beside this.
                const model =
                  configuredProviders.find((entry) => entry.id === value)
                    ?.model ?? conversation.model;
                onProviderChange(value, model);
              }}
            >
              <SelectTrigger
                id={providerId}
                // Named for the conversation, not just "Provider": the tab
                // strip has its own provider picker for *creating* a
                // conversation, and two controls with the same accessible
                // name on one screen is a question nobody can answer.
                aria-label={t("Provider for this conversation", {
                  defaultValue: "Provider for this conversation",
                })}
                className={cn(
                  AI_SELECT_TRIGGER_CLASS,
                  compact ? "w-full" : "w-36",
                )}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={AI_SELECT_CONTENT_CLASS}>
                {configuredProviders.map((profile) => (
                  <SelectItem
                    key={profile.id}
                    value={profile.id}
                    data-value={profile.id}
                  >
                    {profile.label}
                  </SelectItem>
                ))}
                {providerMissing ? (
                  <SelectItem
                    value={conversation.provider}
                    data-value={conversation.provider}
                    data-missing="true"
                    disabled
                  >
                    {t("Missing provider ({{id}})", {
                      id: conversation.provider,
                      defaultValue: `Missing provider (${conversation.provider})`,
                    })}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>

          <div className={cn("space-y-1", compact && "min-w-0")}>
            <Label className="sr-only" htmlFor={modelId}>
              {t("Model", "Model")}
            </Label>
            <Input
              id={modelId}
              value={modelDraft}
              // A model that the selected provider cannot serve is a send
              // that fails, and a provider that is not configured cannot
              // serve anything — so the provider is fixed first.
              disabled={disabled || providerMissing}
              aria-label={t("Model for this conversation", {
                defaultValue: "Model for this conversation",
              })}
              aria-describedby={`${modelId}-hint`}
              placeholder={t("Model", "Model")}
              // Free text, committed on Enter or on leaving the field, which
              // is why the summary line above shows the stored value: a pair
              // of save/cancel buttons would cost more inline width than a
              // 22rem dock has, and the editor can simply be collapsed.
              title={t(
                "Press Enter to use this model.",
                "Press Enter to use this model.",
              )}
              className={cn("h-8 text-xs", compact ? "w-full" : "w-44")}
              onChange={(event) => setModelDraft(event.target.value)}
              onBlur={commitModel}
              onKeyDown={handleModelKey}
            />
          </div>

          {/* Not visible, not absent: the dock spends no height on the
              sentence, and a screen reader is still told the rule the Enter
              key follows. There is deliberately no "Done" button beside it —
              the summary line above closes the editor, and a second control
              doing the same thing would cost a fourth stacked row in exactly
              the chrome where rows are expensive. */}
          <p className="sr-only" id={`${modelId}-hint`}>
            {t(
              "Press Enter to use this model.",
              "Press Enter to use this model.",
            )}
          </p>
        </div>
      ) : null}
    </section>
  );
}
