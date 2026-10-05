/**
 * The agent loop's generation settings.
 *
 * Three rules this form is built around.
 *
 * **Every field says what it does.** These were five bare numeric inputs, which
 * is fine if you have read a provider's API reference and useless otherwise.
 * Each one now states the practical consequence of a high and a low value, and
 * its valid range, taken from {@link AI_AGENT_LIMITS} rather than typed in —
 * the bounds there are copied from the Rust validators, so a number on screen
 * cannot drift away from the number that will refuse the save.
 *
 * **Nothing claims to work that does not.** `topP` shipped once as a setting
 * that was stored, validated, persisted — and sent to no provider at all. The
 * advanced group could repeat that mistake six times over, because providers
 * do not take the same parameters: Anthropic has no `seed` and no penalties,
 * OpenAI has no `topK`. So a control is marked, and not operable, whenever the
 * `ai_protocol_capabilities` map does not list its parameter for the protocol
 * the default provider speaks — and when that map could not be read, nothing
 * in the advanced group is operable either, because "we could not ask" is not
 * a licence to imply "yes". The frontend holds no table of its own; see
 * `@/lib/ai/capabilities`.
 *
 * **The common controls stay uncluttered.** The eight advanced parameters live
 * behind a collapsed `<details>`, the same disclosure idiom
 * `AiPersonaSettings` uses, so a 22rem dock opens on the five settings most
 * people want and nothing else.
 *
 * Client-side checks are for immediate feedback only. The form still sends the
 * value and still shows the backend's refusal verbatim, because the validator
 * on the other side is the one that counts.
 *
 * `toolsEnabled` is deliberately absent: it is the master switch in Tools &
 * permissions, and offering a second control for it here would let two
 * surfaces disagree about the one piece of state that decides whether any tool
 * can run at all.
 */
import { useEffect, useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAiProtocolCapabilities } from "@/hooks/ai/use-ai-settings";
import { useI18n } from "@/hooks/use-i18n";
import {
  AI_ADVANCED_PARAMETERS,
  aiParameterApplicability,
  isAiParameterEditable,
  type AiGenerationParameter,
  type AiParameterApplicability,
} from "@/lib/ai/capabilities";
import {
  AI_AGENT_LIMITS,
  AI_CONFIGURABLE_LIMITS,
  AI_DEFAULT_MAX_CONTEXT_TOKENS,
  AI_PERSONA_LIMITS,
  AI_STOP_LIMITS,
  isAiByteLimit,
  validateAgentConfig,
  type AiConfigurableLimit,
  type AiValidationIssue,
} from "@/lib/ai/permissions";
import type {
  AgentConfig,
  AiProtocolCapabilities,
  ProviderProtocol,
} from "@/types/ai";

import { describeAiError } from "./ai-error";

export interface AiAgentSettingsProps {
  /** `null` until `ai_get_config` has answered. */
  config: AgentConfig | null;
  onSave: (config: AgentConfig) => Promise<void>;
  /**
   * The protocol the default provider speaks, or `null` when no provider
   * resolves — none configured, none chosen, or a default naming a profile
   * that has been deleted. `null` is not "none of them": it is "nothing to
   * check against", and the advanced group says so rather than marking every
   * parameter unsupported.
   */
  protocol: ProviderProtocol | null;
  /** That provider's label, so the marking can name it. `null` with `protocol`. */
  providerLabel: string | null;
  /** From `ai_protocol_capabilities`. `null` until it answers. */
  capabilities: AiProtocolCapabilities | null;
  capabilitiesLoading: boolean;
  capabilitiesError: unknown;
  onRetryCapabilities: () => void;
}

/**
 * The form's own state: every value a string, because an in-progress number
 * is not a number.
 *
 * The eight configurable limits are folded in as a `Record` keyed off
 * {@link AI_CONFIGURABLE_LIMITS} rather than spelled out, so a limit added to
 * that list is a type error here until it is handled — which is what lets the
 * limit fields be rendered in a loop without the loop being able to address a
 * key the draft does not have.
 */
type Draft = Record<AiConfigurableLimit, string> & {
  maxToolRounds: string;
  maxTokensPerTurn: string;
  temperature: string;
  topP: string;
  stream: boolean;
  topK: string;
  /** One stop sequence per line. */
  stop: string;
  seed: string;
  frequencyPenalty: string;
  presencePenalty: string;
  maxContextTokens: string;
  systemPromptOverride: string;
  requestTimeoutMs: string;
};

/**
 * A field that came back absent or NaN would render as "undefined"/"NaN" and
 * then be sent straight back. Falling back to the field's own minimum keeps the
 * form submittable and visibly wrong rather than invisibly wrong.
 */
function numberText(value: number, fallback: number): string {
  return String(Number.isFinite(value) ? value : fallback);
}

/**
 * An advanced parameter's text, where empty means "not set".
 *
 * Absent and `null` both arrive from the backend and mean the same thing, and
 * both have to render as an empty field — `0` is a value a user may well have
 * chosen, so it must not share a spelling with "unchosen".
 */
