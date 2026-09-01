/**
 * Provider configuration and the tool-use control.
 *
 * Two things about credentials here are deliberate, not oversights:
 *
 * 1. **The key is session-only.** `AgentManager::configure_provider` inserts
 *    into a plain `RwLock<HashMap<…>>`; there is no `bc-storage` or `bc-crypto`
 *    call anywhere in the AI crates and no load-from-disk path. The key does not
 *    survive a restart, and the required notice under the field says so. This is
 *    unlike Cloudflare API keys, which are encrypted into the OS keyring.
 * 2. **The key is write-only.** No command returns a `ProviderConfig`, so the UI
 *    can never show a stored key — not even masked. It can only show
 *    `configured: true/false`. The field is `type="password"` with no reveal
 *    toggle, matching `AddKeyDialog`, and it is cleared from React state as soon
 *    as the save succeeds. The key is never logged, echoed, or put into runtime
 *    error context.
 *
 * Saving is also the connection test: `ai_configure_provider` health-checks
 * against the provider before storing, so a rejection means the credentials do
 * not work. A separate "Test" button would double the network cost for no extra
 * information.
 */
import { useState, type FormEvent } from "react";

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
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/hooks/use-i18n";
import {
  PROVIDER_KINDS,
  type ProviderConfig,
  type ProviderKind,
} from "@/types/ai";
import type { ProviderStatus } from "@/types/ai";

import { describeAiError } from "./ai-error";

/** Mirrors `AgentConfig::default()` on the Rust side closely enough for a new form. */
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 4096;

export interface AiProviderSettingsProps {
  providers: ProviderStatus[];
  loading: boolean;
  /** Actual agent state, so a disabled toggle never misreports it. */
  toolsEnabled: boolean;
  onConfigure: (config: ProviderConfig) => Promise<void>;
  /** Remember the model for this provider so new conversations can default to it. */
  onConfigured: (kind: ProviderKind, model: string) => void;
}

