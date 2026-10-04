/**
 * The agent loop's numeric settings.
 *
 * Every bound checked here is copied from a Rust validator rather than chosen:
 * see `AI_AGENT_LIMITS`. The check is for immediate feedback only — the form
 * still sends the value and still shows the backend's refusal verbatim if it
 * disagrees, because the validator on the other side is the one that counts.
 *
 * `toolsEnabled` is deliberately absent. It is the switch the chat view owns
 * (see `AiToolNotice`), and offering a second control for it here would let two
 * surfaces disagree about the one piece of state that decides whether any tool
 * can run at all.
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/hooks/use-i18n";
import {
  AI_AGENT_LIMITS,
  validateAgentConfig,
  type AiValidationIssue,
} from "@/lib/ai/permissions";
import type { AgentConfig } from "@/types/ai";

import { describeAiError } from "./ai-error";

export interface AiAgentSettingsProps {
  /** `null` until `ai_get_config` has answered. */
  config: AgentConfig | null;
  onSave: (config: AgentConfig) => Promise<void>;
}

interface Draft {
  maxToolRounds: string;
  maxTokensPerTurn: string;
  temperature: string;
  topP: string;
  stream: boolean;
}

/**
 * A field that came back absent or NaN would render as "undefined"/"NaN" and
 * then be sent straight back. Falling back to the field's own minimum keeps the
 * form submittable and visibly wrong rather than invisibly wrong.
 */
function numberText(value: number, fallback: number): string {
  return String(Number.isFinite(value) ? value : fallback);
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
  };
}

export function AiAgentSettings({ config, onSave }: AiAgentSettingsProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [issues, setIssues] = useState<AiValidationIssue[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();

  // Seed once the config arrives, and re-seed if it is replaced from
  // elsewhere — but never while the user is mid-edit on an unsaved draft.
  useEffect(() => {
    if (config === null) return;
    setDraft((current) => current ?? toDraft(config));
  }, [config]);

  const describeIssue = (issue: AiValidationIssue): string => {
    const fieldLabels = {
      maxToolRounds: t("Tool rounds per turn", "Tool rounds per turn"),
      maxTokensPerTurn: t("Tokens per turn", "Tokens per turn"),
      temperature: t("Temperature", "Temperature"),
      topP: t("Top-p", "Top-p"),
      name: t("Name", "Name"),
      description: t("Description", "Description"),
      systemPrompt: t("System prompt", "System prompt"),
    } as const;
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
    const next: AgentConfig = {
      ...config,
      maxToolRounds: Number(draft.maxToolRounds),
      maxTokensPerTurn: Number(draft.maxTokensPerTurn),
      temperature: Number(draft.temperature),
      topP: Number(draft.topP),
      stream: draft.stream,
    };
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

  return (
    <form
      className="min-w-0 space-y-3"
      data-testid="ai-agent-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <h3 className="text-sm font-semibold">
        {t("Response settings", "Response settings")}
      </h3>

      <div className="flex flex-wrap gap-3">
        <div className="space-y-1">
          <Label htmlFor="ai-agent-temperature">
            {t("Temperature", "Temperature")}
          </Label>
          <Input
            id="ai-agent-temperature"
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
        </div>
        <div className="space-y-1">
          <Label htmlFor="ai-agent-top-p">{t("Top-p", "Top-p")}</Label>
          <Input
            id="ai-agent-top-p"
            type="number"
            min={AI_AGENT_LIMITS.topP.min}
            max={AI_AGENT_LIMITS.topP.max}
            step={0.05}
            className="w-28"
            value={draft.topP}
            onChange={(event) =>
              setDraft({ ...draft, topP: event.target.value })
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ai-agent-tool-rounds">
            {t("Tool rounds per turn", "Tool rounds per turn")}
          </Label>
          <Input
            id="ai-agent-tool-rounds"
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
        </div>
        <div className="space-y-1">
          <Label htmlFor="ai-agent-max-tokens">
            {t("Tokens per turn", "Tokens per turn")}
          </Label>
          <Input
            id="ai-agent-max-tokens"
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
        </div>
      </div>

      <label className="flex items-start gap-3">
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
            {t("Stream replies", "Stream replies")}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t(
              "Show the reply as it arrives instead of waiting for the whole turn.",
              "Show the reply as it arrives instead of waiting for the whole turn.",
            )}
          </span>
        </span>
      </label>

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