function optionalNumberText(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Read an optional numeric field back.
 *
 * An empty field is `null` — not set. Anything else is handed to `Number`
 * verbatim, NaN included, so that `validateAgentConfig` can report it instead
 * of this function quietly turning rubbish into "not set".
 */
function optionalNumberValue(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : Number(trimmed);
}

/**
 * Stop sequences, one per line.
 *
 * Only genuinely empty lines are dropped. A sequence may legitimately be or
 * begin with whitespace — `"\n  Assistant:"` is a real stop sequence — so
 * trimming the lines would corrupt them.
 */
function stopText(stop: readonly string[] | undefined): string {
  return (stop ?? []).join("\n");
}

function stopValue(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

function toDraft(config: AgentConfig): Draft {
  return {
    maxToolRounds: numberText(
      config.maxToolRounds,
      AI_AGENT_LIMITS.maxToolRounds.min,
    ),
    maxTokensPerTurn: numberText(
      config.maxTokensPerTurn,
      AI_AGENT_LIMITS.maxTokensPerTurn.min,
    ),
    temperature: numberText(
      config.temperature,
      AI_AGENT_LIMITS.temperature.min,
    ),
    topP: numberText(config.topP, AI_AGENT_LIMITS.topP.max),
    stream: config.stream,
    topK: optionalNumberText(config.topK),
    stop: stopText(config.stop),
    seed: optionalNumberText(config.seed),
    frequencyPenalty: optionalNumberText(config.frequencyPenalty),
    presencePenalty: optionalNumberText(config.presencePenalty),
    // Not optional: Rust types it a bare `u32` with a default, so there is no
    // empty state to render. A config from a build without the field falls
    // back to the value that build's successor would have defaulted it to.
    maxContextTokens: numberText(
      config.maxContextTokens ?? AI_DEFAULT_MAX_CONTEXT_TOKENS,
      AI_DEFAULT_MAX_CONTEXT_TOKENS,
    ),
    systemPromptOverride: config.systemPromptOverride ?? "",
    requestTimeoutMs: optionalNumberText(config.requestTimeoutMs),
    ...limitDraft(config),
  };
}

/**
 * The eight configurable limits, seeded from the config.
 *
 * An absent field falls back to the **ceiling**, which is not a guess: Rust
 * gives each one a serde default of exactly that constant, so a configuration
 * from a build predating the field behaves as though it were set to the
 * ceiling, and showing anything else would misreport what the backend will do.
 */
function limitDraft(config: AgentConfig): Record<AiConfigurableLimit, string> {
  const draft = {} as Record<AiConfigurableLimit, string>;
  for (const field of AI_CONFIGURABLE_LIMITS) {
    const ceiling = AI_AGENT_LIMITS[field].max;
    draft[field] = numberText(config[field] ?? ceiling, ceiling);
  }
  return draft;
}

/** The config a draft would store, including the parameters not shown. */
function fromDraft(config: AgentConfig, draft: Draft): AgentConfig {
  return {
    ...config,
    maxToolRounds: Number(draft.maxToolRounds),
    maxTokensPerTurn: Number(draft.maxTokensPerTurn),
    temperature: Number(draft.temperature),
    topP: Number(draft.topP),
    stream: draft.stream,
    // A parameter the current provider ignores is still sent back exactly as
    // it was read. Dropping it because today's default provider has no use for
    // it would quietly delete a setting that belongs to another provider.
    topK: optionalNumberValue(draft.topK),
    stop: stopValue(draft.stop),
    seed: optionalNumberValue(draft.seed),
    frequencyPenalty: optionalNumberValue(draft.frequencyPenalty),
    presencePenalty: optionalNumberValue(draft.presencePenalty),
    maxContextTokens: Number(draft.maxContextTokens),
    // Blank is `null`, not `""`: the backend refuses a present-but-blank
    // override outright, because an empty one would compose a pair of blank
    // lines onto every system prompt. Clearing the field clears the setting.
    systemPromptOverride:
      draft.systemPromptOverride.trim().length === 0
        ? null
        : draft.systemPromptOverride,
    requestTimeoutMs: optionalNumberValue(draft.requestTimeoutMs),
    // Never optional: Rust types each one a bare `usize` with a serde default,
    // so `null` is not a value any of them can take. An unparseable field is
    // handed to `Number` verbatim, NaN included, so the validator reports it
    // rather than this function turning rubbish into a ceiling.
    ...Object.fromEntries(
      AI_CONFIGURABLE_LIMITS.map((field) => [field, Number(draft[field])]),
    ),
  };
}

/** One labelled control with its range, its explanation, and its marking. */
interface FieldShellProps {
  /** The DOM id, which is scoped per instance and so is not a stable name. */
  id: string;
  /** The `AgentConfig` field this control writes. Stable; used for queries. */
  name: string;
  /**
   * What the capability map said about this parameter, or absent when the
   * parameter is not provider-dependent at all — `temperature` reaches every
   * protocol, so there is nothing to report about it.
   */
  applicability?: AiParameterApplicability;
  label: string;
  /** The accepted values, in words. Always from a shared constant. */
  range: string;
  /** What the setting does, and what a high or low value costs. */
  explanation: string;
  /** Why this parameter does not reach the provider in use, when it does not. */
  marking?: string | null;
  control: ReactNode;
}

function FieldShell({
  id,
  name,
  applicability,
  label,
  range,
  explanation,
  marking,
  control,
}: FieldShellProps) {
  return (
    <div
      className="min-w-0 space-y-1"
      data-testid="ai-agent-field"
      data-field={name}
      data-applicability={applicability ?? "notProviderDependent"}
    >
      <Label htmlFor={id}>{label}</Label>
      {control}
      <div
        id={`${id}-help`}
        className="space-y-1 text-xs text-muted-foreground"
      >
        <p data-testid="ai-agent-range">{range}</p>
        <p className="break-words [overflow-wrap:anywhere]">{explanation}</p>
        {marking ? (
          <p
            data-testid="ai-agent-marking"
            className="break-words text-amber-700 [overflow-wrap:anywhere] dark:text-amber-200"
          >
            {marking}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AiAgentSettings({
  config,
  onSave,
  protocol,
  providerLabel,
  capabilities,
  capabilitiesLoading,
  capabilitiesError,
  onRetryCapabilities,
}: AiAgentSettingsProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [issues, setIssues] = useState<AiValidationIssue[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  const baseId = useId();

  // Seed once the config arrives, and re-seed if it is replaced from
  // elsewhere — but never while the user is mid-edit on an unsaved draft.
  useEffect(() => {
    if (config === null) return;
    setDraft((current) => current ?? toDraft(config));
  }, [config]);

  const fieldLabels = {
    maxToolRounds: t("Tool rounds per turn", "Tool rounds per turn"),
    maxTokensPerTurn: t("Tokens per turn", "Tokens per turn"),
    temperature: t("Temperature", "Temperature"),
    topP: t("Top-p", "Top-p"),
    topK: t("Top-k", "Top-k"),
    stop: t("Stop sequences", "Stop sequences"),
    seed: t("Seed", "Seed"),
    frequencyPenalty: t("Frequency penalty", "Frequency penalty"),
    presencePenalty: t("Presence penalty", "Presence penalty"),
    maxContextTokens: t("Context token ceiling", "Context token ceiling"),
    systemPromptOverride: t("System prompt override", "System prompt override"),
    requestTimeoutMs: t("Request timeout", "Request timeout"),
    stream: t("Stream replies", "Stream replies"),
    name: t("Name", "Name"),
    description: t("Description", "Description"),
    systemPrompt: t("System prompt", "System prompt"),
    // The eight configurable limits. The byte ones say "bytes" in the label
    // itself, because "512" against a title means 512 UTF-8 bytes and a form
    // that let someone read it as characters would promise a length the
    // backend refuses.
    maxConversations: t("Conversations kept", "Conversations kept"),
    maxMessagesPerConversation: t(
      "Messages kept per conversation",
      "Messages kept per conversation",
    ),
    maxChatMessageBytes: t("Bytes per message", "Bytes per message"),
    maxConversationBytes: t("Bytes per conversation", "Bytes per conversation"),
    maxGlobalRetainedBytes: t("Bytes kept in total", "Bytes kept in total"),
    maxTitleBytes: t("Bytes per title", "Bytes per title"),
    maxPlanSteps: t("Steps per plan", "Steps per plan"),
    maxRetainedPlans: t("Plans kept", "Plans kept"),
  } as const;

  const describeIssue = (issue: AiValidationIssue): string => {
    if (issue.code === "integerRange") {
      return t(
        "{{field}} must be a whole number between {{min}} and {{max}}.",
        {
          field: fieldLabels[issue.field],
          min: issue.min,
          max: issue.max,
          defaultValue: `${fieldLabels[issue.field]} must be a whole number between ${issue.min} and ${issue.max}.`,
        },
      );
    }
    if (issue.code === "range") {
      return t("{{field}} must be between {{min}} and {{max}}.", {
        field: fieldLabels[issue.field],
        min: issue.min,
        max: issue.max,
        defaultValue: `${fieldLabels[issue.field]} must be between ${issue.min} and ${issue.max}.`,
      });
    }
    if (issue.code === "tooManySequences") {
      return t("At most {{limit}} stop sequences can be sent.", {
        limit: issue.limit,
        defaultValue: `At most ${issue.limit} stop sequences can be sent.`,
      });
    }
    if (issue.code === "sequenceTooLong") {
      return t("Each stop sequence must be at most {{limit}} bytes.", {
        limit: issue.limit,
        defaultValue: `Each stop sequence must be at most ${issue.limit} bytes.`,
      });
    }
    if (issue.code === "sequenceBlank") {
      return t(
        "A stop sequence must contain something other than spaces. Delete the blank line to remove it.",
        "A stop sequence must contain something other than spaces. Delete the blank line to remove it.",
      );
    }
    if (issue.code === "overrideBlank") {
      return t(
        "The system prompt override is blank. Clear the field to go back to the persona's own prompt.",
        "The system prompt override is blank. Clear the field to go back to the persona's own prompt.",
      );
    }
    if (issue.code === "overrideTooLong") {
      return t("{{field}} must be at most {{limit}} bytes.", {
        field: fieldLabels.systemPromptOverride,
        limit: issue.limit,
        defaultValue: `${fieldLabels.systemPromptOverride} must be at most ${issue.limit} bytes.`,
      });
    }
    if (issue.code === "controlCharacter") {
      return t(
        "{{field}} must not contain control characters other than tab, carriage return or newline.",
        {
          field: fieldLabels[issue.field],
          defaultValue: `${fieldLabels[issue.field]} must not contain control characters other than tab, carriage return or newline.`,
        },
      );
    }
    // The persona codes cannot reach this form.
    return t("That value is required.", "That value is required.");
  };

  if (config === null || draft === null) {
    return (
      <p
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground"
        data-testid="ai-agent-settings"
      >
        {t(
          "Reading the assistant's settings…",
          "Reading the assistant's settings…",
        )}
      </p>
    );
  }

  const handleSubmit = async () => {
    const next = fromDraft(config, draft);
    const found = validateAgentConfig(next);
    setIssues(found);
    setFormError(null);
    setRemediation(null);
    setSaved(false);
    if (found.length > 0) return;

    setBusy(true);
    try {
      await onSave(next);
      setSaved(true);
    } catch (error) {
      const described = describeAiError(
        error,
        t(
          "The assistant's settings could not be saved.",
          "The assistant's settings could not be saved.",
        ),
      );
      setFormError(described.message);
      setRemediation(described.remediation ?? null);
    } finally {
      setBusy(false);
    }
  };

  // ── Ranges, from the shared bounds rather than typed in ──────────────────

  const betweenText = (min: number, max: number): string =>
    t("Between {{min}} and {{max}}.", {
      min,
      max,
      defaultValue: `Between ${min} and ${max}.`,
    });

  const wholeBetweenText = (min: number, max: number): string =>
    t("A whole number between {{min}} and {{max}}.", {
      min,
      max,
      defaultValue: `A whole number between ${min} and ${max}.`,
    });

  /** "or empty" is the whole point of the advanced parameters: unset is a value. */
  const optionalWholeBetweenText = (min: number, max: number): string =>
    t(
      "A whole number between {{min}} and {{max}}, or empty to leave it to the provider.",
      {
        min,
        max,
        defaultValue: `A whole number between ${min} and ${max}, or empty to leave it to the provider.`,
      },
    );

  const optionalBetweenText = (min: number, max: number): string =>
    t(
      "A number between {{min}} and {{max}}, or empty to leave it to the provider.",
      {
        min,
        max,
        defaultValue: `A number between ${min} and ${max}, or empty to leave it to the provider.`,
      },
    );

  /**
   * A byte limit's range, which says "bytes" rather than leaving the unit to
   * be inferred from the label.
   */
  const byteWholeBetweenText = (min: number, max: number): string =>
    t("A whole number of UTF-8 bytes, between {{min}} and {{max}}.", {
      min,
      max,
      defaultValue: `A whole number of UTF-8 bytes, between ${min} and ${max}.`,
    });

  /** What each configurable limit does, and what lowering it costs. */
  const limitExplanations: Record<AiConfigurableLimit, string> = {
    maxConversations: t(
      "How many chats the assistant keeps at once. Once the number is reached the least recently used chat is dropped to make room, so a low number means older conversations disappear sooner. It is a retention limit, not a tidiness setting: a dropped conversation is gone.",
      "How many chats the assistant keeps at once. Once the number is reached the least recently used chat is dropped to make room, so a low number means older conversations disappear sooner. It is a retention limit, not a tidiness setting: a dropped conversation is gone.",
    ),
    maxMessagesPerConversation: t(
      "How many messages one chat keeps. The oldest go first, which costs the assistant the beginning of a long thread — it cannot answer about what has been dropped, however generous the context budget is. Lower this to hold down memory on a long-running chat, not to shorten what is sent.",
      "How many messages one chat keeps. The oldest go first, which costs the assistant the beginning of a long thread — it cannot answer about what has been dropped, however generous the context budget is. Lower this to hold down memory on a long-running chat, not to shorten what is sent.",
    ),
    maxChatMessageBytes: t(
      "The largest single message the app will keep. A message over this is refused outright rather than shortened, because silently truncating what you typed would be worse than saying it is too long — so a low value turns a long paste into an error, not a trimmed message.",
      "The largest single message the app will keep. A message over this is refused outright rather than shortened, because silently truncating what you typed would be worse than saying it is too long — so a low value turns a long paste into an error, not a trimmed message.",
    ),
    maxConversationBytes: t(
      "How much one whole chat may hold, counting every message in it. Reaching this drops the oldest messages exactly as the message count does, so whichever of the two is reached first is the one doing the trimming.",
      "How much one whole chat may hold, counting every message in it. Reaching this drops the oldest messages exactly as the message count does, so whichever of the two is reached first is the one doing the trimming.",
    ),
    maxGlobalRetainedBytes: t(
      "How much every chat together may hold. This is the limit that actually bounds how much memory the assistant uses, which is why it cannot be raised: once it is reached the least recently used chats are dropped whole, not trimmed.",
      "How much every chat together may hold. This is the limit that actually bounds how much memory the assistant uses, which is why it cannot be raised: once it is reached the least recently used chats are dropped whole, not trimmed.",
    ),
    maxTitleBytes: t(
      "How long a conversation title may be. Counted in UTF-8 bytes, so an emoji costs four of these and an accented letter two — a title that looks short can still be refused. A title over the limit is refused rather than cut.",
      "How long a conversation title may be. Counted in UTF-8 bytes, so an emoji costs four of these and an accented letter two — a title that looks short can still be refused. A title over the limit is refused rather than cut.",
    ),
    maxPlanSteps: t(
      "How many steps the assistant may put in one plan. A plan you cannot read in a screenful is not one you can meaningfully approve, which is what this is really for; a longer proposal is refused outright, so the assistant has to plan in smaller pieces rather than having its plan silently cut short.",
      "How many steps the assistant may put in one plan. A plan you cannot read in a screenful is not one you can meaningfully approve, which is what this is really for; a longer proposal is refused outright, so the assistant has to plan in smaller pieces rather than having its plan silently cut short.",
    ),
    maxRetainedPlans: t(
      "How many plans are kept at once. There is one plan per conversation, so this is effectively how far back a plan survives; deleting a conversation deletes its plan with it, and plans are lost when the app restarts either way.",
      "How many plans are kept at once. There is one plan per conversation, so this is effectively how far back a plan survives; deleting a conversation deletes its plan with it, and plans are lost when the app restarts either way.",
    ),
  };

  /**
   * Write one limit field.
   *
   * The cast is confined here and is sound by construction: `Draft` includes
   * `Record<AiConfigurableLimit, string>`, so the computed key is certainly
   * one of its own string fields — TypeScript simply will not narrow a
   * computed key from a union on its own.
   */
  const setLimitDraft = (field: AiConfigurableLimit, value: string) => {
    setDraft({ ...draft, [field]: value } as Draft);
  };

  // ── What reaches the provider in use ─────────────────────────────────────

  const protocolLabel = protocol ?? "";
  const applicabilityOf = (parameter: AiGenerationParameter) =>
    aiParameterApplicability(parameter, protocol, capabilities);

  /**
   * The sentence that says a parameter does not reach this provider.
   *
   * Only the `unsupported` case produces one, because it is the only one that
   * is a fact about this parameter. "We could not ask" and "no provider is
   * chosen" are statements about the whole group, and are made once above it —
   * repeated per field they would read as eight separate refusals and bury the
   * ones that are real.
   */
  const markingFor = (parameter: AiGenerationParameter): string | null => {
    if (applicabilityOf(parameter) !== "unsupported") return null;
    return providerLabel === null
      ? t("The {{protocol}} protocol ignores this, so it is not sent.", {
          protocol: protocolLabel,
          defaultValue: `The ${protocolLabel} protocol ignores this, so it is not sent.`,
        })
      : t(
          "{{provider}} ignores this: the {{protocol}} protocol has no such parameter, so it is left out of the request rather than refused. The value is kept, and applies to a provider that does use it.",
          {
            provider: providerLabel,
            protocol: protocolLabel,
            defaultValue: `${providerLabel} ignores this: the ${protocolLabel} protocol has no such parameter, so it is left out of the request rather than refused. The value is kept, and applies to a provider that does use it.`,
          },
        );
  };

  const editable = (parameter: AiGenerationParameter) =>
    !busy && isAiParameterEditable(applicabilityOf(parameter));

  /** The group-level note: what is known about the provider being checked. */
  const advancedNotice = ((): string => {
    if (capabilities === null) {
      if (capabilitiesLoading) {
        return t(
          "Checking which of these parameters reach your provider…",
          "Checking which of these parameters reach your provider…",
        );
      }
      const described = capabilitiesError
        ? describeAiError(
            capabilitiesError,
            t(
              "The assistant could not say which parameters reach your provider.",
              "The assistant could not say which parameters reach your provider.",
            ),
          ).message
        : t(
            "The assistant could not say which parameters reach your provider.",
            "The assistant could not say which parameters reach your provider.",
          );
      return t(
        "{{reason}} These controls are locked until it can: a dial that may be wired to nothing is worse than no dial.",
        {
          reason: described,
          defaultValue: `${described} These controls are locked until it can: a dial that may be wired to nothing is worse than no dial.`,
        },
      );
    }
    if (protocol === null) {
      return t(
        "No default provider is set, so there is nothing to check these against yet. They are stored, and each one is marked once a default is chosen.",
        "No default provider is set, so there is nothing to check these against yet. They are stored, and each one is marked once a default is chosen.",
      );
    }
    return t(
      "Checked against {{provider}}, the default provider, which speaks {{protocol}}. A conversation started with a different provider reaches a different set.",
      {
        provider: providerLabel ?? protocolLabel,
        protocol: protocolLabel,
        defaultValue: `Checked against ${providerLabel ?? protocolLabel}, the default provider, which speaks ${protocolLabel}. A conversation started with a different provider reaches a different set.`,
      },
    );
  })();

  const unsupportedCount = AI_ADVANCED_PARAMETERS.filter(
    (parameter) => applicabilityOf(parameter) === "unsupported",
  ).length;

  const id = (field: string) => `${baseId}-${field}`;

  return (
    <form
      className="min-w-0 space-y-3"
      data-testid="ai-agent-settings"
      data-protocol={protocol ?? ""}
      data-capabilities={capabilities === null ? "unread" : "read"}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <h3 className="text-sm font-semibold">
        {t("Response settings", "Response settings")}
      </h3>

      <div className="grid min-w-0 gap-3">
        <FieldShell
          id={id("temperature")}
          name="temperature"
          label={fieldLabels.temperature}
          range={betweenText(
            AI_AGENT_LIMITS.temperature.min,
            AI_AGENT_LIMITS.temperature.max,
          )}
          explanation={t(
            "How much the wording varies between runs. At 0 the same question gives back the same answer every time, which is what you want for record syntax you are going to paste. Above about 1 the model starts reaching for less likely words: livelier prose, and more confident-sounding DNS advice that is wrong.",
            "How much the wording varies between runs. At 0 the same question gives back the same answer every time, which is what you want for record syntax you are going to paste. Above about 1 the model starts reaching for less likely words: livelier prose, and more confident-sounding DNS advice that is wrong.",
          )}
          control={
            <Input
              id={id("temperature")}
              aria-describedby={`${id("temperature")}-help`}
              type="number"
              min={AI_AGENT_LIMITS.temperature.min}
              max={AI_AGENT_LIMITS.temperature.max}
              step={0.1}
              className="w-28"
              value={draft.temperature}
              onChange={(event) =>
                setDraft({ ...draft, temperature: event.target.value })
              }
            />
          }
        />

        <FieldShell
          id={id("topP")}
          name="topP"
          applicability={applicabilityOf("topP")}
          label={fieldLabels.topP}
          range={betweenText(
            AI_AGENT_LIMITS.topP.min,
            AI_AGENT_LIMITS.topP.max,
          )}
          explanation={t(
            "A blunter limit on the same variation. The model ranks its candidates for the next word; this throws away the unlikely tail, keeping only the candidates that make up the given share of the probability. At 0.9 the last tenth is discarded, at 1 nothing is. Move this or Temperature, not both — together it is impossible to tell which one did what.",
            "A blunter limit on the same variation. The model ranks its candidates for the next word; this throws away the unlikely tail, keeping only the candidates that make up the given share of the probability. At 0.9 the last tenth is discarded, at 1 nothing is. Move this or Temperature, not both — together it is impossible to tell which one did what.",
          )}
          marking={markingFor("topP")}
          control={
            <Input
              id={id("topP")}
              aria-describedby={`${id("topP")}-help`}
              type="number"
              min={AI_AGENT_LIMITS.topP.min}
              max={AI_AGENT_LIMITS.topP.max}
              step={0.05}
              className="w-28"
              disabled={!editable("topP")}
              value={draft.topP}
              onChange={(event) =>
                setDraft({ ...draft, topP: event.target.value })
              }
            />
          }
        />

        <FieldShell
          id={id("maxToolRounds")}
          name="maxToolRounds"
          label={fieldLabels.maxToolRounds}
          range={wholeBetweenText(
            AI_AGENT_LIMITS.maxToolRounds.min,
            AI_AGENT_LIMITS.maxToolRounds.max,
          )}
          explanation={t(
            "How many times the assistant may call a tool, read the result and decide what to do next before it has to answer. At 1 it gets a single lookup. A higher ceiling lets it chain steps — list the zone, read a record, then check the SPF record it found — and every round is another billed request. When it runs out of rounds it answers with whatever it has.",
            "How many times the assistant may call a tool, read the result and decide what to do next before it has to answer. At 1 it gets a single lookup. A higher ceiling lets it chain steps — list the zone, read a record, then check the SPF record it found — and every round is another billed request. When it runs out of rounds it answers with whatever it has.",
          )}
          control={
            <Input
              id={id("maxToolRounds")}
              aria-describedby={`${id("maxToolRounds")}-help`}
              type="number"
              min={AI_AGENT_LIMITS.maxToolRounds.min}
              max={AI_AGENT_LIMITS.maxToolRounds.max}
              step={1}
              className="w-28"
              value={draft.maxToolRounds}
              onChange={(event) =>
                setDraft({ ...draft, maxToolRounds: event.target.value })
              }
            />
          }
        />

        <FieldShell
          id={id("maxTokensPerTurn")}
          name="maxTokensPerTurn"
          label={fieldLabels.maxTokensPerTurn}
          range={wholeBetweenText(
            AI_AGENT_LIMITS.maxTokensPerTurn.min,
            AI_AGENT_LIMITS.maxTokensPerTurn.max,
          )}
          explanation={t(
            "The hard ceiling on one reply, counted in tokens — roughly three quarters of a word each. A reply that reaches the ceiling is cut off mid-sentence, so setting it too low is visible damage; setting it high costs nothing unless a reply actually grows into it, because you are billed for the tokens produced, not the ceiling.",
            "The hard ceiling on one reply, counted in tokens — roughly three quarters of a word each. A reply that reaches the ceiling is cut off mid-sentence, so setting it too low is visible damage; setting it high costs nothing unless a reply actually grows into it, because you are billed for the tokens produced, not the ceiling.",
          )}
          control={
            <Input
              id={id("maxTokensPerTurn")}
              aria-describedby={`${id("maxTokensPerTurn")}-help`}
              type="number"
              min={AI_AGENT_LIMITS.maxTokensPerTurn.min}
              max={AI_AGENT_LIMITS.maxTokensPerTurn.max}
              step={1}
              className="w-32"
              value={draft.maxTokensPerTurn}
              onChange={(event) =>
                setDraft({ ...draft, maxTokensPerTurn: event.target.value })
              }
            />
          }
        />
      </div>

      <label
        className="flex items-start gap-3"
        data-testid="ai-agent-field"
        data-field="stream"
        data-applicability="notProviderDependent"
      >
        <input
          type="checkbox"
          className="checkbox-themed mt-1 shrink-0"
          checked={draft.stream}
          onChange={(event) =>
            setDraft({ ...draft, stream: event.target.checked })
          }
        />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-xs font-medium">
            {fieldLabels.stream}
          </span>
          <span
            className="block text-xs text-muted-foreground"
            data-testid="ai-agent-range"
          >
            {t("On or off.", "On or off.")}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t(
              "Shows the reply building up word by word instead of waiting for the whole turn. Turned off, nothing appears until the turn has finished, which on a long answer is indistinguishable from the app having hung.",
              "Shows the reply building up word by word instead of waiting for the whole turn. Turned off, nothing appears until the turn has finished, which on a long answer is indistinguishable from the app having hung.",
            )}
          </span>
        </span>
      </label>

      {/* The advanced parameters, collapsed. `<details>` is the disclosure
          idiom `AiPersonaSettings` already uses, and a closed one still
          renders its contents, so nothing here is hidden from a find-in-page
          or from assistive technology that walks the document. */}
      <details className="min-w-0" data-testid="ai-agent-advanced">
        <summary className="cursor-pointer text-xs font-medium">
          {unsupportedCount > 0
            ? t("Advanced ({{count}} not sent to this provider)", {
                count: unsupportedCount,
                defaultValue: `Advanced (${unsupportedCount} not sent to this provider)`,
              })
            : t("Advanced", "Advanced")}
        </summary>

        <div className="mt-2 min-w-0 space-y-3 rounded-lg border border-border/60 bg-card/30 p-3">
          <p
            role="note"
            data-testid="ai-agent-advanced-notice"
            className="text-xs break-words text-muted-foreground [overflow-wrap:anywhere]"
          >
            {advancedNotice}
          </p>
          {capabilities === null && !capabilitiesLoading ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetryCapabilities}
            >
              {t("Try again", "Try again")}
            </Button>
          ) : null}

          <FieldShell
            id={id("topK")}
            name="topK"
            applicability={applicabilityOf("topK")}
            label={fieldLabels.topK}
            range={optionalWholeBetweenText(
              AI_AGENT_LIMITS.topK.min,
              AI_AGENT_LIMITS.topK.max,
            )}
            explanation={t(
              "Keeps only the k likeliest candidates for the next word and ignores everything below them. At 1 the reply is all but fixed; 40 is a mild filter. It is Top-p's job done by a cruder rule — a fixed count of candidates instead of a share of the probability.",
              "Keeps only the k likeliest candidates for the next word and ignores everything below them. At 1 the reply is all but fixed; 40 is a mild filter. It is Top-p's job done by a cruder rule — a fixed count of candidates instead of a share of the probability.",
            )}
            marking={markingFor("topK")}
            control={
              <Input
                id={id("topK")}
                aria-describedby={`${id("topK")}-help`}
                type="number"
                min={AI_AGENT_LIMITS.topK.min}
                max={AI_AGENT_LIMITS.topK.max}
                step={1}
                className="w-28"
                disabled={!editable("topK")}
                value={draft.topK}
                onChange={(event) =>
                  setDraft({ ...draft, topK: event.target.value })
                }
              />
            }
          />

          <FieldShell
            id={id("stop")}
            name="stop"
            applicability={applicabilityOf("stop")}
            label={fieldLabels.stop}
            range={t(
              "One per line. Up to {{count}} sequences, each at most {{bytes}} bytes, or empty for none.",
              {
                count: AI_STOP_LIMITS.maxSequences,
                bytes: AI_STOP_LIMITS.maxSequenceBytes,
                defaultValue: `One per line. Up to ${AI_STOP_LIMITS.maxSequences} sequences, each at most ${AI_STOP_LIMITS.maxSequenceBytes} bytes, or empty for none.`,
              },
            )}
            explanation={t(
              "Text that ends the reply the instant the model writes it, and the sequence itself is not shown. Use it to stop a model that keeps running on past the answer into a section you did not ask for. A line is taken exactly as typed, leading and trailing spaces included, but a line of nothing but spaces is refused rather than sent.",
              "Text that ends the reply the instant the model writes it, and the sequence itself is not shown. Use it to stop a model that keeps running on past the answer into a section you did not ask for. A line is taken exactly as typed, leading and trailing spaces included, but a line of nothing but spaces is refused rather than sent.",
            )}
            marking={markingFor("stop")}
            control={
              <Textarea
                id={id("stop")}
                aria-describedby={`${id("stop")}-help`}
                rows={3}
                className="font-mono text-xs"
                disabled={!editable("stop")}
                value={draft.stop}
                onChange={(event) =>
                  setDraft({ ...draft, stop: event.target.value })
                }
              />
            }
          />

          <FieldShell
            id={id("seed")}
            name="seed"
            applicability={applicabilityOf("seed")}
            label={fieldLabels.seed}
            range={optionalWholeBetweenText(
              AI_AGENT_LIMITS.seed.min,
              AI_AGENT_LIMITS.seed.max,
            )}
            explanation={t(
              "Fixes the random choices the model makes, so the same question with the same settings comes back with the same answer — which is what makes two prompts comparable. It is a best effort, not a promise: providers change the model behind a name without changing the name.",
              "Fixes the random choices the model makes, so the same question with the same settings comes back with the same answer — which is what makes two prompts comparable. It is a best effort, not a promise: providers change the model behind a name without changing the name.",
            )}
            marking={markingFor("seed")}
            control={
              <Input
                id={id("seed")}
                aria-describedby={`${id("seed")}-help`}
                type="number"
                min={AI_AGENT_LIMITS.seed.min}
                max={AI_AGENT_LIMITS.seed.max}
                step={1}
                className="w-40"
                disabled={!editable("seed")}
                value={draft.seed}
                onChange={(event) =>
                  setDraft({ ...draft, seed: event.target.value })
                }
              />
            }
          />

          <FieldShell
            id={id("frequencyPenalty")}
            name="frequencyPenalty"
            applicability={applicabilityOf("frequencyPenalty")}
            label={fieldLabels.frequencyPenalty}
            range={optionalBetweenText(
              AI_AGENT_LIMITS.frequencyPenalty.min,
              AI_AGENT_LIMITS.frequencyPenalty.max,
            )}
            explanation={t(
              "Pushes the model away from words it has already used in this reply, in proportion to how often it has used them. Raise it when answers start looping. Raise it far and the wording turns strained, because the model is avoiding the word it actually needs — including a record type it has to keep naming.",
              "Pushes the model away from words it has already used in this reply, in proportion to how often it has used them. Raise it when answers start looping. Raise it far and the wording turns strained, because the model is avoiding the word it actually needs — including a record type it has to keep naming.",
            )}
            marking={markingFor("frequencyPenalty")}
            control={
              <Input
                id={id("frequencyPenalty")}
                aria-describedby={`${id("frequencyPenalty")}-help`}
                type="number"
                min={AI_AGENT_LIMITS.frequencyPenalty.min}
                max={AI_AGENT_LIMITS.frequencyPenalty.max}
                step={0.1}
                className="w-28"
                disabled={!editable("frequencyPenalty")}
                value={draft.frequencyPenalty}
                onChange={(event) =>
                  setDraft({ ...draft, frequencyPenalty: event.target.value })
                }
              />
            }
          />

          <FieldShell
            id={id("presencePenalty")}
            name="presencePenalty"
            applicability={applicabilityOf("presencePenalty")}
            label={fieldLabels.presencePenalty}
            range={optionalBetweenText(
              AI_AGENT_LIMITS.presencePenalty.min,
              AI_AGENT_LIMITS.presencePenalty.max,
            )}
            explanation={t(
              "Pushes the model away from any word it has used at all, however few times. Raise it to make a reply cover more ground rather than circle one point; it is the wrong dial for a repeated phrase, which is what the frequency penalty is for.",
              "Pushes the model away from any word it has used at all, however few times. Raise it to make a reply cover more ground rather than circle one point; it is the wrong dial for a repeated phrase, which is what the frequency penalty is for.",
            )}
            marking={markingFor("presencePenalty")}
            control={
              <Input
                id={id("presencePenalty")}
                aria-describedby={`${id("presencePenalty")}-help`}
                type="number"
                min={AI_AGENT_LIMITS.presencePenalty.min}
                max={AI_AGENT_LIMITS.presencePenalty.max}
                step={0.1}
                className="w-28"
                disabled={!editable("presencePenalty")}
                value={draft.presencePenalty}
                onChange={(event) =>
                  setDraft({ ...draft, presencePenalty: event.target.value })
                }
              />
            }
          />

          <FieldShell
            id={id("maxContextTokens")}
            name="maxContextTokens"
            applicability={applicabilityOf("maxContextTokens")}
            label={fieldLabels.maxContextTokens}
            range={wholeBetweenText(
              AI_AGENT_LIMITS.maxContextTokens.min,
              AI_AGENT_LIMITS.maxContextTokens.max,
            )}
            explanation={t(
              "How much of the conversation is sent with each turn. The oldest messages are dropped until the turn fits, so lowering this holds down the cost of a long thread and costs the assistant the start of it in exchange. Set it below the model's own context window, not above: a turn that overflows the window is refused by the provider rather than trimmed.",
              "How much of the conversation is sent with each turn. The oldest messages are dropped until the turn fits, so lowering this holds down the cost of a long thread and costs the assistant the start of it in exchange. Set it below the model's own context window, not above: a turn that overflows the window is refused by the provider rather than trimmed.",
            )}
            marking={markingFor("maxContextTokens")}
            control={
              <Input
                id={id("maxContextTokens")}
                aria-describedby={`${id("maxContextTokens")}-help`}
                type="number"
                min={AI_AGENT_LIMITS.maxContextTokens.min}
                max={AI_AGENT_LIMITS.maxContextTokens.max}
                step={1}
                className="w-32"
                disabled={!editable("maxContextTokens")}
                value={draft.maxContextTokens}
                onChange={(event) =>
                  setDraft({ ...draft, maxContextTokens: event.target.value })
                }
              />
            }
          />

          <FieldShell
            id={id("requestTimeoutMs")}
            name="requestTimeoutMs"
            applicability={applicabilityOf("requestTimeoutMs")}
            label={fieldLabels.requestTimeoutMs}
            range={t(
              "Milliseconds: a whole number between {{min}} and {{max}}, or empty for no timeout.",
              {
                min: AI_AGENT_LIMITS.requestTimeoutMs.min,
                max: AI_AGENT_LIMITS.requestTimeoutMs.max,
                defaultValue: `Milliseconds: a whole number between ${AI_AGENT_LIMITS.requestTimeoutMs.min} and ${AI_AGENT_LIMITS.requestTimeoutMs.max}, or empty for no timeout.`,
              },
            )}
            explanation={t(
              "How long to wait for the provider before giving up on the call. Too short and a slow connection turns a long answer into a failure. Left empty there is no timeout on the call at all, and a provider that has stopped responding mid-turn is only caught by the transcript's own stall watchdog.",
              "How long to wait for the provider before giving up on the call. Too short and a slow connection turns a long answer into a failure. Left empty there is no timeout on the call at all, and a provider that has stopped responding mid-turn is only caught by the transcript's own stall watchdog.",
            )}
            marking={markingFor("requestTimeoutMs")}
            control={
              <Input
                id={id("requestTimeoutMs")}
                aria-describedby={`${id("requestTimeoutMs")}-help`}
                type="number"
                min={AI_AGENT_LIMITS.requestTimeoutMs.min}
                max={AI_AGENT_LIMITS.requestTimeoutMs.max}
                step={1}
                className="w-32"
                disabled={!editable("requestTimeoutMs")}
                value={draft.requestTimeoutMs}
                onChange={(event) =>
                  setDraft({ ...draft, requestTimeoutMs: event.target.value })
                }
              />
            }
          />

          <FieldShell
            id={id("systemPromptOverride")}
            name="systemPromptOverride"
            applicability={applicabilityOf("systemPromptOverride")}
            label={fieldLabels.systemPromptOverride}
            range={t("Up to {{limit}} bytes, or empty.", {
              limit: AI_PERSONA_LIMITS.systemPromptBytes,
              defaultValue: `Up to ${AI_PERSONA_LIMITS.systemPromptBytes} bytes, or empty.`,
            })}
            explanation={t(
              "Extra standing instructions, added to the end of whichever system prompt is already in effect — the conversation's own if it has one, otherwise the selected persona's. It adds, it does not replace: the persona you picked keeps applying, so this is the place for a house rule (\"always show the TTL\") rather than a different personality. Leave it empty to send nothing extra; a conversation with its own prompt is the way to replace one outright.",
              "Extra standing instructions, added to the end of whichever system prompt is already in effect — the conversation's own if it has one, otherwise the selected persona's. It adds, it does not replace: the persona you picked keeps applying, so this is the place for a house rule (\"always show the TTL\") rather than a different personality. Leave it empty to send nothing extra; a conversation with its own prompt is the way to replace one outright.",
            )}
            marking={markingFor("systemPromptOverride")}
            control={
              <Textarea
                id={id("systemPromptOverride")}
                aria-describedby={`${id("systemPromptOverride")}-help`}
                rows={4}
                className="text-xs"
                disabled={!editable("systemPromptOverride")}
                value={draft.systemPromptOverride}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    systemPromptOverride: event.target.value,
                  })
                }
              />
            }
          />

          {/* ── The configurable retention and plan limits ─────────────────
              Inside Advanced, but a section of their own rather than eight
              more entries in the list above, because they are a different
              kind of setting: none of them reaches a provider, so none is
              capability-checked or ever marked "not sent", and the group
              notice at the top of Advanced does not apply to them. They are
              locked only while a save is in flight.

              The two facts in the note are here once rather than in eight
              explanations, and they are both things a user would otherwise
              discover by being surprised. */}
          <section
            className="min-w-0 space-y-3 rounded-lg border border-border/60 bg-background/30 p-3"
            data-testid="ai-agent-limits"
          >
            <h4 className="text-xs font-semibold">
              {t("Retention and plan limits", "Retention and plan limits")}
            </h4>
            <p
              role="note"
              data-testid="ai-agent-limits-notice"
              className="space-y-1 text-xs break-words text-muted-foreground [overflow-wrap:anywhere]"
            >
              <span className="block">
                {t(
                  "These bound what the assistant keeps in memory, and they go to no provider. Each one can only be lowered: the top of every range below is what the code is built to survive, and a higher value is refused by name rather than accepted and quietly clamped.",
                  "These bound what the assistant keeps in memory, and they go to no provider. Each one can only be lowered: the top of every range below is what the code is built to survive, and a higher value is refused by name rather than accepted and quietly clamped.",
                )}
              </span>
              <span className="block">
                {t(
                  "Lowering a limit deletes nothing. It stops the store growing straight away and then trims at most one item each time something is written, so 40 conversations under a new limit of 5 all stay in the list and the number comes down as you delete them.",
                  "Lowering a limit deletes nothing. It stops the store growing straight away and then trims at most one item each time something is written, so 40 conversations under a new limit of 5 all stay in the list and the number comes down as you delete them.",
                )}
              </span>
            </p>

            {AI_CONFIGURABLE_LIMITS.map((limitField) => {
              const bounds = AI_AGENT_LIMITS[limitField];
              const bytes = isAiByteLimit(limitField);
              return (
                <FieldShell
                  key={limitField}
                  id={id(limitField)}
                  name={limitField}
                  label={fieldLabels[limitField]}
                  range={
                    bytes
                      ? byteWholeBetweenText(bounds.min, bounds.max)
                      : wholeBetweenText(bounds.min, bounds.max)
                  }
                  explanation={limitExplanations[limitField]}
                  control={
                    <Input
                      id={id(limitField)}
                      aria-describedby={`${id(limitField)}-help`}
                      type="number"
                      min={bounds.min}
                      max={bounds.max}
                      step={1}
                      className="w-40"
                      disabled={busy}
                      value={draft[limitField]}
                      onChange={(event) =>
                        setLimitDraft(limitField, event.target.value)
                      }
                    />
                  }
                />
              );
            })}
          </section>
        </div>
      </details>

      {issues.length > 0 ? (
        <ul
          role="alert"
          data-testid="ai-agent-issues"
          className="list-disc space-y-1 rounded-md border border-destructive/40 bg-destructive/10 py-2 pl-7 pr-3 text-xs text-destructive"
        >
          {issues.map((issue) => (
            <li key={`${issue.field}-${issue.code}`}>{describeIssue(issue)}</li>
          ))}
        </ul>
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

      {saved ? (
        <p
          role="status"
          aria-live="polite"
          className="text-xs text-muted-foreground"
        >
          {t("Settings saved.", "Settings saved.")}
        </p>
      ) : null}

      <Button type="submit" size="sm" disabled={busy}>
        {busy ? t("Saving…", "Saving…") : t("Save settings", "Save settings")}
      </Button>
    </form>
  );
}

/**
 * The generation settings wired to the capability map.
 *
 * `ai_protocol_capabilities` is read here rather than in `AiSettingsPanel` for
 * the same reason the permission catalog is read in its own component: the
 * Behaviour section is the only place that needs the answer, so an install
 * that never opens it never issues the command.
 */
export function ConnectedAiAgentSettings(
  props: Omit<
    AiAgentSettingsProps,
    | "capabilities"
    | "capabilitiesLoading"
    | "capabilitiesError"
    | "onRetryCapabilities"
  >,
) {
  const protocols = useAiProtocolCapabilities();
  return (
    <AiAgentSettings
      {...props}
      capabilities={protocols.capabilities}
      capabilitiesLoading={protocols.loading}
      capabilitiesError={protocols.loadError}
      onRetryCapabilities={() => void protocols.refresh()}
    />
  );
}