export function AiProviderSettings({
  providers,
  loading,
  toolsEnabled,
  onConfigure,
  onConfigured,
}: AiProviderSettingsProps) {
  const { t } = useI18n();
  const [kind, setKind] = useState<ProviderKind>("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState(String(DEFAULT_TEMPERATURE));
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MAX_TOKENS));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Ollama runs locally and takes no key; requiring one would be a lie.
  const keyRequired = kind !== "ollama";

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setRemediation(null);
    setSaved(null);

    const trimmedModel = model.trim();
    if (trimmedModel.length === 0) {
      setFormError(t("Enter a model name.", "Enter a model name."));
      return;
    }
    const parsedTemperature = Number(temperature);
    if (
      !Number.isFinite(parsedTemperature) ||
      parsedTemperature < 0 ||
      parsedTemperature > 2
    ) {
      setFormError(
        t(
          "Temperature must be between 0 and 2.",
          "Temperature must be between 0 and 2.",
        ),
      );
      return;
    }
    const parsedMaxTokens = Number(maxTokens);
    if (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1) {
      setFormError(
        t(
          "Max tokens must be a whole number of at least 1.",
          "Max tokens must be a whole number of at least 1.",
        ),
      );
      return;
    }
    if (keyRequired && apiKey.trim().length === 0) {
      setFormError(t("Enter an API key.", "Enter an API key."));
      return;
    }

    const config: ProviderConfig = {
      kind,
      model: trimmedModel,
      temperature: parsedTemperature,
      maxTokens: parsedMaxTokens,
    };
    if (apiKey.trim().length > 0) config.apiKey = apiKey.trim();
    if (baseUrl.trim().length > 0) config.baseUrl = baseUrl.trim();

    setSaving(true);
    try {
      await onConfigure(config);
      // Nothing reads the key back, so holding it in component state after a
      // successful save would only widen its exposure.
      setApiKey("");
      onConfigured(kind, trimmedModel);
      setSaved(
        t(
          "Provider verified and saved for this session.",
          "Provider verified and saved for this session.",
        ),
      );
    } catch (error) {
      // Only the backend's sanitized message is surfaced, and the failure is
      // never handed to runtime reporting — the submitted value is a secret.
      const described = describeAiError(
        error,
        t(
          "The provider could not be verified.",
          "The provider could not be verified.",
        ),
      );
      setFormError(described.message);
      setRemediation(described.remediation ?? null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="ai-settings">
      <section className="space-y-2" data-testid="ai-providers">
        <h3 className="text-sm font-semibold">{t("Providers", "Providers")}</h3>
        <ul role="list" className="space-y-1">
          {PROVIDER_KINDS.map((candidate) => {
            const status = providers.find((entry) => entry.kind === candidate);
            const configured = status?.configured === true;
            return (
              <li
                key={candidate}
                className="flex items-center justify-between rounded-md border border-border/60 px-2 py-1.5 text-xs"
                data-provider={candidate}
                data-configured={configured}
              >
                <span className="font-medium">{candidate}</span>
                <span className="text-muted-foreground">
                  {loading
                    ? t("Loading…", "Loading…")
                    : configured
                      ? t("Configured", "Configured")
                      : t("Not configured", "Not configured")}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <form className="space-y-3" onSubmit={handleSubmit}>
        <h3 className="text-sm font-semibold">
          {t("Configure a provider", "Configure a provider")}
        </h3>

        <div className="space-y-1">
          <Label htmlFor="ai-provider-kind">{t("Provider", "Provider")}</Label>
          <Select
            value={kind}
            onValueChange={(value) => setKind(value as ProviderKind)}
          >
            <SelectTrigger
              id="ai-provider-kind"
              aria-label={t("Provider", "Provider")}
              className="h-9 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_KINDS.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {candidate}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="ai-provider-key">
            {keyRequired
              ? t("API key", "API key")
              : t("API key (not required)", "API key (not required)")}
          </Label>
          <Input
            id="ai-provider-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={t("Provider API key", "Provider API key")}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <p role="note" className="text-xs text-muted-foreground">
            {t(
              "Stored in memory for this session only. You will need to re-enter it after restarting the app.",
              "Stored in memory for this session only. You will need to re-enter it after restarting the app.",
            )}
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="ai-provider-model">{t("Model", "Model")}</Label>
          <Input
            id="ai-provider-model"
            value={model}
            placeholder={t("e.g. gpt-4o-mini", "e.g. gpt-4o-mini")}
            onChange={(event) => setModel(event.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="space-y-1">
            <Label htmlFor="ai-provider-temperature">
              {t("Temperature", "Temperature")}
            </Label>
            <Input
              id="ai-provider-temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              className="w-28"
              onChange={(event) => setTemperature(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ai-provider-max-tokens">
              {t("Max tokens", "Max tokens")}
            </Label>
            <Input
              id="ai-provider-max-tokens"
              type="number"
              min={1}
              step={1}
              value={maxTokens}
              className="w-32"
              onChange={(event) => setMaxTokens(event.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="ai-provider-base-url">
            {t("Base URL (optional)", "Base URL (optional)")}
          </Label>
          <Input
            id="ai-provider-base-url"
            type="url"
            value={baseUrl}
            placeholder={t(
              "Override the default endpoint",
              "Override the default endpoint",
            )}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>

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
            {saved}
          </p>
        ) : null}

        <Button type="submit" size="sm" disabled={saving}>
          {saving
            ? t("Verifying…", "Verifying…")
            : t("Save and verify", "Save and verify")}
        </Button>
      </form>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("Tool use", "Tool use")}</h3>
        <div className="flex items-start gap-3">
          <Switch
            id="ai-tools-enabled"
            size="sm"
            checked={toolsEnabled}
            disabled
            aria-label={t("Tool use", "Tool use")}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "Tool use is unavailable in this build. The assistant can read and discuss, but cannot change anything in your account.",
              "Tool use is unavailable in this build. The assistant can read and discuss, but cannot change anything in your account.",
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
